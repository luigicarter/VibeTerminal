'use strict';

/**
 * A Node HTTP stand-in for the Lina Terminal desktop bridge.
 *
 * It implements the bridge contract exactly as the desktop does, over
 * demonstration data, so the phone app can be built and verified without the
 * desktop running.
 *
 *   node scripts/mock-bridge.cjs
 *   MOCK http://127.0.0.1:47832 code MOCK-MOCK-MOCK-MOCK
 *
 * The terminal stream is protocol 2: the mock keeps a headless screen model per
 * session — rows of text and the scrollback above them — and sends `hello`, one
 * `scrollback`, a full `screen`, and then `frame`s carrying only the rows that
 * actually moved, at no more than twelve a second. Rows are self-contained ANSI
 * ending in a reset, so a phone that joins late is never missing an attribute.
 * The whole stream is gzipped when the client says it can take it, and so is
 * every JSON body worth compressing.
 *
 * `--storm` makes one session rewrite every row thirty times a second, which is
 * what the frame budget is there for: `bridge.streamStats(id)` then reports the
 * bytes that actually went out against the bytes a full-screen-per-change
 * protocol would have sent.
 *
 * `--read-only` imitates a desktop build that serves the bridge for reading
 * only: `/api/hello` reports `readOnly: true` and every write route answers
 * 404 `{ok:false,error:'not found'}`. Without `--control` the terminal page is
 * view-only and `POST /keys` answers 403 `control not allowed`; `--control`
 * grants it and echoes the bytes back into the screen and the stream.
 *
 * Discovery and pairing need no code: `GET /api/discover`, `POST /api/pair` and
 * the long-polled `GET /api/pair/:requestId`. A request is approved two seconds
 * later by default, as if somebody pressed Allow; `--pair=deny` refuses, and
 * `--pair=manual` waits, printing `PAIR <requestId>` so it can be answered with
 * `POST /__mock/approve/<requestId>`. `--pair-expiry=<ms>` shortens the wait.
 *
 * Every knob the tests need is an option on `createMockBridge`.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const nodePath = require('node:path');
const zlib = require('node:zlib');

// The desktop bridge owns 47831 on the same machine; the mock stays out of its way.
const DEFAULT_PORT = 47832;
const DEFAULT_CODE = 'MOCK-MOCK-MOCK-MOCK';
const MAX_WAIT_MS = 25000;
const MAX_INPUT_CHARS = 48000;

/** The terminal stream's version, reported in `hello`. */
const STREAM_PROTOCOL = 2;

/** The headless screen the mock keeps per session. */
const STREAM_COLS = 80;
const STREAM_ROWS = 24;

/** How many lines above the viewport the model keeps, and how many it sends. */
const MAX_SCROLLBACK = 1200;
const SCROLLBACK_LIMIT = 300;

/** Twelve frames a second, and not one more. */
const FRAME_FPS = 12;
const FRAME_INTERVAL_MS = Math.ceil(1000 / FRAME_FPS);

/** How often a working terminal rewrites its status rows. */
const MUTATE_MS = 300;

/** How often a storming terminal rewrites every row. */
const STORM_HZ = 30;

/** A comment down the wire, so a sleeping proxy does not close the stream. */
const KEEPALIVE_MS = 15000;

/** Below this a gzip header costs more than it saves. */
const GZIP_MIN_BYTES = 512;

/** One page of transcript when the phone does not ask for a size. */
const TRANSCRIPT_LIMIT = 50;
const MAX_TRANSCRIPT_LIMIT = 200;

/** A list row cannot show more, so the wire does not carry more. */
const MAX_SNIPPET_CHARS = 80;

// --- the xterm assets the terminal page needs -------------------------------

/** Served under /vendor/<hash>/, resolved from a real installation at runtime. */
const XTERM_FILES = {
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
};

const XTERM_MISSING_MESSAGE =
  'xterm was not found. Run npm ci in apps/mobile to install the mock terminal assets, ' +
  'or start it with --xterm-dir <folder holding @xterm/xterm and @xterm/addon-fit>.';

/**
 * Find the mobile app's own development assets, or an explicit --xterm-dir.
 * Either a folder that
 * contains `@xterm/...` or one whose `node_modules` does will do.
 *
 * The result carries a content hash, because the assets are served under it and
 * cached forever: a different xterm is a different URL.
 */
function resolveXtermAssets(xtermDir) {
  const roots = [];
  if (xtermDir) roots.push(nodePath.resolve(xtermDir));
  roots.push(nodePath.resolve(__dirname, '..'));
  for (const root of roots) {
    const files = {};
    let complete = true;
    for (const [name, request] of Object.entries(XTERM_FILES)) {
      const direct = nodePath.join(root, ...request.split('/'));
      if (fs.existsSync(direct)) {
        files[name] = direct;
        continue;
      }
      try {
        files[name] = require.resolve(request, { paths: [root] });
      } catch {
        complete = false;
        break;
      }
    }
    if (!complete) continue;
    let hash;
    try {
      const digest = crypto.createHash('sha256');
      for (const name of Object.keys(XTERM_FILES)) digest.update(fs.readFileSync(files[name]));
      hash = digest.digest('hex').slice(0, 12);
    } catch {
      continue;
    }
    return { files, from: root, hash };
  }
  return null;
}

// --- the headless screen model ----------------------------------------------

const RESET = '\u001b[0m';

/**
 * One row as the wire carries it: self-contained ANSI that starts by resetting
 * whatever the last row left behind and ends by resetting its own. A phone that
 * receives row 9 and nothing else still draws row 9 correctly.
 */
function renderRow(text) {
  const body = text.replace(/\s+$/, '');
  if (!body) return RESET;
  return `${RESET}${colorFor(body)}${body}${RESET}`;
}

/** A little colour, so the rows on the wire are real ANSI and not plain text. */
function colorFor(text) {
  if (/^\s*(\$|>|PS )/.test(text)) return '\u001b[1;37m';
  if (/(✓|✔|passing|PASS|built in|\bdone\b)/.test(text)) return '\u001b[32m';
  if (/(Error|ENOENT|throw|FAIL|✗|failed)/.test(text)) return '\u001b[31m';
  if (/^\s*(·|❯|⏵|◯)/.test(text)) return '\u001b[33m';
  return '';
}

function createScreen(cols, rows) {
  return {
    cols,
    rows,
    lines: new Array(rows).fill(''),
    scrollback: [],
    cursor: { x: 0, y: 0, visible: true },
  };
}

function scrollUp(screen) {
  screen.scrollback.push(screen.lines.shift());
  if (screen.scrollback.length > MAX_SCROLLBACK) screen.scrollback.shift();
  screen.lines.push('');
}

function setCell(screen, text) {
  const y = screen.cursor.y;
  const line = screen.lines[y] || '';
  const padded = line.length < screen.cursor.x ? line + ' '.repeat(screen.cursor.x - line.length) : line;
  screen.lines[y] = padded.slice(0, screen.cursor.x) + text + padded.slice(screen.cursor.x + text.length);
  screen.cursor.x += text.length;
}

function newline(screen) {
  screen.cursor.x = 0;
  screen.cursor.y += 1;
  if (screen.cursor.y >= screen.rows) {
    scrollUp(screen);
    screen.cursor.y = screen.rows - 1;
  }
}

/**
 * Write output at the cursor, the way a terminal would. `\n` is treated as a
 * new line and a carriage return together, which is what the desktop's PTY
 * output already looks like by the time it reaches the bridge.
 */
function writeText(screen, text) {
  for (const character of String(text)) {
    if (character === '\n') {
      newline(screen);
      continue;
    }
    if (character === '\r') {
      screen.cursor.x = 0;
      continue;
    }
    if (character === '\t') {
      const next = Math.min(screen.cols - 1, (Math.floor(screen.cursor.x / 8) + 1) * 8);
      setCell(screen, ' '.repeat(Math.max(1, next - screen.cursor.x)));
      continue;
    }
    if (character < ' ') continue;
    if (screen.cursor.x >= screen.cols) newline(screen);
    setCell(screen, character);
  }
}

/** Rewrite one row in place — what a progress line or a spinner really does. */
function setRow(screen, index, text) {
  if (index < 0 || index >= screen.rows) return;
  screen.lines[index] = String(text).slice(0, screen.cols);
  screen.cursor.y = index;
  screen.cursor.x = Math.min(screen.cols - 1, screen.lines[index].length);
}

function resizeScreen(screen, cols, rows) {
  const nextCols = Math.max(20, Math.min(400, Math.trunc(cols) || screen.cols));
  const nextRows = Math.max(4, Math.min(200, Math.trunc(rows) || screen.rows));
  const lines = screen.lines.map(line => line.slice(0, nextCols));
  while (lines.length > nextRows) {
    screen.scrollback.push(lines.shift());
    if (screen.scrollback.length > MAX_SCROLLBACK) screen.scrollback.shift();
  }
  while (lines.length < nextRows) lines.push('');
  screen.cols = nextCols;
  screen.rows = nextRows;
  screen.lines = lines;
  screen.cursor.y = Math.min(screen.cursor.y, nextRows - 1);
  screen.cursor.x = Math.min(screen.cursor.x, nextCols - 1);
}

/** The whole thing as plain text, for the `/screen` fallback the phone keeps. */
function screenText(screen) {
  const all = screen.scrollback.concat(screen.lines).map(line => line.replace(/\s+$/, ''));
  while (all.length > 0 && all[all.length - 1] === '') all.pop();
  return all.join('\n');
}

/* --- the page's geometry, as pure functions ---------------------------------
 *
 * These three run inside the terminal page — their source is injected into it,
 * so what the tests check is literally what the phone executes. They exist
 * because the one thing a terminal on a phone must never do is scroll
 * sideways: every column the desktop has is fitted into the width, and zoom,
 * not a scrollbar, is how small text is read.
 */

/** The largest font the page uses; the fit only ever goes down from here. */
const MAX_FONT_SIZE = 12;

/**
 * The font size at which `cols` columns fit `viewportWidth` exactly, floored to
 * a tenth of a pixel so rounding can only ever leave the terminal narrower.
 * There is no lower bound: a 40-column-wide phone showing 120 columns gets a
 * very small font, and the reader pinches.
 */
function fitFontSize(viewportWidth, cols, advancePerPx, maxFontSize) {
  // Self-contained on purpose: this source is injected into the terminal page.
  const ceiling = maxFontSize > 0 ? maxFontSize : 12;
  if (!(viewportWidth > 0) || !(cols > 0) || !(advancePerPx > 0)) return ceiling;
  const ideal = viewportWidth / (cols * advancePerPx);
  return Math.max(0.5, Math.min(ceiling, Math.floor(ideal * 10) / 10));
}

