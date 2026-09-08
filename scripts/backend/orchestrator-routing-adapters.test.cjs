'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { launcherCatalog, waitForRoutingReady, routingBindingMatches } = require('../../backend/orchestratorLaunchers.cjs');
const { createSessionDirectory } = require('../../backend/orchestratorIntegration.cjs');
const { createOrchestratorDelivery } = require('../../backend/orchestratorDelivery.cjs');
const { sessionIdentity } = require('../../backend/orchestratorRouting.cjs');
const { normalizeIntent, claimDelegatedTaskCreation, bindDelegatedTask } = require('../../backend/orchestratorIntent.cjs');

function replayAttachedHost(kind, payload, originalPayload, directory) {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
  const filename = kind === 'fusion' ? 'fusionChatHost.cjs' : 'openFusionChatHost.cjs';
  const source = ts.createSourceFile(filename, fs.readFileSync(path.join(__dirname, '../../backend', filename), 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = [];
  const visit = node => { if (ts.isFunctionDeclaration(node) && ['start', 'replaySession'].includes(node.name?.text)) functions.push(node.getText(source)); ts.forEachChild(node, visit); };
  visit(source); assert.equal(functions.length, 2);
  const state = { child: {}, generation: originalPayload.generation, launchPayload: originalPayload, history: [{ type: 'engine-ready' }] };
  const events = [];
  const context = vm.createContext({ ...require('../../backend/fusionChatHost.cjs'), sessions: new Map([[payload.id, state]]),
    clonePayload: value => structuredClone(value), normalizeFusionRunMode: value => value || 'auto',
    emit: envelope => { events.push(envelope); directory.ingest(kind, { id: envelope.id, generation: envelope.generation, ...envelope.event }); } });
  vm.runInContext(functions.join('\n'), context); context.start(payload);
  assert.equal(events.length, 1); assert.equal(events[0].generation, originalPayload.generation); assert.equal(events[0].event.replay, true);
}

for (const turnState of ['idle', 'unknown']) test(`native ${turnState} routing readiness receipt binds its actual delegated creation`, async () => {
  const cwd = 'C:/work/app';
  const session = { id: 'created', generation: 'actual-generation', launchToken: 1, kind: 'codex', provider: 'codex', cwd, name: 'Actual worker',
    processState: 'running', launchState: 'ready', agentProcessState: 'running', agentPid: 42, observation: 'observed', turnState };
  const plan = normalizeIntent({ goal: 'Fix the tests', actions: [{ kind: 'delegate_task', cwd, text: 'Fix the tests', assignmentMode: 'new', kindOfSession: 'codex' }] },
    { requestId: 'request', instruction: 'Open Codex and fix the tests', sessions: [], projects: [{ path: cwd }] });
  const creation = claimDelegatedTaskCreation(plan, plan.grants[0].id, { kindOfSession: 'codex' });
  // The renderer acknowledges only the pane. Launch readiness must supply the
  // process evidence consumed by the real command-plan binding boundary.
  const receipt = await waitForRoutingReady({ result: { ok: true, id: session.id, launchToken: 1, status: 'created', cwd: 'C:/wrong', name: 'Provisional' }, getSession: () => session });
  assert.equal(receipt.readiness, turnState === 'idle' ? 'ready' : 'process-ready');
  assert.equal(receipt.processState, 'running'); assert.equal(receipt.cwd, cwd); assert.equal(receipt.name, session.name);
  const bound = bindDelegatedTask(plan, plan.grants[0].id, session, { sessions: [session], expectedTarget: receipt.target,
    creationReceipt: { ...receipt, actionId: creation.actionId } });
  assert.equal(bound.grants[0].kind, 'operate_terminal');
  assert.deepEqual(bound.grants[0].targets, [{ id: session.id, generation: session.generation }]);
  assert.equal(bound.grants[0].text, 'Fix the tests');
});

test('cancelled routing launch cannot retain provisional target, location or process evidence', async () => {
  const controller = new AbortController(); controller.abort();
  const receipt = await waitForRoutingReady({ result: { ok: true, id: 'created', launchToken: 1, target: { id: 'created', generation: 'provisional' },
    cwd: 'C:/unverified', name: 'Unverified', processState: 'running' }, signal: controller.signal, getSession: () => assert.fail('cancelled launch must not read') });
  assert.equal(receipt.status, 'cancelled'); assert.equal(receipt.sessionCreated, true);
  for (const field of ['target', 'cwd', 'name', 'processState']) assert.equal(receipt[field], undefined);
});
test('catalog preserves unknown availability and refuses unconfigured Open Fusion without leaking credentials', () => {
  assert.deepEqual(launcherCatalog(), []);
  const [native, open] = launcherCatalog([{ kind: 'codex', apiKey: 'secret' }, { kind: 'openfusion', available: true, configured: true }]);
  assert.equal(native.available, 'unknown'); assert.equal(native.configured, 'unknown'); assert.equal(native.apiKey, undefined); assert.equal(open.configured, false);
});
test('new worker first send accepts absent native identity but fences known scope', () => {
  const session = { id: 'new', generation: 'g', launchToken: 1, provider: 'codex', cwd: 'C:/repo' };
  const binding = { target: { id: 'new', generation: 'g', launchToken: 1 }, nativeIdentity: sessionIdentity(session) };
  assert.equal(routingBindingMatches(binding, session), true);
  assert.equal(routingBindingMatches(binding, { ...session, cwd: 'C:/other' }), false);
  assert.equal(routingBindingMatches(binding, { ...session, cwd: 'c:\\REPO\\' }), true);
});
test('startup deadline and abort settle even while inventory refresh never returns', async () => {
  const result = { ok: true, id: 'created', launchToken: 1 };
  const hung = () => new Promise(() => {});
  const timed = await waitForRoutingReady({ result, refresh: hung, getSession: () => assert.fail('must not read after deadline'), timeoutMs: 15 });
  assert.equal(timed.status, 'launch-timeout'); assert.equal(timed.id, 'created'); assert.equal(timed.launchToken, 1);
  const before = new AbortController(); before.abort();
  assert.equal((await waitForRoutingReady({ result, refresh: () => assert.fail('pre-aborted'), signal: before.signal })).status, 'cancelled');
  const during = new AbortController();
  const waiting = waitForRoutingReady({ result, refresh: hung, signal: during.signal }); during.abort();
  assert.equal((await waiting).status, 'cancelled');
});
test('startup fences the initially acknowledged generation and rejects invalid identities', async () => {
  const result = { ok: true, id: 'a', launchToken: 1, target: { id: 'a', generation: 'original', launchToken: 1 } };
  const ready = { id: 'a', generation: 'replacement', launchToken: 1, kind: 'openfusion', engineReady: true, status: 'idle' };
  assert.equal((await waitForRoutingReady({ result, getSession: () => ready })).status, 'superseded');
  for (const generation of [undefined, '', 'paused:a']) {
    const response = await waitForRoutingReady({ result: { ...result, target: undefined }, getSession: () => ({ ...ready, generation }), timeoutMs: 10, pollMs: 1 });
    assert.equal(response.ok, false); assert.equal(response.target, undefined);
  }
});
test('structured startup waits for explicit engine ready', async () => {
  const directory = createSessionDirectory(); directory.updateUi([{ id: 'a', kind: 'openfusion', launchToken: 1, started: true }]);
  directory.outgoing('openfusion', { type: 'start', payload: { id: 'a' } });
  let settled = false;
  const waiting = waitForRoutingReady({ result: { ok: true, id: 'a', launchToken: 1 }, getSession: directory.get, timeoutMs: 1000, pollMs: 5 }).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(settled, false);
  directory.ingest('openfusion', { id: 'a', type: 'engine-ready' });
  assert.equal((await waiting).readiness, 'ready');
});

test('routing readiness ignores an older launch while its replacement inventory catches up', async () => {
  let reads = 0;
  const ready = { id: 'a', generation: 'current', launchToken: 2, kind: 'openfusion', engineReady: true, status: 'idle' };
  const receipt = await waitForRoutingReady({ result: { ok: true, id: 'a', launchToken: 2 }, pollMs: 1,
    getSession: () => ++reads === 1 ? { ...ready, generation: 'old', launchToken: 1, status: 'exited' } : ready });
  assert.equal(receipt.ok, true); assert.equal(receipt.target.generation, 'current'); assert.equal(receipt.target.launchToken, 2);
});

for (const kind of ['fusion', 'openfusion']) test(`${kind} remount with discovered native ID preserves its live generation and pending interaction`, () => {
  const directory = createSessionDirectory();
  const payload = { id: 'pane', cwd: 'C:/repo', plannerModel: 'brain', executorModel: 'worker' };
  const first = directory.outgoing(kind, { type: 'start', payload }).payload;
  const emit = (type, extra = {}) => directory.ingest(kind, { id: 'pane', generation: first.generation, type, ...extra });
  emit('engine-ready'); emit('session', { sessionId: 'discovered' });
  emit('question', { requestId: 'pending-question' });
  const before = directory.get('pane');
  const attached = directory.outgoing(kind, { type: 'start', payload: { ...payload, resumeId: 'discovered' } }).payload;
  assert.equal(attached.generation, first.generation);
  // Execute the actual hosts' existing-child attach/replay branches. Replayed
  // readiness cannot rescue a directory that accidentally minted a new owner.
  replayAttachedHost(kind, attached, first, directory);
  assert.equal(directory.get('pane').engineReady, true);
  assert.equal(directory.get('pane').status, before.status);
  assert.equal(directory.get('pane').turnState, 'waiting');
  emit('question-resolved', { requestId: 'pending-question' });
  assert.equal(directory.get('pane').status, 'idle');
  const other = directory.outgoing(kind, { type: 'start', payload: { ...payload, resumeId: 'different' } }).payload;
  assert.notEqual(other.generation, first.generation);
  directory.ingest(kind, { id: 'pane', generation: other.generation, type: 'session', sessionId: 'different' });
  const changed = directory.outgoing(kind, { type: 'start', payload: { ...payload, executorModel: 'another-worker', resumeId: 'different' } }).payload;
  assert.notEqual(changed.generation, other.generation);
  assert.equal(directory.get('pane').engineReady, undefined);
});
test('queued routed prompt never crosses same generation native conversation switch', async () => {
  let session = { id: 'a', generation: 'g', kind: 'codex', provider: 'codex', cwd: 'C:/repo', conversation: { id: 'one' }, processState: 'running', agentProcessState: 'running', agentPid: 42, observation: 'observed', turnState: 'running' };
  const updates = [], writes = [];
  const delivery = createOrchestratorDelivery({ getSession: () => session, write: payload => { writes.push(payload); return { ok: true }; }, onUpdate: value => updates.push(value) });
  const target = { id: 'a', generation: 'g' };
  assert.equal((await delivery.submit({ actionId: 'r', target, text: 'task', routingBinding: { target, nativeIdentity: sessionIdentity(session) } })).status, 'queued');
  session = { ...session, turnState: 'idle', conversation: { id: 'two' } }; await delivery.pump();
  assert.equal(writes.length, 0); assert.equal(updates[0].status, 'conversation-changed'); assert.equal(updates[0].delivery, 'not-dispatched'); delivery.dispose();
});
