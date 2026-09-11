'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { closeReviewPayload, closeReviewPolicies, isInactiveCloseTarget, assertCloseEligibility, assertCloseInputEligibility } = require('../../backend/orchestratorCloseSafety.cjs');
const { normalizeIntent } = require('../../backend/orchestratorIntent.cjs');
const idle = () => ({ id: 'worker', generation: 'g1', launchToken: 1, kind: 'codex', visiblePane: true,
  observation: 'observed', status: 'idle', turnState: 'completed', processState: 'running', agentProcessState: 'running' });
const scope = { condition: 'inactive', targets: [{ id: 'worker', generation: 'g1', launchToken: 1 }] };

test('native input checks use current decoder metadata and protect unsent user input without reading output', async () => {
  const observations = require('../../backend/terminalObservation.cjs').createTerminalObservation();
  const check = () => assertCloseInputEligibility(scope, [idle()], target => observations.inputState(target));
  try {
    assert.throws(check, { code: 'ORCHESTRATOR_CLOSE_SELECTION' });
    await observations.ingest({ type: 'created', id: 'worker', generation: 'g1', inputRevision: 0 });
    assert.doesNotThrow(check);
    await observations.ingest({ type: 'input-state', id: 'worker', generation: 'g1', inputRevision: 1, manualInputPending: true });
    assert.throws(check, { code: 'ORCHESTRATOR_CLOSE_SELECTION' });
    await observations.ingest({ type: 'input-state', id: 'worker', generation: 'old', inputRevision: 20 });
    await observations.ingest({ type: 'input-state', id: 'worker', generation: 'g1', inputRevision: 0 });
    assert.throws(check, { code: 'ORCHESTRATOR_CLOSE_SELECTION' });
    await observations.ingest({ type: 'input-state', id: 'worker', generation: 'g1', inputRevision: 2, interactionInputPending: true });
    assert.throws(check, { code: 'ORCHESTRATOR_CLOSE_SELECTION' });
    await observations.ingest({ type: 'input-state', id: 'worker', generation: 'g1', inputRevision: 3 });
    assert.doesNotThrow(check);
    observations.forget('worker', 'g1'); assert.throws(check, { code: 'ORCHESTRATOR_CLOSE_SELECTION' });
  } finally { observations.dispose(); }
});

test('inactivity requires positive evidence and excludes active, input, background and unknown states', () => {
  assert.equal(isInactiveCloseTarget(idle()), true);
  for (const state of [{ status: 'running' }, { status: 'unknown' }, { observation: 'unavailable' }, { turnState: 'unknown' },
    { pendingInput: 'submit' }, { childActivity: true }, { children: [{ id: 'child' }] }, { activeTools: ['tool'] }, { turnActive: true }, { pendingInteraction: true },
    { manualInputPending: true }, { interactionInputPending: true }, { heldMouseButton: true },
    { backgroundActivity: { active: true } }, { detachedTaskIds: ['child'] }, { attention: { reason: 'approval' } },
    { attention: { reason: 'question' } }, { launchState: 'pending' }, { processState: 'starting' }, { agentProcessState: 'unknown' },
    { binding: { status: 'ambiguous' } }, { telemetryHealth: 'unavailable' }, { engineReady: false }, { started: false }, { closed: true }]) {
    assert.equal(isInactiveCloseTarget({ ...idle(), ...state, lastActivityAt: 1 }), false, JSON.stringify(state));
    assert.throws(() => assertCloseEligibility(scope, [{ ...idle(), ...state }]), { code: 'ORCHESTRATOR_CLOSE_SELECTION' });
  }
  assert.equal(isInactiveCloseTarget({ ...idle(), status: 'exited', processState: 'exited', agentProcessState: 'exited' }), true);
  assert.equal(isInactiveCloseTarget({ ...idle(), status: 'paused', observation: 'unavailable', generation: 'paused:worker:1' }), false);
});

test('dispatch checks pending interactions, preserves replacements, and permits unconditional user closure', () => {
  assert.throws(() => assertCloseEligibility(scope, [idle()], [{ sessionId: 'worker', generation: 'g1', state: 'pending' }]), { code: 'ORCHESTRATOR_CLOSE_SELECTION' });
  assert.doesNotThrow(() => assertCloseEligibility(scope, [{ ...idle(), generation: 'g2', launchToken: 2, status: 'running' }]));
  assert.doesNotThrow(() => assertCloseEligibility({ ...scope, condition: 'unconditional' }, [{ ...idle(), status: 'running' }]));
  assert.doesNotThrow(() => assertCloseEligibility(scope, []));
});

test('close review uses user instructions and bound replies, never assistant list authorization', () => {
  const context = { requestId: 'r', instruction: 'Yes, those three.', sessions: [idle()], recentUserMessages: [{ id: 'earlier', text: 'Close inactive terminals.' }],
    recentConversation: [{ role: 'assistant', text: 'Close the working terminal.' }], replyContext: { requestId: 'reply', instruction: 'Only idle ones.' } };
  const plan = normalizeIntent({ goal: 'Close', actions: [{ kind: 'close', scope: { type: 'explicit', targetIds: ['worker'] } }] }, context);
  const payload = closeReviewPayload(plan, context);
  assert.equal(payload.userSources.length, 3); assert(!JSON.stringify(payload).includes('Close the working terminal'));
  const valid = { operations: [{ operation: 0, condition: 'inactive', count: 3, evidence: [{ sourceId: 'current', quote: context.instruction }] }] };
  const response = value => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
  assert.deepEqual(closeReviewPolicies(response(valid), payload), { 0: { condition: 'inactive', expectedCount: 3 } });
  for (const value of [{ operations: [] }, { operations: [...valid.operations, ...valid.operations] },
    { operations: [{ ...valid.operations[0], condition: 'unclear' }] }, { operations: [{ ...valid.operations[0], operation: 5 }] },
    { operations: [{ ...valid.operations[0], evidence: [{ sourceId: 'assistant', quote: 'Close the working terminal.' }] }] },
    { operations: [{ ...valid.operations[0], evidence: [null] }] },
    { operations: [{ ...valid.operations[0], evidence: [{ sourceId: 'current', quote: 'invented' }] }] }]) assert.throws(() => closeReviewPolicies(response(value), payload));
});

test('an inactive close continuation retains its restriction and cannot inherit new busy targets', () => {
  const context = { requestId: 'r1', instruction: 'Close inactive worker', sessions: [idle()], requireCloseScope: true,
    closePolicies: { 0: { condition: 'inactive', expectedCount: 1 } } };
  const original = normalizeIntent({ goal: 'Close', actions: [{ kind: 'close', scope: { type: 'explicit', targetIds: ['worker'] } }] }, context);
  const retry = { ...context, requestId: 'r2', instruction: 'Retry', closePolicies: { 0: { condition: 'unconditional', expectedCount: 1 } },
    previousCommand: { requestId: 'r1', instruction: context.instruction, grants: original.grants } };
  const raw = { goal: 'Retry', continuationOf: 'r1', actions: [{ kind: 'close', sourceUserId: 'r1' }] };
  assert.equal(normalizeIntent(raw, retry).grants[0].closeScope.condition, 'inactive');
  assert.throws(() => normalizeIntent(raw, { ...retry, sessions: [{ ...idle(), status: 'running' }] }), { code: 'ORCHESTRATOR_CLOSE_SELECTION' });
});
