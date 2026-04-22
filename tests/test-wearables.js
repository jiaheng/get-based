// test-wearables.js — Wearable adapter registry + L1 store + L2 summary + AI context

return (async function() {
  let pass = 0, fail = 0;
  function assert(name, condition, detail) {
    if (condition) { pass++; console.log(`%c PASS %c ${name}`, 'background:#22c55e;color:#fff;padding:2px 6px;border-radius:3px', '', detail || ''); }
    else { fail++; console.error(`%c FAIL %c ${name}`, 'background:#ef4444;color:#fff;padding:2px 6px;border-radius:3px', '', detail || ''); }
  }

  console.log('%c Wearables Tests ', 'background:#6366f1;color:#fff;font-size:14px;padding:4px 12px;border-radius:4px');

  const reg = await import('../js/wearable-adapters.js');
  const store = await import('../js/wearables-store.js');
  const summary = await import('../js/wearables-summary.js');
  const labCtx = await import('../js/lab-context.js');
  const oauth = await import('../js/wearables-oura-auth.js');

  // ═══════════════════════════════════════
  // 1. Registry shape
  // ═══════════════════════════════════════
  console.log('%c 1. Registry ', 'font-weight:bold;color:#f59e0b');

  assert('ADAPTERS is array', Array.isArray(reg.ADAPTERS));
  assert('Has Oura adapter', reg.ADAPTERS.some(a => a.id === 'oura'));
  const ouraAdapter = reg.adapterById('oura');
  assert('Oura authType is oauth2', ouraAdapter?.authType === 'oauth2');
  assert('Oura has oauth.clientId',
    typeof ouraAdapter?.oauth?.clientId === 'string' && ouraAdapter.oauth.clientId.length > 10);
  assert('Oura has redirect URIs registered', Array.isArray(ouraAdapter?.oauth?.redirectUris) && ouraAdapter.oauth.redirectUris.length > 0);
  assert('Oura redirect URIs include localhost for dev',
    ouraAdapter.oauth.redirectUris.some(u => u.startsWith('http://localhost')));
  assert('Oura scopes include personal', ouraAdapter?.oauth?.scopes?.includes('personal'));
  assert('CANONICAL_METRICS has hrv_rmssd', !!reg.CANONICAL_METRICS.hrv_rmssd);
  assert('CANONICAL_METRICS has rhr', !!reg.CANONICAL_METRICS.rhr);
  assert('DEFAULT_METRIC_ORDER is array', Array.isArray(reg.DEFAULT_METRIC_ORDER));
  assert('Default order contains 4 core metrics', reg.DEFAULT_METRIC_ORDER.length >= 4);
  const oura = reg.adapterById('oura');
  assert('adapterById(oura) found', oura?.id === 'oura');
  assert('Oura supports hrv_rmssd', reg.adapterSupportsMetric('oura', 'hrv_rmssd'));
  assert('Oura does not support bogus metric', !reg.adapterSupportsMetric('oura', 'bogus'));
  const ouraMetrics = reg.metricsForSources(['oura']);
  assert('metricsForSources returns in DEFAULT order', ouraMetrics[0] === 'hrv_rmssd');
  assert('metricsForSources includes all 4 core', ['hrv_rmssd','rhr','sleep_score','readiness_score'].every(id => ouraMetrics.includes(id)));

  // ═══════════════════════════════════════
  // 2. L1 IndexedDB CRUD
  // ═══════════════════════════════════════
  console.log('%c 2. L1 IndexedDB ', 'font-weight:bold;color:#f59e0b');

  const TEST_PROFILE = '__test-wearables-' + Math.random().toString(36).slice(2, 8);
  try {
    await store.upsertDaily(TEST_PROFILE, {
      source: 'oura', date: '2026-04-20',
      hrv_rmssd: 52, rhr: 58, sleep_score: 85, readiness_score: 84,
    });
    const got = await store.getDaily(TEST_PROFILE, 'oura', '2026-04-20');
    assert('upsertDaily + getDaily round-trip', got?.hrv_rmssd === 52 && got?.date === '2026-04-20');

    // Batch insert
    const batch = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date('2026-03-01'); d.setUTCDate(d.getUTCDate() + i);
      batch.push({ source: 'oura', date: d.toISOString().slice(0, 10), hrv_rmssd: 50 + (i % 5), rhr: 60, sleep_score: 80, readiness_score: 82 });
    }
    await store.upsertDailyBatch(TEST_PROFILE, batch);
    const range = await store.getDailyRange(TEST_PROFILE, 'oura', '2026-03-01', '2026-03-30');
    assert('Batch upsert + range query returns 30 rows', range.length === 30, `got ${range.length}`);
    assert('Range rows sorted ascending by date', range[0].date === '2026-03-01' && range[29].date === '2026-03-30');

    const n = await store.countSource(TEST_PROFILE, 'oura');
    assert('countSource returns total', n === 31); // 30 batch + 1 earlier

    await store.setMeta(TEST_PROFILE, 'last-sync:oura', { at: 12345, rows: 7 });
    const meta = await store.getMeta(TEST_PROFILE, 'last-sync:oura');
    assert('Meta KV round-trip', meta?.at === 12345 && meta?.rows === 7);

    await store.clearSource(TEST_PROFILE, 'oura');
    const afterClear = await store.countSource(TEST_PROFILE, 'oura');
    assert('clearSource wipes all rows for that source', afterClear === 0);

    await store.deleteWearablesDB(TEST_PROFILE);
  } catch (e) {
    assert('IDB path did not throw', false, e.message);
  }

  // ═══════════════════════════════════════
  // 3. L2 summary derivation (pure)
  // ═══════════════════════════════════════
  console.log('%c 3. L2 Summary Math ', 'font-weight:bold;color:#f59e0b');

  function makeRows(start, n, hrvFn) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(start); d.setUTCDate(d.getUTCDate() + i);
      rows.push({ source: 'oura', date: d.toISOString().slice(0, 10),
        hrv_rmssd: hrvFn(i), rhr: 60, sleep_score: 82, readiness_score: 82 });
    }
    return rows;
  }
  const declining = makeRows('2026-01-22', 90, i => {
    if (i < 70) return 52;        // stable baseline
    return 52 - (i - 70) * 1.2;   // last 20 days decline
  });
  const sum = summary.computeWearableSummary(
    { oura: declining },
    { oura: { connectedSince: '2026-01-22', lastSyncAt: Date.now() } }
  );
  assert('Summary has sources.oura', !!sum.sources?.oura);
  assert('Summary has metrics.hrv_rmssd', !!sum.metrics?.hrv_rmssd);
  const hrv = sum.metrics.hrv_rmssd;
  assert('HRV primarySource = oura', hrv.primarySource === 'oura');
  assert('HRV latest is most recent (declining)', hrv.latest < 52);
  assert('HRV baseline ~52 (median of mostly-stable)', Math.abs(hrv.baseline - 52) < 3, `baseline=${hrv.baseline}`);
  assert('HRV trend30d is declining', hrv.trend30d === 'declining', hrv.trend30d);
  assert('Weekly has up to 12 entries', hrv.weekly.length <= 12 && hrv.weekly.length > 0);
  assert('Rolling d7 < d90 on declining series', hrv.rolling.d7 < hrv.rolling.d90);

  // ═══════════════════════════════════════
  // 4. shouldWriteL2 gate
  // ═══════════════════════════════════════
  console.log('%c 4. L2 Write Gate ', 'font-weight:bold;color:#f59e0b');

  const baseSummary = summary.computeWearableSummary(
    { oura: makeRows('2026-01-22', 90, () => 52) },
    { oura: { connectedSince: '2026-01-22', lastSyncAt: Date.now() } }
  );
  const driftSummary = summary.computeWearableSummary(
    { oura: makeRows('2026-01-22', 90, () => 52.5) }, // ~1% drift
    { oura: { connectedSince: '2026-01-22', lastSyncAt: Date.now() } }
  );
  const bigShiftSummary = summary.computeWearableSummary(
    { oura: makeRows('2026-01-22', 90, i => i > 80 ? 40 : 52) }, // ~23% shift on d7
    { oura: { connectedSince: '2026-01-22', lastSyncAt: Date.now() } }
  );

  assert('Gate: initial writes', summary.shouldWriteL2(baseSummary, null).write === true);
  assert('Gate: tiny drift does NOT write', summary.shouldWriteL2(driftSummary, baseSummary).write === false);
  assert('Gate: big d7 shift DOES write',    summary.shouldWriteL2(bigShiftSummary, baseSummary).write === true);
  // Min cadence: pretend old is 15 days old
  const stale = JSON.parse(JSON.stringify(baseSummary));
  stale.summaryUpdatedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const minCadenceRes = summary.shouldWriteL2(driftSummary, stale);
  assert('Gate: 15d-stale L2 forces write regardless of drift', minCadenceRes.write === true, minCadenceRes.reason);

  // Trend flip → anomaly event. Use a 0.5/day rise so normalized slope clears
  // the production 'rising' threshold (0.002 of baseline).
  const risingSummary = summary.computeWearableSummary(
    { oura: makeRows('2026-01-22', 90, i => 52 + i * 0.5) },
    { oura: { connectedSince: '2026-01-22', lastSyncAt: Date.now() } }
  );
  const flipRes = summary.shouldWriteL2(risingSummary, baseSummary);
  const hasFlipEvent = flipRes.anomalyEvents?.some(e => e.kind === 'trend-flip' && e.metricId === 'hrv_rmssd');
  assert('Gate: trend flip emits anomaly event', hasFlipEvent, `events: ${JSON.stringify(flipRes.anomalyEvents)}`);

  // ═══════════════════════════════════════
  // 5. buildWearableContext
  // ═══════════════════════════════════════
  console.log('%c 5. AI Context ', 'font-weight:bold;color:#f59e0b');

  const noSummaryCtx = labCtx.buildWearableContext({});
  assert('No summary → empty context', noSummaryCtx === '');

  const testImported = {
    wearableSummary: bigShiftSummary,
    changeHistory: [
      { ts: Date.now(), type: 'wearable', kind: 'trend-flip', metricId: 'hrv_rmssd', from: 'flat', to: 'declining', message: 'hrv_rmssd trend flipped from flat to declining' },
    ],
  };
  const ctx = labCtx.buildWearableContext(testImported);
  assert('Context non-empty with summary', ctx.length > 0);
  assert('Context includes "Wearables" header', ctx.includes('## Wearables'));
  assert('Context includes HRV metric', ctx.includes('HRV'));
  assert('Context includes weekly trend block', ctx.includes('Weekly trend'));
  assert('Context includes anomaly from history', ctx.includes('Recent anomalies') && ctx.includes('trend flipped'));
  assert('Context size under 2 KB', ctx.length < 2048, `size ${ctx.length}`);

  assert('isWearableContextEnabled default ON', labCtx.isWearableContextEnabled() === true);
  labCtx.setWearableContextEnabled(false);
  assert('setWearableContextEnabled(false) → disabled', labCtx.isWearableContextEnabled() === false);
  labCtx.setWearableContextEnabled(true);
  assert('Re-enable toggle', labCtx.isWearableContextEnabled() === true);

  // ═══════════════════════════════════════
  // 6. OAuth2 helpers (authorize URL, state CSRF)
  // ═══════════════════════════════════════
  console.log('%c 6. OAuth2 Helpers ', 'font-weight:bold;color:#f59e0b');

  const clientId = ouraAdapter.oauth.clientId;
  const redirectUri = ouraAdapter.oauth.redirectUris[0];

  // buildAuthorizeUrl produces a well-formed URL with required params
  const authUrl = oauth.buildAuthorizeUrl({
    clientId, redirectUri, scopes: ['personal', 'daily'], state: 'abc123',
  });
  const authParsed = new URL(authUrl);
  assert('Authorize URL goes to cloud.ouraring.com', authParsed.hostname === 'cloud.ouraring.com');
  assert('Authorize URL path is /oauth/authorize', authParsed.pathname === '/oauth/authorize');
  assert('Authorize URL has client_id', authParsed.searchParams.get('client_id') === clientId);
  assert('Authorize URL has redirect_uri', authParsed.searchParams.get('redirect_uri') === redirectUri);
  assert('Authorize URL is server-side flow (response_type=code)', authParsed.searchParams.get('response_type') === 'code');
  assert('Authorize URL carries state param', authParsed.searchParams.get('state') === 'abc123');
  assert('Authorize URL has scope list space-joined', authParsed.searchParams.get('scope') === 'personal daily');

  // pickRedirectUri prefers the one that matches current origin+path
  const fakeLoc = { origin: 'http://localhost:8000', pathname: '/app' };
  const picked = oauth.pickRedirectUri(ouraAdapter.oauth.redirectUris, fakeLoc);
  assert('pickRedirectUri returns localhost URI when on localhost', picked === 'http://localhost:8000/app');

  // completeOAuthCallback rejects when state is missing in sessionStorage
  sessionStorage.removeItem('oura-oauth-pending');
  const noPending = await oauth.completeOAuthCallback(new URLSearchParams('code=X&state=Y'));
  assert('Callback w/ no pending state rejected', noPending.ok === false && /pending/i.test(noPending.error));

  // completeOAuthCallback rejects on state mismatch (CSRF guard)
  sessionStorage.setItem('oura-oauth-pending', JSON.stringify({
    state: 'correct-state', redirectUri, startedAt: Date.now(), clientId,
  }));
  const badState = await oauth.completeOAuthCallback(new URLSearchParams('code=X&state=wrong-state'));
  assert('Callback w/ state mismatch rejected (CSRF guard)', badState.ok === false && /state/i.test(badState.error));
  assert('State consumed even on failure', sessionStorage.getItem('oura-oauth-pending') === null);

  // isOuraCallback recognises a pending Oura flow
  sessionStorage.setItem('oura-oauth-pending', JSON.stringify({
    state: 'xyz', redirectUri, startedAt: Date.now(), clientId,
  }));
  assert('isOuraCallback true when state matches pending', oauth.isOuraCallback(new URLSearchParams('code=X&state=xyz')));
  assert('isOuraCallback false when state absent', !oauth.isOuraCallback(new URLSearchParams('code=X')));
  assert('isOuraCallback false when pending missing', (sessionStorage.removeItem('oura-oauth-pending'), !oauth.isOuraCallback(new URLSearchParams('code=X&state=xyz'))));

  // DEFAULT_OURA_SCOPES sanity
  assert('DEFAULT_OURA_SCOPES includes personal+daily+heartrate+session',
    ['personal', 'daily', 'heartrate', 'session'].every(s => oauth.DEFAULT_OURA_SCOPES.includes(s)));

  // ═══════════════════════════════════════
  // 7. Window exports for render handlers
  // ═══════════════════════════════════════
  console.log('%c 7. Window Exports ', 'font-weight:bold;color:#f59e0b');
  assert('window.renderWearableStrip exists', typeof window.renderWearableStrip === 'function');
  assert('window.renderWearablesSettingsSection exists', typeof window.renderWearablesSettingsSection === 'function');
  assert('window.handleWearableConnect exists', typeof window.handleWearableConnect === 'function');
  assert('window.handleWearableDisconnect exists', typeof window.handleWearableDisconnect === 'function');
  assert('window.syncWearableNow exists', typeof window.syncWearableNow === 'function');

  console.log(`\nResults: ${pass} passed, ${fail} failed, ${pass + fail} total`);
})();
