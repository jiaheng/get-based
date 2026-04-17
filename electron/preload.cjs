// electron/preload.cjs — Context-isolated bridge between renderer and main.
//
// CommonJS (.cjs) because Electron's preload sandbox doesn't support ESM
// yet as of Electron 32 — runs as a classic script in an isolated world.
//
// Renderer code calls `window.api.invoke('command_name', args)` which
// round-trips through IPC to the main process's ipcMain.handle(...).
// The channel name MUST be in ALLOWED_INVOKE_CHANNELS below — contextBridge
// alone isolates heaps, not capabilities, and a compromised bundled vendor
// script (chart libs, pdf.js, etc.) could otherwise call destructive
// channels like `ingest_documents` or `install_update`. Explicit allowlist
// keeps the attack surface to exactly what the renderer needs.
//
// Platform detection: `window.api.isDesktop` is true inside Electron, false
// in plain-browser PWA. Replaces the old Tauri sniff.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Every channel we handle in electron/main.js. Adding a new ipcMain.handle
// call means adding the channel name here too — fail-closed by default.
const ALLOWED_INVOKE_CHANNELS = new Set([
  // Setup pipeline
  'get_setup_status', 'run_setup', 'reset_setup', 'cancel_setup',
  // GPU
  'detect_gpu', 'detect_all_gpus',
  // Native dialog
  'plugin:dialog|open',
  // Lens lifecycle
  'get_lens_status', 'start_lens', 'stop_lens', 'configure_lens',
  // Knowledge base
  'get_lens_config', 'ingest_documents', 'get_ingest_progress',
  'get_knowledge_stats', 'delete_document', 'clear_knowledge',
  // Library registry
  'list_libraries', 'create_library', 'activate_library',
  'rename_library', 'delete_library',
  // Auto-updater
  'check_for_update', 'install_update',
]);

// Event channels the main process is allowed to push to the renderer.
// Same fail-closed principle as invoke.
const ALLOWED_SUBSCRIBE_CHANNELS = new Set([
  'setup:progress',
]);

contextBridge.exposeInMainWorld('api', {
  isDesktop: true,
  platform: process.platform, // 'linux' | 'darwin' | 'win32'
  invoke: (channel, ...args) => {
    if (typeof channel !== 'string' || !ALLOWED_INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  // Reactive subscription bridge — main process pushes events to renderer
  // via webContents.send(channel, payload). Used for setup / ingest
  // progress streams. Returns an unsubscribe function.
  on: (channel, listener) => {
    if (typeof channel !== 'string' || !ALLOWED_SUBSCRIBE_CHANNELS.has(channel)) {
      throw new Error(`IPC subscription not allowed: ${channel}`);
    }
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  // Electron 32 deprecated File.path (the non-standard field Chromium used
  // to expose on File objects from drag-drop / <input type=file>). Under
  // sandbox:true it already returns empty or just the filename on some
  // platforms, so drag-drop of a .zip can deliver a relative path that
  // lens's `is_file()` check fails silently — falling through to walking
  // CWD. webUtils.getPathForFile is the supported replacement.
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); }
    catch { return ''; }
  },
});
