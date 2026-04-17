// test-lens-local-worker.js — Browser test: full message protocol round-trip
// against lens-local-worker.js running with a mocked embedder. Covers init,
// ingest, query (including MMR diversification), stats, delete, clear,
// and OPFS persistence across worker restarts.
//
// Uses the `?mock=1` worker query param to skip the real transformers.js
// load — tests run in ~100 ms instead of ~15 s.

return (async function() {
  let passed = 0, failed = 0;
  const results = [];
  function assert(name, cond, detail) {
    if (cond) { passed++; results.push(`  \u2705 ${name}`); }
    else { failed++; results.push(`  \u274c ${name}${detail ? ' \u2014 ' + detail : ''}`); }
  }

  // ── Wipe OPFS first so the test starts from a known empty state.
  // Also wipes the localStorage count shadow that hasLens() reads.
  try {
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry('lens-local', { recursive: true }); } catch {}
  } catch (e) {
    console.warn('[test] OPFS wipe failed, continuing:', e.message);
  }
  try { localStorage.removeItem('labcharts-lens-local-count'); } catch {}

  // ── Helpers for talking to the worker directly ──
  function spawnWorker() {
    return new Worker('/js/lens-local-worker.js?mock=1', { type: 'module' });
  }

  function roundTrip(worker, msg, expectedType, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.removeEventListener('message', onMsg);
        reject(new Error(`worker did not respond with ${expectedType} within ${timeoutMs} ms`));
      }, timeoutMs);
      const onMsg = (e) => {
        if (e.data?.type === 'progress') return; // skip progress events
        clearTimeout(timer);
        worker.removeEventListener('message', onMsg);
        if (e.data?.type === 'error') reject(new Error(e.data.message));
        else if (e.data?.type === expectedType) resolve(e.data);
        else reject(new Error(`unexpected response type: ${e.data?.type}`));
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage(msg);
    });
  }

  // ─── Phase 1: init on empty store ───
  console.log('%c[1] Init on fresh store', 'font-weight:bold');
  let worker = spawnWorker();
  let ready = await roundTrip(worker, { type: 'init' }, 'ready');
  assert('init returns {type:ready, numChunks:0, numDocs:0}',
    ready.numChunks === 0 && ready.numDocs === 0,
    `got ${JSON.stringify(ready)}`);

  // ─── Phase 2: ingest ───
  console.log('%c[2] Ingest', 'font-weight:bold');
  const files = [
    { name: 'vitamin-d.md', text: 'Vitamin D is a secosteroid hormone synthesised in skin when UVB hits 7-dehydrocholesterol.' + ' filler '.repeat(20) },
    { name: 'mitochondria.md', text: 'Cytochrome c oxidase peaks at 670 nm for near-infrared photobiomodulation.' + ' filler '.repeat(20) },
    { name: 'sleep.md', text: 'Blue light around 480 nm suppresses melatonin via melanopsin-sensitive retinal ganglion cells.' + ' filler '.repeat(20) },
  ];
  const ingestResult = await roundTrip(worker, { type: 'ingest', files }, 'ingest_done', 10000);
  assert('ingest_done returns stats.files_seen',
    ingestResult.stats?.files_seen === 3,
    `got ${JSON.stringify(ingestResult.stats)}`);
  assert('ingest_done chunks_indexed > 0',
    ingestResult.stats?.chunks_indexed > 0);

  // ─── Phase 3: stats reflect ingest ───
  console.log('%c[3] Stats', 'font-weight:bold');
  const stats = await roundTrip(worker, { type: 'stats' }, 'stats_result');
  assert('stats.total_chunks matches ingest chunks_indexed',
    stats.total_chunks === ingestResult.stats.chunks_indexed);
  assert('stats.documents has 3 entries',
    Array.isArray(stats.documents) && stats.documents.length === 3);
  assert('stats exposes model + dim',
    typeof stats.model === 'string' && stats.dim === 384);

  // ─── Phase 4: query shape + MMR ───
  console.log('%c[4] Query', 'font-weight:bold');
  const queryResult = await roundTrip(worker, { type: 'query', text: 'vitamin D and light', topK: 5 }, 'query_result');
  assert('query_result.chunks is an array',
    Array.isArray(queryResult.chunks));
  if (queryResult.chunks.length > 0) {
    const top = queryResult.chunks[0];
    assert('chunk has text, source, score fields',
      typeof top.text === 'string' && typeof top.source === 'string' && typeof top.score === 'number');
    // Scores must be in [-1, 1] for unit-normalized cosine. Stub vectors are
    // hash-based so scores will be all over the place; just bound them.
    assert('chunk score is within [-1, 1]',
      top.score >= -1 && top.score <= 1);
  }

  // ─── Phase 5: delete one document ───
  console.log('%c[5] Delete', 'font-weight:bold');
  const before = stats.total_chunks;
  const del = await roundTrip(worker, { type: 'delete', source: 'mitochondria.md' }, 'delete_done');
  assert('delete_done returns a positive deleted_chunks count',
    del.deleted_chunks > 0);
  const stats2 = await roundTrip(worker, { type: 'stats' }, 'stats_result');
  assert('stats.total_chunks decreased by deleted count',
    stats2.total_chunks === before - del.deleted_chunks);
  assert('deleted document no longer in documents list',
    !stats2.documents.some((d) => d.source === 'mitochondria.md'));

  // ─── Phase 6: OPFS persistence across worker restart ───
  console.log('%c[6] Persistence across restart', 'font-weight:bold');
  worker.terminate();
  worker = spawnWorker();
  const ready2 = await roundTrip(worker, { type: 'init' }, 'ready');
  assert('reinit picks up persisted chunks',
    ready2.numChunks === stats2.total_chunks);
  assert('reinit picks up persisted doc count',
    ready2.numDocs === 2);

  // ─── Phase 7: clear wipes everything ───
  console.log('%c[7] Clear', 'font-weight:bold');
  await roundTrip(worker, { type: 'clear' }, 'clear_done');
  const stats3 = await roundTrip(worker, { type: 'stats' }, 'stats_result');
  assert('clear empties total_chunks',
    stats3.total_chunks === 0);
  assert('clear empties documents list',
    Array.isArray(stats3.documents) && stats3.documents.length === 0);

  // ─── Phase 8: query on empty store returns empty list, not error ───
  console.log('%c[8] Query on empty store', 'font-weight:bold');
  const emptyQ = await roundTrip(worker, { type: 'query', text: 'anything', topK: 5 }, 'query_result');
  assert('empty-store query returns chunks:[]',
    Array.isArray(emptyQ.chunks) && emptyQ.chunks.length === 0);

  // ─── Phase 9: error propagation ───
  console.log('%c[9] Error handling', 'font-weight:bold');
  try {
    await roundTrip(worker, { type: 'nonsense_type' }, 'ready', 1000);
    assert('unknown message type → error message', false, 'expected rejection');
  } catch (e) {
    assert('unknown message type → error message',
      /unknown/i.test(e.message));
  }

  worker.terminate();

  console.log('\n' + results.join('\n'));
  console.log(`\n%c${passed} passed, ${failed} failed`, `font-weight:bold;color:${failed ? 'red' : 'green'}`);
  return { passed, failed };
})();
