#!/usr/bin/env node
// Node-side unit tests for dev-server helpers:
//   - parseEnvLocal:    quoted/unquoted values, inline comments, whitespace,
//                       malformed lines, mixed-case key rejection
//   - _proxyHostBlocked: private/loopback/link-local/metadata IP ranges, the
//                       6 live vendor hosts (must NOT be blocked), strict
//                       decimal octet parsing (no octal smuggling)
//   - _isAllowedProxyUrl: vendor-allowlist shortcuts + HTTPS-public-host fallback
//
// These were extracted as exports so tests can import them without spinning
// up the HTTP server (the server-side SSRF guard would be end-to-end work).

import { parseEnvLocal, _proxyHostBlocked, _isAllowedProxyUrl } from '../dev-server.js';

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

console.log('\n── parseEnvLocal ──');

// Basic key=value
{
  const p = parseEnvLocal('FOO=bar\nBAZ=qux');
  assert('parses two unquoted values', p.FOO === 'bar' && p.BAZ === 'qux');
}

// Double-quoted values stripped
{
  const p = parseEnvLocal('TOKEN="abc def"');
  assert('strips double quotes', p.TOKEN === 'abc def', JSON.stringify(p));
}

// Single-quoted values stripped
{
  const p = parseEnvLocal("SECRET='hello world'");
  assert('strips single quotes', p.SECRET === 'hello world');
}

// Full-line comment ignored
{
  const p = parseEnvLocal('# this is a comment\nFOO=bar');
  assert('ignores # comment lines', !('comment' in p) && p.FOO === 'bar');
}

// Leading whitespace on comment
{
  const p = parseEnvLocal('   # indented comment\nFOO=bar');
  assert('ignores indented # comment', p.FOO === 'bar' && Object.keys(p).length === 1);
}

// Whitespace around = tolerated
{
  const p = parseEnvLocal('FOO = bar\nBAZ=qux\nSPACED  =  value');
  assert('tolerates whitespace around =', p.FOO === 'bar' && p.SPACED === 'value');
}

// Trailing whitespace on value stripped
{
  const p = parseEnvLocal('FOO=bar   ');
  assert('strips trailing whitespace on value', p.FOO === 'bar', JSON.stringify(p.FOO));
}

// Empty value
{
  const p = parseEnvLocal('EMPTY=\nFOO=bar');
  assert('handles empty value', p.EMPTY === '' && p.FOO === 'bar');
}

// Equal sign inside value (after first =)
{
  const p = parseEnvLocal('URL=https://example.com/?a=1&b=2');
  assert('preserves = inside value', p.URL === 'https://example.com/?a=1&b=2');
}

// Malformed lines ignored (no =)
{
  const p = parseEnvLocal('NOT_AN_ASSIGNMENT\nFOO=bar\nalso bad');
  assert('ignores malformed lines', Object.keys(p).length === 1 && p.FOO === 'bar');
}

// Lowercase keys rejected (enforce uppercase-only convention)
{
  const p = parseEnvLocal('lowercase=no\nFOO=yes');
  assert('rejects lowercase keys', !('lowercase' in p) && p.FOO === 'yes');
}

// Numeric-leading keys rejected
{
  const p = parseEnvLocal('9ABC=no\nFOO=yes');
  assert('rejects numeric-leading keys', !('9ABC' in p) && p.FOO === 'yes');
}

// Underscore-leading key allowed
{
  const p = parseEnvLocal('_INTERNAL=value');
  assert('allows underscore-leading key', p._INTERNAL === 'value');
}

// Mixed: comment + blank + value
{
  const p = parseEnvLocal('# comment\n\n  \nFOO=bar\n\n# another\nBAZ=qux');
  assert('handles blank lines + comments', p.FOO === 'bar' && p.BAZ === 'qux' && Object.keys(p).length === 2);
}

// Realistic OAuth secrets
{
  const p = parseEnvLocal(
    '# getbased local OAuth secrets — DO NOT COMMIT\n' +
    'OURA_CLIENT_SECRET="S3cr3tVal"\n' +
    'WITHINGS_CLIENT_SECRET=unquoted-value-with-dashes\n' +
    'ULTRAHUMAN_CLIENT_SECRET=\'single-quoted\'\n'
  );
  assert('real-world .env.local round-trips',
    p.OURA_CLIENT_SECRET === 'S3cr3tVal' &&
    p.WITHINGS_CLIENT_SECRET === 'unquoted-value-with-dashes' &&
    p.ULTRAHUMAN_CLIENT_SECRET === 'single-quoted',
    JSON.stringify(p));
}

console.log('\n── _proxyHostBlocked ──');

