#!/usr/bin/env node
// Node-side test: dev-server /api/* same-origin guard rejects forged headers.
// Probes a running dev server. Issue #119.
// Run: node tests/test-dev-server-origin.js (server must be on :$PORT, default 8000)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8000;
const HOST = '127.0.0.1';

function probe(method, pathStr, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path: pathStr, method, headers, timeout: 5000 }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

(async () => {
  const results = [];
  let passed = 0, failed = 0;
  function assert(name, cond, detail) {
    if (cond) { passed++; results.push(`  PASS: ${name}`); }
    else { failed++; results.push(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
  }

  console.log('=== dev-server origin guard tests ===\n');

  // 1. No Origin/Referer → 403
  try {
    const status = await probe('GET', '/api/check-url?url=https://example.com', {});
    assert('no headers → 403', status === 403, `got ${status}`);
  } catch (e) { assert('no headers → 403', false, e.message); }

  // 2. Forged foreign Referer with substring → must be 403 (the bug)
  try {
    const status = await probe('GET', '/api/check-url?url=https://example.com', {
      'Referer': `https://evil.example/?next=http://${HOST}:${PORT}/`,
    });
    assert('forged Referer substring → 403', status === 403, `got ${status} (substring bypass present)`);
  } catch (e) { assert('forged Referer substring → 403', false, e.message); }

  // 3. Forged foreign Origin with substring → must be 403
  try {
    const status = await probe('GET', '/api/check-url?url=https://example.com', {
      'Origin': `https://evil.example.${HOST}:${PORT}.attacker.io`,
    });
    assert('forged Origin substring → 403', status === 403, `got ${status}`);
  } catch (e) { assert('forged Origin substring → 403', false, e.message); }

  // 4. Legitimate Origin → 200 (request reaches handler; upstream may fail but guard passed)
  try {
    const status = await probe('GET', '/api/check-url?url=https://example.com', {
      'Origin': `http://${HOST}:${PORT}`,
    });
    assert('legitimate Origin → not 403', status !== 403, `got ${status}`);
  } catch (e) { assert('legitimate Origin → not 403', false, e.message); }

  // 5. Legitimate Referer → 200 (same)
  try {
    const status = await probe('GET', '/api/check-url?url=https://example.com', {
      'Referer': `http://${HOST}:${PORT}/app`,
    });
    assert('legitimate Referer → not 403', status !== 403, `got ${status}`);
  } catch (e) { assert('legitimate Referer → not 403', false, e.message); }

  // 6. Localhost Origin → 200
  try {
    const status = await probe('GET', '/api/check-url?url=https://example.com', {
      'Origin': `http://localhost:${PORT}`,
    });
    assert('localhost Origin → not 403', status !== 403, `got ${status}`);
  } catch (e) { assert('localhost Origin → not 403', false, e.message); }

  // 6b. IPv6 loopback Origin → 200
  try {
    const status = await probe('GET', '/api/check-url?url=https://example.com', {
      'Origin': `http://[::1]:${PORT}`,
    });
    assert('IPv6 [::1] Origin → not 403', status !== 403, `got ${status}`);
  } catch (e) { assert('IPv6 [::1] Origin → not 403', false, e.message); }

  // 6c. Lookalike origin with valid prefix but extra suffix → 403
  try {
    const status = await probe('GET', '/api/check-url?url=https://example.com', {
      'Origin': `http://localhost:${PORT}.evil.example`,
    });
    assert('lookalike "localhost:PORT.evil" Origin → 403', status === 403, `got ${status}`);
  } catch (e) { assert('lookalike "localhost:PORT.evil" Origin → 403', false, e.message); }

  // 6d. Malformed Referer → URL parse throws → 403
  try {
    const status = await probe('GET', '/api/check-url?url=https://example.com', {
      'Referer': 'not a valid url',
    });
    assert('malformed Referer → 403', status === 403, `got ${status}`);
  } catch (e) { assert('malformed Referer → 403', false, e.message); }

  // 7. Source inspection — substring check is gone, parsing is in
  const src = fs.readFileSync(path.join(__dirname, '..', 'dev-server.js'), 'utf8');
  assert('isSameOrigin no longer uses .includes() for origin', !/origin\.includes\(`localhost:/.test(src));
  assert('isSameOrigin parses Referer via new URL().origin', /new URL\(req\.headers\.referer\)\.origin/.test(src));
  assert('ALLOWED_ORIGINS Set defined', /ALLOWED_ORIGINS = new Set/.test(src));

  console.log(results.join('\n'));
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})();
