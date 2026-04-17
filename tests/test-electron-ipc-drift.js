#!/usr/bin/env node
// Static test: preload's ALLOWED_INVOKE_CHANNELS must match main.js's
// ipcMain.handle registrations exactly. No Electron launch required —
// we source-parse both files and diff the sets.
//
// Catches the single most likely regression class:
//   - New ipcMain.handle('foo', ...) added in main.js, preload's allowlist
//     not updated → renderer can't reach the channel
//   - Channel removed from main.js, allowlist entry left behind → dead
//     entry, preload says yes but main rejects
//   - Typo in either side → silent breakage
//
// Also checks preload's ALLOWED_SUBSCRIBE_CHANNELS against webContents.send
// calls in main.js, so push events stay consistent.
//
// Run: node tests/test-electron-ipc-drift.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const preloadSrc = fs.readFileSync(path.join(repoRoot, 'electron/preload.cjs'), 'utf8');
const mainSrc = fs.readFileSync(path.join(repoRoot, 'electron/main.js'), 'utf8');

const results = [];
let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; results.push(`  PASS: ${name}`); }
  else { failed++; results.push(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== Electron IPC allowlist drift ===\n');

// ── Extract allowlisted channels from preload.cjs ───────────────

function extractSet(src, varName) {
  const re = new RegExp(`const\\s+${varName}\\s*=\\s*new\\s+Set\\(\\[([\\s\\S]*?)\\]\\)`);
  const m = src.match(re);
  if (!m) return null;
  const body = m[1];
  // Pull out 'literal' and "literal" entries, ignore comments/whitespace.
  const entries = [];
  const strRe = /['"]([^'"]+)['"]/g;
  let sm;
  while ((sm = strRe.exec(body)) !== null) entries.push(sm[1]);
  return new Set(entries);
}

const allowInvoke = extractSet(preloadSrc, 'ALLOWED_INVOKE_CHANNELS');
const allowSubscribe = extractSet(preloadSrc, 'ALLOWED_SUBSCRIBE_CHANNELS');
assert('preload.cjs: ALLOWED_INVOKE_CHANNELS defined', allowInvoke !== null);
assert('preload.cjs: ALLOWED_SUBSCRIBE_CHANNELS defined', allowSubscribe !== null);

// ── Extract registered channels from main.js ────────────────────

// ipcMain.handle('name', handler) — both single and double-quoted names.
const handleRe = /ipcMain\.handle\s*\(\s*['"]([^'"]+)['"]/g;
const handlerCalls = new Set();
let hm;
while ((hm = handleRe.exec(mainSrc)) !== null) handlerCalls.add(hm[1]);

// webContents.send('name', payload) — captured from broadcastProgress etc.
// win.webContents.send(...) or mainWindow.webContents.send(...) etc.
const sendRe = /webContents\.send\s*\(\s*['"]([^'"]+)['"]/g;
const sendCalls = new Set();
let sm;
while ((sm = sendRe.exec(mainSrc)) !== null) sendCalls.add(sm[1]);

assert('main.js: found at least one ipcMain.handle registration', handlerCalls.size > 0);
assert('main.js: found at least one webContents.send call', sendCalls.size > 0);

// ── Diff the sets ──────────────────────────────────────────────

function diff(a, b) {
  return [...a].filter((x) => !b.has(x));
}

const inPreloadNotMain = diff(allowInvoke, handlerCalls);
const inMainNotPreload = diff(handlerCalls, allowInvoke);

assert(
  `every preload-allowed invoke channel is registered in main (${allowInvoke.size} entries)`,
  inPreloadNotMain.length === 0,
  inPreloadNotMain.length ? `extra in preload: ${inPreloadNotMain.join(', ')}` : '',
);
assert(
  `every main-registered channel is in the preload allowlist (${handlerCalls.size} entries)`,
  inMainNotPreload.length === 0,
  inMainNotPreload.length ? `missing from preload: ${inMainNotPreload.join(', ')}` : '',
);

// Subscribe channels: every webContents.send should be in the allowlist.
// Not necessarily the reverse — the allowlist can legitimately list channels
// the renderer subscribes to that main only sends from one code path.
const inSendNotAllow = diff(sendCalls, allowSubscribe);
assert(
  `every webContents.send channel is in ALLOWED_SUBSCRIBE_CHANNELS (${sendCalls.size} senders)`,
  inSendNotAllow.length === 0,
  inSendNotAllow.length ? `missing from allowlist: ${inSendNotAllow.join(', ')}` : '',
);

// ── Sanity: known channels must be present ─────────────────────

// Every ipcMain.handle channel in main.js. If a channel is added/removed,
// update this list to match — the drift test makes sure preload's
// allowlist is always in sync. NOTE: these are Electron main-process IPC
// channels. The browser-local lens's per-library worker-message types
// (activate_library, create_library, etc.) live in lens-local-worker.js's
// switch statement and are not Electron IPC — they're postMessage to the
// Web Worker. They're tested by test-lens-local-worker.js.
const mustHave = [
  'get_setup_status', 'run_setup', 'cancel_setup', 'reset_setup',
  'detect_gpu', 'detect_all_gpus',
  'get_lens_status', 'start_lens', 'stop_lens', 'configure_lens',
  'ingest_documents', 'get_ingest_progress', 'get_knowledge_stats',
  'delete_document', 'clear_knowledge', 'get_lens_config',
  'plugin:dialog|open',
  'check_for_update', 'install_update',
];
for (const ch of mustHave) {
  assert(`channel "${ch}" registered in main.js`, handlerCalls.has(ch));
  assert(`channel "${ch}" allowlisted in preload.cjs`, allowInvoke.has(ch));
}

// ── Done ────────────────────────────────────────────────────────

console.log(results.join('\n'));
console.log(`\nchannels registered: ${handlerCalls.size}, preload-allowed: ${allowInvoke.size}, push channels: ${sendCalls.size}`);
console.log(`Total: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
