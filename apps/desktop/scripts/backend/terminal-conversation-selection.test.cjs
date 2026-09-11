'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
const { createOrchestratorDelivery } = require('../../backend/orchestratorDelivery.cjs');
const { createTerminalInput } = require('../../backend/orchestratorTerminalInput.cjs');
const { sessionIdentity } = require('../../backend/orchestratorRouting.cjs');

function fixture(t, { provider = 'claude', lookup } = {}) {
  let time = 10000;
  const reads = [];
  const runtime = createTerminalRuntime({ now: () => time, lookup: async p => {
    reads.push(p);
    return lookup ? lookup(p) : { status: 'found', rootVerified: true,
      threadRef: { provider, id: p.confirmId, title: `Chat ${p.confirmId}`, createdAt: time, updatedAt: time } };
  } });
  t.after(() => runtime.dispose());
  const launch = runtime.beginLaunch({ id: 'pane', provider, cwd: process.cwd(), launchToken: 1,
    threadRef: { provider, id: 'A' } });
  const event = (type, fields = {}) => runtime.ingest({ id: 'pane', generation: launch.generation,
    type, observedAt: ++time, ...fields });
  event('created');
  event('agent-process', { phase: 'start', processId: 'owner' });
  const select = (id, fields = {}) => event('agent-session', { phase: 'start', source: 'clear',
    providerThreadId: id, invocationId: 'owner', ...fields });
  return { runtime, event, select, reads, get: () => runtime.getSnapshot('pane'), tick: () => { time += 9000; } };
}

for (const provider of ['claude', 'codex', 'open-codex']) {
  test(`${provider}: clear A -> B -> C selects the exact last chat and ignores old callbacks`, async t => {
    const h = fixture(t, { provider });
    h.select('B');
    assert.equal(h.get().selection.threadRef.id, 'B');
    assert.equal(h.get().selection.status, 'pending');
    assert.equal(h.get().conversation, undefined, 'old root cannot remain current during verification');
    await h.runtime.refresh();
    assert.equal(h.get().conversation.id, 'B');
    h.select('C');
    await h.runtime.refresh();
    assert.equal(h.get().conversation.id, 'C');
    assert.equal(h.get().selection.status, 'confirmed');
    for (const id of ['A', 'B']) h.event('agent-running', { providerThreadId: id, rootVerified: true, providerTurnId: 'late' });
    assert.equal(h.get().conversation.id, 'C');
    assert.equal(h.get().binding.status, 'found');
    assert.deepEqual(h.get().children, []);
    assert.deepEqual(h.reads.map(p => p.confirmId), ['B', 'C']);
  });
}

test('nested invocations, explicit children, compact and background forks cannot select a root', async t => {
  const h = fixture(t);
  for (const patch of [{ invocationId: 'nested' }, { invocationId: undefined },
    { parentThreadId: 'A' }, { transcriptKind: 'subagent' }, { rootVerified: false },
    { source: 'compact' }, { source: 'fork' }, { generation: 'old-generation' }]) h.select('child', patch);
  await h.runtime.refresh();
  assert.equal(h.get().conversation.id, 'A');
  assert.equal(h.get().selection, undefined);
});

test('stale metadata, duplicate selection and old start hooks cannot revert a later selection', async t => {
  let resolve;
  const h = fixture(t, { lookup: p => p.confirmId === 'B' ? new Promise(r => { resolve = r; }) :
    { status: 'found', rootVerified: true, threadRef: { id: p.confirmId } } });
  h.select('B');
  const reading = h.runtime.refresh();
  await new Promise(setImmediate);
  h.select('C');
  resolve({ status: 'found', rootVerified: true, threadRef: { id: 'B' } });
  await reading;
  await h.runtime.refresh();
  assert.equal(h.get().conversation.id, 'C');
  h.select('B', { observedAt: 10003 });
  h.select('A', { source: 'startup' });
  const revision = h.get().selection.revision;
  h.select('C');
  assert.equal(h.get().selection.revision, revision);
  assert.equal(h.get().conversation.id, 'C');
  h.select('A', { source: 'resume' });
  await h.runtime.refresh();
  assert.equal(h.get().conversation.id, 'A', 'a deliberate resume back is supported');
});

test('unreadable/missing metadata retains the candidate through exit without restoring A', async t => {
  let result = { status: 'found', rootVerified: false, threadRef: { id: 'B' } };
  const h = fixture(t, { lookup: () => result });
  h.select('B'); await h.runtime.refresh();
  assert.equal(h.get().selection.status, 'pending');
  assert.equal(h.get().conversation, undefined);
  result = { status: 'missing', rootVerified: false }; h.tick(); await h.runtime.refresh();
  h.event('agent-process', { phase: 'exit', processId: 'owner', exitCode: 0 });
  assert.equal(h.get().selection.threadRef.id, 'B');
  assert.equal(h.get().conversation, undefined);
});

