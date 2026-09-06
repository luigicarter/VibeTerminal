const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeSpeechWav, wavFromSamples, errorChime } = require('../../backend/voiceAudio.cjs');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { TTS_MODEL, TTS_VOICE } = require('../../shared/voiceConfig.cjs');

test('WAV validates actual rate, framing, encoding and declared length', () => {
  const wav = wavFromSamples([-1, 0, 1], 44100);
  const audio = decodeSpeechWav(wav);
  assert.equal(audio.sampleRate, 44100); assert.equal(audio.channels, 1); assert.equal(audio.pcm.readInt16LE(0), -32768);
  for (const mutate of [b => b.writeUInt16LE(3, 20), b => b.writeUInt16LE(8, 34), b => b.writeUInt32LE(0, 24), b => b.writeUInt32LE(1, 40)]) {
    const bad = Buffer.from(wav); mutate(bad); assert.throws(() => decodeSpeechWav(bad), /WAV/);
  }
  assert.throws(() => decodeSpeechWav(wav.subarray(0, -1)), /WAV/);
  assert.throws(() => decodeSpeechWav(Buffer.from([0, 0])), /WAV/);
  const stereo = wavFromSamples([0.25, -0.25, 0.5, -0.5], 48000);
  stereo.writeUInt16LE(2, 22); stereo.writeUInt16LE(4, 32); stereo.writeUInt32LE(192000, 28);
  assert.equal(decodeSpeechWav(stereo).channels, 2); assert.equal(decodeSpeechWav(stereo).durationMs, 2 / 48);
  const long = wavFromSamples(new Float32Array(8000 * 181), 8000);
  assert.throws(() => decodeSpeechWav(long), /three-minute/);
});

test('preview plays selected supported voice at WAV rate without enabling relay or capture', async t => {
  let controller; const calls = [], chunks = [], events = [];
  controller = createVoiceController({ orchestrator: { getState: () => ({ enabled: false }) }, getKey: () => 'fake-key', getSettings: () => ({ voice: 'af_bella' }),
    emit: state => events.push(state),
    fetch: async (_url, options) => { calls.push(JSON.parse(options.body)); return { ok: true, headers: new Headers({ 'content-type': 'audio/wav' }), body: (async function* () { const wav = wavFromSamples([0.1, -0.1], 44100); yield wav.subarray(0, 3); yield wav.subarray(3); })() }; },
    onAudio: chunk => { chunks.push(chunk); if (chunk.done) queueMicrotask(() => controller.configure({ playbackDone: chunk.replyId })); } });
  t.after(() => controller.dispose());
  assert.equal((await controller.configure({ preview: true })).ok, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].model, TTS_MODEL); assert.equal(calls[0].voice, 'af_bella'); assert.equal(calls[0].response_format, 'pcm');
  assert.equal(chunks[0].sampleRate, 44100); assert(events.every(e => !e.listening && e.muted)); assert.equal(controller.getState().phase, 'off');
});

test('preview reports missing key and speech failure while remaining muted', async t => {
  const controller = createVoiceController({ getKey: () => '', orchestrator: { getState: () => ({ enabled: false }) } }); t.after(() => controller.dispose());
  assert.equal((await controller.configure({ preview: true })).ok, false); assert.equal(controller.getState().errorOperation, 'speech'); assert.equal(controller.getState().listening, false);
  const other = createVoiceController({ getKey: () => 'fake-key', fetch: async () => ({ ok: false, status: 503, json: async () => ({ error: { code: 503 } }) }), orchestrator: { getState: () => ({ enabled: false }) } }); t.after(() => other.dispose());
  assert.equal((await other.configure({ preview: true })).ok, false); assert.equal(other.getState().phase, 'off'); assert.equal(other.getState().errorOperation, 'speech');
});

test('legacy nonverbal chime remains available and default voice is Heart', () => {
  const clip = errorChime(); assert.equal(clip.text, ''); assert(clip.durationMs < 500); assert(clip.pcm.some(n => n !== 0)); assert.equal(TTS_VOICE, 'af_heart');
});

test('playback error fails preview without stopping the microphone', async t => {
  let controller;
  controller = createVoiceController({ orchestrator: { getState: () => ({ enabled: true }) }, getKey: () => 'fake-key',
    fetch: async () => ({ ok: true, headers: new Headers({ 'content-type': 'audio/wav' }), body: (async function* () { yield wavFromSamples([0, 0], 24000); })() }),
    onAudio: chunk => { if (chunk.done && !chunk.cancelled) queueMicrotask(() => controller.configure({ playbackError: 'Output unavailable' })); } });
  t.after(() => controller.dispose()); await controller.setListening(true);
  const result = await controller.configure({ preview: true });
  assert.equal(result.ok, false); assert.equal(result.operation, 'speech'); assert.match(result.error, /audio output/); assert.equal(controller.getState().phase, 'listening');
});

test('full-duration WAV emits at most 180 audio buffers plus completion', async t => {
  let controller; const chunks = [];
  // Lowest supported rate keeps this maximum-duration fixture below 3 MB.
  const wav = wavFromSamples(new Float32Array(8000 * 180), 8000);
  controller = createVoiceController({ orchestrator: { getState: () => ({ enabled: false }) }, getKey: () => 'fake-key',
    fetch: async () => ({ ok: true, headers: new Headers({ 'content-type': 'audio/wav' }), body: (async function* () { yield wav; })() }),
    onAudio: chunk => { chunks.push({ length: chunk.data.length, rate: chunk.sampleRate, done: chunk.done }); if (chunk.done) queueMicrotask(() => controller.configure({ playbackDone: chunk.replyId })); } });
  t.after(() => controller.dispose());
  assert.equal((await controller.configure({ preview: true })).ok, true);
  assert.equal(chunks.length, 181); assert(chunks.slice(0, -1).every(chunk => chunk.length === chunk.rate * 2)); assert(chunks.at(-1).done);
});
