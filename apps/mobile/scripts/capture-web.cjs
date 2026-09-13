'use strict';

/**
 * Capture the phone screens without a phone, a browser extension, or a device.
 *
 * The app is exported for web, served from a temporary static server, and
 * walked inside a 390x844 Electron window — the desktop app's own Electron
 * binary, so nothing new is installed. Every step drives the real DOM that
 * react-native-web renders, through `data-testid` hooks, so the walk does not
 * depend on any visible text.
 *
 *   npm run capture                       # against a private mock bridge
 *   npm run capture -- --host 192.168.1.20 --port 47831 --code XXXX-...
 *   npm run capture -- --read-only        # mock that refuses input
 *   npm run capture -- --control          # mock that grants the key bar
 *
 * Screens land in apps/mobile/.tmp/screens (gitignored) and each one prints a
 * `CAPTURED <file>` line. Any step that takes longer than 20 seconds fails the
 * run with a non-zero exit code.
 *
 * The walk is terminal-first, because the app is: opening a session lands in
 * the live terminal (`04-session`), History is a sheet over it (`04b-history`),
 * `A+` three times is `zoom(+0.6)` (`04c-zoomed`), and the key bar with Ctrl
 * armed is `05-keys`. It ends on Settings, which is a modal (`07-settings`),
 * and on the app's one confirmation sheet over it (`08-settings-modal`).
 *
 * What this cannot photograph is what only a device has: the soft keyboard, a
 * rotation, the hardware back button and the swipe that dismisses a sheet.
 * Those are verified on an emulator instead — see `docs/mobile-app.md`.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { createMockBridge, DEFAULT_CODE, normalizeCode } = require('./mock-bridge.cjs');

const root = path.resolve(__dirname, '..');
const electronBinary = path.resolve(root, '../desktop/node_modules/electron/dist/electron.exe');
const scratch = path.join(root, '.tmp', `capture-${Date.now()}`);
const outDir = path.join(root, '.tmp', 'screens');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function parseArgs(argv) {
  const args = { host: '', port: 0, code: '', readOnly: false, control: false, keepExport: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[(index += 1)];
    if (arg === '--host') args.host = value();
    else if (arg.startsWith('--host=')) args.host = arg.slice(7);
    else if (arg === '--port') args.port = Number.parseInt(value(), 10);
    else if (arg.startsWith('--port=')) args.port = Number.parseInt(arg.slice(7), 10);
    else if (arg === '--code') args.code = value();
    else if (arg.startsWith('--code=')) args.code = arg.slice(7);
    else if (arg === '--read-only' || arg === '--readonly') args.readOnly = true;
    else if (arg === '--control') args.control = true;
    else if (arg === '--keep-export') args.keepExport = true;
  }
  return args;
}

function exportWeb(target) {
  process.stdout.write('Exporting the web build…\n');
  // Run Expo's CLI entry directly: Node refuses to spawn npx.cmd without a shell.
  const cli = path.join(root, 'node_modules/expo/bin/cli');
  if (!fs.existsSync(cli)) throw new Error(`the Expo CLI is missing at ${cli}; run npm ci first`);
  const result = spawnSync(
    process.execPath,
    [cli, 'export', '--platform', 'web', '--output-dir', target],
    { cwd: root, stdio: 'inherit', windowsHide: true }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`expo export failed with code ${result.status}`);
  if (!fs.existsSync(path.join(target, 'index.html'))) throw new Error('the web export has no index.html');
}

/**
 * A phone looks for desktops on 47831 and 47832 only, so the mock has to take
 * one of them rather than an ephemeral port.
 */
async function listenOnBridgePort(bridge) {
  const failures = [];
  for (const candidate of [47832, 47831]) {
    try {
      await bridge.listen(candidate, '127.0.0.1');
      return candidate;
    } catch (error) {
      failures.push(`${candidate}: ${error.code || error.message}`);
    }
  }
  throw new Error(
    `Both bridge ports are busy (${failures.join(', ')}). Stop the other mock or desktop and try again.`
  );
}

function serveStatic(directory) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let file = path.join(directory, decodeURIComponent(url.pathname));
    if (!file.startsWith(directory)) file = path.join(directory, 'index.html');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(directory, 'index.html');
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const ELECTRON_ENTRY = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const config = JSON.parse(process.env.LINA_CAPTURE_CONFIG);
const STEP_TIMEOUT_MS = 20000;

app.disableHardwareAcceleration();
app.setPath('userData', config.userData);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function js(win, expression) {
  return win.webContents.executeJavaScript(expression, true);
}

