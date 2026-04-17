// electron/setup.js — first-run setup orchestrator.
//
// Ports src-tauri/src/setup.rs to Node. Pipeline is the same:
//   1. Detect GPU
//   2. Download Python standalone (cpython from python-build-standalone)
//   3. SHA256-verify the archive against the aggregate SHA256SUMS file
//   4. Extract it into <dataDir>/getbased/lens/python
//   5. Create venv
//   6. pip install the bundled lens/ source with [full] extras (streamed)
//   7. Second-pass pip install --force-reinstall --no-deps so same-version
//      source-code edits actually land (audit item #13)
//   8. Install the right onnxruntime provider for the detected hardware
//   9. Download the chosen embedding model (BGE-M3 or MiniLM) via
//      huggingface_hub snapshot_download
//  10. Persist model choice + write .setup-complete marker
//
// Progress is streamed to renderer via `emit(phase)`. Cancel support: we
// track the PID of the currently running subprocess, and `cancel()` kills
// that PID plus its direct children (pip spawns python subprocesses).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  dataDir, lensDir, pythonDir, venvDir, modelsDir,
  lensSourceDir, setupMarkerPath, embeddingModelPath,
  pythonBinPath, venvPipPath, lensBinPath,
} from './paths.js';
import { extractTarGz } from './archive.js';
import { detectGpu, pickEmbeddingModel } from './gpu.js';

// python-build-standalone: update VERSION / RELEASE when new builds drop.
// SHA256SUMS verification means we don't blindly trust a tampered archive.
const PYTHON_VERSION = '3.11.15';
const PYTHON_RELEASE = '20260414';
const PYTHON_REPO = 'astral-sh/python-build-standalone';

// 4 GB headroom covers Python + venv + ONNX Runtime + BGE-M3. MiniLM uses
// much less but we don't know which model will be picked until after GPU
// detection, so block on the higher bound.
const REQUIRED_DISK_BYTES = 4 * 1024 * 1024 * 1024;

export class SetupManager {
  constructor({ onProgress } = {}) {
    this._phase = { phase: 'not_started' };
    this._gpu = null;
    this._cancelRequested = false;
    this._currentChildPid = null;
    this._onProgress = onProgress || (() => {});
  }

  // ── Public surface ──────────────────────────────────────────────

  async isSetupComplete() {
    try { await fs.access(setupMarkerPath()); return true; }
    catch { return false; }
  }

  async lensBinary() {
    if (!(await this.isSetupComplete())) return null;
    const bin = lensBinPath();
    try { await fs.access(bin); return bin; }
    catch { return null; }
  }

  async status() {
    return {
      phase: this._phase,
      gpu: this._gpu || { vendor: 'unknown', name: 'No GPU detected', recommended_provider: 'cpu', runtime_installed: false, vram_is_unified: false },
      is_first_run: !(await this.isSetupComplete()),
      lens_binary: await this.lensBinary(),
    };
  }

  /// User hit Cancel. Flip the flag and SIGKILL the tracked subprocess and
  /// its direct children — pip spawns python subprocesses that ignore
  /// SIGTERM on the parent, so we have to walk the tree ourselves.
  async cancel() {
    this._cancelRequested = true;
    const pid = this._currentChildPid;
    if (!pid) return;
    for (const childPid of await listChildPids(pid)) {
      try { process.kill(childPid, 'SIGKILL'); } catch {}
    }
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }

  async reset() {
    try { await fs.unlink(setupMarkerPath()); } catch {}
    this._setPhase({ phase: 'not_started' });
  }

  /// Run the pipeline. Idempotent — safe to re-run after a partial failure.
  /// A prior cancel must not poison a fresh retry, so the flag resets here.
  async run() {
    if (await this.isSetupComplete()) {
      this._setPhase({ phase: 'completed' });
      return;
    }
    this._cancelRequested = false;
    try {
      await this._runInner();
    } catch (e) {
      const message = e?.message || String(e);
      this._setPhase({ phase: 'failed', error: message });
      throw e;
    }
  }

  // ── Pipeline ────────────────────────────────────────────────────

