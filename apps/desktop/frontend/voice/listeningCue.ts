import { PcmPlayer } from './pcmPlayer';
import type { VoiceState } from './types';

// A brief rising pair of soft notes, distinct from the completion bell.
function listeningAudio() {
  const sampleRate = 24000;
  const data: number[] = [];
  for (let frame = 0; frame < sampleRate * 0.18; frame++) {
    const seconds = frame / sampleRate;
    const offset = seconds < 0.09 ? seconds : seconds - 0.09;
    const frequency = seconds < 0.09 ? 660 : 880;
    const envelope = Math.max(0, Math.min(1, offset / 0.006, (0.075 - offset) / 0.025));
    const sample = Math.round(32767 * 0.07 * envelope * Math.sin(2 * Math.PI * frequency * offset));
    data.push(sample & 255, (sample >> 8) & 255);
  }
  return { data, sampleRate, channels: 1 as const, format: 's16le' as const };
}

export class ListeningCue {
  // Cues never acknowledge speech or change microphone/answer ownership.
  private player = new PcmPlayer(() => {}, () => {});
  private previous?: VoiceState;
  private accepting = false;
  private sequence = 0;
  private audio?: ReturnType<typeof listeningAudio>;

  update(state: VoiceState, initial = false) {
    const accepting = state.listening && !state.muted && !state.captureRecovering
      && (state.phase === 'recording' || (state.phase === 'awaiting-answer' && state.handsFreeStatus === 'ready'));
    const newRecording = state.phase === 'recording' && this.previous?.phase === 'recording'
      && state.recordingId !== this.previous.recordingId;
    const captureChanged = this.previous && state.captureToken !== this.previous.captureToken;
    if (!accepting || captureChanged) this.player.stop();
    if (!initial && accepting && (!this.accepting || newRecording)) {
      this.audio ??= listeningAudio();
      this.player.push({ ...this.audio, replyId: `listening-${++this.sequence}`, sequence: 0, done: true });
    }
    this.accepting = accepting;
    this.previous = state;
  }

  dispose() { this.player.dispose(); this.previous = undefined; this.accepting = false; }
}
