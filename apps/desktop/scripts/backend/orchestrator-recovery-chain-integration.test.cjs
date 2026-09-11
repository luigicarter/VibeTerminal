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

async function fixture(t, { modelIntent = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-recovery-chain-'));
  const f = { root, projects: [{ name: 'Project', path: root }], sessions: [], effects: [], contexts: [], routes: [], reads: [], plans: [], phases: new Map(),
    launchers: [{ kind: 'codex', label: 'Codex', available: true, configured: true }] };
  f.statuses = []; f.spoken = [];
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
    onChange: state => { for (const task of state.tasks || []) f.statuses.push({ requestId: task.requestId, status: task.status }); },
    onSpeak: async speech => { f.spoken.push(speech); return { ok: true }; },
    interpretIntent: modelIntent ? undefined : async context => {
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
      if (action.kind === 'close' && f.closeEffect) return f.closeEffect(action);
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
      if (body.tools?.some(item => item.function.name === 'interpret_workspace')) {
        f.intentBodies ||= []; f.intentBodies.push(body);
        const plan = f.plans.shift(); assert.ok(plan, 'Every model interpretation is explicitly scripted');
        const args = typeof plan === 'function' ? await plan(body) : plan;
        return jsonResponse({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `intent-${++sequence}`, type: 'function', function: { name: 'interpret_workspace', arguments: JSON.stringify(args) } }] } }] });
      }
      const metadata = JSON.parse(body.messages.find(message => message.role === 'user').content);
      if (f.reply) return jsonResponse(await f.reply({ body, metadata }));
      const grant = metadata.authorizedCommands?.grants.find(g => g.kind === 'operate_terminal' && (f.phases.get(g.id) || 0) < 4);
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

const { RoutingError } = require('../../backend/orchestratorRoutePlanner.cjs');
const counts = f => ({ creates: f.effects.filter(a => a.kind === 'create_session'), sends: f.effects.filter(a => a.kind === 'send_prompt') });

test('bound new Codex bypasses discovery and submits the full investigation once', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  f.sessions.push(f.session('unrelated-busy'));
  f.route = () => assert.fail('A bound new Codex task must not call the route model');
  const text = 'Investigate partial terminal closure; do not edit. Preserve every finding.';
  const result = await f.run(text, { assignmentMode: 'new', kindOfSession: 'codex', promptMode: 'literal' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.routes.length, 0);
  assert.equal(counts(f).creates.length, 1); assert.equal(counts(f).sends.length, 1);
  assert.equal(counts(f).sends[0].text, text);
  assert.equal(counts(f).sends[0].target.generation, f.sessions[1].generation);
});

test('natural retry repairs an impossible result dependency without finishing the failed source', { timeout: 4000 }, async t => {
  const f = await fixture(t, { modelIntent: true });
  f.route = () => { throw new RoutingError('synthetic-unassigned'); };
  const text = 'Investigate partial closure; do not edit.';
  f.plans.push({ goal: text, access: 'read-only', actions: [f.plan(text)] });
  const first = await f.relay.send({ text, origin: 'text' });
  assert.equal(first.ok, false); assert.equal(f.task(first).status, 'failed'); assert.deepEqual(f.effects, []);
  const continuation = { goal: text, access: 'read-only', continuationOf: first.requestId,
    actions: [{ kind: 'delegate_task', sourceUserId: first.requestId }] };
  f.plans.push({ ...continuation, dependsOnRequestIds: [first.requestId] });
  f.plans.push(body => {
    assert.match(body.messages[0].content, /Validation failure/);
    assert.equal(f.task(first).status, 'failed', 'Repair must precede every source mutation');
    return continuation;
  });
  f.route = () => ({ kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'No prior assignment exists.' });
  const second = await f.relay.send({ text: 'Look at my last request and action it.', origin: 'text', replyToRequestId: first.requestId });
  assert.equal(second.ok, true, JSON.stringify(second)); assert.equal(f.intentBodies.length, 3);
  assert.equal(counts(f).creates.length, 1); assert.equal(counts(f).sends.length, 1);
  assert.equal(counts(f).sends[0].text, text);
  assert.ok(!f.statuses.some(item => item.requestId === first.requestId && item.status === 'finished'));
});

