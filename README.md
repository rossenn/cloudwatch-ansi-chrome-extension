# ANSI Colors for AWS CloudWatch

A Chromium extension (Manifest V3) that interprets ANSI SGR escape codes
inside the AWS CloudWatch console. Built originally to render the colors
emitted by `AwsLambdaConsoleAppender` and `MessageHighlightConverter` in
the `ph558-crem-lib-common-utils` library, but the parser is general and
covers the full SGR spec — any service writing ANSI to stdout will render.

## Install (unpacked, Chrome / Edge / Brave)

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and pick the
   `cloudwatch-ansi-chrome-extension/` directory.
4. Open any CloudWatch URL — Log groups, Log streams, Live Tail, or Logs
   Insights results — and previously gibberish-looking ANSI sequences
   will render with their original colors.

The extension runs only on `*.console.aws.amazon.com/cloudwatch/*` and
needs only the `storage` permission (used to remember the on/off toggle).

## Verify without CloudWatch

Open `demo.html` directly in a browser. It bundles the same parser and
shows the appender's output rendered. Click **Show raw** to see the
escape sequences before parsing, **Render** to colorize again.

Two test suites are bundled:

```sh
node tests/parser.test.js       # 89 unit assertions, no deps
node tests/e2e.test.js          # launches Chrome for Testing, loads
                                # the extension, asserts colored spans
                                # on a fixture covering raw ESC, the
                                # JSON / octal / shell literal forms,
                                # MutationObserver, and the
                                # Zscaler-stripped (bare CSI) case
```

`e2e.test.js` requires the `puppeteer` devDependency (already in
`package.json`); run `npm install` once before the first run. The
unit suite has no dependencies.

## What's supported

| SGR codes                    | Meaning                                |
| ---------------------------- | -------------------------------------- |
| `0`                          | Reset                                  |
| `1` / `22`                   | Bold on / off                          |
| `2` / `22`                   | Dim on / off                           |
| `3` / `23`                   | Italic on / off                        |
| `4` / `24`                   | Underline on / off                     |
| `7` / `27`                   | Inverse (swap fg/bg) on / off          |
| `9` / `29`                   | Strike-through on / off                |
| `30`–`37` / `90`–`97`        | Standard / bright foreground (8 + 8)   |
| `40`–`47` / `100`–`107`      | Standard / bright background (8 + 8)   |
| `39` / `49`                  | Default fg / bg                        |
| `38;5;N` / `48;5;N`          | xterm 256-color fg / bg                |
| `38;2;R;G;B` / `48;2;R;G;B`  | 24-bit truecolor fg / bg               |

Non-SGR CSI sequences (cursor moves, erases, etc.) are stripped if they
appear in a text node so they don't clutter the message; they don't
contribute styling.

