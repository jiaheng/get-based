// lens.js — Custom Knowledge Source
// User-configured RAG endpoint that backs the Interpretive Lens with retrieved chunks.

import { state } from './state.js';
import { getCachedKey, updateKeyCache, encryptedSetItem } from './crypto.js';
import { hashString, showNotification, showConfirmDialog, isDebugMode, escapeHTML, escapeAttr } from './utils.js';

const CONFIG_KEY = 'labcharts-lens-config';
const SECRET_KEY = 'labcharts-lens-key';

// testProbe — per-user "canary" query used by Save & Test to verify the
// endpoint. Default is health-themed because getbased's audience typically
// indexes health research, but any user with a different domain corpus (legal
// docs, code docs, recipes…) can change it so the test result reflects their
// actual content instead of always looking like "0 passages returned".
const DEFAULT_TEST_PROBE = 'vitamin D deficiency supplementation';
// Three backends under one UI:
//   'desktop-engine' — local Python lens server at 127.0.0.1:8322 (Electron
//                      only; first-run installs Python + model). Fastest,
//                      handles large corpora. Backend for users who ran
//                      the engine setup.
//   'in-browser'     — MiniLM in a Web Worker, vectors in OPFS. Works in
//                      every browser + Electron. No install, but smaller
//                      capacity + WASM-slow inference.
//   'external-server' — user-configured URL + Bearer key. For servers the
//                       user runs themselves or someone they trust.
//
// Legacy names ('remote' → 'external-server', 'local-browser' → 'in-browser')
// are migrated on read in getLensConfig. Old Electron users whose
// auto-configure wired a localhost:8322 + bearer key get moved to
// 'desktop-engine' automatically.
const DEFAULT_CONFIG = {
  name: '',
  url: '',
  enabled: false,
  topK: 5,
  testProbe: DEFAULT_TEST_PROBE,
  backend: 'in-browser',
};
const TIMEOUT_MS = 30000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 20;
const MAX_CHUNKS = 10;
const MAX_RESPONSE_BYTES = 32 * 1024;

// ─── Config storage ───────────────────────────────────────────
export function getLensConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return migrateLensConfig({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
  } catch { return { ...DEFAULT_CONFIG }; }
}

/// Rename/rebucket legacy backend values so users who had browser-local
/// or external-URL configs from earlier v1.21.0 betas don't see their
/// lens stop working on upgrade. Heuristic: if backend=remote and url
/// points at the Python engine's default port, they were using the
/// auto-configured desktop engine — promote to the new enum value.
function migrateLensConfig(cfg) {
  if (cfg.backend === 'remote') {
    cfg.backend = isDesktopEnginePort(cfg.url) ? 'desktop-engine' : 'external-server';
  } else if (cfg.backend === 'local-browser') {
    cfg.backend = 'in-browser';
  }
  return cfg;
}

function isDesktopEnginePort(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === '8322';
  } catch { return false; }
}

export function saveLensConfig(partial) {
  const prev = getLensConfig();
  const next = { ...prev, ...partial };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
  const urlChanged = partial.url !== undefined && partial.url !== prev.url;
  const topKChanged = partial.topK !== undefined && partial.topK !== prev.topK;
  if (urlChanged || topKChanged) clearLensCache();
  // Ping listeners so the indicator re-evaluates visibility (without clobbering state)
  updateLensStatus({});
  return next;
}

export function getLensKey() { return getCachedKey(SECRET_KEY) || ''; }

export async function saveLensKey(key) {
  await encryptedSetItem(SECRET_KEY, key);
  updateKeyCache(SECRET_KEY, key);
  clearLensCache();
}

export async function removeLens() {
  localStorage.removeItem(CONFIG_KEY);
  await encryptedSetItem(SECRET_KEY, '');
  updateKeyCache(SECRET_KEY, '');
  clearLensCache();
  updateLensStatus({ state: 'idle', lastChunkCount: 0, lastError: null, sourceName: '' });
}

export function hasLens() {
  const cfg = getLensConfig();
  if (!cfg.enabled) return false;
  if (cfg.backend === 'in-browser') {
    // In-browser needs OPFS + Workers AND at least one indexed chunk.
    // Without the count check, hasLens() would be true on a fresh
    // install and every chat query would spin the worker pointlessly —
    // the UI indicator would read "active" but `injectLensChunks`
    // silently no-ops on empty results. peekLocalCorpusSize reads a
    // localStorage shadow written by lens-local.js after each state
    // change.
    if (typeof navigator === 'undefined' || !navigator.storage || typeof Worker === 'undefined') return false;
    try {
      const n = Number(localStorage.getItem('labcharts-lens-local-count')) || 0;
      return n > 0;
    } catch { return false; }
  }
  if (cfg.backend === 'desktop-engine') {
    // Desktop engine needs the Electron IPC bridge + the generated API
    // key. The URL is always 127.0.0.1:8322. We don't require a
    // pre-fetched chunk count — the Python engine responds to empty
    // queries with an empty list, which injectLensChunks no-ops on.
    return typeof window !== 'undefined'
      && !!window.api?.isDesktop
      && !!getLensKey();
  }
  // external-server: URL + bearer key
  return !!(cfg.url && getLensKey());
}

// ─── URL validation ───────────────────────────────────────────
// http:// is accepted for hosts that can't leak the Bearer token across the
// public internet: loopback, RFC1918 LAN, link-local, Tailscale CGNAT, mDNS.
// Everything else must be https://.
function _isPrivateHost(host) {
  if (!host) return false;
  if (host === 'localhost') return true;
  if (host === '::1' || host === '[::1]') return true;
  if (host.endsWith('.local') || host.endsWith('.local.')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = +m[1], b = +m[2], c = +m[3], d = +m[4];
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;
  if (a === 10) return true;                           // 10.0.0.0/8
  if (a === 127) return true;                          // loopback
  if (a === 169 && b === 254) return true;             // link-local 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;   // Tailscale CGNAT 100.64.0.0/10
  return false;
}

export function isValidLensUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return _isPrivateHost(u.hostname);
  return false;
}