test('UI retry consumes only the failed unassigned request once', { timeout: 4000 }, async t => {
  const f = await fixture(t); f.route = () => { throw new RoutingError('unassigned'); };
  const first = await f.run('Investigate the issue; do not edit.'); assert.equal(first.ok, false);
  f.route = () => ({ kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'Retry the unassigned task.' });
  const retried = f.relay.retry({ requestId: first.requestId }); assert.equal(retried.ok, true, JSON.stringify(retried));
  await until(() => counts(f).sends.length === 1);
  await until(() => f.relay.getState().tasks.some(task => task.requestId !== first.requestId && ['waiting-results', 'finished', 'failed'].includes(task.status)));
  assert.equal(f.relay.retry({ requestId: first.requestId }).ok, false);
  await f.relay.refresh(); assert.equal(counts(f).creates.length, 1); assert.equal(counts(f).sends.length, 1);
});

test('second-grant route exhaustion preserves the first created pane for retry', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  const firstText = 'Review checkout without editing.', secondText = 'Review search without editing.';
  f.route = context => { if (context.instruction === secondText) throw new RoutingError('second-grant'); return { kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'Independent review.' }; };
  f.plans.push({ goal: 'Review both areas without edits.', access: 'read-only', actions: [f.plan(firstText), f.plan(secondText)] });
  const first = await f.relay.send({ text: 'Review checkout and search independently without editing.', origin: 'text' });
  assert.equal(first.ok, false); assert.equal(counts(f).creates.length, 1); const original = f.sessions[0];
  f.route = () => ({ kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'Independent remaining review.' });
  const retried = f.relay.retry({ requestId: first.requestId }); assert.equal(retried.ok, true, JSON.stringify(retried));
  try { await until(() => counts(f).sends.length === 2 || f.relay.getState().tasks.some(task => task.requestId !== first.requestId && ['failed', 'needs-answer', 'waiting-results', 'finished'].includes(task.status))); }
  catch (error) { throw Error(`${error.message}: ${JSON.stringify({ tasks: f.relay.getState().tasks, effects: f.effects.map(a => ({ kind: a.kind, text: a.text })) })}`); }
  assert.equal(counts(f).sends.length, 2, JSON.stringify({ tasks: f.relay.getState().tasks, effects: f.effects.map(a => ({ kind: a.kind, targetId: a.targetId, text: a.text })) }));
  assert.equal(counts(f).creates.length, 2, 'Reuse the first created pane; create only the missing second worker');
  assert.equal(counts(f).sends.filter(a => a.targetId === original.id && a.text === firstText).length, 1);
  assert.equal(counts(f).sends.filter(a => a.text === secondText).length, 1);
});

test('launch timeout retry recovers the exact original pane without duplicate creation', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  f.create = action => { const result = f.created(action); Object.assign(f.sessions[0], { agentProcessState: 'starting', agentPid: undefined, status: 'starting', turnState: 'starting' });
    return { ...result, ok: false, status: 'launch-timeout', target: undefined, sessionCreated: true, delivery: 'not-dispatched', error: 'Still starting.' }; };
  const first = await f.run('Investigate startup; do not edit.', { assignmentMode: 'new', kindOfSession: 'codex' });
  assert.equal(first.ok, false); assert.equal(counts(f).creates.length, 1); assert.equal(counts(f).sends.length, 0);
  const original = f.sessions[0]; Object.assign(original, { agentProcessState: 'running', agentPid: 101, status: 'idle', turnState: 'idle' });
  await f.relay.refresh();
  const retry = f.relay.retry({ requestId: first.requestId }); assert.equal(retry.ok, true, JSON.stringify(retry));
  await until(() => counts(f).sends.length === 1);
  assert.equal(counts(f).creates.length, 1); assert.equal(counts(f).sends[0].targetId, original.id);
  assert.equal(counts(f).sends[0].target.generation, original.generation);
});

