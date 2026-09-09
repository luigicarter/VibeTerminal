'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { EventEmitter } = require('node:events');
const ts = require('typescript');
const fusion = require('../../backend/fusionChatHost.cjs');
const open = require('../../backend/openFusionChatHost.cjs');
const { createSessionDirectory, installOrchestrator } = require('../../backend/orchestratorIntegration.cjs');
const { sessionReady, waitForRoutingReady } = require('../../backend/orchestratorLaunchers.cjs');
// Execute the actual host lifecycle producers, substituting only process/RPC
// boundaries. Their emitted events flow into the real directory and launcher.
function functions(file, names) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, '../../backend', file), 'utf8'), ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = node => { if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) found.push(node.getText(source)); ts.forEachChild(node, visit); };
  visit(source); assert.equal(found.length, names.length); return found.join('\n');
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function child() { const value = new EventEmitter(); value.stdin = { writable: true }; value.stdout = new EventEmitter(); value.stderr = new EventEmitter(); value.killed = false; return value; }
function harness(kind, plannerFamily) {
  const directory = createSessionDirectory(), sessions = new Map(), events = [];
  directory.updateUi([{ id: 'pane', kind, started: true, launchToken: 1 }]);
  const payload = directory.outgoing(kind, { type: 'start', payload: { id: 'pane', cwd: 'C:/fixture', plannerFamily } }).payload;
  const context = { ...fusion, ...open, sessions, Map, String, Boolean, Array, JSON, Promise,
    clonePayload: value => structuredClone(value || {}), cloneHistory: value => structuredClone(value || []),
    clearPlannerResultBackstop() {}, normalizeFusionRunMode: value => value || 'auto', normalizeFusionPlannerFamily: value => value === 'codex' ? 'codex' : 'claude',
    createFusionGateTracker: () => ({}), createOpenFusionGateTracker: () => ({ consumeNudge: () => false }),
    buildClaudeSpawn: () => ({ command: 'fixture', args: [], env: {} }),
    emitSessionEvent(id, state, event) { if (sessions.get(id) !== state) return; events.push(event); directory.ingest(kind, { id, generation: state.generation || state.launchPayload.generation, ...event }); },
    markPlannerClosed(state) { state.child = null; }, connectEvents() {}, locateClaudeTranscriptFile: () => null,
    locateCodexRollout: () => null, codexHome: () => '', path,
    killChild(value) { if (value) value.killed = true; },
    replaySession() {}, observeInteractionEvent() {}, emit() {},
    emitDirectSessionEvent(id, event, state) { directory.ingest(kind, { id, generation: state.generation, ...event }); events.push(event); },
    crypto: require('node:crypto'), PORT_TIMEOUT_MS: 30000, setTimeout, clearTimeout,
    backgroundStatusFileForEnv: () => '', writeBackgroundStatusSnapshotFile() {}, writeBackgroundStatusFile() {},
    buildServeSpawn: () => ({ command: 'fixture', args: [], options: {} }),
    clearSteerRoutingState() {}, settleAllBackgroundTasks() {},
  };
  context.stopObserver = require('../../backend/observedStop.cjs').createHostStopObserver({
    lookup: id => { const state = sessions.get(id); return kind === 'fusion' ? state?.launchPayload : state && { id, launchToken: state.launchToken, generation: state.generation }; },
    kill: value => context.killChild(value), emit: event => context.emit(event)
  });
  vm.createContext(context);
  return { context, directory, sessions, events, payload, ready: () => sessionReady(directory.get('pane')) };
}

for (const resume of [false, true]) test(`Claude Fusion ${resume ? 'resume' : 'fresh'} becomes dispatch-ready only after writable child spawn`, async () => {
  const h = harness('fusion', 'claude'), process = child(); h.context.spawn = () => process;
  vm.runInContext(functions('fusionChatHost.cjs', ['start']), h.context);
  h.context.start({ ...h.payload, ...(resume && { resumeId: 'saved' }) });
  assert.equal(h.ready(), false);
  process.emit('spawn'); assert.equal(h.ready(), true);
  const result = await waitForRoutingReady({ result: { ok: true, id: 'pane', target: { id: 'pane', generation: h.payload.generation } }, getSession: () => h.directory.get('pane'), timeoutMs: 100 });
  assert.equal(result.ok, true);
  process.emit('exit', 1); assert.equal(h.ready(), false);
});

