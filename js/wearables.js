// wearables.js — Dashboard wearable strip (Oura / future sources)
// v1 UI mock: mock data + render. Storage + API wiring comes in a follow-up.
// Shape defined here is the L2 `wearableSummary` snapshot — see docs/contributor/wearables-architecture.md (planned).

import { escapeHTML } from './utils.js';

// ─────────────────────────────────────────────────────────
// MOCK DATA  — remove once L1/L2 pipelines ship
// ─────────────────────────────────────────────────────────
// Snapshot tells a "mild overtraining / early infection" story so the UI
// is visibly non-trivial: HRV & readiness sag, RHR creeps, sleep dips.
// Keep numbers self-consistent — they're read by buildWearableContext() stubs
// during development.
const MOCK_SUMMARY = {
  oura: {
    connectedSince: '2026-01-22',
    lastSyncAt: Date.now() - 2 * 60 * 60 * 1000,
    coverageDays: 90,
    metrics: {
      hrv_rmssd: {
        label: 'HRV', sub: 'RMSSD', unit: 'ms',
        today: 38, baseline: 52, baselineP25: 41, baselineP75: 63,
        rollingD7: 38, rollingD30: 46, rollingD90: 52,
        trend30d: 'declining', worseWhen: 'down',
        weekly: [50, 52, 51, 53, 52, 54, 51, 49, 47, 45, 42, 38],
      },
      rhr: {
        label: 'Resting HR', sub: '', unit: 'bpm',
        today: 61, baseline: 58, baselineP25: 55, baselineP75: 61,
        rollingD7: 61, rollingD30: 59, rollingD90: 58,
        trend30d: 'rising', worseWhen: 'up',
        weekly: [58, 58, 57, 58, 59, 58, 59, 60, 60, 60, 61, 61],
      },
      sleep_score: {
        label: 'Sleep', sub: 'score', unit: '',
        today: 79, baseline: 82, baselineP25: 76, baselineP75: 87,
        rollingD7: 79, rollingD30: 81, rollingD90: 82,
        trend30d: 'flat', worseWhen: 'down',
        weekly: [85, 84, 83, 86, 85, 84, 82, 80, 79, 78, 79, 78],
      },
      readiness_score: {
        label: 'Readiness', sub: 'score', unit: '',
        today: 78, baseline: 82, baselineP25: 77, baselineP75: 88,
        rollingD7: 78, rollingD30: 81, rollingD90: 82,
        trend30d: 'declining', worseWhen: 'down',
        weekly: [82, 83, 82, 84, 83, 82, 81, 79, 78, 77, 78, 78],
      },
    },
  },
};

// Feature flag — only render in the UI while mock data is the only thing behind the component.
// Flip to `hasWearableSummary()` once L2 wiring is real.
function isWearableStripVisible() {
  if (localStorage.getItem('wearables-mock-off') === '1') return false;
  return true;
}

export function hasWearableSummary() {
  return isWearableStripVisible();
}

function getWearableSummary() {
  return MOCK_SUMMARY;
}

// ─────────────────────────────────────────────────────────
// HELPERS
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

// Semantic color for a delta: worse-direction → red, better-direction → green, ~flat → neutral.
function deltaClass(metric) {
  const deltaPct = ((metric.today - metric.baseline) / metric.baseline) * 100;
  const absPct = Math.abs(deltaPct);
  if (absPct < 3) return 'delta-flat';
  const isDown = deltaPct < 0;
  const worse = (isDown && metric.worseWhen === 'down') || (!isDown && metric.worseWhen === 'up');
  return worse ? 'delta-bad' : 'delta-good';
}

function formatDelta(metric) {
  const deltaPct = ((metric.today - metric.baseline) / metric.baseline) * 100;
  const arrow = deltaPct > 0.5 ? '↑' : deltaPct < -0.5 ? '↓' : '→';
  return `${arrow} ${Math.abs(deltaPct).toFixed(0)}%`;
}

function formatValue(metric) {
  if (metric.unit === 'ms' || metric.unit === 'bpm') return String(Math.round(metric.today));
  if (metric.unit === '') return String(Math.round(metric.today));
  return metric.today.toFixed(1);
}

