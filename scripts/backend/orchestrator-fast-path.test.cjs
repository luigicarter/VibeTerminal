'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { canExecuteDirect, completedOperatorResponse } = require('../../backend/orchestratorFastPath.cjs');
const { formatDirectOutcomes } = require('../../backend/orchestratorResponse.cjs');
const create = { id: 'g', kind: 'create_session', args: { kindOfSession: 'codex', cwd: path.resolve('.') }, targets: [] };
const plan = { executionMode: 'direct', grants: [create], dependsOnRequestIds: [] };
test('direct creation requires complete unprompted bound arguments and no reasoning dependency', () => {
  assert.equal(canExecuteDirect(plan), true);
  for (const patch of [{ executionMode: 'reason' }, { clarification: 'Which folder?' }, { afterResults: { instruction: 'then review' } },
    { dependsOnRequestIds: ['earlier'] }, { grants: [{ ...create, text: 'Run a task' }] },
    { grants: [{ ...create, args: { kindOfSession: 'missing', cwd: path.resolve('.') } }] },
    { grants: [{ ...create, args: { kindOfSession: 'codex', cwd: 'relative' } }] },
    { grants: [{ ...create, kind: 'operate_terminal' }] }, { grants: [] }]) assert.equal(canExecuteDirect({ ...plan, ...patch }), false);
});
function finished() {
  const target = { id: 'a', generation: 'g1' };
  return { plan: { grants: [{ id: 'grant', kind: 'operate_terminal', targets: [target] }] },
    progress: { grants: [{ id: 'grant', dispatched: true }] }, sessions: [{ ...target, name: 'Project A' }],
    outcomes: [{ kind: 'finish_terminal', grantId: 'grant', targetId: 'a', ok: true, status: 'interaction-complete', text: 'Submitted the review.' }], getOperation: () => ({ uncertain: false }) };
}
test('consumed operator finishes reuse attribution and retain pending result qualification', () => {
  const f = finished();
  assert.equal(completedOperatorResponse(f), 'Submitted the review.');
  assert.match(completedOperatorResponse({ ...f, pendingResultTargets: ['a'] }), /result is still pending/);
  assert.match(completedOperatorResponse({ ...f, deliveryWaits: [{ targetId: 'a', deliveryStatus: 'queued' }] }), /has not been sent/);
  f.outcomes.unshift({ kind: 'send_prompt', grantId: 'grant', targetId: 'a', ok: true, status: 'queued' });
  assert.doesNotMatch(completedOperatorResponse({ ...f, deliveryWaits: [{ targetId: 'a', deliveryStatus: 'written', delivered: true }] }), /has not been sent/);
  f.plan.grants[0].targets.push({ id: 'b', generation: 'g2' });
  assert.equal(completedOperatorResponse(f), undefined, 'all targets require independent finishes');
  f.sessions.push({ id: 'b', generation: 'g2', name: 'Project B' });
  f.outcomes.push({ kind: 'finish_terminal', grantId: 'grant', targetId: 'b', ok: true, status: 'interaction-complete', text: 'Read the result.' });
  assert.equal(completedOperatorResponse(f), 'Project A: Submitted the review.\n\nProject B: Read the result.');
});
test('partial, failed, uncertain, mixed and newly blocked work retain the executor', () => {
  const f = finished();
  for (const patch of [
    { plan: { ...f.plan, clarification: 'Choose a target' } }, { plan: { ...f.plan, afterResults: { instruction: 'then fix' } } },
    { plan: { grants: [...f.plan.grants, create] } }, { progress: { grants: [{ id: 'grant', dispatched: false }] } },
    { outcomes: [] }, { outcomes: [{ ...f.outcomes[0], ok: false, status: 'blocked' }] },
    { outcomes: [...f.outcomes, { kind: 'unknown', ok: false }] }, { getOperation: () => ({ uncertain: true }) },
    { sessions: [{ id: 'a', generation: 'replacement' }] },
    { pendingRequests: [{ sessionId: 'a', generation: 'g1', state: 'pending', kind: 'permission' }] },
    { deliveryWaits: [{ targetId: 'a', failed: true, done: true, deliveryStatus: 'rejected' }] },
    { deliveryWaits: [{ targetId: 'a', deliveryStatus: 'unknown' }] },
    { deliveryUpdates: [{ targetId: 'a', ok: false, status: 'blocked' }] },
    { deliveryUpdates: [{ targetId: 'a', ok: true, status: 'unknown' }] }
  ]) assert.equal(completedOperatorResponse({ ...f, ...patch }), undefined);
});
test('direct creation wording distinguishes started, unconfirmed and failed launches', () => {
  const sessions = [{ id: 'a', name: 'Codex' }];
  const format = result => formatDirectOutcomes([{ kind: 'create_session', id: 'a', ...result }], sessions);
  assert.equal(format({ ok: true, status: 'created', processState: 'running' }), 'Opened Codex.');
  assert.match(format({ ok: true, status: 'starting' }), /not confirmed/);
  assert.match(format({ ok: false, status: 'launch-failed', error: 'Missing executable' }), /Missing executable/);
});