/** The topmost visible element for a selector: earlier screens stay mounted. */
const VISIBLE = selector => '(() => {' +
  'const all = Array.from(document.querySelectorAll(' + JSON.stringify(selector) + '));' +
  'const shown = all.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });' +
  'const el = shown[shown.length - 1];' +
  'if (!el) return null;' +
  'const r = el.getBoundingClientRect();' +
  'return { x: r.left + r.width / 2, y: r.top + r.height / 2, testid: el.getAttribute("data-testid") };' +
  '})()';

async function waitFor(win, selector, what, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || STEP_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const found = await js(win, VISIBLE(selector));
    if (found) return found;
    await sleep(200);
  }
  throw new Error('timed out waiting for ' + (what || selector));
}

/** The same wait, for something a real desktop may simply not have. */
async function maybe(win, selector, timeoutMs) {
  try {
    return await waitFor(win, selector, selector, timeoutMs || 2500);
  } catch (error) {
    return null;
  }
}

async function click(win, selector) {
  const target = await waitFor(win, selector);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(target.x), y: Math.round(target.y), button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(target.x), y: Math.round(target.y), button: 'left', clickCount: 1 });
  await sleep(250);
  return target;
}

/**
 * Drag the zoomed terminal. On a phone this is a finger; here it is the same
 * message the app uses for zoom and fit, posted into the embedded page — an
 * Electron input event cannot be aimed at an out-of-process frame, and the
 * page is on the desktop's origin, so it cannot be scripted directly either.
 */
async function panTerminal(win, dx, dy) {
  const posted = await js(win, '(() => {' +
    'const frame = Array.from(document.querySelectorAll("iframe")).pop();' +
    'if (!frame || !frame.contentWindow) return false;' +
    'frame.contentWindow.postMessage(JSON.stringify({ type: "pan", dx: ' + dx + ', dy: ' + dy + ' }), "*");' +
    'return true;' +
  '})()');
  if (!posted) throw new Error('there was no embedded terminal to pan');
  await sleep(400);
}

/** React-safe typing: the native setter plus an input event updates the state. */
async function fill(win, testid, value) {
  await waitFor(win, '[data-testid="' + testid + '"]');
  await js(win, '(() => {' +
    'const el = document.querySelector(' + JSON.stringify('[data-testid="' + testid + '"]') + ');' +
    'const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;' +
    'const setter = Object.getOwnPropertyDescriptor(proto, "value").set;' +
    'el.focus();' +
    'setter.call(el, ' + JSON.stringify(value) + ');' +
    'el.dispatchEvent(new Event("input", { bubbles: true }));' +
    'return el.value;' +
  '})()');
  await sleep(150);
}

async function capture(win, name) {
  await sleep(400);
  // The live terminal is an out-of-process frame and this window has no GPU and
  // was shown inactive, so a frame that is not producing anything — a terminal
  // parked on a prompt — can be absent from the first snapshot taken of it even
  // though its DOM is provably correct. Asking for a frame is what composites
  // it, so the first one is thrown away and the second is the photograph.
  // Nothing on a phone needs this: there the compositor is awake.
  await win.webContents.capturePage();
  await sleep(250);
  const image = await win.webContents.capturePage();
  const file = path.join(config.outDir, name);
  fs.writeFileSync(file, image.toPNG());
  process.stdout.write('CAPTURED ' + file + '\n');
}

/** Pair the way the product means people to: find the desktop, approve it. */
async function pairByDiscovery(win) {
  // This run's own mock carries a unique desktop id, so a stray mock left
  // running on the other bridge port cannot be the desktop the walk pairs with.
  const row = '[data-testid="discover-row-' + config.desktopId + '"]';
  await waitFor(win, row, "this run's mock in the discovery list");
  await sleep(400);
  await capture(win, '01-discover.png');
  await click(win, row);

  await waitFor(win, '[data-testid="approve-cancel"]', 'the approval screen');
  await sleep(500);
  await capture(win, '01b-approve.png');
}

/** The escape hatch, used when this run was pointed at an address. */
async function pairByAddress(win) {
  await waitFor(win, '[data-testid="discover-manual-link"]', 'the manual pairing link');
  await sleep(400);
  await capture(win, '01-discover.png');
  await click(win, '[data-testid="discover-manual-link"]');

  await waitFor(win, '[data-testid="pair-address"]', 'the manual pairing form');
  await fill(win, 'pair-address', config.host);
  await fill(win, 'pair-port', String(config.port));
  await fill(win, 'pair-code', config.code);

  // The code field reformats what it is given, which proves React took the value.
  const codeValue = await js(win, 'document.querySelector(\'[data-testid="pair-code"]\').value');
  if (!/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/.test(codeValue)) {
    throw new Error('the pairing code field did not accept the typed code: ' + JSON.stringify(codeValue));
  }
  await capture(win, '01b-approve.png');
  await click(win, '[data-testid="pair-submit"]');
}

