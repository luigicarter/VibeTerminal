export type VoiceState = {
  phase: string; muted: boolean; listening: boolean; ready: boolean; wakeReady: boolean;
  error?: string | null; wakeError?: string | null; transcript?: string; reply?: string; replyId?: string; microphoneId?: string;
  request?: { id: string; sessionId?: string; kind?: string; detail?: string; currentQuestion?: number; questions?: { id?: string; question: string; options?: { label: string }[] }[] };
};
export type VoiceAudio = { replyId: string; sequence: number; data: number[]; sampleRate: 24000; channels: 1; format: 's16le'; done?: boolean; cancelled?: boolean; local?: boolean };
export type VoiceApi = {
  getState(): Promise<VoiceState>; onState(cb: (state: VoiceState) => void): () => void;
  configure(patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  setListening(value: boolean): Promise<{ ok: boolean; error?: string }>;
  frames(frame: { samples: number[]; sampleRate: number }): void;
  cancelSpeech(): Promise<unknown>; onAudio(cb: (chunk: VoiceAudio) => void): () => void;
};
