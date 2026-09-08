'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { buildReplyContext } = require('../../backend/orchestratorReplyContext.cjs');
const { recoverSubmittedTaskIntent } = require('../../backend/orchestratorCorrectionRecovery.cjs');
const { normalizeIntent, authorizeIntentAction } = require('../../backend/orchestratorIntent.cjs');

function fixture(extraWaits = []) {
  const sessions = [{ id: 'a', generation: 'old', name: 'Codex' }, { id: 'b', generation: 'b1' }];
  const submitted = { task: { requestId: 'sent', sequence: 1, status: 'waiting-result' }, input: { text: 'Send exactly "Fix bubble labels." to Codex.' },
    waits: [{ targetId: 'a', generation: 'old', deliveryStatus: 'written', delivered: true, done: false }, ...extraWaits] };
  const jobs = [submitted];
  const messages = [{ role: 'user', requestId: 'sent', text: submitted.input.text }, { role: 'assistant', requestId: 'sent', text: 'Accepted and working.' }];
  const reference = extra => buildReplyContext({ input: {}, currentSequence: 9, jobs, sessions, messages, ...extra });
  const context = { requestId: 'correction', instruction: "You didn't paste that prompt.", sessions, tasks: jobs.map(job => job.task), pendingCommands: [], replyContext: reference() };
  return { sessions, submitted, jobs, messages, reference, context };
}

test('implicit correction carries original submission/evidence without grants and never skips unrelated exchange', () => {
  const f = fixture(), reply = f.context.replyContext;
  assert.equal(reply.implicit, true); assert.equal(reply.submittedTask.requestId, 'sent');
  assert.equal(reply.submittedTask.deliveryEvidence[0].deliveryStatus, 'written');
  assert.equal(reply.grants, undefined); assert.equal(reply.submittedTask.grants, undefined);
  f.jobs.push({ task: { requestId: 'unrelated', sequence: 2, status: 'finished' }, input: { text: 'Hello' }, waits: [] });
  f.messages.push({ role: 'user', requestId: 'unrelated', text: 'Hello' });
  assert.equal(f.reference().submittedTask, undefined);
  assert.equal(f.reference({ input: { replyToRequestId: 'sent' }, previous: f.submitted }).submittedTask.requestId, 'sent');
  f.messages.push({ role: 'assistant', requestId: 'missing-history', text: 'Untracked unrelated conversation.' });
  assert.equal(f.reference(), undefined, 'Missing history must not resurrect an older implicit subject');
});

test('historical literal-source and consumed-continuation failures recover with zero effect authority', () => {
  const { context } = fixture();
  const literal = { goal: 'Paste that prompt.', actions: [{ kind: 'operate_terminal', sourceUserId: 'correction', targetIds: ['a'], promptMode: 'literal', text: 'Fix bubble labels.' }] };
  assert.throws(() => normalizeIntent(literal, context), /literal text supplied/);
  const consumed = { ...literal, actions: [{ ...literal.actions[0], sourceUserId: 'sent' }] };
  assert.throws(() => normalizeIntent(consumed, context), /unfinished request is unavailable/);
  for (const raw of [literal, consumed]) {
    const plan = recoverSubmittedTaskIntent(raw, context);
    assert.equal(plan.responseKind, 'task-status'); assert.equal(plan.statusRequestId, 'sent');
    assert.deepEqual(plan.grants, []); assert.equal(plan.access, 'read-only');
    assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', targetId: 'a' }, plan, context.sessions), /matching user command grant/);
  }
});

