// knowledge-base.js — Local Knowledge Base UI for the desktop app.
// Browser builds: all functions early-return; entire UI section is hidden.
//
// User-facing flow:
//   1. Settings → AI → Local Knowledge Base
//   2. If setup not done: see brief explainer + "Set up engine" button
//   3. After setup: drag/drop docs OR click to add via OS file picker
//   4. Indexed docs listed with delete buttons
//   5. "Auto-configure Custom Knowledge Source" button wires the local lens
//      into the existing Custom Knowledge Source settings in one click

import { showNotification } from './utils.js';

// ─── Desktop detection ───────────────────────────────────────────
// `window.api` is exposed by electron/preload.cjs when running in the
// Electron desktop shell. In the plain-browser PWA build it's undefined
// and every function here early-returns so the whole section is hidden.
function isDesktop() {
  return !!(window.api && window.api.isDesktop);
}

async function invoke(cmd, args = {}) {
  if (!isDesktop()) return null;
  return window.api.invoke(cmd, args);
}

export function isKnowledgeBaseAvailable() {
  return isDesktop();
}

// ─── State ───────────────────────────────────────────────────────
let _state = {
  setupComplete: false,
  setupRunning: false,
  setupPhase: null,    // SetupPhase from Tauri (object with phase tag)
  setupGpu: null,
  stats: { total_chunks: 0, documents: [] },
  ingesting: false,
  loading: false,
  docFilter: '',                 // search box text — case-insensitive substring
  docSort: 'name-asc',            // 'name-asc' | 'name-desc' | 'chunks-desc' | 'chunks-asc'
  docListThreshold: 8,            // hide search/sort UI below this many docs
  lastSkipped: [],                // filenames skipped in the most recent ingest (unsupported / empty)
  bannerFetchStarted: false,      // guard so renderKbDashboardBanner only kicks off one fetch
};
let _setupPollTimer = null;

// Ordered list of phases so the setup UI can render "Step N of 5". Kept in
// the same order as SetupPhase progression in src-tauri/src/setup.rs.
const SETUP_PHASE_ORDER = [
  'detecting_gpu',
  'downloading_python',
  'installing_lens',
  'downloading_onnx_runtime',
  'downloading_model',
];

