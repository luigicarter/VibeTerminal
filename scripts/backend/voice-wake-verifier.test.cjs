const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWakeVerifier } = require('../../backend/voiceWakeVerifier.cjs');

function harness() {
  const streams = []; let result = { tokens: [' HE', 'Y', ' LI', 'N', 'A'], timestamps: [1.1, 1.2, 1.3, 1.4, 1.5] };
  class OnlineRecognizer {
    constructor(config) { assert.equal(config.modelConfig.numThreads, 1); assert.equal(config.decodingMethod, 'modified_beam_search'); assert.equal(config.maxActivePaths, 16); this.bias = config.hotwordsScore; }
    createStream() { const stream = { bias: this.bias, frames: [], acceptWaveform({ samples }) { this.frames.push(Float32Array.from(samples)); }, inputFinished() { this.finished = true; } }; streams.push(stream); return stream; }
    isReady(stream) { return !stream.decoded; }
    decode(stream) { assert.equal(stream.finished, true); stream.decoded = true; }
    getResult() { return typeof result === 'function' ? result(streams.length) : result; }
  }
  return { streams, verifier: createWakeVerifier({ paths: { keyword: {} }, sherpa: { OnlineRecognizer } }), result(value) { result = value; } };
}

test('verification is causal, normalized with bounded gain, and cached per captured position', () => {
  const h = harness(), samples = new Float32Array(32000).fill(0.001);
  h.verifier.accept(samples, 0);
  assert.equal(h.verifier.verify(), true);
  assert.equal(h.streams.length, 1);
  assert.equal(h.streams[0].frames[0].length, 32000);
  assert.equal(h.streams[0].frames[0][0], Math.fround(Math.fround(0.001) * 8));
  assert.equal(samples[0], Math.fround(0.001), 'caller PCM remains unmodified');
  assert.equal(h.streams[0].frames[1].length, 8000);
  assert.ok(h.streams[0].frames[1].every(x => x === 0), 'right context is synthetic silence');
  assert.equal(h.verifier.verify(), true);
  assert.equal(h.streams.length, 1, 'duplicate KWS paths reuse the same local transcript');
  assert.equal(h.verifier.verify({ afterSample: 24000 }), false, 'prior accepted phrase cannot approve a later candidate');
  h.verifier.accept(new Float32Array(320), 32000); h.verifier.verify();
  assert.equal(h.streams.length, 2);
  h.verifier.dispose();
});

test('only complete supported wake pronunciations with recent real-audio token times verify', () => {
  for (const [text, accepted] of [['HEY LINA', true], ['HEY LENA', true], ['HE LENA', true], ['HELINA', true], ['LINA', false], ['HEY LINDA', false], ['HEY NINA', false], ['HELLO LINA', false], ['HEY LINAC', false], ['XHELINA', false]]) {
    const h = harness(); h.result({ tokens: [text], timestamps: [1.5] }); h.verifier.accept(new Float32Array(32000), 0);
    assert.equal(h.verifier.verify(), accepted, text); h.verifier.dispose();
  }
  for (const stamp of [0.8, 2, 2.1, -1, NaN, Infinity, undefined, '1.5']) {
    const h = harness(); h.result({ tokens: ['HEY LINA'], timestamps: [stamp] }); h.verifier.accept(new Float32Array(32000), 0);
    assert.equal(h.verifier.verify(), false, `invalid, old or padded-audio timestamp ${stamp}`); h.verifier.dispose();
  }
});

test('rolling history retains at most four seconds and resets on gaps or explicit boundaries', () => {
  const h = harness(); h.result({ tokens: ['HEY LINA'], timestamps: [3.5] });
  h.verifier.accept(new Float32Array(30000).fill(0.1), 0);
  h.verifier.accept(new Float32Array(50000).fill(0.2), 30000);
  assert.equal(h.verifier.verify(), true);
  const audio = h.streams[0].frames[0];
  assert.equal(audio.length, 64000);
  assert.ok(audio.subarray(0, 14000).every(x => x === Math.fround(0.1)));
  assert.ok(audio.subarray(14000).every(x => x === Math.fround(0.2)));
  assert.equal(h.verifier.verify({ afterSample: 72000 }), false, 'token times use the rolling buffer absolute origin');
  h.verifier.accept(new Float32Array(320), 100000);
  assert.equal(h.verifier.verify(), false); assert.equal(h.streams.at(-1).frames[0].length, 320);
  h.verifier.reset(); assert.equal(h.verifier.verify(), false);
  h.verifier.dispose();
  assert.throws(() => h.verifier.accept(new Float32Array(320), 0), /disposed/);
  assert.throws(() => h.verifier.verify(), /disposed/);
});

test('phrase timestamps follow normalized token lengths including Unicode expansion', () => {
  const h = harness();
  h.result({ tokens: [' ß', '▁HE', 'Y', '▁LI', 'N', 'A'], timestamps: [0.1, 1.1, 1.2, 1.3, 1.4, 1.5] });
  h.verifier.accept(new Float32Array(32000), 0);
  assert.equal(h.verifier.verify(), true);
  assert.equal(h.verifier.verify({ afterSample: 24000 }), false);
  h.verifier.dispose();
});

test('onset views retain fixed pre-roll and prior spaced greeting, then stop after a verified match', () => {
  const h = harness();
  h.result(index => index === 1 ? { tokens: ['HEY NINA'], timestamps: [0.5] } : { tokens: ['HEY LINA'], timestamps: [2.7] });
  h.verifier.accept(new Float32Array(64000), 0);
  h.verifier.onset(16000); h.verifier.onset(48000);
  assert.equal(h.verifier.verify(), true);
  assert.equal(h.streams.length, 2, 'previous onset can retain the Hey in a spaced greeting');
  assert.equal(h.streams[0].frames[0].length, 19200, 'latest onset includes exactly 200ms pre-roll');
  assert.equal(h.streams[1].frames[0].length, 51200);
  h.verifier.reset();
  h.verifier.accept(new Float32Array(32000), 100000); h.verifier.verify();
  assert.equal(h.streams.length, 3, 'old onset anchors are discarded across capture resets');
  assert.equal(h.streams[2].frames[0].length, 32000);
  h.verifier.dispose();
});

test('stronger name bias is selected only when captured audio needs normalization', () => {
  for (const [level, bias] of [[0.001, 2], [0.03, 2], [0.15, 1], [0.5, 1]]) {
    const h = harness(); h.verifier.accept(new Float32Array(32000).fill(level), 0);
    assert.equal(h.verifier.verify(), true);
    assert.equal(h.streams[0].bias, bias, `peak ${level}`);
    h.verifier.dispose();
  }
});
