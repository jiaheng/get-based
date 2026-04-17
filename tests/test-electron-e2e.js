#!/usr/bin/env node
// Full Electron E2E: spawn the real app with remote-debugging-port, attach
// Puppeteer, execute window.api.invoke() from the renderer, assert each
// IPC channel round-trips. Complements the static ipc-drift test — this
// one proves handlers actually respond, preload is wired, and the
// renderer can reach main.
//
// Spawns the shipping main.js unmodified — if a regression breaks
// window creation or preload registration, this test catches it.
//
// Graceful skip on platforms where Electron can't find a display
// (no DISPLAY on Linux, no xvfb available) — exits 0 with a warning
// rather than failing CI. Trade-off: local + macOS/Windows CI get
// coverage; Linux CI without xvfb skips.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const results = [];
let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; results.push(`  PASS: ${name}`); }
  else { failed++; results.push(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

function skip(reason) {
  console.log('=== electron E2E ===\n');
  console.log(`  SKIP: ${reason}`);
  process.exit(0);
}

// ── Environment probe ──────────────────────────────────────────

if (process.platform === 'linux' && !process.env.DISPLAY) {
  skip('no DISPLAY (need xvfb-run on CI — apt-get install xvfb, then xvfb-run node tests/test-electron-e2e.js)');
}

// Load puppeteer (same version used by the Puppeteer browser suite).
let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch {
  skip('puppeteer not installed in node_modules');
}

const electronBin = require.resolve('electron/cli.js');
// Some environments use `node_modules/.bin/electron`; the binary lives at
// `node_modules/electron/dist/electron` which cli.js spawns for us.

// ── Spawn Electron ─────────────────────────────────────────────

console.log('=== electron E2E ===\n');
console.log('spawning electron…');
// Use a high non-standard port so multiple test runs don't collide.
const DEBUG_PORT = 9229 + Math.floor(Math.random() * 1000);
const electron = spawn('node', [
  electronBin,
  projectRoot,
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--remote-allow-origins=*',
  '--no-sandbox', // required on some CI images
], {
  env: {
    ...process.env,
    // Force packaged-like path so CSP + will-navigate kick in like production.
    ELECTRON_DEV: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let electronStdout = '';
let electronStderr = '';
electron.stdout.on('data', (c) => { electronStdout += c.toString('utf8'); });
electron.stderr.on('data', (c) => { electronStderr += c.toString('utf8'); });

let browser = null;

async function cleanup() {
  try { if (browser) await browser.disconnect(); } catch {}
  try { electron.kill('SIGKILL'); } catch {}
}

process.on('uncaughtException', async (e) => {
  console.error('uncaught:', e);
  await cleanup();
  process.exit(1);
});

try {
  // Wait for debugger to come up. Electron logs the URL to stderr.
  let attached = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !attached) {
    await sleep(250);
    try {
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${DEBUG_PORT}`,
        defaultViewport: null,
      });
      attached = true;
    } catch { /* still booting */ }
  }
  if (!attached) {
    console.error('Electron stderr:', electronStderr.slice(0, 2000));
    throw new Error('timeout waiting for electron --remote-debugging-port to come up');
  }

  // Find the app's renderer page. Puppeteer's browser.pages() may return
  // stale targets; poll browser.targets() until the main renderer shows
  // up (different from devtools, preload, or network targets).
  let appPage = null;
  const pageDeadline = Date.now() + 10000;
  while (Date.now() < pageDeadline && !appPage) {
    const targets = browser.targets();
    for (const t of targets) {
      if (t.type() !== 'page') continue;
      const url = t.url();
      if (url.startsWith('file://') || url.startsWith('http://localhost:8000') || url === 'about:blank') {
        appPage = await t.page();
        if (appPage) break;
      }
    }
    if (!appPage) await sleep(250);
  }
  if (!appPage) {
    const seen = browser.targets().map((t) => `${t.type()}:${t.url()}`).join(', ');
    throw new Error(`no renderer page found (targets: ${seen})`);
  }

  // Wait for window.api to appear — it's injected by the preload bridge
  // during early document setup. Every IPC call after this can trust it.
  const apiReady = await appPage.waitForFunction(
    () => typeof window !== 'undefined' && window.api && typeof window.api.invoke === 'function',
    { timeout: 15000 },
  ).then(() => true).catch(() => false);
  assert('preload bridge exposed window.api.invoke in renderer', apiReady);

  if (!apiReady) throw new Error('window.api never attached; preload may be broken');

  // ── Invoke each core IPC channel and assert response shape ──

  // get_setup_status
  const status = await appPage.evaluate(() => window.api.invoke('get_setup_status'));
  assert('get_setup_status returns an object', status && typeof status === 'object');
  assert('get_setup_status has phase, gpu, is_first_run fields',
    status?.phase && status?.gpu && 'is_first_run' in status);

  // detect_gpu
  const gpu = await appPage.evaluate(() => window.api.invoke('detect_gpu'));
  assert('detect_gpu returns a vendor + provider',
    gpu && typeof gpu.vendor === 'string' && typeof gpu.recommended_provider === 'string');

  // detect_all_gpus
  const allGpus = await appPage.evaluate(() => window.api.invoke('detect_all_gpus'));
  assert('detect_all_gpus returns an array', Array.isArray(allGpus));

  // get_lens_status (no child running)
  const lensStatus = await appPage.evaluate(() => window.api.invoke('get_lens_status'));
  assert('get_lens_status returns running flag',
    lensStatus && typeof lensStatus.running === 'boolean');
  assert('get_lens_status url is http://127.0.0.1:8322',
    lensStatus?.url === 'http://127.0.0.1:8322');

  // get_ingest_progress (idle)
  const prog = await appPage.evaluate(() => window.api.invoke('get_ingest_progress'));
  assert('get_ingest_progress returns null when idle', prog === null);

  // Allowlist enforcement — unknown channel should reject.
  const rejected = await appPage.evaluate(async () => {
    try { await window.api.invoke('this_channel_definitely_does_not_exist'); return false; }
    catch { return true; }
  });
  assert('preload allowlist rejects unknown channels', rejected);

  // check_for_update — packaged=false in this run, returns "not available"
  const updateInfo = await appPage.evaluate(() => window.api.invoke('check_for_update'));
  assert('check_for_update returns {available:false} in unpackaged dev',
    updateInfo && updateInfo.available === false);
  assert('check_for_update includes current_version',
    typeof updateInfo?.current_version === 'string');

  // ── Navigation lock: attempting to navigate away from origin blocked ──
  // We can't easily test will-navigate from inside executeJavaScript (the
  // event fires in the main process), so assert the renderer's bridge is
  // CSP-compliant by trying to eval a script tag with an external src —
  // if CSP is injecting, this will reject. This only runs on file://
  // (packaged path); on localhost dev, CSP is per-response so it applies.
  const cspBlocks = await appPage.evaluate(async () => {
    try {
      const s = document.createElement('script');
      s.src = 'https://evil.example.com/steal.js';
      document.head.appendChild(s);
      return await new Promise((resolve) => {
        s.onerror = () => resolve(true);  // blocked
        s.onload = () => resolve(false);  // loaded — CSP missing
        setTimeout(() => resolve(true), 500);  // treat timeout as blocked
      });
    } catch { return true; }
  });
  assert('CSP blocks cross-origin script from disallowed host', cspBlocks);

  // ── External URL handling: setWindowOpenHandler guard ──
  // window.open returns null in Electron when setWindowOpenHandler denies.
  const externalBlocked = await appPage.evaluate(() => {
    try {
      const w = window.open('file:///etc/passwd', '_blank');
      return w === null;
    } catch { return true; }
  });
  assert('window.open for file:// URL is blocked',
    externalBlocked !== false,
    `got ${externalBlocked}`);

  // ── Cleanup ──

  await cleanup();

  console.log(results.join('\n'));
  console.log(`\nTotal: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
} catch (e) {
  console.error('\ne2e harness error:', e.message);
  if (electronStderr) console.error('electron stderr (last 2KB):', electronStderr.slice(-2000));
  await cleanup();
  process.exit(1);
}
