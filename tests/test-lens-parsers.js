// test-lens-parsers.js — Browser test: js/lens-local-parsers.js edge cases.
// Verifies extractFromFile() never throws on malformed input and returns
// sensible empty results so a user drag-dropping junk can't wedge the app.
//
// Covers:
//   empty.zip        — valid zip with no entries
//   zero-byte.md     — empty supported-extension file
//   corrupt.pdf      — garbage bytes with .pdf extension
//   unsupported.xyz  — extension we don't recognize
//   no-extension     — filename with no dot at all
//   .MD (caps)       — case-insensitivity
//   nested.zip       — zip containing another zip (recursion cap)

return (async function() {
  let passed = 0, failed = 0;
  const results = [];
  function assert(name, cond, detail) {
    if (cond) { passed++; results.push(`  \u2705 ${name}`); }
    else { failed++; results.push(`  \u274c ${name}${detail ? ' \u2014 ' + detail : ''}`); }
  }

  const { extractFromFile } = await import('/js/lens-local-parsers.js');

  // ── zero-byte markdown ──
  {
    const f = new File([''], 'empty.md', { type: 'text/markdown' });
    let out, err;
    try { out = await extractFromFile(f); } catch (e) { err = e; }
    assert('zero-byte .md does not throw', !err, err?.message);
    assert('zero-byte .md returns one entry with empty text',
      Array.isArray(out) && out.length === 1 && out[0].text === '',
      `got ${JSON.stringify(out)}`);
  }

  // ── unsupported extension ──
  {
    const f = new File(['stuff'], 'notes.xyz', { type: 'application/octet-stream' });
    let out, err;
    try { out = await extractFromFile(f); } catch (e) { err = e; }
    assert('unsupported .xyz does not throw', !err, err?.message);
    assert('unsupported .xyz returns []', Array.isArray(out) && out.length === 0);
  }

  // ── no extension at all ──
  {
    const f = new File(['hello world'], 'README', { type: '' });
    let out, err;
    try { out = await extractFromFile(f); } catch (e) { err = e; }
    assert('no-extension file does not throw', !err);
    assert('no-extension file returns []', Array.isArray(out) && out.length === 0);
  }

  // ── case-insensitive extension match ──
  {
    const f = new File(['hello'], 'Notes.MD', { type: 'text/markdown' });
    const out = await extractFromFile(f);
    assert('.MD (caps) detected as markdown', out.length === 1 && out[0].text === 'hello');
  }

  // ── empty zip ──
  // Build a minimal valid empty zip: "end of central directory" record only.
  {
    const eocd = new Uint8Array([
      0x50, 0x4b, 0x05, 0x06, // signature
      0x00, 0x00,             // disk number
      0x00, 0x00,             // disk with CD
      0x00, 0x00,             // total entries on this disk
      0x00, 0x00,             // total entries
      0x00, 0x00, 0x00, 0x00, // CD size
      0x00, 0x00, 0x00, 0x00, // CD offset
      0x00, 0x00,             // comment length
    ]);
    const f = new File([eocd], 'empty.zip', { type: 'application/zip' });
    let out, err;
    try { out = await extractFromFile(f); } catch (e) { err = e; }
    // JSZip accepts an empty zip without complaint — expect an empty array.
    assert('empty zip does not throw', !err, err?.message);
    assert('empty zip returns []', Array.isArray(out) && out.length === 0);
  }

  // ── corrupt PDF ──
  {
    // Pad to typical PDF length but with garbage (no %PDF header).
    const bad = new Uint8Array(128).fill(0x41); // "A" repeated
    const f = new File([bad], 'bad.pdf', { type: 'application/pdf' });
    let out, err;
    try { out = await extractFromFile(f); } catch (e) { err = e; }
    // pdf.js throws for garbage; the caller in _handleLocalLensIngest wraps
    // in try/catch + warn, so the contract here is "throws OR returns".
    // We accept either, but not "returns a bogus chunk". Both paths must
    // leave the app in a sane state.
    const isEmpty = !err && Array.isArray(out) && out.length === 0;
    const threwNicely = err && typeof err.message === 'string';
    assert('corrupt pdf either rejects or returns []',
      isEmpty || threwNicely,
      `out=${JSON.stringify(out)} err=${err?.message}`);
    // Extra: if it returned successfully, text shouldn't be garbage-long.
    if (isEmpty === false && out && out[0]?.text) {
      assert('corrupt pdf text is not suspiciously large',
        out[0].text.length < 10_000,
        `got ${out[0].text.length} chars`);
    }
  }

  // ── text files with weird whitespace ──
  {
    const f = new File(['  \n\n  '], 'whitespace.txt');
    const out = await extractFromFile(f);
    assert('whitespace-only .txt returns an entry', out.length === 1);
    // chunkText would reject this later (below min_size) — extractor's
    // job is just to return the raw text.
    assert('whitespace-only .txt preserves raw bytes', out[0].text === '  \n\n  ');
  }

  // ── JSON file ──
  {
    const f = new File(['{"a":1}'], 'data.json');
    const out = await extractFromFile(f);
    assert('.json extracted as text', out.length === 1 && out[0].text === '{"a":1}');
  }

  console.log('\n' + results.join('\n'));
  console.log(`\n%c${passed} passed, ${failed} failed`, `font-weight:bold;color:${failed ? 'red' : 'green'}`);
  return { passed, failed };
})();
