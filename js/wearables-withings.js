// wearables-withings.js — Withings data layer
//
// BETA. Withings's REST API quirks:
//   - Base: wbsapi.withings.net
//   - Every POST/GET carries `action=<verb>` in the body or query string
//     (e.g. action=getmeas, action=getsleep). action IS the method selector;
//     the URL path just groups endpoints.
//   - Responses wrap the real payload in `{ status: 0, body: {...} }`;
//     non-zero status is an error code.
//   - Measures use a numeric `type` code (1=weight kg, 9=bp diastolic,
//     10=bp systolic, 11=pulse bpm, 76=muscle mass, 77=hydration,
//     71=body temp, 73=skin temp, etc.) — we unpack into canonical fields.
//
// Pagination: /measure returns arrays per call, no nextToken. /v2/sleep and
// /v2/heart use `startdateymd`/`enddateymd`. Everything is day-granular on
// our side — we reduce intra-day samples before writing to L1.

import { isDebugMode } from './utils.js';

const WITHINGS_API = 'https://wbsapi.withings.net';
const PROXY_URL    = '/api/proxy';

// Withings measure-type codes → canonical fields
const MEAS_TYPES = {
  1:  'weight',       // kg
  9:  'bp_diastolic', // mmHg
  10: 'bp_systolic',  // mmHg
  11: 'rhr',          // bpm (pulse — Withings uses this for resting HR on scale)
};

async function withingsPOST(action, accessToken, params = {}) {
  // Withings accepts either x-www-form-urlencoded body OR query string. Form
  // body is the documented path; we route through our generic proxy (which
  // forwards the body verbatim).
  const form = new URLSearchParams({ action, ...params });
  const url = `${WITHINGS_API}/${normalisePath(action)}`;
  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: form.toString(),
    }),
  });
  if (!res.ok) {
    let err; try { err = await res.json(); } catch { err = { error: res.statusText }; }
    const e = new Error(err?.error || err?.detail || res.statusText || 'Withings request failed');
    e.status = res.status; throw e;
  }
  const payload = await res.json();
  if (payload?.status !== 0) {
    const e = new Error(`Withings status ${payload?.status}: ${payload?.error || 'unknown'}`);
    // Withings uses 401 for expired/invalid tokens; mirror in the JS error.
    e.status = (payload?.status === 401 || payload?.status === 100) ? 401 : 400;
    throw e;
  }
  return payload.body || {};
}

// Withings clusters endpoints into groups; the action tells the server which
// resource to hit. The path prefix is the group.
function normalisePath(action) {
  if (action === 'getmeas' || action === 'getsubscription') return 'measure';
  if (action === 'getsleep' || action === 'getsleepsummary') return 'v2/sleep';
  if (action === 'getheartlist' || action === 'get') return 'v2/heart';
  if (action === 'getactivity') return 'v2/measure';
  return 'measure';
}

export async function fetchWithingsPersonalInfo(accessToken) {
  // Withings doesn't have a clean /user endpoint; we best-effort by pulling a
  // short-range measure window and stamping a connection identity. This avoids
  // failing the connect flow just because profile info is sparse.
  try {
    const today = Math.floor(Date.now() / 1000);
    const week = today - 7 * 86400;
    const meas = await withingsPOST('getmeas', accessToken, { startdate: String(week), enddate: String(today) });
    return { ok: true, account: { email: null, userId: meas?.updatetime ? 'verified' : null } };
  } catch (e) {
    return { ok: false, error: e.message, status: e.status };
  }
}

export async function fetchWithingsDailyRange(accessToken, startDate, endDate) {
  const startUnix = Math.floor(new Date(startDate + 'T00:00:00Z').getTime() / 1000);
  const endUnix   = Math.floor(new Date(endDate + 'T23:59:59Z').getTime() / 1000);

  // Fetch in parallel: body measures (weight, BP, pulse), sleep summary.
  // Heartrate list is per-device and noisy; deferring to a follow-up.
  const [meas, sleep] = await Promise.all([
    withingsPOST('getmeas', accessToken, {
      startdate: String(startUnix), enddate: String(endUnix),
      meastypes: Object.keys(MEAS_TYPES).join(','),
      category: '1', // 1 = real measures (not user objectives)
    }).catch(e => { logDebug('getmeas', e); return {}; }),
    withingsPOST('getsleepsummary', accessToken, {
      startdateymd: startDate, enddateymd: endDate,
      data_fields: 'asleepduration,wakeupduration,deepsleepduration,hr_average,hr_min,rr_average,sleep_score',
    }).catch(e => { logDebug('getsleepsummary', e); return {}; }),
  ]);

  const byDate = new Map();
  function ensureRow(day) {
    if (!byDate.has(day)) {
      byDate.set(day, {
        source: 'withings', date: day,
        hrv_rmssd: null, hrv_sdnn: null, rhr: null,
        sleep_score: null, readiness_score: null,
        activity_score: null, steps: null,
        strain: null,
        stress_high_min: null, resilience_level: null, cardio_age: null,
        weight: null, bp_systolic: null, bp_diastolic: null,
        spo2_avg: null, body_temp_delta: null, glucose_avg: null,
      });
    }
    return byDate.get(day);
  }

  // Body measures — Withings returns grouped samples; each group has a date +
  // an array of {value, type, unit}. Value is `value * 10^unit` (unit can be
  // negative, e.g. weight 725 with unit=-1 → 72.5 kg).
  for (const group of (meas?.measuregrps || [])) {
    const epoch = group?.date;
    if (!epoch) continue;
    const day = new Date(epoch * 1000).toISOString().slice(0, 10);
    const row = ensureRow(day);
    for (const m of (group.measures || [])) {
      const field = MEAS_TYPES[m.type];
      if (!field) continue;
      const real = m.value * Math.pow(10, m.unit);
      // When multiple samples exist per day we take the first; Withings orders
      // by `date` desc so first = most recent. Callers may want avg/min later.
      if (row[field] == null) row[field] = Math.round(real * 100) / 100;
    }
  }

  // Sleep summary — Withings gives nightly aggregates; sleep_score is a
  // 0-100 composite (may be null if data is thin).
  for (const s of (sleep?.series || [])) {
    const day = s?.date;
    if (!day) continue;
    const row = ensureRow(day);
    const d = s.data || {};
    if (typeof d.sleep_score === 'number') row.sleep_score = d.sleep_score;
    // hr_average from sleep summary is a reasonable RHR proxy when no scale exists
    if (row.rhr == null && typeof d.hr_min === 'number') row.rhr = d.hr_min;
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function logDebug(where, err) {
  if (isDebugMode?.()) console.warn(`[withings] ${where} failed:`, err?.message || err);
}
