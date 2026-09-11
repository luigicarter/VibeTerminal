const test = require('node:test');
const assert = require('node:assert/strict');
const { RATE, createRecording, decodeSpeechAudio, decodeSpeechWav, wavFromSamples } = require('../../backend/voiceAudio.cjs');
const { TTS_NATIVE_RATE, TTS_NATIVE_CHANNELS } = require('../../shared/voiceConfig.cjs');
// The controller admits content types before decodeSpeechAudio ever sees them, so the
// two lists have to agree; read the shipped gate rather than restating it here.
const SPEECH_CONTENT_TYPE_GATE = (() => {
  const source = require('node:fs').readFileSync(require.resolve('../../backend/voiceController.cjs'), 'utf8');
  const found = /!(\/\^\(\?:audio.+?\/i)\.test\(contentType\)/.exec(source);
  assert(found, 'speech content-type gate not found in voiceController.cjs');
  return (0, eval)(found[1]);
})();

test('raw speech preserves signed little-endian samples reassembled across odd network chunks', () => {
  const chunks = [Buffer.from([0]), Buffer.from([128, 255, 127]), Buffer.from([0, 0])];
  const input = Buffer.concat(chunks);
  const audio = decodeSpeechAudio(input, 'audio/pcm;rate=24000;channels=1');
  assert.deepEqual(audio.pcm, input);
  assert.deepEqual([0, 2, 4].map(at => audio.pcm.readInt16LE(at)), [-32768, 32767, 0]);
  assert.equal(audio.sampleRate, 24000);
  assert.equal(audio.channels, 1);
  assert.equal(audio.durationMs, 0.125);
});

test('PCM metadata determines mono/stereo duration at supported rates', () => {
  for (const rate of [8000, 16000, 24000, 44100, 48000]) {
    for (const channels of [1, 2]) {
      const audio = decodeSpeechAudio(Buffer.alloc(rate * channels * 2), ` Audio/PCM ; Channels = "${channels}" ; RATE = ${rate} `);
      assert.equal(audio.durationMs, 1000);
      assert.equal(audio.sampleRate, rate);
      assert.equal(audio.channels, channels);
    }
  }
});

test('PCM rejects ambiguous, malformed and contradictory format metadata', () => {
  for (const contentType of [
    'audio/pcm;rate=24000;channels=1;RATE=24000',
    'audio/pcm;rate=24000;channels=1;channels=2',
    'audio/pcm;rate=24000;channels=1;encoding=float',
    'audio/pcm;rate=24000;channels=1;bits=32',
    'audio/pcm;rate=24000;channels=1;bitspersample=24',
    'audio/pcm;rate=24000;channels=1;format=f32le',
    ...['7999', '48001', '0', '-24000', '24e3', '24000.0', 'Infinity', 'NaN', '', '"24000', '24000junk', '999999999999999999999999999'].map(rate => `audio/pcm;rate=${rate};channels=1`),
    ...['0', '3', '-1', '1.0', '', '"1', '1junk'].map(channels => `audio/pcm;rate=24000;channels=${channels}`),
  ]) assert.throws(() => decodeSpeechAudio(Buffer.alloc(4), contentType), /unsupported audio or PCM metadata/, contentType);
});

test('PCM rejects empty, incomplete sample/frame and excessive recordings', () => {
  for (const [length, channels] of [[0, 1], [1, 1], [3, 1], [2, 2], [6, 2]]) {
    assert.throws(() => decodeSpeechAudio(Buffer.alloc(length), `audio/pcm;rate=24000;channels=${channels}`), /unsupported audio or PCM metadata/);
  }
  const limit = Buffer.alloc(8000 * 2 * 180);
  assert.equal(decodeSpeechAudio(limit, 'audio/pcm;rate=8000;channels=1').durationMs, 180000);
  assert.throws(() => decodeSpeechAudio(Buffer.alloc(limit.length + 2), 'audio/pcm;rate=8000;channels=1'), /three-minute/);
  assert.throws(() => decodeSpeechAudio(Buffer.alloc(36 * 1024 * 1024 + 1), 'audio/pcm;rate=48000;channels=2'), /size limit/);
});

test('WAV compatibility uses actual headers and rejects wrong MIME', () => {
  const wav = wavFromSamples([-1, 0, 1], 44100);
  for (const mime of [undefined, null, '', 'application/octet-stream', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'Audio/WAV; codecs=1']) {
    assert.deepEqual(decodeSpeechAudio(wav, mime), decodeSpeechWav(wav));
  }
  // A declared WAV type must actually be a WAV; an unlabelled body is sniffed instead.
  for (const mime of ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']) {
    assert.throws(() => decodeSpeechAudio(Buffer.alloc(4), mime), /WAV/);
  }
  // RFC 2586 L16 is big-endian, so it must stay refused rather than play as noise.
  for (const mime of ['audio/mpeg', 'application/json', 'text/plain', 'audio/L16;rate=24000', 'audio/L16;rate=24000;channels=1']) {
    assert.throws(() => decodeSpeechAudio(wav, mime), /unsupported audio/);
    assert.equal(SPEECH_CONTENT_TYPE_GATE.test(mime), false, mime);
  }
  const broken = Buffer.from(wav); broken.writeUInt16LE(32, 34);
  assert.throws(() => decodeSpeechAudio(broken, 'audio/wav'), /WAV/);
});

test('benign content-type variations decode instead of failing the whole reply', () => {
  // One case per row of the provider-response probe. A reply that cannot be decoded
  // becomes a local "speech failed" alert, so needless strictness here is audible.
  const raw = Buffer.alloc(48000, 1), wav = wavFromSamples(new Float32Array(480), 24000);
  const native = { sampleRate: TTS_NATIVE_RATE, channels: TTS_NATIVE_CHANNELS };
  for (const [label, contentType, body, expected] of [
    ['bare audio/pcm', 'audio/pcm', raw, native],
    ['documented shape', 'audio/pcm;rate=24000;channels=1', raw, native],
    ['spaced parameters', 'audio/pcm; rate=24000; channels=1', raw, native],
    ['quoted parameters', 'audio/pcm;rate="24000";channels="1"', raw, native],
    ['channels omitted', 'audio/pcm;rate=24000', raw, native],
    ['rate omitted', 'audio/pcm;channels=1', raw, native],
    ['trailing semicolon', 'audio/pcm;rate=24000;channels=1;', raw, native],
    ['unknown parameter', 'audio/pcm;charset=binary;rate=24000;channels=1', raw, native],
    ['declared 16-bit', 'audio/pcm;rate=24000;channels=1;bits=16', raw, native],
    ['octet-stream carrying raw PCM', 'application/octet-stream', raw, native],
    ['absent header carrying raw PCM', '', raw, native],
    ['octet-stream carrying a WAV', 'application/octet-stream', wav, native],
    ['audio/vnd.wave carrying a WAV', 'audio/vnd.wave', wav, native],
    ['non-native rate is honoured over the default', 'audio/pcm;rate=48000;channels=2', raw, { sampleRate: 48000, channels: 2 }],
  ]) {
    const audio = decodeSpeechAudio(body, contentType);
    assert.equal(audio.sampleRate, expected.sampleRate, label);
    assert.equal(audio.channels, expected.channels, label);
    assert(audio.pcm.length > 0, label);
  }
});

test('a short command wholly in the pre-roll ring is measured separately and retains all samples', () => {
  const speech = new Float32Array(RATE).fill(0.1);
  const trailingSilence = new Float32Array(RATE * 0.4);
  const recording = createRecording({ preRoll: [speech, trailingSilence] });
  // Pre-roll is audio the speaker has already finished, so it cannot endpoint the
  // capture. Its voiced duration is still reported, because a second of it is a command
  // the caller must upload rather than discard.
  assert.equal(recording.preRollVoicedMs, 1000);
  assert.equal(recording.voicedMs, 0);
  for (let i = 0; i < 59; i++) assert.equal(recording.push(new Float32Array(RATE * 0.1)), 'recording');
  assert.equal(recording.push(new Float32Array(RATE * 0.1)), 'silence');
  const result = recording.finish();
  assert.equal(result.length, RATE * 7.4);
  assert.deepEqual(result.subarray(0, speech.length), speech);
  assert(result.subarray(speech.length).every(sample => sample === 0));
});

test('pre-roll is retained whole while only live audio endpoints the recording', () => {
  const speech = new Float32Array(RATE * 0.4).fill(0.1);
  const trailingSilence = new Float32Array(RATE * 0.4);
  const recording = createRecording({ preRoll: [speech, trailingSilence] });
  assert.equal(recording.voicedMs, 0);
  assert.equal(recording.push(new Float32Array(RATE * 0.4)), 'recording');
  assert.equal(recording.push(new Float32Array(RATE * 0.1)), 'recording');
  for (let i = 0; i < 5; i++) assert.equal(recording.push(new Float32Array(RATE * 0.2).fill(0.1)), 'recording');
  assert.equal(recording.voicedMs, 1000);
  for (let i = 0; i < 8; i++) assert.equal(recording.push(new Float32Array(RATE * 0.1)), 'recording');
  assert.equal(recording.push(new Float32Array(RATE * 0.1)), 'complete');
  const result = recording.finish();
  assert.equal(result.length, RATE * 3.2);
  assert.deepEqual(result.subarray(0, speech.length), speech);
  assert(result.subarray(speech.length, RATE * 1.3).every(sample => sample === 0));
});

test('a voiced pre-roll waits for the speaker while a silent pre-roll still cancels', () => {
  // Endpointing cannot tell a stray word in the ring from a command; transcription does.
  // Because it cannot, the pause after the ring must not end the capture.
  const ring = createRecording({ preRoll: [new Float32Array(RATE * 0.3).fill(0.1)] });
  assert.equal(ring.push(new Float32Array(RATE * 0.9)), 'recording');
  assert.equal(ring.voicedMs, 0);
  assert.equal(ring.finish().length, RATE * 1.2);
  const silent = createRecording({ preRoll: [new Float32Array(RATE)] });
  assert.equal(silent.push(new Float32Array(RATE * 6)), 'silence');
  assert.equal(silent.voicedMs, 0);
});

test('live voice uses the configured threshold and maximum recording duration is respected', () => {
  const silent = createRecording({ threshold: 0.2, preRoll: [new Float32Array(RATE).fill(0.1)] });
  assert.equal(silent.voicedMs, 0);
  assert.equal(silent.push(new Float32Array(RATE * 6).fill(0.1)), 'silence');
  assert.equal(silent.voicedMs, 0);
  const capped = createRecording({ maxMs: 500, preRoll: [new Float32Array(RATE * 0.4).fill(0.1)] });
  assert.equal(capped.push(new Float32Array(RATE).fill(0.1)), 'complete');
  assert.equal(capped.finish().length, RATE / 2);
  const full = createRecording({ maxMs: 500, preRoll: [new Float32Array(RATE).fill(0.1), new Float32Array(RATE)] });
  assert.equal(full.voicedMs, 0);
  assert.equal(full.push(new Float32Array(RATE)), 'complete');
  assert.equal(full.finish().length, RATE / 2);
});
