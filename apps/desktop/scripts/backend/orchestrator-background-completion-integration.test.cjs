'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createSessionDirectory } = require('../../backend/orchestratorIntegration.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { createTaskScheduler, hasWorkspaceOccupancy } = require('../../backend/orchestratorTasks.cjs');
const { createCompletionEvidence } = require('../../backend/orchestratorCompletion.cjs');
const tick = () => new Promise(setImmediate);
async function until(predicate) { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) throw Error('Background-completion fixture did not settle'); await tick(); } }

function chat(kind, cwd = process.cwd()) {
  const directory = createSessionDirectory();
  const generation = directory.outgoing(kind, { type: 'start', payload: { id: 'root', cwd } }).payload.generation;
  const emit = (type, fields = {}) => directory.ingest(kind, { id: 'root', generation, type, ...fields });
  emit('session', { sessionId: 'native-root' }); emit('engine-ready');
  return { directory, generation, emit, current: () => directory.get('root') };
}

async function fixture(t, kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-background-completion-'));
  const f = { ...chat(kind, root), root, native: [], effects: [], plans: [], phases: new Map(), followContexts: [], intentContexts: [] };
  let callId = 0;
  f.relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [root] }), getSessions: () => [...f.directory.list(), ...f.native],
    getLaunchers: () => [{ kind: 'codex', available: true, configured: true }],
    interpretIntent: context => { f.intentContexts.push(context); const plan = f.plans.shift(); assert.ok(plan); return plan; },
    routeTask: () => ({ kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'Use an independent worker.' }),
    readSession: async target => f.directory.get(target.id) ? f.directory.readChat(target)
      : { ok: true, id: target.id, generation: target.generation, sequence: 1, inputRevision: 0, text: '> ' },
    dispatchAction: action => {
      f.effects.push(action);
      if (action.kind === 'create_session') {
        const id = `worker-${f.native.length + 1}`, generation = `${id}-generation`;
        f.native.push({ id, generation, launchToken: 1, cwd: root, kind: 'codex', provider: 'codex', conversationId: `${id}-conversation`, name: id,
          processState: 'running', agentProcessState: 'running', agentPid: 42, observation: 'observed', turnState: 'idle' });
        return { ok: true, status: 'created', id, launchToken: 1, processState: 'running', target: { id, generation, launchToken: 1 } };
      }
      assert.equal(action.kind, 'send_prompt');
      if (action.target.id === 'root') {
        f.directory.outgoing(kind, { type: 'input', payload: { id: 'root', actionId: action.actionId } });
        f.emit('turn-start', { turnId: 'root-turn' });
      }
      return { ok: true, status: 'written' };
    },
    fetch: async (url, options) => {
      const response = value => new Response(JSON.stringify(value));
      if (url.endsWith('/key')) return response({ data: {} });
      if (url.endsWith('/models')) return response({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] });
      const body = JSON.parse(options.body), context = JSON.parse(body.messages.find(message => message.role === 'user').content);
      const grant = context.authorizedCommands?.grants.find(grant => grant.kind === 'operate_terminal');
      if (!grant) return response({ choices: [{ finish_reason: 'stop', message: { content: 'Observed agent result.' } }] });
      const targetId = grant.targets[0].id;
      if (targetId !== 'root') f.followContexts.push(context);
      const phase = f.phases.get(grant.id) || 0; f.phases.set(grant.id, phase + 1);
      let action;
      if (phase === 0 || phase === 2) action = { kind: 'read_session', targetId };
      else {
        const observed = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
        const base = { targetId, grantId: grant.id, stepId: `${grant.id}-${phase}`, observationToken: observed.observationToken };
        action = phase === 1 ? { ...base, kind: 'send_prompt', text: grant.text,
          observationSequence: observed.observation.sequence, inputRevision: observed.observation.inputRevision }
          : { ...base, kind: 'finish_terminal', outcome: 'completed', text: 'Submission inspected.' };
      }
      assert.ok(phase < 4);
      return response({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `tool-${++callId}`, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(action) } }] } }] });
    } });
  t.after(async () => { await f.relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('vibe-background-completion-')); fs.rmSync(root, { recursive: true, force: true }); });
  await f.relay.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true }); assert.equal((await f.relay.setEnabled(true)).ok, true);
  f.plans.push({ goal: 'Review with background investigators.', actions: [{ kind: 'operate_terminal', targetIds: ['root'], text: 'Review checkout with background investigators.' }] });
  f.first = await f.relay.send({ text: 'Review checkout with background investigators.', origin: 'text' }); assert.equal(f.first.ok, true);
  f.task = result => f.relay.getState().tasks.find(task => task.requestId === result.requestId);
  f.follow = dependency => {
    f.plans.push({ goal: 'Fix checkout.', ...(dependency && { dependsOnRequestIds: [f.first.requestId] }), actions: [{ kind: 'delegate_task', cwd: root, text: 'Fix checkout.' }] });
    return f.relay.send({ text: dependency ? 'After the review finishes, fix checkout.' : 'Independently fix checkout.', origin: 'text' });
  };
  return f;
}

