'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');

async function fixture(t, steps, observation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-read-recovery-'));
  let index = 0, effects = 0;
  const app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => [{ id: 'pane', generation: 'g1', conversationId: 'saved', name: 'Review recent messages', kind: 'codex', cwd: root }],
    getRoots: () => ({ documents: root, projects: [root] }),
    interpretIntent: () => ({ goal: 'Explain what the review terminal reported.', actions: [] }),
    readSession: () => observation || ({ id: 'pane', generation: 'g1', text: 'The agent reported a prompt submission bug.', sequence: 1 }),
    dispatchAction: action => {
      if (action.kind === 'list_conversations') return { ok: true, conversations: [{ reference: 'expired', id: 'saved', provider: 'codex', cwd: root }] };
      if (action.kind === 'read_conversation' && action.reference === 'expired') throw Error('Unknown or expired conversation reference. List history again.');
      if (action.kind === 'read_conversation') return action.reference === 'fresh'
        ? { ok: true, identity: { id: 'saved', provider: 'codex', cwd: root }, text: 'The agent reported a prompt submission bug.' }
        : { ok: false, error: 'Unknown or expired conversation reference. List history again.' };
      effects++; throw Error('No effects are authorized.');
    },
    fetch: async (url) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture', supported_parameters: ['tools'], context_length: 128000 }] }));
      const step = steps[index++]; assert.ok(step, 'No extra model turns');
      const message = typeof step === 'string' ? { content: step } : { tool_calls: [{ id: `read-${index}`, function: { name: step.name || 'workspace', arguments: JSON.stringify(step.args || step) } }] };
      return new Response(JSON.stringify({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] }));
    } });
  t.after(async () => { await app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await app.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true }); await app.setEnabled(true);
  return { app, effects: () => effects };
}

