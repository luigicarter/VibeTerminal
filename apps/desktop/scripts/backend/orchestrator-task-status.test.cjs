'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { formatTaskWait, formatTaskStatus } = require('../../backend/orchestratorTaskStatus.cjs');
const session = { id: 'a', generation: 'g1', name: 'Codex', turnId: 'old', turnState: 'completed', agentProcessState: 'running' };
const wait = { targetId: 'a', generation: 'g1', deliveryStatus: 'written', delivered: true, done: false };

test('transport and process liveness cannot prove that a submitted task started', () => {
  assert.match(formatTaskWait(wait, session), /haven't seen it start yet/);
  assert.match(formatTaskWait({ ...wait, deliveryStatus: 'queued', delivered: false }, session), /queued; nothing has been typed yet/);
  assert.match(formatTaskWait({ ...wait, staged: true }, session), /draft in Codex; nothing was sent/);
  assert.match(formatTaskWait({ ...wait, deliveryStatus: 'unknown' }, session), /couldn't confirm that Codex took the prompt.*haven't typed it again/);
  assert.match(formatTaskWait({ ...wait, nativeShell: true, deliveryStatus: 'unknown' }, session), /couldn't confirm that Codex took the prompt.*haven't typed it again/);
  assert.match(formatTaskWait(wait, { ...session, generation: 'new' }), /Codex changed, so I can't tell you where this task stands/);
  assert.match(formatTaskWait({ ...wait, inputDisposition: 'submitted-while-running' }, session), /haven't seen it taken up yet/);
});

test('attributed current running and completed evidence overrides uncertain transport without verifying work', () => {
  const attributed = { ...wait, turnId: 'new', observedState: 'running', deliveryStatus: 'unknown' };
  assert.match(formatTaskWait(attributed, { ...session, turnId: 'new', turnState: 'running' }), /Codex is working on it[.]/);
  assert.doesNotMatch(formatTaskWait(attributed, session), /is working on it/);
  assert.doesNotMatch(formatTaskWait({ ...attributed, attributionAmbiguous: true }, { ...session, turnId: 'new', turnState: 'running' }), /is working on it/);
  assert.match(formatTaskWait({ ...attributed, done: true, observedState: 'completed' }, session), /finished its turn; I haven't checked what it changed/);
  assert.match(formatTaskWait({ ...attributed, done: true, failed: true, error: 'Agent stopped.' }, session), /Agent stopped/);
});

test('an older active turn and uncertain stale identity cannot certify this input', () => {
  const active = { ...session, turnState: 'running' };
  for (const baselineTurnId of ['old', undefined]) {
    const overlapping = { ...wait, turnId: 'old', baselineTurnId, observedState: 'running', inputDisposition: 'submitted-while-running' };
    assert.match(formatTaskWait(overlapping, active), /haven't seen it taken up yet/);
    assert.doesNotMatch(formatTaskWait({ ...overlapping, done: true, observedState: 'completed' }, active), /finished its turn|started on it|is working on it/);
  }
  assert.match(formatTaskWait({ ...wait, turnId: 'stale', deliveryStatus: 'unknown' }, active), /couldn't confirm/);
  assert.match(formatTaskWait({ ...wait, turnId: 'new', baselineTurnId: 'old', inputDisposition: 'submitted-while-running', observedState: 'running' }, { ...active, turnId: 'new' }), /is working on it/);
});

test('watch fallback never asserts input was sent and readiness stays distinct from completion', () => {
  for (const patch of [{}, { attributionAmbiguous: true }, { deliveryStatus: 'unknown' }]) {
    const text = formatTaskWait({ ...wait, source: 'watch', turnId: 'old', ...patch }, session);
    assert.doesNotMatch(text, /Typed the task|took the prompt|started working/);
    assert.match(text, /watch|watching/);
  }
  assert.equal(formatTaskWait({ ...wait, source: 'watch', watchUntil: 'ready', done: true, observedState: 'ready' }, session), 'Codex is ready.');
});

test('linked requests and pending submissions retain their own turn attribution across later watches', () => {
  const jobs = [
    { task: { requestId: 'prior', sequence: 1 }, waits: [{ ...wait, turnId: 'old', observedState: 'completed', done: true }] },
    { task: { requestId: 'sent', sequence: 2 }, waits: [{ ...wait }] },
    { task: { requestId: 'watched', sequence: 3 }, waits: [{ ...wait, source: 'watch', turnId: 'old', done: true, observedState: 'completed' }] }
  ];
  const format = requestId => formatTaskStatus({ targets: [session], jobs, sessions: [session], requestId });
  assert.match(format(), /haven't seen it start yet/);
  assert.match(format('prior'), /finished its turn/);
  assert.match(format('sent'), /haven't seen it start yet/);
  assert.match(format('watched'), /finished its turn/);
  assert.match(format('unknown'), /don't have a tracked task/);
  jobs.push({ task: { requestId: 'status', sequence: 4 }, waits: [], intent: { commandPlan: { responseKind: 'task-status', statusRequestId: 'sent' } } });
  assert.match(format('status'), /haven't seen it start yet/);
  jobs.push({ task: { requestId: 'implicit', sequence: 5 }, waits: [], intent: { commandPlan: { responseKind: 'task-status' } } });
  jobs.push({ task: { requestId: 'newer', sequence: 6 }, waits: [{ ...wait, turnId: 'newer', done: true, observedState: 'completed' }] });
  jobs.push({ task: { requestId: 'second', sequence: 7 }, waits: [], input: { replyToRequestId: 'implicit' }, intent: { commandPlan: { responseKind: 'task-status' } } });
  jobs.push({ task: { requestId: 'third', sequence: 8 }, waits: [], input: { replyToRequestId: 'second' }, intent: { commandPlan: { responseKind: 'task-status' } } });
  for (const id of ['implicit', 'second', 'third']) assert.match(format(id), /haven't seen it start yet/, 'Status reply keeps its old implicit task anchor');
});
