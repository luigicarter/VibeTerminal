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

test('an idle-only prompt observed while idle refuses later busy dispatch without writing or queueing', async t => {
  const f = await fixture(t);
  Object.assign(f.snapshot, { turnState: 'completed', childActivity: false });
  const observed = await f.invoke('dispatch', { kind: 'read_session', target: { id: 'p', generation: 'g' } });
  assert.equal(observed.ok, true);
  Object.assign(f.snapshot, { turnState: 'running', childActivity: true });
  const result = await f.invoke('dispatch', { kind: 'send_prompt', target: { id: 'p', generation: 'g' }, text: 'Only use an idle terminal.',
    targetAvailability: 'idle', operator: true, requestId: 'idle-request', observationSequence: observed.sequence, inputRevision: observed.inputRevision });
  assert.equal(result.ok, false); assert.equal(result.delivery, 'not-dispatched');
  assert.notEqual(result.status, 'queued'); assert.equal(f.sent.length, 0);
  Object.assign(f.snapshot, { turnState: 'completed', childActivity: false });
  await f.integration.refreshInventory(); await tick(); await tick();
  assert.equal(f.sent.length, 0, 'Later readiness cannot revive the refused send');
});

test('idle-only availability is rechecked inside the adapter after core admission', async t => {
  const f = await fixture(t);
  Object.assign(f.snapshot, { turnState: 'completed', childActivity: false });
  const get = f.integration.directory.get;
  let changed = false;
  f.integration.directory.get = id => {
    const session = get(id);
    if (!changed && id === 'p') {
      changed = true;
      // Return the admitted idle snapshot, then publish a new busy snapshot.
      Object.assign(f.snapshot, { turnState: 'running', childActivity: true });
    }
    return session;
  };
  const result = await f.invoke('dispatch', { kind: 'send_prompt', target: { id: 'p', generation: 'g' }, text: 'An idle terminal only.',
    targetAvailability: 'idle', operator: true, requestId: 'idle-request', observationSequence: 1, inputRevision: 0 });
  assert.equal(changed, true, 'The adapter observed the idle-to-busy transition');
  assert.equal(result.ok, false); assert.equal(result.delivery, 'not-dispatched');
  assert.notEqual(result.status, 'queued'); assert.equal(f.sent.length, 0);
  f.integration.directory.get = get;
  Object.assign(f.snapshot, { turnState: 'completed', childActivity: false });
  await f.integration.refreshInventory(); await tick(); await tick(); assert.equal(f.sent.length, 0);
});

test('an idle-only operator prompt still submits once when native readiness remains idle', async t => {
  const f = await fixture(t); Object.assign(f.snapshot, { turnState: 'completed', childActivity: false });
  const result = await f.invoke('dispatch', { kind: 'send_prompt', target: { id: 'p', generation: 'g' }, text: 'Use this idle terminal.',
    targetAvailability: 'idle', operator: true, requestId: 'idle-request', observationSequence: 1, inputRevision: 0 });
  assert.equal(result.ok, true); assert.equal(result.inputDisposition, 'submitted-when-ready'); assert.equal(f.sent.length, 1);
});

test('a prompt queued behind pending Codex input promotes once when the busy root becomes observable', async t => {
  const f = await fixture(t);
  f.snapshot.pendingInput = true;
  const queued = await f.send('Deliver this followup while Codex is working.');
  assert.equal(queued.status, 'queued'); assert.equal(f.sent.length, 0);
  assert.equal(typeof queued.actionId, 'string');
  f.snapshot.pendingInput = false;
  f.event({ type: 'input-state', inputRevision: 3 });
  await f.integration.refreshInventory();
  await until(() => f.integration.getState().receipts.some(receipt => receipt.status === 'written'));
  assert.equal(f.sent.length, 1, 'The queued prompt must reach the supported busy composer before completion');
  const payload = f.sent[0].payload;
  assert.equal(payload.kind, 'interaction'); assert.equal(payload.submit, true);
  assert.equal(payload.text, 'Deliver this followup while Codex is working.');
  assert.equal(payload.requestId, 'request'); assert.equal(payload.interactionEvidence.inputRevision, 3);
  assert.notEqual(payload.actionId, queued.actionId, 'A proven-unsent terminal-input cache entry cannot poison the fresh attempt');
  const receipts = f.integration.getState().receipts;
  const delivered = receipts.find(receipt => receipt.status === 'written');
  assert.ok(delivered, JSON.stringify(f.integration.getState().receipts));
  assert.equal(delivered.requestId, receipts.find(receipt => receipt.status === 'queued').requestId, 'Delivery retains the original request correlation');
  await f.integration.refreshInventory();
  Object.assign(f.snapshot, { turnState: 'completed', childActivity: false });
  await f.integration.refreshInventory();
  assert.equal(f.sent.length, 1, 'Observation and completion cannot replay a promoted prompt');
});