// Build an SVG polyline path from a numeric series normalised to 0..VW, 0..VH.
// Includes a dashed baseline reference line and a dot at the latest point.
function sparklineSVG(series, baseline, worseWhen) {
  if (!series || series.length === 0) return '';
  const VW = 100, VH = 30;
  const pad = 2;
  const all = series.concat([baseline]);
  const min = Math.min(...all), max = Math.max(...all);
  const range = Math.max(max - min, 1e-6);
  const xStep = (VW - pad * 2) / Math.max(series.length - 1, 1);
  const yFor = (v) => VH - pad - ((v - min) / range) * (VH - pad * 2);
  const pts = series.map((v, i) => `${(pad + i * xStep).toFixed(1)},${yFor(v).toFixed(1)}`).join(' ');
  const lastX = (pad + (series.length - 1) * xStep).toFixed(1);
  const lastY = yFor(series[series.length - 1]).toFixed(1);
  const baselineY = yFor(baseline).toFixed(1);
  // Color hints the viewer BEFORE the delta badge reads: if series ends below baseline and
  // that's the "bad" direction for this metric, the line skews red.
  const endsBelowBaseline = series[series.length - 1] < baseline;
  const badTone = (endsBelowBaseline && worseWhen === 'down') || (!endsBelowBaseline && worseWhen === 'up');
  const strokeClass = Math.abs(series[series.length - 1] - baseline) / baseline < 0.03
    ? 'spark-neutral' : (badTone ? 'spark-bad' : 'spark-good');
  return `<svg class="wearable-sparkline ${strokeClass}" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" y1="${baselineY}" x2="${VW}" y2="${baselineY}" class="spark-baseline"/>
    <polyline points="${pts}" class="spark-line"/>
    <circle cx="${lastX}" cy="${lastY}" r="2" class="spark-last"/>
  </svg>`;
}

// ─────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────

export function renderWearableStrip() {
  if (!isWearableStripVisible()) return '';
  const summary = getWearableSummary();
  const oura = summary.oura;
  if (!oura) return '';

  const metricOrder = ['hrv_rmssd', 'rhr', 'sleep_score', 'readiness_score'];
  const collapsed = localStorage.getItem('wearables-strip-collapsed') === '1';

  let html = `<section class="wearable-strip" id="wearable-strip">
    <div class="wearable-strip-header" onclick="toggleWearableStrip()">
      <div class="wearable-strip-title">
        <span class="wearable-strip-icon">⌬</span>
        <span>Wearable <span class="wearable-source-label">Oura · ${oura.coverageDays}d</span></span>
        <span class="wearable-strip-demo-pill">demo data</span>
      </div>
      <div class="wearable-strip-meta">
        <span>last synced ${formatAgo(oura.lastSyncAt)}</span>
        <a href="#" class="wearable-strip-sync" onclick="event.stopPropagation();syncWearableNow();return false">Sync now</a>
        <span class="wearable-collapse-arrow${collapsed ? ' collapsed' : ''}">▾</span>
      </div>
    </div>
    <div class="wearable-card-grid${collapsed ? ' hidden' : ''}">`;

  for (const key of metricOrder) {
    const m = oura.metrics[key];
    if (!m) continue;
    const subLabel = m.sub ? `<span class="wearable-metric-sub">${escapeHTML(m.sub)}</span>` : '';
    const unitLabel = m.unit ? `<span class="wearable-unit">${escapeHTML(m.unit)}</span>` : '';
    const trendClass = `wearable-trend-${m.trend30d}`;
    const trendLabel = m.trend30d === 'declining' ? 'declining 30d'
      : m.trend30d === 'rising' ? 'rising 30d'
      : m.trend30d === 'improving' ? 'improving 30d'
      : 'flat 30d';
    html += `<div class="wearable-card" onclick="openWearableDetail('${escapeHTML(key)}')" role="button" tabindex="0">
      <div class="wearable-card-top">
        <span class="wearable-metric-name">${escapeHTML(m.label)}${subLabel}</span>
        <span class="wearable-delta ${deltaClass(m)}">${formatDelta(m)}</span>
      </div>
      <div class="wearable-value-row">
        <span class="wearable-value">${formatValue(m)}</span>${unitLabel}
        <span class="wearable-baseline">baseline ${m.baseline}${m.unit ? ' ' + escapeHTML(m.unit) : ''}</span>
      </div>
      ${sparklineSVG(m.weekly, m.baseline, m.worseWhen)}
      <div class="wearable-trend-pill ${trendClass}">${trendLabel}</div>
    </div>`;
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

function openWearableDetail(_metricKey) {
  // Placeholder — detail view arrives in v1.1. A no-op toast keeps the click
  // surface honest while UI lands first.
  if (window.showNotification) window.showNotification('Detail view is scheduled for v1.1', 'info');
}

function syncWearableNow() {
  if (window.showNotification) window.showNotification('Wearable sync stub — API wiring arrives in the next PR', 'info');
}

Object.assign(window, {
  renderWearableStrip,
  toggleWearableStrip,
  openWearableDetail,
  syncWearableNow,
  hasWearableSummary,
});
