// Completion-gate tracker smoke: pure, offline. Feeds hand-built normalized
// pane events through both mode factories and asserts the latch, evidence,
// gate annotation, and one-shot nudge semantics the pane chip + corrective
// reminder are built on.

const {
  createFusionGateTracker,
  createOpenFusionGateTracker,
  normalizeGatePath
} = require("../../backend/completionGate.cjs");

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const CWD = "C:\\repo";
const ROOT = "ses_root";
const CHILD = "ses_child";

function observeAll(tracker, events) {
  return events.map((event) => tracker.observe(event));
}

// ---- normalizeGatePath ----
{
  const isWin = process.platform === "win32";
  const abs = normalizeGatePath("C:\\repo\\src\\Thing.ts", CWD);
  assert(abs.includes("/") && !abs.includes("\\"), "normalizeGatePath should use forward slashes");
  if (isWin) {
    assert(abs === "c:/repo/src/thing.ts", "normalizeGatePath should case-fold on win32");
  }
  const rel = normalizeGatePath("src/Thing.ts", CWD);
  assert(rel === abs, "relative paths should resolve against cwd and match the absolute form");
  assert(
    normalizeGatePath("./src/Thing.ts", CWD) === abs,
    "leading ./ should be stripped before resolving"
  );
  assert(normalizeGatePath("", CWD) === "", "empty path stays empty");
}

// ---- Open Fusion: unverified settle + one-shot nudge ----
{
  const gate = createOpenFusionGateTracker({ cwd: CWD });
  const events = observeAll(gate, [
    { type: "tool-call", toolId: "t1", name: "task", role: "brain", input: { subagent_type: "executor" } },
    // Executor child edits a file; a child bash git MUST NOT count as planner evidence.
    { type: "tool-call", toolId: "c1", name: "edit", role: "executor", sessionID: CHILD, input: { filePath: "C:\\repo\\src\\thing.ts" } },
    { type: "tool-result", toolId: "c1", name: "edit", role: "executor", sessionID: CHILD, ok: true },
    { type: "tool-call", toolId: "c2", name: "bash", role: "executor", sessionID: CHILD, input: { command: "git diff" } },
    { type: "tool-result", toolId: "c2", name: "bash", role: "executor", sessionID: CHILD, ok: true },
    { type: "tool-result", toolId: "t1", name: "task", role: "brain", ok: true, childSessionId: CHILD, text: "<task_result>done</task_result>" },
    { type: "result", tokens: { input: 1, output: 2 } }
  ]);
  const settle = events[events.length - 1];
  assert(settle.gate && settle.gate.status === "unverified", "settle after unchecked executor return should be unverified");
  assert(settle.gate.pendingSince > 0, "unverified gate should carry pendingSince");
  const state = gate.getState();
  assert(state.latchOpen && state.nudgePending, "latch stays open and nudge armed after unverified settle");
  assert(
    state.changedFiles.length === 1 && state.changedFiles[0].endsWith("src/thing.ts"),
    "executor edit path should be captured as the changed-file set"
  );
  assert(gate.consumeNudge() === true, "consumeNudge should fire once");
  assert(gate.consumeNudge() === false, "consumeNudge must be one-shot");

  // Next turn: planner runs git diff -> verified settle, latch closed.
  const second = observeAll(gate, [
    { type: "tool-call", toolId: "b1", name: "bash", role: "brain", input: { command: "git diff --stat" } },
    { type: "tool-result", toolId: "b1", name: "bash", role: "brain", ok: true },
    { type: "result", tokens: {} }
  ]);
  const verified = second[second.length - 1];
  assert(verified.gate && verified.gate.status === "verified", "git diff should verify the pending delegation");
  assert(verified.gate.evidence[0] === "git diff", "evidence label should name the git subcommand");
  assert(!gate.getState().latchOpen && !gate.getState().nudgePending, "verified settle closes latch and disarms nudge");

  // Post-verified settle with no new delegation: no gate field at all.
  const idle = gate.observe({ type: "result", tokens: {} });
  assert(!("gate" in idle), "settles without delegation involvement carry no gate");
}

