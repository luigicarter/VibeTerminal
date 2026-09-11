'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIntent, authorizeIntentAction, projectIntent, claimGrant, releaseGrantStep, resolveIntentTargetAvailability, assertIntentTargetAvailability } = require('../../backend/orchestratorIntent.cjs');
const live = (id, patch = {}) => ({ id, generation: `gen-${id}`, kind: 'codex', cwd: 'C:\\work', observation: 'observed', processState: 'running', agentProcessState: 'running', agentPid: 42, turnState: 'idle', status: 'idle', ...patch });
const action = patch => ({ kind: 'operate_terminal', text: 'Review the changes.', targetIds: ['a', 'b'], selection: 'one', targetAvailability: 'idle', ...patch });
const compile = (sessions, patch = {}, extra = {}) => normalizeIntent({ goal: 'Ask one free terminal to review.', actions: [action(patch)] }, { requestId: 'u1', instruction: 'Ask one free terminal to review.', sessions, ...extra });
const send = (plan, targetId = plan.grants[0].targets[0].id, patch = {}) => ({ kind: 'send_prompt', grantId: plan.grants[0].id, targetId, stepId: 's1', ...patch });

test('idle-only group choice never chooses busy, and freezes original candidates', () => {
  const sessions = [live('a', { turnState: 'running' }), live('b')];
  for (let i = 0; i < 20; i++) {
    const plan = compile(sessions);
    assert.deepEqual(plan.grants[0].targets, [{ id: 'b', generation: 'gen-b' }]);
    assert.equal(plan.grants[0].targetCandidates.length, 2);
    assert(Object.isFrozen(plan.grants[0].targetCandidates));
    assert.equal(projectIntent(plan).grants[0].targetAvailability, 'idle');
  }
});

test('no eligible target yields clarification without any effect authority', () => {
  for (const patch of [{ turnState: 'running' }, { generation: 'paused:a' }, { observation: 'unavailable' }, { pendingInput: true }, { pendingInteraction: {} }, { childActivity: true }, { agentProcessState: 'exited' },
    { manualInputPending: true }, { interactionInputPending: true }, { heldMouseButton: 'left' }, { attention: { reason: 'question' } }, { attention: { reason: 'approval' } }]) {
    const plan = compile([live('a', patch)], { targetIds: ['a'] });
    assert.equal(plan.grants.length, 0);
    assert.match(plan.clarification, /currently free/);
    assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', targetId: 'a' }, plan, [live('a')]));
  }
});

test('free chat selection rejects contradictory startup and process evidence', () => {
  for (const kind of ['fusion', 'openfusion']) {
    for (const patch of [{ status: 'starting' }, { engineReady: false }, { processState: 'starting' }, { processState: 'exited' }, { agentProcessState: 'failed' }]) {
      const sessions = [live('a', { kind, ...patch })];
      const plan = compile(sessions, { targetIds: ['a'] });
      assert.equal(plan.grants.length, 0, `${kind}: ${JSON.stringify(patch)}`);
      assert.match(plan.clarification, /currently free/);
    }
    const ready = compile([live('a', { kind, engineReady: true, processState: undefined, agentProcessState: undefined, agentPid: undefined })], { targetIds: ['a'] });
    assert.equal(ready.grants.length, 1, 'chat readiness does not require native PTY process fields');
  }
});

test('routed continuations retain exact routing identity when another group candidate becomes free', () => {
  const sessions = [live('a'), live('b', { turnState: 'running' })];
  const initial = compile(sessions);
  const projected = projectIntent(initial).grants[0];
  const routing = { cwd: 'C:\\work', kindOfSession: 'codex', binding: { id: 'a', generation: 'gen-a' } };
  const previousCommand = { queued: true, requestId: 'u1', instruction: 'Ask one free terminal to review.', grants: [{ ...projected, routing }] };
  const changed = [live('a', { turnState: 'running' }), live('b')];
  const plan = normalizeIntent({ goal: 'Continue review.', actions: [{ kind: 'operate_terminal', sourceUserId: 'u1' }] }, { requestId: 'u2', instruction: 'Please continue.', previousCommand, sessions: changed });
  assert.throws(() => resolveIntentTargetAvailability(plan, changed), /currently free/);
  assert.equal(projectIntent(plan).grants[0].targets[0].id, 'a');
  assert.deepEqual(plan.grants[0].routing, routing);
  assert.equal(resolveIntentTargetAvailability(plan, sessions), plan);
});

test('application can reselect only original same-generation candidates before first effect', () => {
  const initial = [live('a'), live('b', { turnState: 'running' })];
  const plan = compile(initial);
  const next = resolveIntentTargetAvailability(plan, [live('a', { turnState: 'running' }), live('b'), live('c')]);
  assert.equal(next.grants[0].targets[0].id, 'b');
  assert.throws(() => projectIntent(plan), /Unknown application command/);
  assert.throws(() => resolveIntentTargetAvailability(next, [live('a', { generation: 'new' }), live('b', { turnState: 'running' }), live('c')]), /currently free/);
  const named = compile(initial, { targetIds: ['a'] });
  assert.throws(() => resolveIntentTargetAvailability(named, [live('a', { turnState: 'running' }), live('b')]), /currently free/);
});

