'use strict';
// Frame protocol v2: what the phone actually needs to repaint a pane.
//
// The bridge used to ship the pane's raw PTY bytes and let the phone's own xterm
// replay them. A TUI that repaints thirty lines thirty times a second is tens of
// kilobytes per second of escape sequences, most of which redraw rows that did
// not change — on a phone that is battery and cellular data spent on nothing.
//
// This module turns the bridge's own headless terminal (the `terminalObservation`
// decoder it already feeds from `broadcastTerminalEvent`) into self-contained
// ANSI row strings, hashes each row, and emits only the rows that changed, at a
// capped frame rate. Nothing here writes to a terminal: it reads `buffer.active`
// and returns strings.

const RESET = '\x1b[0m';
// The order is fixed so two style descriptors can be compared, and differenced,
// by simple array membership.
const FLAGS = [
  ['isBold', '1'], ['isDim', '2'], ['isItalic', '3'], ['isUnderline', '4'],
  ['isBlink', '5'], ['isInverse', '7'], ['isInvisible', '8'], ['isStrikethrough', '9'],
  ['isOverline', '53']
];
const DEFAULT_STYLE = { flags: [], fg: '39', bg: '49' };

const STREAM_PROTOCOL = 2;
const MAX_FPS = 12;
// 84 ms: twelve frames fit in a second and a thirteenth does not.
const FRAME_INTERVAL_MS = Math.ceil(1000 / MAX_FPS);
const SCROLLBACK_LINES = 300;

// ------------------------------------------------------------ row strings ---