// ---- Open Fusion: read-changed-file, investigator, evidence-clears-nudge ----
{
  const gate = createOpenFusionGateTracker({ cwd: CWD });
  observeAll(gate, [
    { type: "tool-call", toolId: "t1", name: "task", role: "brain", input: { subagent_type: "executor" } },
    { type: "tool-call", toolId: "c1", name: "write", role: "executor", sessionID: CHILD, input: { filePath: "src/other.ts" } },
    { type: "tool-result", toolId: "c1", name: "write", role: "executor", sessionID: CHILD, ok: true },
    { type: "tool-result", toolId: "t1", name: "task", role: "brain", ok: true, childSessionId: CHILD },
    { type: "result", tokens: {} }
  ]);
  assert(gate.getState().nudgePending, "nudge armed after unverified settle");
  // Reading an UNRELATED file is not evidence; reading the changed file is —
  // and evidence arriving BEFORE the next input disarms the nudge.
  gate.observe({ type: "tool-call", toolId: "r0", name: "read", role: "brain", input: { filePath: "C:\\repo\\readme.md" } });
  gate.observe({ type: "tool-result", toolId: "r0", name: "read", role: "brain", ok: true });
  assert(gate.getState().latchOpen, "reading an unrelated file is not evidence");
  gate.observe({ type: "tool-call", toolId: "r1", name: "read", role: "brain", input: { filePath: "C:\\repo\\src\\other.ts" } });
  gate.observe({ type: "tool-result", toolId: "r1", name: "read", role: "brain", ok: true });
  const state = gate.getState();
  assert(!state.latchOpen && !state.nudgePending, "read of the changed file closes the latch and disarms the nudge");
  const settle = gate.observe({ type: "result", tokens: {} });
  assert(settle.gate && settle.gate.evidence[0] === "read changed file", "read-changed-file label");

  // Investigator task as evidence.
  observeAll(gate, [
    { type: "tool-call", toolId: "t2", name: "task", role: "brain", input: { subagent_type: "executor" } },
    { type: "tool-result", toolId: "t2", name: "task", role: "brain", ok: true, childSessionId: "ses_x" },
    { type: "tool-call", toolId: "t3", name: "task", role: "brain", input: { subagent_type: "investigator" } },
    { type: "tool-result", toolId: "t3", name: "task", role: "brain", ok: true }
  ]);
  const inv = gate.observe({ type: "result", tokens: {} });
  assert(inv.gate && inv.gate.status === "verified" && inv.gate.evidence[0] === "investigator", "investigator task verifies");
}

// ---- Open Fusion: interrupted settle keeps latch, arms nothing ----
{
  const gate = createOpenFusionGateTracker({ cwd: CWD });
  observeAll(gate, [
    { type: "tool-call", toolId: "t1", name: "task", role: "brain", input: { subagent_type: "executor" } },
    { type: "tool-result", toolId: "t1", name: "task", role: "brain", ok: true },
    { type: "interrupted" }
  ]);
  const aborted = gate.observe({ type: "result", tokens: {} });
  assert(!("gate" in aborted), "interrupted settle is never annotated");
  assert(gate.getState().latchOpen && !gate.getState().nudgePending, "interrupt keeps the latch, arms no nudge");
  const clean = gate.observe({ type: "result", tokens: {} });
  assert(clean.gate && clean.gate.status === "unverified", "next clean settle reports the still-open latch");
}

// ---- Fusion: codex_implement latch, Read evidence, needs_decision ignored ----
{
  const gate = createFusionGateTracker({ cwd: CWD });
  const implementResult = JSON.stringify(
    { status: "completed", summary: "done", files: ["src/api/limits.ts"], goalReached: true, nextAction: "done" },
    null,
    2
  );
  // needs_decision must not open the latch.
  observeAll(gate, [
    { type: "tool-call", toolId: "d0", name: "mcp__fusion-codex__codex_implement", input: { task: "x" } },
    { type: "tool-result", toolId: "d0", text: JSON.stringify({ status: "needs_decision", pendingId: "p1" }) }
  ]);
  assert(!gate.getState().latchOpen, "needs_decision must not open the latch");
  observeAll(gate, [
    { type: "tool-call", toolId: "d1", name: "mcp__fusion-codex__codex_implement", input: { task: "x" } },
    { type: "tool-result", toolId: "d1", text: implementResult }
  ]);
  assert(gate.getState().latchOpen, "completed codex_implement opens the latch");
  const unverified = gate.observe({ type: "result", subtype: "success", isError: false });
  assert(unverified.gate && unverified.gate.status === "unverified", "Fusion unverified settle");
  assert(gate.consumeNudge() === true && gate.consumeNudge() === false, "Fusion nudge is one-shot");

  // Read of a changed file (relative `files` vs absolute Read path) verifies.
  observeAll(gate, [
    { type: "tool-call", toolId: "r1", name: "Read", input: { file_path: "C:\\repo\\src\\api\\limits.ts" } },
    { type: "tool-result", toolId: "r1", text: "file contents" }
  ]);
  const verified = gate.observe({ type: "result", subtype: "success", isError: false });
  assert(verified.gate && verified.gate.status === "verified" && verified.gate.evidence[0] === "read changed file",
    "Read of a returned file verifies (suffix path match)");
}

