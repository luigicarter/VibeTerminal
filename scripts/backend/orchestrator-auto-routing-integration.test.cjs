'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { observeWorkItemCommits } = require('./orchestrator-work-item-persistence-fixture.cjs');
let sequence = 0;
const tool = action => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `auto-${++sequence}`, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(action) } }] } }] });
const jsonResponse = body => new Response(JSON.stringify(body));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Fixture condition did not settle within 1.5 seconds'); await tick(); }
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-auto-routing-'));
  const f = { root, projects: [{ name: 'Project', path: root }], sessions: [], effects: [], contexts: [], routes: [], reads: [], plans: [], phases: new Map(),
    launchers: [{ kind: 'codex', label: 'Codex', available: true, configured: true }] };
  f.commits = observeWorkItemCommits(t, path.join(root, 'orchestrator-work-items.json'), () => f.relay?.getState().tasks);
  f.session = (id = 'pane', cwd = root) => ({ id, name: id, cwd, kind: 'codex', provider: 'codex', generation: `generation-${id}`,
    launchToken: f.sessions.length + 1, conversationId: `conversation-${id}`, started: true, status: 'idle', observation: 'observed',
    processState: 'running', agentProcessState: 'running', agentPid: 100 + f.sessions.length, turnState: 'idle', revision: 1 });
  f.created = action => {
    const session = f.session(`created-${f.sessions.length + 1}`, action.cwd); f.sessions.push(session);
    return { ok: true, status: 'created', id: session.id, launchToken: session.launchToken, processState: 'running',
      target: { id: session.id, generation: session.generation, launchToken: session.launchToken } };
  };
  f.relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: f.projects }), getSessions: () => f.sessions,
    getLaunchers: () => f.launchers,
    interpretIntent: async context => {
      f.contexts.push(context);
      const plan = f.plans.shift();
      assert.ok(plan, 'Every user request has one explicitly scripted interpretation');
      const interpreted = typeof plan === 'function' ? await plan(context) : plan;
      return interpreted.actions ? interpreted : { goal: context.instruction, actions: [interpreted] };
    },
    routeTask: async (context, api) => {
      f.routes.push(context);
      return f.route ? f.route(context, api) : { kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'Independent task needs its own conversation.' };
    },
    readSession: async target => {
      f.reads.push(target);
      const session = f.sessions.find(s => s.id === target.id);
      if (!session) return { ok: false, status: 'stale-generation' };
      const result = { ok: true, id: session.id, generation: session.generation, text: 'Task workspace ready.', sequence: 10, observationSequence: 10, inputRevision: 2 };
      if (target.completedTurnId) result.completedResult = { turnId: target.completedTurnId, text: 'Review found a checkout defect.', status: 'completed' };
      if (f.afterRead) await f.afterRead(session);
      return result;
    },
    dispatchAction: async action => {
      f.effects.push(action);
      if (action.kind === 'create_session') {
        assert.equal(action.waitForReady, true);
        assert.equal(action.prompt, undefined); assert.equal(action.text, undefined);
        if (f.create) return f.create(action);
        return f.created(action);
      }
      assert.ok(['send_prompt', 'terminal_interact'].includes(action.kind), 'Only native input reaches this fixture transport');
      if (f.sendEffect) return f.sendEffect(action);
      return { ok: true, status: 'written' };
    },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return jsonResponse({ data: {} });
      if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'scripted', context_length: 128000, supported_parameters: ['tools', 'tool_choice'] }] });
      const body = JSON.parse(options.body);
      const metadata = JSON.parse(body.messages.find(message => message.role === 'user').content);
      const grant = metadata.authorizedCommands?.grants.find(g => g.kind === 'operate_terminal');
      if (!grant) return jsonResponse({ choices: [{ message: { content: 'No terminal work submitted.' }, finish_reason: 'stop' }] });
      const phase = f.phases.get(grant.id) || 0; f.phases.set(grant.id, phase + 1);
      const targetId = grant.targets[0].id;
      if (f.executor) { const custom = await f.executor({ body, metadata, grant, phase, targetId }); if (custom) return jsonResponse(tool(custom)); }
      if (phase === 0 || phase === 2) return jsonResponse(tool({ kind: 'read_session', targetId }));
      const observed = JSON.parse(body.messages.filter(m => m.role === 'tool').at(-1).content);
      const base = { targetId, grantId: grant.id, stepId: `${grant.id}-${phase}`, observationToken: observed.observationToken };
      if (phase === 1) return jsonResponse(tool({ ...base, kind: 'send_prompt', text: grant.text || metadata.instruction,
        observationSequence: observed.observation?.sequence, inputRevision: observed.observation?.inputRevision }));
      if (phase === 3) return jsonResponse(tool({ ...base, kind: 'finish_terminal', outcome: 'completed', text: 'Submission inspected.' }));
      return jsonResponse(tool({ kind: 'respond', text: 'The requested submission is blocked.', responseTurn: 'complete' }));
    }
  });
  t.after(async () => { f.release?.(); await f.relay.cancel(); await f.relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await f.relay.configure({ apiKey: 'test-key', model: 'scripted', sessionOnly: true });
  assert.equal((await f.relay.setEnabled(true)).ok, true);
  f.plan = (text, extra = {}) => ({ kind: 'delegate_task', text, cwd: root, ...extra });
  f.run = async (text, extra = {}, input = {}) => { f.plans.push(f.plan(text, extra)); return f.relay.send({ text, origin: 'text', ...input }); };
  f.task = result => f.relay.getState().tasks.find(task => task.requestId === result.requestId);
  return f;
}

test('automatic creation binds the real launch then submits exactly once with no creation result wait', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  const result = await f.run('Fix checkout validation.');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.effects.map(a => a.kind), ['create_session', 'send_prompt']);
  assert.equal(f.effects[1].target.generation, f.sessions[0].generation);
  assert.equal(f.effects[1].text, 'Fix checkout validation.');
  const task = f.task(result); assert.ok(task.workItemId);
  const session = f.sessions[0];
  Object.assign(session, { turnId: 'actual-turn', actionId: f.effects[1].actionId, turnState: 'completed', turnStartedAt: Date.now(), turnEndedAt: Date.now() });
  await f.relay.refresh();
  assert.equal(f.task(result).status, 'finished', 'Only the actual send result must finish the request; creation cannot leave a phantom wait');
});

