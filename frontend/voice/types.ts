export type VoiceState = {
  indicatorVisible?: boolean; captureToken?: number; phase: string; muted: boolean; listening: boolean; ready: boolean;
  handsFreeStatus?: 'off' | 'loading' | 'ready' | 'unavailable'; handsFreeError?: string | null;
  recordingSource?: 'ptt' | 'wake' | 'answer'; recordingId?: number; finishHint?: boolean;
  error?: string | null; transcript?: string; reply?: string; replyId?: string; microphoneId?: string;
  request?: { id: string; sessionId?: string; kind?: string; detail?: string; currentQuestion?: number; questions?: { id?: string; question: string; options?: { label: string }[] }[] };
};
export type VoiceAudio = { replyId: string; sequence: number; data: number[]; sampleRate: number; channels: 1 | 2; format: 's16le'; done?: boolean; cancelled?: boolean; local?: boolean };
export type VoiceResult = { ok: boolean; error?: string; status?: string; recordingSource?: 'ptt' | 'wake' | 'answer' };
export type VoiceApi = {
  getState(): Promise<VoiceState>; onState(cb: (state: VoiceState) => void): () => void;
  configure(patch: Record<string, unknown>): Promise<VoiceResult>;
  setListening(value: boolean): Promise<VoiceResult>;
  frames(frame: { samples: number[]; sampleRate: number; sampleStart: number; captureToken?: number }): void;
  onFlush(cb: (request: { id: string; captureToken: number }) => void): () => void;
  cancelSpeech(): Promise<unknown>; onAudio(cb: (chunk: VoiceAudio) => void): () => void;
};
