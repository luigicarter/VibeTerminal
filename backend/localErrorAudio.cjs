const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ERROR_AUDIO_TEXT = Object.freeze({
  credits: 'OpenRouter reports insufficient credits. Please check your balance or API key spending limit.',
  auth: 'OpenRouter authentication failed. Please check your API key in settings.',
  'rate-limit': 'OpenRouter is rate limiting requests. Please try again shortly.',
  upstream: 'OpenRouter or the selected provider could not complete the request. Please try again later.',
  network: 'OpenRouter could not be reached. Please check your connection and try again.',
  timeout: 'The OpenRouter request timed out. Please try again.',
  request: 'OpenRouter rejected the request. Please check your model and settings.',
});
const MAX_AUDIO_BYTES = 24_000 * 2 * 12 + 4096;

class LocalErrorAudioError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'LocalErrorAudioError';
    this.code = 'LOCAL_ERROR_AUDIO_INVALID';
  }
}

function readBounded(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) throw new Error('Invalid asset size');
    const data = Buffer.alloc(size);
    let at = 0;
    while (at < size) {
      const count = fs.readSync(fd, data, at, size - at, at);
      if (!count) throw new Error('Truncated asset');
      at += count;
    }
    return data;
  } finally { fs.closeSync(fd); }
}

function parseWave(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) !== wav.length - 8) throw new Error('Invalid WAV header');
  let formatSeen = false;
  let pcm;
  let at = 12;
  while (at < wav.length) {
    if (at + 8 > wav.length) throw new Error('Truncated WAV chunk');
    const type = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const start = at + 8;
    if (start + size > wav.length) throw new Error('Truncated WAV data');
    if (type === 'fmt ') {
      if (formatSeen || size < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 || wav.readUInt32LE(start + 4) !== 24000 || wav.readUInt32LE(start + 8) !== 48000 || wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) throw new Error('Unsupported WAV format');
      formatSeen = true;
    } else if (type === 'data') {
      if (pcm) throw new Error('Duplicate WAV data');
      pcm = wav.subarray(start, start + size);
    }
    at = start + size + (size % 2);
  }
  if (at !== wav.length || !formatSeen || !pcm || pcm.length === 0 || pcm.length % 2 || pcm.length >= 48000 * 12) throw new Error('Invalid WAV duration or data');
  let audible = false;
  for (let i = 0; i < pcm.length; i += 2) if (Math.abs(pcm.readInt16LE(i)) > 32) { audible = true; break; }
  if (!audible) throw new Error('Silent WAV data');
  return { pcm, durationMs: pcm.length / 48 };
}

function createLocalErrorAudio({ directory = path.resolve(__dirname, '../vendor/voice/alerts') } = {}) {
  const cache = new Map();
  let manifest;
  return {
    load(category) {
      try {
        if (typeof category !== 'string' || !Object.hasOwn(ERROR_AUDIO_TEXT, category)) throw new Error('Unknown error audio category');
        if (!cache.has(category)) {
          if (!manifest) manifest = JSON.parse(readBounded(path.join(directory, 'manifest.json'), 32768).toString('utf8'));
          const asset = manifest.clips?.[category];
          if (manifest.version !== 1 || !asset || asset.file !== `${category}.wav` || asset.text !== ERROR_AUDIO_TEXT[category] || typeof asset.voice !== 'string' || !asset.voice || asset.sampleRate !== 24000 || asset.channels !== 1 || asset.format !== 's16le' || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid audio manifest');
          const wav = readBounded(path.join(directory, `${category}.wav`), MAX_AUDIO_BYTES);
          if (crypto.createHash('sha256').update(wav).digest('hex') !== asset.sha256) throw new Error('Audio checksum mismatch');
          cache.set(category, { text: asset.text, ...parseWave(wav), sampleRate: 24000, channels: 1, format: 's16le' });
        }
        const result = cache.get(category);
        return { ...result, pcm: Buffer.from(result.pcm) };
      } catch (cause) {
        throw new LocalErrorAudioError('Bundled error audio is unavailable or invalid', { cause });
      }
    },
  };
}

module.exports = { createLocalErrorAudio, LocalErrorAudioError, ERROR_AUDIO_TEXT };