for (const failure of ['error', 'closed-pipe', 'replaced']) test(`Claude Fusion ${failure} cannot announce acceptance readiness`, () => {
  const h = harness('fusion', 'claude'), process = child(); h.context.spawn = () => process;
  vm.runInContext(functions('fusionChatHost.cjs', ['start']), h.context); h.context.start(h.payload);
  if (failure === 'error') process.emit('error', Error('Failed to spawn'));
  else { if (failure === 'closed-pipe') process.stdin.writable = false; else h.sessions.delete('pane'); process.emit('spawn'); }
  assert.equal(h.ready(), false); assert(!h.events.some(event => event.type === 'engine-ready'));
});

for (const outcome of ['ready', 'ready-resume', 'failed', 'replaced']) test(`Codex Fusion boot ${outcome} gates routing on completed RPC initialization`, async () => {
  const h = harness('fusion', 'codex'), process = child(); let resolve, reject;
  const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
  h.context.createCodexBrainSession = () => ({ child: process, ready });
  vm.runInContext(functions('fusionChatHost.cjs', ['startCodexBrain']), h.context); h.context.startCodexBrain({ ...h.payload, ...(outcome === 'ready-resume' && { resumeId: 'saved' }) });
  assert.equal(h.ready(), false);
  if (outcome === 'failed') reject(Error('RPC initialization failed'));
  else { if (outcome === 'replaced') h.sessions.delete('pane'); resolve(); }
  await tick(); assert.equal(h.ready(), outcome.startsWith('ready'));
});

