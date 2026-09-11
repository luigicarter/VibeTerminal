'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSpeechAudioStream, wavFromSamples } = require('../../backend/voiceAudio.cjs');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const tick = () => new Promise(setImmediate);
async function until(fn, label) { for (let n = 0; n < 150; n++) { if (fn()) return; await tick(); } assert.fail(label); }
function decode(chunks, type) { const stream = createSpeechAudioStream(type), output = chunks.flatMap(chunk => stream.push(chunk)), result = stream.finish(); return { ...result, chunks: [...output, ...result.chunks] }; }

test('streamed PCM retains split stereo frames, emits 100 ms then one-second chunks, and preserves bytes', () => {
  for (const rate of [8000, 8001, 24000, 44100, 48000]) for (const channels of [1, 2]) {
    const frame = channels * 2, first = Math.ceil(rate / 10) * frame;
    const input = Buffer.alloc((rate * 2 + 3) * frame);
    for (let n = 0; n < input.length; n++) input[n] = n % 256;
    const stream = createSpeechAudioStream(`audio/pcm;rate=${rate};channels=${channels}`);
    assert.deepEqual(stream.push(input.subarray(0, first - 1)), []);
    const early = stream.push(input.subarray(first - 1, first + 1));
    assert.equal(early.length, 1); assert.equal(early[0].pcm.length, first);
    const later = stream.push(input.subarray(first + 1)), end = stream.finish();
    const chunks = [...early, ...later, ...end.chunks];
    assert.deepEqual(Buffer.concat(chunks.map(chunk => chunk.pcm)), input);
    assert(chunks.every(chunk => chunk.pcm.length % frame === 0 && chunk.sampleRate === rate && chunk.channels === channels));
    assert(chunks.slice(1).every(chunk => chunk.pcm.length <= rate * frame));
  }
});

test('WAV sniff waits for twelve bytes and full container validation, while unlabelled PCM streams', () => {
  const wav = wavFromSamples(new Float32Array(24000), 24000);
  for (const type of ['', 'application/octet-stream', 'audio/wav', 'audio/vnd.wave']) {
    const stream = createSpeechAudioStream(type);
    for (const chunk of [wav.subarray(0, 3), wav.subarray(3, 11), wav.subarray(11, 12), wav.subarray(12)]) assert.deepEqual(stream.push(chunk), []);
    assert.deepEqual(Buffer.concat(stream.finish().chunks.map(chunk => chunk.pcm)), wav.subarray(44));
    const malformed = Buffer.from(wav); malformed.writeUInt16LE(32, 34);
    const invalid = createSpeechAudioStream(type); assert.deepEqual(invalid.push(malformed), []);
    assert.throws(() => invalid.finish(), /WAV/);
  }
  for (const type of ['', 'application/octet-stream']) {
    const raw = createSpeechAudioStream(type); assert.deepEqual(raw.push(Buffer.alloc(11)), []);
    assert.equal(raw.push(Buffer.alloc(4800 - 11)).length, 1);
    assert.deepEqual(raw.finish().chunks, []);
  }
});

test('unsupported PCM metadata fails before reading and incomplete EOF or duration overflow fails', () => {
  for (const type of ['audio/mpeg', 'audio/L16;rate=24000', 'audio/pcm;bits=32', 'audio/pcm;channels=3', 'audio/pcm;rate=0', 'audio/pcm;format=s16be', 'audio/pcm;endian=big']) assert.throws(() => createSpeechAudioStream(type), /unsupported/);
  for (const [type, length] of [['audio/pcm', 1], ['audio/pcm;channels=2', 2], ['', 0]]) {
    const stream = createSpeechAudioStream(type); stream.push(Buffer.alloc(length)); assert.throws(() => stream.finish(), /unsupported/);
  }
  const limit = createSpeechAudioStream('audio/pcm;rate=8000');
  const chunks = limit.push(Buffer.alloc(8000 * 2 * 180)), end = limit.finish();
  assert.equal(chunks.length + end.chunks.length, 181); assert.equal(end.durationMs, 180000);
  const overflow = createSpeechAudioStream('audio/pcm;rate=8000');
  overflow.push(Buffer.alloc(1600)); assert.throws(() => overflow.push(Buffer.alloc(8000 * 2 * 180)), /three-minute/);
  assert.deepEqual(Buffer.concat(decode([Buffer.from([0]), Buffer.from([128, 255, 127])], 'audio/pcm').chunks.map(chunk => chunk.pcm)), Buffer.from([0, 128, 255, 127]));
});

function fixture(t, type = 'audio/pcm;rate=24000;channels=1', autoDone = false) {
  const f = { audio: [], diagnostics: [], calls: [], cancelled: false, clock: 0 };
  const body = new ReadableStream({ start(controller) { f.stream = controller; }, cancel() { f.cancelled = true; } });
  f.controller = createVoiceController({
    orchestrator: { getState: () => ({ enabled: true, tasks: [{ requestId: 'request-1', status: 'running' }] }), recordDiagnostic: event => f.diagnostics.push(event) },
    getKey: () => 'fixture-key', getSettings: () => ({}), monotonicNow: () => ++f.clock,
    errorAudio: { load: () => ({ pcm: Buffer.alloc(2), durationMs: 1 }) },
    fetch: async (url, options) => { f.calls.push({ url, options }); return { ok: true, status: 200, headers: new Headers({ 'content-type': type }), body }; },
    onAudio: chunk => { f.audio.push(chunk); if (chunk.done && !chunk.cancelled && (chunk.local || autoDone)) queueMicrotask(() => f.controller.configure({ playbackDone: chunk.replyId })); }
  });
  f.speech = () => f.controller.speak({ origin: 'voice', requestId: 'request-1', text: 'A private test reply.', responseTurn: 'listen' });
  f.chunks = () => f.audio.filter(chunk => !chunk.local && chunk.data.length);
  t.after(() => f.controller.dispose()); return f;
}

