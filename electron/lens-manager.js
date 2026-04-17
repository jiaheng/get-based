// electron/lens-manager.js — Lens Python sidecar lifecycle.
//
// Ports src-tauri/src/lens.rs to Node. Public surface on the class:
//   • start()      — reap orphans, spawn the FastAPI server, health-check 60s
//   • stop()       — SIGKILL the child, clear uptime
//   • status()     — is-running + health response + GPU info
//   • configure()  — merge partial config into the manager's state
//
// Helpers exported for main.js callers:
//   • runLensCommand(args)            — one-shot lens CLI invocation
//   • runLensCommandStreaming(args, onLine) — streams stdout lines
//   • lensHttpGet(path) / lensHttpDelete(path) — auth'd HTTP to the running
//     server, used when qdrant's POSIX flock would conflict with a CLI
//     subprocess
//   • redactBearer(s)                 — scrub Bearer <token> from error bodies
//   • percentEncodePath(s)            — RFC 3986 pchar + '/' for FastAPI :path
//
// Qdrant takes an exclusive POSIX flock on its storage dir, so the long-
// running lens server and a one-shot `lens ingest` / `delete` / `clear`
// CLI can't both hold it. Two strategies:
//   1. Prefer the HTTP path when the server is running (same handle, no
//      flock conflict) — see lensHttpGet / lensHttpDelete.
//   2. For CLI paths, the caller wraps the operation in `withLensPaused`
//      (stop server, run, restart) — lives in main.js.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  lensBinPath, lensDir, embeddingModelPath, apiKeyPath, venvDir,
} from './paths.js';
import { detectGpu } from './gpu.js';

const execFileP = promisify(execFile);

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8322;
const DEFAULT_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';

// ── Module-level helpers (mirror Rust free functions) ──────────────

/// Read the embedding model written at setup time. Falls back to MiniLM
/// if the sidecar file is missing or empty — the safe default on any
/// hardware and what Python's config.py defaults to.
function selectedEmbeddingModel() {
  try {
    const v = fsSync.readFileSync(embeddingModelPath(), 'utf8').trim();
    return v || DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

/// Env block the lens process inherits. Keeps LENS_DATA_DIR and
/// LENS_EMBEDDING_MODEL in sync with what setup wrote to disk. Applies to
/// both the long-running server (LensManager.start) and one-shot CLI
/// calls (runLensCommand, runLensCommandStreaming) — consistency matters
/// because the CLI's `stats`/`delete`/`clear` paths would otherwise see
/// a different similarity floor than live queries.
function lensEnv(extra = {}) {
  const model = selectedEmbeddingModel();
  return {
    ...process.env,
    LENS_DATA_DIR: lensDir(),
    LENS_EMBEDDING_MODEL: model,
    // Similarity floor is model-dependent. BGE-M3 (1024-dim multilingual,
    // MTEB ~59) scores related content in the 0.55-0.75 band, so the lens
    // Python default of 0.55 is well-calibrated. MiniLM (384-dim English,
    // MTEB ~41) scores the same content in 0.40-0.60, so 0.55 culls most
    // good matches — a real user with 12k+ MiniLM excerpts saw ≤2 chunks
    // returned for "vitamin D deficiency" at the default. 0.40 restores
    // recall for MiniLM without letting in pure noise (anything under
    // 0.35 is usually unrelated). Env var override still wins over the
    // model-derived default.
    LENS_SIMILARITY_FLOOR: process.env.LENS_SIMILARITY_FLOOR
      || (/minilm/i.test(model) ? '0.4' : '0.55'),
    ...extra,
  };
}

/// Resolve the lens binary path. Priority:
///   1. Setup-managed venv's lens entry point
///   2. Setup-managed venv's python (fallback for broken entry point)
/// We intentionally do NOT walk system PATH anymore — the Rust source did,
/// but our packaged desktop app owns its venv end-to-end, and picking up
/// `/usr/local/bin/lens` from a user's dev install would mask bugs in the
/// managed install.
async function resolveLensBinary() {
  const venvLens = lensBinPath();
  try { await fs.access(venvLens); return venvLens; } catch {}
  const venvPython = process.platform === 'win32'
    ? path.join(venvDir(), 'Scripts', 'python.exe')
    : path.join(venvDir(), 'bin', 'python3');
  try { await fs.access(venvPython); return venvPython; } catch {}
  throw new Error('Lens binary not found. Run setup first.');
}

/// Run `lens <args>` one-shot. Returns { stdout, stderr, ok } so callers
/// can inspect exit status without throwing — matches the Rust 3-tuple
/// so the main.js translation layer stays 1:1.
export async function runLensCommand(args) {
  const bin = await resolveLensBinary();
  try {
    const { stdout, stderr } = await execFileP(bin, args, {
      env: lensEnv(),
      maxBuffer: 64 * 1024 * 1024, // `lens stats --json` on a big KB can be several MB
      windowsHide: true,
    });
    return { stdout, stderr, ok: true };
  } catch (e) {
    // execFile rejects on non-zero exit; the partial stdout/stderr hang
    // off the error object so we can surface them to the caller.
    return {
      stdout: (e.stdout || '').toString(),
      stderr: (e.stderr || e.message || '').toString(),
      ok: false,
    };
  }
}

/// Streaming variant — spawns lens with piped stdout, calls `onLine` for
/// each stdout line as it arrives, then waits for exit. stderr is buffered
/// whole and surfaced on non-zero exit. Use for long-running operations
/// (ingest) where progress events matter.
export async function runLensCommandStreaming(args, onLine) {
  const bin = await resolveLensBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: lensEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutBuf = '';
    let stderrBuf = '';
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
    child.on('error', (err) => reject(new Error(`Failed to spawn lens: ${err.message}`)));
    child.on('close', (code) => {
      if (stdoutBuf.length > 0) { try { onLine(stdoutBuf.trim()); } catch {} }
      if (code !== 0) { reject(new Error(`lens exited non-zero:\n${stderrBuf}`)); return; }
      resolve();
    });
  });
}

