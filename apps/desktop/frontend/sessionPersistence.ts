import type { AgentSession, AgentThreadProvider, AgentThreadRef } from "./types";
import type { TerminalRuntimeSnapshot } from "./terminalRuntime";

export function rememberTerminalThread(session: AgentSession, snapshot: TerminalRuntimeSnapshot): AgentSession {
  if (session.fusion || session.openFusion || session.launchToken !== snapshot.launchToken) return session;
  if (snapshot.selection?.status === 'unavailable') {
    return session.threadRef || !session.threadSelectionPending ? { ...session, threadRef: undefined, threadSelectionPending: true } : session;
  }
  const ref = snapshot.selection?.status === 'pending' ? snapshot.selection.threadRef : snapshot.conversation;
  if (!ref?.id || ref.provider !== session.kind) return session;
  const pending = snapshot.selection?.status === 'pending' || undefined;
  if (session.threadRef?.id === ref.id && session.threadRef?.title === ref.title &&
      session.threadRef?.titleSource === ref.titleSource && session.threadSelectionPending === pending) return session;
  return { ...session, threadRef: ref as AgentThreadRef, threadSelectionPending: pending };
}

// Chat hosts can report their session after the user switches projects and the
// pane unmounts. Keep that identity in workspace state, independent of its view.
export function rememberChatThread(
  session: AgentSession,
  provider: AgentThreadProvider,
  id: string
): AgentSession {
  if (!session.started || typeof id !== "string" || !id.trim()) return session;
  const previous = session.threadRef;
  if (previous?.provider === provider && previous.id === id) return session;
  return {
    ...session,
    threadRef: { provider, id, createdAt: session.createdAt, updatedAt: Date.now() }
  };
}

// Run before kind validation, so removing a launcher never deletes saved tiles.
export function migrateRemovedAgent(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const stored = value as Record<string, unknown>;
  if (stored.kind !== "aider") return value;
  return {
    ...stored,
    kind: "terminal",
    command: "",
    started: false,
    status: "idle",
    nextLaunchMode: "new",
    threadRef: undefined,
    resumeRef: undefined,
    fusion: undefined,
    openFusion: undefined,
    providerProfileId: undefined,
    providerModelOverride: undefined,
    attention: undefined,
    backgroundActivity: undefined,
    detachedTaskIds: undefined,
    subagentDepth: undefined
  };
}

// Runtime observations belong to the current process, never the next app launch.
export function serializeSession(session: AgentSession): AgentSession {
  if (session.fusion || session.openFusion) return session;
  return {
    ...session,
    status: "idle",
    attention: undefined,
    backgroundActivity: undefined,
    detachedTaskIds: undefined,
    subagentDepth: undefined,
    threadLookupStartedAt: undefined,
    threadLookupStatus: "idle",
    threadLookupMessage: undefined
  };
}
