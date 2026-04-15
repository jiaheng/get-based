// lens.js — Custom Knowledge Source
// User-configured RAG endpoint that backs the Interpretive Lens with retrieved chunks.

import { state } from './state.js';
import { getCachedKey, updateKeyCache, encryptedSetItem } from './crypto.js';
import { hashString, showNotification, showConfirmDialog, isDebugMode, escapeHTML, escapeAttr } from './utils.js';

const CONFIG_KEY = 'labcharts-lens-config';
const SECRET_KEY = 'labcharts-lens-key';

const DEFAULT_CONFIG = { name: '', url: '', enabled: false, topK: 5 };
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
  return !!(cfg.enabled && cfg.url && getLensKey());
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
  // Use a domain-relevant probe — 'test query' is too generic to pass typical similarity floors.
  const result = await _doQuery(cfg.url, key, Math.max(cfg.topK, 3), cfg.name || 'Lens', 'vitamin D deficiency supplementation', {});
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
      ? `Knowledge source active${cfg.name ? ': ' + cfg.name : ''} · ${s.lastChunkCount || 0} passages`
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
      ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Last query: ${status.lastChunkCount} passage${status.lastChunkCount !== 1 ? 's' : ''}${status.sourceName ? ' from ' + escapeHTML(status.sourceName) : ''}</div>`
      : '';

  return `<div class="ai-provider-panel">
    <div class="ai-provider-desc">Connect a knowledge base to ground the AI's analysis in real sources — research papers, clinical guides, or any documents you choose. When enabled, the AI searches your knowledge base for relevant passages before interpreting your labs. <a href="/docs/guide/interpretive-lens#custom-knowledge-source-rag" target="_blank" rel="noopener" style="color:var(--accent)">Setup guide &rarr;</a></div>
    <div class="api-key-status" id="lens-status-chip">${statusChip}${lastInfo}</div>
    <div style="margin-top:8px;display:flex;align-items:center;gap:10px">
      <label class="toggle-switch" for="lens-enabled-toggle">
        <input type="checkbox" id="lens-enabled-toggle" ${cfg.enabled ? 'checked' : ''} onchange="handleToggleLens(this.checked)">
        <span class="toggle-slider"></span>
        <span style="font-size:13px;margin-left:8px">Enable Knowledge Source</span>
      </label>
    </div>
    <div style="margin-top:10px">
      <label style="font-size:12px;color:var(--text-muted)" for="lens-name-input">Display name</label>
      <input type="text" class="api-key-input" id="lens-name-input" value="${escapeAttr(cfg.name)}" placeholder="e.g. Functional Medicine Library" style="margin-top:4px">
    </div>
    <div style="margin-top:8px">
      <label style="font-size:12px;color:var(--text-muted)" for="lens-url-input">Endpoint URL</label>
      <input type="text" class="api-key-input" id="lens-url-input" value="${escapeAttr(cfg.url)}" placeholder="https://your-server.example.com/query" style="margin-top:4px">
    </div>
    <div style="margin-top:8px">
      <label style="font-size:12px;color:var(--text-muted)" for="lens-key-input">API key</label>
      <input type="password" class="api-key-input" id="lens-key-input" value="${escapeAttr(keySet ? '••••••••' : '')}" placeholder="Your access key" style="margin-top:4px">
    </div>
    <div style="margin-top:8px">
      <label style="font-size:12px;color:var(--text-muted)" for="lens-topk-input">Passages per query</label>
      <input type="number" class="api-key-input" id="lens-topk-input" value="${cfg.topK || 5}" min="1" max="10" style="margin-top:4px;width:100px">
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="import-btn import-btn-primary" onclick="handleSaveLensConfig()">Save &amp; Test</button>
      ${connected ? '<button class="import-btn import-btn-secondary" onclick="handleClearLensCache()">Clear cache</button>' : ''}
      ${connected ? '<button class="import-btn import-btn-secondary" onclick="handleRemoveLens()">Remove</button>' : ''}
    </div>
    <div class="api-key-notice" style="margin-top:12px">Your questions are sent directly to the server you configure. Only connect to servers you control or trust. Your key is encrypted at rest on this device.</div>
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
      ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Last query: ${status.lastChunkCount} passage${status.lastChunkCount !== 1 ? 's' : ''}${status.sourceName ? ' from ' + escapeHTML(status.sourceName) : ''}</div>`
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
  if (!isValidLensUrl(url)) { showNotification('URL must be https:// (or http:// to localhost / LAN / .local)', 'error'); return; }

  const key = (keyRaw === '••••••••') ? getLensKey() : keyRaw.trim();
  if (!key) { showNotification('Please enter an API key', 'error'); return; }

  saveLensConfig({ name, url, enabled, topK });
  if (keyRaw !== '••••••••') await saveLensKey(key);

  const result = await testLensConnection();
  _rerenderLensSection();
  if (result.ok) {
    showNotification(`Connected — ${result.chunkCount} passage${result.chunkCount !== 1 ? 's' : ''} returned`, 'success');
  } else {
    showNotification(`Connection failed: ${result.error}`, 'error');
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
});
