import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  CopyPlus,
  GripVertical,
  Maximize2,
  Minimize2,
  Plus,
  Play,
  RefreshCcw,
  RotateCcw,
  TerminalSquare,
  Ungroup,
  X
} from "lucide-react";
import clsx from "clsx";
import {
  hasLiveSubagents,
  isCodexTurnSubmitInput,
  isTurnTelemetryKind,
  reconcileStatus,
  shouldSettleStatusOnPaneUnmount,
  shouldShowAttentionDot,
  statusAfterUserInput
} from "../attention";
import { buildLaunchCommand, isThreadedAgentKind } from "../sessionLaunch";
import {
  isTerminalCopyShortcut,
  isTerminalPasteShortcut
} from "../terminalClipboard";
import {
  createSgrMouseTracker,
  createSyncOutputCoalescer,
  type SgrMouseTracker,
  type SyncOutputCoalescer
} from "../terminalOutput";
import {
  buildSgrWheelReports,
  computeWheelLines,
  type WheelAccumulator
} from "../terminalWheel";
import {
  cwdConflictChipLabel,
  cwdConflictTitle,
  type CwdConflict
} from "../cwdConflicts";
import type {
  AgentProfile,
  AgentSession,
  AgentThreadRef,
  AgentThreadLookupStatus,
  SessionStatus
} from "../types";

const THREAD_LOOKUP_POLL_MS = 8000;
const THREAD_LOOKUP_TIMEOUT_MS = 90_000;
const NON_TERMINAL_FOCUS_TARGET =
  ".pane-actions, .pane-actions *, button, input, textarea, select, a";
// Plain-terminal output settles to waiting after this quiet gap. The same delay
// is used only for agent boot states; a real Codex turn never uses a silence
// timer because model/tool quiet time is still work.
const IDLE_AFTER_MS = 1500;
// After the user interacts with a pane (keystroke, paste, or a mouse/focus
// report a full-screen TUI requests), the bytes that echo straight back — the
// typed character, the prompt redraw, the focus/mouse ack — are NOT the agent
// working. Ignore output this soon after the last input so typing in or clicking
// a pane never reads as "working".
const INPUT_GRACE_MS = 450;
// Stale-"running" watchdog for telemetry kinds: a turn can end without its
// hook firing (claude's Stop does not fire on an Esc interrupt; a notify POST
// can be lost). While genuinely working these TUIs repaint their spinner
// constantly, so this much TOTAL output silence while "running" means the turn
// is over — settle to "waiting". If a turn really is alive but silent, the
// next telemetry event re-asserts "running".
const TELEMETRY_RUNNING_QUIET_MS = 12_000;
// The same watchdog while a subagent delegation is open. A delegating pane is
// EXPECTED to be quiet — the parent sits idle at a static prompt while its
// subagent works, and a detached subagent can outlive the parent turn entirely
// — so 12s of silence there is normal rather than a lost hook. Silence still
// cannot be trusted forever, because the bracket's close event can be lost (a
// denied Task, a killed child), so this window doubles as the delegation
// counter's absolute expiry.
const TELEMETRY_DELEGATION_QUIET_MS = 120_000;
// Generated-title harvest: providers whose session titles can be read back
// from local metadata with a cheap bounded file read. opencode/cursor already
// bind their discovery refs with titles, and opencode's confirm path spawns a
// CLI per call — too heavy to poll. kimi binds with a title too, but a fresh
// session's generated title lands after the first turn, so it joins the cheap
// file-read polling set.
const TITLE_REFRESH_PROVIDERS = new Set<string>(["claude", "codex", "kimi", "kimi-custom", "qwen"]);
const TITLE_REFRESH_DELAY_MS = 4000;
const TITLE_REFRESH_MAX_ATTEMPTS = 5;

// A tile can hold several terminals, so several panes mount into ONE
// .pane-frame and each wants the frame's CSS transition off while it measures.
// Refcount it: the forced synchronous layout happens once per frame element per
// commit instead of once per pane, and the frame's declared transition is
// restored by whoever leaves last rather than by whoever finishes first.
const frameTransitionSuppressions = new WeakMap<
  HTMLElement,
  { count: number; saved: string }
>();

function suppressFrameTransition(frame: HTMLElement) {
  const entry = frameTransitionSuppressions.get(frame);
  if (entry) {
    entry.count += 1;
    return;
  }

  frameTransitionSuppressions.set(frame, {
    count: 1,
    saved: frame.style.transition
  });
  frame.style.transition = "none";
  void frame.offsetWidth;
}

function releaseFrameTransition(frame: HTMLElement) {
  const entry = frameTransitionSuppressions.get(frame);
  if (!entry) {
    return;
  }

  entry.count -= 1;
  if (entry.count > 0) {
    return;
  }

  // Deferred so every pane in this commit measures while the transition is
  // still off, collapsing N suppress/reflow/restore cycles into one.
  queueMicrotask(() => {
    const current = frameTransitionSuppressions.get(frame);
    if (!current || current.count > 0) {
      return;
    }
    frameTransitionSuppressions.delete(frame);
    frame.style.transition = current.saved;
  });
}

interface ThreadLookupPatch {
  threadLookupStartedAt?: number;
  threadLookupStatus: AgentThreadLookupStatus;
  threadLookupMessage?: string;
}

interface TerminalPaneProps {
  session: AgentSession;
  profile: AgentProfile;
  providerLogoSrc?: string;
  claimedThreadIds: string[];
  cwdConflict?: CwdConflict;
  isMaximized: boolean;
  isArranging: boolean;
  // This pane shares its board tile with others, so it can be popped back out.
  isGrouped: boolean;
  // Whether this pane takes focus when it mounts. True for an ordinary
  // ungrouped pane (a freshly launched terminal must be typeable without
  // clicking into it); inside a split tile only the selected member, since
  // several terminals mount into one frame and the last one would win.
  autoFocus: boolean;
  onClose: () => void;
  onDuplicate: () => void;
  onSplit: (dir: "row" | "col") => void;
  onPopOut: () => void;
  onRestart: () => void;
  onResume: () => void;
  onAdd: () => void;
  onSelect: () => void;
  onMaximize: () => void;
  onThreadRefChange: (threadRef: AgentThreadRef) => void;
  onFreshLaunchFallback: (patch: ThreadLookupPatch) => void;
  onThreadLookupChange: (patch: ThreadLookupPatch) => void;
  onStatusChange: (status: SessionStatus) => void;
  // Human keyboard input decided the status (statusAfterUserInput). Applied
  // WITHOUT reconcileStatus — releasing the done/failed latch is the point.
  onInputStatusRelease: (status: SessionStatus) => void;
  // The delegation watchdog gave up on an open subagent bracket after
  // TELEMETRY_DELEGATION_QUIET_MS of total silence. Reported explicitly rather
  // than inferred from the status change so the reset is visible at the call
  // site and assertable in the smoke test.
  onDelegationTimeout?: () => void;
  // Bare Enter is Codex's compatibility turn-start signal until the passive
  // provider lifecycle observer is trusted/available. It is kept above the pane
  // lifecycle so running survives workspace switches and maximize unmounts.
  onCodexTurnStart: () => void;
  // Lift input timing into App so hidden-output recovery retains the same
  // echo/redraw suppression as the mounted terminal heuristic.
  onCodexInput: () => void;
}

