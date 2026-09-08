'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { createTaskScheduler } = require('../../backend/orchestratorTasks.cjs');
const objective = 'Review checkout; do not edit.';
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-continuation-history-'));
  const sessions = [], effects = [], plans = [], contexts = [], executorContexts = [], projects = [root], phases = new Map();
  let ask = true, call = 0;
  const json = value => new Response(JSON.stringify(value));
  const tool = action => json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `tool-${++call}`, function: { name: 'workspace', arguments: JSON.stringify(action) } }] } }] });
  const session = (id, cwd = root) => ({ id, name: id, generation: `g-${id}`, conversationId: `native-${id}`, launchToken: 1, cwd, kind: 'codex', provider: 'codex',
    started: true, status: 'idle', processState: 'running', agentProcessState: 'running', agentPid: 101, observation: 'observed', turnState: 'idle' });
  const app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => sessions, getRoots: () => ({ documents: root, projects }),
    getLaunchers: () => [{ kind: 'codex', available: true, configured: true }],
    interpretIntent: context => { contexts.push(context); return context.instruction === 'hello' ? { goal: 'Hello', actions: [] } : plans.shift(); },
    routeTask: () => ({ kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'Independent review.' }),
    readSession: target => ({ ok: true, id: target.id, generation: target.generation, text: 'Ready to review.', sequence: 10, inputRevision: 2,
      ...(target.completedTurnId && { completedResult: { turnId: target.completedTurnId, status: 'completed', text: 'The review found a checkout defect.' } }) }),
    dispatchAction: action => {
      effects.push(action);
      if (action.kind === 'create_session') { const s = session(`created-${sessions.length + 1}`, action.cwd); sessions.push(s); return { ok: true, status: 'created', id: s.id, launchToken: 1, processState: 'running', target: { id: s.id, generation: s.generation, launchToken: 1 } }; }
      assert.equal(action.kind, 'send_prompt');
      Object.assign(sessions.find(s => s.id === action.targetId), { turnState: 'running', turnId: action.actionId, actionId: action.actionId, turnStartedAt: Date.now() });
      return { ok: true, status: 'written', turnId: action.actionId };
    },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return json({ data: {} });
      if (url.endsWith('/models')) return json({ data: [{ id: 'fixture', supported_parameters: ['tools'], context_length: 128000 }] });
      const body = JSON.parse(options.body), metadata = JSON.parse(body.messages.find(item => item.role === 'user').content);
      executorContexts.push(metadata);
      const grant = metadata.authorizedCommands?.grants.find(item => item.kind === 'operate_terminal');
      if (!grant) return json({ choices: [{ message: { content: 'Hello.' }, finish_reason: 'stop' }] });
      if (ask) return tool({ kind: 'ask_user', text: 'Which review mode should I use?' });
      const phase = phases.get(grant.id) || 0; phases.set(grant.id, phase + 1);
      const targetId = grant.targets[0].id;
      if (phase === 0 || phase === 2) return tool({ kind: 'read_session', targetId });
      const observed = JSON.parse(body.messages.filter(item => item.role === 'tool').at(-1).content);
      const base = { grantId: grant.id, targetId, stepId: `${grant.id}-${phase}`, observationToken: observed.observationToken };
      return tool(phase === 1 ? { ...base, kind: 'send_prompt', text: grant.text } : { ...base, kind: 'finish_terminal', outcome: 'completed', text: 'Submission inspected.' });
    }
  });
  t.after(async () => { await app.cancel(); await app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await app.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true }); await app.setEnabled(true);
  const run = (text, plan, extra = {}) => { plans.push(plan); return app.send({ text, origin: 'text', ...extra }); };
  const follow = (source, reply) => run('Use the standard review mode.', { goal: 'Continue review.', continuationOf: source,
    actions: [{ kind: 'operate_terminal', sourceUserId: source, targetIds: [sessions[0].id] }] }, { replyToRequestId: reply });
  return { app, root, sessions, effects, contexts, executorContexts, projects, session, run, follow, setAsk: value => { ask = value; }, task: id => app.getState().tasks.find(item => item.requestId === id) };
}

test('clearing history retains the actual prerequisite while a dependent waits for another workspace', { timeout: 4000 }, async t => {
  const f = await fixture(t); f.setAsk(false);
  const a = await f.run(objective, { goal: objective, actions: [{ kind: 'delegate_task', cwd: f.root, text: objective }] });
  Object.assign(f.sessions[0], { turnState: 'completed', turnEndedAt: Date.now() }); await f.app.refresh();
  assert.equal(f.task(a.requestId).status, 'finished');
  const other = path.join(f.root, 'other'); fs.mkdirSync(other); f.projects.push(other);
  const c = await f.run('Existing work elsewhere.', { goal: 'Existing work elsewhere.', actions: [{ kind: 'delegate_task', cwd: other, text: 'Existing work elsewhere.' }] });
  assert.equal(f.task(c.requestId).status, 'waiting-results');
  const dependentText = 'Apply the review findings.';
  const bPending = f.run(dependentText, { goal: dependentText, dependsOnRequestIds: [a.requestId], actions: [{ kind: 'delegate_task', cwd: other, text: dependentText }] });
  const deadline = Date.now() + 2000;
  while (!f.app.getState().tasks.some(task => task.sequence === 3 && task.targetIds.length && task.status === 'queued')) {
    assert(Date.now() < deadline, 'Dependent request reaches its workspace wait'); await new Promise(resolve => setImmediate(resolve));
  }
  await f.app.clearHistory();
  assert.equal(f.task(a.requestId).status, 'finished');
  assert.equal(f.app.getState().tasks.find(task => task.sequence === 3).status, 'queued');
  assert.equal(f.effects.filter(action => action.kind === 'send_prompt').length, 2);
  Object.assign(f.sessions[1], { turnState: 'completed', turnEndedAt: Date.now() }); await f.app.refresh();
  const b = await bPending;
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(f.effects.filter(action => action.kind === 'send_prompt' && action.text === dependentText).length, 1);
  assert.match(JSON.stringify(f.executorContexts.find(context => context.instruction === dependentText)?.dependencyResults), /checkout defect/);
  Object.assign(f.sessions[2], { turnState: 'completed', turnEndedAt: Date.now() }); await f.app.refresh();
  await f.app.clearHistory();
  assert.equal(f.task(a.requestId), undefined, 'Finished dependencies no longer pin old history');
});

