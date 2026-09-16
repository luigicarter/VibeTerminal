const STT_MODEL = 'openai/whisper-large-v3-turbo';
const VOICE_ENDPOINTING = Object.freeze(require('./voiceEndpointing.json'));
const validVoicePauseMs = value => Number.isInteger(value) && value >= VOICE_ENDPOINTING.minPauseMs && value <= VOICE_ENDPOINTING.maxPauseMs;
const normalizeVoicePauseMs = value => validVoicePauseMs(value) ? value : VOICE_ENDPOINTING.defaultPauseMs;
// Whisper accepts an initial prompt and biases its decoding toward the spellings
// it contains. These are the names a spoken command routes on and that a general
// transcript otherwise renders phonetically ("codecs", "Quinn", "Lena"). Project
// names are appended by the controller; the whole prompt is capped so it stays a
// vocabulary hint and never becomes context the model tries to continue.
const STT_PROMPT_NAMES = Object.freeze(['Lina', 'Lina Terminal', 'Claude Code', 'Open Claude Code', 'Codex', 'Open Codex', 'Codex Web', 'Gemini', 'Cursor', 'Grok', 'Kimi', 'Qwen']);
const STT_PROMPT_MAX_CHARS = 200;
const TTS_MODEL = 'hexgrad/kokoro-82m';
const TTS_VOICE = 'af_heart';
// Kokoro's published English presets. WAV carries its actual playback parameters.
const TTS_VOICES = Object.freeze(['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'am_michael', 'am_fenrir', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_fable']);
// Kokoro's native PCM output. Used only when a response omits its rate or channels;
// a response that declares them, or carries a WAV header, always wins.
const TTS_NATIVE_RATE = 24000;
const TTS_NATIVE_CHANNELS = 1;
module.exports = { VOICE_ENDPOINTING, validVoicePauseMs, normalizeVoicePauseMs, STT_MODEL, STT_PROMPT_NAMES, STT_PROMPT_MAX_CHARS, TTS_MODEL, TTS_VOICE, TTS_VOICES, TTS_NATIVE_RATE, TTS_NATIVE_CHANNELS };
