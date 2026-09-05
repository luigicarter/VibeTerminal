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
  private chain = Promise.resolve();
  constructor(private onDone: (id: string) => void, private onError: (message: string) => void) {}
  push(chunk: VoiceAudio) {
    if (chunk.cancelled) { this.retire(chunk.replyId); if (chunk.replyId === this.active) this.stop(); return; }
    if (this.retired.has(chunk.replyId)) return;
    if (chunk.replyId !== this.active) { this.stop(); this.active = chunk.replyId; }
    if (chunk.sampleRate !== 24000 || chunk.channels !== 1 || chunk.format !== 's16le' || chunk.sequence < this.expected) return;
    this.pending.set(chunk.sequence, chunk);
    if (this.pending.size > 256) { this.stop(); this.onError('Speech playback lost its audio order.'); return; }
    const epoch = this.epoch;
    this.chain = this.chain.then(async () => {
      if (epoch !== this.epoch) return;
      this.context ??= new AudioContext({ sampleRate: 24000 }); await this.context.resume();
      if (epoch !== this.epoch) return;
      while (this.pending.has(this.expected)) {
        const next = this.pending.get(this.expected)!; this.pending.delete(this.expected++);
        if (next.data.length) {
          const samples = decodePcm16(next.data);
          const buffer = this.context.createBuffer(1, samples.length, 24000); buffer.copyToChannel(samples, 0);
          const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
          const when = Math.max(this.context.currentTime + 0.035, this.endAt); this.endAt = when + buffer.duration;
          this.sources.add(source); source.onended = () => { this.sources.delete(source); source.disconnect(); }; source.start(when);
        }
        if (next.done) {
          clearTimeout(this.completion);
          this.completion = setTimeout(() => { if (epoch === this.epoch) { this.retire(next.replyId); this.onDone(next.replyId); } }, Math.max(0, this.endAt - this.context.currentTime) * 1000 + 80);
        }
      }
    }).catch(() => { if (epoch === this.epoch) { this.stop(); this.onError('Speech playback failed. Check your audio output.'); } });
  }
  private retire(id: string) { this.retired.add(id); if (this.retired.size > 128) this.retired.delete(this.retired.values().next().value!); }
  stop() { this.epoch++; clearTimeout(this.completion); if (this.active) this.retire(this.active); this.active = undefined; for (const s of this.sources) { try { s.stop(); } catch { /* Already ended. */ } s.disconnect(); } this.sources.clear(); this.pending.clear(); this.expected = 0; this.endAt = 0; }
  dispose() { this.stop(); void this.context?.close(); this.context = undefined; }
}