// ─── LRU cache ────────────────────────────────────────────────
const _lensCache = new Map();

function cacheKey(url, topK, profileId, query) {
  return hashString(`${url}|${topK}|${profileId}|${query}`);
}

function cacheGet(key) {
  const entry = _lensCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) { _lensCache.delete(key); return null; }
  _lensCache.delete(key); _lensCache.set(key, entry);
  return entry.result;
}

function cacheSet(key, result) {
  if (_lensCache.size >= CACHE_MAX) {
    const oldest = _lensCache.keys().next().value;
    if (oldest !== undefined) _lensCache.delete(oldest);
  }
  _lensCache.set(key, { result, at: Date.now() });
}

export function clearLensCache() { _lensCache.clear(); }

// ─── Status pub/sub ───────────────────────────────────────────
let _lensStatus = { state: 'idle', lastChunkCount: 0, lastError: null, sourceName: '' };
const _statusListeners = new Set();

export function getLensStatus() { return { ..._lensStatus }; }

export function updateLensStatus(partial) {
  _lensStatus = { ..._lensStatus, ...partial };
  for (const fn of _statusListeners) { try { fn(_lensStatus); } catch {} }
}

export function subscribeLensStatus(fn) {
  _statusListeners.add(fn);
  return () => _statusListeners.delete(fn);
}

// ─── Query ────────────────────────────────────────────────────
export async function queryLens(queryHint, opts = {}) {
  if (!hasLens()) return null;
  const cfg = getLensConfig();
  const topK = typeof opts.topK === 'number' ? opts.topK : cfg.topK;
  const hint = String(queryHint || '').trim();
  if (!hint) return null;
  if (cfg.backend === 'in-browser') {
    const sourceName = cfg.name || 'Knowledge Base';
    return queryWithCache('in-browser', sourceName, hint, topK, async () => {
      const mod = await import('./lens-local.js');
      const result = await mod.queryLensLocal(hint, { topK });
      if (!result) return [];
      return result.chunks.map((c) => ({ text: c.text, source: c.source }));
    });
  }
  if (cfg.backend === 'desktop-engine') {
    const key = getLensKey();
    if (!key) return null;
    // Fixed URL: the Python lens always listens on loopback:8322. Same
    // fetch path as external-server, just hardcoded host/port so users
    // don't have to configure it.
    const url = 'http://127.0.0.1:8322/query';
    const sourceName = cfg.name || 'Desktop Knowledge Base';
    return queryWithCache('desktop-engine', sourceName, hint, topK,
      () => _fetchRemoteChunks(url, key, hint, topK, opts));
  }
  // external-server
  const url = cfg.url;
  const key = getLensKey();
  if (!url || !key) return null;
  const sourceName = cfg.name || 'Lens';
  return queryWithCache(url, sourceName, hint, topK,
    () => _fetchRemoteChunks(url, key, hint, topK, opts));
}

/// Shared cache + status envelope for every backend. `fetchFn(abortCtl)`
/// returns a Promise<chunks[]>; caller shapes its own errors via throw.
/// Keeping cache + status plumbing here means adding a third backend is
/// just a third fetchFn — no re-plumbing of observability per call.
async function queryWithCache(backendKey, sourceName, hint, topK, fetchFn) {
  const profileId = state.currentProfile || 'default';
  const ck = cacheKey(backendKey, topK, profileId, hint);
  const cached = cacheGet(ck);
  if (cached) {
    if (isDebugMode()) console.log('[Lens] cache hit', backendKey);
    updateLensStatus({ state: 'active', lastChunkCount: cached.chunks.length, lastError: null, sourceName });
    return cached;
  }
  try {
    const rawChunks = await fetchFn();
    const chunks = Array.isArray(rawChunks) ? rawChunks : [];
    const result = { chunks, sourceName };
    cacheSet(ck, result);
    updateLensStatus({ state: 'active', lastChunkCount: chunks.length, lastError: null, sourceName });
    return result;
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? 'timeout' : (e?.message) || 'unknown error';
    if (isDebugMode()) console.warn('[Lens] query failed:', backendKey, msg);
    updateLensStatus({ state: 'error', lastError: msg });
    return null;
  }
}

/// Remote-server backend — HTTP POST with bearer auth, strict transport
/// settings (no credentials, no referrer, no redirects). Returns a flat
/// array of chunks in the shared envelope shape.
async function _fetchRemoteChunks(url, key, hint, topK, opts) {
  const outerSignal = opts?.signal;
  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), TIMEOUT_MS);
  const signal = anySignal(outerSignal, timeoutCtl.signal);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({ version: 1, query: hint, top_k: topK }),
      signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const err = await res.json(); if (err && err.error) msg = String(err.error); } catch {}
      throw new Error(msg);
    }
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    const data = JSON.parse(text);
    return Array.isArray(data && data.chunks) ? data.chunks.slice(0, MAX_CHUNKS)
      .map((c) => ({ text: String(c && c.text || '').slice(0, 4000), source: c && c.source ? String(c.source).slice(0, 200) : '' }))
      .filter((c) => c.text) : [];
  } finally {
    clearTimeout(timer);
  }
}

function anySignal(...signals) {
  const ctl = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) { ctl.abort(); break; }
    s.addEventListener('abort', () => ctl.abort(), { once: true });
  }
  return ctl.signal;
}