test('controller plays before EOF, ignores stale acknowledgments, and listens only after playback end', async t => {
  const f = fixture(t); await f.controller.setListening(true); let settled = false;
  const speaking = f.speech().then(result => { settled = true; return result; });
  await until(() => f.calls.length, 'speech fetch');
  f.stream.enqueue(Buffer.alloc(4799)); await tick(); assert.equal(f.chunks().length, 0);
  f.stream.enqueue(Buffer.alloc(1)); await until(() => f.chunks().length, 'first audio before EOF');
  const id = f.chunks()[0].replyId;
  assert.equal(f.chunks()[0].data.length, 4800); assert.equal(settled, false);
  f.controller.configure({ playbackDone: id }); // A premature done cannot finish a downloading reply.
  f.controller.configure({ playbackStarted: 'retired', playbackDone: 'retired', playbackError: 'late error', playbackReplyId: 'retired' });
  f.controller.configure({ playbackStarted: id }); f.controller.configure({ playbackStarted: id });
  f.stream.enqueue(Buffer.alloc(48000)); f.stream.close();
  await until(() => f.audio.some(chunk => chunk.done && !chunk.cancelled), 'download completion');
  assert.equal(settled, false); assert.equal(f.controller.getState().phase, 'speaking');
  f.controller.configure({ playbackDone: id }); assert.equal((await speaking).ok, true);
  assert.equal(f.controller.getState().phase, 'awaiting-answer');
  const stages = f.diagnostics.filter(event => event.event === 'request_stage');
  assert.deepEqual(stages.map(event => event.stage), ['tts_started', 'tts_first_byte', 'playback_started', 'tts_complete', 'playback_complete']);
  assert(stages.every(event => event.requestId === 'request-1' && event.replyId === id && event.elapsedMs >= 0));
  assert(!JSON.stringify(stages).includes('private test reply'));
});

test('early playback failure cancels a pending network reader and cannot replay partial speech', async t => {
  const f = fixture(t); await f.controller.setListening(true); const speaking = f.speech();
  await until(() => f.calls.length, 'fetch'); f.stream.enqueue(Buffer.alloc(4800));
  await until(() => f.chunks().length, 'early audio');
  const id = f.chunks()[0].replyId;
  f.controller.configure({ playbackError: 'Device disconnected', playbackReplyId: id });
  const result = await speaking; assert.equal(result.ok, false); assert.equal(result.operation, 'speech');
  assert.equal(f.cancelled, true); assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.chunks().length, 1); assert(f.audio.some(chunk => chunk.replyId === id && chunk.cancelled));
  assert.equal(f.calls.length, 1); assert.notEqual(f.controller.getState().phase, 'awaiting-answer');
});

test('malformed EOF cancels already emitted PCM, while unsupported headers emit none', async t => {
  const f = fixture(t); await f.controller.setListening(true); const speaking = f.speech();
  await until(() => f.calls.length, 'fetch'); f.stream.enqueue(Buffer.alloc(4801));
  await until(() => f.chunks().length, 'partial playback'); f.stream.close();
  assert.equal((await speaking).ok, false); assert(f.audio.some(chunk => chunk.cancelled));
  assert.equal(f.audio.filter(chunk => !chunk.local && chunk.done && !chunk.cancelled).length, 0);
  assert.equal(f.calls[0].options.signal.aborted, true);
  const bad = fixture(t, 'audio/pcm;format=f32le'); await bad.controller.setListening(true);
  assert.equal((await bad.speech()).ok, false); assert.equal(bad.chunks().length, 0);
});

test('cancelling streaming speech releases its reader and prevents future answer capture', async t => {
  const f = fixture(t); await f.controller.setListening(true); const speaking = f.speech();
  await until(() => f.calls.length, 'fetch'); f.stream.enqueue(Buffer.alloc(4800));
  await until(() => f.chunks().length, 'early audio'); const id = f.chunks()[0].replyId;
  f.controller.cancelSpeech(); assert.equal((await speaking).status, 'cancelled');
  assert.equal(f.cancelled, true); f.controller.configure({ playbackDone: id, playbackStarted: id });
  assert.equal(f.controller.getState().phase, 'listening');
});

test('STT completion links the capture and recording to the enqueued request without transcript content', async t => {
  const diagnostics = []; let clock = 0;
  const controller = createVoiceController({
    orchestrator: { getState: () => ({ enabled: true }), enqueue: async () => ({ ok: true, requestId: 'enqueued-request' }), recordDiagnostic: event => diagnostics.push(event) },
    getKey: () => 'private-key', monotonicNow: () => ++clock,
    fetch: async () => ({ ok: true, json: async () => ({ text: 'private transcribed command' }) })
  });
  t.after(() => controller.dispose()); await controller.setListening(true); controller.configure({ captureToken: 7 });
  const result = await controller.sendAudio({ audioBase64: wavFromSamples([0.1, 0.2, 0.3]).toString('base64'), recordingId: 5 });
  assert.equal(result.requestId, 'enqueued-request');
  const stage = diagnostics.find(event => event.stage === 'stt_complete');
  assert.equal(stage.requestId, result.requestId); assert.equal(stage.captureToken, 7); assert.equal(stage.recordingId, 5); assert.equal(stage.elapsedMs, 1);
  assert(!JSON.stringify(diagnostics).includes('private'));
});
