/*
 * Parser test runner.
 *
 * Run with: node tests/parser.test.js
 *
 * No external deps. Mirrors the parser inside content.js and asserts
 * against the actual ANSI byte sequences emitted by:
 *   - AwsLambdaConsoleAppender (Logback %green/%cyan/%magenta/%blue/%highlight)
 *   - MessageHighlightConverter (xterm 208 / 215 / 75 / 4)
 * plus general SGR cases (truecolor, inverse, non-SGR CSI absorption).
 *
 * Keep in lockstep with content.js / demo.html. If a behavior changes
 * there, update the asserts here.
 */
'use strict';

const ANY_CSI = /(?:\x1b|\\u001b|\\033|\\e)\[([\d;?]*)([@-~])/g;
const ANY_OSC8 = /(?:\x1b|\\u001b|\\033|\\e)\]8;([^;]*);([^\x1b\x07]*?)(?:(?:\x1b|\\u001b|\\033|\\e)\\|\x07)/g;
const BARE_SGR = /\[(\d{1,3}(?:;\d{1,3}){0,4})m/g;
const ESC_MARKERS = ['\x1b', '\\u001b', '\\033', '\\e['];

const BASE_COLORS = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543',
  '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

const PALETTE_256 = (() => {
  const p = BASE_COLORS.slice();
  const cube = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) {
    const r = cube[Math.floor(i / 36) % 6];
    const g = cube[Math.floor(i / 6) % 6];
    const b = cube[i % 6];
    p.push('#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join(''));
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    p.push('#' + [v, v, v].map(c => c.toString(16).padStart(2, '0')).join(''));
  }
  return p;
})();

const def = () => ({
  fg: null, bg: null,
  bold: false, dim: false, italic: false,
  underline: false, inverse: false, strike: false,
});

function applySgr(state, paramString) {
  const codes = paramString === ''
    ? [0]
    : paramString.split(';').map(s => s === '' ? 0 : parseInt(s, 10) | 0);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) state = def();
    else if (c === 1) state.bold = true;
    else if (c === 2) state.dim = true;
    else if (c === 3) state.italic = true;
    else if (c === 4) state.underline = true;
    else if (c === 7) state.inverse = true;
    else if (c === 9) state.strike = true;
    else if (c === 22) { state.bold = false; state.dim = false; }
    else if (c === 23) state.italic = false;
    else if (c === 24) state.underline = false;
    else if (c === 27) state.inverse = false;
    else if (c === 29) state.strike = false;
    else if (c >= 30 && c <= 37) state.fg = BASE_COLORS[c - 30];
    else if (c === 38) {
      const n = codes[i + 1];
      if (n === 5 && i + 2 < codes.length) { state.fg = PALETTE_256[codes[i + 2]] || null; i += 2; }
      else if (n === 2 && i + 4 < codes.length) { state.fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
    }
    else if (c === 39) state.fg = null;
    else if (c >= 40 && c <= 47) state.bg = BASE_COLORS[c - 40];
    else if (c === 48) {
      const n = codes[i + 1];
      if (n === 5 && i + 2 < codes.length) { state.bg = PALETTE_256[codes[i + 2]] || null; i += 2; }
      else if (n === 2 && i + 4 < codes.length) { state.bg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
    }
    else if (c === 49) state.bg = null;
    else if (c >= 90 && c <= 97) state.fg = BASE_COLORS[c - 90 + 8];
    else if (c >= 100 && c <= 107) state.bg = BASE_COLORS[c - 100 + 8];
  }
  return state;
}

function parseToSegments(text) {
  const segments = [];
  let cursor = 0;
  let style = def();
  let linkUrl = null;
  const hasRealEsc = ESC_MARKERS.some(mk => text.indexOf(mk) >= 0);
  const matches = collectMatches(text, hasRealEsc);
  for (const m of matches) {
    if (m.index > cursor) segments.push({ text: text.slice(cursor, m.index), style, linkUrl });
    if (m.kind === 'sgr') style = applySgr({ ...style }, m.params);
    else if (m.kind === 'osc8') linkUrl = m.url ? m.url : null;
    cursor = m.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), style, linkUrl });
  return segments;
}

