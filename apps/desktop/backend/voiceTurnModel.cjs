'use strict';
const { performance } = require('node:perf_hooks');
const { createWhisperFeatures } = require('./voiceWhisperFeatures.cjs');
async function createTurnDetector({ modelPath, ort = require('onnxruntime-node') }) {
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1,
    executionMode: 'sequential', graphOptimizationLevel: 'all',
  });
  const extract = createWhisperFeatures();
  let disposed = false, busy = false;
  return {
    async predict(samples) {
      if (disposed) throw new Error('Turn detector disposed');
      if (busy) throw new Error('Turn detector already processing');
      busy = true;
      try {
        const start = performance.now();
        const features = extract(samples);
        const prepared = performance.now();
        const outputs = await session.run({ input_features: new ort.Tensor('float32', features, [1, 80, 800]) });
        const finished = performance.now();
        const probability = Number(outputs[session.outputNames[0]].data[0]);
        if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid completion probability');
        return { probability, complete: probability > 0.5, totalMs: finished - start, preprocessingMs: prepared - start, inferenceMs: finished - prepared };
      } finally { busy = false; }
    },
    async dispose() { if (!disposed) { disposed = true; await session.release(); } },
  };
}
module.exports = { createTurnDetector };
