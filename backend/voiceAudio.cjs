const { TTS_NATIVE_RATE, TTS_NATIVE_CHANNELS } = require('../shared/voiceConfig.cjs');
const RATE = 16000;
function wavFromSamples(samples, sampleRate = RATE) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); b.writeInt16LE(Math.round(s * (s < 0 ? 32768 : 32767)), 44 + i * 2); }
  return b;
}
function createRecording({ silenceMs = 900, initialSilenceMs = 6000, maxMs = 60000, threshold = 0.012, preRoll = [], endpointing = true } = {}) {
  let chunks = [], total = 0, voiced = 0, silence = 0, preRollVoiced = 0;
  const voicedMsOf = samples => Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length) >= threshold ? samples.length / RATE * 1000 : 0;
  const accountVoice = samples => {
    const duration = voicedMsOf(samples);
    if (duration) { voiced += duration; silence = 0; } else silence += samples.length / RATE * 1000;
  };
  let remainingPreRoll = Math.max(0, Math.floor(maxMs / 1000 * RATE));
  // Pre-roll is microphone history from before the recording started. It is kept for
  // transcription but must not endpoint the recording: charging its trailing silence
  // to the budget below closed the capture before the speaker started their command.
  // Its voiced duration is measured separately so a caller can judge a whole turn.
  for (const chunk of preRoll) {
    const samples = Float32Array.from(chunk.slice(0, remainingPreRoll));
    if (!samples.length) continue;
    chunks.push(samples); remainingPreRoll -= samples.length; preRollVoiced += voicedMsOf(samples);
    if (!remainingPreRoll) break;
  }
  const preRollMs = chunks.reduce((n, chunk) => n + chunk.length, 0) / RATE * 1000;
  return {
    push(samples) {
      const remaining = Math.max(0, Math.floor((maxMs - preRollMs - total) / 1000 * RATE));
      if (samples.length > remaining) samples = samples.slice(0, remaining);
      if (!samples.length) return 'complete';
      const duration = samples.length / RATE * 1000;
      chunks.push(Float32Array.from(samples)); total += duration;
      accountVoice(samples);
      if (total + preRollMs >= maxMs) return 'complete';
      // Push-to-talk turns are ended by the key, so only the maximum cap may close them.
      if (!endpointing) return 'recording';
      return voiced >= 250 && silence >= silenceMs ? 'complete' : (voiced < 250 && total >= initialSilenceMs ? 'silence' : 'recording');
    },
    // Completion inference reads a bounded tail without consuming the recording.
    tail(maxSamples = RATE * 8) { const size = Math.min(maxSamples, chunks.reduce((n, c) => n + c.length, 0)); const result = new Float32Array(size); let at = size; for (let i = chunks.length - 1; i >= 0 && at; i--) { const c = chunks[i], take = Math.min(at, c.length); at -= take; result.set(c.subarray(c.length - take), at); } return result; },
    finish() { const result = new Float32Array(chunks.reduce((n, c) => n + c.length, 0)); let at = 0; for (const c of chunks) { result.set(c, at); at += c.length; } chunks = []; return result; },
    get voicedMs() { return voiced; },
    get preRollVoicedMs() { return preRollVoiced; },
  };
}
function shouldSpeak({ origin, kind } = {}) { return origin === 'voice' || kind === 'interaction'; }
function decodedPcm(pcm, sampleRate, channels, invalid) {
  if (!pcm.length || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000 || ![1, 2].includes(channels) || pcm.length % (channels * 2)) invalid();
  const durationMs = pcm.length / (sampleRate * channels * 2) * 1000;
  if (durationMs > 180000) throw Error('Speech exceeded the three-minute playback limit.');
  return { pcm, sampleRate, channels, durationMs };
}
function decodeSpeechAudio(input, contentType = '') {
  const invalid = () => { throw Error('Speech returned invalid or unsupported audio or PCM metadata.'); };
  if (contentType == null) contentType = '';
  if (typeof contentType !== 'string' || contentType.length > 1024) invalid();
  const [mime, ...parameters] = contentType.toLowerCase().split(';').map(part => part.trim());
  // Bound the complete recording before copying, allowing space for WAV headers.
  const length = input?.byteLength ?? input?.length;
  if (!Number.isSafeInteger(length) || length <= 0) invalid();
  if (length > 36 * 1024 * 1024) throw Error('Speech exceeded the audio size limit.');
  if (mime === 'audio/pcm') {
    const values = new Map();
    for (const parameter of parameters) {
      const named = /^([^=]+?)\s*=\s*(.*)$/.exec(parameter);
      if (!named) continue;
      // A parameter that contradicts signed 16-bit little-endian cannot be ignored:
      // decoding float or 32-bit data as s16le is noise, not a wrong-sounding voice.
      if (['bits', 'bitspersample'].includes(named[1]) && named[2] !== '16') invalid();
      if (['encoding', 'format'].includes(named[1]) && !['pcm', 'lpcm', 's16le', 'pcm_s16le', 'signed-integer'].includes(named[2])) invalid();
      if (['endian', 'endianness'].includes(named[1]) && !['le', 'little', 'little-endian'].includes(named[2])) invalid();
      // Anything else descriptive (charset, codecs, ...) is not disqualifying; only a
      // malformed value for a parameter we actually read is.
      if (!['rate', 'channels'].includes(named[1])) continue;
      const value = /^(?:([0-9]+)|"([0-9]+)")$/.exec(named[2]);
      if (!value || values.has(named[1])) invalid();
      values.set(named[1], Number(value[1] ?? value[2]));
    }
    // OpenRouter PCM is signed 16-bit little-endian; an omitted rate or channel count
    // falls back to the speech model's native output rather than failing the reply.
    return decodedPcm(Buffer.from(input), values.get('rate') ?? TTS_NATIVE_RATE, values.get('channels') ?? TTS_NATIVE_CHANNELS, invalid);
  }
  if (['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(mime)) return decodeSpeechWav(input);
  if (['', 'application/octet-stream'].includes(mime)) {
    // Unlabelled bodies are whatever they actually are: a WAV container, else raw PCM.
    const body = Buffer.from(input);
    return body.length >= 12 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WAVE'
      ? decodeSpeechWav(body)
      : decodedPcm(body, TTS_NATIVE_RATE, TTS_NATIVE_CHANNELS, invalid);
  }
  invalid();
}
function decodeSpeechWav(input) {
  const b = Buffer.from(input);
  const invalid = () => { throw Error('Speech returned an invalid or unsupported WAV recording.'); };
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') invalid();
  let format, pcm;
  const declared = b.readUInt32LE(4);
  if (declared !== 0xffffffff && declared + 8 !== b.length) invalid();
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString('ascii', at, at + 4), size = b.readUInt32LE(at + 4), start = at + 8;
    const end = size === 0xffffffff && id === 'data' ? b.length : start + size;
    if (end > b.length) invalid();
    if (id === 'fmt ') {
      if (size < 16 || format) invalid();
      format = { encoding: b.readUInt16LE(start), channels: b.readUInt16LE(start + 2), sampleRate: b.readUInt32LE(start + 4), byteRate: b.readUInt32LE(start + 8), align: b.readUInt16LE(start + 12), bits: b.readUInt16LE(start + 14) };
    }
    if (id === 'data') { if (pcm) invalid(); pcm = b.subarray(start, end); }
    at = end + (size % 2);
  }
  if (!format || !pcm?.length || format.encoding !== 1 || format.bits !== 16 || ![1, 2].includes(format.channels) || format.sampleRate < 8000 || format.sampleRate > 48000 || format.align !== format.channels * 2 || format.byteRate !== format.sampleRate * format.align || pcm.length % format.align) invalid();
  return decodedPcm(pcm, format.sampleRate, format.channels, invalid);
}

// PCM can be played once its metadata and complete sample frames are known.
// Containers must remain buffered until their complete structure is validated.
function createSpeechAudioStream(contentType = '') {
  if (contentType != null && (typeof contentType !== 'string' || contentType.length > 1024)) throw Error('Speech returned invalid or unsupported audio or PCM metadata.');
  const mime = String(contentType ?? '').trim().split(';')[0].trim().toLowerCase();
  let mode = ['', 'application/octet-stream'].includes(mime) ? 'sniff'
    : ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(mime) ? 'wav' : 'pcm';
  let metadata = mode === 'pcm' ? decodeSpeechAudio(Buffer.alloc(4), contentType) : null;
  let pending = Buffer.alloc(0), buffered = [], bytes = 0, pcmBytes = 0, initialChunk = true, ended = false;
  const invalid = () => { throw Error('Speech returned invalid or unsupported audio or PCM metadata.'); };
  const select = () => {
    mode = pending.length >= 12 && pending.toString('ascii', 0, 4) === 'RIFF' && pending.toString('ascii', 8, 12) === 'WAVE' ? 'wav' : 'pcm';
    if (mode === 'pcm') metadata = decodeSpeechAudio(Buffer.alloc(4), 'audio/pcm');
  };
  function drain(final = false) {
    const chunks = [];
    if (mode !== 'pcm') return chunks;
    const { sampleRate, channels } = metadata, frameBytes = channels * 2;
    if (final && (!pcmBytes || pending.length % frameBytes)) invalid();
    while (pending.length) {
      const size = (initialChunk ? Math.ceil(sampleRate / 10) : sampleRate) * frameBytes;
      if (pending.length < size && !final) break;
      const take = Math.min(size, pending.length);
      chunks.push({ pcm: pending.subarray(0, take), sampleRate, channels });
      pending = pending.subarray(take); initialChunk = false;
    }
    return chunks;
  }
  return {
    push(raw) {
      if (ended) throw Error('Speech audio stream already ended.');
      const length = raw?.byteLength ?? raw?.length;
      if (!Number.isSafeInteger(length) || length < 0) invalid();
      if (bytes + length > 48000 * 4 * 180 + 65536 || bytes + length > 36 * 1024 * 1024) throw Error('Speech exceeded the audio size limit.');
      const chunk = Buffer.from(raw); bytes += chunk.length;
      if (mode === 'wav') { buffered.push(chunk); return []; }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      if (mode === 'sniff') {
        if (pending.length < 12) return [];
        select();
        if (mode === 'wav') { buffered.push(pending); pending = Buffer.alloc(0); return []; }
        pcmBytes = bytes;
      } else pcmBytes += chunk.length;
      if (pcmBytes > metadata.sampleRate * metadata.channels * 2 * 180) throw Error('Speech exceeded the three-minute playback limit.');
      return drain();
    },
    finish() {
      if (ended) throw Error('Speech audio stream already ended.');
      ended = true;
      if (mode === 'sniff') { select(); pcmBytes = bytes; }
      if (mode === 'wav') {
        const audio = decodeSpeechAudio(Buffer.concat(buffered), contentType);
        metadata = audio; pending = audio.pcm; pcmBytes = pending.length; mode = 'pcm';
        initialChunk = false; // Buffered WAV gains nothing from a shorter first node.
      }
      const chunks = drain(true);
      return { chunks, sampleRate: metadata.sampleRate, channels: metadata.channels,
        durationMs: pcmBytes / (metadata.sampleRate * metadata.channels * 2) * 1000 };
    }
  };
}
module.exports = { RATE, wavFromSamples, createRecording, shouldSpeak, decodeSpeechWav, decodeSpeechAudio, createSpeechAudioStream };
