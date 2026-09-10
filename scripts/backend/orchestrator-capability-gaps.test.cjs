'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { workspaceMap } = require('../../backend/orchestratorWorkspace.cjs');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-capability-audit-'));
  const f = { sessions: [{ id: 'p', generation: 'g1', launchToken: 1, kind: 'codex', provider: 'codex', cwd: root,
    conversationId: 'old-chat', status: 'idle', observation: 'observed' }] };
  f.app = createOrchestrator({ userDataPath: root, getSessions: () => f.sessions,
    getRoots: () => ({ documents: root, projects: [] }), getWorkspaceState: async () => ({ ok: true, view: 'orchestrator' }),
    fetch: () => assert.fail('No network expected'), ...options });
  t.after(async () => { await f.app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await f.app.refresh();
  return f;
}

test('workspace activity includes background work, excludes obsolete root states and counts current questions', () => {
  const sessions = [
    { id: 'child', generation: 'g', status: 'running', turnState: 'completed', childActivity: true },
    { id: 'dead', generation: 'g', status: 'exited', turnState: 'running', processState: 'exited' },
    { id: 'unknown', generation: 'g', status: 'unobserved', turnState: 'running' },
    { id: 'question', generation: 'new', status: 'idle', turnState: 'idle' },
    { id: 'stale-question', generation: 'new', status: 'idle', turnState: 'idle' }
  ];
  const map = workspaceMap({ sessions, interactions: [
    { sessionId: 'question', generation: 'new', state: 'pending' },
    { sessionId: 'stale-question', generation: 'old', state: 'pending' }
  ] });
  assert.equal(map.terminals.active, 1);
  assert.equal(map.terminals.needsInput, 1);
});

for (const change of ['generation', 'conversation', 'removed', 'adapter-generation', 'adapter-id']) {
  test(`a delayed read rejects ${change} changes without returning stale content`, async t => {
    const entered = deferred(), reading = deferred();
    const f = await fixture(t, { readSession: async () => { entered.resolve(); return reading.promise; } });
    const pending = f.app.dispatch({ kind: 'read_session', targetId: 'p' });
    await entered.promise;
    if (change === 'generation') f.sessions[0].generation = 'g2';
    if (change === 'conversation') f.sessions[0].conversationId = 'new-chat';
    if (change === 'removed') f.sessions = [];
    await f.app.refresh();
    reading.resolve({ ok: true, id: change === 'adapter-id' ? 'wrong-pane' : 'p',
      generation: change === 'adapter-generation' ? 'wrong-generation' : 'g1', text: 'STALE_PRIVATE_SCREEN', sequence: 1 });
    const result = await pending;
    assert.equal(result.ok, false);
    assert(['stale-generation', 'conversation-changed'].includes(result.status), JSON.stringify(result));
    assert.equal(result.observationToken, undefined);
    assert.equal(JSON.stringify(result).includes('STALE_PRIVATE_SCREEN'), false);
  });
}

for (const change of ['metadata', 'first-native-identity']) {
  test(`read validation permits ${change} updates without changing the source`, async t => {
    const entered = deferred(), reading = deferred();
    const f = await fixture(t, { readSession: async () => { entered.resolve(); return reading.promise; } });
    if (change === 'first-native-identity') { delete f.sessions[0].conversationId; await f.app.refresh(); }
    const pending = f.app.dispatch({ kind: 'read_session', targetId: 'p' });
    await entered.promise;
    if (change === 'metadata') { f.sessions[0].name = 'Updated title'; f.sessions[0].revision = 99; }
    else f.sessions[0].conversationId = 'first-observed-chat';
    await f.app.refresh();
    reading.resolve({ ok: true, id: 'p', generation: 'g1', text: 'Current screen', sequence: 1 });
    const result = await pending;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.observation.text, 'Current screen');
  });
}

test('workspace exposes allowlisted current configuration and truthful capability limits', async t => {
  const f = await fixture(t);
  await f.app.configure({ apiKey: 'PRIVATE_CAPABILITY_KEY', sessionOnly: true, model: 'fixture-brain', monitoringEnabled: false, spendingLimit: 2 });
  const result = await f.app.dispatch({ kind: 'read_workspace' });
  assert.equal(result.ok, true);
  assert.equal(result.orchestrator.model, 'fixture-brain');
  assert.equal(result.orchestrator.spendingLimit, 2);
  assert.equal(result.orchestrator.monitoringEnabled, false);
  assert.equal(result.capabilities.settings.write, false);
  assert.equal(result.capabilities.requests.cancel, 'ui-only');
  assert.equal(result.capabilities.files.search, 'names-only');
  assert.equal(JSON.stringify(result).includes('PRIVATE_CAPABILITY_KEY'), false);
  assert.equal(result.orchestrator.apiKey, undefined);
  assert.equal(result.orchestrator.microphoneId, undefined);
});
