'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { summarizeCloseOutcomes, confirmedClose, refreshCloseScopeOutcomes } = require('../../backend/orchestratorCloseOutcome.cjs');
const { formatFinalResponse } = require('../../backend/orchestratorFinalResponse.cjs');
const { formatDirectOutcomes } = require('../../backend/orchestratorResponse.cjs');
const { commandCompleted } = require('../../backend/orchestratorCommandCompletion.cjs');
const target = (id = 'a') => ({ id, generation: 'g1', launchToken: `launch-${id}`, name: `Agent ${id}` });
const grant = (targets = [target()]) => ({ id: 'close-grant', kind: 'close', targets,
  closeScope: { scope: { type: 'project', projectId: 'p' }, targetCount: targets.length, targets } });
const receipt = (item = target(), close = {}, patch = {}) => ({ kind: 'close', grantId: 'close-grant', targetId: item.id, generation: item.generation,
  ok: true, status: 'closed', close: { operationId: `close-${item.id}`, target: item, pane: 'removed', process: 'stopped', launchSettled: true, ...close }, ...patch });
const summarize = (outcomes, grants = [grant()], sessions = []) => summarizeCloseOutcomes({ outcomes, grants, sessions });
const completed = (outcomes, grants = [grant()]) => commandCompleted({ plan: { grants }, progress: { grants: grants.map(item => ({ id: item.id, dispatched: true })) }, responseTurn: 'complete', outcomes });

test('close_requested transport acknowledgment cannot certify closure or permit completion', () => {
  const outcomes = [{ kind: 'close', grantId: 'close-grant', targetId: 'a', generation: 'g1', ok: true, status: 'close_requested' }];
  const result = summarize(outcomes);
  assert.equal(result.ok, false); assert.equal(result.pending, true); assert.equal(result.unresolvedCount, 1);
  assert.match(result.text, /Closed 0 of 1 terminals.*Agent a.*unconfirmed/);
  assert.equal(completed(outcomes), false);
  assert.equal(formatFinalResponse({ outcomes, grants: [grant()] }), result.text);
  assert.equal(formatDirectOutcomes(outcomes, [], [grant()]), result.text);
});

test('four closures retain all eight frozen targets even if model receipts cover only four', () => {
  const targets = Array.from({ length: 8 }, (_, i) => target(String(i))), scope = grant(targets);
  const result = summarize(targets.slice(0, 4).map(item => receipt(item)), [scope]);
  assert.match(result.text, /Closed 4 of 8 terminals/); assert.equal(result.unresolvedCount, 4); assert.equal(result.ok, false);
});

test('pre-dispatch rejection or missing receipts retain the scope denominator', () => {
  const scope = grant([target(), target('b')]); scope.closeScope.targetCount = 8;
  const result = summarize([], [scope]);
  assert.match(result.text, /Closed 0 of 8 terminals/); assert.match(result.text, /6 other original terminals/);
  assert.equal(result.pending, true); assert.equal(result.unresolvedCount, 8);
  assert.equal(formatFinalResponse({ grants: [scope] }), result.text);
});

for (const state of ['unknown', 'running', 'failed', 'superseded']) test(`removed pane with ${state} process is unresolved`, () => {
  const outcomes = [receipt(target(), { process: state })], result = summarize(outcomes);
  assert.equal(result.ok, false); assert.equal(completed(outcomes), false);
  assert.match(result.text, state === 'superseded' ? /replaced.*left open/ : /process stop is still unconfirmed/);
});

test('pending launch cancellation must settle even when pane and runtime appear absent', () => {
  const outcomes = [receipt(target(), { pane: 'already-absent', process: 'already-absent', launchSettled: false })];
  assert.match(summarize(outcomes).text, /pending launch cancellation.*unconfirmed/);
  assert.equal(completed(outcomes), false);
});

test('fully confirmed active and dormant targets permit completion', () => {
  const targets = [target(), target('b')], outcomes = [receipt(), receipt(targets[1], { pane: 'already-absent', process: 'already-absent' })];
  const result = summarize(outcomes, [grant(targets)]);
  assert.equal(result.ok, true); assert.equal(result.complete, true); assert.equal(result.text, 'Closed 2 of 2 terminals.');
  assert.equal(completed(outcomes, [grant(targets)]), true);
});

