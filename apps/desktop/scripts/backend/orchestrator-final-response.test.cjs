'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { formatFinalResponse } = require('../../backend/orchestratorFinalResponse.cjs');
const { failureSentence } = require('../../backend/orchestratorFailureText.cjs');
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
  assert.match(text, /haven't seen it start yet/);
  assert.match(text, ok ? /Claude stopped/ : /couldn't do that in Claude: Adapter unavailable[.]/);
});

test('same-pane pre-write rejection is not replaced by a different active wait', () => {
  const text = format({ waits: [{ ...wait, turnId: 'turn-a', observedState: 'running' }], outcomes: [sent,
    { ...sent, actionId: 'rejected-b', ok: false, status: 'rejected', validationFailure: true, error: 'Private grant mismatch.', reason: 'Internal literal validation.' }
  ] });
  assert.match(text, /Codex is working on it[.]/);
  assert.match(text, /couldn't do that in Codex[.]/);
  assert.doesNotMatch(text, /Private|Internal|grant mismatch/);
});

test('late delivery updates require exact action and generation identity', () => {
  const text = format({ waits: [], outcomes: [sent, { ...sent, actionId: 'send-b' }], deliveryUpdates: [
    { actionId: 'send-a', targetId: 'a', generation: 'g1', ok: true, status: 'queued' },
    { actionId: 'send-b', targetId: 'a', generation: 'old', ok: false, status: 'rejected', error: 'Wrong generation.' },
    { targetId: 'a', generation: 'g1', ok: false, status: 'rejected', error: 'Missing identity.' }
  ] });
  assert.match(text, /queued; nothing has been typed yet/);
  assert.match(text, /haven't seen it start yet/);
  assert.doesNotMatch(text, /Wrong generation|Missing identity/);
});

test('current scheduler wait overrides older transport receipt and update', () => {
  assert.match(format({ waits: [{ ...wait, turnId: 'turn-a', observedState: 'running' }], deliveryUpdates: [{ ...sent, status: 'queued' }] }), /Codex is working on it[.]/);
});

test('native task interaction uses its submission wait once for duplicate receipts', () => {
  const native = { ...sent, kind: 'terminal_interact' };
  const text = format({ outcomes: [native, native] });
  assert.match(text, /haven't seen it start yet/);
  assert.doesNotMatch(text, /took care of that/);
  assert.equal(text.split('Typed the task into').length - 1, 1);
});

test('uncertain adapter failure retains detail while validation detail stays private', () => {
  const failure = { ...sent, ok: false, status: 'write-failed', error: 'Adapter transport closed.' };
  assert.match(format({ outcomes: [failure], waits: [] }), /couldn't confirm that Codex took the prompt.*Adapter transport closed/);
  assert.doesNotMatch(format({ outcomes: [{ ...failure, validationFailure: true }], waits: [] }), /Adapter transport closed/);
});

test('separate verified non-task finish replaces only its successful controls', () => {
  const text = format({ outcomes: [sent,
    { kind: 'focus_session', grantId: 'gb', targetId: 'b', generation: 'g2', ok: true },
    { kind: 'finish_terminal', grantId: 'gb', targetId: 'b', generation: 'g2', ok: true, status: 'interaction-complete', text: 'Opened the settings panel in Claude.' }
  ] });
  assert.match(text, /haven't seen it start yet/);
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

test('one pane gets one failure sentence, with its reason, and its orphaned pane is named', () => {
  const created = { kind: 'create_session', ok: true, status: 'created', processState: 'running',
    name: 'Open Claude Code 11', cwd: 'C:/Projects/checkout-project', target: { id: 'c', generation: 'g3' } };
  const failure = { kind: 'send_prompt', grantId: 'gc', targetId: 'c', generation: 'g3', ok: false, status: 'blocked', delivery: 'not-dispatched' };
  const text = formatFinalResponse({ sessions: [{ id: 'c', generation: 'g3', kind: 'claude-custom', name: 'Open Claude Code 11', cwd: 'C:/Projects/checkout-project' }],
    waits: [], outcomes: [created,
      { ...failure, actionId: 'one' },
      { ...failure, actionId: 'two', error: failureSentence('input-surface-unverified', { pane: 'Open Claude Code 11' }) },
      { ...failure, actionId: 'three' }] });
  assert.equal(text, 'Opened Open Claude Code 11 in checkout-project.\n\n'
    + `I couldn't do that in Open Claude Code 11: ${failureSentence('input-surface-unverified', { pane: 'Open Claude Code 11' })}\n\n`
    + "I opened Open Claude Code 11 in checkout-project but couldn't type the task; the pane is still open.");
  assert.equal(text.split("I couldn't do that in").length - 1, 1, 'one pane, one failure sentence');
});

test('an orphan sentence needs a definite failure on every action against the new pane', () => {
  const created = { kind: 'create_session', ok: true, status: 'created', processState: 'running', name: 'Codex 4', cwd: '/work/app', target: { id: 'd', generation: 'g4' } };
  const uncertainSend = { kind: 'send_prompt', grantId: 'gd', actionId: 'd1', targetId: 'd', generation: 'g4', ok: false, status: 'unknown', error: 'Transport closed.' };
  const uncertainText = formatFinalResponse({ sessions: [{ id: 'd', generation: 'g4', name: 'Codex 4' }], waits: [], outcomes: [created, uncertainSend] });
  assert.doesNotMatch(uncertainText, /the pane is still open/, 'unconfirmed delivery is not a failure to send');
  const deliveredText = formatFinalResponse({ sessions: [{ id: 'd', generation: 'g4', name: 'Codex 4' }],
    waits: [{ actionId: 'd1', targetId: 'd', generation: 'g4', delivered: true, deliveryStatus: 'written' }],
    outcomes: [created, { ...uncertainSend, ok: true, status: 'written' }] });
  assert.doesNotMatch(deliveredText, /the pane is still open/);
  assert.doesNotMatch(formatFinalResponse({ sessions: [], waits: [], outcomes: [created] }), /the pane is still open/, 'a pane opened on request is not an orphan');
});
