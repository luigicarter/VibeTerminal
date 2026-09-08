'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Dependency fixture did not settle'); await new Promise(setImmediate); }
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dependency-create-'));
  const f = { root, effects: [], routes: [], plans: [], sessions: [], phases: new Map(), contexts: [], resultAvailable: true };
  const session = id => ({ id, generation: `generation-${id}`, launchToken: 1, cwd: root, kind: 'codex', provider: 'codex',
    conversationId: `conversation-${id}`, name: id, started: true, observation: 'observed', processState: 'running',
    agentProcessState: 'running', agentPid: 42, turnState: 'idle', revision: 1 });
  f.sessions.push(session('reviewer'));
  f.relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [root] }), getSessions: () => f.sessions,
    getLaunchers: () => [{ kind: 'codex', available: true, configured: true }],
    interpretIntent: () => { const plan = f.plans.shift(); assert.ok(plan, 'Every interpretation is scripted'); return plan; },
    routeTask: context => { f.routes.push(context); return { kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'Use a fresh worker for the dependent task.' }; },
    readSession: async target => ({ ok: true, id: target.id, generation: target.generation, sequence: 1, inputRevision: 0, text: '> ',
      ...(target.completedTurnId && f.resultAvailable && { completedResult: { turnId: target.completedTurnId, status: 'completed', text: 'The review found a checkout defect.' } }) }),
    dispatchAction: action => {
      f.effects.push(action);
      if (action.kind === 'create_session') {
        assert.equal(action.waitForReady, true);
        const created = session('implementer'); f.sessions.push(created);
        return { ok: true, id: created.id, launchToken: 1, status: 'created', processState: 'running', target: { id: created.id, generation: created.generation, launchToken: 1 } };
      }
      assert.equal(action.kind, 'send_prompt'); return { ok: true, status: 'written' };
    },
    fetch: async (url, options) => {
      const response = value => new Response(JSON.stringify(value));
      if (url.endsWith('/key')) return response({ data: {} });
      if (url.endsWith('/models')) return response({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] });
      const body = JSON.parse(options.body), context = JSON.parse(body.messages.find(message => message.role === 'user').content);
      f.contexts.push(context);
      const grant = context.authorizedCommands?.grants.find(item => item.kind === 'operate_terminal');
      if (!grant) return response({ choices: [{ finish_reason: 'stop', message: { content: 'Ready.' } }] });
      const phase = f.phases.get(grant.id) || 0; f.phases.set(grant.id, phase + 1);
      const targetId = grant.targets[0].id;
      let action;
      if (phase === 0 || phase === 2) action = { kind: 'read_session', targetId };
      else {
        const observed = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
        const base = { targetId, grantId: grant.id, stepId: `${grant.id}-${phase}`, observationToken: observed.observationToken };
        action = phase === 1 ? { ...base, kind: 'send_prompt', text: grant.text, observationSequence: observed.observation.sequence, inputRevision: observed.observation.inputRevision }
          : { ...base, kind: 'finish_terminal', outcome: 'completed', text: 'Submission inspected.' };
      }
      assert.ok(phase < 4);
      return response({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `${grant.id}-${phase}`, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(action) } }] } }] });
    } });
  t.after(async () => { await f.relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('vibe-dependency-create-')); fs.rmSync(root, { recursive: true, force: true }); });
  await f.relay.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true });
  assert.equal((await f.relay.setEnabled(true)).ok, true);
  f.plans.push({ goal: 'Review checkout.', actions: [{ kind: 'operate_terminal', targetIds: ['reviewer'], text: 'Review checkout.' }] });
  f.first = await f.relay.send({ text: 'Ask reviewer to review checkout.', origin: 'text' }); assert.equal(f.first.ok, true);
  f.plans.push({ goal: 'After the review finishes, create a worker to fix its findings.', dependsOnRequestIds: [f.first.requestId],
    actions: [{ kind: 'delegate_task', cwd: root, assignmentMode: 'new', text: 'Fix the findings from the completed review.' }] });
  f.pending = f.relay.send({ text: 'After that review finishes, open a fresh Codex and fix its findings.', origin: 'text' });
  await until(() => f.relay.getState().tasks.some(task => task.dependsOn.includes(f.first.requestId)));
  f.finish = async status => {
    const send = f.effects.find(action => action.kind === 'send_prompt');
    Object.assign(f.sessions[0], { turnId: 'review-turn', actionId: send.actionId, turnState: status, turnStartedAt: Date.now(), turnEndedAt: Date.now() });
    await f.relay.refresh();
  };
  return f;
}

test('automatic dependent creation waits for an attributable result without blocking unrelated routing', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(f.effects.map(action => action.kind), ['send_prompt']); assert.equal(f.routes.length, 0);
  const waiting = f.relay.getState().tasks.find(task => task.dependsOn.includes(f.first.requestId));
  assert.equal(waiting.status, 'queued'); assert.equal(waiting.workItemId, undefined);
  f.plans.push({ goal: 'Answer an unrelated request.', actions: [] });
  assert.equal((await f.relay.send({ text: 'Are you available?', origin: 'text' })).ok, true);
  assert.deepEqual(f.effects.map(action => action.kind), ['send_prompt']);
  await f.finish('completed');
  const result = await f.pending; assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.effects.map(action => action.kind), ['send_prompt', 'create_session', 'send_prompt']);
  assert.equal(f.effects[2].target.id, 'implementer');
  assert.equal(f.effects[2].target.generation, 'generation-implementer');
  assert.equal(f.effects[1].prompt, undefined);
  const context = f.contexts.find(item => item.authorizedCommands?.grants.some(grant => grant.targets.some(target => target.id === 'implementer')));
  assert.equal(context.dependencyResults[0].result.turnId, 'review-turn');
  assert.equal(f.relay.getState().tasks.find(task => task.requestId === result.requestId).status, 'waiting-results');
});

for (const outcome of ['failed', 'cancelled', 'missing-result']) test(`automatic dependent creation never runs after ${outcome} prerequisite`, { timeout: 5000 }, async t => {
  const f = await fixture(t);
  if (outcome === 'cancelled') await f.relay.cancel(f.first.requestId);
  else { if (outcome === 'missing-result') f.resultAvailable = false; await f.finish(outcome === 'failed' ? 'failed' : 'completed'); }
  const result = await f.pending; assert.equal(result.ok, false);
  assert.deepEqual(f.effects.map(action => action.kind), ['send_prompt']); assert.equal(f.routes.length, 0);
});