function collectMatches(text, hasRealEsc) {
  const out = [];
  if (hasRealEsc) {
    ANY_CSI.lastIndex = 0;
    let m;
    while ((m = ANY_CSI.exec(text)) !== null) {
      out.push({ index: m.index, end: ANY_CSI.lastIndex, kind: m[2] === 'm' ? 'sgr' : 'csi', params: m[1] });
    }
    ANY_OSC8.lastIndex = 0;
    while ((m = ANY_OSC8.exec(text)) !== null) {
      out.push({ index: m.index, end: ANY_OSC8.lastIndex, kind: 'osc8', url: m[2] });
    }
    out.sort((a, b) => a.index - b.index);
  } else {
    BARE_SGR.lastIndex = 0;
    let m;
    while ((m = BARE_SGR.exec(text)) !== null) {
      out.push({ index: m.index, end: BARE_SGR.lastIndex, kind: 'sgr', params: m[1] });
    }
  }
  return out;
}

function looksLikeBareStrippedAnsi(text) {
  if (!text || text.indexOf('[0m') < 0) return false;
  BARE_SGR.lastIndex = 0;
  let count = 0;
  while (BARE_SGR.exec(text) !== null) {
    if (++count >= 2) return true;
  }
  return false;
}

/* ---- Tiny test harness --------------------------------------------- */
let passed = 0;
let failed = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
  }
}

function segText(segments) {
  return segments.map(s => s.text);
}

function segFg(segments) {
  return segments.map(s => s.style.fg);
}

function segBg(segments) {
  return segments.map(s => s.style.bg);
}

function segFlags(segments) {
  return segments.map(s => ({
    bold: s.style.bold, italic: s.style.italic,
    underline: s.style.underline, inverse: s.style.inverse,
    strike: s.style.strike, dim: s.style.dim,
  }));
}

/* ---- Color palette sanity ------------------------------------------ */
eq(PALETTE_256[208], '#ff8700', 'xterm 208 → bright orange (rgb 255,135,0)');
eq(PALETTE_256[215], '#ffaf5f', 'xterm 215 → light orange (rgb 255,175,95)');
eq(PALETTE_256[75], '#5fafff', 'xterm 75 → sky blue (rgb 95,175,255)');
eq(PALETTE_256[4], BASE_COLORS[4], 'xterm 4 → standard blue from base palette');
eq(PALETTE_256.length, 256, '256-color palette has exactly 256 entries');
eq(PALETTE_256[16], '#000000', 'xterm 16 (cube origin) is black');
eq(PALETTE_256[231], '#ffffff', 'xterm 231 (cube max) is white');
eq(PALETTE_256[232], '#080808', 'xterm 232 (gray ramp start) is near-black');
eq(PALETTE_256[255], '#eeeeee', 'xterm 255 (gray ramp end) is near-white');

/* ---- Single SGR pair ----------------------------------------------- */
{
  const s = parseToSegments('\x1b[31mred\x1b[0m');
  eq(segText(s), ['red'], 'simple red: text');
  eq(segFg(s), [BASE_COLORS[1]], 'simple red: fg color');
}

/* ---- Logback %green / %cyan / %magenta / %blue --------------------- */
{
  const s = parseToSegments(
    '\x1b[32m1234-abcd\x1b[0m [INFO ] \x1b[36m2026-04-29\x1b[0m \x1b[35mlogger\x1b[0m[\x1b[34mthread\x1b[0m] - msg'
  );
  eq(segText(s),
     ['1234-abcd', ' [INFO ] ', '2026-04-29', ' ', 'logger', '[', 'thread', '] - msg'],
     'appender pattern: text segments');
  eq(segFg(s),
     [BASE_COLORS[2], null, BASE_COLORS[6], null, BASE_COLORS[5], null, BASE_COLORS[4], null],
     'appender pattern: fg colors');
}

