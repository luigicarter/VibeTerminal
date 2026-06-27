import type {
  AgentAttention,
  AgentAttentionEvent,
  AgentSession,
  SessionStatus,
  TerminalEvent
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

export function statusFromTerminalEvent(
  terminalEvent: TerminalEvent
): SessionStatus | null {
  if (terminalEvent.type === "data") {
    return "running";
  }

  if (terminalEvent.type === "snapshot") {
    return terminalEvent.isRunning
      ? "running"
      : terminalEvent.exitCode === 0
        ? "done"
        : "failed";
  }

  if (terminalEvent.type === "error") {
    return "failed";
  }

  if (terminalEvent.type === "exit") {
    return terminalEvent.exitCode === 0 ? "done" : "failed";
  }

  return null;
}

export function attentionFromTerminalEvent(
  terminalEvent: TerminalEvent,
  updatedAt = Date.now()
): AgentAttentionEvent | null {
  if (terminalEvent.type === "error") {
    return {
      state: "failed",
      reason: "error",
      source: "process",
      updatedAt,
      message: terminalEvent.message
    };
  }

  if (terminalEvent.type === "exit") {
    const completed = terminalEvent.exitCode === 0;

    return {
      state: completed ? "completed" : "failed",
      reason: completed ? "done" : "exit",
      source: "process",
      updatedAt,
      message: completed
        ? "Terminal finished successfully."
        : "Terminal exited with an error."
    };
  }

  return null;
}

export function shouldUseTerminalEventAttention(session: AgentSession) {
  return !(
    session.kind === "codex" ||
    session.kind === "claude" ||
    session.kind === "opencode"
  );
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
