'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const GROUPS = {
  keyword: { encoder: 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx', decoder: 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx', joiner: 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx', tokens: 'tokens.txt', keywords: 'keywords.txt' },
  vad: { model: 'silero_vad.onnx' }, turn: { model: 'smart-turn-v3.2-cpu.onnx' },
};
function loadVoiceModels(root, { groups } = {}) {
  if (groups !== undefined && (!Array.isArray(groups) || !groups.length || groups.some(group => !Object.hasOwn(GROUPS, group)))) throw new Error('Invalid voice model groups');
  const selected = groups === undefined ? null : new Set(groups.flatMap(group => Object.values(GROUPS[group])));
  const directory = path.resolve(root, 'models');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.sampleRate !== 16000 || !Array.isArray(manifest.files)) throw new Error('Unsupported voice model manifest');
  const paths = new Map(), entries = new Set();
  for (const file of manifest.files) {
    // Validate every entry, including unselected groups, before touching its path.
    if (!file || typeof file.path !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file.path) || file.path.endsWith('.') || entries.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid voice model entry');
    entries.add(file.path.toLowerCase());
    if (selected && !selected.has(file.path)) continue;
    const resolved = path.join(directory, file.path), bytes = fs.readFileSync(resolved);
    if (bytes.length !== file.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Voice model checksum mismatch: ${file.path}`);
    paths.set(file.path, resolved);
  }
  const required = name => { if (!paths.has(name)) throw new Error(`Missing voice model: ${name}`); return paths.get(name); };
  return { ...Object.fromEntries((groups || Object.keys(GROUPS)).map(group => [group, Object.fromEntries(Object.entries(GROUPS[group]).map(([key, file]) => [key, required(file)]))])), manifest };
}
module.exports = { loadVoiceModels };
