'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');

async function fixture(t, changeAt) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-free-target-'));
  const sessions = ['a', 'b'].map(id => ({ id, generation: `g-${id}`, name: id, cwd: root, kind: 'codex', provider: 'codex', processState: 'running', agentProcessState: 'running', agentPid: id === 'a' ? 1 : 2, observation: 'observed', status: 'idle', turnState: 'idle' }));
  const effects = [], reads = [], contexts = []; let plan, phase = 0, changed = false;
  const busy = id => Object.assign(sessions.find(s => s.id === id), { status: 'running', turnState: 'running', turnId: 'other-work' });
  const app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [root] }),
    getSessions: () => {
      if (plan && changeAt === 'inventory' && !changed) { changed = true; busy(plan.grants[0].targets[0].id); }
      return sessions;
    },
    interpretIntent: context => { contexts.push(context); return context.instruction === 'What is pending?' ? { goal: 'Describe pending work.', actions: [] } : { goal: 'Review in a free terminal.', actions: [{ kind: 'operate_terminal', targetIds: ['a', 'b'], selection: 'one', targetAvailability: 'idle', text: 'Review changes.' }] }; },
    onChange: state => {
      if (!changed && changeAt === 'admission' && state.tasks.some(task => task.status === 'queued' && task.targetIds.length)) {
        changed = true; busy(state.tasks.find(task => task.status === 'queued' && task.targetIds.length).targetIds[0]);
      }
    },
    readSession: async target => { reads.push(target.id); if (changeAt === 'after-read' && !changed) { changed = true; busy(target.id); }
      return { ok: true, id: target.id, generation: target.generation, text: 'Empty input composer.', sequence: 1, inputRevision: 0 }; },
    dispatchAction: async action => { effects.push(action); if (changeAt === 'after-send') busy(action.targetId); return { ok: true, status: 'written' }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] }));
      const body = JSON.parse(options.body), context = JSON.parse(body.messages.find(m => m.role === 'user').content);
      plan = context.authorizedCommands;
      if (!plan.grants.length) return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'The task is waiting for a free terminal.' } }] }));
      const grant = plan.grants[0], targetId = grant.targets[0].id;
      const latest = () => JSON.parse(body.messages.filter(m => m.role === 'tool').at(-1).content);
      let action;
      if (phase === 0 || phase === 2) action = { kind: 'read_session', targetId };
      else if (phase === 1) action = { kind: 'send_prompt', targetId, grantId: grant.id, stepId: 'send', text: 'Review changes.', observationToken: latest().observationToken };
      else if (phase === 3) action = { kind: 'finish_terminal', targetId, grantId: grant.id, stepId: 'finish', outcome: ['after-read', 'after-send'].includes(changeAt) ? 'blocked' : 'completed', text: 'Input checked.', observationToken: latest().observationToken };
      else action = { kind: 'respond', text: 'The selected terminal became busy.', responseTurn: 'complete' };
      phase++;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `call-${phase}`, function: { name: 'workspace', arguments: JSON.stringify(action) } }] } }] }));
    } });
  t.after(async () => { await app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await app.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true }); await app.setEnabled(true);
  return { app, sessions, effects, reads, contexts };
}

test('availability drift during admission selects another original free candidate before reading or writing', async t => {
  const f = await fixture(t, 'admission');
  const result = await f.app.send({ text: 'Use a free Codex terminal to review changes.', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.effects.length, 1);
  assert.equal(f.effects[0].targetAvailability, 'idle');
  assert.equal(f.sessions.find(s => s.id === f.effects[0].targetId).turnState, 'idle');
  assert(f.reads.every(id => id === f.effects[0].targetId));
  assert.deepEqual(f.app.getState().tasks.find(task => task.requestId === result.requestId).targetIds, [f.effects[0].targetId]);
});

test('availability drift after observation never writes or queues, and recovery retains the idle constraint', async t => {
  const f = await fixture(t, 'after-read');
  const result = await f.app.send({ text: 'Use a free Codex terminal to review changes.', origin: 'text' });
  assert.equal(f.effects.length, 0);
  assert.equal(result.ok, false);
  // Status inspection exposes pending authority without granting another send.
  await f.app.send({ text: 'What is pending?', origin: 'text', replyToRequestId: result.requestId });
  const pending = f.contexts.at(-1).pendingCommands.find(command => command.requestId === result.requestId);
  assert.equal(pending.grants[0].targetAvailability, 'idle');
  assert.equal(pending.grants[0].targetCandidates.length, 2);
});

test('continuation of an already submitted task retains satisfied availability and its selected identity', async t => {
  const f = await fixture(t, 'after-send');
  const result = await f.app.send({ text: 'Use a free Codex terminal to review changes.', origin: 'text' });
  assert.equal(f.effects.length, 1);
  await f.app.send({ text: 'What is pending?', origin: 'text', replyToRequestId: result.requestId });
  const pending = f.contexts.at(-1).pendingCommands.find(command => command.requestId === result.requestId);
  assert.deepEqual(pending.grants[0].availabilitySatisfiedTargetIds, [f.effects[0].targetId]);
  assert.equal(pending.grants[0].availabilitySelectionLocked, true);
});
