#!/usr/bin/env node

const target = process.argv[2] || process.env.SMOKE_URL || 'http://127.0.0.1:8000/';

const res = await fetch(target, { redirect: 'manual' });
const csp = res.headers.get('content-security-policy');

if (!csp) {
  console.error(`Missing Content-Security-Policy header on ${target} (HTTP ${res.status})`);
  process.exit(1);
}

const requiredDirectives = [
  "default-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
];
const missing = requiredDirectives.filter(directive => !csp.includes(directive));
if (missing.length) {
  console.error(`Content-Security-Policy on ${target} is missing: ${missing.join(', ')}`);
  console.error(csp);
  process.exit(1);
}

console.log(`OK: Content-Security-Policy present on ${target}`);