test('an exact literal task survives automatic worker creation unchanged', { timeout: 2000 }, async t => {
  const f = await fixture(t); const text = 'Review "checkout"; do not edit.\nReport exactly three findings.';
  const result = await f.run(text, { promptMode: 'literal' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.effects.find(a => a.kind === 'send_prompt').text, text);
});

test('a timed-out creation recovers only its original ready pane for a later authorized follow-up', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  f.create = action => {
    const result = f.created(action);
    Object.assign(f.sessions[0], { agentProcessState: 'starting', agentPid: undefined, turnState: 'starting', status: 'starting' });
    return { ...result, ok: false, status: 'launch-timeout', target: undefined, sessionCreated: true, delivery: 'not-dispatched', error: 'The pane is still starting.' };
  };
  const first = await f.run('Fix checkout validation.');
  assert.equal(first.ok, false);
  const workItemId = f.task(first).workItemId;
  assert.deepEqual(f.effects.map(action => action.kind), ['create_session']);
  Object.assign(f.sessions[0], { agentProcessState: 'running', agentPid: 101, turnState: 'idle', status: 'idle' });
  await f.relay.refresh();
  const second = await f.run('Continue the checkout task.', { workItemId }, { replyToRequestId: first.requestId });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(f.effects.map(action => action.kind), ['create_session', 'send_prompt']);
  assert.equal(f.effects[1].targetId, f.sessions[0].id);
});

test('Windows directory separators normalize consistently across assignment and affinity', { timeout: 2000, skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const cwd = f.root.replace(/\\/g, '\\\\');
  const first = await f.run('Fix checkout validation.', { cwd });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await f.run('Also cover coupons.', { workItemId: f.task(first).workItemId }, { replyToRequestId: first.requestId });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(f.effects.filter(action => action.kind === 'create_session').length, 1);
});

