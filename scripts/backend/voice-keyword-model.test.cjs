const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createKeywordDetector } = require('../../backend/voiceKeywordModel.cjs');

function harness() {
  const streams = []; let speaking = false;
  class KeywordSpotter {
    constructor(config) { assert.equal(config.keywordsThreshold, 0.25); }
    createStream() {
      const frames = []; streams.push(frames);
      return { acceptWaveform({ samples }) { frames.push(Float32Array.from(samples)); } };
    }
    isReady() { return false; }
  }
  class Vad {
    reset() {} acceptWaveform() {} isDetected() { return speaking; } isEmpty() { return true; }
  }
  const detector = createKeywordDetector({ paths: { keyword: {}, vad: {} }, sherpa: { KeywordSpotter, Vad } });
  let sampleStart = 0;
  return {
    streams, detector,
    feed(value, speech = false, identity = {}) {
      speaking = speech;
      const samples = new Float32Array(320).fill(value);
      detector.process({ samples, sampleStart, captureToken: 'a', streamId: 1, mode: 'wake', ...identity });
      sampleStart += samples.length;
      assert.ok(samples.every(sample => sample === Math.fround(value)), 'never mutate caller PCM');
    },
  };
}

test('quiet onset boosts only companion with bounded gain held through the utterance', () => {
  const h = harness();
  h.feed(0.001); h.feed(0.001, true);
  assert.equal(h.streams.length, 2);
  assert.equal(h.streams[0].at(-1)[0], Math.fround(0.001));
  assert.equal(h.streams[1].at(-1)[0], Math.fround(Math.fround(0.001) * 8));
  h.feed(0.01, true);
  assert.equal(h.streams[1].at(-1)[0], Math.fround(Math.fround(0.01) * 8));
  h.feed(0.9, true); h.feed(-0.9, true);
  assert.equal(h.streams[1].at(-2)[0], 1);
  assert.equal(h.streams[1].at(-1)[0], -1);
  assert.ok(h.streams[1].flatMap(samples => [...samples]).every(sample => Number.isFinite(sample) && Math.abs(sample) <= 1));
  h.detector.dispose();
});

test('onset gain uses replay history and leaves normal level audio unchanged', () => {
  const h = harness();
  h.feed(0.5); h.feed(0.01, true);
  assert.equal(h.streams[1].at(-1)[0], Math.fround(0.01), 'preceding onset peak prevents needless boosting');
  assert.ok(h.streams[1].some(samples => samples.includes(0.5)), 'replay retains unmodified loud onset');
  h.detector.dispose();
});

test('capture changes, discontinuities and explicit reset discard gain and replay history', () => {
  for (const boundary of ['capture', 'gap', 'reset']) {
    const h = harness();
    h.feed(0.001, true);
    if (boundary === 'reset') h.detector.reset();
    h.feed(0.5, true, boundary === 'capture' ? { captureToken: 'b' } : boundary === 'gap' ? { sampleStart: 10000 } : {});
    assert.equal(h.streams.length, 4, boundary);
    assert.equal(h.streams[3].at(-1)[0], 0.5, boundary);
    assert.ok(h.streams[3].slice(0, -1).every(samples => samples.every(sample => sample === 0)), 'old replay discarded');
    h.detector.dispose();
  }
});

test('VAD-only mode never creates or amplifies keyword streams', () => {
  const h = harness(); h.feed(0.001, true, { mode: 'vad' });
  assert.equal(h.streams.length, 0); h.detector.dispose();
});
