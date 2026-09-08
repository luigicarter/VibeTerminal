'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { installOrchestrator } = require('../../backend/orchestratorIntegration.cjs');
const { createOperatorObservations } = require('../../backend/orchestratorOperator.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 300; i++) { if (predicate()) return; await tick(); } assert.fail('Expected busy delivery checkpoint was not reached.'); }
async function fixture(t, provider = 'codex') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-busy-integration-'));
  const ipc = new EventEmitter(); ipc.handlers = new Map(); ipc.handle = (name, fn) => ipc.handlers.set(name, fn);
  const app = new EventEmitter(); app.getPath = () => root;
  const main = { isDestroyed: () => false, webContents: new EventEmitter() };
  const snapshot = { id: 'p', generation: 'g', launchToken: 1, provider, kind: provider, name: 'Worker', cwd: root,
    observation: 'observed', processState: 'running', agentProcessState: 'running', agentPid: 42,
    turnId: 'current-turn', turnStartedAt: Date.now() - 1000, turnState: 'running', revision: 1, childActivity: true };
  const f = { root, snapshot, sent: [] };
  main.webContents.send = (channel, request) => {
    if (channel === 'orchestrator:ui-action' && request.kind === 'inventory') queueMicrotask(() => ipc.emit('orchestrator:ui-result', { sender: main.webContents }, { id: request.id,
      result: { ok: true, sessions: [{ id: 'p', kind: provider, name: 'Worker', cwd: root, started: true, launchToken: 1 }], projectPaths: [root] } }));
  };
  const integration = f.integration = installOrchestrator({ app, ipcMain: ipc, BrowserWindow: { getAllWindows: () => [main] }, screen: {},
    shell: {}, safeStorage: { isEncryptionAvailable: () => false }, getMainWindow: () => main, getRuntime: () => ({ listSnapshots: () => [snapshot] }),
    getTelemetry: () => ({}), getChanges: () => ({}), sendFusion: () => false, sendOpenFusion: () => false,
    sendPty: message => { f.sent.push(message); queueMicrotask(() => integration.incoming('terminal', { type: 'action-result', id: 'p', generation: 'g', actionId: message.payload.actionId, ok: true, status: 'written', ...f.hostResult })); return true; } });
  f.invoke = (name, payload = {}) => ipc.handlers.get(`orchestrator:${name}`)({ sender: main.webContents }, payload);
  f.event = event => integration.incoming('terminal', { id: 'p', generation: 'g', ...event });
  await integration.refreshInventory();
  f.event({ type: 'created', cols: 80, rows: 24, inputRevision: 0 });
  f.event({ type: 'agent-process', phase: 'start', pid: 42 });
  f.event({ type: 'data', sequence: 1, data: 'Agent working; task composer remains available.\r\n> ' });
  await f.invoke('dispatch', { kind: 'read_session', target: { id: 'p', generation: 'g' } });
  f.send = text => f.invoke('dispatch', { kind: 'send_prompt', target: { id: 'p', generation: 'g' }, text, operator: true, requestId: 'request', observationSequence: 1, inputRevision: 0 });
  t.after(async () => { await integration.dispose(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('vibe-busy-integration-')); fs.rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('real routing submits a pure prompt to working Codex with background activity', async t => {
  const f = await fixture(t);
  const result = await f.send('Also review error handling.');
  assert.equal(result.ok, true, JSON.stringify({ result, session: f.integration.directory.get('p') })); assert.equal(result.inputDisposition, 'submitted-while-running');
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].payload.kind, 'interaction');
  assert.equal(f.sent[0].payload.text, 'Also review error handling.'); assert.equal(f.sent[0].payload.submit, true);
  assert.equal(f.sent[0].payload.keys, undefined); assert.equal(f.sent[0].payload.editInput, undefined);
});

test('unsupported busy composer queues the same prompt and later dispatches when ready', async t => {
  const f = await fixture(t, 'claude');
  const result = await f.send('Review this after the current work.');
  assert.equal(result.status, 'queued', JSON.stringify(result)); assert.equal(f.sent.length, 0);
  Object.assign(f.snapshot, { turnState: 'completed', turnEndedAt: Date.now(), childActivity: false });
  f.event({ type: 'input-state', inputRevision: 0 });
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0].payload.kind, 'input'); assert.equal(f.sent[0].payload.promptText, 'Review this after the current work.');
  assert.equal(f.sent[0].payload.recipientEvidence.state, 'idle');
});

