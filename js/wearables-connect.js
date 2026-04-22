// wearables-connect.js — Connect/disconnect/backfill orchestration
//
// Bridges the adapter registry (config), the vendor-specific fetcher + auth
// (wearables-oura.js, wearables-oura-auth.js), the L1 IndexedDB store, and
// the L2 summary gate. Keeps UI-side code clean of OAuth plumbing.

import { state } from './state.js';
import { saveImportedData } from './data.js';
import { adapterById } from './wearable-adapters.js';
import { upsertDailyBatch, clearSource, setMeta, getMeta, countSource } from './wearables-store.js';
import { syncWearableSummary } from './wearables-summary.js';
import { fetchOuraDailyRange, fetchOuraPersonalInfo, daysAgoIso, isoDay } from './wearables-oura.js';
import { beginOAuth, completeOAuthCallback, isOuraCallback, withFreshToken, DEFAULT_OURA_SCOPES } from './wearables-oura-auth.js';
import { getActiveProfileId } from './profile.js';
import { isDebugMode, showNotification } from './utils.js';

const BACKFILL_DAYS = 90;

// ─────────────────────────────────────────────────────────
// importedData.wearableConnections read/write
// ─────────────────────────────────────────────────────────
// Stored in the same blob as other credentials. Rides Evolu sync so the
// connection is available on the user's other devices.

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
// OAuth kick-off
// ─────────────────────────────────────────────────────────

// Starts the OAuth flow. Navigates away from the current page — control
// returns via the redirect handler in main.js (see `handleOAuthCallbackOnLoad`).
export function beginConnectOAuth(adapterId) {
  const adapter = adapterById(adapterId);
  if (!adapter) throw new Error(`Unknown adapter: ${adapterId}`);
  if (adapter.authType !== 'oauth2') throw new Error(`Adapter ${adapterId} is not OAuth2`);
  if (adapter.id !== 'oura') throw new Error(`Unsupported OAuth adapter: ${adapter.id}`);

  beginOAuth({
    clientId: adapter.oauth.clientId,
    registeredUris: adapter.oauth.redirectUris,
    scopes: adapter.oauth.scopes || DEFAULT_OURA_SCOPES,
  });
}

// Called from main.js on page load. Returns true if a callback was handled.
export async function handleOAuthCallbackOnLoad() {
  const urlParams = new URLSearchParams(window.location.search);
  if (!isOuraCallback(urlParams)) return false;

  const result = await completeOAuthCallback(urlParams);
  // Clean the URL regardless of success so the code doesn't stay in history.
  window.history.replaceState(null, '', window.location.pathname);

  if (!result.ok) {
    showNotification?.(`Oura connection failed: ${result.error}`, 'error', 5000);
    return true;
  }

  // Fetch account identity so the settings panel can show "connected as <email>".
  const info = await fetchOuraPersonalInfo(result.tokens.accessToken);
  saveConnection('oura', {
    accessToken: result.tokens.accessToken,
    refreshToken: result.tokens.refreshToken,
    expiresAt: result.tokens.expiresAt,
    scope: result.tokens.scope,
    connectedAt: new Date().toISOString(),
    account: info.ok ? info.account : null,
    lastSyncAt: 0,
  });
  showNotification?.('Oura connected — backfilling 90 days…', 'info', 3000);
  try {
    const bf = await backfillWearable('oura');
    await syncWearableSummary(getActiveProfileId(), listConnectedSources());
    showNotification?.(`Oura backfilled ${bf.rows} days`, 'success');
    if (window.navigate) window.navigate('dashboard');
  } catch (e) {
    showNotification?.(`Backfill failed: ${e.message}`, 'error', 5000);
  }
  return true;
}

// ─────────────────────────────────────────────────────────
// Per-adapter dispatch (fetch + auth refresh)
// ─────────────────────────────────────────────────────────

// Wraps a fetcher call with token refresh. On 401, does one retry with a
// forced refresh — guards against the case where the access token expired
// between our clock check and the actual API call.
async function callWithRefresh(adapter, fetcher) {
  let conn = getConnection(adapter.id);
  if (!conn) throw new Error(`Not connected: ${adapter.id}`);

  conn = await withFreshToken(conn, adapter.oauth.clientId, async (updated) => {
    saveConnection(adapter.id, updated);
  }).catch(async e => {
    if (e?.code === 'needs-reauth' || e?.status === 400 || e?.status === 401) {
      saveConnection(adapter.id, { ...conn, needsReauth: true });
      const wrap = new Error('Reconnect required');
      wrap.code = 'needs-reauth';
      throw wrap;
    }
    throw e;
  });

  try {
    return await fetcher(conn.accessToken);
  } catch (e) {
    if (e?.status !== 401) throw e;
    // Forced refresh + one retry.
    const forced = { ...conn, expiresAt: 0 };
    const refreshed = await withFreshToken(forced, adapter.oauth.clientId, async (u) => saveConnection(adapter.id, u));
    return fetcher(refreshed.accessToken);
  }
}

