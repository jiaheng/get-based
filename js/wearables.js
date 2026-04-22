// wearables.js — Dashboard wearable strip
// Source-agnostic: reads `wearableSummary` (the L2 shape that ships to Evolu)
// and walks CANONICAL_METRICS via the registry in wearable-adapters.js.
// Adding a new vendor means registering an adapter — this file doesn't change.
//
// L2 `wearableSummary` shape (consumed here, produced by the future sync pipeline):
//   sources:  { [adapterId]: { connectedSince, lastSyncAt, coverageDays } }
//   metrics:  { [canonicalId]: {
//                  primarySource,           // which adapter id this metric was read from
//                  latest, latestDate,      // most recent daily value (for the big number)
//                  baseline,                // 90d median
//                  baselineP25, baselineP75,
//                  rolling: { d7, d30, d90 },
//                  trend30d,                // 'declining' | 'rising' | 'improving' | 'flat'
//                  weekly: number[]         // up to 12 weekly means (oldest → newest)
//                } }

import { escapeHTML, showNotification, showConfirmDialog } from './utils.js';
import { state } from './state.js';
import { ADAPTERS, adapterById, canonicalMetric, metricsForSources } from './wearable-adapters.js';
import { connectWearable, backfillWearable, disconnectWearable, syncNow, listConnectedSources, getConnection } from './wearables-connect.js';
import { syncWearableSummary } from './wearables-summary.js';
import { getActiveProfileId } from './profile.js';

// ─────────────────────────────────────────────────────────
// MOCK SUMMARY — remove once the real L2 pipeline ships
// ─────────────────────────────────────────────────────────
// Stays in CANONICAL shape so the renderer exercises the real code paths.
// Numbers tell a mild-overtraining / early-infection story so the UI reads
// as visibly non-trivial.
const MOCK_SUMMARY = {
  sources: {
    oura: {
      connectedSince: '2026-01-22',
      lastSyncAt: Date.now() - 2 * 60 * 60 * 1000,
      coverageDays: 90,
    },
  },
  metrics: {
    hrv_rmssd: {
      primarySource: 'oura',
      latest: 38, latestDate: '2026-04-22',
      baseline: 52, baselineP25: 41, baselineP75: 63,
      rolling: { d7: 38, d30: 46, d90: 52 },
      trend30d: 'declining',
      weekly: [50, 52, 51, 53, 52, 54, 51, 49, 47, 45, 42, 38],
    },
    rhr: {
      primarySource: 'oura',
      latest: 61, latestDate: '2026-04-22',
      baseline: 58, baselineP25: 55, baselineP75: 61,
      rolling: { d7: 61, d30: 59, d90: 58 },
      trend30d: 'rising',
      weekly: [58, 58, 57, 58, 59, 58, 59, 60, 60, 60, 61, 61],
    },
    sleep_score: {
      primarySource: 'oura',
      latest: 79, latestDate: '2026-04-22',
      baseline: 82, baselineP25: 76, baselineP75: 87,
      rolling: { d7: 79, d30: 81, d90: 82 },
      trend30d: 'flat',
      weekly: [85, 84, 83, 86, 85, 84, 82, 80, 79, 78, 79, 78],
    },
    readiness_score: {
      primarySource: 'oura',
      latest: 78, latestDate: '2026-04-22',
      baseline: 82, baselineP25: 77, baselineP75: 88,
      rolling: { d7: 78, d30: 81, d90: 82 },
      trend30d: 'declining',
      weekly: [82, 83, 82, 84, 83, 82, 81, 79, 78, 77, 78, 78],
    },
  },
};

// ─────────────────────────────────────────────────────────
// L2 ACCESS — single source of truth for summary lookup
// ─────────────────────────────────────────────────────────
// Priority: real L2 in importedData → mock (if demo profile + mock not disabled).
// Real data takes over as soon as the user connects any adapter.

export function hasWearableSummary() {
  return getWearableSummary() != null;
}

