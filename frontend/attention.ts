import type {
  AgentAttention,
  AgentAttentionEvent,
  AgentAttentionState,
  AgentKind,
  AgentSession,
  BackgroundTaskEvent,
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

// The pane is actively working while its foreground turn is "running" or a
// detached Fusion/Open Fusion delegation is still in flight. This is the signal
// behind the sidebar "working" spinner. It is deliberately narrow: "starting"
// (a booting agent that hasn't been given a turn yet) and "waiting" alone do not
// count as working, so an idle pane never spins.
export function isSessionWorking(session: AgentSession) {
  return session.status === "running" || Boolean(session.detachedTaskIds?.length);
}

export function updateDetachedTaskIds(
  session: AgentSession,
  event: BackgroundTaskEvent
): AgentSession {
  if (event.phase === "progress") {
    return session;
  }

  const currentTaskIds = session.detachedTaskIds ?? [];
  if (event.phase === "started") {
    return currentTaskIds.includes(event.taskId)
      ? session
      : { ...session, detachedTaskIds: [...currentTaskIds, event.taskId] };
  }

  if (!currentTaskIds.includes(event.taskId)) {
    return session;
  }

  const detachedTaskIds = currentTaskIds.filter((taskId) => taskId !== event.taskId);
  return {
    ...session,
    detachedTaskIds: detachedTaskIds.length ? detachedTaskIds : undefined
  };
}

// A detached task outlives the launcher turn, so that foreground result is not
// the user-facing completion. Once every task id is settled, the host's fresh
// wake-report turn uses the normal unread decision again.
export function shouldMarkCompletedTurnUnread(
  session: AgentSession,
  unread: boolean
) {
  return session.detachedTaskIds?.length ? false : unread;
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
    // A snapshot is a REPLAY of buffered output (pane remount / reattach), not
    // fresh activity: a live process must not read as "working" from replayed
    // bytes — that used to wipe a settled done/failed pill on every workspace
    // switch. Only the exited form settles status.
    return terminalEvent.isRunning
      ? null
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

// Terminal input that plausibly came from the user's keyboard: typed text,
// Enter/Backspace/Ctrl chords, or a bracketed paste. Everything else that
// arrives through onData starts with a bare ESC — focus reports (CSI I/O),
// mouse reports (CSI M / CSI <...), arrow keys and other navigation — and must
// NOT count as the user starting a turn, so merely clicking or focusing a
// finished TUI pane never disturbs its "done" pill.
export function isHumanTerminalInput(data: string) {
  return !data.startsWith("\x1b") || data.startsWith("\x1b[200~");
}

// What a keystroke into the pane means for the status pill, or null to leave
// it alone.
//
// - telemetry kinds "running" + a bare Esc: the TUI interrupt key (claude
//   shows "esc to interrupt") — and NO hook fires for an interrupt, so
//   without this the pill/spinner stays "working" until the ~60s idle
//   notification. Settle to "waiting" immediately; if the Esc merely
//   dismissed a menu, the next telemetry event re-asserts "running"
//   (waiting -> running is never latched), so this self-heals.
// - telemetry kinds waiting on an APPROVAL: the answer keystroke is the only
//   signal there is (PreToolUse fired before the prompt, PostToolUse fires
//   only when the tool ends), so flip to "running" immediately instead of
//   reading "waiting" for the whole tool run. An idle/question wait stays
//   put — composing a prompt is not working, and UserPromptSubmit will fire.
// - codex/plain terminals (no turn telemetry): typing is their equivalent of
//   claude's UserPromptSubmit — the one signal that legitimately supersedes a
//   finished turn. Release the done/failed latch to "waiting" (it is the
//   user's turn; the output-flow heuristic flips to "running" once real
//   output follows). Without this a codex pane latched "done" by its turn-end
//   telemetry could never show working/waiting again until restart.
//
// Callers must apply the returned status DIRECTLY (not through
// reconcileStatus): releasing the latch is the point.
export function statusAfterUserInput(
  session: Pick<AgentSession, "kind" | "status" | "attention">,
  data: string
): SessionStatus | null {
  if (isTurnTelemetryKind(session.kind)) {
    if (session.status === "running" && data === "\x1b") {
      return "waiting";
    }

    return isHumanTerminalInput(data) &&
      session.status === "waiting" &&
      session.attention?.state === "waiting" &&
      session.attention.reason === "approval"
      ? "running"
      : null;
  }

  return isHumanTerminalInput(data) &&
    (session.status === "done" || session.status === "failed")
    ? "waiting"
    : null;
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