test('independent same-project work creates a distinct conversation after the prior task completes', { timeout: 2000 }, async t => {
  const f = await fixture(t); const first = await f.run('Fix checkout.');
  const session = f.sessions[0]; const submission = f.effects.find(a => a.kind === 'send_prompt');
  Object.assign(session, { turnId: 'checkout-done', actionId: submission.actionId, turnState: 'completed', turnStartedAt: Date.now(), turnEndedAt: Date.now() });
  await f.relay.refresh();
  const next = await f.run('Update deployment documentation.');
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(f.effects.filter(a => a.kind === 'create_session').length, 2);
  assert.notEqual(f.task(first).workItemId, f.task(next).workItemId);
  assert.notEqual(f.effects.filter(a => a.kind === 'send_prompt')[0].targetId, f.effects.filter(a => a.kind === 'send_prompt')[1].targetId);
});

test('related busy owner A is reused after unrelated B while independent work creates its own worker', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  const a = await f.run('Fix checkout.'); const owner = f.task(a).workItemId;
  const pane = f.sessions[0];
  Object.assign(pane, { turnState: 'running', turnId: 'checkout-turn', turnStartedAt: Date.now(), status: 'running' });
  // B uses another project so the request is independent of A's mutation lease.
  const other = path.join(f.root, 'other'); fs.mkdirSync(other);
  f.projects.push({ name: 'Other', path: other });
  f.plans.push({ kind: 'delegate_task', text: 'Update deployment notes.', cwd: other });
  const b = await f.relay.send({ text: 'Update deployment notes.', origin: 'text' });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.notEqual(f.task(b).workItemId, owner);
  const follow = await f.run('Also cover expired coupons.', { workItemId: owner }, { replyToRequestId: a.requestId });
  assert.equal(follow.ok, true, JSON.stringify(follow));
  assert.equal(f.effects.filter(a => a.kind === 'create_session').length, 2);
  assert.equal(f.effects.filter(a => a.kind === 'send_prompt').at(-1).targetId, pane.id);
});

test('unowned reuse requires candidate read evidence before binding', { timeout: 2000 }, async t => {
  const f = await fixture(t); f.sessions.push(f.session());
  f.route = async (_context, { read }) => { await read({ kind: 'read_session', targetId: 'pane' }); return { kind: 'choose', decision: 'reuse', targetId: 'pane', reason: 'Fresh relevant workspace.' }; };
  const result = await f.run('Review checkout.');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.effects.map(a => a.kind), ['send_prompt']);
  assert.ok(f.reads.length >= 3, 'Discovery plus pre/post submission observations');
});

test('unread unowned reuse and missing configured launchers never dispatch', { timeout: 2000 }, async t => {
  const f = await fixture(t); f.sessions.push(f.session());
  f.route = () => ({ kind: 'choose', decision: 'reuse', targetId: 'pane', reason: 'Title only.' });
  await f.run('Review checkout.'); assert.equal(f.effects.length, 0);
  f.sessions = []; f.launchers = [{ kind: 'codex', available: false, configured: false }];
  f.route = () => ({ kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'Needs worker.' });
  await f.run('Fix checkout.'); assert.equal(f.effects.length, 0);
});

for (const status of ['unknown', 'failed']) test(`${status} creation never submits input or retries creation`, { timeout: 2000 }, async t => {
  const f = await fixture(t); f.create = () => ({ ok: false, status, error: 'Fixture startup outcome' });
  await f.run('Fix checkout.');
  assert.deepEqual(f.effects.map(a => a.kind), ['create_session']);
});

test('a related request arriving during creation shares the pending worker and submits its own prompt once', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  const barrier = new Promise(resolve => { f.release = resolve; });
  f.create = async action => { await barrier; return f.created(action); };
  const first = f.run('Fix checkout.');
  await until(() => f.effects.some(a => a.kind === 'create_session'));
  f.plans.push(context => {
    const workItem = context.workItems.find(item => item.objective === 'Fix checkout.' || item.text === 'Fix checkout.');
    assert.ok(workItem, 'Pending creation is discoverable as an existing work item');
    return f.plan('Also cover coupons.', { workItemId: workItem.id });
  });
  const second = f.relay.send({ text: 'Also cover coupons.', origin: 'text' });
  await until(() => f.contexts.length === 2);
  assert.equal(f.effects.filter(a => a.kind === 'create_session').length, 1);
  f.release();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.ok), JSON.stringify(results));
  assert.deepEqual(f.effects.map(a => a.kind), ['create_session', 'send_prompt', 'send_prompt']);
  assert.equal(f.effects[1].targetId, f.effects[2].targetId);
  assert.equal(f.task(results[0]).workItemId, f.task(results[1]).workItemId);
});

