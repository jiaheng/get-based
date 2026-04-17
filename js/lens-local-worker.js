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
let _rootDir = null;            // OPFS FileSystemDirectoryHandle
let _manifest = null;           // { numChunks, dim, modelId, indexedAt, docs: [{source, chunks}] }
let _vectors = null;            // Float32Array of all vectors, length = numChunks * dim
let _chunks = null;             // [{source, text}], length = numChunks

const OPFS_SUBDIR = 'lens-local';
const FILE_MANIFEST = 'manifest.json';
const FILE_VECTORS = 'vectors.bin';
const FILE_CHUNKS = 'chunks.json';

// ── Message dispatch ───────────────────────────────────────────────

self.addEventListener('message', async (e) => {
  const msg = e.data || {};
  try {
    switch (msg.type) {
      case 'init':        return handleInit();
      case 'ingest':      return handleIngest(msg.files || []);
      case 'query':       return handleQuery(msg.text, msg.topK || 10);
      case 'stats':       return handleStats();
      case 'delete':      return handleDelete(msg.source);
      case 'clear':       return handleClear();
      default:            throw new Error(`Unknown message type: ${msg.type}`);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
});

// ── Init: load model + open OPFS ───────────────────────────────────

async function handleInit() {
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
    _embedder = await pipeline('feature-extraction', MODEL_ID, {
      device,
      dtype: device === 'webgpu' ? 'fp32' : 'q8',
    });
    console.log(`[lens-local] Embedder ready on ${device}`);
  } catch (e) {
    if (device !== 'wasm') {
      console.warn(`[lens-local] ${device} init failed, falling back to WASM:`, e?.message || e);
      _embedder = await pipeline('feature-extraction', MODEL_ID);
      console.log('[lens-local] Embedder ready on wasm (fallback)');
    } else {
      throw e;
    }
  }

  await openOpfs();
  await loadCorpusIntoMemory();
  self.postMessage({
    type: 'ready',
    numChunks: _manifest.numChunks,
    numDocs: _manifest.docs.length,
  });
}

async function openOpfs() {
  const root = await navigator.storage.getDirectory();
  _rootDir = await root.getDirectoryHandle(OPFS_SUBDIR, { create: true });

  // Request persistent storage so the browser doesn't evict our data under
  // disk pressure. Silent if already granted; origins on localhost usually
  // get auto-granted. Best-effort — if the request fails we still proceed.
  try { await navigator.storage.persist?.(); } catch {}

  // Diagnostic: list what's actually in the OPFS dir on boot. Shows in
  // the main thread's DevTools console so persistence problems are
  // visible without any UI work.
  const foundFiles = [];
  try {
    for await (const [name] of _rootDir.entries()) foundFiles.push(name);
  } catch (e) {
    console.warn('[lens-local] OPFS listing failed:', e);
  }
  console.log('[lens-local] OPFS dir contents on boot:', foundFiles);

  // Manifest first — drives everything else. Missing = fresh store.
  let manifest;
  try {
    manifest = JSON.parse(await readOpfsFile(FILE_MANIFEST));
    if (manifest.dim !== DIM || manifest.modelId !== MODEL_ID) {
      // Incompatible previous store (dim or model changed). Safer to wipe
      // than to surface garbage results from stale embeddings.
      console.warn('[lens-local] Incompatible existing store — wiping.', manifest);
      manifest = null;
    } else {
      console.log('[lens-local] Loaded manifest:', {
        numChunks: manifest.numChunks,
        docs: manifest.docs.length,
      });
    }
  } catch (e) {
    console.log('[lens-local] No existing manifest:', e?.message || 'missing');
    manifest = null;
  }

  _manifest = manifest || {
    numChunks: 0,
    dim: DIM,
    modelId: MODEL_ID,
    indexedAt: null,
    docs: [],
  };
}

async function loadCorpusIntoMemory() {
  if (_manifest.numChunks === 0) {
    _vectors = new Float32Array(0);
    _chunks = [];
    return;
  }
  const vecBytes = await readOpfsBinary(FILE_VECTORS);
  _vectors = new Float32Array(vecBytes);
  _chunks = JSON.parse(await readOpfsFile(FILE_CHUNKS));
  // Sanity check — a partial write could leave these out of sync.
  const expected = _manifest.numChunks * DIM;
  if (_vectors.length !== expected || _chunks.length !== _manifest.numChunks) {
    console.warn('[lens-local] Manifest/data length mismatch — resetting to empty.', {
      expectedVecLen: expected,
      gotVecLen: _vectors.length,
      expectedChunks: _manifest.numChunks,
      gotChunks: _chunks.length,
    });
    _manifest.numChunks = 0;
    _manifest.docs = [];
    _vectors = new Float32Array(0);
    _chunks = [];
    await persistAll();
  }
}

// ── Ingest ────────────────────────────────────────────────────────

async function handleIngest(files) {
  if (!_embedder) throw new Error('Worker not initialized');

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
  const newVectors = new Float32Array(allChunks.length * DIM);
  for (let i = 0; i < allChunks.length; i++) {
    const out = await _embedder(allChunks[i].text, { pooling: 'mean', normalize: true });
    newVectors.set(out.data, i * DIM);
    if (i % 5 === 0 || i === allChunks.length - 1) {
      self.postMessage({
        type: 'progress', stage: 'embed',
        index: i + 1, total: allChunks.length, source: allChunks[i].source,
      });
    }
  }

  // Merge into in-memory corpus.
  const merged = new Float32Array(_vectors.length + newVectors.length);
  merged.set(_vectors, 0);
  merged.set(newVectors, _vectors.length);
  _vectors = merged;
  _chunks.push(...allChunks);

  // Merge per-doc counts into manifest.
  const perDocAdded = new Map();
  for (const c of allChunks) perDocAdded.set(c.source, (perDocAdded.get(c.source) || 0) + 1);
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
    stats: { files_seen: files.length, chunks_indexed: allChunks.length, skipped: [] },
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

// ── OPFS I/O ──────────────────────────────────────────────────────
//
// Uses FileSystemSyncAccessHandle — worker-only API, synchronous reads
// and writes, explicit flush(). More reliable than createWritable() for
// binary data and gives us a deterministic persistence boundary. Per MDN,
// SyncAccessHandle "is designed to provide fast, direct access to the
// file's contents from Web Workers" and is what the Evolu SQLite WASM
// worker uses under the hood.

async function persistAll() {
  await writeSync(FILE_MANIFEST, new TextEncoder().encode(JSON.stringify(_manifest)));
  await writeSync(FILE_VECTORS, new Uint8Array(_vectors.buffer, _vectors.byteOffset, _vectors.byteLength));
  await writeSync(FILE_CHUNKS, new TextEncoder().encode(JSON.stringify(_chunks)));
}

async function readOpfsFile(name) {
  const bytes = await readSync(name);
  return new TextDecoder().decode(bytes);
}

async function readOpfsBinary(name) {
  const bytes = await readSync(name);
  // Copy into a fresh ArrayBuffer so the caller can safely use .buffer
  // without worrying about byteOffset on a subarray view.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/// Read entire file as Uint8Array. Returns empty Uint8Array if the file
/// doesn't exist (caller can distinguish by byteLength === 0 if needed).
async function readSync(name) {
  const handle = await _rootDir.getFileHandle(name);
  const sync = await handle.createSyncAccessHandle();
  try {
    const size = sync.getSize();
    const buf = new Uint8Array(size);
    sync.read(buf, { at: 0 });
    return buf;
  } finally {
    sync.close();
  }
}

/// Write bytes atomically: truncate + write + flush + close. flush() is
/// what guarantees the data actually hit disk before we return; without
/// it the browser may coalesce writes and lose data on reload if the tab
/// closes between write and coalesce.
async function writeSync(name, bytes) {
  const handle = await _rootDir.getFileHandle(name, { create: true });
  const sync = await handle.createSyncAccessHandle();
  try {
    sync.truncate(0);
    sync.write(bytes, { at: 0 });
    sync.flush();
  } finally {
    sync.close();
  }
}