/* ---- %highlight ERROR (bold red) ----------------------------------- */
{
  const s = parseToSegments('[\x1b[1;31mERROR\x1b[0m] boom');
  eq(segText(s), ['[', 'ERROR', '] boom'], 'highlight ERROR: text');
  eq(s[1].style.fg, BASE_COLORS[1], 'highlight ERROR: red fg');
  eq(s[1].style.bold, true, 'highlight ERROR: bold');
  eq(s[2].style.bold, false, 'highlight ERROR: bold cleared by reset');
}

/* ---- MessageHighlightConverter colors ------------------------------ */
{
  // ORANGE = "\033[38;5;208m"
  const s = parseToSegments('msg \x1b[38;5;208mGuaranteeUpdatedEvent:{"id":42}\x1b[0m tail');
  eq(segText(s), ['msg ', 'GuaranteeUpdatedEvent:{"id":42}', ' tail'], 'orange highlight: text');
  eq(s[1].style.fg, '#ff8700', 'orange highlight: xterm 208 fg');
}
{
  // BLUE = "\033[38;5;75m"
  const s = parseToSegments('cmd \x1b[38;5;75mIssueGuaranteeCommand:7\x1b[0m');
  eq(s[1].style.fg, '#5fafff', 'blue highlight: xterm 75 fg');
}
{
  // LIGHT_ORANGE = "\033[38;5;215m"
  const s = parseToSegments('pub \x1b[38;5;215mGuaranteeUpdatedEvent:{}\x1b[0m');
  eq(s[1].style.fg, '#ffaf5f', 'light orange highlight: xterm 215 fg');
}
{
  // LIGHT_BLUE = "\033[38;5;4m"
  const s = parseToSegments('pub \x1b[38;5;4mIssueGuaranteeCommand:9\x1b[0m');
  eq(s[1].style.fg, BASE_COLORS[4], 'deep blue highlight: xterm 4 fg');
}

/* ---- Nested style state with reset --------------------------------- */
{
  const s = parseToSegments('\x1b[1m\x1b[31mbold red\x1b[39m bold only\x1b[0m plain');
  eq(s[0].style.bold, true, 'nested: first segment bold');
  eq(s[0].style.fg, BASE_COLORS[1], 'nested: first segment red');
  eq(s[1].style.bold, true, 'nested: second segment still bold');
  eq(s[1].style.fg, null, 'nested: second segment fg cleared by 39');
  eq(s[2].style.bold, false, 'nested: third segment plain after reset');
  eq(s[2].style.fg, null, 'nested: third segment no fg');
}

/* ---- Truecolor ----------------------------------------------------- */
{
  const s = parseToSegments('\x1b[38;2;255;87;34mfg\x1b[0m \x1b[48;2;30;30;30mbg\x1b[0m');
  eq(s[0].style.fg, 'rgb(255,87,34)', 'truecolor: fg rgb');
  eq(s[2].style.bg, 'rgb(30,30,30)', 'truecolor: bg rgb');
}

/* ---- Bright (90-97 / 100-107) -------------------------------------- */
{
  const s = parseToSegments('\x1b[91mbright red\x1b[0m \x1b[103mbright yellow bg\x1b[0m');
  eq(s[0].style.fg, BASE_COLORS[9], 'bright fg 91 → BASE[9]');
  eq(s[2].style.bg, BASE_COLORS[11], 'bright bg 103 → BASE[11]');
}

/* ---- Compound params and empty params (= reset) -------------------- */
{
  const s = parseToSegments('\x1b[1;3;4;31mall\x1b[m end');
  eq(s[0].style.bold, true, 'compound: bold');
  eq(s[0].style.italic, true, 'compound: italic');
  eq(s[0].style.underline, true, 'compound: underline');
  eq(s[0].style.fg, BASE_COLORS[1], 'compound: red fg');
  eq(s[1].style.bold, false, 'empty params (\\x1b[m) acts as reset');
}

