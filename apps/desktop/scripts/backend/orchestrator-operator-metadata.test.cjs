'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOperatorObservations } = require('../../backend/orchestratorOperator.cjs');

function fixture() {
  let at = 100;
  const observations = createOperatorObservations({ now: () => at });
  const target = { id: 'pane', generation: 'original', launchToken: 1, kind: 'codex', revision: 1, turnId: 'turn' };
  const screen = { ok: true, id: target.id, generation: target.generation, sequence: 10, inputRevision: 2 };
  const read = (modelRound, selected = target, data = screen) => {
    const readId = observations.beginRead(selected, modelRound);
    return observations.observe(selected, data, [], { modelRound, readId });
  };
  return { observations, target, screen, read, advance: delta => { at += delta; } };
}

test('implicit evidence requires a read returned in an earlier model round', () => {
  const f = fixture(), token = f.read(2);
  assert.equal(f.observations.latest(f.target, 2), undefined, 'A batched read and action cannot use unseen output');
  assert.equal(f.observations.latest(f.target, 1), undefined);
  assert.equal(f.observations.latest(f.target, 3), token);
  assert.ok(f.observations.authorize(token, f.target, { kind: 'terminal_interact' }));
});

test('failed, pending, paged or budget-suppressed read attempts invalidate implicit evidence immediately', () => {
  for (const result of [undefined, { ok: false }, { ok: true, exited: true }, { ok: true, generation: 'replacement' }]) {
    const f = fixture(); f.read(0);
    const readId = f.observations.beginRead(f.target, 1);
    assert.equal(f.observations.latest(f.target, 2), undefined);
    // Paged and budget-suppressed reads do not mint a live observation at all.
    if (result) f.observations.observe(f.target, result, [], { modelRound: 1, readId });
    assert.equal(f.observations.latest(f.target, 2), undefined);
  }
});

test('an obsolete asynchronous read cannot replace the latest completed read', () => {
  const f = fixture(), oldId = f.observations.beginRead(f.target, 0);
  const latestId = f.observations.beginRead(f.target, 1);
  const newest = f.observations.observe(f.target, f.screen, [], { modelRound: 1, readId: latestId });
  f.observations.observe(f.target, { ...f.screen, sequence: 9 }, [], { modelRound: 0, readId: oldId });
  assert.equal(f.observations.latest(f.target, 2), newest);
  f.observations.observe(f.target, { ok: false }, [], { modelRound: 0, readId: oldId });
  assert.equal(f.observations.latest(f.target, 2), newest);
});

test('consumed, expired or invalid latest evidence never falls back to an older unused token', () => {
  const f = fixture(); f.read(0);
  const latest = f.read(1);
  f.observations.consume(f.observations.authorize(latest, f.target, { kind: 'focus_session' }), f.target, { kind: 'focus_session' });
  assert.equal(f.observations.latest(f.target, 2), undefined);
  f.read(2); f.advance(30001);
  assert.equal(f.observations.latest(f.target, 3), undefined);
  f.read(3);
  const invalid = f.read(4, f.target, { ...f.screen, inputRevision: undefined });
  assert.equal(f.observations.latest(f.target, 5), invalid);
  assert.throws(() => f.observations.authorize(invalid, f.target, { kind: 'terminal_interact' }), /screen sequence and input revision/);
});

test('implicit selection never crosses a request, terminal or generation boundary', () => {
  const f = fixture(); f.read(0);
  assert.equal(f.observations.latest({ ...f.target, id: 'other' }, 1), undefined);
  assert.equal(f.observations.latest({ ...f.target, generation: 'replacement' }, 1), undefined);
  assert.equal(createOperatorObservations().latest(f.target, 1), undefined);
  assert.equal(f.observations.latest(f.target, undefined), undefined);
  assert.equal(f.observations.latest(f.target, NaN), undefined);
});

test('routing reads without an executor round cannot seed implicit operator evidence', () => {
  const f = fixture(); f.read(0);
  const readId = f.observations.beginRead(f.target, undefined);
  assert.equal(readId, undefined);
  const token = f.observations.observe(f.target, f.screen, [], { modelRound: undefined, readId });
  assert.equal(f.observations.latest(f.target, 1), undefined);
  assert.ok(f.observations.authorize(token, f.target, { kind: 'terminal_interact' }));
  const oldId = f.observations.beginRead(f.target, 1);
  assert.throws(() => f.observations.beginRead(f.target, -1), /execution round/);
  f.observations.observe(f.target, f.screen, [], { modelRound: 1, readId: oldId });
  assert.equal(f.observations.latest(f.target, 2), undefined);
});

test('selected implicit evidence still enforces live native input and chat revision authority', () => {
  const f = fixture(); f.read(0);
  const changed = { ...f.target, turnId: 'new-turn' };
  const token = f.observations.latest(changed, 1);
  assert.throws(() => f.observations.authorize(token, changed, { kind: 'terminal_interact' }), /terminal changed/);
  const chat = { ...f.target, kind: 'fusion' };
  const chatToken = f.read(1, chat);
  assert.throws(() => f.observations.authorize(chatToken, { ...chat, revision: 2 }, { kind: 'focus_session' }), /terminal changed/);
});

