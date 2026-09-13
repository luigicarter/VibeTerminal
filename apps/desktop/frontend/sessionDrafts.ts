import { useCallback, useSyncExternalStore, type SetStateAction } from "react";
import type { AgentSession } from './types';
import { conversationKey } from './orchestratorHistory';
import { chatBootstrap } from './chatPersistence';

export interface SessionDraft { text: string; revision: number }
const drafts = new Map<string, SessionDraft>();
const owners = new Map<string, string>();
const dirty = new Map<string, SessionDraft>();
let initialized = false, saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<unknown> = Promise.resolve();
function owner(id: string) { return owners.get(id) || 'pane:' + id; }
export function configureChatDrafts(sessions: AgentSession[]) {
  if (!initialized) { initialized = true; for (const [key, value] of Object.entries(chatBootstrap()?.drafts || {})) drafts.set(key, value); }
  let changed = false;
  for (const session of sessions) {
    const ref = session.threadRef?.id ? session.threadRef : !session.started ? session.resumeRef : undefined;
    const next = ref?.id ? 'native:' + conversationKey({ provider: ref.provider, id: ref.id, cwd: session.cwd, claudeHome: session.providerProfileId ? 'custom' : undefined, openFusion: session.openFusion }) : 'pane:' + session.id + ':' + session.launchToken;
    const previous = owner(session.id);
    if (previous === next) continue;
    // Only promote a provisional draft; A's draft never follows A -> B.
    if (previous.startsWith('pane:') && !drafts.has(next) && drafts.has(previous)) {
      drafts.set(next, drafts.get(previous)!); dirty.set(next, drafts.get(previous)!);
    }
    owners.set(session.id, next); changed = true;
  }
  if (changed) { for (const listener of listeners) listener(); void flushChatDrafts().catch(() => {}); }
}
export function flushChatDrafts(): Promise<unknown> {
  clearTimeout(saveTimer); saveTimer = undefined;
  const batch = [...dirty];
  if (!window.vibe?.chats || !batch.length) return saving;
  saving = saving.catch(() => {}).then(async () => {
    for (const [key, value] of batch) {
      const result = await window.vibe!.chats!.draft({ owner: key, ...value });
      if (!result.saved) throw new Error('A newer draft is already saved. Your text has been kept in this window.');
      if (dirty.get(key) === value) dirty.delete(key);
    }
  }).catch(error => { window.dispatchEvent(new CustomEvent('vibe:chat-save-error', { detail: String(error) })); throw error; });
  return saving;
}
const listeners = new Set<() => void>();
const empty: SessionDraft = Object.freeze({ text: "", revision: 0 });
export function readSessionDraft(id: string): SessionDraft { return drafts.get(owner(id)) || empty; }
export function writeSessionDraft(id: string, text: string, expectedRevision?: number): SessionDraft {
  const previous = readSessionDraft(id);
  if (expectedRevision !== undefined && previous.revision !== expectedRevision) throw new Error("Draft changed; read it again before replacing it.");
  if (previous.text === text) return previous;
  const next = { text, revision: previous.revision + 1 };
  const key = owner(id);
  drafts.set(key, next);
  dirty.set(key, next);
  if (!saveTimer && typeof window !== 'undefined') saveTimer = setTimeout(() => { void flushChatDrafts().catch(() => {}); }, 250);
  for (const listener of listeners) listener();
  return next;
}
export function forgetSessionDraft(id: string) { drafts.delete(owner(id)); for (const listener of listeners) listener(); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useSessionDraft(id: string): [string, (value: SetStateAction<string>) => void] {
  const draft = useSyncExternalStore(subscribe, () => readSessionDraft(id), () => empty);
  const setText = useCallback((value: SetStateAction<string>) => {
    writeSessionDraft(id, typeof value === "function" ? value(readSessionDraft(id).text) : value);
  }, [id]);
  return [draft.text, setText];
}

// The module-level bridge also stages drafts for currently unmounted panes.
// It never sends a turn or routes text into a pending question.
if (typeof window !== "undefined") window.addEventListener("vibe:composer-draft", (event) => {
  const payload = (event as CustomEvent).detail;
  if (!payload || typeof payload.id !== "string" || !payload.requestId) return;
  try {
    let draft = readSessionDraft(payload.id);
    if (payload.operation !== "get" && payload.mode !== "get") {
      const references = Array.isArray(payload.paths) ? payload.paths.filter((p: unknown) => typeof p === "string").join("\n") : "";
      const text = [typeof payload.text === "string" ? payload.text : "", references].filter(Boolean).join("\n");
      draft = writeSessionDraft(payload.id, payload.mode === "replace" ? text : [draft.text, text].filter(Boolean).join("\n"), payload.expectedRevision);
    }
    window.dispatchEvent(new CustomEvent("vibe:composer-draft-result", { detail: { id: payload.id, requestId: payload.requestId, ok: true, status: "staged", ...draft } }));
  } catch (error) {
    window.dispatchEvent(new CustomEvent("vibe:composer-draft-result", { detail: { id: payload.id, requestId: payload.requestId, ok: false, error: String(error) } }));
  }
});