/// Scrub `Bearer <token>` substrings from a string. Misbehaving proxies
/// sometimes echo our Authorization header in error bodies; this keeps
/// the API key out of UI + logs. Mirrors the Rust `redact_bearer`.
export function redactBearer(s) {
  let out = '';
  let rest = s;
  for (;;) {
    const idx = rest.indexOf('Bearer ');
    if (idx === -1) break;
    out += rest.slice(0, idx);
    out += 'Bearer [REDACTED]';
    rest = rest.slice(idx + 'Bearer '.length);
    // Skip the token itself up to the next terminator.
    const m = rest.search(/[\s",}\];]/);
    rest = m === -1 ? '' : rest.slice(m);
  }
  out += rest;
  return out;
}

/// Percent-encode a path string per RFC 3986 pchar rules, keeping `/` so
/// multi-segment FastAPI `:path` params still match. Encodes UTF-8 bytes
/// individually so any non-ASCII byte becomes %XX. encodeURIComponent
/// leaves too much (`'`, `!`, `*`) and also encodes `/`, so we roll our
/// own. Replaces the Rust `percent_encode_path`.
export function percentEncodePath(s) {
  const bytes = Buffer.from(s, 'utf8');
  let out = '';
  for (const b of bytes) {
    const isAlnum = (b >= 0x30 && b <= 0x39)
      || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A);
    const isUnreserved = b === 0x2D /* - */ || b === 0x2E /* . */
      || b === 0x5F /* _ */ || b === 0x7E /* ~ */ || b === 0x2F /* / */;
    if (isAlnum || isUnreserved) out += String.fromCharCode(b);
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

async function readApiKey() {
  return (await fs.readFile(apiKeyPath(), 'utf8')).trim();
}

/// GET http://127.0.0.1:8322<path> with bearer auth. Throws on HTTP !ok.
export async function lensHttpGet(pathSuffix, { timeoutMs = 10000 } = {}) {
  const apiKey = await readApiKey();
  const url = `http://${DEFAULT_HOST}:${DEFAULT_PORT}${pathSuffix}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: ctl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${redactBearer(body)}`);
    }
    return resp.json();
  } finally {
    clearTimeout(t);
  }
}

