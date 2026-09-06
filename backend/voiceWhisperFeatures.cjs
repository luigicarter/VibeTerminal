'use strict';
// Whisper numpy frontend: periodic Hann, reflect padding, Slaney mel filters.
// Reference: Hugging Face transformers audio_utils.py (Apache-2.0).
const SAMPLE_COUNT = 128000;
const FRAMES = 800;
const BANDS = 80;
// Match NumPy's float32 pairwise reduction (including near-constant signals).
function sumFloat32(values, offset = 0, length = values.length) {
  const f = Math.fround;
  if (length < 8) { let sum = -0; for (let i = 0; i < length; i++) sum = f(sum + values[offset + i]); return sum; }
  if (length > 128) { const half = Math.floor(length / 2 / 8) * 8; return f(sumFloat32(values, offset, half) + sumFloat32(values, offset + half, length - half)); }
  const sums = Array.from({ length: 8 }, (_, i) => values[offset + i]);
  let i = 8;
  for (; i < length - 7; i += 8) for (let j = 0; j < 8; j++) sums[j] = f(sums[j] + values[offset + i + j]);
  let sum = f(f(f(sums[0] + sums[1]) + f(sums[2] + sums[3])) + f(f(sums[4] + sums[5]) + f(sums[6] + sums[7])));
  for (; i < length; i++) sum = f(sum + values[offset + i]);
  return sum;
}
function fftPlan(n) {
  if (n === 1) return (input, start, stride, re, im) => { re[0] = input[start]; im[0] = 0; };
  const radix = n % 2 === 0 ? 2 : 5, size = n / radix;
  const child = fftPlan(size);
  const real = Array.from({ length: radix }, () => new Float64Array(size));
  const imag = Array.from({ length: radix }, () => new Float64Array(size));
  const cos = new Float64Array(n * radix), sin = new Float64Array(n * radix);
  for (let k = 0; k < n; k++) for (let j = 0; j < radix; j++) {
    cos[k * radix + j] = Math.cos(-2 * Math.PI * j * k / n);
    sin[k * radix + j] = Math.sin(-2 * Math.PI * j * k / n);
  }
  return (input, start, stride, re, im) => {
    for (let j = 0; j < radix; j++) child(input, start + j * stride, stride * radix, real[j], imag[j]);
    for (let k = 0; k < n; k++) {
      let r = 0, i = 0; const sub = k % size;
      for (let j = 0; j < radix; j++) {
        const c = cos[k * radix + j], s = sin[k * radix + j];
        r += real[j][sub] * c - imag[j][sub] * s;
        i += real[j][sub] * s + imag[j][sub] * c;
      }
      re[k] = r; im[k] = i;
    }
  };
}
const hzToMel = hz => hz < 1000 ? hz * 3 / 200 : 15 + Math.log(hz / 1000) * 27 / Math.log(6.4);
const melToHz = mel => mel < 15 ? mel * 200 / 3 : 1000 * Math.exp((mel - 15) * Math.log(6.4) / 27);
const edges = Array.from({ length: 82 }, (_, i) => melToHz(hzToMel(8000) * i / 81));
const filters = Array.from({ length: BANDS }, (_, band) => {
  const entries = [];
  for (let bin = 0; bin <= 200; bin++) {
    const hz = bin * 40;
    const weight = Math.max(0, Math.min((hz - edges[band]) / (edges[band + 1] - edges[band]), (edges[band + 2] - hz) / (edges[band + 2] - edges[band + 1]))) * 2 / (edges[band + 2] - edges[band]);
    if (weight > 0) entries.push([bin, weight]);
  }
  return entries;
});
function createWhisperFeatures() {
  const fft = fftPlan(400), re = new Float64Array(400), im = new Float64Array(400);
  const window = Float64Array.from({ length: 400 }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / 400));
  const frame = new Float64Array(400), power = new Float64Array(201);
  return samples => {
    if (!samples || !Number.isSafeInteger(samples.length)) throw new TypeError('Expected mono 16 kHz samples');
    const audio = new Float32Array(SAMPLE_COUNT), count = Math.min(samples.length, SAMPLE_COUNT);
    for (let i = 0; i < count; i++) {
      const value = samples[samples.length - count + i];
      if (!Number.isFinite(value)) throw new TypeError('Audio samples must be finite');
      audio[SAMPLE_COUNT - count + i] = value;
    }
    const mean = Math.fround(sumFloat32(audio) / SAMPLE_COUNT), squares = new Float32Array(SAMPLE_COUNT);
    for (let i = 0; i < audio.length; i++) { audio[i] = audio[i] - mean; squares[i] = audio[i] ** 2; }
    const variance = Math.fround(sumFloat32(squares) / SAMPLE_COUNT);
    const scale = Math.fround(Math.sqrt(Math.fround(variance + 1e-7)));
    for (let i = 0; i < audio.length; i++) audio[i] /= scale;
    const features = new Float32Array(BANDS * FRAMES); let maximum = -Infinity;
    for (let t = 0; t < FRAMES; t++) {
      for (let i = 0; i < 400; i++) {
        let pos = t * 160 + i - 200;
        if (pos < 0) pos = -pos;
        if (pos >= SAMPLE_COUNT) pos = 2 * SAMPLE_COUNT - 2 - pos;
        frame[i] = audio[pos] * window[i];
      }
      fft(frame, 0, 1, re, im);
      for (let i = 0; i <= 200; i++) power[i] = re[i] ** 2 + im[i] ** 2;
      for (let band = 0; band < BANDS; band++) {
        let value = 0; for (const [bin, weight] of filters[band]) value += power[bin] * weight;
        const log = Math.log10(Math.max(1e-10, value));
        features[band * FRAMES + t] = log; maximum = Math.max(maximum, log);
      }
    }
    for (let i = 0; i < features.length; i++) features[i] = (Math.max(features[i], maximum - 8) + 4) / 4;
    return features;
  };
}
module.exports = { createWhisperFeatures, SAMPLE_COUNT, FRAMES, BANDS };
