const test = require('node:test');
const assert = require('node:assert/strict');
const { RATE, createRecording, decodeSpeechAudio, decodeSpeechWav, wavFromSamples } = require('../../backend/voiceAudio.cjs');

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

test('PCM rejects ambiguous, missing, malformed and unsupported format metadata', () => {
  for (const contentType of [
    'audio/pcm', 'audio/pcm;rate=24000', 'audio/pcm;channels=1',
    'audio/pcm;rate=24000;channels=1;RATE=24000',
    'audio/pcm;rate=24000;channels=1;channels=2',
    'audio/pcm;rate=24000;channels=1;',
    'audio/pcm;rate=24000;channels=1;encoding=float',
    'audio/pcm;rate=24000;channels=1;bits=32',
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

test('WAV compatibility uses actual headers and rejects wrong MIME or unlabelled raw audio', () => {
  const wav = wavFromSamples([-1, 0, 1], 44100);
  for (const mime of [undefined, null, '', 'application/octet-stream', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'Audio/WAV; codecs=1']) {
    assert.deepEqual(decodeSpeechAudio(wav, mime), decodeSpeechWav(wav));
    assert.throws(() => decodeSpeechAudio(Buffer.alloc(4), mime), /WAV/);
  }
  for (const mime of ['audio/mpeg', 'application/json', 'text/plain', 'audio/L16;rate=24000;channels=1']) {
    assert.throws(() => decodeSpeechAudio(wav, mime), /unsupported audio/);
  }
  const broken = Buffer.from(wav); broken.writeUInt16LE(32, 34);
  assert.throws(() => decodeSpeechAudio(broken, 'audio/wav'), /WAV/);
});

test('a short command wholly in wake pre-roll endpoints after silence and retains all samples', () => {
  const speech = new Float32Array(RATE * 0.4).fill(0.1);
  const trailingSilence = new Float32Array(RATE * 0.4);
  const recording = createRecording({ preRoll: [speech, trailingSilence] });
  assert.equal(recording.voicedMs, 400);
  assert.equal(recording.push(new Float32Array(RATE * 0.4)), 'recording');
  assert.equal(recording.push(new Float32Array(RATE * 0.1)), 'complete');
  const result = recording.finish();
  assert.equal(result.length, RATE * 1.3);
  assert.deepEqual(result.subarray(0, speech.length), speech);
  assert(result.subarray(speech.length).every(sample => sample === 0));
});

test('voiced wake-only pre-roll is retained for transcription while silent pre-roll cancels', () => {
  // Endpointing cannot distinguish a wake phrase from a command; transcription does.
  const wake = createRecording({ preRoll: [new Float32Array(RATE * 0.3).fill(0.1)] });
  assert.equal(wake.push(new Float32Array(RATE * 0.9)), 'complete');
  assert.equal(wake.voicedMs, 300);
  assert.equal(wake.finish().length, RATE * 1.2);
  const silent = createRecording({ preRoll: [new Float32Array(RATE)] });
  assert.equal(silent.push(new Float32Array(RATE * 6)), 'silence');
  assert.equal(silent.voicedMs, 0);
});

test('pre-roll voice uses the configured threshold and respects maximum recording duration', () => {
  const silent = createRecording({ threshold: 0.2, preRoll: [new Float32Array(RATE).fill(0.1)] });
  assert.equal(silent.voicedMs, 0);
  assert.equal(silent.push(new Float32Array(RATE * 6)), 'silence');
  const capped = createRecording({ maxMs: 500, preRoll: [new Float32Array(RATE * 0.4).fill(0.1)] });
  assert.equal(capped.push(new Float32Array(RATE).fill(0.1)), 'complete');
  assert.equal(capped.finish().length, RATE / 2);
  const full = createRecording({ maxMs: 500, preRoll: [new Float32Array(RATE).fill(0.1), new Float32Array(RATE)] });
  assert.equal(full.voicedMs, 500);
  assert.equal(full.push(new Float32Array(RATE)), 'complete');
  assert.equal(full.finish().length, RATE / 2);
});