// ─── Formatting ───────────────────────────────────────────────
export function buildLensSnippet(result) {
  if (!result || !Array.isArray(result.chunks) || !result.chunks.length) return '';
  const lines = [`### Retrieved from your knowledge source (${result.sourceName}):`];
  result.chunks.forEach((c, i) => {
    const cite = c.source ? ` — ${c.source}` : '';
    lines.push(`${i + 1}. ${c.text}${cite}`);
  });
  lines.push('When your interpretation draws on these excerpts, cite the source. When it does not, say so.');
  return lines.join('\n');
}

// ─── Test connection ──────────────────────────────────────────
// Tests the configured URL + key regardless of the enabled toggle
// (users explicitly asking to test shouldn't be blocked by the toggle state).
//
// Returns { ok, chunkCount, firstSource, error } where `ok` reflects
// CONNECTIVITY ONLY — a 200 response with valid schema counts as pass
// even if chunkCount is 0. Passage count is informational: a server that
// answers correctly but returns no chunks is "working" from a transport
// perspective; the user still needs to evaluate whether their probe is
// relevant to their corpus. This separation keeps Custom Knowledge Source
// generic across domains — users with legal / code / recipe RAGs don't see
// "connection failed" just because the default health probe doesn't match.
export async function testLensConnection() {
  const cfg = getLensConfig();
  const key = getLensKey();
  if (!cfg.url || !key) return { ok: false, error: 'URL and API key required' };
  clearLensCache();
  updateLensStatus({ state: 'idle', lastError: null });
  const probe = (cfg.testProbe && cfg.testProbe.trim()) || DEFAULT_TEST_PROBE;
  const result = await _doQuery(cfg.url, key, Math.max(cfg.topK, 3), cfg.name || 'Lens', probe, {});
  if (!result) return { ok: false, error: getLensStatus().lastError || 'unknown error' };
  return { ok: true, chunkCount: result.chunks.length, firstSource: result.chunks[0]?.source || '' };
}

// ═══════════════════════════════════════════════
// CHAT-HEADER INDICATOR
// ═══════════════════════════════════════════════
export function updateLensIndicator() {
  const btn = document.getElementById('chat-lens-indicator');
  const live = document.getElementById('chat-lens-status');
  if (!btn) return;
  btn.classList.remove('active', 'error');
  if (!hasLens()) { btn.style.display = 'none'; if (live) live.textContent = ''; return; }
  btn.style.display = '';
  const s = getLensStatus();
  if (s.state === 'active') btn.classList.add('active');
  else if (s.state === 'error') btn.classList.add('error');
  const cfg = getLensConfig();
  const tip = s.state === 'error'
    ? `Knowledge source error: ${s.lastError || 'unknown'}`
    : s.state === 'active'
      ? `Knowledge source active${cfg.name ? ': ' + cfg.name : ''} · ${s.lastChunkCount || 0} excerpts`
      : `Knowledge source ready${cfg.name ? ': ' + cfg.name : ''}`;
  btn.title = tip;
  if (live) live.textContent = tip;
}

subscribeLensStatus(updateLensIndicator);