async function fetchRange(adapter, startDate, endDate) {
  if (adapter.id === 'oura') {
    return callWithRefresh(adapter, (token) => fetchOuraDailyRange(token, startDate, endDate));
  }
  return [];
}

// ─────────────────────────────────────────────────────────
// Backfill / incremental sync
// ─────────────────────────────────────────────────────────

export async function backfillWearable(adapterId, daysBack = BACKFILL_DAYS) {
  const adapter = adapterById(adapterId);
  if (!adapter) throw new Error(`Unknown adapter: ${adapterId}`);
  const conn = getConnection(adapterId);
  if (!conn?.accessToken) throw new Error(`Not connected: ${adapterId}`);
  const profileId = getActiveProfileId();

  const startDate = daysAgoIso(daysBack);
  const endDate = isoDay();
  const rows = await fetchRange(adapter, startDate, endDate);
  if (isDebugMode?.()) console.log(`[wearables] ${adapterId} backfill ${startDate}..${endDate}: ${rows.length} rows`);

  if (rows.length > 0) await upsertDailyBatch(profileId, rows);
  await setMeta(profileId, `last-sync:${adapterId}`, { at: Date.now(), rows: rows.length, startDate, endDate });

  const updated = { ...getConnection(adapterId), lastSyncAt: Date.now(), needsReauth: false };
  saveConnection(adapterId, updated);
  return { rows: rows.length, startDate, endDate };
}

// Incremental sync — pull from the last successful sync day (or 7d back,
// whichever is earlier, so a missed day gets backfilled).
export async function incrementalSyncWearable(adapterId) {
  const conn = getConnection(adapterId);
  if (!conn?.accessToken) return { skipped: true, reason: 'not-connected' };
  const profileId = getActiveProfileId();

  const lastSync = await getMeta(profileId, `last-sync:${adapterId}`);
  const fallbackStart = daysAgoIso(7);
  const startDate = (lastSync?.endDate && lastSync.endDate < fallbackStart) ? fallbackStart : (lastSync?.endDate || daysAgoIso(BACKFILL_DAYS));
  const endDate = isoDay();

  const adapter = adapterById(adapterId);
  const rows = await fetchRange(adapter, startDate, endDate);
  if (rows.length > 0) await upsertDailyBatch(profileId, rows);
  await setMeta(profileId, `last-sync:${adapterId}`, { at: Date.now(), rows: rows.length, startDate, endDate });

  const updated = { ...getConnection(adapterId), lastSyncAt: Date.now(), needsReauth: false };
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
    if (state.importedData?.wearableSummary?.sources?.[adapterId]) {
      delete state.importedData.wearableSummary.sources[adapterId];
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
    if (e?.code === 'needs-reauth') {
      showNotification?.('Oura needs reconnection — open Settings → Wearables', 'error', 5000);
    } else if (e?.status === 401 || e?.status === 403) {
      const conn = getConnection(adapterId);
      if (conn) saveConnection(adapterId, { ...conn, needsReauth: true });
      showNotification?.(`${adapterId} token rejected — reconnect`, 'error');
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

export async function recoverIfL1Empty(adapterId) {
  const conn = getConnection(adapterId);
  if (!conn?.accessToken) return { skipped: true };
  const profileId = getActiveProfileId();
  const n = await countSource(profileId, adapterId).catch(() => 0);
  if (n > 0) return { skipped: true, rows: n };
  if (isDebugMode?.()) console.log(`[wearables] L1 empty for ${adapterId} — recovering via backfill`);
  return backfillWearable(adapterId);
}

// ─────────────────────────────────────────────────────────
// Scheduler — only runs while the tab is open
// ─────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STALE_MS         = 12 * 60 * 60 * 1000;

let _pollTimer = null;
let _schedulerInstalled = false;

async function maybeSyncStaleSources() {
  const sources = getConnections();
  const now = Date.now();
  for (const [sid, conn] of Object.entries(sources)) {
    if (!conn?.accessToken) continue;
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
  maybeSyncStaleSources();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeSyncStaleSources();
  });
  _pollTimer = setInterval(maybeSyncStaleSources, POLL_INTERVAL_MS);
  window.addEventListener('beforeunload', () => { if (_pollTimer) clearInterval(_pollTimer); });
}