test('cancellation removes a queued busy prompt without touching the running terminal', async t => {
  const f = await fixture(t, 'claude'); assert.equal((await f.send('A followup.')).status, 'queued');
  await f.invoke('cancel'); Object.assign(f.snapshot, { turnState: 'completed', childActivity: false }); f.event({ type: 'input-state', inputRevision: 0 }); await tick(); await tick();
  assert.equal(f.sent.length, 0);
});

test('uncertain busy write and occupied input never become an automatic queued replay', async t => {
  for (const hostResult of [{ ok: false, status: 'unknown' }, { ok: false, status: 'input-buffer-occupied', delivery: 'not-dispatched' }]) {
    const f = await fixture(t); f.hostResult = hostResult;
    const result = await f.send('Preserve this request.'); assert.equal(result.status, hostResult.status);
    Object.assign(f.snapshot, { turnState: 'completed', childActivity: false }); f.event({ type: 'input-state', inputRevision: 0 }); await tick(); await tick();
    assert.equal(f.sent.length, 1);
  }
});

test('busy prompt exception retains root and turn boundaries while native controls ignore only metadata churn', () => {
  const observations = createOperatorObservations();
  const session = { id: 'p', generation: 'g', kind: 'codex', provider: 'codex', observation: 'observed', processState: 'running', agentProcessState: 'running', agentPid: 42, turnState: 'running', turnId: 't', turnStartedAt: 10, revision: 1 };
  const screen = { ok: true, id: 'p', generation: 'g', sequence: 1, inputRevision: 2 };
  const token = observations.observe(session, screen);
  const action = { kind: 'send_prompt', target: { id: 'p', generation: 'g' }, text: 'Additional instruction', observationSequence: 1, inputRevision: 2 };
  assert.ok(observations.authorize(token, { ...session, revision: 99 }, action));
  for (const patch of [{ agentPid: 43 }, { turnId: 'new' }, { turnStartedAt: 11 }, { pendingInteraction: true }, { manualInputPending: true }, { observation: 'unknown' }, { agentProcessState: 'exited' }]) assert.throws(() => observations.authorize(token, { ...session, revision: 99, ...patch }, action), /changed/);
  assert.ok(observations.authorize(token, { ...session, revision: 99 }, { ...action, kind: 'terminal_interact', submit: true }));
  assert.throws(() => observations.authorize(token, { ...session, revision: 99, turnId: 'new-turn' }, { ...action, kind: 'terminal_interact', submit: true }), /changed/);
  const claude = { ...session, kind: 'claude', provider: 'claude' };
  const queuedToken = observations.observe(claude, screen);
  assert.ok(observations.authorize(queuedToken, { ...claude, revision: 99 }, action), 'unsupported busy provider can reach its queued delivery path');
});

