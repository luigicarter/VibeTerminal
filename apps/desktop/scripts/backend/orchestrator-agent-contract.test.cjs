'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createAgentDirectory, projectAgent } = require('../../backend/orchestratorAgents.cjs');
const { runRef, sameRun, sections } = require('../../shared/orchestratorAgentContract.cjs');
const { sessionSummary } = require('../../backend/orchestratorContext.cjs');
const { sessionIdentity } = require('../../backend/orchestratorRouting.cjs');
const { agent, childApproval } = require('./orchestrator-agent-fixtures.cjs');
const directory = () => { let next = 0; return createAgentDirectory({ makeId: () => `agent-${++next}` }); };

test('agent record explains child approval independently of its completed root and legacy ready label', () => {
  const source = childApproval();
  const old = sessionSummary(source, { includeNavigationGuide: false });
  assert.equal(old.readiness, 'ready'); assert.equal(old.children, undefined);
  const record = projectAgent(source, { agentId: 'agent-a', state: 'bound' });
  assert.equal(record.activity.foreground.state, 'completed');
  assert.equal(record.activity.childWork, true);
  assert.equal(record.attention.items[0].childId, 'reviewer');
  assert.equal(record.attention.items[0].toolId, 'attempt-1');
  assert.equal(record.capabilities.operations.idleTask.eligibility, 'blocked');
  assert.equal(record.results.verification, 'not-established-by-session-status');
  assert.equal(record.capabilities.turnCompletion, 'authoritative');
});

test('record projection never reads terminal bodies, transcripts, credentials or authority objects', () => {
  const source = agent();
  for (const key of ['text', 'history', 'transcript', 'messages', 'screen', 'raw', 'apiKey', 'grants']) {
    Object.defineProperty(source, key, { enumerable: true, get() { assert.fail(`Read forbidden source field ${key}`); } });
  }
  const record = projectAgent(source, { agentId: 'a', state: 'bound' });
  assert.equal(record.identity.native.id, 'conversation-worker');
  assert.equal(record.capabilities.observedModel, undefined);
});

test('unrelated same-project work is never presented as owned work', () => {
  const source = agent(), target = { id: source.id, generation: source.generation, launchToken: 1 };
  const items = [
    { id: 'same', requestIds: ['r'], requiresRevalidation: false, binding: { target, nativeIdentity: sessionIdentity(source) } },
    { id: 'other', requestIds: ['q'], binding: { target, nativeIdentity: { ...sessionIdentity(source), id: 'another-conversation' } } },
    { id: 'same-folder', cwd: source.cwd, requestIds: [] }
  ];
  assert.deepEqual(projectAgent(source, { agentId: 'a', state: 'bound' }, { workItems: items }).work.items.map(x => x.id), ['same']);
});

test('identity survives rename, output revisions, remount and exact verified resume', () => {
  const d = directory(), s = agent();
  const first = d.reconcile([s])[0];
  const membership = d.membershipRevision();
  d.reconcile([{ ...s, revision: 500, updatedAt: 500, lastOutputAt: 500 }]);
  assert.equal(d.get(first.agentId).revision, first.revision);
  d.reconcile([{ ...s, name: 'New display name' }]);
  assert.equal(d.membershipRevision(), membership);
  assert.equal(d.forSurface(s.id).agentId, first.agentId);
  const resumed = { ...s, generation: 'replacement-run', launchToken: 2 };
  d.reconcile([resumed]);
  assert.equal(d.forSurface(s.id).agentId, first.agentId);
  assert.equal(d.resolve(first.agentId, runRef(s)), null);
  assert.deepEqual(d.resolve(first.agentId, runRef(resumed)), runRef(resumed));
});

test('provisional identity binds first root without changing agent ID', () => {
  const d = directory(), s = agent('new', { conversation: undefined, binding: { status: 'pending' } });
  const first = d.reconcile([s])[0];
  assert.equal(first.identity.state, 'provisional');
  d.reconcile([{ ...s, conversation: { provider: 'codex', id: 'new-root' }, binding: { status: 'found' } }]);
  assert.equal(d.forSurface(s.id).agentId, first.agentId);
  assert.equal(d.forSurface(s.id).identity.state, 'bound');
});

test('native root replacement remains ambiguous while an explicit structured new chat gets another identity', () => {
  const d = directory(), s = agent();
  const first = d.reconcile([s])[0];
  d.reconcile([{ ...s, conversation: { provider: 'codex', id: 'unexpected-root' } }]);
  assert.equal(d.forSurface(s.id).identity.state, 'ambiguous');
  assert.equal(d.resolve(first.agentId), null);
  const chat = agent('chat', { kind: 'fusion', provider: undefined, fusion: true, conversation: undefined, conversationId: 'chat-one', engineReady: true });
  const original = d.reconcile([chat])[0];
  const replacement = d.reconcile([{ ...chat, conversationId: 'chat-two' }])[0];
  assert.notEqual(replacement.agentId, original.agentId);
  assert.equal(d.resolve(original.agentId), null);
});

