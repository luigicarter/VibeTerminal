'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTerminalInput } = require('../../backend/orchestratorTerminalInput.cjs');
const { waitForRoutingReady } = require('../../backend/orchestratorLaunchers.cjs');
const tick = () => new Promise(setImmediate);
function fixture(t, options = {}) {
  const session = { id: 'p', generation: 'g', launchToken: 1, started: true, provider: 'codex', kind: 'codex',
    processState: 'running', launchState: 'ready', agentProcessState: 'running', agentPid: 42,
    observation: 'observed', turnState: 'unknown', revision: 1, cwd: 'C:/project' };
  const observation = { ok: true, id: 'p', generation: 'g', sequence: 0, inputRevision: 0, cols: 80, rows: 24,
    text: '', cursor: { x: 0, y: 0 }, cursorVisible: true };
  const f = { session, observation, writes: [], reads: 0, sessionPresent: true };
  f.ready = () => Object.assign(observation, { sequence: observation.sequence + 1, text: 'OpenAI Codex\nmodel: gpt-5.6\n› ', cursor: { x: 2, y: 2 } });
  f.action = (extra = {}) => ({ target: { id: 'p', generation: 'g' }, actionId: 'first', requestId: 'r', operator: true,
    promptSubmission: true, text: 'Implement the feature', submit: true, observationSequence: 0, inputRevision: 0, ...extra });
  f.input = createTerminalInput({ getSession: () => f.sessionPresent ? session : undefined,
    readSession: async () => { f.reads++; return { ...observation }; },
    write: async action => { f.writes.push(action); return { ok: true, status: 'written' }; },
    startupTimeoutMs: 1000, startupPollMs: 1, ...options });
  if (options.trackStartup !== false) f.input.trackStartup({ id: 'p', generation: 'g', launchToken: 1 });
  t.after(() => f.input.dispose());
  f.waitForReads = async count => { for (let i = 0; i < 1000 && f.reads < count; i++) await tick(); assert.ok(f.reads >= count); };
  return f;
}

test('process-ready creation observes blank, shell and loading screens without input, then submits exactly once', async t => {
  const f = fixture(t);
  const receipt = await waitForRoutingReady({ result: { ok: true, id: 'p', launchToken: 1 }, getSession: () => f.session });
  assert.equal(receipt.readiness, 'process-ready', 'creation still permits inspecting onboarding');
  const action = f.action({ target: receipt.target });
  const pending = f.input.handle(action), duplicate = f.input.handle(action);
  await f.waitForReads(1); assert.equal(f.writes.length, 0);
  Object.assign(f.observation, { sequence: 1, text: 'PS C:\\project> codex', cursor: { x: 20, y: 0 } });
  await f.waitForReads(f.reads + 1); assert.equal(f.writes.length, 0);
  Object.assign(f.observation, { sequence: 2, text: 'OpenAI Codex\nmodel: loading\n› ', cursor: { x: 2, y: 2 } });
  await f.waitForReads(f.reads + 1); assert.equal(f.writes.length, 0);
  f.ready();
  const result = await pending;
  assert.equal(result.status, 'written'); assert.deepEqual(await duplicate, result); assert.deepEqual(await f.input.handle(action), result);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].text, action.text);
  assert.equal(f.writes[0].actionId, 'first'); assert.equal(f.writes[0].requestId, 'r');
  assert.equal(f.writes[0].interactionEvidence.sequence, 3); assert.equal(f.writes[0].interactionEvidence.inputRevision, 0);
});

test('task text staging waits but native menu controls remain available during startup', async t => {
  const f = fixture(t);
  assert.equal((await f.input.handle(f.action({ actionId: 'menu', promptSubmission: false, text: undefined, keys: ['down'], submit: false }))).ok, true);
  f.writes.length = 0;
  const pending = f.input.handle(f.action({ promptSubmission: false, inputPurpose: 'task', submit: false }));
  await f.waitForReads(2); assert.equal(f.writes.length, 0); f.ready();
  const result = await pending; assert.equal(result.ok, true); assert.equal(result.deliveryBaseline, undefined);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].submit, false);
});

