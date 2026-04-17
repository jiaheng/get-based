// electron/paths.js — platform data directory resolver.
//
// Ports the Rust dirs::data_dir() helpers from src-tauri/src/setup.rs and
// src-tauri/src/lens.rs. Every on-disk Lens artifact — Python runtime, venv,
// downloaded models, setup-complete marker, generated API key — lives under
// `<platform data dir>/getbased/lens/…`.
//
// Per-OS resolution (matches the Rust `dirs` crate, which in turn matches the
// per-OS conventions most users expect):
//   macOS   → ~/Library/Application Support/getbased/…
//   Linux   → $XDG_DATA_HOME or ~/.local/share/getbased/…
//   Windows → %APPDATA%\getbased\…  (Roaming, not Local)
//
// We DO NOT use Electron's app.getPath('userData') because that points at
// `<dataDir>/<appName>` and `appName` defaults to the package.json `name`
// ("getbased") with a trailing slash layout that differs from dirs::data_dir.
// Staying platform-native — and compatible with the Rust-era install — lets
// returning users keep their downloaded Python + venv across the migration.

import path from 'node:path';
import os from 'node:os';

function userDataDir() {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support');
    case 'win32':
      // Roaming, mirrors dirs::data_dir() on Windows.
      return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    default: {
      // XDG_DATA_HOME, falling back to ~/.local/share — mirrors dirs::data_dir()
      // on Linux / BSDs.
      const xdg = process.env.XDG_DATA_HOME;
      if (xdg && xdg.length > 0) return xdg;
      return path.join(os.homedir(), '.local', 'share');
    }
  }
}

export function dataDir() {
  return path.join(userDataDir(), 'getbased');
}

export function lensDir() {
  return path.join(dataDir(), 'lens');
}

export function pythonDir() {
  return path.join(lensDir(), 'python');
}

export function venvDir() {
  return path.join(lensDir(), 'venv');
}

export function modelsDir() {
  return path.join(lensDir(), 'models');
}

export function lensSourceDir() {
  return path.join(lensDir(), 'lens-source');
}

export function setupMarkerPath() {
  return path.join(lensDir(), '.setup-complete');
}

export function embeddingModelPath() {
  return path.join(lensDir(), 'embedding_model');
}

export function apiKeyPath() {
  return path.join(lensDir(), 'api_key');
}

/// Python interpreter inside the downloaded standalone distribution.
/// python-build-standalone's install_only archives unpack to
/// `python/bin/python3` on POSIX and `python/python.exe` on Windows.
export function pythonBinPath() {
  return process.platform === 'win32'
    ? path.join(pythonDir(), 'python.exe')
    : path.join(pythonDir(), 'bin', 'python3');
}

/// pip inside the managed venv. Windows venvs use `Scripts/` instead of `bin/`.
export function venvPipPath() {
  return process.platform === 'win32'
    ? path.join(venvDir(), 'Scripts', 'pip.exe')
    : path.join(venvDir(), 'bin', 'pip');
}

/// Lens CLI entry point installed by pip into the venv.
export function lensBinPath() {
  return process.platform === 'win32'
    ? path.join(venvDir(), 'Scripts', 'lens.exe')
    : path.join(venvDir(), 'bin', 'lens');
}