test('status chain preserves original request and old generation despite newer work and omitted model ID', () => {
  const f = fixture();
  f.jobs.push({ task: { requestId: 'status', sequence: 2, status: 'finished' }, intent: { commandPlan: { responseKind: 'task-status', statusRequestId: 'sent' } } });
  f.jobs.push({ task: { requestId: 'newer', sequence: 3, status: 'waiting-result' }, waits: [{ targetId: 'a', generation: 'old', delivered: true }] });
  f.messages.push({ role: 'assistant', requestId: 'status', text: 'Delivery is unverified.' });
  f.context.replyContext = f.reference();
  for (const statusRequestId of [undefined, 'status']) {
    const plan = normalizeIntent({ goal: 'Check that prompt.', actions: [], responseKind: 'task-status', statusTargetIds: ['a'], ...(statusRequestId && { statusRequestId }) }, f.context);
    assert.equal(plan.statusRequestId, 'sent');
  }
  f.sessions[0].generation = 'replacement'; f.context.replyContext = f.reference();
  assert.equal(f.context.replyContext.submittedTask.targets[0].available, false);
  for (const sessions of [f.sessions, []]) assert.equal(normalizeIntent({ goal: 'Inspect.', actions: [], responseKind: 'task-status', statusTargetIds: ['a'] }, { ...f.context, sessions }).statusTargets[0].generation, 'old');
  assert.throws(() => normalizeIntent({ goal: 'Inspect.', actions: [], responseKind: 'task-status', statusRequestId: 'sent', statusTargetIds: ['b'] }, f.context), /belong to/);
});

test('mixed, malformed and unrelated raw interpretations cannot enter correction recovery or throw', () => {
  const { context } = fixture();
  for (const raw of [null, {}, { actions: [null] }, { actions: ['send_prompt'] },
    ...[null, {}, 'a', [null], []].map(targetIds => ({ actions: [{ kind: 'operate_terminal', sourceUserId: 'sent', targetIds }] })),
    { actions: [{ kind: 'operate_terminal', sourceUserId: 'sent', targetIds: ['a'], text: 'A different task.' }] },
    { actions: [{ kind: 'operate_terminal', sourceUserId: 'sent', targetIds: ['a'], permissionMode: 'delegated' }] },
    { continuationOf: 'sent', actions: [{ kind: 'close', targetIds: ['a'] }] },
    { continuationOf: 'sent', actions: [{ kind: 'operate_terminal', targetIds: ['b'] }] },
    { actions: [{ kind: 'operate_terminal', sourceUserId: 'sent', targetIds: ['a'] }, { kind: 'operate_terminal', sourceUserId: 'correction', targetIds: ['a'] }] },
  ]) assert.equal(recoverSubmittedTaskIntent(raw, context), undefined, JSON.stringify(raw));
  assert.equal(recoverSubmittedTaskIntent({ actions: [] }, undefined), undefined);
});

test('ambiguous multi-target correction clarifies and multi-generation submission does not guess', () => {
  const f = fixture([{ targetId: 'b', generation: 'b1', deliveryStatus: 'unknown' }]);
  const ambiguous = recoverSubmittedTaskIntent({ continuationOf: 'sent', actions: [] }, f.context);
  assert.match(ambiguous.clarification, /Which terminal/); assert.deepEqual(ambiguous.grants, []);
  const exact = recoverSubmittedTaskIntent({ actions: [{ kind: 'operate_terminal', sourceUserId: 'sent', targetIds: ['b'] }] }, f.context);
  assert.deepEqual(exact.statusTargets.map(target => target.id), ['b']);
  assert.equal(fixture([{ targetId: 'a', generation: 'replacement', deliveryStatus: 'written' }]).context.replyContext.submittedTask, undefined);
});

test('failed uncertain submission stays inspectable but cancelled/paused/restored sources do not gain continuity', () => {
  const f = fixture(); f.submitted.task.status = 'failed'; f.submitted.waits[0].deliveryStatus = 'unknown';
  assert.equal(f.reference().submittedTask.requestId, 'sent');
  f.jobs.push({ task: { requestId: 'status', sequence: 2, status: 'finished' }, intent: { commandPlan: { responseKind: 'task-status', statusRequestId: 'sent' } } });
  f.messages.push({ role: 'assistant', requestId: 'status', text: 'Unknown.' });
  for (const status of ['cancelled', 'paused']) { f.submitted.task.status = status; assert.equal(f.reference().submittedTask, undefined); }
  f.submitted.task.status = 'failed'; f.submitted.restored = true; assert.equal(f.reference().submittedTask, undefined);
});
