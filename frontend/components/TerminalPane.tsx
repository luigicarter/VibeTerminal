import { useEffect, useMemo, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { CanvasAddon } from "@xterm/addon-canvas";
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
  X
} from "lucide-react";
import clsx from "clsx";
import {
  isTurnTelemetryKind,
  reconcileStatus,
  shouldShowAttentionDot
} from "../attention";
import { buildLaunchCommand, isThreadedAgentKind } from "../sessionLaunch";
import {
  isTerminalCopyShortcut,
  isTerminalPasteShortcut
} from "../terminalClipboard";
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
// How long a live pane may produce no output before we treat it as idle and
// surface "waiting" (the agent/shell is quiet, so it's the user's turn). Longer
// means fewer false "waiting" flips while an agent pauses mid-task, at the cost
// of a slower idle signal.
const IDLE_AFTER_MS = 1500;
// After the user interacts with a pane (keystroke, paste, or a mouse/focus
// report a full-screen TUI requests), the bytes that echo straight back — the
// typed character, the prompt redraw, the focus/mouse ack — are NOT the agent
// working. Ignore output this soon after the last input so typing in or clicking
// a pane never reads as "working".
const INPUT_GRACE_MS = 450;

interface ThreadLookupPatch {
  threadLookupStartedAt?: number;
  threadLookupStatus: AgentThreadLookupStatus;
  threadLookupMessage?: string;
}

