'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
const { createAgentTelemetryManager, openCodePluginSource } = require('../../backend/agentTelemetry.cjs');
const { createSessionDirectory } = require('../../backend/orchestratorIntegration.cjs');
const { createTerminalInput } = require('../../backend/orchestratorTerminalInput.cjs');
const { createOrchestratorDelivery } = require('../../backend/orchestratorDelivery.cjs');
const { createCompletionEvidence } = require('../../backend/orchestratorCompletion.cjs');
const { validateResultEvidence } = require('../../backend/orchestratorResultReports.cjs');

function fixture(options = {}) {
  let time = 1000;
  const runtime = createTerminalRuntime({ now: () => ++time, ...options });
  const directory = createSessionDirectory({ getRuntime: () => runtime });
  directory.updateUi([{ id: 'pane', kind: options.provider || 'opencode', cwd: process.cwd() }]);
  const launch = runtime.beginLaunch({ id: 'pane', launchToken: 1, provider: options.provider || 'opencode', cwd: process.cwd() });
  const ingest = event => { runtime.ingest(event); directory.ingest('terminal', event); };
  const event = (type, fields = {}) => ingest({ id: 'pane', generation: launch.generation, type, ...fields });
  event('created', { cols: 100, rows: 28 });
  event('agent-process', { phase: 'start', processId: 'root-process', pid: 42 });
  const get = () => directory.get('pane');
  const observation = () => ({ ok: true, id: 'pane', generation: get().generation, sequence: 7,
    inputRevision: 0, cols: 100, rows: 28, text: 'Agent reported its findings.', outputAt: time + 100 });
  return { runtime, directory, launch, ingest, event, get, observation };
}

function assertAmbiguous(s) {
  assert.equal(s.conversation.id, 'root-A', 'Original reference remains diagnostic history');
  assert.equal(s.binding.status, 'ambiguous');
  assert.equal(s.observation, 'unavailable');
  assert.equal(s.turnState, 'unknown');
  for (const key of ['turnId', 'turnStartedAt', 'turnEndedAt', 'attention', 'lastTool', 'pendingInput']) assert.equal(s[key], undefined, key);
  assert.deepEqual(s.activeTools, []);
  assert.deepEqual(s.children, []);
  assert.equal(s.childActivity, false);
}

