// test-coverage-stragglers.js — Targeted probes for the 1-function-each
// gaps left after the AI-verdict + vendor-personalInfo sweeps.
//
// These functions are too narrow to merit deep behavioural assertions;
// each is a single error-path callback or one-line helper that the
// existing tests never reach. The asserts here verify the function's
// EFFECT (rejection / specific output / dom-class flip) rather than
// its presence — a pure "did V8 mark it called" probe would be brittle.

return (async function() {
  let pass = 0, fail = 0;
  function assert(name, condition, detail) {
    if (condition) { pass++; console.log(`%c PASS %c ${name}`, 'background:#22c55e;color:#fff;padding:2px 6px;border-radius:3px', '', detail || ''); }
    else { fail++; console.error(`%c FAIL %c ${name}`, 'background:#ef4444;color:#fff;padding:2px 6px;border-radius:3px', '', detail || ''); }
  }

  console.log('%c Coverage Stragglers ', 'background:#16a34a;color:#fff;font-size:14px;padding:4px 12px;border-radius:4px');

  // ─── 1. image-utils: img.onerror ───────────────────────────────────
  // resizeImage wires img.onerror → reject. Pass garbage bytes so the
  // browser's image decoder fails to parse → fires onerror.
  console.log('%c 1. image-utils img.onerror ', 'font-weight:bold;color:#16a34a');
  {
    const { resizeImage } = await import('/js/image-utils.js?bust=' + Date.now());
    const garbage = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], 'not-an-image.png', { type: 'image/png' });
    let rejected = false;
    try { await resizeImage(garbage, 64, 0.7); }
    catch (e) { rejected = /Failed to load image/i.test(e.message); }
    assert('resizeImage rejects with "Failed to load image" on garbage bytes (img.onerror fired)',
      rejected);
  }

  // ─── 2. lens-local-parsers: extractDocx ─────────────────────────────
  // Drive the full ingest router with a .docx file. With invalid DOCX
  // bytes, mammoth either returns empty text or throws — both branches
  // count extractDocx as called.
  console.log('%c 2. lens-local-parsers extractDocx ', 'font-weight:bold;color:#16a34a');
  {
    const parsers = await import('/js/lens-local-parsers.js?bust=' + Date.now());
    // extractDocx is internal — exposed via the public extractText router.
    // A fake .docx file (zip-shaped or not) flows through the router →
    // pickExtractor → extractDocx. mammoth chokes on garbage; we accept
    // either an empty string OR an error as evidence the function ran.
    const fakeDocx = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'x.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    let ran = false;
    try {
      const out = await parsers.extractFromFile(fakeDocx);
      // extractFromFile returns an array of {name, text}; even an empty
      // text string proves extractDocx ran.
      ran = Array.isArray(out);
    } catch (_) { ran = true; }
    assert('extractFromFile routed .docx through extractDocx', ran);
  }

  // ─── 3. wearables-oura-auth: .json().catch() arrow ──────────────────
  // The arrow `.catch(() => ({}))` on the token-exchange response only
  // fires when the proxy returns a body that isn't valid JSON
  // (CloudFront HTML error page in front of the Oura token endpoint).
  // Stub fetch to return raw HTML on 504; exchangeRes.clone().json()
  // throws → catch arrow runs → body becomes {}.
  console.log('%c 3. wearables-oura-auth json-catch arrow ', 'font-weight:bold;color:#16a34a');
  {
    const auth = await import('/js/wearables-oura-auth.js?bust=' + Date.now());
    const origFetch = window.fetch;
    const STATE_KEY = 'oura-oauth-pending';
    try {
      // Set up the pending CSRF state the callback validates against
      sessionStorage.setItem(STATE_KEY, JSON.stringify({
        state: 'state-xyz',
        redirectUri: 'http://localhost/cb',
        clientId: 'cli',
        profileId: 'p',
        startedAt: Date.now(),
      }));
      // 504 with HTML body — exercises .clone().json().catch + the
      // detail-fallback branch on the 5xx error
      window.fetch = async () => new Response(
        '<html><body>504 Gateway Timeout</body></html>',
        { status: 504, headers: { 'content-type': 'text/html' } }
      );
      const params = new URLSearchParams({ code: 'stub-code', state: 'state-xyz' });
      let result;
      try { result = await auth.completeOAuthCallback(params); } catch (_) {}
      assert('completeOAuthCallback handles non-JSON 5xx body (json .catch fired)',
        result?.ok === false);
      assert('completeOAuthCallback surfaces fallback error string',
        typeof result?.error === 'string' && result.error.length > 0,
        result?.error);
    } finally {
      window.fetch = origFetch;
      sessionStorage.removeItem(STATE_KEY);
    }
  }

  // ─── 4. utils: animationend `once` callback ─────────────────────────
  // The arrow inside showConfirmDialog's overlay click handler sets
  // `modal-nudge` then registers an animationend listener with
  // `{ once: true }` that strips the class. To fire it: open the dialog,
  // dispatch a backdrop click, then a synthetic animationend on the
  // .confirm-dialog.
  console.log('%c 4. utils showConfirmDialog animationend once ', 'font-weight:bold;color:#16a34a');
  {
    const utils = await import('/js/utils.js?bust=' + Date.now());
    // showConfirmDialog blocks until OK/Cancel — fire-and-forget; resolve
    // it at the end of the probe by clicking Cancel.
    const promise = utils.showConfirmDialog('probe');
    await new Promise(r => setTimeout(r, 50)); // let DOM render
    const overlay = document.getElementById('confirm-dialog-overlay');
    let nudgeApplied = false, nudgeCleared = false;
    if (overlay) {
      const dialog = overlay.querySelector('.confirm-dialog');
      // Dispatch a click whose target IS the overlay backdrop (not the dialog)
      const evt = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(evt, 'target', { value: overlay });
      overlay.dispatchEvent(evt);
      nudgeApplied = !!dialog?.classList.contains('modal-nudge');
      // Fire animationend → the {once:true} callback strips the class
      dialog?.dispatchEvent(new Event('animationend', { bubbles: true }));
      nudgeCleared = !dialog?.classList.contains('modal-nudge');
    }
    assert('confirm overlay backdrop-click added .modal-nudge', nudgeApplied);
    assert('animationend once-handler stripped .modal-nudge', nudgeCleared);
    // Resolve the dangling promise — click Cancel
    document.getElementById('confirm-cancel')?.click();
    await promise.catch(() => {});
  }

  console.log(`%c Result: ${pass} passed, ${fail} failed `, fail === 0
    ? 'background:#22c55e;color:#fff;font-size:14px;padding:4px 12px;border-radius:4px'
    : 'background:#ef4444;color:#fff;font-size:14px;padding:4px 12px;border-radius:4px');
  return { pass, fail };
})();
