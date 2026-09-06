const { performance } = require('node:perf_hooks');

function createKeywordDetector({ paths, sherpa = require('sherpa-onnx-node') }) {
  let spotter = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder: paths.keyword.encoder, decoder: paths.keyword.decoder, joiner: paths.keyword.joiner }, tokens: paths.keyword.tokens, numThreads: 1, provider: 'cpu', debug: false },
    keywordsFile: paths.keyword.keywords, maxActivePaths: 4, numTrailingBlanks: 1, keywordsScore: 1, keywordsThreshold: 0.25
  });
  let vad = new sherpa.Vad({ sileroVad: { model: paths.vad.model, threshold: 0.5, minSpeechDuration: 0.064, minSilenceDuration: 0.032, windowSize: 512, maxSpeechDuration: 60 }, sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: false }, 65);
  let primary = null, companion = null, identity = null, origin = 0, expected = null, lastWake = -Infinity;
  let history = new Float32Array(0), lastSpeech = -Infinity, lastCompanion = -Infinity;
  function reset() {
    primary = null; companion = null; identity = null; expected = null; lastWake = -Infinity;
    history = new Float32Array(0); lastSpeech = -Infinity; lastCompanion = -Infinity; vad?.reset();
  }
  function process(frame) {
    if (!spotter || !vad) throw new Error('Keyword detector is disposed.');
    const started = performance.now();
    const key = JSON.stringify([frame.captureToken, frame.streamId, frame.mode]);
    if (key !== identity || frame.sampleStart !== expected) {
      reset(); identity = key; origin = frame.sampleStart;
      if (frame.mode === 'wake') primary = spotter.createStream();
    }
    expected = frame.sampleStart + frame.samples.length;
    vad.acceptWaveform(frame.samples);
    let speech = vad.isDetected();
    // Drain completed segments so native buffering stays bounded even for long sessions.
    while (!vad.isEmpty()) { speech = true; vad.pop(); }
    let wake;
    function decode(stream) {
      while (spotter.isReady(stream)) {
        spotter.decode(stream);
        // Native result retrieval clears the matched keyword; never read it twice.
        const result = spotter.getResult(stream);
        if (result.keyword) {
          const stamps = result.timestamps || [];
          const first = Number(stamps[0]) || 0;
          const last = Number(stamps[stamps.length - 1]) || first;
          // Upstream's internal silence resets restart token timestamps without
          // exposing a reset epoch. Use the detection sample as a conservative
          // upper bound; these positions must never be used to trim recordings.
          if (expected - lastWake >= 12800) {
            wake = { keyword: result.keyword, startSample: Math.max(origin, expected - Math.round(Math.max(0, last - first) * 16000)), lastTokenSample: expected, timingApproximate: true };
            lastWake = expected;
          }
          spotter.reset(stream);
        }
      }
    }
    if (primary) {
      primary.acceptWaveform({ sampleRate: 16000, samples: frame.samples });
      decode(primary);
      // Preserve the continuous stream. Re-anchor only the companion at a new
      // speech onset following 200ms of VAD quiet, at most once per two seconds.
      // Replay 300ms so VAD's confirmation delay cannot cut off initial sounds.
      if (speech && frame.sampleStart - lastSpeech >= 3200 && frame.sampleStart - lastCompanion >= 32000) {
        companion = spotter.createStream(); lastCompanion = frame.sampleStart;
        // Normalize the first onset too: short startup history otherwise makes
        // the companion identical to the primary at unlucky chunk alignments.
        const replay = new Float32Array(4800);
        replay.set(history, replay.length - history.length);
        for (let offset = 0; offset < replay.length; offset += 320) {
          companion.acceptWaveform({ sampleRate: 16000, samples: replay.subarray(offset, offset + 320) });
          decode(companion);
        }
      }
      if (companion) { companion.acceptWaveform({ sampleRate: 16000, samples: frame.samples }); decode(companion); }
      if (speech) lastSpeech = frame.sampleStart;
      const retained = new Float32Array(Math.min(4800, history.length + frame.samples.length));
      const joined = new Float32Array(history.length + frame.samples.length);
      joined.set(history); joined.set(frame.samples, history.length);
      retained.set(joined.subarray(joined.length - retained.length)); history = retained;
    }
    return { captureToken: frame.captureToken, streamId: frame.streamId, sampleStart: frame.sampleStart, sampleEnd: expected, speech, ...(wake ? { wake } : {}), processingMs: performance.now() - started };
  }
  return { process, reset, dispose() { primary = null; companion = null; history = null; spotter = null; vad = null; } };
}
module.exports = { createKeywordDetector };