test('cancellation during creation preserves a late pane without sending or duplicating creation', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  const barrier = new Promise(resolve => { f.release = resolve; });
  f.create = async action => { await barrier; return f.created(action); };
  const running = f.run('Fix checkout.');
  await until(() => f.effects.length === 1);
  await f.relay.cancel(); f.release(); await running;
  assert.deepEqual(f.effects.map(a => a.kind), ['create_session']);
  assert.equal(f.sessions.length, 1, 'Cancellation does not delete the actual late-created pane');
});

test('a candidate generation changed after discovery cannot receive the frozen prompt', { timeout: 2000 }, async t => {
  const f = await fixture(t); f.sessions.push(f.session());
  f.route = async (_context, { read }) => {
    await read({ kind: 'read_session', targetId: 'pane' });
    return { kind: 'choose', decision: 'reuse', targetId: 'pane', reason: 'Candidate read.' };
  };
  f.afterRead = session => { if (f.reads.length === 2) session.generation = 'replacement-generation'; };
  await f.run('Fix checkout.');
  assert.equal(f.effects.filter(a => a.kind === 'send_prompt').length, 0);
});

test('a native conversation replaced within the same generation cannot receive the frozen prompt', { timeout: 2000 }, async t => {
  const f = await fixture(t); f.sessions.push(f.session());
  const originalGeneration = f.sessions[0].generation;
  f.route = async (_context, { read }) => {
    await read({ kind: 'read_session', targetId: 'pane' });
    return { kind: 'choose', decision: 'reuse', targetId: 'pane', reason: 'Candidate read.' };
  };
  f.afterRead = session => { if (f.reads.length === 2) session.conversationId = 'replacement-conversation'; };
  await f.run('Fix checkout.');
  assert.equal(f.sessions[0].generation, originalGeneration);
  assert.equal(f.effects.filter(a => a.kind === 'send_prompt').length, 0);
});

test('a newly revealed conversation identity is latched before a later operator effect', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  f.create = action => { const result = f.created(action); delete f.sessions[0].conversationId; return result; };
  f.sendEffect = () => { f.sessions[0].conversationId = 'first-native-conversation'; return { ok: true, status: 'written' }; };
  f.afterRead = session => { if (f.effects.some(a => a.kind === 'send_prompt')) session.conversationId = 'replacement-native-conversation'; };
  f.executor = ({ body, grant, phase, targetId }) => {
    if (phase !== 3) return;
    const observed = JSON.parse(body.messages.filter(m => m.role === 'tool').at(-1).content);
    return { kind: 'send_prompt', grantId: grant.id, targetId, stepId: 'second-effect', text: 'Check the same task again.',
      observationToken: observed.observationToken, observationSequence: observed.observation?.sequence, inputRevision: observed.observation?.inputRevision };
  };
  await f.run('Fix checkout and check the same task again.');
  assert.equal(f.effects.filter(a => a.kind === 'send_prompt').length, 1);
});

