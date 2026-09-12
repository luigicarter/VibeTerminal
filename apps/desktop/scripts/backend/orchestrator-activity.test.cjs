'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { interpretTestIntent } = require('./orchestrator-test-intent.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const reply = text => ({ choices: [{ message: { content: text } }] });
const tools = (...actions) => ({ choices: [{ message: { tool_calls: actions.map((args, i) => ({ id: `call-${i}`, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(args) } })) } }] });
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-activity-'));
  const f = { sessions: ['a', 'b', 'idle'].map(id => ({ id, generation: `g-${id}`, name: `Worker ${id.toUpperCase()}`, kind: 'codex', cwd: root, status: 'busy' })), responses: [], changes: [] };
  const relay = createOrchestrator({ interpretIntent: interpretTestIntent, userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => f.sessions, getRoots: () => ({ documents: root, projects: [{ name: "Fixture", path: root }] }),
    onChange: state => f.changes.push(state.activeTargets),
    onSpeak: value => f.speak?.(value),
    readSession: args => f.read?.(args) || { text: 'Observed output.' },
    dispatchAction: args => f.effect?.(args) || { ok: true },
    fetch: async url => ({ ok: true, json: async () => {
      if (url.endsWith('/key')) return { data: {} };
      if (url.endsWith('/models')) return { data: [{ id: 'brain', context_length: 128000, supported_parameters: ['tools'] }] };
      const response = f.responses.shift(); return typeof response === 'function' ? response() : response || reply('Done.');
    } }) });
  t.after(async () => { await relay.dispose(); assert(path.resolve(root).startsWith(path.join(os.tmpdir(), 'vibe-activity-'))); fs.rmSync(root, { recursive: true, force: true }); });
  await relay.configure({ apiKey: 'test-key', sessionOnly: true, model: 'brain' });
  assert.equal((await relay.setEnabled(true)).ok, true);
  f.relay = relay; f.active = () => relay.getState().activeTargets;
  return f;
}

test('two touched targets remain during model and speech, with no busy idle-agent inference', async t => {
  const f = await fixture(t), model = deferred(), atModel = deferred(), speech = deferred(), atSpeech = deferred();
  f.responses.push(tools({ kind: 'list_sessions' }), tools({ kind: 'read_session', targetId: 'a' }, { kind: 'read_session', targetId: 'b' }), () => { atModel.resolve(); return model.promise; });
  f.speak = () => { atSpeech.resolve(); return speech.promise; };
  assert.deepEqual(f.active(), []);
  const run = f.relay.send({ text: 'Read Worker A and Worker B', origin: 'voice' });
  await atModel.promise;
  const expected = ['a', 'b'].map(id => ({ id, generation: `g-${id}`, operations: ['read_session'] }));
  assert.deepEqual(f.active(), expected);
  model.resolve(reply('Both checked.')); await atSpeech.promise;
  assert.deepEqual(f.active(), expected);
  speech.resolve({ ok: true }); assert.equal((await run).ok, true);
  assert.deepEqual(f.active(), []);
});

test('directory, rejected model effects and forged direct generations never mark targets', async t => {
  const f = await fixture(t);
  f.responses.push(tools({ kind: 'list_sessions' }, { kind: 'close', targetId: 'a' }), reply('Rejected.'));
  await f.relay.send({ text: 'Hello', origin: 'text' });
  assert.equal((await f.relay.dispatch({ kind: 'send_prompt', targetId: 'a', generation: 'forged', text: 'hello' })).ok, false);
  assert.equal((await f.relay.dispatch({ kind: 'read_session', targetId: 'a', generation: 'forged' })).ok, false);
  assert.equal((await f.relay.dispatch({ kind: 'send_prompt', targetId: 'missing', text: 'hello' })).ok, false);
  assert(f.changes.every(targets => targets.length === 0));
});

test('overlapping direct effects aggregate and completing one preserves the other', async t => {
  const f = await fixture(t), gates = { a: deferred(), b: deferred() }, entered = { a: deferred(), b: deferred() };
  f.effect = action => { assert(f.active().some(s => s.id === action.targetId)); entered[action.targetId].resolve(); return gates[action.targetId].promise; };
  const a = f.relay.dispatch({ kind: 'send_prompt', targetId: 'a', text: 'A' }); await entered.a.promise;
  const b = f.relay.dispatch({ kind: 'send_prompt', targetId: 'b', text: 'B' }); await entered.b.promise;
  assert.deepEqual(f.active().map(s => s.id), ['a', 'b']);
  gates.a.resolve({ ok: true }); await a;
  assert.deepEqual(f.active(), [{ id: 'b', generation: 'g-b', operations: ['send_prompt'] }]);
  gates.b.resolve({ ok: true }); await b; assert.deepEqual(f.active(), []);
});

test('refresh prunes changed generations and deletion without reviving removed identities', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  f.responses.push(tools({ kind: 'read_session', targetId: 'a' }, { kind: 'read_session', targetId: 'b' }), () => { entered.resolve(); return gate.promise; });
  const run = f.relay.send({ text: 'Read both sessions', origin: 'text' }); await entered.promise;
  f.sessions[0].generation = 'new-a'; f.sessions = f.sessions.filter(s => s.id !== 'b'); await f.relay.refresh();
  assert.deepEqual(f.active(), []);
  f.sessions[0].generation = 'g-a'; await f.relay.refresh(); assert.deepEqual(f.active(), []);
  gate.resolve(reply('Done.')); await run;
});

