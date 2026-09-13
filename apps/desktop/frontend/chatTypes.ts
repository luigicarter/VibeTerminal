import type { AgentSession, ProjectWorkspace } from './types';
import type { SavedConversation } from './orchestratorHistory';
export interface ChatRow {
  chatId: string; nativeKey?: string; title: string; titleOverride?: boolean; cwd?: string;
  conversation?: SavedConversation; projectId?: string | null; paneId?: string;
  started?: boolean; pending?: boolean; provisional?: boolean; archived?: boolean;
  kind?: string; updatedAt: number; revision: number;
}
export interface ChatWorkspace { workspaces: ProjectWorkspace[]; multiSessions: AgentSession[]; activeWorkspaceId: string | null; activeView: 'multi' | 'project' }
export interface ChatBootstrap { bootId: string; recoveryNeeded: boolean; workspace: ChatWorkspace | null; drafts: Record<string, { text: string; revision: number }> }
export interface ChatsApi {
  bootstrap(legacy: ChatWorkspace | null): Promise<ChatBootstrap>;
  checkpoint(input: { workspace: ChatWorkspace; sequence: number; clientId: string }): Promise<{ saved: boolean }>;
  list(): Promise<{ chats: ChatRow[]; error?: string }>;
  refresh(input?: { cwd?: string }): Promise<{ warnings: string[] }>;
  update(input: { chatId: string; revision: number; title?: string; archived?: boolean }): Promise<ChatRow>;
  open(chatId: string): Promise<SavedConversation>;
  read(chatId: string): Promise<ChatTranscript>;
  draft(input: { owner: string; text: string; revision: number }): Promise<{ saved: boolean; revision: number }>;
  onChanged(callback: (value: { revision: number; error?: string }) => void): () => void;
  onFlush(callback: (value: { id: string }) => void): () => void;
  flushed(id: string, error?: string): void;
}
export interface ChatTranscript { title: string; messages: { role: string; text: string }[]; capturedAt: number; limited: boolean; recoveryCopy: boolean; note?: string }
