'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { CLOSE_REVIEW_SCHEMA, closeReviewPayload, closeReviewPolicies, isInactiveCloseTarget, assertCloseEligibility, assertCloseInputEligibility } = require('../../backend/orchestratorCloseSafety.cjs');
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

test('a fenced close review reply is read exactly like the bare JSON it wraps', () => {
  const context = { requestId: 'r', instruction: 'Yes, those three.', sessions: [idle()], recentUserMessages: [{ id: 'earlier', text: 'Close inactive terminals.' }] };
  const plan = normalizeIntent({ goal: 'Close', actions: [{ kind: 'close', scope: { type: 'explicit', targetIds: ['worker'] } }] }, context);
  const payload = closeReviewPayload(plan, context);
  const valid = { operations: [{ operation: 0, condition: 'inactive', count: 3, evidence: [{ sourceId: 'current', quote: context.instruction }] }] };
  const fenced = text => ({ choices: [{ finish_reason: 'stop', message: { content: text } }] });
  assert.deepEqual(closeReviewPolicies(fenced('```json\n' + JSON.stringify(valid) + '\n```'), payload), { 0: { condition: 'inactive', expectedCount: 3 } });
  assert.throws(() => closeReviewPolicies(fenced('```json\nClose the three inactive panes.\n```'), payload), { code: 'ORCHESTRATOR_CLOSE_SELECTION' });
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

test('the exported close-review schema is strict-mode friendly and keeps the unclear escape hatch', () => {
  const operation = CLOSE_REVIEW_SCHEMA.properties.operations.items, evidence = operation.properties.evidence.items;
  for (const object of [CLOSE_REVIEW_SCHEMA, operation, evidence]) {
    assert.equal(object.type, 'object');
    assert.equal(object.additionalProperties, false);
    assert.equal(object.oneOf, undefined); assert.equal(object.anyOf, undefined);
    assert.deepEqual([...object.required].sort(), Object.keys(object.properties).sort());
  }
  assert.deepEqual(CLOSE_REVIEW_SCHEMA.required, ['operations']);
  assert.equal(CLOSE_REVIEW_SCHEMA.properties.operations.type, 'array');
  assert.deepEqual(operation.required, ['operation', 'condition', 'count', 'evidence']);
  assert.equal(operation.properties.operation.type, 'integer');
  assert.deepEqual(operation.properties.condition.enum, ['inactive', 'unconditional', 'unclear']);
  assert.deepEqual(operation.properties.count.type, ['integer', 'null']);
  assert.deepEqual(evidence.required, ['sourceId', 'quote']);
});

test('an unclear condition the schema permits is still refused by the validator', () => {
  const payload = { operations: [{ operation: 0 }], userSources: [{ id: 'current', text: 'close the idle ones' }] };
  const reply = condition => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ operations: [{ operation: 0, condition,
    count: null, evidence: [{ sourceId: 'current', quote: 'close the idle ones' }] }] }) } }] });
  assert.deepEqual(closeReviewPolicies(reply('inactive'), payload), { 0: { condition: 'inactive', expectedCount: null } });
  assert.throws(() => closeReviewPolicies(reply('unclear'), payload), { code: 'ORCHESTRATOR_CLOSE_SELECTION' });
});
