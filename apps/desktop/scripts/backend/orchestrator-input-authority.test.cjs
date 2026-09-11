'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectInputAuthority, sameInputAuthority } = require('../../backend/orchestratorInputAuthority.cjs');
const { createOperatorObservations } = require('../../backend/orchestratorOperator.cjs');
const { createTerminalInput } = require('../../backend/orchestratorTerminalInput.cjs');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');

function session() {
  return { id: 'p', generation: 'g', launchToken: 1, kind: 'codex', provider: 'codex',
    agentPid: 42, started: true, status: 'waiting', lifecycle: 'live', launchState: 'ready',
    processState: 'running', agentProcessState: 'running', turnId: 't', turnStartedAt: 10, turnState: 'waiting',
    pendingInput: undefined, childActivity: false, binding: { status: 'found', message: 'Bound' },
    conversation: { provider: 'codex', id: 'thread', title: 'Old title', updatedAt: 10 },
    observation: 'observed', telemetryHealth: 'available', cols: 100, rows: 28,
    attention: { id: 'old-id', state: 'waiting', reason: 'question', updatedAt: 10 },
    pendingInteractions: [{ id: 'q', sessionId: 'p', generation: 'g', revision: 1, kind: 'question', state: 'pending',
      questions: [{ id: 'database', question: 'Which database?', options: [{ label: 'SQLite', description: 'Local' }] }], updatedAt: 10 }],
    revision: 1, updatedAt: 10 };
}
const screen = { ok: true, id: 'p', generation: 'g', sequence: 7, inputRevision: 0, cols: 100, rows: 28 };
const control = { kind: 'terminal_interact', observationSequence: 7, inputRevision: 0, keys: ['down'] };
function churn(s) {
  s.revision += 20; s.updatedAt = 30; s.lastActivityAt = 30; s.lastOutputAt = 30;
  s.terminalTitle = 'New terminal'; s.name = 'New title'; s.conversation.title = 'Generated title'; s.conversation.updatedAt = 30;
  s.binding.message = 'Metadata refreshed'; s.attention.id = 'repeat-question'; s.attention.updatedAt = 30;
  s.lastTool = { id: 'tool', name: 'New tool label', startedAt: 30 }; s.activeTools = [{ id: 'tool', name: 'New label' }];
  s.pendingInteractions[0].updatedAt = 30;
}

test('frozen input authority ignores publication/title/tool/attention timestamp churn', async () => {
  const current = session(), observations = createOperatorObservations();
  const token = observations.observe(current, screen, current.pendingInteractions);
  const initial = projectInputAuthority(current);
  assert(Object.isFrozen(initial)); assert(Object.isFrozen(initial.pendingInteractions[0].questions[0]));
  churn(current);
  assert(sameInputAuthority(initial, projectInputAuthority(current)));
  assert(observations.authorize(token, current, control, current.pendingInteractions));
  const writes = [];
  const input = createTerminalInput({ getSession: () => current,
    readSession: async () => { churn(current); return screen; }, write: async payload => { writes.push(payload); return { ok: true, status: 'written' }; } });
  const result = await input.handle({ ...control, target: { id: 'p', generation: 'g' }, actionId: 'churn', operator: true, requestId: 'owner', inputAuthority: initial });
  assert.equal(result.status, 'written'); assert.equal(writes.length, 1);
  assert.equal(writes[0].interactionEvidence.cols, 100); assert.equal(writes[0].interactionEvidence.rows, 28);
});