test('busy promotion uses a fresh host action ID after a proven-unsent native host rejection', async t => {
  const f = await fixture(t);
  f.hostResult = { ok: false, status: 'recipient-unavailable', delivery: 'not-dispatched' };
  const queued = await f.send('Try the verified busy root when available.');
  assert.equal(queued.status, 'queued'); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].payload.actionId, queued.actionId);
  delete f.hostResult;
  await f.integration.refreshInventory();
  await until(() => f.integration.getState().receipts.some(receipt => receipt.status === 'written'));
  assert.equal(f.sent.length, 2);
  assert.notEqual(f.sent[1].payload.actionId, f.sent[0].payload.actionId, 'The host caches rejected IDs too');
  const receipts = f.integration.getState().receipts;
  assert.equal(receipts.find(receipt => receipt.status === 'written').requestId, receipts.find(receipt => receipt.status === 'queued').requestId);
  await f.integration.refreshInventory(); assert.equal(f.sent.length, 2);
});

for (const hostResult of [
  { ok: false, status: 'unknown' },
  { ok: false, status: 'write-failed' },
  { ok: false, status: 'input-buffer-occupied', delivery: 'not-dispatched' },
  { ok: false, status: 'stale-observation', delivery: 'not-dispatched', error: 'The input revision changed before the host write.' },
]) test(`queued busy promotion ${hostResult.status} is final and cannot replay at turn completion`, async t => {
  const f = await fixture(t); f.snapshot.pendingInput = true;
  assert.equal((await f.send('Preserve this exact followup.')).status, 'queued');
  f.hostResult = hostResult; f.snapshot.pendingInput = false;
  await f.integration.refreshInventory();
  await until(() => f.integration.getState().receipts.some(receipt => receipt.status === (hostResult.status === 'write-failed' ? 'unknown' : hostResult.status)));
  assert.equal(f.sent.length, 1);
  assert.ok(f.integration.getState().receipts.some(receipt => receipt.status === (hostResult.status === 'write-failed' ? 'unknown' : hostResult.status)));
  delete f.hostResult;
  Object.assign(f.snapshot, { turnState: 'completed', childActivity: false });
  await f.integration.refreshInventory(); await f.integration.refreshInventory();
  assert.equal(f.sent.length, 1);
});

for (const mode of ['cancel', 'conversation', 'human-input']) test(`queued Codex promotion respects ${mode} before input`, async t => {
  const f = await fixture(t); f.snapshot.pendingInput = true;
  f.snapshot.conversation = { id: 'original', provider: 'codex' };
  assert.equal((await f.send('Only send to this authorized composer.')).status, 'queued');
  if (mode === 'cancel') await f.invoke('cancel');
  if (mode === 'conversation') f.snapshot.conversation = { id: 'replacement', provider: 'codex' };
  if (mode === 'human-input') f.snapshot.manualInputPending = true;
  f.snapshot.pendingInput = false;
  await f.integration.refreshInventory(); await f.integration.refreshInventory();
  await tick(); await tick();
  assert.equal(f.sent.length, 0);
});

for (const field of ['manualInputPending', 'interactionInputPending']) test(`fresh decoded ${field} blocks promotion even if native runtime has no draft metadata`, async t => {
  const f = await fixture(t); f.snapshot.pendingInput = true;
  assert.equal((await f.send('Keep existing input intact.')).status, 'queued');
  f.event({ type: 'input-state', inputRevision: 1, [field]: true, ownerRequestId: 'another-request' });
  f.snapshot.pendingInput = false;
  await f.integration.refreshInventory();
  await until(() => f.integration.getState().receipts.some(receipt => receipt.status === 'input-buffer-occupied'));
  assert.equal(f.sent.length, 0);
  f.event({ type: 'input-state', inputRevision: 2 });
  Object.assign(f.snapshot, { turnState: 'completed', childActivity: false });
  await f.integration.refreshInventory(); await tick(); await tick();
  assert.equal(f.sent.length, 0, 'Clearing a draft cannot revive the rejected prompt');
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
