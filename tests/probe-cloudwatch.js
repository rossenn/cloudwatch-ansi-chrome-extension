/*
 * Probe an actual AWS CloudWatch URL with the extension loaded.
 * We can't authenticate (no credentials), so we'll be redirected to
 * the SSO login page — but we can still verify (a) whether the
 * extension's URL match fires at all on console.aws.amazon.com paths,
 * and (b) what the redirect chain and final URL look like.
 *
 * Usage: node tests/probe-cloudwatch.js [url]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer');

const EXT_DIR = path.resolve(__dirname, '..');
const URL = process.argv[2] ||
  'https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups';

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ansi-cw-prof-'));

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  try {
    const page = await browser.newPage();
    const messages = [];
    const requests = [];
    page.on('console', m => messages.push({ type: m.type(), text: m.text() }));
    page.on('framenavigated', f => {
      if (f === page.mainFrame()) requests.push({ event: 'framenavigated', url: f.url() });
    });
    page.on('request', r => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) {
        requests.push({ event: 'request', url: r.url() });
      }
    });

    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(e => {
      console.log('navigation note:', e.message);
    });
    await new Promise(r => setTimeout(r, 2000));

    console.log('\n--- Final URL ---');
    console.log(page.url());

    console.log('\n--- Navigation chain ---');
    for (const r of requests) console.log(' ', r.event, r.url);

    console.log('\n--- Console messages from page (filtering for our extension) ---');
    const ours = messages.filter(m => m.text.includes('[ansi-cloudwatch]'));
    if (ours.length === 0) {
      console.log('  (none — extension did not log "active on", meaning it never injected on the final URL)');
    } else {
      for (const m of ours) console.log('  [' + m.type + ']', m.text);
    }

    console.log('\n--- All page console messages (first 20) ---');
    for (const m of messages.slice(0, 20)) {
      console.log('  [' + m.type + ']', m.text.slice(0, 160));
    }

    console.log('\n--- Frame tree ---');
    function dump(frame, indent) {
      console.log(' '.repeat(indent) + '- ' + frame.url());
      for (const c of frame.childFrames()) dump(c, indent + 2);
    }
    dump(page.mainFrame(), 2);
  } finally {
    await browser.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