export async function lensHttpDelete(pathSuffix, { timeoutMs = 30000 } = {}) {
  const apiKey = await readApiKey();
  const url = `http://${DEFAULT_HOST}:${DEFAULT_PORT}${pathSuffix}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: ctl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${redactBearer(body)}`);
    }
    return resp.json();
  } finally {
    clearTimeout(t);
  }
}

// ── LensManager class ──────────────────────────────────────────────

export class LensManager {
  constructor() {
    this._child = null;
    this._startedAt = null;
    this._config = { host: DEFAULT_HOST, port: DEFAULT_PORT, reranker: false };
    // Serialize start/stop. Two concurrent start() calls would both see
    // `_child == null`, both spawn, and the second overwrite orphans the
    // first. Two start/stop pairs overlap the health-loop polling with a
    // new child. A promise-chain mutex is the smallest viable fix.
    this._lifecycleMutex = Promise.resolve();
    // AbortController per start() so stop() can tear down the health loop
    // immediately instead of letting it run out the full 60s timeout
    // against a child that's already been killed.
    this._startAbort = null;
  }

  /// Run `fn` under the lifecycle mutex. Returns fn's result. If fn
  /// throws, the chain is reset so the next caller isn't poisoned.
  _serialize(fn) {
    const pending = this._lifecycleMutex.then(fn, fn);
    // Detach errors from the chain; each caller sees its own error.
    this._lifecycleMutex = pending.then(() => undefined, () => undefined);
    return pending;
  }

  /// Poll the child — if it exited since we last checked, drop our handle
  /// and return the exit status. Mirrors the Rust `try_wait_child`. Without
  /// this, `running` would stay true forever after a crash.
  _tryReapChild() {
    if (!this._child) return null;
    const exitCode = this._child.exitCode;
    const signal = this._child.signalCode;
    if (exitCode !== null || signal !== null) {
      const reaped = { code: exitCode, signal };
      this._child = null;
      this._startedAt = null;
      return reaped;
    }
    return null;
  }

  start() { return this._serialize(() => this._startImpl()); }
  stop()  { return this._serialize(() => this._stopImpl()); }