/**
 * The transform that makes the drawn terminal exactly as wide as the viewport
 * at zoom 1 — xterm rounds its own cell metrics, so a residual correction is
 * what guarantees "never wider" rather than "usually not wider".
 */
function fitScale(viewportWidth, naturalWidth, zoomFactor) {
  if (!(viewportWidth > 0) || !(naturalWidth > 0)) return 1;
  const zoom = Math.min(3, Math.max(0.6, zoomFactor > 0 ? zoomFactor : 1));
  return (viewportWidth / naturalWidth) * zoom;
}

/**
 * Where the content may sit. Bigger than the viewport, it may be dragged but
 * never past its own edges; smaller, it is pinned — to the left across, and to
 * the bottom down, because that is where a terminal's newest line is.
 */
function clampPan(offset, viewport, content, anchorEnd) {
  if (!(content > viewport)) return anchorEnd ? viewport - content : 0;
  return Math.min(0, Math.max(viewport - content, offset));
}

/**
 * Where a translate lands when the content is rescaled about a point.
 *
 * Zooming from the key bar anchors at the left edge and the foot of the view —
 * a terminal reads from column zero and its newest line is at the bottom — so
 * pressing `A+` never leaves the reader panning back to where they already
 * were. A pinch passes the point between the fingers instead.
 */
function anchorPan(offset, origin, ratio) {
  if (!(ratio > 0)) return offset;
  return origin - ratio * (origin - offset);
}

/** Make the control bytes a key bar sends visible in a demonstration screen. */
function echoKeys(data) {
  let out = '';
  for (const character of String(data)) {
    const code = character.codePointAt(0);
    if (character === '\r' || character === '\n') out += '\n';
    else if (character === '\t') out += '\t';
    else if (character === '\u001b') out += '^[';
    else if (code < 32) out += `^${String.fromCharCode(code + 64)}`;
    else out += character;
  }
  return out;
}

/**
 * The page the phone embeds: a real xterm, the desktop's colours, the session's
 * scrollback and screen, and then changed-row frames. It reports itself through
 * `ReactNativeWebView.postMessage` in a WebView and `parent.postMessage` in an
 * iframe, because the phone app uses both.
 *
 * The terminal is the size the stream says it is — 80 columns, whatever the
 * phone is — and a CSS transform on the wrapper is what makes it fit. That is
 * why pinch, two-finger pan and a double tap all work here rather than in the
 * app: the page owns the geometry, so the page owns the gesture.
 */
function terminalPageHtml(config) {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const title = String(config.title || 'Terminal').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>${title}</title>
<link rel="stylesheet" href="${config.vendor.css}">
<style>
  /* Nothing on this page scrolls sideways, at any zoom, on any wrapper. */
  html, body { margin: 0; padding: 0; height: 100%; background: #17181c;
    overflow: hidden; overflow-x: hidden; }
  #pan { position: absolute; top: 0; right: 0; bottom: 0; left: 0;
    overflow: hidden; overflow-x: hidden; touch-action: pan-y; }
  #pan.zoomed { touch-action: none; }
  #pan.viewonly { top: 18px; }
  #zoom { position: absolute; top: 0; left: 0; transform-origin: 0 0;
    display: inline-block; padding: 2px 0; box-sizing: content-box; }
  #banner { position: absolute; top: 0; left: 0; right: 0; height: 18px; z-index: 5;
    font: 600 10px/18px -apple-system, system-ui, "Segoe UI", sans-serif; letter-spacing: .6px;
    text-transform: uppercase; text-align: center; color: #ffc466;
    background: rgba(23,24,28,.94); border-bottom: 1px solid rgba(255,255,255,.09); }
  #banner[hidden] { display: none; }
  /* Two pixels on the right edge, and only while the reader has scrolled away
     from the newest line. A scrollbar would be one more thing to mis-tap. */
  #rail { position: absolute; right: 1px; width: 2px; border-radius: 1px; z-index: 6;
    background: rgba(255,255,255,.45); opacity: 0; transition: opacity .3s; pointer-events: none; }
  #rail.shown { opacity: 1; }
  #fail { position: absolute; top: 0; right: 0; bottom: 0; left: 0; display: none; z-index: 9;
    align-items: center; justify-content: center; padding: 18px; background: #17181c;
    color: #b8b8b8; text-align: center; font: 13px/1.5 -apple-system, system-ui, "Segoe UI", sans-serif; }
  #fail.shown { display: flex; }
  /* Scrolling stays touch-driven; no bar is ever drawn for it. */
  .xterm-viewport { scrollbar-width: none; overflow-x: hidden !important; }
  .xterm-viewport::-webkit-scrollbar { display: none; width: 0; height: 0; }
  .xterm-screen, .xterm { overflow-x: hidden; }