test('cancel clears immediately and late request finalization preserves newer request scope', async t => {
  const f = await fixture(t), oldGate = deferred(), oldEntered = deferred(), newGate = deferred(), newEntered = deferred();
  f.responses.push(tools({ kind: 'read_session', targetId: 'a' }), () => { oldEntered.resolve(); return oldGate.promise; });
  const oldRun = f.relay.send({ text: 'Read Worker A', origin: 'text' }); await oldEntered.promise;
  await f.relay.cancel(); assert.deepEqual(f.active(), []);
  f.responses.push(tools({ kind: 'read_session', targetId: 'b' }), () => { newEntered.resolve(); return newGate.promise; });
  const newRun = f.relay.send({ text: 'Read Worker B', origin: 'text' }); await newEntered.promise;
  oldGate.resolve(reply('Old.')); assert.equal((await oldRun).status, 'cancelled');
  assert.deepEqual(f.active().map(s => s.id), ['b']);
  newGate.resolve(reply('New.')); await newRun; assert.deepEqual(f.active(), []);
});

test('direct read marks during read, errors clear, and dispose removes pending scopes', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  f.read = () => { assert.deepEqual(f.active().map(s => s.id), ['a']); entered.resolve(); return gate.promise; };
  const run = f.relay.dispatch({ kind: 'read_session', targetId: 'a' }); await entered.promise;
  f.relay.dispose(); assert.deepEqual(f.active(), []); gate.resolve({ text: 'Late' }); await run;
  const g = await fixture(t);
  g.effect = () => { assert.deepEqual(g.active().map(s => s.id), ['a']); throw Error('Adapter failed'); };
  assert.equal((await g.relay.dispatch({ kind: 'focus_session', targetId: 'a' })).ok, false);
  assert.deepEqual(g.active(), []);
});

test('same-target direct scopes combine operations, then cancel isolates late acknowledgments', async t => {
  const f = await fixture(t), read = deferred(), readEntered = deferred(), send = deferred(), sendEntered = deferred();
  f.read = () => { readEntered.resolve(); return read.promise; };
  f.effect = () => { sendEntered.resolve(); return send.promise; };
  const reading = f.relay.dispatch({ kind: 'read_session', targetId: 'a' }); await readEntered.promise;
  const sending = f.relay.dispatch({ kind: 'send_prompt', targetId: 'a', text: 'A' }); await sendEntered.promise;
  assert.deepEqual(f.active()[0].operations, ['read_session', 'send_prompt']);
  read.resolve({ text: 'A' }); await reading; assert.deepEqual(f.active()[0].operations, ['send_prompt']);
  await f.relay.cancel(); assert.deepEqual(f.active(), []);
  send.resolve({ ok: true }); await sending; assert.deepEqual(f.active(), []);
});

test('created target requires acknowledged current native generation and survives through reply', async t => {
  for (const native of [false, true]) {
    const f = await fixture(t), gate = deferred(), entered = deferred();
    f.effect = () => {
      f.sessions.push({ id: 'new', generation: native ? 'native-new' : 'paused:new:2', launchToken: 2 });
      return { ok: true, id: 'new', launchToken: 2, ...(native && { target: { id: 'new', generation: 'native-new', launchToken: 2 } }) };
    };
    f.responses.push(tools({ kind: 'create_session', kindOfSession: 'codex' }), () => { entered.resolve(); return gate.promise; });
    const run = f.relay.send({ text: 'Create Codex in Fixture', origin: 'text' }); await entered.promise;
    assert.deepEqual(f.active(), native ? [{ id: 'new', generation: 'native-new', operations: ['create_session'] }] : []);
    gate.resolve(reply('Created.')); await run; assert.deepEqual(f.active(), []);
  }
});

test('direct action remains active across a newer greeting and aggregates with a later relay target', async t => {
  const f = await fixture(t), acknowledgment = deferred(), dispatched = deferred(), model = deferred(), atModel = deferred();
  f.effect = () => { dispatched.resolve(); return acknowledgment.promise; };
  const direct = f.relay.dispatch({ kind: 'send_prompt', targetId: 'a', text: 'Continue A' }); await dispatched.promise;
  f.responses.push(reply('Hello.'));
  assert.equal((await f.relay.send({ text: 'Hello', origin: 'text' })).ok, true);
  assert.deepEqual(f.active(), [{ id: 'a', generation: 'g-a', operations: ['send_prompt'] }]);
  f.responses.push(tools({ kind: 'read_session', targetId: 'b' }), () => { atModel.resolve(); return model.promise; });
  const relay = f.relay.send({ text: 'Read Worker B', origin: 'text' }); await atModel.promise;
  assert.deepEqual(f.active().map(s => s.id), ['a', 'b']);
  acknowledgment.resolve({ ok: true }); assert.equal((await direct).ok, true);
  assert.deepEqual(f.active(), [{ id: 'b', generation: 'g-b', operations: ['read_session'] }]);
  model.resolve(reply('Read B.')); await relay; assert.deepEqual(f.active(), []);
});