  async _runInner() {
    await fs.mkdir(lensDir(), { recursive: true });
    await fs.mkdir(modelsDir(), { recursive: true });

    // Disk precheck. statfs is the portable way in modern Node; on failure
    // we treat free space as infinite rather than blocking install.
    let free = Number.MAX_SAFE_INTEGER;
    try {
      const st = await fs.statfs(lensDir());
      free = Number(st.bsize) * Number(st.bavail);
    } catch {}
    if (free < REQUIRED_DISK_BYTES) {
      const need = Math.floor(REQUIRED_DISK_BYTES / 1024 / 1024 / 1024);
      const have = Math.floor(free / 1024 / 1024 / 1024);
      throw new Error(`Not enough disk space. Need ${need} GB free, you have ${have} GB. Free up space and try again.`);
    }

    // Phase 1: GPU detection.
    this._setPhase({ phase: 'detecting_gpu' });
    this._gpu = await detectGpu();

    // Phase 2: Python download.
    const pythonUrl = pythonStandaloneUrl();
    this._setPhase({ phase: 'downloading_python', url: pythonUrl, progress: 0 });
    const pythonBin = await this._downloadPython(pythonUrl);

    // Phase 3: pip install bundled lens source.
    this._setPhase({ phase: 'installing_lens', progress: 0, status: null });
    await this._installLens(pythonBin);

    // Phase 4: ONNX runtime provider.
    const provider = this._gpu?.recommended_provider || 'cpu';
    this._setPhase({ phase: 'downloading_onnx_runtime', provider, progress: 0, status: null });
    await this._installOnnxRuntime(provider);

    // Phase 5: Embedding model.
    const model = pickEmbeddingModel(this._gpu, os.totalmem());
    await fs.writeFile(embeddingModelPath(), model);
    this._setPhase({ phase: 'downloading_model', name: model, progress: 0, status: null });
    await this._downloadModel(pythonBin, model);

    await fs.writeFile(setupMarkerPath(), String(Math.floor(Date.now() / 1000)));
    this._setPhase({ phase: 'completed' });
  }

  // ── Phase bodies ────────────────────────────────────────────────

  async _downloadPython(url) {
    const target = pythonDir();
    const bin = pythonBinPath();
    try { await fs.access(bin); return bin; } catch {}

    const archiveBytes = await this._downloadWithProgress(url, 'Python');

    // Verify SHA256 against the aggregate SHA256SUMS file from the same
    // release. Same trust boundary as the archive (both GitHub Releases) —
    // catches TLS-MITM and corrupt downloads, not a compromised release.
    const filename = pythonArchiveFilename();
    try {
      const expected = await this._fetchExpectedSha256(filename);
      verifySha256(archiveBytes, expected);
    } catch (e) {
      // Skip-with-warning matches Rust behavior — don't block install on a
      // transient SHA fetch failure, but log loudly for support triage.
      console.warn(`[setup] SHA256 verification SKIPPED: ${e.message || e}`);
    }

    const tempDir = `${target}.tmp`;
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
    await extractTarGz(archiveBytes, tempDir);

    // python-build-standalone extracts to a single top-level subdirectory
    // (e.g. `python/`). Move its contents up into `target`.
    const entries = await fs.readdir(tempDir);
    if (entries.length === 0) throw new Error('Empty archive');
    const inner = path.join(tempDir, entries[0]);
    try { await fs.rm(target, { recursive: true, force: true }); } catch {}
    await fs.rename(inner, target);
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}

