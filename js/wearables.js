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
import { beginConnectOAuth, backfillWearable, disconnectWearable, syncNow, listConnectedSources, getConnection } from './wearables-connect.js';
import { syncWearableSummary } from './wearables-summary.js';
import { getActiveProfileId } from './profile.js';
import { getDailyRange } from './wearables-store.js';
import { getChartColors } from './theme.js';

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
// Returns 'delta-flat' for zero/missing baseline so we don't paint NaN% red/green.
function deltaClassFor(latest, baseline, worseWhen) {
  if (!baseline || !isFinite(baseline)) return 'delta-flat';
  const pct = ((latest - baseline) / baseline) * 100;
  if (Math.abs(pct) < 3) return 'delta-flat';
  const isDown = pct < 0;
  const worse = (isDown && worseWhen === 'down') || (!isDown && worseWhen === 'up');
  if (worseWhen === 'either') return 'delta-flat';
  return worse ? 'delta-bad' : 'delta-good';
}

function formatDelta(latest, baseline) {
  // Zero baseline happens when the metric is 0 across the window (e.g. activity
  // score on a ring that wasn't worn); render a dash instead of NaN%.
  if (!baseline || !isFinite(baseline)) return '→ —';
  const pct = ((latest - baseline) / baseline) * 100;
  const arrow = pct > 0.5 ? '↑' : pct < -0.5 ? '↓' : '→';
  return `${arrow} ${Math.abs(pct).toFixed(0)}%`;
}

