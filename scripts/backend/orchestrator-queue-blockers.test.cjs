'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskScheduler } = require('../../backend/orchestratorTasks.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(onChange = () => {}) {
  const tasks = createTaskScheduler({ onChange });
  const prior = tasks.create({ text: 'Repair the old project', origin: 'text' });
  prior.task.targetIds = ['old'];
  prior.lanes = [{ key: 'workspace:C:/project', targetIds: ['old'], workItemId: 'old-work' }];
  prior.admitted = true;
  tasks.track(prior, { kind: 'send_prompt', actionId: 'send-old', targetId: 'old', generation: 1 }, { ok: true, status: 'written', turnId: 'old-turn' });
  prior.executionDone = true;
  tasks.update(prior, { status: 'waiting-results' });
  const sessions = [{ id: 'old', name: 'Old agent', generation: 1, kind: 'codex', turnId: 'old-turn', turnState: 'running' }, { id: 'empty', name: 'Empty agent', generation: 1, kind: 'codex', turnState: 'idle' }];
  tasks.reconcile(sessions);
  const next = tasks.create({ text: 'New project work', origin: 'text' });
  next.task.targetIds = ['empty'];
  next.lanes = [{ key: 'workspace:C:/project', targetIds: ['empty'], workItemId: 'new-work' }, { key: 'terminal:empty', targetIds: ['empty'] }];
  return { tasks, prior, next, sessions };
}

test('workspace queue names actual old request and target, updates unverified reason, clears only on exact result', async () => {
  const { tasks, prior, next, sessions } = fixture();
  let admitted = false;
  const ready = tasks.ready(next).then(() => { admitted = true; });
  await tick();
  assert.equal(admitted, false);
  assert.match(next.task.waitingReason, /Repair the old project/);
  assert.ok(!next.task.waitingReason.includes(prior.task.requestId));
  assert.match(next.task.waitingReason, /Old agent.*workspace C:\/project: work is still active/);
  assert.doesNotMatch(next.task.waitingReason, /Empty agent/);
  sessions[0].turnState = 'idle';
  tasks.reconcile(sessions);
  await tick();
  assert.equal(admitted, false, 'idle is not completion');
  assert.match(next.task.waitingReason, /result remains unverified/);
  sessions[0].turnState = 'completed';
  sessions[0].turnId = 'other-turn';
  tasks.reconcile(sessions);
  await tick();
  assert.equal(admitted, false, 'another turn cannot release old ownership');
  sessions[0].turnId = 'old-turn';
  tasks.reconcile(sessions);
  await ready;
  assert.equal(next.task.waitingReason, undefined);
  assert.equal(tasks.blockingReason(next), undefined);
});

test('independent workspace proceeds while same workspace remains queued', async () => {
  const { tasks, next } = fixture();
  const pending = tasks.ready(next).catch(() => {});
  const independent = tasks.create({ text: 'Other project', origin: 'text' });
  independent.lanes = [{ key: 'workspace:C:/other', targetIds: ['other'], workItemId: 'other-work' }];
  await tasks.ready(independent);
  assert.equal(independent.admitted, true);
  assert.equal(next.admitted, undefined);
  next.controller.abort(); await pending;
});

test('unchanged blocker does not notify recursively or on every reconciliation', async () => {
  let notifications = 0, tasksRef, sessionsRef, inCallback = false;
  const f = fixture(() => {
    notifications++;
    assert.ok(notifications < 30, 'notification loop');
    if (tasksRef && !inCallback) {
      inCallback = true;
      tasksRef.reconcile(sessionsRef);
      inCallback = false;
    }
  });
  tasksRef = f.tasks; sessionsRef = f.sessions;
  const pending = f.tasks.ready(f.next).catch(() => {});
  const initial = notifications;
  for (let i = 0; i < 5; i++) f.tasks.reconcile(f.sessions);
  assert.equal(notifications, initial);
  f.next.controller.abort(); await pending;
});