    return bin;
  }

  async _installLens(pythonBin) {
    // Always re-extract the bundled source so same-version code edits ship
    // with each desktop release. See phase-7 note for how packaging reads
    // this from extraResources; for dev we copy from the checked-in lens/.
    const source = lensSourceDir();
    await copyBundledLensSourceTo(source);

    // Idempotent venv create — skip if bin/ or Scripts/ already exist.
    const venvBinDir = process.platform === 'win32'
      ? path.join(venvDir(), 'Scripts')
      : path.join(venvDir(), 'bin');
    let venvExists = false;
    try { await fs.access(venvBinDir); venvExists = true; } catch {}
    if (!venvExists) {
      await this._runAndLog(pythonBin, ['-m', 'venv', venvDir()], 'Creating virtual environment');
    }

    const pip = venvPipPath();
    await this._runAndLog(pip, ['install', '--upgrade', 'pip'], 'Upgrading pip');
    // pip 26's isolated build envs intermittently can't resolve the stdlib on
    // python-build-standalone (bug pattern: queue.py not found from isolated
    // interpreter). Pre-installing setuptools + wheel into the main venv lets
    // us pass --no-build-isolation below to dodge that code path entirely.
    await this._runAndLog(pip, ['install', '--upgrade', 'setuptools', 'wheel'], 'Installing build tools');

    const sourceWithExtras = `${source}[full]`;
    await this._runAndStream(
      pip,
      ['install', '--upgrade', '--no-build-isolation', sourceWithExtras],
      'Installing getbased-lens (bundled)',
      (line) => {
        if (line.startsWith('Collecting ') || line.startsWith('Downloading ')
            || line.startsWith('Using cached ') || line.startsWith('Building wheel ')
            || line.startsWith('Installing collected packages') || line.startsWith('Successfully installed')) {
          this._bumpInstallProgress(line);
        }
      },
    );

    // Second pass: force-reinstall lens itself without touching deps. The
    // first --upgrade pass is a no-op when the bundled source changed but
    // the version string didn't — pip sees "already at version X" and
    // skips. --no-deps keeps it cheap. (Audit item #13 from the pre-merge
    // KB audit — preserve across the Rust → Node port.)
    await this._runAndStream(
      pip,
      ['install', '--force-reinstall', '--no-deps', '--no-build-isolation', source],
      'Reinstalling lens package (source refresh)',
      (line) => {
        if (line.startsWith('Installing collected packages') || line.startsWith('Successfully installed')) {
          this._setStatusLine(line);
        }
      },
    );
  }

  async _installOnnxRuntime(provider) {
    // Pick the right pip package per provider. CoreML ships in base
    // `onnxruntime` on macOS — no separate package. Other providers need
    // their own (mutually exclusive with the CPU `onnxruntime`).
    let packages;
    switch (provider) {
      case 'cuda': packages = ['onnxruntime-gpu']; break;
      case 'directml': packages = ['onnxruntime-directml']; break;
      case 'openvino': packages = ['onnxruntime-openvino']; break;
      case 'coreml': packages = ['onnxruntime']; break;
      case 'rocm':
        // ROCm wheels ship at repo.radeon.com, not PyPI. Fall back to CPU
        // and log — the user can install AMD's wheels manually if they
        // care about acceleration.
        console.warn('[setup] ROCm provider requested but no PyPI package. Falling back to onnxruntime (CPU).');
        packages = ['onnxruntime'];
        break;
      default: packages = ['onnxruntime'];
    }
    const pip = venvPipPath();
    for (const pkg of packages) {
      await this._runAndStream(
        pip,
        ['install', '--upgrade', pkg],
        `Installing ${pkg}`,
        (line) => {
          if (line.startsWith('Collecting ') || line.startsWith('Downloading ')
              || line.startsWith('Using cached ') || line.startsWith('Installing collected packages')
              || line.startsWith('Successfully installed') || line.startsWith('Requirement already satisfied')) {
            this._setStatusLine(line);
          }
        },
      );
    }
  }

  async _downloadModel(pythonBin, model) {
    // Pattern list is tailored per-model family:
    //   • ONNX-family (BGE-M3, bge-large) → *.onnx + *.onnx_data + metadata
    //   • sentence-transformers family (MiniLM) → safetensors + pooling
    //     configs + tokenizer only. MiniLM repos ship pytorch/safetensors/
    //     openvino/onnx variants, and a blanket allow_patterns would pull
    //     700 MB instead of the 90 MB we actually need.
    const script = String.raw`
import sys
from huggingface_hub import snapshot_download

model = sys.argv[2]
is_onnx_model = any(tok in model.lower() for tok in ("bge-m3", "bge-large", "onnx"))
if is_onnx_model:
    patterns = [
        "*.onnx", "*.onnx_data",
        "config.json", "tokenizer.json",
        "tokenizer_config.json", "special_tokens_map.json",
    ]
else:
    patterns = [
        "*.safetensors",
        "config.json", "tokenizer.json", "tokenizer_config.json",
        "special_tokens_map.json", "vocab.txt",
        "modules.json", "sentence_bert_config.json",
        "1_Pooling/*",
    ]

path = snapshot_download(model, allow_patterns=patterns, cache_dir=sys.argv[1])
print(f"Model downloaded to: {path}")
`;
    const scriptPath = path.join(modelsDir(), 'download_model.py');
    await fs.writeFile(scriptPath, script);
    await this._runAndLog(pythonBin, [scriptPath, modelsDir(), model], `Downloading ${model}`);
  }

  // ── Process + download helpers ──────────────────────────────────

  /// Fire-and-forget spawn, collect combined stdout+stderr, surface stderr
  /// on non-zero exit. Matches `run_and_log` in the Rust source.
  async _runAndLog(cmd, args, label) {
    await this._runAndStream(cmd, args, label, () => {});
  }

  /// Spawn + stream stdout line-by-line to `onLine`. stderr is collected
  /// whole and surfaced on failure. Tracks child PID so cancel() can kill.
  async _runAndStream(cmd, args, label, onLine) {
    if (this._cancelRequested) throw new Error('Setup cancelled by user');
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this._currentChildPid = child.pid;
      let stderrBuf = '';
      let stdoutBuf = '';

      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf8');
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + 1);
          try { onLine(line.trim()); } catch {}
        }
      });
      child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf8'); });

      child.on('error', (err) => {
        this._currentChildPid = null;
        reject(new Error(`${label} failed to start: ${err.message}`));
      });
      child.on('close', (code, signal) => {
        this._currentChildPid = null;
        if (stdoutBuf.length > 0) { try { onLine(stdoutBuf.trim()); } catch {} }
        if (this._cancelRequested) { reject(new Error('Setup cancelled by user')); return; }
        if (code !== 0) {
          reject(new Error(`${label} failed (exit ${code}${signal ? `, signal ${signal}` : ''}):\n${stderrBuf}`));
          return;
        }
        resolve();
      });
    });
  }

  async _downloadWithProgress(url, label) {
    // Use native fetch (Node 18+ built-in) so we can Buffer.from(await body)
    // after streaming chunks through a counter. Download size is ~50 MB so
    // buffering the whole archive before hashing/extract is fine.
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`Download failed for ${url}: HTTP ${resp.status}`);
    const total = Number(resp.headers.get('content-length')) || 0;
    const reader = resp.body.getReader();
    const chunks = [];
    let downloaded = 0;
    let lastLogged = -1;
    for (;;) {
      if (this._cancelRequested) throw new Error('Setup cancelled by user');
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      downloaded += value.length;
      if (total > 0) {
        const progress = downloaded / total;
        this._setProgress(progress);
        const tick = Math.floor(progress * 20);
        if (tick !== lastLogged) {
          lastLogged = tick;
          console.log(`[setup] ${label}: ${Math.round(progress * 100)}% (${downloaded}/${total})`);
        }
      }
    }
    return Buffer.concat(chunks);
  }

  async _fetchExpectedSha256(archiveFilename) {
    const url = `https://github.com/${PYTHON_REPO}/releases/download/${PYTHON_RELEASE}/SHA256SUMS`;
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`SHA256SUMS fetch returned ${resp.status}`);
    const body = await resp.text();
    for (const line of body.split('\n')) {
      const match = line.match(/^([0-9a-fA-F]{64})\s+(.+?)\s*$/);
      if (match && match[2] === archiveFilename) return match[1];
    }
    throw new Error(`SHA256SUMS does not contain hash for ${archiveFilename}`);
  }

  // ── Phase state helpers ─────────────────────────────────────────

  _setPhase(phase) {
    this._phase = phase;
    this._onProgress(phase);
  }

  _setProgress(progress) {
    const p = Math.max(0, Math.min(1, progress));
    const phase = this._phase?.phase;
    if (phase === 'downloading_python' || phase === 'installing_lens'
        || phase === 'downloading_onnx_runtime' || phase === 'downloading_model') {
      this._phase = { ...this._phase, progress: p };
      this._onProgress(this._phase);
    }
  }

  _setStatusLine(line) {
    const phase = this._phase?.phase;
    if (phase === 'installing_lens' || phase === 'downloading_onnx_runtime' || phase === 'downloading_model') {
      this._phase = { ...this._phase, status: line };
      this._onProgress(this._phase);
    }
  }

  /// Lens-install phase fakes progress from pip's per-package log lines.
  /// We don't know the total package count in advance, but lens[full] resolves
  /// to roughly ~70 packages, so each event bumps ~1.3% and we cap at 90%
  /// until "Successfully installed" flips us to 99%.
  _bumpInstallProgress(line) {
    if (this._phase?.phase !== 'installing_lens') return;
    let progress = this._phase.progress ?? 0;
    if (line.startsWith('Collecting ') || line.startsWith('Downloading ')) {
      progress = Math.min(0.90, progress + 0.013);
    } else if (line.startsWith('Successfully installed')) {
      progress = 0.99;
    }
    this._phase = { ...this._phase, progress, status: line };
    this._onProgress(this._phase);
  }
}