// ─── HTML escape ─────────────────────────────────────────────────
function _esc(s) {
  if (s === null || s === undefined) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

// ─── Data fetching ───────────────────────────────────────────────
async function fetchSetupStatus() {
  try {
    const status = await invoke('get_setup_status');
    return status;
  } catch (e) {
    console.warn('[KB] setup status failed:', e);
    return null;
  }
}

async function fetchStats() {
  try {
    return await invoke('get_knowledge_stats');
  } catch (e) {
    console.warn('[KB] stats failed:', e);
    return { total_chunks: 0, documents: [] };
  }
}

// ─── Setup integration (start setup + poll progress within KB section) ──
export async function startKbSetup() {
  if (!isDesktop()) return;
  _state.setupRunning = true;
  _renderSection();

  // Start polling BEFORE firing run_setup. run_setup is a long-running async
  // command (downloads + pip install take ~2 min); if we awaited it the JS
  // would block for that entire window and the poll timer would never tick,
  // so the UI would freeze at "Starting…" and jump straight to the done
  // state. Instead, start the poll loop first, then fire run_setup as a
  // background Promise. SetupManager records phase transitions via the
  // Mutex inside the Rust struct, and our poll reads them out every second.
  if (_setupPollTimer) clearInterval(_setupPollTimer);
  _setupPollTimer = setInterval(_pollSetupProgress, 1000);
  _pollSetupProgress();

  invoke('run_setup').catch((e) => {
    // SetupManager.run_setup already records SetupPhase::Failed on error
    // before returning Err, so the poll will surface the failure and
    // update the UI. This handler just keeps the unhandled-rejection
    // warning quiet and leaves a breadcrumb in the console.
    console.warn('[KB] run_setup rejected:', e);
  });
}

async function _pollSetupProgress() {
  try {
    const status = await fetchSetupStatus();
    if (!status) return;
    _state.setupPhase = status.phase;
    _state.setupGpu = status.gpu;
    const phaseTag = (status.phase && status.phase.phase) || status.phase;
    if (phaseTag === 'completed') {
      _state.setupRunning = false;
      _state.setupComplete = true;
      clearInterval(_setupPollTimer);
      _setupPollTimer = null;
      _state.stats = await fetchStats();
      showNotification('Local knowledge engine ready', 'success');
    } else if (phaseTag === 'failed') {
      _state.setupRunning = false;
      clearInterval(_setupPollTimer);
      _setupPollTimer = null;
      const err = (status.phase && status.phase.error) || 'unknown';
      showNotification(`Setup failed: ${err}`, 'error');
    }
    _renderSection();
  } catch (e) {
    console.warn('[KB] poll failed:', e);
  }
}

/**
 * Render the indexed-documents list with optional search + sort UI.
 * For small libraries (< _state.docListThreshold) just renders the raw list —
 * search/sort is overhead until you have enough docs to scroll. Above the
 * threshold, surfaces a search box (case-insensitive substring) and a sort
 * dropdown so a 473-doc list becomes navigable.
 */
function _renderDocList(allDocs) {
  const filter = (_state.docFilter || '').trim().toLowerCase();
  const filtered = filter
    ? allDocs.filter(d => (d.source || '').toLowerCase().includes(filter))
    : allDocs.slice();
  const sorted = filtered.sort((a, b) => {
    switch (_state.docSort) {
      case 'name-desc':   return (b.source || '').localeCompare(a.source || '');
      case 'chunks-desc': return (b.chunks || 0) - (a.chunks || 0);
      case 'chunks-asc':  return (a.chunks || 0) - (b.chunks || 0);
      case 'name-asc':
      default:            return (a.source || '').localeCompare(b.source || '');
    }
  });
  const showControls = allDocs.length >= _state.docListThreshold;
  const controls = !showControls ? '' : `
    <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">
      <input type="search" id="kb-doc-search" placeholder="Search ${allDocs.length} document${allDocs.length !== 1 ? 's' : ''}…"
        value="${_esc(_state.docFilter || '')}"
        oninput="handleDocSearchInput(this.value)"
        style="flex:1;min-width:160px;padding:6px 10px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);border-radius:4px;font-size:12px">
      <select id="kb-doc-sort" onchange="handleDocSortChange(this.value)"
        style="padding:6px 10px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);border-radius:4px;font-size:12px">
        <option value="name-asc"${_state.docSort === 'name-asc' ? ' selected' : ''}>Name A-Z</option>
        <option value="name-desc"${_state.docSort === 'name-desc' ? ' selected' : ''}>Name Z-A</option>
        <option value="chunks-desc"${_state.docSort === 'chunks-desc' ? ' selected' : ''}>Most excerpts first</option>
        <option value="chunks-asc"${_state.docSort === 'chunks-asc' ? ' selected' : ''}>Fewest excerpts first</option>
      </select>
    </div>
  `;
  const matchInfo = filter && sorted.length !== allDocs.length
    ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Showing ${sorted.length} of ${allDocs.length}</div>`
    : '';
  const emptyHint = filter && sorted.length === 0
    ? `<div style="padding:12px;font-size:12px;color:var(--text-muted);text-align:center">No documents match "${_esc(filter)}"</div>`
    : '';
  return `<div style="margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px">Indexed documents</div>
        <button class="kb-clear-all" onclick="handleClearAllDocuments()" title="Remove every document from this knowledge base" ${_state.ingesting ? 'disabled' : ''}>Remove all</button>
      </div>
      ${controls}
      ${matchInfo}
      <div class="kb-doc-list">
        ${sorted.map(d => `
          <div class="kb-doc-row">
            <span class="kb-doc-icon">📄</span>
            <span class="kb-doc-name">${_esc(d.source)}</span>
            <span class="kb-doc-chunks">${d.chunks} excerpt${d.chunks !== 1 ? 's' : ''}</span>
            <button class="kb-doc-delete" onclick="handleDeleteDocument('${_esc(d.source).replace(/'/g, "\\'")}')" aria-label="Remove ${_esc(d.source)}" title="Remove">×</button>
          </div>
        `).join('')}
        ${emptyHint}
      </div>
    </div>`;
}

// Surgical input handler — re-render only the doc list, not the whole panel.
// Re-rendering the entire section blows away the input's focus and selection,
// which is unusable for a search box. We rebuild the doc list only and rely
// on the controls reading their value from _state on next render.
export function handleDocSearchInput(value) {
  _state.docFilter = value;
  _refreshDocListInPlace();
}

export function handleDocSortChange(value) {
  _state.docSort = value;
  _refreshDocListInPlace();
}

function _refreshDocListInPlace() {
  // Find the doc list container and replace just its inner doc rows + match
  // info. The controls themselves are not re-rendered so the search input
  // keeps focus while the user types.
  const container = document.querySelector('#knowledge-base-section .kb-doc-list');
  if (!container) return;
  const allDocs = _state.stats?.documents || [];
  const filter = (_state.docFilter || '').trim().toLowerCase();
  const filtered = filter
    ? allDocs.filter(d => (d.source || '').toLowerCase().includes(filter))
    : allDocs.slice();
  const sorted = filtered.sort((a, b) => {
    switch (_state.docSort) {
      case 'name-desc':   return (b.source || '').localeCompare(a.source || '');
      case 'chunks-desc': return (b.chunks || 0) - (a.chunks || 0);
      case 'chunks-asc':  return (a.chunks || 0) - (b.chunks || 0);
      default:            return (a.source || '').localeCompare(b.source || '');
    }
  });
  container.innerHTML = sorted.map(d => `
    <div class="kb-doc-row">
      <span class="kb-doc-icon">📄</span>
      <span class="kb-doc-name">${_esc(d.source)}</span>
      <span class="kb-doc-chunks">${d.chunks} excerpt${d.chunks !== 1 ? 's' : ''}</span>
      <button class="kb-doc-delete" onclick="handleDeleteDocument('${_esc(d.source).replace(/'/g, "\\'")}')" aria-label="Remove ${_esc(d.source)}" title="Remove">×</button>
    </div>
  `).join('') + (filter && sorted.length === 0
    ? `<div style="padding:12px;font-size:12px;color:var(--text-muted);text-align:center">No documents match "${_esc(filter)}"</div>`
    : '');
}

/**
 * Render the live ingest progress block — counter + filename + progress bar
 * + ETA. Falls back to a generic spinner before the first progress event
 * arrives (typically the first 1-3 seconds while the lens process boots and
 * the embedder loads). Driven by _state.ingestProgress, which the run loop
 * polls from Rust's IngestState every 500ms.
 */
function _renderIngestProgress() {
  const p = _state.ingestProgress;
  if (!p || !p.total) {
    return `<span class="kb-spinner" aria-hidden="true"></span> <span role="status" aria-live="polite">Starting indexer…</span>`;
  }
  const pct = Math.min(100, Math.round((p.current / p.total) * 100));
  const elapsed = p.started_at_ms ? (Date.now() - p.started_at_ms) / 1000 : 0;
  let eta = '';
  if (elapsed > 5 && p.current > 0 && p.current < p.total) {
    const perFile = elapsed / p.current;
    const remainSec = Math.round(perFile * (p.total - p.current));
    const m = Math.floor(remainSec / 60);
    const s = remainSec % 60;
    eta = m > 0 ? ` · ~${m}m ${s}s remaining` : ` · ~${s}s remaining`;
  }
  // Truncate long source paths from the front so users see the filename
  // (most informative part) rather than the directory prefix.
  const fname = p.source ? p.source.split('/').slice(-2).join('/') : '';
  return `
    <div role="status" aria-live="polite" style="display:flex;align-items:center;gap:8px;font-weight:500">
      <span class="kb-spinner" aria-hidden="true"></span>
      <span>Indexing ${p.current} of ${p.total}${eta}</span>
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:4px;font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%">${_esc(fname)}</div>
    <div role="progressbar"
         aria-label="Ingest progress"
         aria-valuenow="${pct}"
         aria-valuemin="0"
         aria-valuemax="100"
         style="margin-top:8px;background:var(--bg-secondary);border-radius:4px;overflow:hidden;height:6px;width:100%">
      <div style="height:100%;width:${pct}%;background:var(--accent);transition:width 0.4s ease"></div>
    </div>
  `;
}

function _phaseLabel(phase) {
  if (!phase) return 'Starting…';
  const tag = phase.phase || phase;
  const pct = phase.progress != null ? ` (${Math.round(phase.progress * 100)}%)` : '';
  switch (tag) {
    case 'not_started': return 'Starting…';
    case 'detecting_gpu': return '🖥️ Detecting GPU…';
    case 'downloading_python': return `📥 Downloading Python${pct}`;
    case 'installing_lens': return `📦 Installing engine${pct}`;
    case 'downloading_onnx_runtime': return `⚡ Downloading ${phase.provider || 'ONNX'} runtime${pct}`;
    case 'downloading_model': return `🧠 Downloading ${phase.name || 'model'}${pct}`;
    case 'completed': return '✅ Setup complete';
    case 'failed': return `❌ Failed: ${phase.error || 'unknown'}`;
    default: return String(tag);
  }
}

function _phaseProgress(phase) {
  if (!phase || typeof phase === 'string') return 0;
  return phase.progress || 0;
}

// ─── Auto-configure Custom Knowledge Source ──────────────────────
export async function autoConfigureCustomLens() {
  if (!isDesktop()) return;
  // Don't wire up an empty corpus — the chat AI would silently return zero
  // excerpts forever and the user would think the feature is broken. Force
  // the user to ingest at least one document first.
  const chunkCount = _state.stats?.total_chunks || 0;
  if (chunkCount === 0) {
    showNotification('Add at least one document to your knowledge base before connecting it to chat', 'error');
    return;
  }
  try {
    const cfg = await invoke('get_lens_config');
    if (!cfg || !cfg.url || !cfg.api_key) {
      showNotification('Failed to get lens config — is setup complete?', 'error');
      return;
    }
    // Fill in the Custom Knowledge Source fields and save
    if (window.saveLensConfig && window.saveLensKey) {
      window.saveLensConfig({
        name: 'Local Knowledge Base',
        url: cfg.url,
        topK: cfg.top_k || 5,
        enabled: true,
      });
      await window.saveLensKey(cfg.api_key);
      // Re-render the lens settings section to reflect new config
      const section = document.getElementById('custom-lens-section');
      if (section && window.renderCustomLensSection) {
        section.innerHTML = window.renderCustomLensSection();
      }
      // Update chat header indicator
      if (window.updateLensIndicator) window.updateLensIndicator();
      showNotification('Custom Knowledge Source connected to local engine', 'success');
    } else {
      showNotification('Lens module not available — try refreshing', 'error');
    }
  } catch (e) {
    showNotification(`Auto-configure failed: ${e}`, 'error');
  }
}

// ─── File ingest (drag & drop + click) ───────────────────────────
// Uses the legacy Tauri-style IPC command name for the dialog — Electron
// main wraps `dialog.showOpenDialog` under the same channel so the call
// site stays identical across the port. `invoke('plugin:dialog|open',
// { options })` returns a string | string[] | null matching what Tauri's
// plugin-dialog returned.
async function pickFiles() {
  if (!isDesktop()) return [];
  try {
    const selected = await invoke('plugin:dialog|open', {
      options: {
        multiple: true,
        directory: false,
        // Separate filter groups so the native OS dialog's "file type"
        // dropdown lets users switch between document and archive views.
        // Linux GTK pickers in particular tend to hide archives when the
        // active filter is purely "documents", so users couldn't select
        // a .zip without knowing to switch filters.
        filters: [
          { name: 'Documents', extensions: ['txt', 'md', 'markdown', 'rst', 'json', 'pdf', 'docx'] },
          { name: 'Archives', extensions: ['zip'] },
          { name: 'All supported', extensions: ['txt', 'md', 'markdown', 'rst', 'json', 'pdf', 'docx', 'zip'] },
        ],
      },
    });
    if (!selected) return [];
    return Array.isArray(selected) ? selected : [selected];
  } catch (e) {
    console.warn('[KB] file picker failed:', e);
    return [];
  }
}

async function pickFolder() {
  if (!isDesktop()) return null;
  try {
    const selected = await invoke('plugin:dialog|open', {
      options: { directory: true, multiple: false },
    });
    return selected || null;
  } catch (e) {
    console.warn('[KB] folder picker failed:', e);
    return null;
  }
}

export async function handleAddFiles() {
  if (!isDesktop() || _state.ingesting) return;
  const paths = await pickFiles();
  if (!paths || paths.length === 0) return;
  await runIngest(paths);
}

export async function handleAddFolder() {
  if (!isDesktop() || _state.ingesting) return;
  const folder = await pickFolder();
  if (!folder) return;
  await runIngest([folder]);
}

async function runIngest(paths) {
  _state.ingesting = true;
  _state.ingestProgress = null;
  _renderSection();

  // Poll the Rust IngestState every 500ms so the UI shows N/M and the
  // current filename instead of a static "Indexing…" spinner. Rust
  // updates the state from the lens CLI's JSONL stream as each file
  // completes. Cleared on completion in the finally block.
  const progressTimer = setInterval(async () => {
    try {
      const p = await invoke('get_ingest_progress');
      if (p && _state.ingesting) {
        _state.ingestProgress = p;
        _renderSection();
      }
    } catch { /* polling is best-effort */ }
  }, 500);

  try {
    const result = await invoke('ingest_documents', { req: { paths } });
    if (!result) return;
    const skippedList = Array.isArray(result.skipped) ? result.skipped : [];
    _state.lastSkipped = skippedList;
    const skipped = skippedList.length;
    if (result.chunks_indexed === 0) {
      showNotification(
        skipped > 0
          ? `Indexed 0 excerpts from ${result.files_seen} files (${skipped} skipped — unsupported or too short). See list below.`
          : 'No content found in selected files (try larger documents)',
        'info'
      );
    } else {
      showNotification(
        skipped > 0
          ? `Indexed ${result.chunks_indexed} excerpts from ${result.files_seen} file${result.files_seen !== 1 ? 's' : ''} (${skipped} skipped — see list below)`
          : `Indexed ${result.chunks_indexed} excerpts from ${result.files_seen} file${result.files_seen !== 1 ? 's' : ''}`,
        'success'
      );
    }
    // Refresh stats
    _state.stats = await fetchStats();
  } catch (e) {
    showNotification(`Ingest failed: ${e}`, 'error');
  } finally {
    clearInterval(progressTimer);
    _state.ingesting = false;
    _state.ingestProgress = null;
    _renderSection();
  }
}

export async function handleDeleteDocument(source) {
  if (!isDesktop()) return;
  if (!confirm(`Delete "${source}" from your knowledge base? This removes all excerpts indexed from it.`)) {
    return;
  }
  try {
    const deleted = await invoke('delete_document', { source });
    showNotification(`Removed ${deleted} excerpts for ${source}`, 'success');
    _state.stats = await fetchStats();
    _renderSection();
  } catch (e) {
    showNotification(`Delete failed: ${e}`, 'error');
  }
}

export async function handleClearAllDocuments() {
  if (!isDesktop() || _state.ingesting) return;
  const docCount = (_state.stats?.documents || []).length;
  const chunkCount = _state.stats?.total_chunks || 0;
  if (docCount === 0) return;
  const confirmed = window.confirm(
    `Remove all ${docCount} document${docCount !== 1 ? 's' : ''} (${chunkCount} excerpt${chunkCount !== 1 ? 's' : ''}) from your knowledge base? This cannot be undone.`
  );
  if (!confirmed) return;
  try {
    const deleted = await invoke('clear_knowledge');
    showNotification(`Removed ${deleted} excerpts (all documents)`, 'success');
    _state.lastSkipped = [];
    _state.stats = await fetchStats();
    _renderSection();
  } catch (e) {
    showNotification(`Clear failed: ${e}`, 'error');
  }
}

/// User hit "Cancel" during the initial setup download. Main side flips a
/// flag + kills the currently running subprocess; the poll loop observes
/// the resulting Failed phase and updates the UI accordingly.
export async function handleCancelSetup() {
  if (!isDesktop() || !_state.setupRunning) return;
  try {
    await invoke('cancel_setup');
  } catch (e) {
    console.warn('[KB] cancel_setup failed:', e);
  }
}

export function handleDismissSkipped() {
  _state.lastSkipped = [];
  _renderSection();
}

// ─── Drag & drop wiring ──────────────────────────────────────────
function _attachDropHandlers() {
  const zone = document.getElementById('kb-drop-zone');
  if (!zone || zone.dataset.dropAttached) return;
  zone.dataset.dropAttached = '1';

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('kb-drop-zone-active');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('kb-drop-zone-active'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('kb-drop-zone-active');
    if (!isDesktop()) return;
    // Electron 32 deprecated File.path — on sandboxed renderers it returns
    // empty or just the filename, which makes lens silently walk CWD when
    // it fails to resolve the relative path. webUtils.getPathForFile(file)
    // is the supported replacement; the preload bridge exposes it as
    // window.api.getPathForFile.
    const files = Array.from(e.dataTransfer?.files || []);
    const getPath = window.api?.getPathForFile;
    const paths = files
      .map((f) => (getPath ? getPath(f) : f.path))
      .filter(Boolean);
    if (paths.length > 0) {
      await runIngest(paths);
    }
  });
  // Keyboard activation — the drop zone is a <div> so it doesn't fire click
  // on Enter/Space by default. Without this, screen-reader and keyboard-only
  // users have no way to open the file picker.
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (window.handleAddFiles) window.handleAddFiles();
    }
  });
}