test('new panes preserve successful snapshot accounting but prohibit unqualified done', () => {
  const outcomes = [receipt(target(), { newTargetCount: 1, remainingTargetCount: 0 })], result = summarize(outcomes);
  assert.equal(result.ok, true); assert.equal(result.complete, false); assert.equal(result.unresolvedCount, 0);
  assert.match(result.text, /Closed 1 of 1 original terminals.*1 new terminal remains open/);
  assert.equal(completed(outcomes), false);
});

test('fresh inventory showing original panes remains authoritative over old successful receipts', () => {
  const outcomes = [receipt(target(), { remainingTargetCount: 1 })], result = summarize(outcomes);
  assert.equal(result.ok, false); assert.equal(result.pending, true); assert.equal(completed(outcomes), false);
  assert.match(result.text, /latest inventory still contains original terminals/);
});

test('replacement generation and launch cannot stand in for frozen target or donate its name', () => {
  const original = { ...target(), name: undefined }, scope = grant([original]);
  for (const replacement of [{ ...target(), generation: 'g2' }, { ...target(), launchToken: 'replacement' }]) {
    const result = summarize([receipt(replacement)], [scope], [{ ...replacement, name: 'Wrong replacement name' }]);
    assert.equal(result.ok, false); assert.match(result.text, /terminal a/); assert.doesNotMatch(result.text, /Wrong replacement name/);
  }
});

test('operation identity, generation and launch settlement are mandatory', () => {
  for (const close of [{ operationId: undefined }, { target: { id: 'a' } }, { launchSettled: undefined }]) assert.equal(confirmedClose(receipt(target(), close)), false);
});

test('later refreshed evidence supersedes pending evidence for the same operation', () => {
  const outcomes = [receipt(target(), { process: 'unknown' }, { ok: false, status: 'close-partial' }), receipt()];
  assert.equal(summarize(outcomes).ok, true); assert.equal(completed(outcomes), true);
});

test('distinct failed close attempts stay visible after a successful independent close', () => {
  const outcomes = [receipt(target(), { operationId: 'failed-first', process: 'failed' }, { ok: false }), receipt()];
  assert.equal(summarize(outcomes).ok, false); assert.match(summarize(outcomes).text, /separate close attempt failed/);
  assert.equal(completed(outcomes), false);
});

test('scopes keep independent frozen counts and late evidence', () => {
  const second = { ...grant([target('b')]), id: 'second' };
  const result = summarize([receipt(), receipt(target('b'), { newTargetCount: 2 }, { grantId: 'second' })], [grant(), second]);
  assert.equal(result.ok, true); assert.equal(result.newTargetCount, 2);
  assert.match(result.text, /Closed 1 of 1 terminals\.\n\nClosed 1 of 1 original terminals/);
});

