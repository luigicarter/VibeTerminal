'use strict';
// One accepted-pronunciation table for the spoken wake phrase, shared by the
// voice transcript path and the orchestrator's vocabulary normalizer. The
// bundled recognizer and the cloud transcription spell the same spoken name
// many ways: "Hey Lina", "HEY LENA", "Hey Alina", "Hey, Elena", "Here, Lina",
// "Hey Elina". The product's older wake phrase was "Hey Vibe", which the same
// recognizers wrote as "Hey, bye", "Hey, vibe", "Hey Vibe!", "Hey, vote",
// "Hey, but" and "He'll be". Every accepted spelling must be removed from the
// start of a transcript on every input path, or the wake words become part of
// the command text.
const WAKE_GREETINGS = "hey|he'?ll|he|here|hi";
// The current wake name. Kept separate from the retired "Vibe" spellings: the
// dismissal grammar matches a bare name, and "bye" or "but" as a bare name
// would turn ordinary sentences into voice controls.
const WAKE_NAMES = 'lina|lena|leena|alina|elina|elena|helina';
// Retired "Hey Vibe" spellings. Accepted only after a greeting.
const LEGACY_WAKE_NAMES = 'vibe|vybe|bye|vote|but';
const SEPARATOR = "[\\s,!.:;—–'\"-]+";
// "He'll be" is spelled out rather than adding "be" to the name tables: a bare
// "be" after any greeting would eat "Hey, be careful".
const WAKE_PHRASE = `(?:(?:${WAKE_GREETINGS})${SEPARATOR}(?:${WAKE_NAMES}|${LEGACY_WAKE_NAMES})|he'?ll${SEPARATOR}be)`;
// Speech before the greeting is noise only when a greeting follows it, and only
// when every word of it is a filler word. "Close it. Hey Lina" keeps its first
// sentence; "and all. Hey, Lena." and "Really not. Hey, Lena." do not.
const FILLER_WORDS = "and|all|really|not|okay|ok|so|yeah|yep|yup|um|uh|you|it|well|oh|right|no|yes|thanks|thank|now|then|alright|anyway|sorry|i'?m";
const FILLER_RUN = `(?:(?:${FILLER_WORDS})\\b[\\s,!.:;—–…"-]*){0,4}`;
// Leading greeting only, and only a complete name: "Hey Linaria" and "Show Hey
// Lina in the terminal" are ordinary words and stay untouched. The greeting may
// repeat ("Hey Lena. Hey Lena. Can you ...").
const WAKE_PREFIX = new RegExp(`^[\\s.,!?;:—–…-]*${FILLER_RUN}(?:${WAKE_PHRASE}\\b[\\s,!.:;—–…"-]*)+`, 'i');
function wakePrefixPattern(extraPhrases = []) {
  const extra = (Array.isArray(extraPhrases) ? extraPhrases : []).filter(phrase => typeof phrase === 'string' && phrase.trim())
    .map(phrase => phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, SEPARATOR));
  if (!extra.length) return WAKE_PREFIX;
  return new RegExp(`^[\\s.,!?;:—–…-]*${FILLER_RUN}(?:(?:${WAKE_PHRASE}|${extra.join('|')})\\b[\\s,!.:;—–…"-]*)+`, 'i');
}
// Returns the transcript without its wake prefix and exactly what was removed,
// so a caller can record that a prefix was stripped without keeping the text.
function stripWakePhrases(text, extraPhrases = []) {
  const value = String(text ?? '');
  const match = value.match(wakePrefixPattern(extraPhrases));
  if (!match || !match[0]) return { text: value, removed: '' };
  return { text: value.slice(match[0].length), removed: match[0] };
}
module.exports = { WAKE_GREETINGS, WAKE_NAMES, LEGACY_WAKE_NAMES, WAKE_PHRASE, WAKE_PREFIX, FILLER_WORDS, wakePrefixPattern, stripWakePhrases };