for (const resume of [false, true]) test(`Open Fusion ${resume ? 'restored' : 'fresh'} readiness cannot manufacture a running turn`, async () => {
  const h = harness('openfusion'), state = { child: child(), cwd: h.payload.cwd, generation: h.payload.generation };
  h.sessions.set('pane', state);
  h.context.request = async (_state, _method, endpoint) => endpoint.endsWith('/message')
    ? [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'Historical prompt' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Historical answer' }, { type: 'tool', tool: 'read', callID: 'old-tool', state: { status: 'completed', input: {}, output: 'Old output' } }] }]
    : { id: 'saved' };
  vm.runInContext(functions('openFusionChatHost.cjs', ['establishSession']), h.context);
  await h.context.establishSession('pane', state, resume ? 'saved' : '');
  assert.equal(h.ready(), true); assert.equal(h.directory.get('pane').turnActive, false); assert.equal(h.directory.get('pane').turnState, 'idle');
  if (resume) {
    const history = h.events.filter(event => ['assistant-text', 'tool-call', 'tool-result', 'user', 'result'].includes(event.type));
    assert(history.length >= 3); assert(history.every(event => event.replay === true));
    assert.match(JSON.stringify(history), /Historical answer/);
  }
});

test('Open Fusion stopped during resume lookup cannot publish session or readiness', async () => {
  const h = harness('openfusion'), state = { child: child(), generation: h.payload.generation }; h.sessions.set('pane', state);
  let resolve; h.context.request = () => new Promise(yes => { resolve = yes; });
  vm.runInContext(functions('openFusionChatHost.cjs', ['establishSession']), h.context);
  const pending = h.context.establishSession('pane', state, 'saved'); h.sessions.delete('pane'); resolve({ id: 'saved' }); await pending;
  assert.equal(h.ready(), false); assert.equal(h.events.length, 0);
});

function loadLifecycle(h, kind) {
  vm.runInContext(functions(kind === 'fusion' ? 'fusionChatHost.cjs' : 'openFusionChatHost.cjs',
    kind === 'fusion' ? ['start', 'stop', 'startCodexBrain'] : ['start', 'stop', 'establishSession', 'ensureSession', 'postRootPlannerInput']), h.context);
}

for (const kind of ['fusion', 'openfusion']) test(`${kind} changed live configuration starts the directory's new owner and fences old callbacks`, () => {
  const h = harness(kind, kind === 'fusion' ? 'claude' : undefined), children = [];
  h.context.spawn = () => { const value = child(); children.push(value); return value; };
  loadLifecycle(h, kind); h.context.start(h.payload);
  const replacement = h.directory.outgoing(kind, { type: 'start', payload: { ...h.payload, cwd: 'C:/another-project' } }).payload;
  assert.notEqual(replacement.generation, h.payload.generation);
  h.context.start(replacement);
  assert.equal(children.length, 2); assert.equal(children[0].killed, true);
  const current = h.sessions.get('pane');
  assert.equal(current.generation || current.launchPayload.generation, replacement.generation);
  children[0].emit('exit', 1); children[0].emit('error', Error('Late old launch error'));
  children[0].stdout.emit('data', Buffer.from('listening on http://127.0.0.1:1234\n'));
  assert.equal(h.sessions.get('pane'), current); assert.equal(h.directory.get('pane').generation, replacement.generation);
  assert(!h.events.some(event => event.type === 'closed' || event.type === 'error'));
  h.context.stop({ id: 'pane' });
});

for (const kind of ['fusion', 'openfusion']) test(`${kind} spawn error followed by close permits a real retry without an exit event`, () => {
  const h = harness(kind, kind === 'fusion' ? 'claude' : undefined), children = [];
  h.context.spawn = () => { const value = child(); children.push(value); return value; };
  loadLifecycle(h, kind); h.context.start(h.payload);
  children[0].emit('error', Error('ENOENT')); children[0].emit('close', -4058);
  assert.equal(h.sessions.get('pane').child, null); assert.equal(h.ready(), false);
  const retry = h.directory.outgoing(kind, { type: 'start', payload: h.payload }).payload;
  h.context.start(retry); assert.equal(children.length, 2);
  assert.equal(h.sessions.get('pane').generation || h.sessions.get('pane').launchPayload.generation, retry.generation);
  h.context.stop({ id: 'pane' });
});

test('Codex Fusion failed initialization retires its child and permits a real retry', async () => {
  const h = harness('fusion', 'codex'), children = [];
  h.context.createCodexBrainSession = () => { const value = child(); children.push(value); return { child: value, ready: Promise.reject(Error('Initialize failed')) }; };
  loadLifecycle(h, 'fusion'); h.context.start(h.payload); await tick();
  assert.equal(children[0].killed, true); assert.equal(h.sessions.get('pane').child, null);
  const retry = h.directory.outgoing('fusion', { type: 'start', payload: h.payload }).payload;
  h.context.start(retry); assert.equal(children.length, 2); await tick();
});

test('Open Fusion live Brain model changes preserve the host generation across remount', async () => {
  const h = harness('openfusion'), process = child(); let spawns = 0;
  h.context.spawn = () => { spawns++; return process; };
  loadLifecycle(h, 'openfusion'); h.context.start(h.payload);
  process.stdout.emit('data', Buffer.from('listening on http://127.0.0.1:1234\n')); await tick();
  assert.equal(h.ready(), true);
  vm.runInContext(functions('openFusionChatHost.cjs', ['plannerModel']), h.context);
  const change = h.directory.outgoing('openfusion', { type: 'planner-model', payload: { id: 'pane', model: 'provider/new-brain' } });
  h.context.plannerModel(change.payload);
  assert.equal(h.directory.get('pane').model, 'provider/new-brain');
  const attach = h.directory.outgoing('openfusion', { type: 'start', payload: { ...h.payload, plannerModel: 'provider/new-brain' } }).payload;
  h.context.start(attach);
  assert.equal(attach.generation, h.payload.generation); assert.equal(spawns, 1); assert.equal(h.ready(), true);
  h.context.stop({ id: 'pane' });
});

for (const resumed of [true, false]) test(`Open Fusion input waits for pending resume lookup (${resumed ? 'found' : 'missing'}) before choosing a root`, async () => {
  const h = harness('openfusion'), process = child(), calls = []; let resolveLookup;
  h.context.spawn = () => process;
  h.context.request = async (_state, method, endpoint) => {
    calls.push([method, endpoint]);
    if (method === 'GET' && endpoint === '/session/saved') return new Promise(resolve => { resolveLookup = resolve; });
    if (method === 'POST' && endpoint === '/session') return { id: 'fresh' };
    if (endpoint.endsWith('/message')) return [];
    return {};
  };
  loadLifecycle(h, 'openfusion'); h.context.start({ ...h.payload, resumeId: 'saved' });
  process.stdout.emit('data', Buffer.from('listening on http://127.0.0.1:1234\n'));
  const state = h.sessions.get('pane');
  const input = h.context.postRootPlannerInput('pane', state, 'Continue the task', 'auto', { providerID: 'provider', modelID: 'model' }, false);
  await tick(); assert.deepEqual(calls, [['GET', '/session/saved']]);
  resolveLookup(resumed ? { id: 'saved' } : {}); const result = await input;
  assert.equal(result.ok, true, result.error); assert.equal(state.sessionId, resumed ? 'saved' : 'fresh');
  assert.equal(calls.filter(([method, endpoint]) => method === 'POST' && endpoint === '/session').length, resumed ? 0 : 1);
  assert(calls.some(([method, endpoint]) => method === 'POST' && endpoint === `/session/${resumed ? 'saved' : 'fresh'}/prompt_async`));
  h.context.stop({ id: 'pane' });
});

test('Fusion clean exit and next input resume through installed Integration with UI inventory without old completion attribution', async t => {
  const h = harness('fusion', 'claude'), children = [], launches = [], writes = [];
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vibe-chat-recovery-'));
  const ipc = new EventEmitter(); ipc.handle = () => {};
  const app = new EventEmitter(); app.getPath = () => root; app.isPackaged = false;
  const main = { isDestroyed: () => false, webContents: new EventEmitter() };
  main.webContents.send = (channel, payload) => {
    if (channel !== 'orchestrator:ui-action' || payload.kind !== 'inventory') return;
    queueMicrotask(() => ipc.emit('orchestrator:ui-result', { sender: main.webContents }, { id: payload.id,
      result: { ok: true, projectPaths: [root], sessions: [{ id: 'pane', kind: 'fusion', cwd: root, started: true, launchToken: 1 }] } }));
  };
  const integration = installOrchestrator({ app, BrowserWindow: { getAllWindows: () => [main] }, ipcMain: ipc, screen: {}, shell: {},
    safeStorage: { isEncryptionAvailable: () => false }, getMainWindow: () => main, getRuntime: () => ({ listSnapshots: () => [] }),
    sendPty: () => true, sendFusion: () => true, sendOpenFusion: () => true, getTelemetry: () => ({}), getChanges: () => ({}) });
  t.after(async () => { await integration.dispose(); assert(path.resolve(root).startsWith(path.join(require('node:os').tmpdir(), 'vibe-chat-recovery-'))); fs.rmSync(root, { recursive: true, force: true }); });
  await integration.refreshInventory();
  h.directory = integration.directory;
  h.payload = integration.outgoing('fusion', { type: 'start', payload: { ...h.payload, cwd: root } }).payload;
  h.ready = () => sessionReady(integration.directory.get('pane'));
  h.context.spawn = () => { const value = child(); value.stdin.write = line => writes.push(JSON.parse(line)); children.push(value); return value; };
  h.context.buildClaudeSpawn = payload => { launches.push(payload); return { command: 'fixture', args: [], env: {} }; };
  h.context.createFusionGateTracker = () => ({ consumeNudge: () => false, observe: event => event });
  h.context.cloneEvent = value => structuredClone(value);
  h.context.MAX_HISTORY_EVENTS = 4000; h.context.setImmediate = setImmediate;
  h.context.settleOrphanedBackgroundTasks = () => {};
  h.context.emit = envelope => { h.events.push(envelope.event); integration.incoming('fusion', { id: envelope.id, generation: envelope.generation, ...envelope.event }); };
  loadLifecycle(h, 'fusion');
  vm.runInContext(functions('fusionChatHost.cjs', ['emitSessionEvent', 'restartCleanClosedSession', 'markPlannerClosed', 'input']), h.context);
  h.context.start(h.payload); children[0].emit('spawn');
  const first = h.sessions.get('pane');
  h.context.emitSessionEvent('pane', first, { type: 'session', sessionId: 'native-root' });
  h.directory.outgoing('fusion', { type: 'input', payload: { id: 'pane', actionId: 'old-action' } });
  h.context.emitSessionEvent('pane', first, { type: 'turn-start' });
  h.context.emitSessionEvent('pane', first, { type: 'assistant-text', text: 'Previous answer' });
  h.context.emitSessionEvent('pane', first, { type: 'result', subtype: 'success' });
  const oldTurn = h.directory.get('pane').completedTurnId;
  children[0].emit('exit', 0); assert.equal(h.ready(), false);
  for (const fields of [{ generation: 'older-generation' }, { generation: undefined }, { replay: true }]) {
    assert.equal(integration.incoming('fusion', { id: 'pane', generation: h.payload.generation, type: 'engine-restarting', ...fields }), false);
  }
  assert.equal(integration.incoming('openfusion', { id: 'pane', generation: h.payload.generation, type: 'engine-restarting' }), false);
  for (const type of ['engine-ready', 'session', 'assistant-text']) {
    assert.equal(integration.incoming('fusion', { id: 'pane', generation: h.payload.generation, type, sessionId: 'late-root', text: 'Late output' }), false);
  }
  h.context.emitSessionEvent('pane', first, { type: 'engine-ready' }); assert.equal(h.ready(), false, 'late ready cannot revive an exited owner');
  h.context.input({ id: 'pane', text: 'Continue' });
  assert.equal(children.length, 2); assert.equal(launches[1].resumeId, 'native-root');
  assert.equal(h.directory.get('pane').generation, h.payload.generation); assert.equal(h.ready(), false);
  children[1].emit('spawn'); assert.equal(h.ready(), true);
  assert.equal(writes.length, 1);
  assert.equal(h.directory.get('pane').completedTurnId, undefined);
  assert.equal(h.directory.readChat({ id: 'pane', generation: h.payload.generation, completedTurnId: oldTurn }).completedResult.actionId, 'old-action');
  h.context.emitSessionEvent('pane', h.sessions.get('pane'), { type: 'turn-start' });
  assert.notEqual(h.directory.get('pane').turnId, oldTurn);
  assert.equal(h.directory.get('pane').activeActionId, undefined);
  children[1].emit('exit', 0);
  h.directory.outgoing('fusion', { type: 'stop', payload: { id: 'pane' } });
  h.context.stop({ id: 'pane' });
  assert.equal(integration.incoming('fusion', { id: 'pane', generation: h.payload.generation, type: 'engine-restarting' }), false);
  assert.equal(integration.incoming('fusion', { id: 'pane', generation: h.payload.generation, type: 'engine-ready' }), false);
  assert.equal(h.ready(), false); assert.notEqual(h.directory.get('pane').generation, h.payload.generation);
  const replacement = integration.outgoing('fusion', { type: 'start', payload: h.payload }).payload;
  integration.incoming('fusion', { id: 'pane', generation: replacement.generation, type: 'closed', code: 0 });
  assert.equal(integration.incoming('fusion', { id: 'pane', generation: h.payload.generation, type: 'engine-restarting' }), false);
  integration.outgoing('fusion', { type: 'stop', payload: { id: 'pane' } });
  integration.directory.updateUi([]);
  assert.equal(integration.incoming('fusion', { id: 'pane', generation: replacement.generation, type: 'engine-restarting' }), false, 'no UI fallback cannot revive an explicitly stopped owner');
});

test('Open Fusion stop during pending resume prevents queued input from creating or submitting another conversation', async () => {
  const h = harness('openfusion'), process = child(), calls = []; let resolveLookup;
  h.context.spawn = () => process;
  h.context.request = (_state, method, endpoint) => { calls.push([method, endpoint]); return new Promise(resolve => { resolveLookup = resolve; }); };
  loadLifecycle(h, 'openfusion'); h.context.start({ ...h.payload, resumeId: 'saved' });
  process.stdout.emit('data', Buffer.from('listening on http://127.0.0.1:1234\n'));
  const input = h.context.postRootPlannerInput('pane', h.sessions.get('pane'), 'Continue', 'auto', {}, false);
  h.context.stop({ id: 'pane' }); resolveLookup({ id: 'saved' });
  assert.equal((await input).ok, false); assert.deepEqual(calls, [['GET', '/session/saved']]);
});
