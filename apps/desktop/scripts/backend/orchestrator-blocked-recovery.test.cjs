'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIntent, authorizeIntentAction, claimGrant, projectIntent } = require('../../backend/orchestratorIntent.cjs');
const sessions = [{ id: 'a', generation: 'g', kind: 'codex' }, { id: 'b', generation: 'gb', kind: 'claude' }];
function fixture(targetIds = ['a']) {
  const plan = normalizeIntent({ goal: 'Review changes and report findings.', actions: [{ kind: 'operate_terminal', targetIds, selection: 'all', text: 'Review changes and report findings.' }] }, { requestId: 'original', instruction: 'Review changes and report findings.', sessions });
  const action = (kind, stepId, extra = {}) => authorizeIntentAction({ kind, grantId: plan.grants[0].id, targetId: 'a', stepId, ...extra }, plan, sessions);
  return { plan, action, project: () => projectIntent(plan).grants[0] };
}
test('blocked finish retains the objective without making claimed effects replayable', () => {
  const f = fixture();
  const sent = f.action('send_prompt', 'sent', { text: 'Review changes.' }); claimGrant(sent, f.plan);
  const blocked = f.action('finish_terminal', 'blocked', { outcome: 'blocked', text: 'The submission remains unconfirmed.' });
  assert.equal(claimGrant(blocked, f.plan).consumed, false);
  assert.deepEqual(f.project().availableTargetIds, ['a']);
  assert.deepEqual(f.project().blockedTargetIds, ['a']);
  assert.equal(f.project().dispatched, false);
  assert.equal(f.project().progress[0].steps, 1);
  assert.equal(f.project().progress[0].outcome, 'blocked');
  assert.throws(() => claimGrant(sent, f.plan), /already dispatched/);
  assert.throws(() => claimGrant(blocked, f.plan), /already dispatched/);
});
test('fresh recovery preserves step accounting and only successful finish consumes objective', () => {
  const f = fixture();
  claimGrant(f.action('terminal_interact', 'edit', { keys: ['home'], observationSequence: 1, inputRevision: 0 }), f.plan);
  claimGrant(f.action('finish_terminal', 'blocked', { outcome: 'blocked', text: 'Composer needs clearing.' }), f.plan);
  claimGrant(f.action('terminal_interact', 'recover', { keys: ['end'], observationSequence: 2, inputRevision: 1 }), f.plan);
  assert.equal(f.project().progress[0].steps, 2);
  assert.deepEqual(f.project().blockedTargetIds, []);
  assert.equal(f.project().progress[0].outcome, undefined);
  claimGrant(f.action('finish_terminal', 'finished', { outcome: 'completed', text: 'Input prepared.' }), f.plan);
  assert.equal(f.project().dispatched, true);
  assert.deepEqual(f.project().availableTargetIds, []);
});
test('blocked sibling remains available after another target completes', () => {
  const f = fixture(['a', 'b']);
  claimGrant(f.action('finish_terminal', 'blocked-a', { outcome: 'blocked', text: 'Needs input.' }), f.plan);
  const completed = authorizeIntentAction({ kind: 'finish_terminal', grantId: f.plan.grants[0].id, targetId: 'b', stepId: 'completed-b', outcome: 'completed', text: 'Finished interaction.' }, f.plan, sessions);
  claimGrant(completed, f.plan);
  assert.deepEqual(f.project().availableTargetIds, ['a']);
  assert.deepEqual(f.project().blockedTargetIds, ['a']);
  assert.equal(f.project().dispatched, false);
});