for (const kind of ['fusion', 'openfusion']) test(`${kind}: dependent creation waits for the last detached child after a root result`, { timeout: 5000 }, async t => {
  const f = await fixture(t, kind);
  for (const taskId of ['one', 'two']) f.emit('background-task', { phase: 'started', taskId });
  f.emit('assistant-text', { text: 'The root response is available; investigators continue.' }); f.emit('result'); await f.relay.refresh();
  assert.equal(f.current().turnState, 'completed'); assert.equal(f.current().status, 'running');
  assert.equal(f.task(f.first).status, 'waiting-results'); assert.match(f.task(f.first).waitingReason, /background/);
  const pending = f.follow(true);
  await until(() => f.relay.getState().tasks.some(task => task.dependsOn.includes(f.first.requestId)));
  assert.deepEqual(f.effects.map(action => action.kind), ['send_prompt']);
  f.emit('background-task', { phase: 'settled', taskId: 'one' }); await f.relay.refresh(); await tick();
  assert.equal(f.task(f.first).status, 'waiting-results'); assert.equal(f.effects.length, 1);
  f.emit('background-task', { phase: 'settled', taskId: 'two' }); await f.relay.refresh();
  const result = await pending; assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.task(f.first).status, 'finished');
  assert.deepEqual(f.effects.map(action => action.kind), ['send_prompt', 'create_session', 'send_prompt']);
  assert.equal(f.followContexts[0].dependencyResults[0].result.turnId, 'root-turn');
  f.emit('background-task', { phase: 'settled', taskId: 'two' }); await f.relay.refresh();
  assert.equal(f.effects.filter(action => action.kind === 'send_prompt').length, 2);
});

test('structured background-activity keeps workspace ownership after foreground completion', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'openfusion');
  f.emit('background-activity', { backgroundActivity: { active: true, items: [{ id: 'external-task' }] } });
  f.emit('assistant-text', { text: 'Foreground finished.' }); f.emit('result'); await f.relay.refresh();
  const pending = f.follow(false);
  await until(() => f.relay.getState().tasks.some(task => task.sequence === 2 && task.targetIds.length && task.status === 'queued'));
  assert.deepEqual(f.effects.map(action => action.kind), ['send_prompt', 'create_session']);
  f.emit('background-activity', { backgroundActivity: { active: false, items: [] } }); await f.relay.refresh();
  assert.equal((await pending).ok, true); assert.equal(f.effects.filter(action => action.kind === 'send_prompt').length, 2);
});

for (const ending of ['error', 'interrupted']) test(`${ending} remains a failed task outcome despite active detached work`, { timeout: 5000 }, async t => {
  const f = await fixture(t, 'openfusion');
  f.emit('background-task', { phase: 'started', taskId: 'child' }); f.emit(ending, { message: 'Root stopped.' }); await f.relay.refresh();
  assert.equal(f.task(f.first).status, 'failed');
  const result = await f.follow(true); assert.equal(result.ok, false); assert.equal(f.effects.length, 1);
});

