'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { createTaskScheduler } = require('../../backend/orchestratorTasks.cjs');

test('numeric zero generations retain task identity through repeated tracking and completion', () => {
  for (const identity of [{ generation: 0 }, { result: { target: { generation: 0 } } }, { result: { generation: 0 } }]) {
    const tasks = createTaskScheduler();
    const job = tasks.create({ text: 'Work', origin: 'text' });
    const action = { kind: 'send_prompt', actionId: 'ours', targetId: 's', ...(identity.generation === 0 && { generation: 0 }) };
    tasks.track(job, action, { ok: true, status: 'queued', ...identity.result });
    assert.equal(job.waits[0].generation, 0);
    tasks.track(job, { kind: 'send_prompt', actionId: 'ours', targetId: 's' }, { ok: true, status: 'written', turnId: 'our-turn' });
    assert.equal(job.waits[0].generation, 0);
    job.executionDone = true; tasks.update(job, { status: 'waiting-results' });
    tasks.reconcile([{ id: 's', generation: 0, turnId: 'our-turn', turnState: 'completed' }]);
    assert.equal(job.task.status, 'finished');
    assert.equal(job.waits[0].failed, false);
  }
});

test('partial completion preserves sibling waits and current inventory readiness', async () => {
  const tasks = createTaskScheduler();
  const job = tasks.create({ text: 'Both tasks', origin: 'text' });
  for (const id of ['s', 'other']) tasks.track(job, { kind: 'send_prompt', actionId: id, targetId: id, generation: 'g' }, { ok: true, status: 'written', turnId: `${id}-old` });
  job.executionDone = true; tasks.update(job, { status: 'waiting-results' });
  tasks.reconcile([{ id: 's', generation: 'g', kind: 'codex', turnId: 'newer', turnState: 'running' }, { id: 'other', generation: 'g', turnId: 'other-old', turnState: 'running' }]);
  tasks.reconcile([{ id: 's', generation: 'stale', turnId: 's-old', turnState: 'completed' }], { partial: true });
  assert.equal(job.waits[0].done, false);
  tasks.reconcile([{ id: 's', generation: 'g', turnId: 's-old', turnState: 'completed' }], { partial: true });
  assert.equal(job.waits[0].done, true);
  assert.equal(job.waits[1].done, false); assert.equal(job.waits[1].failed, undefined);
  const next = tasks.create({ text: 'Next task', origin: 'text' });
  next.lanes = [{ key: 'terminal:s', targetIds: ['s'], readOnly: false }];
  let ready = false;
  const pending = tasks.ready(next).then(() => { ready = true; }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false, 'old completion event cannot replace newer busy readiness');
  next.controller.abort(); await pending;
});

test('cached completed identity never borrows the newer turn state, and ambiguity remains tracked', () => {
  const tasks = createTaskScheduler({ now: () => 100 });
  const job = tasks.create({ text: 'Work', origin: 'text' });
  tasks.track(job, { kind: 'send_prompt', actionId: 'ours', targetId: 's', generation: 'g' }, { ok: true, status: 'unknown', turnId: 'our-turn' }, { kind: 'codex', turnState: 'idle' });
  job.executionDone = true; tasks.update(job, { status: 'waiting-results' });
  const session = { id: 's', generation: 'g', kind: 'codex', turnId: 'newer', completedTurnId: 'our-turn', completedActionId: 'ours', actionId: 'human' };
  for (const turnState of ['running', 'failed', 'completed']) {
    tasks.reconcile([{ ...session, turnState }]);
    assert.equal(job.waits[0].done, false); assert.equal(job.waits[0].observedState, undefined);
  }
  tasks.reconcile([{ ...session, turnId: 'our-turn', actionId: 'ours', turnState: 'running' }]);
  assert.equal(job.waits[0].observedState, 'running'); assert.doesNotMatch(job.task.waitingReason, /uncertain/);
  tasks.reconcile([{ ...session, turnId: 'our-turn', turnState: 'completed', completionAttribution: 'ambiguous' }]);
  assert.equal(job.waits[0].attributionAmbiguous, true); assert.equal(job.waits[0].done, false);
  assert.match(job.task.waitingReason, /cannot be attributed/);
  tasks.reconcile([{ ...session, turnId: 'our-turn', turnState: 'completed' }]);
  assert.equal(job.waits[0].attributionAmbiguous, false); assert.equal(job.task.status, 'finished');
});

