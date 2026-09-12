const { WAKE_GREETINGS, WAKE_NAMES, stripWakePrefix } = require('./voiceWakePhrase.cjs');
// The same accepted wake pronunciations that are stripped from commands must be
// accepted here, otherwise "Hey Lena, never mind" reaches the relay as a task.
const LEADING_NAME = new RegExp(`^(?:${WAKE_NAMES})\\s+`);
const TRAILING_NAME = new RegExp(`\\s+(?:(?:${WAKE_GREETINGS})\\s+)?(?:${WAKE_NAMES})$`);
// Explicit whole-utterance voice controls only. Task text containing these words
// must remain available to the orchestrator (for example, "dismiss that dialog").
function isVoiceDismissal(text) {
  const spoken = String(text || '').toLowerCase().replace(/[’‘]/g, "'")
    .replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
  const normalized = stripWakePrefix(spoken)
    .replace(LEADING_NAME, '').replace(TRAILING_NAME, '')
    .replace(/^please\s+/, '').replace(/\s+please$/, '');
  return /^(?:never\s?mind|that's all|that is all|stop listening|dismiss|go back to sleep)$/.test(normalized);
}
module.exports = { isVoiceDismissal };
