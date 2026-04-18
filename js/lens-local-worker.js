// js/lens-local-worker.js — browser-side lens engine (no Python, no server).
//
// Runs in a module Web Worker. Owns all OPFS I/O and all calls into
// transformers.js so the main thread stays responsive while a multi-minute
// ingest pass is running.
//
// Layout on disk (OPFS, origin-scoped, persistent):
//   /lens-local/manifest.json   — {numChunks, dim, modelId, indexedAt, docs: [...]}
//   /lens-local/vectors.bin     — packed Float32Array, numChunks * dim * 4 bytes
//   /lens-local/chunks.json     — array parallel to vectors: [{source, text}, …]
//
// Persistence strategy: load the full corpus into RAM on first query for this
// worker session, then serve every query from memory (cosine over 10k chunks
// is 10 ms — linear scan is fine up to ~100k). Vectors re-dehydrate from
// OPFS on worker restart.
//
// Message protocol (main ↔ worker):
//   IN:  {type: 'init'}                   → loads model, opens OPFS
//        {type: 'ingest', files: [{name, text}]}
//                                         → chunks + embeds + appends
//        {type: 'query', text, topK}      → returns top-K matches
//        {type: 'stats'}                  → per-source counts
//        {type: 'delete', source}         → drops one doc
//        {type: 'clear'}                  → wipes the store
//   OUT: {type: 'ready'}
//        {type: 'progress', stage, index, total, source?}
//        {type: 'ingest_done', stats}
//        {type: 'query_result', chunks: [{text, source, score}]}
//        {type: 'stats_result', ...}
//        {type: 'error', message}
//
// Model: Xenova/all-MiniLM-L6-v2 — 384-dim, ~90 MB quantized, MTEB ~41.
// Not the strongest embedder but the only one that runs acceptably in
// pure WASM. Browser caches it after first load.

import { chunkText, mmrSelect } from './lens-local-utils.js';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;
// Chunk target: 800 chars, overlap 50, min 50 — matches lens/src/lens/store.py
// defaults so ingest behavior is consistent across browser + Python backends.
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 50;
const CHUNK_MIN = 50;

let _embedder = null;
let _embedderBackend = 'wasm';  // 'webgpu' | 'wasm' — whichever transformers.js actually booted
let _abortRequested = false;    // set by 'abort' message, checked between embeds in handleIngest
let _rootDir = null;            // OPFS FileSystemDirectoryHandle at /lens-local/
let _libraries = [];            // [{id, name, createdAt}]
let _activeId = null;           // Currently active library id
let _manifest = null;           // Active library's manifest (loaded on activate)
let _vectors = null;            // Active library's packed Float32Array
let _chunks = null;             // Active library's [{source, text}]

const OPFS_SUBDIR = 'lens-local';
const FILE_MANIFEST = 'manifest.json';
const FILE_VECTORS = 'vectors.bin';
const FILE_CHUNKS = 'chunks.json';
const FILE_LIBRARIES = '_libraries.json'; // top-level, inside /lens-local/
const DEFAULT_LIBRARY_NAME = 'My Library';

// ── Message dispatch ───────────────────────────────────────────────
//
// Every handler (ingest, query, stats, delete, clear) scopes to the ACTIVE
// library. Library-management handlers (activate, create, rename, delete,
// list) manage _libraries metadata + OPFS subdirectories.