function colorParam(cell, foreground) {
  if (foreground ? cell.isFgDefault() : cell.isBgDefault()) return foreground ? '39' : '49';
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) {
    return `${foreground ? 38 : 48};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
  }
  if (value >= 0 && value < 8) return String((foreground ? 30 : 40) + value);
  if (value >= 8 && value < 16) return String((foreground ? 90 : 100) + value - 8);
  return `${foreground ? 38 : 48};5;${value}`;
}
function styleOf(cell) {
  const flags = [];
  for (const [method, param] of FLAGS) if (cell[method]()) flags.push(param);
  return { flags, fg: colorParam(cell, true), bg: colorParam(cell, false) };
}
// The shortest correct hop between two styles: additions alone when nothing is
// being turned off, otherwise a reset and a restatement. SGR has no "unbold"
// that is safe across the attribute set, so a removal always costs a reset.
function transition(previous, next) {
  const removes = previous.flags.some(flag => !next.flags.includes(flag));
  if (!removes) {
    const params = next.flags.filter(flag => !previous.flags.includes(flag));
    if (next.fg !== previous.fg) params.push(next.fg);
    if (next.bg !== previous.bg) params.push(next.bg);
    return params.length ? `\x1b[${params.join(';')}m` : '';
  }
  const params = [...next.flags];
  if (next.fg !== '39') params.push(next.fg);
  if (next.bg !== '49') params.push(next.bg);
  return `\x1b[0${params.length ? ';' + params.join(';') : ''}m`;
}
// A cell worth shipping. A blank with a painted background, an inverse run or a
// rule drawn with underline is visible even though it carries no glyph.
function visibleCell(cell) {
  const chars = cell.getChars();
  if (chars && chars !== ' ') return true;
  if (cell.getWidth() === 0) return false;
  return !cell.isBgDefault() || Boolean(cell.isInverse()) || Boolean(cell.isUnderline())
    || Boolean(cell.isStrikethrough()) || Boolean(cell.isOverline());
}
// One buffer line as a self-contained ANSI string: SGR runs for colour and
// attributes, a wide character emitted once (its zero-width trailing cell is
// skipped), trailing blanks dropped, always ending at the default style so the
// next row a phone draws starts clean.
function serializeRow(line, cols, cell) {
  if (!line || !cell) return RESET;
  const limit = Math.max(0, Math.min(Number(cols) || 0, line.length));
  let end = -1;
  for (let x = limit - 1; x >= 0; x--) {
    if (!line.getCell(x, cell)) continue;
    if (visibleCell(cell)) { end = x; break; }
  }
  let out = '';
  let style = DEFAULT_STYLE;
  for (let x = 0; x <= end; x++) {
    if (!line.getCell(x, cell)) continue;
    if (cell.getWidth() === 0) continue;
    const next = styleOf(cell);
    out += transition(style, next);
    style = next;
    const chars = cell.getChars();
    out += chars === '' ? ' ' : chars;
  }
  return out + RESET;
}
// FNV-1a over the serialized row, so "changed" means changed text *or* changed
// attributes without a second pass over the cells.
function hashRow(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

// ------------------------------------------------------------- the screen ---

function renderScreen(terminal, { cursorVisible = true } = {}) {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  const top = buffer.viewportY;
  const lines = [];
  const hashes = [];
  for (let y = 0; y < terminal.rows; y++) {
    const text = serializeRow(buffer.getLine(top + y), terminal.cols, cell);
    lines.push(text);
    hashes.push(hashRow(text));
  }
  return { cols: terminal.cols, rows: terminal.rows, lines, hashes,
    cursor: { x: buffer.cursorX, y: buffer.cursorY, visible: cursorVisible !== false } };
}
// Up to `limit` lines above the viewport, oldest first. Never the viewport
// itself: the `screen` event that follows owns those rows.
function renderScrollback(terminal, limit = SCROLLBACK_LINES) {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  const top = buffer.viewportY;
  const start = Math.max(0, top - Math.max(0, limit));
  const lines = [];
  for (let y = start; y < top; y++) lines.push(serializeRow(buffer.getLine(y), terminal.cols, cell));
  return lines;
}
// Rows a viewer has not already been sent. `previous` is that viewer's own hash
// table, so two phones attached at different moments each get a correct diff.
function diffRows(previous, rendered) {
  const changed = [];
  if (!Array.isArray(previous) || previous.length !== rendered.hashes.length) {
    for (let y = 0; y < rendered.lines.length; y++) changed.push([y, rendered.lines[y]]);
    return changed;
  }
  for (let y = 0; y < rendered.hashes.length; y++) {
    if (previous[y] !== rendered.hashes[y]) changed.push([y, rendered.lines[y]]);
  }
  return changed;
}
const sameCursor = (a, b) => Boolean(a) && Boolean(b) && a.x === b.x && a.y === b.y && a.visible === b.visible;

// --------------------------------------------------------------- the pump ---
// Coalescing, so a pane repainting thirty times a second costs twelve frames.
// The clock and the timer are injected so the cap can be tested without waiting.

function createFramePump({ now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = handle => clearTimeout(handle), intervalMs = FRAME_INTERVAL_MS } = {}) {
  const pending = new Map();
  const last = new Map();

  function request(key, emit) {
    if (pending.has(key)) return false;
    const at = now();
    const previous = last.get(key);
    const wait = previous === undefined ? 0 : Math.max(0, intervalMs - (at - previous));
    if (wait <= 0) { last.set(key, at); emit(); return true; }
    const entry = {};
    pending.set(key, entry);
    entry.timer = setTimer(() => {
      pending.delete(key);
      last.set(key, now());
      emit();
    }, wait);
    entry.timer?.unref?.();
    return false;
  }
  function cancel(key) {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    try { clearTimer(entry.timer); } catch { /* a fake timer may not clear */ }
  }
  return {
    request,
    cancel,
    forget(key) { cancel(key); last.delete(key); },
    clear() { for (const key of [...pending.keys()]) cancel(key); last.clear(); },
    pendingCount: () => pending.size
  };
}

module.exports = { serializeRow, hashRow, renderScreen, renderScrollback, diffRows, sameCursor,
  createFramePump, styleOf, transition, RESET, STREAM_PROTOCOL, MAX_FPS, FRAME_INTERVAL_MS, SCROLLBACK_LINES };
