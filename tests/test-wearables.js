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

  // Gate: metric-removed (Phase 7 L2 fix). User deletes last manual weight
  // entry → summary.metrics no longer contains weight → strip must re-render
  // immediately. Without this guard the stale summary persists and the card
  // stays on screen forever.
  const oldWithWeight = {
    summaryUpdatedAt: baseSummary.summaryUpdatedAt,
    sources: baseSummary.sources,
    metrics: { ...baseSummary.metrics, weight: { latest: 82, primarySource: 'manual', baseline: 82, rolling: { d7: 82 }, trend30d: 'flat', weekly: [82] } }
  };
  const newWithoutWeight = { ...baseSummary }; // has no `weight` key
  const removedRes = summary.shouldWriteL2(newWithoutWeight, oldWithWeight);
  assert('Gate: metric-removed trips write',
    removedRes.write === true && removedRes.reason?.startsWith('metric-removed:'),
    `reason=${removedRes.reason}`);

  // Gate: source-flip (Phase 7 L2 fix). User deletes manual rhr → auto-picker
  // reverts primary to Oura → card source label must refresh even if d7
  // doesn't cross the 5% threshold.
  const oldRhrManual = {
    summaryUpdatedAt: baseSummary.summaryUpdatedAt,
    sources: baseSummary.sources,
    metrics: { rhr: { latest: 64, primarySource: 'manual', baseline: 65, rolling: { d7: 64 }, trend30d: 'flat', weekly: [64] } }
  };
  const newRhrOura = {
    summaryUpdatedAt: baseSummary.summaryUpdatedAt,
    sources: baseSummary.sources,
    metrics: { rhr: { latest: 64, primarySource: 'oura', baseline: 65, rolling: { d7: 64 }, trend30d: 'flat', weekly: [64] } }
  };
  const sourceFlipRes = summary.shouldWriteL2(newRhrOura, oldRhrManual);
  assert('Gate: source-flip trips write even without d7 shift',
    sourceFlipRes.write === true && sourceFlipRes.reason?.startsWith('source-flip:'),
    `reason=${sourceFlipRes.reason}`);

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

  // DEFAULT_OURA_SCOPES sanity — covers all canonical-metric-backing endpoints
  assert('DEFAULT_OURA_SCOPES includes base 4 (personal+daily+heartrate+session)',
    ['personal', 'daily', 'heartrate', 'session'].every(s => oauth.DEFAULT_OURA_SCOPES.includes(s)));
  assert('DEFAULT_OURA_SCOPES includes spo2 (daily_spo2)',
    oauth.DEFAULT_OURA_SCOPES.includes('spo2'));
  assert('DEFAULT_OURA_SCOPES includes stress (daily_stress + daily_resilience)',
    oauth.DEFAULT_OURA_SCOPES.includes('stress'));
  assert('DEFAULT_OURA_SCOPES includes heart_health (daily_cardiovascular_age)',
    oauth.DEFAULT_OURA_SCOPES.includes('heart_health'));
  assert('DEFAULT_OURA_SCOPES does NOT include docs-claimed spo2Daily (gate rejects it)',
    !oauth.DEFAULT_OURA_SCOPES.includes('spo2Daily'));
  // Adapter-registered scopes must match what the auth module requests — a drift
  // here means the authorize URL and the token-gate check for different things.
  assert('Oura adapter scope list matches DEFAULT_OURA_SCOPES',
    JSON.stringify([...ouraAdapter.oauth.scopes].sort()) === JSON.stringify([...oauth.DEFAULT_OURA_SCOPES].sort()));

  // Extended canonical metrics (9 cards ship with the dashboard strip at v1.22.2)
  for (const mid of ['activity_score','steps','stress_high_min','resilience_level','cardio_age']) {
    assert(`CANONICAL_METRICS has ${mid}`, !!reg.CANONICAL_METRICS[mid]);
    assert(`Oura adapter maps ${mid}`, reg.adapterSupportsMetric('oura', mid));
  }
  assert('DEFAULT_METRIC_ORDER is 14 metrics (4 core + 5 extended + 3 biometric + 2 daytime companions)', reg.DEFAULT_METRIC_ORDER.length === 14);
  // Biometric metrics must be in the default order so the summary pipeline
  // iterates them for manual / Withings / Fitbit rows.
  assert('DEFAULT_METRIC_ORDER includes weight', reg.DEFAULT_METRIC_ORDER.includes('weight'));
  assert('DEFAULT_METRIC_ORDER includes bp_systolic', reg.DEFAULT_METRIC_ORDER.includes('bp_systolic'));
  assert('DEFAULT_METRIC_ORDER includes bp_diastolic', reg.DEFAULT_METRIC_ORDER.includes('bp_diastolic'));
  // Daytime companions must be summarised so the AI context + detail modal
  // can read them, even though they're hidden from the strip cards themselves.
  assert('DEFAULT_METRIC_ORDER includes hrv_day', reg.DEFAULT_METRIC_ORDER.includes('hrv_day'));
  assert('DEFAULT_METRIC_ORDER includes hr_day', reg.DEFAULT_METRIC_ORDER.includes('hr_day'));
  assert('CANONICAL_METRICS has hrv_day with daytime sub-label', reg.CANONICAL_METRICS.hrv_day?.sub === 'daytime');
  assert('CANONICAL_METRICS has hr_day with daytime sub-label', reg.CANONICAL_METRICS.hr_day?.sub === 'daytime');
  assert('CANONICAL_METRICS hrv_rmssd sub-label is overnight', reg.CANONICAL_METRICS.hrv_rmssd?.sub === 'overnight');
  assert('CANONICAL_METRICS rhr sub-label is overnight', reg.CANONICAL_METRICS.rhr?.sub === 'overnight');
  assert('Steps is mapped to the same endpoint as activity_score (both from daily_activity)',
    reg.adapterById('oura').metrics.steps.endpoint === reg.adapterById('oura').metrics.activity_score.endpoint);

  // AI context labels derive from canonical registry — must handle every ordered
  // metric without falling back to raw ids.
  const fakeSummary = {
    sources: { oura: { connectedSince: '2026-01-01', lastSyncAt: Date.now(), coverageDays: 30 } },
    metrics: {},
  };
  for (const mid of reg.DEFAULT_METRIC_ORDER) {
    fakeSummary.metrics[mid] = { primarySource: 'oura', latest: 50, baseline: 50, baselineP25: 45, baselineP75: 55, rolling: { d7: 50, d30: 50, d90: 50 }, trend30d: 'flat', weekly: [49, 50, 51, 50, 50, 50] };
  }
  const ctxAll = labCtx.buildWearableContext({ wearableSummary: fakeSummary });
  assert('AI context renders all 8 canonical labels (no raw IDs)',
    !/activity_score|stress_high_min|resilience_level|cardio_age/.test(ctxAll) &&
    ctxAll.includes('Activity') && ctxAll.includes('Stress') && ctxAll.includes('Resilience') && ctxAll.includes('Cardio age'));
  assert('AI context includes weekly trend for extended metrics',
    ctxAll.includes('Weekly trend') && /Resilience.*→/.test(ctxAll));

  // ═══════════════════════════════════════
  // 8. Resilience + stress value normalization
  // ═══════════════════════════════════════
  console.log('%c 8. Value Normalization ', 'font-weight:bold;color:#f59e0b');
  const { fetchOuraDailyRange } = await import('../js/wearables-oura.js');
  assert('fetchOuraDailyRange is exported', typeof fetchOuraDailyRange === 'function');
  // We can't hit Oura here, but we can assert the helper behaviors indirectly
  // by checking metric definitions. Resilience enum → 1..5 numeric maps through
  // the fetcher; stress_high (seconds) → minutes via /60 round. Both guarantees
  // live in wearables-oura.js; this test pins the shape contract.
  assert('resilience_level metric unit is /5 (registry contract)',
    reg.CANONICAL_METRICS.resilience_level.unit === '/5');
  assert('stress_high_min metric unit is min (registry contract)',
    reg.CANONICAL_METRICS.stress_high_min.unit === 'min');

  // ═══════════════════════════════════════
  // 9. Render-helper divide-by-zero guards
  // ═══════════════════════════════════════
  console.log('%c 9. Render Guards ', 'font-weight:bold;color:#f59e0b');
  // Force-load wearables.js (side-effect module that registers window.*).
  await import('../js/wearables.js');
  // deltaClassFor / formatDelta are not exported — they're internal to the strip
  // render. We test them via the full render path: a metric with baseline=0 must
  // NOT produce "NaN%" in the rendered HTML, and the delta cell must still carry
  // a neutral class (no bad/good red/green paint on divide-by-zero).
  const zeroBaselineSummary = {
    sources: { oura: { connectedSince: '2026-01-01', lastSyncAt: Date.now(), coverageDays: 10 } },
    metrics: {
      activity_score: { primarySource: 'oura', latest: 0, baseline: 0, baselineP25: 0, baselineP75: 0, rolling: { d7: 0, d30: 0, d90: 0 }, trend30d: 'flat', weekly: [0,0,0,0] },
    },
  };
  // Stash summary so renderWearableStrip reads it
  window._labState.importedData = window._labState.importedData || {};
  window._labState.importedData.wearableSummary = zeroBaselineSummary;
  const html = window.renderWearableStrip();
  assert('render never emits NaN% on zero baseline', !/NaN/.test(html));
  assert('render shows dash marker for zero-baseline delta', /→\s*—/.test(html) || /→—/.test(html));
  delete window._labState.importedData.wearableSummary;

  // ── Zero-coverage source: header drops it, footer surfaces "waiting on first sync" ──
  const mixedCoverageSummary = {
    sources: {
      oura:  { connectedSince: '2026-01-01', lastSyncAt: Date.now(), coverageDays: 15 },
      polar: { connectedSince: '2026-04-23', lastSyncAt: Date.now(), coverageDays: 0 },
    },
    metrics: {
      hrv_rmssd: { primarySource: 'oura', latest: 39, baseline: 32, baselineP25: 28, baselineP75: 36, rolling: { d7: 39, d30: 33, d90: 32 }, trend30d: 'rising', weekly: [30, 32, 34, 39] },
    },
  };
  window._labState.importedData.wearableSummary = mixedCoverageSummary;
  const mixedHtml = window.renderWearableStrip();
  assert('header source label omits zero-coverage vendor', !/wearable-source-label[^>]*>[^<]*Polar/.test(mixedHtml));
  assert('header source label still shows the data-bearing vendor', /wearable-source-label[^>]*>[^<]*Oura/.test(mixedHtml));
  assert('coverage label reflects only data-bearing source', /·\s*15d/.test(mixedHtml));
  assert('footer surfaces waiting hint for zero-coverage vendor', /Polar connected — waiting on first device sync/.test(mixedHtml));
  delete window._labState.importedData.wearableSummary;

  // ═══════════════════════════════════════
  // 9b. Detail modal
  // ═══════════════════════════════════════
  console.log('%c 9b. Detail Modal ', 'font-weight:bold;color:#f59e0b');
  const detailSummary = {
    sources: { oura: { connectedSince: '2026-01-01', lastSyncAt: Date.now(), coverageDays: 5 } },
    metrics: {
      hrv_rmssd: { primarySource: 'oura', latest: 42, latestDate: '2026-04-22', baseline: 40, baselineP25: 36, baselineP75: 44, rolling: { d7: 42, d30: 40, d90: 40 }, trend30d: 'rising', weekly: [38, 40, 42] },
      activity_score: { primarySource: 'oura', latest: 0, latestDate: '2026-04-22', baseline: 0, baselineP25: 0, baselineP75: 0, rolling: { d7: 0, d30: 0, d90: 0 }, trend30d: 'flat', weekly: [0,0,0,0,0] },
    },
  };
  window._labState.importedData.wearableSummary = detailSummary;
  const TEST_PROFILE_DETAIL = window._labState.currentProfile || TEST_PROFILE;
  await store.upsertDailyBatch(TEST_PROFILE_DETAIL, [
    { source: 'oura', date: '2026-04-20', hrv_rmssd: 40, activity_score: 0 },
    { source: 'oura', date: '2026-04-21', hrv_rmssd: 41, activity_score: 0 },
    { source: 'oura', date: '2026-04-22', hrv_rmssd: 42, activity_score: 0 },
  ]);

  await window.openWearableDetail('hrv_rmssd');
  await new Promise(r => setTimeout(r, 60));
  assert('Detail modal opens on a valid metric', document.getElementById('modal-overlay').classList.contains('show'));
  const modalHtml = document.getElementById('detail-modal').innerHTML;
  assert('Detail modal includes metric label HRV', modalHtml.includes('HRV'));
  assert('Detail modal shows latest value', /42/.test(modalHtml));
  assert('Detail modal shows Baseline (90d) stat', /Baseline/.test(modalHtml));
  assert('Detail modal shows Coverage stat', /Coverage/.test(modalHtml));
  assert('Chart canvas mounted on modal', !!document.getElementById('chart-modal'));
  assert('Chart instance stored under state.chartInstances.modal', !!window._labState.chartInstances?.modal);
  const modalChart = window._labState.chartInstances?.modal;
  // Chart actually got 3 data points from the 3 upserted L1 rows (regression
  // guard: if the time-axis adapter fails to parse ISO labels the chart either
  // throws on build or quietly renders 0 points). Also confirms label/data
  // array lengths stay in lockstep.
  assert('Chart has 3 data points matching L1 row count', modalChart?.data?.datasets?.[0]?.data?.length === 3);
  assert('Chart labels array has 3 entries', modalChart?.data?.labels?.length === 3);
  assert('Chart x-axis is time type', modalChart?.options?.scales?.x?.type === 'time');
  window.closeModal();
  assert('closeModal clears modal chart instance', !window._labState.chartInstances?.modal);

  await window.openWearableDetail('activity_score');
  await new Promise(r => setTimeout(r, 60));
  assert('Rest-mode hint shown on all-zero activity score',
    /Rest Mode/.test(document.getElementById('detail-modal').innerHTML));
  window.closeModal();
  delete window._labState.importedData.wearableSummary;

  // ═══════════════════════════════════════
  // 10. Window exports for render handlers
  // ═══════════════════════════════════════
  console.log('%c 10. Window Exports ', 'font-weight:bold;color:#f59e0b');
  assert('window.renderWearableStrip exists', typeof window.renderWearableStrip === 'function');
  assert('window.renderWearablesSettingsSection exists', typeof window.renderWearablesSettingsSection === 'function');
  assert('window.handleWearableConnect exists', typeof window.handleWearableConnect === 'function');
  assert('window.handleWearableDisconnect exists', typeof window.handleWearableDisconnect === 'function');
  assert('window.syncWearableNow exists', typeof window.syncWearableNow === 'function');
  assert('window.openWearableDetail exists', typeof window.openWearableDetail === 'function');
  assert('handleWearablePATConnect removed (Ultrahuman moved to OAuth2)',
    typeof window.handleWearablePATConnect === 'undefined');

  // ═══════════════════════════════════════
  // 11. Phase-3 multi-vendor adapter registry
  // ═══════════════════════════════════════
  console.log('%c 11. Multi-Vendor ', 'font-weight:bold;color:#f59e0b');
  for (const vid of ['whoop', 'ultrahuman', 'apple_health', 'withings', 'fitbit']) {
    const v = reg.adapterById(vid);
    assert(`Adapter ${vid} registered`, !!v);
    assert(`Adapter ${vid} carries beta flag`, v?.beta === true);
  }
  assert('WHOOP uses OAuth2 with PKCE',
    reg.adapterById('whoop')?.authType === 'oauth2' && reg.adapterById('whoop')?.oauth?.pkce === true);
  assert('Ultrahuman uses OAuth2 (moved off legacy PAT in v1.23.3)',
    reg.adapterById('ultrahuman')?.authType === 'oauth2');
  assert('Ultrahuman is confidential client (client_secret held by proxy, no PKCE)',
    reg.adapterById('ultrahuman')?.oauth?.pkce === false);
  assert('Ultrahuman scopes include profile + ring_data + cgm_data',
    ['profile', 'ring_data', 'cgm_data'].every(s => reg.adapterById('ultrahuman')?.oauth?.scopes?.includes(s)));
  assert('Apple Health uses file-import auth', reg.adapterById('apple_health')?.authType === 'file-import');
  assert('Withings uses OAuth2 server-side (no PKCE)',
    reg.adapterById('withings')?.authType === 'oauth2' && reg.adapterById('withings')?.oauth?.pkce === false);
  assert('WHOOP maps strain metric (WHOOP-native)',
    reg.adapterById('whoop')?.metrics?.strain != null);
  assert('Apple Health maps hrv_sdnn (deep HRV that footer hints about)',
    reg.adapterById('apple_health')?.metrics?.hrv_sdnn != null);
  assert('Withings maps weight + BP pair',
    reg.adapterById('withings')?.metrics?.weight != null &&
    reg.adapterById('withings')?.metrics?.bp_systolic != null &&
    reg.adapterById('withings')?.metrics?.bp_diastolic != null);

  // New canonicals the Phase-3 adapters introduced
  for (const mid of ['hrv_sdnn', 'strain', 'weight', 'bp_systolic', 'bp_diastolic']) {
    assert(`CANONICAL_METRICS now has ${mid}`, !!reg.CANONICAL_METRICS[mid]);
  }

  // ═══════════════════════════════════════
  // 12. WHOOP PKCE auth module
  // ═══════════════════════════════════════
  console.log('%c 12. WHOOP PKCE ', 'font-weight:bold;color:#f59e0b');
  const whoopAuth = await import('../js/wearables-whoop-auth.js');
  assert('WHOOP DEFAULT_WHOOP_SCOPES includes read:recovery',
    whoopAuth.DEFAULT_WHOOP_SCOPES.includes('read:recovery'));
  assert('WHOOP scopes include offline (for refresh_token)',
    whoopAuth.DEFAULT_WHOOP_SCOPES.includes('offline'));
  const whoopAuthUrl = await whoopAuth.buildAuthorizeUrl({
    clientId: 'test-client', redirectUri: 'http://localhost:8000/app',
    scopes: whoopAuth.DEFAULT_WHOOP_SCOPES, state: 'test-state',
    codeVerifier: 'Dm4l9H2NqE8yP5Rb7w3a6Z1K0VxYcOjG4FiU_n-tBXs',
  });
  assert('WHOOP authorize URL hits api.prod.whoop.com',
    whoopAuthUrl.includes('api.prod.whoop.com/oauth/oauth2/auth'));
  assert('WHOOP authorize URL carries code_challenge',
    /code_challenge=[A-Za-z0-9_-]+/.test(whoopAuthUrl));
  assert('WHOOP authorize URL declares S256 method',
    whoopAuthUrl.includes('code_challenge_method=S256'));
  assert('WHOOP authorize URL does NOT leak code_verifier',
    !whoopAuthUrl.includes('code_verifier='));

  // ═══════════════════════════════════════
  // 13. Ultrahuman OAuth2 + fetcher shape
  // ═══════════════════════════════════════
  console.log('%c 13. Ultrahuman OAuth2 ', 'font-weight:bold;color:#f59e0b');
  const uh = await import('../js/wearables-ultrahuman.js');
  assert('fetchUltrahumanDailyRange exists', typeof uh.fetchUltrahumanDailyRange === 'function');
  assert('fetchUltrahumanPersonalInfo exists (moved off verifyPAT to OAuth2 user_info)',
    typeof uh.fetchUltrahumanPersonalInfo === 'function');
  const uhAuth = await import('../js/wearables-ultrahuman-auth.js');
  assert('Ultrahuman scopes include profile + ring_data + cgm_data',
    ['profile', 'ring_data', 'cgm_data'].every(s => uhAuth.DEFAULT_ULTRAHUMAN_SCOPES.includes(s)));
  const uhUrl = uhAuth.buildAuthorizeUrl({
    clientId: 'test-client', redirectUri: 'http://localhost:8000/app',
    scopes: uhAuth.DEFAULT_ULTRAHUMAN_SCOPES, state: 'uh-test-state',
  });
  assert('Ultrahuman authorize URL hits auth.ultrahuman.com/authorise',
    uhUrl.startsWith('https://auth.ultrahuman.com/authorise'));
  assert('Ultrahuman scope list is space-delimited',
    /scope=profile\+ring_data\+cgm_data/.test(uhUrl));
  assert('Ultrahuman adapter scope list matches DEFAULT_ULTRAHUMAN_SCOPES',
    JSON.stringify([...reg.adapterById('ultrahuman').oauth.scopes].sort()) ===
    JSON.stringify([...uhAuth.DEFAULT_ULTRAHUMAN_SCOPES].sort()));

  // ═══════════════════════════════════════
  // 14. Apple Health XML parser
  // ═══════════════════════════════════════
  console.log('%c 14. Apple Health XML ', 'font-weight:bold;color:#f59e0b');
  const ah = await import('../js/wearables-apple-health.js');
  const fixtureXml = await fetch('/tests/spike-fixtures/apple-health-sample.xml').then(r => r.text());
  const ahRows = ah.parseAppleHealthXml(fixtureXml);
  assert('Apple Health parser returned 2 canonical day rows (2026-04-20, 2026-04-21)',
    ahRows.length === 2);
  assert('Apple rows sorted ascending by date',
    ahRows[0].date === '2026-04-20' && ahRows[1].date === '2026-04-21');
  const day1 = ahRows.find(r => r.date === '2026-04-20');
  const day2 = ahRows.find(r => r.date === '2026-04-21');

  // RHR aggregator is MIN across all samples — Apple writes RestingHR as a
  // sleep-derived value timestamped at wake, so hour-of-day splitting would
  // mis-classify it. Min still protects against 3rd-party-app spikes.
  assert('RHR uses min-per-day aggregator (ignores 85bpm 3rd-party outlier, keeps 58)',
    day1.rhr === 58);
  // HRV SDNN: both fixture samples are at 02:15 and 03:20 — night-window
  // (22:00–06:00) → mean(42.5, 48.5) = 45.5 routes to hrv_sdnn (overnight).
  assert('HRV SDNN aggregates night-window samples (42.5 & 48.5 → 45.5)',
    day1.hrv_sdnn === 45.5);
  // No day-window HRV samples in fixture → hrv_day should be null on day 1.
  assert('hrv_day is null when no day-window samples exist',
    day1.hrv_day === null);
  // Steps is sum-per-day (320 + 2100 + 5430 = 7850)
  assert('Steps sum multiple sources per day (320+2100+5430=7850)',
    day1.steps === 7850);
  // SpO2 mean of 97 + 95 = 96
  assert('SpO2 mean-per-day aggregator (97+95 → 96)',
    day1.spo2_avg === 96);
  // Day 2 has single readings — single 02:10 SDNN sample is night-window → 51
  assert('Day 2 RHR populated (single reading → 56)', day2.rhr === 56);
  assert('Day 2 HRV SDNN populated (single night-window sample → 51)', day2.hrv_sdnn === 51);
  assert('Day 2 hrv_day null (no day-window samples)', day2.hrv_day === null);

  // Records we explicitly don't map must NOT end up in canonical rows —
  // HeartRate (real-time) and BodyMass aren't in our Apple Health mapping yet.
  assert('Unmapped HeartRate record does not leak into canonical rows',
    day1.hrv_rmssd === null && day2.hrv_rmssd === null);
  assert('Body temp delta correctly dropped (no baseline yet, absolute temp unusable)',
    day1.body_temp_delta === null);

  // Source tag is apple_health so the L1 IDB + multi-source badge paths pick
  // it up as a distinct vendor alongside Oura/WHOOP.
  assert('Canonical row carries source: apple_health', day1.source === 'apple_health');

  // Unit-normalisation guard — a record with a bogus unit string must be
  // dropped rather than silently stored in the wrong scale.
  const hostileXml = '<?xml version="1.0"?><HealthData><Record type="HKQuantityTypeIdentifierStepCount" unit="furlongs" startDate="2026-04-20 00:00:00 +0000" value="12"/></HealthData>';
  const hostileRows = ah.parseAppleHealthXml(hostileXml);
  assert('Hostile unit ("furlongs" for steps) is refused, not ingested',
    hostileRows.length === 0 || hostileRows[0].steps === null);

  // ═══════════════════════════════════════
  // 15. Withings OAuth2 + measure-type decoding
  // ═══════════════════════════════════════
  console.log('%c 15. Withings ', 'font-weight:bold;color:#f59e0b');
  const withingsAuth = await import('../js/wearables-withings-auth.js');
  assert('Withings scopes include user.metrics',
    withingsAuth.DEFAULT_WITHINGS_SCOPES.includes('user.metrics'));
  const withingsAuthUrl = withingsAuth.buildAuthorizeUrl({
    clientId: 'test-client', redirectUri: 'http://localhost:8000/app',
    scopes: withingsAuth.DEFAULT_WITHINGS_SCOPES, state: 'abc123',
  });
  assert('Withings authorize URL hits account.withings.com',
    withingsAuthUrl.startsWith('https://account.withings.com/oauth2_user/authorize2'));
  assert('Withings authorize URL carries state param',
    withingsAuthUrl.includes('state=abc123'));
  // Scopes are comma-delimited (Withings quirk — not space like everyone else)
  assert('Withings scope list is comma-delimited (not space)',
    /scope=user\.info%2Cuser\.metrics/.test(withingsAuthUrl));

  const withingsReg = reg.adapterById('withings');
  assert('Withings adapter scopes match DEFAULT_WITHINGS_SCOPES',
    JSON.stringify([...withingsReg.oauth.scopes].sort()) === JSON.stringify([...withingsAuth.DEFAULT_WITHINGS_SCOPES].sort()));

  // Measure-type code sanity — Withings uses numeric codes (1=weight, 10=BP sys
  // etc.). Our adapter declares them explicitly so the renderer can surface
  // them; if a tester's scale is only pushing type 77 (hydration) we ignore it
  // rather than mapping to something wrong.
  assert('Withings weight maps to measType 1',      withingsReg.metrics.weight?.measType === 1);
  assert('Withings BP diastolic maps to measType 9', withingsReg.metrics.bp_diastolic?.measType === 9);
  assert('Withings BP systolic maps to measType 10', withingsReg.metrics.bp_systolic?.measType === 10);
  // Scale pulse (type 11) is a daytime spot reading, NOT resting HR. It now
  // routes to hr_day; the rhr slot is filled from sleep summary's hr_min.
  assert('Withings scale pulse (type 11) maps to hr_day, not rhr',
    withingsReg.metrics.hr_day?.measType === 11 && !withingsReg.metrics.rhr?.measType);
  assert('Withings rhr is sourced from sleep summary hr_min',
    withingsReg.metrics.rhr?.endpoint === 'v2/sleep' && withingsReg.metrics.rhr?.field === 'hr_min');

  const withingsFetcher = await import('../js/wearables-withings.js');
  assert('fetchWithingsDailyRange exists', typeof withingsFetcher.fetchWithingsDailyRange === 'function');

  // ═══════════════════════════════════════
  // 16. Fitbit PKCE + fetcher shape
  // ═══════════════════════════════════════
  console.log('%c 16. Fitbit PKCE ', 'font-weight:bold;color:#f59e0b');
  const fitbitAuth = await import('../js/wearables-fitbit-auth.js');
  const fitbitFetcher = await import('../js/wearables-fitbit.js');
  const fitbitReg = reg.adapterById('fitbit');

  assert('Fitbit uses OAuth2 with PKCE (public client, no client_secret)',
    fitbitReg?.authType === 'oauth2' && fitbitReg?.oauth?.pkce === true);
  assert('Fitbit scopes include heartrate + sleep + profile',
    ['heartrate', 'sleep', 'profile'].every(s => fitbitAuth.DEFAULT_FITBIT_SCOPES.includes(s)));
  assert('Fitbit scopes include temperature + weight (for skin Δ + scale readings)',
    ['temperature', 'weight'].every(s => fitbitAuth.DEFAULT_FITBIT_SCOPES.includes(s)));
  assert('Fitbit adapter scope list matches DEFAULT_FITBIT_SCOPES (no drift)',
    JSON.stringify([...fitbitReg.oauth.scopes].sort()) ===
    JSON.stringify([...fitbitAuth.DEFAULT_FITBIT_SCOPES].sort()));

  const fbUrl = await fitbitAuth.buildAuthorizeUrl({
    clientId: 'fb-test-client', redirectUri: 'http://localhost:8000/app',
    scopes: fitbitAuth.DEFAULT_FITBIT_SCOPES, state: 'fb-state-xyz',
    codeVerifier: 'Dm4l9H2NqE8yP5Rb7w3a6Z1K0VxYcOjG4FiU_n-tBXs',
  });
  assert('Fitbit authorize URL hits www.fitbit.com/oauth2/authorize',
    fbUrl.startsWith('https://www.fitbit.com/oauth2/authorize'));
  assert('Fitbit authorize URL carries code_challenge', /code_challenge=[A-Za-z0-9_-]+/.test(fbUrl));
  assert('Fitbit authorize URL declares S256 method', fbUrl.includes('code_challenge_method=S256'));
  assert('Fitbit authorize URL does NOT leak code_verifier', !fbUrl.includes('code_verifier='));
  assert('Fitbit scopes are space-delimited in URL', /scope=profile\+activity\+heartrate/.test(fbUrl));

  assert('fetchFitbitDailyRange exists', typeof fitbitFetcher.fetchFitbitDailyRange === 'function');
  assert('fetchFitbitPersonalInfo exists', typeof fitbitFetcher.fetchFitbitPersonalInfo === 'function');

  // ═══════════════════════════════════════
  // 17. Multi-source primary-source override (post-audit fix)
  // ═══════════════════════════════════════
  console.log('%c 17. Primary-Source Override ', 'font-weight:bold;color:#f59e0b');
  const baseRow = (src, date, metrics) => ({ source: src, date, ...metrics });
  const rowsBySource = {
    oura:   [baseRow('oura',   '2026-04-22', { hrv_rmssd: 40, steps: 0 })],
    fitbit: [baseRow('fitbit', '2026-04-22', { hrv_rmssd: 45, steps: 8200 })],
  };
  const connectedSources = {
    oura:   { connectedSince: '2026-01-01', lastSyncAt: Date.now() },
    fitbit: { connectedSince: '2026-02-01', lastSyncAt: Date.now() },
  };

  // Auto-pick: insertion order (oura first) wins on ties. Document the existing
  // behaviour so regressions in the picker are caught.
  const autoSummary = summary.computeWearableSummary(rowsBySource, connectedSources);
  assert('Auto picker: tied dates → insertion-order-first (oura) wins hrv_rmssd',
    autoSummary.metrics.hrv_rmssd?.primarySource === 'oura');

  // Override: force Fitbit for HRV even though Oura would auto-win
  const overrideSummary = summary.computeWearableSummary(rowsBySource, connectedSources, { hrv_rmssd: 'fitbit' });
  assert('Override: primaryOverride.hrv_rmssd=fitbit flips primarySource',
    overrideSummary.metrics.hrv_rmssd?.primarySource === 'fitbit');
  assert('Override: derived latest value comes from the overridden source',
    overrideSummary.metrics.hrv_rmssd?.latest === 45);

  // Bad override: force Ultrahuman (not in rowsBySource) → fall back to auto
  const badOverrideSummary = summary.computeWearableSummary(rowsBySource, connectedSources, { hrv_rmssd: 'ultrahuman' });
  assert('Override: unknown source silently falls back to auto picker',
    badOverrideSummary.metrics.hrv_rmssd?.primarySource === 'oura');

  // Override with no data in that source → also falls back
  const rowsWithEmptyFitbit = {
    oura:   [baseRow('oura', '2026-04-22', { hrv_rmssd: 40 })],
    fitbit: [baseRow('fitbit', '2026-04-22', { hrv_rmssd: null })],
  };
  const emptyOverrideSummary = summary.computeWearableSummary(rowsWithEmptyFitbit, connectedSources, { hrv_rmssd: 'fitbit' });
  assert('Override: source has no non-null samples → auto fallback',
    emptyOverrideSummary.metrics.hrv_rmssd?.primarySource === 'oura');

  // ═══════════════════════════════════════
  // 18. withFreshToken re-reads connection inside lock (cross-tab race guard)
  // ═══════════════════════════════════════
  console.log('%c 18. Auth Race Guard ', 'font-weight:bold;color:#f59e0b');
  // Stale connection: expired 10 min ago. readLatest() returns a fresh one
  // that another tab already refreshed. Expected: function returns the fresh
  // connection without calling refreshTokens (which would fail on the stale
  // refreshToken).
  const staleConn = {
    accessToken: 'stale-at', refreshToken: 'stale-rt',
    expiresAt: Date.now() - 10 * 60 * 1000,  // expired
  };
  const freshConn = {
    accessToken: 'fresh-at', refreshToken: 'fresh-rt',
    expiresAt: Date.now() + 60 * 60 * 1000,  // valid for 1h
  };
  let refreshCalled = false;
  // Temporarily stub refreshTokens to detect if it's (incorrectly) called.
  const origFetch = window.fetch;
  window.fetch = async () => { refreshCalled = true; return { ok: false, status: 400, json: async () => ({ error: 'shouldnt-run' }) }; };
  try {
    const result = await oauth.withFreshToken(staleConn, 'test-client', async () => {}, () => freshConn);
    assert('withFreshToken: returns fresh connection from readLatest without hitting token endpoint',
      result.accessToken === 'fresh-at' && !refreshCalled);
  } catch (e) {
    assert('withFreshToken: no throw when another tab already refreshed', false, e.message);
  } finally {
    window.fetch = origFetch;
  }

  // Formatter-unification guard: a value with unit '%' must render the SAME
  // way in the strip card and the detail modal. Catches the v1.22.2 divergence
  // where `formatValue(97, '%')` returned "97" but the modal's inline formatV
  // fell through to `.toFixed(1)` → "97.0".
  const strip2 = {
    sources: { oura: { connectedSince: '2026-01-01', lastSyncAt: Date.now(), coverageDays: 10 } },
    metrics: {
      spo2_avg: { primarySource: 'oura', latest: 97, latestDate: '2026-04-22', baseline: 96, baselineP25: 95, baselineP75: 98, rolling: { d7: 97, d30: 97, d90: 96 }, trend30d: 'flat', weekly: [96, 96, 97, 97, 97] },
    },
  };
  window._labState.importedData.wearableSummary = strip2;
  const stripSpo2Html = window.renderWearableStrip();
  await store.upsertDailyBatch(TEST_PROFILE_DETAIL, [
    { source: 'oura', date: '2026-04-22', spo2_avg: 97 },
  ]);
  await window.openWearableDetail('spo2_avg');
  await new Promise(r => setTimeout(r, 60));
  const modalSpo2Html = document.getElementById('detail-modal').innerHTML;
  // Neither renderer should produce "97.0 %" — both should be "97 %".
  assert('Strip renders SpO2 97 as integer (no .0)',
    !/97\.0/.test(stripSpo2Html));
  assert('Modal renders SpO2 97 as integer (no .0)',
    !/97\.0/.test(modalSpo2Html));
  window.closeModal();
  delete window._labState.importedData.wearableSummary;

  // ═══════════════════════════════════════
  // 13. OAUTH_DISPATCH registry-vs-dispatch drift
  // ═══════════════════════════════════════
  // Catches the bug where someone adds a new OAuth adapter to wearable-adapters.js
  // but forgets to register its begin/callback/complete/withFreshToken/fetchRange
  // hooks in wearables-connect.js OAUTH_DISPATCH (or vice versa). apple_health is
  // the one legitimate exception — file-import, not OAuth.
  console.log('%c 13. OAUTH_DISPATCH drift ', 'font-weight:bold;color:#f59e0b');
  const connect = await import('../js/wearables-connect.js');
  assert('OAUTH_DISPATCH exported', typeof connect.OAUTH_DISPATCH === 'object' && connect.OAUTH_DISPATCH !== null);

  const oauthAdapterIds = reg.ADAPTERS.filter(a => a.authType === 'oauth2').map(a => a.id);
  const dispatchIds = Object.keys(connect.OAUTH_DISPATCH);

  // 1. Every oauth2 adapter has a dispatch entry
  for (const id of oauthAdapterIds) {
    assert(`Adapter '${id}' has OAUTH_DISPATCH entry`, dispatchIds.includes(id),
      `missing — register hooks in wearables-connect.js`);
  }
  // 2. Every dispatch entry has a matching oauth2 adapter (no orphaned dispatch hooks)
  for (const id of dispatchIds) {
    const adapter = reg.adapterById(id);
    assert(`Dispatch entry '${id}' has matching oauth2 adapter`, adapter?.authType === 'oauth2',
      `orphaned — remove from OAUTH_DISPATCH or add adapter`);
  }
  // 3. Each dispatch entry exposes the full hook surface
  const REQUIRED_HOOKS = ['begin', 'isCallback', 'complete', 'withFreshToken', 'fetchAccountInfo', 'fetchRange', 'displayName'];
  for (const id of dispatchIds) {
    const entry = connect.OAUTH_DISPATCH[id];
    for (const hook of REQUIRED_HOOKS) {
      assert(`OAUTH_DISPATCH.${id}.${hook} present`, entry && entry[hook] != null);
    }
  }
  // 4. Apple Health is explicitly NOT in dispatch (file-import, no OAuth)
  assert('apple_health NOT in OAUTH_DISPATCH', !dispatchIds.includes('apple_health'),
    'apple_health is file-import, should never be registered');

  // ═══════════════════════════════════════
  // 14. Withings error-code table
  // ═══════════════════════════════════════
  console.log('%c 14. Withings error codes ', 'font-weight:bold;color:#f59e0b');
  const withings = await import('../js/wearables-withings.js');
  assert('withingsErrorMessage exported', typeof withings.withingsErrorMessage === 'function');
  assert('maps 100 → token invalid', /token/i.test(withings.withingsErrorMessage(100)));
  assert('maps 293 → rate limit', /rate/i.test(withings.withingsErrorMessage(293)));
  assert('maps 284 → token not found', /token not found/i.test(withings.withingsErrorMessage(284)));
  assert('maps 283 → token used', /token/i.test(withings.withingsErrorMessage(283)));
  assert('maps 251 → grant invalid', /grant/i.test(withings.withingsErrorMessage(251)));
  assert('maps 601 → rate limited', /rate/i.test(withings.withingsErrorMessage(601)));
  assert('unknown code returns null', withings.withingsErrorMessage(99999) === null);
  assert('non-numeric returns null', withings.withingsErrorMessage('foo') === null);
  assert('numeric string works', /token/i.test(withings.withingsErrorMessage('100')));

  // ═══════════════════════════════════════
  // 15. PKCE: code_verifier → code_challenge SHA256 spec compliance
  // ═══════════════════════════════════════
  // RFC 7636 §4.2: code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier))).
  // WHOOP and Fitbit both use the S256 method; a bug in the derivation silently
  // breaks the final token exchange with a cryptic 'invalid_grant'. Pin the
  // exact byte sequence end-to-end against the RFC test vector.
  console.log('%c 15. PKCE SHA256 pair ', 'font-weight:bold;color:#f59e0b');
  // Auth modules already imported above (sections 6 + 11); reuse to avoid
  // top-level identifier collisions in this IIFE's single scope.
  const fitbitAuthPkce = await import('../js/wearables-fitbit-auth.js');
  const whoopAuthPkce = await import('../js/wearables-whoop-auth.js');

  // RFC 7636 Appendix B test vector:
  //   verifier  = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  //   challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  const RFC_VERIFIER  = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

  // Both auth modules should expose a derivation helper; if not, recreate inline
  // and make sure the helper names match what's used inside begin*OAuth.
  {
    const got = await fitbitAuthPkce.deriveCodeChallenge(RFC_VERIFIER);
    assert('Fitbit PKCE derives RFC test vector', got === RFC_CHALLENGE, `got ${got}`);
  }
  {
    const got = await whoopAuthPkce.deriveCodeChallenge(RFC_VERIFIER);
    assert('WHOOP PKCE derives RFC test vector', got === RFC_CHALLENGE, `got ${got}`);
  }

  // ═══════════════════════════════════════
  // 16. Polar AccessLink adapter
  // ═══════════════════════════════════════
  console.log('%c 16. Polar adapter ', 'font-weight:bold;color:#f59e0b');
  const polarAdapter = reg.adapterById('polar');
  assert('Polar adapter registered', polarAdapter?.id === 'polar');
  assert('Polar displayName', polarAdapter?.displayName === 'Polar');
  assert('Polar authType oauth2', polarAdapter?.authType === 'oauth2');
  assert('Polar NOT PKCE (confidential client)', polarAdapter?.oauth?.pkce === false);
  assert('Polar Client ID pasted (not placeholder)',
    typeof polarAdapter?.oauth?.clientId === 'string' &&
    !polarAdapter.oauth.clientId.startsWith('REPLACE_WITH_') &&
    polarAdapter.oauth.clientId.length > 10);
  assert('Polar scope is accesslink.read_all',
    polarAdapter?.oauth?.scopes?.includes('accesslink.read_all'));
  assert('Polar supports sleep_score', reg.adapterSupportsMetric('polar', 'sleep_score'));
  assert('Polar supports steps', reg.adapterSupportsMetric('polar', 'steps'));
  assert('Polar supports rhr', reg.adapterSupportsMetric('polar', 'rhr'));
  assert('Polar in OAUTH_DISPATCH', 'polar' in connect.OAUTH_DISPATCH);
  assert('Polar has postConnect hook (one-time /v3/users registration)',
    typeof connect.OAUTH_DISPATCH.polar?.postConnect === 'function');
  assert('Polar has commitAfterWrite hook (transactions)',
    typeof connect.OAUTH_DISPATCH.polar?.commitAfterWrite === 'function');

  const polarAuth = await import('../js/wearables-polar-auth.js');
  assert('Polar DEFAULT_POLAR_SCOPES exported',
    Array.isArray(polarAuth.DEFAULT_POLAR_SCOPES) && polarAuth.DEFAULT_POLAR_SCOPES.includes('accesslink.read_all'));
  const polarAuthUrl = polarAuth.buildAuthorizeUrl({
    clientId: 'test-client', redirectUri: 'http://localhost:8000/app',
    scopes: polarAuth.DEFAULT_POLAR_SCOPES, state: 'test-state',
  });
  assert('Polar authorize URL points at flow.polar.com',
    polarAuthUrl.startsWith('https://flow.polar.com/oauth2/authorization'));
  assert('Polar authorize URL has response_type=code',
    polarAuthUrl.includes('response_type=code'));
  assert('Polar authorize URL NOT PKCE',
    !polarAuthUrl.includes('code_challenge'));
  assert('Polar authorize URL space-delimits scopes',
    polarAuthUrl.includes('scope=accesslink.read_all'));

  // Independent: verify the raw WebCrypto pipeline our flow depends on (base64url, not base64).
  const enc = new TextEncoder().encode(RFC_VERIFIER);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert('WebCrypto+base64url yields RFC 7636 challenge', b64url === RFC_CHALLENGE, `got ${b64url}`);

  // ═══════════════════════════════════════
  // 17. Day/night HRV + RHR canonicals (v1.25.0)
  // ═══════════════════════════════════════
  console.log('%c 17. Day/Night HRV+RHR ', 'font-weight:bold;color:#f59e0b');

  // Per-vendor adapter declarations: every adapter that has a day-window
  // signal we know how to harvest must declare it. Conversely, vendors with
  // no day signal yet (Fitbit hr_day, Apple Health hr_day) must NOT declare
  // one — leaving the slot null is more honest than fabricating.
  assert('Oura declares hr_day from heartrate endpoint',
    reg.adapterSupportsMetric('oura', 'hr_day'));
  assert('Oura does NOT declare hrv_day (gap until v2 exposes daytime rMSSD)',
    !reg.adapterSupportsMetric('oura', 'hrv_day'));
  assert('WHOOP declares hr_day from cycle endpoint',
    reg.adapterSupportsMetric('whoop', 'hr_day'));
  assert('Fitbit declares hrv_day from dailyRmssd (sleep+wake aggregate)',
    reg.adapterSupportsMetric('fitbit', 'hrv_day'));
  assert('Fitbit hrv_rmssd routes to deepRmssd (deep sleep only)',
    reg.adapterById('fitbit').metrics.hrv_rmssd?.field?.includes('deepRmssd'));
  assert('Fitbit hrv_day routes to dailyRmssd (broader-window aggregate)',
    reg.adapterById('fitbit').metrics.hrv_day?.field?.includes('dailyRmssd'));
  assert('Ultrahuman declares both hrv_day and hr_day (.avg fields are 24h)',
    reg.adapterSupportsMetric('ultrahuman', 'hrv_day') &&
    reg.adapterSupportsMetric('ultrahuman', 'hr_day'));
  assert('Ultrahuman hrv_rmssd routes to hrv.sleep (overnight)',
    reg.adapterById('ultrahuman').metrics.hrv_rmssd?.field === 'hrv.sleep');
  assert('Ultrahuman rhr routes to resting_heart_rate.sleep (overnight)',
    reg.adapterById('ultrahuman').metrics.rhr?.field === 'resting_heart_rate.sleep');
  assert('Polar hr_day routes to activity-transactions average',
    reg.adapterById('polar').metrics.hr_day?.endpoint?.includes('activity-transactions'));
  assert('Polar hrv_day routes to exercise-transactions (workout HRV is daytime)',
    reg.adapterById('polar').metrics.hrv_day?.endpoint?.includes('exercise-transactions'));
  assert('Polar rhr routes to sleep nights (true overnight RHR)',
    reg.adapterById('polar').metrics.rhr?.endpoint?.includes('/sleep'));
  assert('Apple Health declares hrv_day with window:day flag',
    reg.adapterById('apple_health').metrics.hrv_day?.window === 'day');

  // Strip integration: hrv_day/hr_day are summarised but hidden from the
  // strip cards — they live in the detail modal as sub-stats and in the
  // AI context. Regression guard so a future refactor doesn't accidentally
  // surface them as their own cards (visual clutter).
  const wearablesSrc = await fetch('/js/wearables.js').then(r => r.text());
  assert('Strip rendering hides hrv_day from card list',
    /STRIP_HIDDEN_METRICS\s*=\s*new Set\(\[[^\]]*'hrv_day'/.test(wearablesSrc));
  assert('Strip rendering hides hr_day from card list',
    /STRIP_HIDDEN_METRICS\s*=\s*new Set\(\[[^\]]*'hr_day'/.test(wearablesSrc));

  // Detail modal companion: when viewing the overnight HRV/RHR card, the
  // matching daytime aggregate appears as an extra stat row.
  assert('Detail modal pairs hrv_rmssd with hrv_day companion',
    /DAY_COMPANION\s*=\s*\{\s*hrv_rmssd:\s*'hrv_day'/.test(wearablesSrc));
  assert('Detail modal pairs rhr with hr_day companion',
    /DAY_COMPANION\s*=\s*\{[\s\S]*?rhr:\s*'hr_day'/.test(wearablesSrc));

  console.log(`\nResults: ${pass} passed, ${fail} failed, ${pass + fail} total`);
})();
