// updater.js — Auto-update check + install banner for desktop builds.
// Browser builds: all functions are no-ops.

import { showNotification } from './utils.js';

function isDesktop() {
  return !!(window.api && window.api.isDesktop);
}

async function invoke(cmd, args = {}) {
  if (!isDesktop()) return null;
  return window.api.invoke(cmd, args);
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const SKIP_VERSION_KEY = 'getbased-update-skip-version';

export async function checkForUpdate({ silent = false } = {}) {
  if (!isDesktop()) return null;
  try {
    const info = await invoke('check_for_update');
    if (info && info.available) {
      const skipped = localStorage.getItem(SKIP_VERSION_KEY);
      if (skipped && skipped === info.new_version && silent) {
        return info; // user opted out of this version
      }
      showUpdateBanner(info);
    } else if (!silent) {
      showNotification('You are on the latest version.', 'info');
    }
    return info;
  } catch (e) {
    if (!silent) {
      showNotification(`Couldn't check for updates — check your connection and try again.`, 'error');
    }
    console.warn('[Updater]', e);
    return null;
  }
}

export async function installUpdateNow() {
  if (!isDesktop()) return;
  const banner = document.getElementById('getbased-update-banner');
  const actions = banner?.querySelector('.update-banner-actions');
  if (actions) {
    actions.innerHTML = '<span style="color:var(--text-muted);font-size:13px">Downloading…</span>';
  }
  try {
    await invoke('install_update');
    // App restarts automatically — won't reach here
  } catch (e) {
    showNotification('Install failed. Retry, or download the new version manually from github.com/elkimek/get-based/releases.', 'error');
    console.error('[Updater]', e);
    const actionsAgain = banner?.querySelector('.update-banner-actions');
    if (actionsAgain) {
      actionsAgain.innerHTML = `
        <button class="import-btn import-btn-primary" onclick="installUpdateNow()">Retry</button>
        <button class="import-btn import-btn-secondary" onclick="dismissUpdateBanner()">Dismiss</button>`;
    }
  }
}

export function dismissUpdateBanner() {
  const b = document.getElementById('getbased-update-banner');
  if (b) b.remove();
}

export function skipThisVersion() {
  const banner = document.getElementById('getbased-update-banner');
  const ver = banner?.dataset?.version;
  if (ver) localStorage.setItem(SKIP_VERSION_KEY, ver);
  dismissUpdateBanner();
}

function showUpdateBanner(info) {
  if (document.getElementById('getbased-update-banner')) return;
  const notes = info.notes ? _esc(info.notes).slice(0, 400) : '';
  const html = `
    <div id="getbased-update-banner" data-version="${_esc(info.new_version)}" style="position:fixed;bottom:20px;right:20px;max-width:380px;background:var(--bg-secondary);border:1px solid var(--accent);border-radius:10px;padding:16px;box-shadow:0 8px 30px rgba(0,0,0,0.4);z-index:9000" role="dialog" aria-label="Update available">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <strong style="font-size:14px">getbased ${_esc(info.new_version)} is available</strong>
        <button onclick="dismissUpdateBanner()" aria-label="Dismiss" style="background:none;border:none;color:var(--text-muted);font-size:18px;cursor:pointer;line-height:1">×</button>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Current: ${_esc(info.current_version)}</div>
      ${notes ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;max-height:100px;overflow-y:auto;line-height:1.5">${notes}</div>` : ''}
      <div class="update-banner-actions" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="import-btn import-btn-primary" onclick="installUpdateNow()">Install and restart</button>
        <button class="import-btn import-btn-secondary" onclick="skipThisVersion()">Skip this version</button>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

function _esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

// Background auto-check on launch + every 6h
async function startAutoCheck() {
  if (!isDesktop()) return;
  // Initial check after 30s (don't compete with first-run flow)
  setTimeout(() => checkForUpdate({ silent: true }), 30000);
  setInterval(() => checkForUpdate({ silent: true }), CHECK_INTERVAL_MS);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startAutoCheck);
  } else {
    startAutoCheck();
  }
}

/// User-initiated check from Settings → Data → App Updates. Updates the
/// inline status line while the request is in flight so users get feedback
/// within a tick. checkForUpdate handles the toast/banner rendering; this
/// wrapper just drives the button state.
export async function handleManualUpdateCheck() {
  const btn = document.getElementById('check-updates-btn');
  const status = document.getElementById('update-check-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  if (status) status.textContent = 'Checking…';
  const info = await checkForUpdate({ silent: false });
  if (btn) { btn.disabled = false; btn.textContent = 'Check for updates'; }
  if (status) {
    if (info?.available) {
      status.textContent = `Update available: ${info.new_version}`;
      status.style.color = 'var(--green)';
    } else {
      status.textContent = `Current version: ${window.APP_VERSION || '?'} — up to date`;
      status.style.color = 'var(--text-muted)';
    }
  }
}

Object.assign(window, {
  checkForUpdate,
  installUpdateNow,
  dismissUpdateBanner,
  skipThisVersion,
  handleManualUpdateCheck,
});
