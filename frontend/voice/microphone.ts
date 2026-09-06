// This capture is instantiated only by VoiceOverlay, never by a dock or settings view.
export const workletSource = `
class VibeCapture extends AudioWorkletProcessor {
  constructor() { super(); this.output = []; this.sum = 0; this.weight = 0; this.sampleEnd = 0; this.port.onmessage = event => { if (event.data?.flush !== undefined) { this.emit(); this.port.postMessage({ flushed: event.data.flush, sampleEnd: this.sampleEnd }); } }; }
  emit() { if (this.output.length) { this.port.postMessage({ samples: this.output, sampleStart: this.sampleEnd }); this.sampleEnd += this.output.length; this.output = []; } }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) for (const sample of input) {
      let remaining = 1;
      const ratio = sampleRate / 16000;
      while (remaining > 0.000001) {
        const weight = Math.min(remaining, ratio - this.weight);
        this.sum += sample * weight; this.weight += weight; remaining -= weight;
        if (this.weight >= ratio - 0.000001) {
          this.output.push(Math.max(-1, Math.min(1, this.sum / ratio))); this.sum = 0; this.weight = 0;
          if (this.output.length === 320) this.emit();
        }
      }
    }
    return true;
  }
}
registerProcessor('vibe-capture', VibeCapture);
`;
export class VoiceMicrophone {
  private generation = 0;
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private flushId = 0;
  private pending = new Map<number, { resolve: (end: number) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  async start(onFrame: (samples: number[], sampleStart: number) => void, microphoneId?: string, onError?: () => void) {
    this.stop(); const generation = this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
    this.stream = stream;
    try {
    stream.getAudioTracks().forEach(track => { track.onended = () => { if (generation === this.generation) onError?.(); }; });
    const context = this.context = new AudioContext({ sampleRate: 16000 });
    const url = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
    try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    if (generation !== this.generation) return;
    const node = this.node = new AudioWorkletNode(context, 'vibe-capture');
    node.onprocessorerror = () => { if (generation === this.generation) onError?.(); };
    node.port.onmessage = e => {
      if (generation !== this.generation) return;
      if (Array.isArray(e.data.samples)) onFrame(e.data.samples, e.data.sampleStart);
      else if (e.data.flushed !== undefined) {
        const pending = this.pending.get(e.data.flushed);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(e.data.flushed); pending.resolve(e.data.sampleEnd); }
      }
    };
    const mute = context.createGain(); mute.gain.value = 0;
    context.createMediaStreamSource(stream).connect(node); node.connect(mute); mute.connect(context.destination);
    await context.resume();
    } catch (error) {
      // A failed startup owns these resources only until a newer capture starts.
      if (generation === this.generation) this.stop();
      throw error;
    }
  }
  flush(): Promise<number> {
    const node = this.node;
    if (!node) return Promise.reject(new Error('Microphone capture is not active.'));
    const id = ++this.flushId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Microphone flush timed out.')); }, 1000);
      this.pending.set(id, { resolve, reject, timer });
      node.port.postMessage({ flush: id });
    });
  }
  stop() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Microphone capture changed.')); }
    this.pending.clear();
    this.generation++; this.node?.disconnect(); this.node?.port.close(); this.node = undefined;
    this.stream?.getTracks().forEach(t => { t.onended = null; t.stop(); }); this.stream = undefined;
    if (this.context) void this.context.close().catch(() => {}); this.context = undefined;
  }
}
