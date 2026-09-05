import { useCallback, useSyncExternalStore, type SetStateAction } from "react";

export interface SessionDraft { text: string; revision: number }
const drafts = new Map<string, SessionDraft>();
const listeners = new Set<() => void>();
const empty: SessionDraft = Object.freeze({ text: "", revision: 0 });
export function readSessionDraft(id: string): SessionDraft { return drafts.get(id) || empty; }
export function writeSessionDraft(id: string, text: string, expectedRevision?: number): SessionDraft {
  const previous = readSessionDraft(id);
  if (expectedRevision !== undefined && previous.revision !== expectedRevision) throw new Error("Draft changed; read it again before replacing it.");
  if (previous.text === text) return previous;
  const next = { text, revision: previous.revision + 1 };
  drafts.set(id, next);
  for (const listener of listeners) listener();
  return next;
}
export function forgetSessionDraft(id: string) { drafts.delete(id); for (const listener of listeners) listener(); }
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