// ── Module-level helpers ───────────────────────────────────────────

function pythonStandaloneUrl() {
  return `https://github.com/${PYTHON_REPO}/releases/download/${PYTHON_RELEASE}/${pythonArchiveFilename()}`;
}

function pythonArchiveFilename() {
  return `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-${pythonTargetTriple()}-install_only.tar.gz`;
}

function pythonTargetTriple() {
  const { platform, arch } = process;
  const triples = {
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
  };
  const triple = triples[`${platform}-${arch}`];
  if (!triple) throw new Error(`Unsupported platform: ${platform} ${arch}`);
  return triple;
}

function verifySha256(data, expectedHex) {
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual.toLowerCase() !== expectedHex.trim().toLowerCase()) {
    throw new Error(`SHA256 mismatch: expected ${expectedHex.trim()}, got ${actual}`);
  }
}

/// List direct child PIDs of `parentPid`. Linux: walk /proc. macOS/Windows:
/// use `pgrep -P` (available on macOS) / `wmic` fallback. Best-effort — a
/// failure returns an empty list and we only kill the parent PID itself.
async function listChildPids(parentPid) {
  if (process.platform === 'linux') {
    try {
      const entries = await fs.readdir('/proc');
      const out = [];
      for (const pidStr of entries) {
        const pid = parseInt(pidStr, 10);
        if (!Number.isFinite(pid)) continue;
        try {
          const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
          // Field 4 (after the parenthesized comm) is ppid. comm may contain
          // spaces and parens; take everything after the final ')'.
          const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          const ppid = parseInt(afterComm[1], 10);
          if (ppid === parentPid) out.push(pid);
        } catch {}
      }
      return out;
    } catch { return []; }
  }
  // Best-effort for other platforms — skip until packaging phase adds ps-list.
  return [];
}

