// Output-stream helpers for TerminalPane, kept React-free so the smoke test
// can transpile and execute the real module (same pattern as splitTree.ts).

// DEC private mode 2026 ("synchronized output"): a TUI brackets a full repaint
// between BSU (?2026h) and ESU (?2026l) so the terminal presents the frame
// atomically. xterm.js has no support for the mode, and ConPTY re-chunks PTY
// output at ~4KB, so a bracketed frame arrives split across several writes and
// paints partially — visible flicker on every repaint tick of a full-screen
// TUI (qwen's virtual viewport wraps every frame this way, worst during its
// subagent panel's spinner storms). The coalescer holds bytes from a BSU until
// the matching ESU and hands the whole frame to xterm as one write. A stream
// that never uses the markers passes through untouched.
export const SYNC_BEGIN = "\u001b[?2026h";
export const SYNC_END = "\u001b[?2026l";
// The longest dangling fragment a marker split across chunk boundaries can
// leave behind: both markers share everything but the final byte.
const SYNC_MARKER_PREFIX = "\u001b[?2026";

// A frame whose ESU never arrives must not wedge the pane: flush this long
// after the frame opened and fall back to passthrough for its remainder.
export const SYNC_FLUSH_DELAY_MS = 80;
// Runaway guard — no sane frame is this large.
export const SYNC_MAX_HOLD_BYTES = 512 * 1024;

export interface SyncOutputCoalescer {
  push(data: string): void;
  // Write everything withheld right now (process exit, error banners) so no
  // bytes are lost ahead of out-of-band writes.
  flush(): void;
  // Drop everything withheld without writing. Only correct when the screen the
  // held bytes were painting is about to be wiped (terminal.reset before a
  // snapshot replay, a relaunch).
  reset(): void;
  isHolding(): boolean;
}

interface SyncOutputOptions {
  flushDelayMs?: number;
  maxHoldBytes?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

// Length of the buffer suffix that could be the start of a split marker and so
// must wait for the next chunk before it can be classified.
function partialMarkerSuffixLength(buffer: string): number {
  const max = Math.min(SYNC_MARKER_PREFIX.length, buffer.length);
  for (let length = max; length > 0; length--) {
    if (SYNC_MARKER_PREFIX.startsWith(buffer.slice(buffer.length - length))) {
      return length;
    }
  }
  return 0;
}

export function createSyncOutputCoalescer(
  write: (data: string) => void,
  options?: SyncOutputOptions
): SyncOutputCoalescer {
  const flushDelayMs = options?.flushDelayMs ?? SYNC_FLUSH_DELAY_MS;
  const maxHoldBytes = options?.maxHoldBytes ?? SYNC_MAX_HOLD_BYTES;
  const schedule =
    options?.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel =
    options?.cancel ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  // Held frame bytes (starting at the BSU) while a frame is open.
  let hold = "";
  let holding = false;
  // Chunk tail too short to classify (a possibly-split marker).
  let carry = "";
  let timer: unknown = null;

  function clearTimer() {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  }

  function flush() {
    clearTimer();
    const data = hold + carry;
    hold = "";
    carry = "";
    holding = false;
    if (data) {
      write(data);
    }
  }

  function reset() {
    clearTimer();
    hold = "";
    carry = "";
    holding = false;
  }

  function push(data: string) {
    let buffer = carry + data;
    carry = "";
    let out = "";
    // Deadline runs from each frame OPEN, not from the last byte — a storm of
    // back-to-back frames must not let an old timer fire mid-frame, and a
    // stalled frame must flush even while other bytes keep arriving.
    let openedFrame = false;

    for (;;) {
      if (!holding) {
        const begin = buffer.indexOf(SYNC_BEGIN);
        if (begin !== -1) {
          out += buffer.slice(0, begin);
          holding = true;
          openedFrame = true;
          hold = SYNC_BEGIN;
          buffer = buffer.slice(begin + SYNC_BEGIN.length);
          continue;
        }
        const keep = partialMarkerSuffixLength(buffer);
        out += buffer.slice(0, buffer.length - keep);
        carry = buffer.slice(buffer.length - keep);
        break;
      }

      const end = buffer.indexOf(SYNC_END);
      if (end !== -1) {
        out += hold + buffer.slice(0, end) + SYNC_END;
        hold = "";
        holding = false;
        buffer = buffer.slice(end + SYNC_END.length);
        continue;
      }
      const keep = partialMarkerSuffixLength(buffer);
      hold += buffer.slice(0, buffer.length - keep);
      carry = buffer.slice(buffer.length - keep);
      if (hold.length > maxHoldBytes) {
        // Degraded passthrough: dump the oversized frame and stop holding;
        // its remaining bytes stream through until the next BSU.
        out += hold;
        hold = "";
        holding = false;
      }
      break;
    }

    if (out) {
      write(out);
    }

    if (openedFrame) {
      clearTimer();
    }
    if (holding || carry) {
      if (timer === null) {
        timer = schedule(() => {
          timer = null;
          flush();
        }, flushDelayMs);
      }
    } else {
      clearTimer();
    }
  }

  return {
    push,
    flush,
    reset,
    isHolding: () => holding
  };
}

// Tracks whether the application enabled SGR mouse encoding (DECSET 1006) by
// watching the output stream. TerminalPane only synthesizes SGR-encoded wheel
// reports (see terminalWheel.ts) while this is on — for any other tracking
// encoding it leaves xterm's own single report untouched rather than feed the
// application bytes in the wrong dialect. Assignment is absolute
// (last h/l wins), so re-scanning bytes kept in the boundary tail is harmless.
const SGR_MOUSE_ENABLE = "\u001b[?1006h";
const SGR_MOUSE_DISABLE = "\u001b[?1006l";

export interface SgrMouseTracker {
  push(data: string): void;
  reset(): void;
  readonly active: boolean;
}

export function createSgrMouseTracker(): SgrMouseTracker {
  let active = false;
  let tail = "";
  return {
    push(data: string) {
      const scan = tail + data;
      const enabledAt = scan.lastIndexOf(SGR_MOUSE_ENABLE);
      const disabledAt = scan.lastIndexOf(SGR_MOUSE_DISABLE);
      if (enabledAt !== -1 || disabledAt !== -1) {
        active = enabledAt > disabledAt;
      }
      tail = scan.slice(-(SGR_MOUSE_ENABLE.length - 1));
    },
    reset() {
      active = false;
      tail = "";
    },
    get active() {
      return active;
    }
  };
}