// ─── UI rendering ────────────────────────────────────────────────
export function renderKnowledgeBaseSection() {
  if (!isDesktop()) return '';

  // Trigger async data load + re-render once data lands
  if (!_state.loading && !_state.ingesting) {
    _state.loading = true;
    Promise.all([fetchSetupStatus(), fetchStats()]).then(([status, stats]) => {
      _state.setupComplete = !!status && !status.is_first_run;
      _state.stats = stats;
      _state.loading = false;
      _renderSection();
      requestAnimationFrame(_attachDropHandlers);
    });
  }

  return _innerHtml();
}

function _renderSection() {
  const section = document.getElementById('knowledge-base-section');
  if (section) {
    section.innerHTML = _innerHtml();
    requestAnimationFrame(_attachDropHandlers);
  }
}

function _phaseStepIndex(phase) {
  if (!phase) return -1;
  const tag = phase.phase || phase;
  return SETUP_PHASE_ORDER.indexOf(tag);
}

function _renderSkippedBlock() {
  const skipped = _state.lastSkipped || [];
  if (skipped.length === 0) return '';
  const items = skipped
    .slice(0, 200)
    .map((s) => `<li style="padding:2px 0;font-family:ui-monospace,monospace;font-size:11px;color:var(--text-muted);word-break:break-all">${_esc(s)}</li>`)
    .join('');
  const overflow = skipped.length > 200
    ? `<li style="padding:2px 0;font-size:11px;color:var(--text-muted)">…and ${skipped.length - 200} more</li>`
    : '';
  return `<details style="margin-top:14px;padding:10px 12px;border:1px solid var(--border);background:var(--bg-secondary);border-radius:6px">
    <summary style="cursor:pointer;font-size:12px;color:var(--text-primary);user-select:none">
      ${skipped.length} file${skipped.length !== 1 ? 's' : ''} skipped in last ingest
      <button class="kb-doc-delete" onclick="event.preventDefault();handleDismissSkipped()" aria-label="Dismiss skipped list" title="Dismiss" style="float:right;margin-top:-2px">×</button>
    </summary>
    <div style="font-size:11px;color:var(--text-muted);margin:8px 0 6px;line-height:1.4">Usually means the file was empty, an unsupported extension, or failed to parse. Rename or convert the files and try again.</div>
    <ul style="list-style:none;padding:0;margin:0">${items}${overflow}</ul>
  </details>`;
}

