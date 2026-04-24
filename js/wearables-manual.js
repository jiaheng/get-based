// wearables-manual.js — Manual entry as a first-class wearable source.
//
// Treats user-entered weight / BP / pulse as rows in the wearables IndexedDB
// store with `source: 'manual'`. Unifies the old `importedData.biometrics`
// time-series with the wearables architecture so they render, sync, and chart
// through the same pipeline as Oura/Withings/Fitbit data.
//
// This module is intentionally small — it exposes a log helper + a one-time
// migration. The dashboard strip, per-metric source picker, and AI context
// layer all pick up 'manual' rows via the existing generic summary logic.

import { upsertDaily, upsertDailyBatch, countSource, getDaily, getMeta, setMeta } from './wearables-store.js';
import { state } from './state.js';
import { saveImportedData } from './data.js';

// Merge helper — read the existing manual row for `date` (if any), shallow-merge
// the new patch on top, write back. Needed because IDB `put` replaces the whole
// row; a user who logs BP in the morning and weight in the evening otherwise
// loses the morning's BP when the weight upsert overwrites the row.
async function _mergeManualRow(profileId, date, patch) {
  const existing = await getDaily(profileId, 'manual', date);
  const merged = { ...(existing || {}), source: 'manual', date, ...patch };
  await upsertDaily(profileId, merged);
}

// Canonical metrics manual entry covers. All four already exist in
// CANONICAL_METRICS (wearable-adapters.js) — this list just scopes what the
// manual UI exposes for entry.
export const MANUAL_METRICS = ['weight', 'bp_systolic', 'bp_diastolic', 'rhr'];

// One-time migration flag key in the wearables meta store.
const MIGRATION_FLAG = 'biometrics-migrated-v1';

/**
 * Ensure `wearableConnections.manual` exists so listConnectedSources() and
 * the dashboard strip surface 'manual' as a source. Mirrors the pattern
 * wearables-apple-health uses — no OAuth token, just a connectedAt stamp.
 * Refreshes lastSyncAt + coverageDays on every call.
 */
export function ensureManualConnection({ coverageDays = 0 } = {}) {
  if (!state.importedData) return;
  if (!state.importedData.wearableConnections) state.importedData.wearableConnections = {};
  const prev = state.importedData.wearableConnections.manual;
  const nowISO = new Date().toISOString();
  state.importedData.wearableConnections.manual = {
    source: 'manual',
    connectedAt: prev?.connectedAt || nowISO,
    lastSyncAt: Date.now(),
    coverageDays: Math.max(coverageDays, prev?.coverageDays || 0),
    needsReauth: false,
  };
  saveImportedData();
}

/**
 * Log a single manual measurement.
 *   metric: one of MANUAL_METRICS
 *   date:   'YYYY-MM-DD' — defaults to today
 *   value:  number (unit is always SI — kg, mmHg, bpm)
 *
 * Rows are upserted on the [source, date] compound key. Logging weight
 * twice on the same day overwrites — same behaviour as a wearable sync.
 */
export async function logManualMetric(profileId, metric, { date, value }) {
  if (!MANUAL_METRICS.includes(metric)) {
    throw new Error(`logManualMetric: unknown metric "${metric}"`);
  }
  if (value == null || !isFinite(value)) {
    throw new Error('logManualMetric: value must be a finite number');
  }
  const d = date || new Date().toISOString().slice(0, 10);
  await _mergeManualRow(profileId, d, { [metric]: value });
  ensureManualConnection();
}

/**
 * Log BP as a pair — matches how home cuffs report systolic + diastolic
 * (+ optional pulse) in a single reading. One row per date.
 */