for (const cancel of [false, true]) test(`failed foreground retains child workspace ownership across clear${cancel ? ' and cancellation' : ''}`, { timeout: 5000 }, async t => {
  const f = await fixture(t, 'openfusion');
  f.emit('background-task', { phase: 'started', taskId: 'editing-child' }); f.emit('error', { message: 'Foreground failed.' }); await f.relay.refresh();
  const ownerId = f.task(f.first).workItemId;
  if (cancel) await f.relay.cancel(f.first.requestId);
  await f.relay.clearHistory(); assert.equal(f.task(f.first).status, 'failed');
  const pending = f.follow(false);
  await until(() => f.relay.getState().tasks.some(task => task.requestId !== f.first.requestId && task.targetIds.length && task.status === 'queued'));
  assert.ok(f.intentContexts.at(-1).workItems.some(item => item.id === ownerId), 'Explicit work-item affinity survives history clearing with live children');
  assert.deepEqual(f.effects.map(action => action.kind), ['send_prompt', 'create_session']);
  f.emit('background-task', { phase: 'settled', taskId: 'editing-child' }); await f.relay.refresh();
  const result = await pending; assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.task(f.first).status, 'failed', 'Settling detached work never turns the failed foreground into success');
  assert.equal(f.effects.filter(action => action.kind === 'send_prompt').length, 2);
  await f.relay.clearHistory(); assert.equal(f.task(f.first), undefined);
});

test('cancelling an active request does not release its known detached edits after the root fails', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'fusion'); f.emit('background-task', { phase: 'started', taskId: 'editing-child' }); await f.relay.refresh();
  await f.relay.cancel(f.first.requestId); f.emit('error', { message: 'Foreground failed after cancellation.' }); await f.relay.refresh();
  await f.relay.clearHistory(); assert.equal(f.task(f.first).status, 'cancelled');
  const pending = f.follow(false);
  await until(() => f.relay.getState().tasks.some(task => task.requestId !== f.first.requestId && task.targetIds.length && task.status === 'queued'));
  assert.deepEqual(f.effects.map(action => action.kind), ['send_prompt', 'create_session']);
  f.emit('background-task', { phase: 'settled', taskId: 'editing-child' }); await f.relay.refresh();
  assert.equal((await pending).ok, true); assert.equal(f.task(f.first).status, 'cancelled');
});

test('failed task occupancy survives capacity eviction and clears only after same-source child settlement', async () => {
  const f = chat('openfusion'), scheduler = createTaskScheduler();
  const owner = scheduler.create({ text: 'Start task' }); owner.lanes = [{ key: 'workspace:repo', targetIds: ['root'], workItemId: 'owner' }];
  f.directory.outgoing('openfusion', { type: 'input', payload: { id: 'root', actionId: 'submission' } }); f.emit('turn-start', { turnId: 'turn' });
  scheduler.track(owner, { kind: 'send_prompt', actionId: 'submission', targetId: 'root', generation: f.generation }, { ok: true, status: 'written', turnId: 'turn' }, f.current());
  owner.executionDone = true; scheduler.update(owner, { status: 'waiting-results' });
  f.emit('background-task', { phase: 'started', taskId: 'child' }); f.emit('error'); scheduler.reconcile(f.directory.list());
  assert.equal(owner.task.status, 'failed'); assert.equal(hasWorkspaceOccupancy(owner.waits[0]), true);
  for (let index = 0; index < 205; index++) { const job = scheduler.create({ text: `Archived ${index}` }); job.executionDone = true; scheduler.update(job, { status: 'finished' }); }
  assert.equal(scheduler.jobs.size, 200); assert.equal(scheduler.get(owner.task.requestId), owner);
  scheduler.clear(); assert.equal(scheduler.get(owner.task.requestId), owner);
  f.emit('background-task', { phase: 'settled', taskId: 'child' }); scheduler.reconcile(f.directory.list());
  assert.equal(owner.task.status, 'failed'); assert.equal(hasWorkspaceOccupancy(owner.waits[0]), false);
  scheduler.clear(); assert.equal(scheduler.get(owner.task.requestId), undefined);
});

test('replacement or missing native identity cannot settle a failed task child; retired generation releases its bounds', () => {
  const scheduler = createTaskScheduler(), owner = scheduler.create({ text: 'Task' });
  const native = { id: 'pane', generation: 'g', kind: 'codex', provider: 'codex', cwd: process.cwd(), conversationId: 'original',
    observation: 'observed', processState: 'running', turnId: 'turn', turnState: 'running', childActivity: true };
  scheduler.track(owner, { kind: 'send_prompt', actionId: 'send', targetId: 'pane', generation: 'g' }, { ok: true, status: 'written', turnId: 'turn' }, native);
  scheduler.reconcile([{ ...native, processState: 'exited' }]);
  assert.equal(owner.waits[0].failed, true); assert.equal(hasWorkspaceOccupancy(owner.waits[0]), true);
  for (const conversationId of [undefined, 'replacement']) {
    scheduler.reconcile([{ ...native, conversationId, childActivity: false, turnState: 'idle' }]);
    assert.equal(hasWorkspaceOccupancy(owner.waits[0]), true);
  }
  scheduler.reconcile([{ ...native, generation: 'new-generation', childActivity: false }]);
  assert.equal(hasWorkspaceOccupancy(owner.waits[0]), false); assert.equal(owner.waits[0].failed, true);
});

