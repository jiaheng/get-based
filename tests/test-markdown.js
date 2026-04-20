// test-markdown.js — Markdown rendering + XSS surface assertions.
// markdown.js runs on every streamed AI response. Previously had zero
// dedicated tests; surfaced as E's priority-1 gap in the 2026-04-20 audit.
//
// Run: fetch('tests/test-markdown.js').then(r=>r.text()).then(s=>Function(s)())

return (async function() {
  let passed = 0, failed = 0;
  const fails = [];
  function assert(name, cond, detail) {
    if (cond) { passed++; console.log(`  %c PASS %c ${name}`, 'background:#22c55e;color:#fff;padding:2px 6px;border-radius:3px', '', detail || ''); }
    else { failed++; fails.push(name); console.error(`  %c FAIL %c ${name}`, 'background:#ef4444;color:#fff;padding:2px 6px;border-radius:3px', '', detail || ''); }
  }

  console.log('%c Markdown Rendering + XSS Tests ', 'background:#6366f1;color:#fff;font-size:14px;padding:4px 12px;border-radius:4px');

  // Dynamic import — markdown.js is an ES module that lens-local tests
  // already use this pattern for.
  const mod = await import('/js/markdown.js');
  const { applyInlineMarkdown, renderMarkdown } = mod;

  // ─── 1. Inline markdown basics ───
  console.log('%c 1. Inline basics ', 'font-weight:bold;color:#f59e0b');

  assert('bold renders as <strong>',
    applyInlineMarkdown('**bold**') === '<strong>bold</strong>');
  assert('italic renders as <em>',
    applyInlineMarkdown('*italic*') === '<em>italic</em>');
  assert('inline code renders as <code>',
    applyInlineMarkdown('`code`') === '<code>code</code>');
  assert('bold + italic combine',
    applyInlineMarkdown('**bold** and *italic*') === '<strong>bold</strong> and <em>italic</em>');

  // ─── 2. XSS: raw HTML tags must be escaped ───
  console.log('%c 2. XSS — raw tags escaped ', 'font-weight:bold;color:#f59e0b');

  const scriptTag = applyInlineMarkdown('<script>alert(1)</script>');
  assert('<script> tag is escaped to &lt;script&gt;',
    scriptTag.includes('&lt;script&gt;') && !scriptTag.includes('<script>'));

  const imgTag = applyInlineMarkdown('<img src=x onerror=alert(1)>');
  assert('<img onerror> is escaped',
    imgTag.includes('&lt;img') && !imgTag.toLowerCase().includes('<img'),
    'raw img tag must not reach the DOM');

  const ampersand = applyInlineMarkdown('AT&T and <div>');
  assert('ampersand and < both encoded',
    ampersand.includes('AT&amp;T') && ampersand.includes('&lt;div&gt;'));

  // ─── 3. XSS: link URL scheme allowlist ───
  console.log('%c 3. XSS — link URL scheme ', 'font-weight:bold;color:#f59e0b');

  const jsLink = applyInlineMarkdown('[click](javascript:alert(1))');
  assert('javascript: URL in link is neutralized to #',
    jsLink.includes('href="#"') && !jsLink.toLowerCase().includes('javascript:'),
    'markdown links must only accept http(s) and mailto');

  const dataLink = applyInlineMarkdown('[img](data:text/html,<script>alert(1)</script>)');
  assert('data: URL in link is neutralized to #',
    dataLink.includes('href="#"') && !dataLink.toLowerCase().includes('data:'));

  const vbLink = applyInlineMarkdown('[x](vbscript:msgbox(1))');
  assert('vbscript: URL in link is neutralized',
    vbLink.includes('href="#"') && !vbLink.toLowerCase().includes('vbscript:'));

  const fileLink = applyInlineMarkdown('[read](file:///etc/passwd)');
  assert('file: URL in link is neutralized',
    fileLink.includes('href="#"') && !fileLink.toLowerCase().includes('file:'));

  const httpLink = applyInlineMarkdown('[ok](http://example.com/path)');
  assert('http:// URL passes through unchanged',
    httpLink.includes('href="http://example.com/path"'));

  const httpsLink = applyInlineMarkdown('[ok](https://example.com)');
  assert('https:// URL passes through unchanged',
    httpsLink.includes('href="https://example.com"'));

  const mailLink = applyInlineMarkdown('[mail](mailto:a@b.c)');
  assert('mailto: URL passes through',
    mailLink.includes('href="mailto:a@b.c"'));

  // ─── 4. XSS: attribute breakout via quote in URL ───
  console.log('%c 4. XSS — attribute breakout ', 'font-weight:bold;color:#f59e0b');

  const quotedUrl = applyInlineMarkdown('[x](https://example.com/"onmouseover=alert(1))');
  assert('double-quote in URL is escaped to &quot;',
    !quotedUrl.includes('"onmouseover') && !quotedUrl.includes('" onmouseover'),
    'raw " inside href= breaks out of the attribute');

  const quotedLabel = applyInlineMarkdown('["](https://example.com)');
  assert('double-quote in link label is escaped',
    !/>"<\/a>/.test(quotedLabel),
    'label should pass through escapeHTML which now encodes both quote styles');

  // ─── 5. Autolinks (bare URLs become <a>) ───
  console.log('%c 5. Autolinks ', 'font-weight:bold;color:#f59e0b');

  const autolink = applyInlineMarkdown('Visit https://example.com today');
  assert('bare https URL becomes <a>',
    autolink.includes('<a href="https://example.com"'));

  const plainText = applyInlineMarkdown('Not a URL: just plain text');
  assert('plain text has no <a>',
    !plainText.includes('<a '));

  // ─── 6. renderMarkdown block-level ───
  console.log('%c 6. Block-level rendering ', 'font-weight:bold;color:#f59e0b');

  const heading = renderMarkdown('# H1 heading');
  assert('h1 renders chat-h1 class',
    heading.includes('class="chat-h1"') && heading.includes('H1 heading'));

  const h2 = renderMarkdown('## Second');
  assert('h2 renders chat-h2 class',
    h2.includes('class="chat-h2"'));

  const codeFence = renderMarkdown('```js\nconst x = <div>evil</div>;\n```');
  assert('fenced code block escapes content',
    codeFence.includes('&lt;div&gt;') && !codeFence.includes('<div>evil'),
    'code blocks must not let <tags> reach the DOM');

  const untaggedFence = renderMarkdown('```\nline one\nline two\n```');
  assert('untagged fence becomes callout div',
    untaggedFence.includes('chat-callout'));

  const blockquote = renderMarkdown('> quoted text\n> second line');
  assert('blockquote wraps in <blockquote>',
    blockquote.includes('<blockquote') && blockquote.includes('quoted text'));

  const ul = renderMarkdown('- first\n- second');
  assert('unordered list renders <ul>',
    ul.includes('<ul class="chat-list">') && ul.includes('<li>first</li>'));

  const ol = renderMarkdown('1. first\n2. second');
  assert('ordered list renders <ol>',
    ol.includes('<ol class="chat-list">') && ol.includes('<li>first</li>'));

  const hr = renderMarkdown('---');
  assert('horizontal rule renders <hr>',
    hr.includes('<hr class="chat-hr">'));

  const table = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
  assert('pipe-table renders <table>',
    table.includes('<table class="chat-table">') && table.includes('<th>a</th>') && table.includes('<td>1</td>'));

  // ─── 7. XSS: injections inside block contexts ───
  console.log('%c 7. XSS in block contexts ', 'font-weight:bold;color:#f59e0b');

  const headingXss = renderMarkdown('# <script>alert(1)</script>');
  assert('heading content is escaped',
    headingXss.includes('&lt;script&gt;') && !headingXss.includes('<script>'));

  const listXss = renderMarkdown('- <img src=x onerror=alert(1)>');
  assert('list-item content is escaped',
    !listXss.toLowerCase().includes('<img'));

  const tableXss = renderMarkdown('| col |\n|---|\n| <script>alert(1)</script> |');
  assert('table cell content is escaped',
    tableXss.includes('&lt;script&gt;') && !tableXss.includes('<script>alert'));

  // ─── 8. Robustness ───
  console.log('%c 8. Robustness ', 'font-weight:bold;color:#f59e0b');

  // Unclosed bold doesn't regex-match — should pass through as-is
  assert('unclosed bold leaves ** literal',
    applyInlineMarkdown('**unclosed') === '**unclosed');

  // Null/undefined/empty shouldn't throw
  let threw = false;
  try { applyInlineMarkdown(''); renderMarkdown(''); } catch { threw = true; }
  assert('empty string does not throw', !threw);

  // Large input completes quickly (no catastrophic backtracking on the
  // autolink regex or the em/strong alternations)
  const big = 'word '.repeat(5000); // 25 KB of text
  const t0 = performance.now();
  const bigOut = applyInlineMarkdown(big);
  const dt = performance.now() - t0;
  assert('25 KB plaintext renders in under 200 ms', dt < 200, `took ${dt.toFixed(0)} ms`);
  assert('large-input output has no corruption',
    bigOut.length >= big.length);

  // ─── Summary ───
  console.log(`\n%c ${passed} passed, ${failed} failed `,
    `background:${failed ? '#ef4444' : '#22c55e'};color:#fff;font-size:13px;padding:4px 10px;border-radius:4px;font-weight:bold`);
  if (failed) console.error('Failures:', fails);
  return { passed, failed };
})();