test('late startup after clarification hops recovers under the current control owner only', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  f.create = action => {
    const result = f.created(action);
    Object.assign(f.sessions[0], { agentProcessState: 'starting', agentPid: undefined, status: 'starting', turnState: 'starting' });
    return { ...result, ok: false, status: 'launch-timeout', target: undefined, sessionCreated: true, delivery: 'not-dispatched', error: 'Still starting.' };
  };
  const objective = 'Investigate startup; do not edit.';
  const first = await f.run(objective, { assignmentMode: 'new', kindOfSession: 'codex' });
  assert.equal(first.ok, false);
  let latest = first;
  for (let hop = 0; hop < 2; hop++) {
    f.plans.push(context => ({ goal: objective, continuationOf: context.previousCommand.requestId,
      clarification: 'The original worker is still starting. Continue when ready?', actions: [] }));
    latest = await f.relay.send({ text: 'Keep the original investigation pending.', origin: 'text', replyToRequestId: latest.requestId });
    assert.equal(latest.ok, true, JSON.stringify(latest));
  }
  const original = f.sessions[0];
  Object.assign(original, { agentProcessState: 'running', agentPid: 101, status: 'idle', turnState: 'idle' });
  await f.relay.refresh();
  assert.equal(counts(f).creates.length, 1);
  assert.equal(counts(f).sends.length, 0, 'Readiness recovery binds authority but does not dispatch input');
  f.plans.push(context => {
    const pending = context.pendingCommands.filter(command => command.requestId === first.requestId);
    assert.equal(pending.length, 1, 'Only the current continuation owns unfinished control');
    assert.equal(pending[0].grants.length, 1, 'The original claimed creation becomes a bound unfinished task');
    assert.equal(pending[0].grants[0].kind, 'operate_terminal');
    assert.equal(pending[0].grants[0].text, objective);
    assert.equal(pending[0].grants[0].targets[0].id, original.id);
    return { goal: 'Inspect pending ownership.', actions: [] };
  });
  const inspection = await f.relay.send({ text: 'What investigation remains pending?', origin: 'text' });
  assert.equal(inspection.ok, true, JSON.stringify(inspection));
  assert.equal(f.relay.retry({ requestId: first.requestId }).ok, false, 'The predecessor cannot regain control');
  const retry = f.relay.retry({ requestId: latest.requestId });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  await until(() => counts(f).sends.length === 1);
  assert.equal(counts(f).creates.length, 1);
  assert.equal(counts(f).sends[0].targetId, original.id);
  assert.equal(counts(f).sends[0].target.generation, original.generation);
  assert.equal(counts(f).sends[0].text, objective);
  assert.equal(f.task(first).status, 'failed', 'The historical startup failure remains recorded');
});

test('ask_user cannot publish a false closure success while stop evidence remains unknown', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  f.sessions.push({ ...f.session(), visiblePane: true, board: 'multi' });
  f.closeEffect = action => ({ ok: false, status: 'close-partial', close: {
    operationId: action.actionId, target: action.target, pane: 'removed', process: 'unknown', launchSettled: true } });
  let phase = 0;
  const falseClaim = 'All project terminals closed successfully. What should I investigate next?';
  f.reply = ({ metadata }) => {
    if (phase++ === 0) return tool({ kind: 'close', grantId: metadata.authorizedCommands.grants[0].id, targetId: 'pane' });
    if (phase === 2) return tool({ kind: 'ask_user', text: falseClaim });
    return { choices: [{ finish_reason: 'stop', message: { content: falseClaim } }] };
  };
  f.plans.push({ goal: 'Close workspace terminals.', actions: [{ kind: 'close', scope: { type: 'workspace' } }] });
  const result = await f.relay.send({ text: 'Close all workspace terminals.', origin: 'voice' });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.text, /All project terminals closed successfully/);
  assert.match(result.text, /Closed 0 of 1 terminals/);
  assert.match(result.text, /unconfirmed/);
  assert.doesNotMatch(f.task(result).question?.text || '', /All project terminals closed successfully/);
  assert.equal(f.spoken.length, 1);
  assert.doesNotMatch(f.spoken[0].speechText, /All project terminals closed successfully/);
  assert.match(f.spoken[0].speechText, /unconfirmed/);
});