test('an explicitly submitted managed task holds its workspace against independent automatic work', { timeout: 2000 }, async t => {
  const f = await fixture(t); f.sessions.push(f.session());
  f.plans.push({ kind: 'operate_terminal', targetIds: ['pane'], text: 'Fix checkout.' });
  const first = await f.relay.send({ text: 'Use pane to fix checkout.', origin: 'text' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const submission = f.effects.find(a => a.kind === 'send_prompt');
  const second = f.run('Update deployment documentation.');
  await until(() => f.effects.filter(a => a.kind === 'send_prompt').length > 1
    || f.relay.getState().tasks.some(task => task.sequence === 2 && task.workItemId && task.status === 'queued'));
  await tick();
  assert.equal(f.effects.filter(a => a.kind === 'send_prompt').length, 1, 'Automatic work must wait for explicit managed work, even without busy telemetry');
  Object.assign(f.sessions[0], { turnId: 'explicit-result', actionId: submission.actionId, turnState: 'completed', turnStartedAt: Date.now(), turnEndedAt: Date.now() });
  await f.relay.refresh();
  const result = await second; assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.effects.filter(a => a.kind === 'send_prompt').length, 2);
});

test('continuing an unsent queued task transfers its original request and submits only once', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  await f.run('Earlier project work.');
  const earlier = f.sessions[0], earlierSend = f.effects.find(action => action.kind === 'send_prompt');
  const pending = f.run('Review the queued task; do not edit.');
  await until(() => f.relay.getState().tasks.some(task => task.text === 'Review the queued task; do not edit.' && task.status === 'queued' && task.targetIds.length));
  const original = f.relay.getState().tasks.find(task => task.text === 'Review the queued task; do not edit.');
  const target = f.sessions[1];
  f.plans.push(context => {
    const queued = context.pendingCommands.find(command => command.requestId === original.requestId);
    assert.equal(queued?.queued, true, 'The unsent original must be exposed as pending authority');
    assert.equal(queued.grants[0].text, 'Review the queued task; do not edit.');
    return { goal: 'Continue the original task.', continuationOf: original.requestId, actions: [
      { kind: 'operate_terminal', sourceUserId: original.requestId, targetIds: [target.id] }
    ] };
  });
  const resumed = f.relay.send({ text: 'Send that queued task.', origin: 'text', replyToRequestId: original.requestId });
  await until(() => f.relay.getState().tasks.find(task => task.requestId === original.requestId).status === 'cancelled');
  assert.equal(f.effects.filter(action => action.kind === 'send_prompt').length, 1, 'A project conflict still gates the transfer');
  Object.assign(earlier, { turnId: 'earlier-done', actionId: earlierSend.actionId, turnState: 'completed', turnStartedAt: Date.now(), turnEndedAt: Date.now() });
  await f.relay.refresh();
  const result = await resumed;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await pending).status, 'cancelled');
  assert.equal(f.effects.filter(action => action.kind === 'create_session').length, 2);
  const sent = f.effects.filter(action => action.kind === 'send_prompt' && action.targetId === target.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'Review the queued task; do not edit.');
  await f.relay.refresh();
  assert.equal(f.effects.filter(action => action.kind === 'send_prompt' && action.targetId === target.id).length, 1);
});

for (const race of [false, true]) test(`queued recovery ${race ? 'after original admission' : 'interpretation failure'} cannot retain a second delivery grant`, { timeout: 3000 }, async t => {
  const f = await fixture(t);
  await f.run('Earlier project work.');
  const earlier = f.sessions[0], earlierSend = f.effects.find(action => action.kind === 'send_prompt');
  const pending = f.run('The original queued task.');
  await until(() => f.relay.getState().tasks.some(task => task.text === 'The original queued task.' && task.status === 'queued' && task.targetIds.length));
  const original = f.relay.getState().tasks.find(task => task.text === 'The original queued task.');
  const target = f.sessions[1];
  const releaseEarlier = async () => {
    Object.assign(earlier, { turnId: 'earlier-done', actionId: earlierSend.actionId, turnState: 'completed', turnStartedAt: Date.now(), turnEndedAt: Date.now() });
    await f.relay.refresh();
  };
  f.plans.push(async context => {
    assert(context.pendingCommands.some(command => command.requestId === original.requestId && command.queued));
    if (!race) throw new Error('Fixture interpretation failure.');
    await releaseEarlier();
    await until(() => f.relay.getState().tasks.find(task => task.requestId === original.requestId).status !== 'queued');
    return { goal: 'Continue original task.', continuationOf: original.requestId, actions: [{ kind: 'operate_terminal', sourceUserId: original.requestId, targetIds: [target.id] }] };
  });
  const recovered = await f.relay.send({ text: 'Send the original queued task.', origin: 'text', replyToRequestId: original.requestId });
  assert.equal(recovered.ok, false);
  assert.equal(f.relay.retry({ requestId: recovered.requestId }).ok, false, 'A rejected recovery must not retain duplicate authority');
  if (!race) await releaseEarlier();
  assert.equal((await pending).ok, true);
  assert.equal(f.effects.filter(action => action.kind === 'send_prompt' && action.targetId === target.id).length, 1);
});