// ---- Fusion: investigate evidence, error settle, latch replacement ----
{
  const gate = createFusionGateTracker({ cwd: CWD });
  observeAll(gate, [
    { type: "tool-call", toolId: "d1", name: "mcp__fusion-codex__codex_implement", input: {} },
    { type: "tool-result", toolId: "d1", text: JSON.stringify({ status: "completed", files: ["a.ts"] }) },
    // Errored settle: no annotation, latch survives.
    { type: "result", subtype: "error_during_execution", isError: true }
  ]);
  assert(gate.getState().latchOpen && !gate.getState().nudgePending, "error settle keeps latch, arms nothing");
  // A newer delegation replaces the latch (new file set).
  observeAll(gate, [
    { type: "tool-call", toolId: "d2", name: "mcp__fusion-codex__codex_implement", input: {} },
    { type: "tool-result", toolId: "d2", text: JSON.stringify({ status: "completed", files: ["b.ts"] }) }
  ]);
  assert(
    gate.getState().changedFiles.length === 1 && gate.getState().changedFiles[0].endsWith("b.ts"),
    "re-delegation replaces the latch file set"
  );
  observeAll(gate, [
    { type: "tool-call", toolId: "i1", name: "mcp__fusion-codex__codex_investigate", input: { task: "verify b.ts" } },
    { type: "tool-result", toolId: "i1", text: JSON.stringify({ status: "completed", findings: "ok" }) }
  ]);
  const settle = gate.observe({ type: "result", subtype: "success", isError: false });
  assert(settle.gate && settle.gate.evidence[0] === "investigate", "codex_investigate verifies");
}

// ---- Fusion: empty-fileset fallback + native-tool evidence (codex planner) ----
{
  const gate = createFusionGateTracker({ cwd: CWD });
  observeAll(gate, [
    { type: "tool-call", toolId: "d1", name: "mcp__fusion-codex__codex_implement", input: {} },
    { type: "tool-result", toolId: "d1", text: JSON.stringify({ status: "completed", files: [] }) },
    { type: "tool-call", toolId: "r1", name: "Read", input: { file_path: "C:\\repo\\anything.md" } },
    { type: "tool-result", toolId: "r1", text: "x" }
  ]);
  const fallback = gate.observe({ type: "result", subtype: "success", isError: false });
  assert(fallback.gate && fallback.gate.status === "verified" && fallback.gate.evidence[0] === "read",
    "empty changed-file set falls back to any successful Read");

  // Native shell git evidence (codex planner observe-only events).
  observeAll(gate, [
    { type: "tool-call", toolId: "d2", name: "mcp__fusion-codex__codex_implement", input: {} },
    { type: "tool-result", toolId: "d2", text: JSON.stringify({ status: "completed", files: ["src/x.ts"] }) },
    { type: "native-tool", name: "bash", command: "git log --oneline -3", actions: [], ok: true }
  ]);
  assert(!gate.getState().latchOpen, "native git command closes the latch");
  const nativeSettle = gate.observe({ type: "result", subtype: "success", isError: false });
  assert(nativeSettle.gate.evidence[0] === "git log", "native git evidence label");

  // Native read action against the changed set.
  observeAll(gate, [
    { type: "tool-call", toolId: "d3", name: "mcp__fusion-codex__codex_implement", input: {} },
    { type: "tool-result", toolId: "d3", text: JSON.stringify({ status: "completed", files: ["src/y.ts"] }) },
    { type: "native-tool", name: "bash", command: "type src\\y.ts", actions: [{ type: "read", command: "type src\\y.ts", name: "y.ts", path: "C:\\repo\\src\\y.ts" }], ok: true }
  ]);
  const nativeRead = gate.observe({ type: "result", subtype: "success", isError: false });
  assert(nativeRead.gate.evidence[0] === "read changed file", "native read action matches the changed set");
  // A FAILED native command is never evidence.
  observeAll(gate, [
    { type: "tool-call", toolId: "d4", name: "mcp__fusion-codex__codex_implement", input: {} },
    { type: "tool-result", toolId: "d4", text: JSON.stringify({ status: "completed", files: ["src/z.ts"] }) },
    { type: "native-tool", name: "bash", command: "git diff", actions: [], ok: false }
  ]);
  assert(gate.getState().latchOpen, "failed native command is not evidence");
}

