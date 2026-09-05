const RATE = 16000;
function wavFromSamples(samples, sampleRate = RATE) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); b.writeInt16LE(Math.round(s * (s < 0 ? 32768 : 32767)), 44 + i * 2); }
  return b;
}
function createRecording({ silenceMs = 900, initialSilenceMs = 6000, maxMs = 60000, threshold = 0.012, preRoll = [] } = {}) {
  let chunks = preRoll.map(c => Float32Array.from(c)), total = 0, voiced = 0, silence = 0;
  const preRollMs = chunks.reduce((n, chunk) => n + chunk.length, 0) / RATE * 1000;
  return {
    push(samples) {
      const remaining = Math.max(0, Math.floor((maxMs - preRollMs - total) / 1000 * RATE));
      if (samples.length > remaining) samples = samples.slice(0, remaining);
      if (!samples.length) return 'complete';
      const duration = samples.length / RATE * 1000;
      const rms = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
      chunks.push(Float32Array.from(samples)); total += duration;
      if (rms >= threshold) { voiced += duration; silence = 0; } else silence += duration;
      return total + preRollMs >= maxMs || (voiced >= 250 && silence >= silenceMs) ? 'complete' : (voiced < 250 && total >= initialSilenceMs ? 'silence' : 'recording');
    },
    finish() { const result = new Float32Array(chunks.reduce((n, c) => n + c.length, 0)); let at = 0; for (const c of chunks) { result.set(c, at); at += c.length; } chunks = []; return result; },
    get voicedMs() { return voiced; },
  };
}
// Network boundaries can split a signed 16-bit sample between two chunks.
function createPcmFramer() {
  let carry = Buffer.alloc(0);
  return { push(chunk) { const b = Buffer.concat([carry, Buffer.from(chunk)]); const end = b.length - b.length % 2; carry = Buffer.from(b.subarray(end)); return b.subarray(0, end); }, finish() { if (carry.length) throw Error('Speech stream ended with an incomplete PCM sample'); } };
}
function shouldSpeak({ origin, kind } = {}) { return origin === 'voice' || kind === 'interaction'; }
module.exports = { RATE, wavFromSamples, createRecording, createPcmFramer, shouldSpeak };
