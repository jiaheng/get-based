// wearables-store.js — L1 IndexedDB for raw wearable daily rows
//
// Per-profile database so wearable history doesn't leak across profiles.
// Stays on-device only; never syncs. L2 summary (in importedData) is what
// ships to Evolu.
//
// Row schema (canonical; any adapter normalizes into this shape on write):
//   { source, date, importedAt,
//     hrv_rmssd, rhr, sleep_score, readiness_score,
//     spo2_avg, body_temp_delta, glucose_avg,
//     _raw?: { /* optional debug stash */ } }
//
// Compound key [source, date] — multiple sources coexist per day (Oura +
// WHOOP + Apple Health on the same 2026-04-22 is three distinct rows).

const DB_PREFIX = 'labcharts-wearables-';
const DB_VERSION = 1;
const STORE_DAILY = 'daily-metrics';
const STORE_META = 'meta';

const _dbPromises = new Map();

function dbNameFor(profileId) {
  // Fall back to 'default' so a missing profile id still gets a valid db name.
  return DB_PREFIX + (profileId || 'default');
}

export function openWearablesDB(profileId) {
  const name = dbNameFor(profileId);
  if (_dbPromises.has(name)) return _dbPromises.get(name);
  const p = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DAILY)) {
        const store = db.createObjectStore(STORE_DAILY, { keyPath: ['source', 'date'] });
        store.createIndex('by_source', 'source', { unique: false });
        store.createIndex('by_date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { _dbPromises.delete(name); reject(req.error); };
  });
  _dbPromises.set(name, p);
  return p;
}

// Evict the cached promise so a subsequent open reconnects — useful after
// close() or when Safari evicts storage.
export function resetWearablesDB(profileId) {
  _dbPromises.delete(dbNameFor(profileId));
}

// ─────────────────────────────────────────────────────────
// Row CRUD
// ─────────────────────────────────────────────────────────

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export async function upsertDaily(profileId, row) {
  if (!row || !row.source || !row.date) throw new Error('upsertDaily requires {source, date}');
  const db = await openWearablesDB(profileId);
  const tx = db.transaction(STORE_DAILY, 'readwrite');
  tx.objectStore(STORE_DAILY).put({ importedAt: Date.now(), ...row });
  return txPromise(tx);
}

// Remove a single row by compound key. Used by deleteManualMetric when
// the last metric field on a row is cleared — otherwise stub rows pile up
// in IDB and sources.coverageDays over-counts. Idempotent (silent on
// missing key).
export async function deleteDaily(profileId, source, date) {
  const db = await openWearablesDB(profileId);
  const tx = db.transaction(STORE_DAILY, 'readwrite');
  tx.objectStore(STORE_DAILY).delete([source, date]);
  return txPromise(tx);
}

export async function upsertDailyBatch(profileId, rows) {
  if (!rows || rows.length === 0) return;
  const db = await openWearablesDB(profileId);
  const tx = db.transaction(STORE_DAILY, 'readwrite');
  const store = tx.objectStore(STORE_DAILY);
  const stamp = Date.now();
  for (const row of rows) {
    if (!row || !row.source || !row.date) continue;
    store.put({ importedAt: stamp, ...row });
  }
  return txPromise(tx);
}

export async function getDaily(profileId, source, date) {
  const db = await openWearablesDB(profileId);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DAILY, 'readonly');
    const req = tx.objectStore(STORE_DAILY).get([source, date]);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// Inclusive range query for ONE source. ISO dates; lexicographic order matches
// chronological because format is YYYY-MM-DD.
export async function getDailyRange(profileId, source, startDate, endDate) {
  const db = await openWearablesDB(profileId);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DAILY, 'readonly');
    const store = tx.objectStore(STORE_DAILY);
    const keyRange = IDBKeyRange.bound([source, startDate], [source, endDate]);
    const rows = [];
    const req = store.openCursor(keyRange);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { rows.push(cursor.value); cursor.continue(); }
      else resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

// Count rows for a given source (fast sanity check, also used by Safari-eviction recovery).
export async function countSource(profileId, source) {
  const db = await openWearablesDB(profileId);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DAILY, 'readonly');
    const idx = tx.objectStore(STORE_DAILY).index('by_source');
    const req = idx.count(IDBKeyRange.only(source));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Wipe every row for a source — used by "disconnect wearable" action.
export async function clearSource(profileId, source) {
  const db = await openWearablesDB(profileId);
  const tx = db.transaction(STORE_DAILY, 'readwrite');
  const idx = tx.objectStore(STORE_DAILY).index('by_source');
  const req = idx.openCursor(IDBKeyRange.only(source));
  req.onsuccess = () => {
    const c = req.result;
    if (c) { c.delete(); c.continue(); }
  };
  return txPromise(tx);
}

// ─────────────────────────────────────────────────────────
// Meta KV (last-sync cursors, token fingerprints, one-off flags)
// ─────────────────────────────────────────────────────────

export async function getMeta(profileId, key) {
  const db = await openWearablesDB(profileId);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readonly');
    const req = tx.objectStore(STORE_META).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.v : null);
    req.onerror = () => reject(req.error);
  });
}

export async function setMeta(profileId, key, value) {
  const db = await openWearablesDB(profileId);
  const tx = db.transaction(STORE_META, 'readwrite');
  tx.objectStore(STORE_META).put({ k: key, v: value, updatedAt: Date.now() });
  return txPromise(tx);
}

export async function deleteMeta(profileId, key) {
  const db = await openWearablesDB(profileId);
  const tx = db.transaction(STORE_META, 'readwrite');
  tx.objectStore(STORE_META).delete(key);
  return txPromise(tx);
}

// Delete the entire wearable database for this profile — used by the nuke
// path in Settings → Data.
export async function deleteWearablesDB(profileId) {
  resetWearablesDB(profileId);
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbNameFor(profileId));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // other tabs still hold it; deletion runs when they close
  });
}
