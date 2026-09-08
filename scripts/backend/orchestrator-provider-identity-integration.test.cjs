"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionDirectory } = require('../../backend/orchestratorIntegration.cjs');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
const { createOrchestratorHistory } = require('../../backend/orchestratorHistory.cjs');
const { readSource, createReadRecovery } = require('../../backend/orchestratorReadRecovery.cjs');
const { sessionIdentity } = require('../../backend/orchestratorRouting.cjs');
const { routingBindingMatches } = require('../../backend/orchestratorLaunchers.cjs');

async function sources(kind, plannerFamily = 'claude') {
  const cwd = process.cwd(), nativeId = 'native-conversation';
  const runtime = createTerminalRuntime();
  const directory = createSessionDirectory({ getRuntime: () => runtime });
  const profile = kind === 'claude-custom' ? 'custom-profile' : undefined;
  const threadRef = { id: nativeId, provider: kind === 'fusion' ? plannerFamily : kind === 'openfusion' ? 'opencode' : kind };
  const ui = { id: 'pane', kind, cwd, threadRef, providerProfileId: profile,
    ...(kind === 'fusion' && { fusion: true, fusionPlannerFamily: plannerFamily }), ...(kind === 'openfusion' && { openFusion: true }) };
  directory.updateUi([ui]);
  if (['fusion', 'openfusion'].includes(kind)) directory.outgoing(kind, { type: 'start', payload: { id: ui.id, cwd, plannerFamily } });
  else runtime.beginLaunch({ id: ui.id, cwd, provider: kind, providerProfileId: profile, threadRef });
  const live = directory.get(ui.id);
  // This is the actual Integration getKnownScopes shape, including the
  // incidental plannerProvider currently carried by non-Fusion scopes.
  const scope = { provider: live.kind, cwd: live.cwd, claudeHome: live.providerProfileId ? 'custom' : 'global',
    providerProfileId: live.providerProfileId, ownedThreadIds: [live.threadRef.id], plannerProvider: live.fusionPlannerFamily || 'claude',
    fusion: live.kind === 'fusion', openFusion: live.kind === 'openfusion' };
  const history = createOrchestratorHistory({ getKnownScopes: () => [scope], lookupThreads: async () => ({ status: 'found', threads: [{ id: nativeId, title: 'Actual native record' }] }) });
  const saved = (await history.list()).conversations[0];
  assert.ok(saved);
  return { directory, ui, live, saved };
}
function recovered(saved, live) {
  const recovery = createReadRecovery(), failure = { ok: false };
  recovery.observe({ kind: 'read_conversation', reference: saved.reference }, { ok: false, readSource: readSource(saved) }, failure, true);
  recovery.observe({ kind: 'read_session', targetId: live.id }, { ok: true, readSource: readSource(live, true), observation: { id: live.id, generation: live.generation, text: 'Observed native output' } }, undefined, true);
  return recovery.recovered(failure);
}
for (const kind of ['codex', 'claude', 'claude-custom', 'cursor', 'gemini', 'kimi', 'kimi-custom', 'qwen', 'opencode', 'openfusion', 'fusion']) {
  for (const family of kind === 'fusion' ? ['claude', 'codex'] : ['claude']) test(`${kind}/${family}: actual directory and history identities recover only the same source`, async () => {
    const { live, saved } = await sources(kind, family);
    assert.equal(recovered(saved, live), true, JSON.stringify({ live: readSource(live, true), saved: readSource(saved) }));
    assert.equal(recovered(saved, { ...live, conversationId: 'replacement' }), false);
    assert.equal(recovered(saved, { ...live, home: 'another-native-home' }), false);
    assert.equal(recovered(saved, { ...live, providerProfileId: 'another-profile' }), false);
    if (kind === 'fusion') assert.equal(recovered(saved, { ...live, plannerProvider: family === 'claude' ? 'codex' : 'claude' }), false);
    else assert.equal(recovered(saved, { ...live, plannerProvider: 'irrelevant-non-fusion-metadata' }), true);
  });
}
for (const kind of ['fusion', 'openfusion']) test(`${kind}: current host identity replaces UI identity immediately and stale inventory cannot undo it`, async () => {
  const { directory, ui, live } = await sources(kind);
  const binding = { target: { id: live.id, generation: live.generation }, nativeIdentity: sessionIdentity(live) };
  for (const extra of [{ generation: 'old-generation' }, { generation: live.generation, replay: true }, {}]) {
    directory.ingest(kind, { id: live.id, type: 'session', sessionId: 'ignored', ...extra });
    assert.equal(sessionIdentity(directory.get(live.id)).id, live.threadRef.id);
  }
  directory.ingest(kind, { id: live.id, generation: live.generation, type: 'session', sessionId: 'new-native-id' });
  assert.equal(sessionIdentity(directory.get(live.id)).id, 'new-native-id');
  assert.equal(routingBindingMatches(binding, directory.get(live.id)), false);
  directory.updateUi([ui]);
  assert.equal(sessionIdentity(directory.get(live.id)).id, 'new-native-id');
  directory.ingest(kind, { id: live.id, generation: live.generation, type: 'session', sessionId: '' });
  assert.equal(sessionIdentity(directory.get(live.id)).id, 'new-native-id');
});