test('mixed send, create, focus, failed effects and closure facts each remain visible once', () => {
  const outcomes = [receipt(target(), { process: 'unknown' }),
    { kind: 'create_session', target: target('b'), ok: true, status: 'created', processState: 'running', name: 'Codex' },
    { kind: 'send_prompt', targetId: 'c', generation: 'g1', ok: true, status: 'written' },
    { kind: 'focus_session', targetId: 'b', ok: true },
    { kind: 'interrupt', targetId: 'd', ok: false, error: 'Adapter unavailable.' }];
  const text = formatFinalResponse({ outcomes, grants: [grant()], sessions: [target('c')] });
  assert.equal(text.split('Closed 0 of 1').length, 2);
  assert.match(text, /Opened Codex/); assert.match(text, /haven't confirmed that the task started/);
  assert.match(text, /Switched to/); assert.match(text, /Adapter unavailable/);
});

test('operator success prose cannot conceal close evidence on that same target', () => {
  const text = formatFinalResponse({ outcomes: [receipt(target(), { process: 'unknown' }),
    { kind: 'finish_terminal', grantId: 'close-grant', targetId: 'a', generation: 'g1', ok: true, status: 'interaction-complete', text: 'Everything closed successfully.' }], grants: [grant()] });
  assert.doesNotMatch(text, /Everything closed successfully/); assert.match(text, /process stop is still unconfirmed/);
});

test('post-refresh counts replace stale counts and exclude runtime-only orphans', () => {
  const outcomes = [receipt(target(), { remainingTargetCount: 3, newTargetCount: 4 })];
  const refreshed = refreshCloseScopeOutcomes({ outcomes, grants: [grant()], sessions: [
    { ...target(), visiblePane: false, projectId: 'p' },
    { ...target('new'), visiblePane: true, projectId: 'p' },
    { ...target('other'), visiblePane: true, projectId: 'elsewhere' }
  ] });
  assert.equal(outcomes[0].close.remainingTargetCount, 3, 'input evidence stays immutable');
  assert.equal(refreshed[0].close.remainingTargetCount, 0); assert.equal(refreshed[0].close.newTargetCount, 1);
  const result = summarize(refreshed); assert.equal(result.ok, true); assert.equal(result.complete, false);
});

test('fresh surviving original pane prevents closed claim even with older successful receipt', () => {
  const outcomes = refreshCloseScopeOutcomes({ outcomes: [receipt()], grants: [grant()], sessions: [{ ...target(), visiblePane: true, projectId: 'p' }] });
  const result = summarize(outcomes); assert.match(result.text, /Closed 0 of 1/); assert.equal(result.ok, false);
});

test('empty scope refresh retains new panes without requiring a fake target identity', () => {
  const empty = grant([]);
  for (const sessions of [[], [{ ...target('new'), visiblePane: true, projectId: 'p' }]]) {
    const outcomes = refreshCloseScopeOutcomes({ grants: [empty], sessions });
    assert.equal(outcomes[0].close.scopeEmpty, true);
    const result = summarize(outcomes, [empty]);
    assert.equal(result.ok, true); assert.equal(result.complete, false);
    assert.match(result.text, /No original terminals/);
    if (sessions.length) assert.match(result.text, /1 new terminal remains open/);
  }
});

test('empty target array cannot erase a nonzero frozen denominator during refresh', () => {
  const scope = grant([]); scope.closeScope.targetCount = 8;
  const outcomes = refreshCloseScopeOutcomes({ grants: [scope], sessions: [] });
  assert.equal(outcomes[0].close.scopeEmpty, false);
  const result = summarize(outcomes, [scope]); assert.equal(result.ok, false); assert.equal(result.unresolvedCount, 8);
});

test('frozen grant name remains available after closed pane leaves inventory', () => {
  const scope = grant(); scope.closeScope.targets = [{ id: 'a', generation: 'g1', launchToken: 'launch-a' }];
  assert.match(summarize([], [scope]).text, /Agent a/);
});

test('unauthorized rejected close never acquires lifecycle evidence or fabricates counts', () => {
  const outcomes = [{ kind: 'close', targetId: 'a', ok: false, status: 'rejected', validationFailure: true, error: 'Unauthorized tool.' }];
  const result = summarizeCloseOutcomes({ outcomes });
  assert.equal(result.present, false); assert.equal(result.text, undefined); assert.equal(result.totalTargetCount, 0);
  assert.equal(formatFinalResponse({ outcomes }), undefined, 'ordinary rejected action response remains caller-owned');
  assert.match(formatDirectOutcomes(outcomes), /couldn't complete the request/);
  assert.doesNotMatch(formatDirectOutcomes(outcomes), /Closed|original terminals|close attempt failed/);
});

test('authorized close validation failure retains frozen scope and independent unauthorized failure stays visible', () => {
  const authorized = { kind: 'close', grantId: 'close-grant', targetId: 'a', generation: 'g1', ok: false, status: 'rejected', validationFailure: true };
  assert.match(summarize([authorized]).text, /Closed 0 of 1 terminals/);
  assert.equal(summarize([authorized]).failed, true);
  const unauthorized = { ...authorized, grantId: 'ungranted', targetId: 'b', error: 'Private validation internals.' };
  const text = formatFinalResponse({ outcomes: [receipt(), unauthorized], grants: [grant()] });
  assert.match(text, /Closed 1 of 1 terminals/); assert.match(text, /couldn't complete the request/);
  assert.doesNotMatch(text, /Private validation|0 of|separate close attempt/);
});

test('empty scope keeps a factual successful response instead of a completion cue', () => {
  const empty = grant([]), outcomes = refreshCloseScopeOutcomes({ grants: [empty], sessions: [] });
  const result = summarize(outcomes, [empty]);
  assert.equal(result.ok, true); assert.equal(result.complete, false); assert.equal(completed(outcomes, [empty]), false);
  assert.equal(formatFinalResponse({ outcomes, grants: [empty] }), 'No original terminals were available to close.');
});
