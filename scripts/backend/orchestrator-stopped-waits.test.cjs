'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskScheduler } = require('../../backend/orchestratorTasks.cjs');
function fixture(nativeShell = false) {
  const scheduler = createTaskScheduler(); const job = scheduler.create({ text: 'Work', origin: 'text' });
  scheduler.track(job, { kind: 'send_prompt', actionId: 'action', targetId: 'a', generation: 'g' }, { ok: true, status: 'written', turnId: 'turn' }, { kind: nativeShell ? 'terminal' : 'codex' });
  job.executionDone = true; scheduler.update(job, { status: 'waiting-results' });
  return { scheduler, job, reconcile: patch => scheduler.reconcile([{ id: 'a', generation: 'g', kind: 'codex', turnId: 'turn', turnState: 'running', processState: 'running', agentProcessState: 'running', ...patch }]) };
}
test('same-generation CLI exit fails outstanding work even while outer PTY remains live', () => {
  const f = fixture(); f.reconcile({});
  f.reconcile({ agentProcessState: 'exited' });
  assert.equal(f.job.task.status, 'failed'); assert.equal(f.job.waits[0].failed, true);
  assert.match(f.job.waits[0].error, /agent stopped.*Completion remains unverified/);
});
test('observed attributed turn ending takes precedence over later process exit', () => {
  const f = fixture(); f.reconcile({ agentProcessState: 'exited', observation: 'observed', turnState: 'completed', turnEndedAt: 20 });
  assert.equal(f.job.task.status, 'finished'); assert.equal(f.job.waits[0].failed, false);
});
test('ambiguous and unobserved watched work fails honestly when its process exits', () => {
  for (const patch of [{ completionAttribution: 'ambiguous' }, { observation: 'unavailable' }]) {
    const f = fixture(); Object.assign(f.job.waits[0], { source: 'watch', watchUntil: 'completion' });
    f.reconcile({ ...patch, agentProcessState: 'exited' });
    assert.equal(f.job.task.status, 'failed'); assert.match(f.job.waits[0].error, /unverified/);
  }
});
test('shell writes retain explicit unknown-result semantics and idle live agents do not fail', () => {
  const shell = fixture(true); shell.reconcile({ processState: 'exited' });
  assert.equal(shell.job.waits[0].done, false); assert.match(shell.job.task.waitingReason, /cannot be verified/);
  const live = fixture(); live.reconcile({ turnState: 'idle' });
  assert.equal(live.job.waits[0].done, false);
});
