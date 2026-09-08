'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { wavFromSamples } = require('../../backend/voiceAudio.cjs');
const audioBase64 = wavFromSamples(Array(4000).fill(.1)).toString('base64');
const tick = () => new Promise(setImmediate);
async function fixture(t, options = {}) {
  const question = { id: 'q1', requestId: 'r1', text: 'Which project?' };
  const tasks = [{ requestId: 'r1', status: 'needs-answer', question }], requests = [], inputs = [];
  let voice;
  voice = createVoiceController({
    orchestrator: { getState: () => ({ enabled: true, tasks, requests }), enqueue: input => { inputs.push(input); return { ok: true, status: 'queued' }; } },
    getKey: options.getKey || (() => 'test-key'),
    inferenceFactory: () => ({ start: async () => {}, dispose() {}, feed() {} }),
    fetch: async url => url.endsWith('/transcriptions') ? options.transcribe ? options.transcribe() : new Response(JSON.stringify({ text: 'Run tests in Beta' })) : new Response(Buffer.alloc(100), { headers: { 'content-type': 'audio/pcm' } }),
    onAudio: chunk => { if (chunk.done && !chunk.cancelled) queueMicrotask(() => voice.configure({ playbackDone: chunk.replyId })); },
  });
  t.after(() => voice.dispose());
  await voice.setListening(true);
  return { voice, tasks, requests, inputs, question, prompt: () => voice.speak({ origin: 'voice', requestId: 'r1', text: question.text, question }) };
}

for (const change of ['answered', 'cancelled', 'cleared', 'replaced', 'running']) test(`task question ${change} releases answer mode before a new PTT command`, async t => {
  const f = await fixture(t); await f.prompt();
  if (change === 'cleared') f.tasks.length = 0;
  else if (change === 'replaced') f.tasks[0].question = { ...f.question, id: 'q2' };
  else f.tasks[0].status = change === 'answered' ? 'finished' : change;
  f.voice.reconcileTaskQuestions();
  assert.equal(f.voice.getState().phase, 'listening');
  f.voice.configure({ pushToTalk: 'start', holdId: 'fresh' });
  assert.equal((await f.voice.sendAudio({ audioBase64 })).ok, true);
  assert.deepEqual(f.inputs, [{ text: 'Run tests in Beta', origin: 'voice' }]);
});

test('PTT start independently retires an obsolete question before capture', async t => {
  const f = await fixture(t); await f.prompt();
  f.tasks[0].status = 'finished';
  f.voice.configure({ pushToTalk: 'start', holdId: 'fresh' });
  await f.voice.sendAudio({ audioBase64 });
  assert.equal(f.inputs[0].replyToRequestId, undefined);
});

for (const change of ['answered', 'replaced']) test(`question ${change} during key preparation never starts obsolete playback`, async t => {
  let release, deferKey = false;
  const f = await fixture(t, { getKey: () => deferKey ? new Promise(resolve => { release = resolve; }) : 'test-key' });
  deferKey = true;
  const prompt = f.prompt();
  await tick(); assert.equal(typeof release, 'function');
  if (change === 'answered') f.tasks[0].status = 'running';
  else f.tasks[0].question = { ...f.question, id: 'q2' };
  f.voice.reconcileTaskQuestions();
  release('test-key');
  assert.equal((await prompt).status, 'resolved');
  assert.equal(f.voice.getState().reply, '');
  assert.equal(f.voice.getState().phase, 'listening');
  deferKey = false;
  assert.equal((await f.voice.speak({ origin: 'voice', requestId: 'next', text: 'Next result.' })).ok, true);
  assert.equal(f.voice.getState().phase, 'listening');
});

test('question resolution during STT cancels captured answer instead of making a new command', async t => {
  let release;
  const f = await fixture(t, { transcribe: () => new Promise(resolve => { release = resolve; }) });
  await f.prompt();
  const answer = f.voice.sendAudio({ audioBase64 });
  await tick(); assert.equal(typeof release, 'function');
  f.tasks[0].status = 'finished'; f.voice.reconcileTaskQuestions();
  release(new Response(JSON.stringify({ text: 'yes' })));
  assert.equal((await answer).status, 'cancelled');
  assert.deepEqual(f.inputs, []);
  assert.equal(f.voice.getState().phase, 'listening');
});

test('question resolution during capture discards its audio and stale hold release', async t => {
  const f = await fixture(t); await f.prompt();
  f.voice.configure({ pushToTalk: 'start', holdId: 'old' });
  f.voice.frames({ samples: Array(6400).fill(.1), sampleRate: 16000 });
  f.tasks[0].status = 'finished'; f.voice.reconcileTaskQuestions();
  assert.equal(f.voice.configure({ pushToTalk: 'stop', holdId: 'old' }).status, 'idle');
  assert.deepEqual(f.inputs, []);
});

test('reconciliation preserves current task, native and conversational answer windows', async t => {
  const f = await fixture(t); await f.prompt();
  f.voice.reconcileTaskQuestions(); assert.equal(f.voice.getState().phase, 'awaiting-answer');
  f.voice.cancelSpeech();
  const interaction = { id: 'native', sessionId: 'pane', generation: 'g', revision: 1, state: 'pending', kind: 'question', questions: [{ id: 'q', question: 'Which branch?', options: [] }] };
  f.requests.push(interaction); await f.voice.announceInteraction(interaction);
  f.voice.reconcileTaskQuestions(); assert.equal(f.voice.getState().phase, 'awaiting-answer');
  f.voice.cancelSpeech(); f.tasks[0].status = 'finished';
  await f.voice.speak({ origin: 'voice', requestId: 'r1', text: 'Anything else?', responseTurn: 'listen' });
  f.voice.reconcileTaskQuestions(); assert.equal(f.voice.getState().phase, 'awaiting-answer');
});
