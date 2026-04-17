// electron/main.js — Electron main process entry point.
//
// Responsibilities:
//   1. Create the BrowserWindow + load the existing HTML frontend.
//   2. Wire the context-isolated preload bridge so renderer → Node calls route
//      through ipcMain.handle (window.api.invoke('get_setup_status', args)).
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

import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SetupManager } from './setup.js';
import { detectGpu, detectAll } from './gpu.js';
import {
  LensManager, reapOrphanLensProcesses, runLensCommand, runLensCommandStreaming,
  lensHttpGet, lensHttpDelete, percentEncodePath,
} from './lens-manager.js';
import { apiKeyPath } from './paths.js';

// electron-updater is CommonJS-only (electron/electron-userland#10219).
// createRequire is the standard interop from ESM → CJS.
const require = createRequire(import.meta.url);
const { autoUpdater } = require('electron-updater');
// We drive download + install ourselves from the renderer's two-step UI
// (check → confirm → install), so auto-download + auto-install are off.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

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

  // Expected origin for this window. Anything trying to navigate away from
  // it gets blocked by the will-navigate handler below — an unguarded
  // location.href would otherwise take the main window to an attacker
  // origin, which then inherits our preload bridge + every IPC handler.
  const expectedOriginPrefix = isDev
    ? 'http://localhost:8000/'
    : `file://${path.join(projectRoot, 'index.html')}`;

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
  // browser instead of spawning extra Electron windows. URL scheme is
  // validated — shell.openExternal will happily launch file:// or
  // javascript:// or custom handlers, so any renderer XSS would otherwise
  // pivot to local code execution.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });

  // Navigation lock: block attempts to replace the renderer origin.
  // Internal anchors (target=_self) and the initial load are both allowed;
  // only cross-origin navigations are denied + handed to the OS browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(expectedOriginPrefix)) return;
    event.preventDefault();
    openExternalSafe(url);
  });

  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
}

