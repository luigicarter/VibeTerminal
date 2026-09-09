'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIntent, projectIntent, authorizeIntentAction, claimGrant, INTENT_SYSTEM, INTENT_TOOL } = require('../../backend/orchestratorIntent.cjs');
const sessions = [{ id: 'codex', generation: 'g1', kind: 'codex' }, { id: 'claude', generation: 'g2', kind: 'claude' }, { id: 'chat', generation: 'g3', kind: 'openfusion' }];
const context = { requestId: 'u1', instruction: 'Inspect Codex usage and reset time.', sessions };
const action = { kind: 'operate_terminal', targetIds: ['codex'], text: context.instruction };
const raw = { goal: context.instruction, responseKind: 'terminal-inspection', actions: [action] };
const normalize = (input = raw, ctx = context) => normalizeIntent(input, ctx);
const operation = (plan, extra = {}) => ({ kind: 'terminal_interact', grantId: plan.grants[0].id, targetId: 'codex', stepId: 'nav1', observationSequence: 4, inputRevision: 0, inputPurpose: 'interaction', text: '/status', submit: true, ...extra });

test('native usage inspection projects informational scope and permits freshly observed slash navigation', () => {
  const plan = normalize();
  assert.equal(plan.access, 'read-only');
  assert.equal(plan.executionMode, 'reason');
  assert.equal(plan.grants[0].inspection, true);
  assert.equal(plan.grants[0].lifecycleMode, 'preserve');
  assert.equal(plan.grants[0].permissionMode, 'none');
  const projected = projectIntent(plan);
  assert.equal(projected.responseKind, 'terminal-inspection');
  assert.equal(Object.hasOwn(projected, 'statusTargets'), false);
  assert.equal(authorizeIntentAction(operation(plan), plan, sessions).text, '/status');
  assert.throws(() => authorizeIntentAction(operation(plan, { targetId: 'claude' }), plan, sessions));
  assert.throws(() => authorizeIntentAction(operation(plan, { inputRevision: -1 }), plan, sessions), /revision/i);
});

test('inspection rejects task effects, editing, permissions, and interruption without restricting ordinary operators', () => {
  const plan = normalize();
  for (const extra of [{ inputPurpose: 'task' }, { editInput: true }, { keys: ['ctrl-c'], text: undefined }, { kind: 'send_prompt' }, { kind: 'permission' }, { kind: 'interrupt' }, { kind: 'answer_question' }]) {
    assert.throws(() => authorizeIntentAction(operation(plan, extra), plan, sessions));
  }
  const regular = normalize({ goal: 'Work.', actions: [action] });
  assert.equal(authorizeIntentAction(operation(regular, { inputPurpose: 'task' }), regular, sessions).inputPurpose, 'task');
});

test('inspection rejects incompatible plans and non-native target controls', () => {
  for (const extra of [{ access: 'mutation' }, { statusTargetIds: ['codex'] }, { statusRequestId: 'other' }, { afterResults: { instruction: 'reset time' } }, { dependsOnRequestIds: ['other'] }]) {
    assert.throws(() => normalize({ ...raw, ...extra }, { ...context, tasks: [{ requestId: 'other' }] }), /inspection/i);
  }
  for (const change of [{ lifecycleMode: 'interrupt' }, { permissionMode: 'delegated' }, { promptMode: 'literal' }, { kind: 'focus_session', text: undefined }, { targetIds: ['chat'] }]) {
    assert.throws(() => normalize({ ...raw, actions: [{ ...action, ...change }] }));
  }
  const passive = normalize({ ...raw, actions: [] });
  assert.equal(passive.access, 'read-only');
  assert.equal(projectIntent(passive).responseKind, 'terminal-inspection');
  assert.deepEqual(passive.grants, []);
});