function statusLabel(status: SessionStatus) {
  switch (status) {
    case "starting":
      return "starting";
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

export default function TerminalPane({
  session,
  profile,
  providerLogoSrc,
  claimedThreadIds,
  cwdConflict,
  isMaximized,
  isArranging,
  isGrouped,
  autoFocus,
  onAdd,
  onClose,
  onDuplicate,
  onSplit,
  onPopOut,
  onMaximize,
  onRestart,
  onResume,
  onSelect,
  onThreadRefChange,
  onFreshLaunchFallback,
  onThreadLookupChange,
  onStatusChange,
  onInputStatusRelease,
  onDelegationTimeout,
  onCodexTurnStart,
  onCodexInput
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef(session);
  const createdRef = useRef(false);
  const lastLaunchTokenRef = useRef(0);
  const onStatusChangeRef = useRef(onStatusChange);
  const onInputStatusReleaseRef = useRef(onInputStatusRelease);
  const onDelegationTimeoutRef = useRef(onDelegationTimeout);
  const autoFocusRef = useRef(autoFocus);
  const onCodexTurnStartRef = useRef(onCodexTurnStart);
  const onCodexInputRef = useRef(onCodexInput);
  const onThreadRefChangeRef = useRef(onThreadRefChange);
  const onFreshLaunchFallbackRef = useRef(onFreshLaunchFallback);
  const onThreadLookupChangeRef = useRef(onThreadLookupChange);
  const isArrangingRef = useRef(isArranging);
  const pendingFitRef = useRef(false);
  const fitFrameRef = useRef<number | null>(null);
  const fitAndResizeRef = useRef<(() => void) | null>(null);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  // Whether a fit has ever measured this pane's real bounds. Until then
  // terminal.cols/rows are xterm's 80x24 construction default, which must
  // never be advertised to the PTY (see the create() call).
  const fitMeasuredRef = useRef(false);
  // Whether this pane should keep showing the tail of its output. Only the
  // user's own scrolling flips it — see syncFollowTail().
  const followTailRef = useRef(true);
  // Byte-stream helpers owned by the terminal-create effect; refs so the
  // launch effect can reset them on a relaunch.
  const syncOutputRef = useRef<SyncOutputCoalescer | null>(null);
  const sgrMouseRef = useRef<SgrMouseTracker | null>(null);
  const terminalPointerRef = useRef(false);
  const threadLookupTimeoutRef = useRef<number | null>(null);
  const threadLookupAfterRef = useRef(
    session.threadLookupStartedAt ?? session.createdAt
  );
  const terminalExitedRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);
  const lastInputAtRef = useRef(0);
  const lookupInFlightRef = useRef(false);
  const claimedThreadIdsRef = useRef(claimedThreadIds);
  const forceThreadLookupTokenRef = useRef<number | null>(null);
  const titleRefreshTimeoutRef = useRef<number | null>(null);
  const titleRefreshAttemptsRef = useRef(0);
  const titleRefreshInFlightRef = useRef(false);
  const [terminalReadyToken, setTerminalReadyToken] = useState(0);

  const platform = window.vibe?.platform;

  const launchCommand = useMemo(
    () => buildLaunchCommand(session, { platform }),
    [session, platform]
  );

  useLayoutEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    onInputStatusReleaseRef.current = onInputStatusRelease;
  }, [onInputStatusRelease]);

  useEffect(() => {
    onDelegationTimeoutRef.current = onDelegationTimeout;
  }, [onDelegationTimeout]);

  useEffect(() => {
    autoFocusRef.current = autoFocus;
  }, [autoFocus]);

  // armTelemetrySettle fixes its delay at arm time, so a delegation that opens
  // during an already-quiet stretch would still be settled by the pending short
  // timer. Re-arm whenever the bracket opens or closes — which also shortens
  // the window straight back to 12s once the delegation ends, so an ordinary
  // turn is never left holding the long one. Only ever RE-arms a timer that is
  // already pending: with no timer running there is nothing to correct, and
  // arming one here (e.g. on mount) would settle a booting pane that has not
  // produced any output yet.
  useEffect(() => {
    if (idleTimerRef.current !== null) {
      armTelemetrySettle();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.subagentDepth]);

  useEffect(() => {
    onCodexTurnStartRef.current = onCodexTurnStart;
  }, [onCodexTurnStart]);

  useEffect(() => {
    onCodexInputRef.current = onCodexInput;
  }, [onCodexInput]);

  useEffect(() => {
    onThreadRefChangeRef.current = onThreadRefChange;
  }, [onThreadRefChange]);

  useEffect(() => {
    onFreshLaunchFallbackRef.current = onFreshLaunchFallback;
  }, [onFreshLaunchFallback]);

  useEffect(() => {
    onThreadLookupChangeRef.current = onThreadLookupChange;
  }, [onThreadLookupChange]);

  useEffect(() => {
    claimedThreadIdsRef.current = claimedThreadIds;
  }, [claimedThreadIds]);

  useEffect(() => {
    if (session.threadLookupStartedAt) {
      threadLookupAfterRef.current = session.threadLookupStartedAt;
    }
  }, [session.threadLookupStartedAt]);

  useEffect(() => {
    return () => {
      if (threadLookupTimeoutRef.current) {
        window.clearTimeout(threadLookupTimeoutRef.current);
      }
      if (titleRefreshTimeoutRef.current !== null) {
        window.clearTimeout(titleRefreshTimeoutRef.current);
      }
    };
  }, []);

  // Harvest the provider-generated title once a thread id exists without one:
  // fires on mount for restored/resumed panes, when discovery binds a codex
  // id, and on every relaunch. Once a title lands the guard goes quiet.
  useEffect(() => {
    if (session.threadRef?.id && !session.threadRef.title) {
      scheduleTitleRefresh(true);
    }
  }, [session.threadRef?.id, session.threadRef?.title, session.launchToken]);

  useEffect(() => {
    isArrangingRef.current = isArranging;

    if (!isArranging && pendingFitRef.current) {
      pendingFitRef.current = false;
      scheduleFitAndResize();
    }
  }, [isArranging]);

  function setStatus(status: SessionStatus) {
    const nextStatus = reconcileStatus(sessionRef.current.status, status);
    if (nextStatus === sessionRef.current.status) {
      return;
    }

    sessionRef.current = {
      ...sessionRef.current,
      status: nextStatus
    };
    onStatusChangeRef.current(nextStatus);
  }

  function clearIdleTimer() {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }

  // Output just flowed: the pane is working. Re-arm the quiescence timer so that
  // if it then goes quiet while the process is still alive, the pill settles to
  // "waiting" instead of being pinned to "working" forever.
  function markActive() {
    setStatus("running");
    clearIdleTimer();
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      if (!terminalExitedRef.current) {
        setStatus("waiting");
      }
    }, IDLE_AFTER_MS);
  }

  // (Re)arm the settle-to-waiting timer for a telemetry-kind pane in a state
  // that must not outlive fresh output: a booting pane ("starting" settles
  // after the first quiet gap so a freshly launched agent doesn't read as
  // starting forever) and a possibly-stale "running" (see
  // TELEMETRY_RUNNING_QUIET_MS). Settles only if the status is unchanged when
  // the timer fires — a starting->running transition mid-wait must not settle
  // a fresh turn after the shorter boot delay.
  function armTelemetrySettle() {
    if (isTurnTelemetryKind(sessionRef.current.kind)) {
      const armedFor = sessionRef.current.status;
      if (armedFor !== "starting" && armedFor !== "running") {
        return;
      }
      const delay =
        armedFor === "starting"
          ? IDLE_AFTER_MS
          : hasLiveSubagents(sessionRef.current)
            ? TELEMETRY_DELEGATION_QUIET_MS
            : TELEMETRY_RUNNING_QUIET_MS;
      clearIdleTimer();
      idleTimerRef.current = window.setTimeout(() => {
        idleTimerRef.current = null;
        if (
          !terminalExitedRef.current &&
          sessionRef.current.status === armedFor
        ) {
          if (hasLiveSubagents(sessionRef.current)) {
            onDelegationTimeoutRef.current?.();
          }
          setStatus("waiting");
        }
      }, delay);
    }
  }

  // Codex boot output proves the TUI is alive, but it is not a user turn. Let
  // the initial "starting" pill settle after the first quiet gap without ever
  // applying that silence rule to a real Codex turn.
  function armCodexStartingSettle() {
    if (
      sessionRef.current.kind !== "codex" ||
      sessionRef.current.status !== "starting"
    ) {
      return;
    }

    clearIdleTimer();
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      if (
        !terminalExitedRef.current &&
        sessionRef.current.status === "starting"
      ) {
        setStatus("waiting");
      }
    }, IDLE_AFTER_MS);
  }

  // Decide whether a chunk of PTY output should read as the agent "working".
  function markActiveFromOutput() {
    // Codex has provider lifecycle telemetry when its passive observer is
    // trusted, an Enter fallback otherwise, and provider-owned completion.
    // PTY silence during thinking/quiet tools is not the mounted idle heuristic.
    if (sessionRef.current.kind === "codex") {
      armCodexStartingSettle();
      return;
    }

    // claude/opencode/cursor own their working state through turn telemetry
    // (UserPromptSubmit / busy events), so their output never sets "running" —
    // otherwise a focus/click redraw or a keystroke echo would look like work.
    // Output only feeds their quiescence watchdog.
    if (isTurnTelemetryKind(sessionRef.current.kind)) {
      armTelemetrySettle();
      return;
    }

    // plain terminals / other non-agent panes: output is "working" unless it lands
    // inside the input grace window, where it is just the echo of, or the TUI's
    // response to, the user's own keystroke/click.
    if (Date.now() - lastInputAtRef.current < INPUT_GRACE_MS) {
      return;
    }

    markActive();
  }

  // Resizing a pane moves the .xterm-viewport element before xterm itself knows
  // its new size, so the browser clamps that element's scrollTop against a
  // scroll area built for the old geometry. xterm reads the resulting scroll
  // event as the user dragging the scrollbar up: it latches its internal
  // isUserScrolling flag, stops following new output, and the view then drifts
  // further and further behind the process — all the way to the top of the
  // scrollback once lines start being trimmed. So xterm's own idea of "the user
  // scrolled up" cannot be trusted across a resize; track it here instead, from
  // the gestures that actually move the view: the wheel, a scrollbar or
  // selection drag inside the terminal, and keys (typing scrolls xterm back to
  // the bottom). Pane chrome — resize edges, the drag header — sits outside
  // this element, so arranging a pane never counts as scrolling it.
  function syncFollowTail() {
    requestAnimationFrame(() => {
      const buffer = terminalRef.current?.buffer.active;
      if (buffer) {
        followTailRef.current = buffer.viewportY >= buffer.baseY;
      }
    });
  }

  function handleTerminalPointerDown() {
    terminalPointerRef.current = true;
  }

  function handleWindowPointerMove() {
    // Dragging with the button down inside the terminal is the user moving the
    // view — the scrollbar, or a selection that auto-scrolls past an edge — and
    // every step of it would otherwise look like a stray scroll worth undoing.
    // A press that never moves is just a click, so following stays armed.
    if (terminalPointerRef.current) {
      followTailRef.current = false;
    }
  }

  function handleWindowPointerUp() {
    if (!terminalPointerRef.current) {
      return;
    }

    terminalPointerRef.current = false;
    syncFollowTail();
  }

  function scheduleFitAndResize() {
    if (fitFrameRef.current !== null) {
      return;
    }

    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null;
      fitAndResizeRef.current?.();
    });
  }


  function focusTerminal() {
    if (!isArrangingRef.current) {
      terminalRef.current?.focus();
    }
  }

  function copySelectionToClipboard() {
    const selection = terminalRef.current?.getSelection() ?? "";
    const clipboard = window.vibe?.clipboard;
    if (!selection || !clipboard) {
      return false;
    }

    clipboard.writeText(selection);
    return true;
  }

  function pasteText(text: string) {
    if (!text || terminalExitedRef.current || !createdRef.current) {
      return false;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return false;
    }

    focusTerminal();
    terminal.paste(text);
    return true;
  }

  function pasteClipboardText() {
    const text = window.vibe?.clipboard?.readText() ?? "";
    return pasteText(text);
  }

  function handlePanePointerDown(event: React.PointerEvent<HTMLElement>) {
    onSelect();

    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest(NON_TERMINAL_FOCUS_TARGET)
    ) {
      return;
    }

    focusTerminal();
  }

  function handleTerminalContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    const terminal = terminalRef.current;
    if (!terminal || !window.vibe?.terminal.showContextMenu) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onSelect();
    focusTerminal();
    void window.vibe.terminal.showContextMenu({
      id: session.id,
      selectionText: terminal.getSelection()
    });
  }

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      // PTY-backed terminals (node-pty/ConPTY) already emit CRLF and absolute
      // cursor control, so xterm must render the bytes raw. convertEol:true
      // makes xterm force the cursor to column 0 on every '\n' (core lineFeed()
      // sets activeBuffer.x = 0), which desyncs column tracking from full-screen
      // TUIs (e.g. Claude Code): a later column-relative erase clears the wrong
      // span and strands stale glyphs in the leftmost column. Must stay false.
      convertEol: false,
      fontFamily:
        'Cascadia Mono, "Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      fontWeight: 500,
      lineHeight: 1.18,
      letterSpacing: 0,
      scrollback: 5000,
      theme: {
        background: "#17181c",
        foreground: "#ededf0",
        cursor: profile.accent,
        cursorAccent: "#101114",
        selectionBackground: "#2e3138",
        black: "#101211",
        red: "#ff6b6b",
        green: "#87d37c",
        yellow: "#f2c94c",
        blue: "#70a8ff",
        magenta: "#c78bff",
        cyan: "#6bd7db",
        white: "#f2f0e8",
        brightBlack: "#6a6e78",
        brightRed: "#ff8585",
        brightGreen: "#9be28e",
        brightYellow: "#f8d56a",
        brightBlue: "#9ac3ff",
        brightMagenta: "#d8a8ff",
        brightCyan: "#91eef2",
        brightWhite: "#ffffff"
      }
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(containerRef.current);

    // Capture phase: these must record the user's intent before xterm's own
    // handlers scroll the buffer, so the repair below can tell a gesture apart
    // from a stray scroll.
    const terminalHost = containerRef.current;
    terminalHost.addEventListener("wheel", syncFollowTail, {
      capture: true,
      passive: true
    });
    terminalHost.addEventListener("keydown", syncFollowTail, true);
    terminalHost.addEventListener("pointerdown", handleTerminalPointerDown, true);
    window.addEventListener("pointermove", handleWindowPointerMove, true);
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerUp);
    terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      // Landing on the tail re-arms following, whoever did it — a gesture, or a
      // programmatic scroll such as the one that ends a snapshot replay.
      if (buffer.viewportY >= buffer.baseY) {
        followTailRef.current = true;
        return;
      }

      if (!followTailRef.current) {
        return;
      }

      // Scrolled off the tail with no gesture behind it: a layout clamp. Undo it
      // on the next frame, by which point a gesture that raced this scroll has
      // cleared the flag. Resizes are repaired by their own fit; this also
      // catches the ones no fit follows, such as the pane settling into the
      // board right after it mounts.
      requestAnimationFrame(() => {
        if (followTailRef.current) {
          terminal.scrollToBottom();
        }
      });
    });

    // Frame coalescing for DEC 2026 "synchronized output" (qwen's virtual
    // viewport wraps every repaint in it): xterm has no support for the mode
    // and ConPTY re-chunks output, so an unheld frame paints partially and the
    // pane flickers on every repaint tick. All PTY data reaches xterm through
    // this coalescer; streams without the markers pass through untouched.
    const syncOutput = createSyncOutputCoalescer((data) => terminal.write(data));
    // Whether the foreground app enabled SGR mouse encoding — the only
    // encoding the wheel handler below can speak.
    const sgrMouse = createSgrMouseTracker();
    syncOutputRef.current = syncOutput;
    sgrMouseRef.current = sgrMouse;

    // When a TUI tracks the mouse (qwen's virtual viewport does), xterm turns
    // any wheel event into exactly ONE wheel report, however large its delta —
    // and Chromium coalesces a fast flick into a few large-delta events, so
    // the TUI sees a single small step and scrolling reads as stuck.
    // Synthesize one SGR report per scrolled line instead, at the same rate
    // xterm scrolls an untracked buffer. Anything unsupported (no tracking,
    // x10 protocol, non-SGR encoding, shift-wheel) falls through to xterm's
    // own handling unchanged.
    const wheelAccumulator: WheelAccumulator = { partial: 0 };
    terminal.attachCustomWheelEventHandler((event) => {
      const trackingMode = terminal.modes.mouseTrackingMode;
      if (trackingMode === "none" || trackingMode === "x10") {
        return true;
      }
      if (!sgrMouse.active || event.shiftKey) {
        return true;
      }
      const host = containerRef.current;
      if (!host || terminalExitedRef.current || !createdRef.current) {
        return true;
      }
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return true;
      }

      const rowHeight = rect.height / Math.max(1, terminal.rows);
      const colWidth = rect.width / Math.max(1, terminal.cols);
      const fastModifier = terminal.options.fastScrollModifier ?? "alt";
      const fastHeld =
        (fastModifier === "alt" && event.altKey) ||
        (fastModifier === "ctrl" && event.ctrlKey);
      const deltaY =
        event.deltaY * (fastHeld ? terminal.options.fastScrollSensitivity ?? 5 : 1);
      const lines = computeWheelLines(
        wheelAccumulator,
        { deltaY, deltaMode: event.deltaMode },
        rowHeight,
        terminal.rows
      );
      if (lines !== 0) {
        const col = Math.min(
          terminal.cols,
          Math.max(1, Math.floor((event.clientX - rect.left) / colWidth) + 1)
        );
        const row = Math.min(
          terminal.rows,
          Math.max(1, Math.floor((event.clientY - rect.top) / rowHeight) + 1)
        );
        window.vibe?.terminal.input(
          session.id,
          buildSgrWheelReports(lines, col, row)
        );
      }
      // Consumed: without this xterm would add its own single report on top.
      return false;
    });

    // Ungrouped panes focus on mount as they always have; inside a split tile
    // only the selected member does, since an unconditional focus() there hands
    // it to whichever pane rendered last.
    if (autoFocusRef.current) {
      terminal.focus();
    }
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }

      if (isTerminalCopyShortcut(event, platform)) {
        if (terminal.hasSelection()) {
          if (copySelectionToClipboard()) {
            event.preventDefault();
            return false;
          }

          return true;
        }

        // Keep Ctrl+C as interrupt, but make Ctrl+Shift+C/Cmd+C a copy-only
        // shortcut instead of forwarding an accidental control character.
        if (event.shiftKey || platform === "darwin") {
          event.preventDefault();
          return false;
        }

        return true;
      }

      if (isTerminalPasteShortcut(event, platform)) {
        if (!window.vibe?.clipboard) {
          return true;
        }

        event.preventDefault();
        pasteClipboardText();
        return false;
      }

      return true;
    });

    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    setTerminalReadyToken((value) => value + 1);

    const fitAndResize = () => {
      if (isArrangingRef.current) {
        pendingFitRef.current = true;
        return;
      }

      // A pane without laid-out bounds (hidden workspace, zero-width start of
      // a CSS transition) makes fit() a silent no-op that leaves xterm at its
      // 80x24 default. Skip instead of recording that default as a real size;
      // the ResizeObserver re-runs this once the pane has actual bounds.
      const host = containerRef.current;
      if (!host || host.clientWidth === 0 || host.clientHeight === 0) {
        return;
      }

      try {
        fitAddon.fit();
        // Undo the clamp-induced scroll described on syncFollowTail(). Scrolling
        // to the bottom also clears xterm's isUserScrolling flag, which is what
        // restores tail-following; a pane the user had scrolled up stays put.
        if (followTailRef.current) {
          terminal.scrollToBottom();
        }

        fitMeasuredRef.current = true;
        const size = {
          cols: terminal.cols,
          rows: terminal.rows
        };

        if (
          lastSentSizeRef.current?.cols === size.cols &&
          lastSentSizeRef.current?.rows === size.rows
        ) {
          return;
        }

        lastSentSizeRef.current = size;
        window.vibe?.terminal.resize(session.id, size.cols, size.rows);
      } catch {
        // Fit can throw while the pane is between layout states.
      }
    };
    fitAndResizeRef.current = fitAndResize;

    scheduleFitAndResize();

    const resizeObserver = new ResizeObserver(() => {
      scheduleFitAndResize();
    });
    resizeObserver.observe(containerRef.current);

    terminal.onData((data) => {
      if (!createdRef.current) {
        return;
      }

      onSelect();

      // Keyboard input can decide the status where no hook or output can: a
      // human keystroke releases a done/failed pill latched by the previous
      // turn (codex/plain terminals, whose output alone must never unlatch)
      // and answers a pending approval (claude); a bare Esc while a telemetry
      // turn is "running" is the TUI interrupt key, which fires no hook.
      // Applied directly — bypassing the latch is the point — and mirrored
      // into sessionRef so the heuristic reconciles against the released
      // status before the next re-render.
      if (!terminalExitedRef.current) {
        if (sessionRef.current.kind === "codex") {
          onCodexInputRef.current();
        }

        const releasedStatus = statusAfterUserInput(sessionRef.current, data);
        if (releasedStatus && releasedStatus !== sessionRef.current.status) {
          sessionRef.current = {
            ...sessionRef.current,
            status: releasedStatus
          };
          onInputStatusReleaseRef.current(releasedStatus);
        }

        if (
          sessionRef.current.kind === "codex" &&
          isCodexTurnSubmitInput(data)
        ) {
          clearIdleTimer();
          sessionRef.current = {
            ...sessionRef.current,
            status: "running"
          };
          onCodexTurnStartRef.current();
        }
      }

      window.vibe?.terminal.input(session.id, data);
      // User interaction is not plain-terminal work. Record when it happened so
      // that pane's echo/redraw can be told apart from real output. Codex status
      // is submit/notify-driven and does not consume this grace timestamp.
      lastInputAtRef.current = Date.now();

      // Enter on an untitled thread likely just submitted its first prompt —
      // the provider is about to write the metadata the title harvest reads,
      // so restart the backoff chain. No-ops once a title exists.
      if (data.includes("\r") || data.includes("\n")) {
        scheduleTitleRefresh(true);
      }
    });

    const removeListener = window.vibe?.terminal.onEvent((event) => {
      if (event.type === "host-error" || event.type === "host-exit") {
        if ("id" in event && event.id && event.id !== session.id) {
          return;
        }

        syncOutput.flush();
        terminal.writeln("");
        terminal.writeln(`\x1b[31m${event.message}\x1b[0m`);
        clearIdleTimer();
        setStatus("failed");
        return;
      }

      if (!("id" in event) || event.id !== session.id) {
        return;
      }

      if (event.type === "data") {
        sgrMouse.push(event.data);
        syncOutput.push(event.data);
        markActiveFromOutput();
      }

      if (event.type === "snapshot") {
        // A held frame and the mouse-encoding state describe the screen this
        // replay is about to replace; the replay itself is one atomic write,
        // so it does not need the coalescer.
        syncOutput.reset();
        sgrMouse.reset();
        terminal.reset();
        if (event.data) {
          sgrMouse.push(event.data);
          terminal.write(event.data, () => terminal.scrollToBottom());
        }

        if (event.isRunning) {
          // A snapshot is a REPLAY of buffered output (remount/reattach), not
          // fresh activity, so it never marks the pane "working" — that used
          // to wipe a settled done/failed pill on every workspace switch. It
          // only re-arms the telemetry quiescence settle so a stale
          // "starting"/"running" pill can't outlive the remount; live output
          // then drives the heuristic kinds normally.
          armTelemetrySettle();
          // The replayed bytes were rendered for the PTY's historical sizes.
          // Force the next fit to re-send this pane's true size even if it
          // matches what this component believes was already sent — a live
          // full-screen TUI painting for a stale PTY width (missed resize,
          // pre-fix create default) shreds the pane until the sizes agree.
          // The backend dedups an equal-size resize, so this is free when
          // nothing drifted.
          lastSentSizeRef.current = null;
          scheduleFitAndResize();
        } else {
          terminalExitedRef.current = true;
          terminal.writeln("");
          terminal.writeln(
            "\x1b[33mProcess exited. Use restart to run it again.\x1b[0m"
          );
          clearIdleTimer();
          setStatus(event.exitCode === 0 ? "done" : "failed");
        }
      }

      if (event.type === "error") {
        syncOutput.flush();
        terminal.writeln("");
        terminal.writeln(`\x1b[31m${event.message}\x1b[0m`);
        clearIdleTimer();
        setStatus("failed");
      }

      if (event.type === "exit") {
        terminalExitedRef.current = true;
        syncOutput.flush();
        terminal.writeln("");
        terminal.writeln(
          "\x1b[33mProcess exited. Use restart to run it again.\x1b[0m"
        );
        scheduleThreadLookup(200, true);
        clearIdleTimer();
        setStatus(event.exitCode === 0 ? "done" : "failed");
      }

    });
    const removeContextMenuPasteListener =
      window.vibe?.terminal.onContextMenuPaste?.((payload) => {
        if (payload.id === session.id) {
          pasteText(payload.text);
        }
      });

    if (!session.started) {
      terminal.writeln(
        "\x1b[90mSession is paused. Use the play button to start it.\x1b[0m"
      );
    }

    return () => {
      resizeObserver.disconnect();
      terminalHost.removeEventListener("wheel", syncFollowTail, true);
      terminalHost.removeEventListener("keydown", syncFollowTail, true);
      terminalHost.removeEventListener(
        "pointerdown",
        handleTerminalPointerDown,
        true
      );
      window.removeEventListener("pointermove", handleWindowPointerMove, true);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerUp);
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
      if (
        !terminalExitedRef.current &&
        shouldSettleStatusOnPaneUnmount(sessionRef.current)
      ) {
        setStatus("waiting");
      }
      clearIdleTimer();
      removeListener?.();
      removeContextMenuPasteListener?.();
      // Drop (not flush) any held frame: the terminal is being disposed, and a
      // pending coalescer timer must not write into a disposed instance.
      syncOutput.reset();
      syncOutputRef.current = null;
      sgrMouseRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      fitAndResizeRef.current = null;
      lastSentSizeRef.current = null;
    };
  }, [
    // Terminal lifecycle is pinned to the session identity. Every mutable
    // callback the listeners use already flows through refs (sessionRef,
    // onStatusChangeRef, etc.), and accent/cwd are immutable per session — so
    // the xterm instance must persist across launchCommand changes (e.g. when a
    // resume thread id is discovered mid-session). Recreating it here would
    // blank the pane while the PTY keeps running.
    session.id
  ]);

  // A resume only succeeds once the agent has persisted its session locally:
  // claude needs a transcript (`claude --resume <id>`), codex a rollout file
  // (`codex resume <id>`), opencode a known session (`opencode --session <id>`),
  // and cursor a saved chat (`cursor-agent --resume <id>`).
  // Resuming an id the agent no longer has hard-fails in the live shell pane
  // (e.g. claude's "No conversation found") and strands the user at a bare
  // prompt. So before resuming any threaded agent, confirm the id still exists;
  // if it does not, start a clean session instead. Claude keeps the pane's
  // assigned session id for the fresh launch; other threaded agents launch plain
  // and rediscover their new local thread metadata.
  async function resolveLaunchCommand(
    currentSession: AgentSession,
    defaultCommand: string
  ): Promise<string> {
    if (
      isThreadedAgentKind(currentSession.kind) &&
      currentSession.nextLaunchMode === "resume" &&
      currentSession.threadRef?.id &&
      window.vibe?.agentThreads
    ) {
      try {
        const result = await window.vibe.agentThreads.findLatest({
          provider: currentSession.kind,
          cwd: currentSession.cwd,
          confirmId: currentSession.threadRef.id
        });

        if (result?.status === "missing") {
          if (currentSession.kind !== "claude") {
            forceThreadLookupTokenRef.current = currentSession.launchToken;
            onFreshLaunchFallbackRef.current({
              threadLookupStartedAt: threadLookupAfterRef.current,
              threadLookupStatus: "pending",
              threadLookupMessage: `Saved ${profile.label} resume thread is no longer available. Started fresh and waiting for local thread metadata.`
            });
          }

          return buildLaunchCommand(currentSession, {
            mode: "new",
            platform: window.vibe?.platform
          });
        }
      } catch {
        // Confirmation unavailable (host down/timeout): fall through to the
        // resume command rather than risk a duplicate-session collision on a
        // session that may well exist.
      }
    }

    return defaultCommand;
  }

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!session.started || !terminal || terminalReadyToken === 0) {
      return;
    }

    if (
      createdRef.current &&
      lastLaunchTokenRef.current === session.launchToken
    ) {
      return;
    }

    const launchToken = session.launchToken;
    lastLaunchTokenRef.current = launchToken;
    createdRef.current = true;
    terminalExitedRef.current = false;
    terminal.clear();
    // A relaunch starts a fresh process: no frame can be open and the old
    // process's mouse-encoding state no longer applies. (A remount dedups into
    // a snapshot, whose replay re-derives the encoding state.)
    syncOutputRef.current?.reset();
    sgrMouseRef.current?.reset();
    clearIdleTimer();
    // Only a genuine (re)launch shows "starting": every launch path (create,
    // restart, resume, settings change) resets the status to "idle" first. A
    // REMOUNT of a live pane (workspace switch, maximize) re-runs this effect
    // too — the backend dedups the create into a snapshot — and must not
    // disturb a settled pill (done/failed would be unlatched by
    // "starting", then degraded to "waiting" by the settle timers).
    if (sessionRef.current.status === "idle") {
      setStatus("starting");
    }

    // The terminal opens at xterm's 80x24 default, while the first scheduled
    // fit runs on the next animation frame. A newly mounted board frame can
    // also still be at the zero-width start of its CSS transition, so suppress
    // that transition just for this measurement and fit to its laid-out size.
    const paneFrame = isArrangingRef.current
      ? null
      : containerRef.current?.closest<HTMLElement>(".pane-frame");
    if (paneFrame) {
      suppressFrameTransition(paneFrame);
    }
    fitAndResizeRef.current?.();
    if (paneFrame) {
      releaseFrameTransition(paneFrame);
    }
    if (fitMeasuredRef.current) {
      lastSentSizeRef.current = {
        cols: terminal.cols,
        rows: terminal.rows
      };
    }
    const lookupStartedAt = Date.now();
    threadLookupAfterRef.current = lookupStartedAt;
    if (isThreadedAgentKind(session.kind) && !session.threadRef?.id) {
      onThreadLookupChangeRef.current({
        threadLookupStartedAt: lookupStartedAt,
        threadLookupStatus: "pending",
        threadLookupMessage: `Waiting for ${profile.label} to create local thread metadata.`
      });
    }

    let cancelled = false;

    void (async () => {
      const command = await resolveLaunchCommand(session, launchCommand);

      // Confirming resumability is async, so the pane may have been restarted
      // (new token), closed, or torn down meanwhile — never launch into a stale
      // terminal.
      if (
        cancelled ||
        lastLaunchTokenRef.current !== launchToken ||
        !terminalRef.current
      ) {
        return;
      }

      window.vibe?.terminal.create({
        id: session.id,
        cwd: session.cwd,
        command,
        launchToken,
        fusion: session.fusion,
        openFusion: session.openFusion,
        openFusionPlannerModel: session.openFusionPlannerModel,
        openFusionExecutorModel: session.openFusionExecutorModel,
        // Advertise a size only once a real fit has measured the pane.
        // Shipping xterm's 80x24 pre-fit default here resizes a LIVE PTY down
        // to it on the backend's remount dedup path — a full-screen TUI
        // (kimi, claude) then repaints for the wrong width and shreds the
        // pane. Omitted sizes leave the existing PTY size untouched (fresh
        // spawns fall back to the ptyHost default until the first fit lands).
        cols: fitMeasuredRef.current ? terminalRef.current.cols : undefined,
        rows: fitMeasuredRef.current ? terminalRef.current.rows : undefined
      });
      scheduleThreadLookup(5000);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    // launchCommand and cwd are read fresh from the closure at launch time. A
    // (re)launch only fires on first start or a restart (launchToken bump), at
    // which point React runs this effect with the current render's command — so
    // a command-string change alone never relaunches or blanks the terminal.
    session.id,
    session.launchToken,
    session.started,
    terminalReadyToken
  ]);

  function scheduleThreadLookup(delayMs: number, finalAttempt = false) {
    const currentSession = sessionRef.current;
    const provider = currentSession.kind;
    const forceLookup =
      forceThreadLookupTokenRef.current === currentSession.launchToken;

    if (
      (currentSession.threadRef?.id && !forceLookup) ||
      !isThreadedAgentKind(provider) ||
      !window.vibe?.agentThreads ||
      (!finalAttempt && terminalExitedRef.current) ||
      (!finalAttempt &&
        (currentSession.threadLookupStatus === "ambiguous" ||
          currentSession.threadLookupStatus === "failed"))
    ) {
      return;
    }

    if (threadLookupTimeoutRef.current) {
      window.clearTimeout(threadLookupTimeoutRef.current);
    }

    threadLookupTimeoutRef.current = window.setTimeout(
      () => runThreadLookup(finalAttempt),
      delayMs
    );
  }

  async function runThreadLookup(finalAttempt: boolean) {
    const currentSession = sessionRef.current;
    const provider = currentSession.kind;
    const launchToken = currentSession.launchToken;
    const cwd = currentSession.cwd;
    const forceLookup =
      forceThreadLookupTokenRef.current === currentSession.launchToken;

    threadLookupTimeoutRef.current = null;

    if (lookupInFlightRef.current) {
      if (!finalAttempt) {
        scheduleThreadLookup(THREAD_LOOKUP_POLL_MS);
      }
      return;
    }

    if (
      (currentSession.threadRef?.id && !forceLookup) ||
      !isThreadedAgentKind(provider) ||
      !window.vibe?.agentThreads
    ) {
      return;
    }

    const lookupStartedAt =
      threadLookupAfterRef.current ||
      currentSession.threadLookupStartedAt ||
      currentSession.createdAt;

    if (
      !finalAttempt &&
      Date.now() - lookupStartedAt > THREAD_LOOKUP_TIMEOUT_MS
    ) {
      onThreadLookupChangeRef.current({
        threadLookupStartedAt: lookupStartedAt,
        threadLookupStatus: "failed",
        threadLookupMessage: `Timed out waiting for ${profile.label} local thread metadata.`
      });
      return;
    }

    lookupInFlightRef.current = true;

    try {
      if (sessionRef.current.threadRef?.id && !forceLookup) {
        return;
      }

      const result = await window.vibe?.agentThreads.findLatest({
        provider,
        cwd,
        after: lookupStartedAt,
        excludeIds: claimedThreadIdsRef.current
      });

      const latestSession = sessionRef.current;
      const latestForceLookup =
        forceThreadLookupTokenRef.current === latestSession.launchToken;
      if (
        latestSession.launchToken !== launchToken ||
        latestSession.kind !== provider ||
        latestSession.cwd !== cwd ||
        threadLookupAfterRef.current !== lookupStartedAt ||
        (latestSession.threadRef?.id && !latestForceLookup)
      ) {
        return;
      }

      if (result?.status === "found") {
        if (
          result.threadRef.id &&
          claimedThreadIdsRef.current.includes(result.threadRef.id)
        ) {
          if (finalAttempt) {
            onThreadLookupChangeRef.current({
              threadLookupStartedAt: lookupStartedAt,
              threadLookupStatus: "failed",
              threadLookupMessage: `${profile.label} thread was already claimed by another pane.`
            });
            return;
          }

          onThreadLookupChangeRef.current({
            threadLookupStartedAt: lookupStartedAt,
            threadLookupStatus: "pending",
            threadLookupMessage: `Waiting for an unclaimed ${profile.label} thread.`
          });
          scheduleThreadLookup(THREAD_LOOKUP_POLL_MS);
          return;
        }

        forceThreadLookupTokenRef.current = null;
        onThreadRefChangeRef.current(result.threadRef);
        onThreadLookupChangeRef.current({
          threadLookupStartedAt: lookupStartedAt,
          threadLookupStatus: "found",
          threadLookupMessage: undefined
        });
        return;
      }

      if (result?.status === "ambiguous") {
        onThreadLookupChangeRef.current({
          threadLookupStartedAt: lookupStartedAt,
          threadLookupStatus: "ambiguous",
          threadLookupMessage:
            result.message ??
            `Found multiple ${profile.label} threads; not guessing.`
        });
        return;
      }

      if (result?.status === "failed") {
        onThreadLookupChangeRef.current({
          threadLookupStartedAt: lookupStartedAt,
          threadLookupStatus: "failed",
          threadLookupMessage:
            result.message ?? `Could not discover ${profile.label} thread metadata.`
        });
        return;
      }

      if (finalAttempt) {
        onThreadLookupChangeRef.current({
          threadLookupStartedAt: lookupStartedAt,
          threadLookupStatus: "failed",
          threadLookupMessage: `${profile.label} exited before a thread id was captured.`
        });
        return;
      }

      onThreadLookupChangeRef.current({
        threadLookupStartedAt: lookupStartedAt,
        threadLookupStatus: "pending",
        threadLookupMessage:
          result?.message ??
          `Waiting for ${profile.label} to create local thread metadata.`
      });
      scheduleThreadLookup(THREAD_LOOKUP_POLL_MS);
    } finally {
      lookupInFlightRef.current = false;
    }
  }

  // ── Generated-title harvest ─────────────────────────────────────────────
  // The pane label starts as a placeholder ("Claude 2"). The provider titles
  // the real conversation itself — Claude from the first prompt (or a custom
  // rename), Codex from the first user message — in its local metadata. Once
  // a thread id exists without a title, poll the confirm path (it returns a
  // titled threadRef) on a bounded backoff; an Enter keystroke restarts the
  // chain because a prompt was likely just submitted.
  function canRefreshTitle(currentSession: AgentSession) {
    return (
      TITLE_REFRESH_PROVIDERS.has(currentSession.kind) &&
      Boolean(currentSession.threadRef?.id) &&
      !currentSession.threadRef?.title &&
      Boolean(window.vibe?.agentThreads)
    );
  }

  function scheduleTitleRefresh(restart: boolean) {
    if (!canRefreshTitle(sessionRef.current)) {
      return;
    }

    if (restart) {
      titleRefreshAttemptsRef.current = 0;
      if (titleRefreshTimeoutRef.current !== null) {
        window.clearTimeout(titleRefreshTimeoutRef.current);
        titleRefreshTimeoutRef.current = null;
      }
    } else if (titleRefreshTimeoutRef.current !== null) {
      // A chain is already pending; let it run.
      return;
    }

    const attempt = titleRefreshAttemptsRef.current;
    if (attempt >= TITLE_REFRESH_MAX_ATTEMPTS) {
      return;
    }

    titleRefreshAttemptsRef.current = attempt + 1;
    titleRefreshTimeoutRef.current = window.setTimeout(() => {
      titleRefreshTimeoutRef.current = null;
      void runTitleRefresh();
    }, TITLE_REFRESH_DELAY_MS * 2 ** attempt);
  }

  async function runTitleRefresh() {
    const currentSession = sessionRef.current;
    const provider = currentSession.kind;
    const threadId = currentSession.threadRef?.id;
    const launchToken = currentSession.launchToken;

    if (
      titleRefreshInFlightRef.current ||
      !threadId ||
      (provider !== "claude" && provider !== "codex") ||
      !canRefreshTitle(currentSession)
    ) {
      return;
    }

    titleRefreshInFlightRef.current = true;
    try {
      const result = await window.vibe?.agentThreads.findLatest({
        provider,
        cwd: currentSession.cwd,
        confirmId: threadId
      });

      // The pane may have relaunched or rebound its thread while we read.
      const latest = sessionRef.current;
      if (
        latest.launchToken !== launchToken ||
        latest.threadRef?.id !== threadId ||
        latest.threadRef?.title
      ) {
        return;
      }

      if (
        result?.status === "found" &&
        result.threadRef.id === threadId &&
        result.threadRef.title
      ) {
        onThreadRefChangeRef.current({
          ...latest.threadRef,
          ...result.threadRef
        });
        return;
      }

      // No metadata (or no prompt) on disk yet — continue the backoff chain.
      scheduleTitleRefresh(false);
    } catch {
      scheduleTitleRefresh(false);
    } finally {
      titleRefreshInFlightRef.current = false;
    }
  }

  // Glow the pane border when this terminal has finished a turn but hasn't been
  // looked at yet (same unread rule as the sidebar folder dot). Selecting or
  // typing into the pane clears the unread flag, which drops the glow.
  const showAttention = shouldShowAttentionDot(session);

  return (
    <article
      className={clsx(
        "terminal-pane",
        session.openFusion && "terminal-pane-open-fusion",
        isArranging && "terminal-pane-arranging",
        showAttention && "terminal-pane-attention",
        showAttention &&
          session.attention &&
          `terminal-pane-attention-${session.attention.state}`
      )}
      style={{ "--pane-accent": profile.accent } as React.CSSProperties}
      // Deliberately NOT data-session-id: the board frame owns that attribute
      // and tooling resolves a frame with closest('[data-session-id]'), which a
      // second copy on a descendant would break.
      data-pane-id={session.id}
      onPointerDown={handlePanePointerDown}
    >
      <header className="pane-header pane-drag-zone" title="Drag header to move pane">
        <div className="pane-title">
          <GripVertical className="drag-grip" size={15} />
          {providerLogoSrc ? (
            <img
              className="pane-provider-logo"
              src={providerLogoSrc}
              alt=""
            />
          ) : (
            <TerminalSquare size={15} />
          )}
          <span title={session.threadRef?.title || session.name}>
            {session.threadRef?.title || session.name}
          </span>
          <small>{profile.label}</small>
          {cwdConflict && (
            <span
              className={clsx(
                "pane-cwd-conflict-chip",
                cwdConflict.active && "is-active"
              )}
              title={cwdConflictTitle(cwdConflict)}
            >
              {cwdConflictChipLabel(cwdConflict)}
            </span>
          )}
        </div>

        <div className="pane-status">
          <span className={`status-pill status-${session.status}`}>
            {statusLabel(session.status)}
          </span>
        </div>

        <div className="pane-actions">
          <button title="Add matching pane" onClick={onAdd}>
            <Plus size={14} />
          </button>
          <button title="Duplicate pane" onClick={onDuplicate}>
            <CopyPlus size={14} />
          </button>
          {/* Split / pop-out are intentionally NOT in this row: three more
              always-visible buttons crowded the header at the 280px minimum
              pane width. The actions stay wired for a less cramped entry
              point. */}
          {isGrouped && (
            <button title="Pop out of tile" onClick={onPopOut}>
              <Ungroup size={14} />
            </button>
          )}
          <button
            title={session.started ? "Restart terminal" : "Start terminal"}
            onClick={onRestart}
          >
            {session.started ? <RefreshCcw size={14} /> : <Play size={14} />}
          </button>
          {session.resumeRef?.id && (
            <button
              title={`Resume last ${profile.label} chat`}
              onClick={onResume}
            >
              <RotateCcw size={14} />
            </button>
          )}
          <button title={isMaximized ? "Restore pane" : "Maximize pane"} onClick={onMaximize}>
            {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="danger" title="Close pane" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </header>

      <div className="terminal-command-strip">
        <span>{launchCommand || "shell"}</span>
        <span>{session.cwd}</span>
      </div>

      <div
        className="terminal-surface"
        onContextMenu={handleTerminalContextMenu}
      >
        <div ref={containerRef} className="terminal-fit-host" />
      </div>
    </article>
  );
}
