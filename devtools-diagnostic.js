/*
 * Paste this entire file into the DevTools console while on the
 * CloudWatch tab where colors are missing. It scans the page for any
 * text that looks like an ANSI sequence, dumps the surrounding bytes
 * in hex, and reports which encoding (raw 0x1B / literal  /
 * literal \033 / literal \e) the AWS console is using.
 *
 * The hex dump is the key piece of information — it tells us whether
 * the ESC byte is actually present in the DOM.
 */
(() => {
  const SAMPLE_LIMIT = 5;       // stop after this many matching nodes
  const SNIPPET_CHARS = 120;    // chars of text to show per match

  const patterns = [
    { name: 'raw 0x1B',       re: /\x1b\[[\d;?]*[@-~]/ },
    { name: 'literal \\u001b', re: /\\u001b\[[\d;?]*[@-~]/ },
    { name: 'literal \\033',   re: /\\033\[[\d;?]*[@-~]/ },
    { name: 'literal \\e',     re: /\\e\[[\d;?]*[@-~]/ },
    { name: 'bare [Nm',       re: /\[\d{1,3}(?:;\d{1,3}){0,4}m/ },
  ];

  function hexOf(s) {
    return Array.from(s)
      .map(c => c.codePointAt(0).toString(16).padStart(2, '0'))
      .join(' ');
  }

  function scanRoot(root, results) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const v = n.nodeValue;
      if (!v) continue;
      for (const p of patterns) {
        if (p.re.test(v)) {
          results.push({
            encoding: p.name,
            parent: n.parentElement ? n.parentElement.tagName + (n.parentElement.className ? '.' + n.parentElement.className.split(' ').join('.') : '') : '(none)',
            snippet: v.slice(0, SNIPPET_CHARS),
            hex: hexOf(v.slice(0, SNIPPET_CHARS)),
          });
          if (results.length >= SAMPLE_LIMIT) return;
          break;
        }
      }
    }
    // Recurse into shadow roots too
    const elWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = elWalker.nextNode())) {
      if (el.shadowRoot && results.length < SAMPLE_LIMIT) scanRoot(el.shadowRoot, results);
    }
  }

  const results = [];
  scanRoot(document.body, results);

  if (results.length === 0) {
    console.log('%c[ansi-cloudwatch debug] no ANSI-looking text found on this page',
                'color:#cd3131;font-weight:bold');
    console.log('Try scrolling so log lines that should contain colors are visible, then re-run.');
    return;
  }

  console.log('%c[ansi-cloudwatch debug] found', 'color:#0dbc79;font-weight:bold',
              results.length, 'matching text node(s):');
  console.table(results.map(r => ({
    encoding: r.encoding,
    parent: r.parent,
    snippet: r.snippet,
  })));
  console.log('Hex dumps (byte-by-byte) for each match:');
  for (const r of results) {
    console.groupCollapsed('%c' + r.encoding + '  ' + r.snippet.slice(0, 60),
                            'color:#3b8eea');
    console.log('encoding :', r.encoding);
    console.log('parent   :', r.parent);
    console.log('snippet  :', r.snippet);
    console.log('hex      :', r.hex);
    console.groupEnd();
  }

  const enc = results[0].encoding;
  console.log('%c[ansi-cloudwatch debug] dominant encoding: ' + enc,
              'color:#bc3fbc;font-weight:bold');
  if (enc === 'bare [Nm') {
    console.log("AWS appears to be stripping the ESC byte before render — only the bracketed parameter remains. The current extension cannot color this safely (false-positive risk on regular text). Tell the assistant.");
  } else {
    console.log("The extension supports this encoding. If colors still don't show, the parent element may be inside a structure the walker can't reach (canvas, iframe with different origin, etc.). Share the parent: value above with the assistant.");
  }
})();