export async function logManualBP(profileId, { date, systolic, diastolic, pulse }) {
  const d = date || new Date().toISOString().slice(0, 10);
  const row = { source: 'manual', date: d };
  if (systolic != null && isFinite(systolic)) row.bp_systolic = systolic;
  if (diastolic != null && isFinite(diastolic)) row.bp_diastolic = diastolic;
  if (pulse != null && isFinite(pulse)) row.rhr = pulse;
  if (!row.bp_systolic && !row.bp_diastolic && !row.rhr) return;
  // Merge rather than replace — preserves same-day weight from a prior entry.
  const { source: _s, date: _d, ...patch } = row;
  await _mergeManualRow(profileId, d, patch);
  ensureManualConnection();
}

/**
 * One-time migration — walks `importedData.biometrics.{weight,bp,pulse}` and
 * writes each entry into the wearables IndexedDB with source: 'manual'.
 *
 * Idempotent: tags the wearables meta store with a flag after a successful
 * run so re-opening the app doesn't re-insert. Returns a small summary for
 * telemetry / debug output.
 *
 * Does NOT delete the original biometrics data — the Edit Client modal keeps
 * writing there until Commit 4 of the Health Metrics unification.
 */
export async function migrateBiometricsToManual(profileId, biometrics) {
  if (!profileId) return { skipped: 'no-profile' };
  const alreadyRan = await getMeta(profileId, MIGRATION_FLAG);
  if (alreadyRan) return { skipped: 'already-migrated' };
  if (!biometrics) {
    await setMeta(profileId, MIGRATION_FLAG, { at: Date.now(), counts: {} });
    return { skipped: 'no-biometrics' };
  }

  // Group existing time-series entries by date so we write ONE row per
  // date rather than three (matches how wearable adapters emit).
  const byDate = new Map();
  const pushInto = (date, patch) => {
    if (!date) return;
    const existing = byDate.get(date) || { source: 'manual', date };
    byDate.set(date, { ...existing, ...patch });
  };

  const weight = Array.isArray(biometrics.weight) ? biometrics.weight : [];
  const bp     = Array.isArray(biometrics.bp)     ? biometrics.bp     : [];
  const pulse  = Array.isArray(biometrics.pulse)  ? biometrics.pulse  : [];

  for (const e of weight) {
    if (e?.date && typeof e.value === 'number' && isFinite(e.value)) {
      // Units in the old store can be 'kg' or 'lb'; canonicalize to kg.
      const v = e.unit === 'lb' ? e.value / 2.20462 : e.value;
      pushInto(e.date, { weight: v });
    }
  }
  for (const e of bp) {
    if (!e?.date) continue;
    const patch = {};
    if (typeof e.systolic  === 'number' && isFinite(e.systolic))  patch.bp_systolic  = e.systolic;
    if (typeof e.diastolic === 'number' && isFinite(e.diastolic)) patch.bp_diastolic = e.diastolic;
    if (Object.keys(patch).length) pushInto(e.date, patch);
  }
  for (const e of pulse) {
    if (e?.date && typeof e.value === 'number' && isFinite(e.value)) {
      pushInto(e.date, { rhr: e.value });
    }
  }

  const rows = [...byDate.values()];
  if (rows.length) {
    await upsertDailyBatch(profileId, rows);
    // Surface 'manual' as a connected source so the dashboard strip and
    // Settings → Integrations see it. Coverage = distinct dates migrated.
    ensureManualConnection({ coverageDays: rows.length });
  }

  const counts = { weight: weight.length, bp: bp.length, pulse: pulse.length, rows: rows.length };
  await setMeta(profileId, MIGRATION_FLAG, { at: Date.now(), counts });
  return { migrated: true, counts };
}

/**
 * Is `manual` a "connected" source for this profile? True when any manual
 * row exists in the wearables IDB. Used by the wearables-connect façade so
 * the dashboard strip and Settings → Integrations panel list Manual
 * alongside Oura/Withings without needing an OAuth flow.
 */
export async function hasManualData(profileId) {
  try {
    const n = await countSource(profileId, 'manual');
    return n > 0;
  } catch {
    return false;
  }
}