self.addEventListener('message', async (e) => {
  const msg = e.data || {};
  try {
    switch (msg.type) {
      case 'init':              return handleInit();
      case 'ingest':            return handleIngest(msg.files || []);
      case 'query':             return handleQuery(msg.text, msg.topK || 10);
      case 'stats':             return handleStats();
      case 'delete':            return handleDelete(msg.source);
      case 'clear':             return handleClear();
      case 'list_libraries':    return handleListLibraries();
      case 'activate_library':  return handleActivateLibrary(msg.libraryId);
      case 'create_library':    return handleCreateLibrary(msg.name);
      case 'rename_library':    return handleRenameLibrary(msg.libraryId, msg.name);
      case 'delete_library':    return handleDeleteLibrary(msg.libraryId);
      // Abort is a side-channel signal — skips the serial queue on the
      // main thread so it can interrupt an in-flight ingest. handleIngest
      // polls _abortRequested between embeds and commits whatever's been
      // indexed so far.
      case 'abort':             _abortRequested = true; return;
      default:                  throw new Error(`Unknown message type: ${msg.type}`);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
});

// ── Init: load model + open OPFS ───────────────────────────────────

async function handleInit() {
  // Test hook — `?mock=1` on the worker URL skips the real transformers.js
  // load + WebGPU probe. Uses a deterministic text-hash stub embedder so
  // tests/test-lens-local-worker.js can exercise the full message protocol
  // + OPFS roundtrip in ~50 ms without the ~15s model download. Production
  // path is unchanged.
  const params = new URLSearchParams(self.location.search || '');
  if (params.has('mock')) {
    _embedder = mockEmbedder;
    console.log('[lens-local] mock embedder active (test mode)');
    await openOpfs();
    await loadCorpusIntoMemory();
    self.postMessage(readyPayload());
    return;
  }

  // Library loads from jsdelivr — the npm-dist bundle has bare module
  // specifiers (`onnxruntime-web/webgpu` etc.) that browsers can't resolve
  // without a bundler, and jsdelivr auto-rewrites them. Pin @4.1.0 for
  // reproducibility. Browsers cache the bundle indefinitely after first
  // load; SW can cache too.
  //
  // No Subresource Integrity on this import: dynamic `import()` has no
  // integrity attribute (the spec intentionally omits it — SRI belongs
  // on <script> / <link>). The durable fix is to vendor the resolved
  // ESM locally via a bundler pass at vendor-update time; tracked as
  // phase 2c in project_browser_local_lens.md. Until then, trust is
  // rooted in jsdelivr + our CSP's cdn.jsdelivr.net allowlist.
  const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.1.0');
  // ORT picks one of 4 WASM variants at runtime (plain / asyncify / jsep /
  // jspi) based on what the browser supports — SharedArrayBuffer gates
  // threaded, cross-origin isolation headers gate jsep, etc. Vendoring
  // all four is ~75 MB; picking one is fragile because the "right" one
  // varies per browser + per deployment (COOP/COEP headers matter). For
  // now ORT fetches from its default (bundled CDN reference) which covers
  // every variant. Full vendor requires a bundler pass, tracked as phase
  // 2c — see project_browser_local_lens.md.
  // Running inside a Worker. ORT's default spawns a NESTED worker for
  // inference which is 10-15× slower than in-worker execution.
  // https://onnxruntime.ai/docs/tutorials/web/env-flags.html#envwasmproxy
  env.backends.onnx.wasm.proxy = false;

  // Try WebGPU first. On a Polaris AMD box + Intel iGPU, WebGPU through
  // ANGLE typically runs 3-10× faster than WASM for transformer
  // inference. Falls back to WASM if the adapter isn't available or the
  // pipeline init throws (some browsers expose navigator.gpu but fail at
  // shader compile for MiniLM's ops).
  let device = 'wasm';
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) device = 'webgpu';
    } catch {}
  }
  try {
    _embedder = await pipeline('feature-extraction', MODEL_ID, { device });
    _embedderBackend = device;
    console.log(`[lens-local] Embedder ready on ${device}`);
  } catch (e) {
    if (device !== 'wasm') {
      console.warn(`[lens-local] ${device} init failed, falling back to WASM:`, e?.message || e);
      _embedder = await pipeline('feature-extraction', MODEL_ID);
      _embedderBackend = 'wasm';
      device = 'wasm';
      console.log('[lens-local] Embedder ready on wasm (fallback)');
    } else {
      throw e;
    }
  }

  // Sanity-check WebGPU: some driver combos (AMD Polaris + unvalidated
  // Mesa, certain Linux/Chrome builds with enable-unsafe-webgpu) expose
  // a working adapter, init the pipeline without errors, then embed at
  // <1 token/s because shader compile falls into a slow path. A single
  // warmup embed catches this — healthy WebGPU does one in ~20-50 ms;
  // broken paths take seconds. Threshold 600 ms is generous; anything
  // above that is a broken backend, not just a cold cache.
  if (device === 'webgpu') {
    const t0 = performance.now();
    try {
      await _embedder('warmup', { pooling: 'mean', normalize: true });
      const dt = performance.now() - t0;
      if (dt > 600) {
        console.warn(`[lens-local] WebGPU pathologically slow (${dt.toFixed(0)} ms/embed), falling back to WASM`);
        _embedder = await pipeline('feature-extraction', MODEL_ID, { device: 'wasm' });
        _embedderBackend = 'wasm';
      } else {
        console.log(`[lens-local] WebGPU warmup ${dt.toFixed(0)} ms — backend confirmed`);
      }
    } catch (err) {
      console.warn('[lens-local] WebGPU warmup threw, falling back to WASM:', err?.message || err);
      _embedder = await pipeline('feature-extraction', MODEL_ID, { device: 'wasm' });
      _embedderBackend = 'wasm';
    }
  }

  await openOpfs();
  await loadCorpusIntoMemory();
  self.postMessage(readyPayload());
}