for (const ending of ['finished', 'cancelled']) test(`transitive dependency protection is released after ${ending}`, () => {
  const scheduler = createTaskScheduler(); let prior;
  for (let index = 0; index < 200; index++) {
    const job = scheduler.create({ text: 'Dependent request', origin: 'text' });
    job.executionDone = true; scheduler.update(job, { status: 'finished', dependsOn: prior ? [prior.task.requestId] : [] }); prior = job;
  }
  scheduler.update(prior, { status: 'queued' });
  assert.equal(scheduler.hasCapacity(), false); scheduler.clear(); assert.equal(scheduler.snapshot().length, 200);
  if (ending === 'cancelled') scheduler.cancel(prior.task.requestId); else scheduler.update(prior, { status: 'finished' });
  assert.equal(scheduler.hasCapacity(), true); scheduler.clear(); assert.equal(scheduler.snapshot().length, 0);
});

for (const cleanup of ['clear', 'capacity']) test(`two clarifications retain the original operator through ${cleanup}`, { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const a = await f.run(objective, { goal: objective, actions: [{ kind: 'delegate_task', cwd: f.root, text: objective }] });
  const c = await f.follow(a.requestId, a.requestId);
  assert.equal(f.task(a.requestId).status, 'finished'); assert.equal(f.task(c.requestId).status, 'needs-answer');
  if (cleanup === 'clear') await f.app.clearHistory();
  else for (let index = 0; index < 202; index++) assert.equal((await f.app.send({ text: 'hello', origin: 'text' })).ok, true);
  assert(f.task(a.requestId), 'The original live operator state remains available');
  assert(f.app.getState().tasks.length <= 200);
  f.setAsk(false);
  const d = await f.follow(a.requestId, c.requestId);
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(f.effects.map(action => action.kind), ['create_session', 'send_prompt']);
  assert.equal(f.effects[1].text, objective);
  Object.assign(f.sessions[0], { turnState: 'completed', turnEndedAt: Date.now() }); await f.app.refresh();
  await f.app.clearHistory();
  assert.equal(f.task(a.requestId), undefined, 'Completed continuations release their original scopes');
});

test('cancelled continuation releases its retired owner for clearing', async t => {
  const f = await fixture(t);
  const a = await f.run(objective, { goal: objective, actions: [{ kind: 'delegate_task', cwd: f.root, text: objective }] });
  const c = await f.follow(a.requestId, a.requestId);
  await f.app.cancel({ requestId: c.requestId }); await f.app.clearHistory();
  assert.equal(f.task(a.requestId), undefined); assert.equal(f.task(c.requestId), undefined);
  assert.deepEqual(f.effects.map(action => action.kind), ['create_session']);
});

test('fully protected capacity refuses admission and is released when its continuation is cancelled', () => {
  const scheduler = createTaskScheduler();
  let prior;
  for (let index = 0; index < 200; index++) {
    const job = scheduler.create({ text: 'Continuation', origin: 'text' });
    job.intent = { commandPlan: { grants: prior ? [{ sourceUserId: prior.task.requestId }] : [] } };
    job.executionDone = true; scheduler.update(job, { status: 'finished' }); prior = job;
  }
  prior.context = { pendingCommand: { requestId: prior.task.requestId } }; scheduler.update(prior, { status: 'needs-answer' });
  assert.equal(scheduler.hasCapacity(), false);
  scheduler.cancel(prior.task.requestId);
  assert.equal(scheduler.hasCapacity(), true);
  scheduler.clear(); assert.equal(scheduler.snapshot().length, 0);
});

for (const ending of ['completed', 'cancelled']) test(`explicit live work affinity survives clearing until ${ending}`, async t => {
  const f = await fixture(t); f.sessions.push(f.session('explicit')); f.setAsk(false);
  const a = await f.run(objective, { goal: objective, actions: [{ kind: 'operate_terminal', targetIds: ['explicit'], text: objective }] });
  const workItemId = f.task(a.requestId).workItemId;
  await f.app.clearHistory();
  assert.equal(f.task(a.requestId).status, 'waiting-results');
  assert.equal((await f.app.send({ text: 'hello', origin: 'text', replyToRequestId: a.requestId })).ok, true);
  assert.equal(f.contexts.at(-1).replyWorkItem.id, workItemId);
  assert.equal(f.contexts.at(-1).replyWorkItem.objective, objective);
  assert.equal(f.effects.length, 1, 'Clearing and reading affinity cannot create or submit more work');
  if (ending === 'cancelled') await f.app.cancel({ requestId: a.requestId });
  // Cancellation keeps already-dispatched work owned until it actually ends.
  Object.assign(f.sessions[0], { turnState: 'completed', turnEndedAt: Date.now() }); await f.app.refresh();
  await f.app.clearHistory(); await f.app.dispose();
  const file = path.join(f.root, 'orchestrator-work-items.json');
  assert(!fs.existsSync(file) || !JSON.parse(fs.readFileSync(file, 'utf8')).items.some(item => item.id === workItemId));
});
