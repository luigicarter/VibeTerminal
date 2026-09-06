const STT_MODEL = 'openai/whisper-large-v3-turbo';
const TTS_MODEL = 'hexgrad/kokoro-82m';
const TTS_VOICE = 'af_heart';
// Kokoro's published English presets. WAV carries its actual playback parameters.
const TTS_VOICES = Object.freeze(['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'am_michael', 'am_fenrir', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_fable']);
// Kokoro's native PCM output. Used only when a response omits its rate or channels;
// a response that declares them, or carries a WAV header, always wins.
const TTS_NATIVE_RATE = 24000;
const TTS_NATIVE_CHANNELS = 1;
module.exports = { STT_MODEL, TTS_MODEL, TTS_VOICE, TTS_VOICES, TTS_NATIVE_RATE, TTS_NATIVE_CHANNELS };
