const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const ts = require("typescript");

// Regression guard for the terminal byte-stream helpers behind the qwen pane
// fixes (2026-08-06): DEC 2026 synchronized-output frame coalescing (partial
// full-screen repaints painted as flicker/"vibration") and per-line SGR wheel
// report synthesis for mouse-tracking TUIs (xterm sends ONE report per DOM
// wheel event, so a coalesced flick scrolled qwen's virtual viewport a single
// 3-row step). Like pane-split-smoke, this transpiles and executes the real
// production modules in memory — both are deliberately React-free.

function loadModule(relativePath) {
  const filePath = path.join(__dirname, "..", "..", ...relativePath);
  const source = fs.readFileSync(filePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    },
    fileName: filePath
  }).outputText;
  const mod = new Module(filePath, module);
  mod.filename = filePath;
  mod.paths = Module._nodeModulePaths(path.dirname(filePath));
  mod._compile(compiled, filePath);
  return mod.exports;
}

const {
  SYNC_BEGIN,
  SYNC_END,
  SYNC_FLUSH_DELAY_MS,
  createSgrMouseTracker,
  createSyncOutputCoalescer
} = loadModule(["frontend", "terminalOutput.ts"]);
const {
  MAX_WHEEL_REPORTS_PER_EVENT,
  buildSgrWheelReports,
  computeWheelLines
} = loadModule(["frontend", "terminalWheel.ts"]);

const BSU = "\u001b[?2026h";
const ESU = "\u001b[?2026l";
assert.strictEqual(SYNC_BEGIN, BSU, "BSU marker bytes");
assert.strictEqual(SYNC_END, ESU, "ESU marker bytes");

// ── Fake timer harness ───────────────────────────────────────────────────
function makeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    schedule: (callback, delayMs) => {
      const id = nextId++;
      pending.set(id, { callback, delayMs });
      return id;
    },
    cancel: (id) => {
      pending.delete(id);
    },
    fire: () => {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, entry] of entries) {
        entry.callback();
      }
    },
    get count() {
      return pending.size;
    }
  };
}

function makeCoalescer(options = {}) {
  const writes = [];
  const timers = makeTimers();
  const coalescer = createSyncOutputCoalescer((data) => writes.push(data), {
    schedule: timers.schedule,
    cancel: timers.cancel,
    ...options
  });
  return { coalescer, writes, timers };
}

// ── Coalescer: passthrough ───────────────────────────────────────────────
{
  const { coalescer, writes, timers } = makeCoalescer();
  coalescer.push("plain output\r\n");
  coalescer.push("\u001b[31mred\u001b[0m");
  assert.deepStrictEqual(
    writes,
    ["plain output\r\n", "\u001b[31mred\u001b[0m"],
    "marker-free streams pass through untouched"
  );
  assert.strictEqual(timers.count, 0, "no timer without withheld bytes");
  assert.strictEqual(coalescer.isHolding(), false);
}

// ── Coalescer: a frame split across chunks arrives as ONE write ─────────
{
  const { coalescer, writes, timers } = makeCoalescer();
  coalescer.push("before " + BSU + "frame-part-1 ");
  assert.deepStrictEqual(writes, ["before "], "frame bytes are withheld");
  assert.strictEqual(coalescer.isHolding(), true);
  assert.strictEqual(timers.count, 1, "open frame arms the flush deadline");
  coalescer.push("frame-part-2 ");
  coalescer.push("frame-part-3" + ESU + " after");
  assert.deepStrictEqual(
    writes,
    [
      "before ",
      BSU + "frame-part-1 frame-part-2 frame-part-3" + ESU + " after"
    ],
    "the closed frame lands as one write, markers preserved"
  );
  assert.strictEqual(coalescer.isHolding(), false);
  assert.strictEqual(timers.count, 0, "closing the frame disarms the timer");
}

// ── Coalescer: markers split across chunk boundaries ────────────────────
{
  const { coalescer, writes } = makeCoalescer();
  coalescer.push("head \u001b[?20");
  assert.deepStrictEqual(writes, ["head "], "possible marker tail is carried");
  coalescer.push("26hbody" + ESU.slice(0, 4));
  coalescer.push(ESU.slice(4) + "tail");
  assert.deepStrictEqual(
    writes,
    ["head ", BSU + "body" + ESU + "tail"],
    "split BSU and split ESU both reassemble"
  );
}

