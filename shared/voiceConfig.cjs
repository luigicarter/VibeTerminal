const STT_MODEL = 'openai/whisper-large-v3-turbo';
const TTS_MODEL = 'hexgrad/kokoro-82m';
const TTS_VOICE = 'af_heart';
// Kokoro's published English presets. WAV carries its actual playback parameters.
const TTS_VOICES = Object.freeze(['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'am_michael', 'am_fenrir', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_fable']);
module.exports = { STT_MODEL, TTS_MODEL, TTS_VOICE, TTS_VOICES };
