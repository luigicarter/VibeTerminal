'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { formatTaskWait, formatTaskStatus } = require('../../backend/orchestratorTaskStatus.cjs');
const session = { id: 'a', generation: 'g1', name: 'Codex', turnId: 'old', turnState: 'completed', agentProcessState: 'running' };
const wait = { targetId: 'a', generation: 'g1', deliveryStatus: 'written', delivered: true, done: false };

test('transport and process liveness cannot prove that a submitted task started', () => {
  assert.match(formatTaskWait(wait, session), /haven't confirmed that the task started/);
  assert.match(formatTaskWait({ ...wait, deliveryStatus: 'queued', delivered: false }, session), /queued.*not been sent/);
  assert.match(formatTaskWait({ ...wait, staged: true }, session), /draft.*not been sent/);
  assert.match(formatTaskWait({ ...wait, deliveryStatus: 'unknown' }, session), /couldn't confirm.*haven't sent it again/);
  assert.match(formatTaskWait({ ...wait, nativeShell: true, deliveryStatus: 'unknown' }, session), /couldn't confirm.*haven't sent it again/);
  assert.match(formatTaskWait(wait, { ...session, generation: 'new' }), /changed.*unverified/);
  assert.match(formatTaskWait({ ...wait, inputDisposition: 'submitted-while-running' }, session), /haven't confirmed that it started this request/);
});

test('attributed current running and completed evidence overrides uncertain transport without verifying work', () => {
  const attributed = { ...wait, turnId: 'new', observedState: 'running', deliveryStatus: 'unknown' };
  assert.match(formatTaskWait(attributed, { ...session, turnId: 'new', turnState: 'running' }), /task is running.*result is still pending/);
  assert.doesNotMatch(formatTaskWait(attributed, session), /task is running/);
  assert.doesNotMatch(formatTaskWait({ ...attributed, attributionAmbiguous: true }, { ...session, turnId: 'new', turnState: 'running' }), /task is running/);
  assert.match(formatTaskWait({ ...attributed, done: true, observedState: 'completed' }, session), /turn.*ended.*not been independently verified/);
  assert.match(formatTaskWait({ ...attributed, done: true, failed: true, error: 'Agent stopped.' }, session), /Agent stopped/);
});

test('an older active turn and uncertain stale identity cannot certify this input', () => {
  const active = { ...session, turnState: 'running' };
  for (const baselineTurnId of ['old', undefined]) {
    const overlapping = { ...wait, turnId: 'old', baselineTurnId, observedState: 'running', inputDisposition: 'submitted-while-running' };
    assert.match(formatTaskWait(overlapping, active), /haven't confirmed that it started this request/);
    assert.doesNotMatch(formatTaskWait({ ...overlapping, done: true, observedState: 'completed' }, active), /turn.*ended|task started|task is running/);
  }
  assert.match(formatTaskWait({ ...wait, turnId: 'stale', deliveryStatus: 'unknown' }, active), /couldn't confirm/);
  assert.match(formatTaskWait({ ...wait, turnId: 'new', baselineTurnId: 'old', inputDisposition: 'submitted-while-running', observedState: 'running' }, { ...active, turnId: 'new' }), /task is running/);
});

test('watch fallback never asserts input was sent and readiness stays distinct from completion', () => {
  for (const patch of [{}, { attributionAmbiguous: true }, { deliveryStatus: 'unknown' }]) {
    const text = formatTaskWait({ ...wait, source: 'watch', turnId: 'old', ...patch }, session);
    assert.doesNotMatch(text, /[Ii]nput was sent|received the prompt|task started/);
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
  assert.match(format(), /haven't confirmed that the task started/);
  assert.match(format('prior'), /turn.*ended/);
  assert.match(format('sent'), /haven't confirmed that the task started/);
  assert.match(format('watched'), /turn.*ended/);
  assert.match(format('unknown'), /don't have a tracked task/);
  jobs.push({ task: { requestId: 'status', sequence: 4 }, waits: [], intent: { commandPlan: { responseKind: 'task-status', statusRequestId: 'sent' } } });
  assert.match(format('status'), /haven't confirmed that the task started/);
  jobs.push({ task: { requestId: 'implicit', sequence: 5 }, waits: [], intent: { commandPlan: { responseKind: 'task-status' } } });
  jobs.push({ task: { requestId: 'newer', sequence: 6 }, waits: [{ ...wait, turnId: 'newer', done: true, observedState: 'completed' }] });
  jobs.push({ task: { requestId: 'second', sequence: 7 }, waits: [], input: { replyToRequestId: 'implicit' }, intent: { commandPlan: { responseKind: 'task-status' } } });
  jobs.push({ task: { requestId: 'third', sequence: 8 }, waits: [], input: { replyToRequestId: 'second' }, intent: { commandPlan: { responseKind: 'task-status' } } });
  for (const id of ['implicit', 'second', 'third']) assert.match(format(id), /haven't confirmed that the task started/, 'Status reply keeps its old implicit task anchor');
});