test('queued delivery cannot attribute an intervening turn using the original idle baseline', () => {
  for (const freshBaseline of [false, true]) {
    const tasks = createTaskScheduler({ now: () => 100 });
    const job = tasks.create({ text: 'Queued work', origin: 'text' });
    tasks.track(job, { kind: 'send_prompt', actionId: 'ours', targetId: 's', generation: 'g' }, { ok: true, status: 'queued' }, { kind: 'codex', turnId: 'old', turnState: 'idle', submittedAt: 100 });
    job.executionDone = true; tasks.update(job, { status: 'waiting-results' });
    const human = { id: 's', generation: 'g', kind: 'codex', turnId: 'human', completedTurnId: 'human', completedActionId: 'human-action', turnState: 'completed', turnStartedAt: 101 };
    tasks.reconcile([human]);
    tasks.delivery({ actionId: 'ours', ok: true, status: 'written', ...(freshBaseline && { deliveryBaseline: { kind: 'codex', submittedAt: 102, turnId: 'human', turnState: 'completed' } }) });
    tasks.reconcile([human]);
    assert.equal(job.task.status, 'waiting-results'); assert.equal(job.waits[0].observedState, undefined);
    tasks.reconcile([{ ...human, turnId: 'our-turn', actionId: 'ours', turnStartedAt: 103, turnState: 'waiting' }]);
    assert.equal(job.waits[0].observedState, 'waiting');
    assert.equal(job.waits[0].turnId, 'our-turn');
    assert.match(job.task.waitingReason, /needs input/);
    tasks.reconcile([{ ...human, turnId: 'our-turn', completedTurnId: 'our-turn', completedActionId: 'ours', turnState: 'failed' }]);
    assert.equal(job.task.status, 'failed'); assert.match(job.waits[0].error, /failed/);
  }
});
const { fitMessages } = require('../../backend/orchestratorBudget.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await tick(); } assert.fail('Condition was not reached.'); }
const reply = text => ({ choices: [{ finish_reason: 'stop', message: { content: text } }] });
async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-tasks-'));
  const f = { root, contexts: [], effects: [], executorCalls: 0, activeCalls: 0, maxCalls: 0, sessions: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, generation: `g${i}`, name: `Agent ${i}`, kind: 'fusion', cwd: path.join(root, `p${i}`), turnState: 'idle' })) };
  f.plan = context => ({ goal: context.instruction, executionMode: 'direct', actions: [{ kind: 'send_prompt', targetIds: [context.targetId || 's0'], text: context.instruction }] });
  f.finish = async (id, status = 'completed') => { const session = f.sessions.find(session => session.id === id); Object.assign(session, { turnState: status, turnEndedAt: Date.now(), completedTurnId: session.turnId, completedActionId: session.actionId }); await f.app.refresh(); await tick(); };
  f.app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false }, getSessions: () => f.sessions, getRoots: () => ({ documents: root, projects: [] }),
    readSession: async ({ id, completedTurnId }) => ({ completedResult: { turnId: completedTurnId || f.sessions.find(session => session.id === id).turnId, text: `Observed review in ${id}`, status: 'completed' } }),
    interpretIntent: async context => { f.contexts.push(context); return f.plan(context); },
    dispatchAction: async action => { f.effects.push(action); if (f.dispatch) return f.dispatch(action); const session = f.sessions.find(session => session.id === action.targetId); if (session && action.kind === 'send_prompt' && session.kind !== 'terminal') Object.assign(session, { turnId: `turn-${f.effects.length}`, turnState: 'running', turnStartedAt: Date.now(), actionId: action.actionId }); return { ok: true, status: 'written', turnId: session?.turnId }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'model', context_length: 128000, supported_parameters: ['tools'] }] }));
      f.executorCalls++; f.activeCalls++; f.maxCalls = Math.max(f.maxCalls, f.activeCalls);
      try { return new Response(JSON.stringify(f.respond ? await f.respond(JSON.parse(options.body)) : reply('Done.'))); } finally { f.activeCalls--; }
    }, ...overrides });
  await f.app.configure({ apiKey: 'fixture', sessionOnly: true, model: 'model' }); await f.app.setEnabled(true);
  t.after(async () => { await f.app.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('five rapid requests acknowledge immediately and run independently with isolated targets', async t => {
  const f = await fixture(t);
  const acks = f.sessions.map(session => f.app.enqueue({ text: `Review ${session.id}`, origin: 'text', targetId: session.id }));
  assert.ok(acks.every(ack => ack.ok && ack.status === 'queued'));
  assert.equal(new Set(acks.map(ack => ack.requestId)).size, 5);
  await until(() => f.effects.length === 5 && f.app.getState().tasks.every(task => task.status === 'waiting-results'));
  assert.deepEqual(f.effects.map(action => action.targetId), ['s0', 's1', 's2', 's3', 's4']);
  assert.equal(f.executorCalls, 0, 'fully bound sends take the direct path');
  assert.ok(f.app.getState().receipts.every(receipt => acks.some(ack => ack.requestId === receipt.requestId)));
  for (const session of f.sessions) await f.finish(session.id);
  assert.ok(f.app.getState().tasks.every(task => task.status === 'finished'));
});

test('executor calls are limited to two while serial routing continues', async t => {
  const f = await fixture(t); f.plan = () => ({ goal: 'Read context.', actions: [] });
  const releases = []; f.respond = () => new Promise(resolve => releases.push(() => resolve(reply('Read.'))));
  for (let i = 0; i < 5; i++) f.app.enqueue({ text: `Question ${i}`, origin: 'text' });
  await until(() => f.contexts.length === 5 && releases.length === 2);
  assert.equal(f.maxCalls, 2);
  for (let i = 0; i < 5; i++) { await until(() => releases.length > i); releases[i](); await tick(); }
  await until(() => f.app.getState().tasks.every(task => task.status === 'finished'));
  assert.equal(f.maxCalls, 2);
});

test('same target and same worktree mutations wait for terminal completion; another project progresses', async t => {
  const f = await fixture(t); f.sessions[1].cwd = f.sessions[0].cwd;
  const first = f.app.enqueue({ text: 'First edit', targetId: 's0', origin: 'text' });
  await until(() => f.effects.length === 1);
  f.app.enqueue({ text: 'Second edit', targetId: 's1', origin: 'text' });
  f.app.enqueue({ text: 'Third edit', targetId: 's2', origin: 'text' });
  await until(() => f.contexts.length === 3 && f.effects.length === 2);
  assert.deepEqual(f.effects.map(action => action.targetId), ['s0', 's2']);
  await f.finish('s0'); await until(() => f.effects.length === 3);
  assert.equal(f.effects[2].targetId, 's1'); assert.equal(f.app.getState().tasks.find(task => task.id === first.requestId).status, 'finished');
});

test('targeted cancellation does not abort sibling requests or unlock still-running terminal work', async t => {
  const f = await fixture(t); const first = f.app.enqueue({ text: 'First edit', targetId: 's0', origin: 'text' });
  await until(() => f.effects.length === 1);
  await f.app.cancel({ requestId: first.requestId });
  f.app.enqueue({ text: 'Later edit', targetId: 's0', origin: 'text' });
  f.app.enqueue({ text: 'Independent edit', targetId: 's2', origin: 'text' });
  await until(() => f.contexts.length === 3 && f.effects.length === 2);
  assert.equal(f.effects[1].targetId, 's2'); assert.equal(f.effects[1].signal.aborted, false);
  await f.finish('s0'); await until(() => f.effects.length === 3);
});

test('plain shell independent commands preserve dispatch order without inventing completion', async t => {
  const f = await fixture(t); f.sessions[0].kind = 'terminal';
  await f.app.send({ text: 'echo one', targetId: 's0', origin: 'text' });
  await f.app.send({ text: 'echo two', targetId: 's0', origin: 'text' });
  assert.deepEqual(f.effects.map(action => action.text), ['echo one', 'echo two']);
  assert.ok(f.app.getState().tasks.every(task => task.status === 'waiting-results'));
});

test('semantic dependencies wait without executor calls, then include observed results', async t => {
  const f = await fixture(t); const first = f.app.enqueue({ text: 'Review', targetId: 's0', origin: 'text' });
  await until(() => f.effects.length === 1);
  f.plan = context => ({ goal: 'Fix findings', dependsOnRequestIds: [first.requestId], actions: [{ kind: 'send_prompt', targetIds: ['s1'], text: 'Fix findings' }] });
  f.respond = body => { const meta = JSON.parse(body.messages[1].content); const grants = meta.authorizedCommands.grants; return body.messages.some(message => message.role === 'tool') ? reply('Sent.') : { choices: [{ message: { tool_calls: [{ id: 'send', function: { name: 'workspace', arguments: JSON.stringify({ kind: 'send_prompt', grantId: grants[0].id, targetId: 's1' }) } }] } }] }; };
  f.app.enqueue({ text: 'Fix the review findings', targetId: 's1', origin: 'text' });
  await until(() => f.contexts.length === 2); assert.equal(f.executorCalls, 0); assert.equal(f.effects.length, 1);
  await f.finish('s0'); await until(() => f.effects.length === 2);
  assert.match(f.effects[1].text, /Observed review in s0/);
});

test('one utterance review then fix starts its literal future clause once with full constraints', async t => {
  const f = await fixture(t); const original = 'Review changes then fix findings, and do not commit.';
  f.plan = context => context.instruction === original ? { goal: 'Review before fixing.', executionMode: 'direct', afterResults: { instruction: 'fix findings' }, actions: [{ kind: 'send_prompt', targetIds: ['s0'], text: 'Review changes. Do not commit.' }] } : { goal: 'Fix findings without committing.', executionMode: 'direct', actions: [{ kind: 'send_prompt', targetIds: ['s0'], text: `Fix findings. Do not commit. ${context.dependencyResults[0].result.text}` }] };
  f.respond = body => body.messages.some(message => message.role === 'tool') ? reply('The review prompt was sent.') : { choices: [{ message: { tool_calls: [{ id: 'send-review', function: { name: 'workspace', arguments: JSON.stringify({ kind: 'send_prompt', targetId: 's0', grantId: JSON.parse(body.messages[1].content).authorizedCommands.grants[0].id }) } }] } }] };
  const initial = await f.app.send({ text: original, targetId: 's0', origin: 'text' });
  assert.equal(initial.ok, true, JSON.stringify(initial));
  assert.equal(f.effects.length, 1); await f.finish('s0'); await until(() => f.effects.length === 2);
  assert.equal(f.contexts[1].originalInstruction, original); assert.equal(f.contexts[1].instruction, 'fix findings');
  await f.app.refresh(); await tick(); assert.equal(f.effects.length, 2);
});

test('structured clarification survives unrelated work and assistant context is supplied as reference', async t => {
  const f = await fixture(t);
  f.plan = context => context.instruction === 'Review one' ? { goal: 'Review one', clarification: 'Which agent?', actions: [] } : context.instruction === 's0' ? { goal: 'Send review.', executionMode: 'direct', continuationOf: context.previousCommand.requestId, actions: [{ kind: 'send_prompt', sourceUserId: context.previousCommand.requestId, targetIds: ['s0'], text: 'Review changes' }] } : { goal: 'Greet.', actions: [] };
  const result = await f.app.send({ text: 'Review one', origin: 'text' });
  const pending = f.app.getState().tasks.find(task => task.id === result.requestId);
  assert.equal(pending.status, 'needs-answer'); assert.equal(pending.question.text, 'Which agent?');
  await f.app.send({ text: 'Hello', origin: 'text' });
  await f.app.send({ text: 's0', origin: 'text', replyToRequestId: result.requestId, questionId: pending.question.id });
  assert.equal(f.effects.length, 1); assert.ok(f.contexts.at(-1).recentConversation.some(message => message.role === 'assistant' && message.text === 'Which agent?'));
  assert.equal(f.app.enqueue({ text: 's0', origin: 'text', replyToRequestId: result.requestId, questionId: pending.question.id }).ok, false);
});

test('staged transport never satisfies a result dependency', async t => {
  const f = await fixture(t); f.dispatch = () => ({ ok: true, status: 'staged', reason: 'Agent input readiness is not observed.' });
  const first = await f.app.send({ text: 'Review', targetId: 's0', origin: 'text' });
  assert.equal(f.app.getState().tasks.find(task => task.id === first.requestId).status, 'paused');
  assert.match(first.text, /has not been sent.*Agent input readiness is not observed.*Open the terminal/s);
  f.plan = () => ({ goal: 'Fix', dependsOnRequestIds: [first.requestId], actions: [] });
  const dependent = f.app.enqueue({ text: 'Fix results', origin: 'text' });
  await until(() => f.app.getState().tasks.find(task => task.id === dependent.requestId)?.status === 'paused'); assert.equal(f.executorCalls, 0);
  f.app.retry({ requestId: first.requestId });
  await until(() => f.app.getState().tasks.some(task => task.status === 'needs-answer'));
  assert.equal(f.effects.length, 1, 'resuming a draft must not replay the consumed send');
});

test('mixed staged and delivered work keeps occupancy until sent work finishes, then pauses', async () => {
  const tasks = createTaskScheduler();
  const job = tasks.create({ text: 'Review both', origin: 'text' });
  job.lanes = [{ key: 'terminal:s1', targetIds: ['s1'], readOnly: false }];
  job.task.targetIds = ['s1'];
  const sessions = [{ id: 's1', generation: 'g', turnState: 'idle' }, { id: 's2', generation: 'g', turnState: 'idle' }];
  tasks.track(job, { kind: 'send_prompt', actionId: 'a', targetId: 's1', generation: 'g' }, { ok: true, status: 'written', turnId: 't1' });
  tasks.track(job, { kind: 'send_prompt', actionId: 'b', targetId: 's2', generation: 'g' }, { ok: true, status: 'staged' });
  job.executionDone = true; tasks.update(job, { status: 'waiting-results' }); tasks.reconcile(sessions);
  assert.equal(job.task.status, 'waiting-results');
  const next = tasks.create({ text: 'Next', origin: 'text' }); next.lanes = job.lanes; next.task.targetIds = ['s1'];
  let ready = false; const waiting = tasks.ready(next).then(() => { ready = true; }); await tick(); assert.equal(ready, false);
  Object.assign(sessions[0], { turnState: 'completed', turnId: 't1' }); tasks.reconcile(sessions); await waiting;
  assert.equal(job.task.status, 'paused'); assert.match(job.task.waitingReason, /not sent/);
  assert.equal(job.waits[1].done, false);
});

test('asynchronous queued staging pauses without inventing completion and later delivery clears staging', () => {
  const tasks = createTaskScheduler(); const job = tasks.create({ text: 'Review', origin: 'text' });
  const action = { kind: 'send_prompt', actionId: 'a', targetId: 's', generation: 'g' };
  const sessions = [{ id: 's', generation: 'g', turnState: 'completed', actionId: 'a', turnId: 'unrelated' }];
  tasks.track(job, action, { ok: true, status: 'queued' }); job.executionDone = true; tasks.update(job, { status: 'waiting-results' });
  tasks.delivery({ actionId: 'a', ok: true, status: 'staged' }); tasks.reconcile(sessions);
  assert.equal(job.task.status, 'paused'); assert.equal(job.waits[0].staged, true); assert.equal(job.waits[0].done, false);
  sessions[0].turnState = 'running'; sessions[0].turnId = 'actual';
  tasks.delivery({ actionId: 'a', ok: true, status: 'written', turnId: 'actual' }); tasks.reconcile(sessions);
  assert.equal(job.task.status, 'waiting-results'); assert.equal(job.waits[0].staged, false); assert.doesNotMatch(job.task.waitingReason, /draft/);
  sessions[0].turnState = 'completed'; tasks.reconcile(sessions); assert.equal(job.task.status, 'finished');
});

test('proven blocked sends terminate their waits and release occupancy, including asynchronous rejection', async () => {
  for (const asynchronous of [false, true]) {
    const tasks = createTaskScheduler(); const job = tasks.create({ text: 'Review', origin: 'text' });
    const action = { kind: 'send_prompt', actionId: 'a', targetId: 's', generation: 'g' };
    job.lanes = [{ key: 'terminal:s', targetIds: ['s'], readOnly: false }]; job.task.targetIds = ['s'];
    tasks.track(job, action, { ok: true, status: 'unconfirmed' });
    const blocked = { actionId: 'a', ok: false, status: 'blocked', delivery: 'not-dispatched', error: 'Read the current screen.' };
    if (asynchronous) tasks.delivery(blocked); else tasks.track(job, action, blocked);
    job.executionDone = true; tasks.update(job, { status: 'waiting-results' }); tasks.reconcile([{ id: 's', generation: 'g', turnState: 'unknown' }]);
    assert.equal(job.task.status, 'failed'); assert.equal(job.waits[0].done, true); assert.equal(job.waits[0].delivered, false);
    const next = tasks.create({ text: 'Operate the screen', origin: 'text' }); next.lanes = job.lanes; next.task.targetIds = ['s'];
    await tasks.ready(next);
  }
});

test('operator recovery retires only proven unsent attempts and preserves successful result tracking', () => {
  for (const asynchronous of [false, true]) {
    const tasks = createTaskScheduler(); const job = tasks.create({ text: 'Operate', origin: 'text' });
    const action = { kind: 'send_prompt', operator: true, actionId: 'a', targetId: 's', generation: 'g' };
    tasks.track(job, action, { ok: true, status: 'unconfirmed' });
    const blocked = { actionId: 'a', ok: false, status: 'blocked', delivery: 'not-dispatched' };
    if (asynchronous) tasks.delivery(blocked); else tasks.track(job, action, blocked);
    assert.equal(job.waits.length, 0);
    tasks.track(job, { ...action, actionId: 'b' }, { ok: true, status: 'written', turnId: 'result' });
    job.executionDone = true; tasks.update(job, { status: 'waiting-results' });
    tasks.reconcile([{ id: 's', generation: 'g', turnId: 'result', turnState: 'completed' }]);
    assert.equal(job.task.status, 'finished');
    const uncertain = tasks.create({ text: 'Uncertain', origin: 'text' });
    tasks.track(uncertain, action, { ok: false, status: 'unknown' });
    assert.equal(uncertain.waits.length, 1); assert.equal(uncertain.waits[0].delivered, true);
  }
});

test('operator lanes serialize active harnesses but can operate busy terminals after prior dispatch', async () => {
  const tasks = createTaskScheduler();
  const first = tasks.create({ text: 'Operate first', origin: 'text' });
  first.lanes = [{ key: 'terminal:s', targetIds: ['s'], operator: true, readOnly: false }]; first.task.targetIds = ['s'];
  tasks.reconcile([{ id: 's', generation: 'g', kind: 'codex', turnState: 'running' }]);
  await tasks.ready(first); tasks.update(first, { status: 'running' });
  const next = tasks.create({ text: 'Answer the running terminal', origin: 'text' }); next.lanes = first.lanes; next.task.targetIds = ['s'];
  let ready = false; const pending = tasks.ready(next).then(() => { ready = true; }); await tick();
  assert.equal(ready, false, 'only one active harness can control this terminal');
  tasks.track(first, { kind: 'send_prompt', operator: true, actionId: 'a', targetId: 's', generation: 'g' }, { ok: true, status: 'written' });
  first.executionDone = true; tasks.update(first, { status: 'waiting-results' }); await pending;
  assert.equal(ready, true); assert.equal(first.waits[0].done, false, 'operator readiness does not invent completion');
  const dependent = tasks.create({ text: 'Use the result', origin: 'text' }); dependent.lanes = first.lanes; dependent.task.dependsOn = [first.task.requestId];
  let dependencyReady = false; const dependency = tasks.ready(dependent).then(() => { dependencyReady = true; }, () => {}); await tick();
  assert.equal(dependencyReady, false, 'explicit result dependencies still wait');
  dependent.controller.abort(); await dependency;
  const ordinary = tasks.create({ text: 'Ordinary send', origin: 'text' }); ordinary.lanes = [{ key: 'terminal:s', targetIds: ['s'], readOnly: false }];
  let ordinaryReady = false; const waiting = tasks.ready(ordinary).then(() => { ordinaryReady = true; }, () => {}); await tick();
  assert.equal(ordinaryReady, false, 'ordinary send still waits for busy terminal'); ordinary.controller.abort(); await waiting;
});

test('native task submission waits for its provider result, including Enter after earlier typing', async () => {
  for (const submit of [true, false]) {
    const tasks = createTaskScheduler({ now: () => 100 }); const job = tasks.create({ text: 'Review then fix', origin: 'text' });
    const base = { kind: 'terminal_interact', operator: true, inputPurpose: 'task', targetId: 's', generation: 'g' };
    const baseline = { kind: 'codex', turnId: 'old', turnState: 'unknown', submittedAt: 100 };
    tasks.track(job, { ...base, actionId: 'typing', text: 'Review last commit' }, { ok: true, status: 'written' }, baseline);
    assert.equal(job.waits.length, 0, 'typing without submission does not start a task');
    tasks.track(job, { ...base, actionId: 'submission', ...(submit ? { submit: true, text: 'Review last commit' } : { keys: ['enter'] }) }, { ok: true, status: 'written' }, baseline);
    assert.equal(job.waits.length, 1);
    job.executionDone = true; tasks.update(job, { status: 'waiting-results' });
    const dependent = tasks.create({ text: 'Fix findings', origin: 'text' }); dependent.task.dependsOn = [job.task.requestId];
    let ready = false; const waiting = tasks.ready(dependent).then(() => { ready = true; });
    tasks.reconcile([{ id: 's', generation: 'g', kind: 'codex', turnId: 'old', turnState: 'completed', turnStartedAt: 90 }]); await tick(); assert.equal(ready, false);
    tasks.reconcile([{ id: 's', generation: 'g', kind: 'codex', turnId: 'new', turnState: 'running', turnStartedAt: 101 }]);
    assert.equal(job.waits[0].turnId, 'new'); assert.equal(job.task.status, 'waiting-results');
    tasks.reconcile([{ id: 's', generation: 'g', kind: 'codex', turnId: 'new', turnState: 'completed', turnStartedAt: 101 }]); await waiting;
    assert.equal(ready, true); assert.equal(job.task.status, 'finished');
  }
});

test('interaction-only controls and shell transport cannot supply provider completion evidence', () => {
  const tasks = createTaskScheduler(); const job = tasks.create({ text: 'Operate controls', origin: 'text' });
  const action = { kind: 'terminal_interact', operator: true, actionId: 'a', targetId: 's', generation: 'g', keys: ['enter'] };
  for (const inputPurpose of ['interaction', undefined]) tasks.track(job, { ...action, inputPurpose }, { ok: true, status: 'written' }, { kind: 'codex' });
  assert.equal(job.waits.length, 0);
  tasks.track(job, { ...action, inputPurpose: 'task' }, { ok: true, status: 'written', turnId: 'shell-turn' }, { kind: 'terminal' });
  job.executionDone = true; tasks.update(job, { status: 'waiting-results' });
  tasks.reconcile([{ id: 's', generation: 'g', turnId: 'shell-turn', actionId: 'a', turnState: 'completed' }]);
  assert.equal(job.waits[0].done, false); assert.equal(job.task.status, 'waiting-results');
});

test('failed dependencies pause without recursion and future dependency IDs are rejected', async () => {
  const tasks = createTaskScheduler(); const first = tasks.create({ text: 'one', origin: 'text' }); const next = tasks.create({ text: 'two', origin: 'text' });
  next.task.dependsOn = [first.task.requestId]; tasks.cancel(first.task.requestId);
  await assert.rejects(tasks.ready(next), /prerequisite/); assert.equal(next.task.status, 'paused');
});

test('partial executor failure retries only unconsumed slots and transfers authority once', async t => {
  const f = await fixture(t); f.plan = () => ({ goal: 'Review both', actions: [{ kind: 'send_prompt', targetIds: ['s0', 's1'], selection: 'all', text: 'Review only. Do not edit.' }] });
  let phase = 0;
  f.respond = body => {
    const grant = JSON.parse(body.messages[1].content).authorizedCommands.grants[0];
    if (phase++ === 1) throw new Error('Fixture connection interrupted.');
    if (phase > 3) return reply('Sent remaining review.');
    return { choices: [{ message: { tool_calls: [{ id: `call-${phase}`, function: { name: 'workspace', arguments: JSON.stringify({ kind: 'send_prompt', grantId: grant.id, targetId: phase === 1 ? 's0' : 's1' }) } }] } }] };
  };
  const first = await f.app.send({ text: 'Review both agents without editing', origin: 'text' });
  assert.equal(first.ok, false); assert.equal(f.effects.length, 1);
  const retry = f.app.retry({ requestId: first.requestId }); assert.equal(retry.ok, true);
  await until(() => f.effects.length === 2 && f.app.getState().tasks.find(task => task.id === retry.requestId)?.status === 'waiting-results');
  assert.deepEqual(f.effects.map(action => action.targetId), ['s0', 's1']);
  assert.equal(f.app.retry({ requestId: first.requestId }).ok, false);
  assert.equal(f.app.enqueue({ text: 'forge', origin: 'text', retryOf: first.requestId }).ok, false);
});

test('out-of-order action acknowledgments cannot overwrite a later routed target', async t => {
  const f = await fixture(t); let release;
  f.plan = context => ({ goal: 'Focus', executionMode: 'direct', actions: [{ kind: 'focus_session', targetIds: [context.targetId] }] });
  f.dispatch = action => action.targetId === 's0' ? new Promise(resolve => { release = () => resolve({ ok: true }); }) : { ok: true };
  const first = f.app.send({ text: 'Focus Agent 0', targetId: 's0', origin: 'text' }); await until(() => release);
  await f.app.send({ text: 'Focus Agent 1', targetId: 's1', origin: 'text' }); release(); await first;
  f.plan = context => { assert.equal(context.conversationTarget.id, 's1'); return { goal: 'Explain', actions: [] }; };
  await f.app.send({ text: 'What is it doing?', origin: 'text' });
});

test('uncertain transport retains occupancy and missing action identity never proves completion', async () => {
  const tasks = createTaskScheduler(); const job = tasks.create({ text: 'one', origin: 'text' });
  tasks.track(job, { kind: 'send_prompt', actionId: 'a', targetId: 's', generation: 'g' }, { ok: true, status: 'unconfirmed' }, { submittedAt: 10 });
  tasks.track(job, { kind: 'send_prompt', actionId: 'a', targetId: 's', generation: 'g' }, { ok: false, status: 'unknown' }, {});
  assert.equal(job.waits[0].done, false);
  tasks.reconcile([{ id: 's', generation: 'g', turnState: 'completed' }]); assert.equal(job.waits[0].done, false);
});

test('dependent prompt preparation rejects additional global effects before dispatch', async t => {
  const f = await fixture(t); const first = await f.app.send({ text: 'Review', targetId: 's0', origin: 'text' }); await f.finish('s0');
  f.plan = context => ({ goal: 'Fix', dependsOnRequestIds: [first.requestId], actions: [{ kind: 'send_prompt', targetIds: ['s1'], text: 'Fix findings' }, ...(context.dependencyResults.length ? [{ kind: 'create_project', parent: f.root, name: 'Unexpected' }] : [])] });
  const next = await f.app.send({ text: 'Fix the review findings', targetId: 's1', origin: 'text' });
  assert.equal(next.ok, false); assert.match(next.error, /frozen operations/); assert.equal(f.effects.length, 1);
});

test('a terminal already busy outside this conversation is queued instead of implicitly steered', async t => {
  const f = await fixture(t); Object.assign(f.sessions[0], { turnState: 'running', turnId: 'human-turn' });
  f.app.enqueue({ text: 'Review after current work', targetId: 's0', origin: 'text' });
  await until(() => f.contexts.length === 1); await tick(); assert.equal(f.effects.length, 0);
  await f.finish('s0'); await until(() => f.effects.length === 1);
});

test('large archived and pending task context shrinks before the selected terminal identity', () => {
  const selected = { id: 'chosen', generation: 'g', name: 'Current terminal' };
  const payload = { instruction: 'Tell it to inspect only.', conversationTarget: { id: selected.id, generation: selected.generation }, sessions: [...Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, generation: `g${i}`, name: `Other ${i}` })), selected], tasks: Array.from({ length: 120 }, (_, i) => ({ requestId: `r${i}`, text: 'Earlier task context '.repeat(100) })), pendingCommands: Array.from({ length: 50 }, (_, i) => ({ requestId: `p${i}`, instruction: 'Unrelated pending work '.repeat(100) })), previousCommand: { requestId: 'protected', instruction: 'Review only; never edit.', grants: [] } };
  const messages = fitMessages({ contextLength: 7000, outputTokens: 1200, messages: [{ role: 'system', content: 'Interpret.' }, { role: 'user', content: JSON.stringify(payload) }] });
  const fitted = JSON.parse(messages[1].content);
  assert.ok(fitted.sessions.some(session => session.id === selected.id));
  assert.equal(fitted.instruction, payload.instruction); assert.deepEqual(fitted.previousCommand, payload.previousCommand);
  assert.ok(Buffer.byteLength(JSON.stringify({ messages, tools: [] })) <= 4776);
});

