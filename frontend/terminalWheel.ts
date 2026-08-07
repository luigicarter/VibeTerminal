// Wheel-to-mouse-report helpers for TerminalPane, kept React-free so the
// smoke test can transpile and execute the real module.
//
// When a TUI tracks the mouse (DECSET 1000/1002/1003 — qwen's virtual
// viewport does, with SGR encoding), xterm.js reports every DOM wheel event
// as exactly ONE wheel press, however large its delta. Chromium coalesces
// fast wheel motion into a few large-delta events, so a flick that scrolls an
// untracked buffer ~20 rows reaches the TUI as a single 3-row step — scrolling
// reads as stuck. TerminalPane intercepts the wheel through xterm's custom
// handler and synthesizes one SGR report per scrolled line instead, mirroring
// Viewport.getLinesScrolled's pixel accumulation so tracked and untracked
// panes scroll at the same rate.

export interface WheelAccumulator {
  // Fractional lines left over from previous events (trackpads emit many
  // sub-line deltas that must add up instead of vanishing).
  partial: number;
}

// Bound on reports synthesized from one event — a pathological delta must not
// turn into an unbounded PTY write.
export const MAX_WHEEL_REPORTS_PER_EVENT = 50;

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export function computeWheelLines(
  accumulator: WheelAccumulator,
  event: { deltaY: number; deltaMode: number },
  rowHeightPx: number,
  rows: number
): number {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) {
    return 0;
  }

  let amount: number;
  if (event.deltaMode === DOM_DELTA_LINE) {
    amount = event.deltaY;
  } else if (event.deltaMode === DOM_DELTA_PAGE) {
    amount = event.deltaY * Math.max(1, rows);
  } else {
    if (!(rowHeightPx > 0)) {
      return 0;
    }
    amount = event.deltaY / rowHeightPx;
  }

  accumulator.partial += amount;
  let lines = Math.trunc(accumulator.partial);
  accumulator.partial -= lines;
  if (lines > MAX_WHEEL_REPORTS_PER_EVENT) {
    lines = MAX_WHEEL_REPORTS_PER_EVENT;
  } else if (lines < -MAX_WHEEL_REPORTS_PER_EVENT) {
    lines = -MAX_WHEEL_REPORTS_PER_EVENT;
  }
  return lines;
}

// SGR wheel reports: button 64 = wheel up (negative lines), 65 = wheel down.
// col/row are 1-based; callers pass the cell under the pointer, but consumers
// like qwen ignore wheel coordinates entirely.
export function buildSgrWheelReports(
  lines: number,
  col: number,
  row: number
): string {
  if (lines === 0) {
    return "";
  }

  const code = lines < 0 ? 64 : 65;
  const clampedCol = Math.max(1, Math.floor(col) || 1);
  const clampedRow = Math.max(1, Math.floor(row) || 1);
  const report = `\u001b[<${code};${clampedCol};${clampedRow}M`;
  return report.repeat(
    Math.min(Math.abs(lines), MAX_WHEEL_REPORTS_PER_EVENT)
  );
}