interface TerminalPaneProps {
  session: AgentSession;
  profile: AgentProfile;
  claimedThreadIds: string[];
  isMaximized: boolean;
  isArranging: boolean;
  onClose: () => void;
  onDuplicate: () => void;
  onRestart: () => void;
  onResume: () => void;
  onAdd: () => void;
  onSelect: () => void;
  onMaximize: () => void;
  onThreadRefChange: (threadRef: AgentThreadRef) => void;
  onThreadLookupChange: (patch: ThreadLookupPatch) => void;
  onStatusChange: (status: SessionStatus) => void;
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
  claimedThreadIds,
  isMaximized,
  isArranging,
  onAdd,
  onClose,
  onDuplicate,
  onMaximize,
  onRestart,
  onResume,
  onSelect,
  onThreadRefChange,
  onThreadLookupChange,
  onStatusChange
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef(session);
  const createdRef = useRef(false);
  const lastLaunchTokenRef = useRef(0);
  const onStatusChangeRef = useRef(onStatusChange);
  const onThreadRefChangeRef = useRef(onThreadRefChange);
  const onThreadLookupChangeRef = useRef(onThreadLookupChange);
  const isArrangingRef = useRef(isArranging);
  const pendingFitRef = useRef(false);
  const fitFrameRef = useRef<number | null>(null);
  const repaintFrameRef = useRef<number | null>(null);
  const fitAndResizeRef = useRef<(() => void) | null>(null);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const threadLookupTimeoutRef = useRef<number | null>(null);
  const threadLookupAfterRef = useRef(
    session.threadLookupStartedAt ?? session.createdAt
  );
  const terminalExitedRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);
  const lastInputAtRef = useRef(0);
  const lookupInFlightRef = useRef(false);
  const claimedThreadIdsRef = useRef(claimedThreadIds);

  const platform = window.vibe?.platform;

  const launchCommand = useMemo(
    () => buildLaunchCommand(session, { platform }),
    [session, platform]
  );

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    onThreadRefChangeRef.current = onThreadRefChange;
  }, [onThreadRefChange]);

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
    };
  }, []);

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

  // Decide whether a chunk of PTY output should read as the agent "working".
  function markActiveFromOutput() {
    // claude/opencode own their working state through turn telemetry
    // (UserPromptSubmit / busy events), so their output never sets "running" —
    // otherwise a focus/click redraw or a keystroke echo would look like work.
    // The first quiet gap after boot still settles the "starting" pill to
    // "waiting" so a freshly launched agent doesn't read as starting forever.
    if (isTurnTelemetryKind(sessionRef.current.kind)) {
      if (sessionRef.current.status !== "starting") {
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
      return;
    }

    // codex / plain terminals / others: output is "working" unless it lands
    // inside the input grace window, where it is just the echo of, or the TUI's
    // response to, the user's own keystroke/click.
    if (Date.now() - lastInputAtRef.current < INPUT_GRACE_MS) {
      return;
    }

    markActive();
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

  function scheduleTerminalRepaint() {
    if (repaintFrameRef.current !== null) {
      return;
    }

    repaintFrameRef.current = requestAnimationFrame(() => {
      repaintFrameRef.current = null;
      const terminal = terminalRef.current;
      if (!terminal || terminal.rows <= 0) {
        return;
      }

      try {
        terminal.refresh(0, terminal.rows - 1);
      } catch {
        // A repaint can race with xterm teardown during pane removal.
      }
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
        background: "#1b1f1c",
        foreground: "#efeee7",
        cursor: profile.accent,
        cursorAccent: "#141615",
        selectionBackground: "#3f4a44",
        black: "#101211",
        red: "#ff6b6b",
        green: "#87d37c",
        yellow: "#f2c94c",
        blue: "#70a8ff",
        magenta: "#c78bff",
        cyan: "#6bd7db",
        white: "#f2f0e8",
        brightBlack: "#636a64",
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

    // Use xterm's canvas (2D) renderer rather than WebGL. WebGL allocates one
    // GL context per terminal and Chromium caps concurrent contexts (~16,
    // evicting the oldest -> context loss), which breaks a tiled board of many
    // panes; the 2D canvas renderer has no per-page context limit. Note it
    // repaints only the rows xterm marks dirty (not the whole surface), so it
    // cannot mask buffer-level corruption -- left-column glyph bleed is fixed by
    // keeping convertEol false above, not here. If the renderer can't initialize
    // we fall back to xterm's built-in DOM renderer.
    try {
      terminal.loadAddon(new CanvasAddon());
      scheduleTerminalRepaint();
    } catch {
      // Canvas context unavailable: xterm keeps using the DOM renderer.
    }

    terminal.focus();
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

    const fitAndResize = () => {
      if (isArrangingRef.current) {
        pendingFitRef.current = true;
        return;
      }

      try {
        fitAddon.fit();
        scheduleTerminalRepaint();
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
      window.vibe?.terminal.input(session.id, data);
      // User interaction (keys, paste, mouse/focus reports) is not the agent
      // working, so it must not mark the pane active. Record when it happened so
      // the echo/redraw that follows can be told apart from real output.
      lastInputAtRef.current = Date.now();
    });

    const removeListener = window.vibe?.terminal.onEvent((event) => {
      if (event.type === "host-error" || event.type === "host-exit") {
        if ("id" in event && event.id && event.id !== session.id) {
          return;
        }

        terminal.writeln("");
        terminal.writeln(`\x1b[31m${event.message}\x1b[0m`, scheduleTerminalRepaint);
        clearIdleTimer();
        setStatus("failed");
        return;
      }

      if (!("id" in event) || event.id !== session.id) {
        return;
      }

      if (event.type === "data") {
        terminal.write(event.data, scheduleTerminalRepaint);
        markActiveFromOutput();
      }

      if (event.type === "snapshot") {
        terminal.reset();
        scheduleTerminalRepaint();
        if (event.data) {
          terminal.write(event.data, scheduleTerminalRepaint);
        }

        if (event.isRunning) {
          markActiveFromOutput();
        } else {
          terminalExitedRef.current = true;
          terminal.writeln("");
          terminal.writeln(
            "\x1b[33mProcess exited. Use restart to run it again.\x1b[0m",
            scheduleTerminalRepaint
          );
          clearIdleTimer();
          setStatus(event.exitCode === 0 ? "done" : "failed");
        }
      }

      if (event.type === "error") {
        terminal.writeln("");
        terminal.writeln(`\x1b[31m${event.message}\x1b[0m`, scheduleTerminalRepaint);
        clearIdleTimer();
        setStatus("failed");
      }

      if (event.type === "exit") {
        terminalExitedRef.current = true;
        terminal.writeln("");
        terminal.writeln(
          "\x1b[33mProcess exited. Use restart to run it again.\x1b[0m",
          scheduleTerminalRepaint
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
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
      if (repaintFrameRef.current !== null) {
        cancelAnimationFrame(repaintFrameRef.current);
        repaintFrameRef.current = null;
      }
      clearIdleTimer();
      removeListener?.();
      removeContextMenuPasteListener?.();
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
  // (`codex resume <id>`), opencode a known session (`opencode --session <id>`).
  // Resuming an id the agent no longer has hard-fails in the live shell pane
  // (e.g. claude's "No conversation found") and strands the user at a bare
  // prompt. So before resuming any threaded agent, confirm the id still exists;
  // if it does not, start a clean session instead. (For claude the fresh launch
  // reuses the still-unused pre-assigned id; codex/opencode just launch plain.)
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
    if (!session.started || !terminal) {
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
    scheduleTerminalRepaint();
    clearIdleTimer();
    setStatus("starting");
    lastSentSizeRef.current = {
      cols: terminal.cols,
      rows: terminal.rows
    };
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
        cols: terminalRef.current.cols,
        rows: terminalRef.current.rows
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
    session.started
  ]);

  function scheduleThreadLookup(delayMs: number, finalAttempt = false) {
    const currentSession = sessionRef.current;
    const provider = currentSession.kind;

    if (
      currentSession.threadRef?.id ||
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

    threadLookupTimeoutRef.current = null;

    if (
      lookupInFlightRef.current ||
      currentSession.threadRef?.id ||
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
      if (sessionRef.current.threadRef?.id) {
        return;
      }

      const result = await window.vibe?.agentThreads.findLatest({
        provider,
        cwd: currentSession.cwd,
        after: lookupStartedAt,
        excludeIds: claimedThreadIdsRef.current
      });

      if (result?.status === "found") {
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

  // Glow the pane border when this terminal has finished a turn but hasn't been
  // looked at yet (same unread rule as the sidebar folder dot). Selecting or
  // typing into the pane clears the unread flag, which drops the glow.
  const showAttention = shouldShowAttentionDot(session);

  return (
    <article
      className={clsx(
        "terminal-pane",
        isArranging && "terminal-pane-arranging",
        showAttention && "terminal-pane-attention",
        showAttention &&
          session.attention &&
          `terminal-pane-attention-${session.attention.state}`
      )}
      style={{ "--pane-accent": profile.accent } as React.CSSProperties}
      onPointerDown={handlePanePointerDown}
    >
      <header className="pane-header pane-drag-zone" title="Drag header to move pane">
        <div className="pane-title">
          <GripVertical className="drag-grip" size={15} />
          <TerminalSquare size={15} />
          <span>{session.name}</span>
          <small>{profile.label}</small>
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