test('an unverified shell command does not permanently lock another agent in its worktree', async t => {
  const f = await fixture(t); f.sessions[0].kind = 'terminal'; f.sessions[1].cwd = f.sessions[0].cwd;
  const shell = await f.app.send({ text: 'echo one', targetId: 's0', origin: 'text' });
  await f.app.send({ text: 'Review changes', targetId: 's1', origin: 'text' });
  assert.deepEqual(f.effects.map(action => action.targetId), ['s0', 's1']);
  assert.equal(f.app.getState().tasks.find(task => task.id === shell.requestId).status, 'waiting-results');
  f.plan = () => ({ goal: 'Use shell result', dependsOnRequestIds: [shell.requestId], actions: [] });
  f.app.enqueue({ text: 'Act on that shell result', origin: 'text' });
  await until(() => f.contexts.length === 3); assert.equal(f.executorCalls, 0);
  await f.app.cancel({ requestId: shell.requestId });
  await until(() => f.app.getState().tasks.at(-1).status === 'paused');
});

test('cancelled shell tracking cannot block a resumed agent in the same project', async t => {
  const f = await fixture(t); f.sessions[0].kind = 'terminal'; f.sessions[1].cwd = f.sessions[0].cwd;
  const shell = await f.app.send({ text: 'echo one', targetId: 's0', origin: 'text' });
  await f.app.cancel({ requestId: shell.requestId });
  await f.app.send({ text: 'Send follow-up to the resumed agent', targetId: 's1', origin: 'text' });
  assert.deepEqual(f.effects.map(action => action.targetId), ['s0', 's1']);
});

