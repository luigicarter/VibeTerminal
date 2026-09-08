'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { createTaskScheduler } = require('../../backend/orchestratorTasks.cjs');
const tick = () => new Promise(setImmediate);
async function until(predicate) { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) throw Error('Multi-work-item fixture did not settle'); await tick(); } }

async function fixture(t, { separate = false, readOnly = false, explicitOrder, secondControls, controlsOnly = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-multi-work-'));
  const secondRoot = separate ? path.join(root, 'other-project') : root;
  if (separate) fs.mkdirSync(secondRoot);
  const f = { root, effects: [], plans: [], sessions: [], phases: new Map(), toolSequence: 0, recovered: 0, lastAction: new Map() };
  const nativeSession = (id, cwd) => ({ id, generation: `generation-${id}`, launchToken: 1, cwd, kind: 'codex', provider: 'codex',
    conversationId: `conversation-${id}`, name: id, started: true, observation: 'observed', processState: 'running',
    agentProcessState: 'running', agentPid: 42, turnState: 'idle', revision: 1 });
  if (explicitOrder) f.sessions.push(nativeSession('explicit-worker', explicitOrder === 'first' ? root : secondRoot));
  f.relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [...new Set([root, secondRoot])] }), getSessions: () => f.sessions,
    getLaunchers: () => [{ kind: 'codex', available: true, configured: true }],
    interpretIntent: () => { const plan = f.plans.shift(); assert.ok(plan); return plan; },
    routeTask: () => ({ kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'Separate work needs a separate conversation.' }),
    readSession: async target => ({ ok: true, id: target.id, generation: target.generation, sequence: 1, inputRevision: 0, text: '> ' }),
    dispatchAction: action => {
      f.effects.push(action);
      if (action.kind === 'create_session') {
        const id = `worker-${f.sessions.length + 1}`;
        const session = nativeSession(id, action.cwd);
        f.sessions.push(session);
        return { ok: true, id, launchToken: 1, status: 'created', processState: 'running', target: { id, generation: session.generation, launchToken: 1 } };
      }
      if (action.kind === 'interrupt') return new Promise(resolve => { f.releaseControl = () => resolve({ ok: true, status: 'written' }); });
      assert.ok(['send_prompt', 'terminal_interact'].includes(action.kind));
      if (action.kind === 'terminal_interact' && action.inputPurpose === 'interaction') return { ok: true, status: 'written' };
      Object.assign(f.sessions.find(session => session.id === action.target.id), { turnId: action.actionId, turnState: 'running', turnStartedAt: Date.now() });
      return { ok: true, status: 'written', turnId: action.actionId };
    },
    fetch: async (url, options) => {
      const response = value => new Response(JSON.stringify(value));
      if (url.endsWith('/key')) return response({ data: {} });
      if (url.endsWith('/models')) return response({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] });
      const body = JSON.parse(options.body), context = JSON.parse(body.messages.find(message => message.role === 'user').content);
      const tools = body.messages.filter(message => message.role === 'tool'), last = tools.length ? JSON.parse(tools.at(-1).content) : null;
      const previous = f.lastAction.get(context.instruction);
      if (last?.validationFailure && previous?.kind === 'send_prompt') {
        assert.equal(++f.recovered, 1, 'Only the deliberately stale token requires recovery');
        f.phases.set(previous.grantId, 0);
      }
      const grant = context.authorizedCommands.grants.find(grant => (f.phases.get(grant.id) || 0) < 4);
      assert.ok(grant, 'All granted operators must converge');
      const phase = f.phases.get(grant.id) || 0; f.phases.set(grant.id, phase + 1);
      const targetId = grant.targets[0].id;
      let action;
      if (phase === 0 || phase === 2) action = { kind: 'read_session', targetId };
      else {
        const base = { targetId, grantId: grant.id, stepId: `step-${++f.toolSequence}`, observationToken: last.observationToken };
        action = phase === 1 ? context.instruction === 'Interrupt first worker.' ? { ...base, kind: 'interrupt' }
          : { ...base, kind: 'send_prompt', text: grant.text, observationSequence: last.observation.sequence, inputRevision: last.observation.inputRevision }
          : { ...base, kind: 'finish_terminal', outcome: 'completed', text: 'Submission inspected.' };
        if (phase === 1 && grant.id === context.authorizedCommands.grants[1]?.id && (secondControls || controlsOnly)) {
          action = { ...base, kind: 'terminal_interact', observationSequence: last.observation.sequence, inputRevision: last.observation.inputRevision,
            inputPurpose: controlsOnly ? 'interaction' : 'task', ...(secondControls || { keys: ['down'] }) };
        }
      }
      f.lastAction.set(context.instruction, action);
      return response({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `tool-${++f.toolSequence}`, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(action) } }] } }] });
    } });
  t.after(async () => { f.releaseControl?.(); await f.relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('vibe-multi-work-')); fs.rmSync(root, { recursive: true, force: true }); });
  await f.relay.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true }); assert.equal((await f.relay.setEnabled(true)).ok, true);
  const first = { kind: 'delegate_task', cwd: root, text: readOnly ? 'Review checkout without editing.' : 'Fix checkout.' };
  const second = { kind: 'delegate_task', cwd: secondRoot, text: controlsOnly ? 'Select the menu entry.' : readOnly ? 'Review search without editing.' : 'Fix search.' };
  const explicit = grant => ({ kind: 'operate_terminal', targetIds: ['explicit-worker'], text: grant.text });
  f.plans.push({ goal: 'Work on checkout and search separately.', access: readOnly ? 'read-only' : 'mutation', actions: [
    explicitOrder === 'first' ? explicit(first) : first, explicitOrder === 'second' ? explicit(second) : second] });
  f.pending = f.relay.send({ text: 'Work on checkout and search separately.', origin: 'text' });
  f.sent = () => f.effects.filter(action => action.kind === 'send_prompt' || action.kind === 'terminal_interact' && action.inputPurpose === 'task');
  f.parked = () => f.relay.getState().tasks.find(task => task.waitingReason?.includes('before submitting the next task'));
  f.finishFirst = async () => { Object.assign(f.sessions.find(session => session.id === f.sent()[0].target.id), { turnState: 'completed', turnEndedAt: Date.now() }); await f.relay.refresh(); };
  return f;
}

