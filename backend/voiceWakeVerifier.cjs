'use strict';

const SAMPLE_RATE = 16000;
const WINDOW_SAMPLES = 4 * SAMPLE_RATE;
const MAX_TOKEN_AGE = 0.8 * SAMPLE_RATE;
// The bundled English recognizer spells the same Lina pronunciation in these
// forms. Require the entire greeting; a bare name or substring is insufficient.
const WAKE_PHRASE = /(?:^|\s)(?:HEY LINA|HEY LENA|HE LENA|HELINA)(?=$|\s)/g;

function createWakeVerifier({ paths, sherpa }) {
  const config = {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: { transducer: { encoder: paths.keyword.encoder, decoder: paths.keyword.decoder, joiner: paths.keyword.joiner }, tokens: paths.keyword.tokens, modelingUnit: 'bpe', bpeVocab: paths.keyword.bpeVocab, numThreads: 1, provider: 'cpu', debug: false },
    decodingMethod: 'modified_beam_search', maxActivePaths: 16, enableEndpoint: false,
    hotwordsFile: paths.keyword.hotwords, hotwordsScore: 1,
  };
  let recognizer = new sherpa.OnlineRecognizer(config);
  let quietRecognizer = new sherpa.OnlineRecognizer({ ...config, hotwordsScore: 2 });
  let history = new Float32Array(WINDOW_SAMPLES), cursor = 0, count = 0, end = null;
  let cachedEnd = null, matchedEnds = [], onsets = [];
  function reset() { cursor = 0; count = 0; end = null; cachedEnd = null; matchedEnds = []; onsets = []; }
  function onset(sampleStart) { onsets = [...onsets.slice(-1), sampleStart - 3200]; }
  function accept(samples, sampleStart) {
    if (!recognizer) throw new Error('Wake verifier is disposed.');
    if (sampleStart !== end) reset();
    const retained = samples.subarray(Math.max(0, samples.length - WINDOW_SAMPLES));
    const first = Math.min(retained.length, WINDOW_SAMPLES - cursor);
    history.set(retained.subarray(0, first), cursor);
    history.set(retained.subarray(first), 0);
    cursor = (cursor + retained.length) % WINDOW_SAMPLES;
    count = Math.min(WINDOW_SAMPLES, count + retained.length);
    end = sampleStart + samples.length;
  }
  function verify({ afterSample = -Infinity } = {}) {
    if (!recognizer) throw new Error('Wake verifier is disposed.');
    if (!count) return false;
    if (cachedEnd !== end) {
      const samples = new Float32Array(count), start = (cursor - count + WINDOW_SAMPLES) % WINDOW_SAMPLES;
      const first = Math.min(count, WINDOW_SAMPLES - start);
      samples.set(history.subarray(start, start + first)); samples.set(history.subarray(0, count - first), first);
      matchedEnds = [];
      // Fixed VAD pre-roll removes unrelated prior speech and stabilizes the
      // tiny recognizer's onset framing. The previous onset preserves spaced
      // greetings; the full window remains a fallback for continuous speech.
      const starts = [...new Set([...onsets].reverse().map(at => Math.max(0, at - (end - count))).filter(at => at < count).concat(0))];
      for (const viewStart of starts) {
        const view = samples.slice(viewStart);
        let peak = 0;
        for (const sample of view) peak = Math.max(peak, Math.abs(sample));
        const gain = Math.max(1, Math.min(8, 0.15 / Math.max(peak, 0.0001)));
        for (let i = 0; i < view.length; i++) view[i] = Math.max(-1, Math.min(1, view[i] * gain));
        // Quiet audio needs a stronger prior for this uncommon proper name.
        // Normal-level audio retains the stricter prior to reject nearby names.
        // Both decoders retain unrestricted vocabulary and use the same model.
        const decoder = gain > 1 ? quietRecognizer : recognizer;
        const stream = decoder.createStream();
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: view });
        // Flush the model's right context using silence, never future microphone
        // audio. This work stays local in the existing keyword helper process.
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(8000) });
        stream.inputFinished();
        while (decoder.isReady(stream)) decoder.decode(stream);
        const result = decoder.getResult(stream), tokens = result.tokens || [], timestamps = result.timestamps || [];
        const normalizedTokens = tokens.map(token => String(token).replaceAll('▁', ' ').toUpperCase());
        const text = normalizedTokens.join('');
        const tokenEnds = []; let offset = 0;
        for (const token of normalizedTokens) { offset += token.length; tokenEnds.push(offset); }
        for (const match of text.matchAll(WAKE_PHRASE)) {
          const tokenIndex = tokenEnds.findIndex(at => at >= match.index + match[0].length);
          const stamp = timestamps[tokenIndex];
          if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp < 0) continue;
          const sample = end - count + viewStart + Math.round(stamp * SAMPLE_RATE);
          // Text anywhere in the rolling window is not proof of this candidate.
          // Its final name token must be recent and within real captured audio.
          if (sample >= end - MAX_TOKEN_AGE && sample < end) matchedEnds.push(sample);
        }
        if (matchedEnds.some(sample => sample > afterSample)) break;
      }
      cachedEnd = end;
    }
    return matchedEnds.some(sample => sample > afterSample);
  }
  return { accept, onset, verify, reset, dispose() { reset(); history = null; recognizer = null; quietRecognizer = null; } };
}

module.exports = { createWakeVerifier };
