'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { delegatedSubmissionFinishes, completedOperatorResponse } = require('../../backend/orchestratorFastPath.cjs');
const { createOperatorObservations } = require('../../backend/orchestratorOperator.cjs');
const { sessionIdentity } = require('../../backend/orchestratorRouting.cjs');
const { formatTaskWait } = require('../../backend/orchestratorTaskStatus.cjs');

function fixture(kind = 'codex') {
  const target = { id: 'worker', generation: 'generation' };
  const session = { ...target, kind, provider: kind, cwd: '/project', launchToken: 1, conversationId: 'native-thread',
    started: true, status: 'running', processState: 'running', agentProcessState: 'running', agentPid: 44,
    observation: 'observed', turnState: 'running', engineReady: true, name: 'Assigned worker' };
  const grant = { id: 'grant', kind: 'operate_terminal', targets: [target], text: 'Review the project.',
    routing: { cwd: session.cwd, kindOfSession: kind, workItemId: 'work',
      binding: { ...target, launchToken: 1, conversationId: session.conversationId } } };
  const wait = { targetId: target.id, generation: target.generation, actionId: 'submission', delivered: true,
    deliveryStatus: 'written', nativeIdentity: sessionIdentity(session), done: false };
  const receipt = { kind: 'send_prompt', grantId: grant.id, targetId: target.id, generation: target.generation,
    actionId: wait.actionId, ok: true, status: 'written' };
  const observations = createOperatorObservations({ now: () => 100 });
  const read = round => {
    const readId = observations.beginRead(session, round);
    return observations.observe(session, { ok: true, sequence: 1, inputRevision: 2 }, [], { modelRound: round, readId });
  };
  const before = read(0);
  observations.consume(observations.authorize(before, session, { kind: 'send_prompt' }), session, { kind: 'send_prompt' });
  const postActionToken = read(1);
  const operation = { uncertain: false, steps: 1, ...(!['fusion', 'openfusion'].includes(kind) && { nativeRecipient: { pid: 44 } }) };
  const input = { plan: { grants: [grant] }, outcomes: [receipt], waits: [wait], sessions: [session], observations,
    modelRound: 2, getOperation: () => operation, pendingRequests: [] };
  return { input, grant, session, wait, receipt, operation, observations, postActionToken,
    finish: () => delegatedSubmissionFinishes(input) };
}

for (const kind of ['codex', 'fusion', 'openfusion']) test(`${kind} delegated delivery produces one pure factual finish proposal`, () => {
  const f = fixture(kind);
  const snapshot = structuredClone({ plan: f.input.plan, outcomes: f.input.outcomes, waits: f.input.waits, session: f.session });
  const [action] = f.finish();
  assert.ok(action); assert.equal(f.finish().length, 1);
  assert.equal(action.kind, 'finish_terminal'); assert.equal(action.grantId, f.grant.id); assert.equal(action.targetId, f.session.id);
  assert.equal(action.observationToken, f.postActionToken); assert.equal(action.outcome, 'completed');
  assert.equal(action.text, formatTaskWait(f.wait, f.session)); assert.match(action.text, /result is still pending/);
  assert.deepEqual(f.finish(), [action], 'Unchanged evidence gives the same immutable step');
  assert.deepEqual({ plan: f.input.plan, outcomes: f.input.outcomes, waits: f.input.waits, session: f.session }, snapshot);
  assert.equal(f.observations.latest(f.session, 2), f.postActionToken, 'Only the dispatcher may consume evidence');
});

test('explicit operator work, inspections, unbound routing and clarification cannot auto-finish', () => {
  for (const change of [f => delete f.grant.routing, f => f.grant.inspection = true,
    f => f.input.plan.responseKind = 'terminal-inspection', f => delete f.grant.routing.binding, f => delete f.grant.routing.cwd,
    f => f.grant.kind = 'delegate_task', f => f.input.plan.clarification = 'Which project?',
    f => f.grant.targets.push({ id: 'other', generation: 'other' })]) {
    const f = fixture(); change(f); assert.deepEqual(f.finish(), []);
  }
});

test('submission attribution requires its exact grant, action and target identity', () => {
  for (const change of [f => f.input.outcomes = [], f => f.receipt.grantId = 'another', f => f.receipt.actionId = 'another',
    f => f.receipt.targetId = 'another', f => f.receipt.generation = 'another', f => f.receipt.kind = 'focus_session',
    f => f.input.waits = [], f => delete f.wait.actionId, f => f.wait.targetId = 'another', f => f.wait.generation = 'another',
    f => f.wait.source = 'watch', f => f.input.waits.push({ ...f.wait, actionId: 'second' })]) {
    const f = fixture(); change(f); assert.deepEqual(f.finish(), []);
  }
});

