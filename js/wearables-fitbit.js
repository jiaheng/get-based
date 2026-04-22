// wearables-fitbit.js — Fitbit Web API data layer
//
// Day-granular reads per endpoint. Fitbit's API is sprawling and paginated
// unusually (per-endpoint idioms vary), so the fetcher walks a fixed set of
// endpoints per day and canonicalises the result.
//
// Endpoint map (confirmed from dev.fitbit.com/build/reference/web-api/):
//   HRV RMSSD       GET /1/user/-/hrv/date/YYYY-MM-DD.json
//   Resting HR      GET /1/user/-/activities/heart/date/YYYY-MM-DD/1d.json
//   Steps           GET /1/user/-/activities/steps/date/YYYY-MM-DD/1d.json
//   Sleep           GET /1.2/user/-/sleep/date/YYYY-MM-DD.json
//   SpO₂            GET /1/user/-/spo2/date/YYYY-MM-DD.json
//   Skin temp Δ     GET /1/user/-/temp/skin/date/YYYY-MM-DD.json
//   Respiratory     GET /1/user/-/br/date/YYYY-MM-DD.json
//   Body weight     GET /1/user/-/body/log/weight/date/YYYY-MM-DD.json
//
// Auth: Authorization: Bearer <access_token>. All endpoints support the
// same bearer; scope is enforced per-endpoint and surfaces as 401.

import { isDebugMode } from './utils.js';

const FITBIT_API = 'https://api.fitbit.com';
const PROXY_URL = '/api/proxy';

async function fbGET(path, accessToken) {
  const url = `${FITBIT_API}/${path.replace(/^\//, '')}`;
  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url, method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }),
  });
  if (!res.ok) {
    let err; try { err = await res.json(); } catch { err = { error: res.statusText }; }
    const msg = err?.errors?.[0]?.message || err?.detail || err?.message || err?.error || res.statusText || 'Fitbit request failed';
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return res.json();
}

export async function fetchFitbitPersonalInfo(accessToken) {
  try {
    const info = await fbGET('1/user/-/profile.json', accessToken);
    const u = info?.user || {};
    return { ok: true, account: { email: u.email || null, fullName: u.fullName || u.displayName || null } };
  } catch (e) {
    return { ok: false, error: e.message, status: e.status };
  }
}

export async function fetchFitbitDailyRange(accessToken, startDate, endDate) {
  const start = new Date(startDate + 'T00:00:00Z');
  const end   = new Date(endDate   + 'T00:00:00Z');
  const byDate = new Map();
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    const row = await fetchOneDay(accessToken, day);
    if (row) byDate.set(day, row);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchOneDay(accessToken, day) {
  // Fire all endpoint reads in parallel per day; any failure degrades to null
  // for that metric without taking down the whole day's row.
  const [hrv, rhr, steps, sleep, spo2, skinTemp, weight] = await Promise.all([
    fbGET(`1/user/-/hrv/date/${day}.json`, accessToken).catch(e => { logDebug('hrv',   day, e); return null; }),
    fbGET(`1/user/-/activities/heart/date/${day}/1d.json`, accessToken).catch(e => { logDebug('rhr',   day, e); return null; }),
    fbGET(`1/user/-/activities/steps/date/${day}/1d.json`, accessToken).catch(e => { logDebug('steps', day, e); return null; }),
    fbGET(`1.2/user/-/sleep/date/${day}.json`, accessToken).catch(e => { logDebug('sleep', day, e); return null; }),
    fbGET(`1/user/-/spo2/date/${day}.json`, accessToken).catch(e => { logDebug('spo2',  day, e); return null; }),
    fbGET(`1/user/-/temp/skin/date/${day}.json`, accessToken).catch(e => { logDebug('temp',  day, e); return null; }),
    fbGET(`1/user/-/body/log/weight/date/${day}.json`, accessToken).catch(e => { logDebug('weight',day, e); return null; }),
  ]);

  const row = {
    source: 'fitbit', date: day,
    hrv_rmssd: null, hrv_sdnn: null, rhr: null,
    sleep_score: null, readiness_score: null,
    activity_score: null, steps: null,
    strain: null,
    stress_high_min: null, resilience_level: null, cardio_age: null,
    weight: null, bp_systolic: null, bp_diastolic: null,
    spo2_avg: null, body_temp_delta: null, glucose_avg: null,
  };

  // HRV RMSSD — `hrv.[0].value.dailyRmssd` in the legacy shape;
  // newer Fitbit tenants expose `rmssdMilliseconds`. Accept both.
  const hrvRow = hrv?.hrv?.[0]?.value;
  if (hrvRow) {
    const v = (typeof hrvRow.dailyRmssd === 'number') ? hrvRow.dailyRmssd
            : (typeof hrvRow.rmssdMilliseconds === 'number') ? hrvRow.rmssdMilliseconds
            : null;
    if (v != null) row.hrv_rmssd = v;
  }

  // Resting heart rate — under activities-heart time series.
  const restHr = rhr?.['activities-heart']?.[0]?.value?.restingHeartRate;
  if (typeof restHr === 'number') row.rhr = restHr;

  // Steps — sum of the day; `activities-steps[0].value` is a string.
  const stepsVal = Number(steps?.['activities-steps']?.[0]?.value);
  if (isFinite(stepsVal)) row.steps = stepsVal;

  // Sleep score — Fitbit doesn't publish a 0-100 "Sleep Score" via API.
  // We surface the primary sleep's `efficiency` (0-100) as a proxy — same
  // 0-100 scale as Oura's sleep_score so the strip card stays comparable.
  const mainSleep = (sleep?.sleep || []).find(s => s.isMainSleep) || sleep?.sleep?.[0];
  if (mainSleep && typeof mainSleep.efficiency === 'number') {
    row.sleep_score = mainSleep.efficiency;
  }

  // SpO₂ — Fitbit returns `value.avg` as a percentage.
  const spo2Avg = spo2?.value?.avg;
  if (typeof spo2Avg === 'number') row.spo2_avg = spo2Avg;

  // Skin temperature deviation from baseline (°C).
  const tempNight = skinTemp?.tempSkin?.[0]?.value?.nightlyRelative;
  if (typeof tempNight === 'number') row.body_temp_delta = tempNight;

  // Body weight (kg). Fitbit can return multiple weigh-ins per day; take the
  // most recent (last entry in chronological order).
  const weighIns = weight?.weight;
  if (Array.isArray(weighIns) && weighIns.length > 0) {
    const latest = weighIns[weighIns.length - 1];
    if (typeof latest?.weight === 'number') row.weight = latest.weight;
  }

  // Skip the row entirely if every metric is null (user didn't wear the device
  // that day, or their Fitbit account has no data for that period).
  const hasAny = ['hrv_rmssd','rhr','sleep_score','steps','spo2_avg','body_temp_delta','weight']
    .some(k => row[k] != null);
  return hasAny ? row : null;
}

function logDebug(where, day, err) {
  if (isDebugMode?.()) console.warn(`[fitbit] ${where} ${day} failed:`, err?.message || err);
}