// Single formatter used by both the strip card AND the detail modal so a
// number renders identically in both places. Rules:
//   null / non-finite  → "—"
//   integer unit       → Math.round (ms, bpm, %, min, '' score, steps count)
//   integer value      → Math.round (even for /5, yrs, °C, mg/dL — avoids "3.0")
//   else               → toFixed(1)
function formatValue(latest, unit) {
  if (latest == null || !isFinite(latest)) return '—';
  const intUnits = ['ms', 'bpm', '%', 'min', ''];
  if (intUnits.includes(unit) || Number.isInteger(latest)) return String(Math.round(latest));
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
  const deltaPct = (baseline && isFinite(baseline)) ? Math.abs((last - baseline) / baseline) : 0;
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
  // Space-prefix the sub so screen readers hear "HRV RMSSD" not "HRVRMSSD".
  // Visual spacing is still margin-left via .wearable-metric-sub CSS.
  const subLabel = canon.sub ? ` <span class="wearable-metric-sub">${escapeHTML(canon.sub)}</span>` : '';
  const unitLabel = canon.unit ? `<span class="wearable-unit">${escapeHTML(canon.unit)}</span>` : '';
  const baselineUnit = canon.unit ? ' ' + escapeHTML(canon.unit) : '';
  const trendCls = trendClassFor(metric.trend30d, canon.worseWhen);
  const adapter = adapterById(metric.primarySource);
  // Source badge is interactive when >1 wearable is connected — click it to
  // open a small picker that overrides the primary source for this metric.
  // Without the override, the summary picker auto-picks by most-recent
  // non-null value, which can feel arbitrary when two sources report similar
  // freshness. The override is per-metric, persisted in importedData.
  const sourceBadge = (showSourceBadge && adapter)
    ? `<button type="button" class="wearable-source-badge wearable-source-badge-btn" onclick="event.stopPropagation();chooseWearableSource('${escapeHTML(metricId)}',event)" title="Click to switch source for this metric">via ${escapeHTML(adapter.displayName)}</button>` : '';
  // Build a meaningful aria-label: value + unit + trend direction + metric
  // name so screen readers can read the card at a glance without entering it.
  const valueRead = formatValue(metric.latest, canon.unit);
  const trendRead = trendLabel(metric.trend30d);
  const canonRead = canon.sub ? `${canon.label} ${canon.sub}` : canon.label;
  const deltaRead = deltaText.replace('↑', 'up').replace('↓', 'down').replace('→', 'flat at');
  const ariaLabel = `${canonRead} ${valueRead}${canon.unit ? ' ' + canon.unit : ''}, ${deltaRead} vs baseline, ${trendRead} — open detail`;
  return `<div class="wearable-card" onclick="openWearableDetail('${escapeHTML(metricId)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openWearableDetail('${escapeHTML(metricId)}')}" role="button" tabindex="0" aria-label="${escapeHTML(ariaLabel)}">
    <div class="wearable-card-top">
      <span class="wearable-metric-name">${escapeHTML(canon.label)}${subLabel}</span>
      <span class="wearable-delta ${deltaCls}">${deltaText}</span>
    </div>
    <div class="wearable-value-row">
      <span class="wearable-value">${valueRead}</span>${unitLabel}
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

  // Footer caveat is source-aware: only show the Oura HRV note if Oura is
  // actually the primary source driving the HRV card. Otherwise it looks like
  // a generic disclaimer that doesn't apply to the user's current wearable.
  const hrvPrimary = summary.metrics?.hrv_rmssd?.primarySource;
  const footerNote = hrvPrimary === 'oura'
    ? 'Deep HRV (SDNN · pNN50 · HF/LF) needs an ECG chest strap — Oura provides RMSSD only.'
    : '';

  let html = `<section class="wearable-strip" id="wearable-strip">
    <div class="wearable-strip-header" role="button" tabindex="0" aria-expanded="${!collapsed}" onclick="toggleWearableStrip()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleWearableStrip()}">
      <div class="wearable-strip-title">
        <span class="wearable-strip-icon" aria-hidden="true">⌬</span>
        <span>Wearables: <span class="wearable-source-label">${escapeHTML(sourceLabel)}${coverageLabel}</span></span>
        ${isMock ? '<span class="wearable-strip-demo-pill">demo data</span>' : ''}
      </div>
      <div class="wearable-strip-meta">
        <span>last synced ${formatAgo(lastSyncAt)}</span>
        <button type="button" class="wearable-strip-sync" onclick="event.stopPropagation();syncWearableNow();return false">Sync now</button>
        <span class="wearable-collapse-arrow${collapsed ? ' collapsed' : ''}" aria-hidden="true">▾</span>
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

  html += `</div>`;
  if (footerNote) {
    html += `<div class="wearable-strip-footer${collapsed ? ' hidden' : ''}">
      <span class="wearable-strip-footer-note">${escapeHTML(footerNote)}</span>
    </div>`;
  }
  html += `</section>`;
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

// ─────────────────────────────────────────────────────────
// DETAIL MODAL — 90d daily chart + stats for a single metric
// ─────────────────────────────────────────────────────────

// Monotonic op token — fast successive clicks on different cards shouldn't
// land mismatched data in the modal. Each call grabs a new token; any work
// that resolves with a stale token aborts before touching the DOM.
let _detailOp = 0;

async function openWearableDetail(metricId) {
  const op = ++_detailOp;
  const canon = canonicalMetric(metricId);
  const summary = state.importedData?.wearableSummary;
  const m = summary?.metrics?.[metricId];
  if (!canon || !m) {
    showNotification?.('No data for this metric yet — run a sync first', 'info');
    return;
  }

  // Pull last 90 days from L1 for whichever source is primary for this metric.
  // Series may have gaps (ring not worn, feature off) — we plot what's there
  // and label missing days via Chart.js spanGaps rather than forward-filling.
  const profileId = getActiveProfileId();
  const endDate = new Date().toISOString().slice(0, 10);
  const start = new Date(); start.setUTCDate(start.getUTCDate() - 90);
  const startDate = start.toISOString().slice(0, 10);
  let rows = [];
  try { rows = await getDailyRange(profileId, m.primarySource, startDate, endDate); }
  catch (e) { showNotification?.(`Couldn't read local history: ${e.message}`, 'error', 4000); return; }
  if (op !== _detailOp) return;  // superseded by a later click — bail

  const series = rows
    .map(r => ({ date: r.date, v: r[metricId] }))
    .filter(p => typeof p.v === 'number' && isFinite(p.v))
    .sort((a, b) => a.date.localeCompare(b.date));

  const modal = document.getElementById('detail-modal');
  const overlay = document.getElementById('modal-overlay');
  if (!modal || !overlay) return;

  // Destroy any previous chart on the shared modal canvas before swapping html.
  if (state.chartInstances['modal']) {
    state.chartInstances['modal'].destroy();
    delete state.chartInstances['modal'];
  }

  modal.innerHTML = buildWearableDetailHtml(canon, m, series, metricId);
  overlay.classList.add('show');
  // Move focus to the close button so keyboard users land inside the modal.
  modal.querySelector('.modal-close')?.focus?.();

  const canvas = document.getElementById('chart-modal');
  if (canvas && typeof window.Chart !== 'undefined' && series.length > 0) {
    renderWearableChart(canvas, canon, m, series);
  }
}

function buildWearableDetailHtml(canon, m, series, metricId) {
  const adapter = adapterById(m.primarySource);
  const sourceName = adapter?.displayName || m.primarySource;
  const unit = canon.unit || '';
  const unitSpaced = unit ? ' ' + escapeHTML(unit) : '';
  const subLabel = canon.sub ? ` <span style="opacity:0.6;font-size:0.7em;margin-left:6px;font-weight:normal">${escapeHTML(canon.sub)}</span>` : '';
  const formatV = v => formatValue(v, unit);

  // Trend copy mirrors the strip card so users get consistent language.
  const trendWord = m.trend30d === 'declining' ? 'declining'
                   : m.trend30d === 'rising' ? 'rising'
                   : m.trend30d === 'improving' ? 'improving'
                   : 'flat';

  const deltaPct = m.baseline && isFinite(m.baseline) ? ((m.latest - m.baseline) / m.baseline * 100) : null;
  const deltaStr = deltaPct == null ? '—'
                 : (deltaPct > 0.5 ? '↑' : deltaPct < -0.5 ? '↓' : '→') + ' ' + Math.abs(deltaPct).toFixed(0) + '%';

  const statsCells = [
    ['Latest',   `${formatV(m.latest)}${unitSpaced}`, m.latestDate || ''],
    ['Baseline (90d)', `${formatV(m.baseline)}${unitSpaced}`, 'median'],
    ['7-day avg', `${formatV(m.rolling?.d7)}${unitSpaced}`, ''],
    ['30-day avg', `${formatV(m.rolling?.d30)}${unitSpaced}`, ''],
    ['P25 – P75', `${formatV(m.baselineP25)} – ${formatV(m.baselineP75)}${unitSpaced}`, 'interquartile'],
    ['Coverage', `${series.length}d`, `of last 90 days`],
  ].map(([label, val, sub]) => `
    <div class="wearable-detail-stat">
      <div class="wearable-detail-stat-label">${escapeHTML(label)}</div>
      <div class="wearable-detail-stat-val">${val}</div>
      ${sub ? `<div class="wearable-detail-stat-sub">${escapeHTML(sub)}</div>` : ''}
    </div>`).join('');

  const emptyHint = series.length === 0
    ? `<div class="wearable-detail-empty">No daily samples for this metric in the last 90 days. Either the source adapter lacks the scope, the feature is off on the device, or the ring wasn't worn. Try Sync now or reconnect with full scopes.</div>`
    : (metricId === 'activity_score' && series.every(p => p.v === 0))
      ? `<div class="wearable-detail-empty">Every day shows 0 — Oura suppresses the Activity composite score while Rest Mode is on. Check the <b>Steps</b> card for raw movement data, or disable Rest Mode in the Oura app.</div>`
      : '';

  return `<button class="modal-close" onclick="closeModal()">&times;</button>
    <h3>${escapeHTML(canon.label)}${subLabel}</h3>
    <div class="modal-unit">
      ${escapeHTML(sourceName)} · ${deltaStr} vs baseline · ${escapeHTML(trendWord)} 30d
    </div>
    <div class="modal-chart" style="height:260px"><canvas id="chart-modal"></canvas></div>
    ${emptyHint}
    <div class="wearable-detail-stats">${statsCells}</div>`;
}

function renderWearableChart(canvas, canon, m, series) {
  const tc = getChartColors();
  const labels = series.map(p => p.date);
  const values = series.map(p => p.v);
  const baselineValues = values.map(() => m.baseline);

  // Y-axis padding so baseline line and sparkline aren't clipped to the edge.
  const ymin = Math.min(...values, m.baseline);
  const ymax = Math.max(...values, m.baseline);
  const pad = Math.max((ymax - ymin) * 0.08, 0.5);

  const unit = canon.unit || '';
  const formatV = v => formatValue(v, unit);

  state.chartInstances['modal'] = new window.Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: canon.label,
          data: values,
          borderColor: tc.lineColor || '#60a5fa',
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          spanGaps: true,
        },
        {
          label: 'Baseline',
          data: baselineValues,
          borderColor: tc.gridColor || '#9ca3af',
          backgroundColor: 'transparent',
          borderWidth: 1,
          borderDash: [4, 4],
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: tc.tooltipBg, titleColor: tc.tooltipTitle,
          bodyColor: tc.tooltipBody, borderColor: tc.tooltipBorder, borderWidth: 1,
          callbacks: { label: (c) => `${c.dataset.label}: ${formatV(c.parsed.y)}${unit ? ' ' + unit : ''}` },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: { tooltipFormat: 'MMM d, yyyy', displayFormats: { day: 'MMM d', month: 'MMM yyyy' } },
          ticks: { source: 'auto', color: tc.tickColor, font: { size: 10 }, maxTicksLimit: 8 },
          grid: { display: false },
        },
        y: {
          min: ymin - pad, max: ymax + pad,
          ticks: { color: tc.tickColor, font: { size: 10 } },
          grid: { color: tc.gridColor },
        },
      },
    },
  });
}

