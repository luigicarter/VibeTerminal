const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { wavFromSamples } = require('../../backend/voiceAudio.cjs');
const tick = () => new Promise(setImmediate);
const audioBase64 = wavFromSamples(Array(4000).fill(.1)).toString('base64');
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  assert.fail('Voice conversation did not settle');
}
async function fixture(t, options = {}) {
  const tasks = [], requests = [], inputs = [], dispatched = [], audio = [];
  let voice, transcript = 'yes';
  voice = createVoiceController({
    orchestrator: {
      getState: () => ({ enabled: true, tasks, requests }),
      enqueue: input => { inputs.push(input); return { ok: true, status: 'queued' }; },
      dispatch: input => { dispatched.push(input); return { ok: true }; },
    },
    getKey: () => 'fixture-key',
    inferenceFactory: () => ({ start: async () => { throw Error('No detector in this fixture'); }, dispose() {} }),
    fetch: async (url) => url.endsWith('/transcriptions')
      ? new Response(JSON.stringify({ text: transcript }))
      : options.speech ? options.speech() : new Response(Buffer.alloc(100), { headers: { 'content-type': 'audio/pcm' } }),
    onAudio: chunk => audio.push(chunk),
  });
  t.after(() => voice.dispose());
  await voice.setListening(true);
  const answer = async () => {
    assert.equal(voice.configure({ pushToTalk: 'start', holdId: 'answer' }).ok, true);
    voice.frames({ samples: Array(6400).fill(.1), sampleRate: 16000 });
    voice.configure({ pushToTalk: 'stop', holdId: 'answer' });
    await until(() => inputs.length || dispatched.length);
  };
  return { voice, tasks, requests, inputs, dispatched, audio, answer, transcript: value => { transcript = value; } };
}

test('Space interrupts a task question while TTS loads and retains the exact answer route', async t => {
  let release;
  const f = await fixture(t, { speech: () => new Promise(resolve => { release = resolve; }) });
  const question = { id: 'q1', requestId: 'r1', text: 'Which terminal should run this?' };
  f.tasks.push({ requestId: 'r1', status: 'needs-answer', question });
  const speaking = f.voice.speak({ origin: 'voice', requestId: 'r1', text: question.text, question });
  await until(() => release);
  await f.answer();
  assert.deepEqual(f.inputs, [{ text: 'yes', origin: 'voice', replyToRequestId: 'r1', questionId: 'q1' }]);
  release(new Response(Buffer.alloc(100), { headers: { 'content-type': 'audio/pcm' } }));
  assert.equal((await speaking).status, 'cancelled');
  assert.equal(f.voice.getState().phase, 'listening');
  assert.equal(f.audio.filter(chunk => chunk.data.length).length, 0, 'interrupted TTS cannot play late');
});

test('Space interrupts a native question during playback and keeps generation, revision and partial answers', async t => {
  const f = await fixture(t); f.transcript('two');
  const interaction = {
    id: 'native', sessionId: 'pane', generation: 4, revision: 7, kind: 'question', state: 'pending',
    partialAnswers: [['First']],
    questions: [
      { id: 'first', question: 'First choice?', options: [{ label: 'First' }] },
      { id: 'second', question: 'Second choice?', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
    ],
  };
  f.requests.push(interaction);
  const speaking = f.voice.announceInteraction(interaction);
  await until(() => f.audio.some(chunk => chunk.done));
  await f.answer();
  assert.deepEqual(f.dispatched, [{ kind: 'answer_question', targetId: 'pane', requestId: 'native', generation: 4, revision: 7, answers: { first: 'First', second: 'Beta' } }]);
  await speaking;
  assert.equal(f.voice.getState().phase, 'listening');
});

test('a conversational reply stays linked to its finished request amid other pending questions', async t => {
  const f = await fixture(t);
  f.tasks.push({ requestId: 'original', status: 'finished' }, { requestId: 'other', status: 'needs-answer', question: { id: 'other-q' } });
  const speaking = f.voice.speak({ origin: 'voice', requestId: 'original', responseTurn: 'listen', text: 'Tell me what you would like changed.' });
  await until(() => f.audio.some(chunk => chunk.done));
  f.voice.configure({ playbackDone: f.voice.getState().replyId }); await speaking;
  await f.voice.sendAudio({ audioBase64 });
  assert.deepEqual(f.inputs, [{ text: 'yes', origin: 'voice', replyToRequestId: 'original' }]);
});

test('interrupting a replaced question never submits an answer to its obsolete identity', async t => {
  const f = await fixture(t);
  const question = { id: 'old', requestId: 'r1', text: 'Which file?' };
  f.tasks.push({ requestId: 'r1', status: 'needs-answer', question });
  const speaking = f.voice.speak({ origin: 'voice', requestId: 'r1', text: question.text, question });
  await until(() => f.audio.some(chunk => chunk.done));
  f.voice.configure({ pushToTalk: 'start', holdId: 'answer' });
  f.tasks[0].question = { id: 'new', requestId: 'r1', text: 'Which branch?' };
  const result = await f.voice.sendAudio({ audioBase64 });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(f.inputs, []);
  await speaking;
});

test('a short Space tap during a question restores its answer window without sending', async t => {
  const f = await fixture(t);
  const question = { id: 'q1', requestId: 'r1', text: 'Which file?' };
  f.tasks.push({ requestId: 'r1', status: 'needs-answer', question });
  const speaking = f.voice.speak({ origin: 'voice', requestId: 'r1', text: question.text, question });
  await until(() => f.audio.some(chunk => chunk.done));
  f.voice.configure({ pushToTalk: 'start', holdId: 'tap' });
  f.voice.configure({ pushToTalk: 'cancel', holdId: 'tap' });
  await speaking;
  assert.equal(f.voice.getState().phase, 'awaiting-answer');
  assert.deepEqual(f.inputs, []);
});