test('completion during blocker publication wakes admission without another refresh', async () => {
  let f, completed = false, notifications = 0;
  f = fixture(() => {
    if (!f) return;
    assert.ok(++notifications < 10, 'publication must converge without a listener loop');
    if (!completed && f.next.task.waitingReason) {
      completed = true;
      f.sessions[0].turnState = 'completed';
      f.tasks.reconcile(f.sessions);
    }
  });
  let admitted = false;
  const pending = f.tasks.ready(f.next).then(() => { admitted = true; }, () => {});
  try {
    await tick();
    assert.equal(completed, true);
    assert.equal(f.prior.task.status, 'finished');
    assert.equal(admitted, true, 'the completion notification cannot be lost during blocker publication');
    assert.equal(f.next.task.waitingReason, undefined);
  } finally { f.next.controller.abort(); await pending; }
});

test('ambiguous attribution and background occupancy remain truthful blockers', async () => {
  const { tasks, next, sessions } = fixture();
  const pending = tasks.ready(next).catch(() => {});
  sessions[0].turnState = 'completed';
  sessions[0].completionAttribution = 'ambiguous';
  tasks.reconcile(sessions);
  assert.match(next.task.waitingReason, /result cannot yet be attributed/);
  sessions[0].childActivity = true;
  tasks.reconcile(sessions);
  assert.match(next.task.waitingReason, /background work is still active/);
  assert.equal(next.admitted, undefined);
  next.controller.abort(); await pending;
});

test('prerequisite blockers name their owning request and clear after success', async () => {
  const { tasks, prior } = fixture();
  const next = tasks.create({ text: 'Summarize', origin: 'text' });
  next.task.dependsOn = [prior.task.requestId];
  const pending = tasks.waitForDependencies(next);
  assert.match(next.task.waitingReason, /prerequisite request "Repair the old project"/);
  assert.match(next.task.waitingReason, /result remains unverified/);
  tasks.update(prior, { status: 'finished' });
  await pending;
  assert.equal(next.task.waitingReason, undefined);
  assert.equal(next.admitted, undefined, 'dependency waiting does not acquire lanes');
});

test('status recognizes admission queue without claiming delivery or accepting a replacement pane', () => {
  const { formatTaskStatus } = require('../../backend/orchestratorTaskStatus.cjs');
  const target = { id: 'empty', generation: 1, name: 'Empty agent' };
  const queued = { task: { requestId: 'queued', sequence: 1, status: 'queued', targets: [target], waitingReason: 'Waiting for earlier project work; its result remains unverified.' }, waits: [] };
  const status = { task: { requestId: 'status', sequence: 2 }, waits: [], intent: { commandPlan: { responseKind: 'task-status', statusRequestId: 'queued' } } };
  const jobs = [queued, status];
  for (const requestId of [undefined, 'queued', 'status']) {
    const text = formatTaskStatus({ targets: [target], sessions: [target], jobs, requestId });
    assert.match(text, /request.*queued; no prompt delivery has been recorded/);
    assert.match(text, /earlier project work; its result remains unverified/);
    assert.doesNotMatch(text, /Input was sent|task is running|don't have a tracked/);
  }
  const changed = formatTaskStatus({ targets: [target], sessions: [{ ...target, generation: 2 }], jobs, requestId: 'status' });
  assert.match(changed, /changed.*delivery is unverified/);
  assert.doesNotMatch(changed, /Input was sent|task is running/);
  const newTarget = formatTaskStatus({ targets: [{ ...target, generation: 2 }], sessions: [{ ...target, generation: 2 }], jobs, requestId: 'queued' });
  assert.match(newTarget, /don't have a tracked task/);
});

test('new admission queue remains status subject over older submissions and later watches', () => {
  const { formatTaskStatus } = require('../../backend/orchestratorTaskStatus.cjs');
  const target = { id: 'empty', generation: 1, name: 'Empty agent', turnId: 'old', turnState: 'running' };
  const wait = { targetId: target.id, generation: 1, delivered: true, turnId: 'old', observedState: 'running' };
  const jobs = [
    { task: { requestId: 'old', sequence: 1 }, waits: [wait] },
    { task: { requestId: 'queued', sequence: 2, status: 'queued', targets: [target] }, waits: [] },
    { task: { requestId: 'watch', sequence: 3 }, waits: [{ ...wait, source: 'watch' }] }
  ];
  assert.match(formatTaskStatus({ targets: [target], sessions: [target], jobs }), /request.*queued/);
  assert.match(formatTaskStatus({ targets: [target], sessions: [target], jobs, requestId: 'old' }), /task is running/);
});