// Per-metric primary-source override picker. Reads connected sources that
// actually have data for this metric and lets the user pick one. The summary
// pipeline respects `state.importedData.wearablePrimaryOverride[metricId]`.
async function chooseWearableSource(metricId, event) {
  const canon = canonicalMetric(metricId);
  if (!canon) return;
  const connected = listConnectedSources();
  const connectedIds = Object.keys(connected);
  if (connectedIds.length < 2) return;

  // Find sources that map this canonical metric in their adapter registry —
  // no point offering WHOOP as a source for `weight` (it doesn't do scales).
  const eligible = connectedIds.filter(sid => {
    const a = adapterById(sid);
    return !!a?.metrics?.[metricId];
  });
  if (eligible.length < 2) {
    showNotification?.(`Only one connected wearable provides ${canon.label}`, 'info', 2500);
    return;
  }

  // Close any existing picker, then build + position a new one near the click.
  document.querySelectorAll('.wearable-source-picker').forEach(el => el.remove());
  const current = state.importedData?.wearablePrimaryOverride?.[metricId]
    || state.importedData?.wearableSummary?.metrics?.[metricId]?.primarySource
    || eligible[0];
  const picker = document.createElement('div');
  picker.className = 'wearable-source-picker';
  picker.innerHTML = `
    <div class="wearable-source-picker-head">${escapeHTML(canon.label)} source</div>
    ${eligible.map(sid => {
      const a = adapterById(sid);
      const selected = sid === current;
      return `<button type="button" class="wearable-source-picker-item${selected ? ' selected' : ''}" data-source="${escapeHTML(sid)}">
        <span>${escapeHTML(a?.displayName || sid)}</span>
        ${selected ? '<span class="wearable-source-picker-check">✓</span>' : ''}
      </button>`;
    }).join('')}
    <button type="button" class="wearable-source-picker-item wearable-source-picker-auto" data-source="">
      <span>Auto (most recent)</span>
      ${!state.importedData?.wearablePrimaryOverride?.[metricId] ? '<span class="wearable-source-picker-check">✓</span>' : ''}
    </button>
  `;
  const rect = event.target.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.top = `${rect.bottom + 4}px`;
  picker.style.left = `${Math.max(8, rect.left - 60)}px`;
  picker.style.zIndex = '10000';
  document.body.appendChild(picker);

  // Wire clicks — pick a source, persist override, re-render strip.
  picker.querySelectorAll('[data-source]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = btn.dataset.source;
      if (!state.importedData.wearablePrimaryOverride) state.importedData.wearablePrimaryOverride = {};
      if (!sid) delete state.importedData.wearablePrimaryOverride[metricId];
      else state.importedData.wearablePrimaryOverride[metricId] = sid;
      const { saveImportedData } = await import('./data.js');
      await saveImportedData();
      await syncWearableSummary(getActiveProfileId(), listConnectedSources());
      picker.remove();
      if (window.navigate) window.navigate('dashboard');
    });
  });

  // Dismiss on outside click / Escape.
  setTimeout(() => {
    const dismiss = (e) => {
      if (picker.contains(e.target)) return;
      picker.remove();
      document.removeEventListener('click', dismiss);
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') { picker.remove(); document.removeEventListener('keydown', onKey); document.removeEventListener('click', dismiss); } };
    document.addEventListener('click', dismiss);
    document.addEventListener('keydown', onKey);
  }, 0);
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
  const betaBadge = adapter.beta
    ? `<span class="wearable-adapter-chip wearable-adapter-chip-beta" title="Beta — shape may change; please report issues">BETA</span>`
    : '';

  const authBlock = renderAuthBlock(adapter, conn);

  return `<div class="wearable-adapter-card" data-adapter="${escapeHTML(adapter.id)}">
    <div class="wearable-adapter-header">
      <div class="wearable-adapter-name">${escapeHTML(adapter.displayName)} ${betaBadge}</div>
      ${statusChip}
    </div>
    ${authBlock}
  </div>`;
}