/* ---- Non-SGR CSI is absorbed silently ------------------------------ */
{
  const s = parseToSegments('a\x1b[31mb\x1b[1Ac\x1b[0md');
  eq(segText(s), ['a', 'b', 'c', 'd'], 'non-SGR CSI \\x1b[1A absorbed, no leftover bytes');
  eq(s[1].style.fg, BASE_COLORS[1], 'non-SGR CSI does not clear current style');
  eq(s[2].style.fg, BASE_COLORS[1], 'style persists across non-SGR CSI');
  eq(s[3].style.fg, null, 'reset still works after non-SGR CSI');
}

/* ---- All-CSI input ------------------------------------------------- */
{
  const s = parseToSegments('\x1b[31m\x1b[0m');
  eq(s.length, 0, 'pure escapes → no segments');
}

/* ---- Plain text no escapes ----------------------------------------- */
{
  const s = parseToSegments('just plain text');
  eq(segText(s), ['just plain text'], 'plain text: single segment');
  eq(s[0].style.fg, null, 'plain text: no fg');
}

/* ---- 22 cancels both bold and dim ---------------------------------- */
{
  const s = parseToSegments('\x1b[1;2mboth\x1b[22m neither');
  eq(s[0].style.bold, true, '22-cancel: starts bold');
  eq(s[0].style.dim, true, '22-cancel: starts dim');
  eq(s[1].style.bold, false, '22 clears bold');
  eq(s[1].style.dim, false, '22 clears dim');
}

/* ---- Inverse swaps fg/bg ------------------------------------------- */
{
  const s = parseToSegments('\x1b[31;47;7minverted\x1b[0m');
  // We don't apply the swap until styleToCss in content.js, so the raw
  // state still holds the original fg/bg with inverse=true.
  eq(s[0].style.fg, BASE_COLORS[1], 'inverse: raw fg unchanged');
  eq(s[0].style.bg, BASE_COLORS[7], 'inverse: raw bg unchanged');
  eq(s[0].style.inverse, true, 'inverse: flag set');
}

/* ---- ERROR/WARN/INFO highlight discrimination ---------------------- */
{
  const error = parseToSegments('\x1b[1;31mERROR\x1b[0m');
  const warn  = parseToSegments('\x1b[31mWARN\x1b[0m');
  const info  = parseToSegments('\x1b[34mINFO\x1b[0m');
  eq([error[0].style.bold, error[0].style.fg], [true, BASE_COLORS[1]], 'ERROR: bold red');
  eq([warn[0].style.bold,  warn[0].style.fg],  [false, BASE_COLORS[1]], 'WARN: red, not bold');
  eq([info[0].style.bold,  info[0].style.fg],  [false, BASE_COLORS[4]], 'INFO: blue, not bold');
}

/* ---- Realistic appender line, end to end --------------------------- */
{
  // Mimics what AwsLambdaConsoleAppender would emit for an INFO line
  // whose message contains a highlighted Event.
  const line =
    '\x1b[32mreq-1\x1b[0m [\x1b[34mINFO  \x1b[0m] ' +
    '\x1b[36m2026-04-29 10:00:00.000\x1b[0m ' +
    '\x1b[35mcom.nextera.fim.X\x1b[0m[\x1b[34mmain\x1b[0m] - ' +
    'received \x1b[38;5;208mFooEvent:{"id":1}\x1b[0m';
  const s = parseToSegments(line);
  // Spot-check: count, key colors, and that nothing leaks raw bytes.
  if (s.some(x => x.text.includes('\x1b'))) {
    failed++;
    failures.push('FAIL  realistic line: raw ESC leaked into segment text');
  } else passed++;
  // The Event highlight should use xterm 208.
  const evtSeg = s.find(x => x.text.startsWith('FooEvent'));
  eq(evtSeg && evtSeg.style.fg, '#ff8700', 'realistic line: event highlight is xterm 208');
}