test('supplied native counters remain exact and omission never manufactures missing read evidence', () => {
  const f = fixture(), token = f.read(0);
  for (const field of ['observationSequence', 'inputRevision']) for (const value of [null, -1, 999, '2']) {
    assert.throws(() => f.observations.authorize(token, f.target, { kind: 'terminal_interact', [field]: value }), /screen sequence and input revision/);
  }
  const record = f.observations.authorize(token, f.target, { kind: 'terminal_interact' });
  assert.equal(record.sequence, 10); assert.equal(record.inputRevision, 2);
  assert.throws(() => f.observations.authorize(undefined, f.target, { kind: 'terminal_interact' }), /missing, used, or stale/);
});

test('bounded read history cannot revive an evicted implicit observation', () => {
  const f = fixture(); f.read(0);
  for (let index = 0; index < 128; index++) {
    const target = { ...f.target, id: `other-${index}` };
    f.read(0, target, { ...f.screen, id: target.id });
  }
  assert.equal(f.observations.latest(f.target, 1), undefined);
});

test('raw target invalidation clears all generations even without an inventory record', () => {
  const f = fixture(), original = f.read(0);
  const replacement = { ...f.target, generation: 'replacement' };
  f.read(0, replacement, { ...f.screen, generation: replacement.generation });
  const other = { ...f.target, id: 'other' }, otherToken = f.read(0, other, { ...f.screen, id: other.id });
  const inFlight = f.observations.beginRead(f.target, 1);
  f.observations.invalidate('pane');
  f.observations.observe(f.target, f.screen, [], { modelRound: 1, readId: inFlight });
  assert.equal(f.observations.latest(f.target, 2), undefined);
  assert.equal(f.observations.latest(replacement, 2), undefined);
  assert.equal(f.observations.latest(other, 2), otherToken);
  assert.ok(f.observations.authorize(original, f.target, { kind: 'terminal_interact' }), 'Explicit-token authorization remains unchanged');
});

test('missing or malformed read target conservatively clears implicit evidence only', () => {
  for (const id of [undefined, null, '', '   ', {}, 7]) {
    const f = fixture(), explicit = f.read(0);
    f.observations.invalidate(id);
    assert.equal(f.observations.latest(f.target, 1), undefined);
    assert.ok(f.observations.authorize(explicit, f.target, { kind: 'terminal_interact' }));
  }
});

test('failed read while absent from inventory cannot reuse old implicit evidence after reappearance', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createOrchestrator } = require('../../backend/orchestrator.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-absent-read-'));
  const pane = { id: 'pane', generation: 'same-generation', kind: 'codex', provider: 'codex', cwd: root, status: 'running' };
  let sessions = [pane], stage = 0, rejectedMissingRead = false, freshReadSupplied = false, reads = 0, readsBeforeSend = 0;
  const effects = [];
  const tool = action => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `call-${stage}`,
    type: 'function', function: { name: 'workspace', arguments: JSON.stringify(action) } }] } }] });
  const relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [{ name: 'Project', path: root }] }), getSessions: () => sessions,
    interpretIntent: async () => ({ goal: 'Review the project.', actions: [{ kind: 'operate_terminal', targetIds: ['pane'], text: 'Review the project.' }] }),
    readSession: async () => { reads++; return { ok: true, id: pane.id, generation: pane.generation, sequence: 10, inputRevision: 2, text: 'Ready for input' }; },
    dispatchAction: async action => { effects.push(action); return { ok: true, status: 'written' }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'scripted', context_length: 128000, supported_parameters: ['tools', 'tool_choice'] }] }));
      const body = JSON.parse(options.body), last = body.messages.filter(message => message.role === 'tool').at(-1);
      const observed = last && JSON.parse(last.content);
      let reply;
      switch (stage++) {
        case 0: reply = tool({ kind: 'read_session', targetId: 'pane' }); break;
        case 1: sessions = []; reply = tool({ kind: 'list_sessions' }); break;
        case 2: reply = tool({ kind: 'read_session', targetId: 'pane' }); break;
        case 3:
          rejectedMissingRead = observed?.ok === false && /Unknown target session/.test(observed.error);
          sessions = [pane]; readsBeforeSend = reads; reply = tool({ kind: 'send_prompt', targetId: 'pane', text: 'Review the project.' }); break;
        case 4:
          // The stale pre-disappearance evidence is still unusable. The write is
          // authorized only because the application read the terminal again.
          freshReadSupplied = observed?.ok === true && reads === readsBeforeSend + 1 && effects.length === 1;
          reply = tool({ kind: 'read_session', targetId: 'pane' }); break;
        case 5: reply = tool({ kind: 'send_prompt', targetId: 'pane', text: 'Review the project.' }); break;
        case 6: reply = tool({ kind: 'read_session', targetId: 'pane' }); break;
        case 7: reply = tool({ kind: 'finish_terminal', targetId: 'pane', outcome: 'completed', text: 'Submission inspected.' }); break;
        default: reply = { choices: [{ finish_reason: 'stop', message: { content: 'Submission was inspected.' } }] };
      }
      return new Response(JSON.stringify(reply));
    } });
  t.after(async () => { await relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await relay.configure({ apiKey: 'test-key', model: 'scripted', sessionOnly: true });
  assert.equal((await relay.setEnabled(true)).ok, true);
  await relay.send({ text: 'Review the project.', origin: 'text' });
  assert.equal(rejectedMissingRead, true);
  assert.equal(freshReadSupplied, true, 'Reappearing with the same generation does not undo the failed-read boundary');
  assert.equal(effects.length, 1, 'Only a successful read permits input, and the submitted task is never repeated');
});
