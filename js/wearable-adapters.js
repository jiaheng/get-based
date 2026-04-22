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
  hrv_rmssd:        { id: 'hrv_rmssd',        label: 'HRV',         sub: 'RMSSD', unit: 'ms',    worseWhen: 'down'   },
  hrv_sdnn:         { id: 'hrv_sdnn',         label: 'HRV',         sub: 'SDNN',  unit: 'ms',    worseWhen: 'down'   }, // Apple Health (deep HRV)
  rhr:              { id: 'rhr',              label: 'Resting HR',  sub: '',      unit: 'bpm',   worseWhen: 'up'     },
  sleep_score:      { id: 'sleep_score',      label: 'Sleep',       sub: 'score', unit: '',      worseWhen: 'down'   },
  readiness_score:  { id: 'readiness_score',  label: 'Readiness',   sub: 'score', unit: '',      worseWhen: 'down'   },
  activity_score:   { id: 'activity_score',   label: 'Activity',    sub: 'score', unit: '',      worseWhen: 'down'   },
  steps:            { id: 'steps',             label: 'Steps',       sub: '',      unit: '',      worseWhen: 'down'   },
  strain:           { id: 'strain',           label: 'Strain',      sub: 'day',   unit: '',      worseWhen: 'either' }, // WHOOP 0-21 Borg scale
  stress_high_min:  { id: 'stress_high_min',  label: 'Stress',      sub: 'high',  unit: 'min',   worseWhen: 'up'     },
  resilience_level: { id: 'resilience_level', label: 'Resilience',  sub: 'level', unit: '/5',    worseWhen: 'down'   },
  cardio_age:       { id: 'cardio_age',       label: 'Cardio age',  sub: '',      unit: 'yrs',   worseWhen: 'up'     },
  // Biometric-rooted canonicals (Withings scale/BP cuff, etc.) — these overlap
  // with manual biometrics entries; Phase 3 will decide on a merge policy.
  weight:           { id: 'weight',           label: 'Weight',      sub: '',      unit: 'kg',    worseWhen: 'either' },
  bp_systolic:      { id: 'bp_systolic',      label: 'BP',          sub: 'syst',  unit: 'mmHg',  worseWhen: 'up'     },
  bp_diastolic:     { id: 'bp_diastolic',     label: 'BP',          sub: 'dia',   unit: 'mmHg',  worseWhen: 'up'     },
  // Canonical extras — adapters opt in by mapping to them
  spo2_avg:         { id: 'spo2_avg',         label: 'SpO₂',        sub: '',      unit: '%',     worseWhen: 'down'   },
  body_temp_delta:  { id: 'body_temp_delta',  label: 'Body temp',   sub: 'Δ',     unit: '°C',    worseWhen: 'either' },
  glucose_avg:      { id: 'glucose_avg',      label: 'Glucose',     sub: 'avg',   unit: 'mg/dL', worseWhen: 'either' },
};

// Default display order for the dashboard strip. A canonical metric not listed
// here still renders (appended in registry order) — the list just pins priority.
export const DEFAULT_METRIC_ORDER = [
  'hrv_rmssd', 'rhr', 'sleep_score', 'readiness_score',
  'activity_score', 'steps', 'stress_high_min', 'resilience_level', 'cardio_age',
];

