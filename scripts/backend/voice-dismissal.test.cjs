const test = require('node:test');
const assert = require('node:assert/strict');
const { isVoiceDismissal } = require('../../shared/voiceDismissal.cjs');

test('dismissal accepts only dedicated whole utterances with optional name and politeness', () => {
  for (const text of ['never mind', 'Nevermind!', "that's all", 'that is all', 'Stop listening.', 'dismiss', 'go back to sleep', 'Hey Vibe, never mind.', 'Please stop listening, Vibe.', 'Vibe, dismiss please']) assert.equal(isVoiceDismissal(text), true, text);
  for (const text of ['', 'stop', 'cancel', 'no', 'dismiss the dialog', 'never mind the test, fix the build', "that's all the files to edit", 'tell the terminal to stop listening', 'go back to sleep after the build', 'what does dismiss mean']) assert.equal(isVoiceDismissal(text), false, text);
});
