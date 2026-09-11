const test = require('node:test');
const assert = require('node:assert/strict');
const { RATE, createRecording } = require('../../backend/voiceAudio.cjs');

// Shape taken from a live capture: the ring handed over when the key goes down held
// [0 x8, 0.0267, 0.15116, 0.07191, 0.13712, 0.07074, 0.01346, 0.00126, 0 x4] and the
// speaker had not started their command yet. Pre-roll silence must not spend the
// trailing-silence budget the speaker needs before they begin.
const FRAME = 1600; // 100 ms at 16 kHz, matching the renderer's capture frames.
const silent = () => new Float32Array(FRAME);
const voiced = () => new Float32Array(FRAME).fill(0.1);
const ringPreRoll = () => [...Array(8).fill(0).map(silent), ...Array(6).fill(0).map(voiced), ...Array(5).fill(0).map(silent)];

test('pre-roll silence does not consume the speaker trailing-silence budget', () => {
  const recording = createRecording({ preRoll: ringPreRoll() });
  // The speaker pauses for 1.2 s after pressing the key before starting their command.
  for (let i = 0; i < 12; i++) assert.equal(recording.push(silent()), 'recording', `closed early at live frame ${i + 1}`);
});

test('a command spoken after the opening pause is captured whole with its pre-roll', () => {
  const recording = createRecording({ preRoll: ringPreRoll() });
  for (let i = 0; i < 15; i++) assert.equal(recording.push(silent()), 'recording');
  for (let i = 0; i < 11; i++) assert.equal(recording.push(voiced()), 'recording');
  for (let i = 0; i < 8; i++) assert.equal(recording.push(silent()), 'recording', `closed at trailing silent frame ${i + 1}`);
  assert.equal(recording.push(silent()), 'complete');
  // 19 pre-roll frames + 15 + 11 + 9 live frames, nothing dropped.
  assert.equal(recording.finish().length, (19 + 15 + 11 + 9) * FRAME);
});

test('an endpointed recording with no command gives up only after the initial silence grace', () => {
  const recording = createRecording({ preRoll: ringPreRoll() });
  let state;
  for (let i = 0; i < 59; i++) { state = recording.push(silent()); assert.equal(state, 'recording', `gave up early at live frame ${i + 1}`); }
  assert.equal(recording.push(silent()), 'silence');
});

test('silent pre-roll followed by speech endpoints on the trailing pause as before', () => {
  const recording = createRecording({ preRoll: [new Float32Array(RATE)] });
  for (let i = 0; i < 5; i++) assert.equal(recording.push(voiced()), 'recording');
  for (let i = 0; i < 8; i++) assert.equal(recording.push(silent()), 'recording');
  assert.equal(recording.push(silent()), 'complete');
  assert.equal(recording.finish().length, RATE + 14 * FRAME);
});

test('a push-to-talk recording is never endpointed; only the maximum cap closes it', () => {
  const recording = createRecording({ preRoll: ringPreRoll(), endpointing: false });
  // Neither the trailing pause after speech nor a minute of silence may end the turn.
  for (let i = 0; i < 11; i++) assert.equal(recording.push(voiced()), 'recording');
  for (let i = 0; i < 200; i++) assert.equal(recording.push(silent()), 'recording', `closed at silent frame ${i + 1}`);
  assert.equal(recording.voicedMs, 1100);
  const capped = createRecording({ maxMs: 2000, endpointing: false, preRoll: [voiced()] });
  for (let i = 0; i < 18; i++) assert.equal(capped.push(voiced()), 'recording');
  assert.equal(capped.push(voiced()), 'complete');
  assert.equal(capped.finish().length, RATE * 2);
});
