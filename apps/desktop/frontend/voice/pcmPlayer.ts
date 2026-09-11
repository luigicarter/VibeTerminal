import type { VoiceAudio } from './types';
export function decodePcm16(data: number[]) {
  if (data.length % 2) throw new Error('Incomplete PCM sample');
  const samples = new Float32Array(data.length / 2);
  for (let i = 0; i < samples.length; i++) { let n = data[i * 2] | (data[i * 2 + 1] << 8); if (n >= 32768) n -= 65536; samples[i] = n / 32768; }
  return samples;
}
export class PcmPlayer {
  private context?: AudioContext;
  private active?: string;
  private expected = 0;
  private pending = new Map<number, VoiceAudio>();
  private retired = new Set<string>();
  private sources = new Set<AudioBufferSourceNode>();
  private endAt = 0;
  private epoch = 0;
  private completion?: ReturnType<typeof setTimeout>;
  private beginning?: ReturnType<typeof setTimeout>;
  private started = false;
  private doneReply?: string;
  private chain = Promise.resolve();
  constructor(private onDone: (id: string) => void, private onError: (message: string, id?: string) => void, private onStarted?: (id: string) => void) {}
  push(chunk: VoiceAudio) {
    if (chunk.cancelled) { this.retire(chunk.replyId); if (chunk.replyId === this.active) this.stop(); return; }
    if (this.retired.has(chunk.replyId)) return;
    if (chunk.replyId !== this.active) { this.stop(); this.active = chunk.replyId; }
    if (!Number.isInteger(chunk.sampleRate) || chunk.sampleRate < 8000 || chunk.sampleRate > 48000 || ![1, 2].includes(chunk.channels) || chunk.format !== 's16le') { this.stop(); this.onError('Speech returned an unsupported audio format.', chunk.replyId); return; }
    if (chunk.sequence < this.expected) return;
    this.pending.set(chunk.sequence, chunk);
    if (this.pending.size > 256) { this.stop(); this.onError('Speech playback lost its audio order.', chunk.replyId); return; }
    const epoch = this.epoch;
    this.chain = this.chain.then(async () => {
      if (epoch !== this.epoch) return;
      this.context ??= new AudioContext(); await this.context.resume();
      if (epoch !== this.epoch) return;
      while (this.pending.has(this.expected)) {
        const next = this.pending.get(this.expected)!; this.pending.delete(this.expected++);
        if (next.data.length) {
          const samples = decodePcm16(next.data);
          if (samples.length % next.channels) throw new Error('Incomplete PCM frame');
          const buffer = this.context.createBuffer(next.channels, samples.length / next.channels, next.sampleRate);
          for (let channel = 0; channel < next.channels; channel++) {
            const values = new Float32Array(buffer.length);
            for (let i = 0; i < values.length; i++) values[i] = samples[i * next.channels + channel];
            buffer.copyToChannel(values, channel);
          }
          const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
          const when = Math.max(this.context.currentTime + 0.035, this.endAt); this.endAt = when + buffer.duration;
          this.sources.add(source); source.onended = () => { this.sources.delete(source); source.disconnect(); this.finishWhenEnded(epoch); }; source.start(when);
          if (!this.started) {
            this.started = true;
            // This reports scheduled AudioContext output, not hardware audibility.
            this.beginning = setTimeout(() => { if (epoch === this.epoch && this.active === next.replyId) this.onStarted?.(next.replyId); }, Math.max(0, when - this.context.currentTime) * 1000);
          }
        }
        if (next.done) {
          this.doneReply = next.replyId;
          this.finishWhenEnded(epoch);
        }
      }
    }).catch(() => { if (epoch === this.epoch) { this.stop(); this.onError('Speech playback failed. Check your audio output.', chunk.replyId); } });
  }
  private finishWhenEnded(epoch: number) {
    if (epoch !== this.epoch || !this.doneReply || this.sources.size || this.completion !== undefined) return;
    const id = this.doneReply;
    // A wall-clock prediction can expire while the audio context is suspended.
    // Only actual source completion may open the user's next answer window.
    this.completion = setTimeout(() => { if (epoch === this.epoch && this.active === id && !this.sources.size) { this.retire(id); this.onDone(id); } }, 80);
  }
  private retire(id: string) { this.retired.add(id); if (this.retired.size > 128) this.retired.delete(this.retired.values().next().value!); }
  stop() { this.epoch++; clearTimeout(this.completion); this.completion = undefined; clearTimeout(this.beginning); this.started = false; this.doneReply = undefined; if (this.active) this.retire(this.active); this.active = undefined; for (const s of this.sources) { try { s.stop(); } catch { /* Already ended. */ } s.disconnect(); } this.sources.clear(); this.pending.clear(); this.expected = 0; this.endAt = 0; }
  dispose() { this.stop(); void this.context?.close(); this.context = undefined; }
}