// ═══════════════════════════════════════════════
// SETTINGS PANEL
// ═══════════════════════════════════════════════
export function renderCustomLensSection() {
  const cfg = getLensConfig();
  // Schedule the local-backend init on the next animation frame. The
  // caller (settings.js or _rerenderLensSection) sets innerHTML with the
  // string we return, so the #lens-local-stats element doesn't exist yet
  // at this point. rAF defers until after that assignment paints, at
  // which point _loadLocalLensStats can populate stats + doc list +
  // wire the drop handlers. Without this, the panel opened with
  // backend=local-browser stayed stuck on "Loading corpus stats…".
  if (cfg.backend === 'local-browser' && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      try { _loadLocalLensStats(); } catch {}
    });
  }
  const keySet = !!getLensKey();
  const canUseDesktop = typeof window !== 'undefined' && !!window.api?.isDesktop;

  // Auto-coerce backend to the right on-device flavor for this environment.
  // Desktop users shouldn't be stuck on the in-browser engine (slower, no
  // server-class retrieval); PWA users can't run the desktop engine at all.
  // Silent migration — runs once per render if the backend doesn't match.
  if (canUseDesktop && cfg.backend === 'in-browser') {
    saveLensConfig({ backend: 'desktop-engine' });
    cfg.backend = 'desktop-engine';
  } else if (!canUseDesktop && cfg.backend === 'desktop-engine') {
    saveLensConfig({ backend: 'in-browser' });
    cfg.backend = 'in-browser';
  }

  const isBrowser = cfg.backend === 'in-browser';
  const isDesktop = cfg.backend === 'desktop-engine';
  const isExternal = cfg.backend === 'external-server';
  const isOnDevice = isBrowser || isDesktop;
  // On-device engine label + description vary by environment.
  const onDeviceBackend = canUseDesktop ? 'desktop-engine' : 'in-browser';
  const onDeviceDesc = canUseDesktop
    ? 'Runs a native engine on this computer. Fastest option; handles large libraries. One-time ~3 GB setup.'
    : 'Runs entirely in this browser. No install — first use downloads a small AI model (~100 MB); after that it works offline.';

  // Connected: backend-dependent.
  //   in-browser: always "ready" (feature-detected via hasLens elsewhere).
  //   desktop-engine: needs the Python engine key. hasLens() gates on it.
  //   external-server: needs URL + key.
  const connected = isBrowser
    || (isDesktop && keySet)
    || (isExternal && cfg.url && keySet);
  const status = getLensStatus();
  const statusChip = !connected
    ? '<span style="color:var(--text-muted)">Not connected</span>'
    : status.state === 'error'
      ? `<span style="color:#fbbf24">&#9888; Error${cfg.name ? ' · ' + escapeHTML(cfg.name) : ''}</span>`
      : cfg.enabled
        ? `<span style="color:var(--green)">&#10003; Connected${cfg.name ? ' · ' + escapeHTML(cfg.name) : ''}</span>`
        : `<span style="color:var(--text-muted)">Configured (disabled)</span>`;
  const lastInfo = status.state === 'error' && status.lastError
    ? `<div style="font-size:11px;color:#fbbf24;margin-top:4px">Last error: ${escapeHTML(status.lastError)}</div>`
    : connected && status.lastChunkCount
      ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Last query: ${status.lastChunkCount} excerpt${status.lastChunkCount !== 1 ? 's' : ''}${status.sourceName ? ' from ' + escapeHTML(status.sourceName) : ''}</div>`
      : '';

  // Per-backend field visibility. The radio handler swaps display:none
  // so we don't have to re-render the whole panel on toggle — preserves
  // scroll position + focus.
  const desktopFieldsStyle = isDesktop ? '' : 'display:none';
  const browserFieldsStyle = isBrowser ? '' : 'display:none';
  const externalFieldsStyle = isExternal ? '' : 'display:none';

  return `<div class="ai-provider-panel">
    <div class="ai-provider-desc">A Knowledge Base grounds the AI's analysis in real documents you provide — research papers, clinical guides, personal notes. Add your documents below and the AI references them when answering your questions.</div>
    <div class="api-key-status" id="lens-status-chip">${statusChip}${lastInfo}</div>

    <div style="margin-top:10px">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Where to run it</div>
      <div class="ctx-btn-group" role="radiogroup" aria-label="Knowledge Base engine">
        <button type="button" class="ctx-btn-option ${isOnDevice ? 'active' : ''}" role="radio" aria-checked="${isOnDevice}" onclick="handleLensBackendChange('${onDeviceBackend}')">On this device</button>
        <button type="button" class="ctx-btn-option ${isExternal ? 'active' : ''}" role="radio" aria-checked="${isExternal}" onclick="handleLensBackendChange('external-server')">External server</button>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px">
        ${isOnDevice ? onDeviceDesc : 'Connect to a knowledge server you run (or one run by someone you trust). For remote or shared setups.'}
      </div>
    </div>

    <div style="margin-top:10px;display:flex;align-items:center;gap:10px">
      <label class="toggle-switch" for="lens-enabled-toggle">
        <input type="checkbox" id="lens-enabled-toggle" ${cfg.enabled ? 'checked' : ''} onchange="handleToggleLens(this.checked)">
        <span class="toggle-slider"></span>
      </label>
      <label for="lens-enabled-toggle" style="font-size:13px;cursor:pointer">Enable Knowledge Source</label>
    </div>

    <div style="margin-top:10px">
      <label style="font-size:12px;color:var(--text-muted)" for="lens-name-input">Display name</label>
      <input type="text" class="api-key-input" id="lens-name-input" value="${escapeAttr(cfg.name)}" placeholder="${isBrowser ? 'e.g. My Research Library' : isDesktop ? 'e.g. Desktop Library' : 'e.g. Functional Medicine Library'}" style="margin-top:4px">
    </div>

    <!-- Desktop-engine: delegate the setup + ingest UI to knowledge-base.js.
         That module already handles the first-run phase machine, stats line,
         drop zone, doc list, and progress streaming. Mounting it here keeps
         one UX surface — the user never thinks about "which panel is this" —
         while the implementation stays in its natural home. -->
    <div id="lens-desktop-fields" style="${desktopFieldsStyle}">
      <!-- #knowledge-base-section is the id that js/knowledge-base.js re-renders
           into after its async fetchSetupStatus+fetchStats lands. If this div
           is missing that id, the panel stays stuck on "Loading knowledge base…"
           because the module's _renderSection() can't find its mount point. -->
      <div id="knowledge-base-section" style="margin-top:8px">
        ${isDesktop && typeof window !== 'undefined' && window.renderKnowledgeBaseSection
          ? window.renderKnowledgeBaseSection()
          : '<div style="font-size:13px;color:var(--text-muted)">Desktop engine loading…</div>'}
      </div>
    </div>

    <div id="lens-remote-fields" style="${externalFieldsStyle}">
      <div style="margin-top:8px">
        <label style="font-size:12px;color:var(--text-muted)" for="lens-url-input">Endpoint URL</label>
        <input type="text" class="api-key-input" id="lens-url-input" value="${escapeAttr(cfg.url)}" placeholder="https://your-server.example.com/query" style="margin-top:4px">
      </div>
      <div style="margin-top:8px">
        <label style="font-size:12px;color:var(--text-muted)" for="lens-key-input">API key</label>
        <input type="password" class="api-key-input" id="lens-key-input" value="${escapeAttr(keySet ? '••••••••' : '')}" placeholder="Your access key" style="margin-top:4px">
      </div>
      <div style="margin-top:8px">
        <label style="font-size:12px;color:var(--text-muted)" for="lens-test-probe-input">Test query</label>
        <input type="text" class="api-key-input" id="lens-test-probe-input" value="${escapeAttr(cfg.testProbe || DEFAULT_TEST_PROBE)}" placeholder="${escapeAttr(DEFAULT_TEST_PROBE)}" style="margin-top:4px">
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Sent to your endpoint on Save &amp; Test to verify the connection. Pick a query your documents should have good matches for.</div>
      </div>
    </div>

    <div id="lens-local-fields" style="${browserFieldsStyle}">
      <div id="lens-local-libraries" style="margin-top:10px">
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px" for="lens-local-library-select">Library</label>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <select id="lens-local-library-select" onchange="handleLocalLensActivate(this.value)"
                  style="flex:1;min-width:180px;padding:6px 8px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;font-size:13px">
            <option value="">Loading…</option>
          </select>
          <button class="import-btn import-btn-secondary" onclick="handleLocalLensNewLibrary()" style="font-size:12px;padding:6px 10px" title="New library">+ New</button>
          <button class="import-btn import-btn-secondary" onclick="handleLocalLensRenameLibrary()" style="font-size:12px;padding:6px 10px" title="Rename active library">Rename</button>
          <button class="import-btn import-btn-secondary" onclick="handleLocalLensDeleteLibrary()" style="font-size:12px;padding:6px 10px" title="Delete active library">Delete</button>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Separate libraries let you keep different collections — research papers, clinical guides, personal notes — without mixing them. Chat grounds its answers in whichever library is active.</div>
      </div>
      <div id="lens-local-stats" style="margin-top:10px;padding:10px 14px;background:var(--bg-secondary);border-radius:6px;font-size:13px;color:var(--text-muted)">Loading stats…</div>
      <div id="lens-local-drop"
           role="button" tabindex="0"
           aria-label="Add documents — drop files here or press Enter to open the file picker"
           style="margin-top:10px;padding:18px;border:2px dashed var(--border);border-radius:8px;text-align:center;font-size:13px;color:var(--text-muted);cursor:pointer;transition:border-color 0.15s"
           onclick="document.getElementById('lens-local-filepick').click()">
        <div style="font-size:20px;pointer-events:none" aria-hidden="true">📁</div>
        <div style="margin-top:4px;pointer-events:none">Drop documents or click to add</div>
        <div style="font-size:11px;margin-top:2px;opacity:0.7;pointer-events:none">PDF · Markdown · Text · Word · JSON · ZIP</div>
      </div>
      <input type="file" id="lens-local-filepick" multiple style="display:none" accept=".txt,.md,.markdown,.rst,.json,.csv,.log,.pdf,.docx,.zip">
      <div id="lens-local-progress-wrap" style="display:none;margin-top:8px">
        <progress id="lens-local-progress" value="0" max="100" style="width:100%;height:8px" aria-label="Indexing progress"></progress>
        <div id="lens-local-progress-text" role="status" aria-live="polite" style="font-size:11px;color:var(--text-muted);margin-top:4px"></div>
      </div>
      <div id="lens-local-doc-list" style="margin-top:10px"></div>
    </div>

    <div style="margin-top:10px">
      <label style="font-size:12px;color:var(--text-muted)" for="lens-topk-input">Excerpts per question</label>
      <input type="number" class="api-key-input" id="lens-topk-input" value="${cfg.topK || 5}" min="1" max="10" style="margin-top:4px;width:100px">
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px">How many of the most relevant excerpts the AI sees with each chat question.</div>
    </div>

    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="import-btn import-btn-primary" onclick="handleSaveLensConfig()">${isExternal ? 'Save &amp; Test' : 'Save'}</button>
      ${connected ? '<button class="import-btn import-btn-secondary" onclick="handleClearLensCache()">Clear cache</button>' : ''}
      ${connected ? '<button class="import-btn import-btn-secondary" onclick="handleRemoveLens()">Remove</button>' : ''}
    </div>

    <div class="api-key-notice" style="margin-top:12px">
      ${isDesktop
        ? 'Your documents and questions never leave this computer. The Python engine runs locally; no data is sent to any server.'
        : isBrowser
          ? 'Your documents and questions never leave this device. First use downloads a small AI model (about 100 MB); after that it works offline.'
          : 'Your questions are sent directly to the server you configure. Only connect to servers you control or trust.'}
    </div>
  </div>`;
}

function _rerenderLensSection() {
  const section = document.getElementById('custom-lens-section');
  if (section) section.innerHTML = renderCustomLensSection();
}

// Update only the status chip without blowing away input fields
function _updateLensStatusChip() {
  const chip = document.getElementById('lens-status-chip');
  if (!chip) return;
  const cfg = getLensConfig();
  const keySet = !!getLensKey();
  // Same connectedness rule as the main render — per-backend condition.
  const isBrowser = cfg.backend === 'in-browser';
  const isDesktop = cfg.backend === 'desktop-engine';
  const connected = isBrowser
    || (isDesktop && keySet)
    || (cfg.backend === 'external-server' && cfg.url && keySet);
  const status = getLensStatus();
  const statusChip = !connected
    ? '<span style="color:var(--text-muted)">Not connected</span>'
    : status.state === 'error'
      ? `<span style="color:#fbbf24">&#9888; Error${cfg.name ? ' · ' + escapeHTML(cfg.name) : ''}</span>`
      : cfg.enabled
        ? `<span style="color:var(--green)">&#10003; Connected${cfg.name ? ' · ' + escapeHTML(cfg.name) : ''}</span>`
        : `<span style="color:var(--text-muted)">Configured (disabled)</span>`;
  const lastInfo = status.state === 'error' && status.lastError
    ? `<div style="font-size:11px;color:#fbbf24;margin-top:4px">Last error: ${escapeHTML(status.lastError)}</div>`
    : connected && status.lastChunkCount
      ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Last query: ${status.lastChunkCount} excerpt${status.lastChunkCount !== 1 ? 's' : ''}${status.sourceName ? ' from ' + escapeHTML(status.sourceName) : ''}</div>`
      : '';
  chip.innerHTML = statusChip + lastInfo;
}

export async function handleSaveLensConfig() {
  const name = (document.getElementById('lens-name-input')?.value || '').trim();
  const topK = Math.max(1, Math.min(10, parseInt(document.getElementById('lens-topk-input')?.value, 10) || 5));
  const enabled = !!document.getElementById('lens-enabled-toggle')?.checked;
  // Backend is set by the pill buttons via handleLensBackendChange and
  // persisted immediately — read it from config rather than DOM.
  const backend = getLensConfig().backend || 'in-browser';

  if (backend === 'in-browser') {
    saveLensConfig({ name, enabled, topK, backend });
    _rerenderLensSection();
    _loadLocalLensStats();
    showNotification('Saved. Your documents stay on this device.', 'success');
    return;
  }

  if (backend === 'desktop-engine') {
    // Desktop engine doesn't need URL/key inputs — the Python lens
    // listens on fixed 127.0.0.1:8322 and the API key is generated by
    // the engine itself. Fetch it now so queries work immediately.
    saveLensConfig({ name, enabled, topK, backend });
    try {
      if (!getLensKey()) {
        const cfg = await window.api?.invoke?.('get_lens_config');
        if (cfg?.api_key) await saveLensKey(cfg.api_key);
      }
    } catch (e) {
      showNotification(`Couldn't read the engine's API key: ${e?.message || e}.`, 'error');
      return;
    }
    _rerenderLensSection();
    showNotification('Saved. Using the desktop engine.', 'success');
    return;
  }

  // external-server
  const url = (document.getElementById('lens-url-input')?.value || '').trim().replace(/\/+$/, '');
  const keyRaw = document.getElementById('lens-key-input')?.value || '';
  const testProbe = (document.getElementById('lens-test-probe-input')?.value || '').trim() || DEFAULT_TEST_PROBE;

  if (!url) { showNotification('Please enter an endpoint URL', 'error'); return; }
  if (!isValidLensUrl(url)) { showNotification('URL must be https:// (or http:// to localhost / LAN / .local)', 'error'); return; }

  const key = (keyRaw === '••••••••') ? getLensKey() : keyRaw.trim();
  if (!key) { showNotification('Please enter an API key', 'error'); return; }

  saveLensConfig({ name, url, enabled, topK, testProbe, backend });
  if (keyRaw !== '••••••••') await saveLensKey(key);

  const result = await testLensConnection();
  _rerenderLensSection();
  if (result.ok) {
    // Connectivity succeeded. Passage count is informational so users with
    // domains that don't match the default probe don't misread "0 passages"
    // as "broken" — the endpoint answered and the auth is correct.
    const n = result.chunkCount;
    const msg = n > 0
      ? `Connected — found ${n} good excerpt${n !== 1 ? 's' : ''} for the test query`
      : `Connected — your endpoint works, but the test query didn't find any close matches. Try a query more specific to what you've indexed.`;
    showNotification(msg, 'success');
  } else {
    showNotification(`Connection failed: ${result.error}`, 'error');
  }
}

/// Backend radio handler — saves the choice immediately (so a reload
/// keeps the selection). Re-renders the whole panel since the per-backend
/// sections have structurally different layouts (desktop-engine mounts
/// the KB panel from knowledge-base.js, in-browser shows the library
/// picker, external-server has URL/key fields).
export async function handleLensBackendChange(backend) {
  saveLensConfig({ backend });
  // Desktop-engine path auto-reads the generated API key so the user
  // doesn't have to hit Save before chat can query. Silent — if the
  // engine isn't set up yet, the KB panel will show its setup flow
  // inside the mounted section anyway.
  if (backend === 'desktop-engine' && !getLensKey() && window.api?.invoke) {
    try {
      const cfg = await window.api.invoke('get_lens_config');
      if (cfg?.api_key) await saveLensKey(cfg.api_key);
    } catch { /* engine not set up yet — fine, panel handles it */ }
  }
  _rerenderLensSection();
  if (backend === 'in-browser') _loadLocalLensStats();
  _updateLensStatusChip();
  updateLensIndicator();
}

/// Populate the local-corpus stats line + doc list + wire the drop handler.
/// Lazy-imports lens-local.js so remote-only users don't pay the cost.
/// Idempotent — called on panel render, backend toggle, and after ingest.
///
/// No local cache here: `openLocalLens()` memoizes its own `_ready`
/// Promise, so repeated `await openLocalLens()` is free. One source of
/// truth; no drift possible.
async function _getLocalLens() {
  const mod = await import('./lens-local.js');
  return mod.openLocalLens();
}

async function _loadLocalLensStats() {
  const stats = document.getElementById('lens-local-stats');
  const list = document.getElementById('lens-local-doc-list');
  const librarySelect = document.getElementById('lens-local-library-select');
  if (!stats) return;
  try {
    const lens = await _getLocalLens();
    // Populate the library picker. Happens on every stats refresh so
    // create/rename/delete all show their effect without a dedicated
    // refresh path.
    if (librarySelect) {
      const { libraries, activeId } = await lens.listLibraries();
      librarySelect.innerHTML = libraries.map((l) =>
        `<option value="${escapeAttr(l.id)}" ${l.id === activeId ? 'selected' : ''}>${escapeHTML(l.name)}</option>`
      ).join('');
    }
    const s = await lens.getStats();
    if (s.total_chunks === 0) {
      stats.innerHTML = '<span style="color:var(--text-muted)">No documents indexed yet.</span>';
    } else {
      // Human-readable model label rather than the raw HF repo id.
      const modelLabel = /minilm/i.test(s.model)
        ? `MiniLM · ${s.dim}-dim`
        : /bge-m3/i.test(s.model) ? `BGE-M3 · ${s.dim}-dim` : `${s.model} · ${s.dim}-dim`;
      stats.innerHTML = `<span style="color:var(--green)">&#9679;</span> ${s.total_chunks.toLocaleString()} excerpt${s.total_chunks !== 1 ? 's' : ''} from ${s.documents.length} document${s.documents.length !== 1 ? 's' : ''} · <span title="${escapeAttr(s.model)}">${escapeHTML(modelLabel)}</span>`;
    }
    if (list) list.innerHTML = _renderLocalDocList(s.documents);
    _attachLocalLensDropHandlers();
  } catch (e) {
    stats.innerHTML = `<span style="color:#fbbf24">Failed to load stats: ${escapeHTML(e?.message || String(e))}</span>`;
  }
}