for (const change of ['cancel', 'dispose', 'close', 'restart', 'launch-token', 'pid', 'conversation', 'manual-input', 'occupied', 'turn-start', 'exited']) {
  test(`startup ${change} never writes or replays the pending task`, async t => {
    const abort = new AbortController(), f = fixture(t);
    f.session.conversationId = 'original';
    const action = f.action({ signal: abort.signal }), pending = f.input.handle(action);
    await f.waitForReads(1);
    switch (change) {
      case 'cancel': abort.abort(); break;
      case 'dispose': f.input.dispose(); break;
      case 'close': f.sessionPresent = false; break;
      case 'restart': f.session.generation = 'replacement'; break;
      case 'launch-token': f.session.launchToken++; break;
      case 'pid': f.session.agentPid++; break;
      case 'conversation': f.session.conversationId = 'replacement'; break;
      case 'manual-input': f.observation.inputRevision++; break;
      case 'occupied': f.observation.manualInputPending = true; break;
      case 'turn-start': f.session.turnId = 'human-turn'; break;
      case 'exited': f.session.agentProcessState = 'exited'; break;
    }
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.delivery, 'not-dispatched'); assert.equal(f.writes.length, 0);
    f.ready(); await f.input.handle(action); assert.equal(f.writes.length, 0);
  });
}

test('startup timeout and cancellation settle independently of a hung decoded-screen read', async t => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const f = fixture(t, { startupTimeoutMs: 15, readSession: () => new Promise(() => {}) });
    const pending = f.input.handle(f.action({ signal: controller.signal })); await tick();
    if (cancel) controller.abort();
    const result = await pending;
    assert.equal(result.status, cancel ? 'cancelled' : 'launch-timeout'); assert.equal(result.delivery, 'not-dispatched'); assert.equal(f.writes.length, 0);
  }
});

test('unknown transport result is not retried when readiness remains visible', async t => {
  const f = fixture(t, { write: async action => { f.writes.push(action); return { ok: false, status: 'unknown' }; } });
  f.ready(); const action = f.action();
  assert.equal((await f.input.handle(action)).status, 'unknown');
  assert.equal((await f.input.handle(action)).status, 'unknown'); assert.equal(f.writes.length, 1);
});

test('first discovered PID and native identity are adopted once then frozen during startup', async t => {
  const f = fixture(t); f.session.agentPid = undefined; f.session.agentProcessState = 'starting';
  const pending = f.input.handle(f.action()); await f.waitForReads(1);
  f.session.agentPid = 42; f.session.agentProcessState = 'running'; f.session.conversationId = 'discovered';
  await f.waitForReads(f.reads + 1); f.ready();
  assert.equal((await pending).ok, true); assert.equal(f.writes[0].expectedAgentPid, 42);
});

test('accepted shell startup survives later custom prompt but never a replacement PID', async t => {
  const f = fixture(t); Object.assign(f.session, { kind: 'terminal', provider: 'terminal', pid: 42, agentPid: undefined });
  Object.assign(f.observation, { sequence: 1, text: 'PS C:\\project>', cursor: { x: 14, y: 0 } });
  assert.equal((await f.input.handle(f.action())).ok, true);
  f.observation.text = 'custom shell'; f.observation.sequence++;
  assert.equal((await f.input.handle(f.action({ actionId: 'next', observationSequence: 2 }))).ok, true);
  f.session.pid = 43;
  const last = f.input.handle(f.action({ actionId: 'replacement', observationSequence: 2 }));
  assert.equal((await last).status, 'recipient-unavailable'); assert.equal(f.writes.length, 2);
});

