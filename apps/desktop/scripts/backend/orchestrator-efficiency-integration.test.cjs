'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
let callId = 0;
const calls = (...actions) => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: actions.map(action => ({
  id: `efficiency-${++callId}`, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(action) }
})) } }] });
const reply = content => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
const metadata = body => JSON.parse(body.messages.find(message => message.role === 'user').content);
const latest = body => JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
const read = targetId => ({ kind: 'read_session', targetId });
function focus(body, targetId) {
  return { kind: 'focus_session', targetId, grantId: metadata(body).authorizedCommands.grants.find(grant => grant.targets.some(target => target.id === targetId)).id };
}
function operation(body, kind, extra = {}) {
  const observation = latest(body);
  return { kind, targetId: 'a', grantId: metadata(body).authorizedCommands.grants[0].id, stepId: `step-${++callId}`,
    observationToken: observation.observationToken,
    ...(kind === 'send_prompt' ? { observationSequence: observation.observation?.sequence, inputRevision: observation.observation?.inputRevision } : {}), ...extra };
}
function assertPaired(body) {
  for (let i = 0; i < body.messages.length; i++) {
    const announced = body.messages[i].tool_calls;
    if (!announced) continue;
    const results = body.messages.slice(i + 1, i + 1 + announced.length);
    assert.equal(results.length, announced.length);
    assert(results.every(message => message.role === 'tool'));
    assert.deepEqual(results.map(message => message.tool_call_id), announced.map(call => call.id));
  }
}
async function fixture(t, { operator = false, noActions = false, dispatch } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-efficiency-'));
  const f = { steps: [], bodies: [], effects: [], reads: [] };
  const sessions = ['a', 'b'].map(id => ({ id, generation: 'g1', name: id.toUpperCase(), kind: 'codex', provider: 'codex', cwd: root, status: 'running' }));
  f.app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => sessions, getRoots: () => ({ documents: root, projects: [root] }),
    interpretIntent: async () => ({ goal: operator ? 'Review changes in A.' : 'Focus A then B.', executionMode: 'reason',
      actions: noActions ? [] : operator ? [{ kind: 'operate_terminal', targetIds: ['a'], text: 'Review changes.', answerMode: 'delegated', permissionMode: 'none' }]
        : ['a', 'b'].map(id => ({ kind: 'focus_session', targetIds: [id] })) }),
    readSession: async target => { f.reads.push(target.id); return { ok: true, id: target.id, generation: 'g1', text: f.evolvingOutput ? `Observed evidence page ${f.reads.length}.` : 'Input is ready.', sequence: 10, inputRevision: 2 }; },
    dispatchAction: async action => { f.effects.push(action); return dispatch ? dispatch(action) : { ok: true, status: operator ? 'written' : 'focused' }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return Response.json({ data: {} });
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] });
      const body = JSON.parse(options.body); f.bodies.push(body);
      try {
        assertPaired(body);
        assert(f.steps.length, 'Unexpected extra model round: ' + JSON.stringify(body.messages.slice(-4)));
        const step = f.steps.shift();
        return Response.json(typeof step === 'function' ? step(body) : step);
      } catch (error) { f.error = error; throw error; }
    }
  });
  t.after(async () => { await f.app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await f.app.configure({ apiKey: 'fixture', model: 'fixture', sessionOnly: true });
  await f.app.setEnabled(true);
  f.run = async steps => {
    f.steps.push(...steps);
    const result = await f.app.send({ text: operator ? 'Review changes in A.' : 'Focus A then B.', origin: 'text' });
    if (f.error) throw f.error;
    assert.equal(f.steps.length, 0, JSON.stringify(result));
    return result;
  };
  return f;
}

test('reason-mode partial execution continues the remaining authorized action after premature prose', async t => {
  const f = await fixture(t);
  const result = await f.run([body => calls(focus(body, 'a')), reply('I focused A.'), body => calls(focus(body, 'b')), reply('Both focused.')]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.effects.map(action => action.targetId), ['a', 'b']);
  assert.equal(f.app.getState().tasks.find(task => task.requestId === result.requestId).status, 'finished');
});

test('premature responses retain bounded continuation attempts', async t => {
  const f = await fixture(t);
  const result = await f.run([body => calls(focus(body, 'a')), reply('A is focused.'), reply('I will focus B.'), reply('I will do it.')]);
  assert.equal(result.ok, false);
  assert.match(result.error, /unfinished/);
  assert.deepEqual(f.effects.map(action => action.targetId), ['a']);
});

test('ordinary final-round respond publishes without a thirteenth executor call', async t => {
  const f = await fixture(t, { noActions: true });
  f.evolvingOutput = true;
  const result = await f.run([...Array.from({ length: 11 }, () => calls(read('a'))),
    calls({ kind: 'respond', text: 'The terminal is ready.', responseTurn: 'complete' })]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, 'The terminal is ready.');
  assert.equal(f.bodies.length, 12);
});

test('final-round clarification publishes without extending the executor budget', async t => {
  const f = await fixture(t);
  f.evolvingOutput = true;
  const result = await f.run([...Array.from({ length: 11 }, () => calls(read('a'))),
    calls({ kind: 'ask_user', text: 'Which view should I show?' })]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.responseTurn, 'listen');
  assert.equal(f.bodies.length, 12);
  assert.equal(f.effects.length, 0);
  assert.equal(f.app.getState().tasks.find(task => task.requestId === result.requestId).status, 'needs-answer');
});

test('operator final-round finish publishes without a thirty-third executor call', async t => {
  const f = await fixture(t, { operator: true });
  f.evolvingOutput = true;
  const result = await f.run([calls(read('a')),
    body => calls(operation(body, 'send_prompt', { text: 'Review changes.' }), read('a')),
    ...Array.from({ length: 29 }, () => calls(read('a'))),
    body => calls(operation(body, 'finish_terminal', { outcome: 'completed', text: 'The review was submitted.' }))]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.bodies.length, 32);
  assert.deepEqual(f.effects.map(action => action.kind), ['send_prompt']);
});

test('final-round response with unfinished actions cannot extend the executor budget', async t => {
  const f = await fixture(t);
  f.evolvingOutput = true;
  const result = await f.run([...Array.from({ length: 11 }, () => calls(read('a'))),
    calls({ kind: 'respond', text: 'I will focus both terminals.', responseTurn: 'complete' })]);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.error, /action limit/);
  assert.equal(f.bodies.length, 12);
  assert.equal(f.effects.length, 0);
});