/// Shape of the `ready` message + the response from any library-management
/// op. Keeps libraries + active context in one place — every state change
/// (activate, ingest, delete, clear) re-emits this so the renderer always
/// has the current picture without re-polling.
function readyPayload() {
  return {
    type: 'ready',
    libraries: _libraries.slice(),
    activeId: _activeId,
    activeName: _libraries.find((l) => l.id === _activeId)?.name || '',
    numChunks: _manifest?.numChunks || 0,
    numDocs: _manifest?.docs?.length || 0,
  };
}

async function openOpfs() {
  const root = await navigator.storage.getDirectory();
  _rootDir = await root.getDirectoryHandle(OPFS_SUBDIR, { create: true });

  // Request persistent storage so the browser doesn't evict our data under
  // disk pressure. Silent if already granted; origins on localhost usually
  // get auto-granted. Best-effort — if the request fails we still proceed.
  try { await navigator.storage.persist?.(); } catch {}

  // Load or initialise the library registry. The registry lives at
  // /lens-local/_libraries.json and is the source of truth for which
  // libraries exist + which is active. Each library's data lives under
  // /lens-local/<libraryId>/ (manifest.json, vectors.bin, chunks.json).
  await loadOrMigrateLibraries();
  console.log('[lens-local] Libraries:', _libraries.map((l) => `${l.id}=${l.name}`).join(', '),
              'active:', _activeId);

  // Load the active library's manifest. Missing = fresh store for this
  // library, which is legitimate right after create_library.
  await loadActiveManifest();
}

/// First-run migration: if a legacy flat-layout store exists
/// (/lens-local/manifest.json at top level), move it into
/// /lens-local/default/ and create a "My Library" entry.
async function loadOrMigrateLibraries() {
  let registry = null;
  try {
    const text = await readOpfsFileFrom(_rootDir, FILE_LIBRARIES);
    registry = JSON.parse(text);
  } catch { /* no registry yet */ }

  if (registry && Array.isArray(registry.libraries) && registry.libraries.length > 0) {
    _libraries = registry.libraries;
    _activeId = registry.activeId || _libraries[0].id;
    if (!_libraries.some((l) => l.id === _activeId)) _activeId = _libraries[0].id;
    return;
  }

  // Check for legacy flat-layout store (pre-multi-library).
  let hasLegacy = false;
  try {
    await _rootDir.getFileHandle(FILE_MANIFEST);
    hasLegacy = true;
  } catch {}

  if (hasLegacy) {
    console.log('[lens-local] Migrating legacy single-library store to /default/');
    const defaultDir = await _rootDir.getDirectoryHandle('default', { create: true });
    for (const fn of [FILE_MANIFEST, FILE_VECTORS, FILE_CHUNKS]) {
      try {
        const srcBytes = await readBinaryFrom(_rootDir, fn);
        await writeBinaryTo(defaultDir, fn, new Uint8Array(srcBytes));
        await _rootDir.removeEntry(fn);
      } catch (e) {
        console.warn(`[lens-local] Migration: ${fn} skip — ${e.message}`);
      }
    }
    _libraries = [{ id: 'default', name: DEFAULT_LIBRARY_NAME, createdAt: Date.now() }];
    _activeId = 'default';
    await persistLibraries();
    return;
  }

  // Fresh install — create a single default library so the UI always has
  // something to show. User can rename it later.
  _libraries = [{ id: 'default', name: DEFAULT_LIBRARY_NAME, createdAt: Date.now() }];
  _activeId = 'default';
  await _rootDir.getDirectoryHandle('default', { create: true });
  await persistLibraries();
}