/// Scheme-validated wrapper around shell.openExternal. Rejects
/// file:, javascript:, vbscript:, data:, and any custom-protocol URL —
/// only http(s) and mailto round-trip to the OS.
function openExternalSafe(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return; }
  const allowed = new Set(['http:', 'https:', 'mailto:']);
  if (!allowed.has(parsed.protocol)) {
    console.warn(`[main] openExternal blocked for scheme: ${parsed.protocol}`);
    return;
  }
  shell.openExternal(parsed.toString()).catch((e) => {
    console.warn('[main] shell.openExternal failed:', e?.message || e);
  });
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
  // Coerce filters into the exact shape Electron expects. A renderer sending
  // filter.name = 1 or extensions = "zip" (string not string[]) would
  // otherwise crash dialog internals in the main process.
  const rawFilters = Array.isArray(options.filters) ? options.filters : [];
  const filters = rawFilters
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({
      name: String(f.name || 'Files'),
      extensions: (Array.isArray(f.extensions) ? f.extensions : [])
        .filter((x) => typeof x === 'string')
        .map((x) => String(x).replace(/^\./, '')),
    }));
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
  const rawPaths = args?.req?.paths || [];
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    throw new Error('No paths provided');
  }
  // Validate every path up front. Turns silent fall-through (e.g. lens
  // receiving a relative or non-existent path and walking CWD) into a
  // clear, actionable error before we spawn any subprocess. realpath
  // resolves symlinks — a user dragging `evil.zip → /etc/shadow` would
  // otherwise let lens try to ingest the target without the user
  // noticing.
  const paths = [];
  for (const raw of rawPaths) {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(`Invalid path (empty or non-string): ${JSON.stringify(raw)}`);
    }
    let resolved;
    try { resolved = await fs.realpath(path.resolve(raw)); }
    catch { throw new Error(`Path does not exist: ${raw}`); }
    paths.push(resolved);
  }
  console.log('[kb] ingest_documents paths:', paths);
  // Reset at the start so a previous run's tail state doesn't leak.
  // total spans the WHOLE batch, not just the current path's `lens ingest`
  // invocation — otherwise dropping 5 files reports "1 of 1" five times
  // in a row because each CLI call is one file.
  ingestProgress = {
    current: 0, total: paths.length, source: '', chunks_so_far: 0, started_at_ms: Date.now(),
  };
  let filesDone = 0;

  try {
    return await withLensPaused(async () => {
      const total = { files_seen: 0, chunks_indexed: 0, skipped: [] };
      for (const p of paths) {
        let finalLine = null;
        // Per-path offset so inner events map to batch-wide totals.
        // For a single-file path the CLI reports (index=1, total=1), which
        // we rewrite to (filesDone + 1) of (paths.length). If the user
        // dropped a directory the inner total may be > 1, and we bump the
        // outer total to include those extras.
        let innerTotalSeen = 1;
        await runLensCommandStreaming(['ingest', '--json', p], (line) => {
          let parsed;
          try { parsed = JSON.parse(line); } catch { return; }
          const event = parsed?.event;
          if (event === 'start') {
            innerTotalSeen = Number(parsed.total) || 1;
            // Outer total was seeded to paths.length (1 per entry). Each
            // start event tells us the real inner count — subtract the
            // 1 we preallocated and add the real figure.
            if (ingestProgress && innerTotalSeen > 1) {
              ingestProgress.total += (innerTotalSeen - 1);
            }
          } else if (event === 'file') {
            if (ingestProgress) {
              const innerIdx = Number(parsed.index) || 1;
              ingestProgress.current = filesDone + innerIdx;
              ingestProgress.source = String(parsed.source || '');
              const added = Number(parsed.chunks) || 0;
              ingestProgress.chunks_so_far += added;
            }
          } else {
            // No event tag → the final result line from lens ingest.
            finalLine = line;
          }
        }).catch((e) => { throw new Error(`Ingest of ${p} failed: ${e.message}`); });
        // Advance the baseline by however many files this invocation
        // actually contained (1 for single files, N for directories).
        filesDone += innerTotalSeen;

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

// ── IPC: auto-updater ──────────────────────────────────────────────
//
// Backed by electron-updater + the GitHub publish config in package.json's
// `build` block. Two-step flow: renderer calls check_for_update first, and
// only downloads + installs when the user confirms the banner.

/// Flatten electron-updater's releaseNotes into a single string. Windows
/// returns an array of { version, note } when `releaseNotes: 'all'` is
/// set; every other platform returns a plain string.
function extractReleaseNotes(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map((r) => r?.note || r).join('\n\n');
  return String(raw);
}

// Cached version of the last successful check. Reused by install_update
// so we don't have to re-hit the GitHub feed between "user clicked the
// banner" and "start downloading" — a transient 503 there would otherwise
// throw "no update available" right after we offered one.
let lastUpdateCheck = null;

ipcMain.handle('check_for_update', async () => {
  const currentVersion = app.getVersion();
  const empty = {
    available: false,
    current_version: currentVersion,
    new_version: null,
    notes: null,
    date: null,
  };
  // Dev mode: electron-updater refuses to talk to GitHub without the app
  // being properly packaged (no latest.yml next to the binary). Return the
  // "no update available" shape so the renderer's silent-check doesn't
  // spam the console.
  if (!app.isPackaged) return empty;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) { lastUpdateCheck = null; return empty; }
    const info = result.updateInfo;
    // Nothing to offer if the feed's latest version == what we're on.
    if (info.version === currentVersion) { lastUpdateCheck = null; return empty; }
    lastUpdateCheck = info;
    return {
      available: true,
      current_version: currentVersion,
      new_version: info.version,
      notes: extractReleaseNotes(info.releaseNotes),
      date: info.releaseDate || null,
    };
  } catch (e) {
    throw new Error(`Update check failed: ${e.message || e}`);
  }
});

ipcMain.handle('install_update', async () => {
  if (!app.isPackaged) throw new Error('Auto-update is unavailable in dev mode');
  // Require a prior successful check_for_update. downloadUpdate without
  // a cached updateInfo in electron-updater's internals is undefined
  // behavior; the renderer's banner UI always runs check first, so a
  // missing cache here means the user clicked install on a stale banner.
  if (!lastUpdateCheck) {
    throw new Error('No update available. Re-check and try again.');
  }
  await autoUpdater.downloadUpdate();
  // quitAndInstall restarts the app with the new version. Doesn't
  // resolve — the event loop tears down first.
  autoUpdater.quitAndInstall();
});

// ── App lifecycle ──────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Inject CSP headers on every response. Packaged builds load index.html
  // over file:// where same-origin is permissive and there is no server to
  // set CSP at the transport layer, so we do it here.
  //
  // 'unsafe-inline' + 'unsafe-eval' in script-src: the app uses inline
  // onclick="..." handlers pervasively (knowledge-base.js, lens.js,
  // settings.js, etc.) and transformers.js internally uses eval() for
  // dynamic kernel compilation. Stripping either breaks every button in
  // the app. 'unsafe-inline' weakens CSP against XSS but the preload
  // bridge's channel allowlist + will-navigate lock + openExternal
  // scheme guard are the real defensive layers here.
  // connect-src covers AI provider APIs, sync relay, local lens server,
  // and https: for CDN model downloads (first-run transformers.js
  // fetches the model from Hugging Face).
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self';"
          // cdn.jsdelivr.net allowed for the browser-local lens path —
          // @huggingface/transformers loads from there (bare module
          // specifiers in the npm bundle; jsdelivr auto-rewrites them).
          // Bundler work to vendor the resolved ESM is tracked as phase
          // 2c and would let us drop this allowance.
          + " script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net;"
          + " style-src 'self' 'unsafe-inline';"
          + " img-src 'self' data: blob: https:;"
          + " font-src 'self' data:;"
          + " connect-src 'self' https: wss: http://localhost:8322 http://127.0.0.1:8322;"
          + " media-src 'self' blob:;"
          + " worker-src 'self' blob:;"
          + " frame-ancestors 'none';"
          + " object-src 'none';",
        ],
      },
    });
  });

  // Hide the default native menu bar (File / Edit / View / Window / Help).
  // The app has its own header-based navigation, and the native menu's
  // system chrome doesn't match the dark theme on Linux / Windows. macOS
  // keeps a minimal app menu because that platform requires one for
  // quit / about / etc.
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  } else {
    // Trimmed macOS menu — just the system-required entries and Edit
    // (so Cmd+C/V/Z work). Everything else comes from the web UI.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]));
  }

  // Reap orphan lens processes BEFORE any IPC handler wires up. An abrupt
  // app quit (SIGKILL, crash, battery cutoff) leaves the spawned lens
  // server reparented to PID 1, still holding port 8322 + qdrant's POSIX
  // flock. The LensManager.start() path already reaps, but that only runs
  // when the renderer calls start_lens — if the renderer hits /health
  // first via the indicator's auto-check, it sees "Failed to fetch"
  // against the dead orphan, and no reap ever happens. Launching a reap
  // pass up front breaks that deadlock.
  //
  // 2s timeout so a hung /proc read on a slow disk can't block window
  // creation indefinitely.
  try {
    const killed = await Promise.race([
      reapOrphanLensProcesses(),
      new Promise((resolve) => setTimeout(() => resolve(0), 2000)),
    ]);
    if (killed > 0) console.log(`[main] Reaped ${killed} orphan lens process(es) at launch`);
  } catch (e) {
    console.warn('[main] Launch-time orphan reap failed:', e?.message || e);
  }

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
//
// 2s hard ceiling on stop() — a stuck lens child must not hang app quit.
// On the next launch the orphan reaper catches whatever is left alive.
let quitInProgress = false;
app.on('will-quit', (event) => {
  if (!lensManager || quitInProgress) return;
  quitInProgress = true;
  event.preventDefault();
  Promise.race([
    lensManager.stop().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]).finally(() => { app.exit(0); });
});
