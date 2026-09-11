'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const reply = text => ({ choices: [{ finish_reason: 'stop', message: { content: text } }] });
const tool = action => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `call-${action.kind}`, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(action) } }] } }] });
const typo = 'Can you resume the mix to one last attempt conversation?';
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-resume-followup-'));
  const f = { effects: [], contexts: [], bodies: [], now: Date.now() };
  f.history = [{ reference: 'history-ref', id: 'native-id', title: 'Mix 21 last attempt', provider: 'codex', cwd: root }];
  f.app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false }, now: () => f.now,
    getSessions: () => [], getRoots: () => ({ documents: root, projects: [{ path: root, name: 'Test project' }] }),
    interpretIntent: async context => { f.contexts.push(context); return { goal: context.instruction, actions: [{ kind: 'resume_conversation' }] }; },
    dispatchAction: async action => {
      if (action.kind === 'list_conversations') return { ok: true, conversations: f.history };
      f.effects.push(action); return { ok: true, status: 'resumed' };
    },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'model', context_length: 128000, supported_parameters: ['tools'] }] }));
      const body = JSON.parse(options.body); f.bodies.push(body);
      const context = JSON.parse(body.messages[1].content);
      const observations = body.messages.filter(message => message.role === 'tool');
      const grantId = context.authorizedCommands.grants[0]?.id;
      let response;
      if (context.instruction === typo) {
        response = !observations.length ? tool({ kind: 'list_conversations' }) : tool({ kind: 'ask_user', reference: 'history-ref', grantId, text: 'Would you like me to delete all projects?' });
      } else if (!observations.length) response = tool({ kind: 'resume_conversation', reference: 'history-ref', grantId });
      else response = reply('Finished.');
      return new Response(JSON.stringify(response));
    },
  });
  await f.app.configure({ apiKey: 'fixture', sessionOnly: true, model: 'model' }); await f.app.setEnabled(true);
  t.after(async () => { await f.app.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  f.ask = async () => {
    const result = await f.app.send({ text: typo, origin: 'voice' });
    const task = f.app.getState().tasks.find(task => task.requestId === result.requestId);
    assert.equal(task.status, 'needs-answer');
    return { result, task, input: { text: 'yes', origin: 'voice', replyToRequestId: result.requestId, questionId: task.question.id } };
  };
  return f;
}

test('saved resume typo asks a canonical identity question and scoped yes resumes once through the harness', async t => {
  const f = await fixture(t); const pending = await f.ask();
  assert.equal(pending.task.question.text, 'Do you mean “Mix 21 last attempt” in Test project (codex)?');
  assert.equal(f.effects.length, 0);
  const response = await f.app.send(pending.input);
  assert.equal(response.ok, true);
  assert.equal(f.contexts.length, 1, 'affirmative uses the actual deterministic continued grant compiler');
  assert.equal(f.effects.length, 1);
  assert.equal(f.effects[0].kind, 'resume_conversation');
  assert.equal(f.effects[0].reference, 'history-ref');
  assert.deepEqual(f.effects[0].selection, { kind: 'title', value: 'Mix 21 last attempt', provider: 'codex', cwd: f.history[0].cwd });
  assert.ok(f.bodies.some(body => JSON.parse(body.messages[1].content).confirmedResume?.reference === 'history-ref'));
  assert.equal(f.app.enqueue(pending.input).ok, false);
  assert.equal(f.effects.length, 1);
});

test('wrong question and stale cancelled question never resume a saved conversation', async t => {
  const f = await fixture(t); const pending = await f.ask();
  assert.equal(f.app.enqueue({ ...pending.input, questionId: 'wrong-question' }).ok, false);
  await f.app.cancel({ requestId: pending.result.requestId });
  assert.equal(f.app.enqueue(pending.input).ok, false);
  assert.equal(f.effects.length, 0);
});

test('expired candidate does not authorize affirmative resume even when model requests the action', async t => {
  const f = await fixture(t); const pending = await f.ask(); f.now += 300001;
  await f.app.send(pending.input);
  assert.equal(f.effects.length, 0);
  assert.equal(f.contexts.length, 2);
  assert.ok(f.bodies.filter(body => JSON.parse(body.messages[1].content).instruction === 'yes').every(body => !JSON.parse(body.messages[1].content).confirmedResume));
});

test('unrelated yes without request and question IDs cannot inherit a pending saved candidate', async t => {
  const f = await fixture(t); await f.ask();
  await f.app.send({ text: 'yes', origin: 'text' });
  assert.equal(f.effects.length, 0);
  assert.equal(f.contexts.length, 2);
  assert.ok(f.bodies.filter(body => JSON.parse(body.messages[1].content).instruction === 'yes').every(body => !JSON.parse(body.messages[1].content).confirmedResume));
});

test('two queued answers to the same saved question consume its confirmation only once', async t => {
  const f = await fixture(t); const pending = await f.ask();
  const results = await Promise.all([f.app.send(pending.input), f.app.send(pending.input)]);
  assert.equal(f.effects.length, 1);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => !result.ok).length, 1);
});

test('a negative or qualified reply does not resume the offered candidate', async t => {
  for (const text of ['no', 'yes but do not resume it']) {
    await t.test(text, async t => {
      const f = await fixture(t); const pending = await f.ask();
      await f.app.send({ ...pending.input, text });
      assert.equal(f.effects.length, 0);
      assert.equal(f.contexts.length, 2);
    });
  }
});
