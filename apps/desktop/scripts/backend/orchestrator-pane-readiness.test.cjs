'use strict';
// One pane-state predicate, six former call sites. Each of those used to decide
// "is this pane usable" privately, and where two of them disagreed a pane
// counted as free or busy depending on which one ran. These cases pin both
// halves: the facts the predicate reports, and that every call site that used to
// own a copy still answers the way its callers need.
const test = require('node:test');
const assert = require('node:assert/strict');
const { paneReadiness, paneForm } = require('../../backend/orchestratorPaneReadiness.cjs');
const { sessionReady } = require('../../backend/orchestratorLaunchers.cjs');
const { isIdleTarget } = require('../../backend/orchestratorTargetAvailability.cjs');
const { idlePaneCandidate } = require('../../backend/orchestratorResolver.cjs');
const { isObservedBusyPrompt } = require('../../backend/orchestratorBusyInput.cjs');

const pane = (extra = {}) => ({ id: 'p', generation: 'g', launchToken: 1, kind: 'codex', provider: 'codex',
  started: true, status: 'idle', launchState: 'ready', processState: 'running', agentProcessState: 'running',
  agentPid: 42, observation: 'observed', turnState: 'idle', binding: { status: 'found' }, ...extra });

test('a live idle agent pane reports every fact true, and every call site accepts it', () => {
  const session = pane();
  assert.deepEqual(paneReadiness(session), { form: 'native', process: true, composerVerified: true, named: true, idle: true, untouched: true, free: true, reason: 'ready' });
  assert.equal(sessionReady(session), true);
  assert.equal(isIdleTarget(session), true);
  assert.equal(idlePaneCandidate(session), true);
});

// The reason is the first fact that is false, and it is what the delivery
// classifier, the launch label and the idle-pane resolver all read.
for (const [reason, patch, facts] of [
  ['not-running', { processState: 'exited' }, { process: false, composerVerified: false, named: false, idle: false }],
  ['not-running', { started: false }, { process: false }],
  ['not-running', { generation: 'paused:p:1' }, { process: false }],
  ['launch-pending', { launchState: 'pending' }, { process: false, composerVerified: false }],
  ['launch-pending', { status: 'starting' }, { process: false }],
  ['unverified', { binding: { status: 'ambiguous' } }, { process: true, composerVerified: false, named: false, idle: false }],
  ['unverified', { agentPid: 0 }, { composerVerified: false }],
  ['unverified', { selection: { status: 'pending' } }, { composerVerified: false }],
  ['waiting', { pendingInteraction: true }, { composerVerified: true, idle: false }],
  ['waiting', { attention: { reason: 'approval' } }, { idle: false }],
  ['waiting', { turnState: 'waiting' }, { idle: false }],
  ['busy', { turnState: 'running' }, { composerVerified: true, named: true, idle: false }],
  ['busy', { childActivity: true }, { idle: false }],
  ['busy', { pendingInput: 'submit' }, { idle: false }],
  ['unknown-turn', { turnState: 'unknown', turnId: 't' }, { composerVerified: true, idle: false, untouched: false }],
  ['unknown-turn', { turnState: 'unknown' }, { composerVerified: true, idle: false, untouched: true }],
  ['unnamed', { observation: 'provisional', turnId: 'earlier' }, { composerVerified: true, named: false, idle: true, free: false }],
  ['input-owned', { interactionInputPending: true }, { composerVerified: true, named: true, idle: false }],
  ['input-owned', { manualInputPending: true }, { named: true, idle: false }],
  ['input-owned', { heldMouseButton: 'left' }, { idle: false }],
]) test(`a pane reports ${reason} for ${JSON.stringify(patch)}`, () => {
  const readiness = paneReadiness(pane(patch));
  assert.equal(readiness.reason, reason);
  for (const [fact, value] of Object.entries(facts)) assert.equal(readiness[fact], value, fact);
});

test('a shell has no turn to be busy about, and a structured chat pane has no composer to verify', () => {
  const shell = { ...pane(), kind: 'terminal', provider: 'terminal', pid: 7, agentPid: undefined,
    agentProcessState: undefined, observation: undefined, turnState: undefined };
  assert.equal(paneForm(shell), 'shell');
  assert.deepEqual(paneReadiness(shell), { form: 'shell', process: true, composerVerified: true, named: true, idle: true, untouched: true, free: true, reason: 'ready' });
  assert.equal(sessionReady(shell), true);
  assert.equal(isIdleTarget(shell), false, 'a plain shell is never offered as an idle agent target');
  const chat = { ...pane(), kind: 'openfusion', provider: 'openfusion', engineReady: true, agentPid: undefined, observation: undefined };
  assert.equal(paneForm(chat), 'structured');
  assert.equal(paneReadiness(chat).composerVerified, true);
  assert.equal(sessionReady(chat), true);
  assert.equal(sessionReady({ ...chat, engineReady: false }), false);
});

