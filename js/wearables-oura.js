// wearables-oura.js — Oura API data-layer (OAuth2 server-side flow)
//
// Pure data-layer: talks to Oura's /v2/usercollection/* endpoints via the
// /api/proxy path (Oura does not set permissive CORS, so browser-direct
// won't work in production). Returns canonical L1 rows — no Oura field
// names cross the boundary.
//
// The accessToken arg is opaque here — this module doesn't know whether it
// came from OAuth2 or from an older PAT. Token refresh happens one layer up
// in wearables-connect.js via `withFreshToken`. See wearables-oura-auth.js.

import { isDebugMode } from './utils.js';

const OURA_API = 'https://api.ouraring.com';
const PROXY_URL = '/api/proxy';

// ─────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────

async function ouraGET(path, accessToken, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${OURA_API}/${path.replace(/^\//, '')}${qs ? '?' + qs : ''}`;
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
    const msg = err?.detail || err?.error || res.statusText || 'Oura request failed';
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// Collect every page of a paginated collection endpoint. Oura returns
// `{ data: [...], next_token }` — we loop until next_token is null/empty.
async function ouraCollect(path, accessToken, params) {
  const all = [];
  let nextToken = null;
  let pages = 0;
  do {
    const p = nextToken ? { ...params, next_token: nextToken } : params;
    const page = await ouraGET(path, accessToken, p);
    if (Array.isArray(page?.data)) all.push(...page.data);
    nextToken = page?.next_token || null;
    pages++;
    if (pages > 20) break; // defensive — 90 days of any endpoint fits well under this
  } while (nextToken);
  return all;
}

// ─────────────────────────────────────────────────────────
// Account info (replaces the PAT-era verifyOuraPAT)
// ─────────────────────────────────────────────────────────

export async function fetchOuraPersonalInfo(accessToken) {
  try {
    const info = await ouraGET('v2/usercollection/personal_info', accessToken);
    return {
      ok: true,
      account: {
        email: info?.email || null,
        age: info?.age || null,
        weight: info?.weight || null,
        height: info?.height || null,
        biologicalSex: info?.biological_sex || null,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message, status: e.status };
  }
}

// ─────────────────────────────────────────────────────────
// Range fetch → canonical rows
// ─────────────────────────────────────────────────────────

// Pick the longest sleep session per day — Oura's /sleep endpoint returns
// one row per sleep period (nap + main). HRV/HR for the "main" night is
// the most useful signal.
function bestSessionPerDay(sessions) {
  const byDay = new Map();
  for (const s of sessions) {
    const day = s?.day;
    if (!day) continue;
    const dur = (s?.total_sleep_duration ?? s?.duration ?? 0);
    const prev = byDay.get(day);
    if (!prev || dur > (prev.total_sleep_duration ?? prev.duration ?? 0)) byDay.set(day, s);
  }
  return byDay;
}

function meanOrNull(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const nums = arr.map(v => (typeof v === 'object' && v !== null) ? v.value : v).filter(v => typeof v === 'number' && isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Returns canonical L1 rows for the inclusive date range [startDate, endDate].
// Each row is keyed by date; missing metrics are null (not omitted) so consumers
// can see "no spo2 today" vs "spo2 not yet fetched."
// Resilience `level` is a string enum; map to 1-5 so baseline/trend math works.
const RESILIENCE_LEVEL_TO_NUM = {
  limited: 1, adequate: 2, solid: 3, strong: 4, exceptional: 5,
};

export async function fetchOuraDailyRange(accessToken, startDate, endDate) {
  const params = { start_date: startDate, end_date: endDate };
  // Fetch collections in parallel — independent endpoints. New (daily_activity,
  // daily_stress, daily_resilience, daily_cardiovascular_age) are covered by
  // the `daily` scope we already request, so no reconnect needed for them.
  const [
    sleepSessions, dailySleep, dailyReadiness, dailySpo2,
    dailyActivity, dailyStress, dailyResilience, dailyCardioAge,
  ] = await Promise.all([
    ouraCollect('v2/usercollection/sleep',                    accessToken, params).catch(e => { logDebug('sleep', e); return []; }),
    ouraCollect('v2/usercollection/daily_sleep',              accessToken, params).catch(e => { logDebug('daily_sleep', e); return []; }),
    ouraCollect('v2/usercollection/daily_readiness',          accessToken, params).catch(e => { logDebug('daily_readiness', e); return []; }),
    ouraCollect('v2/usercollection/daily_spo2',               accessToken, params).catch(e => { logDebug('daily_spo2', e); return []; }),
    ouraCollect('v2/usercollection/daily_activity',           accessToken, params).catch(e => { logDebug('daily_activity', e); return []; }),
    ouraCollect('v2/usercollection/daily_stress',             accessToken, params).catch(e => { logDebug('daily_stress', e); return []; }),
    ouraCollect('v2/usercollection/daily_resilience',         accessToken, params).catch(e => { logDebug('daily_resilience', e); return []; }),
    ouraCollect('v2/usercollection/daily_cardiovascular_age', accessToken, params).catch(e => { logDebug('daily_cardiovascular_age', e); return []; }),
  ]);

  const sleepByDay = bestSessionPerDay(sleepSessions);

  const byDate = new Map();
  function ensureRow(day) {
    if (!byDate.has(day)) {
      byDate.set(day, {
        source: 'oura', date: day,
        hrv_rmssd: null, rhr: null,
        sleep_score: null, readiness_score: null,
        activity_score: null, stress_high_min: null,
        resilience_level: null, cardio_age: null,
        spo2_avg: null, body_temp_delta: null, glucose_avg: null,
      });
    }
    return byDate.get(day);
  }

  for (const [day, s] of sleepByDay) {
    const row = ensureRow(day);
    row.hrv_rmssd = s?.average_hrv ?? meanOrNull(s?.hrv) ?? meanOrNull(s?.hrv_samples);
    row.rhr       = s?.average_heart_rate ?? s?.lowest_heart_rate ?? null;
  }
  for (const d of dailySleep) {
    if (!d?.day) continue;
    ensureRow(d.day).sleep_score = typeof d.score === 'number' ? d.score : null;
  }
  for (const d of dailyReadiness) {
    if (!d?.day) continue;
    const row = ensureRow(d.day);
    row.readiness_score = typeof d.score === 'number' ? d.score : null;
    if (typeof d.temperature_deviation === 'number') row.body_temp_delta = d.temperature_deviation;
  }
  for (const d of dailySpo2) {
    if (!d?.day) continue;
    const v = typeof d.spo2_percentage === 'object' ? d.spo2_percentage?.average : d.spo2_percentage;
    if (typeof v === 'number') ensureRow(d.day).spo2_avg = v;
  }
  for (const d of dailyActivity) {
    if (!d?.day) continue;
    if (typeof d.score === 'number') ensureRow(d.day).activity_score = d.score;
  }
  for (const d of dailyStress) {
    if (!d?.day) continue;
    // Oura returns `stress_high` in seconds — convert to minutes for display.
    if (typeof d.stress_high === 'number') ensureRow(d.day).stress_high_min = Math.round(d.stress_high / 60);
  }
  for (const d of dailyResilience) {
    if (!d?.day) continue;
    const n = RESILIENCE_LEVEL_TO_NUM[String(d.level || '').toLowerCase()];
    if (typeof n === 'number') ensureRow(d.day).resilience_level = n;
  }
  for (const d of dailyCardioAge) {
    if (!d?.day) continue;
    if (typeof d.vascular_age === 'number') ensureRow(d.day).cardio_age = d.vascular_age;
  }

  // Return sorted ascending by date so consumers get chronological order.
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ─────────────────────────────────────────────────────────
// Date helpers (exported for the scheduler)
// ─────────────────────────────────────────────────────────

export function isoDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function daysAgoIso(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return isoDay(d);
}

// ─────────────────────────────────────────────────────────
// Debug
// ─────────────────────────────────────────────────────────

function logDebug(where, err) {
  if (isDebugMode?.()) console.warn(`[oura] ${where} failed:`, err?.message || err);
}