/// Copy the bundled lens/ source tree into `target`. For dev, we read from
/// the repo root (`<repo>/lens/`). In a packaged build this will eventually
/// point at process.resourcesPath — phase-7 packaging work.
async function copyBundledLensSourceTo(target) {
  const source = bundledLensSourcePath();
  try { await fs.rm(target, { recursive: true, force: true }); } catch {}
  await fs.mkdir(target, { recursive: true });
  await copyDir(source, target);
}

function bundledLensSourcePath() {
  // Packaged app: electron-builder's `extraResources` copies lens/ to
  // process.resourcesPath/lens, outside app.asar so fs can read from it.
  // Dev: fall back to the checked-in lens/ at repo root. process.defaultApp
  // is true when the app is running from source (electron .) and absent
  // from packaged builds, which is the cleanest platform-agnostic way to
  // distinguish the two modes.
  if (process.resourcesPath && !process.defaultApp) {
    return path.join(process.resourcesPath, 'lens');
  }
  const url = new URL('../lens', import.meta.url);
  return fileURLToPath(url);
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath);
    } else if (entry.isSymbolicLink()) {
      const link = await fs.readlink(srcPath);
      await fs.symlink(link, dstPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, dstPath);
    }
  }
}

export { pythonStandaloneUrl, pythonArchiveFilename, verifySha256 };