test('generated OpenCode producer through authenticated HTTP invalidates recipients, including queued input', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-native-root-ambiguity-'));
  const h = fixture();
  const events = [];
  const manager = createAgentTelemetryManager({ baseDir: path.join(root, 'shims'), openCodeHome: path.join(root, 'opencode-home'),
    emit: event => { events.push(event); h.ingest(event); } });
  t.after(() => {
    manager.cleanup(); h.runtime.dispose();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('vibe-native-root-ambiguity-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const instrument = await manager.prepareSession('pane', { generation: h.launch.generation, provider: 'opencode' });
  const factory = vm.runInNewContext(openCodePluginSource().replace('export const VibeTerminalNotify', 'const VibeTerminalNotify') + '; VibeTerminalNotify;',
    { process: { env: instrument.env }, fetch, AbortSignal, Date });
  const plugin = await factory();
  const send = (type, properties) => plugin.event({ event: { type, properties } });
  await send('session.created', { info: { id: 'root-A', title: 'Original', directory: process.cwd() } });
  await send('session.status', { sessionID: 'root-A', status: { type: 'busy' } });
  assert.equal(h.get().turnState, 'running');
  const writes = [];
  const write = async payload => { writes.push(payload); return { ok: true, status: 'written' }; };
  const delivery = createOrchestratorDelivery({ getSession: h.get, write });
  const input = createTerminalInput({ getSession: h.get, readSession: async () => h.observation(), write });
  t.after(() => { delivery.dispose(); input.dispose(); });
  const action = { target: { id: 'pane', generation: h.launch.generation }, actionId: 'queued', text: 'Continue the task' };
  assert.equal((await delivery.submit(action)).status, 'queued');

  // This is the genuine installed plugin schema, not a forged runtime event.
  await send('session.created', { info: { id: 'root-B', title: 'Another root', directory: process.cwd() } });
  assert.equal(events.at(-1).rootVerified, true);
  assert.equal(events.at(-1).generation, h.launch.generation);
  assertAmbiguous(h.get());
  await send('session.status', { sessionID: 'root-B', status: { type: 'busy' } });
  await send('session.idle', { sessionID: 'root-B' });
  await send('session.updated', { info: { id: 'root-A', title: 'Delayed old root' } });
  await send('session.idle', { sessionID: 'root-A' });
  assertAmbiguous(h.get());
  await delivery.pump();
  assert.equal((await delivery.submit({ ...action, actionId: 'fresh' })).status, 'blocked');
  const native = await input.handle({ ...action, actionId: 'operator', operator: true, requestId: 'request',
    observationSequence: 7, inputRevision: 0, submit: true, promptSubmission: true });
  assert.equal(native.status, 'recipient-unavailable');
  assert.equal(native.delivery, 'not-dispatched');
  assert.deepEqual(writes, []);
  // Manual PTY input uses generation matching, not native automation admission.
  assert.equal(h.runtime.matches({ id: 'pane', generation: h.launch.generation }), true);
  assert.equal(h.runtime.recordInput({ id: 'pane', generation: h.launch.generation, data: 'manual input\r' }), null);
  assertAmbiguous(h.get());
});

test('conflict retires completion evidence and never recovers from old callbacks or metadata', async t => {
  let resolveLookup;
  const h = fixture({ provider: 'codex', capabilities: () => ({ finalCompletion: 'authoritative' }),
    lookup: () => new Promise(resolve => { resolveLookup = resolve; }) });
  t.after(() => h.runtime.dispose());
  h.event('agent-running', { providerThreadId: 'root-A', providerTurnId: 'turn-A', rootVerified: true });
  h.event('agent-attention', { providerThreadId: 'root-A', providerTurnId: 'turn-A', attention: { state: 'completed' } });
  const evidence = createCompletionEvidence({ getSession: h.get, readObservation: async () => h.observation() });
  t.after(() => evidence.clear());
  const cached = await evidence.capture(h.get());
  assert.ok(validateResultEvidence(h.get(), cached), 'Control: the original observed completion was usable');
  const refresh = h.runtime.refresh();
  await new Promise(setImmediate);
  h.event('agent-session', { providerThreadId: 'root-B', rootVerified: true, phase: 'update' });
  assertAmbiguous(h.get());
  resolveLookup({ status: 'found', rootVerified: true, threadRef: { id: 'root-A', title: 'Late lookup' } });
  await refresh;
  h.event('agent-running', { providerThreadId: 'root-A', providerTurnId: 'later-A', rootVerified: true });
  h.event('agent-attention', { providerThreadId: 'root-A', providerTurnId: 'later-A', rootVerified: true, attention: { state: 'completed' } });
  h.event('agent-process', { phase: 'start', processId: 'root-process', pid: 42 });
  assertAmbiguous(h.get());
  assert.equal(await evidence.capture(h.get()), undefined);
  assert.equal(evidence.get(h.get()), undefined);
  assert.deepEqual(evidence.get(h.get(), 'turn-A'), cached, 'Explicit historical evidence is retained');
  assert.equal(validateResultEvidence(h.get(), cached), undefined, 'Historical completion cannot finish current work');

  const next = h.runtime.beginLaunch({ id: 'pane', launchToken: 2, provider: 'codex', cwd: process.cwd() });
  h.runtime.ingest({ id: 'pane', generation: next.generation, type: 'created' });
  h.runtime.ingest({ id: 'pane', generation: next.generation, type: 'agent-session', phase: 'start', providerThreadId: 'root-B', rootVerified: true });
  assert.equal(h.get().binding.status, 'found');
  assert.equal(h.get().conversation.id, 'root-B');
  assert.equal(h.get().observation, 'observed');
  assert.equal(h.get().turnState, 'idle');
});

test('explicit child, subagent, stale-generation and unverified identities never trigger root ambiguity', t => {
  const h = fixture();
  t.after(() => h.runtime.dispose());
  h.event('agent-running', { providerThreadId: 'root-A', rootVerified: true });
  for (const child of [{ parentThreadId: 'root-A', rootVerified: true }, { transcriptKind: 'subagent', rootVerified: true }, { rootVerified: false }, {}]) {
    h.event('agent-running', { providerThreadId: 'child', ...child });
    assert.equal(h.get().binding.status, 'found');
    assert.equal(h.get().children[0].id, 'child');
    h.event('agent-attention', { providerThreadId: 'child', attention: { state: 'completed' }, ...child });
    assert.equal(h.get().children[0].observation, 'provisional');
    h.event('agent-session', { providerThreadId: 'child', phase: 'end', ...child });
    assert.deepEqual(h.get().children, []);
    assert.equal(h.get().turnState, 'running');
  }
  h.event('agent-subagent', { providerThreadId: 'child', rootVerified: true, taskId: 'task', phase: 'start' });
  assert.equal(h.get().binding.status, 'found');
  h.event('agent-session', { generation: 'stale', providerThreadId: 'other-root', rootVerified: true });
  assert.equal(h.get().binding.status, 'found');
});

test('conflict arriving during checked input observation prevents bytes; manual IPC remains usable', async t => {
  const h = fixture();
  t.after(() => h.runtime.dispose());
  h.event('agent-session', { providerThreadId: 'root-A', rootVerified: true, phase: 'start' });
  const writes = [];
  const input = createTerminalInput({ getSession: h.get, readSession: async () => {
    h.event('agent-session', { providerThreadId: 'root-B', rootVerified: true, phase: 'update' });
    return h.observation();
  }, write: async payload => { writes.push(payload); return { ok: true }; } });
  t.after(() => input.dispose());
  const result = await input.handle({ target: { id: 'pane', generation: h.launch.generation }, actionId: 'race',
    observationSequence: 7, text: 'Task input', submit: true, promptSubmission: true });
  assert.equal(result.delivery, 'not-dispatched');
  assert.deepEqual(writes, []);
  assertAmbiguous(h.get());

  // Execute the actual main-process manual IPC handlers with the real runtime.
  const main = fs.readFileSync(path.resolve(__dirname, '../../backend/main.cjs'), 'utf8');
  const start = main.indexOf('function scopedTerminalPayload(');
  const end = main.indexOf('ipcMain.handle("terminal:resize"', start);
  assert.ok(start >= 0 && end > start);
  const handlers = {}, manualWrites = [];
  vm.runInNewContext(main.slice(start, end), { terminalRuntime: h.runtime,
    ipcMain: { handle: (name, handler) => { handlers.handle = handler; }, on: (name, handler) => { handlers.on = handler; } },
    sendToPtyHost: message => manualWrites.push(message) });
  const payload = { id: 'pane', generation: h.launch.generation, data: 'Human input\r' };
  assert.equal(handlers.handle({}, payload), true);
  handlers.on({}, payload);
  assert.equal(manualWrites.length, 2);
  assert.ok(manualWrites.every(message => message.type === 'input' && message.payload.data === payload.data));
  assertAmbiguous(h.get());
});
