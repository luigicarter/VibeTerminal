'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { createWhisperFeatures } = require('../../backend/voiceWhisperFeatures.cjs');
const { createTurnDetector } = require('../../backend/voiceTurnModel.cjs');
const { loadVoiceModels } = require('../../backend/voiceModels.cjs');
const fixtureRoot = path.join(__dirname, 'fixtures');
const reference = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'voice-whisper-reference.json')));
function samples(count) {
  if (count === 128000) return new Float32Array(count).fill(0.1);
  return Float32Array.from({ length: count }, (_, i) => i < 333 ? 0 : (((i * 7919 + i * i * 13) % 65521) - 32760) / 65536);
}
for (const fixture of reference.cases) test(`Whisper numpy parity: ${fixture.samples} samples`, () => {
  const bytes = zlib.gunzipSync(fs.readFileSync(path.join(fixtureRoot, fixture.file)));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), fixture.sha256);
  const expected = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  const actual = createWhisperFeatures()(samples(fixture.samples));
  let maxError = 0, squared = 0;
  for (let i = 0; i < actual.length; i++) { const e = Math.abs(expected[i] - actual[i]); maxError = Math.max(maxError, e); squared += e * e; }
  console.log(JSON.stringify({ samples: fixture.samples, maxError, rmsError: Math.sqrt(squared / actual.length), reference: reference.transformers }));
  assert.ok(maxError < 1e-5, `Feature max error ${maxError}`);
});
test('silence stays finite, left padding and latest window are exact', () => {
  const extract = createWhisperFeatures();
  assert.ok(extract(new Float32Array(0)).every(x => Number.isFinite(x)));
  const short = samples(6400), padded = new Float32Array(128000); padded.set(short, 121600);
  assert.deepEqual(extract(short), extract(padded));
  const long = samples(144000); assert.deepEqual(extract(long), extract(long.subarray(16000)));
  assert.throws(() => extract([NaN]), /finite/);
});
test('turn detector uses CPU one thread, sigmoid threshold, disposal and busy guard', async () => {
  let options, finish, released = false;
  const ort = {
    Tensor: class { constructor(type, data, dims) { assert.equal(type, 'float32'); assert.equal(data.length, 64000); assert.deepEqual(dims, [1, 80, 800]); } },
    InferenceSession: { async create(_path, opts) { options = opts; return { outputNames: ['output'], run() { return new Promise(resolve => { finish = resolve; }); }, async release() { released = true; } }; } },
  };
  const detector = await createTurnDetector({ modelPath: 'fake', ort });
  const pending = detector.predict(new Float32Array(0));
  await assert.rejects(detector.predict([]), /already processing/);
  finish({ output: { data: [0.5] } });
  assert.equal((await pending).complete, false);
  assert.equal(options.intraOpNumThreads, 1); assert.equal(options.interOpNumThreads, 1); assert.deepEqual(options.executionProviders, ['cpu']);
  await detector.dispose(); assert.equal(released, true);
  await assert.rejects(detector.predict([]), /disposed/);
});
test('bundled model manifest is valid and rejects modified bytes', () => {
  const root = path.resolve(__dirname, '../../vendor/voice');
  const models = loadVoiceModels(root);
  assert.ok(models.keyword.keywords.endsWith('keywords.txt'));
  for (const file of models.manifest.files.filter(file => file.content !== undefined)) {
    const bytes = Buffer.from(file.content, 'utf8');
    assert.equal(bytes.length, file.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
  const temporaryRoot = path.resolve(__dirname, '../../.tmp/handsfree-assets');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'resolver-'));
  try {
    fs.mkdirSync(path.join(directory, 'models'));
    const bytes = Buffer.from('original');
    const manifest = { version: 1, sampleRate: 16000, files: [{ path: 'tokens.txt', bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] };
    fs.writeFileSync(path.join(directory, 'models/manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(directory, 'models/tokens.txt'), 'modified');
    assert.throws(() => loadVoiceModels(directory), /checksum mismatch/);
    manifest.files[0].path = '../outside';
    fs.writeFileSync(path.join(directory, 'models/manifest.json'), JSON.stringify(manifest));
    assert.throws(() => loadVoiceModels(directory), /Invalid voice model entry/);
  } finally {
    assert.equal(path.dirname(directory), temporaryRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