test('queued, staged, uncertain, failed and ambiguous current delivery never qualifies', () => {
  for (const change of [f => f.wait.delivered = false, f => f.wait.staged = true, f => f.wait.failed = true,
    f => f.wait.attributionAmbiguous = true, f => f.wait.nativeShell = true, f => f.wait.observedState = 'waiting',
    f => delete f.wait.nativeIdentity, f => f.operation.uncertain = true, f => f.receipt.ok = false,
    f => f.receipt.delivery = 'not-dispatched', ...['queued', 'staged', 'unknown', 'unconfirmed', 'uncertain', 'rejected', 'failed', 'write-failed']
      .map(status => f => f.wait.deliveryStatus = status)]) {
    const f = fixture(); change(f); assert.deepEqual(f.finish(), []);
  }
  const f = fixture(); f.receipt.status = 'queued';
  assert.equal(f.finish().length, 1, 'A later exact-action delivered wait can settle an earlier queued receipt');
});

test('changed pane, conversation, provider, project, recipient or unverified liveness blocks finalization', () => {
  for (const patch of [{ generation: 'replacement' }, { launchToken: 2 }, { conversationId: 'new-thread' },
    { kind: 'claude' }, { provider: 'claude' }, { cwd: '/other' }, { agentPid: 55 }, { started: false },
    { processState: 'exited' }, { agentProcessState: 'failed' }, { observation: 'unavailable' }, { status: 'starting' }]) {
    const f = fixture(); Object.assign(f.session, patch); assert.deepEqual(f.finish(), []);
  }
  const f = fixture('fusion'); f.session.engineReady = false; assert.deepEqual(f.finish(), []);
  const stopped = fixture('openfusion'); stopped.session.processState = 'failed'; assert.deepEqual(stopped.finish(), []);
});

test('pending user input, questions and permissions block auto-finish', () => {
  for (const patch of [{ pendingInput: true }, { pendingInteraction: true }, { manualInputPending: true },
    { interactionInputPending: true }, { heldMouseButton: 'left' }, { pendingInteractions: [{}] },
    { attention: { reason: 'approval' } }, { attention: { reason: 'question' } }, { status: 'waiting' }, { turnState: 'waiting' }]) {
    const f = fixture(); Object.assign(f.session, patch); assert.deepEqual(f.finish(), []);
  }
  for (const kind of ['question', 'permission']) {
    const f = fixture(); f.input.pendingRequests.push({ sessionId: f.session.id, generation: f.session.generation, state: 'pending', kind });
    assert.deepEqual(f.finish(), []);
  }
});

test('only a fresh earlier-round post-action read qualifies, and an existing finish is respected', () => {
  const f = fixture(); f.input.modelRound = 1; assert.deepEqual(f.finish(), []);
  f.input.modelRound = 2;
  f.observations.consume(f.observations.authorize(f.postActionToken, f.session, { kind: 'focus_session' }), f.session, { kind: 'focus_session' });
  assert.deepEqual(f.finish(), []);
  for (const status of ['blocked', 'interaction-complete']) {
    const other = fixture(); other.input.outcomes.push({ kind: 'finish_terminal', grantId: other.grant.id, targetId: other.session.id, status, ok: status !== 'blocked' });
    assert.deepEqual(other.finish(), []);
  }
});

test('changed factual summary gets a new step identity instead of rebinding an old step', () => {
  const f = fixture(), first = f.finish()[0];
  f.session.name = 'Renamed worker';
  const second = f.finish()[0];
  assert.notEqual(first.text, second.text); assert.notEqual(first.stepId, second.stepId);
});

test('a separate failure remains visible to aggregate completion after the delegated finish', () => {
  const f = fixture();
  const failure = { kind: 'navigate', grantId: 'other-effect', ok: false, status: 'rejected', error: 'Project unavailable.' };
  f.input.outcomes.push(failure);
  const action = f.finish()[0]; assert.ok(action);
  const outcomes = [...f.input.outcomes, { ...action, ok: true, status: 'interaction-complete' }];
  assert.equal(completedOperatorResponse({ ...f.input, outcomes, progress: { grants: [{ id: f.grant.id, dispatched: true }] }, deliveryWaits: f.input.waits }), undefined);
  assert.equal(f.input.outcomes.at(-1), failure); assert.equal(failure.ok, false);
  assert.equal(f.wait.done, false, 'Finishing delivery never completes the native result');
});