async function loadActiveManifest() {
  const dir = await activeLibraryDir();
  let manifest;
  try {
    manifest = JSON.parse(await readOpfsFileFrom(dir, FILE_MANIFEST));
    if (manifest.dim !== DIM || manifest.modelId !== MODEL_ID) {
      console.warn('[lens-local] Incompatible existing store — wiping.', manifest);
      manifest = null;
    }
  } catch { manifest = null; }

  _manifest = manifest || {
    numChunks: 0,
    dim: DIM,
    modelId: MODEL_ID,
    indexedAt: null,
    docs: [],
  };
}

async function loadCorpusIntoMemory() {
  const dir = await activeLibraryDir();
  if (_manifest.numChunks === 0) {
    _vectors = new Float32Array(0);
    _chunks = [];
    return;
  }
  let vecBytes, chunksText;
  try {
    vecBytes = await readBinaryFrom(dir, FILE_VECTORS);
    chunksText = await readOpfsFileFrom(dir, FILE_CHUNKS);
  } catch (e) {
    console.warn('[lens-local] Data file missing — resetting to empty.', e.message);
    _manifest.numChunks = 0;
    _manifest.docs = [];
    _vectors = new Float32Array(0);
    _chunks = [];
    await persistAll();
    return;
  }
  _vectors = new Float32Array(vecBytes);
  _chunks = JSON.parse(chunksText);
  const expected = _manifest.numChunks * DIM;
  if (_vectors.length !== expected || _chunks.length !== _manifest.numChunks) {
    console.warn('[lens-local] Manifest/data length mismatch — resetting to empty.');
    _manifest.numChunks = 0;
    _manifest.docs = [];
    _vectors = new Float32Array(0);
    _chunks = [];
    await persistAll();
  }
}

/// Resolve the active library's directory handle. Creates if missing
/// (shouldn't happen after init, but defensive against orphaned registry
/// entries from a partial delete).
async function activeLibraryDir() {
  if (!_activeId) throw new Error('No active library');
  return _rootDir.getDirectoryHandle(_activeId, { create: true });
}

async function persistLibraries() {
  const payload = { activeId: _activeId, libraries: _libraries };
  await writeSync(FILE_LIBRARIES, new TextEncoder().encode(JSON.stringify(payload)));
}

// ── Ingest ────────────────────────────────────────────────────────

