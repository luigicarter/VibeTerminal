// Explicit whole-utterance voice controls only. Task text containing these words
// must remain available to the orchestrator (for example, "dismiss that dialog").
function isVoiceDismissal(text) {
  const normalized = String(text || '').toLowerCase().replace(/[’‘]/g, "'")
    .replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:hey\s+)?vibe\s+/, '').replace(/\s+(?:hey\s+)?vibe$/, '')
    .replace(/^please\s+/, '').replace(/\s+please$/, '');
  return /^(?:never\s?mind|that's all|that is all|stop listening|dismiss|go back to sleep)$/.test(normalized);
}
module.exports = { isVoiceDismissal };
