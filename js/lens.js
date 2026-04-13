// lens.js — Custom Knowledge Source (Lens Corpus)
// User-configured RAG endpoint that backs the Interpretive Lens with retrieved chunks.

import { state } from './state.js';
import { getCachedKey, updateKeyCache, encryptedSetItem } from './crypto.js';
import { hashString, showNotification, showConfirmDialog, isDebugMode, escapeHTML, escapeAttr } from './utils.js';

const CONFIG_KEY = 'labcharts-lens-config';
const SECRET_KEY = 'labcharts-lens-key';

const DEFAULT_CONFIG = { name: '', url: '', enabled: false, topK: 5 };
const TIMEOUT_MS = 5000;
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
  return !!(cfg.enabled && cfg.url && getLensKey());
}

// ─── URL validation ───────────────────────────────────────────
export function isValidLensUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')) return true;
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
  const key = getLensKey();
  const topK = typeof opts.topK === 'number' ? opts.topK : cfg.topK;
  return _doQuery(cfg.url, key, topK, cfg.name || 'Lens', queryHint, opts);
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
export async function testLensConnection() {
  const cfg = getLensConfig();
  const key = getLensKey();
  if (!cfg.url || !key) return { ok: false, error: 'URL and API key required' };
  clearLensCache();
  updateLensStatus({ state: 'idle', lastError: null });
  const result = await _doQuery(cfg.url, key, cfg.topK, cfg.name || 'Lens', 'test query', {});
  if (!result) return { ok: false, error: getLensStatus().lastError || 'unknown error' };
  return { ok: true, chunkCount: result.chunks.length, firstSource: result.chunks[0]?.source || '' };
}

// ═══════════════════════════════════════════════
// CHAT-HEADER INDICATOR
// ═══════════════════════════════════════════════
export function updateLensIndicator() {
  const btn = document.getElementById('chat-lens-indicator');
  if (!btn) return;
  btn.classList.remove('active', 'error');
  if (!hasLens()) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  const s = getLensStatus();
  if (s.state === 'active') btn.classList.add('active');
  else if (s.state === 'error') btn.classList.add('error');
  const cfg = getLensConfig();
  const tip = s.state === 'error'
    ? `Lens error: ${s.lastError || 'unknown'}`
    : s.state === 'active'
      ? `Lens active${cfg.name ? ': ' + cfg.name : ''} · ${s.lastChunkCount || 0} chunks`
      : `Lens ready${cfg.name ? ': ' + cfg.name : ''}`;
  btn.title = tip;
}

subscribeLensStatus(updateLensIndicator);

// ═══════════════════════════════════════════════
// SETTINGS PANEL
// ═══════════════════════════════════════════════
export function renderCustomLensSection() {
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
      ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Last query: ${status.lastChunkCount} chunk${status.lastChunkCount !== 1 ? 's' : ''}${status.sourceName ? ' from ' + escapeHTML(status.sourceName) : ''}</div>`
      : '';

  return `<div class="ai-provider-panel">
    <div class="ai-provider-desc">Back your Interpretive Lens with a RAG endpoint. When configured, each chat question is sent to your endpoint; retrieved framework chunks inform the AI's interpretation of your lab data. <a href="/docs/guide/interpretive-lens#custom-knowledge-source-rag" target="_blank" rel="noopener" style="color:var(--accent)">Contract spec &rarr;</a></div>
    <div class="api-key-status" id="lens-status-chip">${statusChip}${lastInfo}</div>
    <div style="margin-top:8px;display:flex;align-items:center;gap:10px">
      <label class="toggle-switch">
        <input type="checkbox" id="lens-enabled-toggle" ${cfg.enabled ? 'checked' : ''} onchange="handleToggleLens(this.checked)">
        <span class="toggle-slider"></span>
      </label>
      <span style="font-size:13px">Enable Custom Knowledge Source</span>
    </div>
    <div style="margin-top:10px">
      <label style="font-size:12px;color:var(--text-muted)">Display name</label>
      <input type="text" class="api-key-input" id="lens-name-input" value="${escapeAttr(cfg.name)}" placeholder="Bredesen Protocol RAG" style="margin-top:4px">
    </div>
    <div style="margin-top:8px">
      <label style="font-size:12px;color:var(--text-muted)">Endpoint URL</label>
      <input type="text" class="api-key-input" id="lens-url-input" value="${escapeAttr(cfg.url)}" placeholder="https://your-rag.example.com/query" style="margin-top:4px">
    </div>
    <div style="margin-top:8px">
      <label style="font-size:12px;color:var(--text-muted)">API key</label>
      <input type="password" class="api-key-input" id="lens-key-input" value="${escapeAttr(keySet ? '••••••••' : '')}" placeholder="Bearer token" style="margin-top:4px">
    </div>
    <div style="margin-top:8px">
      <label style="font-size:12px;color:var(--text-muted)">Chunks per query (top_k)</label>
      <input type="number" class="api-key-input" id="lens-topk-input" value="${cfg.topK || 5}" min="1" max="10" style="margin-top:4px;width:100px">
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="import-btn import-btn-primary" onclick="handleSaveLensConfig()">Save &amp; Test</button>
      ${connected ? '<button class="import-btn import-btn-secondary" onclick="handleClearLensCache()">Clear cache</button>' : ''}
      ${connected ? '<button class="import-btn import-btn-secondary" onclick="handleRemoveLens()">Remove</button>' : ''}
    </div>
    <div class="api-key-notice" style="margin-top:12px">Queries are sent verbatim to the endpoint you configure. Only connect to endpoints you control or trust. Your key is encrypted at rest.</div>
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
      ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Last query: ${status.lastChunkCount} chunk${status.lastChunkCount !== 1 ? 's' : ''}${status.sourceName ? ' from ' + escapeHTML(status.sourceName) : ''}</div>`
      : '';
  chip.innerHTML = statusChip + lastInfo;
}

export async function handleSaveLensConfig() {
  const name = (document.getElementById('lens-name-input')?.value || '').trim();
  const url = (document.getElementById('lens-url-input')?.value || '').trim().replace(/\/+$/, '');
  const keyRaw = document.getElementById('lens-key-input')?.value || '';
  const topK = Math.max(1, Math.min(10, parseInt(document.getElementById('lens-topk-input')?.value, 10) || 5));
  const enabled = !!document.getElementById('lens-enabled-toggle')?.checked;

  if (!url) { showNotification('Please enter an endpoint URL', 'error'); return; }
  if (!isValidLensUrl(url)) { showNotification('URL must be https:// (or http://localhost for dev)', 'error'); return; }

  const key = (keyRaw === '••••••••') ? getLensKey() : keyRaw.trim();
  if (!key) { showNotification('Please enter an API key', 'error'); return; }

  saveLensConfig({ name, url, enabled, topK });
  if (keyRaw !== '••••••••') await saveLensKey(key);

  const result = await testLensConnection();
  _rerenderLensSection();
  if (result.ok) {
    showNotification(`Connected — ${result.chunkCount} chunk${result.chunkCount !== 1 ? 's' : ''} returned`, 'success');
  } else {
    showNotification(`Lens test failed: ${result.error}`, 'error');
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
  showConfirmDialog('Remove Custom Knowledge Source? Your endpoint URL and API key will be deleted.', async () => {
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
});