test('a matching live result recovers a known expired history source', async t => {
  const f = await fixture(t, [
    { kind: 'list_conversations' },
    { kind: 'read_conversation', reference: 'expired' },
    { kind: 'read_session', targetId: 'pane' },
    'The review found a prompt submission bug.'
  ]);
  const result = await f.app.send({ text: 'What did the review recent messages terminal say?', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, 'The review found a prompt submission bug.');
  assert.equal(f.app.getState().tasks.find(task => task.requestId === result.requestId).status, 'finished');
  assert.equal(result.actions.filter(action => action.ok === false).length, 1, 'Recovery retains the failed read attempt');
  assert.equal(f.effects(), 0);
});

for (const steps of [
  [{ kind: 'read_conversation', reference: 'expired' }, 'The read failed.'],
  [{ kind: 'send_prompt', targetId: 'pane', text: 'unauthorized' }, { kind: 'read_session', targetId: 'pane' }, 'Read the output.'],
  [{ kind: 'read_session', targetId: 'pane' }, { kind: 'read_conversation', reference: 'expired' }, 'The last read failed.']
]) test(`unresolved read or effect failure stays failed: ${steps[0].kind}/${steps.length}`, async t => {
  const f = await fixture(t, steps);
  const result = await f.app.send({ text: 'What did the review terminal say?', origin: 'text' });
  assert.equal(result.ok, false); assert.equal(f.effects(), 0);
});

for (const observation of [
  { ok: false, status: 'unavailable' },
  { id: 'pane', generation: 'g1', status: 'unsupported' },
  { id: 'other-pane', generation: 'g2', text: 'Unrelated output.' },
]) test(`an unreadable or mismatched observation cannot recover a failed read (${observation.status || observation.id})`, async t => {
  const f = await fixture(t, [{ kind: 'read_conversation', reference: 'expired' }, { kind: 'read_session', targetId: 'pane' }, 'No result is available.'], observation);
  const result = await f.app.send({ text: 'What did the review terminal say?', origin: 'text' });
  assert.equal(result.ok, false);
});

test('reading another terminal cannot recover a failed read of the requested terminal', async t => {
  const f = await fixture(t, [{ kind: 'read_session', targetId: 'missing-required-pane' }, { kind: 'read_session', targetId: 'pane' }, 'Read the other output.']);
  const result = await f.app.send({ text: 'Read both requested terminals.', origin: 'text' });
  assert.equal(result.ok, false);
});

test('a fresh saved-conversation excerpt recovers an expired reference', async t => {
  const f = await fixture(t, [{ kind: 'list_conversations' }, { kind: 'read_conversation', reference: 'expired' }, { kind: 'read_conversation', reference: 'fresh' }, 'The review found a prompt submission bug.']);
  const result = await f.app.send({ text: 'Read that review result.', origin: 'text' });
  assert.equal(result.ok, true);
});

for (const next of [{ kind: 'read_conversation', reference: 'fresh' }, { kind: 'read_session', targetId: 'pane' }])
  test(`unknown history identity cannot be guessed from ${next.kind}`, async t => {
    const f = await fixture(t, [{ kind: 'read_conversation', reference: 'unknown' }, next, 'Only the other output was read.']);
    const result = await f.app.send({ text: 'Read both conversations.', origin: 'text' });
    assert.equal(result.ok, false);
  });

test('an unknown invalid tool cannot be certified by an unrelated read', async t => {
  const f = await fixture(t, [{ name: 'read_terminal', args: { targetId: 'other' } }, { kind: 'read_session', targetId: 'pane' }, 'Only this terminal was read.']);
  assert.equal((await f.app.send({ text: 'Read both terminals.', origin: 'text' })).ok, false);
});

const { createReadRecovery, readSource } = require('../../backend/orchestratorReadRecovery.cjs');
const identity = { id: 'saved', provider: 'claude', cwd: 'C:\\project', claudeHome: 'global' };
for (const change of [{ id: 'other' }, { provider: 'codex' }, { cwd: 'C:\\other' }, { claudeHome: 'custom' },
  { providerProfileId: 'custom-profile' }, { openFusion: true }]) {
  test(`different native identity cannot recover a read: ${JSON.stringify(change)}`, () => {
    const recovery = createReadRecovery(), failure = { ok: false };
    recovery.observe({ kind: 'read_conversation', reference: 'expired' }, { ok: false, readSource: readSource(identity) }, failure, true);
    recovery.observe({ kind: 'read_conversation', reference: 'fresh' }, { ok: true, text: 'Other content', readSource: readSource({ ...identity, ...change }) }, undefined, true);
    assert.equal(recovery.recovered(failure), false);
  });
}

test('a replaced terminal generation cannot recover an earlier terminal read', () => {
  const recovery = createReadRecovery(), failure = { ok: false };
  const session = { id: 'pane', generation: 'g1', provider: 'codex', cwd: 'C:\\project', conversationId: 'saved' };
  recovery.observe({ kind: 'read_session', targetId: 'pane' }, { ok: false, readSource: readSource(session, true) }, failure, true);
  recovery.observe({ kind: 'read_session', targetId: 'pane' }, { ok: true, readSource: readSource({ ...session, generation: 'g2' }, true), observation: { id: 'pane', generation: 'g2', text: 'Replacement' } }, undefined, true);
  assert.equal(recovery.recovered(failure), false);
});

test('same opaque reference can recover without guessing a native identity', () => {
  const recovery = createReadRecovery(), failure = { ok: false };
  recovery.observe({ kind: 'read_conversation', reference: 'same' }, failure, failure, true);
  recovery.observe({ kind: 'read_conversation', reference: 'same' }, { ok: true, text: 'Recovered content' }, undefined, true);
  assert.equal(recovery.recovered(failure), true);
});

for (const conversationId of ['saved', 'replacement']) test(`same pane recovery preserves native conversation ${conversationId}`, () => {
  const recovery = createReadRecovery(), failure = { ok: false };
  const session = { id: 'pane', generation: 'g1', provider: 'codex', cwd: 'C:\\project', conversationId: 'saved' };
  recovery.observe({ kind: 'read_session', targetId: 'pane' }, { ok: false, readSource: readSource(session, true) }, failure, true);
  recovery.observe({ kind: 'read_session', targetId: 'pane' }, { ok: true, readSource: readSource({ ...session, conversationId }, true), observation: { id: 'pane', generation: 'g1', text: 'Content' } }, undefined, true);
  assert.equal(recovery.recovered(failure), conversationId === 'saved');
});

test('an unavailable terminal observation is a failed read with no usable observation token', async t => {
  const f = await fixture(t, [{ kind: 'read_session', targetId: 'pane' }, 'The terminal cannot be read.'], { ok: false, status: 'unavailable' });
  const result = await f.app.send({ text: 'Read the review terminal.', origin: 'text' });
  assert.equal(result.ok, false);
  assert.equal(result.actions[0].status, 'unavailable');
  assert.equal(result.actions[0].observationToken, undefined);
});
