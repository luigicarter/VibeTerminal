'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { resolveLoginBrowser, browserLoginArgs, filterLoginState, createBrowserLogin } = require('../../backend/codexWebBrowserLogin.cjs');

test('external login prefers the default installed Chrome/Edge browser', () => {
  const env = { ProgramFiles: 'C:\\Programs', 'ProgramFiles(x86)': 'C:\\Programs86' };
  assert.equal(resolveLoginBrowser({ env, exists: () => true, query: () => 'MSEdgeHTM' }).name, 'Edge');
  assert.equal(resolveLoginBrowser({ env, exists: () => true, query: () => 'ChromeHTML' }).name, 'Chrome');
  assert.equal(resolveLoginBrowser({ env, exists: executable => executable.endsWith('msedge.exe'), query: () => 'FirefoxURL' }).name, 'Edge');
  assert.throws(() => resolveLoginBrowser({ env, exists: () => false, query: () => '' }), /login_browser_missing/);
});
test('browser launch is tied to an explicit app-owned profile and localhost', () => {
  const profile = path.resolve(os.tmpdir(), 'lina-profile');
  const args = browserLoginArgs(profile, 43210);
  assert.ok(args.includes('--user-data-dir=' + profile)); assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--remote-debugging-port=43210')); assert.ok(args.includes('--new-window'));
  assert.ok(!args.some(arg => /password-store|no-sandbox|disable-web-security/.test(arg)));
  assert.throws(() => browserLoginArgs('relative', 2));
});
test('session transfer excludes identity-provider and unrelated browser state', () => {
  const state = filterLoginState({ cookies: [
    { domain: '.chatgpt.com', value: 'web-session' }, { domain: 'auth.openai.com', value: 'auth-session' },
    { domain: '.google.com', value: 'NEVER-TRANSFER' }, { domain: 'chatgpt.com.evil.test', value: 'NEVER-TRANSFER' },
    { domain: '.chatgpt.com', partitionKey: 'x', value: 'partitioned' },
  ], origins: [{ origin: 'https://chatgpt.com', localStorage: [] }, { origin: 'https://accounts.google.com', localStorage: [{ value: 'NEVER-TRANSFER' }] }] });
  assert.equal(state.cookies.length, 2); assert.equal(state.origins.length, 1); assert.ok(!JSON.stringify(state).includes('NEVER-TRANSFER'));
});
function fixture(t, { timeoutMs = 3000, verifyPage = async () => true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-browser-login-test-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const child = new EventEmitter(); Object.assign(child, { exitCode: null, signalCode: null });
  const launches = [], imports = [], statuses = [], logs = [];
  let connected = true;
  const close = () => { connected = false; child.exitCode = 0; child.emit('exit', 0); };
  const context = { pages: () => [{}], storageState: async () => ({ cookies: [{ domain: '.chatgpt.com', value: 'PRIVATE-COOKIE' }, { domain: 'google.com', value: 'PRIVATE-GOOGLE' }], origins: [] }) };
  const browser = { contexts: () => [context], isConnected: () => connected, newBrowserCDPSession: async () => ({ send: async method => { assert.equal(method, 'Browser.close'); close(); } }), close: async () => close() };
  const login = createBrowserLogin({ userData: root, chromium: { connectOverCDP: async () => browser },
    chooseBrowser: () => ({ name: 'Chrome', executable: 'chrome.exe' }), portProvider: async () => 43210,
    spawnBrowser: (executable, args, options) => { launches.push({ executable, args, options }); return child; },
    verifyPage, timeoutMs, pollMs: 5, importState: async transfer => { imports.push(transfer.storageState); await transfer.cleanup(); },
    publish: state => statuses.push(state), log: event => logs.push(event) });
  return { login, root, child, launches, imports, statuses, logs };
}
test('manual browser completion imports once, removes temporary profile and never logs credentials', async t => {
  const f = fixture(t); await f.login.start();
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].options.windowsHide, false);
  assert.equal(f.imports.length, 1); assert.equal(f.imports[0].cookies.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'external-login')), []);
  assert.ok(!JSON.stringify(f.logs).includes('PRIVATE')); assert.ok(!JSON.stringify(f.statuses).includes('PRIVATE'));
  assert.equal(f.login.status, null);
});
test('repeated sign-in clicks share a window and cancellation never imports a session', async t => {
  const f = fixture(t, { verifyPage: async () => false });
  const first = f.login.start(), second = f.login.start(); assert.equal(first, second);
  const rejected = assert.rejects(first, /client_cancelled/);
  while (!f.launches.length) await new Promise(resolve => setImmediate(resolve));
  await f.login.cancel(); await rejected;
  assert.equal(f.launches.length, 1); assert.equal(f.imports.length, 0); assert.equal(f.login.status, null);
});
test('a stalled browser check times out without changing saved app authentication', async t => {
  const f = fixture(t, { timeoutMs: 30, verifyPage: () => new Promise(() => {}) });
  await assert.rejects(f.login.start(), /external_login_timeout/);
  assert.equal(f.imports.length, 0); assert.deepEqual(fs.readdirSync(path.join(f.root, 'external-login')), []);
});
test('a browser launcher handing off to a live browser is not mistaken for cancellation', async t => {
  const f = fixture(t);
  f.child.exitCode = 0;
  await f.login.start();
  assert.equal(f.imports.length, 1);
});