function renderAuthBlock(adapter, conn) {
  if (adapter.authType === 'oauth2') {
    // If an OAuth adapter hasn't been given a real client_id yet, surface the
    // scaffold block so testers see "not wired" instead of a broken authorize
    // URL. The first real beta tester only lands once the maintainer pastes
    // the ID + sets the provider's env var on Vercel.
    if (adapter.oauth?.clientId?.startsWith('REPLACE_WITH_')) {
      return renderComingSoonBlock(adapter, `${adapter.displayName} support is in progress — we’re waiting on partner credentials. Check back soon or watch the changelog.`);
    }
    return renderOAuthBlock(adapter, conn);
  }
  if (adapter.authType === 'file-import') {
    if (adapter.id === 'apple_health') return renderAppleHealthBlock(adapter, conn);
    return `<p class="wearable-adapter-note">File import — ships in a follow-up.</p>`;
  }
  return '';
}

function renderComingSoonBlock(adapter, msg) {
  const docs = adapter.authDocsUrl ? `<a href="${escapeHTML(adapter.authDocsUrl)}" target="_blank" rel="noopener">Provider docs</a>` : '';
  return `<div class="wearable-adapter-body">
    <p class="wearable-adapter-hint">${escapeHTML(msg)}</p>
    ${docs ? `<p class="wearable-adapter-hint" style="font-size:11px;opacity:0.8">${docs}</p>` : ''}
  </div>`;
}

