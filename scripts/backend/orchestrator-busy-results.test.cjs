'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskScheduler } = require('../../backend/orchestratorTasks.cjs');
const { collectTaskReports } = require('../../backend/orchestratorTaskReports.cjs');
function fixture() {
  const scheduler = createTaskScheduler({ now: () => 100 }); const job = scheduler.create({ text: 'Followup', origin: 'text' });
  const action = { kind: 'send_prompt', actionId: 'followup', targetId: 'a', generation: 'g' };
  const baseline = { kind: 'codex', turnState: 'running', turnId: 'old', submittedAt: 100 };
  scheduler.track(job, action, { ok: true, status: 'written', inputDisposition: 'submitted-while-running', deliveryBaseline: baseline, turnId: 'old' }, baseline);
  job.executionDone = true; scheduler.update(job, { status: 'waiting-results' });
  return { scheduler, job, action };
}
test('busy receipt and current-turn action tags cannot complete followup from preexisting work', () => {
  const f = fixture();
  assert.equal(f.job.waits[0].turnId, undefined);
  const session = { id: 'a', generation: 'g', turnId: 'old', completedTurnId: 'old', actionId: 'followup', completedActionId: 'followup' };
  for (const turnState of ['running', 'completed', 'failed']) {
    f.scheduler.reconcile([{ ...session, turnState }]);
    assert.equal(f.job.waits[0].done, false); assert.equal(f.job.waits[0].observedState, undefined);
  }
  assert.match(f.job.task.waitingReason, /incorporation.*unverified/);
});
test('later explicit new-turn action attribution permits progress and final result', () => {
  const f = fixture();
  const session = { id: 'a', generation: 'g', turnId: 'new', actionId: 'followup', turnState: 'running', turnStartedAt: 110 };
  f.scheduler.reconcile([session]);
  assert.equal(f.job.waits[0].turnId, 'new'); assert.equal(f.job.waits[0].observedState, 'running');
  f.scheduler.reconcile([{ ...session, turnState: 'completed', completedTurnId: 'new', completedActionId: 'followup', turnEndedAt: 200 }]);
  assert.equal(f.job.task.status, 'finished');
});
test('unrelated subsequent turn without action evidence never establishes incorporation', () => {
  const f = fixture();
  f.scheduler.reconcile([{ id: 'a', generation: 'g', turnId: 'human', turnState: 'completed', turnStartedAt: 110 }]);
  assert.equal(f.job.waits[0].done, false);
});
test('asynchronous busy receipt uses actual dispatch baseline instead of queue snapshot', () => {
  const scheduler = createTaskScheduler({ now: () => 100 }); const job = scheduler.create({ text: 'Task', origin: 'text' });
  scheduler.track(job, { kind: 'send_prompt', actionId: 'q', targetId: 'a', generation: 'g' }, { ok: true, status: 'queued' }, { kind: 'codex', turnState: 'idle', turnId: 'initial', submittedAt: 100 });
  scheduler.delivery({ actionId: 'q', ok: true, status: 'written', inputDisposition: 'submitted-while-running', turnId: 'busy', deliveryBaseline: { kind: 'codex', turnState: 'running', turnId: 'busy', submittedAt: 200 } });
  assert.equal(job.waits[0].baselineTurnId, 'busy'); assert.equal(job.waits[0].submittedAt, 200);
  assert.equal(job.waits[0].baselineIdle, false); assert.equal(job.waits[0].turnId, undefined);
});
test('busy report is explicit and deduplicated without a misleading no-start timeout', () => {
  const f = fixture();
  const reports = collectTaskReports(f.job, [], { now: () => 120000 });
  assert.equal(reports.length, 1); assert.equal(reports[0].inputDisposition, 'submitted-while-running');
  assert.match(reports[0].text, /submitted while the agent was working.*incorporated.*unverified/);
  assert.doesNotMatch(reports[0].text, /could not confirm that the agent started/);
  assert.deepEqual(collectTaskReports(f.job, [], { now: () => 240000 }), []);
  f.job.waits[0].deliveryStatus = 'unknown';
  assert.match(collectTaskReports(f.job, [], { now: () => 300000 })[0].text, /delivery is unconfirmed/);
});
test('pre-ack busy protection clears on actual queue and later idle dispatch uses new baseline', () => {
  const f = fixture();
  f.job.waits[0].deliveryStatus = 'unconfirmed';
  f.scheduler.reconcile([{ id: 'a', generation: 'g', turnId: 'old', turnState: 'completed', actionId: 'followup' }]);
  assert.equal(f.job.waits[0].done, false);
  f.scheduler.delivery({ actionId: 'followup', ok: true, status: 'queued' });
  assert.equal(f.job.waits[0].inputDisposition, undefined); assert.equal(f.job.waits[0].delivered, false);
  f.scheduler.delivery({ actionId: 'followup', ok: true, status: 'written', inputDisposition: 'submitted-when-ready', deliveryBaseline: { kind: 'codex', turnState: 'idle', turnId: 'old', submittedAt: 200 } });
  assert.equal(f.job.waits[0].inputDisposition, 'submitted-when-ready'); assert.equal(f.job.waits[0].baselineIdle, true);
  f.scheduler.reconcile([{ id: 'a', generation: 'g', turnId: 'fresh', turnStartedAt: 201, turnState: 'running' }]);
  assert.equal(f.job.waits[0].turnId, 'fresh');
  f.scheduler.reconcile([{ id: 'a', generation: 'g', turnId: 'fresh', turnStartedAt: 201, turnState: 'completed' }]);
  assert.equal(f.job.task.status, 'finished');
});
test('actual staged receipt clears provisional busy submission wording', () => {
  const f = fixture();
  f.scheduler.delivery({ actionId: 'followup', ok: true, status: 'staged' });
  assert.equal(f.job.waits[0].inputDisposition, undefined);
  const report = collectTaskReports(f.job, [])[0];
  assert.match(report.text, /draft.*not been sent/); assert.doesNotMatch(report.text, /submitted while/);
});