  async _startImpl() {
    if (this._child && this._tryReapChild() === null) {
      throw new Error('Lens is already running');
    }

    // Sweep orphan lens processes from prior sessions. Tauri-era bug
    // pattern: dev-server restart reparents the spawned lens server to
    // PID 1 and its qdrant POSIX flock stays held, blocking every
    // subsequent ingest/delete/clear in this session. Same hazard
    // under Electron if the app is SIGKILLed.
    const killed = await killOrphanLensProcesses();
    if (killed > 0) {
      console.log(`[lens] Reaped ${killed} orphan process(es) before starting fresh server`);
      // Brief pause so the OS releases flock + port.
      await sleep(500);
    }

    const bin = await resolveLensBinary();
    const { host, port } = this._config;
    const gpu = await detectGpu();
    const gpuProvider = gpu.recommended_provider;

    const child = spawn(bin, [], {
      env: lensEnv({
        LENS_HOST: String(host),
        LENS_PORT: String(port),
        LENS_RERANKER: this._config.reranker ? '1' : '0',
        LENS_ONNX_PROVIDER: gpuProvider,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Pipe stdio somewhere so the pipes don't fill up and block the
    // child. We don't actively read these — lens writes logs to stderr
    // and we only care about them on crash.
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    this._child = child;
    this._startedAt = Date.now();

    // AbortController so stop() can short-circuit the health loop below
    // instead of letting it run out the full 60s after the child dies.
    const abort = new AbortController();
    this._startAbort = abort;
    try {
      // BGE-M3 cold start can take ~30s, wait up to 60s. Health check
      // polls 1/sec. If the child exits during startup, surface the
      // crash immediately instead of waiting out the timeout.
      await abortableSleep(3000, abort.signal);
      const healthUrl = `http://${host}:${port}/health`;
      for (let i = 0; i < 60; i++) {
        if (abort.signal.aborted) throw new Error('Lens start aborted');
        const exited = this._tryReapChild();
        if (exited) {
          throw new Error(`Lens sidecar exited during startup (code=${exited.code} signal=${exited.signal}). Check logs.`);
        }
        try {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), 2000);
          const signal = anyAbortSignal(ctl.signal, abort.signal);
          const resp = await fetch(healthUrl, { signal });
          clearTimeout(t);
          if (resp.ok) return;
        } catch {}
        await abortableSleep(1000, abort.signal);
      }
      throw new Error(`Lens sidecar did not become healthy within 60s at ${healthUrl}`);
    } finally {
      if (this._startAbort === abort) this._startAbort = null;
    }
  }

  async _stopImpl() {
    // Abort any in-flight start() health loop first — without this, the
    // loop keeps polling against a child we're about to kill and throws
    // "did not become healthy" for the caller who did start-then-stop.
    if (this._startAbort) { try { this._startAbort.abort(); } catch {} }
    const child = this._child;
    if (!child) return;
    this._child = null;
    this._startedAt = null;
    try { child.kill('SIGKILL'); } catch {}
    // Best-effort wait for exit, with timeout — don't let a zombie child
    // hang the shutdown path.
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 2000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  async status() {
    this._tryReapChild();
    const running = !!this._child;
    const uptime = this._startedAt ? Math.floor((Date.now() - this._startedAt) / 1000) : null;
    const { host, port } = this._config;
    const healthUrl = `http://${host}:${port}/health`;
    let health = null;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2000);
      const resp = await fetch(healthUrl, { signal: ctl.signal });
      clearTimeout(t);
      if (resp.ok) health = await resp.json().catch(() => ({ status: 'ok' }));
    } catch {}
    const gpu = await detectGpu();
    return {
      running,
      uptime_seconds: uptime,
      health,
      url: `http://${host}:${port}`,
      gpu: {
        vendor: gpu.vendor,
        name: gpu.name,
        provider: gpu.recommended_provider,
        runtime_installed: gpu.runtime_installed,
      },
    };
  }

  async configure(config) {
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      Object.assign(this._config, config);
    }
  }
}

// ── Orphan reaper ──────────────────────────────────────────────────

/// Kill any orphan lens server process whose kernel-reported executable
/// path matches our managed venv's lens binary. Returns the number killed.
/// Ports the Rust `kill_orphan_lens_processes`.
///
/// Match rule is `/proc/<pid>/exe` (symlink to the actual executable), not
/// argv — user-controlled argv could spoof the match. Linux is the high-
/// risk OS (Unix sockets + /proc), so we ship full detection there. macOS
/// and Windows fall back to best-effort (no reap, relies on the app
/// shutting down cleanly).
/// Public wrapper so main.js can reap orphans at app launch before the
/// renderer has had a chance to call start_lens.
export async function reapOrphanLensProcesses() {
  return killOrphanLensProcesses();
}

async function killOrphanLensProcesses() {
  if (process.platform !== 'linux') return 0;
  const ourBin = lensBinPath();
  const ourPid = process.pid;
  let entries;
  try { entries = await fs.readdir('/proc'); } catch { return 0; }
  let killed = 0;
  for (const pidStr of entries) {
    const pid = parseInt(pidStr, 10);
    if (!Number.isFinite(pid) || pid === ourPid) continue;
    let exe;
    try { exe = await fs.readlink(`/proc/${pid}/exe`); } catch { continue; }
    if (exe !== ourBin) continue;
    console.warn(`[lens] Killing orphan lens process pid=${pid} exe=${exe}`);
    try { process.kill(pid, 'SIGKILL'); killed += 1; } catch {}
  }
  return killed;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/// Sleep that rejects immediately when `signal` aborts. Used inside the
/// health-check loop so stop() can tear it down without waiting up to 60s.
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); cleanup(); reject(new Error('aborted')); };
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/// Merge N AbortSignals into one that fires when any of them does.
/// Used inside the health-check fetch so both the per-request 2s timer
/// and the outer stop() abort both cut short the request.
function anyAbortSignal(...signals) {
  const ctl = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) { ctl.abort(); break; }
    s.addEventListener('abort', () => ctl.abort(), { once: true });
  }
  return ctl.signal;
}
