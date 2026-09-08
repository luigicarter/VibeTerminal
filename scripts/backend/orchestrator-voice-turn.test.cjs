'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');

const tool = (name, args) => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call', function: { name, arguments: JSON.stringify(args) } }] } }] });
const respond = (text, responseTurn = 'complete', speechText) => tool('workspace', { kind: 'respond', text, responseTurn, ...(speechText !== undefined && { speechText }) });
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
      if (body.tools?.[0]?.function.name === 'interpret_workspace') {
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

test('long ordinary speech summarizes once and preserves written result and history', async t => {
  const f = await fixture(t);
  const full = 'Detailed implementation notes. '.repeat(70) + 'Seven tests passed; deployment is pending.';
  f.reply = body => body.tools ? respond(full) : { choices: [{ finish_reason: 'stop', message: { content: 'The agent reports seven tests passing; deployment is pending.' } }] };
  const result = await f.app.send({ text: 'Give me the result', origin: 'voice' });
  assert.equal(result.text, full);
  assert.equal(f.spoken.at(-1).text, full);
  assert.equal(f.spoken.at(-1).speechText, 'The agent reports seven tests passing; deployment is pending.');
  assert.ok(f.spoken.at(-1).signal instanceof AbortSignal);
  assert.ok(f.app.getState().messages.some(message => message.text === full));
  assert.equal(f.calls.filter(body => !body.tools).length, 1);
});

test('respond supplies model-chosen speech in the existing call without clipping or another model', async t => {
  const f = await fixture(t);
  const full = 'The full written report has implementation details.';
  const summary = 'The agent reports the outcome and outstanding checks. '.repeat(90).trim();
  f.reply = body => { assert.ok(body.tools, 'must not request another summary'); return respond(full, 'complete', summary); };
  const result = await f.app.send({ text: 'Tell me what happened', origin: 'voice' });
  assert.equal(result.text, full);
  assert.equal(f.spoken.at(-1).text, full);
  assert.equal(f.spoken.at(-1).speechText, summary);
  assert.equal(f.calls.length, 1);
  const branch = f.calls[0].tools[0].function.parameters.anyOf.find(item => item.properties.kind.enum[0] === 'respond');
  assert.ok(branch.properties.speechText);
  assert.ok(!branch.required.includes('speechText'));
});

test('long ordinary failed summary stays brief without changing the written response', async t => {
  const f = await fixture(t);
  const full = 'Agent details. '.repeat(100);
  f.reply = body => body.tools ? respond(full) : { choices: [{ finish_reason: 'length', message: { content: 'Incomplete summary' } }] };
  const result = await f.app.send({ text: 'Give me the result', origin: 'voice' });
  assert.equal(result.text, full);
  assert.match(f.spoken.at(-1).speechText, /could not prepare a reliable spoken summary/);
  assert.equal(f.calls.filter(body => !body.tools).length, 1);
});

test('cancelled ordinary summary cannot publish stale speech or a fallback', async t => {
  const f = await fixture(t);
  let release, started;
  const summaryStarted = new Promise(resolve => { started = resolve; });
  f.reply = body => body.tools ? respond('Long response details. '.repeat(100)) : new Promise(resolve => { release = resolve; started(); });
  const pending = f.app.send({ text: 'Give me the result', origin: 'voice' });
  await summaryStarted;
  await f.app.cancel();
  release({ choices: [{ finish_reason: 'stop', message: { content: 'Obsolete result.' } }] });
  await pending;
  assert.equal(f.spoken.length, 0);
});

test('parallel ordinary summaries share the two-call executor limit and preserve every result', async t => {
  const f = await fixture(t);
  const full = 'Detailed result notes. '.repeat(90);
  const releases = [];
  let inFlight = 0, peak = 0;
  f.reply = body => {
    if (body.tools) return respond(full);
    inFlight++; peak = Math.max(peak, inFlight);
    return new Promise(resolve => releases.push(() => {
      inFlight--;
      resolve({ choices: [{ finish_reason: 'stop', message: { content: 'The agent reports changes; verification remains pending.' } }] });
    }));
  };
  const pending = [1, 2, 3, 4].map(index => f.app.send({ text: `Report result ${index}`, origin: 'voice' }));
  let completed = false;
  const finished = Promise.all(pending).then(results => { completed = true; return results; });
  // Hold summaries across event-loop turns so overlapping request completions
  // have a real opportunity to exceed the shared provider limit.
  for (let round = 0; round < 400 && !completed; round++) {
    for (let tick = 0; tick < 8; tick++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(inFlight <= 2, `Observed ${inFlight} simultaneous summary calls`);
    releases.shift()?.();
  }
  assert.ok(completed, 'All queued summaries should finish');
  const results = await finished;
  assert.equal(peak, 2);
  assert.equal(results.length, 4);
  assert.ok(results.every(result => result.ok && result.text === full));
  assert.equal(f.spoken.length, 4);
  assert.equal(f.calls.filter(body => !body.tools).length, 4);
});

test('respond complete and dismiss carry metadata without inventing a question or effect', async t => {
  const f = await fixture(t);
  for (const responseTurn of ['complete', 'dismiss']) {
    f.reply = () => respond(responseTurn === 'complete' ? 'All ready.' : 'Talk later.', responseTurn, 'All ready.');
    const result = await f.app.send({ text: 'A voice exchange', origin: 'voice' });
    assert.equal(result.ok, true); assert.equal(result.responseTurn, responseTurn);
    assert.equal(f.task(result.requestId).status, 'finished'); assert.equal(f.task(result.requestId).question, undefined);
    assert.equal(f.spoken.at(-1).responseTurn, responseTurn); assert.equal(f.spoken.at(-1).question, undefined);
  }
  assert.equal(f.effects.length, 0);
  assert.equal(f.calls.filter(body => !body.tools).length, 0, 'explicit speech and dismissal need no speech summary model call');
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
    { kind: 'respond', text: 'Choose.', responseTurn: 'complete', speechText: {} },
    { kind: 'respond', text: 'Choose.', responseTurn: 'complete', speechText: ' ' },
  ]) {
    let attempt = 0;
    f.reply = body => {
      if (!attempt++) return tool('workspace', args);
      const rejection = JSON.parse(body.messages.findLast(message => message.role === 'tool').content);
      assert.equal(rejection.ok, false); assert.equal(rejection.status, 'rejected'); assert.match(rejection.error, /Respond requires/);
      return respond('I could not finish that reply.', 'complete', 'I could not finish that reply.');
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
    if (index === 1) return respond('All done.', 'complete', 'The work is complete and verified.');
    if (index === 2) {
      assert.match(body.messages.at(-1).content, /still has unfinished work/);
      assert.equal(f.spoken.length, 0); assert.equal(f.effects.length, 0);
      const grant = JSON.parse(body.messages[1].content).authorizedCommands.grants[0];
      return tool('workspace', { kind: 'send_prompt', grantId: grant.id, targetId: 's1' });
    }
    return respond('Sent to Project Alpha.', 'complete', 'The work is complete and verified.');
  };
  const result = await f.app.send({ text: 'Send echo ready to Project Alpha', origin: 'voice' });
  assert.equal(result.ok, true); assert.equal(f.effects.length, 1); assert.equal(f.effects[0].text, 'echo ready');
  assert.equal(f.calls.length, 3); assert.equal(f.spoken.length, 2); assert.equal(f.spoken[0].text, result.text);
  assert.match(result.text, /Input was sent to Project Alpha; task completion cannot be verified automatically/);
  assert.equal(f.spoken[0].speechText, result.text, 'current delivery evidence replaces an unsupported model speech summary');
  assert.equal(f.spoken[1].kind, 'task-report'); assert.equal(f.spoken[1].requestId, result.requestId);
  assert.match(f.spoken[1].text, /plain shell.*Completion is unverified/);
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
  assert.equal(f.spoken.length, 2); assert.notEqual(f.spoken[0].text, 'All done.');
  assert.equal(f.spoken[1].kind, 'task-report'); assert.equal(f.spoken[1].requestId, result.requestId);
  assert.match(f.spoken[1].text, /plain shell.*Completion is unverified/);
});