function _renderLocalDocList(docs) {
  if (!docs || docs.length === 0) return '';
  const rows = docs.map((d) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px">
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeAttr(d.source)}">${escapeHTML(d.source)}</span>
      <span style="color:var(--text-muted);margin:0 10px;font-variant-numeric:tabular-nums">${d.chunks}</span>
      <button class="kb-doc-delete" onclick="handleLocalLensDeleteDoc(${JSON.stringify(d.source).replace(/"/g, '&quot;')})" aria-label="Delete ${escapeAttr(d.source)}" title="Delete" style="background:transparent;border:0;color:var(--text-muted);cursor:pointer;font-size:16px;padding:2px 6px">×</button>
    </div>
  `).join('');
  return `
    <div style="margin-top:4px;max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">${rows}</div>
    <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
      <button class="import-btn import-btn-secondary" onclick="handleLocalLensClear()" style="font-size:12px;padding:4px 10px">Clear all</button>
    </div>
  `;
}

function _attachLocalLensDropHandlers() {
  const drop = document.getElementById('lens-local-drop');
  const picker = document.getElementById('lens-local-filepick');
  if (!drop || !picker) return;
  // Reset idempotent binding — removes listeners from a previous render so
  // we don't stack them every time the section re-renders.
  if (drop.dataset.wired === '1') return;
  drop.dataset.wired = '1';
  drop.addEventListener('dragenter', (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; });
  drop.addEventListener('dragleave', () => { drop.style.borderColor = 'var(--border)'; });
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.style.borderColor = 'var(--border)'; _handleLocalLensIngest(e.dataTransfer?.files); });
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); }
  });
  picker.addEventListener('change', (e) => { _handleLocalLensIngest(e.target.files); e.target.value = ''; });
}

async function _handleLocalLensIngest(fileList) {
  // Snapshot IMMEDIATELY — FileList from an <input type=file>.files is a
  // LIVE reference, and the picker's change handler clears input.value
  // right after calling us. Awaiting the dynamic import below would give
  // the clear a chance to empty the FileList mid-flight. Array.from copies
  // the File handles off the live list; each File itself stays valid.
  const incoming = fileList ? Array.from(fileList) : [];
  if (incoming.length === 0) return;

  const wrap = document.getElementById('lens-local-progress-wrap');
  const bar = document.getElementById('lens-local-progress');
  const textEl = document.getElementById('lens-local-progress-text');
  if (wrap) wrap.style.display = '';
  if (textEl) textEl.textContent = 'Reading files…';

  // Parse main-thread, hand text to worker (see lens-local-parsers.js for
  // why: module worker can't cleanly import the UMD parser bundles).
  const { extractFromFile } = await import('./lens-local-parsers.js');
  const files = [];
  for (const f of incoming) {
    try {
      const extracted = await extractFromFile(f);
      for (const e of extracted) files.push(e);
    } catch (err) { console.warn('[lens-local] extract failed:', f.name, err); }
  }
  if (files.length === 0) {
    if (textEl) textEl.textContent = 'No usable files.';
    return;
  }

  const lens = await _getLocalLens();
  const { subscribeProgress } = await import('./lens-local.js');
  const t0 = performance.now();
  const unsub = subscribeProgress((p) => {
    if (!bar || !textEl) return;
    if (p.stage === 'start') {
      bar.max = p.total;
      textEl.textContent = `Preparing ${p.total} excerpts across ${files.length} file${files.length !== 1 ? 's' : ''}…`;
    } else if (p.stage === 'embed') {
      bar.value = p.index;
      const rate = p.index / ((performance.now() - t0) / 1000);
      textEl.textContent = `Indexing ${p.index}/${p.total} · ${rate.toFixed(1)}/s · ${p.source}`;
    }
  });
  try {
    const stats = await lens.ingest(files);
    const dur = ((performance.now() - t0) / 1000).toFixed(1);
    if (textEl) textEl.textContent = `Indexed ${stats.chunks_indexed} excerpts from ${stats.files_seen} file${stats.files_seen !== 1 ? 's' : ''} in ${dur}s.`;
    showNotification(`Indexed ${stats.chunks_indexed} excerpts from ${stats.files_seen} file${stats.files_seen !== 1 ? 's' : ''}.`, 'success');
  } catch (e) {
    if (textEl) textEl.textContent = `Couldn't index: ${e.message || e}`;
    showNotification(`Couldn't index: ${e.message || e}`, 'error');
  } finally {
    unsub();
    setTimeout(() => { if (wrap) wrap.style.display = 'none'; }, 3000);
    await _loadLocalLensStats();
  }
}