</style>
</head>
<body>
<div id="banner"${config.control ? ' hidden' : ''}>View only</div>
<div id="pan"${config.control ? '' : ' class="viewonly"'}><div id="zoom"><div id="term"></div></div><div id="rail"></div></div>
<div id="fail"></div>
<script src="${config.vendor.js}"></script>
<script>
(function () {
  var config = ${json};
  var MIN_ZOOM = 0.6;
  var MAX_ZOOM = 3;
  var LINE_HEIGHT = 1.25;
  var FONT = '"Cascadia Mono", Menlo, Consolas, monospace';

  // The page's geometry, verbatim from the bridge module that the tests check.
  var fitFontSize = ${fitFontSize.toString()};
  var fitScale = ${fitScale.toString()};
  var clampPan = ${clampPan.toString()};
  var anchorPan = ${anchorPan.toString()};

  function post(message) {
    var body = JSON.stringify(message);
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(body);
      }
    } catch (error) {}
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage(body, '*');
    } catch (error) {}
  }
  function fail(text) {
    var node = document.getElementById('fail');
    node.textContent = text;
    node.className = 'shown';
    post({ type: 'error', message: text });
  }
  if (typeof window.Terminal !== 'function') {
    fail(config.assetsError || 'The terminal renderer could not be loaded.');
    return;
  }

  var term = new window.Terminal({
    convertEol: false,
    cursorBlink: false,
    fontFamily: FONT,
    fontSize: 12,
    lineHeight: LINE_HEIGHT,
    scrollback: 4000,
    cols: config.cols,
    rows: config.rows,
    theme: {
      background: '#17181c',
      foreground: '#ededf0',
      cursor: '#ededf0',
      cursorAccent: '#17181c',
      selectionBackground: 'rgba(255,255,255,0.22)'
    }
  });
  var pan = document.getElementById('pan');
  var zoom = document.getElementById('zoom');
  var rail = document.getElementById('rail');
  term.open(document.getElementById('term'));

  /* ---- geometry: fit across, zoom to read, drag to look --------------- */

  /** How wide one glyph is per pixel of font size, measured once. */
  var advancePerPx = (function () {
    var probe = document.createElement('span');
    probe.style.cssText =
      'position:absolute;visibility:hidden;white-space:pre;font-family:' + FONT + ';font-size:100px';
    probe.textContent = '0000000000';
    document.body.appendChild(probe);
    var width = probe.getBoundingClientRect().width / 10 / 100;
    document.body.removeChild(probe);
    return width > 0 ? width : 0.06;
  })();

  var zoomFactor = 1;
  var scale = 1;
  var tx = 0;
  var ty = 0;
  var applied = '';

  function isZoomed() {
    return zoomFactor > 1.001;
  }
  function contentWidth() {
    return zoom.offsetWidth * scale;
  }
  function contentHeight() {
    return zoom.offsetHeight * scale;
  }
  function apply() {
    tx = clampPan(tx, pan.clientWidth, contentWidth(), false);
    // Anchored to the bottom when there is room: a terminal's newest line sits
    // just above the key bar rather than floating at the top of an empty frame.
    ty = clampPan(ty, pan.clientHeight, contentHeight(), true);
    var next = scale.toFixed(4) + '|' + Math.round(tx) + '|' + Math.round(ty);
    // A resize observer that reacts to its own writes never stops; this does.
    if (next === applied) return;
    applied = next;
    zoom.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    pan.className = (config.control ? '' : 'viewonly ') + (isZoomed() ? 'zoomed' : '');
  }
  function setPan(nextX, nextY) {
    tx = nextX;
    ty = nextY;
    apply();
  }

  /**
   * Fit every column the desktop has into the width. The font size does the
   * work; the residual transform closes whatever xterm's own cell rounding
   * left over, so the drawn width is the viewport width and never more.
   */
  function fit() {
    var available = pan.clientWidth;
    if (!available) return;
    var size = fitFontSize(available, term.cols, advancePerPx, ${MAX_FONT_SIZE});
    if (Math.abs(size - term.options.fontSize) > 0.05) {
      term.options.fontSize = size;
      term.options.lineHeight = LINE_HEIGHT;
    }
    rescale();
    if (window.requestAnimationFrame) window.requestAnimationFrame(rescale);
  }
  function rescale() {
    var available = pan.clientWidth;
    var natural = zoom.offsetWidth;
    if (!available || !natural) return;
    scale = fitScale(available, natural, zoomFactor);
    apply();
    updateRail();
  }
  function resetZoom() {
    zoomFactor = 1;
    tx = 0;
    ty = 0;
    fit();
  }
  /** Zoom about a point, so what the reader was looking at stays put. */
  function zoomAbout(nextFactor, originX, originY) {
    var next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextFactor));
    if (Math.abs(next - zoomFactor) < 0.0005) return;
    var before = scale;
    zoomFactor = next;
    scale = fitScale(pan.clientWidth, zoom.offsetWidth || 1, zoomFactor);
    var ratio = before > 0 ? scale / before : 1;
    tx = anchorPan(tx, originX, ratio);
    ty = anchorPan(ty, originY, ratio);
    apply();
  }
  /**
   * The key bar's A- and A+, and anything else that zooms without a finger:
   * anchored at the left edge and the foot of the view, so column zero stays
   * where it is and the newest lines stay in sight.
   */
  function zoomBy(delta) {
    zoomAbout(zoomFactor + (Number(delta) || 0), 0, pan.clientHeight);
  }

  window.addEventListener('resize', fit);
  if (window.ResizeObserver) new window.ResizeObserver(fit).observe(pan);

  /** Two pixels on the right edge, shown only away from the newest line. */
  function updateRail() {
    var buffer = term.buffer && term.buffer.active;
    if (!buffer) return;
    var total = buffer.baseY + term.rows;
    if (buffer.viewportY >= buffer.baseY || total <= term.rows) {
      rail.className = '';
      return;
    }
    var height = pan.clientHeight;
    var thumb = Math.max(18, Math.round((term.rows / total) * height));
    rail.style.top = Math.round((buffer.viewportY / total) * height) + 'px';
    rail.style.height = thumb + 'px';
    rail.className = 'shown';
  }
  term.onScroll(updateRail);

  /* ---- gestures -------------------------------------------------------- */

  var pinchFrom = 0;
  var pinchFactor = 1;
  var pinchMid = null;
  var lastTapAt = 0;
  var drag = null;

  function spread(touches) {
    var dx = touches[0].clientX - touches[1].clientX;
    var dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function middle(touches) {
    var box = pan.getBoundingClientRect();
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2 - box.left,
      y: (touches[0].clientY + touches[1].clientY) / 2 - box.top
    };
  }

  pan.addEventListener('touchstart', function (event) {
    if (event.touches.length !== 2) return;
    event.preventDefault();
    drag = null;
    pinchFrom = spread(event.touches);
    pinchFactor = zoomFactor;
    pinchMid = middle(event.touches);
  }, { passive: false });

  pan.addEventListener('touchmove', function (event) {
    if (event.touches.length !== 2 || !pinchFrom) return;
    event.preventDefault();
    var here = middle(event.touches);
    zoomAbout(pinchFactor * (spread(event.touches) / pinchFrom), here.x, here.y);
    var dy = here.y - pinchMid.y;
    if (isZoomed()) setPan(tx + (here.x - pinchMid.x), ty + dy);
    else if (dy) {
      // Not zoomed, two fingers: this is a scroll, so scroll the buffer.
      var cell = contentHeight() / term.rows || 1;
      term.scrollLines(-Math.round(dy / cell));
    }
    pinchMid = here;
  }, { passive: false });

  pan.addEventListener('touchend', function (event) {
    if (event.touches.length === 0) pinchFrom = 0;
    if (event.changedTouches.length !== 1 || event.touches.length !== 0) return;
    var now = Date.now();
    if (now - lastTapAt < 300) {
      event.preventDefault();
      resetZoom();
      lastTapAt = 0;
      return;
    }
    lastTapAt = now;
  }, { passive: false });

  // One finger — or a mouse — drags the content while it is zoomed in. While it
  // is not, the touch belongs to xterm's own vertical scrolling.
  pan.addEventListener('pointerdown', function (event) {
    if (pinchFrom || !isZoomed()) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, tx: tx, ty: ty };
    try { pan.setPointerCapture(event.pointerId); } catch (error) {}
  });
  pan.addEventListener('pointermove', function (event) {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    setPan(drag.tx + (event.clientX - drag.x), drag.ty + (event.clientY - drag.y));
  });
  function endDrag(event) {
    if (drag && event.pointerId === drag.id) drag = null;
  }
  pan.addEventListener('pointerup', endDrag);
  pan.addEventListener('pointercancel', endDrag);

  // A wheel or trackpad pans the zoomed content; unzoomed, it is xterm's.
  pan.addEventListener('wheel', function (event) {
    if (!isZoomed()) return;
    event.preventDefault();
    setPan(tx - event.deltaX, ty - event.deltaY);
  }, { passive: false });

  /* ---- the app's handle ------------------------------------------------ */
  window.linaTerminal = {
    focus: function () { try { term.focus(); } catch (error) {} },
    fit: fit,
    zoom: zoomBy,
    resetZoom: resetZoom,
    pan: function (dx, dy) { setPan(tx + (Number(dx) || 0), ty + (Number(dy) || 0)); },
    scale: function () { return scale; },
    zoomFactor: function () { return zoomFactor; },
    drawnWidth: function () { return contentWidth(); },
    scrollToBottom: function () { try { term.scrollToBottom(); } catch (error) {} }
  };
  if (config.control) {
    window.linaTerminal.send = function (data) {
      return fetch(config.keysUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.code },
        body: JSON.stringify({ data: String(data) })
      });
    };
    term.onData(function (data) { window.linaTerminal.send(data); });
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (error) { return; }
    }
    if (!data || !data.type) return;
    if (data.type === 'focus') window.linaTerminal.focus();
    else if (data.type === 'fit') fit();
    else if (data.type === 'zoom') zoomBy(data.delta);
    else if (data.type === 'resetZoom') resetZoom();
    else if (data.type === 'pan') window.linaTerminal.pan(data.dx, data.dy);
  });
  document.addEventListener('pointerdown', function () { window.linaTerminal.focus(); });

  /* ---- the stream ------------------------------------------------------ */
  var bytes = 0;
  var frames = 0;
  var announced = false;
  function announce() {
    if (announced) return;
    announced = true;
    post({ type: 'ready', control: config.control === true });
    // The glyph advance the fit is built on is only final once the font has
    // actually loaded and xterm has re-laid itself out at the new size, so the
    // first fit is measured again a moment later rather than trusted.
    setTimeout(fit, 200);
    setTimeout(fit, 800);
  }
  function paint(rows) {
    var out = '';
    for (var index = 0; index < rows.length; index += 1) {
      out += '\\u001b[' + (rows[index][0] + 1) + ';1H' + rows[index][1] + '\\u001b[K';
    }
    if (out) term.write(out);
  }
  function place(cursor) {
    if (!cursor) return;
    term.write('\\u001b[' + (cursor.y + 1) + ';' + (cursor.x + 1) + 'H' +
      (cursor.visible === false ? '\\u001b[?25l' : '\\u001b[?25h'));
  }
  function read(event) {
    bytes += (event.data || '').length;
    return JSON.parse(event.data);
  }

  var source = new EventSource(config.streamUrl);
  source.addEventListener('hello', function (event) {
    var payload = read(event);
    try { term.resize(payload.cols, payload.rows); } catch (error) {}
    fit();
  });
  source.addEventListener('scrollback', function (event) {
    var payload = read(event);
    var lines = payload.lines || [];
    var out = '';
    for (var index = 0; index < lines.length; index += 1) out += lines[index] + '\\r\\n';
    // Push every one of them above the viewport, or the first screen paint
    // would land on top of the last rows-1 of them and lose that much history.
    for (var blank = 1; blank < term.rows; blank += 1) out += '\\r\\n';
    if (out) term.write(out);
  });
  source.addEventListener('screen', function (event) {
    var payload = read(event);
    paint(payload.rows || []);
    place(payload.cursor);
    fit();
    announce();
  });
  source.addEventListener('frame', function (event) {
    var payload = read(event);
    frames += 1;
    paint(payload.rows || []);
    place(payload.cursor);
    updateRail();
  });
  source.addEventListener('resize', function (event) {
    var payload = read(event);
    try { term.resize(payload.cols, payload.rows); } catch (error) {}
    fit();
  });
  source.addEventListener('exit', function (event) {
    read(event);
    source.close();
    post({ type: 'exit' });
  });
  source.onerror = function () {
    if (source.readyState === 2) fail('The stream from the desktop stopped.');
  };

  // What this page has cost, so Settings can show it. These are the decoded
  // payload lengths the page can see; the wire carried gzip of them.
  setInterval(function () { post({ type: 'stats', bytes: bytes, frames: frames }); }, 5000);
})();
</script>
</body>
</html>
`;
}

function normalizeCode(value) {
  return String(value || '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

function formatCode(value) {
  const flat = normalizeCode(value).slice(0, 16);
  return (flat.match(/.{1,4}/g) || []).join('-');
}

const STATUS_LABELS = {
  working: 'Working',
  waiting: 'Waiting',
  done: 'Done',
  failed: 'Failed',
  idle: 'Idle',
  starting: 'Starting',
  exited: 'Exited',
};

/** The prompt `POST /__mock/needs-input/:id` parks a terminal on. */
const DEFAULT_MOCK_PROMPT = {
  kind: 'yesno',
  prompt: 'Run the test suite before committing?',
  options: [
    { key: '1', label: 'Yes' },
    { key: '2', label: 'No, commit as is' },
  ],
};

/**
 * Read a hook's optional body into the `needsInput` shape, so a test can ask
 * for a particular prompt without having to send the whole thing.
 */
function normalizeMockPrompt(body) {
  const raw = body && typeof body === 'object' ? body : {};
  const prompt = typeof raw.prompt === 'string' && raw.prompt.trim() ? raw.prompt.trim() : null;
  const options = Array.isArray(raw.options)
    ? raw.options
        .filter(entry => entry && typeof entry.key === 'string')
        .map(entry => ({ key: entry.key, label: String(entry.label || entry.key) }))
    : null;
  if (!prompt && !options) return { ...DEFAULT_MOCK_PROMPT };
  return {
    kind: typeof raw.kind === 'string' ? raw.kind : 'menu',
    prompt: prompt || DEFAULT_MOCK_PROMPT.prompt,
    options: options || [],
  };
}

function demoData(now) {
  const minutes = value => now - value * 60000;

  const projects = [
    { id: 'p-vibe', name: 'vibeTerminal', path: 'C:\\Users\\ahmed\\Documents\\vibeTerminal' },
    { id: 'p-lina-site', name: 'lina-site', path: 'C:\\Users\\ahmed\\Documents\\lina-site' },
    { id: 'p-notes', name: 'notes', path: 'C:\\Users\\ahmed\\Documents\\notes' },
  ];

  const sessions = [
    {
      id: 's-codex',
      generation: 4,
      projectId: 'p-vibe',
      projectName: 'vibeTerminal',
      title: 'Phone bridge endpoints',
      kind: 'codex',
      provider: 'openai',
      isChat: false,
      status: 'working',
      attention: false,
      lastActivityAt: minutes(0),
      snippet: 'Writing the long-poll handler for /api/state',
      transcriptStatus: 'found',
      transcript: [
        { role: 'user', text: 'Add a GET /api/state endpoint to the phone bridge that long-polls on a revision number.' },
        {
          role: 'assistant',
          text: 'Plan: keep a module-level revision counter, a Set of pending responses, and bump both whenever the session store changes. /api/state answers immediately when the client revision differs, otherwise it parks the response for up to `wait` ms.',
        },
        { role: 'user', text: 'Cap wait at 25 seconds so proxies do not drop it.' },
        {
          role: 'assistant',
          text: 'Clamped: `const wait = Math.max(0, Math.min(25000, Number(query.wait) || 0))`. A wait of 0 returns the current snapshot straight away, which is what pull-to-refresh uses.',
        },
        { role: 'user', text: 'What happens to parked responses when the client disconnects?' },
        {
          role: 'assistant',
          text: 'Each waiter registers a `close` listener that clears its timer and removes it from the Set, so a phone that walks out of Wi-Fi range does not leak a timer or a socket.',
        },
        { role: 'user', text: 'Good. Now wire the revision bump into the session store.' },
        {
          role: 'assistant',
          text: 'Done — `sessionStore.on("change", bumpRevision)` covers create, title, status and exit. I am running the smoke test now.',
        },
      ],
      screen: [
        '$ npm run smoke:backend:phone-bridge',
        '',
        '  phone bridge',
        '    ✓ hello answers with the app identity',
        '    ✓ state answers immediately on a stale revision',
        '    ✓ state parks a matching revision until a change lands',
        '    ✓ state clamps wait at 25000ms',
        '    ✓ a closed socket removes its waiter',
        '',
        '  5 passing (612ms)',
        '',
        '$ node scripts/backend/phone-bridge-probe.cjs --watch',
        'watching apps/desktop/backend/phoneBridge.cjs',
        // The last two rows of the viewport belong to the live status lines the
        // mock rewrites in place; nothing is seeded into them.
      ].join('\n'),
    },
    {
      id: 's-claude',
      generation: 2,
      projectId: 'p-vibe',
      projectName: 'vibeTerminal',
      title: 'Status pill audit',
      kind: 'claude',
      provider: 'anthropic',
      isChat: false,
      status: 'waiting',
      attention: true,
      lastActivityAt: minutes(3),
      snippet: 'May I edit apps/desktop/frontend/components/StatusPill.tsx?',
      // The one terminal parked on a prompt: the phone shows chips for it.
      needsInput: {
        kind: 'menu',
        prompt: 'Edit apps/desktop/frontend/components/StatusPill.tsx?',
        options: [
          { key: '1', label: 'Yes' },
          { key: '2', label: "Yes, and don't ask again" },
          { key: '3', label: 'No, tell Claude what to do differently' },
        ],
      },
      transcriptStatus: 'found',
      transcript: [
        { role: 'user', text: 'Audit every status pill colour in the renderer against docs/terminal-status-support.md.' },
        {
          role: 'assistant',
          text: 'I read both files. Six of the seven states match the document. `starting` renders #c2c2c2 in the component but the document says the starting and exited states share one grey, which they do — so that one is fine.',
        },
        { role: 'user', text: 'Then what does not match?' },
        {
          role: 'assistant',
          text: 'The `waiting` pill uses #6bd7db in the component while the session dot uses #74b9ed. Both are intentional (pill text versus dot fill), but the document only lists one waiting colour, so the document is wrong, not the code.',
        },
        { role: 'user', text: 'Fix the document then, and leave the component alone.' },
        {
          role: 'assistant',
          text: 'I need permission to edit apps/desktop/frontend/components/StatusPill.tsx to add the clarifying comment. May I?',
        },
      ],
      screen: [
        '  Reading docs/terminal-status-support.md (412 lines)',
        '  Reading apps/desktop/frontend/components/StatusPill.tsx (88 lines)',
        '',
        '  waiting pill   #6bd7db   documented',
        '  waiting dot    #74b9ed   NOT documented',
        '  done pill      #8fd694   documented',
        '  failed pill    #ff8e95   documented',
        '',
        '  Edit file apps/desktop/frontend/components/StatusPill.tsx?',
        '  ❯ 1. Yes',
        '    2. Yes, and do not ask again',
        '    3. No, tell Claude what to do differently',
      ].join('\n'),
    },
    {
      id: 's-gemini',
      generation: 1,
      projectId: 'p-lina-site',
      projectName: 'lina-site',
      title: 'Pricing page copy',
      kind: 'gemini',
      provider: 'google',
      isChat: false,
      status: 'done',
      attention: false,
      lastActivityAt: minutes(12),
      snippet: 'Rewrote the three tier descriptions and shortened the FAQ.',
      transcriptStatus: 'found',
      transcript: [
        { role: 'user', text: 'Rewrite the pricing tiers in src/pages/Pricing.tsx. Shorter, no marketing adjectives.' },
        {
          role: 'assistant',
          text: 'Rewritten. Solo is now "One machine. Every agent.", Team is "Shared projects, per-seat billing.", Studio is "Self-hosted, your own keys." Each tier lost about forty words.',
        },
        { role: 'user', text: 'Does the FAQ still repeat the tier text?' },
        { role: 'assistant', text: 'It did, in two answers. I replaced both with a link to the tier table rather than repeating the copy.' },
        { role: 'user', text: 'Build it.' },
        { role: 'assistant', text: 'npm run build passed: 1.24s, 412 kB, no type errors. The page renders at 360px without a horizontal scrollbar.' },
      ],
      screen: [
        '$ npm run build',
        '',
        'vite v5.4.11 building for production...',
        '✓ 412 modules transformed.',
        'dist/index.html                  0.71 kB │ gzip:  0.41 kB',
        'dist/assets/index-Ck2m1s.css    18.22 kB │ gzip:  4.08 kB',
        'dist/assets/index-B0xQpp.js    412.05 kB │ gzip: 128.77 kB',
        '✓ built in 1.24s',
        '',
        '$ ',
      ].join('\n'),
    },
    {
      id: 's-terminal',
      generation: 1,
      projectId: 'p-vibe',
      projectName: 'vibeTerminal',
      title: 'npm run dev',
      kind: 'terminal',
      provider: 'shell',
      isChat: false,
      status: 'idle',
      attention: false,
      lastActivityAt: minutes(26),
      snippet: 'electron . --dev',
      // A terminal whose working directory is not the project root: the one
      // session whose `cwd` the state has to carry.
      cwd: 'C:\\Users\\ahmed\\Documents\\vibeTerminal\\apps\\desktop',
      transcriptStatus: 'unsupported',
      transcript: [],
      screen: [
        'PS C:\\Users\\ahmed\\Documents\\vibeTerminal> npm run dev',
        '',
        '> vibeterminal@0.1.117 dev',
        '> node scripts/run-app.cjs desktop dev',
        '',
        '[main] electron 34.2.0 starting',
        '[main] pty host ready (conpty: bundled)',
        '[renderer] vite dev server on http://localhost:5173',
        '[main] window shown in 812ms',
        '',
      ].join('\n'),
    },
    {
      id: 's-fusion',
      generation: 3,
      projectId: 'p-lina-site',
      projectName: 'lina-site',
      title: 'Checkout flow',
      kind: 'fusion',
      provider: 'fusion',
      isChat: true,
      status: 'working',
      // A label the status alone does not carry, so the wire has to send it.
      statusLabel: 'Working · milestone 3 of 3',
      attention: false,
      lastActivityAt: minutes(1),
      snippet: 'Executor is running the Stripe webhook test.',
      transcriptStatus: 'found',
      transcript: [
        { role: 'user', text: 'The checkout page double-charges when the customer hits back and resubmits. Fix it.' },
        {
          role: 'assistant',
          text: 'Milestone 1: reproduce. Milestone 2: add an idempotency key. Milestone 3: prove the second submit is a no-op. Delegating milestone 1 to the executor.',
        },
        { role: 'user', text: 'Go.' },
        {
          role: 'assistant',
          text: 'Reproduced: two POSTs to /api/checkout 900ms apart create two Stripe PaymentIntents. The executor captured both intent ids in the test log.',
        },
        { role: 'user', text: 'Use the session id as the idempotency key.' },
        {
          role: 'assistant',
          text: 'Executor added `idempotencyKey: session.id` to the create call and a unique index on (session_id) in the orders table. Running the webhook test now.',
        },
      ],
      screen: [
        '  ⏵ executor · milestone 3 of 3',
        '',
        '  PASS  tests/checkout.idempotency.test.ts',
        '    ✓ first submit creates one payment intent (214ms)',
        '    ✓ resubmit reuses the same intent (198ms)',
        '    ◯ webhook marks the order paid exactly once',
        '',
        '  running: stripe trigger payment_intent.succeeded',
      ].join('\n'),
    },
    {
      id: 's-qwen',
      generation: 2,
      projectId: 'p-notes',
      projectName: 'notes',
      title: 'Note importer',
      kind: 'qwen',
      provider: 'alibaba',
      isChat: false,
      status: 'failed',
      statusLabel: 'Failed · ENOENT',
      attention: true,
      lastActivityAt: minutes(41),
      snippet: 'ENOENT: no such file or directory, open ...\\exports\\2026-09.json',
      transcriptStatus: 'found',
      transcript: [
        { role: 'user', text: 'Import the September export into the notes database.' },
        { role: 'assistant', text: 'Running scripts/import.mjs with --month 2026-09.' },
        { role: 'user', text: 'Did it finish?' },
        {
          role: 'assistant',
          text: 'No. It threw ENOENT on exports/2026-09.json. The exports folder holds 2026-07.json and 2026-08.json only, so the September export was never written.',
        },
        { role: 'user', text: 'Can you generate it from the raw notes?' },
        {
          role: 'assistant',
          text: 'Not without the export tool: the raw notes are markdown with no frontmatter, and the importer needs the id and createdAt fields the exporter adds. Run `npm run export -- --month 2026-09` first.',
        },
      ],
      screen: [
        '$ node scripts/import.mjs --month 2026-09',
        '',
        'node:internal/fs/utils:344',
        '    throw err;',
        '    ^',
        '',
        "Error: ENOENT: no such file or directory, open 'C:\\Users\\ahmed\\Documents\\notes\\exports\\2026-09.json'",
        '    at Object.openSync (node:fs:573:18)',
        '    at readFileSync (node:fs:462:35)',
        '    at loadMonth (file:///C:/Users/ahmed/Documents/notes/scripts/import.mjs:14:18)',
        '',
        'Node.js v22.14.0',
        '$ ',
      ].join('\n'),
    },
    {
      id: 's-cursor',
      generation: 1,
      projectId: 'p-notes',
      projectName: 'notes',
      title: 'Markdown lint',
      kind: 'cursor',
      provider: 'cursor',
      isChat: false,
      status: 'exited',
      attention: false,
      lastActivityAt: minutes(95),
      snippet: 'Process exited with code 0.',
      transcriptStatus: 'found',
      transcript: [
        { role: 'user', text: 'Lint every markdown file in this folder and fix the trivial things.' },
        {
          role: 'assistant',
          text: 'markdownlint flagged 38 issues across 12 files: 31 were trailing whitespace or missing final newlines, which I fixed.',
        },
        { role: 'user', text: 'And the other seven?' },
        {
          role: 'assistant',
          text: 'Four are long lines inside code fences (left alone on purpose) and three are duplicate headings in daily notes, where the duplication is meaningful. I left all seven.',
        },
        { role: 'user', text: 'Fine. Exit.' },
        { role: 'assistant', text: 'Committed nothing — the fixes are in your working tree. Exiting.' },
      ],
      screen: [
        '$ npx markdownlint "**/*.md" --fix',
        '',
        'daily/2026-09-02.md:14 MD024/no-duplicate-heading',
        'daily/2026-09-05.md:22 MD024/no-duplicate-heading',
        'daily/2026-09-09.md:31 MD024/no-duplicate-heading',
        'reference/shortcuts.md:8 MD013/line-length',
        '',
        '7 issues remain, 31 fixed',
        '',
        '[process exited with code 0]',
      ].join('\n'),
    },
  ];

  const messages = [
    {
      id: 'm-1',
      role: 'user',
      text: 'Check whether the phone bridge work is done, and get the pricing page rebuilt.',
      at: minutes(18),
      requestId: 'req-1',
      taskId: null,
      status: null,
      targetId: null,
    },
    {
      id: 'm-2',
      role: 'assistant',
      text: 'Two pieces of work. I gave the bridge endpoints to the Codex terminal in vibeTerminal and the pricing rebuild to Gemini in lina-site.',
      at: minutes(18),
      requestId: 'req-1',
      taskId: 't-1',
      status: 'routing',
      targetId: 's-codex',
    },
    {
      id: 'm-3',
      role: 'system',
      text: 'Gemini finished in lina-site · 2 files changed',
      at: minutes(12),
      requestId: 'req-1',
      taskId: 't-2',
      status: 'finished',
      targetId: 's-gemini',
    },
    {
      id: 'm-4',
      role: 'user',
      text: 'Why is Claude stuck on the status pill audit?',
      at: minutes(4),
      requestId: 'req-2',
      taskId: null,
      status: null,
      targetId: null,
    },
    {
      id: 'm-5',
      role: 'assistant',
      text: 'It is not stuck — it is waiting for you. It asked permission to edit StatusPill.tsx and nobody has answered. Open that terminal and reply, or tell me to answer for you.',
      at: minutes(4),
      requestId: 'req-2',
      taskId: 't-3',
      status: 'needs-answer',
      targetId: 's-claude',
    },
    {
      id: 'm-6',
      role: 'assistant',
      text: 'Codex is still on the bridge endpoints: long-poll parking is written and the smoke test passes; it is checking disconnect cleanup now.',
      at: minutes(1),
      requestId: 'req-1',
      taskId: 't-1',
      status: 'running',
      targetId: 's-codex',
    },
  ];

  const tasks = [
    {
      id: 't-1',
      requestId: 'req-1',
      text: 'Write the phone bridge endpoints and prove the long poll parks and wakes.',
      status: 'running',
      terminalId: 's-codex',
      projectId: 'p-vibe',
      cwd: 'C:\\Users\\ahmed\\Documents\\vibeTerminal',
      createdAt: minutes(18),
      updatedAt: minutes(1),
      result: null,
      error: null,
      summary: 'Long-poll parking written; disconnect cleanup under test.',
    },
    {
      id: 't-2',
      requestId: 'req-1',
      text: 'Rewrite the pricing tiers and rebuild lina-site.',
      status: 'finished',
      terminalId: 's-gemini',
      projectId: 'p-lina-site',
      cwd: 'C:\\Users\\ahmed\\Documents\\lina-site',
      createdAt: minutes(18),
      updatedAt: minutes(12),
      result: 'Three tiers rewritten, FAQ de-duplicated, build passed in 1.24s.',
      error: null,
      summary: null,
    },
    {
      id: 't-3',
      requestId: 'req-2',
      text: 'Find out what the status pill audit is waiting for.',
      status: 'needs-answer',
      terminalId: 's-claude',
      projectId: 'p-vibe',
      cwd: 'C:\\Users\\ahmed\\Documents\\vibeTerminal',
      createdAt: minutes(4),
      updatedAt: minutes(4),
      result: null,
      error: null,
      summary: 'Claude is asking permission to edit StatusPill.tsx.',
    },
  ];

  return { projects, sessions, messages, tasks };
}

/**
 * Everything above the demonstration screen: what this terminal printed before
 * the phone looked at it. It is what the `scrollback` event is for, and without
 * it that event would always be empty.
 */
function preambleFor(session) {
  const lines = [`$ lina attach ${session.id}`, ''];
  for (let index = 1; index <= 34; index += 1) {
    lines.push(`  ${String(index).padStart(3, ' ')}  ${session.title} — earlier output, kept in scrollback`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function createMockBridge(options = {}) {
  const code = normalizeCode(options.code || DEFAULT_CODE);
  const tickMs = options.tickMs === undefined ? 8000 : options.tickMs;
  const requestFinishMs = options.requestFinishMs === undefined ? 4000 : options.requestFinishMs;
  const replyMs = options.replyMs === undefined ? 2500 : options.replyMs;
  const version = options.version || '0.1.117';
  const desktopHost = options.desktopHost || 'LINA-DESKTOP';
  const readOnly = options.readOnly === true;
  // Control is what the future write routes need; without it the terminal page
  // is view-only and POST /keys is refused, which is the state shipping today.
  const control = options.control === true && !readOnly;
  /** How often the working terminal rewrites its two status rows. */
  const mutateMs = options.mutateMs === undefined ? MUTATE_MS : options.mutateMs;
  /** One session rewriting every row, to measure the frame budget against. */
  const storm = options.storm === true;
  const stormSessionId = options.stormSessionId || 's-fusion';
  const stormHz = options.stormHz === undefined ? STORM_HZ : options.stormHz;
  const gzipEnabled = options.gzip !== false;
  const xterm = resolveXtermAssets(options.xtermDir);
  const desktopId = options.desktopId || 'mock-desktop-0001';
  // 'auto' approves by itself, 'deny' refuses, and 'manual' waits for
  // POST /__mock/approve/:id (printing the request id so a person can answer).
  const pairMode = options.pairMode || 'auto';
  const pairAnswerMs = options.pairAnswerMs === undefined ? 2000 : options.pairAnswerMs;
  const pairExpiryMs = options.pairExpiryMs === undefined ? 120000 : options.pairExpiryMs;

  const now = Date.now();
  const data = demoData(now);
  const timers = new Set();
  const waiters = new Set();

  let revision = 1;
  let stateAt = now;
  let counter = 0;
  let closed = false;

  /** requestId -> { status, expiresAt, delivered, deviceName, platform } */
  const pairRequests = new Map();
  /** requestId -> Set of parked responses waiting for an answer. */
  const pairWaiters = new Map();
  /** sessionId -> the screen model, the listeners, and what they have been sent. */
  const streams = new Map();

  /** Immutable, content-addressed URLs for the three xterm files. */
  const vendorUrls = {
    js: `/vendor/${xterm ? xterm.hash : 'missing'}/xterm.js`,
    css: `/vendor/${xterm ? xterm.hash : 'missing'}/xterm.css`,
    fit: `/vendor/${xterm ? xterm.hash : 'missing'}/addon-fit.js`,
  };

  function later(fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!closed) fn();
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    timers.add(timer);
    return timer;
  }

  function bump() {
    revision += 1;
    stateAt = Date.now();
    for (const waiter of Array.from(waiters)) waiter.wake();
  }

  function findSession(id) {
    return data.sessions.find(session => session.id === id) || null;
  }

  function countsFor(projectId) {
    const counts = { working: 0, waiting: 0, done: 0, failed: 0 };
    for (const session of data.sessions) {
      if (session.projectId !== projectId) continue;
      if (counts[session.status] !== undefined) counts[session.status] += 1;
    }
    return counts;
  }

  /**
   * One session as `/api/state` carries it. Three things are left out on
   * purpose: a `statusLabel` that only repeats the status, a `cwd` that only
   * repeats the project's path, and any snippet past what a row can show.
   */
  function publicSession(session) {
    const project = data.projects.find(entry => entry.id === session.projectId) || {};
    const projectPath = project.path || '';
    const cwd = session.cwd || projectPath;
    const label = session.statusLabel || session.status;
    const snippet = String(session.snippet || '');
    const body = {
      id: session.id,
      generation: session.generation,
      projectId: session.projectId,
      projectName: session.projectName,
      title: session.title,
      kind: session.kind,
      provider: session.provider,
      isChat: session.isChat,
      status: session.status,
      lastActivityAt: session.lastActivityAt,
      attention: session.attention,
      snippet:
        snippet.length > MAX_SNIPPET_CHARS ? `${snippet.slice(0, MAX_SNIPPET_CHARS - 1)}…` : snippet,
      needsInput: session.needsInput || null,
    };
    if (label !== session.status) body.statusLabel = label;
    if (cwd && cwd !== projectPath) body.cwd = cwd;
    return body;
  }

  // --- the live terminal stream ---------------------------------------------

  function streamFor(session) {
    let stream = streams.get(session.id);
    if (!stream) {
      const screen = createScreen(STREAM_COLS, STREAM_ROWS);
      writeText(screen, preambleFor(session));
      writeText(screen, `${session.screen}\n`);
      stream = {
        screen,
        // What every attached phone has already been given, row by row, so a
        // frame can carry the difference and nothing else.
        published: screen.lines.map(renderRow),
        publishedCursor: { ...screen.cursor },
        seq: 0,
        frames: 0,
        mutations: 0,
        sentBytes: 0,
        naiveBytes: 0,
        listeners: new Set(),
        timer: null,
        dirty: false,
        lastFrameAt: 0,
        ticker: null,
      };
      streams.set(session.id, stream);
    }
    return stream;
  }

  function screenEvent(stream) {
    return {
      seq: stream.seq,
      rows: stream.screen.lines.map((line, index) => [index, renderRow(line)]),
      cursor: { ...stream.screen.cursor },
    };
  }

  function broadcast(stream, event, payload) {
    const block = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const listener of Array.from(stream.listeners)) listener.write(block);
  }

  /**
   * Something changed on the screen. Nothing goes out yet: frames are capped,
   * so the change waits its turn and travels with whatever else has moved.
   */
  function markDirty(session) {
    const stream = streamFor(session);
    stream.dirty = true;
    if (stream.listeners.size > 0) {
      stream.mutations += 1;
      // What a protocol that sent the whole screen on every change would have
      // put on the wire for this one change, uncompressed. The honest baseline.
      stream.naiveBytes += Buffer.byteLength(
        `event: screen\ndata: ${JSON.stringify(screenEvent(stream))}\n\n`
      );
    }
    scheduleFrame(session);
  }

  function scheduleFrame(session) {
    const stream = streamFor(session);
    if (stream.timer || !stream.dirty || stream.listeners.size === 0 || closed) return;
    const wait = Math.max(0, FRAME_INTERVAL_MS - (Date.now() - stream.lastFrameAt));
    stream.timer = setTimeout(() => {
      stream.timer = null;
      publishFrame(session);
    }, wait);
    if (typeof stream.timer.unref === 'function') stream.timer.unref();
  }

  /** Send the rows that actually moved, and remember that they have gone. */
  function publishFrame(session, options = {}) {
    const stream = streamFor(session);
    const rendered = stream.screen.lines.map(renderRow);
    const rows = [];
    for (let index = 0; index < rendered.length; index += 1) {
      if (rendered[index] !== stream.published[index]) rows.push([index, rendered[index]]);
    }
    const cursor = { ...stream.screen.cursor };
    const cursorMoved =
      cursor.x !== stream.publishedCursor.x ||
      cursor.y !== stream.publishedCursor.y ||
      cursor.visible !== stream.publishedCursor.visible;
    stream.dirty = false;
    if (rows.length === 0 && !cursorMoved) return;
    stream.seq += 1;
    stream.published = rendered;
    stream.publishedCursor = cursor;
    stream.lastFrameAt = Date.now();
    if (stream.listeners.size === 0) return;
    stream.frames += 1;
    if (options.silent !== true) broadcast(stream, 'frame', { seq: stream.seq, rows, cursor });
  }

  /** Output from the process, at the cursor, exactly as a PTY would deliver it. */
  function writeToSession(session, text) {
    if (!text) return;
    writeText(streamFor(session).screen, text);
    markDirty(session);
  }

  /**
   * The demonstration activity: a working terminal rewrites two rows in place,
   * which is what a spinner or a progress line really does, and which is the
   * whole reason frames carry rows and not screens.
   */
  function startActivity(session) {
    const stream = streamFor(session);
    if (stream.ticker) return;
    const storming = storm && session.id === stormSessionId;
    const interval = storming ? Math.max(1, Math.round(1000 / stormHz)) : mutateMs;
    if (interval <= 0) return;
    if (!storming && session.status !== 'working') return;
    let step = 0;
    stream.ticker = setInterval(() => {
      if (closed) return;
      step += 1;
      const screen = stream.screen;
      if (storming) {
        // Every row, every time: the worst case the frame budget exists for.
        for (let row = 0; row < screen.rows; row += 1) {
          setRow(
            screen,
            row,
            `  ${String(row).padStart(2, ' ')} │ ${String(step).padStart(7, ' ')} ` +
              `${'█'.repeat((step + row) % 40)}${'░'.repeat(40 - ((step + row) % 40))}`
          );
        }
      } else {
        if (session.status !== 'working') return;
        const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][step % 10];
        setRow(screen, screen.rows - 2, `  ${spinner} working (${step})`);
        setRow(screen, screen.rows - 1, `  elapsed ${(step * (interval / 1000)).toFixed(1)}s`);
        session.lastActivityAt = Date.now();
      }
      markDirty(session);
    }, interval);
    if (typeof stream.ticker.unref === 'function') stream.ticker.unref();
  }

  function stopActivity(session) {
    const stream = streamFor(session);
    if (!stream.ticker) return;
    clearInterval(stream.ticker);
    stream.ticker = null;
  }

  /** The desktop's PTY changed size: say so, then repaint the lot. */
  function resizeSession(sessionId, cols, rows) {
    const session = findSession(sessionId);
    if (!session) return false;
    const stream = streamFor(session);
    resizeScreen(stream.screen, cols, rows);
    stream.published = stream.screen.lines.map(renderRow);
    stream.publishedCursor = { ...stream.screen.cursor };
    stream.seq += 1;
    stream.dirty = false;
    broadcast(stream, 'resize', { cols: stream.screen.cols, rows: stream.screen.rows });
    broadcast(stream, 'screen', screenEvent(stream));
    return true;
  }

  function handleStream(req, res, session) {
    const stream = streamFor(session);
    const compress = gzipEnabled && acceptsGzip(req);
    const headers = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      Vary: 'Accept-Encoding',
      'X-Accel-Buffering': 'no',
    };
    if (compress) headers['Content-Encoding'] = 'gzip';
    cors(res);
    res.writeHead(200, headers);

    // EventSource decodes gzip itself, so the only thing this costs is a flush
    // after every event to keep the stream live rather than buffered.
    let sink = res;
    if (compress) {
      const gzip = zlib.createGzip();
      gzip.on('data', chunk => {
        stream.sentBytes += chunk.length;
      });
      gzip.on('error', () => {
        /* the socket went away mid-flush */
      });
      gzip.pipe(res);
      sink = gzip;
    }

    const listener = {
      write(text) {
        if (res.writableEnded) return;
        if (compress) {
          sink.write(text);
          sink.flush(zlib.constants.Z_SYNC_FLUSH);
        } else {
          stream.sentBytes += Buffer.byteLength(text);
          sink.write(text);
        }
      },
      end() {
        if (res.writableEnded) return;
        if (compress) sink.end();
        else res.end();
      },
    };

    // Everything already changed goes out first, so the full screen this phone
    // is about to be handed is exactly the one the next frame builds on.
    if (stream.dirty) publishFrame(session);

    listener.write(
      `event: hello\ndata: ${JSON.stringify({
        protocol: STREAM_PROTOCOL,
        cols: stream.screen.cols,
        rows: stream.screen.rows,
        seq: stream.seq,
        exited: session.status === 'exited',
        control,
      })}\n\n`
    );
    listener.write(
      `event: scrollback\ndata: ${JSON.stringify({
        lines: stream.screen.scrollback.slice(-SCROLLBACK_LIMIT).map(renderRow),
      })}\n\n`
    );
    listener.write(`event: screen\ndata: ${JSON.stringify(screenEvent(stream))}\n\n`);

    if (session.status === 'exited') {
      listener.write('event: exit\ndata: {}\n\n');
      listener.end();
      return;
    }

    stream.listeners.add(listener);
    startActivity(session);

    const keepalive = setInterval(() => listener.write(': keepalive\n\n'), KEEPALIVE_MS);
    if (typeof keepalive.unref === 'function') keepalive.unref();

    res.on('close', () => {
      clearInterval(keepalive);
      stream.listeners.delete(listener);
      if (stream.listeners.size === 0) stopActivity(session);
    });
  }

  async function handleKeys(req, res, session) {
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return;
    }
    const keys = typeof body.data === 'string' ? body.data : '';
    if (!keys) {
      sendError(res, 400, 'data is required');
      return;
    }
    if (keys.length > MAX_INPUT_CHARS) {
      sendError(res, 413, `data is longer than ${MAX_INPUT_CHARS} characters`);
      return;
    }
    if (session.status === 'exited') {
      sendError(res, 409, 'that terminal has exited');
      return;
    }

    counter += 1;
    // Keys are answered by the terminal, so whatever it was waiting for is done.
    session.needsInput = null;
    session.attention = false;
    session.lastActivityAt = Date.now();
    writeToSession(session, echoKeys(keys));
    bump();
    sendJson(res, 200, { ok: true, actionId: `action-${counter}` });
  }

  function orchestratorSummary() {
    const active = data.tasks.filter(task =>
      ['queued', 'routing', 'running', 'waiting-results', 'needs-answer'].includes(task.status)
    ).length;
    const lastMessage = data.messages[data.messages.length - 1];
    return {
      enabled: true,
      ready: true,
      activeCount: active,
      lastMessageAt: lastMessage ? lastMessage.at : null,
    };
  }

  function stateBody() {
    return {
      ok: true,
      revision,
      at: stateAt,
      projects: data.projects.map(project => ({
        id: project.id,
        name: project.name,
        path: project.path,
        counts: countsFor(project.id),
      })),
      sessions: data.sessions.map(publicSession),
      orchestrator: orchestratorSummary(),
    };
  }

  // One session changes status on a timer so long polling visibly wakes up.
  const FLIP_ORDER = ['s-claude', 's-gemini', 's-terminal', 's-qwen'];
  const flipBase = new Map(FLIP_ORDER.map(id => [id, (findSession(id) || {}).status]));
  let flipIndex = 0;
  let flipped = null;

  // Exactly one session ever deviates from its demonstration status, so the
  // list keeps its variety while the revision still moves on every tick.
  function tick() {
    if (flipped) {
      const previous = findSession(flipped);
      const base = flipBase.get(flipped);
      flipped = null;
      if (previous) {
        previous.status = base;
        previous.lastActivityAt = Date.now();
        previous.snippet = `Back to ${STATUS_LABELS[base].toLowerCase()}.`;
      }
      bump();
      return;
    }
    const id = FLIP_ORDER[flipIndex % FLIP_ORDER.length];
    flipIndex += 1;
    const session = findSession(id);
    if (!session) return;
    session.status = 'working';
    session.lastActivityAt = Date.now();
    session.snippet = 'Picked the task back up.';
    flipped = id;
    bump();
  }

  let ticker = null;
  if (tickMs > 0) {
    ticker = setInterval(tick, tickMs);
    if (typeof ticker.unref === 'function') ticker.unref();
  }

  function pairRecord(id) {
    const record = pairRequests.get(id);
    if (!record) return null;
    if (record.status === 'pending' && Date.now() >= record.expiresAt) record.status = 'expired';
    return record;
  }

  function wakePair(id) {
    const pending = pairWaiters.get(id);
    if (!pending) return;
    for (const waiter of Array.from(pending)) waiter.wake();
  }

  function answerPair(id, status) {
    const record = pairRequests.get(id);
    if (!record || record.status !== 'pending') return false;
    record.status = status;
    wakePair(id);
    return true;
  }

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  function acceptsGzip(req) {
    return /(^|,)\s*gzip\s*(;|,|$)/i.test(String(req.headers['accept-encoding'] || ''));
  }

  /**
   * JSON, gzipped when it is worth it and the client said it could take it.
   * `fetch` decodes it on both sides of the app, so nothing above this notices.
   */
  function sendJson(res, status, body) {
    if (res.writableEnded) return;
    cors(res);
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const compress = gzipEnabled && res.linaAcceptsGzip === true && raw.length >= GZIP_MIN_BYTES;
    const payload = compress ? zlib.gzipSync(raw) : raw;
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': payload.length,
      'Cache-Control': 'no-store',
      Vary: 'Accept-Encoding',
    };
    if (compress) headers['Content-Encoding'] = 'gzip';
    res.writeHead(status, headers);
    res.end(payload);
  }

  function sendError(res, status, error) {
    sendJson(res, status, { ok: false, error });
  }

  function authorized(req) {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return false;
    return normalizeCode(match[1]) === code;
  }

  /**
   * The header, or `?code=` for the two routes a browser opens by itself: a
   * WebView navigation and an EventSource can carry neither a header nor a body.
   */
  function authorizedRequest(req, url) {
    if (authorized(req)) return true;
    const query = url.searchParams.get('code');
    return typeof query === 'string' && query.length > 0 && normalizeCode(query) === code;
  }

  const VENDOR_TYPES = {
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
  };

  /**
   * The xterm build, straight off disk, under its own content hash. The hash is
   * the file, so the answer can be cached until the heat death of the phone.
   */
  function sendVendorFile(res, hash, name) {
    const known = xterm && hash === xterm.hash && Object.prototype.hasOwnProperty.call(XTERM_FILES, name);
    if (!known) {
      cors(res);
      res.writeHead(xterm ? 404 : 503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(xterm ? 'not found' : XTERM_MISSING_MESSAGE);
      return;
    }
    let body;
    try {
      body = fs.readFileSync(xterm.files[name]);
    } catch (error) {
      cors(res);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`could not read ${name}: ${error.message}`);
      return;
    }
    cors(res);
    res.writeHead(200, {
      'Content-Type': VENDOR_TYPES[nodePath.extname(name).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(body);
  }

  function sendHtml(res, status, html) {
    cors(res);
    const body = Buffer.from(html, 'utf8');
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  function handleTerminalPage(req, res, url, sessionId) {
    if (!authorizedRequest(req, url)) {
      sendHtml(res, 401, '<!doctype html><meta charset="utf-8"><title>Terminal</title>' +
        '<body style="margin:0;background:#17181c;color:#b8b8b8;font:13px system-ui;padding:18px">' +
        'pairing code did not match');
      return;
    }
    const session = findSession(sessionId);
    if (!session) {
      sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><title>Terminal</title>' +
        '<body style="margin:0;background:#17181c;color:#b8b8b8;font:13px system-ui;padding:18px">' +
        'not found');
      return;
    }
    const stream = streamFor(session);
    const query = `code=${encodeURIComponent(formatCode(code))}`;
    sendHtml(
      res,
      200,
      terminalPageHtml({
        title: session.title,
        sessionId: session.id,
        code: normalizeCode(code),
        control,
        cols: stream.screen.cols,
        rows: stream.screen.rows,
        vendor: vendorUrls,
        streamUrl: `/api/sessions/${encodeURIComponent(session.id)}/stream?${query}`,
        keysUrl: `/api/sessions/${encodeURIComponent(session.id)}/keys`,
        assetsError: xterm ? null : XTERM_MISSING_MESSAGE,
      })
    );
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          reject(Object.assign(new Error('too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(Object.assign(new Error('body is not JSON'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  function handleState(req, res, url) {
    const revisionParam = Number.parseInt(url.searchParams.get('revision') || '0', 10);
    const clientRevision = Number.isFinite(revisionParam) ? revisionParam : 0;
    const waitParam = Number.parseInt(url.searchParams.get('wait') || '0', 10);
    const wait = Math.max(0, Math.min(MAX_WAIT_MS, Number.isFinite(waitParam) ? waitParam : 0));

    if (clientRevision !== revision || wait === 0) {
      sendJson(res, 200, stateBody());
      return;
    }

    let settled = false;
    const waiter = {
      wake() {
        finish();
      },
    };
    const timer = setTimeout(finish, wait);
    if (typeof timer.unref === 'function') timer.unref();
    waiters.add(waiter);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(waiter);
      sendJson(res, 200, stateBody());
    }

    res.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(waiter);
    });
  }

  /** One page of the conversation, newest last, oldest page reachable. */
  function handleTranscript(res, url, session) {
    const all = session.transcriptStatus === 'found' ? session.transcript : [];
    const limitParam = Number.parseInt(url.searchParams.get('limit') || '', 10);
    const limit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(MAX_TRANSCRIPT_LIMIT, limitParam))
      : TRANSCRIPT_LIMIT;
    const beforeParam = Number.parseInt(url.searchParams.get('before') || '', 10);
    const end = Number.isFinite(beforeParam)
      ? Math.max(0, Math.min(all.length, beforeParam))
      : all.length;
    const start = Math.max(0, end - limit);
    sendJson(res, 200, {
      ok: true,
      status: session.transcriptStatus,
      messages: all.slice(start, end),
      total: all.length,
      nextBefore: start > 0 ? start : null,
    });
  }

  async function handleInput(req, res, session) {
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return;
    }
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) {
      sendError(res, 400, 'text is required');
      return;
    }
    if (text.length > MAX_INPUT_CHARS) {
      sendError(res, 413, `text is longer than ${MAX_INPUT_CHARS} characters`);
      return;
    }
    if (session.status === 'exited') {
      sendError(res, 409, 'that terminal has exited');
      return;
    }

    counter += 1;
    const actionId = `action-${counter}`;
    writeToSession(session, `\n> ${text}\n`);
    session.transcript = session.transcript.concat([{ role: 'user', text }]);
    if (session.transcriptStatus === 'unavailable') session.transcriptStatus = 'found';
    session.status = 'working';
    session.attention = false;
    session.needsInput = null;
    session.snippet = text;
    session.lastActivityAt = Date.now();
    bump();

    if (replyMs > 0) {
      later(() => {
        const reply = `Understood: "${text}". Working on it.`;
        session.transcript = session.transcript.concat([{ role: 'assistant', text: reply }]);
        writeToSession(session, `${reply}\n`);
        session.status = 'done';
        session.snippet = reply;
        session.lastActivityAt = Date.now();
        bump();
      }, replyMs);
    }

    sendJson(res, 200, { ok: true, actionId });
  }

  function handleInterrupt(res, session) {
    counter += 1;
    writeToSession(session, '^C\n');
    session.status = 'waiting';
    session.snippet = 'Interrupted.';
    session.lastActivityAt = Date.now();
    bump();
    sendJson(res, 200, { ok: true, actionId: `action-${counter}` });
  }

  async function handleOrchestratorRequest(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return;
    }
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) {
      sendError(res, 400, 'text is required');
      return;
    }

    counter += 1;
    const requestId = `req-mock-${counter}`;
    const at = Date.now();
    const projectPath = typeof body.projectPath === 'string' ? body.projectPath : null;
    const project =
      data.projects.find(entry => entry.path === projectPath) ||
      data.projects.find(entry => entry.id === 'p-vibe');
    const terminal = data.sessions.find(
      session => session.projectId === project.id && session.status !== 'exited'
    );

    data.messages.push({
      id: `m-mock-${counter}`,
      role: 'user',
      text,
      at,
      requestId,
      taskId: null,
      status: null,
      targetId: null,
    });

    const task = {
      id: `t-mock-${counter}`,
      requestId,
      text,
      status: 'queued',
      terminalId: terminal ? terminal.id : null,
      projectId: project.id,
      cwd: project.path,
      createdAt: at,
      updatedAt: at,
      result: null,
      error: null,
      summary: null,
    };
    data.tasks.push(task);
    bump();

    if (requestFinishMs > 0) {
      later(() => {
        task.status = 'finished';
        task.updatedAt = Date.now();
        task.result = terminal
          ? `Handed to ${terminal.title} and finished.`
          : 'Finished without needing a terminal.';
        data.messages.push({
          id: `m-mock-${counter}-reply`,
          role: 'assistant',
          text: `Done: ${text}`,
          at: Date.now(),
          requestId,
          taskId: task.id,
          status: 'finished',
          targetId: task.terminalId,
        });
        bump();
      }, requestFinishMs);
    }

    sendJson(res, 200, { ok: true, requestId, status: 'queued' });
  }

  async function handlePairRequest(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return;
    }

    const pending = Array.from(pairRequests.keys()).filter(id => {
      const record = pairRecord(id);
      return record && record.status === 'pending';
    });
    if (pending.length >= 3) {
      sendError(res, 429, 'too many pairing requests are already waiting');
      return;
    }

    counter += 1;
    const requestId = `pair-${counter}`;
    const expiresAt = Date.now() + pairExpiryMs;
    pairRequests.set(requestId, {
      status: 'pending',
      expiresAt,
      delivered: false,
      deviceName: typeof body.deviceName === 'string' ? body.deviceName : 'Phone',
      platform: typeof body.platform === 'string' ? body.platform : 'unknown',
    });

    if (pairMode === 'manual') {
      process.stdout.write(`PAIR ${requestId}` + '\n');
    } else if (pairAnswerMs >= 0) {
      later(() => answerPair(requestId, pairMode === 'deny' ? 'denied' : 'approved'), pairAnswerMs);
    }
    // A request nobody answers still has to stop being pending.
    later(() => wakePair(requestId), pairExpiryMs + 5);

    sendJson(res, 200, { ok: true, requestId, expiresAt });
  }

  function handlePairStatus(req, res, url, requestId) {
    const record = pairRecord(requestId);
    if (!record) {
      sendError(res, 404, 'not found');
      return;
    }

    const waitParam = Number.parseInt(url.searchParams.get('wait') || '0', 10);
    const wait = Math.max(0, Math.min(MAX_WAIT_MS, Number.isFinite(waitParam) ? waitParam : 0));

    const reply = () => {
      const current = pairRecord(requestId);
      const body = { ok: true, status: current.status };
      // The code is handed over once: on the poll that reports the approval.
      if (current.status === 'approved' && !current.delivered) {
        current.delivered = true;
        body.code = formatCode(code);
      }
      sendJson(res, 200, body);
    };

    if (record.status !== 'pending' || wait === 0) {
      reply();
      return;
    }

    let settled = false;
    const waiter = { wake: () => finish() };
    const timer = setTimeout(finish, wait);
    if (typeof timer.unref === 'function') timer.unref();
    if (!pairWaiters.has(requestId)) pairWaiters.set(requestId, new Set());
    pairWaiters.get(requestId).add(waiter);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const pending = pairWaiters.get(requestId);
      if (pending) pending.delete(waiter);
      reply();
    }

    res.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const pending = pairWaiters.get(requestId);
      if (pending) pending.delete(waiter);
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    res.linaAcceptsGzip = acceptsGzip(req);

    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Discovery and pairing carry no code: they are how a phone earns one.
    if (req.method === 'GET' && path === '/api/discover') {
      sendJson(res, 200, {
        ok: true,
        app: 'lina-terminal',
        host: desktopHost,
        version,
        bridge: 1,
        readOnly,
        desktopId,
      });
      return;
    }

    if (req.method === 'POST' && path === '/api/pair') {
      void handlePairRequest(req, res);
      return;
    }

    const pairStatusMatch = /^\/api\/pair\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && pairStatusMatch) {
      handlePairStatus(req, res, url, decodeURIComponent(pairStatusMatch[1]));
      return;
    }

    // The xterm assets the terminal page loads: content-addressed static files,
    // no code, exactly as a browser asks for a subresource of an open page.
    const vendorMatch = /^\/vendor\/([^/]+)\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && vendorMatch) {
      sendVendorFile(res, decodeURIComponent(vendorMatch[1]), decodeURIComponent(vendorMatch[2]));
      return;
    }

    // The live terminal page and its stream carry the code in the query string:
    // neither a WebView navigation nor an EventSource can set a header.
    const terminalMatch = /^\/terminal\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && terminalMatch) {
      handleTerminalPage(req, res, url, decodeURIComponent(terminalMatch[1]));
      return;
    }

    const streamMatch = /^\/api\/sessions\/([^/]+)\/stream$/.exec(path);
    if (req.method === 'GET' && streamMatch) {
      if (!authorizedRequest(req, url)) {
        sendError(res, 401, 'pairing code did not match');
        return;
      }
      const session = findSession(decodeURIComponent(streamMatch[1]));
      if (!session) {
        sendError(res, 404, 'not found');
        return;
      }
      handleStream(req, res, session);
      return;
    }

    // Test hooks standing in for the desktop's own Allow and Deny buttons.
    const mockAnswer = /^\/__mock\/(approve|deny)\/([^/]+)$/.exec(path);
    if (req.method === 'POST' && mockAnswer) {
      const id = decodeURIComponent(mockAnswer[2]);
      if (!pairRecord(id)) {
        sendError(res, 404, 'not found');
        return;
      }
      const changed = answerPair(id, mockAnswer[1] === 'approve' ? 'approved' : 'denied');
      sendJson(res, 200, { ok: true, changed });
      return;
    }

    // Test hooks standing in for a terminal doing something. The demonstration
    // timer moves one status every eight seconds, which is enough to show that
    // long polling wakes but useless for driving a *specific* change: a phone's
    // notification rule is about one terminal starting to ask, or one terminal
    // finishing, on purpose and at a known moment.
    const mockNeeds = /^\/__mock\/needs-input\/([^/]+)$/.exec(path);
    if (req.method === 'POST' && mockNeeds) {
      const session = findSession(decodeURIComponent(mockNeeds[1]));
      if (!session) {
        sendError(res, 404, 'not found');
        return;
      }
      void readBody(req)
        .then(body => {
          session.needsInput = body && body.clear ? null : normalizeMockPrompt(body);
          session.attention = Boolean(session.needsInput);
          session.lastActivityAt = Date.now();
          bump();
          sendJson(res, 200, { ok: true, needsInput: session.needsInput });
        })
        .catch(error => sendError(res, error.status || 400, error.message));
      return;
    }

    const mockStatus = /^\/__mock\/status\/([^/]+)\/([^/]+)$/.exec(path);
    if (req.method === 'POST' && mockStatus) {
      const session = findSession(decodeURIComponent(mockStatus[1]));
      const status = decodeURIComponent(mockStatus[2]);
      if (!session) {
        sendError(res, 404, 'not found');
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(STATUS_LABELS, status)) {
        sendError(res, 400, `unknown status: ${status}`);
        return;
      }
      session.status = status;
      session.statusLabel = STATUS_LABELS[status];
      session.lastActivityAt = Date.now();
      bump();
      sendJson(res, 200, { ok: true, status: session.status });
      return;
    }

    if (!authorized(req)) {
      sendError(res, 401, 'pairing code did not match');
      return;
    }

    if (req.method === 'GET' && path === '/api/hello') {
      sendJson(res, 200, {
        ok: true,
        app: 'lina-terminal',
        version,
        host: desktopHost,
        bridge: 1,
        readOnly,
      });
      return;
    }

    if (req.method === 'GET' && path === '/api/state') {
      handleState(req, res, url);
      return;
    }

    if (req.method === 'GET' && path === '/api/orchestrator/history') {
      const limitParam = Number.parseInt(url.searchParams.get('limit') || '200', 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 200;
      sendJson(res, 200, {
        ok: true,
        enabled: true,
        ready: true,
        messages: data.messages.slice(-limit),
        tasks: data.tasks,
      });
      return;
    }

    if (req.method === 'POST' && path === '/api/orchestrator/request') {
      if (readOnly) {
        sendError(res, 404, 'not found');
        return;
      }
      void handleOrchestratorRequest(req, res);
      return;
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)\/(screen|transcript|input|keys|interrupt)$/.exec(path);
    if (sessionMatch) {
      const session = findSession(decodeURIComponent(sessionMatch[1]));
      if (!session) {
        sendError(res, 404, 'not found');
        return;
      }
      const action = sessionMatch[2];
      if (req.method === 'GET' && action === 'screen') {
        const maxParam = Number.parseInt(url.searchParams.get('maxChars') || '12000', 10);
        const maxChars = Number.isFinite(maxParam) && maxParam > 0 ? maxParam : 12000;
        const full = screenText(streamFor(session).screen);
        sendJson(res, 200, {
          ok: true,
          text: full.length > maxChars ? full.slice(-maxChars) : full,
          exited: session.status === 'exited',
          updatedAt: session.lastActivityAt,
        });
        return;
      }
      if (req.method === 'GET' && action === 'transcript') {
        handleTranscript(res, url, session);
        return;
      }
      if (req.method === 'POST' && action === 'input') {
        if (readOnly) {
          sendError(res, 404, 'not found');
          return;
        }
        void handleInput(req, res, session);
        return;
      }
      if (req.method === 'POST' && action === 'keys') {
        // A read-only desktop does not serve the route at all; one that serves
        // it but has not granted control says so.
        if (readOnly) {
          sendError(res, 404, 'not found');
          return;
        }
        if (!control) {
          sendError(res, 403, 'control not allowed');
          return;
        }
        void handleKeys(req, res, session);
        return;
      }
      if (req.method === 'POST' && action === 'interrupt') {
        if (readOnly) {
          sendError(res, 404, 'not found');
          return;
        }
        handleInterrupt(res, session);
        return;
      }
      sendError(res, 404, 'not found');
      return;
    }

    sendError(res, 404, 'not found');
  });

  function listen(port, hostname) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, hostname, () => {
        server.removeListener('error', reject);
        resolve(server.address());
      });
    });
  }

  function close() {
    closed = true;
    if (ticker) clearInterval(ticker);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const waiter of Array.from(waiters)) waiter.wake();
    waiters.clear();
    for (const set of pairWaiters.values()) for (const waiter of Array.from(set)) waiter.wake();
    pairWaiters.clear();
    // An open event stream never ends by itself, so the server would never close.
    for (const stream of streams.values()) {
      if (stream.ticker) clearInterval(stream.ticker);
      if (stream.timer) clearTimeout(stream.timer);
      stream.ticker = null;
      stream.timer = null;
      for (const listener of Array.from(stream.listeners)) {
        try {
          listener.end();
        } catch {
          /* the socket was already gone */
        }
      }
      stream.listeners.clear();
    }
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    return new Promise(resolve => server.close(() => resolve()));
  }

  return {
    server,
    code,
    readOnly,
    control,
    storm,
    stormSessionId,
    /** Null when xterm could not be found; the page then fails with a reason. */
    xterm,
    vendorUrls,
    desktopId,
    approvePairing: id => answerPair(id, 'approved'),
    denyPairing: id => answerPair(id, 'denied'),
    formattedCode: formatCode(code),
    listen,
    close,
    tick,
    resize: resizeSession,
    /** What one session's stream has cost, and what a naive one would have. */
    streamStats(sessionId) {
      const session = findSession(sessionId);
      if (!session) return null;
      const stream = streamFor(session);
      return {
        sentBytes: stream.sentBytes,
        naiveBytes: stream.naiveBytes,
        frames: stream.frames,
        mutations: stream.mutations,
        seq: stream.seq,
      };
    },
    /** The plain text of one session's screen, for assertions. */
    screenTextOf(sessionId) {
      const session = findSession(sessionId);
      return session ? screenText(streamFor(session).screen) : null;
    },
    get revision() {
      return revision;
    },
    get port() {
      const address = server.address();
      return address && typeof address === 'object' ? address.port : 0;
    },
  };
}

function parseArgs(argv) {
  const args = {
    port: DEFAULT_PORT,
    code: DEFAULT_CODE,
    host: '0.0.0.0',
    readOnly: false,
    control: false,
    storm: false,
    xtermDir: '',
    pairMode: 'auto',
    pairExpiryMs: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port' && argv[index + 1]) {
      args.port = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg.startsWith('--port=')) {
      args.port = Number.parseInt(arg.slice('--port='.length), 10);
    } else if (arg === '--code' && argv[index + 1]) {
      args.code = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--code=')) {
      args.code = arg.slice('--code='.length);
    } else if (arg === '--host' && argv[index + 1]) {
      args.host = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--host=')) {
      args.host = arg.slice('--host='.length);
    } else if (arg === '--read-only' || arg === '--readonly') {
      args.readOnly = true;
    } else if (arg === '--control') {
      args.control = true;
    } else if (arg === '--storm') {
      args.storm = true;
    } else if (arg === '--xterm-dir' && argv[index + 1]) {
      args.xtermDir = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--xterm-dir=')) {
      args.xtermDir = arg.slice('--xterm-dir='.length);
    } else if (arg === '--pair' && argv[index + 1]) {
      args.pairMode = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--pair=')) {
      args.pairMode = arg.slice('--pair='.length);
    } else if (arg === '--pair-expiry' && argv[index + 1]) {
      args.pairExpiryMs = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg.startsWith('--pair-expiry=')) {
      args.pairExpiryMs = Number.parseInt(arg.slice('--pair-expiry='.length), 10);
    }
  }
  if (!Number.isFinite(args.port) || args.port < 0 || args.port > 65535) args.port = DEFAULT_PORT;
  if (!['auto', 'deny', 'manual'].includes(args.pairMode)) args.pairMode = 'auto';
  if (!Number.isFinite(args.pairExpiryMs) || args.pairExpiryMs <= 0) args.pairExpiryMs = undefined;
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bridge = createMockBridge({
    code: args.code,
    readOnly: args.readOnly,
    control: args.control,
    storm: args.storm,
    xtermDir: args.xtermDir,
    pairMode: args.pairMode,
    pairExpiryMs: args.pairExpiryMs,
  });
  await bridge.listen(args.port, args.host);
  const flags = [
    args.readOnly ? 'read-only' : '',
    bridge.control ? 'control' : 'view-only',
    args.storm ? `storm:${bridge.stormSessionId}` : '',
    args.pairMode === 'auto' ? '' : 'pair:' + args.pairMode,
  ]
    .filter(Boolean)
    .join(' ');
  process.stdout.write(
    `MOCK http://127.0.0.1:${bridge.port} code ${bridge.formattedCode}${flags ? ' ' + flags : ''}\n`
  );
  // The live terminal needs a real xterm; say so loudly rather than serving a
  // page that fails in the phone.
  if (!bridge.xterm) process.stderr.write(`MOCK ${XTERM_MISSING_MESSAGE}\n`);
  const shutdown = () => {
    void bridge.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
}

module.exports = {
  createMockBridge,
  normalizeCode,
  formatCode,
  renderRow,
  resolveXtermAssets,
  // The terminal page's geometry, injected into it verbatim and tested here.
  anchorPan,
  clampPan,
  fitFontSize,
  fitScale,
  DEFAULT_CODE,
  DEFAULT_PORT,
  FRAME_FPS,
  FRAME_INTERVAL_MS,
  MAX_FONT_SIZE,
  SCROLLBACK_LIMIT,
  STREAM_PROTOCOL,
  TRANSCRIPT_LIMIT,
  XTERM_MISSING_MESSAGE,
};