function renderAppleHealthBlock(adapter, conn) {
  if (conn?.lastSyncAt) {
    const when = new Date(conn.lastSyncAt).toLocaleString();
    const fileName = conn.fileName ? escapeHTML(conn.fileName) : 'export';
    return `<div class="wearable-adapter-body">
      <div class="wearable-adapter-identity">Imported from ${fileName}</div>
      <div class="wearable-adapter-meta">Last import: ${escapeHTML(when)} · ${conn.coverageDays ?? '?'} days</div>
      <div class="wearable-adapter-actions">
        <button class="ctx-btn-option" onclick="document.getElementById('apple-health-file-input').click()">Re-import new export</button>
        <button class="ctx-btn-option ctx-btn-danger" onclick="handleWearableDisconnect('${escapeHTML(adapter.id)}')">Remove data</button>
      </div>
      <input type="file" id="apple-health-file-input" accept=".zip,.xml,application/zip,application/xml" style="display:none" onchange="handleAppleHealthFilePick(this)">
    </div>`;
  }
  return `<div class="wearable-adapter-body">
    <p class="wearable-adapter-hint">getbased doesn't connect to an Apple Health API — none exists. A daily auto-sync would require either a native iOS companion app (not built yet) or routing your data through a third-party aggregator (we don't). Instead, export occasionally from your iPhone and drop the zip here. No credentials, no server contact, no tracking — your Health data never leaves your control.</p>
    <p class="wearable-adapter-hint" style="font-size:11px;opacity:0.85">iPhone → Health app → tap your profile photo (top right) → <b>Export All Health Data</b> → AirDrop / email the <code>export.zip</code> to your computer → drop it below (or the <code>export.xml</code> inside). Parsing runs entirely in your browser.</p>
    <div class="apple-health-dropzone"
         ondragover="event.preventDefault();this.classList.add('drag-over')"
         ondragleave="this.classList.remove('drag-over')"
         ondrop="event.preventDefault();this.classList.remove('drag-over');handleAppleHealthDrop(event)"
         onclick="document.getElementById('apple-health-file-input').click()">
      <div class="apple-health-dropzone-icon">📂</div>
      <div class="apple-health-dropzone-text">Drop <code>export.zip</code> or <code>export.xml</code> here — or click to pick a file</div>
    </div>
    <div id="apple-health-progress" class="apple-health-progress" style="display:none">
      <div class="apple-health-progress-bar"><div class="apple-health-progress-fill"></div></div>
      <div class="apple-health-progress-text"></div>
    </div>
    <input type="file" id="apple-health-file-input" accept=".zip,.xml,application/zip,application/xml" style="display:none" onchange="handleAppleHealthFilePick(this)">
  </div>`;
}

