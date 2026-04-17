// electron/gpu.js — GPU + ONNX Runtime provider detection.
//
// Ports src-tauri/src/gpu.rs to Node. Surface is the same: `detectGpu()`
// returns the best single GPU, `detectAll()` returns every GPU found, and
// `pickEmbeddingModel(gpu, totalRamBytes)` tiers hardware into BGE-M3 vs
// MiniLM. Every output field mirrors the Rust `GpuInfo` struct so the
// renderer's `js/knowledge-base.js` consumer doesn't need to change shape.
//
// Detection strategy (matches Rust):
//   • NVIDIA → nvidia-smi (works on Linux and Windows)
//   • Linux AMD → rocm-smi, fall back to lspci + /sys/class/drm for VRAM
//   • Linux Intel → lspci + /sys/class/drm + Python `import openvino` probe
//   • macOS → sysctl for Apple Silicon, system_profiler JSON for discrete
//   • Windows non-NVIDIA → WMI via `wmic` (synchronous, ships with Windows)
//
// All external commands are wrapped with a timeout so a hung probe can't
// stall app startup. Output is best-effort: any probe that fails is treated
// as "no GPU of that kind here", not as a hard error.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);

/// Run an external command with stdout captured. Returns null when the
/// command isn't on PATH, exits non-zero, or exceeds the timeout — any of
/// those are expected outcomes when probing for GPU vendors that aren't
/// present.
async function tryExec(cmd, args, { timeoutMs = 3000 } = {}) {
  try {
    const { stdout } = await execFileP(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────

export async function detectGpu() {
  const all = await detectAll();
  return all[0] || defaultGpuInfo();
}

export async function detectAll() {
  const gpus = [];
  const nvidia = await detectNvidia();
  if (nvidia) gpus.push(nvidia);

  if (process.platform === 'win32') {
    gpus.push(...await detectWindowsNonNvidia());
  } else if (process.platform === 'darwin') {
    const apple = await detectApple();
    if (apple) gpus.push(apple);
    gpus.push(...await detectMacosDiscrete());
  } else {
    const amd = await detectAmdLinux();
    if (amd) gpus.push(amd);
    const intel = await detectIntelLinux();
    if (intel) gpus.push(intel);
  }

  if (gpus.length === 0) gpus.push(defaultGpuInfo());
  return gpus;
}

export function defaultGpuInfo() {
  return {
    vendor: 'unknown',
    name: 'No GPU detected',
    driver_version: null,
    vram_mb: null,
    architecture: null,
    recommended_provider: 'cpu',
    runtime_installed: false,
    vram_is_unified: false,
    summary: 'No dedicated GPU found. CPU inference will be used.',
  };
}

// ── NVIDIA (cross-platform via nvidia-smi) ─────────────────────────

async function detectNvidia() {
  const out = await tryExec('nvidia-smi', [
    '--query-gpu=name,driver_version,memory.total,compute_cap',
    '--format=csv,noheader,nounits',
  ]);
  if (!out) return null;

  // Pick the row with the most VRAM if multiple GPUs are present.
  let best = null;
  let bestVram = -1;
  for (const line of out.split('\n')) {
    const parts = line.trim().split(',').map((s) => s.trim());
    if (parts.length < 2 || !parts[0]) continue;
    const vram = parseInt(parts[2] || '', 10) || 0;
    if (vram > bestVram) {
      bestVram = vram;
      best = parts;
    }
  }
  if (!best) return null;

  const name = best[0];
  const driverVersion = best[1] || null;
  const vramMb = Number.isFinite(parseInt(best[2], 10)) ? parseInt(best[2], 10) : null;
  const computeCap = best[3] || null;
  const architecture = computeCap ? nvidiaArchFromComputeCap(computeCap) : null;

  const parts = [name];
  if (architecture) parts[0] += ` (${architecture})`;
  if (vramMb != null) parts[0] += `, ${vramMb} MB VRAM`;
  parts.push(`driver ${driverVersion ?? '?'}`);
  parts.push('CUDA ready');
  const summary = parts.join(', ');

  return {
    vendor: 'nvidia',
    name,
    driver_version: driverVersion,
    vram_mb: vramMb,
    architecture,
    recommended_provider: 'cuda',
    runtime_installed: true,
    vram_is_unified: false,
    summary,
  };
}

function nvidiaArchFromComputeCap(cc) {
  const [majStr, minStr] = cc.split('.');
  const major = parseInt(majStr, 10) || 0;
  const minor = parseInt(minStr, 10) || 0;
  if (major === 12) return 'Blackwell';
  if (major === 9) return 'Hopper';
  if (major === 8 && minor === 9) return 'Ada Lovelace';
  if (major === 8) return 'Ampere';
  if (major === 7 && minor === 5) return 'Turing';
  if (major === 7 && (minor === 0 || minor === 2)) return 'Volta';
  if (major === 6) return 'Pascal';
  if (major === 5) return 'Maxwell';
  return `Compute ${cc}`;
}

// ── AMD (Linux) ────────────────────────────────────────────────────

async function detectAmdLinux() {
  const rocm = await detectAmdRocm();
  if (rocm) return rocm;
  return detectAmdLspci();
}

async function detectAmdRocm() {
  const out = await tryExec('rocm-smi', ['--showproductname', '--showmeminfo', 'vram']);
  if (!out) return null;

  const lines = out.split('\n');
  const nameLine = lines.find((l) => l.includes('Card series:') || l.includes('GPU id:'));
  const name = nameLine
    ? (nameLine.split(':').pop() || 'AMD GPU').trim()
    : 'AMD GPU';

  const vramLine = lines.find((l) => l.includes('Total VRAM') || l.includes('VRAM'));
  let vramMb = null;
  if (vramLine) {
    for (const word of vramLine.split(/\s+/)) {
      const n = parseInt(word, 10);
      if (Number.isFinite(n) && n > 0) { vramMb = n; break; }
    }
  }

  const architecture = amdArchFromName(name);
  const summary = `${name} (ROCm), ${vramMb ? `${vramMb} MB VRAM` : 'VRAM unknown'}`;

  return {
    vendor: 'amd',
    name,
    driver_version: null,
    vram_mb: vramMb,
    architecture,
    recommended_provider: 'rocm',
    runtime_installed: true,
    vram_is_unified: false,
    summary,
  };
}

/// Read total VRAM (in MB) for the highest-capacity card matching the given
/// PCI vendor ID. Mirrors the Rust `drm_sysfs_vram_mb` helper. Returns null
/// when no matching card exists or mem_info_vram_total is absent (iGPUs).
async function drmSysfsVramMb(vendorId) {
  let entries;
  try {
    entries = await fs.readdir('/sys/class/drm');
  } catch {
    return null;
  }
  let bestMb = 0;
  for (const entry of entries) {
    // Only "card0", "card1" — skip "card0-HDMI-A-1" output connector nodes.
    if (!entry.startsWith('card') || entry.includes('-')) continue;
    const devDir = path.join('/sys/class/drm', entry, 'device');
    try {
      const thisVendor = (await fs.readFile(path.join(devDir, 'vendor'), 'utf8')).trim();
      if (thisVendor.toLowerCase() !== vendorId.toLowerCase()) continue;
      const bytesStr = (await fs.readFile(path.join(devDir, 'mem_info_vram_total'), 'utf8')).trim();
      const bytes = parseInt(bytesStr, 10);
      if (!Number.isFinite(bytes)) continue;
      const mb = Math.floor(bytes / 1024 / 1024);
      if (mb > bestMb) bestMb = mb;
    } catch {
      // Missing file / permissions / iGPU — move on.
    }
  }
  return bestMb === 0 ? null : bestMb;
}

async function detectAmdLspci() {
  const out = await tryExec('lspci', ['-mm']);
  if (!out) return null;
  // lspci -mm row layout (quoted fields): [0] class code ws, [1] class, [3]
  // vendor, [5] device, [7] subsys vendor, [9] subsys device. We match on the
  // vendor (fields[3]) and surface the device (fields[5]) as the display name.
  // Naive substring checks on the whole row falsely match "ati" inside
  // "Corporation" on Intel rows — the Rust source had the same bug and we fix
  // it here by only testing the vendor field.
  const line = out.split('\n').find((l) => {
    const fields = l.split('"');
    const cls = (fields[1] || '').toLowerCase();
    const vendor = fields[3] || '';
    const isDisplay = cls.includes('vga') || cls.includes('display') || cls.includes('3d');
    // Match on "Advanced Micro" or word-boundary ATI/AMD. Naive substring
    // checks for "ati" / "amd" falsely match "Corporation" / "vmmd" etc.
    const isAmd = /advanced micro|\b(ati|amd|radeon)\b/i.test(vendor);
    return isDisplay && isAmd;
  });
  if (!line) return null;

  const fields = line.split('"');
  const name = (fields[5] || 'AMD GPU').trim();
  const architecture = amdArchFromName(name);
  const vramMb = await drmSysfsVramMb('0x1002');

  return {
    vendor: 'amd',
    name,
    driver_version: null,
    vram_mb: vramMb,
    architecture,
    recommended_provider: 'rocm',
    runtime_installed: false,
    vram_is_unified: false,
    summary: `${name} detected via PCI. ROCm not installed — CPU fallback. Install ROCm for GPU acceleration.`,
  };
}

// ── Intel (Linux) ──────────────────────────────────────────────────

async function detectIntelLinux() {
  const out = await tryExec('lspci', ['-mm']);
  if (!out) return null;
  const line = out.split('\n').find((l) => {
    const fields = l.split('"');
    const cls = (fields[1] || '').toLowerCase();
    const vendor = (fields[3] || '').toLowerCase();
    const isDisplay = cls.includes('vga') || cls.includes('display') || cls.includes('3d');
    const isIntel = vendor.includes('intel');
    return isDisplay && isIntel;
  });
  if (!line) return null;

  const fields = line.split('"');
  const name = (fields[5] || 'Intel GPU').trim();
  const architecture = intelArchFromName(name);

  // OpenVINO runtime probe — installed system-wide via `pip install openvino`
  // on the user's Python3 (not the managed venv, which doesn't exist yet at
  // first-run detection time). Returns false when Python3 isn't on PATH.
  const runtimeInstalled = !!(await tryExec('python3', ['-c', 'import openvino']));
  const vramMb = await drmSysfsVramMb('0x8086');

  return {
    vendor: 'intel',
    name,
    driver_version: null,
    vram_mb: vramMb,
    architecture,
    recommended_provider: 'openvino',
    runtime_installed: runtimeInstalled,
    vram_is_unified: false,
    summary: runtimeInstalled
      ? `${name}, OpenVINO ready`
      : `${name}, install OpenVINO for acceleration`,
  };
}

// ── Windows (non-NVIDIA via WMI) ───────────────────────────────────

async function detectWindowsNonNvidia() {
  // wmic ships with every Windows since XP, so we don't need node-wmi or a
  // native binding. Output is CSV-ish with a header row. Powershell's
  // Get-CimInstance would be cleaner but adds a 300ms startup tax per call.
  const out = await tryExec('wmic', [
    'path', 'Win32_VideoController',
    'get', 'Name,AdapterRAM,DriverVersion',
    '/format:csv',
  ], { timeoutMs: 5000 });
  if (!out) return [];

  const results = [];
  const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  // Header row tells us column order — wmic doesn't guarantee it.
  const header = lines[0].split(',').map((s) => s.trim());
  const idxName = header.indexOf('Name');
  const idxRam = header.indexOf('AdapterRAM');
  const idxDriver = header.indexOf('DriverVersion');

  for (const line of lines.slice(1)) {
    const cells = line.split(',').map((s) => s.trim());
    const name = cells[idxName] || '';
    if (!name) continue;
    const lower = name.toLowerCase();

    // Skip NVIDIA (handled by nvidia-smi) and Windows virtual adapters.
    if (lower.includes('nvidia') || lower.includes('geforce')
        || lower.includes('quadro') || lower.includes('tesla')) continue;
    if (lower.includes('basic display') || lower.includes('microsoft remote')) continue;

    const driverVersion = cells[idxDriver] || null;
    const vramBytesRaw = parseInt(cells[idxRam] || '', 10);
    // WMI AdapterRAM is a UINT32 capped at ~4 GB — any ≥4 GB card reports
    // 4294836224. Rust-era comment: real fix is DXGI QueryVideoMemoryInfo,
    // tracked as follow-up; for now, cards ≥4 GB look like 4 GB which errs
    // toward MiniLM (safe false negative).
    const vramMb = Number.isFinite(vramBytesRaw) ? Math.floor(vramBytesRaw / 1024 / 1024) : null;

    let vendor = 'unknown';
    let architecture = null;
    if (lower.includes('amd') || lower.includes('radeon') || lower.includes('ati')) {
      vendor = 'amd';
      architecture = amdArchFromName(name);
    } else if (lower.includes('intel') || lower.includes('arc')) {
      vendor = 'intel';
      architecture = intelArchFromName(name);
    }

    const summaryParts = [name];
    if (architecture) summaryParts[0] += ` (${architecture})`;
    if (vramMb != null) summaryParts[0] += `, ${vramMb} MB VRAM`;
    summaryParts.push('DirectML on Windows');

    results.push({
      vendor,
      name,
      driver_version: driverVersion,
      vram_mb: vramMb,
      architecture,
      // DirectML works for any DX12-capable GPU on Windows 10+ — best
      // portable choice and its ONNX Runtime wheel is on PyPI.
      recommended_provider: 'directml',
      runtime_installed: true,
      vram_is_unified: false,
      summary: summaryParts.join(', '),
    });
  }
  return results;
}

// ── macOS ──────────────────────────────────────────────────────────

async function detectApple() {
  const armOut = await tryExec('sysctl', ['-n', 'hw.optional.arm64']);
  const arm = armOut ? armOut.trim() === '1' : false;

  const brandOut = await tryExec('sysctl', ['-n', 'machdep.cpu.brand_string']);
  const chipBrand = brandOut ? brandOut.trim() : '';

  let vendor, name, architecture;
  if (arm) {
    vendor = 'apple';
    name = chipBrand;
    architecture = appleArchFromName(chipBrand);
  } else {
    // Intel Mac CoreML still works (uses Metal). Dedicated VRAM — if any —
    // comes from detectMacosDiscrete. This entry represents the Intel CPU
    // side so the runtime path surfaces in UI even without a discrete card.
    vendor = 'intel';
    name = `${chipBrand} (Intel Mac)`;
    architecture = null;
  }

  // Unified memory on Apple Silicon: hw.memsize reports total RAM, which IS
  // the pool the GPU can use. Intel Macs report the same value but they have
  // dedicated VRAM for discrete cards — mark as non-unified so the threshold
  // logic uses the discrete VRAM instead.
  const memOut = await tryExec('sysctl', ['-n', 'hw.memsize']);
  const memBytes = memOut ? parseInt(memOut.trim(), 10) : NaN;
  const vramMb = Number.isFinite(memBytes) ? Math.floor(memBytes / 1024 / 1024) : null;

  const summary = arm
    ? `${name} — CoreML acceleration (unified memory)`
    : `${name} — CoreML on Intel Mac`;

  return {
    vendor,
    name,
    driver_version: null,
    vram_mb: vramMb,
    architecture,
    recommended_provider: 'coreml',
    runtime_installed: true,
    vram_is_unified: arm,
    summary,
  };
}

async function detectMacosDiscrete() {
  const out = await tryExec('system_profiler', ['SPDisplaysDataType', '-json'], { timeoutMs: 5000 });
  if (!out) return [];
  let json;
  try { json = JSON.parse(out); } catch { return []; }
  const displays = Array.isArray(json?.SPDisplaysDataType) ? json.SPDisplaysDataType : [];
  const results = [];
  for (const d of displays) {
    const name = (d?.sppci_model || d?._name || '').toString();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (lower.includes('apple')) continue; // handled by detectApple

    let vendor;
    if (lower.includes('amd') || lower.includes('radeon')) vendor = 'amd';
    else if (lower.includes('intel')) vendor = 'intel';
    else if (lower.includes('nvidia') || lower.includes('geforce')) vendor = 'nvidia';
    else continue;

    const vramStr = d?.sppci_vram || d?.spdisplays_vram;
    const vramMb = vramStr ? parseVramString(vramStr) : null;
    let architecture = null;
    if (vendor === 'amd') architecture = amdArchFromName(name);
    else if (vendor === 'intel') architecture = intelArchFromName(name);

    results.push({
      vendor,
      name,
      driver_version: null,
      vram_mb: vramMb,
      architecture,
      // Intel Mac discrete cards run inference via CoreML's Metal backend;
      // picking CoreML here matches what the Rust code does.
      recommended_provider: 'coreml',
      runtime_installed: true,
      vram_is_unified: false,
      summary: `${name} on Intel Mac — CoreML/Metal`,
    });
  }
  return results;
}

function parseVramString(s) {
  const parts = String(s).split(/\s+/);
  if (parts.length < 2) return null;
  const n = parseInt(parts[0], 10);
  if (!Number.isFinite(n)) return null;
  const unit = parts[1].toUpperCase();
  if (unit.startsWith('GB')) return n * 1024;
  if (unit.startsWith('MB')) return n;
  return null;
}

// ── Architecture name helpers ──────────────────────────────────────

function amdArchFromName(name) {
  const lower = name.toLowerCase();
  if (lower.includes('rx 907') || lower.includes('rdna4')) return 'RDNA 4';
  if (lower.includes('rx 7') || lower.includes('rx 8') || lower.includes('rdna3')) return 'RDNA 3';
  if (lower.includes('rx 6') || lower.includes('rdna2')) return 'RDNA 2';
  if (lower.includes('rx 5') || lower.includes('rdna')) return 'RDNA 1';
  if (lower.includes('mi300') || lower.includes('mi250') || lower.includes('cdna')) return 'CDNA';
  return null;
}

function intelArchFromName(name) {
  const lower = name.toLowerCase();
  if (lower.includes('battlemage') || lower.includes('arc b')) return 'Battlemage';
  if (lower.includes('alchemist') || lower.includes('arc a')
      || lower.includes('arc 7') || lower.includes('arc 5') || lower.includes('arc 3')) return 'Alchemist';
  if (lower.includes('celestial')) return 'Celestial';
  if (lower.includes('xe')) return 'Xe';
  return null;
}

function appleArchFromName(name) {
  const lower = name.toLowerCase();
  if (lower.includes('m5')) return 'M5';
  if (lower.includes('m4')) return 'M4';
  if (lower.includes('m3')) return 'M3';
  if (lower.includes('m2')) return 'M2';
  if (lower.includes('m1')) return 'M1';
  return null;
}

// ── Model selection ────────────────────────────────────────────────

export const MODEL_BGE_M3 = 'BAAI/bge-m3';
export const MODEL_MINILM = 'sentence-transformers/all-MiniLM-L6-v2';

/// Mirrors the Rust `pick_embedding_model` tiers. Inputs are the GpuInfo
/// struct + total system RAM in bytes (from `os.totalmem()`). Output is a
/// Hugging Face repo id the Python downloader can hand to snapshot_download.
///
///   1. Usable discrete GPU (CUDA / DirectML / CoreML) with ≥ 6 GB VRAM → BGE-M3
///   2. Apple Silicon unified memory ≥ 16 GB → BGE-M3
///   3. CPU-only with ≥ 24 GB system RAM → BGE-M3
///   4. Everything else → MiniLM
///
/// ROCm is intentionally excluded from tier 1 because PyPI has no
/// `onnxruntime-rocm` wheel — a ROCm-flagged card would run on CPU anyway,
/// and a false positive would put it back on the thrashing path the
/// tiering exists to prevent.
export function pickEmbeddingModel(gpu, totalRamBytes) {
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  const vramMb = gpu?.vram_mb ?? 0;
  const accel = gpu?.runtime_installed && (
    gpu.recommended_provider === 'cuda'
    || gpu.recommended_provider === 'directml'
    || gpu.recommended_provider === 'coreml'
  );

  if (accel && gpu.vram_is_unified && vramMb >= 16 * 1024) return MODEL_BGE_M3;
  if (accel && !gpu.vram_is_unified && vramMb >= 6 * 1024) return MODEL_BGE_M3;
  if (totalRamBytes >= 24 * GB) return MODEL_BGE_M3;
  return MODEL_MINILM;
}
