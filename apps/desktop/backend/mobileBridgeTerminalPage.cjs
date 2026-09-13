'use strict';
// The phone's terminal view: one self-contained page that renders a desktop
// pane with the desktop's own xterm build, its exact theme and font, fed by the
// bridge's server-sent stream.
//
// It speaks frame protocol v2: the server sends whole rows that changed, as
// self-contained ANSI, and the page paints each one at an absolute position.
// No raw PTY bytes cross the wire, so a TUI repainting thirty times a second
// costs twelve frames of changed rows instead of its whole escape stream.
//
// It observes. This build has no input path at all: `send()` below is a marked
// stub that only logs, there is no route it could post to, and the terminal is
// created with `disableStdin: true`. The page loads nothing but the bridge's own
// /vendor assets and its stream.

// The desktop's per-kind accent (frontend/App.tsx `agentProfiles`), so the
// cursor on the phone is the colour the same pane draws on the desktop.
const ACCENTS = {
  terminal: '#f4cf5a', codex: '#ff9f43', 'open-codex': '#df9e55', 'codex-web': '#ff9f43',
  claude: '#8fd694', 'claude-custom': '#d97757', fusion: '#b98bff', openfusion: '#2ee8be',
  cursor: '#46c2c9', gemini: '#70a8ff', opencode: '#c78bff', kimi: '#1e88e5',
  'kimi-custom': '#8e24aa', qwen: '#6d7cff', grok: '#d8e2ef'
};
// Copied field for field from frontend/components/TerminalPane.tsx so a pane
// looks the same on the phone as it does on the desktop.
const THEME = {
  background: '#17181c', foreground: '#ededf0', cursorAccent: '#101114', selectionBackground: '#2e3138',
  black: '#101211', red: '#ff6b6b', green: '#87d37c', yellow: '#f2c94c', blue: '#70a8ff',
  magenta: '#c78bff', cyan: '#6bd7db', white: '#f2f0e8', brightBlack: '#6a6e78', brightRed: '#ff8585',
  brightGreen: '#9be28e', brightYellow: '#f8d56a', brightBlue: '#9ac3ff', brightMagenta: '#d8a8ff',
  brightCyan: '#91eef2', brightWhite: '#ffffff'
};
const FONT_FAMILY = 'Cascadia Mono, "Cascadia Code", "JetBrains Mono", Consolas, monospace';
const FONT_WEIGHT = 500;
const LINE_HEIGHT = 1.18;
const SCROLLBACK = 5000;
// There is no readable floor any more, only a sane one: the PTY's columns must
// fit the viewport at whatever size that takes, because a phone reads a small
// screen by zooming into it, never by scrolling it sideways.
const MIN_FONT_PX = 1;
const MAX_FONT_PX = 16;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 3;

const escapeHtml = value => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Inlined into a <script>: a literal "</script>" inside a JSON string would end
// the element, and U+2028/9 are newlines to a JavaScript parser.
const LINE_TERMINATORS = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
const json = value => JSON.stringify(value)
  .replace(/</g, '\\u003c').replace(LINE_TERMINATORS, character => '\\u' + character.charCodeAt(0).toString(16));

// `control` is the build's capability, not the page's opinion: the phone app
// enables its key bar from it. It stays false while the bridge exposes no route
// that writes to a terminal, and becomes true only when a real send path exists.
// The vendored assets are addressed by content hash, so a phone caches them
// for a year; the caller passes the current manifest and the page never hard
// codes a path that could go stale.
const DEFAULT_VENDOR = { 'xterm.js': '/vendor/xterm.js', 'xterm.css': '/vendor/xterm.css', 'addon-fit.js': '/vendor/addon-fit.js' };

function terminalPage({ id, code, kind = 'terminal', title = '', cols = 80, rows = 24, exited = false, control = false, vendor = null } = {}) {
  const session = { id: String(id), kind: String(kind || 'terminal'), title: String(title || ''),
    cols: Number(cols) || 80, rows: Number(rows) || 24, exited: exited === true };
  const assets = { ...DEFAULT_VENDOR, ...(vendor || {}) };
  const theme = { ...THEME, cursor: ACCENTS[session.kind] || ACCENTS.terminal };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(session.title || session.id)}</title>
