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
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SetupManager } from './setup.js';
import { detectGpu, detectAll } from './gpu.js';
import {
  LensManager, runLensCommand, runLensCommandStreaming,
  lensHttpGet, lensHttpDelete, percentEncodePath,
} from './lens-manager.js';
import { apiKeyPath } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const isDev = process.env.ELECTRON_DEV === '1';

let mainWindow = null;
let setupManager = null;
let lensManager = null;
// In-flight ingest progress — the renderer polls via get_ingest_progress,
// matching the Tauri-era IngestState. Reset at the start of every ingest
// so tail state from a previous call doesn't leak into the UI.
let ingestProgress = null;

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

// ── IPC: lens sidecar lifecycle ────────────────────────────────────

function getLensManager() {
  if (!lensManager) lensManager = new LensManager();
  return lensManager;
}

ipcMain.handle('get_lens_status', async () => getLensManager().status());
ipcMain.handle('start_lens', async () => getLensManager().start());
ipcMain.handle('stop_lens', async () => getLensManager().stop());
ipcMain.handle('configure_lens', async (_event, args) => {
  await getLensManager().configure(args?.config || args || {});
});

// ── IPC: knowledge base queries ────────────────────────────────────
//
// Strategy (ports main.rs):
//   • Prefer HTTP to the running lens server where possible — bypasses the
//     qdrant POSIX flock that a CLI subprocess would fight over.
//   • Fall back to the CLI when the server isn't up (e.g. first-run right
//     after setup, before start_lens fires).
//   • For CLI paths that mutate qdrant, wrap in withLensPaused so the
//     running server temporarily releases the flock.

/// Stop the running lens server, run `body`, restart if it was running.
/// Mirrors the Rust `with_lens_paused`. 300 ms settle lets the OS drop the
/// POSIX flock before the CLI subprocess tries to acquire it.
async function withLensPaused(body) {
  const mgr = getLensManager();
  const s = await mgr.status().catch(() => ({ running: false }));
  const wasRunning = !!s?.running;
  if (wasRunning) {
    try { await mgr.stop(); } catch (e) { console.warn('[kb] Failed to stop lens server:', e.message); }
    await new Promise((r) => setTimeout(r, 300));
  }
  try {
    return await body();
  } finally {
    if (wasRunning) {
      try { await mgr.start(); } catch (e) { console.warn('[kb] Failed to restart lens server:', e.message); }
    }
  }
}

/// Return the local lens server URL + API key for auto-fill into Custom
/// Knowledge Source. Generates a key on first call via `lens key`.
ipcMain.handle('get_lens_config', async () => {
  let apiKey;
  try {
    apiKey = (await fs.readFile(apiKeyPath(), 'utf8')).trim();
  } catch {
    const { stdout, stderr, ok } = await runLensCommand(['key']);
    if (!ok) throw new Error(`Failed to generate key: ${stderr}`);
    apiKey = stdout.trim();
  }
  return { url: 'http://127.0.0.1:8322/query', api_key: apiKey, top_k: 5 };
});

ipcMain.handle('get_ingest_progress', async () => ingestProgress);

/// Ingest documents into the local knowledge base. Handles multiple paths;
/// each is ingested independently and results are summed. Streams the lens
/// CLI's JSONL output so per-file progress lands in ingestProgress while
/// the command runs — the frontend polls get_ingest_progress for the
/// live counter. The final non-event JSON line is the IngestResult.
ipcMain.handle('ingest_documents', async (_event, args) => {
  const paths = args?.req?.paths || [];
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('No paths provided');
  }
  // Reset at the start so a previous run's tail state doesn't leak.
  ingestProgress = { current: 0, total: 0, source: '', chunks_so_far: 0, started_at_ms: Date.now() };

  try {
    return await withLensPaused(async () => {
      const total = { files_seen: 0, chunks_indexed: 0, skipped: [] };
      for (const p of paths) {
        let finalLine = null;
        await runLensCommandStreaming(['ingest', '--json', p], (line) => {
          let parsed;
          try { parsed = JSON.parse(line); } catch { return; }
          const event = parsed?.event;
          if (event === 'start') {
            if (ingestProgress) {
              ingestProgress.total = Number(parsed.total) || 0;
            }
          } else if (event === 'file') {
            if (ingestProgress) {
              ingestProgress.current = Number(parsed.index) || 0;
              ingestProgress.total = Number(parsed.total) || ingestProgress.total;
              ingestProgress.source = String(parsed.source || '');
              const added = Number(parsed.chunks) || 0;
              ingestProgress.chunks_so_far += added;
            }
          } else {
            // No event tag → the final result line from lens ingest.
            finalLine = line;
          }
        }).catch((e) => { throw new Error(`Ingest of ${p} failed: ${e.message}`); });

        if (!finalLine) throw new Error(`Ingest of ${p} produced no result line`);
        let parsed;
        try { parsed = JSON.parse(finalLine.trim()); }
        catch (e) { throw new Error(`Bad ingest JSON: ${e.message}`); }
        if (parsed.error) throw new Error(`Ingest error: ${parsed.error}`);
        total.files_seen += Number(parsed.files_seen) || 0;
        total.chunks_indexed += Number(parsed.chunks_indexed) || 0;
        if (Array.isArray(parsed.skipped)) {
          for (const s of parsed.skipped) if (typeof s === 'string') total.skipped.push(s);
        }
      }
      return total;
    });
  } finally {
    // Always clear so the UI stops showing "N of M" after exit.
    ingestProgress = null;
  }
});

