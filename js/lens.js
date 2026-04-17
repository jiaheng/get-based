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
// backend: 'remote'         — POST to URL + Bearer key (today's behavior)
//          'local-browser'  — in-process MiniLM via js/lens-local.js,
//                             corpus in OPFS. No server, no network.
//                             Works offline, slower on WASM but private.
const DEFAULT_CONFIG = {
  name: '',
  url: '',
  enabled: false,
  topK: 5,
  testProbe: DEFAULT_TEST_PROBE,
  backend: 'remote',
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
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch { return { ...DEFAULT_CONFIG }; }
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
  if (cfg.backend === 'local-browser') {
    // Local backend needs OPFS + Web Workers + dynamic import. Every
    // evergreen browser has them; feature-detect defensively so we don't
    // claim a working lens on a legacy UA that'll throw at first query.
    return typeof navigator !== 'undefined'
      && !!navigator.storage
      && typeof Worker !== 'undefined';
  }
  // Default: remote URL requires a bearer key.
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
  if (cfg.backend === 'local-browser') {
    return _doLocalQuery(topK, cfg.name || 'Local Knowledge Base', queryHint, opts);
  }
  return _doQuery(cfg.url, getLensKey(), topK, cfg.name || 'Lens', queryHint, opts);
}

/// Local backend dispatch. Lazy-imports lens-local.js only when the user
/// has opted into the browser backend — PWA users on the remote path
/// don't pay the bundle cost.
async function _doLocalQuery(topK, sourceName, queryHint, opts = {}) {
  const profileId = state.currentProfile || 'default';
  const hint = String(queryHint || '').trim();
  if (!hint) return null;

  // Local cache still helps — embedding the query itself is ~8 ms on
  // WASM and the search is ~10 ms/10k chunks, so a cache hit saves
  // 20-30 ms per repeat. Matches remote cache TTL + bucketing.
  const ck = cacheKey('local-browser', topK, profileId, hint);
  const cached = cacheGet(ck);
  if (cached) {
    if (isDebugMode()) console.log('[Lens] (local) cache hit');
    updateLensStatus({ state: 'active', lastChunkCount: cached.chunks.length, lastError: null, sourceName });
    return cached;
  }

  try {
    const mod = await import('./lens-local.js');
    const result = await mod.queryLensLocal(hint, { topK });
    if (!result) {
      updateLensStatus({ state: 'active', lastChunkCount: 0, lastError: null, sourceName });
      return { chunks: [], sourceName };
    }
    // Conform to the same shape as remote results so chat.js doesn't care.
    const normalized = {
      chunks: result.chunks.map((c) => ({ text: c.text, source: c.source })),
      sourceName,
    };
    cacheSet(ck, normalized);
    updateLensStatus({ state: 'active', lastChunkCount: normalized.chunks.length, lastError: null, sourceName });
    return normalized;
  } catch (e) {
    const msg = e?.message || 'unknown error';
    if (isDebugMode()) console.warn('[Lens] (local) query failed:', msg);
    updateLensStatus({ state: 'error', lastError: msg });
    return null;
  }
}

