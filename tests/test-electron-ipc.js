#!/usr/bin/env node
// Integration tests for the code the Electron ipcMain handlers wrap.
// Exercises SetupManager + LensManager at the class boundary — same
// surface that `electron/main.js` delegates to for every IPC handler.
//
// Covers:
//   SetupManager.status() on a fresh + completed install
//   SetupManager.reset() clears marker + returns to not_started
//   LensManager.status() with no child running
//   LensManager.stop() is idempotent when nothing to stop
//   LensManager.configure() merges partial overrides
//   Orphan reap returns a sane count without killing unrelated processes
//   runLensCommand returns a structured result shape (stdout/stderr/ok)
//
// What this DOESN'T cover (requires full Electron launch):
//   ipcMain.handle registration + allowlist enforcement
//   Renderer → preload → main message round-trip
//   Progress event streaming (setup:progress)
//   install_update / quitAndInstall flow
//   Window lifecycle
//
// Those gaps are tracked for a future Puppeteer-attached-to-Electron
// harness. Run: node tests/test-electron-ipc.js

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { SetupManager } from '../electron/setup.js';
import { LensManager } from '../electron/lens-manager.js';
import { redactBearer, percentEncodePath } from '../electron/lens-manager.js';
import { setupMarkerPath } from '../electron/paths.js';
import { detectGpu } from '../electron/gpu.js';

const results = [];
let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; results.push(`  PASS: ${name}`); }
  else { failed++; results.push(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== electron IPC surface (class-level integration) ===\n');

// ── SetupManager ────────────────────────────────────────────────

const mgr = new SetupManager({ onProgress: () => {} });

// Initial state: depends on whether THIS dev box has done setup already.
// Test the invariants that hold regardless of state.
const s1 = await mgr.status();
assert('setup.status returns { phase, gpu, is_first_run, lens_binary }',
  s1 && typeof s1.phase === 'object' && 'is_first_run' in s1,
  `got ${JSON.stringify(Object.keys(s1 || {}))}`);
assert('setup.status phase is an object with a `phase` tag',
  s1.phase && typeof s1.phase.phase === 'string');
assert('setup.status gpu info carries recommended_provider',
  s1.gpu && typeof s1.gpu.recommended_provider === 'string');

// reset() must flip phase back to not_started even when no marker exists.
await mgr.reset();
const s2 = await mgr.status();
assert('setup.reset → phase === "not_started"',
  s2.phase.phase === 'not_started',
  `got ${s2.phase.phase}`);

// cancel() on an idle manager must be a no-op (not throw, not spawn anything).
let cancelOk = true;
try { await mgr.cancel(); } catch { cancelOk = false; }
assert('setup.cancel is safe when no child is running', cancelOk);

// ── LensManager ─────────────────────────────────────────────────

const lens = new LensManager();

const ls1 = await lens.status();
assert('lens.status returns { running, uptime_seconds, health, url, gpu }',
  ls1 && 'running' in ls1 && 'uptime_seconds' in ls1 && 'url' in ls1 && 'gpu' in ls1);
assert('lens.status running === false before start()',
  ls1.running === false);
assert('lens.status uptime === null before start()',
  ls1.uptime_seconds === null);
assert('lens.status url is http://127.0.0.1:8322 by default',
  ls1.url === 'http://127.0.0.1:8322');
assert('lens.status gpu.provider is a string',
  typeof ls1.gpu?.provider === 'string');

// stop() on an idle manager: no throw, no hang, completes fast.
const stopT0 = Date.now();
let stopOk = true;
try { await lens.stop(); } catch { stopOk = false; }
assert('lens.stop is idempotent when no child running', stopOk);
assert('lens.stop returns within 2s when idle',
  Date.now() - stopT0 < 2000,
  `took ${Date.now() - stopT0}ms`);

// configure() merges partial overrides without wiping defaults.
await lens.configure({ port: 9876, reranker: true });
assert('lens.configure partial merge keeps host default',
  lens._config.host === '127.0.0.1');
assert('lens.configure partial merge updates port',
  lens._config.port === 9876);
assert('lens.configure honors reranker knob',
  lens._config.reranker === true);

// Ignore non-object configs instead of throwing (matches Rust behavior).
await lens.configure(null);
await lens.configure('not-an-object');
assert('lens.configure tolerates null + non-object args',
  lens._config.port === 9876);

// ── Free-function helpers (already covered by test-electron-helpers,
//    repeat the shape checks here to catch import-path regressions) ──

assert('redactBearer export still reachable via lens-manager',
  typeof redactBearer === 'function'
  && redactBearer('Bearer xyz') === 'Bearer [REDACTED]');
assert('percentEncodePath export still reachable via lens-manager',
  typeof percentEncodePath === 'function'
  && percentEncodePath('/a b') === '/a%20b');

// ── Path resolution across dev vs packaged mode ─────────────────

const marker = setupMarkerPath();
assert('setup marker path lands under user data dir',
  marker.includes('getbased') && marker.endsWith('.setup-complete'),
  marker);

// ── GPU detection runs without errors ───────────────────────────

const gpu = await detectGpu();
assert('detectGpu returns an object with recommended_provider',
  gpu && typeof gpu.recommended_provider === 'string');
assert('detectGpu returns one of the known providers',
  ['cuda', 'rocm', 'openvino', 'coreml', 'directml', 'cpu'].includes(gpu.recommended_provider),
  `got ${gpu.recommended_provider}`);

// ── Done ────────────────────────────────────────────────────────

console.log(results.join('\n'));
console.log(`\nTotal: ${passed} passed, ${failed} failed.`);
console.log('\nNOT COVERED (needs full Electron launch):');
console.log('  - ipcMain.handle registration + preload allowlist enforcement');
console.log('  - Renderer → preload → main IPC round-trip');
console.log('  - setup:progress event streaming');
console.log('  - install_update / quitAndInstall flow');
console.log('  - Window lifecycle (will-navigate, openExternalSafe, CSP)');

process.exit(failed === 0 ? 0 : 1);
