'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TOML = require('@iarna/toml');
const { webModels, errorInfo, createLog, syncCapabilities } = require('../../backend/codexWebSupport.cjs');
const { createCodexWebHost } = require('../../backend/codexWebHost.cjs');
const { refreshStartupAuthentication } = require('../../backend/codexWebLauncher.cjs');
const { startValidation, validatedSession, waitForValidation } = require('../../backend/codexWebStartup.cjs');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test('Lina app readiness schedules Codex Web prewarm without waiting for a pane or network', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../backend/main.cjs'), 'utf8');
  const start = source.indexOf('app.whenReady().then(() => {'), end = source.indexOf('\napp.on("window-all-closed"', start);
  assert.ok(start >= 0 && end > start);
  let ready, painted = false, warmed = 0; const queued = [], noop = () => {};
  const context = { app: { whenReady: () => ({ then: callback => { ready = callback; } }), on: noop },
    getAgentTelemetry: noop, getBuildSupervisor: noop, startPtyHost: noop, startAgentThreadHost: noop, refreshInstalledClis: noop,
    createMainWindow: () => { painted = true; }, mainWindow: { on: noop },
    getCodexWebHost: () => ({ prewarm: () => { warmed++; return new Promise(() => {}); } }),
    setImmediate: callback => queued.push(callback), setTimeout: noop, checkForUpdatesOnLaunch: noop,
    require: name => { assert.equal(name, './orchestratorIntegration.cjs'); return { installOrchestrator: () => ({}) }; },
    BrowserWindow: {}, Menu: {}, ipcMain: {}, screen: {}, shell: {}, safeStorage: {}, dialog: {}, systemPreferences: {},
    getTerminalRuntime: noop, sendToPtyHost: noop, sendToFusionChatHost: noop, sendToOpenFusionChatHost: noop, getCodeChangeSummary: noop,
  };
  require('node:vm').runInNewContext(source.slice(start, end), context);
  assert.equal(warmed, 0); ready(); assert.equal(painted, true); assert.equal(warmed, 0);
  for (const callback of queued) callback();
  await Promise.resolve(); await Promise.resolve(); assert.equal(warmed, 1);
});
test('cached startup stays available while inference waits for background authentication', async () => {
  const check = deferred(); let state = { authenticated: false }, completed = false;
  const browser = { snapshot: () => state };
  startValidation(browser, { cached: { accountKey: 'account-a', updatedAt: Date.now() }, check: () => check.promise, refreshModels: async () => assert.fail('Fresh catalog should not refresh') });
  const request = validatedSession(browser).then(result => { completed = true; return result; });
  await Promise.resolve(); assert.equal(browser.linaValidation.pending, true); assert.equal(completed, false);
  state = { authenticated: true, linaAccountKey: 'account-a' }; check.resolve();
  assert.deepEqual(await request, { ok: true }); assert.equal(browser.linaValidation.pending, false);
});
test('background expiry and unexpected account changes block requests with specific recovery messages', async () => {
  for (const [state, code] of [[{ authenticated: false, status: 'signed-out' }, 'chatgpt_session_expired'], [{ authenticated: true, linaAccountKey: 'account-b' }, 'web_account_changed']]) {
    const browser = { snapshot: () => state };
    await startValidation(browser, { cached: { accountKey: 'account-a', updatedAt: Date.now() }, check: async () => {}, refreshModels: async () => assert.fail('Must not refresh a different or expired account') });
    const result = await validatedSession(browser); assert.equal(result.ok, false); assert.equal(result.code, code); assert.match(result.message, /pane menu/);
  }
});
test('stale model refresh finishes behind the same request gate and never blocks cached UI data', async () => {
  const models = deferred(), browser = { snapshot: () => ({ authenticated: true, linaAccountKey: 'account-a' }) };
  const validation = startValidation(browser, { cached: { accountKey: 'account-a', updatedAt: Date.now() - 3600001 }, check: async () => {}, refreshModels: () => models.promise });
  await Promise.resolve(); assert.equal(browser.linaValidation.pending, true); assert.equal(browser.linaValidation.cached.accountKey, 'account-a');
  models.resolve(); await validation;
  assert.equal(browser.linaValidation.modelsRefreshed, true); assert.deepEqual(await validatedSession(browser), { ok: true });
});
test('a transient background failure can recover on the next request without another login', async () => {
  let working = false, checks = 0;
  const browser = { snapshot: () => working ? { authenticated: true, linaAccountKey: 'account-a' } : { authenticated: false, status: 'error' } };
  await startValidation(browser, { cached: { accountKey: 'account-a', updatedAt: Date.now() }, check: async () => { checks++; }, refreshModels: async () => {} });
  assert.equal((await validatedSession(browser)).code, 'connection_failed'); assert.equal(checks, 1);
  working = true; browser.linaValidation.finishedAt -= 1001;
  assert.deepEqual(await validatedSession(browser), { ok: true }); assert.equal(checks, 2);
});
test('the real private browser control endpoint gates requests and supports cancellation', async t => {
  const previous = process.env.LINA_CODEX_WEB_HOST_MODULE; process.env.LINA_CODEX_WEB_HOST_MODULE = path.resolve('backend/codexWebLauncher.cjs');
  t.after(() => { if (previous === undefined) delete process.env.LINA_CODEX_WEB_HOST_MODULE; else process.env.LINA_CODEX_WEB_HOST_MODULE = previous; });
  const check = deferred(); let state = { authenticated: false, status: 'signed-out' };
  const browser = { snapshot: () => state };
  startValidation(browser, { cached: { accountKey: 'account-a', updatedAt: Date.now() }, check: () => check.promise, refreshModels: async () => {} });
  const { BrowserControlServer } = require('../../vendor/codex-web/launcher/electron/control-server.cjs');
  const server = await new BrowserControlServer({ getBrowserHost: () => browser, getPreferences: () => ({}), logger: { info() {}, warn() {} } }).start();
  t.after(async () => { check.resolve(); await server.close(); });
  const descriptor = { control: server.descriptor() }, cancelled = new AbortController();
  const request = waitForValidation(descriptor, cancelled.signal); cancelled.abort();
  await assert.rejects(request, /abort/i);
  check.resolve(); const expired = await waitForValidation(descriptor);
  assert.equal(expired.status, 401); assert.equal(expired.code, 'chatgpt_session_expired');
  state = { authenticated: true, linaAccountKey: 'account-b' }; browser.linaValidation.error = null; browser.linaValidation.cached = null;
  assert.deepEqual(await waitForValidation(descriptor), { ok: true });
});
test('cached login checks use the isolated cookie partition and do not require website startup', async () => {
  let state = {}, navigations = 0;
  const host = { view: { webContents: { session: { fetch: async url => ({ ok: true, status: 200, url, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ user: { id: 'account-1' }, accessToken: 'PRIVATE-TOKEN', expires: new Date(Date.now() + 60000).toISOString() }) }) } } }, setState: patch => { state = { ...state, ...patch }; }, snapshot: () => state, refreshAuthentication: async () => { navigations++; } };
  await refreshStartupAuthentication(host);
  assert.equal(state.authenticated, true); assert.equal(navigations, 0); assert.match(state.linaAccountKey, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(state).includes('PRIVATE-TOKEN'));
  host.view.webContents.session.fetch = async () => ({ status: 401 });
  await refreshStartupAuthentication(host); assert.equal(state.authenticated, false); assert.equal(state.status, 'signed-out');
  host.view.webContents.session.fetch = async () => ({ status: 403, ok: false });
  await refreshStartupAuthentication(host); assert.equal(navigations, 1, 'A browser challenge uses the established interactive browser check.');
});
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-codex-web-test-'));
  t.after(() => { const absolute = path.resolve(directory); assert.equal(path.dirname(absolute), path.resolve(os.tmpdir())); fs.rmSync(absolute, { recursive: true, force: true }); });
  return directory;
}
test('picker excludes native, hidden, malformed and duplicate models and preserves Web effort', () => {
  assert.deepEqual(webModels([
    { id: 'gpt-native', displayName: 'Native' }, { id: 'chatgpt-web/pro', displayName: 'ChatGPT Pro', defaultReasoningEffort: 'ultra' },
    { id: 'chatgpt-web/pro' }, { id: 'chatgpt-web/hidden', hidden: true }, { id: 'chatgpt-web/../../auth.json' }, null,
  ]), [{ id: 'chatgpt-web/pro', label: 'ChatGPT Pro', effort: 'ultra' }]);
  assert.deepEqual(webModels(null), []);
});
test('auth errors are distinct from quotas, transient subscription failure and ambiguous HTTP status', () => {
  assert.equal(errorInfo('ChatGPT session has expired').code, 'chatgpt_session_expired');
  assert.equal(errorInfo({ message: '{"code":"rate_limit_exceeded"}' }).code, 'rate_limit_exceeded');
  assert.equal(errorInfo('chatgpt_subscription_unavailable').code, 'chatgpt_subscription_unavailable');
  assert.equal(errorInfo('HTTP 403 Bearer PRIVATE').code, 'request_failed');
  assert.ok(!JSON.stringify(errorInfo({ message: 'SECRET-PROMPT', cause: { cookie: 'SECRET' } })).includes('SECRET'));
});
test('global capabilities are shared while private auth and model routing stay separate', t => {
  const root = temporary(t), global = path.join(root, 'global'), own = path.join(root, 'private');
  fs.mkdirSync(path.join(global, 'skills'), { recursive: true }); fs.mkdirSync(own);
  fs.writeFileSync(path.join(global, 'skills', 'test.md'), 'shared skill');
  fs.writeFileSync(path.join(global, 'AGENTS.md'), 'shared instructions');
  fs.writeFileSync(path.join(global, 'auth.json'), 'GLOBAL-AUTH');
  fs.writeFileSync(path.join(own, 'auth.json'), 'PRIVATE-AUTH');
  fs.writeFileSync(path.join(global, 'config.toml'), 'model="native"\ncli_auth_credentials_store="keyring"\n[mcp_servers.example]\ncommand="node"\n[features]\napps=true\n');
  fs.writeFileSync(path.join(own, 'config.toml'), 'openai_base_url="http://127.0.0.1:12345/v1"\n');
  const before = fs.readFileSync(path.join(global, 'config.toml'), 'utf8');
  syncCapabilities(global, own);
  const config = TOML.parse(fs.readFileSync(path.join(own, 'config.toml'), 'utf8'));
  assert.equal(config.model, undefined); assert.equal(config.cli_auth_credentials_store, 'file');
  assert.equal(config.openai_base_url, 'http://127.0.0.1:12345/v1'); assert.equal(config.mcp_servers.example.command, 'node');
  assert.equal(config.features.apps, true); assert.equal(fs.readFileSync(path.join(own, 'AGENTS.md'), 'utf8'), 'shared instructions');
  assert.equal(fs.readFileSync(path.join(own, 'skills/test.md'), 'utf8'), 'shared skill');
  assert.equal(fs.readFileSync(path.join(global, 'auth.json'), 'utf8'), 'GLOBAL-AUTH');
  assert.equal(fs.readFileSync(path.join(own, 'auth.json'), 'utf8'), 'PRIVATE-AUTH');
  assert.equal(fs.readFileSync(path.join(global, 'config.toml'), 'utf8'), before);
  assert.throws(() => syncCapabilities(global, global), /separate/);
});
test('diagnostics are bounded and never persist arbitrary fields or exception content', t => {
  const log = createLog(temporary(t), { maxBytes: 300, files: 5 });
  for (let i = 0; i < 90; i++) log.record('request.failed', { code: 'request_failed', message: 'SECRET prompt', cookie: 'SECRET', authorization: 'Bearer SECRET', nested: { key: 'SECRET' }, count: i });
  const entries = fs.readdirSync(log.directory);
  assert.ok(entries.length <= 5);
  for (const name of entries) { const body = fs.readFileSync(path.join(log.directory, name), 'utf8'); assert.ok(!body.includes('SECRET')); assert.ok(Buffer.byteLength(body) <= 300); }
  const broken = path.join(log.directory, 'blocked'); fs.writeFileSync(broken, 'file');
  const bad = createLog(broken); assert.doesNotThrow(() => bad.record('error')); assert.equal(bad.failed, true);
});
test('sandbox and approval settings inherit the normal Codex configuration and selected profile', t => {
  const root = temporary(t), global = path.join(root, 'global'), own = path.join(root, 'private');
  fs.mkdirSync(global); fs.mkdirSync(own);
  const settings = { sandbox_mode: 'workspace-write', approval_policy: 'on-request', windows: { sandbox: 'elevated' }, sandbox_workspace_write: { network_access: true }, profile: 'daily', profiles: { daily: { approval_policy: 'never', sandbox_mode: 'danger-full-access', model: 'native-only' } } };
  fs.writeFileSync(path.join(global, 'config.toml'), TOML.stringify(settings));
  fs.writeFileSync(path.join(own, 'config.toml'), '[windows]\nsandbox="unelevated"\n');
  const before = fs.readFileSync(path.join(global, 'config.toml'), 'utf8');
  syncCapabilities(global, own);
  const result = TOML.parse(fs.readFileSync(path.join(own, 'config.toml'), 'utf8'));
  assert.equal(result.sandbox_mode, 'danger-full-access'); assert.equal(result.approval_policy, 'never');
  assert.deepEqual(result.windows, settings.windows); assert.deepEqual(result.sandbox_workspace_write, settings.sandbox_workspace_write);
  assert.equal(result.model, undefined); assert.equal(result.profiles, undefined);
  assert.equal(fs.readFileSync(path.join(global, 'config.toml'), 'utf8'), before);
});
test('fresh private config permits the bridge to install its features table', t => {
  const root = temporary(t), global = path.join(root, 'global'), own = path.join(root, 'private');
  syncCapabilities(global, own);
  const file = path.join(own, 'config.toml');
  const installed = fs.readFileSync(file, 'utf8') + '\n[features]\nmulti_agent = true\nmulti_agent_v2 = true\n';
  assert.equal(TOML.parse(installed).features.multi_agent, true);
});
test('known setup corruption repairs only the empty duplicate and preserves private auth and routing', t => {
  const root = temporary(t), global = path.join(root, 'global'), own = path.join(root, 'private');
  fs.mkdirSync(own); fs.mkdirSync(global);
  const file = path.join(own, 'config.toml');
  const broken = 'features = { }\nopenai_base_url = "http://127.0.0.1:12345/v1"\n# Managed by codex-chatgpt-web: Responses use the local bridge\n[features]\nmulti_agent = true\nmulti_agent_v2 = true\n';
  fs.writeFileSync(file, broken); fs.writeFileSync(path.join(own, 'auth.json'), 'PRIVATE-AUTH');
  fs.writeFileSync(path.join(global, 'config.toml'), 'model="native"\n');
  assert.throws(() => TOML.parse(broken));
  assert.equal(syncCapabilities(global, own).repaired, true);
  const config = TOML.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(config.features.multi_agent, true); assert.equal(config.openai_base_url, 'http://127.0.0.1:12345/v1');
  assert.equal(fs.readFileSync(path.join(own, 'auth.json'), 'utf8'), 'PRIVATE-AUTH');
  assert.equal(fs.readFileSync(path.join(global, 'config.toml'), 'utf8'), 'model="native"\n');
  assert.equal(syncCapabilities(global, own).repaired, false);
  const unrelated = broken.replace('features = { }', 'features = { plugins = true }');
  fs.writeFileSync(file, unrelated);
  assert.throws(() => syncCapabilities(global, own));
  assert.equal(fs.readFileSync(file, 'utf8'), unrelated);
});
test('configuration errors retain a safe stage and location without logging file contents', t => {
  let error;
  try { TOML.parse('secret = "PRIVATE"\nsecret = "PRIVATE"\n'); } catch (caught) { error = caught; }
  const info = errorInfo(error, 'capabilities');
  assert.equal(info.code, 'config_invalid'); assert.equal(info.stage, 'capabilities'); assert.equal(info.line, 2);
  const log = createLog(temporary(t)); log.record('operation.failed', info);
  const body = fs.readFileSync(path.join(log.directory, 'codex-web.jsonl'), 'utf8');
  assert.ok(!body.includes('PRIVATE')); assert.ok(!body.includes('secret'));
  assert.equal(JSON.parse(body).line, 2); assert.equal(JSON.parse(body).stage, 'capabilities');
});
test('capability sync preserves managed formatting and repairs only matching journal definitions', t => {
  const root = temporary(t), global = path.join(root, 'global'), home = path.join(root, 'codex-home');
  fs.mkdirSync(home); fs.mkdirSync(global); fs.mkdirSync(path.join(root, 'bridge/codex'), { recursive: true });
  const file = path.join(home, 'config.toml');
  const fragment = '\n# Managed by codex-chatgpt-web: release the exact Responses request when its Codex turn is interrupted.\n[[hooks.Interrupt]]\n\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "fixture-command"\ntimeout = 3\n\n[hooks.state.fixture]\ntrusted_hash = "fixture-hash"\n# End codex-chatgpt-web interrupt lifecycle hook.\n';
  const config = { openai_base_url: 'http://127.0.0.1:12345/v1', experimental_realtime_webrtc_call_base_url: 'https://chatgpt.com/backend-api/codex', features: { multi_agent: true, multi_agent_v2: false }, agents: { max_depth: 2 }, ...TOML.parse(fragment) };
  const journal = { version: 10, active: true, configPath: file, installed: { openai_base_url: config.openai_base_url, experimental_realtime_webrtc_call_base_url: config.experimental_realtime_webrtc_call_base_url, subagent_protocol: 'compatibility-v1' }, installedAgentMaxDepth: 2, interruptHook: { fragment, groupIndex: 0, stateKey: 'fixture' } };
  fs.writeFileSync(path.join(root, 'bridge/codex/integration-journal.json'), JSON.stringify(journal));
  fs.writeFileSync(file, TOML.stringify(config));
  syncCapabilities(global, home);
  const repaired = fs.readFileSync(file, 'utf8');
  assert.ok(repaired.includes(fragment)); assert.ok(repaired.includes('# Managed by codex-chatgpt-web: Responses'));
  assert.ok(repaired.includes('multi_agent = true # Managed by codex-chatgpt-web:'));
  syncCapabilities(global, home);
  assert.equal(fs.readFileSync(file, 'utf8'), repaired, 'An unchanged sync must retain exact journal formatting.');
  fs.writeFileSync(path.join(global, 'config.toml'), '[mcp_servers.updated]\ncommand="node"\n');
  syncCapabilities(global, home);
  const changed = fs.readFileSync(file, 'utf8');
  assert.ok(changed.includes(fragment)); assert.equal(TOML.parse(changed).mcp_servers.updated.command, 'node');
  const tampered = TOML.parse(changed); tampered.hooks.Interrupt[0].hooks[0].command = 'different-command';
  fs.writeFileSync(file, TOML.stringify(tampered));
  assert.throws(() => syncCapabilities(global, home), /config_invalid/);
  assert.equal(TOML.parse(fs.readFileSync(file, 'utf8')).hooks.Interrupt[0].hooks[0].command, 'different-command');
});
async function fixture(t) {
  const root = temporary(t), calls = [], events = [];
  let connection = { authenticated: true, accountKey: 'account-a', configured: true, full: true, toolsVerified: true, automatic: true };
  const server = require('node:http').createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ models: [{ slug: 'native-model' },
      { slug: 'chatgpt-web/gpt-6-astra-wm', display_name: 'GPT-6 Astra', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] },
      { slug: 'chatgpt-web/gpt-6-pro', display_name: 'GPT-6 Pro', default_reasoning_level: 'medium' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const home = path.join(root, 'codex-web/codex-home'); fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), TOML.stringify({ openai_base_url: 'http://127.0.0.1:' + server.address().port + '/v1' }));
  const hostOptions = { app: { getPath: () => root }, shell: { openPath: async () => {}, openExternal: async () => {} },
    resolveCodexBin: () => 'unused', globalCodexHome: path.join(root, 'global'), broadcast: (_, event) => events.push(event),
    bridgeAdapter: { start: async () => {}, call: async action => { calls.push(action); if (action === 'logout') connection = { ...connection, authenticated: false }; return connection; } } };
  const host = createCodexWebHost(hostOptions);
  t.after(() => host.shutdown());
  const action = (action, data = {}) => host.action({ id: 'pane-1', launchToken: 1, action, ...data });
  await action('start', { cwd: root });
  return { root, home, host, hostOptions, action, calls, events, setConnection: value => { connection = { ...connection, ...value }; } };
}
test('the Codex Web paste menu accepts image-only clipboard contents and preserves the pane generation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../backend/main.cjs'), 'utf8');
  const start = source.indexOf('ipcMain.handle("terminal:show-context-menu"'), end = source.indexOf('\nfunction scopedTerminalPayload', start);
  let handler, menu; const events = [];
  require('node:vm').runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, value) => { handler = value; } }, clipboard: { readText: () => '', readImage: () => ({ isEmpty: () => false }), availableFormats: () => [], writeText() {} },
    Menu: { buildFromTemplate: value => { menu = value; return { popup() {} }; } }, BrowserWindow: { fromWebContents: () => null }
  });
  const event = { sender: { send: (name, value) => events.push({ name, ...value }) } };
  handler(event, { id: 'pane', imagePaste: false }); assert.equal(menu[1].enabled, false);
  handler(event, { id: 'pane', imagePaste: true, launchToken: 7 }); assert.equal(menu[1].enabled, true); menu[1].click();
  assert.equal(events[0].launchToken, 7); assert.equal(events[0].text, '');
});
test('image clicks open only saved generated images, preserve account state and reject stale panes', async t => {
  const f = await fixture(t), opened = [];
  f.hostOptions.shell.openPath = async file => { opened.push(file); return ''; };
  const directory = path.join(f.root, 'codex-web/generated-images'); fs.mkdirSync(directory, { recursive: true });
  const name = 'image-0123456789abcdef0123.png', file = path.join(directory, name);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(20)]));
  assert.equal((await f.action('open-image', { filename: name })).ok, true);
  assert.deepEqual(opened, [file]); assert.deepEqual(f.calls, [], 'Opening a local image does not start or authenticate a Web connection.');
  assert.equal((await f.host.action({ id: 'pane-1', launchToken: 2, action: 'open-image', filename: name })).ok, false);
  for (const filename of ['../' + name, 'https://example.com/' + name, 'image-0123456789abcdef0123.exe', 'image-aaaaaaaaaaaaaaaaaaaa.png']) {
    const result = await f.action('open-image', { filename }); assert.equal(result.ok, false); assert.equal(result.error.code, 'image_unavailable');
  }
  fs.writeFileSync(file, '<html>not an image</html>');
  assert.equal((await f.action('open-image', { filename: name })).ok, false);
  assert.equal(opened.length, 1);
});
test('app prewarm skips fresh profiles without opening a browser or creating a session', async t => {
  const root = temporary(t); let starts = 0;
  const host = createCodexWebHost({ app: { getPath: () => root }, shell: {}, broadcast() {}, resolveCodexBin: () => assert.fail('No cached profile'), bridgeAdapter: { start: async () => { starts++; }, call: async () => ({}) } });
  t.after(() => host.shutdown());
  assert.equal(await host.prewarm(), false); assert.equal(starts, 0); assert.equal(host.sessions.size, 0); assert.deepEqual(fs.readdirSync(root), []);
});
test('app prewarm and a later pane share one cached connection, including pane restarts', async t => {
  const f = await fixture(t); await f.action('refresh'); await f.host.shutdown();
  let starts = 0; const started = deferred();
  const host = createCodexWebHost({ ...f.hostOptions, bridgeAdapter: { ...f.hostOptions.bridgeAdapter, start: async () => { starts++; await started.promise; } } });
  t.after(() => host.shutdown());
  const before = f.calls.length, warm = host.prewarm(), sameWarm = host.prewarm();
  await Promise.resolve(); assert.equal(starts, 1); assert.equal(host.sessions.size, 0);
  await host.action({ id: 'later-pane', launchToken: 1, action: 'start', cwd: f.root });
  const opening = host.action({ id: 'later-pane', launchToken: 1, action: 'terminal-status' });
  started.resolve(); assert.equal(await warm, true); assert.equal(await sameWarm, true); assert.equal((await opening).state.models.length, 2);
  await host.stop('later-pane', 1);
  await host.action({ id: 'later-pane', launchToken: 2, action: 'start', cwd: f.root });
  assert.equal((await host.action({ id: 'later-pane', launchToken: 2, action: 'terminal-status' })).state.models.length, 2);
  assert.equal(starts, 1); assert.ok(!f.calls.slice(before).some(action => ['login', 'refresh', 'setup-tools'].includes(action)));
});
test('failed app prewarm is contained and a pane can retry the normal startup path', async t => {
  const f = await fixture(t); await f.action('refresh'); await f.host.shutdown(); let starts = 0;
  const host = createCodexWebHost({ ...f.hostOptions, bridgeAdapter: { ...f.hostOptions.bridgeAdapter, start: async () => { if (++starts === 1) throw new Error('connection_failed'); } } });
  t.after(() => host.shutdown());
  assert.equal(await host.prewarm(), false); assert.equal(host.sessions.size, 0);
  await host.action({ id: 'retry-pane', launchToken: 1, action: 'start', cwd: f.root });
  assert.equal((await host.action({ id: 'retry-pane', launchToken: 1, action: 'terminal-status' })).state.models.length, 2); assert.equal(starts, 2);
});
test('a fresh process reuses only a recent catalog belonging to its verified Web account', async t => {
  const f = await fixture(t); await f.action('refresh'); await f.host.shutdown();
  const host = createCodexWebHost(f.hostOptions); t.after(() => host.shutdown());
  await host.action({ id: 'new-pane', launchToken: 1, action: 'start', cwd: f.root });
  const before = f.calls.filter(call => call === 'refresh').length;
  let result = await host.action({ id: 'new-pane', launchToken: 1, action: 'terminal-status' });
  assert.equal(result.state.models.length, 2); assert.equal(f.calls.filter(call => call === 'refresh').length, before);
  f.setConnection({ accountKey: 'account-b' });
  result = await host.action({ id: 'new-pane', launchToken: 1, action: 'terminal-status' });
  assert.deepEqual(result.state.models, []); assert.equal(fs.existsSync(result.state.catalogPath), false);
});
test('a pending cached login can open with saved models before validation finishes', async t => {
  const f = await fixture(t); await f.action('refresh'); await f.host.shutdown();
  f.setConnection({ authenticated: false, accountKey: null, checkingLogin: true, cachedAccountKey: 'account-a' });
  const host = createCodexWebHost(f.hostOptions); t.after(() => host.shutdown());
  await host.action({ id: 'pending-pane', launchToken: 1, action: 'start', cwd: f.root });
  const result = await host.action({ id: 'pending-pane', launchToken: 1, action: 'terminal-status' });
  assert.equal(result.state.models.length, 2); assert.equal(result.state.connection.authenticated, false); assert.equal(result.state.connection.checkingLogin, true);
  assert.equal(result.state.cachedStartupAllowed, true);
  assert.equal(f.calls.filter(call => call === 'refresh').length, 1);
  f.setConnection({ checkingLogin: false, validationError: 'connection_failed' });
  const offline = await host.action({ id: 'pending-pane', launchToken: 1, action: 'terminal-status' });
  assert.equal(offline.state.models.length, 2); assert.equal(offline.state.cachedStartupAllowed, true);
  assert.equal(fs.existsSync(offline.state.catalogPath), true); assert.equal(offline.state.backgroundError, true);
});
test('logout clears cached models but preserves native history, and expiry never reuses them', async t => {
  const f = await fixture(t); const refreshed = await f.action('refresh');
  fs.mkdirSync(path.join(f.home, 'sessions')); fs.writeFileSync(path.join(f.home, 'sessions', 'native.jsonl'), 'native history');
  f.setConnection({ authenticated: false });
  const expired = await f.action('terminal-status');
  assert.deepEqual(expired.state.models, []);
  await f.action('logout');
  assert.equal(fs.existsSync(refreshed.state.catalogPath), false);
  assert.equal(fs.readFileSync(path.join(f.home, 'sessions', 'native.jsonl'), 'utf8'), 'native history');
});
test('the connection manager writes the Web catalog and lets native config own model preferences', async t => {
  const f = await fixture(t);
  let result = await f.action('refresh'); assert.equal(result.ok, true);
  assert.equal(result.state.model, 'chatgpt-web/gpt-6-astra-wm');
  const catalog = JSON.parse(fs.readFileSync(result.state.catalogPath, 'utf8'));
  assert.equal(catalog.models.length, 2); assert.ok(catalog.models.every(row => row.slug.startsWith('chatgpt-web/')));
  const file = path.join(f.home, 'config.toml'), config = TOML.parse(fs.readFileSync(file, 'utf8'));
  config.model = 'chatgpt-web/gpt-6-pro'; config.model_reasoning_effort = 'medium';
  fs.writeFileSync(file, TOML.stringify(config));
  result = await f.action('status'); assert.equal(result.state.model, config.model); assert.equal(result.state.effort, 'medium');
  assert.equal(fs.existsSync(path.join(f.root, 'codex-web/sessions')), false, 'Lina must not create duplicate conversation history.');
});
test('catalog refresh preserves an active route when user agent settings differ from the setup journal', async () => {
  const { ensureActiveBridgeRoute } = require('../../backend/codexWebLauncher.cjs');
  let connections = 0;
  const host = { run: async () => ({ stdout: JSON.stringify({ installed: true, active: true, errors: ["Codex [agents].max_depth changed after Compatibility V1 setup; refusing to overwrite the user's newer value"] }) }), connectBridgeRoute: async () => { connections++; } };
  await ensureActiveBridgeRoute(host); assert.equal(connections, 0);
  host.run = async () => ({ stdout: JSON.stringify({ installed: true, active: false, errors: [] }) });
  await ensureActiveBridgeRoute(host); assert.equal(connections, 1, 'A disconnected route still requires reconnection.');
  host.run = async () => ({ stdout: JSON.stringify({ installed: true, active: true, errors: ['The managed route was changed.'] }) });
  await ensureActiveBridgeRoute(host); assert.equal(connections, 2, 'Other integration errors retain strict route validation.');
  host.run = async () => ({ stdout: 'invalid' });
  await assert.rejects(ensureActiveBridgeRoute(host), /bridge_config_out_of_sync/);
  assert.equal(connections, 2, 'Unreadable route status cannot trigger a blind configuration rewrite.');
});

