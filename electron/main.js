// electron/main.js — Electron main process entry point.
//
// Responsibilities:
//   1. Create the BrowserWindow + load the existing HTML frontend.
//   2. Wire the context-isolated preload bridge so renderer → Node calls route
//      through ipcMain.handle (window.api.invoke('cmd', args)).
//   3. Register the full Lens IPC surface: setup pipeline, GPU detection,
//      lens server control (phase 3, still stubbed), knowledge-base queries.
//
// In ELECTRON_DEV=1 mode the window points at the existing Node dev server
// (localhost:8000/app). Packaged mode loads the static index.html directly.
// Both paths use the same preload script and the same IPC surface.
//
// Future phases will extend this file:
//   - Phase 3: replace the stubbed lens:* handlers with electron/lens-manager.js
//   - Phase 4: renderer JS swaps isTauri() → isDesktop() to talk to these handlers
//   - Phase 7: electron-updater wiring for check_for_update / install_update

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SetupManager } from './setup.js';
import { detectGpu, detectAll } from './gpu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const isDev = process.env.ELECTRON_DEV === '1';

let mainWindow = null;
let setupManager = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'getbased — Health Dashboard',
    webPreferences: {
      // Security defaults — renderer stays sandboxed; all Node access
      // routes through the preload bridge's contextBridge API.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow = win;

  if (isDev) {
    // Dev mode: talk to the existing Node dev-server at localhost:8000.
    // Same URL the PWA uses, so we get hot-iteration on the frontend
    // without any bundler plumbing. Start dev-server separately:
    //   npm run dev-server   # in one terminal
    //   npm run electron:dev # in another
    win.loadURL('http://localhost:8000/app');
    win.webContents.openDevTools();
  } else {
    // Packaged / file-load mode: serve index.html from the app bundle.
    win.loadFile(path.join(projectRoot, 'index.html'));
  }

  // External links (target=_blank, window.open) open in the user's default
  // browser instead of spawning extra Electron windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
}

// ── IPC: setup pipeline ────────────────────────────────────────────
//
// Command names match the Tauri-era surface (snake_case) so the renderer
// call sites in js/knowledge-base.js, js/setup.js, js/updater.js only need
// the isTauri() → isDesktop() rename in phase 4. Progress events stream
// out as `setup:progress` — the KB poll loop in knowledge-base.js also
// works unchanged since it polls via get_setup_status.

function broadcastProgress(phase) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('setup:progress', phase);
  }
}

function getSetupManager() {
  if (!setupManager) setupManager = new SetupManager({ onProgress: broadcastProgress });
  return setupManager;
}

ipcMain.handle('get_setup_status', async () => getSetupManager().status());
ipcMain.handle('run_setup', async () => getSetupManager().run());
ipcMain.handle('reset_setup', async () => getSetupManager().reset());
ipcMain.handle('cancel_setup', async () => getSetupManager().cancel());

// ── IPC: GPU detection ─────────────────────────────────────────────

ipcMain.handle('detect_gpu', async () => detectGpu());
ipcMain.handle('detect_all_gpus', async () => detectAll());

// ── IPC: native dialogs (replaces Tauri plugin:dialog|open) ────────
//
// Renderer calls: invoke('plugin:dialog|open', { options: {...} }). We
// translate to Electron's dialog.showOpenDialog and return either a string
// (single-select) or an array (multi-select) or null (cancelled), matching
// what Tauri's plugin returned.

ipcMain.handle('plugin:dialog|open', async (_event, args) => {
  const options = args?.options || {};
  const filters = Array.isArray(options.filters) ? options.filters : [];
  const properties = [];
  if (options.directory) properties.push('openDirectory');
  else properties.push('openFile');
  if (options.multiple) properties.push('multiSelections');

  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    filters,
    properties,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  if (options.multiple) return result.filePaths;
  return result.filePaths[0];
});

// ── IPC: lens server + knowledge base (phase 3 stubs) ──────────────
//
// These are stubbed until electron/lens-manager.js lands. We register them
// anyway so the renderer doesn't hit "No handler registered" errors — the
// stubs return the same shape as the real implementation will, just with
// empty / not-running values. Real behavior comes in phase 3 of the port.

ipcMain.handle('get_lens_status', async () => ({ running: false }));
ipcMain.handle('start_lens', async () => { throw new Error('Lens manager not yet ported (phase 3)'); });
ipcMain.handle('stop_lens', async () => {});
ipcMain.handle('configure_lens', async () => {});
ipcMain.handle('get_lens_config', async () => {
  throw new Error('Lens manager not yet ported (phase 3)');
});
ipcMain.handle('ingest_documents', async () => {
  throw new Error('Lens manager not yet ported (phase 3)');
});
ipcMain.handle('get_ingest_progress', async () => null);
ipcMain.handle('get_knowledge_stats', async () => ({ total_chunks: 0, documents: [] }));
ipcMain.handle('delete_document', async () => 0);
ipcMain.handle('clear_knowledge', async () => 0);

// ── IPC: auto-updater (phase 7 stubs) ──────────────────────────────

ipcMain.handle('check_for_update', async () => ({
  available: false,
  current_version: app.getVersion(),
  new_version: null,
  notes: null,
  date: null,
}));
ipcMain.handle('install_update', async () => {
  throw new Error('Auto-updater not yet wired (phase 7)');
});

// ── App lifecycle ──────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    // macOS: re-create window if dock icon is clicked with no windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Standard Electron pattern: quit on all-closed except macOS.
  if (process.platform !== 'darwin') app.quit();
});
