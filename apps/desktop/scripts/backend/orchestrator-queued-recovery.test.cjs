'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeIntent } = require('../../backend/orchestratorIntent.cjs');
const { captureQueuedCommand, assertQueuedTransfer } = require('../../backend/orchestratorQueuedRecovery.cjs');
const sessions = [{ id: 'pane', generation: 'g1', kind: 'codex' }];
function fixture() {
  const plan = normalizeIntent({ goal: 'Review.', access: 'read-only', actions: [{ kind: 'operate_terminal', targetIds: ['pane'], text: 'Review only; do not edit.' }] }, { requestId: 'original', instruction: 'Review only; do not edit.', sessions });
  const job = { input: { text: 'Review only; do not edit.', internalDependencies: ['prerequisite'] }, task: { requestId: 'original', status: 'queued', dependsOn: ['prerequisite'] },
    intent: { commandPlan: plan }, context: {}, controller: new AbortController(), waits: [] };
  const pending = job.context.pendingCommand = captureQueuedCommand(job);
  const context = { requestId: 'follow', instruction: 'Send that task.', sessions, previousCommand: pending, tasks: [{ requestId: 'prerequisite', status: 'finished', sequence: 1 }] };
  const replacement = () => normalizeIntent({ goal: 'Continue.', continuationOf: 'original', actions: [{ kind: 'operate_terminal', sourceUserId: 'original', targetIds: ['pane'] }] }, context);
  return { job, pending, replacement };
}
test('queued recovery preserves internal result dependencies and access', () => {
  const f = fixture(), plan = f.replacement();
  assert.deepEqual(plan.dependsOnRequestIds, ['prerequisite']);
  assert.equal(plan.access, 'read-only');
  assertQueuedTransfer(f.job, f.pending, plan);
});
test('admitted, dispatched, restored and replaced queued owners cannot be transferred', () => {
  for (const mutate of [job => job.admitted = true, job => job.waits.push({ deliveryStatus: 'queued' }), job => job.waits.push({ deliveryStatus: 'unknown' }), job => job.restored = true, job => job.context.pendingCommand = null]) {
    const f = fixture(), plan = f.replacement(); mutate(f.job);
    assert.throws(() => assertQueuedTransfer(f.job, f.pending, plan), /already started or changed/);
  }
});
