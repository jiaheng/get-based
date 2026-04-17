// electron/main.js — Electron main process entry point.
//
// Responsibilities (this file, scaffold phase):
//   1. Create the BrowserWindow
//   2. Load the existing HTML frontend
//   3. Wire context-isolated preload bridge so renderer can talk to Node
//
// In ELECTRON_DEV=1 mode the window points at the existing Node dev server
// (localhost:8000/app). In production / default mode it loads the static
// index.html directly. Both paths use the same preload script.
//
// Future phases will add to this file:
//   - ipcMain.handle('pick_files', …) for native file picker (replaces Tauri's plugin:dialog)
//   - Setup pipeline IPC (run_setup, get_setup_status, cancel_setup)
//   - LensManager IPC (start_lens, stop_lens, get_lens_status, ingest_documents, …)
//   - Evolu in-process bridge (evolu_query, evolu_mutate, evolu_subscribe)

import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const isDev = process.env.ELECTRON_DEV === '1';

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
}

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