test('unambiguous close without optional grantId stays attributed to its frozen scope', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  f.sessions.push({ ...f.session(), visiblePane: true, board: 'multi' });
  f.closeEffect = action => {
    f.sessions.length = 0;
    return { ok: true, status: 'closed', close: { operationId: action.actionId, target: action.target,
      pane: 'removed', process: 'stopped', launchSettled: true } };
  };
  let phase = 0;
  f.reply = () => phase++ === 0 ? tool({ kind: 'close', targetId: 'pane' })
    : { choices: [{ finish_reason: 'stop', message: { content: 'The terminal is closed.' } }] };
  f.plans.push({ goal: 'Close workspace terminals.', actions: [{ kind: 'close', scope: { type: 'workspace' } }] });
  const result = await f.relay.send({ text: 'Close all workspace terminals.', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, 'done');
  assert.equal(result.actions.filter(action => action.kind === 'close').length, 1);
});

test('staggered startup recovery retains the second creation after the first worker submits', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  f.create = action => {
    const result = f.created(action);
    Object.assign(f.sessions.at(-1), { agentProcessState: 'starting', agentPid: undefined, status: 'starting', turnState: 'starting' });
    return { ...result, ok: false, status: 'launch-timeout', target: undefined, sessionCreated: true, delivery: 'not-dispatched', error: 'Still starting.' };
  };
  const objectives = ['Review checkout without editing.', 'Review search without editing.'];
  f.plans.push({ goal: 'Review both areas.', access: 'read-only', actions: objectives.map(text => f.plan(text, { assignmentMode: 'new', kindOfSession: 'codex' })) });
  const first = await f.relay.send({ text: 'Review checkout and search in independent new Codex workers.', origin: 'text' });
  assert.equal(first.ok, false);
  assert.equal(counts(f).creates.length, 2);
  Object.assign(f.sessions[0], { agentProcessState: 'running', agentPid: 101, status: 'idle', turnState: 'idle' });
  await f.relay.refresh();
  const retry = f.relay.retry({ requestId: first.requestId });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  await until(() => counts(f).sends.length === 1);
  await until(() => f.relay.getState().tasks.some(task => task.requestId === retry.requestId && !['queued', 'routing', 'running'].includes(task.status)));
  const firstSend = counts(f).sends[0];
  Object.assign(f.sessions[0], { turnId: 'first-result', completedTurnId: 'first-result', completedActionId: firstSend.actionId,
    turnState: 'completed', turnEndedAt: Date.now() });
  await f.relay.refresh();
  assert.notEqual(f.task(retry).status, 'finished', 'One result cannot certify the two-worker original objective');
  f.plans.push({ goal: 'Summarize both reviews.', dependsOnRequestIds: [retry.requestId],
    actions: [f.plan('Summarize both completed reviews.', { assignmentMode: 'new', kindOfSession: 'codex' })] });
  const dependent = await f.relay.send({ text: 'After both reviews finish, summarize their results.', origin: 'text' });
  assert.equal(dependent.ok, false, JSON.stringify(dependent));
  assert.match(dependent.error, /prerequisite|complete result/i);
  assert.equal(counts(f).creates.length, 2, 'A partial producer must not launch its dependent worker');
  assert.equal(counts(f).sends.length, 1);
  Object.assign(f.sessions[1], { agentProcessState: 'running', agentPid: 102, status: 'idle', turnState: 'idle' });
  await f.relay.refresh();
  f.plans.push(context => {
    const pending = context.pendingCommands.filter(command => command.requestId === first.requestId);
    assert.equal(pending.length, 1, 'The second original creation must retain one recovery owner');
    assert.equal(pending[0].grants.length, 1, 'The delivered first sibling must not be recreated');
    assert.equal(pending[0].grants[0].text, objectives[1]);
    assert.equal(pending[0].grants[0].targets[0].id, f.sessions[1].id);
    return { goal: 'Check pending work.', actions: [] };
  });
  const inspected = await f.relay.send({ text: 'What work is still pending?', origin: 'text' });
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  const finalRetry = f.relay.retry({ requestId: retry.requestId });
  assert.equal(finalRetry.ok, true, JSON.stringify(finalRetry));
  await until(() => counts(f).sends.length === 2);
  assert.equal(counts(f).creates.length, 2);
  assert.deepEqual(counts(f).sends.map(action => action.text), objectives);
});

