import type { ChatBootstrap, ChatWorkspace } from './chatTypes';
const clientId = crypto.randomUUID();
let sequence = 0, latest: ChatWorkspace | undefined, pending: Promise<unknown> = Promise.resolve(), lastSerialized = '';
let boot: ChatBootstrap | undefined;
const keys = { workspaces: 'vibe-terminal:workspaces:v2', multiSessions: 'vibe-terminal:multi-sessions:v1', activeWorkspaceId: 'vibe-terminal:active-workspace:v1', activeView: 'vibe-terminal:active-view:v1' };
function legacyWorkspace(): ChatWorkspace {
  const workspaces = JSON.parse(localStorage.getItem(keys.workspaces) || '[]');
  const multiSessions = JSON.parse(localStorage.getItem(keys.multiSessions) || '[]');
  if (!Array.isArray(workspaces) || !Array.isArray(multiSessions)) throw new Error('Saved workspace is invalid. Your local data has been kept.');
  return { workspaces, multiSessions, activeWorkspaceId: localStorage.getItem(keys.activeWorkspaceId), activeView: localStorage.getItem(keys.activeView) === 'multi' ? 'multi' : 'project' };
}
export async function initializeChatPersistence() {
  if (!window.vibe?.chats) return;
  let legacy: ChatWorkspace | null = null, legacyError: unknown;
  try { legacy = legacyWorkspace(); } catch (error) { legacyError = error; }
  boot = await window.vibe.chats.bootstrap(legacy, clientId);
  if (!boot.workspace && legacyError) throw legacyError;
  if (boot.workspace) {
    localStorage.setItem(keys.workspaces, JSON.stringify(boot.workspace.workspaces));
    localStorage.setItem(keys.multiSessions, JSON.stringify(boot.workspace.multiSessions));
    if (boot.workspace.activeWorkspaceId) localStorage.setItem(keys.activeWorkspaceId, boot.workspace.activeWorkspaceId);
    else localStorage.removeItem(keys.activeWorkspaceId);
    localStorage.setItem(keys.activeView, boot.workspace.activeView);
  }
}
export const chatBootstrap = () => boot;
export function checkpointWorkspace(workspace: ChatWorkspace): Promise<unknown> {
  latest = workspace;
  if (!window.vibe?.chats) return Promise.resolve();
  const serialized = JSON.stringify(workspace);
  if (serialized === lastSerialized) return pending;
  const revision = ++sequence;
  lastSerialized = serialized;
  pending = pending.catch(() => {}).then(async () => { const result = await window.vibe!.chats!.checkpoint({ workspace, sequence: revision, clientId }); if (!result.saved) throw new Error('This workspace view has been replaced. Reload before making further changes.'); return result; }).catch(error => {
    lastSerialized = ''; window.dispatchEvent(new CustomEvent('vibe:chat-save-error', { detail: String(error) })); throw error;
  });
  return pending;
}
export async function flushChatWorkspace() { if (latest) await checkpointWorkspace(latest); else await pending; }
