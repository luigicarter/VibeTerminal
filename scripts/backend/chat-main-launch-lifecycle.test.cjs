'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = ts.createSourceFile('main.cjs', fs.readFileSync(path.join(__dirname, '../../backend/main.cjs'), 'utf8'), ts.ScriptTarget.Latest, true);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture({ cleanup } = {}) {
  const handlers = {}, effects = [], prepared = [], preparations = [];
  const telemetry = {
    prepareFusionFiles: prepare, prepareOpenFusionFiles: prepare,
    async stopFusionSession(id) { effects.push({ type: 'cleanup', id }); await cleanup?.(); },
    releaseSession(id) { effects.push({ type: 'release', id }); }
  };
  function prepare(id, options) {
    const gate = deferred(); preparations.push({ id, options, gate });
    return gate.promise.then(() => {
      prepared.push(options.cwd);
      return { env: { VIBE_TERMINAL_OPEN_FUSION_PLANNER_MODEL: 'brain', VIBE_TERMINAL_OPEN_FUSION_EXECUTOR_MODEL: 'worker' } };
    });
  }
  const context = { ipcMain: { handle(name, fn) { handlers[name] = fn; } },
    chatLaunchPreparation: require('../../backend/chatLaunchPreparation.cjs').createChatLaunchPreparation(),
    resolveLaunchCwd: cwd => ({ ok: true, cwd }), getDefaultRuntimeCwd: () => 'C:/fixture',
    startFusionChatHost() {}, startOpenFusionChatHost() {}, getAgentTelemetry: () => telemetry,
    resolveCodexBin: () => 'fixture-codex', resolveProviderEnv: () => undefined,
    normalizeFusionFamily: (value, fallback) => value || fallback,
    normalizeFusionCodexModel: value => value, normalizeFusionModel: value => value,
    suppressAnthropicOnlyModel: value => value, normalizeFusionCodexEffort: value => value,
    normalizeFusionEffort: value => value, normalizeFusionClaudeExecutorModel: value => value,
    normalizeFusionClaudeRoleEffort: value => value, normalizeFusionRunMode: value => value || 'auto',
    normalizeFusionBoolean: value => value === true, normalizeOpenFusionModel: value => value,
    OPEN_FUSION_MODEL_UNSET: '', getBuildSupervisorDir: () => 'fixture-builds',
    fusionClaudeTools: () => [], fusionClaudeAllowedTools: () => [], fusionClaudeDisallowedTools: () => [],
    sendToFusionChatHost: message => { effects.push(message); return true; },
    sendToOpenFusionChatHost: message => { effects.push(message); return true; },
    app: { on(name, fn) { handlers[name] = fn; }, quit() {} },
    orchestratorIntegration: null, terminalRuntime: null, agentTelemetry: null, buildSupervisor: null,
    ptyHost: null, agentThreadHost: null, fusionChatHost: null, openFusionChatHost: null,
    process: { env: {}, platform: 'win32' }, Promise, Map
  };
  const names = new Set(['fusion-chat:start', 'fusion-chat:stop', 'openfusion-chat:start', 'openfusion-chat:stop']);
  const selected = source.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
    (node.expression.expression.getText(source) === 'ipcMain.handle' && names.has(node.expression.arguments[0]?.text) ||
      node.expression.expression.getText(source) === 'app.on' && node.expression.arguments[0]?.text === 'window-all-closed'));
  assert.equal(selected.length, 5);
  vm.runInNewContext(selected.map(node => node.getText(source)).join('\n'), context);
  return { handlers, effects, prepared, preparations };
}

for (const kind of ['fusion', 'openfusion']) test(`${kind} stop during file preparation never starts a retired pane`, async () => {
  const f = fixture();
  const start = f.handlers[`${kind}-chat:start`](null, { id: 'pane', cwd: 'C:/first' });
  await tick(); assert.equal(f.preparations.length, 1);
  f.handlers[`${kind}-chat:stop`](null, { id: 'pane' });
  f.preparations[0].gate.resolve();
  const result = await start; await tick();
  assert.equal(f.effects.filter(event => event.type === 'start').length, 0, 'A stopped pane must never reach the host after preparation');
  assert.equal(result.ok, false); assert.equal(result.cancelled, true);
});