test('Fusion start records its actual planner family before UI inventory catches up', () => {
  const directory = createSessionDirectory();
  directory.updateUi([{ id: 'pane', kind: 'fusion', cwd: process.cwd(), fusionPlannerFamily: 'claude', threadRef: { id: 'old', provider: 'claude' } }]);
  const generation = directory.outgoing('fusion', { type: 'start', payload: { id: 'pane', cwd: process.cwd(), plannerFamily: 'codex', resumeId: 'codex-thread' } }).payload.generation;
  const source = readSource(directory.get('pane'), true);
  assert.equal(directory.get('pane').fusionPlannerFamily, 'codex', 'History scope receives the actual host planner family too');
  assert.equal(source.native.plannerProvider, 'codex');
  assert.equal(source.native.id, 'codex-thread');
  assert.equal(source.generation, generation);
});


for (const kind of ['fusion', 'openfusion']) test(`${kind}: a native conversation switch retires current turn fields without relabelling cached results`, async () => {
  const { directory, live } = await sources(kind);
  const emit = (type, fields = {}) => directory.ingest(kind, { id: live.id, generation: live.generation, type, ...fields });
  emit('session', { sessionId: live.threadRef.id });
  emit('engine-ready');
  directory.outgoing(kind, { type: 'input', payload: { id: live.id, actionId: 'old-action' } });
  emit('turn-start', { turnId: 'old-turn' });
  emit('tool-call', { name: 'old-tool' });
  emit('assistant-text', { text: 'Original conversation result.' });
  emit('result', { gate: { checked: true } });
  const before = directory.get(live.id);
  const oldResult = directory.readChat({ id: live.id, generation: live.generation, completedTurnId: 'old-turn' }).completedResult;
  assert.equal(before.turnState, 'completed');
  emit('session', { sessionId: live.threadRef.id });
  assert.equal(directory.get(live.id).turnId, before.turnId, 'Repeated current identity does not erase a completed turn');
  emit('session', { sessionId: 'replacement-native' });
  const after = directory.get(live.id);
  assert.equal(after.conversationId, 'replacement-native');
  assert.equal(after.turnState, 'unknown');
  assert.equal(after.turnActive, false);
  assert.equal(after.pendingInput, false);
  for (const key of ['turnId', 'turnStartedAt', 'turnEndedAt', 'completedTurnId', 'completedActionId', 'activeActionId', 'pendingActionId', 'completionAttribution', 'turnText', 'lastTool', 'checkEvidence']) assert.equal(after[key], undefined, key);
  const current = directory.readChat({ id: live.id, generation: live.generation });
  assert.equal(current.completedResult, undefined);
  assert.match(current.text, /Original conversation result/);
  assert.deepEqual(directory.readChat({ id: live.id, generation: live.generation, completedTurnId: 'old-turn' }).completedResult, oldResult);
  directory.outgoing(kind, { type: 'input', payload: { id: live.id, actionId: 'new-action' } });
  emit('turn-start');
  assert.notEqual(directory.get(live.id).turnId, 'old-turn');
  assert.equal(directory.get(live.id).activeActionId, 'new-action');
});

for (const resumeId of [undefined, 'resumed-native']) test(`initial structured native identity preserves pending submission (${resumeId || 'new'})`, () => {
  const directory = createSessionDirectory();
  const generation = directory.outgoing('fusion', { type: 'start', payload: { id: 'pane', cwd: process.cwd(), resumeId } }).payload.generation;
  directory.outgoing('fusion', { type: 'input', payload: { id: 'pane', actionId: 'initial-action' } });
  directory.ingest('fusion', { id: 'pane', generation, type: 'session', sessionId: resumeId || 'new-native' });
  assert.equal(directory.get('pane').pendingActionId, 'initial-action');
  assert.equal(directory.get('pane').pendingInput, true);
  directory.ingest('fusion', { id: 'pane', generation, type: 'turn-start' });
  assert.equal(directory.get('pane').activeActionId, 'initial-action');
});