// ---- Fusion: parallel fan-out combined result latches on the files union ----
{
  const gate = createFusionGateTracker({ cwd: CWD });
  const fanoutResult = JSON.stringify({
    status: "completed",
    summary: "### Workstream 1/2 - a\ndone\n\n### Workstream 2/2 - b\ndone",
    files: ["src/a.js", "src/b.js", "src/shared.js"],
    goalReached: false,
    nextAction: "continue",
    fileConflicts: ["src/shared.js"],
    workers: [
      { task: "a", status: "completed", files: ["src/a.js", "src/shared.js"] },
      { task: "b", status: "completed", files: ["src/b.js", "src/shared.js"] }
    ]
  });
  observeAll(gate, [
    { type: "tool-call", toolId: "f1", name: "mcp__fusion-codex__codex_implement", input: { tasks: ["a", "b"] } },
    { type: "tool-result", toolId: "f1", text: fanoutResult }
  ]);
  assert(gate.getState().latchOpen, "a fan-out combined result opens the latch");
  assert(
    gate.getState().changedFiles.length === 3,
    "the latch captures the fan-out files union"
  );
  observeAll(gate, [
    { type: "tool-call", toolId: "r1", name: "Read", input: { file_path: "C:\\repo\\src\\shared.js" } },
    { type: "tool-result", toolId: "r1", text: "contents" }
  ]);
  const settle = gate.observe({ type: "result", subtype: "success", isError: false });
  assert(
    settle.gate && settle.gate.status === "verified" && settle.gate.evidence[0] === "read changed file",
    "reading a conflicted fan-out file verifies the combined delegation"
  );
}

// ---- Fusion: aborted codex-brain settle ----
{
  const gate = createFusionGateTracker({ cwd: CWD });
  observeAll(gate, [
    { type: "tool-call", toolId: "d1", name: "mcp__fusion-codex__codex_implement", input: {} },
    { type: "tool-result", toolId: "d1", text: JSON.stringify({ status: "completed", files: [] }) }
  ]);
  const aborted = gate.observe({ type: "result", subtype: "aborted", isError: false });
  assert(!("gate" in aborted), "codex-brain aborted settle is never annotated");
  assert(gate.getState().latchOpen, "aborted settle keeps the latch");
}

// ---- Background delegation wake: the report echo opens the latch ----
// The latch opens on the WAKE echo (the moment the work is presented for
// review), not at the settle — a settle can land mid-way through an unrelated
// turn. Hosts attach `files` to the echo only for a completed implement-style
// task; failed/cancelled wakes present no work as done.
{
  const gate = createFusionGateTracker({ cwd: CWD });
  gate.observe({
    type: "user",
    text: "Background task report — x",
    backgroundReport: true,
    taskId: "bg-1",
    title: "x"
  });
  assert(!gate.getState().latchOpen, "a failed/cancelled background wake (no files) must not open the latch");
  gate.observe({
    type: "user",
    text: "Background task report — y",
    backgroundReport: true,
    taskId: "bg-2",
    title: "y",
    files: ["src/bg.ts"]
  });
  assert(gate.getState().latchOpen, "a completed background wake opens the latch with its file set");
  const unverified = gate.observe({ type: "result", subtype: "success", isError: false });
  assert(
    unverified.gate && unverified.gate.status === "unverified",
    "an unreviewed background wake settles unverified"
  );
  observeAll(gate, [
    { type: "tool-call", toolId: "r1", name: "Read", input: { file_path: "C:\\repo\\src\\bg.ts" } },
    { type: "tool-result", toolId: "r1", text: "contents" }
  ]);
  const verified = gate.observe({ type: "result", subtype: "success", isError: false });
  assert(
    verified.gate && verified.gate.status === "verified" && verified.gate.evidence[0] === "read changed file",
    "reading the background task's changed file verifies the wake turn"
  );
  // The echo shape is tracker-generic: the Open Fusion factory latches too.
  const ofGate = createOpenFusionGateTracker({ cwd: CWD });
  ofGate.observe({
    type: "user",
    text: "Background task report — z",
    backgroundReport: true,
    taskId: "obg-1",
    title: "z",
    files: ["src/of.ts"]
  });
  assert(ofGate.getState().latchOpen, "the Open Fusion tracker latches on the background wake echo too");
}

console.log("Completion gate smoke passed");
