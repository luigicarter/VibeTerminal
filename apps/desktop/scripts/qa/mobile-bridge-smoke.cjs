'use strict';
// End-to-end check of the read-only mobile bridge against a real Electron run:
// an isolated profile, one live shell pane in a project, then every route of
// API contract v1 exercised over the loopback listener. Nothing here writes to
// a terminal; the last check proves the reserved write route is absent.
//
//   node scripts/qa/mobile-bridge-smoke.cjs [--hold=<seconds>]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const PORT = 47999;
const CODE = 'MBRD-GE23-4567-89AB';
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: `Bearer ${CODE.replace(/-/g, '')}` };
const hold = Number((process.argv.find(argument => argument.startsWith('--hold=')) || '').split('=')[1]) || 0;
const output = path.join(root, '.tmp', 'mobile-bridge-smoke', `${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
function pass(name, detail) { console.log(`PASS ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); }
function fail(name, error) { failures++; console.error(`FAIL ${name} ${error && error.message ? error.message : error}`); }
async function check(name, fn) {
  try { pass(name, await fn()); } catch (error) { fail(name, error); }
}
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await sleep(200); }
  throw new Error(`Timeout: ${label} ${last || ''}`);
}
const api = (route, init = {}) => fetch(`${BASE}${route}`, { headers: AUTH, ...init });
// The discovery and pairing routes answer before any credential exists.
const open = (route, init = {}) => fetch(`${BASE}${route}`, init);
const offerPair = (deviceName, platform) => open('/api/pair', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceName, platform }) }).then(r => r.json());

// A raw socket, not fetch: undici inflates `Content-Encoding` transparently and
// would hide the only number worth measuring here — what actually went over the
// wire. Everything the phone would draw is parsed from the inflated copy.
function rawStream(route, headers = {}) {
  const state = { events: [], comments: 0, compressed: 0, plainBytes: 0, done: false, at: Date.now() };
  state.request = http.request(`${BASE}${route}`, { headers });
  state.opened = new Promise((resolve, reject) => {
    state.request.on('error', reject);
    state.request.on('response', response => {
      state.status = response.statusCode;
      state.headers = response.headers;
      response.on('data', chunk => { state.compressed += chunk.length; });
      const sink = response.headers['content-encoding'] === 'gzip' ? zlib.createGunzip() : response;
      if (sink !== response) response.pipe(sink);
      let buffer = '';
      sink.on('data', chunk => {
        state.plainBytes += chunk.length;
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (frame.startsWith(':')) { state.comments++; continue; }
          const type = /^event: (.+)$/m.exec(frame);
          const data = /^data: (.*)$/m.exec(frame);
          if (type) state.events.push({ type: type[1], payload: data ? JSON.parse(data[1]) : null, at: Date.now() });
        }
      });
      sink.on('end', () => { state.done = true; });
      resolve(state);
    });
    state.request.end();
  });
  return state;
}
const frameCount = stream => stream.events.filter(event => event.type === 'frame' || event.type === 'screen').length;
// The plain text of a row, so a check reads as the screen a person would see.
const plainRow = row => String(row).replace(/\x1b\[[0-9;]*m/g, '');

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.n = 0; this.pending = new Map(); }
  async open() {
    await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); });
    this.ws.addEventListener('message', event => { const message = JSON.parse(String(event.data)); const waiter = this.pending.get(message.id); if (waiter) { this.pending.delete(message.id); clearTimeout(waiter.timer); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); } });
  }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.n, timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
}