test('bundled mutations park sibling submission, admit controls, then reacquire control lanes before one send', { timeout: 5000 }, async t => {
  const f = await fixture(t); await until(() => f.parked());
  assert.equal(f.sent().length, 1); assert.equal(f.effects.filter(action => action.kind === 'create_session').length, 2);
  f.plans.push({ goal: 'Interrupt first worker.', actions: [{ kind: 'operate_terminal', targetIds: ['worker-1'], text: 'Interrupt first worker.', lifecycleMode: 'interrupt' }] });
  const control = f.relay.send({ text: 'Interrupt first worker.', origin: 'text' });
  await until(() => f.releaseControl);
  await f.finishFirst(); await tick();
  assert.equal(f.sent().length, 1, 'The later admitted control loop still owns its terminal');
  f.releaseControl(); assert.equal((await control).ok, true);
  const result = await f.pending; assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.sent().map(action => [action.target.id, action.text]), [['worker-1', 'Fix checkout.'], ['worker-2', 'Fix search.']]);
  assert.equal(f.relay.getState().tasks.find(task => task.requestId === result.requestId).status, 'waiting-results');
});

test('parked sibling cancellation never submits its preserved prompt', { timeout: 5000 }, async t => {
  const f = await fixture(t); await until(() => f.parked());
  await f.relay.cancel(f.parked().requestId); assert.equal((await f.pending).ok, false);
  await f.finishFirst(); await tick(); assert.equal(f.sent().length, 1);
});

test('a sibling token made stale while parked requires an actual reread before submission', { timeout: 5000 }, async t => {
  const f = await fixture(t); await until(() => f.parked());
  f.sessions[1].turnId = 'intervening-turn';
  await f.finishFirst(); const result = await f.pending;
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.recovered, 1);
  assert.equal(f.sent().length, 2, 'The rejected stale attempt never reaches transport');
});

for (const options of [{ separate: true }, { readOnly: true }]) test(`bundled ${options.separate ? 'separate-project mutations' : 'read-only tasks'} remain independent`, { timeout: 5000 }, async t => {
  const f = await fixture(t, options); const result = await f.pending;
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.sent().length, 2); assert.equal(f.sessions[0].turnState, 'running');
});

for (const secondControls of [...[' Enter ', ' CTRL-M ', 'Ctrl-J'].map(key => ({ keys: [key] })),
  ...['click', 'up'].map(action => ({ mouse: { x: 2, y: 2, button: 'left', action } }))]) {
  test(`native task submission controls cannot bypass sibling parking: ${JSON.stringify(secondControls)}`, { timeout: 5000 }, async t => {
    const f = await fixture(t, { secondControls }); await until(() => f.parked());
    assert.equal(f.sent().length, 1); await f.finishFirst();
    const result = await f.pending; assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.sent().map(action => action.kind), ['send_prompt', 'terminal_interact']);
  });
}