test('unfinished inspections retain scope through grant-backed and empty clarification continuations', () => {
  const original = normalize();
  const previousCommand = { requestId: 'u1', instruction: context.instruction, grants: projectIntent(original).grants };
  const continued = normalize({ goal: context.instruction, actions: [{ kind: 'operate_terminal', sourceUserId: 'u1', targetIds: ['codex'] }] }, { ...context, requestId: 'u2', instruction: 'Continue.', previousCommand });
  assert.equal(continued.responseKind, 'terminal-inspection');
  assert.equal(continued.grants[0].inspection, true);
  assert.equal(continued.grants[0].text, context.instruction);
  assert.deepEqual(continued.grants[0].targets, original.grants[0].targets);
  assert.throws(() => normalize({ goal: 'Change the task.', actions: [{ ...action, sourceUserId: 'u1', text: 'Fix the project.' }] }, { ...context, requestId: 'u2', previousCommand }), /unfinished/);
  const unrelated = normalize({ goal: 'New work.', actions: [{ ...action, text: 'Fix the project.' }] }, { ...context, requestId: 'u2', previousCommand });
  assert.equal(unrelated.responseKind, undefined);
  assert.equal(unrelated.grants[0].inspection, undefined);
  const clarification = { goal: 'Identify the terminal.', continuationOf: 'u1', actions: [], clarification: 'Which terminal?' };
  const pending = { requestId: 'u1', instruction: context.instruction, responseKind: 'terminal-inspection', grants: [] };
  assert.equal(normalize(clarification, { ...context, requestId: 'u2', previousCommand: pending }).responseKind, 'terminal-inspection');
  assert.throws(() => normalize({ ...clarification, responseKind: 'task-status' }, { ...context, requestId: 'u2', previousCommand: pending }), /retain/);
});

test('structured flags and provider overrides cannot gain native inspection controls', () => {
  for (const variant of [
    { kind: 'claude', fusion: true }, { kind: 'opencode', openFusion: true },
    { kind: 'codex', provider: 'fusion' }, { kind: 'codex', provider: 'openfusion' },
    { kind: 'codex', provider: 'terminal' }, { kind: 'unknown', provider: 'codex' },
    { kind: undefined, provider: 'codex' },
  ]) {
    const ctx = { ...context, sessions: [{ id: 'codex', generation: 'g1', ...variant }] };
    assert.throws(() => normalize(raw, ctx), /only native coding-terminal navigation/);
    assert.deepEqual(normalize({ ...raw, actions: [] }, ctx).grants, []);
  }
});

test('partial multi-target inspection preserves its marker while excluding completed targets', () => {
  const original = normalize({ ...raw, actions: [{ ...action, targetIds: ['codex', 'claude'], selection: 'all' }] });
  const finished = authorizeIntentAction({ kind: 'finish_terminal', targetId: 'codex', stepId: 'finished', text: 'Codex quota observed.', outcome: 'completed' }, original, sessions);
  claimGrant(finished, original);
  const projected = projectIntent(original);
  assert.deepEqual(projected.grants[0].availableTargetIds, ['claude']);
  // Both parent pending-command serializers retain this marker on remaining slots.
  const remaining = { ...projected.grants[0], targets: projected.grants[0].targets.filter(target => projected.grants[0].availableTargetIds.includes(target.id)) };
  const previousCommand = { requestId: 'u1', instruction: context.instruction, grants: [remaining] };
  const continued = normalize({ goal: context.instruction, actions: [{ kind: 'operate_terminal', sourceUserId: 'u1', targetIds: ['claude'] }] }, { ...context, requestId: 'u2', instruction: 'Continue.', previousCommand });
  assert.equal(continued.responseKind, 'terminal-inspection');
  assert.equal(continued.grants[0].inspection, true);
  assert.deepEqual(continued.grants[0].targets, [{ id: 'claude', generation: 'g2' }]);
  assert.throws(() => normalize({ goal: context.instruction, actions: [{ kind: 'operate_terminal', sourceUserId: 'u1', targetIds: ['codex', 'claude'] }] }, { ...context, requestId: 'u2', previousCommand }), /unfinished/);
});

test('task status remains passive and intent instructions distinguish lookup from advice', () => {
  const plan = normalize({ goal: 'Check task state.', responseKind: 'task-status', statusTargetIds: ['codex'], actions: [] });
  assert.equal(plan.responseKind, 'task-status');
  assert.throws(() => normalize({ ...raw, responseKind: 'task-status', statusTargetIds: ['codex'] }), /no effects/);
  assert.ok(INTENT_TOOL.function.parameters.properties.responseKind.enum.includes('terminal-inspection'));
  assert.match(INTENT_SYSTEM, /How much Codex usage do I have left/);
  assert.match(INTENT_SYSTEM, /Advice-only questions.*remain passive reads/);
});