async function handleIngest(files) {
  if (!_embedder) throw new Error('Worker not initialized');

  // Fresh run — clear any abort flag left over from a prior run that
  // raced with completion (the main thread can legitimately fire abort
  // just as we post ingest_done).
  _abortRequested = false;

  // First pass — chunk every file. We emit a "start" event with total
  // chunk count so the UI can render a bounded progress bar.
  const allChunks = [];
  for (const f of files) {
    const pieces = chunkText(String(f.text || ''), CHUNK_SIZE, CHUNK_OVERLAP, CHUNK_MIN);
    for (const piece of pieces) allChunks.push({ source: f.name, text: piece });
  }

  self.postMessage({ type: 'progress', stage: 'start', total: allChunks.length });

  // Serial per-chunk embedding. Batching was tested and hurt on WASM
  // (padding every item to the longest sequence in the batch wastes
  // compute on a backend with no parallelism to exploit). On WebGPU the
  // GPU handles parallelism internally — still no obvious batch gain.
  //
  // Abort is checked before each embed so partial progress is committed
  // cleanly: whatever chunks were indexed before the flag flipped become
  // a permanent part of the corpus. Tearing them out would waste the
  // compute the user already paid for.
  const newVectors = new Float32Array(allChunks.length * DIM);
  let indexed = 0;
  let cancelled = false;
  for (let i = 0; i < allChunks.length; i++) {
    if (_abortRequested) { cancelled = true; break; }
    const out = await _embedder(allChunks[i].text, { pooling: 'mean', normalize: true });
    newVectors.set(out.data, i * DIM);
    indexed = i + 1;
    if (i % 5 === 0 || i === allChunks.length - 1) {
      self.postMessage({
        type: 'progress', stage: 'embed',
        index: i + 1, total: allChunks.length, source: allChunks[i].source,
      });
    }
  }
  _abortRequested = false;

  // Commit only the portion actually indexed — slicing when cancelled
  // drops the trailing zeros from the pre-allocated newVectors buffer.
  const commitChunks = cancelled ? allChunks.slice(0, indexed) : allChunks;
  const commitVectors = cancelled ? newVectors.slice(0, indexed * DIM) : newVectors;

  // Merge into in-memory corpus.
  const merged = new Float32Array(_vectors.length + commitVectors.length);
  merged.set(_vectors, 0);
  merged.set(commitVectors, _vectors.length);
  _vectors = merged;
  _chunks.push(...commitChunks);

  // Merge per-doc counts into manifest.
  const perDocAdded = new Map();
  for (const c of commitChunks) perDocAdded.set(c.source, (perDocAdded.get(c.source) || 0) + 1);
  for (const [source, added] of perDocAdded) {
    const existing = _manifest.docs.find((d) => d.source === source);
    if (existing) existing.chunks += added;
    else _manifest.docs.push({ source, chunks: added });
  }
  _manifest.numChunks = _chunks.length;
  _manifest.indexedAt = Date.now();

  await persistAll();

  self.postMessage({
    type: 'ingest_done',
    stats: {
      files_seen: files.length,
      chunks_indexed: commitChunks.length,
      chunks_planned: allChunks.length,
      cancelled,
      skipped: [],
    },
  });
}

// ── Query ─────────────────────────────────────────────────────────

async function handleQuery(text, topK) {
  if (!_embedder) throw new Error('Worker not initialized');
  if (_manifest.numChunks === 0) {
    self.postMessage({ type: 'query_result', chunks: [] });
    return;
  }

  const qout = await _embedder(text, { pooling: 'mean', normalize: true });
  const q = qout.data;

  // Oversample by 3× for MMR: naive top-K by cosine alone concentrates
  // matches on whichever token dominates the query's embedding (seen in
  // "vitamin D + circadian + cold" returning 2x vit-D chunks instead of
  // mixing across all three topics). MMR picks the highest-scoring
  // candidate first, then each subsequent pick penalizes similarity to
  // already-picked chunks — spreads results across topics at a small
  // relevance cost.
  const OVERSAMPLE = Math.max(topK * 3, 30);
  const cap = Math.min(OVERSAMPLE, _manifest.numChunks);
  const candHeap = []; // sorted ascending so head is min
  for (let i = 0; i < _manifest.numChunks; i++) {
    const base = i * DIM;
    let s = 0;
    for (let j = 0; j < DIM; j++) s += q[j] * _vectors[base + j];
    if (candHeap.length < cap) {
      candHeap.push({ i, score: s });
      candHeap.sort((a, b) => a.score - b.score);
    } else if (s > candHeap[0].score) {
      candHeap[0] = { i, score: s };
      candHeap.sort((a, b) => a.score - b.score);
    }
  }
  const candidates = candHeap.reverse(); // descending by score
  // getVec returns a live subarray view into the packed store — no copy
  // per MMR iteration, hot path stays cheap.
  const chosen = mmrSelect(candidates, topK, 0.5,
    (i) => _vectors.subarray(i * DIM, (i + 1) * DIM));
  const result = chosen.map((r) => ({
    text: _chunks[r.i].text,
    source: _chunks[r.i].source,
    score: r.score,
  }));
  self.postMessage({ type: 'query_result', chunks: result });
}

// ── Stats / Delete / Clear ─────────────────────────────────────────

function handleStats() {
  self.postMessage({
    type: 'stats_result',
    total_chunks: _manifest.numChunks,
    documents: _manifest.docs.slice(),
    dim: DIM,
    model: MODEL_ID,
    backend: _embedderBackend,
  });
}