for (const controls of [...[' Enter ', ' CTRL-M ', 'Ctrl-J'].map(key => ({ keys: [key] })),
  ...['click', 'up'].map(action => ({ mouse: { x: 2, y: 2, button: 'left', action } }))]) {
  test(`explicit task controls retain workspace ownership: ${JSON.stringify(controls)}`, { timeout: 2000 }, async t => {
    const f = await fixture(t); f.sessions.push(f.session());
    f.plans.push({ kind: 'operate_terminal', targetIds: ['pane'], text: 'Submit the task in this worker.' });
    f.executor = ({ phase, targetId, grant, body }) => {
      if (targetId !== 'pane' || phase !== 1) return;
      const observed = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
      return { kind: 'terminal_interact', targetId, grantId: grant.id, stepId: 'native-submit', observationToken: observed.observationToken,
        observationSequence: observed.observation.sequence, inputRevision: observed.observation.inputRevision, inputPurpose: 'task', ...controls };
    };
    f.sendEffect = action => {
      Object.assign(f.sessions.find(session => session.id === action.target.id), { turnState: 'running', turnId: action.actionId, turnStartedAt: Date.now() });
      return { ok: true, status: 'written', turnId: action.actionId };
    };
    const first = await f.relay.send({ text: 'Submit the task in this worker.', origin: 'text' });
    assert.equal(first.ok, true, JSON.stringify(first)); assert.ok(f.task(first).workItemId);
    assert.equal(f.task(first).status, 'waiting-results');
    const second = f.run('Independently fix checkout.');
    await until(() => f.effects.some(action => action.kind === 'send_prompt')
      || f.relay.getState().tasks.some(task => task.sequence === 2 && task.workItemId && task.status === 'queued'));
    await tick(); assert.equal(f.effects.filter(action => action.kind === 'send_prompt').length, 0, 'Independent task must wait for the native submission result');
    Object.assign(f.sessions[0], { turnState: 'completed', turnEndedAt: Date.now() }); await f.relay.refresh();
    const result = await second; assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.effects.filter(action => action.kind === 'terminal_interact').length, 1);
    assert.equal(f.effects.filter(action => action.kind === 'send_prompt').length, 1);
  });
}