export function handleLocalLensDeleteDoc(source) {
  if (!source) return;
  showConfirmDialog(`Remove "${source}" from your knowledge base?`, async () => {
    try {
      const lens = await _getLocalLens();
      const deleted = await lens.deleteDocument(source);
      showNotification(`Removed ${deleted} excerpt${deleted !== 1 ? 's' : ''}.`, 'success');
      await _loadLocalLensStats();
    } catch (e) {
      showNotification(`Couldn't delete that document: ${e?.message || e}.`, 'error');
    }
  });
}

export function handleLocalLensClear() {
  showConfirmDialog('Clear every document from your knowledge base? This can\'t be undone.', async () => {
    try {
      const lens = await _getLocalLens();
      await lens.clear();
      clearLensCache(); // stale query cache no longer points at anything real
      showNotification('Knowledge base cleared.', 'success');
      await _loadLocalLensStats();
    } catch (e) {
      showNotification(`Couldn't clear the knowledge base: ${e?.message || e}.`, 'error');
    }
  });
}

// ── Library management handlers ────────────────────────────────

export async function handleLocalLensActivate(libraryId) {
  if (!libraryId) return;
  try {
    const lens = await _getLocalLens();
    const info = await lens.activateLibrary(libraryId);
    clearLensCache(); // stale query cache belongs to the previous library
    updateLensIndicator();
    showNotification(`Switched to "${info.activeName}".`, 'info');
    await _loadLocalLensStats();
  } catch (e) {
    showNotification(`Couldn't switch library: ${e?.message || e}.`, 'error');
  }
}

