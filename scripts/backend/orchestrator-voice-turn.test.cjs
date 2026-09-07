'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');

const tool = (name, args) => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call', function: { name, arguments: JSON.stringify(args) } }] } }] });
const respond = (text, responseTurn = 'complete') => tool('workspace', { kind: 'respond', text, responseTurn });
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-voice-turn-'));
  const f = { spoken: [], effects: [], contexts: [], calls: [], sessions: [{ id: 's1', generation: 'g1', name: 'Project Alpha', kind: 'terminal', cwd: root, turnState: 'idle' }] };
  f.plan = context => ({ goal: context.instruction, actions: [], ...(context.instruction === 'Project Alpha' && context.previousCommand && { continuationOf: context.previousCommand.requestId }) });
  f.reply = () => respond('Ready.');
  f.app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => f.sessions, getRoots: () => ({ documents: root, projects: [] }),
    dispatchAction: async action => { f.effects.push(action); return { ok: true, status: 'written' }; },
    onSpeak: async message => { f.spoken.push(message); return { ok: true }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'model', context_length: 128000, supported_parameters: ['tools'] }] }));
      const body = JSON.parse(options.body);
      if (body.tools[0].function.name === 'interpret_workspace') {
        const context = JSON.parse(body.messages[1].content); f.contexts.push(context);
        return new Response(JSON.stringify(tool('interpret_workspace', f.plan(context))));
      }
      f.calls.push(body); return new Response(JSON.stringify(await f.reply(body, f.calls.length)));
    },
  });
  t.after(async () => { await f.app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await f.app.configure({ apiKey: 'fixture', sessionOnly: true, model: 'model' }); await f.app.setEnabled(true);
  f.task = id => f.app.getState().tasks.find(task => task.requestId === id);
  return f;
}

test('respond listen owns a question and bound reply consumes only the selected question', async t => {
  const f = await fixture(t);
  f.reply = body => respond(`Tell me which project for ${JSON.parse(body.messages[1].content).instruction}.`, 'listen');
  const first = await f.app.send({ text: 'First choice', origin: 'voice' });
  const second = await f.app.send({ text: 'Second choice', origin: 'voice' });
  const firstQuestion = f.task(first.requestId).question, secondQuestion = f.task(second.requestId).question;
  assert.equal(first.responseTurn, 'listen'); assert.equal(f.task(first.requestId).status, 'needs-answer');
  assert.equal(firstQuestion.requestId, first.requestId); assert.notEqual(firstQuestion.id, secondQuestion.id);
  assert.equal(f.spoken[0].responseTurn, 'listen'); assert.deepEqual(f.spoken[0].question, firstQuestion);
  assert.equal(f.spoken[0].requestId, first.requestId); assert.equal(f.spoken[0].text, firstQuestion.text);
  assert.match(f.calls[0].messages[0].content, /Voice turn contract.*responseTurn/s);
  f.reply = () => respond('Project Alpha it is.');
  const answered = await f.app.send({ text: 'Project Alpha', origin: 'voice', replyToRequestId: first.requestId, questionId: firstQuestion.id });
  assert.equal(answered.ok, true); assert.equal(answered.responseTurn, 'complete');
  assert.equal(f.contexts.at(-1).previousCommand.requestId, first.requestId);
  assert.equal(f.task(first.requestId).status, 'finished'); assert.equal(f.task(first.requestId).question, undefined);
  assert.equal(f.task(second.requestId).status, 'needs-answer'); assert.deepEqual(f.task(second.requestId).question, secondQuestion);
  assert.equal(f.app.enqueue({ text: 'Again', origin: 'voice', replyToRequestId: first.requestId, questionId: firstQuestion.id }).ok, false);
  assert.equal(f.effects.length, 0);
});

test('respond complete and dismiss carry metadata without inventing a question or effect', async t => {
  const f = await fixture(t);
  for (const responseTurn of ['complete', 'dismiss']) {
    f.reply = () => respond(responseTurn === 'complete' ? 'All ready.' : 'Talk later.', responseTurn);
    const result = await f.app.send({ text: 'A voice exchange', origin: 'voice' });
    assert.equal(result.ok, true); assert.equal(result.responseTurn, responseTurn);
    assert.equal(f.task(result.requestId).status, 'finished'); assert.equal(f.task(result.requestId).question, undefined);
    assert.equal(f.spoken.at(-1).responseTurn, responseTurn); assert.equal(f.spoken.at(-1).question, undefined);
  }
  assert.equal(f.effects.length, 0);
});

test('question punctuation alone never opens the answer route', async t => {
  const f = await fixture(t);
  f.reply = () => ({ choices: [{ finish_reason: 'stop', message: { content: 'Would you like anything else?' } }] });
  const result = await f.app.send({ text: 'Hello', origin: 'voice' });
  assert.equal(result.responseTurn, 'complete'); assert.equal(f.spoken[0].responseTurn, 'complete');
  assert.equal(f.task(result.requestId).question, undefined); assert.equal(f.spoken[0].question, undefined);
});

test('malformed respond is rejected without opening a question or dispatching effects', async t => {
  const f = await fixture(t);
  for (const args of [
    { kind: 'respond', text: 'Choose.' },
    { kind: 'respond', text: 'Choose.', responseTurn: 'maybe' },
    { kind: 'respond', text: ' ', responseTurn: 'listen' },
    { kind: 'respond', text: 'Choose.', responseTurn: 'listen', targetId: 's1' },
  ]) {
    let attempt = 0;
    f.reply = body => {
      if (!attempt++) return tool('workspace', args);
      const rejection = JSON.parse(body.messages.findLast(message => message.role === 'tool').content);
      assert.equal(rejection.ok, false); assert.equal(rejection.status, 'rejected'); assert.match(rejection.error, /Respond requires/);
      return respond('I could not finish that reply.');
    };
    const result = await f.app.send({ text: 'Hello', origin: 'voice' });
    assert.equal(result.ok, false); assert.equal(f.task(result.requestId).question, undefined);
    assert.equal(f.spoken.at(-1).responseTurn, 'complete');
  }
  assert.equal(f.effects.length, 0);
});

test('respond complete cannot bypass an unfinished terminal grant and must continue tools', async t => {
  const f = await fixture(t);
  f.plan = () => ({ goal: 'Send the authorized command.', actions: [{ kind: 'send_prompt', targetIds: ['s1'], text: 'echo ready' }] });
  f.reply = (body, index) => {
    if (index === 1) return respond('All done.');
    if (index === 2) {
      assert.match(body.messages.at(-1).content, /still has unfinished work/);
      assert.equal(f.spoken.length, 0); assert.equal(f.effects.length, 0);
      const grant = JSON.parse(body.messages[1].content).authorizedCommands.grants[0];
      return tool('workspace', { kind: 'send_prompt', grantId: grant.id, targetId: 's1' });
    }
    return respond('Sent to Project Alpha.');
  };
  const result = await f.app.send({ text: 'Send echo ready to Project Alpha', origin: 'voice' });
  assert.equal(result.ok, true); assert.equal(f.effects.length, 1); assert.equal(f.effects[0].text, 'echo ready');
  assert.equal(f.calls.length, 3); assert.equal(f.spoken.length, 1); assert.equal(f.spoken[0].text, 'Sent to Project Alpha.');
});

test('a rejected response cannot make a later complete bypass unfinished authorized work', async t => {
  const f = await fixture(t);
  f.plan = () => ({ goal: 'Send the authorized command.', actions: [{ kind: 'send_prompt', targetIds: ['s1'], text: 'echo ready' }] });
  f.reply = (body, index) => {
    if (index === 1) return tool('workspace', { kind: 'respond', text: 'Bad metadata.', responseTurn: 'invalid' });
    if (index === 2) return respond('All done.');
    if (index === 3) {
      assert.match(body.messages.at(-1).content, /still has unfinished work/);
      assert.equal(f.spoken.length, 0);
      const grant = JSON.parse(body.messages[1].content).authorizedCommands.grants[0];
      return tool('workspace', { kind: 'send_prompt', grantId: grant.id, targetId: 's1' });
    }
    return respond('The command was sent after the response error.');
  };
  const result = await f.app.send({ text: 'Send echo ready to Project Alpha', origin: 'voice' });
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].text, 'echo ready');
  assert.equal(f.calls.length, 4); assert.equal(result.actions[0].status, 'rejected');
  assert.equal(f.spoken.length, 1); assert.notEqual(f.spoken[0].text, 'All done.');
});