test('interaction-only mouse control does not acquire task or workspace ownership', async t => {
  const f = await fixture(t); f.sessions.push(f.session());
  f.plans.push({ kind: 'operate_terminal', targetIds: ['pane'], text: 'Select the current menu entry.' });
  f.executor = ({ phase, targetId, grant, body }) => {
    if (phase !== 1) return;
    const observed = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
    return { kind: 'terminal_interact', targetId, grantId: grant.id, stepId: 'menu-click', observationToken: observed.observationToken,
      observationSequence: observed.observation.sequence, inputRevision: observed.observation.inputRevision, inputPurpose: 'interaction',
      mouse: { x: 2, y: 2, button: 'left', action: 'click' } };
  };
  const result = await f.relay.send({ text: 'Select the current menu entry.', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.task(result).status, 'finished');
  assert.equal(f.task(result).workItemId, undefined);
});

test('a configured clarification continuation consumes the original delegate without resurrecting pending work', { timeout: 2000 }, async t => {
  const f = await fixture(t); f.launchers = [];
  const first = await f.run('Fix checkout.');
  const question = f.task(first).question; assert.ok(question?.id, JSON.stringify(first));
  f.launchers = [{ kind: 'codex', label: 'Codex', available: true, configured: true }];
  f.plans.push({ goal: 'Continue the original checkout task.', continuationOf: first.requestId,
    actions: [{ kind: 'delegate_task', sourceUserId: first.requestId, kindOfSession: 'codex', assignmentMode: 'new' }] });
  const second = await f.relay.send({ text: 'Use a new Codex agent; it is configured now.', replyToRequestId: first.requestId, questionId: question.id, origin: 'text' });
  assert.equal(second.ok, true, JSON.stringify(second));
  f.plans.push(context => {
    assert.equal(context.pendingCommands?.some(command => command.grants?.some(grant => grant.kind === 'delegate_task')), false, 'Completed delegate must not return as unfinished work');
    return { goal: 'Explain the current workspace.', actions: [] };
  });
  await f.relay.send({ text: 'What is the current workspace?', origin: 'text' });
  const before = f.effects.length; await f.relay.retry({ requestId: second.requestId });
  assert.equal(f.effects.length, before);
  assert.deepEqual(f.effects.map(a => a.kind), ['create_session', 'send_prompt']);
});

test('automatic deferred fix retains native affinity and refuses a replacement conversation', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  f.plans.push({ goal: 'Review then fix checkout.', afterResults: { instruction: 'fix the findings' },
    actions: [f.plan('Review checkout and report findings.')] });
  const first = await f.relay.send({ text: 'Review checkout then fix the findings.', origin: 'text' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const originalWorkItem = f.task(first).workItemId;
  f.plans.push(context => {
    assert.equal(context.instruction, 'fix the findings');
    assert.ok(context.workItems.some(item => item.id === originalWorkItem));
    return { kind: 'operate_terminal', targetIds: [f.sessions[0].id], text: 'Fix the checkout findings.' };
  });
  // The dependency read returns the old exact result, then the CLI switches
  // conversation before the dependent operator can submit its first prompt.
  f.afterRead = session => { if (session.turnState === 'completed') session.conversationId = 'unrelated-conversation'; };
  const submission = f.effects.find(a => a.kind === 'send_prompt');
  Object.assign(f.sessions[0], { turnId: 'review-result', actionId: submission.actionId, turnState: 'completed', turnStartedAt: Date.now(), turnEndedAt: Date.now() });
  await f.relay.refresh();
  await until(() => f.relay.getState().tasks.some(task => task.replyToRequestId === first.requestId && ['failed', 'needs-answer', 'paused', 'finished', 'waiting-results'].includes(task.status))).catch(error => {
    throw new Error(`${error.message}: ${JSON.stringify(f.relay.getState().tasks)}`);
  });
  assert.equal(f.effects.filter(a => a.kind === 'send_prompt').length, 1);
  assert.equal(f.effects.filter(a => a.kind === 'create_session').length, 1);
});


test('routed history tracks completion and an active continuation after reservation release', async t => {
  const f = await fixture(t);
  f.sendEffect = action => {
    const session = f.sessions.find(item => item.id === action.targetId);
    Object.assign(session, { turnId: action.actionId, actionId: action.actionId, turnState: 'running', turnStartedAt: Date.now() });
    return { ok: true, status: 'written', turnId: action.actionId };
  };
  const first = await f.run('Review checkout validation.');
  const saved = status => f.commits.waitFor(item => item.requestIds.includes(first.requestId) && item.status === status, status);
  await saved('waiting-results');
  const session = f.sessions[0];
  Object.assign(session, { turnState: 'completed', completedTurnId: session.turnId, completedActionId: session.actionId, turnEndedAt: Date.now() });
  await f.relay.refresh();
  const finished = await saved('finished');
  assert.match(finished.summary, /turn.*ended/);
  f.route = () => ({ kind: 'choose', decision: 'reuse', workItemId: finished.id, targetId: session.id, reason: 'Continue the same review.' });
  const second = await f.run('Continue the review.', {}, { replyToRequestId: first.requestId });
  assert.equal(second.ok, true, JSON.stringify(second));
  const active = await saved('waiting-results');
  assert.ok(active.requestIds.includes(second.requestId));
  assert.match(active.summary, /task is running/);
  assert.doesNotMatch(active.summary, /turn.*ended/);
  await f.relay.dispose(); await f.commits.verifyDisk();
});


test('a finished newer continuation cannot hide an older outstanding work-item result', async t => {
  const f = await fixture(t);
  let count = 0;
  f.sendEffect = action => {
    const session = f.sessions.find(item => item.id === action.targetId);
    const done = ++count > 1;
    Object.assign(session, { turnId: action.actionId, actionId: action.actionId, turnState: done ? 'completed' : 'running', turnStartedAt: Date.now(),
      ...(done && { completedTurnId: action.actionId, completedActionId: action.actionId, turnEndedAt: Date.now() }) });
    return { ok: true, status: 'written', turnId: action.actionId };
  };
  const first = await f.run('Review checkout validation.');
  f.route = context => ({ kind: 'choose', decision: 'reuse', workItemId: context.workItems[0].id, targetId: f.sessions[0].id, reason: 'Continue the same review.' });
  const second = await f.run('Also inspect the test coverage.', {}, { replyToRequestId: first.requestId });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(f.task(second).status, 'finished');
  assert.equal(f.task(first).status, 'waiting-results');
  const item = await f.commits.waitFor(value => value.requestIds.includes(second.requestId) && value.status === 'waiting-results', 'both request owners with the older result still pending');
  assert.equal(item.status, 'waiting-results');
  assert.doesNotMatch(item.summary, /turn.*ended/);
  await f.relay.dispose(); await f.commits.verifyDisk();
});
