/*
 * End-to-end check: launches a real Chrome with the extension loaded,
 * opens a fixture page that simulates how CloudWatch renders a log
 * stream (raw \x1b ESC byte inside a <pre> wrapped in a div), waits
 * for the content script to color it, then walks the resulting DOM
 * and asserts the spans + computed styles match what we expect.
 *
 * Run with: node tests/e2e.test.js
 *
 * Requires the `puppeteer` devDependency (run `npm install` once).
 * Puppeteer's postinstall fetches a matching Chrome for Testing build
 * into its own cache, so no system Chrome is required.
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer');

const EXT_DIR = path.resolve(__dirname, '..');

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>fixture</title></head>
<body>
  <h1>CloudWatch fixture</h1>
  <!-- Mimics the structural shape of CloudWatch log rows. -->
  <div id="logStream">
    <pre id="row1" class="log-row">\x1b[32mreq-1\x1b[0m [\x1b[34mINFO  \x1b[0m] \x1b[36m2026-04-29 10:00:00.000\x1b[0m \x1b[35mlogger\x1b[0m[\x1b[34mmain\x1b[0m] - received \x1b[38;5;208mFooEvent:{"id":1}\x1b[0m</pre>
    <pre id="row2" class="log-row">\x1b[32mreq-2\x1b[0m [\x1b[1;31mERROR \x1b[0m] \x1b[36m2026-04-29 10:00:01.000\x1b[0m \x1b[35mlogger\x1b[0m[\x1b[34mmain\x1b[0m] - boom</pre>
    <pre id="row3" class="log-row">no ansi here, plain text</pre>
    <!-- JSON-encoded literal forms that AWS pipelines sometimes emit -->
    <pre id="row4" class="log-row">\\u001b[31malert\\u001b[0m and \\033[34mblue\\033[0m end</pre>
    <!-- ESC-stripped: what users behind Zscaler / SSL-inspection proxies
         actually see. The 0x1B byte is gone but the bracketed params
         remain, with a [0m reset that the heuristic uses to gate this
         path. This is the case the user reported. -->
    <pre id="row6" class="log-row">[32mreq-3[0m [[34mINFO  [0m] [36m2026-04-29 10:00:02.000[0m [35mlogger[0m[[34mmain[0m] - stripped via Zscaler [38;5;208mFooEvent:{"id":2}[0m</pre>
    <!-- Negative case: text containing brackets that look SGR-ish but
         have no [0m reset. Heuristic should leave it untouched. -->
    <pre id="row7" class="log-row">job took [42m] (no reset, should not color)</pre>
  </div>

  <!-- Lines added later via JS to test the MutationObserver -->
  <script>
    setTimeout(() => {
      const div = document.createElement('pre');
      div.id = 'row5';
      div.className = 'log-row';
      div.textContent = '\\x1b[38;5;75mIssueGuaranteeCommand:7\\x1b[0m streamed in late';
      document.getElementById('logStream').appendChild(div);
    }, 200);
  </script>
</body></html>
`;

async function main() {
  // Copy the extension into a temp dir and broaden the match pattern
  // to localhost so we can serve the fixture over HTTP. file:// would
  // require the user to toggle "Allow access to file URLs" by hand.
  const tmpExtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ansi-cw-ext-'));
  for (const f of fs.readdirSync(EXT_DIR)) {
    if (f === 'node_modules' || f === 'tests' || f === 'package-lock.json') continue;
    const src = path.join(EXT_DIR, f);
    const dst = path.join(tmpExtDir, f);
    cpRecursive(src, dst);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(tmpExtDir, 'manifest.json'), 'utf8'));
  manifest.content_scripts[0].matches.push('http://localhost/*', 'http://127.0.0.1/*');
  manifest.host_permissions.push('http://localhost/*', 'http://127.0.0.1/*');
  fs.writeFileSync(path.join(tmpExtDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FIXTURE_HTML);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/cloudwatch-fixture`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ansi-cw-prof-'));

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir,
    args: [
      `--disable-extensions-except=${tmpExtDir}`,
      `--load-extension=${tmpExtDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  let failed = 0;
  const fail = (msg) => { failed++; console.log('FAIL  ' + msg); };
  const pass = (msg) => console.log('pass  ' + msg);

  try {
    const page = await browser.newPage();
    const consoleMessages = [];
    page.on('console', m => consoleMessages.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', e => consoleMessages.push(`[pageerror] ${e.message}`));

    // Diagnostics: list what extensions Chrome actually loaded.
    const extPage = await browser.newPage();
    await extPage.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' });
    const loadedExts = await extPage.evaluate(async () => {
      // chrome://extensions is a polymer SPA; introspect via shadow roots.
      const mgr = document.querySelector('extensions-manager');
      if (!mgr) return { error: 'extensions-manager not found' };
      const items = mgr.shadowRoot
        ?.querySelector('extensions-item-list')
        ?.shadowRoot
        ?.querySelectorAll('extensions-item');
      if (!items) return { error: 'extensions-item-list not found' };
      const out = [];
      for (const it of items) {
        out.push({
          id: it.getAttribute('id'),
          name: it.shadowRoot?.querySelector('#name')?.textContent?.trim(),
          enabled: it.shadowRoot?.querySelector('#enableToggle')?.getAttribute('checked'),
          errors: Array.from(it.shadowRoot?.querySelectorAll('.error-message') || []).map(e => e.textContent.trim()),
        });
      }
      return { items: out };
    });
    console.log('Loaded extensions diagnostic:', JSON.stringify(loadedExts, null, 2));
    await extPage.close();

    await page.goto(url, { waitUntil: 'networkidle2' });

    // Give the content script + late mutation a moment to run.
    await new Promise(r => setTimeout(r, 800));

    const startupLogged = consoleMessages.some(m => m.includes('[ansi-cloudwatch] active'));
    if (startupLogged) pass('content script logged "active on" on startup');
    else fail('content script never logged "active on" — extension did not inject. Console messages:\n' + consoleMessages.map(s => '    ' + s).join('\n'));

    const summaryLogged = consoleMessages.some(m => m.includes('colored first ANSI'));
    if (summaryLogged) pass('content script reported coloring first ANSI text node');
    else fail('content script never colored anything. Console messages:\n' + consoleMessages.map(s => '    ' + s).join('\n'));

    // For each row, check whether colored spans were created and that
    // the raw ANSI bytes are gone from the rendered text.
    const inspect = async (selector, expectColored, label) => {
      const result = await page.$eval(selector, (el) => ({
        text: el.textContent,
        spanCount: el.querySelectorAll('span[data-ansi="1"]').length,
        firstSpanColor: (() => {
          const s = el.querySelector('span[data-ansi="1"]');
          return s ? s.getAttribute('style') : null;
        })(),
      }));
      const hasRawEsc = result.text.includes('\x1b');
      const hasLiteral = /\\u001b|\\033|\\e\[/.test(result.text);
      if (hasRawEsc) fail(`${label}: raw ESC byte still in textContent`);
      if (hasLiteral) fail(`${label}: literal escape (\\u001b/\\033/\\e) still in textContent`);
      if (expectColored && result.spanCount === 0) {
        fail(`${label}: expected colored spans but found none. textContent="${result.text.slice(0, 100)}"`);
      } else if (expectColored && result.spanCount > 0) {
        pass(`${label}: ${result.spanCount} colored spans, first style="${result.firstSpanColor}"`);
      } else if (!expectColored && result.spanCount === 0) {
        pass(`${label}: plain text untouched`);
      } else {
        fail(`${label}: expected no spans but got ${result.spanCount}`);
      }
    };

    await inspect('#row1', true,  'row1 (raw ESC, INFO line)');
    await inspect('#row2', true,  'row2 (raw ESC, ERROR with bold red)');
    await inspect('#row3', false, 'row3 (plain text — should be untouched)');
    await inspect('#row4', true,  'row4 (literal \\u001b and \\033 forms)');
    await inspect('#row5', true,  'row5 (added late via JS — MutationObserver)');
    await inspect('#row6', true,  'row6 (ESC-stripped — Zscaler / proxy case)');
    await inspect('#row7', false, 'row7 (brackets without [0m — heuristic must not color)');

    // Spot-check the actual computed color for row1's first span — it
    // should be xterm 32 (green) which we map to '#0dbc79'.
    const row1FirstColor = await page.$eval('#row1 span[data-ansi="1"]',
      (s) => getComputedStyle(s).color);
    if (/0,?\s*188,?\s*121|13,?\s*188,?\s*121/.test(row1FirstColor)) {
      pass(`row1 first span computed color is green-ish: ${row1FirstColor}`);
    } else {
      fail(`row1 first span computed color is "${row1FirstColor}" — expected the VS Code green (#0dbc79 → rgb(13,188,121))`);
    }
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(tmpExtDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  if (failed === 0) {
    console.log('\nE2E: all checks passed');
    process.exit(0);
  } else {
    console.log(`\nE2E: ${failed} check(s) failed`);
    process.exit(1);
  }
}

function cpRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) cpRecursive(path.join(src, f), path.join(dst, f));
  } else {
    fs.copyFileSync(src, dst);
  }
}

main().catch(e => { console.error(e); process.exit(2); });