test('restart preserves unfinished task as paused and explicit resume asks the missing step without replay', async t => {
  const f = await fixture(t); const sent = await f.app.send({ text: 'Review changes, then fix only confirmed bugs.', targetId: 's0', origin: 'text' });
  await f.app.dispose();
  let effects = 0, interpretations = 0;
  const restored = createOrchestrator({ userDataPath: f.root, secureStorage: { isEncryptionAvailable: () => false }, getSessions: () => f.sessions,
    interpretIntent: () => { interpretations++; return { goal: 'No effect.', actions: [] }; }, dispatchAction: () => { effects++; return { ok: true }; },
    fetch: async url => new Response(JSON.stringify(url.endsWith('/key') ? { data: {} } : { data: [{ id: 'model', supported_parameters: ['tools'] }] })) });
  // The fixture owns the directory and its after hook runs first. Transfer its
  // app reference so it drains the restored instance's writes before removal.
  f.app = restored;
  assert.equal(restored.getState().tasks.find(task => task.id === sent.requestId).status, 'paused'); assert.equal(effects, 0);
  await restored.configure({ apiKey: 'fixture', model: 'model', sessionOnly: true }); await restored.setEnabled(true);
  assert.equal(effects, 0); assert.equal(interpretations, 0);
  const ack = restored.retry({ requestId: sent.requestId }); assert.equal(ack.ok, true);
  await until(() => restored.getState().tasks.find(task => task.id === ack.requestId)?.status === 'needs-answer');
  assert.equal(effects, 0); assert.equal(interpretations, 0);
  assert.match(restored.getState().tasks.find(task => task.id === ack.requestId).question.text, /unfinished step/);
});

test('two queued answers to one clarification cannot consume its authority twice', async t => {
  const f = await fixture(t);
  f.plan = context => context.instruction === 'Review' ? { goal: 'Review', clarification: 'Which terminal?', actions: [] } : { goal: 'Review the selected terminal', executionMode: 'direct', continuationOf: context.previousCommand.requestId, actions: [{ kind: 'send_prompt', sourceUserId: context.previousCommand.requestId, targetIds: ['s0'], text: 'Review only' }] };
  const first = await f.app.send({ text: 'Review', origin: 'text' });
  const question = f.app.getState().tasks.find(task => task.id === first.requestId).question;
  const input = { text: 's0', origin: 'text', replyToRequestId: first.requestId, questionId: question.id };
  const answers = [f.app.enqueue(input), f.app.enqueue(input)]; assert.ok(answers.every(answer => answer.ok));
  await until(() => f.app.getState().tasks.find(task => task.id === answers[1].requestId).status === 'failed');
  await until(() => f.effects.length === 1); assert.equal(f.effects.length, 1);
});