for (const shifted of [false, true]) test(`core protects ${shifted ? 'the actual prewrite turn' : 'the original turn'} before busy-write acknowledgement without extra Enter`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-busy-core-'));
  const session = { id: 'p', generation: 'g', kind: 'codex', provider: 'codex', cwd: root, name: 'Worker', observation: 'observed',
    processState: 'running', agentProcessState: 'running', agentPid: 42, turnState: 'running', turnId: 'old-turn', turnStartedAt: Date.now() - 1000, revision: 1, childActivity: true };
  const effects = []; let round = 0, app;
  const tool = args => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `round-${round}`, function: { name: 'workspace', arguments: JSON.stringify(args) } }] } }] });
  app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false }, getSessions: () => [session], getRoots: () => ({ documents: root, projects: [] }),
    interpretIntent: context => ({ goal: context.instruction, actions: [{ kind: 'operate_terminal', targetIds: ['p'], text: context.instruction }] }),
    readSession: async () => ({ ok: true, id: 'p', generation: 'g', sequence: round, inputRevision: 0, text: 'Codex task composer available while working.' }),
    dispatchAction: async action => {
      effects.push(action);
      assert.equal(action.promptObservation.turnId, 'old-turn');
      if (shifted) session.turnId = 'intervening-turn';
      const deliveryBaseline = { kind: 'codex', submittedAt: Date.now(), turnId: session.turnId, turnState: session.turnState };
      if (shifted) app.prepareDelivery({ actionId: action.actionId, id: 'p', generation: 'g', ok: true, status: 'unconfirmed', inputDisposition: 'submitted-while-running', deliveryBaseline });
      // A current-turn event may arrive before the transport receipt. Its action
      // tag must not turn preexisting work into completion of the new followup.
      Object.assign(session, { turnState: 'completed', childActivity: false, completedTurnId: session.turnId, completedActionId: action.actionId, actionId: action.actionId, turnEndedAt: Date.now() });
      app.observeWork([{ ...session }]);
      return { ok: true, status: 'written', inputDisposition: 'submitted-while-running', deliveryBaseline };
    }, fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'model', context_length: 128000, supported_parameters: ['tools'] }] }));
      const body = JSON.parse(options.body); round++;
      const metadata = JSON.parse(body.messages[1].content), latest = body.messages.findLast(item => item.role === 'tool');
      const observed = latest && JSON.parse(latest.content);
      let result;
      if ([1, 3].includes(round)) result = tool({ kind: 'read_session', targetId: 'p' });
      else if (round === 2) { session.revision++; result = tool({ kind: 'send_prompt', targetId: 'p', grantId: metadata.authorizedCommands.grants[0].id, stepId: 'send-once', observationToken: observed.observationToken, text: 'Also review error handling.' }); }
      else if (round === 4) result = tool({ kind: 'finish_terminal', targetId: 'p', grantId: metadata.authorizedCommands.grants[0].id, stepId: 'finish', observationToken: observed.observationToken, outcome: 'completed', text: 'Submitted the followup while Codex was working.' });
      else { assert.equal(round, 5); result = { choices: [{ finish_reason: 'stop', message: { content: 'Submitted the followup while Codex was working.' } }] }; }
      return new Response(JSON.stringify(result));
    } });
  t.after(async () => { await app.dispose(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('vibe-busy-core-')); fs.rmSync(root, { recursive: true, force: true }); });
  await app.configure({ apiKey: 'fixture', sessionOnly: true, model: 'model' }); await app.setEnabled(true);
  const result = await app.send({ text: 'Also review error handling.', targetId: 'p', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(effects.length, 1); assert.equal(effects[0].kind, 'send_prompt');
  assert.equal(app.getState().tasks.find(task => task.requestId === result.requestId).status, 'waiting-results');
  assert.ok(!app.getState().messages.some(message => message.requestId === result.requestId && message.status === 'completed'));
});


for (const changed of [false, true]) for (const operator of [false, true]) test(`explicit ${operator ? 'operator' : 'IPC'} queue ${changed ? 'rejects a replacement native conversation' : 'delivers once to its original native conversation'}`, async t => {
  const f = await fixture(t, 'claude');
  f.snapshot.conversation = { id: 'conversation-A', provider: 'claude' };
  const result = await f.invoke('dispatch', { kind: 'send_prompt', target: { id: 'p', generation: 'g' }, text: 'Continue conversation A only.',
    ...(operator && { operator: true, requestId: 'request', observationSequence: 1, inputRevision: 0 }) });
  assert.equal(result.status, 'queued', JSON.stringify(result));
  assert.equal(f.sent.length, 0);
  Object.assign(f.snapshot, { conversation: { id: changed ? 'conversation-B' : 'conversation-A', provider: 'claude' }, turnState: 'completed', turnId: 'ending-turn', turnEndedAt: Date.now(), childActivity: false });
  await f.integration.refreshInventory();
  assert.equal(f.sent.length, changed ? 0 : 1);
  if (!changed) assert.equal(f.sent[0].payload.promptText, 'Continue conversation A only.');
  else {
    assert.ok(f.integration.getState().receipts.some(item => item.status === 'conversation-changed'), JSON.stringify(f.integration.getState().receipts));
  }
  await f.integration.refreshInventory();
  assert.equal(f.sent.length, changed ? 0 : 1, 'Repeated readiness cannot replay the prompt');
});

test('an explicit send preserves a stronger supplied conversation binding when the current baseline has no native ID', async t => {
  const f = await fixture(t, 'claude');
  const binding = { target: { id: 'p', generation: 'g', launchToken: 1 }, nativeIdentity: { provider: 'claude', home: 'global', workspace: f.root, id: 'conversation-A' } };
  const result = await f.invoke('dispatch', { kind: 'send_prompt', target: { id: 'p', generation: 'g' }, text: 'Only A.', routingBinding: binding });
  assert.equal(result.ok, false);
  assert.equal(result.delivery, 'not-dispatched');
  assert.equal(result.reason, 'conversation-changed');
  assert.equal(f.sent.length, 0);
});
