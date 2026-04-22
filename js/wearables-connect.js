// wearables-connect.js — Connect/disconnect/backfill orchestration
//
// Bridges the adapter registry (config), the vendor-specific fetcher
// (e.g. wearables-oura.js), the L1 IndexedDB store, and the L2 summary
// gate. Keeps UI-side code (settings panel, strip) clean of auth/fetch
// plumbing.

import { state } from './state.js';
import { saveImportedData } from './data.js';
import { adapterById } from './wearable-adapters.js';
import { upsertDailyBatch, clearSource, setMeta, getMeta, countSource } from './wearables-store.js';
import { syncWearableSummary } from './wearables-summary.js';
import { verifyOuraPAT, fetchOuraDailyRange, daysAgoIso, isoDay } from './wearables-oura.js';
import { getActiveProfileId } from './profile.js';
import { isDebugMode, showNotification } from './utils.js';

const BACKFILL_DAYS = 90;

// ─────────────────────────────────────────────────────────
// importedData.wearableConnections read/write
// ─────────────────────────────────────────────────────────
// Stored in the same blob as other credentials. Rides Evolu sync so the
// connection is available on the user's other devices (Oura PATs are
// per-account, not per-device).

function getConnections() {
  if (!state.importedData) return {};
  if (!state.importedData.wearableConnections) state.importedData.wearableConnections = {};
  return state.importedData.wearableConnections;
}

export function getConnection(adapterId) {
  return getConnections()[adapterId] || null;
}

export function listConnectedSources() {
  const map = getConnections();
  const out = {};
  for (const [sid, conn] of Object.entries(map)) {
    if (conn?.connectedAt) {
      out[sid] = {
        connectedSince: conn.connectedAt,
        lastSyncAt: conn.lastSyncAt || 0,
      };
    }
  }
  return out;
}

function saveConnection(adapterId, conn) {
  const map = getConnections();
  map[adapterId] = conn;
  saveImportedData();
}

function removeConnection(adapterId) {
  const map = getConnections();
  delete map[adapterId];
  saveImportedData();
}

// ─────────────────────────────────────────────────────────
// Per-adapter dispatch
// ─────────────────────────────────────────────────────────

async function verifyCredential(adapter, credential) {
  if (adapter.id === 'oura') return verifyOuraPAT(credential);
  return { ok: false, error: `Unknown adapter: ${adapter.id}` };
}

async function fetchRange(adapter, credential, startDate, endDate) {
  if (adapter.id === 'oura') return fetchOuraDailyRange(credential, startDate, endDate);
  return [];
}

// ─────────────────────────────────────────────────────────
// Connect flow
// ─────────────────────────────────────────────────────────

export async function connectWearable(adapterId, credential) {
  const adapter = adapterById(adapterId);
  if (!adapter) throw new Error(`Unknown adapter: ${adapterId}`);
  if (!credential) throw new Error('Credential required');

  const verify = await verifyCredential(adapter, credential);
  if (!verify.ok) throw new Error(verify.error || 'Credential rejected');

  saveConnection(adapterId, {
    credential,
    connectedAt: new Date().toISOString(),
    account: verify.account || null,
    lastSyncAt: 0,
  });
  return { adapter, account: verify.account };
}

export async function backfillWearable(adapterId, daysBack = BACKFILL_DAYS) {
  const adapter = adapterById(adapterId);
  if (!adapter) throw new Error(`Unknown adapter: ${adapterId}`);
  const conn = getConnection(adapterId);
  if (!conn?.credential) throw new Error(`Not connected: ${adapterId}`);
  const profileId = getActiveProfileId();

  const startDate = daysAgoIso(daysBack);
  const endDate = isoDay();
  const rows = await fetchRange(adapter, conn.credential, startDate, endDate);
  if (isDebugMode?.()) console.log(`[wearables] ${adapterId} backfill ${startDate}..${endDate}: ${rows.length} rows`);

  if (rows.length > 0) await upsertDailyBatch(profileId, rows);
  await setMeta(profileId, `last-sync:${adapterId}`, { at: Date.now(), rows: rows.length, startDate, endDate });

  // Stamp the lastSyncAt on the connection blob too (syncs cross-device).
  const updated = { ...getConnection(adapterId), lastSyncAt: Date.now() };
  saveConnection(adapterId, updated);

  return { rows: rows.length, startDate, endDate };
}