export const ADAPTERS = [
  {
    id: 'oura',
    displayName: 'Oura',
    authType: 'oauth2',
    // Oura's developer portal doesn't offer PKCE — this is the server-side
    // flow with the client_secret held server-side (Vercel env var, read only
    // by /api/proxy). Browser never sees the secret. See wearables-oura-auth.js.
    oauth: {
      clientId: '8bb386cb-1b6e-4ab8-b852-ff47662667f6',
      // Must match the URIs registered in the Oura developer portal, verbatim.
      redirectUris: [
        'https://app.getbased.health/',
        'https://getbased.health/app',
        'http://localhost:8000/app',
      ],
      scopes: ['personal', 'daily', 'heartrate', 'session', 'spo2', 'stress', 'heart_health'],
    },
    apiHost: 'api.ouraring.com',
    metrics: {
      hrv_rmssd:        { endpoint: 'v2/usercollection/sleep',                   field: 'average_hrv' },
      rhr:              { endpoint: 'v2/usercollection/sleep',                   field: 'average_heart_rate' },
      sleep_score:      { endpoint: 'v2/usercollection/daily_sleep',             field: 'score' },
      readiness_score:  { endpoint: 'v2/usercollection/daily_readiness',         field: 'score' },
      activity_score:   { endpoint: 'v2/usercollection/daily_activity',          field: 'score' },           // 0 when user has Rest Mode on — see steps as fallback
      steps:            { endpoint: 'v2/usercollection/daily_activity',          field: 'steps' },
      stress_high_min:  { endpoint: 'v2/usercollection/daily_stress',            field: 'stress_high' },     // seconds → minutes in fetcher
      resilience_level: { endpoint: 'v2/usercollection/daily_resilience',        field: 'level' },           // enum → 1-5 in fetcher
      cardio_age:       { endpoint: 'v2/usercollection/daily_cardiovascular_age', field: 'vascular_age' },
      spo2_avg:         { endpoint: 'v2/usercollection/daily_spo2',              field: 'spo2_percentage' },
      body_temp_delta:  { endpoint: 'v2/usercollection/daily_readiness',         field: 'temperature_deviation' },
    },
    accountInfo: { endpoint: 'v2/usercollection/personal_info', identityField: 'email' },
  },
  // ─── Phase 3 beta adapters ─────────────────────────────────────────
  // Flagged `beta: true` so the settings card carries a BETA badge and the
  // strip shows real data as soon as any beta tester connects. The UX is
  // identical to Oura — the flag only affects display copy.

  {
    id: 'ultrahuman',
    displayName: 'Ultrahuman',
    authType: 'pat',
    authDocsUrl: 'https://blog.ultrahuman.com/blog/api-onboarding',
    beta: true,
    apiHost: 'partner.ultrahuman.com',
    metrics: {
      hrv_rmssd:       { endpoint: 'api/v1/metrics',                        field: 'hrv' },
      rhr:             { endpoint: 'api/v1/metrics',                        field: 'resting_heart_rate' },
      sleep_score:     { endpoint: 'api/v1/metrics',                        field: 'sleep_index' },
      readiness_score: { endpoint: 'api/v1/metrics',                        field: 'recovery_index' },
      steps:           { endpoint: 'api/v1/metrics',                        field: 'steps' },
      body_temp_delta: { endpoint: 'api/v1/metrics',                        field: 'temperature' },
      glucose_avg:     { endpoint: 'api/v1/metrics',                        field: 'glucose_avg' }, // CGM users only
    },
    accountInfo: { endpoint: 'api/v1/metrics', identityField: 'email' },
  },

  {
    id: 'whoop',
    displayName: 'WHOOP',
    authType: 'oauth2',
    authDocsUrl: 'https://developer.whoop.com/docs/developing/oauth',
    beta: true,
    oauth: {
      // PKCE flow — no client secret needed in browser. The clientId here is
      // a placeholder until the production WHOOP developer app is registered.
      clientId: 'getbased-whoop-beta',
      redirectUris: [
        'https://app.getbased.health/',
        'https://getbased.health/app',
        'http://localhost:8000/app',
      ],
      scopes: ['read:recovery', 'read:sleep', 'read:workout', 'read:cycles', 'read:profile', 'offline'],
      pkce: true,
    },
    apiHost: 'api.prod.whoop.com',
    metrics: {
      hrv_rmssd:       { endpoint: 'developer/v1/recovery', field: 'score.hrv_rmssd_milli' },
      rhr:             { endpoint: 'developer/v1/recovery', field: 'score.resting_heart_rate' },
      sleep_score:     { endpoint: 'developer/v1/activity/sleep',           field: 'score.sleep_performance_percentage' },
      readiness_score: { endpoint: 'developer/v1/recovery',                 field: 'score.recovery_score' },
      strain:          { endpoint: 'developer/v1/cycle',                    field: 'score.strain' },
    },
    accountInfo: { endpoint: 'developer/v1/user/profile/basic', identityField: 'email' },
  },

  {
    id: 'apple_health',
    displayName: 'Apple Health',
    authType: 'file-import',
    authDocsUrl: 'https://support.apple.com/guide/iphone/share-your-health-data-iph27f6325b2/ios',
    beta: true,
    apiHost: null, // file-import has no host
    metrics: {
      // Apple Health XML `type` attribute → canonical metric mapping. Populated
      // by the parser at import time, not fetched per-request.
      hrv_sdnn:        { hkType: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN' },
      rhr:             { hkType: 'HKQuantityTypeIdentifierRestingHeartRate' },
      steps:           { hkType: 'HKQuantityTypeIdentifierStepCount' },
      spo2_avg:        { hkType: 'HKQuantityTypeIdentifierOxygenSaturation' },
      body_temp_delta: { hkType: 'HKQuantityTypeIdentifierBodyTemperature' },
    },
  },

  {
    id: 'withings',
    displayName: 'Withings',
    authType: 'oauth2',
    authDocsUrl: 'https://developer.withings.com/oauth2/',
    beta: true,
    oauth: {
      // TODO: replace with the Client ID from your Withings developer portal.
      // Requires WITHINGS_CLIENT_SECRET env var on Vercel + local dev-server.
      clientId: 'REPLACE_WITH_WITHINGS_CLIENT_ID',
      redirectUris: [
        'https://app.getbased.health/',
        'https://getbased.health/app',
        'http://localhost:8000/app',
      ],
      scopes: ['user.info', 'user.metrics', 'user.activity', 'user.sleepevents'],
      pkce: false, // Server-side flow like Oura — secret held by /api/proxy
    },
    apiHost: 'wbsapi.withings.net',
    metrics: {
      weight:       { endpoint: 'measure',  measType: 1  },
      bp_diastolic: { endpoint: 'measure',  measType: 9  },
      bp_systolic:  { endpoint: 'measure',  measType: 10 },
      rhr:          { endpoint: 'measure',  measType: 11 },
      sleep_score:  { endpoint: 'v2/sleep', field: 'sleep_score' },
    },
    accountInfo: { endpoint: 'v2/user', identityField: 'email' },
  },
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
