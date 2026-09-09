const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createKeywordDetector } = require('../../backend/voiceKeywordModel.cjs');

function harness() {
  const streams = []; let speaking = false, pendingKeyword;
  class KeywordSpotter {
    constructor(config) { assert.equal(config.keywordsThreshold, 0.25); assert.equal(config.maxActivePaths, 32); }
    createStream() {
      const frames = []; streams.push(frames);
      return { acceptWaveform({ samples }) { frames.push(Float32Array.from(samples)); } };
    }
    isReady() { return pendingKeyword !== undefined; }
    decode() {}
    getResult() { const keyword = pendingKeyword; pendingKeyword = undefined; return { keyword }; }
    reset() {}
  }
  class Vad {
    reset() {} acceptWaveform() {} isDetected() { return speaking; } isEmpty() { return true; }
  }
  const detector = createKeywordDetector({ paths: { keyword: {}, vad: {} }, sherpa: { KeywordSpotter, Vad }, verifierFactory: () => ({ accept() {}, onset() {}, verify() { return true; }, reset() {}, dispose() {} }) });
  let sampleStart = 0;
  return {
    streams, detector, match(keyword) { pendingKeyword = keyword; },
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

test('competing-name boundary releases reanchor cooldown only after a new quiet-separated speech onset', () => {
  for (const keyword of ['REJECT_LISA', 'REJECT_LINDA', 'UNKNOWN']) for (const quietFrames of [1, 10]) {
    const h = harness(); h.feed(0.05, true);
    h.match(keyword);
    for (let i = 0; i < quietFrames; i++) h.feed(0);
    assert.equal(h.streams.length, 2, 'a result alone cannot create a companion');
    h.feed(0.05, true);
    assert.equal(h.streams.length, quietFrames === 10 && keyword !== 'UNKNOWN' ? 3 : 2, `${keyword}, ${quietFrames * 20}ms quiet`);
    h.detector.dispose();
  }
});

test('only Lina activates; competing and unknown matches reset without consuming wake cooldown', () => {
  let nextKeyword, resets = 0, verified = false, verifications = 0;
  class KeywordSpotter {
    createStream() { return { acceptWaveform() {} }; }
    isReady() { return nextKeyword !== undefined; }
    decode() {}
    getResult() { const keyword = nextKeyword; nextKeyword = undefined; return { keyword, timestamps: [0.1, 0.3] }; }
    reset() { resets++; }
  }
  class Vad {
    reset() {} acceptWaveform() {} isDetected() { return false; } isEmpty() { return true; }
  }
  const detector = createKeywordDetector({ paths: { keyword: {}, vad: {} }, sherpa: { KeywordSpotter, Vad }, verifierFactory: () => ({ accept() {}, onset() {}, verify() { verifications++; return verified; }, reset() {}, dispose() {} }) });
  let sampleStart = 0;
  function feed(keyword) {
    nextKeyword = keyword;
    const result = detector.process({ samples: new Float32Array(320), sampleStart, captureToken: 'a', streamId: 1, mode: 'wake' });
    sampleStart += 320;
    return result.wake;
  }
  for (const keyword of ['REJECT_LISA', 'REJECT_LINDA', 'UNKNOWN']) assert.equal(feed(keyword), undefined);
  assert.equal(resets, 3, 'all recognized alternatives reset the native stream');
  assert.equal(verifications, 0, 'competing names need no second-pass inference');
  assert.equal(feed('HEY_LINA'), undefined, 'unverified Lina candidate cannot activate');
  verified = true;
  assert.equal(feed('HEY_LINA')?.keyword, 'HEY_LINA', 'rejected names do not delay a valid wake');
  for (let i = 0; i < 39; i++) assert.equal(feed(i === 38 ? 'REJECT_LINDA' : undefined), undefined);
  assert.equal(feed('HEY_LINA')?.keyword, 'HEY_LINA', 'rejected names do not extend an existing cooldown');
  assert.equal(resets, 7);
  assert.equal(verifications, 3, 'a rejected candidate never consumes wake cooldown');
  detector.dispose();
});
