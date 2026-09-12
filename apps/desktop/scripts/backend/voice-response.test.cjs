const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { interpretTestIntent } = require('./orchestrator-test-intent.cjs');
const { wavFromSamples } = require('../../backend/voiceAudio.cjs');
const { ERROR_AUDIO_TEXT } = require('../../backend/localErrorAudio.cjs');
const tick = () => new Promise(setImmediate);
const audioBase64 = wavFromSamples(Array(1600).fill(.1)).toString('base64');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-voice-response-'));
  const calls = [], audio = [], states = [];
  let transcript = 'hello', failure, controller;
  const request = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/key')) return json({ data: {} });
    if (url.includes('/models')) return json({ data: [{ id: 'brain', context_length: 128000, supported_parameters: ['tools'] }] });
    if (url.endsWith('/transcriptions')) return json({ text: transcript });
    if (url.endsWith('/chat/completions')) return failure ? failure() : json({ choices: [{ finish_reason: 'stop', message: { content: 'Hello! How can I help?' } }] });
    if (url.endsWith('/speech')) {
      assert.equal(body.response_format, 'pcm');
      // Transport chunks may split samples; renderer chunks must not.
      return { ok: true, headers: new Headers({ 'content-type': 'audio/pcm;rate=24000;channels=1' }), body: (async function* () { yield Buffer.from([0, 128, 255]); yield Buffer.from([127]); })() };
    }
    throw Error('Unexpected fixture URL');
  };
  const relay = createOrchestrator({ interpretIntent: interpretTestIntent, userDataPath: root, fetch: request,
    onSpeak: message => controller.speak(message), onUpstreamError: info => controller.announceError(info), onCancel: input => controller?.cancelSpeech(input) });
  controller = createVoiceController({ orchestrator: relay, fetch: request, getKey: () => relay.getKey(), getSettings: () => relay.getSettings(),
    emit: state => states.push(state),
    onAudio: chunk => { audio.push(chunk); if (chunk.done && !chunk.cancelled) queueMicrotask(() => controller.configure({ playbackDone: chunk.replyId })); } });
  t.after(async () => {
    controller.dispose(); await relay.dispose();
    assert(path.resolve(root).startsWith(path.join(os.tmpdir(), 'vibe-voice-response-')));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await relay.configure({ apiKey: 'fixture-secret', sessionOnly: true, model: 'brain' });
  assert.equal((await relay.setEnabled(true)).ok, true);
  await controller.setListening(true);
  const settled = async requestId => {
    for (let attempt = 0; attempt < 500; attempt++) {
      await tick();
      const task = relay.getState().tasks.find(item => item.requestId === requestId);
      if (task && ['finished', 'failed', 'cancelled', 'paused'].includes(task.status) && controller.getState().phase === 'listening') return task;
    }
    throw Error(`Voice task did not settle: ${requestId}`);
  };
  return { controller, relay, calls, audio, states, settled, transcript: value => { transcript = value; }, fail: fn => { failure = fn; } };
}

test('real voice-to-relay-to-speech composition responds with acknowledged PCM', async t => {
  const f = await fixture(t);
  const result = await f.controller.sendAudio({ audioBase64 });
  assert.equal(result.ok, true); assert.equal(result.status, 'queued');
  assert.equal((await f.settled(result.requestId)).status, 'finished');
  assert(f.relay.getState().messages.some(message => message.requestId === result.requestId && message.text === 'Hello! How can I help?'));
  assert.equal(f.controller.getState().transcript, 'hello');
  assert.equal(f.controller.getState().phase, 'listening');
  assert.deepEqual(f.audio.flatMap(chunk => chunk.data), [0, 128, 255, 127]);
  assert.equal(f.calls.filter(call => call.url.endsWith('/speech')).length, 1);
  assert.equal(f.audio.at(-1).done, true);
});

test('empty and punctuation-only transcriptions each speak a retry prompt without cloud speech', async t => {
  const f = await fixture(t);
  for (const transcript of ['', '...', '  ']) {
    f.transcript(transcript);
    const before = f.audio.length;
    const result = await f.controller.sendAudio({ audioBase64 });
    assert.equal(result.status, 'empty'); assert.equal(result.speech.status, 'announced');
    assert.equal(f.controller.getState().reply, ERROR_AUDIO_TEXT['not-understood']);
    assert.equal(f.controller.getState().phase, 'listening');
    assert(f.audio.slice(before).some(chunk => chunk.local && chunk.data.length));
  }
  assert.equal(f.calls.filter(call => /\/speech$|\/chat\/completions$/.test(call.url)).length, 0);
});

test('a silent hold speaks once and returns to listening without transcription', async t => {
  const f = await fixture(t); f.controller.configure({ pushToTalk: 'start' });
  for (let i = 0; i < 60; i++) f.controller.frames({ samples: Array(1600).fill(0), sampleRate: 16000 });
  assert.equal(f.controller.configure({ pushToTalk: 'stop' }).status, 'empty');
  await tick();
  assert.equal(f.controller.getState().reply, ERROR_AUDIO_TEXT['not-understood']);
  assert.equal(f.controller.getState().phase, 'listening');
  assert.equal(new Set(f.audio.map(chunk => chunk.replyId)).size, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/transcriptions')).length, 0);
});

test('malformed transcription is a spoken service failure, never an object string sent to the brain', async t => {
  const f = await fixture(t); f.transcript({ instruction: 'delete everything' });
  const result = await f.controller.sendAudio({ audioBase64 });
  assert.equal(result.ok, false); assert.equal(result.upstreamError.category, 'upstream');
  assert(f.audio.some(chunk => chunk.local && chunk.data.length));
  assert.equal(f.calls.filter(call => call.url.endsWith('/chat/completions')).length, 0);
});

test('local relay failures and spending limits speak explanations', async t => {
  const f = await fixture(t);
  f.fail(() => json({ choices: [{ finish_reason: 'length', message: { content: 'Incomplete' } }] }));
  const result = await f.controller.sendAudio({ audioBase64 });
  assert.equal(result.ok, true);
  assert.equal((await f.settled(result.requestId)).status, 'failed');
  assert.equal(f.controller.getState().reply, ERROR_AUDIO_TEXT.orchestration);
  await f.relay.configure({ spendingLimit: .01 });
  f.relay.recordSpeechUsage('transcription', .02);
  assert.equal((await f.controller.sendAudio({ audioBase64 })).ok, false);
  assert.equal(f.controller.getState().reply, ERROR_AUDIO_TEXT['spending-limit']);
});

test('a busy relay accepts another voice request and speaks its eventual result', async t => {
  const f = await fixture(t); let release;
  f.fail(() => new Promise(resolve => { release = resolve; }));
  const pending = f.relay.send({ text: 'Existing text request', origin: 'text' });
  await tick(); assert(release);
  const result = await f.controller.sendAudio({ audioBase64 });
  assert.equal(result.ok, true); assert.equal(result.status, 'queued');
  assert.equal(f.controller.getState().phase, 'listening');
  f.fail(() => json({ choices: [{ message: { tool_calls: [{ id: 'voice-reply', type: 'function', function: { name: 'workspace',
    arguments: JSON.stringify({ kind: 'respond', text: 'The second voice request is ready.', speechText: 'Your voice request is ready.', responseTurn: 'complete' }) } }] } }] }));
  release(json({ choices: [{ message: { content: 'Done.' } }] })); await pending;
  assert.equal((await f.settled(result.requestId)).status, 'finished');
  assert.equal(f.calls.filter(call => call.url.endsWith('/chat/completions')).length, 2);
  assert.equal(f.calls.filter(call => call.url.endsWith('/speech')).length, 1);
  assert.equal(f.calls.find(call => call.url.endsWith('/speech')).body.input, 'Your voice request is ready.');
  assert.ok(f.relay.getState().messages.some(message => message.requestId === result.requestId && message.text === 'The second voice request is ready.'));
});

test('brain upstream error callback produces one local spoken explanation per explicit voice attempt', async t => {
  const f = await fixture(t); f.fail(() => json({ error: { code: 402 } }, 402));
  for (let i = 0; i < 2; i++) {
    const ack = await f.controller.sendAudio({ audioBase64 });
    assert.equal(ack.ok, true); assert.equal((await f.settled(ack.requestId)).status, 'failed');
  }
  assert.equal(new Set(f.audio.filter(chunk => chunk.local).map(chunk => chunk.replyId)).size, 2);
  assert.equal(f.controller.getState().reply, ERROR_AUDIO_TEXT.credits);
  assert.equal(f.calls.filter(call => call.url.endsWith('/speech')).length, 0);
});

test('cancelled relay requests do not produce a failure announcement', async t => {
  const f = await fixture(t); let release;
  f.fail(() => new Promise(resolve => { release = resolve; }));
  const pending = f.controller.sendAudio({ audioBase64 });
  await tick(); assert(release); await f.relay.cancel();
  release(json({ error: { code: 503 } }, 503));
  const ack = await pending; assert.equal(ack.status, 'queued');
  assert.equal((await f.settled(ack.requestId)).status, 'cancelled');
  assert.equal(f.audio.length, 0);
});