export async function handleLocalLensNewLibrary() {
  const name = (typeof prompt === 'function' ? prompt('Name for the new library?') : '')?.trim();
  if (!name) return;
  try {
    const lens = await _getLocalLens();
    const created = await lens.createLibrary(name);
    // Activate the new library so the user can start ingesting right away.
    await lens.activateLibrary(created.id);
    clearLensCache();
    updateLensIndicator();
    showNotification(`Created "${created.name}". Drop documents to index them.`, 'success');
    await _loadLocalLensStats();
  } catch (e) {
    showNotification(`Couldn't create library: ${e?.message || e}.`, 'error');
  }
}

export async function handleLocalLensRenameLibrary() {
  try {
    const lens = await _getLocalLens();
    const { libraries, activeId } = await lens.listLibraries();
    const active = libraries.find((l) => l.id === activeId);
    const current = active?.name || '';
    const next = (typeof prompt === 'function' ? prompt('Rename library:', current) : '')?.trim();
    if (!next || next === current) return;
    await lens.renameLibrary(activeId, next);
    showNotification(`Renamed to "${next}".`, 'info');
    await _loadLocalLensStats();
  } catch (e) {
    showNotification(`Couldn't rename library: ${e?.message || e}.`, 'error');
  }
}

export function handleLocalLensDeleteLibrary() {
  showConfirmDialog('Delete the active library? Every document in it will be removed. This can\'t be undone.', async () => {
    try {
      const lens = await _getLocalLens();
      const { libraries, activeId } = await lens.listLibraries();
      await lens.deleteLibrary(activeId);
      clearLensCache();
      updateLensIndicator();
      // If that was the last real library, the worker auto-created a new
      // "My Library" default. Surface that to the user clearly.
      const remaining = libraries.length - 1;
      showNotification(
        remaining === 0
          ? 'Library deleted. A fresh "My Library" is ready for new documents.'
          : 'Library deleted.',
        'info',
      );
      await _loadLocalLensStats();
    } catch (e) {
      showNotification(`Couldn't delete library: ${e?.message || e}.`, 'error');
    }
  });
}

