/*
 * ANSI Colors for AWS CloudWatch
 *
 * Walks the page DOM (and shadow roots) for text nodes containing the ANSI
 * escape character (\x1b), parses Select-Graphic-Rendition (SGR) sequences
 * into a running style state, and replaces each affected text node with a
 * fragment of <span> elements whose inline style reflects that state.
 *
 * Supports:
 *   - SGR reset (0)
 *   - bold (1), dim (2), italic (3), underline (4), inverse (7), strike (9)
 *     and their cancel codes (22/23/24/27/29)
 *   - Standard 8 fg (30-37) / bg (40-47), default fg/bg (39/49)
 *   - Bright 8 fg (90-97) / bg (100-107)
 *   - 256-color fg (38;5;N) / bg (48;5;N)
 *   - Truecolor fg (38;2;R;G;B) / bg (48;2;R;G;B)
 *   - OSC 8 hyperlinks (\x1b]8;;URL\x1b\\TEXT\x1b]8;;\x1b\\) — rendered as
 *     <a href target=_blank rel=noopener noreferrer>. BEL (\x07) is also
 *     accepted as the ST terminator.
 */
(() => {
  'use strict';

  // Marker substrings that indicate "an ANSI escape might start here".
  // CloudWatch sometimes preserves the raw 0x1B byte, but other log
  // pipelines (or AWS' own JSON-encoding step) replace it with one of
  // the literal text escapes. We accept all four so the extension works
  // regardless of which representation reaches the browser.
  const ESC_MARKERS = ['\x1b', '\\u001b', '\\033', '\\e['];
  // CSI = (any ESC representation) '[' params final-byte. Final byte is
  // in [@-~]. We capture params and final separately so we can branch
  // on `m` (SGR) vs. the rest (cursor moves, erases, etc., which we
  // want to consume but not act on so they don't leak into output).
  const ANY_CSI = /(?:\x1b|\\u001b|\\033|\\e)\[([\d;?]*)([@-~])/g;
  // OSC 8 hyperlink: ESC ] 8 ; PARAMS ; URL ST  where ST is ESC \ or BEL.
  // PARAMS is usually empty; URL is empty for the close form. We accept
  // any of the four ESC representations both before `]8` and inside ST,
  // and BEL (\x07) as the alternative terminator.
  const ANY_OSC8 = /(?:\x1b|\\u001b|\\033|\\e)\]8;([^;]*);([^\x1b\x07]*?)(?:(?:\x1b|\\u001b|\\033|\\e)\\|\x07)/g;
  // "Bare" SGR: the bracket-and-params-and-m form WITHOUT a leading ESC
  // marker. Some proxies (Zscaler is one) and some AWS surfaces strip
  // the ESC byte from log content during sanitization, leaving `[32m`-
  // style text in the DOM. This pattern is necessarily looser and so
  // we only apply it to text that ALSO contains `[0m`, the canonical
  // reset code, which is a strong signal that the bracketed digits
  // are SGR rather than coincidental log content like "[42 minutes]".
  const BARE_SGR = /\[(\d{1,3}(?:;\d{1,3}){0,4})m/g;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'CODE-MIRROR']);

  // VS Code "Default Dark Modern" 16-color palette: readable on both
  // light and dark backgrounds, which matters because the CloudWatch
  // console can be either depending on the user's theme setting.
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
      p.push(rgbHex(r, g, b));
    }
    for (let i = 0; i < 24; i++) {
      const v = 8 + i * 10;
      p.push(rgbHex(v, v, v));
    }
    return p;
  })();

  function rgbHex(r, g, b) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function defaultStyle() {
    return {
      fg: null, bg: null,
      bold: false, dim: false, italic: false,
      underline: false, inverse: false, strike: false,
    };
  }

  function isStyled(s) {
    return s.fg || s.bg || s.bold || s.dim || s.italic || s.underline || s.inverse || s.strike;
  }

  function applySgr(state, paramString) {
    const codes = paramString === ''
      ? [0]
      : paramString.split(';').map(s => s === '' ? 0 : parseInt(s, 10) | 0);

    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        state = defaultStyle();
      } else if (c === 1) state.bold = true;
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
        const next = codes[i + 1];
        if (next === 5 && i + 2 < codes.length) {
          const idx = codes[i + 2];
          state.fg = PALETTE_256[idx] || null;
          i += 2;
        } else if (next === 2 && i + 4 < codes.length) {
          state.fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
          i += 4;
        }
      }
      else if (c === 39) state.fg = null;
      else if (c >= 40 && c <= 47) state.bg = BASE_COLORS[c - 40];
      else if (c === 48) {
        const next = codes[i + 1];
        if (next === 5 && i + 2 < codes.length) {
          const idx = codes[i + 2];
          state.bg = PALETTE_256[idx] || null;
          i += 2;
        } else if (next === 2 && i + 4 < codes.length) {
          state.bg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
          i += 4;
        }
      }
      else if (c === 49) state.bg = null;
      else if (c >= 90 && c <= 97) state.fg = BASE_COLORS[c - 90 + 8];
      else if (c >= 100 && c <= 107) state.bg = BASE_COLORS[c - 100 + 8];
    }
    return state;
  }

  function styleToCss(s) {
    let fg = s.fg, bg = s.bg;
    if (s.inverse) {
      const a = fg, b = bg;
      fg = b || '#ffffff';
      bg = a || '#000000';
    }
    const parts = [];
    if (fg) parts.push('color:' + fg);
    if (bg) parts.push('background-color:' + bg);
    if (s.bold) parts.push('font-weight:600');
    if (s.dim) parts.push('opacity:.7');
    if (s.italic) parts.push('font-style:italic');
    const deco = [];
    if (s.underline) deco.push('underline');
    if (s.strike) deco.push('line-through');
    if (deco.length) parts.push('text-decoration:' + deco.join(' '));
    return parts.join(';');
  }

  function parseToSegments(text) {
    const segments = [];
    let cursor = 0;
    let style = defaultStyle();
    let linkUrl = null;
    // Pick the regex that fits this node. If raw / literal ESC markers
    // are present, use the strict CSI matcher (and merge in any OSC 8
    // hyperlinks). Otherwise fall back to the bare-SGR heuristic — but
    // only after looksLikeAnsi has already approved the node, so the
    // heuristic guard runs at most once. Bare-SGR mode never carries
    // OSC 8 (no ESC byte to anchor the hyperlink form).
    const hasRealEsc = ESC_MARKERS.some(mk => text.indexOf(mk) >= 0);
    const matches = collectMatches(text, hasRealEsc);
    for (const m of matches) {
      if (m.index > cursor) {
        segments.push({ text: text.slice(cursor, m.index), style, linkUrl });
      }
      if (m.kind === 'sgr') {
        style = applySgr({ ...style }, m.params);
      } else if (m.kind === 'osc8') {
        // Empty URL is the OSC 8 close form. Anything else opens a new link
        // (and supersedes any open link without an explicit close).
        linkUrl = m.url ? m.url : null;
      }
      // Other CSI sequences (cursor moves, erases) are silently consumed.
      cursor = m.end;
    }
    if (cursor < text.length) {
      segments.push({ text: text.slice(cursor), style, linkUrl });
    }
    return segments;
  }

  // Returns [{ index, end, kind: 'sgr'|'csi'|'osc8', params?, url? }, ...]
  // sorted by index. CSI and OSC 8 are interleaved in source order.
  function collectMatches(text, hasRealEsc) {
    const out = [];
    if (hasRealEsc) {
      ANY_CSI.lastIndex = 0;
      let m;
      while ((m = ANY_CSI.exec(text)) !== null) {
        out.push({
          index: m.index,
          end: ANY_CSI.lastIndex,
          kind: m[2] === 'm' ? 'sgr' : 'csi',
          params: m[1],
        });
      }
      ANY_OSC8.lastIndex = 0;
      while ((m = ANY_OSC8.exec(text)) !== null) {
        out.push({
          index: m.index,
          end: ANY_OSC8.lastIndex,
          kind: 'osc8',
          url: m[2],
        });
      }
      out.sort((a, b) => a.index - b.index);
    } else {
      BARE_SGR.lastIndex = 0;
      let m;
      while ((m = BARE_SGR.exec(text)) !== null) {
        out.push({
          index: m.index,
          end: BARE_SGR.lastIndex,
          kind: 'sgr',
          params: m[1],
        });
      }
    }
    return out;
  }

  function isInsideSkippedTag(node) {
    let p = node.parentNode;
    while (p && p.nodeType === Node.ELEMENT_NODE) {
      if (SKIP_TAGS.has(p.nodeName)) return true;
      p = p.parentNode;
    }
    return false;
  }

  function looksLikeAnsi(text) {
    if (!text) return false;
    for (const marker of ESC_MARKERS) {
      if (text.indexOf(marker) >= 0) return true;
    }
    return looksLikeBareStrippedAnsi(text);
  }

  // Heuristic: treat a text node as ESC-stripped SGR only if it has a
  // reset (`[0m`) AND at least one other bare-SGR match. This filters
  // out incidental occurrences like "killed [9m process" while still
  // catching every line a logback ANSI appender would produce, since
  // the appender always closes its sequences with `[0m`.
  function looksLikeBareStrippedAnsi(text) {
    if (text.indexOf('[0m') < 0) return false;
    BARE_SGR.lastIndex = 0;
    let count = 0;
    while (BARE_SGR.exec(text) !== null) {
      if (++count >= 2) return true;
    }
    return false;
  }

  let summaryLogged = false;

  function processTextNode(node) {
    const text = node.nodeValue;
    if (!looksLikeAnsi(text)) return;
    if (isInsideSkippedTag(node)) return;

    const segments = parseToSegments(text);
    if (segments.length === 0) {
      // Text was nothing but CSI sequences — drop them entirely.
      node.nodeValue = '';
      return;
    }

    const allPlain = segments.every(s => !isStyled(s.style) && !s.linkUrl);
    const cleanText = segments.map(s => s.text).join('');
    if (allPlain) {
      node.nodeValue = cleanText;
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const seg of segments) {
      if (!seg.text) continue;
      const css = styleToCss(seg.style);
      if (seg.linkUrl) {
        const a = document.createElement('a');
        a.setAttribute('href', seg.linkUrl);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        a.setAttribute('data-ansi-link', '1');
        if (css) a.setAttribute('style', css);
        a.textContent = seg.text;
        fragment.appendChild(a);
      } else if (css) {
        const span = document.createElement('span');
        span.setAttribute('style', css);
        span.setAttribute('data-ansi', '1');
        span.textContent = seg.text;
        fragment.appendChild(span);
      } else {
        fragment.appendChild(document.createTextNode(seg.text));
      }
    }

    if (node.parentNode) {
      node.parentNode.replaceChild(fragment, node);
      if (!summaryLogged) {
        summaryLogged = true;
        console.log('[ansi-cloudwatch] colored first ANSI text node; further matches will be processed silently');
      }
    }
  }

  function collectAnsiTextNodes(root, out) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        return looksLikeAnsi(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
  }

  function collectShadowHosts(root, out) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (el.shadowRoot) out.push(el.shadowRoot);
    }
  }

  const observers = new WeakSet();

  function attachObserver(root) {
    if (observers.has(root)) return;
    observers.add(root);
    const obs = new MutationObserver(schedule);
    obs.observe(root, { subtree: true, childList: true, characterData: true });
  }

  function scan(root) {
    if (!root) return;
    const targets = [];
    collectAnsiTextNodes(root, targets);
    for (const t of targets) processTextNode(t);

    const shadowRoots = [];
    collectShadowHosts(root, shadowRoots);
    for (const sr of shadowRoots) {
      attachObserver(sr);
      scan(sr);
    }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        scan(document.body);
      } catch (e) {
        // Never let one bad node take the whole observer down.
        console.error('[ansi-cloudwatch] scan failed', e);
      }
    });
  }

  function start() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', start, { once: true });
      return;
    }
    console.log('[ansi-cloudwatch] active on', location.href);
    schedule();
    attachObserver(document.body);
  }

  function readEnabledThen(fn) {
    try {
      chrome.storage.local.get({ enabled: true }, ({ enabled }) => fn(enabled !== false));
    } catch {
      fn(true);
    }
  }

  readEnabledThen((enabled) => {
    if (enabled) start();
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.enabled) {
        // Reload so the page renders cleanly with the new state.
        location.reload();
      }
    });
  } catch { /* extension API unavailable in this frame; ignore */ }
})();
