'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildReplyContext } = require('../../backend/orchestratorReplyContext.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');

function reference() {
  return { input: { replyToRequestId: 'old', questionId: 'q' }, currentSequence: 5,
    previous: { input: { text: 'Choose a project' }, task: { requestId: 'old', sequence: 1, status: 'needs-answer', question: { requestId: 'old', id: 'q', text: 'Alpha or Beta?' } }, context: { conversationTarget: { id: 'a', generation: 1 } } },
    sessions: [{ id: 'a', generation: 1 }], messages: [{ requestId: 'old', role: 'assistant', text: 'Alpha or Beta?' }, { requestId: 'other', role: 'assistant', text: 'Unrelated' }] };
}

test('reply reference pins only the selected owned exchange and live target generation', () => {
  const input = reference(); const result = buildReplyContext(input);
  assert.equal(result.question.text, 'Alpha or Beta?');
  assert.deepEqual(result.recentMessages, [{ role: 'assistant', text: 'Alpha or Beta?' }]);
  assert.deepEqual(result.conversationTarget, { id: 'a', generation: 1 });
  input.sessions[0].generation = 2;
  assert.equal(buildReplyContext(input).conversationTarget, undefined);
  assert.equal(Object.hasOwn(result, 'grants'), false);
});

test('missing, future, wrong and consumed question references cannot supply reply context', () => {
  for (const alter of [x => { x.previous = undefined; }, x => { x.input.replyToRequestId = 'other'; }, x => { x.previous.task.sequence = 5; }, x => { x.input.questionId = 'wrong'; }, x => { x.previous.task.status = 'finished'; }, x => { x.previous.task.question.requestId = 'other'; }]) {
    const input = reference(); alter(input); assert.equal(buildReplyContext(input), undefined);
  }
  for (const status of ['cancelled', 'failed', 'paused']) {
    const input = reference(); delete input.input.questionId; input.previous.task.status = status;
    assert.equal(buildReplyContext(input), undefined);
  }
  const completed = reference(); delete completed.input.questionId; completed.previous.task.status = 'finished';
  assert.equal(buildReplyContext(completed).status, 'finished');
  assert.equal(buildReplyContext(completed).question, undefined);
});

test('reply reference is bounded and excludes monitor and system messages', () => {
  const input = reference(); input.previous.input.text = 'x'.repeat(5000);
  input.messages = Array.from({ length: 8 }, () => ({ requestId: 'old', role: 'assistant', text: 'y'.repeat(3000) }));
  input.messages.push({ requestId: 'old', role: 'system', text: 'private' }, { requestId: 'old', role: 'assistant', origin: 'monitor', text: 'monitor' });
  const result = buildReplyContext(input);
  assert.equal(result.instruction.length, 4000); assert.equal(result.instructionTruncated, true);
  assert.equal(result.recentMessages.length, 4);
  assert.ok(result.recentMessages.every(message => message.text.length === 2000 && message.truncated));
});

const tool = (name, args) => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call', function: { name, arguments: JSON.stringify(args) } }] } }] });
test('both model phases retain an older question across interleaved work without reviving completed authority', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-reply-context-'));
  const contexts = [], executions = [], effects = [];
  const app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false }, getSessions: () => [], getRoots: () => ({ documents: root, projects: [] }),
    dispatchAction: async action => { effects.push(action); return { ok: true }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'model', context_length: 128000, supported_parameters: ['tools'] }] }));
      const body = JSON.parse(options.body), context = JSON.parse(body.messages[1].content);
      if (body.tools[0].function.name === 'interpret_workspace') {
        contexts.push(context);
        return new Response(JSON.stringify(tool('interpret_workspace', { goal: context.instruction, actions: [], ...(context.instruction === 'Alpha' && { continuationOf: context.replyContext.requestId }) })));
      }
      executions.push(context);
      const listen = context.instruction === 'Choose a project';
      return new Response(JSON.stringify(tool('workspace', { kind: 'respond', text: listen ? 'Alpha or Beta?' : 'Ready.', responseTurn: listen ? 'listen' : 'complete' })));
    },
  });
  t.after(async () => { await app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await app.configure({ apiKey: 'fixture', sessionOnly: true, model: 'model' }); await app.setEnabled(true);
  const first = await app.send({ text: 'Choose a project', origin: 'voice' });
  const question = app.getState().tasks.find(task => task.requestId === first.requestId).question;
  for (let index = 0; index < 8; index++) await app.send({ text: `Unrelated ${index}`, origin: 'text' });
  const answered = await app.send({ text: 'Alpha', origin: 'voice', replyToRequestId: first.requestId, questionId: question.id });
  assert.equal(answered.ok, true);
  for (const context of [contexts.at(-1), executions.at(-1)]) {
    assert.equal(context.replyContext.question.text, 'Alpha or Beta?');
    assert.equal(context.replyContext.requestId, first.requestId);
    assert.ok(!context.recentConversation.some(message => message.text === question.text));
  }
  await app.send({ text: 'Actually explain something else', origin: 'voice', replyToRequestId: answered.requestId });
  assert.equal(contexts.at(-1).replyContext.status, 'finished');
  assert.equal(contexts.at(-1).previousCommand, undefined);
  assert.equal(executions.at(-1).authorizedCommands.grants.length, 0);
  assert.equal(effects.length, 0);
});
