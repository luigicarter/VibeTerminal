const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMicrophonePermission } = require('../../backend/microphonePermission.cjs');

function fixture(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-mic-consent-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const state = { focused: true, visible: true, minimized: false, status: 'granted', response: 0, calls: [], links: [] };
  const window = { isDestroyed: () => false, isFocused: () => state.focused, isVisible: () => state.visible, isMinimized: () => state.minimized };
  const dependencies = {
    userDataPath, platform: 'win32', getMainWindow: () => window,
    dialog: { showMessageBox: async (parent, options) => { assert.equal(parent, window); state.calls.push(options); return state.reply ? state.reply(options) : { response: state.response }; } },
    systemPreferences: { getMediaAccessStatus: (kind) => { assert.equal(kind, 'microphone'); return state.status; } },
    shell: { openExternal: async (uri) => { state.links.push(uri); } },
  };
  return { state, dependencies, consentPath: path.join(userDataPath, 'microphone-consent.json'), permission: createMicrophonePermission(dependencies) };
}

test('first foreground allow persists once and survives module recreation', async (t) => {
  const { state, permission, dependencies, consentPath } = fixture(t);
  assert.equal(permission.isGranted(), false);
  assert.equal((await permission.ensure()).ok, true);
  assert.equal(state.calls[0].message, 'Allow Lina Terminal to use your microphone?');
  assert.equal(state.calls[0].cancelId, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(consentPath)), { version: 1, granted: true });
  assert.equal((await createMicrophonePermission(dependencies).ensure()).ok, true);
  assert.equal(state.calls.length, 1);
});

test('cancel saves nothing and a later foreground action can prompt again', async (t) => {
  const { state, permission, consentPath } = fixture(t);
  state.response = 1;
  assert.equal((await permission.ensure()).status, 'permission-required');
  assert.equal(fs.existsSync(consentPath), false);
  state.response = 0;
  assert.equal((await permission.ensure()).ok, true);
  assert.equal(state.calls.length, 2);
});

test('concurrent foreground callers share one dialog', async (t) => {
  const { state, permission } = fixture(t);
  let finish;
  state.reply = () => new Promise((resolve) => { finish = resolve; });
  const first = permission.ensure();
  const second = permission.ensure();
  assert.equal(state.calls.length, 1);
  finish({ response: 0 });
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
});

test('abort during a dialog cannot persist an eventual allow response', async (t) => {
  const { state, permission, consentPath } = fixture(t);
  const controller = new AbortController();
  let finish;
  state.reply = (options) => { assert.equal(options.signal, controller.signal); return new Promise((resolve) => { finish = resolve; }); };
  const result = permission.ensure({ signal: controller.signal });
  controller.abort();
  finish({ response: 0 });
  assert.equal((await result).status, 'cancelled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(consentPath), false);
});

test('secondary caller cancellation does not revoke the active caller consent', async (t) => {
  const { state, permission } = fixture(t);
  let finish;
  state.reply = () => new Promise((resolve) => { finish = resolve; });
  const first = permission.ensure();
  const controller = new AbortController();
  const second = permission.ensure({ signal: controller.signal });
  controller.abort();
  assert.equal((await second).status, 'cancelled');
  finish({ response: 0 });
  assert.equal((await first).ok, true);
});

test('background, hidden, unfocused and minimized requests never prompt', async (t) => {
  const { state, permission } = fixture(t);
  assert.equal((await permission.ensure({ interactive: false })).status, 'permission-required');
  for (const field of ['focused', 'visible', 'minimized']) {
    state[field] = field === 'minimized';
    assert.equal((await permission.ensure()).status, 'permission-required');
    state[field] = field !== 'minimized';
  }
  state.status = 'denied';
  assert.equal((await permission.ensure({ interactive: false })).status, 'os-permission-denied');
  assert.equal(state.calls.length, 0);
  assert.deepEqual(state.links, []);
});

test('existing consent permits background use but never bypasses OS denial', async (t) => {
  const { state, permission } = fixture(t);
  await permission.ensure();
  state.focused = false;
  assert.equal((await permission.ensure({ interactive: false })).ok, true);
  state.status = 'restricted';
  assert.equal((await permission.ensure()).status, 'os-permission-denied');
  assert.equal(state.calls.length, 1);
});

test('OS denial recovery opens only the constant settings URI on explicit click', async (t) => {
  const { state, permission, consentPath } = fixture(t);
  state.status = 'denied';
  state.response = 1;
  assert.equal((await permission.ensure()).status, 'os-permission-denied');
  assert.deepEqual(state.links, []);
  state.response = 0;
  assert.equal((await permission.ensure()).status, 'os-permission-denied');
  assert.deepEqual(state.links, ['ms-settings:privacy-microphone']);
  assert.equal(fs.existsSync(consentPath), false);
});

test('aborted recovery cannot open settings even after an allow response', async (t) => {
  const { state, permission } = fixture(t);
  state.status = 'denied';
  const controller = new AbortController();
  state.reply = () => { controller.abort(); return { response: 0 }; };
  assert.equal((await permission.ensure({ signal: controller.signal })).status, 'cancelled');
  assert.deepEqual(state.links, []);
  assert.equal((await permission.openSettings({ signal: controller.signal })).status, 'cancelled');
});

test('corrupt or invalid persisted consent fails closed', async (t) => {
  const { permission, consentPath } = fixture(t);
  for (const content of ['{broken', 'null', '{"granted":true}', '{"version":1,"granted":"true"}']) {
    fs.writeFileSync(consentPath, content);
    assert.equal(permission.isGranted(), false);
    assert.equal((await permission.ensure({ interactive: false })).ok, false);
  }
});

test('OS status lookup failure fails closed and other-platform settings are unsupported', async (t) => {
  const { dependencies } = fixture(t);
  dependencies.systemPreferences.getMediaAccessStatus = () => { throw new Error('unavailable'); };
  assert.equal((await createMicrophonePermission(dependencies).ensure()).status, 'permission-unavailable');
  assert.equal((await createMicrophonePermission({ ...dependencies, platform: 'darwin' }).openSettings()).status, 'unsupported');
});

test('OS denial while consent is displayed prevents a successful permission result', async (t) => {
  const { state, permission, consentPath } = fixture(t);
  state.reply = () => { state.status = 'denied'; return { response: 0 }; };
  assert.equal((await permission.ensure()).status, 'os-permission-denied');
  assert.equal(fs.existsSync(consentPath), false);
});