async function unresolvedVoiceClose(t) {
  const f = await fixture(t);
  f.sessions.push({ ...f.session(), visiblePane: true, board: 'multi' });
  f.closeEffect = action => {
    f.sessions.length = 0;
    return { ok: false, status: 'close-partial', close: { operationId: action.actionId, target: action.target,
      pane: 'removed', process: 'unknown', launchSettled: true } };
  };
  let phase = 0;
  f.reply = ({ metadata }) => phase++ === 0
    ? tool({ kind: 'close', targetId: 'pane', grantId: metadata.authorizedCommands.grants[0].id })
    : { choices: [{ finish_reason: 'stop', message: { content: 'All terminals were closed.' } }] };
  f.plans.push({ goal: 'Close workspace terminals.', actions: [{ kind: 'close', scope: { type: 'workspace' } }] });
  const initial = await f.relay.send({ text: 'Close all workspace terminals.', origin: 'voice' });
  assert.equal(initial.ok, false);
  assert.match(initial.text, /unconfirmed/);
  assert.equal(f.spoken.length, 1);
  const close = initial.actions.find(action => action.kind === 'close').close;
  return { f, initial, late: { ok: true, kind: 'close', operationId: close.operationId, status: 'closed',
    close: { ...close, process: 'stopped', verifiedAt: Date.now() } } };
}

test('same-operation late observed exit updates closure status, receipts and voice once', { timeout: 4000 }, async t => {
  const { f, initial, late } = await unresolvedVoiceClose(t);
  const reconciled = await f.relay.recordLifecycle(late);
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.updated, 1);
  await until(() => f.spoken.some(speech => speech.requestId === initial.requestId && speech.completionCue));
  assert.equal(f.task(initial).status, 'finished');
  assert.equal(f.task(initial).error, undefined);
  const receipts = f.relay.getState().receipts.filter(receipt => receipt.requestId === initial.requestId && receipt.close?.operationId === late.operationId);
  assert.equal(receipts.at(-1).close.process, 'stopped');
  assert.equal(receipts.at(-1).status, 'closed');
  assert.equal(f.spoken.filter(speech => speech.completionCue).length, 1);
  assert.equal(f.spoken.at(-1).speechText, 'done');
  assert.equal((await f.relay.recordLifecycle(late)).updated, 0, 'Duplicate lifecycle evidence is observationally idempotent');
  await tick();
  assert.equal(f.spoken.filter(speech => speech.completionCue).length, 1);
  assert.equal(f.effects.length, 1, 'Late verification never dispatches another close');
  await f.relay.dispose();
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'orchestrator-conversation.json'), 'utf8'));
  assert.equal(saved.tasks.find(task => task.requestId === initial.requestId).status, 'finished');
  assert.equal(saved.receipts.filter(receipt => receipt.requestId === initial.requestId && receipt.close?.operationId === late.operationId).at(-1).close.process, 'stopped');
  assert.equal(saved.messages.filter(message => message.requestId === initial.requestId && message.completionCue).length, 1);
});

