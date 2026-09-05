const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLocalErrorAudio, LocalErrorAudioError, ERROR_AUDIO_TEXT } = require('../../backend/localErrorAudio.cjs');
const directory = path.resolve(__dirname, '../../vendor/voice/alerts');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const invalid = error => error instanceof LocalErrorAudioError && error.code === 'LOCAL_ERROR_AUDIO_INVALID';

test('every bundled error clip matches its manifest and contains short audible PCM', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const loader = createLocalErrorAudio({ directory });
  assert.equal(Object.keys(manifest.clips).length, 7);
  for (const [category, text] of Object.entries(ERROR_AUDIO_TEXT)) {
    const wav = fs.readFileSync(path.join(directory, `${category}.wav`));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(hash(wav), manifest.clips[category].sha256);
    const audio = loader.load(category);
    assert.equal(audio.text, text);
    assert.equal(audio.sampleRate, 24000);
    assert.equal(audio.channels, 1);
    assert.equal(audio.format, 's16le');
    assert.ok(audio.durationMs > 1000 && audio.durationMs < 12000);
    assert.equal(audio.pcm.length % 2, 0);
    let energy = 0;
    for (let i = 0; i < audio.pcm.length; i += 2) energy += audio.pcm.readInt16LE(i) ** 2;
    assert.ok(energy / (audio.pcm.length / 2) > 100, `${category} should contain speech energy`);
  }
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-error-audio-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  fs.copyFileSync(path.join(directory, 'credits.wav'), path.join(root, 'credits.wav'));
  const writeManifest = () => fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  writeManifest();
  return { root, manifest, writeManifest, loader: () => createLocalErrorAudio({ directory: root }) };
}

test('unknown categories and traversal strings are rejected without asset reads', () => {
  const loader = createLocalErrorAudio({ directory: 'does-not-exist' });
  for (const category of ['../credits', 'constructor', '__proto__', 'unknown', '', null, {}]) assert.throws(() => loader.load(category), invalid);
});

test('missing assets and malformed manifests fail with a local typed error', t => {
  const { root, loader } = fixture(t);
  fs.unlinkSync(path.join(root, 'credits.wav'));
  assert.throws(() => loader().load('credits'), invalid);
  fs.writeFileSync(path.join(root, 'manifest.json'), '{');
  assert.throws(() => loader().load('credits'), invalid);
});

test('corrupt WAV checksum and changed manifest paths are rejected', t => {
  const { root, manifest, writeManifest, loader } = fixture(t);
  const filename = path.join(root, 'credits.wav');
  const wav = fs.readFileSync(filename); wav[wav.length - 10] ^= 1;
  fs.writeFileSync(filename, wav);
  assert.throws(() => loader().load('credits'), invalid);
  manifest.clips.credits.file = '../credits.wav'; writeManifest();
  assert.throws(() => loader().load('credits'), invalid);
});

test('malformed WAV with a matching checksum is still rejected', t => {
  const { root, manifest, writeManifest, loader } = fixture(t);
  const filename = path.join(root, 'credits.wav');
  const wav = fs.readFileSync(filename); wav.write('NOPE', 8, 'ascii');
  fs.writeFileSync(filename, wav);
  manifest.clips.credits.sha256 = hash(wav); writeManifest();
  assert.throws(() => loader().load('credits'), invalid);
});

test('wrong PCM format and silent audio are rejected even with matching hashes', t => {
  const { root, manifest, writeManifest, loader } = fixture(t);
  const filename = path.join(root, 'credits.wav');
  const original = fs.readFileSync(filename);
  let formatAt, dataAt, dataSize;
  for (let at = 12; at < original.length;) {
    const size = original.readUInt32LE(at + 4);
    const type = original.toString('ascii', at, at + 4);
    if (type === 'fmt ') formatAt = at + 8;
    if (type === 'data') { dataAt = at + 8; dataSize = size; }
    at += 8 + size + size % 2;
  }
  const wrongRate = Buffer.from(original); wrongRate.writeUInt32LE(16000, formatAt + 4);
  const silent = Buffer.from(original); silent.fill(0, dataAt, dataAt + dataSize);
  for (const wav of [wrongRate, silent]) {
    fs.writeFileSync(filename, wav);
    manifest.clips.credits.sha256 = hash(wav); writeManifest();
    assert.throws(() => loader().load('credits'), invalid);
  }
});

test('oversized assets and manifests are bounded', t => {
  const { root, loader } = fixture(t);
  fs.writeFileSync(path.join(root, 'credits.wav'), Buffer.alloc(600000));
  assert.throws(() => loader().load('credits'), invalid);
  fs.writeFileSync(path.join(root, 'manifest.json'), ' '.repeat(32769));
  assert.throws(() => loader().load('credits'), invalid);
});

test('validated clips are cached and callers cannot mutate cached PCM', t => {
  const { root, loader } = fixture(t);
  const cached = loader();
  const first = cached.load('credits');
  const expected = hash(first.pcm);
  first.pcm.fill(0);
  fs.unlinkSync(path.join(root, 'credits.wav'));
  assert.equal(hash(cached.load('credits').pcm), expected);
});