async function walk(win) {
  if (config.manual) await pairByAddress(win);
  else await pairByDiscovery(win);

  await waitFor(win, '[data-testid="row-ask-lina"]', 'the Projects screen');
  await waitFor(win, '[data-testid^="project-row-"]', 'a project row');
  // The inbox above the projects. A real desktop may have nothing waiting.
  if (config.manual) await maybe(win, '[data-testid="inbox-section"]');
  else await waitFor(win, '[data-testid="inbox-section"]', 'the Waiting-for-you section');
  await sleep(600);
  await capture(win, '02-projects.png');

  const project = await js(win, '(() => {' +
    'const rows = Array.from(document.querySelectorAll(\'[data-testid^="project-row-"]\'));' +
    'const row = rows.find(el => el.getBoundingClientRect().width > 0);' +
    'return row ? row.getAttribute("data-testid") : null;' +
  '})()');
  if (!project) throw new Error('no project row to open');
  await click(win, '[data-testid="' + project + '"]');
  await waitFor(win, '[data-testid^="session-row-"]', 'a terminal row');
  await sleep(600);
  await capture(win, '03-project.png');

  // Prefer an agent over a plain shell so the Conversation tab has something.
  const session = await js(win, '(() => {' +
    'const rows = Array.from(document.querySelectorAll(\'[data-testid^="session-row-"]\'))' +
      '.filter(el => el.getBoundingClientRect().width > 0);' +
    'const agent = rows.find(el => !el.getAttribute("data-testid").startsWith("session-row-terminal-"));' +
    'const row = agent || rows[0];' +
    'return row ? row.getAttribute("data-testid") : null;' +
  '})()');
  if (!session) throw new Error('no terminal row to open');
  await click(win, '[data-testid="' + session + '"]');

  // Opening a session lands in the terminal itself: the desktop's own xterm, in
  // an iframe, which says "ready" over postMessage once the first screen is on.
  await waitFor(win, '[data-testid="chat-terminal-ready"]', 'the live terminal to report ready');
  await waitFor(win, '[data-testid="keybar"]', 'the key bar');
  // The terminal this walk opens is the one parked on a prompt, so its chips
  // belong in this shot; a real desktop may have nothing waiting.
  if (config.manual) await maybe(win, '[data-testid="prompt-chips"]');
  else await waitFor(win, '[data-testid="prompt-chips"]', 'the prompt chips card');
  // The embedded page re-fits itself once the font metrics have settled; the
  // shot waits for that rather than photographing a terminal mid-measure.
  await sleep(2000);
  await capture(win, '04-session.png');

  // History is a sheet over the terminal, and the only thing that reads a
  // transcript at all: the first page arrives when it is opened, not before.
  await click(win, '[data-testid="header-action-history"]');
  await waitFor(win, '[data-testid="history-sheet"]', 'the History sheet');
  await sleep(1200);
  await capture(win, '04b-history.png');
  await click(win, '[data-testid="history-sheet-close"]');
  await sleep(500);

  // A+ steps the page's zoom by 0.2, so three presses is zoom(+0.6). The page
  // never scrolls sideways, so a zoomed page is read by dragging it.
  await waitFor(win, '[data-testid="keybar-zoom-in"]', 'the zoom keys');
  for (let step = 0; step < 3; step += 1) {
    await click(win, '[data-testid="keybar-zoom-in"]');
  }
  // Zooming from the key bar anchors at the left edge, so the zoomed page is
  // still showing column zero. Dragging it off that edge is what proves the
  // pan: it is a position zooming alone never reaches.
  await panTerminal(win, -160, 0);
  await sleep(500);
  await capture(win, '04c-zoomed.png');

  // Back to the fit before the key bar shot.
  for (let step = 0; step < 3; step += 1) {
    await click(win, '[data-testid="keybar-zoom-out"]');
  }
  await sleep(500);

  if (config.control) {
    await click(win, '[data-testid="keybar-ctrl"]');
    await waitFor(win, '[data-testid="keybar-ctrl-armed"]', 'the Ctrl modifier to arm');
  }
  await sleep(300);
  await capture(win, '05-keys.png');

  await click(win, '[data-testid="header-back"]');
  await waitFor(win, '[data-testid^="session-row-"]', 'the project screen again');
  await click(win, '[data-testid="header-back"]');
  await waitFor(win, '[data-testid="row-ask-lina"]', 'the Projects screen again');
  await click(win, '[data-testid="row-ask-lina"]');
  await waitFor(win, '[data-testid="lina-composer"]', 'the Ask Lina screen');
  await sleep(2000);
  await capture(win, '06-lina.png');

  await click(win, '[data-testid="header-action-settings"]');
  await waitFor(win, '[data-testid="settings-change-pairing"]', 'the Settings screen');
  await sleep(600);
  await capture(win, '07-settings.png');

  // Settings is a modal over whatever opened it, and the two things in it that
  // throw the pairing away ask first, through the app's one confirmation sheet.
  // Cancel, not Forget: the walk has to survive its own screenshot.
  await click(win, '[data-testid="settings-forget"]');
  await waitFor(win, '[data-testid="settings-forget-sheet-confirm"]', 'the confirmation sheet');
  await sleep(600);
  await capture(win, '08-settings-modal.png');
  await click(win, '[data-testid="settings-forget-sheet-cancel"]');
  await sleep(400);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 390,
    height: 844,
    frame: false,
    show: false,
    backgroundColor: '#101010',
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) process.stdout.write('renderer ' + message + '\n');
  });
  win.webContents.on('did-fail-load', (_event, code, description) => {
    process.stderr.write('load failed ' + code + ' ' + description + '\n');
  });
  try {
    win.showInactive();
    await win.loadURL(config.appUrl);
    await walk(win);
    app.exit(0);
  } catch (error) {
    process.stderr.write('CAPTURE FAILED: ' + (error && error.stack ? error.stack : error) + '\n');
    try {
      const image = await win.webContents.capturePage();
      const file = path.join(config.outDir, '99-failure.png');
      fs.writeFileSync(file, image.toPNG());
      process.stderr.write('CAPTURED ' + file + '\n');
      process.stderr.write((await js(win, 'document.body.innerText')) + '\n');
    } catch {}
    app.exit(1);
  }
});