test('canceling an unresolved close prevents a late success cue while retaining exit evidence', { timeout: 4000 }, async t => {
  const { f, initial, late } = await unresolvedVoiceClose(t);
  assert.equal((await f.relay.cancel({ requestId: initial.requestId })).ok, true);
  const spokenBefore = f.spoken.length;
  await f.relay.recordLifecycle(late);
  await tick();
  assert.equal(f.spoken.length, spokenBefore, 'Cancellation suppresses delayed speech');
  assert.notEqual(f.task(initial).status, 'finished', 'A cancelled request cannot be revived as successful');
  assert.equal(f.relay.getState().messages.filter(message => message.requestId === initial.requestId && message.completionCue).length, 0);
  assert.equal(f.relay.getState().receipts.filter(receipt => receipt.requestId === initial.requestId && receipt.close?.operationId === late.operationId).at(-1).close.process, 'stopped');
  assert.equal(f.effects.length, 1);
});

for (const failureKind of ['delivery', 'native-result']) test(`late close proof cannot erase a later ${failureKind} failure from the same request`, { timeout: 4000 }, async t => {
  const f = await fixture(t);
  f.sessions.push({ ...f.session('closing'), visiblePane: true, board: 'multi' }, { ...f.session('worker'), visiblePane: true, board: 'multi' });
  f.sendEffect = () => ({ ok: true, status: failureKind === 'delivery' ? 'queued' : 'written' });
  f.closeEffect = action => {
    f.sessions.splice(f.sessions.findIndex(session => session.id === 'closing'), 1);
    return { ok: false, status: 'close-partial', close: { operationId: action.actionId, target: action.target,
      pane: 'removed', process: 'unknown', launchSettled: true } };
  };
  let phase = 0;
  f.reply = ({ metadata }) => {
    if (phase++ === 0) return tool({ kind: 'send_prompt', grantId: metadata.authorizedCommands.grants.find(grant => grant.kind === 'send_prompt').id,
      targetId: 'worker', text: 'Review the project.' });
    if (phase === 2) return tool({ kind: 'close', grantId: metadata.authorizedCommands.grants.find(grant => grant.kind === 'close').id, targetId: 'closing' });
    return { choices: [{ finish_reason: 'stop', message: { content: 'Requested operations completed.' } }] };
  };
  f.plans.push({ goal: 'Review and close the spare pane.', actions: [
    { kind: 'send_prompt', targetIds: ['worker'], text: 'Review the project.' },
    { kind: 'close', scope: { type: 'explicit', targetIds: ['closing'] } } ] });
  const initial = await f.relay.send({ text: 'Ask worker to review the project and close the spare pane.', origin: 'voice' });
  assert.equal(initial.ok, false);
  const sent = counts(f).sends[0];
  if (failureKind === 'delivery') {
    f.relay.recordDelivery({ actionId: sent.actionId, id: 'worker', generation: sent.generation, ok: false,
      status: 'rejected', delivery: 'not-dispatched', error: 'Worker disappeared before queued input was delivered.' });
  } else {
    Object.assign(f.sessions.find(session => session.id === 'worker'), { turnId: 'failed-result', completedTurnId: 'failed-result',
      completedActionId: sent.actionId, turnState: 'failed', turnEndedAt: Date.now(), error: 'The worker task failed.' });
    await f.relay.refresh();
  }
  const close = initial.actions.find(action => action.kind === 'close').close;
  await f.relay.recordLifecycle({ ok: true, operationId: close.operationId, kind: 'close', status: 'closed',
    close: { ...close, process: 'stopped', verifiedAt: Date.now() } });
  await tick();
  assert.equal(f.task(initial).status, 'failed', 'Independent late failure remains authoritative');
  assert.equal(f.spoken.filter(speech => speech.completionCue).length, 0);
});