test('pending selection cannot claim another pane and preserves original background ownership', async t => {
  const h = fixture(t);
  h.event('agent-subagent', { phase: 'start', taskId: 'worker', providerThreadId: 'A', lifecycle: 'native' });
  h.runtime.beginLaunch({ id: 'other', provider: 'claude', cwd: process.cwd(), launchToken: 1,
    threadRef: { provider: 'claude', id: 'B' } });
  h.select('B'); await h.runtime.refresh();
  assert.equal(h.get().conversation, undefined);
  assert.equal(h.get().binding.status, 'ambiguous');
  assert.equal(h.get().children.find(c => c.id === 'worker').ownerConversationId, 'A');
  h.select('C'); await h.runtime.refresh();
  assert.equal(h.get().conversation.id, 'C');
  h.event('agent-subagent', { phase: 'start', taskId: 'current-worker', providerThreadId: 'C', lifecycle: 'native' });
  h.event('agent-activity', { phase: 'stop', kind: 'tool', toolName: 'Agent', providerThreadId: 'A',
    claudeTaskResult: { status: 'completed', agentId: 'current-worker' } });
  assert.equal(h.get().children.find(c => c.id === 'current-worker').ownerConversationId, 'C');
  h.event('agent-subagent', { phase: 'stop', taskId: 'worker', providerThreadId: 'A', lifecycle: 'native' });
  assert.equal(h.get().children.find(c => c.id === 'worker').observation, 'provisional');
  h.event('agent-activity', { phase: 'stop', kind: 'tool', toolName: 'Agent', providerThreadId: 'A',
    claudeTaskResult: { status: 'completed', agentId: 'worker' } });
  assert.equal(h.get().children.some(c => c.id === 'worker'), false);
});

test('unordered native selections retire automatic resume until another explicit selection', async t => {
  const h = fixture(t);
  h.select('B', { observedAt: 11000 });
  h.select('C', { observedAt: 11000 });
  await h.runtime.refresh();
  assert.equal(h.get().selection.status, 'unavailable');
  assert.equal(h.get().selection.threadRef, undefined);
  assert.equal(h.get().conversation, undefined);
  h.event('agent-running', { providerThreadId: 'C', rootVerified: true });
  assert.equal(h.get().conversation, undefined);
  h.select('D', { observedAt: 12000 }); await h.runtime.refresh();
  assert.equal(h.get().conversation.id, 'D');
});

test('a later prompt delivered before its SessionStart callback is replayed as root activity', async t => {
  const h = fixture(t);
  h.event('agent-running', { providerThreadId: 'B', invocationId: 'owner', observedAt: 11001, providerTurnId: 'B-turn' });
  h.select('B', { observedAt: 11000 }); await h.runtime.refresh();
  assert.equal(h.get().conversation.id, 'B');
  assert.equal(h.get().turnState, 'running');
  assert.equal(h.get().turnId, 'B-turn');
  assert.deepEqual(h.get().children, []);
  h.select('A', { source: 'resume', observedAt: 12000 }); await h.runtime.refresh();
  h.event('agent-running', { providerThreadId: 'A', observedAt: 10500 });
  assert.equal(h.get().turnState, 'idle', 'late callbacks from the earlier visit cannot revive its turn');
});

test('queued A input is revoked across clear, including a later deliberate resume back to A', async t => {
  const h = fixture(t, { provider: 'codex' });
  const get = () => ({ ...h.get(), kind: 'codex', started: true, agentPid: 42 });
  h.event('agent-running', { providerThreadId: 'A', providerTurnId: 'turn-A' });
  const writes = [];
  const delivery = createOrchestratorDelivery({ getSession: get, write: async p => { writes.push(p); return { ok: true }; } });
  t.after(() => delivery.dispose());
  const original = get(), target = { id: original.id, generation: original.generation };
  assert.equal((await delivery.submit({ target, actionId: 'queued', text: 'Continue A',
    routingBinding: { target, nativeIdentity: sessionIdentity(original) } })).status, 'queued');
  h.select('B'); await h.runtime.refresh();
  h.select('A', { source: 'resume' }); await h.runtime.refresh();
  await delivery.pump();
  assert.deepEqual(writes, []);
  const fresh = await delivery.submit({ target, actionId: 'fresh', text: 'New request in A',
    routingBinding: { target, nativeIdentity: sessionIdentity(get()) } });
  assert.equal(fresh.ok, true);
  assert.equal(writes.length, 1);
});

test('pending selection blocks automated keys and mid-observation switching prevents writes', async t => {
  const h = fixture(t, { provider: 'codex' }), writes = [];
  const get = () => ({ ...h.get(), kind: 'codex', started: true, agentPid: 42 });
  const input = createTerminalInput({ getSession: get, readSession: async () => {
    h.select('B');
    return { ok: true, id: 'pane', generation: get().generation, sequence: 1, inputRevision: 0, cols: 80, rows: 24, text: 'Ready' };
  }, write: async p => { writes.push(p); return { ok: true }; } });
  t.after(() => input.dispose());
  const action = { target: { id: 'pane', generation: get().generation }, actionId: 'race', requestId: 'request', operator: true, keys: ['down'], observationSequence: 1, inputRevision: 0 };
  assert.equal((await input.handle(action)).delivery, 'not-dispatched');
  assert.equal((await input.handle({ ...action, actionId: 'pending' })).status, 'recipient-unavailable');
  assert.deepEqual(writes, []);
});