async function handleDelete(source) {
  if (!_manifest || _manifest.numChunks === 0) {
    self.postMessage({ type: 'delete_done', deleted_chunks: 0 });
    return;
  }
  // Rebuild vectors + chunks, skipping rows that match the source. Simpler
  // than a delete-mask + compact — a big store takes ~ms/1k chunks.
  const keep = new Uint8Array(_manifest.numChunks);
  let deleted = 0;
  for (let i = 0; i < _chunks.length; i++) {
    if (_chunks[i].source === source) deleted += 1;
    else keep[i] = 1;
  }
  if (deleted === 0) {
    self.postMessage({ type: 'delete_done', deleted_chunks: 0 });
    return;
  }
  const newCount = _manifest.numChunks - deleted;
  const newVec = new Float32Array(newCount * DIM);
  const newChunks = new Array(newCount);
  let w = 0;
  for (let i = 0; i < _manifest.numChunks; i++) {
    if (!keep[i]) continue;
    newVec.set(_vectors.subarray(i * DIM, (i + 1) * DIM), w * DIM);
    newChunks[w] = _chunks[i];
    w += 1;
  }
  _vectors = newVec;
  _chunks = newChunks;
  _manifest.numChunks = newCount;
  _manifest.docs = _manifest.docs.filter((d) => d.source !== source);
  await persistAll();
  self.postMessage({ type: 'delete_done', deleted_chunks: deleted });
}

async function handleClear() {
  _vectors = new Float32Array(0);
  _chunks = [];
  _manifest = {
    numChunks: 0,
    dim: DIM,
    modelId: MODEL_ID,
    indexedAt: null,
    docs: [],
  };
  await persistAll();
  self.postMessage({ type: 'clear_done' });
}

// ── Library management ──────────────────────────────────────────

function handleListLibraries() {
  self.postMessage({
    type: 'libraries_list',
    libraries: _libraries.slice(),
    activeId: _activeId,
  });
}

/// Swap the active library. Loads the new library's manifest + corpus
/// into memory; the previous library's memory is released for GC.
async function handleActivateLibrary(libraryId) {
  if (!_libraries.some((l) => l.id === libraryId)) {
    throw new Error(`No library with id "${libraryId}"`);
  }
  if (libraryId === _activeId) {
    self.postMessage(readyPayload());
    return;
  }
  _activeId = libraryId;
  await persistLibraries();
  await loadActiveManifest();
  await loadCorpusIntoMemory();
  self.postMessage(readyPayload());
}

