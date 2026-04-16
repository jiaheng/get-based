// tauri-mock.js — Dev-only IPC stub so the Tauri-dependent UI can be driven
// from a plain Chrome tab (via dev-server on :8000). Activate with the query
// param ?tauri-mock=1. No-op otherwise, so regular browser sessions are
// unaffected and the real Tauri runtime wins when actually running inside
// the app.
//
// Classic script (not a module) — must execute before any module imports
// call isTauri(), so window.__TAURI_INTERNALS__ is present synchronously.
(function () {
  if (new URLSearchParams(location.search).get('tauri-mock') !== '1') return;
  if (window.__TAURI_INTERNALS__) return;

  const log = (...args) => console.log('%c[tauri-mock]', 'color:#c792ea', ...args);

  const nowSec = () => Math.floor(Date.now() / 1000);

  let _mockDocs = [
    { source: 'vitamin-d-mitochondria.md', chunks: 42, ingested_at: nowSec() - 3600 },
    { source: 'omega-3-meta-analysis.pdf', chunks: 65, ingested_at: nowSec() - 7200 },
    { source: 'longevity-notes.md', chunks: 20, ingested_at: nowSec() - 86400 },
  ];

  const stats = () => ({
    total_chunks: _mockDocs.reduce((n, d) => n + d.chunks, 0),
    documents: _mockDocs.slice(),
  });

  function invoke(cmd, args = {}) {
    log(cmd, args);
    switch (cmd) {
      // ── Setup / GPU ──────────────────────────────────────────────
      case 'get_setup_status':
        return Promise.resolve({
          is_first_run: false,
          phase: { phase: 'Done' },
          gpu: { vendor: 'NVIDIA', name: 'RTX 4090 (mock)', vram_mb: 24576, provider: 'cuda' },
          error: null,
        });
      case 'detect_gpu':
        return Promise.resolve({ vendor: 'NVIDIA', name: 'RTX 4090 (mock)', vram_mb: 24576, provider: 'cuda' });
      case 'detect_all_gpus':
        return Promise.resolve([{ vendor: 'NVIDIA', name: 'RTX 4090 (mock)', vram_mb: 24576, provider: 'cuda' }]);
      case 'run_setup':
        return new Promise((r) => setTimeout(() => r(null), 800));
      case 'reset_setup':
        return Promise.resolve(null);

      // ── Lens server ──────────────────────────────────────────────
      case 'get_lens_status':
        return Promise.resolve({ running: true, pid: 12345, port: 8321 });
      case 'start_lens':
      case 'stop_lens':
      case 'configure_lens':
        return Promise.resolve(null);
      case 'get_lens_config':
        return Promise.resolve({
          url: 'http://127.0.0.1:8321/query',
          api_key: 'mock-key-' + Math.random().toString(36).slice(2, 12),
          top_k: 5,
        });

      // ── Knowledge base ───────────────────────────────────────────
      case 'get_knowledge_stats':
        return Promise.resolve(stats());
      case 'ingest_documents': {
        const paths = (args && args.req && args.req.paths) || [];
        return new Promise((resolve) => {
          setTimeout(() => {
            for (const p of paths) {
              const name = String(p).split('/').pop() || 'doc.md';
              if (!_mockDocs.find((d) => d.source === name)) {
                _mockDocs.push({ source: name, chunks: 5 + Math.floor(Math.random() * 30), ingested_at: nowSec() });
              }
            }
            resolve({ documents_ingested: paths.length, chunks_added: paths.length * 20, errors: [] });
          }, 1200);
        });
      }
      case 'delete_document': {
        const src = args && args.source;
        _mockDocs = _mockDocs.filter((d) => d.source !== src);
        return Promise.resolve(null);
      }

      // ── Updater ──────────────────────────────────────────────────
      case 'check_for_update':
        return Promise.resolve({ available: false, version: null, notes: null });
      case 'install_update':
        return Promise.resolve(null);

      // ── Plugin: dialog (file/folder picker) ──────────────────────
      case 'plugin:dialog|open': {
        const opts = (args && args.options) || {};
        const multi = !!opts.multiple;
        const dir = !!opts.directory;
        const pick = dir
          ? '/home/mock-user/Documents/research-notes'
          : ['/home/mock-user/Documents/vitamin-d.md', '/home/mock-user/Documents/omega-3.pdf'];
        const value = multi || Array.isArray(pick) ? pick : pick;
        log('plugin:dialog|open →', value);
        return Promise.resolve(value);
      }

      default:
        console.warn('[tauri-mock] unhandled command:', cmd, args);
        return Promise.resolve(null);
    }
  }

  window.__TAURI_INTERNALS__ = { invoke };
  window.__TAURI_MOCK__ = true;

  // Tiny corner badge so there's no confusion about what's running.
  document.addEventListener('DOMContentLoaded', () => {
    const badge = document.createElement('div');
    badge.textContent = 'tauri-mock';
    badge.style.cssText =
      'position:fixed;bottom:8px;left:8px;z-index:99999;padding:2px 8px;' +
      'background:#c792ea;color:#1a1a1a;font:600 11px/1.4 ui-monospace,monospace;' +
      'border-radius:4px;opacity:.75;pointer-events:none;';
    document.body.appendChild(badge);
  });

  log('installed. window.__TAURI_INTERNALS__.invoke is mocked.');
})();
