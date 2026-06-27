import type {
  AgentAttention,
  AgentAttentionEvent,
  AgentSession
} from "./types";

export const EMPTY_ATTENTION: AgentAttention = {
  state: "none",
  unread: false,
  updatedAt: 0,
  source: "process"
};

export function normalizeAttention(attention?: AgentAttention): AgentAttention {
  return attention ?? EMPTY_ATTENTION;
}

export function shouldShowAttentionDot(session: AgentSession) {
  const attention = session.attention;
  return Boolean(
    attention?.unread &&
      (attention.state === "waiting" ||
        attention.state === "completed" ||
        attention.state === "failed")
  );
}

export function attentionFromEvent(
  attentionEvent: AgentAttentionEvent,
  unread: boolean
): AgentAttention {
  return {
    ...attentionEvent,
    unread: attentionEvent.state === "none" ? false : unread
  };
}

export function shouldMarkAttentionUnread(
  sessionId: string,
  selectedSessionId: string | null,
  visibleSessionIds: string[],
  attentionEvent: AgentAttentionEvent
) {
  if (attentionEvent.state === "none") {
    return false;
  }

  return !(
    selectedSessionId === sessionId && visibleSessionIds.includes(sessionId)
  );
}

export function clearUnreadAttention(session: AgentSession): AgentSession {
  if (!session.attention?.unread) {
    return session;
  }

  return {
    ...session,
    attention: {
      ...session.attention,
      unread: false
    }
  };
}