test('verified delegated submission ends a polling model loop while native results still gate dependencies', { timeout: 4000 }, async t => {
  const f = await fixture(t); let modelCalls = 0;
  const objective = 'Investigate the startup problem without editing.';
  f.reply = ({ metadata }) => {
    const grant = metadata.authorizedCommands.grants.find(item => item.kind === 'operate_terminal');
    const targetId = grant.targets[0].id;
    const phase = modelCalls++;
    if (phase === 0 || phase === 2) return tool({ kind: 'read_session', targetId });
    if (phase === 1) return tool({ kind: 'send_prompt', grantId: grant.id, targetId, text: objective });
    return tool({ kind: 'list_sessions' }); // This model never supplies a finish or plain reply.
  };
  const result = await f.run(objective, { assignmentMode: 'new', kindOfSession: 'codex' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(modelCalls, 3, 'Do not ask the model again after the fresh post-submission read');
  assert.equal(f.reads.length, 3, 'The application supplies a post-send read even if the model also requests one');
  assert.equal(counts(f).creates.length, 1); assert.equal(counts(f).sends.length, 1);
  assert.equal(result.actions.filter(action => action.kind === 'finish_terminal' && action.status === 'interaction-complete').length, 1);
  assert.equal(f.task(result).status, 'waiting-results');
  assert.equal(f.statuses.some(task => task.requestId === result.requestId && task.status === 'finished'), false);
  f.plans.push({ goal: 'Summarize the investigation result.', dependsOnRequestIds: [result.requestId],
    actions: [f.plan('Summarize the investigation result.', { assignmentMode: 'new', kindOfSession: 'codex' })] });
  const dependent = f.relay.enqueue({ text: 'After the investigation finishes, summarize its result.', origin: 'text' });
  assert.equal(dependent.ok, true, JSON.stringify(dependent));
  await until(() => f.task(dependent)?.dependsOn?.includes(result.requestId));
  assert.equal(f.task(dependent).status, 'queued');
  await f.relay.refresh();
  assert.equal(counts(f).creates.length, 1, 'Finishing submission does not supply the native prerequisite result');
  assert.equal(counts(f).sends.length, 1); assert.equal(modelCalls, 3);
  await f.relay.cancel({ requestId: dependent.requestId });
  assert.equal(f.task(result).status, 'waiting-results', 'Canceling a dependent preserves its original producer wait');
});

test('top-loop delegated completion preserves a separate failed close and suppresses success cues', { timeout: 4000 }, async t => {
  const f = await fixture(t); let modelCalls = 0;
  f.sessions.push({ ...f.session('spare'), visiblePane: true, board: 'multi' });
  f.closeEffect = action => {
    f.sessions.splice(f.sessions.findIndex(session => session.id === 'spare'), 1);
    return { ok: false, status: 'close-partial', close: { operationId: action.actionId, target: action.target,
      pane: 'removed', process: 'unknown', launchSettled: true } };
  };
  const objective = 'Investigate startup without editing.';
  f.reply = ({ metadata }) => {
    const phase = modelCalls++;
    if (phase === 0) return tool({ kind: 'close', targetId: 'spare', grantId: metadata.authorizedCommands.grants.find(item => item.kind === 'close').id });
    const grant = metadata.authorizedCommands.grants.find(item => item.kind === 'operate_terminal'), targetId = grant.targets[0].id;
    if (phase === 1 || phase === 3) return tool({ kind: 'read_session', targetId });
    if (phase === 2) return tool({ kind: 'send_prompt', grantId: grant.id, targetId, text: objective });
    return tool({ kind: 'list_sessions' });
  };
  f.plans.push({ goal: 'Close the spare pane and investigate startup.', actions: [
    f.plan(objective, { assignmentMode: 'new', kindOfSession: 'codex' }),
    { kind: 'close', scope: { type: 'explicit', targetIds: ['spare'] } } ] });
  const result = await f.relay.send({ text: 'Close spare and open a new Codex to investigate startup without editing.', origin: 'voice' });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(modelCalls, 4, 'The separate failure does not require another ceremonial model finish');
  assert.equal(f.reads.length, 3); assert.equal(counts(f).creates.length, 1); assert.equal(counts(f).sends.length, 1);
  assert.equal(f.task(result).status, 'failed');
  assert.match(result.text, /Closed 0 of 1 terminals/); assert.match(result.text, /unconfirmed/);
  assert.equal(result.actions.filter(action => action.kind === 'finish_terminal' && action.status === 'interaction-complete').length, 1);
  assert.equal(result.actions.find(action => action.kind === 'close').ok, false);
  assert.equal(f.spoken.filter(speech => speech.completionCue).length, 0);
});