let child, cdp;
(async () => {
  try {
    const project = path.join(output, 'project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'readme.txt'), 'mobile bridge smoke\n');

    const env = { ...process.env,
      VIBE_SCREENSHOT_MODE: '1', VIBE_SCREENSHOT_HIDDEN: '1', VIBE_INTERNAL_SCREENSHOT: '0',
      VIBE_SCREENSHOT_USER_DATA: path.join(output, 'userData'), VIBE_AGENT_SHIM_BASE_DIR: path.join(output, 'shims'),
      CODEX_HOME: path.join(output, 'codex'), CLAUDE_CONFIG_DIR: path.join(output, 'claude'),
      GEMINI_CLI_HOME: path.join(output, 'gemini'), QWEN_HOME: path.join(output, 'qwen'), KIMI_CODE_HOME: path.join(output, 'kimi'),
      XDG_CONFIG_HOME: path.join(output, 'xdg-config'), XDG_DATA_HOME: path.join(output, 'xdg-data'),
      LINA_MOBILE_BRIDGE_ENABLED: '1', LINA_MOBILE_BRIDGE_PORT: String(PORT),
      LINA_MOBILE_BRIDGE_CODE: CODE, LINA_MOBILE_BRIDGE_HOST: '127.0.0.1',
      // Fixture only: this run approves pair requests without a human so the
      // discovery flow can be exercised end to end. Phase 2 below runs without it.
      LINA_MOBILE_BRIDGE_AUTO_APPROVE: '1' };
    delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;

    const debugPort = 47998;
    child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${debugPort}`, '--disable-renderer-backgrounding'],
      { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(path.join(output, 'electron.log'));
    child.stdout.pipe(log); child.stderr.pipe(log);

    const page = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json())
      .find(target => target.type === 'page' && target.url.startsWith('file:') && !target.url.includes('surface=voice')), 'renderer');
    cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.open(); await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(() => cdp.eval('Boolean(window.vibe?.terminal)'), 'preload');

    // One project holding one live plain shell, seeded the way the board smokes do.
    const sessions = [{ id: 'phone-shell', name: 'phone-shell', kind: 'terminal', command: '', cwd: project,
      createdAt: Date.now(), started: true, nextLaunchMode: 'new', launchToken: 1, status: 'idle',
      layout: { x: 0, y: 10, w: 60, h: 320, unit: 'fluid' } }];
    const workspaces = [{ id: 'phone', name: 'Phone QA', path: project, sessions }];
    await cdp.eval(`(async()=>{localStorage.setItem('vibe-terminal:workspaces:v2',${JSON.stringify(JSON.stringify(workspaces))});localStorage.setItem('vibe-terminal:active-workspace:v1','phone');localStorage.setItem('vibe-terminal:active-view:v1','project');await ${require('./workspace-fixture.cjs').checkpointFromStorage};location.reload();})()`);
    await until(() => cdp.eval(`document.querySelector('[data-session-id="phone-shell"] .xterm-rows')?.textContent.length>0`), 'live shell');
    // Print a line the phone can recognise in the screen text.
    await cdp.eval(`(async()=>{const s=(await window.vibe.terminal.getRuntimeSnapshots()).find(s=>s.id==='phone-shell');window.vibe.terminal.input('phone-shell','echo LINA-BRIDGE-OK\\r',{generation:s.generation,launchToken:s.launchToken});})()`);
    await until(() => cdp.eval(`document.querySelector('[data-session-id="phone-shell"] .xterm-rows')?.textContent.includes('LINA-BRIDGE-OK')`), 'echo output');

    await until(async () => (await api('/api/hello')).ok, 'bridge listening');

    await check('discover-without-a-code', async () => {
      const response = await open('/api/discover');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-lina-bridge'), '1');
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.app, 'lina-terminal');
      assert.equal(body.readOnly, true);
      assert.match(body.desktopId, /^[0-9a-f]{16}$/);
      assert(body.host, 'the desktop names itself');
      // Discovery must say nothing about the workspace it guards.
      for (const leak of ['phone-shell', 'LINA-BRIDGE', 'project']) {
        assert(!JSON.stringify(body).includes(leak), `discover leaked ${leak}`);
      }
      return { host: body.host, desktopId: body.desktopId, readOnly: body.readOnly };
    });

    await check('pair-then-approved-poll-delivers-the-code', async () => {
      const created = await offerPair('Smoke iPhone', 'ios');
      assert.equal(created.ok, true);
      assert(created.requestId, 'a request id is issued');
      assert(created.expiresAt > Date.now(), 'the offer has a deadline');
      const approved = await (await open(`/api/pair/${created.requestId}?wait=15000`)).json();
      assert.equal(approved.status, 'approved', `expected approval, got ${JSON.stringify(approved)}`);
      assert.match(approved.code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
      // The delivered code is the real credential.
      const hello = await fetch(`${BASE}/api/hello`, { headers: { Authorization: `Bearer ${approved.code.replace(/-/g, '')}` } });
      assert.equal(hello.status, 200, 'the paired code opens the bridge');
      assert.equal((await hello.json()).readOnly, true);
      // Spent on delivery.
      assert.equal((await open(`/api/pair/${created.requestId}`)).status, 404, 'the offer is consumed');
      return { requestId: created.requestId.slice(0, 8) + '…', status: approved.status, codeOpensBridge: true };
    });

    await check('hello-read-only', async () => {
      const response = await api('/api/hello');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-lina-bridge'), '1');
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.app, 'lina-terminal');
      assert.equal(body.readOnly, true);
      assert.equal(body.version, require(path.join(root, 'package.json')).version);
      assert(body.host, 'a hostname is reported');
      return { version: body.version, host: body.host, readOnly: body.readOnly };
    });

    await check('unauthorized-without-code', async () => {
      const response = await fetch(`${BASE}/api/state`);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { ok: false, error: 'unauthorized' });
      return { status: 401 };
    });

    let session;
    await check('state-lists-project-and-terminal', async () => {
      const body = await until(async () => {
        const value = await (await api('/api/state')).json();
        return value.ok && value.projects.length && value.sessions.some(item => item.kind === 'terminal') ? value : null;
      }, 'state inventory');
      assert(body.projects.length >= 1, 'at least one project');
      assert.equal(body.projects[0].path, project);
      session = body.sessions.find(item => item.kind === 'terminal');
      assert(session, 'a terminal session is listed');
      assert.equal(session.projectId, body.projects[0].id);
      assert.equal(session.isChat, false);
      assert(typeof session.statusLabel === 'string');
      assert(Number.isInteger(body.revision) && body.revision > 0);
      return { revision: body.revision, projects: body.projects.length, session: { id: session.id, kind: session.kind, status: session.status, title: session.title, snippet: session.snippet } };
    });

    await check('screen-text-is-live', async () => {
      const body = await (await api(`/api/sessions/${encodeURIComponent(session.id)}/screen`)).json();
      assert.equal(body.ok, true);
      assert(body.text.length > 0, 'screen text is not empty');
      assert(body.text.includes('LINA-BRIDGE-OK'), 'the echoed line is visible');
      assert(!body.text.includes(''), 'ANSI escapes are stripped');
      assert.equal(body.exited, false);
      return { chars: body.text.length, exited: body.exited, tail: body.text.trim().split('\n').at(-1) };
    });

    const streamRoute = `/api/sessions/${encodeURIComponent(session.id)}/stream?code=${CODE.replace(/-/g, '')}`;
    await check('terminal-stream-frame-protocol-v2', async () => {
      const stream = rawStream(streamRoute, { 'Accept-Encoding': 'gzip' });
      try {
        await stream.opened;
        assert.equal(stream.status, 200);
        assert.match(stream.headers['content-type'], /text\/event-stream/);
        assert.equal(stream.headers['content-encoding'], 'gzip', 'the live stream is compressed');
        assert.equal(stream.headers.vary, 'Accept-Encoding');

        const screen = await until(() => stream.events.find(event => event.type === 'screen'), 'the opening screen');
        const hello = stream.events.find(event => event.type === 'hello');
        assert.equal(hello.payload.protocol, 2, 'the stream announces frame protocol v2');
        assert(hello.payload.cols > 0 && hello.payload.rows > 0, 'hello carries the PTY geometry');
        assert.equal(hello.payload.control, false, 'no write path exists to enable a key bar for');
        assert.equal(stream.events[1].type, 'scrollback', 'the lines above the viewport come first');
        assert(Array.isArray(stream.events[1].payload.lines), 'scrollback is a list of rows');
        assert.equal(screen.payload.rows.length, hello.payload.rows, 'the opening screen is the whole viewport');
        for (const [index, row] of screen.payload.rows) {
          assert(Number.isInteger(index) && index >= 0, 'a row carries its index');
          assert(row.endsWith('\x1b[0m'), `a row ends at the default style: ${JSON.stringify(row)}`);
        }
        const drawn = [...stream.events[1].payload.lines, ...screen.payload.rows.map(row => row[1])].map(plainRow).join('\n');
        assert(drawn.includes('LINA-BRIDGE-OK'), 'the opening frames carry what the pane already printed');
        assert.deepEqual(Object.keys(screen.payload.cursor).sort(), ['visible', 'x', 'y']);

        // A fresh line, typed the same way every other check types one: through
        // the renderer's own input path. The bridge has no write route at all.
        const before = frameCount(stream);
        await cdp.eval(`(async()=>{const s=(await window.vibe.terminal.getRuntimeSnapshots()).find(s=>s.id==='phone-shell');window.vibe.terminal.input('phone-shell','echo LINA-STREAM-LIVE\\r',{generation:s.generation,launchToken:s.launchToken});})()`);
        const live = await until(() => stream.events.filter(event => event.type === 'frame')
          .find(event => event.payload.rows.some(row => plainRow(row[1]).includes('LINA-STREAM-LIVE'))), 'the live line as a changed row');
        assert(live.payload.rows.length < hello.payload.rows, 'one echoed line does not redraw the screen');
        assert(live.payload.seq > screen.payload.seq, 'frames carry a rising state number');
        return { protocol: hello.payload.protocol, cols: hello.payload.cols, rows: hello.payload.rows,
          scrollback: stream.events[1].payload.lines.length, framesForOneLine: frameCount(stream) - before,
          changedRows: live.payload.rows.length };
      } finally { try { stream.request.destroy(); } catch {} }
    });

    // The point of the whole protocol, measured: a pane repainting thirty lines
    // thirty times a second, and what the phone is actually charged for it.
    await check('storm-bytes', async () => {
      const stream = rawStream(streamRoute, { 'Accept-Encoding': 'gzip' });
      try {
        await stream.opened;
        await until(() => stream.events.some(event => event.type === 'screen'), 'the opening screen');
        await sleep(400);
        const metricsRoute = `/api/sessions/${encodeURIComponent(session.id)}/metrics`;
        const before = await (await api(metricsRoute)).json();
        const baselineSent = stream.compressed;
        const baselineFrames = frameCount(stream);

        // The redraw storm, driven the only way this smoke drives a shell:
        // through the renderer's own input path. No bridge route writes.
        // A sentinel rather than the last tick: the loop repaints faster than
        // this poll, so waiting for a tick number races the screen it is on.
        const storm = '1..120 | % { $i=$_; Clear-Host; 1..30 | % { "line $_ tick $i" }; Start-Sleep -Milliseconds 33 }; "LINA-STORM-DONE"';
        const startedAt = Date.now();
        await cdp.eval(`(async()=>{const s=(await window.vibe.terminal.getRuntimeSnapshots()).find(s=>s.id==='phone-shell');window.vibe.terminal.input('phone-shell',${JSON.stringify(storm + '\r')},{generation:s.generation,launchToken:s.launchToken});})()`);
        await until(async () => (await (await api(`/api/sessions/${encodeURIComponent(session.id)}/screen`)).json()).text.includes('LINA-STORM-DONE'),
          'the storm to finish', 90000);
        await sleep(500);
        const seconds = (Date.now() - startedAt) / 1000;

        const after = await (await api(metricsRoute)).json();
        const raw = after.rawBytes - before.rawBytes;
        const sent = stream.compressed - baselineSent;
        const frames = frameCount(stream) - baselineFrames;
        const ratio = Number((raw / Math.max(1, sent)).toFixed(2));
        const fps = Number((frames / seconds).toFixed(2));
        assert(raw > 20000, `the fixture really did storm the pane (${raw} raw bytes)`);
        assert(ratio >= 5, `the phone must pay at most a fifth of the PTY bytes: ratio ${ratio} (raw ${raw}, sent ${sent})`);
        assert(fps <= 13, `frames are capped at twelve a second: ${fps}`);
        return { raw, sent, ratio, fps, frames, seconds: Number(seconds.toFixed(2)),
          uncompressed: stream.plainBytes, rawChunks: after.rawChunks - before.rawChunks };
      } finally { try { stream.request.destroy(); } catch {} }
    });

    await check('idle-stream-bytes', async () => {
      const stream = rawStream(streamRoute, { 'Accept-Encoding': 'gzip' });
      try {
        await stream.opened;
        await until(() => stream.events.some(event => event.type === 'screen'), 'the opening screen');
        await sleep(500);
        const baseline = stream.compressed;
        const frames = frameCount(stream);
        await sleep(20000);
        const idle = stream.compressed - baseline;
        assert.equal(frameCount(stream) - frames, 0, 'an idle pane produces no frames at all');
        assert(idle < 4096, `twenty idle seconds cost keepalives only: ${idle} bytes`);
        return { seconds: 20, bytes: idle, keepalives: stream.comments, frames: 0 };
      } finally { try { stream.request.destroy(); } catch {} }
    });

    await check('terminal-page-and-vendor-assets', async () => {
      const code = CODE.replace(/-/g, '');
      const page = await fetch(`${BASE}/terminal/${encodeURIComponent(session.id)}?code=${code}`, { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /text\/html/);
      assert.equal(page.headers.get('content-encoding'), 'gzip', 'the page is compressed');
      const pageGzip = Number(page.headers.get('content-length'));
      const html = await page.text();
      assert(html.includes('View only'), 'the page says it is read-only');
      assert(html.includes('#17181c'), 'the page carries the desktop terminal theme');
      assert(!/\/(input|interrupt)\b/.test(html), 'the page offers no write path');
      assert(!html.includes('&since='), 'protocol v2 has no byte-replay cursor');
      // Never sideways: overflow hidden everywhere, no font floor, zoom instead.
      for (const rule of ['overflow: hidden; overflow-x: hidden', 'overflow-x: hidden !important',
        'scrollbar-width: none', '#rail { position: absolute', 'var MIN_FONT = 1,',
        'var MIN_ZOOM = 0.6, MAX_ZOOM = 3;', 'zoom: function (delta)', 'resetZoom: resetZoom']) {
        assert(html.includes(rule), `the page is missing ${JSON.stringify(rule)}`);
      }
      // The vendored xterm files carry no workspace data and a <script> cannot
      // send a header, so they answer without a credential; the page does not.
      const hashed = /src="(\/vendor\/[0-9a-f]{16}\/xterm\.js)"/.exec(html);
      assert(hashed, `the page addresses xterm by content hash: ${html.slice(0, 0) || 'not found'}`);
      const vendor = await fetch(`${BASE}${hashed[1]}`, { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(vendor.status, 200);
      assert.match(vendor.headers.get('content-type'), /javascript/);
      assert.equal(vendor.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal(vendor.headers.get('content-encoding'), 'gzip');
      const etag = vendor.headers.get('etag');
      const vendorGzip = Number(vendor.headers.get('content-length'));
      const vendorBytes = (await vendor.text()).length;
      assert(vendorBytes > 1000, 'the xterm bundle is served');
      // A phone that already has it is told so, with no body at all.
      const revalidated = await fetch(`${BASE}${hashed[1]}`, { headers: { 'If-None-Match': etag } });
      assert.equal(revalidated.status, 304, 'an unchanged asset revalidates to 304');
      // The unhashed path a stale client may still ask for is redirected.
      const legacy = await fetch(`${BASE}/vendor/xterm.js`, { redirect: 'manual' });
      assert.equal(legacy.status, 302);
      assert.equal(legacy.headers.get('location'), hashed[1]);
      assert(!html.includes('/vendor/xterm.js?code='), 'the page must not put the code in a vendor URL');
      assert.equal((await fetch(`${BASE}/terminal/${encodeURIComponent(session.id)}`)).status, 401);
      assert.equal((await fetch(`${BASE}/api/sessions/${encodeURIComponent(session.id)}/stream`)).status, 401);
      return { page: html.length, pageGzip, vendorUrl: hashed[1], vendorBytes, vendorGzip, etag, revalidated: 304 };
    });

    await check('state-payload-is-slim', async () => {
      const compressed = await api('/api/state', { headers: { ...AUTH, 'Accept-Encoding': 'gzip' } });
      assert.equal(compressed.headers.get('content-encoding'), 'gzip');
      assert.equal(compressed.headers.get('vary'), 'Accept-Encoding');
      const slimGzip = Number(compressed.headers.get('content-length'));
      const body = await compressed.json();
      const slim = Buffer.byteLength(JSON.stringify(body));
      // What the same workspace cost before the read was slimmed: every
      // session repeating its project's path and its normalized status.
      const verbose = Buffer.byteLength(JSON.stringify({ ...body, sessions: body.sessions.map(item => {
        const project = body.projects.find(entry => entry.id === item.projectId);
        return { ...item, statusLabel: item.statusLabel ?? item.status, cwd: item.cwd ?? (project ? project.path : '') };
      }) }));
      for (const item of body.sessions) {
        assert(item.snippet.length <= 80, `snippets are phone width: ${item.snippet.length}`);
        assert.notEqual(item.statusLabel, item.status, 'a label equal to the status is dropped');
        const project = body.projects.find(entry => entry.id === item.projectId);
        if (project && item.cwd) assert.notEqual(item.cwd.replace(/\\/g, '/').toLowerCase(), project.path.replace(/\\/g, '/').toLowerCase());
      }
      assert(slim <= verbose, 'the slim shape is never larger');
      return { slim, slimGzip, verbose, savedBytes: verbose - slim, sessions: body.sessions.length };
    });

    await check('transcript-pagination', async () => {
      const route = `/api/sessions/${encodeURIComponent(session.id)}/transcript`;
      const body = await (await api(route)).json();
      assert.equal(body.ok, true);
      assert.equal(typeof body.total, 'number');
      assert('nextBefore' in body, 'the pagination cursor is always present');
      assert(body.messages.length <= 50, 'an unparameterised read is the last fifty');
      const paged = await (await api(`${route}?limit=5`)).json();
      assert(paged.messages.length <= 5, 'limit is honoured');
      assert.equal(paged.total, body.total, 'the total is of the whole conversation');
      return { status: body.status, total: body.total, messages: body.messages.length, nextBefore: body.nextBefore };
    });

    await check('needs-input-is-null-for-an-idle-shell', async () => {
      const body = await (await api('/api/state')).json();
      const shell = body.sessions.find(item => item.id === session.id);
      assert(shell, 'the shell is still listed');
      assert.equal('needsInput' in shell, true, 'every session carries the field');
      assert.equal(shell.needsInput, null, `an idle shell is waiting on nothing: ${JSON.stringify(shell.needsInput)}`);
      return { needsInput: shell.needsInput };
    });

    await check('transcript-returns-a-valid-status', async () => {
      const body = await (await api(`/api/sessions/${encodeURIComponent(session.id)}/transcript`)).json();
      assert.equal(body.ok, true);
      assert(['found', 'unavailable', 'unsupported'].includes(body.status), `unexpected status ${body.status}`);
      assert(Array.isArray(body.messages));
      return { status: body.status, messages: body.messages.length };
    });

    await check('orchestrator-history', async () => {
      const response = await api('/api/orchestrator/history');
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert(Array.isArray(body.messages) && Array.isArray(body.tasks));
      assert.equal(typeof body.enabled, 'boolean');
      assert.equal(typeof body.ready, 'boolean');
      return { enabled: body.enabled, ready: body.ready, messages: body.messages.length, tasks: body.tasks.length };
    });

    await check('write-routes-are-absent', async () => {
      const detail = {};
      for (const route of [`/api/sessions/${encodeURIComponent(session.id)}/input`, `/api/sessions/${encodeURIComponent(session.id)}/interrupt`, '/api/orchestrator/request']) {
        const response = await api(route, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'echo NEVER-WRITTEN\r' }) });
        assert.equal(response.status, 404, route);
        assert.deepEqual(await response.json(), { ok: false, error: 'not found' });
        detail[route] = 404;
      }
      // The refused POST must not have reached the shell.
      const screen = await (await api(`/api/sessions/${encodeURIComponent(session.id)}/screen`)).json();
      assert(!screen.text.includes('NEVER-WRITTEN'), 'a refused write must not reach the terminal');
      return detail;
    });

    await check('long-poll-holds-then-wakes', async () => {
      const start = await (await api('/api/state')).json();
      const startedAt = Date.now();
      const waiting = api(`/api/state?revision=${start.revision}&wait=15000`).then(response => response.json());
      await sleep(600);
      const heldFor = Date.now() - startedAt;
      await cdp.eval(`(async()=>{const s=(await window.vibe.terminal.getRuntimeSnapshots()).find(s=>s.id==='phone-shell');window.vibe.terminal.input('phone-shell','echo LINA-BRIDGE-SECOND\\r',{generation:s.generation,launchToken:s.launchToken});})()`);
      const woken = await waiting;
      const elapsed = Date.now() - startedAt;
      assert(heldFor >= 500, 'the poll was actually held');
      assert(elapsed < 14000, `the poll woke on the change, not the deadline (${elapsed}ms)`);
      assert(woken.revision > start.revision, 'the revision advanced');
      return { heldMs: elapsed, from: start.revision, to: woken.revision };
    });

    await check('cors-preflight', async () => {
      const response = await fetch(`${BASE}/api/state`, { method: 'OPTIONS' });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal(response.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
      return { status: 204 };
    });

    if (hold > 0) {
      console.log(`HOLD ${BASE} code ${CODE}`);
      console.log(`HOLD terminal ${BASE}/terminal/${encodeURIComponent(session.id)}?code=${CODE.replace(/-/g, '')}`);
      await sleep(hold * 1000);
    }

    // ---- Phase 2: the same flow WITHOUT the auto-approve override, so nothing
    // is handed out until a person on this desktop presses Allow. ----
    try { child.kill(); } catch {}
    child = null;
    await sleep(800);

    const manualPort = 47993, manualDebug = 47992;
    const manualOut = path.join(output, 'manual');
    fs.mkdirSync(manualOut, { recursive: true });
    const manualEnv = { ...env, VIBE_SCREENSHOT_USER_DATA: path.join(manualOut, 'userData'),
      VIBE_AGENT_SHIM_BASE_DIR: path.join(manualOut, 'shims'),
      LINA_MOBILE_BRIDGE_PORT: String(manualPort) };
    delete manualEnv.LINA_MOBILE_BRIDGE_AUTO_APPROVE;
    const manualBase = `http://127.0.0.1:${manualPort}`;

    child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${manualDebug}`, '--disable-renderer-backgrounding'],
      { cwd: root, env: manualEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const manualLog = fs.createWriteStream(path.join(manualOut, 'electron.log'));
    child.stdout.pipe(manualLog); child.stderr.pipe(manualLog);
    const manualPage = await until(async () => (await (await fetch(`http://127.0.0.1:${manualDebug}/json/list`)).json())
      .find(target => target.type === 'page' && target.url.startsWith('file:') && !target.url.includes('surface=voice')), 'manual renderer');
    cdp = new Cdp(manualPage.webSocketDebuggerUrl); await cdp.open(); await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(() => cdp.eval('Boolean(window.vibe?.mobileBridge)'), 'manual preload');
    await until(async () => (await fetch(`${manualBase}/api/discover`)).ok, 'manual bridge listening');

    let manualRequestId;
    await check('manual-mode-poll-stays-pending', async () => {
      const created = await (await fetch(`${manualBase}/api/pair`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceName: 'Unapproved Pixel', platform: 'android' }) })).json();
      assert.equal(created.ok, true);
      manualRequestId = created.requestId;
      const startedAt = Date.now();
      const held = await (await fetch(`${manualBase}/api/pair/${created.requestId}?wait=2000`)).json();
      const elapsed = Date.now() - startedAt;
      assert.equal(held.status, 'pending', `nothing may be approved without a person: ${JSON.stringify(held)}`);
      assert.equal(held.code, undefined, 'a pending offer must never carry the code');
      assert(elapsed >= 1900, `the poll was actually held (${elapsed}ms)`);
      return { heldMs: elapsed, status: held.status };
    });

    await check('desktop-prompt-allows-and-then-the-code-works', async () => {
      const prompt = await until(() => cdp.eval(`(()=>{const e=document.querySelector('.phone-pair-prompt');return e?{text:e.innerText.replace(/\\n/g,' | '),allow:Boolean([...e.querySelectorAll('button')].find(b=>b.textContent==='Allow'))}:null;})()`), 'pair prompt on the desktop');
      assert(prompt.allow, 'the prompt offers Allow');
      assert(prompt.text.includes('Unapproved Pixel'), `the prompt names the device: ${prompt.text}`);
      assert(prompt.text.includes('android'), 'the prompt names the platform');
      const waiting = fetch(`${manualBase}/api/pair/${manualRequestId}?wait=15000`).then(response => response.json());
      await sleep(150);
      await cdp.eval(`[...document.querySelectorAll('.phone-pair-prompt button')].find(b=>b.textContent==='Allow').click()`);
      const approved = await waiting;
      assert.equal(approved.status, 'approved', `expected approval after the click: ${JSON.stringify(approved)}`);
      assert.match(approved.code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
      assert.equal((await fetch(`${manualBase}/api/hello`, { headers: { Authorization: `Bearer ${approved.code.replace(/-/g, '')}` } })).status, 200);
      await until(() => cdp.eval(`!document.querySelector('.phone-pair-prompt')`), 'prompt dismissed after answering');
      const devices = await cdp.eval('window.vibe.mobileBridge.getState().then(s=>s.devices)');
      assert.deepEqual(devices.map(device => [device.deviceName, device.platform]), [['Unapproved Pixel', 'android']]);
      return { prompt: prompt.text.slice(0, 80), devices: devices.map(device => device.deviceName) };
    });
  } catch (error) {
    fail('smoke', error);
  } finally {
    try { child?.kill(); } catch {}
    await sleep(500);
    console.log(`output ${output}`);
    console.log(failures ? `FAILED ${failures} check(s)` : 'ALL CHECKS PASSED');
    process.exit(failures ? 1 : 0);
  }
})();
