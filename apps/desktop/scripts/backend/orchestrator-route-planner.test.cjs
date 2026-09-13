'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRouteCall, deterministicNewTaskRoute, RoutingError } = require('../../backend/orchestratorRoutePlanner.cjs');
// The routing model rounds are retired; the deterministic resolver decides which
// pane a task reaches. What is left to cover here is the operation validator the
// assignment reader still enforces on every read, the launcher choice for an
// explicitly requested new conversation, and the unassigned-failure signal the
// recovery chain reads.
const choose = { kind: 'choose', decision: 'reuse', targetId: 'owner-237', workItemId: 'work-a', reason: 'Observed continuation of task A.' };

test('strict routing shape refuses forged replay fields and invalid paging, preserving valid cursors', () => {
  for (const input of [{ kind: 'list_sessions', offset: -1 }, { kind: 'list_sessions', limit: 201 }, { ...choose, observationToken: 'old' }, { ...choose, kindOfSession: 'codex' }, { kind: 'choose', decision: 'clarify', reason: 'Scope missing', text: 'Which project?', workItemId: 'old' }, { kind: 'read_conversation', reference: 'x', cursor: 1 },
    { kind: 'choose', decision: 'create', kindOfSession: 'codex', agentId: 'mixed', reason: 'create' },
    { kind: 'choose', decision: 'clarify', agentId: 'mixed', text: 'Which task?', reason: 'unclear' }]) assert.throws(() => validateRouteCall(input));
  assert.deepEqual(validateRouteCall({ kind: 'read_conversation', reference: 'opaque-ref', cursor: 'opaque-page' }), { kind: 'read_conversation', reference: 'opaque-ref', cursor: 'opaque-page' });
});

test('bound new chooses only its configured exact launcher without discovery', () => {
  const launchers = [{ kind: 'codex', available: true, configured: true }, { kind: 'claude', available: true, configured: true }];
  assert.equal(deterministicNewTaskRoute({ scope: { assignmentMode: 'auto' }, launchers }), null);
  assert.equal(deterministicNewTaskRoute({ scope: { assignmentMode: 'new', kindOfSession: 'codex' }, launchers }).kindOfSession, 'codex');
  assert.equal(deterministicNewTaskRoute({ scope: { assignmentMode: 'new' }, launchers }).decision, 'clarify');
  assert.equal(deterministicNewTaskRoute({ scope: { assignmentMode: 'new' }, launchers: launchers.slice(0, 1) }).kindOfSession, 'codex');
  const unavailable = deterministicNewTaskRoute({ scope: { assignmentMode: 'new', kindOfSession: 'codex' }, launchers: [launchers[1]] });
  assert.equal(unavailable.decision, 'clarify'); assert.match(unavailable.text, /codex/);
});

test('an unassigned routing failure keeps the signal the recovery chain reads', () => {
  const error = new RoutingError('grant-only');
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'ROUTING_EXHAUSTED'); assert.equal(error.grantId, 'grant-only');
  assert.equal(error.assignmentState, 'not-assigned'); assert.equal(error.delivery, 'not-dispatched');
});