async function _doQuery(url, key, topK, sourceName, queryHint, opts = {}) {
  const profileId = state.currentProfile || 'default';
  const hint = String(queryHint || '').trim();
  if (!hint || !url || !key) return null;

  const ck = cacheKey(url, topK, profileId, hint);
  const cached = cacheGet(ck);
  if (cached) {
    if (isDebugMode()) console.log('[Lens] cache hit');
    updateLensStatus({ state: 'active', lastChunkCount: cached.chunks.length, lastError: null, sourceName });
    return cached;
  }

  const outerSignal = opts.signal;
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
    clearTimeout(timer);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const err = await res.json(); if (err && err.error) msg = String(err.error); } catch {}
      throw new Error(msg);
    }
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    const data = JSON.parse(text);
    const chunks = Array.isArray(data && data.chunks) ? data.chunks.slice(0, MAX_CHUNKS)
      .map(c => ({ text: String(c && c.text || '').slice(0, 4000), source: c && c.source ? String(c.source).slice(0, 200) : '' }))
      .filter(c => c.text) : [];
    const result = { chunks, sourceName };
    cacheSet(ck, result);
    updateLensStatus({ state: 'active', lastChunkCount: chunks.length, lastError: null, sourceName });
    return result;
  } catch (e) {
    clearTimeout(timer);
    const msg = (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'unknown error';
    if (isDebugMode()) console.warn('[Lens] query failed:', msg);
    updateLensStatus({ state: 'error', lastError: msg });
    return null;
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
  const keySet = !!getLensKey();
  const isLocal = cfg.backend === 'local-browser';
  // Connected: backend-dependent. Remote needs URL + key; local only
  // needs the backend toggle set. Browsers without OPFS / Workers
  // would hasLens() == false, but that path is already feature-detected.
  const connected = isLocal || (cfg.url && keySet);
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

  // Remote-only fields, hidden when Browser backend is selected. The
  // radio handler swaps the `display:none` so we don't have to re-render
  // the whole panel on toggle — preserves scroll position + focus.
  const remoteFieldsStyle = isLocal ? 'display:none' : '';
  const localFieldsStyle = isLocal ? '' : 'display:none';

  return `<div class="ai-provider-panel">
    <div class="ai-provider-desc">Connect a knowledge base to ground the AI's analysis in real sources — research papers, clinical guides, or any documents you choose. When enabled, the AI looks up the most relevant excerpts from your library before answering. <a href="/docs/guide/interpretive-lens#custom-knowledge-source-rag" target="_blank" rel="noopener" style="color:var(--accent)">Setup guide &rarr;</a></div>
    <div class="api-key-status" id="lens-status-chip">${statusChip}${lastInfo}</div>

    <div style="margin-top:10px">
      <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px">Backend</label>
      <div style="display:flex;gap:14px;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
          <input type="radio" name="lens-backend" value="remote" ${!isLocal ? 'checked' : ''} onchange="handleLensBackendChange('remote')">
          Remote server
        </label>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
          <input type="radio" name="lens-backend" value="local-browser" ${isLocal ? 'checked' : ''} onchange="handleLensBackendChange('local-browser')">
          Browser (local, no network)
        </label>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px">
        ${isLocal
          ? 'Your documents stay on this device. First-time indexing is slower but queries are instant and work offline.'
          : 'Connect to a lens server you run (or one run by someone you trust). Fastest for large corpora.'}
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
      <input type="text" class="api-key-input" id="lens-name-input" value="${escapeAttr(cfg.name)}" placeholder="${isLocal ? 'e.g. My Research Library' : 'e.g. Functional Medicine Library'}" style="margin-top:4px">
    </div>

    <div id="lens-remote-fields" style="${remoteFieldsStyle}">
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
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Sent to your endpoint on Save &amp; Test to verify the connection. Pick a query your corpus is likely to have good matches for.</div>
      </div>
    </div>

    <div id="lens-local-fields" style="${localFieldsStyle}">
      <div id="lens-local-stats" style="margin-top:10px;padding:10px 14px;background:var(--bg-secondary);border-radius:6px;font-size:13px;color:var(--text-muted)">Loading corpus stats…</div>
      <div id="lens-local-drop"
           role="button" tabindex="0"
           aria-label="Add documents — drop files here or press Enter to open the file picker"
           style="margin-top:10px;padding:18px;border:2px dashed var(--border);border-radius:8px;text-align:center;font-size:13px;color:var(--text-muted);cursor:pointer;transition:border-color 0.15s"
           onclick="document.getElementById('lens-local-filepick').click()">
        <div style="font-size:20px" aria-hidden="true">📁</div>
        <div style="margin-top:4px">Drop documents or click to add</div>
        <div style="font-size:11px;margin-top:2px;opacity:0.7">PDF · Markdown · Text · Word · JSON · ZIP</div>
      </div>
      <input type="file" id="lens-local-filepick" multiple style="display:none" accept=".txt,.md,.markdown,.rst,.json,.csv,.log,.pdf,.docx,.zip">
      <div id="lens-local-progress-wrap" style="display:none;margin-top:8px">
        <progress id="lens-local-progress" value="0" max="100" style="width:100%;height:8px"></progress>
        <div id="lens-local-progress-text" style="font-size:11px;color:var(--text-muted);margin-top:4px"></div>
      </div>
      <div id="lens-local-doc-list" style="margin-top:10px"></div>
    </div>

    <div style="margin-top:10px">
      <label style="font-size:12px;color:var(--text-muted)" for="lens-topk-input">Excerpts per question</label>
      <input type="number" class="api-key-input" id="lens-topk-input" value="${cfg.topK || 5}" min="1" max="10" style="margin-top:4px;width:100px">
      <div style="font-size:11px;color:var(--text-muted);margin-top:4px">How many of the most relevant excerpts the AI sees with each chat question.</div>
    </div>

    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="import-btn import-btn-primary" onclick="handleSaveLensConfig()">${isLocal ? 'Save' : 'Save &amp; Test'}</button>
      ${connected ? '<button class="import-btn import-btn-secondary" onclick="handleClearLensCache()">Clear cache</button>' : ''}
      ${connected ? '<button class="import-btn import-btn-secondary" onclick="handleRemoveLens()">Remove</button>' : ''}
    </div>

    <div class="api-key-notice" style="margin-top:12px">
      ${isLocal
        ? 'Your documents and queries never leave this browser. The embedding model runs in a Web Worker; vectors persist in OPFS (origin-private storage).'
        : 'Your questions are sent directly to the server you configure. Only connect to servers you control or trust. Your key is encrypted at rest on this device.'}
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
  const connected = cfg.url && keySet;
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
  const backend = document.querySelector('input[name="lens-backend"]:checked')?.value
    || getLensConfig().backend || 'remote';

  if (backend === 'local-browser') {
    // Browser backend has no URL + no key. Still persists all shared
    // fields (name, topK, enabled) so switching backends preserves them.
    saveLensConfig({ name, enabled, topK, backend });
    _rerenderLensSection();
    _loadLocalLensStats();
    showNotification('Saved. Using browser-local corpus.', 'success');
    return;
  }

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
/// keeps the selection) and swaps field visibility without re-rendering,
/// so unsaved edits in the name/topK inputs aren't lost.
export function handleLensBackendChange(backend) {
  saveLensConfig({ backend });
  const remote = document.getElementById('lens-remote-fields');
  const local = document.getElementById('lens-local-fields');
  if (remote) remote.style.display = backend === 'local-browser' ? 'none' : '';
  if (local) local.style.display = backend === 'local-browser' ? '' : 'none';
  if (backend === 'local-browser') _loadLocalLensStats();
  _updateLensStatusChip();
  updateLensIndicator();
}

/// Populate the local-corpus stats line + doc list + wire the drop handler.
/// Lazy-imports lens-local.js so remote-only users don't pay the cost.
/// Idempotent — called on panel render, backend toggle, and after ingest.
let _localLens = null; // cached so drop / query / delete / clear share one handle
async function _loadLocalLensStats() {
  const stats = document.getElementById('lens-local-stats');
  const list = document.getElementById('lens-local-doc-list');
  if (!stats) return;
  try {
    if (!_localLens) {
      const mod = await import('./lens-local.js');
      _localLens = await mod.openLocalLens();
    }
    const s = await _localLens.getStats();
    if (s.total_chunks === 0) {
      stats.innerHTML = '<span style="color:var(--text-muted)">No documents indexed yet.</span>';
    } else {
      stats.innerHTML = `<span style="color:var(--green)">&#9679;</span> ${s.total_chunks.toLocaleString()} excerpt${s.total_chunks !== 1 ? 's' : ''} from ${s.documents.length} document${s.documents.length !== 1 ? 's' : ''} · ${escapeHTML(s.model)}`;
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
  if (!fileList || fileList.length === 0) return;
  const wrap = document.getElementById('lens-local-progress-wrap');
  const bar = document.getElementById('lens-local-progress');
  const textEl = document.getElementById('lens-local-progress-text');
  if (wrap) wrap.style.display = '';
  if (textEl) textEl.textContent = 'Extracting text from files…';

  // Parse main-thread, hand text to worker (see lens-local-parsers.js for
  // why: module worker can't cleanly import the UMD parser bundles).
  const { extractFromFile } = await import('./lens-local-parsers.js');
  const files = [];
  for (const f of Array.from(fileList)) {
    try {
      const extracted = await extractFromFile(f);
      for (const e of extracted) files.push(e);
    } catch (err) { console.warn('[lens-local] extract failed:', f.name, err); }
  }
  if (files.length === 0) {
    if (textEl) textEl.textContent = 'No usable files.';
    return;
  }

  if (!_localLens) {
    const mod = await import('./lens-local.js');
    _localLens = await mod.openLocalLens();
  }
  const { subscribeProgress } = await import('./lens-local.js');
  const t0 = performance.now();
  const unsub = subscribeProgress((p) => {
    if (!bar || !textEl) return;
    if (p.stage === 'start') {
      bar.max = p.total;
      textEl.textContent = `Starting: ${p.total} chunks across ${files.length} files`;
    } else if (p.stage === 'embed') {
      bar.value = p.index;
      const rate = p.index / ((performance.now() - t0) / 1000);
      textEl.textContent = `Embedding ${p.index}/${p.total} · ${rate.toFixed(1)}/s · ${p.source}`;
    }
  });
  try {
    const stats = await _localLens.ingest(files);
    const dur = ((performance.now() - t0) / 1000).toFixed(1);
    if (textEl) textEl.textContent = `Ingested ${stats.chunks_indexed} chunks from ${stats.files_seen} files in ${dur} s.`;
    showNotification(`Indexed ${stats.chunks_indexed} excerpts from ${stats.files_seen} file${stats.files_seen !== 1 ? 's' : ''}.`, 'success');
  } catch (e) {
    if (textEl) textEl.textContent = `Ingest failed: ${e.message}`;
    showNotification(`Ingest failed: ${e.message}`, 'error');
  } finally {
    unsub();
    setTimeout(() => { if (wrap) wrap.style.display = 'none'; }, 3000);
    await _loadLocalLensStats();
  }
}

export async function handleLocalLensDeleteDoc(source) {
  if (!source) return;
  if (!confirm(`Delete "${source}" from your local knowledge base?`)) return;
  if (!_localLens) {
    const mod = await import('./lens-local.js');
    _localLens = await mod.openLocalLens();
  }
  try {
    const deleted = await _localLens.deleteDocument(source);
    showNotification(`Removed ${deleted} excerpt${deleted !== 1 ? 's' : ''}.`, 'success');
    await _loadLocalLensStats();
  } catch (e) {
    showNotification(`Delete failed: ${e.message}`, 'error');
  }
}

export async function handleLocalLensClear() {
  if (!confirm('Clear every document from your local knowledge base? This cannot be undone.')) return;
  if (!_localLens) {
    const mod = await import('./lens-local.js');
    _localLens = await mod.openLocalLens();
  }
  try {
    await _localLens.clear();
    clearLensCache(); // stale query cache no longer points at anything real
    showNotification('Local knowledge base cleared.', 'success');
    await _loadLocalLensStats();
  } catch (e) {
    showNotification(`Clear failed: ${e.message}`, 'error');
  }
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
  showConfirmDialog('Remove Knowledge Source? Your server URL and API key will be deleted.', async () => {
    await removeLens();
    _rerenderLensSection();
    showNotification('Lens removed', 'info');
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
});