// renderPATBlock removed in v1.23.3 — Ultrahuman moved from legacy static-token
// PAT to their OAuth2 partner API. All adapters now go through renderOAuthBlock.

function renderOAuthBlock(adapter, conn) {
  if (!conn || conn.needsReauth) {
    const reauthNote = conn?.needsReauth
      ? `<p class="wearable-adapter-hint" style="color:var(--red)">Your ${escapeHTML(adapter.displayName)} token was revoked or expired beyond refresh. Reconnect to resume data pulls.</p>`
      : `<p class="wearable-adapter-hint">Clicking <strong>Connect</strong> sends you to ${escapeHTML(adapter.displayName)} to authorise getbased — you'll be redirected back automatically.</p>`;
    return `<div class="wearable-adapter-body">
      ${reauthNote}
      <div class="wearable-adapter-actions">
        <button class="ctx-btn-option ctx-btn-primary" onclick="handleWearableConnect('${escapeHTML(adapter.id)}')">${conn?.needsReauth ? 'Reconnect' : 'Connect'} ${escapeHTML(adapter.displayName)}</button>
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
      <button class="ctx-btn-option" onclick="handleWearableBackfill('${escapeHTML(adapter.id)}')">Re-sync last 90 days</button>
      <button class="ctx-btn-option ctx-btn-danger" onclick="handleWearableDisconnect('${escapeHTML(adapter.id)}')">Disconnect</button>
    </div>
  </div>`;
}

function handleWearableConnect(adapterId) {
  try {
    beginConnectOAuth(adapterId);
    // beginOAuth navigates away — nothing else to do here.
  } catch (e) {
    showNotification?.(`Connect failed: ${e.message}`, 'error', 5000);
  }
}

function handleAppleHealthDrop(e) {
  const file = e.dataTransfer?.files?.[0];
  if (file) importAppleHealthFlow(file);
}

function handleAppleHealthFilePick(input) {
  const file = input.files?.[0];
  if (file) importAppleHealthFlow(file);
  input.value = ''; // so picking the same file twice re-triggers
}

async function importAppleHealthFlow(file) {
  const { importAppleHealthFile } = await import('./wearables-apple-health.js');
  const bar = document.querySelector('.apple-health-progress-fill');
  const wrap = document.getElementById('apple-health-progress');
  const text = document.querySelector('.apple-health-progress-text');
  if (wrap) wrap.style.display = 'block';
  try {
    const res = await importAppleHealthFile(file, ({ stage, pct, rows, startDate, endDate }) => {
      if (bar) bar.style.width = (pct ?? 0) + '%';
      if (text) text.textContent = stage === 'done'
        ? `${rows} days imported (${startDate} – ${endDate})`
        : `${stage}… ${pct ?? 0}%`;
    });
    showNotification?.(`Apple Health imported — ${res.rows} days`, 'success', 3000);
    refreshSettingsWearables();
    if (window.navigate) window.navigate('dashboard');
  } catch (e) {
    showNotification?.(`Apple Health import failed: ${e.message}`, 'error', 6000);
    if (text) text.textContent = `Failed: ${e.message}`;
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
  chooseWearableSource,
  hasWearableSummary,
  renderWearablesSettingsSection,
  handleWearableConnect,
  handleWearableSyncNow,
  handleWearableBackfill,
  handleWearableDisconnect,
  handleAppleHealthDrop,
  handleAppleHealthFilePick,
});