// A freshly launched pane cannot name its conversation until its provider writes
// a transcript, which for some providers only happens after the first prompt.
// Requiring that here is what made every never-prompted pane unusable.
test('a never-prompted provisional pane is verified and reusable; one that has taken a turn is not', () => {
  const fresh = pane({ observation: 'provisional', agentPid: undefined });
  assert.equal(paneReadiness(fresh).reason, 'ready');
  assert.equal(idlePaneCandidate(fresh), true);
  assert.equal(sessionReady(fresh), true);
  const used = pane({ observation: 'provisional', turnId: 'earlier-turn' });
  assert.equal(paneReadiness(used).reason, 'unnamed');
  assert.equal(idlePaneCandidate(used), false);
  assert.equal(isIdleTarget(used), false);
});

// Selection is conservative about a human draft; writing is not. The pane is
// passed over when another is available, and the decoded composer — not this
// predicate — decides whether the Orchestrator may type into it.
test('a keystroke latch takes a pane out of selection without touching the write fence', () => {
  const latched = pane({ manualInputPending: true });
  assert.equal(paneReadiness(latched).reason, 'input-owned');
  assert.equal(isIdleTarget(latched), false);
  assert.equal(idlePaneCandidate(latched), false);
  // The busy-prompt health check asks only for an identified recipient with
  // nothing waiting on a human, so the latch is not its business either.
  assert.equal(paneReadiness(latched).composerVerified, true);
});

test('a busy Codex root is healthy for a followup while a waiting one is not', () => {
  const action = { target: { id: 'p', generation: 'g' }, operator: true, promptSubmission: true, submit: true, text: 'Also check the tests' };
  const busy = pane({ status: 'running', turnState: 'running', turnId: 'active', childActivity: false });
  assert.equal(paneReadiness(busy).reason, 'busy');
  assert.equal(isObservedBusyPrompt(action, busy), true);
  for (const patch of [{ turnState: 'waiting' }, { pendingInteraction: true }, { attention: { reason: 'question' } },
    { binding: { status: 'ambiguous' } }, { agentProcessState: 'exited' }])
    assert.equal(isObservedBusyPrompt(action, { ...busy, ...patch }), false, JSON.stringify(patch));
});

test('delivery classification is the same ladder, in its own vocabulary', async () => {
  const { createOrchestratorDelivery } = require('../../backend/orchestratorDelivery.cjs');
  const states = [];
  for (const [patch, expected] of [[{}, 'written'], [{ turnState: 'running' }, null], [{ pendingInteraction: true }, 'blocked'],
    [{ turnState: 'unknown' }, 'blocked'], [{ processState: 'exited' }, 'not-running'], [{ observation: 'provisional', turnId: 't' }, 'written']]) {
    const session = pane({ lastActivityAt: 1, ...patch });
    const writes = [];
    const delivery = createOrchestratorDelivery({ getSession: () => session, now: () => 100000,
      write: async payload => { writes.push(payload); return { ok: true, status: 'written', delivery: 'pty-transport-only' }; },
      stage: async () => ({ ok: true, status: 'staged' }) });
    const result = await delivery.submit({ actionId: 'a', target: { id: 'p', generation: 'g' }, text: 'hello' });
    states.push([JSON.stringify(patch), result.status]);
    if (expected === null) assert.equal(result.status, 'queued', JSON.stringify(patch));
    else assert.equal(result.status, expected, JSON.stringify(patch) + ' ' + JSON.stringify(result));
    delivery.dispose?.();
  }
  // An unnamed conversation never blocked delivery and still does not: delivery
  // needs a live recipient, not a conversation it can name.
  assert.ok(states.length === 6);
});

// A pane that has never taken a turn publishes its turn as unknown (measured on
// fresh Codex and Claude panes, 2026-09-14). It is not idle in the sense delivery
// and launch readiness rely on - they keep it on the screen-verified startup
// path - but it is exactly the "empty terminal" a person asks for, so choosing a
// pane for new work reads it as free. Before this, every never-prompted pane was
// refused as an idle target and the resolver opened another pane beside it.
test('a never-prompted pane with an unknown turn is untouched: free to choose, not yet idle to deliver into', () => {
  const fresh = pane({ status: 'unknown', turnState: 'unknown', binding: { status: 'pending' } });
  const facts = paneReadiness(fresh);
  assert.equal(facts.idle, false); assert.equal(facts.untouched, true); assert.equal(facts.reason, 'unknown-turn');
  assert.equal(isIdleTarget(fresh), true);
  assert.equal(idlePaneCandidate(fresh), true);
  assert.equal(sessionReady(fresh), false, 'launch readiness still waits for the composer');
  assert.equal(require('../../backend/orchestratorPaneReadiness.cjs').paneState(fresh), 'idle');
  const prompted = pane({ turnState: 'unknown', turnId: 't' });
  assert.equal(paneReadiness(prompted).untouched, false);
  assert.equal(isIdleTarget(prompted), false, 'a pane with a turn behind it and an unrecognized state is not free');
});

test('a display name drops the progress glyph and the Codex attention banner', () => {
  const { paneDisplayName } = require('../../backend/orchestratorPaneReadiness.cjs');
  assert.equal(paneDisplayName({ name: '⠼ vibeTerminal' }), 'vibeTerminal');
  assert.equal(paneDisplayName({ name: '[ ! ] Action Required | lina web app' }), 'lina web app');
  assert.equal(paneDisplayName({ name: '✳ Claude Code' }), 'Claude Code');
  assert.equal(paneDisplayName({ conversationTitle: 'Fix the full screen bug', name: 'vibeTerminal' }), 'Fix the full screen bug');
});