test('duplicate current roots are ambiguous and no writable run is resolved', () => {
  const d = directory(), a = agent('a'), b = agent('b', { conversation: a.conversation });
  const records = d.reconcile([a, b]);
  assert.equal(records.length, 2);
  for (const item of records) { assert.equal(item.identity.state, 'ambiguous'); assert.equal(d.resolve(item.agentId), null); }
});

test('provider homes and workspaces isolate otherwise equal conversation IDs', () => {
  const d = directory();
  const a = agent('a', { kind: 'claude', provider: 'claude', conversationId: 'same', conversation: undefined });
  const b = { ...a, id: 'b', generation: 'b', providerProfileId: 'profile-one' };
  const c = { ...a, id: 'c', generation: 'c', cwd: 'C:/agent-harness/other' };
  assert.equal(new Set(d.reconcile([a, b, c]).map(x => x.agentId)).size, 3);
});

test('a Fusion planner and standalone agent sharing the same native root cannot both be selected', () => {
  const d = directory(), standalone = agent('native');
  const fusion = agent('fusion', { kind: 'fusion', provider: undefined, fusion: true, plannerProvider: 'codex',
    conversation: undefined, conversationId: standalone.conversation.id, engineReady: true });
  for (const record of d.reconcile([standalone, fusion])) {
    assert.equal(record.identity.state, 'ambiguous'); assert.equal(d.resolve(record.agentId), null);
  }
});

test('resumed native conversation retains historical task references without restoring ownership authority', () => {
  const old = agent(), resumed = { ...old, generation: 'new-run', launchToken: 2 };
  const item = { id: 'prior-work', requestIds: ['prior-request'], requiresRevalidation: false,
    binding: { target: runRef(old), nativeIdentity: sessionIdentity(old) } };
  const record = projectAgent(resumed, { agentId: 'a', state: 'bound' }, { workItems: [item] });
  assert.equal(record.work.ownership, 'historical'); assert.equal(record.work.items[0].id, item.id);
  assert.equal(record.work.items[0].requiresRevalidation, true);
});

test('paused records and plain shells never resolve as live agents', () => {
  const d = directory();
  const records = d.reconcile([agent('shell', { kind: 'terminal', provider: 'terminal' }), agent('paused', { started: false, generation: 'paused:p:1' })]);
  assert.equal(records.length, 1); assert.equal(records[0].identity.state, 'paused');
  assert.equal(d.resolve(records[0].agentId), null);
  assert.equal(projectAgent(agent('shell', { kind: 'terminal' }), { agentId: 'not-an-agent' }), null);
});

test('stale interactions cannot block another generation and missing reasons stay unknown', () => {
  const s = agent('a', { status: 'waiting' });
  const record = projectAgent(s, { agentId: 'a', state: 'bound' }, { requests: [{ id: 'stale', sessionId: s.id, generation: 'old', state: 'pending' }] });
  assert.equal(record.attention.required, true);
  assert.equal(record.attention.coverage, 'reason-unavailable');
  assert.deepEqual(record.attention.items, []);
});

test('structured composition has role models while absent model data is not invented', () => {
  const s = agent('chat', { kind: 'fusion', fusion: true, engineReady: true, plannerProvider: 'codex', model: 'brain-model', executorProvider: 'claude', executorModel: 'worker-model' });
  const record = projectAgent(s, { agentId: 'a', state: 'bound' });
  assert.deepEqual(record.identity.participants, [{ role: 'planner', provider: 'codex', configuredModel: 'brain-model' },
    { role: 'executor', provider: 'claude', configuredModel: 'worker-model' }]);
  assert.equal(record.capabilities.observedModel, undefined);
});

test('retained child uncertainty and provider capability limits survive projection', () => {
  const s = agent('coarse', { kind: 'cursor', provider: 'cursor', status: 'activity unverified', children: [{ id: 'child', observation: 'provisional' }], childActivity: true });
  const record = projectAgent(s, { agentId: 'a', state: 'bound' });
  assert.equal(record.activity.children[0].observation, 'provisional');
  assert.equal(record.capabilities.childTracking, 'unsupported');
  assert.equal(record.capabilities.turnCompletion, 'coarse');
  assert.equal(record.capabilities.operations.idleTask.eligibility, 'blocked');
});

test('identity capacity fails explicitly and keeps earlier records', () => {
  const d = createAgentDirectory({ maxRecords: 1 });
  const original = d.reconcile([agent('one')])[0];
  assert.throws(() => d.reconcile([agent('one'), agent('two')]), /capacity/);
  assert.equal(d.get(original.agentId).identity.native.id, 'conversation-one');
});

test('references are snapshots and generation zero is valid without granting authority', () => {
  const d = directory(), s = agent('zero', { generation: 0 });
  const r = d.reconcile([s])[0]; r.identity.native.id = 'tampered';
  assert.equal(d.forSurface(s.id).identity.native.id, 'conversation-zero');
  assert.equal(sameRun(runRef(s), { id: s.id, generation: 0, launchToken: 1 }), true);
  assert.equal(sameRun(runRef(s), { id: s.id, generation: '0', launchToken: 1 }), false);
  assert.throws(() => sections(['raw-terminal']), /supported/);
});
