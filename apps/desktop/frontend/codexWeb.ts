export interface CodexWebState {
  id: string; launchToken: number; model: string; effort?: string; loggingFailed: boolean;
  route?: string; catalogPath?: string; setupRequested?: boolean; backgroundError?: boolean; cachedStartupAllowed?: boolean;
  error: { code: string; message: string; reference: string } | null;
  models: { id: string; label: string; effort?: string; efforts?: string[] }[];
  connection: { authenticated?: boolean; checkingLogin?: boolean; accountLabel?: string; configured?: boolean; full?: boolean; toolsVerified?: boolean; automatic?: boolean; loginPending?: boolean; loginPhase?: string; loginBrowser?: string };
}
export interface CodexWebApi {
  action(payload: Record<string, unknown>): Promise<{ ok: boolean; state?: CodexWebState; error?: CodexWebState['error']; process?: string; launchSettled?: boolean; attachmentPaths?: string[] }>;
  onEvent(callback: (state: CodexWebState) => void): () => void;
}
