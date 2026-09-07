const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { wavFromSamples } = require('../../backend/voiceAudio.cjs');
const audioBase64 = wavFromSamples(Array(4000).fill(.1)).toString('base64');
const tick = () => new Promise(setImmediate);
async function fixture(t, fixtureOptions = {}) {
  const inputs = [], spoken = [], tasks = [];
  let voice;
  voice = createVoiceController({
    orchestrator: { getState: () => ({ enabled: true, tasks }), enqueue: input => { inputs.push(input); return { ok: true, requestId: `r${inputs.length}`, status: 'queued' }; } },
    getKey: () => 'test',
    inferenceFactory: () => ({ start: async () => { throw Error('No detector in this fixture'); }, dispose() {} }),
    fetch: async (url, options) => {
      if (url.endsWith('/transcriptions')) return new Response(JSON.stringify({ text: fixtureOptions.text ?? 'yes do that' }));
      spoken.push(JSON.parse(options.body).input);
      return new Response(Buffer.alloc(100), { headers: { 'content-type': 'audio/pcm' } });
    },
    onAudio: chunk => { if (chunk.done && !chunk.cancelled) queueMicrotask(() => voice.configure({ playbackDone: chunk.replyId })); },
  });
  t.after(() => voice.dispose());
  await voice.setListening(true);
  return { voice, inputs, spoken, tasks };
}
test('voice enqueues successive utterances and releases microphone while tasks run', async t => {
  const f = await fixture(t);
  assert.equal((await f.voice.sendAudio({ audioBase64 })).status, 'queued');
  assert.equal(f.voice.getState().phase, 'listening');
  assert.equal(f.voice.configure({ pushToTalk: 'start', holdId: 'next' }).ok, true);
  f.voice.configure({ pushToTalk: 'cancel', holdId: 'next' });
  await f.voice.sendAudio({ audioBase64 });
  assert.equal(f.inputs.length, 2);
});
test('structured task clarification listens after playback and scopes the answer', async t => {
  const f = await fixture(t), question = { id: 'q1', requestId: 'r1', text: 'Which terminal?' };
  f.tasks.push({ requestId: 'r1', status: 'needs-answer', question });
  await f.voice.speak({ origin: 'voice', requestId: 'r1', text: question.text, question });
  assert.equal(f.voice.getState().phase, 'awaiting-answer');
  await f.voice.sendAudio({ audioBase64 });
  assert.deepEqual(f.inputs[0], { text: 'yes do that', origin: 'voice', replyToRequestId: 'r1', questionId: 'q1' });
  assert.equal(f.voice.getState().phase, 'listening');
});
test('task question silence quietly returns to wake mode without clearing task', async t => {
  const f = await fixture(t), question = { id: 'q1', requestId: 'r1', text: 'Which terminal?' };
  f.tasks.push({ requestId: 'r1', status: 'needs-answer', question });
  await f.voice.speak({ origin: 'voice', requestId: 'r1', text: question.text, question });
  for (let i = 0; i < 150; i++) f.voice.frames({ samples: Array(1600).fill(0), sampleRate: 16000 });
  assert.equal(f.voice.getState().phase, 'listening');
  assert.equal(f.voice.getState().error, null);
  assert.equal(f.tasks[0].question.id, 'q1');
  await f.voice.speak({ origin: 'voice', text: 'How can I help?' });
  assert.equal(f.voice.getState().phase, 'listening');
});
test('speech waits for capture, retains other queued requests after targeted cancellation', async t => {
  const f = await fixture(t);
  f.voice.configure({ pushToTalk: 'start', holdId: 'hold' });
  const first = f.voice.speak({ origin: 'voice', requestId: 'one', text: 'First response' });
  const second = f.voice.speak({ origin: 'voice', requestId: 'two', text: 'Second response' });
  await tick(); assert.equal(f.spoken.length, 0);
  f.voice.cancelSpeech({ requestId: 'one' });
  assert.equal(f.voice.getState().phase, 'recording');
  f.voice.configure({ pushToTalk: 'cancel', holdId: 'hold' });
  assert.equal((await first).status, 'cancelled');
  assert.equal((await second).ok, true);
  assert.deepEqual(f.spoken, ['Second response']);
});
test('queued task question is silent after its task pauses or replaces the question', async t => {
  const f = await fixture(t), question = { id: 'q1', requestId: 'r1', text: 'Which terminal?' };
  f.tasks.push({ requestId: 'r1', status: 'needs-answer', question });
  f.voice.configure({ pushToTalk: 'start', holdId: 'hold' });
  const speech = f.voice.speak({ origin: 'voice', requestId: 'r1', text: question.text, question });
  await tick();
  f.tasks[0].status = 'paused';
  f.voice.configure({ pushToTalk: 'cancel', holdId: 'hold' });
  assert.equal((await speech).status, 'resolved');
  assert.equal(f.spoken.length, 0);
  assert.equal(f.voice.getState().phase, 'listening');
});
test('two task questions keep separate answer windows and use public target labels', async t => {
  const f = await fixture(t);
  const firstQuestion = { id: 'q1', requestId: 'one', text: 'Which branch?' };
  const secondQuestion = { id: 'q2', requestId: 'two', text: 'Which file?' };
  f.tasks.push({ requestId: 'one', status: 'needs-answer', question: firstQuestion, targets: [{ name: 'Terminal Alpha' }] }, { requestId: 'two', status: 'needs-answer', question: secondQuestion, label: 'Project Beta' });
  await f.voice.speak({ origin: 'voice', requestId: 'one', text: firstQuestion.text, question: firstQuestion });
  const second = f.voice.speak({ origin: 'voice', requestId: 'two', text: secondQuestion.text, question: secondQuestion });
  await tick();
  assert.deepEqual(f.spoken, ['Terminal Alpha. Which branch?']);
  for (let i = 0; i < 150; i++) f.voice.frames({ samples: Array(1600).fill(0), sampleRate: 16000 });
  await second;
  assert.equal(f.voice.getState().phase, 'awaiting-answer');
  assert.equal(f.tasks[0].question.id, 'q1');
  await f.voice.sendAudio({ audioBase64 });
  assert.equal(f.inputs[0].replyToRequestId, 'two');
  assert.equal(f.inputs[0].questionId, 'q2');
  assert.equal(f.spoken[1], 'Project Beta. Which file?');
});
test('background task error waits for capture without interrupting a newer utterance', async t => {
  const f = await fixture(t);
  f.voice.configure({ pushToTalk: 'start', holdId: 'hold' });
  const errorSpeech = f.voice.announceError({ requestId: 'old', origin: 'voice', category: 'orchestration', operation: 'orchestration' });
  await tick();
  assert.equal(f.voice.getState().phase, 'recording');
  f.voice.configure({ pushToTalk: 'cancel', holdId: 'hold' });
  assert.equal((await errorSpeech).status, 'announced');
  assert.equal(f.voice.getState().phase, 'listening');
});

