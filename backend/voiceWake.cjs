const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function createWakeDetector(modelPath) {
  const manifest = JSON.parse(fs.readFileSync(path.join(modelPath, 'manifest.json'), 'utf8'));
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (path.basename(name) !== name) throw Error('Invalid wake model manifest');
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(modelPath, name))).digest('hex');
    if (actual !== expected) throw Error(`Wake model checksum mismatch: ${name}`);
  }
  const sherpa = require('sherpa-onnx-node');
  const spotter = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: Object.fromEntries(['encoder', 'decoder', 'joiner'].map(n => [n, path.join(modelPath, `${n}-epoch-12-avg-2-chunk-16-left-64.int8.onnx`)])),
      tokens: path.join(modelPath, 'tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0,
    },
    keywordsFile: path.join(modelPath, 'hey-vibe.txt'), keywordsScore: 1.5, keywordsThreshold: 0.25, numTrailingBlanks: 1,
  });
  let stream = spotter.createStream();
  return {
    accept(samples) {
      stream.acceptWaveform({ sampleRate: 16000, samples: Float32Array.from(samples) });
      let found = false;
      while (spotter.isReady(stream)) { spotter.decode(stream); if (spotter.getResult(stream).keyword) found = true; }
      if (found) this.reset();
      return found;
    },
    reset() { stream = spotter.createStream(); },
    dispose() { stream = null; },
  };
}
module.exports = { createWakeDetector };
