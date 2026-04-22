// wearables-ultrahuman.js — Ultrahuman Ring Air data layer (PAT auth)
//
// Ultrahuman uses Personal Access Tokens — user pastes a key from their
// partner portal. No OAuth dance, no refresh flow. Requests route through
// /api/proxy so the key is redacted server-side and CORS is handled.
//
// BETA: scope + response shapes haven't been validated against a live token
// yet. Field names below follow Ultrahuman's published docs as of 2026-04.
// First beta tester will surface any drift; the .catch(() => []) on each
// endpoint degrades gracefully if a field was renamed.

import { isDebugMode } from './utils.js';

const UH_API = 'https://partner.ultrahuman.com';
const PROXY_URL = '/api/proxy';

async function uhGET(path, accessToken, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${UH_API}/${path.replace(/^\//, '')}${qs ? '?' + qs : ''}`;
  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }),
  });
  if (!res.ok) {
    let err;
    try { err = await res.json(); } catch { err = { error: res.statusText }; }
    const msg = err?.detail || err?.message || err?.error || res.statusText || 'Ultrahuman request failed';
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return res.json();
}

// Verify the PAT is valid by pulling a 1-day metrics window.
export async function verifyUltrahumanPAT(accessToken, email) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await uhGET('api/v1/metrics', accessToken, { email, date: today });
    return { ok: true, account: { email: email || null } };
  } catch (e) {
    return { ok: false, error: e.message, status: e.status };
  }
}

// Returns canonical L1 rows for [startDate, endDate]. Ultrahuman's partner
// API is day-resolution, keyed by ?email&date. We loop one day at a time;
// their API doesn't support multi-day ranges in a single call.
export async function fetchUltrahumanDailyRange(accessToken, email, startDate, endDate) {
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  const byDate = new Map();
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    let payload;
    try { payload = await uhGET('api/v1/metrics', accessToken, { email, date: day }); }
    catch (e) { logDebug('metrics', e); continue; }
    const row = canonicalizeDay(day, payload);
    if (row) byDate.set(day, row);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// Ultrahuman returns nested `metric_data` objects per day. Field names track
// the docs snapshot as of 2026-04 — they may drift. Keep this function as
// the ONLY place that touches vendor-specific keys.
function canonicalizeDay(day, payload) {
  const data = payload?.data?.metric_data || payload?.metric_data || payload || {};
  const row = {
    source: 'ultrahuman', date: day,
    hrv_rmssd: null, rhr: null,
    sleep_score: null, readiness_score: null,
    activity_score: null, steps: null,
    stress_high_min: null, resilience_level: null, cardio_age: null,
    spo2_avg: null, body_temp_delta: null, glucose_avg: null,
  };
  const pick = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
  const numOrNull = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;

  row.hrv_rmssd       = numOrNull(pick('hrv.avg')) ?? numOrNull(pick('hrv'));
  row.rhr             = numOrNull(pick('resting_heart_rate.avg')) ?? numOrNull(pick('resting_heart_rate'));
  row.sleep_score     = numOrNull(pick('sleep_index.score')) ?? numOrNull(pick('sleep_index'));
  row.readiness_score = numOrNull(pick('recovery_index.score')) ?? numOrNull(pick('recovery_index'));
  row.steps           = numOrNull(pick('steps.total')) ?? numOrNull(pick('steps'));
  row.body_temp_delta = numOrNull(pick('temperature.deviation')) ?? numOrNull(pick('temperature'));
  row.glucose_avg     = numOrNull(pick('glucose.avg')); // CGM stack only

  // If every metric is null, skip the row — keeps the L1 table clean for days
  // the ring wasn't worn or the partner API simply returned nothing.
  if (Object.values(row).every(v => v === null || v === 'ultrahuman' || typeof v === 'string')) return null;
  return row;
}

function logDebug(where, err) {
  if (isDebugMode?.()) console.warn(`[ultrahuman] ${where} failed:`, err?.message || err);
}