/* ---- Alternate ESC representations --------------------------------- */
// Some log pipelines (and AWS' own JSON-encoding step) replace the raw
// 0x1B byte with one of these literal text escapes before the bytes ever
// reach the browser. The parser must accept all four variants.
{
  // Literal "" (6 chars: backslash u 0 0 1 b)
  const s = parseToSegments('\\u001b[31mhello\\u001b[0m');
  eq(segText(s), ['hello'], 'literal \\u001b: segment text');
  eq(s[0].style.fg, BASE_COLORS[1], 'literal \\u001b: fg red');
}
{
  // Literal "\033" (4 chars: backslash 0 3 3) — the form used in the
  // appender's Java source.
  const s = parseToSegments('\\033[38;5;208morange\\033[0m');
  eq(segText(s), ['orange'], 'literal \\033: segment text');
  eq(s[0].style.fg, '#ff8700', 'literal \\033: xterm 208');
}
{
  // Literal "\e[" (2 chars: backslash e) — common in shell scripts
  const s = parseToSegments('\\e[1;31mERROR\\e[0m');
  eq(segText(s), ['ERROR'], 'literal \\e: segment text');
  eq(s[0].style.bold, true, 'literal \\e: bold');
  eq(s[0].style.fg, BASE_COLORS[1], 'literal \\e: red');
}
{
  // Mixed in a single message — pathological but should still parse.
  const s = parseToSegments('a\x1b[31mb\\u001b[32mc\\033[34md\\e[0me');
  eq(segText(s), ['a', 'b', 'c', 'd', 'e'], 'mixed escape forms: text');
  eq(segFg(s),
     [null, BASE_COLORS[1], BASE_COLORS[2], BASE_COLORS[4], null],
     'mixed escape forms: fg per segment');
}

