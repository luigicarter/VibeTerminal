'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function loadVoiceModels(root) {
  const directory = path.resolve(root, 'models');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.sampleRate !== 16000 || !Array.isArray(manifest.files)) throw new Error('Unsupported voice model manifest');
  const paths = new Map();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || path.basename(file.path) !== file.path || paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid voice model entry');
    const resolved = path.join(directory, file.path), bytes = fs.readFileSync(resolved);
    if (bytes.length !== file.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Voice model checksum mismatch: ${file.path}`);
    paths.set(file.path, resolved);
  }
  const required = name => { if (!paths.has(name)) throw new Error(`Missing voice model: ${name}`); return paths.get(name); };
  return {
    keyword: Object.fromEntries(['encoder', 'decoder', 'joiner'].map(name => [name, required(`${name}-epoch-12-avg-2-chunk-16-left-64.int8.onnx`) ]).concat([['tokens', required('tokens.txt')], ['keywords', required('keywords.txt')]])),
    vad: { model: required('silero_vad.onnx') }, turn: { model: required('smart-turn-v3.2-cpu.onnx') }, manifest,
  };
}
module.exports = { loadVoiceModels };