// Incremental sync — pull from the last successful sync day (or 7d back,
// whichever is earlier, so a missed day gets backfilled).
export async function incrementalSyncWearable(adapterId) {
  const conn = getConnection(adapterId);
  if (!conn?.credential) return { skipped: true, reason: 'not-connected' };
  const profileId = getActiveProfileId();

  const lastSync = await getMeta(profileId, `last-sync:${adapterId}`);
  const fallbackStart = daysAgoIso(7);
  const startDate = (lastSync?.endDate && lastSync.endDate < fallbackStart) ? fallbackStart : (lastSync?.endDate || daysAgoIso(BACKFILL_DAYS));
  const endDate = isoDay();

  const adapter = adapterById(adapterId);
  const rows = await fetchRange(adapter, conn.credential, startDate, endDate);
  if (rows.length > 0) await upsertDailyBatch(profileId, rows);
  await setMeta(profileId, `last-sync:${adapterId}`, { at: Date.now(), rows: rows.length, startDate, endDate });

  const updated = { ...getConnection(adapterId), lastSyncAt: Date.now() };
  saveConnection(adapterId, updated);
  return { rows: rows.length, startDate, endDate };
}

// ─────────────────────────────────────────────────────────
// Disconnect
// ─────────────────────────────────────────────────────────

export async function disconnectWearable(adapterId, { deleteData = true } = {}) {
  const profileId = getActiveProfileId();
  removeConnection(adapterId);
  if (deleteData) {
    try { await clearSource(profileId, adapterId); } catch (e) { if (isDebugMode?.()) console.warn('[wearables] clearSource failed:', e.message); }
    // Remove this source's slice from L2 summary too.
    if (state.importedData?.wearableSummary?.sources?.[adapterId]) {
      delete state.importedData.wearableSummary.sources[adapterId];
      // If no sources left, drop the whole summary.
      if (Object.keys(state.importedData.wearableSummary.sources).length === 0) {
        delete state.importedData.wearableSummary;
      }
      saveImportedData();
    }
  }
}

// ─────────────────────────────────────────────────────────
// Top-level orchestrator: sync one source end-to-end
// ─────────────────────────────────────────────────────────

export async function syncNow(adapterId) {
  const profileId = getActiveProfileId();
  try {
    const res = await incrementalSyncWearable(adapterId);
    if (res.skipped) return res;
    await syncWearableSummary(profileId, listConnectedSources());
    return res;
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      // Mark connection as needing-reauth but don't auto-delete data.
      const conn = getConnection(adapterId);
      if (conn) saveConnection(adapterId, { ...conn, needsReauth: true });
      showNotification?.(`${adapterId} needs reconnection — token rejected`, 'error');
    } else {
      if (isDebugMode?.()) console.warn(`[wearables] syncNow ${adapterId} failed:`, e.message);
      showNotification?.(`Sync failed: ${e.message}`, 'error', 4000);
    }
    throw e;
  }
}

export async function syncAllConnected() {
  const sources = listConnectedSources();
  const results = {};
  for (const sid of Object.keys(sources)) {
    try { results[sid] = await syncNow(sid); }
    catch (e) { results[sid] = { error: e.message }; }
  }
  return results;
}

// Safari-eviction / reinstall recovery: if the L1 store is empty but the
// connection blob exists, re-run backfill silently so the dashboard strip
// isn't dark after a storage wipe.
export async function recoverIfL1Empty(adapterId) {
  const conn = getConnection(adapterId);
  if (!conn?.credential) return { skipped: true };
  const profileId = getActiveProfileId();
  const n = await countSource(profileId, adapterId).catch(() => 0);
  if (n > 0) return { skipped: true, rows: n };
  if (isDebugMode?.()) console.log(`[wearables] L1 empty for ${adapterId} — recovering via backfill`);
  return backfillWearable(adapterId);
}

// ─────────────────────────────────────────────────────────
// Scheduler — only runs while the tab is open
// ─────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6h
const STALE_MS         = 12 * 60 * 60 * 1000;  // sync if last attempt > 12h ago

let _pollTimer = null;
let _schedulerInstalled = false;

async function maybeSyncStaleSources() {
  const sources = getConnections();
  const now = Date.now();
  for (const [sid, conn] of Object.entries(sources)) {
    if (!conn?.credential) continue;
    if (conn.needsReauth) continue;
    const last = conn.lastSyncAt || 0;
    if (now - last < STALE_MS) continue;
    try {
      await recoverIfL1Empty(sid);
      await syncNow(sid);
    } catch (e) { if (isDebugMode?.()) console.warn(`[wearables] scheduled sync ${sid} failed:`, e.message); }
  }
}

export function initWearableScheduler() {
  if (_schedulerInstalled) return;
  _schedulerInstalled = true;
  // First pass when the app boots.
  maybeSyncStaleSources();
  // Re-check whenever the tab becomes visible (longest gap in browser-only polling).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeSyncStaleSources();
  });
  // Background tick while open. Cleared on unload so we don't leak timers in tests.
  _pollTimer = setInterval(maybeSyncStaleSources, POLL_INTERVAL_MS);
  window.addEventListener('beforeunload', () => { if (_pollTimer) clearInterval(_pollTimer); });
}