/* ---- ESC-stripped (proxy / SSL-inspection) case -------------------- */
// When Zscaler or similar SSL-inspecting proxies sit between the user
// and AWS, the raw ESC byte gets stripped from log content and only
// the bracketed parameters survive. The bare-CSI path handles this
// when guarded by a [0m reset (the heuristic in looksLikeBareStrippedAnsi).
{
  const text = '[32mreq-3[0m [[34mINFO[0m] - line';
  if (!looksLikeBareStrippedAnsi(text)) {
    failed++;
    failures.push('FAIL  bare-stripped: heuristic should accept this text');
  } else passed++;
  const s = parseToSegments(text);
  // Expect green "req-3" then default " [", then blue "INFO", then "] - line"
  eq(s[0].style.fg, BASE_COLORS[2], 'bare-stripped: first segment green');
  const infoSeg = s.find(x => x.text === 'INFO');
  eq(infoSeg && infoSeg.style.fg, BASE_COLORS[4], 'bare-stripped: INFO is blue');
}
{
  // Negative case: brackets that look SGR-shaped but no [0m reset.
  // Heuristic should reject so we don't false-color regular log content.
  const text = 'job took [42m] (no reset, plain content)';
  if (looksLikeBareStrippedAnsi(text)) {
    failed++;
    failures.push('FAIL  bare-stripped: heuristic should reject text without [0m');
  } else passed++;
}
{
  // Another negative: only one bare-SGR match. Could easily be a coincidence.
  const text = 'process exited with [0m signal';
  if (looksLikeBareStrippedAnsi(text)) {
    failed++;
    failures.push('FAIL  bare-stripped: heuristic should reject single-match text');
  } else passed++;
}
{
  // Realistic Zscaler-stripped appender line, end to end.
  const stripped =
    '[32mreq-1[0m [[34mINFO  [0m] [36m2026-04-29 10:00:00.000[0m ' +
    '[35mlogger[0m[[34mmain[0m] - received [38;5;208mFooEvent:{"id":1}[0m';
  const s = parseToSegments(stripped);
  if (s.some(x => /\[\d/.test(x.text))) {
    failed++;
    failures.push('FAIL  realistic stripped: bare SGR sequence leaked into segment text: '
                  + JSON.stringify(s.find(x => /\[\d/.test(x.text)).text));
  } else passed++;
  const evtSeg = s.find(x => x.text.startsWith('FooEvent'));
  eq(evtSeg && evtSeg.style.fg, '#ff8700', 'realistic stripped: event highlight resolves to xterm 208');
}
/* ---- OSC 8 hyperlinks --------------------------------------------- */
function segLinks(segments) {
  return segments.map(s => s.linkUrl);
}

{
  // Plain hyperlink, ST terminator. Link text is uncolored.
  const s = parseToSegments('before \x1b]8;;https://example.com/foo\x1b\\Click here\x1b]8;;\x1b\\ after');
  eq(segText(s), ['before ', 'Click here', ' after'], 'osc8 ST: text');
  eq(segLinks(s), [null, 'https://example.com/foo', null], 'osc8 ST: link only on middle segment');
}
{
  // BEL terminator (\x07) is the legacy form; should be accepted too.
  const s = parseToSegments('a\x1b]8;;https://x.test/y\x07link\x1b]8;;\x07b');
  eq(segText(s), ['a', 'link', 'b'], 'osc8 BEL: text');
  eq(segLinks(s), [null, 'https://x.test/y', null], 'osc8 BEL: link');
}
{
  // SGR nested inside the hyperlink — segment carries both style and link.
  const s = parseToSegments('\x1b]8;;https://e.com/\x1b\\\x1b[38;5;208mFooEvent:{"id":1}\x1b[0m\x1b]8;;\x1b\\');
  // Text segments: ["FooEvent:{\"id\":1}"]
  eq(segText(s), ['FooEvent:{"id":1}'], 'osc8 + sgr: text');
  eq(s[0].style.fg, '#ff8700', 'osc8 + sgr: fg is xterm 208');
  eq(s[0].linkUrl, 'https://e.com/', 'osc8 + sgr: link is set');
}
{
  // The realistic shape emitted by MessageHighlightConverter: link OPEN,
  // then color OPEN, label, color RESET, link CLOSE — surrounding plain text.
  const line =
    'Handling \x1b]8;;https://devrisk.nee.com/events?correlationId=xyz\x1b\\' +
    '\x1b[38;2;255;135;0mFooEvent:{"a":1}\x1b[0m\x1b]8;;\x1b\\ tail';
  const s = parseToSegments(line);
  eq(segText(s), ['Handling ', 'FooEvent:{"a":1}', ' tail'], 'realistic mhc line: text');
  eq(segLinks(s),
     [null, 'https://devrisk.nee.com/events?correlationId=xyz', null],
     'realistic mhc line: link wraps only the label');
  eq(s[1].style.fg, 'rgb(255,135,0)', 'realistic mhc line: orange truecolor preserved');
}
{
  // Multiple sequential links — each gets its own segment with its URL.
  const line =
    '\x1b]8;;https://a.test/\x1b\\one\x1b]8;;\x1b\\ ' +
    '\x1b]8;;https://b.test/\x1b\\two\x1b]8;;\x1b\\';
  const s = parseToSegments(line);
  eq(segText(s), ['one', ' ', 'two'], 'multi-link: text');
  eq(segLinks(s), ['https://a.test/', null, 'https://b.test/'], 'multi-link: per-segment urls');
}
{
  // Alternate ESC representations inside OSC 8 — must parse the literal
  // \033 form too (the form a Java logger pattern emits via "\033]8;;...").
  // ST in literal form is "\033\" (ESC-literal + one backslash), 5 chars.
  const s = parseToSegments('\\033]8;;https://lit.test/\\033\\hello\\033]8;;\\033\\');
  eq(segText(s), ['hello'], 'osc8 literal \\033: text');
  eq(s[0].linkUrl, 'https://lit.test/', 'osc8 literal \\033: link');
}
{
  // Unclosed hyperlink: the linkUrl persists to end-of-string. Acceptable
  // behavior — terminals do the same. The next text run still rides the link.
  const s = parseToSegments('open \x1b]8;;https://o.test/\x1b\\rest of line');
  eq(segText(s), ['open ', 'rest of line'], 'unclosed osc8: text');
  eq(segLinks(s), [null, 'https://o.test/'], 'unclosed osc8: link persists to end');
}
{
  // ANY_OSC8 must not match SGR-shaped escapes — make sure regexes don't collide.
  const s = parseToSegments('\x1b[31mred\x1b[0m no link here');
  eq(segLinks(s), [null, null], 'no osc8: linkUrl stays null on plain SGR text');
}


console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
for (const f of failures) console.log(f);
process.exit(failed === 0 ? 0 : 1);
