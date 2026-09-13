'use strict';
// One accepted-pronunciation list for the wake greeting. The bundled recognizer
// and the cloud transcription spell the same spoken name several ways ("Hey
// Lina", "HEY LENA", "Hey Alina", "Hey, Elena", "Here, Lina"). Every accepted
// spelling must be removed from a transcript on every input path, or the wake
// words become part of the command text.
// The full variant table, including the retired "Hey Vibe" spellings and the
// filler that precedes a repeated greeting, lives in one shared module so the
// voice transcript and the orchestrator's vocabulary pass strip the same words.
const { WAKE_GREETINGS, WAKE_NAMES, WAKE_PREFIX, stripWakePhrases } = require('./wakePhraseVariants.cjs');
function stripWakePrefix(text) {
  return stripWakePhrases(text).text;
}
module.exports = { WAKE_GREETINGS, WAKE_NAMES, WAKE_PREFIX, stripWakePrefix };