function _innerHtml() {
  if (_state.loading) {
    return `<div class="ai-provider-panel"><div class="ai-provider-desc">Loading knowledge base…</div></div>`;
  }

  // Setup currently running — show progress
  if (_state.setupRunning) {
    const pct = _phaseProgress(_state.setupPhase);
    const pctInt = Math.round(pct * 100);
    const stepIdx = _phaseStepIndex(_state.setupPhase);
    // Step indicator: "Step N of 5". Only shown once we're into a real
    // phase — detecting_gpu is step 1, downloading_model is step 5.
    const stepLine = stepIdx >= 0
      ? `<div style="margin-top:8px;font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px">Step ${stepIdx + 1} of ${SETUP_PHASE_ORDER.length}</div>`
      : '';
    const gpuLine = _state.setupGpu
      ? `<div style="font-size:12px;color:var(--text-muted);margin-top:8px">Hardware: ${_esc(_state.setupGpu.name || 'detecting…')}${_state.setupGpu.recommended_provider ? ' · ' + _esc(_state.setupGpu.recommended_provider) : ''}</div>`
      : '';
    // Live tail-line from the underlying subprocess (pip's "Downloading X" etc.)
    // — surfaced so the user can see activity during the long install phase
    // instead of a frozen 0% bar.
    const statusLine = _state.setupPhase && _state.setupPhase.status
      ? `<div role="status" aria-live="polite" style="margin-top:4px;font-size:11px;color:var(--text-muted);font-family:ui-monospace,monospace;opacity:0.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(_state.setupPhase.status)}</div>`
      : '';
    return `<div class="ai-provider-panel">
      <div class="ai-provider-desc">Setting up local knowledge engine — this is a one-time download.</div>
      ${stepLine}
      <div role="status" aria-live="polite" style="margin-top:6px;font-size:13px;color:var(--text-muted)">${_esc(_phaseLabel(_state.setupPhase))}</div>
      ${statusLine}
      <div role="progressbar"
           aria-label="Setup progress"
           aria-valuenow="${pctInt}"
           aria-valuemin="0"
           aria-valuemax="100"
           style="margin-top:8px;background:var(--bg-secondary);border-radius:6px;overflow:hidden;height:8px">
        <div style="height:100%;width:${Math.max(pct * 100, 5)}%;background:var(--accent);transition:width 0.5s ease;border-radius:6px"></div>
      </div>
      ${gpuLine}
      <div style="margin-top:12px">
        <button class="import-btn import-btn-secondary" onclick="handleCancelSetup()"
                aria-label="Cancel setup">Cancel</button>
      </div>
    </div>`;
  }

  // Setup not done — invite to start
  if (!_state.setupComplete) {
    return `<div class="ai-provider-panel">
      <div class="ai-provider-desc">
        Run an AI knowledge engine on your computer. Add your own documents
        (research papers, clinical guides, notes) and the chat AI will reference
        them when answering your health questions.
      </div>
      <div style="font-size:13px;color:var(--text-muted);margin:10px 0">
        First-time setup downloads ~3 GB (Python runtime + AI engine + embedding model).
        Takes 5–15 min. Runs fully offline after.
      </div>
      <button class="import-btn import-btn-primary" onclick="startKbSetup()">
        Set up engine
      </button>
    </div>`;
  }

  // Setup done — show stats + drop zone + doc list + auto-config
  const stats = _state.stats || { total_chunks: 0, documents: [] };
  const docCount = stats.documents.length;
  const chunkCount = stats.total_chunks;

  const statsLine = chunkCount === 0
    ? `<span style="color:var(--text-muted)">No documents indexed yet</span>`
    : `<span style="color:var(--green)">●</span> ${chunkCount} excerpt${chunkCount !== 1 ? 's' : ''} from ${docCount} document${docCount !== 1 ? 's' : ''}`;

  const dropZoneState = _state.ingesting ? 'kb-drop-zone-busy' : '';
  const dropZoneContent = _state.ingesting
    ? _renderIngestProgress()
    : `<div style="font-size:24px;line-height:1" aria-hidden="true">📁</div>
       <div style="font-weight:500;margin-top:4px">Drop documents here or click to add</div>
       <div style="font-size:11px;color:var(--text-muted);margin-top:2px">PDF · Markdown · Text · Word · JSON · ZIP</div>`;

  const docList = chunkCount === 0 ? '' : _renderDocList(stats.documents);

  return `<div class="ai-provider-panel">
    <div class="ai-provider-desc">
      Add documents to your local knowledge base. The AI references them when
      answering health questions.
    </div>
    <div style="margin-top:10px;font-size:13px">${statsLine}</div>

    <div id="kb-drop-zone" class="kb-drop-zone ${dropZoneState}"
         role="button"
         tabindex="0"
         aria-label="Add documents — drop files here or press Enter to open the file picker"
         aria-busy="${_state.ingesting ? 'true' : 'false'}"
         onclick="handleAddFiles()">
      ${dropZoneContent}
    </div>

    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
      <button class="import-btn import-btn-secondary" onclick="handleAddFiles()" ${_state.ingesting ? 'disabled' : ''}>Add files…</button>
      <button class="import-btn import-btn-secondary" onclick="handleAddFolder()" ${_state.ingesting ? 'disabled' : ''}>Add folder…</button>
    </div>

    ${_renderSkippedBlock()}
    ${docList}

    <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
      <button class="import-btn import-btn-primary" onclick="autoConfigureCustomLens()">
        ⚡ Auto-configure Custom Knowledge Source
      </button>
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px">
        Connects the chat AI to this local engine in one click. After clicking,
        the Custom Knowledge Source section below is filled in and enabled.
      </div>
    </div>
  </div>`;
}