test('claimed focus freezes choice; idle requirement survives an unsent submission release', () => {
  const sessions = [live('a'), live('b', { turnState: 'running' })];
  const plan = compile(sessions);
  const focus = authorizeIntentAction({ ...send(plan), kind: 'focus_session' }, plan, sessions);
  claimGrant(focus, plan);
  assert.throws(() => resolveIntentTargetAvailability(plan, [live('a', { turnState: 'running' }), live('b')]), /currently free/);
  const input = authorizeIntentAction(send(plan, 'a', { stepId: 's2' }), plan, sessions);
  assert.equal(input.targetAvailability, 'idle');
  claimGrant(input, plan);
  assert.throws(() => assertIntentTargetAvailability(plan, input, [live('a', { turnState: 'running' })]), /currently free/);
  assert.doesNotThrow(() => assertIntentTargetAvailability(plan, { ...input, kind: 'answer_question', stepId: 'answer' }, [live('a', { turnState: 'waiting' })]));
  releaseGrantStep(input, plan);
  assert.throws(() => assertIntentTargetAvailability(plan, send(plan, 'a', { stepId: 's3' }), [live('a', { turnState: 'running' })]), /currently free/);
});

test('all free selects only idle subset and then blocks a partial later dispatch; default any permits busy', () => {
  const sessions = [live('a'), live('b', { turnState: 'running' }), live('c')];
  const plan = compile(sessions, { targetIds: ['a', 'b', 'c'], selection: 'all' });
  assert.deepEqual(plan.grants[0].targets.map(t => t.id), ['a', 'c']);
  assert.throws(() => resolveIntentTargetAvailability(plan, [live('a'), live('b'), live('c', { turnState: 'running' })]), /currently free/);
  const any = compile(sessions, { targetIds: ['b'], targetAvailability: undefined });
  assert.doesNotThrow(() => authorizeIntentAction(send(any), any, sessions));
});

test('continuation preserves availability and candidate generation scope', () => {
  const sessions = [live('a'), live('b', { turnState: 'running' })];
  const plan = compile(sessions);
  const previousCommand = { requestId: 'u1', instruction: 'Ask one free terminal to review.', grants: projectIntent(plan).grants };
  const next = normalizeIntent({ goal: 'Continue review.', actions: [{ kind: 'operate_terminal', sourceUserId: 'u1' }] }, { requestId: 'u2', instruction: 'Please continue.', previousCommand, sessions });
  assert.equal(next.grants[0].targetAvailability, 'idle');
  assert.deepEqual(next.grants[0].targetCandidates, plan.grants[0].targetCandidates);
  const changed = [live('a', { turnState: 'running' }), live('b')];
  const pending = normalizeIntent({ goal: 'Continue review.', actions: [{ kind: 'operate_terminal', sourceUserId: 'u1' }] }, { requestId: 'u2', instruction: 'Please continue.', previousCommand: { ...previousCommand, queued: true }, sessions: changed });
  assert.equal(pending.grants[0].targets[0].id, 'a', 'Takeover retains original ownership until application resolution');
  assert.throws(() => authorizeIntentAction(send(pending), pending, changed), /currently free/);
  assert.equal(resolveIntentTargetAvailability(pending, changed).grants[0].targets[0].id, 'b');
  assert.throws(() => normalizeIntent({ goal: 'Continue.', actions: [{ kind: 'operate_terminal', sourceUserId: 'u1', targetAvailability: 'any' }] }, { requestId: 'u2', instruction: 'Continue.', previousCommand, sessions }), /unfinished operation/);
});

test('queued continuation inherits read-only, result dependencies and deferred instruction from its original user', () => {
  const sessions = [live('a')];
  const initial = normalizeIntent({ goal: 'Review then report.', access: 'read-only', dependsOnRequestIds: ['dep'], afterResults: { instruction: 'summarize the findings' }, actions: [action({ targetIds: ['a'] })] },
    { requestId: 'u1', instruction: 'Review changes then summarize the findings.', sessions, tasks: [{ requestId: 'dep' }] });
  const previousCommand = { queued: true, requestId: 'u1', instruction: 'Review changes then summarize the findings.', ...projectIntent(initial), afterResults: initial.afterResults };
  const context = { requestId: 'u2', instruction: 'Send that queued request.', previousCommand, sessions, tasks: [{ requestId: 'dep' }, { requestId: 'dep2' }] };
  const raw = { goal: 'Continue.', actions: [{ kind: 'operate_terminal', sourceUserId: 'u1' }] };
  const next = normalizeIntent(raw, context);
  assert.equal(next.access, 'read-only');
  assert.deepEqual(next.dependsOnRequestIds, ['dep']);
  assert.deepEqual(next.afterResults, { instruction: 'summarize the findings' });
  assert.deepEqual(normalizeIntent({ ...raw, dependsOnRequestIds: ['dep2'] }, context).dependsOnRequestIds, ['dep', 'dep2']);
  assert.throws(() => normalizeIntent({ ...raw, access: 'mutation' }, context), /read-only scope/);
  assert.throws(() => normalizeIntent({ ...raw, afterResults: { instruction: 'fix everything' } }, context), /deferred instruction/);
});