test('lost observation cannot turn a latched background wait into successful completion', () => {
  const scheduler = createTaskScheduler(), job = scheduler.create({ text: 'Task' });
  const session = { id: 'pane', generation: 'g', kind: 'codex', provider: 'codex', cwd: process.cwd(), conversationId: 'native',
    observation: 'observed', turnId: 'turn', turnState: 'completed', childActivity: true };
  scheduler.track(job, { kind: 'send_prompt', actionId: 'send', targetId: 'pane', generation: 'g' }, { ok: true, status: 'written', turnId: 'turn' }, session);
  scheduler.reconcile([session]); assert.equal(job.waits[0].done, false);
  scheduler.reconcile([{ ...session, observation: 'unavailable', childActivity: false }]);
  assert.equal(job.waits[0].done, false); assert.equal(hasWorkspaceOccupancy(job.waits[0]), true);
  scheduler.reconcile([{ ...session, childActivity: false }]);
  assert.equal(job.waits[0].done, true); assert.equal(hasWorkspaceOccupancy(job.waits[0]), false);
});

for (const kind of ['fusion', 'openfusion']) test(`${kind}: resolved permission keeps readiness pending until the active turn settles`, async () => {
  const f = chat(kind), scheduler = createTaskScheduler();
  f.emit('turn-start', { turnId: 'active-turn' }); f.emit('permission', { requestId: 'approval' });
  const watch = scheduler.create({ text: 'Wait until ready' });
  assert.equal(scheduler.watch(watch, { actionId: 'watch', watchUntil: 'ready', watchTarget: { id: 'root', generation: f.generation } }, f.current()).status, 'watching');
  watch.executionDone = true; scheduler.update(watch, { status: 'waiting-results' });
  f.emit('permission-resolved', { requestId: 'approval' }); scheduler.reconcile(f.directory.list());
  assert.equal(f.current().status, 'idle', 'Keep the new truthful display semantics'); assert.equal(f.current().turnActive, true);
  assert.equal(watch.waits[0].done, false);
  const ordinaryScheduler = createTaskScheduler(); ordinaryScheduler.reconcile(f.directory.list());
  const ordinary = ordinaryScheduler.create({ text: 'New ordinary prompt' }); ordinary.lanes = [{ key: 'terminal:root', targetIds: ['root'] }];
  let admitted = false; const ready = ordinaryScheduler.ready(ordinary).then(() => { admitted = true; });
  await tick(); assert.equal(admitted, false);
  const operatorScheduler = createTaskScheduler(); operatorScheduler.reconcile(f.directory.list());
  const operator = operatorScheduler.create({ text: 'Steer active work' }); operator.lanes = [{ key: 'terminal:root', targetIds: ['root'], operator: true }];
  await operatorScheduler.ready(operator);
  f.emit('result'); scheduler.reconcile(f.directory.list()); ordinaryScheduler.reconcile(f.directory.list()); await ready;
  assert.equal(watch.waits[0].done, true); assert.equal(admitted, true);
});

test('native completion capture waits for detached work, including a child appearing during the read', async () => {
  let session = { id: 'native', generation: 'g', turnId: 'turn', turnState: 'completed', observation: 'observed', turnStartedAt: 1, turnEndedAt: 2, childActivity: true };
  let reads = 0, spawnDuringRead = false;
  const evidence = createCompletionEvidence({ getSession: () => session, readObservation: async () => {
    reads++; if (spawnDuringRead) session = { ...session, childActivity: true };
    return { ok: true, generation: 'g', outputAt: 2, text: 'Observed final screen.', sequence: 1 };
  } });
  await evidence.capture(session); assert.equal(reads, 0); assert.equal(evidence.get(session), undefined);
  session = { ...session, childActivity: false }; spawnDuringRead = true;
  await evidence.capture(session); assert.equal(evidence.get(session), undefined);
  session = { ...session, childActivity: false }; spawnDuringRead = false;
  await evidence.capture(session); assert.equal(evidence.get(session).turnId, 'turn'); assert.equal(reads, 2);
});