/**
 * Dashboard discoverability banner — shown only when running in the desktop
 * shell AND the local Knowledge Base hasn't been set up yet. Browser users
 * see nothing because they can't run the local engine. Once setup completes,
 * the banner disappears forever (driven by _state.setupComplete which is
 * read from the marker file via get_setup_status).
 *
 * Returns inline HTML the dashboard appends; nothing without a desktop build
 * with no setup. Click takes the user straight to Settings → AI tab where
 * the KB section lives, with a small scroll nudge so they land on it.
 */
function _bannerInnerHtml() {
  return `<div class="kb-dashboard-banner" role="region" aria-label="Local Knowledge Base">
    <div class="kb-dashboard-banner-icon" aria-hidden="true">📚</div>
    <div class="kb-dashboard-banner-text">
      <div class="kb-dashboard-banner-title">Add a local Knowledge Base</div>
      <div class="kb-dashboard-banner-desc">Index your own documents — research papers, clinical notes, anything — and let the AI ground its answers in them. Runs fully offline on your machine.</div>
    </div>
    <button class="kb-dashboard-banner-cta" onclick="event.preventDefault(); window.openSettingsModal &amp;&amp; window.openSettingsModal('ai'); setTimeout(() =&gt; { var el = document.getElementById('knowledge-base-section'); if (el) el.scrollIntoView({behavior:'smooth', block:'center'}); }, 250);">Set up &rarr;</button>
  </div>`;
}