test('startup evidence refresh cannot replace an originally authorized recipient or launch', async t => {
  const { projectInputAuthority } = require('../../backend/orchestratorInputAuthority.cjs');
  for (const mode of ['authority', 'launch-token']) {
    const f = fixture(t); f.ready();
    const action = f.action({ inputAuthority: projectInputAuthority(f.session), target: { id: 'p', generation: 'g', launchToken: 1 } });
    if (mode === 'authority') f.session.agentPid = 43;
    else { delete action.inputAuthority; f.session.launchToken = 2; }
    const result = await f.input.handle(action);
    assert.equal(result.ok, false); assert.equal(result.delivery, 'not-dispatched'); assert.equal(f.writes.length, 0);
  }
});

test('startup recipient is rechecked after prewrite attribution without sending a byte', async t => {
  const f = fixture(t, { onBeforeWrite: () => { f.session.agentPid = 43; } }); f.ready();
  const result = await f.input.handle(f.action());
  assert.equal(result.status, 'recipient-unavailable'); assert.equal(result.delivery, 'not-dispatched'); assert.equal(f.writes.length, 0);
});

test('observed readiness alone never marks startup accepted after a definite write rejection', async t => {
  const f = fixture(t, { write: async () => ({ ok: false, status: 'input-buffer-occupied', delivery: 'not-dispatched' }) }); f.ready();
  assert.equal((await f.input.handle(f.action())).ok, false);
  assert.equal(f.input.needsStartupReadiness(f.session), true);
});

for (const provider of ['codex', 'claude', 'terminal', 'grok', 'gemini']) test(`existing ${provider} session without turn telemetry keeps semantic operator input`, async t => {
  const f = fixture(t, { trackStartup: false });
  Object.assign(f.session, { kind: provider, provider, pid: 42 });
  assert.equal(f.input.needsStartupReadiness(f.session), false);
  const result = await f.input.handle(f.action());
  assert.equal(result.ok, true); assert.equal(f.writes.length, 1);
});

for (const provider of ['grok', 'gemini', 'cursor', 'opencode']) test(`new unsupported ${provider} launch retains prior semantic operator contract`, async t => {
  const f = fixture(t); Object.assign(f.session, { kind: provider, provider });
  assert.equal(f.input.needsStartupReadiness(f.session), false);
  assert.equal((await f.input.handle(f.action())).ok, true); assert.equal(f.writes.length, 1);
});

for (const submit of [false, true]) test(`authorized editInput ${submit ? 'submission' : 'staging'} keeps an existing manual draft accessible`, async t => {
  const f = fixture(t); f.session.manualInputPending = true;
  Object.assign(f.observation, { manualInputPending: true, inputRevision: 1, text: 'Existing user draft' });
  const action = f.action({ editInput: true, inputRevision: 1, inputPurpose: 'task', submit,
    promptSubmission: submit, text: submit ? undefined : 'Edit the existing draft' });
  assert.equal((await f.input.handle(action)).ok, true);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].editInput, true);
  assert.equal(f.writes[0].interactionEvidence.inputRevision, 1);
});

test('ready startup uses its bounded observation without a second possibly hung read', async t => {
  let reads = 0;
  const f = fixture(t, { readSession: async () => ++reads === 1 ? { ...f.observation } : new Promise(() => {}) });
  f.ready();
  const result = await f.input.handle(f.action());
  assert.equal(result.ok, true); assert.equal(reads, 1); assert.equal(f.writes.length, 1);
});

test('cancellation of the bounded startup read releases the pane lock for a later control', async t => {
  let first = true;
  const f = fixture(t, { readSession: async () => { if (first) { first = false; return new Promise(() => {}); } return { ...f.observation }; } });
  const controller = new AbortController();
  const pending = f.input.handle(f.action({ signal: controller.signal })); await tick(); controller.abort();
  assert.equal((await pending).status, 'cancelled');
  const control = f.action({ actionId: 'menu', promptSubmission: false, text: undefined, submit: false, keys: ['down'] });
  assert.equal((await f.input.handle(control)).ok, true); assert.equal(f.writes.length, 1);
});
