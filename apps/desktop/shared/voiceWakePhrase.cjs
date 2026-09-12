'use strict';
// One accepted-pronunciation list for the wake greeting. The bundled recognizer
// and the cloud transcription spell the same spoken name several ways ("Hey
// Lina", "HEY LENA", "Hey Alina", "Hey, Elena", "Here, Lina"). Every accepted
// spelling must be removed from a transcript on every input path, or the wake
// words become part of the command text.
const WAKE_GREETINGS = 'hey|he|here';
const WAKE_NAMES = 'lina|lena|alina|elena|helina';
// Leading greeting only, and only a complete name: "Hey Linaria" and
// "Show Hey Lina in the terminal" are ordinary words and stay untouched.
const WAKE_PREFIX = new RegExp(`^\\s*(?:${WAKE_GREETINGS})[\\s,!.:;—-]+(?:${WAKE_NAMES})\\b[\\s,!.:;—-]*`, 'i');
function stripWakePrefix(text) {
  return String(text ?? '').replace(WAKE_PREFIX, '');
}
module.exports = { WAKE_GREETINGS, WAKE_NAMES, WAKE_PREFIX, stripWakePrefix };
