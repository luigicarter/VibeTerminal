'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const first = 'Review checkout and inspect the result.', answer = 'Use the standard review mode.';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Expected lifecycle transition did not occur'); await tick(); }
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-clarification-results-')), other = path.join(root, 'other');
  fs.mkdirSync(other);
  const sessions = [], effects = [], plans = [], phases = new Map();
  let call = 0;
  const response = value => new Response(JSON.stringify(value));
  const tool = action => response({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `call-${++call}`, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(action) } }] } }] });
  const app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [root, other] }), getSessions: () => sessions,
    getLaunchers: () => [{ kind: 'codex', label: 'Codex', available: true, configured: true }],
    interpretIntent: () => { assert(plans.length); return plans.shift(); },
    routeTask: () => ({ kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'Independent project task.' }),
    readSession: target => {
      const session = sessions.find(item => item.id === target.id);
      return { ok: true, id: session.id, generation: session.generation, text: 'Observed task output.', sequence: 10, inputRevision: 2,
        ...(target.completedTurnId && { completedResult: { turnId: target.completedTurnId, status: 'completed', text: 'Review found a checkout issue.' } }) };
    },
    dispatchAction: action => {
      effects.push(action);
      if (action.kind === 'create_session') {
        const id = `pane-${sessions.length + 1}`;
        const session = { id, name: id, generation: `g-${id}`, conversationId: `native-${id}`, cwd: action.cwd, kind: 'codex', provider: 'codex',
          launchToken: sessions.length + 1, processState: 'running', agentProcessState: 'running', agentPid: sessions.length + 100,
          observation: 'observed', turnState: 'idle', status: 'idle', started: true };
        sessions.push(session);
        return { ok: true, status: 'created', id, launchToken: session.launchToken, processState: 'running', target: { id, generation: session.generation, launchToken: session.launchToken } };
      }
      assert.equal(action.kind, 'send_prompt');
      Object.assign(sessions.find(item => item.id === action.targetId), { turnId: action.actionId, actionId: action.actionId, turnState: 'running', turnStartedAt: Date.now() });
      return { ok: true, status: 'written', turnId: action.actionId };
    },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return response({ data: {} });
      if (url.endsWith('/models')) return response({ data: [{ id: 'fixture', supported_parameters: ['tools'], context_length: 128000 }] });
      const body = JSON.parse(options.body), metadata = JSON.parse(body.messages.find(item => item.role === 'user').content);
      const grant = metadata.authorizedCommands?.grants.find(item => item.kind === 'operate_terminal');
      if (!grant) return response({ choices: [{ finish_reason: 'stop', message: { content: 'The agent reported a checkout issue.' } }] });
      const phase = phases.get(grant.id) || 0; phases.set(grant.id, phase + 1);
      const targetId = grant.targets[0].id;
      if (metadata.instruction === first && phase === 2) return tool({ kind: 'ask_user', text: 'Which review mode should I use for the remaining check?' });
      if (phase === 0 || phase === 2) return tool({ kind: 'read_session', targetId });
      const observed = JSON.parse(body.messages.filter(item => item.role === 'tool').at(-1).content);
      const base = { targetId, grantId: grant.id, stepId: `${grant.id}-${phase}`, observationToken: observed.observationToken };
      if (phase === 1 && metadata.instruction !== answer) return tool({ ...base, kind: 'send_prompt', text: grant.text || metadata.instruction });
      return tool({ ...base, kind: 'finish_terminal', outcome: 'completed', text: 'Submission inspected.' });
    }
  });
  t.after(async () => { await app.cancel(); await app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  // A bound task handoff is delivered by the application without a model turn,
  // so the clarification under test comes from operating this existing worker.
  sessions.push({ id: 'pane-1', name: 'pane-1', generation: 'g-pane-1', conversationId: 'native-pane-1', cwd: root, kind: 'codex', provider: 'codex',
    launchToken: 1, processState: 'running', agentProcessState: 'running', agentPid: 100, observation: 'observed', turnState: 'idle', status: 'idle', started: true });
  await app.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true }); await app.setEnabled(true);
  return { app, sessions, effects, plans, root, other, task: requestId => app.getState().tasks.find(item => item.requestId === requestId) };
}

for (const ending of ['completed', 'failed-before-answer']) test(`clarification retirement preserves dispatched result lifecycle: ${ending}`, { timeout: 4000 }, async t => {
  const f = await fixture(t);
  f.plans.push({ goal: first, actions: [{ kind: 'operate_terminal', targetIds: ['pane-1'], text: first }] });
  const a = await f.app.send({ text: first, origin: 'text' });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(f.task(a.requestId).status, 'needs-answer');
  const worker = f.sessions[0];
  assert.equal(worker.turnState, 'running');
  const dependentText = 'Update documentation using the completed review.';
  f.plans.push({ goal: dependentText, dependsOnRequestIds: [a.requestId], actions: [{ kind: 'delegate_task', cwd: f.other, text: dependentText }] });
  let bSettled = false;
  const bPending = f.app.send({ text: dependentText, origin: 'text' }).then(result => { bSettled = true; return result; });
  await until(() => f.app.getState().tasks.some(task => task.dependsOn.includes(a.requestId)));
  if (ending === 'failed-before-answer') { Object.assign(worker, { turnState: 'failed', turnEndedAt: Date.now(), error: 'Review failed.' }); await f.app.refresh(); }
  f.plans.push({ goal: 'Continue the unfinished review.', continuationOf: a.requestId, actions: [{ kind: 'operate_terminal', targetIds: [worker.id], sourceUserId: a.requestId }] });
  const c = await f.app.send({ text: answer, origin: 'text', replyToRequestId: a.requestId });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(f.effects.filter(action => action.kind === 'send_prompt').length, 1, 'Answering never resends A');
  if (ending === 'failed-before-answer') {
    assert.equal(f.task(a.requestId).status, 'failed');
    assert.equal((await bPending).ok, false);
    assert.equal(f.sessions.length, 1, 'A failed result cannot launch dependent work');
  } else {
    assert.equal(f.task(a.requestId).status, 'waiting-results');
    assert.equal(bSettled, false, 'Consuming the clarification must not release the dependency');
    assert.equal(f.sessions.length, 1);
    Object.assign(worker, { turnState: 'completed', turnEndedAt: Date.now(), completedTurnId: worker.turnId, completedActionId: worker.actionId });
    await f.app.refresh();
    const b = await bPending;
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(f.task(a.requestId).status, 'finished');
    assert.equal(f.effects.filter(action => action.kind === 'send_prompt').length, 2, 'B submits exactly once after A ends');
    assert.equal(f.sessions.length, 2);
  }
});