export function renderKbDashboardBanner() {
  if (!isDesktop()) return '';
  // First cold dashboard load: fetch setup status on demand and only render
  // the banner after we've confirmed setup isn't already done. Without this
  // the banner flashes on every cold launch (even when the user has setup
  // finished from a previous session) because _state.setupComplete defaults
  // to false until renderKnowledgeBaseSection runs.
  if (!_state.bannerFetchStarted) {
    _state.bannerFetchStarted = true;
    fetchSetupStatus().then((status) => {
      _state.setupComplete = !!status && !status.is_first_run;
      const slot = document.getElementById('kb-dashboard-banner-slot');
      if (!slot) return;
      slot.innerHTML = _state.setupComplete ? '' : _bannerInnerHtml();
    }).catch(() => {
      // Leave the slot empty on fetch failure — showing a stale CTA is worse
      // than nothing.
    });
    return `<div id="kb-dashboard-banner-slot" aria-hidden="true"></div>`;
  }
  if (_state.setupComplete) {
    return `<div id="kb-dashboard-banner-slot" aria-hidden="true"></div>`;
  }
  return `<div id="kb-dashboard-banner-slot">${_bannerInnerHtml()}</div>`;
}

// ─── Window exports ──────────────────────────────────────────────
Object.assign(window, {
  isKnowledgeBaseAvailable,
  renderKnowledgeBaseSection,
  renderKbDashboardBanner,
  handleAddFiles,
  handleAddFolder,
  handleDeleteDocument,
  handleClearAllDocuments,
  handleDocSearchInput,
  handleDocSortChange,
  handleCancelSetup,
  handleDismissSkipped,
  autoConfigureCustomLens,
  startKbSetup,
});