<link rel="stylesheet" href="${escapeHtml(assets['xterm.css'])}">
<style>
  :root { color-scheme: dark; }
  /* Nothing on this page ever scrolls sideways: the font is sized so the PTY's
     columns fit, and a small screen is read by zooming into it. */
  html, body { margin: 0; padding: 0; height: 100%; background: #17181c;
    overflow: hidden; overflow-x: hidden; overscroll-behavior: none; }
  body { display: flex; flex-direction: column; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  #banner { flex: none; display: flex; align-items: center; gap: 8px; padding: 5px 10px;
    font-size: 11px; line-height: 1.3; letter-spacing: .04em; text-transform: uppercase;
    color: #9aa0ac; background: #1c1e24; border-bottom: 1px solid #24262d; }
  #banner .name { text-transform: none; letter-spacing: 0; color: #d6d9e0; font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #banner .state { margin-left: auto; color: #6a6e78; text-transform: none; letter-spacing: 0; }
  /* The pan/zoom window. Nothing escapes it, in either axis. */
  #stage { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden;
    background: #17181c; touch-action: pan-y; }
  #stage.zoomed { touch-action: none; }
  #zoom { position: absolute; inset: 0; transform-origin: 0 0; will-change: transform; }
  #host { position: absolute; inset: 0; overflow: hidden; -webkit-overflow-scrolling: touch; background: #17181c; }
  #host .xterm { padding: 4px 6px; }
  /* Scrollbars are hidden everywhere; the rail below is the only position cue. */
  .xterm-viewport { background-color: #17181c !important; overflow-x: hidden !important;
    scrollbar-width: none; -ms-overflow-style: none; }
  .xterm-viewport::-webkit-scrollbar { display: none; width: 0; height: 0; }
  body::-webkit-scrollbar, #stage::-webkit-scrollbar, #host::-webkit-scrollbar { display: none; width: 0; height: 0; }
  #rail { position: absolute; top: 0; right: 0; bottom: 0; width: 2px; pointer-events: none;
    opacity: 0; transition: opacity .18s ease; }
  #rail.on { opacity: 1; }
  #rail b { position: absolute; left: 0; width: 2px; border-radius: 1px; background: #6a6e78; display: block; }