export function handleToggleLens(checked) {
  saveLensConfig({ enabled: checked });
  // Don't re-render the section — it would discard unsaved field edits.
  // The chip + chat-header indicator pick up the change via subscribers.
  _updateLensStatusChip();
  updateLensIndicator();
}

export function handleClearLensCache() {
  clearLensCache();
  showNotification('Lens cache cleared', 'info');
}

export function handleRemoveLens() {
  const cfg = getLensConfig();
  const isBrowser = cfg.backend === 'in-browser';
  const isDesktop = cfg.backend === 'desktop-engine';
  // Branch the confirmation copy + cleanup per backend.
  //   external-server: only holds a URL + encrypted key in localStorage.
  //   in-browser:      also owns an OPFS corpus with the user's indexed docs.
  //   desktop-engine:  the Python engine's qdrant data lives on disk
  //                    under user-data-dir; "Remove" here disconnects
  //                    but does NOT uninstall the engine — users can
  //                    reconnect later without re-running setup.
  const prompt = isBrowser
    ? 'Remove Knowledge Source? This also deletes every document you indexed in the browser. This can\'t be undone.'
    : isDesktop
      ? 'Disconnect from the desktop engine? Your indexed documents stay on disk — you can reconnect later without re-running setup. To remove everything, use "Remove all" inside the engine panel first.'
      : 'Remove Knowledge Source? Your server URL and API key will be deleted.';
  showConfirmDialog(prompt, async () => {
    await removeLens();
    if (isBrowser) {
      try {
        const lens = await _getLocalLens();
        await lens.clear();
      } catch (e) {
        console.warn('[lens] local corpus clear failed:', e);
      }
    }
    _rerenderLensSection();
    showNotification(
      isBrowser ? 'Knowledge Source and indexed documents removed.'
      : isDesktop ? 'Disconnected from desktop engine.'
      : 'Knowledge Source removed.',
      'info',
    );
  });
}

Object.assign(window, {
  getLensConfig, saveLensConfig, getLensKey, saveLensKey, removeLens,
  hasLens, queryLens, buildLensSnippet, testLensConnection, clearLensCache,
  subscribeLensStatus, getLensStatus, isValidLensUrl,
  renderCustomLensSection, handleSaveLensConfig, handleToggleLens,
  handleClearLensCache, handleRemoveLens, updateLensIndicator,
  handleLensBackendChange,
  handleLocalLensDeleteDoc, handleLocalLensClear,
  handleLocalLensActivate, handleLocalLensNewLibrary,
  handleLocalLensRenameLibrary, handleLocalLensDeleteLibrary,
});