test('read-only exhaustion cannot extend the executor budget', async t => {
  const f = await fixture(t, { noActions: true });
  f.evolvingOutput = true;
  const result = await f.run(Array.from({ length: 12 }, () => calls(read('a'))));
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.error, /action limit/);
  assert.equal(f.bodies.length, 12);
});

test('unchanged evidence stops repeated reads before spending the entire executor allowance', async t => {
  const f = await fixture(t, { noActions: true });
  const result = await f.run(Array.from({ length: 7 }, () => calls(read('a'))));
  assert.equal(result.ok, false);
  assert.match(result.error, /no progress/);
  assert.equal(f.bodies.length, 7);
  assert.deepEqual(f.effects, []);
  assert.ok(f.bodies.some(body => body.messages.some(message => message.content?.includes('last three tool rounds'))));
});

test('respond skips later announced effects and supplies paired receipts before continuation', async t => {
  const f = await fixture(t);
  const result = await f.run([
    body => calls(focus(body, 'a'), { kind: 'respond', text: 'A is focused.', responseTurn: 'complete' }, focus(body, 'b')),
    body => {
      assert.deepEqual(f.effects.map(action => action.targetId), ['a']);
      assert.equal(latest(body).status, 'skipped');
      assert.equal(latest(body).delivery, 'not-dispatched');
      return calls(focus(body, 'b'));
    }, reply('Both focused.')
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.effects.map(action => action.targetId), ['a', 'b']);
});

test('ask_user ends its batch without executing a later effect', async t => {
  const f = await fixture(t);
  const result = await f.run([body => calls({ kind: 'ask_user', text: 'Which view should I show?' }, focus(body, 'a'))]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.responseTurn, 'listen');
  assert.equal(f.effects.length, 0);
  assert.equal(f.app.getState().tasks.find(task => task.requestId === result.requestId).status, 'needs-answer');
});

test('ordered send and verification read complete an operator interaction in three model rounds', async t => {
  const f = await fixture(t, { operator: true });
  const result = await f.run([
    calls(read('a')),
    body => {
      assert.match(body.messages[0].content, /effect\+post-read may share a response/);
      assert.match(body.messages[0].content, /Continue remaining authorized grants/);
      assert.match(latest(body).terminalNavigationGuide, /Codex native CLI/);
      return calls(operation(body, 'send_prompt', { text: 'Review changes.' }), read('a'));
    },
    body => calls(operation(body, 'finish_terminal', { outcome: 'completed', text: 'The review was submitted.' }))
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.bodies.length, 3);
  assert.deepEqual(f.reads, ['a', 'a']);
  assert.deepEqual(f.effects.map(action => action.kind), ['send_prompt']);
});

test('two known independent reads share one tool batch', async t => {
  const f = await fixture(t, { noActions: true });
  const result = await f.run([calls(read('a'), read('b')), reply('Both terminals are ready.')]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.reads, ['a', 'b']);
  assert.equal(f.bodies.length, 2);
  const initial = f.bodies[0];
  const advertised = initial.tools[0].function.parameters.properties.kind.enum;
  for (const kind of advertised) assert.ok(initial.messages[0].content.includes(`\n${kind}: `), `No model-facing guide for ${kind}`);
  assert.equal(advertised.includes('send_prompt'), false);
  assert.equal(metadata(initial).sessions.some(session => Object.hasOwn(session, 'terminalNavigationGuide')), false);
});

test('an uncertain batched send remains non-replayable after the verification read', async t => {
  const f = await fixture(t, { operator: true, dispatch: () => ({ ok: false, status: 'unknown', error: 'Unconfirmed write.' }) });
  const result = await f.run([
    calls(read('a')),
    body => calls(operation(body, 'send_prompt', { text: 'Review changes.' }), read('a')),
    body => calls(operation(body, 'send_prompt', { text: 'Review changes.' })),
    body => { assert.equal(latest(body).ok, false); assert.match(latest(body).error, /unconfirmed|uncertain/); return calls(read('a')); },
    body => calls(operation(body, 'finish_terminal', { outcome: 'blocked', text: 'Delivery remains unconfirmed.' })),
    reply('Delivery remains unconfirmed.')
  ]);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(f.effects.length, 1);
});