ipcMain.handle('get_knowledge_stats', async () => {
  const mgr = getLensManager();
  const s = await mgr.status().catch(() => ({ running: false }));
  if (s?.running) {
    try {
      const v = await lensHttpGet('/stats');
      const documents = Array.isArray(v?.documents)
        ? v.documents.map((d) => ({ source: String(d.source || ''), chunks: Number(d.chunks) || 0 }))
        : [];
      return { total_chunks: Number(v?.total_chunks) || 0, documents };
    } catch (e) {
      console.warn('[kb] HTTP stats failed, falling back to CLI:', e.message);
    }
  }
  const { stdout, stderr, ok } = await runLensCommand(['stats', '--json']);
  if (!ok) throw new Error(`Stats failed: ${stderr}`);
  let parsed;
  try { parsed = JSON.parse(stdout.trim()); }
  catch (e) { throw new Error(`Bad stats JSON: ${e.message}`); }
  if (parsed.error) throw new Error(parsed.error);
  const documents = Array.isArray(parsed.documents)
    ? parsed.documents.map((d) => ({ source: String(d.source || ''), chunks: Number(d.chunks) || 0 }))
    : [];
  return { total_chunks: Number(parsed.total_chunks) || 0, documents };
});

ipcMain.handle('delete_document', async (_event, args) => {
  const source = args?.source;
  if (!source) throw new Error('No source provided');
  const mgr = getLensManager();
  const s = await mgr.status().catch(() => ({ running: false }));
  if (s?.running) {
    try {
      const v = await lensHttpDelete(`/sources/${percentEncodePath(source)}`);
      return Number(v?.deleted_chunks) || 0;
    } catch (e) {
      console.warn('[kb] HTTP delete failed, falling back to CLI:', e.message);
    }
  }
  return withLensPaused(async () => {
    const { stdout, stderr, ok } = await runLensCommand(['delete', '--json', source]);
    if (!ok) throw new Error(`Delete failed: ${stderr}`);
    let parsed;
    try { parsed = JSON.parse(stdout.trim()); }
    catch (e) { throw new Error(`Bad delete JSON: ${e.message}`); }
    return Number(parsed?.deleted_chunks) || 0;
  });
});

ipcMain.handle('clear_knowledge', async () => {
  const mgr = getLensManager();
  const s = await mgr.status().catch(() => ({ running: false }));
  if (s?.running) {
    try {
      const v = await lensHttpDelete('/sources');
      return Number(v?.deleted_chunks) || 0;
    } catch (e) {
      console.warn('[kb] HTTP clear failed, falling back to CLI:', e.message);
    }
  }
  return withLensPaused(async () => {
    const { stdout, stderr, ok } = await runLensCommand(['clear', '--json', '--yes']);
    if (!ok) throw new Error(`Clear failed: ${stderr}`);
    let parsed;
    try { parsed = JSON.parse(stdout.trim()); }
    catch (e) { throw new Error(`Bad clear JSON: ${e.message}`); }
    return Number(parsed?.deleted_chunks) || 0;
  });
});

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

// Kill the lens sidecar on quit so it doesn't leak + hold qdrant's POSIX
// flock into the next launch. LensManager._tryReapChild + the orphan
// reaper in killOrphanLensProcesses would recover from a leak, but
// closing cleanly saves the next-launch user a 500ms settle pause.
app.on('will-quit', async (event) => {
  if (!lensManager) return;
  event.preventDefault();
  try { await lensManager.stop(); } catch {}
  app.exit(0);
});