// Loopback / localhost
assert('blocks localhost',     _proxyHostBlocked('localhost'));
assert('blocks 127.0.0.1',     _proxyHostBlocked('127.0.0.1'));
assert('blocks ::1',           _proxyHostBlocked('::1'));
assert('blocks [::1]',         _proxyHostBlocked('[::1]'));
assert('blocks .local TLD',    _proxyHostBlocked('server.local'));
assert('blocks .localhost',    _proxyHostBlocked('foo.localhost'));
assert('blocks 127/8 edges',   _proxyHostBlocked('127.255.255.254') && _proxyHostBlocked('127.0.0.42'));

// Private RFC1918
assert('blocks 10.0.0.0/8',     _proxyHostBlocked('10.0.0.1') && _proxyHostBlocked('10.255.255.254'));
assert('blocks 172.16.0.0/12',  _proxyHostBlocked('172.16.0.1') && _proxyHostBlocked('172.31.255.254'));
assert('allows 172.15/172.32',  !_proxyHostBlocked('172.15.0.1') && !_proxyHostBlocked('172.32.0.1'));
assert('blocks 192.168.0.0/16', _proxyHostBlocked('192.168.1.1'));

// Link-local + AWS/GCP metadata
assert('blocks 169.254.0.0/16', _proxyHostBlocked('169.254.169.254'));
assert('blocks Azure metadata', _proxyHostBlocked('168.63.129.16'));

// CGNAT
assert('blocks 100.64.0.0/10',  _proxyHostBlocked('100.64.0.1') && _proxyHostBlocked('100.127.255.254'));
assert('allows 100.63 / 100.128', !_proxyHostBlocked('100.63.0.1') && !_proxyHostBlocked('100.128.0.1'));

// 0.0.0.0/8
assert('blocks 0.0.0.0/8', _proxyHostBlocked('0.0.0.0') && _proxyHostBlocked('0.42.42.42'));

// Octal smuggling — leading zeros should be rejected
assert('blocks leading-zero octets', _proxyHostBlocked('010.0.0.1'));
assert('blocks leading-zero octets mid-IP', _proxyHostBlocked('8.8.08.8'));

// Out-of-range octet — defensive stance: invalid-IP literals are blocked
// rather than passed through. Fine because new URL() would reject them too.
assert('blocks out-of-range IPv4 literals', _proxyHostBlocked('999.999.999.999'));
assert('blocks single-octet-overflow', _proxyHostBlocked('256.0.0.1'));

// Empty host blocked
assert('blocks empty host', _proxyHostBlocked(''));

// All 6 live vendor hosts MUST be allowed (regression guard: never block prod)
const VENDOR_HOSTS = [
  'api.ouraring.com',
  'api.prod.whoop.com',
  'partner.ultrahuman.com',
  'wbsapi.withings.net',
  'api.fitbit.com',
  'www.polaraccesslink.com',
  'polarremote.com',
  // apple_health is file-import, no host
  'openrouter.ai',
  'api.venice.ai',
  'api.routstr.com',
  'api.ppq.ai',
];
for (const host of VENDOR_HOSTS) {
  assert(`allows vendor host ${host}`, !_proxyHostBlocked(host));
}

console.log('\n── _isAllowedProxyUrl ──');

assert('allows openrouter allowlist',  _isAllowedProxyUrl('https://openrouter.ai/api/v1/chat/completions'));
assert('allows oura allowlist',        _isAllowedProxyUrl('https://api.ouraring.com/v2/usercollection/sleep'));
assert('allows withings allowlist',    _isAllowedProxyUrl('https://wbsapi.withings.net/measure'));
assert('allows fitbit allowlist',      _isAllowedProxyUrl('https://api.fitbit.com/1/user/-/profile.json'));
assert('allows whoop allowlist',       _isAllowedProxyUrl('https://api.prod.whoop.com/developer/v1/recovery'));
assert('allows ultrahuman allowlist',  _isAllowedProxyUrl('https://partner.ultrahuman.com/api/partners/v1/user_data/metrics'));
assert('allows polar accesslink',      _isAllowedProxyUrl('https://www.polaraccesslink.com/v3/users/123/activity-transactions'));
assert('allows polar token endpoint',  _isAllowedProxyUrl('https://polarremote.com/v2/oauth2/token'));

assert('allows custom HTTPS public host', _isAllowedProxyUrl('https://api.example.com/v1/chat'));
assert('blocks HTTP (no TLS)',         !_isAllowedProxyUrl('http://api.example.com/v1/chat'));
assert('blocks loopback',              !_isAllowedProxyUrl('https://localhost/admin'));
assert('blocks private IP',            !_isAllowedProxyUrl('https://192.168.1.1/admin'));
assert('blocks cloud metadata',        !_isAllowedProxyUrl('https://169.254.169.254/latest/meta-data/'));
assert('blocks .local',                !_isAllowedProxyUrl('https://box.local/admin'));
assert('blocks malformed URL',         !_isAllowedProxyUrl('not a url'));

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed === 0 ? 0 : 1);