for (const kind of ['fusion', 'openfusion']) test(`${kind} replacement preparation cannot be overwritten by an earlier launch`, async () => {
  const f = fixture();
  const first = f.handlers[`${kind}-chat:start`](null, { id: 'pane', cwd: 'C:/first' });
  await tick();
  const second = f.handlers[`${kind}-chat:start`](null, { id: 'pane', cwd: 'C:/second' });
  await tick();
  assert.equal(f.preparations.length, 1, 'Per-pane files must not be written by overlapping preparations');
  f.preparations[0].gate.resolve(); await tick();
  assert.equal(f.preparations.length, 2);
  f.preparations[1].gate.resolve();
  assert.equal((await first).cancelled, true); assert.equal((await second).ok, true);
  assert.deepEqual(f.prepared, ['C:/first', 'C:/second']);
  assert.deepEqual(f.effects.filter(event => event.type === 'start').map(event => event.payload.cwd), ['C:/second']);
});

test('stopping a preparing pane serializes cleanup before a new launch', async () => {
  const gate = deferred(), f = fixture({ cleanup: () => gate.promise });
  const first = f.handlers['fusion-chat:start'](null, { id: 'pane', cwd: 'C:/first' });
  await tick(); f.handlers['fusion-chat:stop'](null, { id: 'pane' });
  const next = f.handlers['fusion-chat:start'](null, { id: 'pane', cwd: 'C:/next' });
  f.preparations[0].gate.resolve(); await first; await tick();
  assert.equal(f.preparations.length, 1, 'Cleanup owns shared files until settled');
  assert.equal(f.effects.filter(event => event.type === 'release').length, 0);
  gate.resolve(); await tick();
  assert.equal(f.preparations.length, 2); assert.equal(f.effects.filter(event => event.type === 'release').length, 1);
  f.preparations[1].gate.resolve(); assert.equal((await next).ok, true);
  assert.deepEqual(f.effects.filter(event => event.type === 'start').map(event => event.payload.cwd), ['C:/next']);
});

for (const kind of ['fusion', 'openfusion']) test(`${kind} app shutdown retires preparation without reviving a host`, async () => {
  const f = fixture();
  const first = f.handlers[`${kind}-chat:start`](null, { id: 'pane', cwd: 'C:/first' });
  await tick(); f.handlers['window-all-closed'](); f.preparations[0].gate.resolve();
  assert.equal((await first).cancelled, true);
  assert.equal(f.effects.filter(event => event.type === 'start').length, 0);
});

test('a blocked pane preparation cannot hold up an independent pane', async () => {
  const f = fixture();
  const first = f.handlers['fusion-chat:start'](null, { id: 'first', cwd: 'C:/first' });
  const second = f.handlers['openfusion-chat:start'](null, { id: 'second', cwd: 'C:/second' });
  await tick(); assert.equal(f.preparations.length, 2);
  f.preparations[1].gate.resolve(); assert.equal((await second).ok, true);
  assert.equal(f.effects.find(event => event.type === 'start').payload.id, 'second');
  f.preparations[0].gate.resolve(); assert.equal((await first).ok, true);
});

test('a stop before queued work starts never prepares its files', async () => {
  const f = fixture();
  const first = f.handlers['fusion-chat:start'](null, { id: 'pane', cwd: 'C:/first' });
  f.handlers['fusion-chat:stop'](null, { id: 'pane' });
  assert.equal((await first).cancelled, true); await tick();
  assert.equal(f.preparations.length, 0);
  assert.equal(f.effects.filter(event => event.type === 'start').length, 0);
});