function isMockAllowed() {
  if (localStorage.getItem('wearables-mock-off') === '1') return false;
  // Show mock only when no real connection exists — keeps the dashboard lively
  // during onboarding / demo flows without shadowing real data.
  const real = state.importedData?.wearableSummary;
  if (real && real.sources && Object.keys(real.sources).length > 0) return false;
  return true;
}

function getWearableSummary() {
  const real = state.importedData?.wearableSummary;
  if (real && real.sources && Object.keys(real.sources).length > 0) return real;
  if (isMockAllowed()) return MOCK_SUMMARY;
  return null;
}

// ─────────────────────────────────────────────────────────
// FORMATTERS
// ─────────────────────────────────────────────────────────

function formatAgo(ts) {
  if (!ts) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

// Semantic delta colour: worse-direction → red, better-direction → green, ~flat → neutral.
function deltaClassFor(latest, baseline, worseWhen) {
  const pct = ((latest - baseline) / baseline) * 100;
  if (Math.abs(pct) < 3) return 'delta-flat';
  const isDown = pct < 0;
  const worse = (isDown && worseWhen === 'down') || (!isDown && worseWhen === 'up');
  if (worseWhen === 'either') return 'delta-flat';
  return worse ? 'delta-bad' : 'delta-good';
}

function formatDelta(latest, baseline) {
  const pct = ((latest - baseline) / baseline) * 100;
  const arrow = pct > 0.5 ? '↑' : pct < -0.5 ? '↓' : '→';
  return `${arrow} ${Math.abs(pct).toFixed(0)}%`;
}

function formatValue(latest, unit) {
  if (unit === 'ms' || unit === 'bpm' || unit === '%' || unit === '') return String(Math.round(latest));
  return latest.toFixed(1);
}

function trendLabel(t) {
  if (t === 'declining') return 'declining 30d';
  if (t === 'rising')    return 'rising 30d';
  if (t === 'improving') return 'improving 30d';
  return 'flat 30d';
}

function trendClassFor(trend, worseWhen) {
  // 'declining' and 'rising' are directional — paint them the semantic colour
  // based on which direction is worse for THIS metric.
  if (trend === 'improving') return 'wearable-trend-improving';
  if (trend === 'flat')      return 'wearable-trend-flat';
  const isBad = (trend === 'declining' && worseWhen === 'down') || (trend === 'rising' && worseWhen === 'up');
  return isBad ? 'wearable-trend-bad' : 'wearable-trend-good';
}

// ─────────────────────────────────────────────────────────
// SPARKLINE
// ─────────────────────────────────────────────────────────

function sparklineSVG(series, baseline, worseWhen) {
  if (!series || series.length === 0) return '';
  const VW = 100, VH = 30, pad = 2;
  const all = series.concat([baseline]);
  const min = Math.min(...all), max = Math.max(...all);
  const range = Math.max(max - min, 1e-6);
  const xStep = (VW - pad * 2) / Math.max(series.length - 1, 1);
  const yFor = v => VH - pad - ((v - min) / range) * (VH - pad * 2);
  const pts = series.map((v, i) => `${(pad + i * xStep).toFixed(1)},${yFor(v).toFixed(1)}`).join(' ');
  const lastX = (pad + (series.length - 1) * xStep).toFixed(1);
  const lastY = yFor(series[series.length - 1]).toFixed(1);
  const baselineY = yFor(baseline).toFixed(1);
  const last = series[series.length - 1];
  const deltaPct = Math.abs((last - baseline) / baseline);
  let toneClass = 'spark-neutral';
  if (deltaPct >= 0.03 && worseWhen !== 'either') {
    const endsBelow = last < baseline;
    const bad = (endsBelow && worseWhen === 'down') || (!endsBelow && worseWhen === 'up');
    toneClass = bad ? 'spark-bad' : 'spark-good';
  }
  return `<svg class="wearable-sparkline ${toneClass}" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" y1="${baselineY}" x2="${VW}" y2="${baselineY}" class="spark-baseline"/>
    <polyline points="${pts}" class="spark-line"/>
    <circle cx="${lastX}" cy="${lastY}" r="2" class="spark-last"/>
  </svg>`;
}

// ─────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────

function renderCard(metricId, canon, metric, showSourceBadge) {
  const deltaCls = deltaClassFor(metric.latest, metric.baseline, canon.worseWhen);
  const deltaText = formatDelta(metric.latest, metric.baseline);
  const subLabel = canon.sub ? `<span class="wearable-metric-sub">${escapeHTML(canon.sub)}</span>` : '';
  const unitLabel = canon.unit ? `<span class="wearable-unit">${escapeHTML(canon.unit)}</span>` : '';
  const baselineUnit = canon.unit ? ' ' + escapeHTML(canon.unit) : '';
  const trendCls = trendClassFor(metric.trend30d, canon.worseWhen);
  const adapter = adapterById(metric.primarySource);
  const sourceBadge = (showSourceBadge && adapter)
    ? `<span class="wearable-source-badge">via ${escapeHTML(adapter.displayName)}</span>` : '';
  return `<div class="wearable-card" onclick="openWearableDetail('${escapeHTML(metricId)}')" role="button" tabindex="0">
    <div class="wearable-card-top">
      <span class="wearable-metric-name">${escapeHTML(canon.label)}${subLabel}</span>
      <span class="wearable-delta ${deltaCls}">${deltaText}</span>
    </div>
    <div class="wearable-value-row">
      <span class="wearable-value">${formatValue(metric.latest, canon.unit)}</span>${unitLabel}
      <span class="wearable-baseline">baseline ${escapeHTML(String(metric.baseline))}${baselineUnit}</span>
    </div>
    ${sparklineSVG(metric.weekly, metric.baseline, canon.worseWhen)}
    <div class="wearable-card-bottom">
      <div class="wearable-trend-pill ${trendCls}">${trendLabel(metric.trend30d)}</div>
      ${sourceBadge}
    </div>
  </div>`;
}

export function renderWearableStrip() {
  const summary = getWearableSummary();
  if (!summary) return '';
  const sourceIds = Object.keys(summary.sources || {});
  if (sourceIds.length === 0) return '';
  if (!summary.metrics || Object.keys(summary.metrics).length === 0) return '';

  const collapsed = localStorage.getItem('wearables-strip-collapsed') === '1';
  const metricOrder = metricsForSources(sourceIds);
  const showSourceBadges = sourceIds.length > 1;

  // Header meta: most recent sync across connected sources + a short coverage label.
  const lastSyncAt = Math.max(0, ...sourceIds.map(s => summary.sources[s].lastSyncAt || 0));
  const coverageDays = Math.max(0, ...sourceIds.map(s => summary.sources[s].coverageDays || 0));
  const sourceLabel = sourceIds.map(id => adapterById(id)?.displayName || id).join(' + ');
  const coverageLabel = coverageDays > 0 ? ` · ${coverageDays}d` : '';

  const isMock = localStorage.getItem('wearables-mock-off') !== '1' &&
    /* mock flag: summary === MOCK_SUMMARY — avoid import cycle by comparing a sentinel */
    summary === MOCK_SUMMARY;

  let html = `<section class="wearable-strip" id="wearable-strip">
    <div class="wearable-strip-header" onclick="toggleWearableStrip()">
      <div class="wearable-strip-title">
        <span class="wearable-strip-icon">⌬</span>
        <span>Wearable <span class="wearable-source-label">${escapeHTML(sourceLabel)}${coverageLabel}</span></span>
        ${isMock ? '<span class="wearable-strip-demo-pill">demo data</span>' : ''}
      </div>
      <div class="wearable-strip-meta">
        <span>last synced ${formatAgo(lastSyncAt)}</span>
        <a href="#" class="wearable-strip-sync" onclick="event.stopPropagation();syncWearableNow();return false">Sync now</a>
        <span class="wearable-collapse-arrow${collapsed ? ' collapsed' : ''}">▾</span>
      </div>
    </div>
    <div class="wearable-card-grid${collapsed ? ' hidden' : ''}">`;

  for (const metricId of metricOrder) {
    const metric = summary.metrics[metricId];
    if (!metric) continue;
    const canon = canonicalMetric(metricId);
    if (!canon) continue;
    html += renderCard(metricId, canon, metric, showSourceBadges);
  }

  html += `</div>
    <div class="wearable-strip-footer${collapsed ? ' hidden' : ''}">
      <span class="wearable-strip-footer-note">Deep HRV (SDNN · pNN50 · HF/LF) needs an ECG chest strap — Oura provides RMSSD only.</span>
    </div>
  </section>`;
  return html;
}

// ─────────────────────────────────────────────────────────
// INTERACTIONS
// ─────────────────────────────────────────────────────────

function toggleWearableStrip() {
  const grid = document.querySelector('.wearable-card-grid');
  const footer = document.querySelector('.wearable-strip-footer');
  const arrow = document.querySelector('.wearable-collapse-arrow');
  if (!grid) return;
  const hidden = grid.classList.toggle('hidden');
  footer?.classList.toggle('hidden', hidden);
  arrow?.classList.toggle('collapsed', hidden);
  localStorage.setItem('wearables-strip-collapsed', hidden ? '1' : '0');
}

function openWearableDetail(_metricId) {
  if (window.showNotification) window.showNotification('Detail view is scheduled for v1.1', 'info');
}

async function syncWearableNow() {
  const sources = Object.keys(listConnectedSources());
  if (sources.length === 0) {
    showNotification?.('Connect a wearable in Settings → Data first', 'info');
    return;
  }
  try {
    showNotification?.('Syncing wearables…', 'info', 1500);
    for (const sid of sources) await syncNow(sid);
    if (window.navigate) window.navigate('dashboard');
    showNotification?.('Wearables synced', 'success', 2000);
  } catch { /* per-source error already surfaced */ }
}

// ─────────────────────────────────────────────────────────
// SETTINGS PANEL  (rendered into the Data tab in settings.js)
// ─────────────────────────────────────────────────────────

export function renderWearablesSettingsSection() {
  const connected = listConnectedSources();
  const cards = ADAPTERS.map(a => renderAdapterCard(a, !!connected[a.id])).join('');
  return `<div class="settings-section-header">
    <span class="settings-section-title">Wearable Integrations</span>
    <span class="settings-section-hint">Data stays on this device; a compact summary + anomaly events sync to your other devices.</span>
  </div>
  <div class="wearables-adapter-grid">${cards}</div>`;
}

function renderAdapterCard(adapter, isConnected) {
  const conn = isConnected ? getConnection(adapter.id) : null;
  const statusChip = !isConnected
    ? `<span class="wearable-adapter-chip wearable-adapter-chip-off">not connected</span>`
    : conn?.needsReauth
      ? `<span class="wearable-adapter-chip wearable-adapter-chip-bad">needs reconnection</span>`
      : `<span class="wearable-adapter-chip wearable-adapter-chip-ok">connected</span>`;

  const authBlock = renderAuthBlock(adapter, conn);

  return `<div class="wearable-adapter-card" data-adapter="${escapeHTML(adapter.id)}">
    <div class="wearable-adapter-header">
      <div class="wearable-adapter-name">${escapeHTML(adapter.displayName)}</div>
      ${statusChip}
    </div>
    ${authBlock}
  </div>`;
}

function renderAuthBlock(adapter, conn) {
  if (adapter.authType === 'pat') return renderPATBlock(adapter, conn);
  if (adapter.authType === 'oauth') return `<p class="wearable-adapter-note">OAuth flow — ships in a follow-up.</p>`;
  if (adapter.authType === 'file-import') return `<p class="wearable-adapter-note">File import — ships in a follow-up.</p>`;
  return '';
}

function renderPATBlock(adapter, conn) {
  const docsLink = adapter.authDocsUrl
    ? `<a href="${escapeHTML(adapter.authDocsUrl)}" target="_blank" rel="noopener">Create a Personal Access Token ↗</a>`
    : '';

  if (!conn) {
    return `<div class="wearable-adapter-body">
      <p class="wearable-adapter-hint">${docsLink}</p>
      <input type="password" class="settings-input wearable-adapter-input"
        id="wearable-pat-${escapeHTML(adapter.id)}"
        placeholder="Paste your ${escapeHTML(adapter.displayName)} Personal Access Token" autocomplete="off"/>
      <div class="wearable-adapter-actions">
        <button class="ctx-btn-option ctx-btn-primary" onclick="handleWearableConnect('${escapeHTML(adapter.id)}')">Save &amp; test</button>
      </div>
    </div>`;
  }

  const acct = conn.account || {};
  const when = conn.lastSyncAt ? new Date(conn.lastSyncAt).toLocaleString() : 'never';
  const identity = acct.email ? escapeHTML(acct.email) : '(account verified)';
  return `<div class="wearable-adapter-body">
    <div class="wearable-adapter-identity">${identity}</div>
    <div class="wearable-adapter-meta">Last sync: ${escapeHTML(when)}</div>
    <div class="wearable-adapter-actions">
      <button class="ctx-btn-option" onclick="handleWearableSyncNow('${escapeHTML(adapter.id)}')">Sync now</button>
      <button class="ctx-btn-option" onclick="handleWearableBackfill('${escapeHTML(adapter.id)}')">Re-backfill 90d</button>
      <button class="ctx-btn-option ctx-btn-danger" onclick="handleWearableDisconnect('${escapeHTML(adapter.id)}')">Disconnect</button>
    </div>
  </div>`;
}

async function handleWearableConnect(adapterId) {
  const input = document.getElementById(`wearable-pat-${adapterId}`);
  const credential = input?.value?.trim();
  if (!credential) { showNotification?.('Paste a token first', 'info'); return; }
  try {
    showNotification?.(`Verifying ${adapterId}…`, 'info', 2000);
    await connectWearable(adapterId, credential);
    showNotification?.(`${adapterId} connected — backfilling 90 days…`, 'info', 3000);
    const bf = await backfillWearable(adapterId);
    await syncWearableSummary(getActiveProfileId(), listConnectedSources());
    showNotification?.(`${adapterId} backfilled ${bf.rows} days`, 'success');
    refreshSettingsWearables();
    if (window.navigate) window.navigate('dashboard');
  } catch (e) {
    showNotification?.(`Connect failed: ${e.message}`, 'error', 5000);
  }
}

async function handleWearableSyncNow(adapterId) {
  try {
    showNotification?.(`Syncing ${adapterId}…`, 'info', 1500);
    const res = await syncNow(adapterId);
    showNotification?.(`${adapterId} synced (${res.rows ?? 0} new)`, 'success', 2500);
    refreshSettingsWearables();
    if (window.navigate) window.navigate('dashboard');
  } catch { /* syncNow already notified */ }
}

async function handleWearableBackfill(adapterId) {
  try {
    showNotification?.(`Backfilling ${adapterId}…`, 'info', 2000);
    const bf = await backfillWearable(adapterId);
    await syncWearableSummary(getActiveProfileId(), listConnectedSources());
    showNotification?.(`${adapterId} backfilled ${bf.rows} days`, 'success');
    refreshSettingsWearables();
    if (window.navigate) window.navigate('dashboard');
  } catch (e) {
    showNotification?.(`Backfill failed: ${e.message}`, 'error', 4000);
  }
}

function handleWearableDisconnect(adapterId) {
  showConfirmDialog(`Disconnect ${adapterId} and delete its local data?`, async () => {
    await disconnectWearable(adapterId, { deleteData: true });
    showNotification?.(`${adapterId} disconnected`, 'success');
    refreshSettingsWearables();
    if (window.navigate) window.navigate('dashboard');
  });
}

function refreshSettingsWearables() {
  const section = document.getElementById('wearables-section');
  if (section) section.innerHTML = renderWearablesSettingsSection();
}

Object.assign(window, {
  renderWearableStrip,
  toggleWearableStrip,
  openWearableDetail,
  syncWearableNow,
  hasWearableSummary,
  renderWearablesSettingsSection,
  handleWearableConnect,
  handleWearableSyncNow,
  handleWearableBackfill,
  handleWearableDisconnect,
});
