// js/lens-local.js — browser-side lens engine, main-thread API.
//
// Implements the same surface as js/lens.js's queryLens(query) so the chat
// callsites don't care which backend is serving them. Delegates all real
// work to js/lens-local-worker.js — model inference, OPFS I/O, embedding.
//
// Usage:
//   const lens = await openLocalLens();
//   await lens.ingest([{name: 'notes.md', text: '…'}]);
//   const { chunks } = await lens.query('vitamin D', 10);
//   const stats = await lens.getStats();
//
// Single worker per tab, lazily initialised on first call. Messages queue
// so a query issued during an ingest waits its turn rather than racing.

let _worker = null;
let _ready = null;
let _inflight = null; // { type, resolve, reject }
const _progressSubs = new Set();

function ensureWorker() {
  if (_worker) return _worker;
  _worker = new Worker(new URL('./lens-local-worker.js', import.meta.url), {
    type: 'module',
  });
  _worker.addEventListener('message', (e) => {
    const msg = e.data || {};
    switch (msg.type) {
      case 'progress':
        for (const fn of _progressSubs) { try { fn(msg); } catch {} }
        return;
      case 'ready':
      case 'ingest_done':
      case 'query_result':
      case 'stats_result':
      case 'delete_done':
      case 'clear_done':
        if (_inflight) { _inflight.resolve(msg); _inflight = null; }
        return;
      case 'error':
        if (_inflight) { _inflight.reject(new Error(msg.message)); _inflight = null; }
        return;
    }
  });
  _worker.addEventListener('error', (e) => {
    if (_inflight) {
      _inflight.reject(new Error(e.message || 'Worker error'));
      _inflight = null;
    }
  });
  return _worker;
}

// Simple serial queue — enforces one request at a time. transformers.js
// doesn't tolerate reentrant inference calls, and OPFS writes can race
// against each other, so strict serialization is the safe default.
let _queue = Promise.resolve();
function send(msg) {
  _queue = _queue.then(() => new Promise((resolve, reject) => {
    _inflight = { type: msg.type, resolve, reject };
    ensureWorker().postMessage(msg);
  }));
  return _queue;
}

export async function openLocalLens() {
  if (_ready) return _ready;
  _ready = (async () => {
    const ready = await send({ type: 'init' });
    return {
      numChunks: ready.numChunks,
      numDocs: ready.numDocs,
      ingest: (files) => send({ type: 'ingest', files }).then((r) => r.stats),
      query: (text, topK = 10) => send({ type: 'query', text, topK }).then((r) => r.chunks),
      getStats: () => send({ type: 'stats' }).then((r) => ({
        total_chunks: r.total_chunks,
        documents: r.documents,
        dim: r.dim,
        model: r.model,
      })),
      deleteDocument: (source) => send({ type: 'delete', source }).then((r) => r.deleted_chunks),
      clear: () => send({ type: 'clear' }),
    };
  })();
  return _ready;
}

/// Subscribe to ingest progress events. Returns an unsubscribe function.
/// Emits { stage: 'start', total } once, then repeated
/// { stage: 'embed', index, total, source } during the embed pass.
export function subscribeProgress(fn) {
  _progressSubs.add(fn);
  return () => _progressSubs.delete(fn);
}

/// Drop-in for the existing queryLens() in js/lens.js. Returns the same
/// shape (or null if not configured) so chat.js doesn't need to know
/// which backend answered.
export async function queryLensLocal(queryHint, opts = {}) {
  const hint = String(queryHint || '').trim();
  if (!hint) return null;
  const lens = await openLocalLens();
  const chunks = await lens.query(hint, opts.topK || 10);
  // Filter against a minimum similarity — mirrors the server's
  // similarity_floor env. 0.3 is permissive enough for MiniLM.
  const floor = typeof opts.floor === 'number' ? opts.floor : 0.3;
  const kept = chunks.filter((c) => c.score >= floor);
  return { chunks: kept, sourceName: 'Local (browser)' };
}