for (const explicitOrder of ['first', 'second']) test(`mixed routed/explicit mutations serialize with explicit target ${explicitOrder}`, { timeout: 5000 }, async t => {
  const f = await fixture(t, { explicitOrder }); await until(() => f.parked());
  assert.equal(f.sent().length, 1); await f.finishFirst();
  const result = await f.pending; assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.sent().map(action => action.text), ['Fix checkout.', 'Fix search.']);
  assert.equal(f.sent().filter(action => action.target.id === 'explicit-worker').length, 1);
});

test('mixed routed/explicit tasks in separate workspaces remain independent', { timeout: 5000 }, async t => {
  const f = await fixture(t, { explicitOrder: 'second', separate: true });
  const result = await f.pending; assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.sent().length, 2);
  assert.equal(f.sessions.find(session => session.id === f.sent()[0].target.id).turnState, 'running');
});

test('explicit interaction-only controls remain available beside a running routed sibling', { timeout: 5000 }, async t => {
  const f = await fixture(t, { explicitOrder: 'second', controlsOnly: true });
  const result = await f.pending; assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.sent().length, 1);
  assert.equal(f.effects.filter(action => action.kind === 'terminal_interact' && action.inputPurpose === 'interaction').length, 1);
});

for (const status of ['queued', 'unknown', 'staged']) test(`same-job submission admission retains ${status} sibling evidence appropriately`, async () => {
  const scheduler = createTaskScheduler(), job = scheduler.create({ text: 'Two tasks' });
  job.task.targetIds = ['a', 'b'];
  job.lanes = ['a', 'b'].flatMap(id => [{ key: `terminal:${id}`, operator: true, targetIds: [id], workItemId: id },
    { key: 'workspace:repo', targetIds: [id], workItemId: id }]);
  await scheduler.ready(job);
  scheduler.track(job, { kind: 'send_prompt', actionId: 'first', targetId: 'a', generation: 'g', operator: true }, { ok: status !== 'unknown', status });
  let settled = false;
  const pending = scheduler.waitForAssignmentSubmission(job, { targetId: 'b', workItemId: 'b' }).then(() => { settled = true; });
  await tick(); assert.equal(settled, status === 'staged');
  if (status !== 'staged') {
    assert.equal(job.parkedForSubmission, true);
    scheduler.delivery({ actionId: 'first', ok: false, status: 'blocked', delivery: 'not-dispatched' }); scheduler.reconcile([]);
  }
  await pending; assert.equal(job.parkedForSubmission || false, false);
});

test('same work-item continuations never wait on their own earlier submission', async () => {
  const scheduler = createTaskScheduler(), job = scheduler.create({ text: 'Continue one task' });
  job.lanes = ['a', 'b'].map(id => ({ key: 'workspace:repo', targetIds: [id], workItemId: 'same' }));
  scheduler.track(job, { kind: 'send_prompt', actionId: 'first', targetId: 'a', generation: 'g' }, { ok: true, status: 'written' });
  assert.equal(await scheduler.waitForAssignmentSubmission(job, { targetId: 'b', workItemId: 'same' }), false);
});

test('parked ownership admits its incumbent continuation while retaining incompatible workspace locks', async () => {
  const scheduler = createTaskScheduler();
  const lanes = (targetId, workItemId) => [{ key: `terminal:${targetId}`, operator: true, targetIds: [targetId], workItemId },
    { key: 'workspace:repo', targetIds: [targetId], workItemId }];
  const original = scheduler.create({ text: 'Two tasks' });
  original.lanes = [...lanes('a', 'first'), ...lanes('b', 'second')]; await scheduler.ready(original);
  scheduler.track(original, { kind: 'send_prompt', actionId: 'first-send', targetId: 'a', generation: 'g' },
    { ok: true, status: 'written', turnId: 'first-turn' });
  let resumed = false;
  const pending = scheduler.waitForAssignmentSubmission(original, { targetId: 'b', workItemId: 'second' }).then(() => { resumed = true; });
  const independent = scheduler.create({ text: 'Independent mutation' }); independent.lanes = lanes('other', 'other-work');
  let independentAdmitted = false;
  const blocked = scheduler.ready(independent).then(() => { independentAdmitted = true; }, () => {});
  const continuation = scheduler.create({ text: 'Continue first task' }); continuation.lanes = lanes('a', 'first');
  let continuationAdmitted = false;
  const entering = scheduler.ready(continuation).then(() => { continuationAdmitted = true; });
  await tick(); assert.equal(continuationAdmitted, true); assert.equal(independentAdmitted, false);
  await entering; scheduler.cancel(independent.task.requestId); await blocked;
  scheduler.reconcile([{ id: 'a', generation: 'g', turnId: 'first-turn', turnState: 'completed' }]);
  await tick(); assert.equal(resumed, false, 'The admitted continuation still owns its active control loop');
  continuation.executionDone = true; scheduler.update(continuation, { status: 'finished' });
  await pending; assert.equal(resumed, true);
});
