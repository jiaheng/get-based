// electron/preload.cjs — Context-isolated bridge between renderer and main.
//
// CommonJS (.cjs) because Electron's preload sandbox doesn't support ESM
// yet as of Electron 32 — runs as a classic script in an isolated world.
//
// Renderer code calls `window.api.invoke('command_name', args)` which
// round-trips through IPC to the main process's ipcMain.handle('command_name').
// Mirrors Tauri's `window.__TAURI_INTERNALS__.invoke(…)` surface so the JS
// call sites in knowledge-base.js / setup.js / updater.js port via a simple
// find/replace.
//
// Platform detection: `window.api.isDesktop` is true inside Electron, false
// in plain-browser PWA. Replaces Tauri's `!!(window.__TAURI_INTERNALS__)`
// sniff the existing modules use.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  isDesktop: true,
  platform: process.platform, // 'linux' | 'darwin' | 'win32'
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  // Reactive subscription bridge — main process pushes events to renderer
  // via webContents.send(channel, payload). Added for Evolu subscriptions
  // and setup / ingest progress streams. Returns an unsubscribe function.
  on: (channel, listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
