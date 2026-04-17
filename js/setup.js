// setup.js — Lens auto-start on app launch for Tauri builds.
//
// The interactive setup UI + progress polling + phase rendering all live in
// `js/knowledge-base.js` now (Settings → AI → Local Knowledge Base). This
// file used to duplicate that state and run its own poll loop, which raced
// the KB state and left both views out of sync. Only the auto-start hook
// survived the consolidation.

// ─── Tauri API detection ────────────────────────────────────────
function isTauri() {
  return !!(window.__TAURI_INTERNALS__);
}

async function invoke(cmd, args = {}) {
  if (!isTauri()) return null;
  return window.__TAURI_INTERNALS__.invoke(cmd, args);
}

export function isSetupAvailable() {
  return isTauri();
}

export async function fetchSetupStatus() {
  if (!isTauri()) return null;
  try {
    return await invoke('get_setup_status');
  } catch (e) {
    console.warn('[Setup] Failed to fetch status:', e);
    return null;
  }
}

// Auto-start lens server if setup is complete and the user has Custom
// Knowledge Source enabled. Keeps the lens server warm when the user returns
// to the app, without ever pulling them through setup against their will.
async function maybeAutoStartLens() {
  if (!isTauri()) return;
  try {
    const status = await fetchSetupStatus();
    if (!status || status.is_first_run) return; // not set up yet
    // Check if user has Custom Knowledge Source enabled (might point at local lens)
    const cfg = (window.getLensConfig && window.getLensConfig()) || {};
    if (!cfg.enabled) return;
    // Try to start; ignore "already running"
    try {
      await invoke('start_lens');
      console.info('[Setup] Lens server auto-started');
    } catch (e) {
      const msg = String(e || '');
      if (!msg.includes('already running')) {
        console.warn('[Setup] Lens auto-start failed:', e);
      }
    }
  } catch (e) {
    console.warn('[Setup] auto-start check failed:', e);
  }
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(maybeAutoStartLens, 1000));
  } else {
    setTimeout(maybeAutoStartLens, 1000);
  }
}

Object.assign(window, {
  isSetupAvailable,
  fetchSetupStatus,
});
