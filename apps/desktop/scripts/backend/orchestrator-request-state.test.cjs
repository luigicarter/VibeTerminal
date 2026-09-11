'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { settledRequestState, remainingGrantSnapshots, requestHasFailures } = require('../../backend/orchestratorRequestState.cjs');
const { normalizeIntent, authorizeIntentAction, claimGrant } = require('../../backend/orchestratorIntent.cjs');
test('delivery completion leaves native results pending and cannot overwrite cancellation or transferred ownership', () => {
  const snapshot = { task: { status: 'running' }, result: { ok: true }, waits: [{ delivered: true, done: false }] };
  assert.equal(settledRequestState(snapshot).status, 'waiting-results');
  assert.equal(settledRequestState(snapshot).controlDisposition, 'completed');
  assert.equal(settledRequestState({ ...snapshot, task: { status: 'cancelled' } }), undefined);
  assert.equal(settledRequestState({ ...snapshot, task: { status: 'running', controlDisposition: 'transferred' } }), undefined);
  assert.equal(settledRequestState({ ...snapshot, waits: [{ done: true, failed: true }] }).status, 'failed');
});
test('unfinished snapshots preserve task bindings and exclude consumed sibling grants', () => {
  const sessions = [{ id: 'a', generation: 'g', cwd: 'C:/Project', kind: 'codex', conversationId: 'thread' }];
  const plan = normalizeIntent({ goal: 'Focus and send review.', actions: [{ kind: 'focus_session', targetIds: ['a'] },
    { kind: 'operate_terminal', targetIds: ['a'], operationMode: 'task', text: 'Review without editing.' }] }, { requestId: 'r', instruction: 'Focus and send review.', sessions });
  claimGrant(authorizeIntentAction({ kind: 'focus_session', grantId: plan.grants[0].id, targetId: 'a' }, plan, sessions), plan);
  const remaining = remainingGrantSnapshots(plan);
  assert.equal(remaining.length, 1); assert.equal(remaining[0].operationMode, 'task');
  assert.equal(remaining[0].taskBindings.a.binding.conversationId, 'thread');
});
test('late uncertain receipts remain failures even after a successful control step', () => {
  assert.equal(requestHasFailures({ closeState: { present: false }, deliveryUpdates: [{ status: 'unknown' }], outcomes: [], isRecovered: () => false }), true);
});