const changes = {
  identity: s => { s.id = 'other'; }, generation: s => { s.generation = 'new'; }, token: s => { s.launchToken++; },
  kind: s => { s.kind = 'claude'; }, provider: s => { s.provider = 'claude'; }, root: s => { s.agentPid++; },
  stopped: s => { s.started = false; }, lifecycle: s => { s.lifecycle = 'closed'; }, paused: s => { s.status = 'paused'; },
  launch: s => { s.launchState = 'pending'; }, process: s => { s.processState = 'exited'; }, agent: s => { s.agentProcessState = 'unknown'; },
  turn: s => { s.turnId = 'new'; }, turnStart: s => { s.turnStartedAt++; }, turnState: s => { s.turnState = 'running'; },
  pendingInput: s => { s.pendingInput = 'submit'; }, children: s => { s.childActivity = true; },
  binding: s => { s.binding.status = 'ambiguous'; }, conversation: s => { s.conversation.id = 'other'; }, conversationProvider: s => { s.conversation.provider = 'claude'; },
  observation: s => { s.observation = 'provisional'; }, telemetry: s => { s.telemetryHealth = 'unavailable'; },
  attentionState: s => { s.attention.state = 'completed'; }, attentionReason: s => { s.attention.reason = 'approval'; },
  requestAdded: s => { s.pendingInteractions.push({ id: 'new', revision: 1, kind: 'permission', state: 'pending', detail: 'Run command?' }); },
  requestRemoved: s => { s.pendingInteractions = []; }, requestId: s => { s.pendingInteractions[0].id = 'other'; },
  requestRevision: s => { s.pendingInteractions[0].revision++; }, requestKind: s => { s.pendingInteractions[0].kind = 'permission'; },
  requestState: s => { s.pendingInteractions[0].state = 'resolved'; }, requestQuestion: s => { s.pendingInteractions[0].questions[0].question = 'Delete database?'; },
  requestOption: s => { s.pendingInteractions[0].questions[0].options[0].label = 'PostgreSQL'; },
  manualDraft: s => { s.manualInputPending = true; }, requestDraft: s => { s.interactionInputPending = true; },
  draftOwner: s => { s.ownerRequestId = 'another-request'; }, mouseOwner: s => { s.heldMouseButton = 'left'; },
  columns: s => { s.cols++; }, rows: s => { s.rows++; }
};
for (const [name, mutate] of Object.entries(changes)) test(`${name} change rejects original token and in-flight native input despite identical screen`, async () => {
  const current = session(), observations = createOperatorObservations();
  const token = observations.observe(current, screen, current.pendingInteractions);
  mutate(current);
  assert.throws(() => observations.authorize(token, current, control, current.pendingInteractions), /terminal changed|missing, used, or stale/);
  const live = session(), writes = [];
  const input = createTerminalInput({ getSession: () => live, readSession: async () => { mutate(live); return screen; },
    write: async payload => { writes.push(payload); return { ok: true }; } });
  const result = await input.handle({ ...control, target: { id: 'p', generation: 'g' }, actionId: name, operator: true, requestId: 'owner' });
  assert.equal(result.ok, false, name); assert.equal(result.delivery, 'not-dispatched'); assert.equal(writes.length, 0);
});

test('trusted observation authority fences mutation before the adapter begins', async () => {
  const live = session(), inputAuthority = projectInputAuthority(live); live.pendingInteractions[0].questions[0].question = 'Different approval';
  let reads = 0, writes = 0;
  const input = createTerminalInput({ getSession: () => live, readSession: async () => { reads++; return screen; }, write: async () => { writes++; } });
  assert.equal((await input.handle({ ...control, target: { id: 'p', generation: 'g' }, actionId: 'changed-before', inputAuthority })).status, 'stale-observation');
  assert.equal(reads, 0); assert.equal(writes, 0);
});

test('shell authority uses its terminal root while chat controls retain broad revision boundary', () => {
  const shell = { ...session(), kind: 'terminal', provider: 'terminal', terminalPid: 90 };
  const initial = projectInputAuthority(shell); shell.agentPid = 99;
  assert(sameInputAuthority(initial, projectInputAuthority(shell))); shell.terminalPid = 91;
  assert(!sameInputAuthority(initial, projectInputAuthority(shell)));
  for (const kind of ['fusion', 'openfusion']) {
    const target = { ...session(), kind }, observations = createOperatorObservations();
    const token = observations.observe(target, screen); target.revision++;
    assert.throws(() => observations.authorize(token, target, control), /terminal changed/);
  }
});

test('a newly pending app question cannot use the busy prompt exception', () => {
  const target = { ...session(), pendingInteractions: [], attention: undefined, turnState: 'running', status: 'running' };
  const observations = createOperatorObservations(), token = observations.observe(target, screen);
  assert.throws(() => observations.authorize(token, target, { kind: 'send_prompt', target: { id: 'p', generation: 'g' }, text: 'Continue' },
    [{ id: 'new-question', sessionId: 'p', generation: 'g', revision: 1, state: 'pending', kind: 'question', questions: [{ question: 'Continue?' }] }]), /terminal changed/);
});

test('runtime retains admitted created/snapshot/resize geometry and rejects stale geometry events', () => {
  const runtime = createTerminalRuntime();
  const launch = runtime.beginLaunch({ id: 'p', provider: 'terminal', launchToken: 1 });
  const event = patch => runtime.ingest({ id: 'p', generation: launch.generation, ...patch });
  event({ type: 'created', cols: 100, rows: 28 });
  assert.equal(runtime.getSnapshot('p').cols, 100);
  event({ type: 'resize', cols: 120, rows: 30 });
  assert.equal(runtime.getSnapshot('p').cols, 120); assert.equal(runtime.getSnapshot('p').rows, 30);
  event({ type: 'resize', cols: 200, rows: 50, generation: 'old' });
  event({ type: 'resize', cols: -1, rows: NaN });
  assert.equal(runtime.getSnapshot('p').cols, 120); assert.equal(runtime.getSnapshot('p').rows, 30);
  event({ type: 'snapshot', isRunning: true, cols: 90, rows: 20 });
  assert.equal(runtime.getSnapshot('p').cols, 90); assert.equal(runtime.getSnapshot('p').rows, 20);
});
