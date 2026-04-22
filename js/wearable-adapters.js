// wearable-adapters.js — Canonical wearable-metric registry + vendor adapters
//
// Contract: the rest of the app reads **canonical** metric ids (hrv_rmssd,
// rhr, sleep_score, readiness_score, …). Adapters describe how each vendor's
// cloud API or file export maps onto those canonical ids. L1 IndexedDB rows
// are stamped with `source`, L2 `wearableSummary` indexes `sources` by id,
// AI context reads canonical — no vendor name reaches the renderer, the
// AI prompt, or the sync schema.
//
// Add a wearable by appending to ADAPTERS. If it surfaces a new canonical
// metric nobody else exposes, add it to CANONICAL_METRICS — the strip will
// pick it up automatically.
//
// Shape — adapter:
//   id              stable lowercase slug; persisted in L1 rows, L2 sources
//   displayName     human label ("Oura", "WHOOP", "Apple Health")
//   authType        'pat' | 'oauth' | 'file-import'
//   authDocsUrl     optional — where the user creates the credential
//   apiHost         optional — for 'pat'/'oauth' adapters; routed via /api/proxy allowlist
//   metrics         { canonicalId: { endpoint, field, transform? } }
//   accountInfo     optional — endpoint + field to verify credential + show identity
//
// Shape — canonical metric:
//   id              slug used across L1/L2/AI
//   label           top-row label on card ("HRV")
//   sub             optional sub-label ("RMSSD", "score")
//   unit            'ms' | 'bpm' | '%' | '°C' | 'mg/dL' | ''
//   worseWhen       'up' | 'down' | 'either'  — semantic colour for delta badges

export const CANONICAL_METRICS = {
  hrv_rmssd:       { id: 'hrv_rmssd',       label: 'HRV',        sub: 'RMSSD', unit: 'ms',    worseWhen: 'down' },
  rhr:             { id: 'rhr',             label: 'Resting HR', sub: '',      unit: 'bpm',   worseWhen: 'up'   },
  sleep_score:     { id: 'sleep_score',     label: 'Sleep',      sub: 'score', unit: '',      worseWhen: 'down' },
  readiness_score: { id: 'readiness_score', label: 'Readiness',  sub: 'score', unit: '',      worseWhen: 'down' },
  // Canonical extras — adapters opt in by mapping to them
  spo2_avg:        { id: 'spo2_avg',        label: 'SpO₂',       sub: '',      unit: '%',     worseWhen: 'down' },
  body_temp_delta: { id: 'body_temp_delta', label: 'Body temp',  sub: 'Δ',     unit: '°C',    worseWhen: 'either' },
  glucose_avg:     { id: 'glucose_avg',     label: 'Glucose',    sub: 'avg',   unit: 'mg/dL', worseWhen: 'either' },
};

// Default display order for the dashboard strip. A canonical metric not listed
// here still renders (appended in registry order) — the list just pins priority.
export const DEFAULT_METRIC_ORDER = ['hrv_rmssd', 'rhr', 'sleep_score', 'readiness_score'];

export const ADAPTERS = [
  {
    id: 'oura',
    displayName: 'Oura',
    authType: 'pat',
    authDocsUrl: 'https://cloud.ouraring.com/personal-access-tokens',
    apiHost: 'api.ouraring.com',
    metrics: {
      hrv_rmssd:       { endpoint: 'v2/usercollection/sleep',           field: 'average_hrv' },
      rhr:             { endpoint: 'v2/usercollection/sleep',           field: 'average_heart_rate' },
      sleep_score:     { endpoint: 'v2/usercollection/daily_sleep',     field: 'score' },
      readiness_score: { endpoint: 'v2/usercollection/daily_readiness', field: 'score' },
      spo2_avg:        { endpoint: 'v2/usercollection/daily_spo2',      field: 'spo2_percentage' },
      body_temp_delta: { endpoint: 'v2/usercollection/daily_readiness', field: 'temperature_deviation' },
    },
    accountInfo: { endpoint: 'v2/usercollection/personal_info', identityField: 'email' },
  },
  // Scheduled:
  //   { id: 'whoop',            authType: 'oauth',       apiHost: 'api.prod.whoop.com' }
  //   { id: 'ultrahuman',       authType: 'pat',         apiHost: 'partner.ultrahuman.com' }
  //   { id: 'apple_health_xml', authType: 'file-import' }
];

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

export function adapterById(id) {
  return ADAPTERS.find(a => a.id === id) || null;
}

export function adapterSupportsMetric(adapterId, metricId) {
  const a = adapterById(adapterId);
  return !!a?.metrics?.[metricId];
}

// Return the list of canonical metrics any given adapter can deliver.
export function adapterMetricIds(adapterId) {
  const a = adapterById(adapterId);
  if (!a) return [];
  return Object.keys(a.metrics || {});
}

// Union of canonical metrics across a set of connected source ids (preserving
// DEFAULT_METRIC_ORDER, then appending any extras in registry order).
export function metricsForSources(sourceIds) {
  const set = new Set();
  for (const sid of sourceIds) for (const m of adapterMetricIds(sid)) set.add(m);
  const ordered = [];
  for (const id of DEFAULT_METRIC_ORDER) if (set.has(id)) ordered.push(id);
  for (const id of set) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

export function canonicalMetric(id) {
  return CANONICAL_METRICS[id] || null;
}
