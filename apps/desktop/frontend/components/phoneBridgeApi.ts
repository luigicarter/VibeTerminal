// Shared typing for the read-only phone bridge's preload namespace. Declared
// here rather than in the global Window typing so the feature stays contained.
export interface PairRequest {
  requestId: string;
  deviceName: string;
  platform: string;
  remoteAddress: string;
  expiresAt: number;
}
export interface PairedDevice {
  deviceName: string;
  platform: string;
  approvedAt: number;
}
export interface MobileBridgeStatus {
  enabled: boolean;
  listening: boolean;
  host: string;
  port: number;
  addresses: string[];
  code: string;
  desktopId: string;
  devices: PairedDevice[];
  pending: PairRequest[];
  autoApprove: boolean;
  error: string;
}
export interface MobileBridgeApi {
  getState(): Promise<MobileBridgeStatus>;
  setEnabled(enabled: boolean): Promise<MobileBridgeStatus>;
  regenerateCode(): Promise<MobileBridgeStatus>;
  respondPair(requestId: string, approve: boolean): Promise<{ ok: boolean; status?: string; error?: string }>;
  onState(callback: (status: MobileBridgeStatus) => void): () => void;
  onPairRequest(callback: (request: PairRequest) => void): () => void;
}
export const bridgeApi = (): MobileBridgeApi | undefined =>
  (window as unknown as { vibe?: { mobileBridge?: MobileBridgeApi } }).vibe?.mobileBridge;
