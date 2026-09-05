// This capture is instantiated only by VoiceOverlay, never by a dock or settings view.
const workletSource = `
class VibeCapture extends AudioWorkletProcessor {
  constructor() { super(); this.output = []; this.sum = 0; this.weight = 0; }
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
          if (this.output.length === 1600) { this.port.postMessage(this.output); this.output = []; }
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
  async start(onFrame: (samples: number[]) => void, microphoneId?: string, onError?: () => void) {
    this.stop(); const generation = this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
    this.stream = stream;
    stream.getAudioTracks().forEach(track => { track.onended = () => { if (generation === this.generation) onError?.(); }; });
    const context = this.context = new AudioContext({ sampleRate: 16000 });
    const url = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
    try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    if (generation !== this.generation) return;
    const node = this.node = new AudioWorkletNode(context, 'vibe-capture');
    node.onprocessorerror = () => { if (generation === this.generation) onError?.(); };
    node.port.onmessage = e => { if (generation === this.generation) onFrame(e.data as number[]); };
    const mute = context.createGain(); mute.gain.value = 0;
    context.createMediaStreamSource(stream).connect(node); node.connect(mute); mute.connect(context.destination);
    await context.resume();
  }
  stop() {
    this.generation++; this.node?.disconnect(); this.node?.port.close(); this.node = undefined;
    this.stream?.getTracks().forEach(t => { t.onended = null; t.stop(); }); this.stream = undefined;
    if (this.context) void this.context.close().catch(() => {}); this.context = undefined;
  }
}
