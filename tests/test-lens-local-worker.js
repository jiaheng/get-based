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

  // ─── Phase 10: multi-library — init exposes "default" library ───
  console.log('%c[10] Multi-library: default present', 'font-weight:bold');
  worker.terminate();
  worker = spawnWorker();
  const libReady = await roundTrip(worker, { type: 'init' }, 'ready');
  assert('init returns libraries array',
    Array.isArray(libReady.libraries) && libReady.libraries.length >= 1);
  assert('init has an activeId',
    typeof libReady.activeId === 'string' && libReady.activeId.length > 0);
  assert('init has an activeName',
    typeof libReady.activeName === 'string');

  // ─── Phase 11: create a second library ───
  console.log('%c[11] Multi-library: create second', 'font-weight:bold');
  const created = await roundTrip(worker, { type: 'create_library', name: 'Research' }, 'library_created');
  assert('library_created returns generated id',
    typeof created.id === 'string' && created.id.length > 0);
  assert('library_created echoes name', created.name === 'Research');
  assert('library_created libraries list now has 2 entries',
    Array.isArray(created.libraries) && created.libraries.length >= 2);

  // ─── Phase 12: new library is isolated from default ───
  console.log('%c[12] Multi-library: isolation', 'font-weight:bold');
  await roundTrip(worker, { type: 'activate_library', libraryId: created.id }, 'ready');
  const researchStats = await roundTrip(worker, { type: 'stats' }, 'stats_result');
  assert('new library starts empty (isolated from default)',
    researchStats.total_chunks === 0 && researchStats.documents.length === 0);

  // Ingest into the new library, then switch back — the switched-to
  // library must still be empty.
  await roundTrip(worker, {
    type: 'ingest',
    files: [{ name: 'research-only.md', text: 'Content limited to the research library.' + ' filler '.repeat(20) }],
  }, 'ingest_done', 10000);
  const researchAfter = await roundTrip(worker, { type: 'stats' }, 'stats_result');
  assert('new library ingest lands in the new library',
    researchAfter.total_chunks > 0);

  // ─── Phase 13: rename ───
  console.log('%c[13] Multi-library: rename', 'font-weight:bold');
  const renamed = await roundTrip(worker, { type: 'rename_library', libraryId: created.id, name: 'Kruse Research' }, 'library_renamed');
  assert('library_renamed returns new name', renamed.name === 'Kruse Research');

  // ─── Phase 14: delete a non-active library ───
  console.log('%c[14] Multi-library: delete non-active', 'font-weight:bold');
  // Activate default, then delete Kruse Research. Active corpus must be unaffected.
  await roundTrip(worker, { type: 'activate_library', libraryId: 'default' }, 'ready');
  const defaultStats = await roundTrip(worker, { type: 'stats' }, 'stats_result');
  const deleted = await roundTrip(worker, { type: 'delete_library', libraryId: created.id }, 'library_deleted');
  assert('library_deleted returns remaining libraries',
    Array.isArray(deleted.libraries) && !deleted.libraries.some((l) => l.id === created.id));
  const defaultAfterDelete = await roundTrip(worker, { type: 'stats' }, 'stats_result');
  assert('active library stats unchanged after non-active delete',
    defaultAfterDelete.total_chunks === defaultStats.total_chunks);

  // ─── Phase 15: deleting the last library auto-creates a default ───
  console.log('%c[15] Multi-library: delete last keeps one', 'font-weight:bold');
  // Currently only "default" remains. Deleting it should auto-create a
  // fresh "My Library" rather than leaving the user with zero libraries.
  const defaultLibId = deleted.libraries[0].id;
  const afterLast = await roundTrip(worker, { type: 'delete_library', libraryId: defaultLibId }, 'library_deleted');
  assert('auto-created a fallback library (never zero)',
    afterLast.libraries.length === 1);
  assert('fallback library has empty stats',
    afterLast.numChunks === 0);

  worker.terminate();

  console.log('\n' + results.join('\n'));
  console.log(`\n%c${passed} passed, ${failed} failed`, `font-weight:bold;color:${failed ? 'red' : 'green'}`);
  return { passed, failed };
})();
