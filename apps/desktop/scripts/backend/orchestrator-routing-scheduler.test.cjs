'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskScheduler } = require('../../backend/orchestratorTasks.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function auto(tasks, owner, target = 's', workspace = 'repo') {
  const job = tasks.create({ text: owner });
  job.task.workItemId = owner; job.task.targetIds = [target];
  job.lanes = [{ key: `terminal:${target}`, targetIds: [target], operator: true, workItemId: owner },
    { key: `workspace:${workspace}`, targetIds: [target], readOnly: false, workItemId: owner }];
  return job;
}
function sent(tasks, job, actionId, extra = {}) {
  tasks.track(job, { kind: 'send_prompt', operator: true, actionId, targetId: job.task.targetIds[0], generation: 'g' },
    { ok: true, status: 'written', turnId: actionId, ...extra });
  job.executionDone = true; tasks.update(job, { status: 'waiting-results' });
}
function ended(tasks, target, turnId) {
  tasks.reconcile([{ id: target, generation: 'g', turnId, turnState: 'completed' }], { partial: true });
}
function pending(tasks, job) {
  const state = { ready: false };
  state.promise = tasks.ready(job).then(() => { state.ready = true; }, error => { state.error = error; });
  return state;
}

test('creation and its initial draft never track submitted work, including provisional creation waits', () => {
  const tasks = createTaskScheduler();
  const job = tasks.create({ text: 'Create a worker' });
  const action = { kind: 'create_session', actionId: 'create', prompt: 'Fix checkout' };
  job.waits.push({ actionId: 'create', delivered: true, done: false });
  tasks.track(job, action, { ok: true, status: 'created', draftStaged: true, id: 's', generation: 'g' });
  assert.deepEqual(job.waits, []);
  tasks.track(job, action, { ok: true, status: 'unconfirmed' });
  tasks.delivery({ actionId: 'create', ok: true, status: 'created', draftStaged: true });
  tasks.reconcile([{ id: 's', generation: 'g', turnId: 'unrelated', turnState: 'completed' }]);
  assert.deepEqual(job.waits, []);
});

test('legacy explicit staged prompts stay unsent while a separate real submission tracks its own result', () => {
  const tasks = createTaskScheduler();
  const draft = tasks.create({ text: 'Save a draft' });
  tasks.track(draft, { kind: 'send_prompt', actionId: 'draft', targetId: 's', generation: 'g' }, { ok: true, status: 'staged' });
  assert.equal(draft.waits[0].delivered, false);
  assert.equal(draft.waits[0].staged, true);
  const sent = tasks.create({ text: 'Run task' });
  tasks.track(sent, { kind: 'send_prompt', actionId: 'send', targetId: 's', generation: 'g' }, { ok: true, status: 'written', turnId: 'ours' });
  sent.executionDone = true;
  tasks.update(sent, { status: 'waiting-results' });
  tasks.reconcile([{ id: 's', generation: 'g', turnId: 'ours', turnState: 'completed' }]);
  assert.equal(sent.task.status, 'finished');
  assert.equal(draft.waits[0].done, false);
});

test('workspace wait does not hold controls, and a later admitted control finishes before waiting task enters', async () => {
  const tasks = createTaskScheduler();
  const original = auto(tasks, 'original'); await tasks.ready(original); sent(tasks, original, 'first');
  const independent = auto(tasks, 'independent'); const waiting = pending(tasks, independent); await tick();
  assert.equal(waiting.ready, false);
  const control = tasks.create({ text: 'Answer the owner' });
  control.lanes = [{ key: 'terminal:s', targetIds: ['s'], operator: true }];
  await tasks.ready(control);
  ended(tasks, 's', 'first'); await tick();
  assert.equal(waiting.ready, false, 'later control still owns its active loop');
  control.executionDone = true; tasks.update(control, { status: 'finished' });
  await waiting.promise; assert.equal(waiting.ready, true);
});

test('incumbent continuation passes queued independent mutation but cannot borrow original completion', async () => {
  const tasks = createTaskScheduler();
  const original = auto(tasks, 'owner'); await tasks.ready(original); sent(tasks, original, 'first');
  const independent = auto(tasks, 'other', 'other-pane'); const waiting = pending(tasks, independent);
  const follow = auto(tasks, 'owner'); await tasks.ready(follow);
  sent(tasks, follow, 'follow', { turnId: 'first', inputDisposition: 'submitted-while-running',
    deliveryBaseline: { kind: 'codex', turnId: 'first', turnState: 'running', submittedAt: 100 } });
  ended(tasks, 's', 'first'); await tick();
  assert.equal(original.waits[0].done, true); assert.equal(follow.waits[0].done, false);
  assert.equal(waiting.ready, false);
  tasks.delivery({ actionId: 'follow', status: 'written', ok: true, turnId: 'follow-turn' });
  ended(tasks, 's', 'follow-turn'); await waiting.promise;
  assert.equal(waiting.ready, true);
});

test('same owner cannot bypass active loops or explicit result prerequisites', async () => {
  const tasks = createTaskScheduler();
  const original = auto(tasks, 'owner'); await tasks.ready(original);
  const follow = auto(tasks, 'owner'); const waiting = pending(tasks, follow); await tick();
  assert.equal(waiting.ready, false);
  follow.task.dependsOn = [original.task.requestId]; sent(tasks, original, 'first'); await tick();
  assert.equal(waiting.ready, false);
  ended(tasks, 's', 'first'); await waiting.promise; assert.equal(waiting.ready, true);
});

test('cancelled and failed submitted work retain ownership; unsent cancellation releases reservation', async () => {
  for (const status of ['cancelled', 'failed']) {
    const tasks = createTaskScheduler();
    const original = auto(tasks, 'owner'); await tasks.ready(original);
    sent(tasks, original, 'first', { ok: false, status: 'unknown' });
    if (status === 'cancelled') tasks.cancel(original.task.requestId); else tasks.update(original, { status });
    const next = auto(tasks, 'other', 'other-pane'); const waiting = pending(tasks, next); await tick();
    assert.equal(waiting.ready, false, status);
    ended(tasks, 's', 'first'); await waiting.promise; assert.equal(waiting.ready, true);
  }
  const tasks = createTaskScheduler();
  const reservation = auto(tasks, 'unsent');
  const next = auto(tasks, 'next', 'other-pane'); const waiting = pending(tasks, next); await tick();
  assert.equal(waiting.ready, false);
  tasks.cancel(reservation.task.requestId); await waiting.promise;
  assert.equal(waiting.ready, true);
});

test('queued automatic delivery holds workspace until definite rejection; linked-worktree lanes remain independent', async () => {
  const tasks = createTaskScheduler();
  const queued = auto(tasks, 'owner'); await tasks.ready(queued); sent(tasks, queued, 'queued', { status: 'queued' });
  const next = auto(tasks, 'next', 'other-pane'); const waiting = pending(tasks, next); await tick();
  assert.equal(waiting.ready, false);
  const separate = auto(tasks, 'separate', 'third-pane', 'linked-worktree'); await tasks.ready(separate);
  tasks.delivery({ actionId: 'queued', ok: false, status: 'blocked', delivery: 'not-dispatched' });
  tasks.reconcile([]); await waiting.promise;
  assert.equal(waiting.ready, true);
});