In addition to SGR, **OSC 8 hyperlinks** are recognized and rendered as
`<a href target="_blank" rel="noopener noreferrer">`. The escape shape is
`ESC ] 8 ; PARAMS ; URL ST  TEXT  ESC ] 8 ; ; ST` where `ST` is either
`ESC \` or `BEL`. This is what `MessageHighlightConverter` uses to wrap
event/command labels with a link to the events app — clicking the
colored label in CloudWatch jumps straight to the events-app workflow
view, pre-filtered by correlation ID.

## Debugging "I see [32m text instead of colors"

The extension supports five ways an ANSI sequence can reach the DOM:

1. Raw `0x1B` byte (most common).
2. Literal six-character `\u001b` (JSON-encoded ESC).
3. Literal four-character `\033` (octal — the form in the appender's
   Java source).
4. Literal two-character `\e` (shell shorthand).
5. **Bare `[Nm` with no leading ESC at all** — what you see when an
   SSL-inspecting corporate proxy (Zscaler, Netskope, Symantec WSS,
   Forcepoint, Palo Alto Prisma) sanitizes control characters out of
   log content on its way to your browser. **This is the most common
   cause of "extension installed, no colors" inside enterprise
   networks.**

The bare-CSI path is heuristic-gated: a text node only enters it if it
contains at least one `[0m` reset AND at least one other bracketed-SGR
pattern. That filters out incidental occurrences like
`job ran for [42 minutes]` while still catching every line a logback
ANSI appender emits, since the appender always closes its sequences
with `[0m`.

If colors still aren't appearing on a page where you expect them:

1. Open DevTools (⌥⌘I or F12) → **Console** tab.
2. Confirm the extension was injected. You should see one line:
   ```
   [ansi-cloudwatch] active on https://us-east-1.console.aws.amazon.com/cloudwatch/...
   ```
   If that line is missing, the content script never loaded — open
   `chrome://extensions`, confirm the extension is enabled, confirm
   the URL matches `https://*.console.aws.amazon.com/cloudwatch/*`,
   then reload the tab.
3. With log lines visible on screen, open `devtools-diagnostic.js`,
   copy the entire file, and paste it into the DevTools console. It
   scans the DOM for ANSI-looking text and prints the encoding it
   detected, the parent element, and a hex dump of the surrounding
   bytes for each match.
4. The dominant-encoding line at the bottom tells you what AWS (or
   your proxy) is serving. The extension already handles all five
   forms; if the diagnostic finds matches but the page still isn't
   colored, send the parent tag back so we can see what structure
   the walker is missing.

## What the appender emits

`AwsLambdaConsoleAppender` (Logback pattern):

```
%green(%AWSRequestId) [%highlight(%.-6level)] %cyan(%d{...}) %magenta(%logger{26})[%blue(%thread)] - %highlightMsg%stackTrace%n
```

This produces these SGR codes:

| Token        | SGR sequence    | Rendered as              |
| ------------ | --------------- | ------------------------ |
| `%green`     | `ESC[32m`       | green (request id)       |
| `%cyan`      | `ESC[36m`       | cyan (timestamp)         |
| `%magenta`   | `ESC[35m`       | magenta (logger name)    |
| `%blue`      | `ESC[34m`       | blue (thread name)       |
| `%highlight` ERROR     | `ESC[1;31m` | bold red          |
| `%highlight` WARN      | `ESC[31m`   | red               |
| `%highlight` INFO      | `ESC[34m`   | blue              |
| `%highlight` DEBUG/TRACE | (none)    | default           |

`MessageHighlightConverter` (custom):

| Constant       | SGR sequence              | Used for                       |
| -------------- | ------------------------- | ------------------------------ |
| `ORANGE`       | `ESC[38;2;255;135;0m`     | `Event:{...}` from handlers    |
| `BLUE`         | `ESC[38;2;64;144;230m`    | `Command:{...}` from handlers  |
| `LIGHT_ORANGE` | `ESC[38;2;255;175;95m`    | `Event:{...}` from publisher   |
| `LIGHT_BLUE`   | `ESC[38;2;135;205;255m`   | `Command:{...}` from publisher |
| `RESET`        | `ESC[0m`                  | end of highlight               |

(`ESC` in the table above is a single byte, `0x1B`.)

All of the above fall under the general parser; nothing in the extension
is appender-specific.

## Files

```
cloudwatch-ansi-chrome-extension/
├── manifest.json            # Manifest V3, scoped to *.console.aws.amazon.com/cloudwatch/*
├── content.js               # SGR parser + DOM rewriter + MutationObserver
├── popup.html               # On/off toolbar popup
├── popup.js                 # Popup logic (chrome.storage.local)
├── demo.html                # Standalone demo with the parser inlined
├── devtools-diagnostic.js   # Paste-into-console diagnostic for "no colors" cases
├── build-icons.py           # One-shot icon generator (stdlib only)
├── tests/parser.test.js     # Unit suite, 89 assertions, no deps
├── tests/e2e.test.js        # Chrome-for-Testing E2E, requires puppeteer devDep
├── tests/probe-cloudwatch.js # Optional: probes a CloudWatch URL with extension loaded
├── icons/                   # 16/48/128 px PNG icons
└── README.md                # This file
```

## How it works

`content.js` runs at `document_idle` on every CloudWatch frame:

1. Reads `chrome.storage.local.enabled` (default `true`) and bails out
   if disabled.
2. Walks `document.body` (and shadow roots) with a `TreeWalker` that
   yields text nodes containing any ESC marker — raw `0x1B`, literal
   `\u001b`, `\033`, `\e[`, or a bracketed-SGR pattern paired with a
   `[0m` reset.
3. For each such text node, parses the embedded SGR sequences into a
   running style state, builds a `DocumentFragment` of styled `<span>`s,
   and replaces the text node in place. Inline `style` attributes are
   used so we don't fight CloudWatch's CSS.
4. A throttled (`requestAnimationFrame`) `MutationObserver` rescans on
   any DOM change so newly streamed log lines are colored as they appear.
5. Shadow roots encountered during traversal get their own observer.

`<script>`, `<style>`, `<textarea>`, and `<noscript>` subtrees are skipped.

## Toggle

Click the toolbar icon → uncheck **Enabled**. The active CloudWatch tab
reloads so the original text comes back unmodified. Re-check to turn it
on again.

## Limitations / known gotchas

- A bare-CSI text node without a `[0m` reset is left alone, even if it
  contains plausible-looking SGR patterns. This is intentional — without
  the reset signal, the false-positive risk on regular log content is
  too high. The logback appender always emits `[0m`, so its output is
  always covered.
- An ANSI sequence split across two text nodes won't be colored. In
  practice CloudWatch keeps each log message in a single text node, so
  this is rare. The same caveat applies to OSC 8 hyperlinks — an open
  in one node and a close in another won't be stitched.
- React occasionally re-renders log rows (e.g. during scroll
  virtualization). The `MutationObserver` re-runs and re-colors them on
  the next frame, so you may see a one-frame flicker on fast scrolling.
- Inverse video (`ESC[7m`) without an explicit fg/bg falls back to
  black-on-white because the extension can't read the page's effective
  colors generically.

## Updating the icons

Re-run `python3 build-icons.py` after editing `QUADRANTS` in that
script. Standard library only, no extra deps.