// ── Coalescer: lookalike tail that is not a marker flushes next push ────
{
  const { coalescer, writes } = makeCoalescer();
  coalescer.push("x\u001b[?2");
  coalescer.push("5h more");
  assert.deepStrictEqual(
    writes,
    ["x", "\u001b[?25h more"],
    "a non-2026 sequence is released once disambiguated"
  );
}

// ── Coalescer: two frames and interleaved text in one chunk ─────────────
{
  const { coalescer, writes } = makeCoalescer();
  coalescer.push("a" + BSU + "f1" + ESU + "b" + BSU + "f2" + ESU + "c");
  assert.deepStrictEqual(
    writes,
    ["a" + BSU + "f1" + ESU + "b" + BSU + "f2" + ESU + "c"],
    "fully-contained frames stream through in order"
  );
}

// ── Coalescer: deadline flush for a frame that never closes ─────────────
{
  const { coalescer, writes, timers } = makeCoalescer();
  coalescer.push(BSU + "wedged frame");
  assert.deepStrictEqual(writes, [], "open frame withheld");
  timers.fire();
  assert.deepStrictEqual(
    writes,
    [BSU + "wedged frame"],
    "deadline dumps the held frame"
  );
  assert.strictEqual(coalescer.isHolding(), false);
  coalescer.push("still streaming");
  assert.deepStrictEqual(
    writes,
    [BSU + "wedged frame", "still streaming"],
    "after a deadline flush the rest of the frame passes through"
  );
  coalescer.push(ESU + "next");
  assert.deepStrictEqual(
    writes,
    [BSU + "wedged frame", "still streaming", ESU + "next"],
    "the dangling ESU passes through harmlessly"
  );
  assert.ok(SYNC_FLUSH_DELAY_MS >= 32, "deadline spans at least two frames");
}

// ── Coalescer: deadline is per frame OPEN, not per byte ─────────────────
{
  const { coalescer, timers } = makeCoalescer();
  coalescer.push(BSU + "f1" + ESU + BSU + "f2 still open");
  assert.strictEqual(coalescer.isHolding(), true);
  assert.strictEqual(
    timers.count,
    1,
    "the second frame re-armed a fresh deadline"
  );
}

// ── Coalescer: oversized frame falls back to passthrough ────────────────
{
  const { coalescer, writes } = makeCoalescer({ maxHoldBytes: 32 });
  coalescer.push(BSU + "x".repeat(64));
  assert.strictEqual(writes.length, 1, "overflow dumps the held bytes");
  assert.strictEqual(coalescer.isHolding(), false);
}

// ── Coalescer: flush() and reset() ──────────────────────────────────────
{
  const { coalescer, writes, timers } = makeCoalescer();
  coalescer.push(BSU + "held");
  coalescer.flush();
  assert.deepStrictEqual(writes, [BSU + "held"], "flush writes held bytes");
  assert.strictEqual(timers.count, 0, "flush disarms the timer");

  coalescer.push(BSU + "dropped");
  coalescer.reset();
  timers.fire();
  assert.deepStrictEqual(
    writes,
    [BSU + "held"],
    "reset drops held bytes and cancels the timer"
  );
}

// ── SGR mouse tracker ───────────────────────────────────────────────────
{
  const tracker = createSgrMouseTracker();
  assert.strictEqual(tracker.active, false);
  tracker.push("\u001b[?1003h\u001b[?1006h");
  assert.strictEqual(tracker.active, true, "1006h enables");
  tracker.push("output that mentions nothing relevant");
  assert.strictEqual(tracker.active, true, "unrelated output keeps state");
  tracker.push("\u001b[?1006l\u001b[?1003l");
  assert.strictEqual(tracker.active, false, "1006l disables");
  tracker.push("\u001b[?10");
  tracker.push("06h");
  assert.strictEqual(tracker.active, true, "split marker reassembles");
  tracker.reset();
  assert.strictEqual(tracker.active, false, "reset clears state");
}

// ── Wheel: pixel deltas accumulate like Viewport.getLinesScrolled ───────
{
  const accumulator = { partial: 0 };
  const rowHeight = 15;
  assert.strictEqual(
    computeWheelLines(accumulator, { deltaY: 5, deltaMode: 0 }, rowHeight, 30),
    0,
    "sub-line delta produces nothing yet"
  );
  assert.strictEqual(
    computeWheelLines(accumulator, { deltaY: 5, deltaMode: 0 }, rowHeight, 30),
    0
  );
  assert.strictEqual(
    computeWheelLines(accumulator, { deltaY: 5, deltaMode: 0 }, rowHeight, 30),
    1,
    "three 5px ticks at 15px rows add up to one line"
  );
  assert.strictEqual(
    computeWheelLines(
      accumulator,
      { deltaY: 100, deltaMode: 0 },
      rowHeight,
      30
    ),
    6,
    "a 100px notch at 15px rows scrolls six lines"
  );
  assert.strictEqual(
    computeWheelLines(
      accumulator,
      { deltaY: -100, deltaMode: 0 },
      rowHeight,
      30
    ),
    -6,
    "wheel up is negative"
  );
}

