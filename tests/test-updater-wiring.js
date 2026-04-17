#!/usr/bin/env node
// Node-side source-inspection test for the auto-updater wiring.
// A full end-to-end updater test would need a real staged GitHub release,
// which isn't practical for CI. Instead we assert the structural invariants
// that every known regression class would break:
//
//   - main.js calls autoUpdater.checkForUpdates, caches its result
//   - install_update guards on app.isPackaged, reads the cache, calls
//     downloadUpdate + quitAndInstall in that order
//   - autoDownload / autoInstallOnAppQuit are disabled (renderer drives)
//   - UpdateInfo shape returned to renderer matches what js/updater.js consumes
//   - js/updater.js banner + skip + manual-check flow wires correctly

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSrc = fs.readFileSync(path.resolve(__dirname, '../electron/main.js'), 'utf8');
const uiSrc = fs.readFileSync(path.resolve(__dirname, '../js/updater.js'), 'utf8');
const settingsSrc = fs.readFileSync(path.resolve(__dirname, '../js/settings.js'), 'utf8');

const results = [];
let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; results.push(`  PASS: ${name}`); }
  else { failed++; results.push(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== auto-updater wiring ===\n');

// ── main.js structural invariants ───────────────────────────────

assert('main.js imports electron-updater',
  /require\(['"]electron-updater['"]\)/.test(mainSrc));
assert('autoDownload disabled (renderer drives the two-step UI)',
  /autoUpdater\.autoDownload\s*=\s*false/.test(mainSrc));
assert('autoInstallOnAppQuit disabled',
  /autoUpdater\.autoInstallOnAppQuit\s*=\s*false/.test(mainSrc));

// check_for_update handler
assert('check_for_update is guarded by app.isPackaged',
  /check_for_update[\s\S]{0,800}app\.isPackaged/.test(mainSrc));
assert('check_for_update calls autoUpdater.checkForUpdates',
  /check_for_update[\s\S]{0,800}autoUpdater\.checkForUpdates\(\)/.test(mainSrc));
assert('check_for_update caches result in lastUpdateCheck',
  /lastUpdateCheck\s*=\s*info/.test(mainSrc));
assert('check_for_update returns UpdateInfo shape (available, current_version, new_version, notes, date)',
  /available[\s\S]{0,100}current_version[\s\S]{0,100}new_version[\s\S]{0,100}notes[\s\S]{0,100}date/.test(mainSrc));

// install_update handler
assert('install_update guards on app.isPackaged',
  /install_update[\s\S]{0,300}app\.isPackaged/.test(mainSrc));
assert('install_update refuses when no cached check exists (hardened against stale banner)',
  /install_update[\s\S]{0,400}lastUpdateCheck/.test(mainSrc)
  && /This update listing is stale/.test(mainSrc));
assert('install_update calls downloadUpdate then quitAndInstall',
  /install_update[\s\S]{0,600}downloadUpdate\(\)[\s\S]{0,100}quitAndInstall/.test(mainSrc));

// Channel allowlist
assert('check_for_update handler registered',
  /ipcMain\.handle\(['"]check_for_update['"]/.test(mainSrc));
assert('install_update handler registered',
  /ipcMain\.handle\(['"]install_update['"]/.test(mainSrc));

// ── js/updater.js flow ──────────────────────────────────────────

assert('updater.js gates on isDesktop()',
  /checkForUpdate[\s\S]{0,200}isDesktop\(\)/.test(uiSrc));
assert('silent check suppresses toasts',
  /silent[\s\S]{0,300}showNotification/.test(uiSrc));
assert('manual check shows connection-error toast',
  /Couldn't check for updates/.test(uiSrc));
assert('installUpdateNow error toast references manual download',
  /github\.com\/elkimek\/get-based\/releases/.test(uiSrc));
assert('skipThisVersion persists to localStorage',
  /function skipThisVersion[\s\S]{0,300}localStorage\.setItem\(SKIP_VERSION_KEY/.test(uiSrc));
assert('auto-check runs every 6 hours',
  /CHECK_INTERVAL_MS\s*=\s*6\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(uiSrc));
assert('auto-check first run delayed by 30 s',
  /setTimeout\([\s\S]{0,60}?checkForUpdate[\s\S]{0,60}?30000/.test(uiSrc));

// Manual-check UI wiring (M6 fix)
assert('handleManualUpdateCheck export exists',
  /export async function handleManualUpdateCheck\(\)/.test(uiSrc));
assert('handleManualUpdateCheck toggles check-updates-btn state',
  /check-updates-btn[\s\S]{0,200}disabled\s*=\s*true/.test(uiSrc));
assert('handleManualUpdateCheck exposed on window',
  /window[\s\S]{0,300}handleManualUpdateCheck/.test(uiSrc));

// ── Settings panel integration ──────────────────────────────────

assert('Settings → Data includes App Updates section (desktop-only)',
  /App Updates/.test(settingsSrc)
  && /window\.api\s*&&\s*window\.api\.isDesktop/.test(settingsSrc));
assert('Settings renders Check-for-updates button',
  /check-updates-btn/.test(settingsSrc)
  && /handleManualUpdateCheck\(\)/.test(settingsSrc));
assert('Settings shows current APP_VERSION',
  /window\.APP_VERSION/.test(settingsSrc));

// ── Banner copy ─────────────────────────────────────────────────

assert('banner title uses product name "getbased"',
  /getbased\s*\${_esc\(info\.new_version\)}\s*is available/.test(uiSrc));
assert('banner has "Install and restart" button',
  /Install and restart/.test(uiSrc));
assert('banner has "Skip this version" button',
  /Skip this version/.test(uiSrc));
assert('banner "Dismiss" + "×" close buttons present',
  /dismissUpdateBanner/.test(uiSrc)
  && /aria-label="Dismiss"/.test(uiSrc));

// ── Done ────────────────────────────────────────────────────────

console.log(results.join('\n'));
console.log(`\nTotal: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