</style>
</head>
<body>
  <div id="banner"><span>View only</span><span class="name" id="name"></span><span class="state" id="state"></span></div>
  <div id="stage">
    <div id="zoom"><div id="host"></div></div>
    <div id="rail"><b></b></div>
  </div>
  <!-- The vendored xterm build, addressed by content hash so it is cached for
       a year. No credential: it carries no workspace data, and a <script>
       could not send a header for it anyway. -->
  <script src="${escapeHtml(assets['xterm.js'])}"></script>
  <script src="${escapeHtml(assets['addon-fit.js'])}"></script>
  <script>
  (function () {
    'use strict';
    var SESSION = ${json(session)};
    var CODE = ${json(String(code))};
    var THEME = ${json(theme)};
    var MIN_FONT = ${MIN_FONT_PX}, MAX_FONT = ${MAX_FONT_PX};
    var MIN_ZOOM = ${MIN_ZOOM}, MAX_ZOOM = ${MAX_ZOOM};
    // Stamped by the server, not decided here: the phone app enables its key
    // bar from READY.control, and this build has no route it could write to.
    var READY = ${json({ type: 'ready', control: control === true })};
    var host = document.getElementById('host');
    var stage = document.getElementById('stage');
    var zoomEl = document.getElementById('zoom');
    var rail = document.getElementById('rail');
    var thumb = rail.firstElementChild;
    var stateEl = document.getElementById('state');
    var nameEl = document.getElementById('name');
    nameEl.textContent = SESSION.title || SESSION.id;
    function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }

    function post(message) {
      try {
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          window.ReactNativeWebView.postMessage(JSON.stringify(message));
        }
      } catch (error) { /* the host bridge is optional */ }
    }
    function setState(label) { stateEl.textContent = label || ''; }

    var term = new Terminal({
      // PTY bytes are rendered raw, exactly as the desktop pane renders them.
      convertEol: false,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: ${json(FONT_FAMILY)},
      fontSize: MAX_FONT,
      fontWeight: ${FONT_WEIGHT},
      lineHeight: ${LINE_HEIGHT},
      letterSpacing: 0,
      scrollback: ${SCROLLBACK},
      theme: THEME
    });
    var fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);

    var cols = SESSION.cols, rows = SESSION.rows;
    // The PTY's geometry is authoritative: the phone never resizes the pane, it
    // shrinks the glyphs until the PTY's columns fit the viewport. Below the
    // floor the columns stay and the container scrolls sideways instead.
    // Cell width per pixel of font size. It is a property of the font, not of
    // the layout, so it is measured once against the same stack xterm renders
    // with: reading the drawn screen instead would lag a font-size change by a
    // layout pass and settle one size too small.
    var advance = 0;
    function advancePerPixel() {
      if (advance) return advance;
      var probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;' +
        'letter-spacing:0;font-weight:${FONT_WEIGHT};font-size:100px;font-family:' + ${json(FONT_FAMILY)};
      probe.textContent = new Array(101).join('W');
      document.body.appendChild(probe);
      var measured = probe.getBoundingClientRect().width;
      probe.parentNode.removeChild(probe);
      if (measured > 0) advance = measured / 100 / 100;
      if (!advance) {
        // No usable font metrics yet: fall back to what the fit addon can see.
        var proposed = fitAddon.proposeDimensions();
        var size = term.options.fontSize || MAX_FONT;
        if (proposed && proposed.cols) return (host.clientWidth / proposed.cols) / size;
      }
      return advance;
    }
    function deriveFontSize() {
      // The .xterm padding this page sets, plus a pixel so rounding cannot
      // widen the drawn screen past the viewport. There is no readable floor:
      // the columns fit at whatever size that takes, and the reader zooms.
      var available = host.clientWidth - 13;
      var perPixel = advancePerPixel();
      if (available <= 0 || !cols || !perPixel) return;
      var exact = available / (cols * perPixel);
      term.options.fontSize = clamp(Math.floor(exact * 100) / 100, MIN_FONT, MAX_FONT);
    }
    // The measured advance is a prediction; this is the proof. Shrink until the
    // screen xterm actually drew is inside the viewport, so no width can ever
    // produce a horizontal scroll. offsetWidth, not the rect: the rect carries
    // the zoom transform.
    function fitWidth() {
      var screenEl = host.querySelector('.xterm-screen');
      if (!screenEl) return;
      var limit = host.clientWidth - 12;
      for (var guard = 0; guard < 8 && screenEl.offsetWidth > limit && limit > 0; guard++) {
        var current = term.options.fontSize;
        var next = Math.floor(current * (limit / screenEl.offsetWidth) * 100) / 100;
        if (!(next < current)) next = current - 0.05;
        next = clamp(next, MIN_FONT, MAX_FONT);
        if (next >= current) break;
        term.options.fontSize = next;
      }
    }
    function applyGeometry() {
      deriveFontSize();
      try { term.resize(cols, rows); } catch (error) { /* a transient zero-size layout */ }
      fitWidth();
      applyTransform();
      updateRail();
    }

    // ---- pan and zoom ------------------------------------------------------
    // The whole terminal is scaled and translated as one layer. Nothing here
    // touches the PTY: the pane's geometry is still the desktop's.
    var scale = 1, panX = 0, panY = 0;
    function applyTransform() {
      var width = stage.clientWidth, height = stage.clientHeight;
      // Bounds, so an edge of the content can never leave the viewport.
      panX = clamp(panX, Math.min(0, width - width * scale), 0);
      panY = clamp(panY, Math.min(0, height - height * scale), 0);
      zoomEl.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
      stage.classList.toggle('zoomed', scale !== 1);
    }
    function setScale(next, originX, originY, baseScale, baseX, baseY) {
      var from = baseScale === undefined ? scale : baseScale;
      var fromX = baseX === undefined ? panX : baseX;
      var fromY = baseY === undefined ? panY : baseY;
      scale = clamp(next, MIN_ZOOM, MAX_ZOOM);
      // Programmatic zoom has no fingers to anchor on, so it anchors on the
      // view: the left edge, so column 0 never leaves, and the bottom edge,
      // because a terminal is read from the newest line up. A pinch passes its
      // own midpoint instead.
      if (originX === undefined) { originX = 0; originY = stage.clientHeight; }
      var ratio = scale / from;
      panX = originX - (originX - fromX) * ratio;
      panY = originY - (originY - fromY) * ratio;
      if (scale === 1) { panX = 0; panY = 0; }
      applyTransform();
    }
    function resetZoom() { scale = 1; panX = 0; panY = 0; applyTransform(); }

    var pinch = null, drag = null, lastTap = 0;
    var spread = function (touches) {
      var dx = touches[0].clientX - touches[1].clientX, dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy) || 1;
    };
    var localX = function (touch) { return touch.clientX - stage.getBoundingClientRect().left; };
    var localY = function (touch) { return touch.clientY - stage.getBoundingClientRect().top; };
    stage.addEventListener('touchstart', function (event) {
      if (event.touches.length === 2) {
        pinch = { distance: spread(event.touches), scale: scale, panX: panX, panY: panY,
          x: (localX(event.touches[0]) + localX(event.touches[1])) / 2,
          y: (localY(event.touches[0]) + localY(event.touches[1])) / 2 };
        drag = null;
        event.preventDefault();
        return;
      }
      if (event.touches.length !== 1) return;
      var now = Date.now();
      if (now - lastTap < 300) { resetZoom(); lastTap = 0; event.preventDefault(); return; }
      lastTap = now;
      // Unzoomed, a one-finger drag is xterm's own vertical scroll; leave it be.
      if (scale !== 1) {
        drag = { x: event.touches[0].clientX, y: event.touches[0].clientY, panX: panX, panY: panY };
        event.preventDefault();
      }
    }, { passive: false });
    stage.addEventListener('touchmove', function (event) {
      if (pinch && event.touches.length === 2) {
        setScale(pinch.scale * (spread(event.touches) / pinch.distance), pinch.x, pinch.y,
          pinch.scale, pinch.panX, pinch.panY);
        event.preventDefault();
      } else if (drag && event.touches.length === 1) {
        panX = drag.panX + (event.touches[0].clientX - drag.x);
        panY = drag.panY + (event.touches[0].clientY - drag.y);
        applyTransform();
        event.preventDefault();
      }
    }, { passive: false });
    var endTouch = function (event) { if (!event.touches.length) { pinch = null; drag = null; } };
    stage.addEventListener('touchend', endTouch);
    stage.addEventListener('touchcancel', endTouch);

    // A slim right-edge cue instead of a scrollbar, shown only while the reader
    // is somewhere above the newest output.
    function updateRail() {
      var view = host.querySelector('.xterm-viewport');
      if (!view) return;
      var span = view.scrollHeight - view.clientHeight;
      if (span <= 1 || view.scrollTop >= span - 1) { rail.classList.remove('on'); return; }
      var height = Math.max(18, rail.clientHeight * (view.clientHeight / view.scrollHeight));
      thumb.style.height = height + 'px';
      thumb.style.top = ((rail.clientHeight - height) * (view.scrollTop / span)) + 'px';
      rail.classList.add('on');
    }
    var viewport = host.querySelector('.xterm-viewport');
    if (viewport) viewport.addEventListener('scroll', updateRail, { passive: true });
    try { term.onScroll(updateRail); } catch (error) { /* older builds */ }

    applyGeometry();
    window.addEventListener('resize', applyGeometry);
    window.addEventListener('orientationchange', applyGeometry);

    // ---- frame protocol v2 -------------------------------------------------
    // A row is drawn where the server says it is: home the cursor to that line,
    // write the row's own ANSI, clear whatever was longer. Nothing is inferred
    // from what came before, so a dropped frame costs one stale row until that
    // row next changes, never a corrupted screen.
    function paint(rows, cursor) {
      var out = '\\x1b[?25l';
      for (var index = 0; index < rows.length; index++) {
        out += '\\x1b[' + (rows[index][0] + 1) + ';1H' + rows[index][1] + '\\x1b[K';
      }
      if (cursor) {
        out += '\\x1b[' + (cursor.y + 1) + ';' + (cursor.x + 1) + 'H';
        if (cursor.visible !== false) out += '\\x1b[?25h';
      }
      term.write(out);
    }
    // The lines above the viewport, written once so the phone can scroll back
    // through them. The trailing blank screen pushes every one of them out of
    // the viewport, which the next screen event owns in full.
    function paintScrollback(lines) {
      term.reset();
      var out = '';
      for (var index = 0; index < lines.length; index++) out += lines[index] + '\\r\\n';
      for (var blank = 1; blank < rows; blank++) out += '\\r\\n';
      if (out) term.write(out);
    }

    // STUB, intentionally inert. This build ships no write path: the bridge has
    // no input endpoint and this page must never appear to have one. It is here
    // only so the phone app can be wired against a stable name later.
    function send(data) {
      console.log('[lina] view only: input is not implemented in this build', data);
      return false;
    }

    window.linaTerminal = {
      focus: function () { try { term.focus(); } catch (error) { /* detached */ } },
      fit: applyGeometry,
      scrollToBottom: function () { try { term.scrollToBottom(); } catch (error) { /* detached */ } },
      // Relative, so a host key or button can step the zoom the way a pinch does.
      zoom: function (delta) { setScale(scale + (Number(delta) || 0)); return scale; },
      resetZoom: resetZoom,
      send: send
    };

    var source = null, lastSeq = 0, backoff = 500, ready = false, closed = false;
    function schedule() {
      if (closed) return;
      var delay = backoff;
      backoff = Math.min(backoff * 2, 15000);
      setState('reconnecting');
      setTimeout(connect, delay);
    }
    function connect() {
      if (closed) return;
      if (source) { try { source.close(); } catch (error) { /* already gone */ } source = null; }
      // No resume cursor: a reconnect is answered with the scrollback and a
      // whole screen, which is smaller than the byte replay it replaced.
      var url = '/api/sessions/' + encodeURIComponent(SESSION.id) + '/stream?code=' + encodeURIComponent(CODE);
      var stream = new EventSource(url);
      source = stream;
      stream.addEventListener('open', function () { backoff = 500; setState(''); });
      stream.addEventListener('hello', function (event) {
        var payload = JSON.parse(event.data);
        if (payload.cols) cols = payload.cols;
        if (payload.rows) rows = payload.rows;
        lastSeq = payload.seq || 0;
        applyGeometry();
        setState(payload.exited ? 'exited' : '');
      });
      stream.addEventListener('scrollback', function (event) {
        var payload = JSON.parse(event.data);
        paintScrollback(payload.lines || []);
      });
      stream.addEventListener('screen', function (event) {
        var payload = JSON.parse(event.data);
        if (payload.seq) lastSeq = payload.seq;
        paint(payload.rows || [], payload.cursor);
        term.scrollToBottom();
        updateRail();
        if (!ready) {
          ready = true;
          post({ type: READY.type, control: READY.control, id: SESSION.id, cols: cols, rows: rows });
        }
      });
      stream.addEventListener('frame', function (event) {
        var payload = JSON.parse(event.data);
        if (payload.seq) lastSeq = payload.seq;
        paint(payload.rows || [], payload.cursor);
      });
      stream.addEventListener('resize', function (event) {
        var payload = JSON.parse(event.data);
        if (payload.cols) cols = payload.cols;
        if (payload.rows) rows = payload.rows;
        applyGeometry();
      });
      stream.addEventListener('exit', function () {
        setState('exited');
        post({ type: 'exit', id: SESSION.id });
      });
      stream.onerror = function () {
        if (stream.readyState === 2 || !closed) {
          try { stream.close(); } catch (error) { /* already gone */ }
          if (source === stream) source = null;
          post({ type: 'error', id: SESSION.id, error: 'stream disconnected' });
          schedule();
        }
      };
    }
    connect();
    window.addEventListener('pagehide', function () {
      closed = true;
      if (source) { try { source.close(); } catch (error) { /* already gone */ } }
    });
  })();
  </script>
</body>
</html>
`;
}

module.exports = { terminalPage, ACCENTS, THEME, FONT_FAMILY, MIN_FONT_PX, MAX_FONT_PX,
  MIN_ZOOM, MAX_ZOOM, SCROLLBACK, DEFAULT_VENDOR };