setTimeout(() => {
  process.stderr.write('CAPTURE FAILED: the whole run timed out\n');
  app.exit(1);
}, 5 * 60 * 1000);
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(electronBinary)) {
    throw new Error(
      `Electron is not installed at ${electronBinary}. Run npm ci in apps/desktop first — this script borrows the desktop app's Electron.`
    );
  }

  // A run that died before its cleanup leaves its export behind.
  const tmp = path.join(root, '.tmp');
  if (fs.existsSync(tmp)) {
    for (const entry of fs.readdirSync(tmp)) {
      if (entry.startsWith('capture-')) fs.rmSync(path.join(tmp, entry), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const stale of fs.readdirSync(outDir)) {
    if (stale.endsWith('.png')) fs.rmSync(path.join(outDir, stale));
  }

  const exportDir = path.join(scratch, 'web');
  exportWeb(exportDir);
  const { server, port: webPort } = await serveStatic(exportDir);

  let bridge = null;
  let host = args.host;
  let port = args.port;
  let code = normalizeCode(args.code);
  const manual = Boolean(host && port && code);
  if (!manual) {
    // Discovery only looks at the bridge ports, so the mock has to sit on one.
    bridge = createMockBridge({
      tickMs: 0,
      // Unique, so discovery can tell this run's mock from a stray one someone
      // left running on the other bridge port.
      desktopId: `mock-capture-${process.pid}`,
      readOnly: args.readOnly,
      // `--control` is what makes the key bar live; without it the page is
      // view-only, which is what a desktop serves today.
      control: args.control,
      // Long enough that the approval screen can be photographed before it passes.
      pairAnswerMs: 3500,
    });
    port = await listenOnBridgePort(bridge);
    host = '127.0.0.1';
    code = normalizeCode(DEFAULT_CODE);
    const flags = [args.readOnly ? ' read-only' : '', bridge.control ? ' control' : ' view-only'].join('');
    process.stdout.write(`MOCK http://127.0.0.1:${port} code ${bridge.formattedCode}${flags}\n`);
    if (!bridge.xterm) {
      throw new Error(
        'The live terminal needs xterm, which is not installed. Run npm ci in apps/desktop.'
      );
    }
  } else {
    process.stdout.write(`Using the bridge at ${host}:${port}\n`);
  }

  const entry = path.join(scratch, 'capture-entry.cjs');
  fs.writeFileSync(entry, ELECTRON_ENTRY);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  env.LINA_CAPTURE_CONFIG = JSON.stringify({
    appUrl: `http://127.0.0.1:${webPort}/`,
    host,
    port,
    code,
    outDir,
    manual,
    desktopId: bridge ? bridge.desktopId : '',
    control: bridge ? bridge.control : false,
    userData: path.join(scratch, 'profile'),
  });

  process.stdout.write(`Serving the export on http://127.0.0.1:${webPort}/\n`);

  const exitCode = await new Promise(resolve => {
    const child = spawn(electronBinary, [entry, '--disable-gpu', '--force-device-scale-factor=2'], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: 'inherit',
    });
    child.on('exit', resolve);
    child.on('error', error => {
      process.stderr.write(`${error.message}\n`);
      resolve(1);
    });
  });

  await new Promise(resolve => server.close(resolve));
  if (bridge) await bridge.close();
  if (!args.keepExport) fs.rmSync(scratch, { recursive: true, force: true });
  process.exitCode = exitCode || 0;
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
