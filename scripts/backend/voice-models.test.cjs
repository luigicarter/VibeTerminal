const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadVoiceModels } = require('../../backend/voiceModels.cjs');
const names = ['encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx', 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx', 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx', 'tokens.txt', 'keywords.txt', 'silero_vad.onnx', 'smart-turn-v3.2-cpu.onnx', 'NOTICE.txt'];
function fixture(t) {
  const temporaryRoot = path.resolve(__dirname, '../../.tmp/handsfree-assets');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'groups-')), directory = path.join(root, 'models'); fs.mkdirSync(directory);
  t.after(() => { assert.equal(path.dirname(root), temporaryRoot); fs.rmSync(root, { recursive: true, force: true }); });
  const bytes = Buffer.from('fixture model');
  const manifest = { version: 1, sampleRate: 16000, files: names.map(name => ({ path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })) };
  const save = () => fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  for (const name of names) fs.writeFileSync(path.join(directory, name), bytes); save();
  return { root, directory, manifest, save, bytes };
}
test('keyword and VAD selection survives absent or corrupt completion model', t => {
  const f = fixture(t), turn = path.join(f.directory, 'smart-turn-v3.2-cpu.onnx');
  fs.unlinkSync(turn);
  const selected = loadVoiceModels(f.root, { groups: ['keyword', 'vad'] });
  assert.ok(selected.keyword.tokens); assert.ok(selected.vad.model); assert.equal(selected.turn, undefined);
  assert.throws(() => loadVoiceModels(f.root), /ENOENT/);
  assert.throws(() => loadVoiceModels(f.root, { groups: ['turn'] }), /ENOENT/);
  fs.writeFileSync(turn, 'bad');
  assert.ok(loadVoiceModels(f.root, { groups: ['keyword', 'vad'] }).keyword);
  assert.throws(() => loadVoiceModels(f.root), /checksum mismatch/);
  assert.throws(() => loadVoiceModels(f.root, { groups: ['turn'] }), /checksum mismatch/);
});
test('selected keyword and VAD corruption still fails while unrelated completion loads', t => {
  const f = fixture(t);
  for (const name of ['tokens.txt', 'silero_vad.onnx']) {
    fs.writeFileSync(path.join(f.directory, name), 'bad');
    assert.throws(() => loadVoiceModels(f.root, { groups: ['keyword', 'vad'] }), /checksum mismatch/);
    assert.ok(loadVoiceModels(f.root, { groups: ['turn'] }).turn.model);
    fs.writeFileSync(path.join(f.directory, name), f.bytes);
  }
});
test('default full verification rejects corrupted assets including unused notices', t => {
  const f = fixture(t); assert.ok(loadVoiceModels(f.root).turn.model);
  for (const name of names) {
    fs.writeFileSync(path.join(f.directory, name), 'bad');
    assert.throws(() => loadVoiceModels(f.root), /checksum mismatch/, name);
    fs.writeFileSync(path.join(f.directory, name), f.bytes);
  }
});
test('unselected entries still enforce schema, unique paths and traversal safety', t => {
  const f = fixture(t), entry = f.manifest.files.at(-1), original = { ...entry };
  for (const value of ['../outside', '..\\outside', '/outside', 'C:\\outside', 'tokens.txt:stream', '..', '.', 'file.', 'TOKENS.TXT']) {
    Object.assign(entry, original, { path: value }); f.save();
    assert.throws(() => loadVoiceModels(f.root, { groups: ['turn'] }), /Invalid voice model entry/, value);
  }
  for (const patch of [{ bytes: -1 }, { bytes: 1.5 }, { sha256: 'invalid' }]) {
    Object.assign(entry, original, patch); f.save();
    assert.throws(() => loadVoiceModels(f.root, { groups: ['turn'] }), /Invalid voice model entry/);
  }
  Object.assign(entry, original); f.save();
  for (const groups of [[], ['unknown'], '__proto__', ['toString']]) assert.throws(() => loadVoiceModels(f.root, { groups }), /Invalid voice model groups/);
  f.manifest.version = 2; f.save(); assert.throws(() => loadVoiceModels(f.root, { groups: ['turn'] }), /Unsupported/);
});
