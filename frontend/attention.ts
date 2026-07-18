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

export type ProviderAttentionDecision = "accept" | "defer" | "reject";

export function codexTurnAttentionDecision(
  activeTurnId: string | undefined,
  submitPending: boolean,
  submitPendingPriorTurnId: string | null | undefined,
  settledTurnIds: readonly string[],
  providerTurnId: string | undefined
): "accept" | "reject" {
  if (!providerTurnId || settledTurnIds.includes(providerTurnId)) {
    return "reject";
  }

  // Legacy notify is detached, so the previous completion can land after the
  // user's next Enter. While that submit is awaiting provider identity, reject
  // the prior id but allow a different id to complete the compatibility path
  // even when UserPromptSubmit hooks are unavailable.
  if (submitPending) {
    return submitPendingPriorTurnId === providerTurnId ? "reject" : "accept";
  }

  return activeTurnId && activeTurnId !== providerTurnId ? "reject" : "accept";
}

// Codex's legacy notify also runs inside spawned agent threads. The appended
// provider thread id is therefore required to prove a completion belongs to the
// pane's root thread. Before discovery binds that root id, hold the event rather
// than accepting a child completion or dropping a fast root completion.
export function providerAttentionDecision(
  session: Pick<AgentSession, "kind" | "threadRef"> | undefined,
  provider?: string,
  providerThreadId?: string
): ProviderAttentionDecision {
  if (provider !== "codex") {
    return "accept";
  }
  if (!providerThreadId) {
    return "reject";
  }
  if (!session || session.kind !== "codex") {
    return "reject";
  }
  if (!session.threadRef?.id) {
    return "defer";
  }
  return session.threadRef.id === providerThreadId ? "accept" : "reject";
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

// claude, opencode, cursor, kimi, and current Codex expose a turn-START signal
// (claude's UserPromptSubmit hook, opencode's busy plugin event, cursor's
// beforeSubmitPrompt hook, kimi's config.toml UserPromptSubmit hook, Codex's
// passive lifecycle observer), so those agents' working state is driven purely
// by telemetry and is NEVER
// inferred from terminal output. That is what stops a keystroke, its echo, or a
// focus/click redraw from reading as "working". Codex keeps an App-owned Enter
// fallback and watchdog for older/untrusted hook configurations. Plain terminals
// retain the output-flow heuristic in TerminalPane.
export function isTurnTelemetryKind(kind: AgentKind) {
  return (
    kind === "claude" ||
    kind === "opencode" ||
    kind === "cursor" ||
    kind === "kimi"
  );
}

export function shouldSettleStatusOnPaneUnmount(
  session: Pick<AgentSession, "kind" | "status">
) {
  return (
    session.status === "starting" ||
    (session.status === "running" &&
      session.kind !== "codex" &&
      !isTurnTelemetryKind(session.kind))
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

// Bare Enter is the compatibility start signal until the passive Codex
// UserPromptSubmit observer is trusted/available. Keep it deliberately narrow:
// ordinary typing, navigation/focus reports, and bracketed pastes stay neutral.
export function isCodexTurnSubmitInput(data: string) {
  return data === "\r" || data === "\n" || data === "\r\n";
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
// - codex "running" + bare Esc/Ctrl+C: settle the renderer-owned turn start
//   immediately and cancel its App-level stale-running watchdog. A later Enter
//   submission starts a fresh turn.
// - telemetry kinds waiting on an APPROVAL: the answer keystroke is the only
//   signal there is (PreToolUse fired before the prompt, PostToolUse fires
//   only when the tool ends), so flip to "running" immediately instead of
//   reading "waiting" for the whole tool run. An idle/question wait stays
//   put — composing a prompt is not working, and UserPromptSubmit will fire.
// - codex/plain terminals: typing legitimately
//   supersedes a finished turn, so release the done/failed latch to "waiting".
//   Codex's separate submit-input callback moves Enter to "running"; plain
//   terminals retain the output-flow heuristic. Without this release, a pane
//   latched by a prior completion could not reflect the next interaction.
//
// Callers must apply the returned status DIRECTLY (not through
// reconcileStatus): releasing the latch is the point.
export function statusAfterUserInput(
  session: Pick<AgentSession, "kind" | "status" | "attention">,
  data: string
): SessionStatus | null {
  if (
    session.kind === "codex" &&
    session.status === "running" &&
    (data === "\x1b" || data === "\x03")
  ) {
    return "waiting";
  }

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
    session.kind === "cursor" ||
    session.kind === "kimi"
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