test('cached picker restores a hidden Thinking route and preserves the exact selection, effort and resume metadata', async t => {
  const f = await fixture(t); await f.action('refresh'); await f.host.shutdown();
  const catalogFile = path.join(f.home, 'lina-model-catalog.json'), cached = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  const { buildNativeCatalog } = require('../../backend/codexWebModelDiscovery.cjs');
  cached.models = buildNativeCatalog({}, { models: [
    { slug: 'gpt-5.6-sol-wm', title: 'GPT-5.6 Sol', workMode: true, reasoningType: 'reasoning', maxTokens: 100000, defaultEffort: 'medium', efforts: [{ effort: 'medium' }, { effort: 'high' }] },
    { slug: 'gpt-5-6-thinking', title: 'GPT-5.6 Sol', workMode: false, reasoningType: 'reasoning', maxTokens: 100000, defaultEffort: 'medium', efforts: [{ effort: 'medium' }, { effort: 'high' }] },
  ] }).models;
  // Reproduce the old policy that hid Thinking when a Work model was listed.
  cached.models[1].visibility = 'hide'; cached.models[1]._lina_web_picker_hidden = true;
  fs.writeFileSync(catalogFile, JSON.stringify(cached));
  const configFile = path.join(f.home, 'config.toml'), config = TOML.parse(fs.readFileSync(configFile, 'utf8'));
  config.model = 'chatgpt-web/gpt-5-6-thinking'; config.model_reasoning_effort = 'high';
  fs.writeFileSync(configFile, TOML.stringify(config));
  const host = createCodexWebHost(f.hostOptions); t.after(() => host.shutdown());
  await host.action({ id: 'filtered-pane', launchToken: 1, action: 'start', cwd: f.root });
  const result = await host.action({ id: 'filtered-pane', launchToken: 1, action: 'terminal-status' });
  assert.equal(result.state.model, 'gpt-5.6-sol-thinking'); assert.equal(result.state.effort, 'high');
  assert.equal(result.state.models.find(model => model.id === result.state.model).hidden, undefined);
  const saved = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  assert.equal(saved.models.length, 2); assert.equal(saved.models.filter(row => row.visibility === 'list').length, 2);
  assert.equal(TOML.parse(fs.readFileSync(configFile, 'utf8')).model, config.model);
});
test('logout clears the Web connection without a second Codex authentication process', async t => {
  const f = await fixture(t); await f.action('refresh');
  const result = await f.action('logout');
  assert.equal(result.state.connection.authenticated, false); assert.deepEqual(result.state.models, []);
  assert.equal(f.calls.filter(action => action === 'logout').length, 1);
});
test('setup stays inside the terminal and survives a pane restart', async t => {
  const f = await fixture(t); assert.equal((await f.action('setup')).state.setupRequested, true);
  await f.action('stop'); await f.action('start', { cwd: f.root });
  assert.equal((await f.action('status')).state.setupRequested, true);
  assert.equal((await f.action('setup-consume')).state.setupRequested, false);
  assert.ok(!f.calls.includes('show'));
});
test('busy Web activity prevents changing the shared account, and stale panes cannot control it', async t => {
  const f = await fixture(t); f.setConnection({ busy: true });
  assert.equal((await f.action('logout')).error.code, 'busy');
  await f.host.action({ id: 'pane-1', launchToken: 2, cwd: f.root, action: 'start' });
  assert.equal((await f.action('login')).error.code, 'client_cancelled');
});
test('normal PTY launch forwards native CLI arguments and keeps control credentials out of commands', async t => {
  const f = await fixture(t);
  const launch = await f.host.prepareTerminal({ id: 'pane-1', launchToken: 1, cwd: f.root });
  const command = fs.readFileSync(path.join(launch.binDir, 'codex-web.cmd'), 'utf8');
  assert.equal(launch.command, 'codex-web'); assert.ok(command.includes('%*'));
  assert.ok(!command.includes(launch.env.LINA_CODEX_WEB_CONTROL_KEY));
  const denied = await fetch(launch.env.LINA_CODEX_WEB_CONTROL_URL, { method: 'POST', body: '{}' }); assert.equal(denied.status, 403);
  const accepted = await fetch(launch.env.LINA_CODEX_WEB_CONTROL_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + launch.env.LINA_CODEX_WEB_CONTROL_KEY }, body: JSON.stringify({ id: 'pane-1', launchToken: 1, action: 'terminal-status' }) });
  assert.equal((await accepted.json()).ok, true);
});
test('tools setup reuses saved credentials and verifies before reporting success', async () => {
  const { setupTools } = require('../../backend/codexWebSetup.cjs');
  const calls = [], printed = [], answers = ['', 'v'];
  await setupTools({
    call: async (action, input) => { calls.push({ action, input }); return { state: { connection: { toolsCredentials: true, connectorName: 'Codex Native2' } } }; },
    prompt: async () => answers.shift(), secret: async () => { throw new Error('Must reuse saved credentials'); }, print: value => printed.push(value),
  });
  assert.equal(calls.find(call => call.action === 'setup-tools').input.replace, false);
  assert.equal(calls.at(-1).action, 'verify-tools');
  assert.equal(printed.at(-1), 'Local tools connected.');
  assert.ok(!calls.some(call => call.action === 'show' || call.action === 'setup-browser'));
});
test('new tools setup sends its secret only through the private control call, and can cancel without opening a browser', async () => {
  const { setupTools } = require('../../backend/codexWebSetup.cjs');
  const calls = [], printed = [], answers = ['', 'tunnel_' + 'a'.repeat(32), 'v'];
  const call = async (action, input) => { calls.push({ action, input }); return { state: { connection: { toolsCredentials: false } } }; };
  await setupTools({ call, prompt: async () => answers.shift(), secret: async () => 'PRIVATE-RUNTIME-KEY-FOR-FIXTURE', print: value => printed.push(value) });
  assert.equal(calls.find(call => call.action === 'setup-tools').input.runtimeKey, 'PRIVATE-RUNTIME-KEY-FOR-FIXTURE');
  assert.ok(!printed.join('\n').includes('PRIVATE-RUNTIME-KEY'));
  calls.length = 0;
  await setupTools({ call, prompt: async () => 'q', secret: async () => { throw new Error('Cancelled'); }, print: () => {} });
  assert.ok(!calls.some(call => ['setup-browser', 'setup-tools', 'verify-tools'].includes(call.action)));
});
test('the secret prompt suppresses readline output', async () => {
  const { secretPrompt } = require('../../backend/codexWebSetup.cjs');
  const { PassThrough, Writable } = require('node:stream');
  const input = new PassThrough(); let displayed = '';
  const output = new Writable({ write(chunk, _encoding, done) { displayed += chunk; done(); } });
  const result = secretPrompt('Key: ', { input, output });
  input.write('PRIVATE-RUNTIME-KEY\n');
  assert.equal(await result, 'PRIVATE-RUNTIME-KEY');
  assert.equal(displayed, 'Key: \n');
});
test('the actual upstream runtime can publish login status before local tools are configured', () => {
  const { RuntimeHost, CURRENT_CONNECTOR_NAME } = require('../../vendor/codex-web/launcher/electron/runtime.cjs');
  const { runtimeConnection } = require('../../backend/codexWebLauncher.cjs');
  const runtime = Object.create(RuntimeHost.prototype);
  runtime.launcherProfile = 'production'; runtime.currentOperation = () => null;
  for (const configured of [false, true]) {
    runtime.runtimeConfigSnapshot = () => ({ configured, mode: 'browser-only', config: configured ? { mode: 'browser-only', browserInteractionMode: 'automatic' } : undefined });
    assert.throws(() => runtime.mcpConnectorName(), /not configured/, 'The configured-MCP accessor is invalid at this startup stage.');
    const state = runtimeConnection(runtime, {});
    assert.equal(state.configured, configured); assert.equal(state.full, false);
    assert.equal(state.toolsCredentials, false); assert.equal(state.connectorName, CURRENT_CONNECTOR_NAME);
  }
});
