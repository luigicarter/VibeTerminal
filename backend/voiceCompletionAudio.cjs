'use strict';

// One quiet bell with a short silent gap before the spoken acknowledgement.
// Match the decoded speech format so the renderer plays one continuous reply.
function createCompletionAudio(sampleRate, channels) {
  const bellFrames = Math.round(sampleRate * 0.2);
  const frames = bellFrames + Math.round(sampleRate * 0.06);
  const pcm = Buffer.alloc(frames * channels * 2);
  for (let frame = 0; frame < bellFrames; frame++) {
    const seconds = frame / sampleRate;
    const attack = Math.min(1, seconds / 0.005);
    const release = Math.min(1, (bellFrames - 1 - frame) / (sampleRate * 0.02));
    const envelope = attack * release * Math.exp(-seconds * 19);
    const tone = Math.sin(2 * Math.PI * 1046.5 * seconds) + 0.25 * Math.sin(2 * Math.PI * 1569.75 * seconds);
    const value = Math.round(32767 * 0.09 * envelope * tone);
    for (let channel = 0; channel < channels; channel++) pcm.writeInt16LE(value, (frame * channels + channel) * 2);
  }
  return { pcm, durationMs: frames * 1000 / sampleRate };
}

module.exports = { createCompletionAudio };