/// Create a new library with the given display name. Generates a random
/// id for the directory — decoupled from the user-facing name so renames
/// don't require moving data.
async function handleCreateLibrary(name) {
  const label = String(name || '').trim() || 'Untitled library';
  const id = `lib-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  _libraries.push({ id, name: label, createdAt: Date.now() });
  await _rootDir.getDirectoryHandle(id, { create: true });
  await persistLibraries();
  self.postMessage({
    type: 'library_created',
    id, name: label,
    libraries: _libraries.slice(),
    activeId: _activeId,
  });
}

async function handleRenameLibrary(libraryId, name) {
  const lib = _libraries.find((l) => l.id === libraryId);
  if (!lib) throw new Error(`No library with id "${libraryId}"`);
  lib.name = String(name || '').trim() || lib.name;
  await persistLibraries();
  self.postMessage({
    type: 'library_renamed',
    id: libraryId, name: lib.name,
    libraries: _libraries.slice(),
    activeId: _activeId,
  });
}

/// Remove a library's on-disk data + registry entry. If the active
/// library is deleted, switch to the first remaining library. If this
/// would leave zero libraries, auto-create a default so the UI always
/// has something to show.
async function handleDeleteLibrary(libraryId) {
  const idx = _libraries.findIndex((l) => l.id === libraryId);
  if (idx === -1) throw new Error(`No library with id "${libraryId}"`);
  try { await _rootDir.removeEntry(libraryId, { recursive: true }); } catch {}
  _libraries.splice(idx, 1);
  if (_libraries.length === 0) {
    // Auto-create a default so the UI never has to handle an empty list.
    const id = 'default';
    _libraries = [{ id, name: DEFAULT_LIBRARY_NAME, createdAt: Date.now() }];
    _activeId = id;
    await _rootDir.getDirectoryHandle(id, { create: true });
  } else if (libraryId === _activeId) {
    _activeId = _libraries[0].id;
  }
  await persistLibraries();
  if (libraryId === _activeId || _libraries.length === 1) {
    await loadActiveManifest();
    await loadCorpusIntoMemory();
  }
  self.postMessage({
    type: 'library_deleted',
    id: libraryId,
    libraries: _libraries.slice(),
    activeId: _activeId,
    numChunks: _manifest?.numChunks || 0,
    numDocs: _manifest?.docs?.length || 0,
  });
}

// ── OPFS I/O ──────────────────────────────────────────────────────
//
// Uses FileSystemSyncAccessHandle — worker-only API, synchronous reads
// and writes, explicit flush(). More reliable than createWritable() for
// binary data and gives us a deterministic persistence boundary. Per MDN,
// SyncAccessHandle "is designed to provide fast, direct access to the
// file's contents from Web Workers" and is what the Evolu SQLite WASM
// worker uses under the hood.

async function persistAll() {
  const dir = await activeLibraryDir();
  await writeBinaryTo(dir, FILE_MANIFEST, new TextEncoder().encode(JSON.stringify(_manifest)));
  await writeBinaryTo(dir, FILE_VECTORS, new Uint8Array(_vectors.buffer, _vectors.byteOffset, _vectors.byteLength));
  await writeBinaryTo(dir, FILE_CHUNKS, new TextEncoder().encode(JSON.stringify(_chunks)));
}

/// Read a text file from a specific directory handle. Thin wrapper over
/// readBinaryFrom that UTF-8-decodes. Used for manifest.json + chunks.json
/// + _libraries.json.
async function readOpfsFileFrom(dir, name) {
  const bytes = await readBinaryFrom(dir, name);
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/// Read an entire file as an ArrayBuffer. The sync-access handle returns a
/// view backed by a scratch Uint8Array; we copy into a fresh buffer so the
/// caller can safely use .buffer without worrying about byteOffset on a
/// subarray view.
async function readBinaryFrom(dir, name) {
  const handle = await dir.getFileHandle(name);
  const sync = await handle.createSyncAccessHandle();
  try {
    const size = sync.getSize();
    const buf = new Uint8Array(size);
    sync.read(buf, { at: 0 });
    const copy = new Uint8Array(buf.byteLength);
    copy.set(buf);
    return copy.buffer;
  } finally {
    sync.close();
  }
}

/// Write bytes atomically to a specific directory: truncate + write +
/// flush + close. flush() is what guarantees the data actually hit disk
/// before we return; without it the browser may coalesce writes and lose
/// data on reload if the tab closes between write and coalesce.
async function writeBinaryTo(dir, name, bytes) {
  const handle = await dir.getFileHandle(name, { create: true });
  const sync = await handle.createSyncAccessHandle();
  try {
    sync.truncate(0);
    sync.write(bytes, { at: 0 });
    sync.flush();
  } finally {
    sync.close();
  }
}

/// Backward-compat shim: writeSync against the root lens-local/ dir. Used
/// for _libraries.json (which lives at top level, not inside any library).
async function writeSync(name, bytes) {
  return writeBinaryTo(_rootDir, name, bytes);
}

// ── Test-only: deterministic stub embedder ────────────────────────
//
// Text-hash → unit-normalized 384-float vector. Same text always maps to
// the same vector, different texts to different vectors, so cosine and
// MMR behave predictably in tests. Returns the shape transformers.js
// pipelines return: an object with a `.data` Float32Array.
async function mockEmbedder(text, _opts) {
  // Force a task-queue boundary between embeds so incoming messages
  // ('abort') can land. The real embedder's WASM/WebGPU work naturally
  // spans tasks via its internal I/O; the synchronous hash stub would
  // otherwise starve the event loop as a tight microtask chain, making
  // abort untestable. Negligible (<5 ms total) for test corpus sizes.
  await new Promise((r) => setTimeout(r, 0));
  const out = new Float32Array(DIM);
  let h = 2166136261;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  for (let i = 0; i < DIM; i++) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    out[i] = ((h | 0) / 2147483647);
  }
  // Unit-normalize so cosine == dot product (matches the real model's output).
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) out[i] /= norm;
  return { data: out };
}