// ── Wheel: line/page delta modes and guards ─────────────────────────────
{
  const accumulator = { partial: 0 };
  assert.strictEqual(
    computeWheelLines(accumulator, { deltaY: 3, deltaMode: 1 }, 15, 30),
    3,
    "line mode passes the count through"
  );
  assert.strictEqual(
    computeWheelLines(accumulator, { deltaY: 1, deltaMode: 2 }, 15, 30),
    30,
    "page mode multiplies by rows"
  );
  assert.strictEqual(
    computeWheelLines(accumulator, { deltaY: 0, deltaMode: 0 }, 15, 30),
    0,
    "zero delta is a no-op"
  );
  assert.strictEqual(
    computeWheelLines(accumulator, { deltaY: 40, deltaMode: 0 }, 0, 30),
    0,
    "unmeasured row height cannot divide"
  );
  assert.strictEqual(
    computeWheelLines(
      accumulator,
      { deltaY: 1e9, deltaMode: 1 },
      15,
      30
    ),
    MAX_WHEEL_REPORTS_PER_EVENT,
    "a pathological delta is capped"
  );
}

// ── Wheel: SGR report bytes ─────────────────────────────────────────────
{
  assert.strictEqual(
    buildSgrWheelReports(-2, 12, 7),
    "\u001b[<64;12;7M\u001b[<64;12;7M",
    "negative lines emit wheel-up reports, one per line"
  );
  assert.strictEqual(
    buildSgrWheelReports(1, 3, 4),
    "\u001b[<65;3;4M",
    "positive lines emit wheel-down"
  );
  assert.strictEqual(buildSgrWheelReports(0, 3, 4), "", "zero emits nothing");
  assert.strictEqual(
    buildSgrWheelReports(1, 0, -5),
    "\u001b[<65;1;1M",
    "coordinates clamp to the 1-based origin"
  );
}

// ── Wiring grep-locks (TerminalPane) ────────────────────────────────────
{
  const paneSource = fs
    .readFileSync(
      path.join(
        __dirname,
        "..",
        "..",
        "frontend",
        "components",
        "TerminalPane.tsx"
      ),
      "utf8"
    )
    .replace(/\r\n/g, "\n");

  assert.ok(
    paneSource.includes("createSyncOutputCoalescer((data) => terminal.write(data))"),
    "pane routes PTY writes through the coalescer"
  );
  assert.ok(
    paneSource.includes("sgrMouse.push(event.data);\n        syncOutput.push(event.data);"),
    "data events feed the tracker then the coalescer"
  );
  assert.ok(
    !/event\.type === "data"[\s\S]{0,120}terminal\.write\(event\.data\)/.test(
      paneSource
    ),
    "no direct terminal.write remains on the data path"
  );
  assert.ok(
    /event\.type === "snapshot"[\s\S]{0,400}syncOutput\.reset\(\);\s*\n\s*sgrMouse\.reset\(\);\s*\n\s*terminal\.reset\(\);/.test(
      paneSource
    ),
    "snapshot replay resets coalescer and tracker before terminal.reset"
  );
  assert.ok(
    paneSource.includes("terminal.attachCustomWheelEventHandler"),
    "pane installs the custom wheel handler"
  );
  assert.ok(
    paneSource.includes('trackingMode === "none" || trackingMode === "x10"'),
    "untracked and x10 panes keep xterm's default wheel behavior"
  );
  assert.ok(
    paneSource.includes("!sgrMouse.active || event.shiftKey"),
    "non-SGR encodings and shift-wheel fall through to xterm"
  );
  assert.ok(
    paneSource.includes("buildSgrWheelReports(lines, col, row)"),
    "synthesized reports are sent to the PTY"
  );
  const exitFlushes = paneSource.match(/syncOutput\.flush\(\);/g) ?? [];
  assert.ok(
    exitFlushes.length >= 3,
    "held bytes flush ahead of host-error/error/exit banners"
  );
}

console.log("terminal-output smoke: all assertions passed");
