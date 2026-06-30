import type {
  AgentAttention,
  AgentAttentionEvent,
  AgentAttentionState,
  AgentKind,
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

// The pane is actively working when its status is "running". This is the signal
// behind the sidebar "working" spinner. It is deliberately narrow: "starting"
// (a booting agent that hasn't been given a turn yet) and "waiting" do not count
// as working, so an idle pane never spins.
export function isSessionWorking(session: AgentSession) {
  return session.status === "running";
}

// claude, opencode, and cursor expose a turn-START signal (claude's
// UserPromptSubmit hook, opencode's busy plugin event, cursor's beforeSubmitPrompt
// hook), so their "working" state is driven purely by telemetry and is NEVER
// inferred from terminal output. That is what stops a keystroke, its echo, or a
// focus/click redraw from reading as "working". codex has no turn-start signal,
// so it (and plain terminals) fall back to the output-flow heuristic in
// TerminalPane.
export function isTurnTelemetryKind(kind: AgentKind) {
  return kind === "claude" || kind === "opencode" || kind === "cursor";
}

export function shouldSettleStatusOnPaneUnmount(
  session: Pick<AgentSession, "kind" | "status">
) {
  return (
    session.status === "starting" ||
    (session.status === "running" && !isTurnTelemetryKind(session.kind))
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

// Coding agents run as a child process *inside* the pane's shell, so when the
// agent finishes the PTY shell stays alive and never emits a terminal "exit".
// The only signal that the agent itself ended is its telemetry attention
// event, so map that lifecycle onto the pill status here.
export function statusFromAttentionState(
  state: AgentAttentionState
): SessionStatus | null {
  switch (state) {
    case "waiting":
      return "waiting";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

// Decide the next pill status from the current one and an incoming signal.
// "done"/"failed" are sticky: once a pane has finished, transient output (the
// shell prompt that reappears after an agent sub-process exits, a stray byte)
// must not flip it back to "working"/"waiting". A restart resets the status to
// "idle"/"starting", which clears the latch.
export function reconcileStatus(
  current: SessionStatus,
  incoming: SessionStatus
): SessionStatus {
  if (incoming === current) {
    return current;
  }

  if (
    (current === "done" || current === "failed") &&
    (incoming === "running" || incoming === "waiting")
  ) {
    return current;
  }

  return incoming;
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
    session.kind === "opencode" ||
    session.kind === "cursor"
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
