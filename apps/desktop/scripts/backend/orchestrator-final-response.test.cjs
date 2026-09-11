'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { formatFinalResponse } = require('../../backend/orchestratorFinalResponse.cjs');
const sessions = [{ id: 'a', generation: 'g1', name: 'Codex', turnId: 'turn-a', turnState: 'running' },
  { id: 'b', generation: 'g2', name: 'Claude' }];
const sent = { kind: 'send_prompt', actionId: 'send-a', grantId: 'ga', targetId: 'a', generation: 'g1', ok: true, status: 'written' };
const wait = { actionId: 'send-a', targetId: 'a', generation: 'g1', delivered: true, deliveryStatus: 'written' };
const format = patch => formatFinalResponse({ sessions, outcomes: [sent], waits: [wait], ...patch });

test('no creation or task evidence leaves an ordinary response alone', () => {
  assert.equal(formatFinalResponse({ outcomes: [{ kind: 'focus_session', ok: true }] }), undefined);
});

test('mixed creation and focus never repeat a shell path', () => {
  const raw = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const text = formatFinalResponse({ sessions: [{ id: 'a', generation: 'g1', kind: 'codex', name: raw }], outcomes: [
    { kind: 'create_session', ok: true, status: 'created', processState: 'running', name: raw, cwd: 'C:\\Projects\\vibeTerminal', target: { id: 'a', generation: 'g1' } },
    { kind: 'focus_session', targetId: 'a', generation: 'g1', ok: true, status: 'focused' },
    { kind: 'finish_terminal', targetId: 'a', generation: 'g1', ok: true, status: 'interaction-complete', text: `Opened ${raw}.` }
  ] });
  assert.equal(text, 'Opened Codex in vibeTerminal.\n\nSwitched to Codex.');
  assert.doesNotMatch(text, /C:|powershell|System32/);
});

for (const ok of [true, false]) test(`submission preserves unrelated interrupt ${ok ? 'success' : 'failure'}`, () => {
  const text = format({ outcomes: [sent, { kind: 'interrupt', targetId: 'b', generation: 'g2', ok, status: ok ? 'stopped' : 'blocked', ...(!ok && { error: 'Adapter unavailable.' }) }] });
  assert.match(text, /haven't confirmed that the task started/);
  assert.match(text, ok ? /Claude stopped/ : /couldn't complete.*Claude.*Adapter unavailable/);
});

test('same-pane pre-write rejection is not replaced by a different active wait', () => {
  const text = format({ waits: [{ ...wait, turnId: 'turn-a', observedState: 'running' }], outcomes: [sent,
    { ...sent, actionId: 'rejected-b', ok: false, status: 'rejected', validationFailure: true, error: 'Private grant mismatch.', reason: 'Internal literal validation.' }
  ] });
  assert.match(text, /task is running/);
  assert.match(text, /couldn't complete the request for Codex/);
  assert.doesNotMatch(text, /Private|Internal|grant mismatch/);
});

test('late delivery updates require exact action and generation identity', () => {
  const text = format({ waits: [], outcomes: [sent, { ...sent, actionId: 'send-b' }], deliveryUpdates: [
    { actionId: 'send-a', targetId: 'a', generation: 'g1', ok: true, status: 'queued' },
    { actionId: 'send-b', targetId: 'a', generation: 'old', ok: false, status: 'rejected', error: 'Wrong generation.' },
    { targetId: 'a', generation: 'g1', ok: false, status: 'rejected', error: 'Missing identity.' }
  ] });
  assert.match(text, /queued.*not been sent/);
  assert.match(text, /haven't confirmed that the task started/);
  assert.doesNotMatch(text, /Wrong generation|Missing identity/);
});

test('current scheduler wait overrides older transport receipt and update', () => {
  assert.match(format({ waits: [{ ...wait, turnId: 'turn-a', observedState: 'running' }], deliveryUpdates: [{ ...sent, status: 'queued' }] }), /task is running/);
});

test('native task interaction uses its submission wait once for duplicate receipts', () => {
  const native = { ...sent, kind: 'terminal_interact' };
  const text = format({ outcomes: [native, native] });
  assert.match(text, /haven't confirmed that the task started/);
  assert.doesNotMatch(text, /request was accepted/);
  assert.equal(text.split('Input was sent').length - 1, 1);
});

test('uncertain adapter failure retains detail while validation detail stays private', () => {
  const failure = { ...sent, ok: false, status: 'write-failed', error: 'Adapter transport closed.' };
  assert.match(format({ outcomes: [failure], waits: [] }), /couldn't confirm.*Adapter transport closed/);
  assert.doesNotMatch(format({ outcomes: [{ ...failure, validationFailure: true }], waits: [] }), /Adapter transport closed/);
});

test('separate verified non-task finish replaces only its successful controls', () => {
  const text = format({ outcomes: [sent,
    { kind: 'focus_session', grantId: 'gb', targetId: 'b', generation: 'g2', ok: true },
    { kind: 'finish_terminal', grantId: 'gb', targetId: 'b', generation: 'g2', ok: true, status: 'interaction-complete', text: 'Opened the settings panel in Claude.' }
  ] });
  assert.match(text, /haven't confirmed that the task started/);
  assert.match(text, /Opened the settings panel in Claude/);
  assert.doesNotMatch(text, /Switched to/);
});

test('task finish prose cannot override delivery facts and adapter failures retain detail', () => {
  const text = format({ outcomes: [sent,
    { kind: 'finish_terminal', grantId: 'ga', targetId: 'a', generation: 'g1', ok: true, status: 'interaction-complete', text: 'Accepted and working.' },
    { ...sent, actionId: 'send-b', ok: false, status: 'blocked', error: 'Provider disconnected.' }
  ] });
  assert.doesNotMatch(text, /Accepted and working/);
  assert.match(text, /Provider disconnected/);
});