test('explicit response-turn metadata opens conversational followup without punctuation guessing', async t => {
  const f = await fixture(t);
  await f.voice.speak({ origin: 'voice', requestId: 'r1', text: 'Tell me which project to use.', responseTurn: 'listen' });
  assert.equal(f.voice.getState().phase, 'awaiting-answer');
  await f.voice.sendAudio({ audioBase64 });
  assert.deepEqual(f.inputs[0], { text: 'yes do that', origin: 'voice' });
  await f.voice.speak({ origin: 'voice', requestId: 'r2', text: 'All set?', responseTurn: 'complete' });
  assert.equal(f.voice.getState().phase, 'listening');
});

test('conversational followup expires quietly and targeted cancellation closes its route', async t => {
  const f = await fixture(t);
  await f.voice.speak({ origin: 'voice', requestId: 'r1', text: 'Tell me more.', responseTurn: 'listen' });
  for (let i = 0; i < 150; i++) f.voice.frames({ samples: Array(1600).fill(0), sampleRate: 16000 });
  assert.equal(f.voice.getState().phase, 'listening');
  assert.equal(f.voice.getState().error, null);
  await f.voice.speak({ origin: 'voice', requestId: 'r2', text: 'Choose a project.', responseTurn: 'listen' });
  f.voice.cancelSpeech({ requestId: 'r2' });
  assert.equal(f.voice.getState().phase, 'listening');
});

test('spoken dismissal preserves task question and does not submit an answer', async t => {
  const f = await fixture(t, { text: 'Hey Vibe, never mind.' });
  const question = { id: 'q1', requestId: 'r1', text: 'Which terminal?' };
  f.tasks.push({ requestId: 'r1', status: 'needs-answer', question });
  await f.voice.speak({ origin: 'voice', requestId: 'r1', text: question.text, question });
  assert.equal((await f.voice.sendAudio({ audioBase64 })).status, 'dismissed');
  assert.equal(f.inputs.length, 0);
  assert.equal(f.tasks[0].question.id, 'q1');
  assert.equal(f.voice.getState().phase, 'listening');
  assert.equal(f.voice.getState().listening, true);
});

test('UI dismissal aborts STT and fences queued speech and old manual releases', async t => {
  const f = await fixture(t);
  f.voice.configure({ pushToTalk: 'start', holdId: 'old' });
  const queued = f.voice.speak({ origin: 'voice', requestId: 'r1', text: 'Choose.', responseTurn: 'listen' });
  await tick();
  assert.equal(f.voice.configure({ dismiss: true }).status, 'dismissed');
  assert.equal((await queued).status, 'cancelled');
  assert.equal(f.voice.configure({ pushToTalk: 'stop', holdId: 'old' }).status, 'idle');
  const transcribing = f.voice.sendAudio({ audioBase64 });
  f.voice.configure({ dismiss: true });
  assert.equal((await transcribing).status, 'cancelled');
  assert.equal(f.inputs.length, 0);
  assert.equal(f.spoken.length, 0);
});
