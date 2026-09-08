const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "../..");
function load(file) {
  const context = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, context);
  return context.exports;
}
const runtime = load("frontend/terminalRuntime.ts");
const attention = load("frontend/attention.ts");
const source = fs.readFileSync(path.join(root, "frontend/App.tsx"), "utf8");
const ast = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["visibleRuntimeAttention", "withRuntime", "applyAgentSubagent"];
const functions = [];
function walk(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.push(node.getText(ast));
  ts.forEachChild(node, walk);
}
walk(ast);
assert.equal(functions.length, names.length);
const session = { id: "pane", kind: "codex", name: "Codex 1", launchToken: 1, started: true, status: "idle" };
let legacy = { ...session, kind: "kimi", status: "running" };
const context = {
  ...runtime, ...attention, Date,
  runtimeSnapshots: {}, runtimeAcknowledgements: {},
  updateAnySession(_id, fn) { legacy = fn(legacy); }
};
vm.createContext(context);
vm.runInContext(ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
const base = {
  id: "pane", generation: "launch-one", launchToken: 1, revision: 1, provider: "codex",
  processState: "running", agentProcessState: "running", turnState: "waiting",
  observation: "observed", telemetryHealth: "available", children: [], childActivity: false,
  attention: { id: "wait", state: "waiting", reason: "approval", updatedAt: 1 }
};
function project(patch = {}) {
  context.runtimeSnapshots.pane = { ...base, ...patch };
  return context.withRuntime(session);
}
assert.equal(project().attention.unread, true);
context.runtimeAcknowledgements.pane = "wait";
assert.equal(project().attention.unread, false);
for (const staleChild of [
  { id: "stale", observation: "provisional" },
  { id: "background:stale" }
]) {
  const stale = { ...staleChild, attention: { id: "old-child-wait", state: "waiting", reason: "approval", updatedAt: 1 } };
  const live = { id: "live", observation: "observed", attention: { id: "live-child-wait", state: "waiting", reason: "question", updatedAt: 2 } };
  const patch = { children: [stale, live], activeTools: [], activityObserved: true,
    backgroundObservation: { availability: "unavailable" } };
  context.runtimeAcknowledgements.pane = live.attention.id;
  assert.equal(project(patch).attention.unread, false, "acknowledgement must follow the live child, never retained stale attention");
  assert.equal(project(patch).attention.reason, "question");
  context.runtimeAcknowledgements.pane = "wait";
  assert.equal(project({ ...patch, children: [stale] }).attention.unread, false, "a waiting root keeps its own attention when its child is unverified");
  assert.equal(project({ ...patch, children: [stale], turnState: "completed" }).attention, undefined);
}
for (const patch of [{ turnState: "running" }, { pendingInput: "submit" }, { pendingInput: "interrupt" }, { processState: "exited" }, { agentProcessState: "exited" }, { telemetryHealth: "unavailable" }]) {
  assert.equal(project(patch).attention, undefined, "obsolete approval must disappear");
}
const completion = { id: "done", state: "completed", reason: "done", updatedAt: 2 };
const runningChild = project({ turnState: "completed", attention: completion, children: [{ id: "child" }] });
assert.equal(runningChild.status, "running");
assert.equal(runningChild.attention, undefined, "parent response is not whole-task attention with a live child");
assert.equal(project({ turnState: "completed", attention: completion }).attention.unread, true);
const exited = project({ agentProcessState: "exited", children: [{ id: "child" }], turnState: "running" });
assert.equal(exited.subagentDepth, undefined);
assert.equal(attention.isSessionWorking(exited), false);
const named = project({ conversation: { provider: "codex", id: "thread", title: "Conversation name" } });
assert.equal(named.name, session.name, "presentation titles must never leak into persisted pane aliases on restart");
assert.equal(named.threadRef.id, "thread");
assert.equal(project({ launchToken: 0 }).status, "starting", "prior launch must not project into the current one");
const chat = { ...session, fusion: true };
assert.equal(context.withRuntime(chat), chat, "chat reducers keep ownership of their state");
for (const phase of ["start", "start", "stop"]) context.applyAgentSubagent("pane", phase, "kimi");
assert.equal(legacy.subagentDepth, 1, "compatibility path must retain the unfinished sibling");

// Exercise retained backend state through the actual App projection and sidebar
// summary. A prebuilt done/attention fixture misses Claude's provisional Stop.
const { createTerminalRuntime } = require("../../backend/terminalRuntime.cjs");
const capabilities = require("../../shared/providerCapabilities.json");
function claudeFixture() {
  let now = 10000;
  const backend = createTerminalRuntime({ now: () => now, capabilities: provider => capabilities[provider] });
  const pane = { ...session, id: "claude-status", kind: "claude" };
  const launch = backend.beginLaunch({ ...pane, provider: "claude", cwd: root,
    threadRef: { provider: "claude", id: "claude-root" } });
  const event = (type, details = {}) => backend.ingest({ id: pane.id, generation: launch.generation,
    providerThreadId: "claude-root", type, ...details });
  event("created");
  event("agent-process", { phase: "start", processId: "claude-process" });
  const snapshot = () => backend.getSnapshot(pane.id);
  const projected = () => {
    context.runtimeSnapshots[pane.id] = snapshot();
    return context.withRuntime(pane);
  };
  const check = (label, blocked) => {
    assert.equal(runtime.runtimeStatusLabel(snapshot()), label);
    assert.equal(attention.summarizeSessions([projected()]).blocked, blocked);
    assert.equal(Boolean(projected().attention?.unread), blocked > 0);
  };
  return { backend, event, snapshot, projected, check, advance: ms => { now += ms; },
    input: data => backend.recordInput({ id: pane.id, generation: launch.generation, data }) };
}
const idleNotifications = [
  { attention: { state: "waiting", reason: "question" } }, // Previous generated hooks lost notification_type.
  { notificationType: "idle_prompt", attention: { state: "waiting", reason: "question" } },
  { notificationType: "idle_prompt", attention: { state: "waiting", reason: "approval" } }
];
for (const stage of ["startup", "idle", "response", "running", "pending", "failed"]) {
  const h = claudeFixture();
  if (stage === "idle") h.event("agent-session", { phase: "start" });
  if (["response", "running", "pending", "failed"].includes(stage)) {
    h.event("agent-running", { turnStart: true });
    if (stage !== "running") {
      h.advance(5000);
      h.event("agent-attention", { attention: { state: stage === "failed" ? "failed" : "completed", reason: stage === "failed" ? "error" : "done" } });
    }
    if (stage === "pending") h.input("\r");
  }
  const before = h.snapshot();
  const expectedLabel = runtime.runtimeStatusLabel(before);
  h.advance(60000);
  for (const details of idleNotifications) {
    h.event("agent-attention", details);
    assert.deepEqual(h.snapshot(), before, `${stage}: idle reminder must not alter retained lifecycle, attention or input intent`);
  }
  assert.equal(runtime.runtimeStatusLabel(h.snapshot()), expectedLabel);
  assert.equal(attention.summarizeSessions([h.projected()]).blocked, 0);
  if (stage === "response") {
    h.check("response available", 0);
    assert.equal(runtime.runtimeElapsed(h.snapshot(), before.turnEndedAt + 3600000), "5s", "idle must not restart the elapsed timer");
    h.event("data", { data: "An ordinary response with no questions." });
    h.check("response available", 0);
  }
  h.backend.dispose();
}
for (const reason of ["approval", "question"]) {
  const h = claudeFixture();
  h.event("agent-running", { turnStart: true, providerTurnId: "turn-one" });
  const toolName = reason === "question" ? "AskUserQuestion" : "Bash";
  const tool = { toolId: "tool-one", toolName, providerTurnId: "turn-one" };
  h.event("agent-activity", { ...tool, phase: "start" });
  h.event("agent-attention", { ...tool, attention: { state: "waiting", reason } });
  h.check("needs input", 1);
  const waiting = h.snapshot();
  for (const details of idleNotifications) h.event("agent-attention", details);
  assert.deepEqual(h.snapshot(), waiting, "idle notifications must not erase or replace a genuine wait");
  if (reason === "question") {
    for (const phase of ["start", "stop"]) {
      h.event("agent-activity", { toolId: "parallel-read", toolName: "Read", phase });
      h.event("agent-running", { toolId: "parallel-read", toolName: "Read", turnStart: false });
      h.check("needs input", 1);
      assert.deepEqual(h.snapshot().attention, waiting.attention, "unrelated tool callbacks must preserve the question occurrence");
    }
  }
  h.input("\r");
  h.check("awaiting activity", 0);
  if (reason === "question") {
    h.event("agent-activity", { toolId: "parallel-read", toolName: "Read", phase: "stop" });
    h.event("agent-running", { toolId: "parallel-read", toolName: "Read", turnStart: false });
    h.check("awaiting activity", 0);
    assert.equal(h.snapshot().pendingInput, "submit", "only the matching question resolution proves the answer was accepted");
  }
  h.event("agent-activity", { ...tool, phase: "stop" });
  h.event("agent-running", { ...tool, turnStart: false });
  h.check("working", 0);
  assert.equal(h.snapshot().pendingInput, undefined, `${reason}: an answer resumes the same native turn`);
  if (reason === "question") {
    const resumed = h.snapshot();
    h.event("agent-activity", { ...tool, phase: "start" });
    h.event("agent-attention", { ...tool, attention: { state: "waiting", reason } });
    assert.deepEqual(h.snapshot(), resumed, "late duplicate question callbacks cannot reopen a resolved tool");
  }
  h.event("agent-attention", { providerTurnId: "turn-one", attention: { state: "completed", reason: "done" } });
  h.check("response available", 0);
  // A retry/continuation can ask a real question after a provisional Stop.
  h.event("agent-attention", { toolId: "tool-two", toolName: "AskUserQuestion", attention: { state: "waiting", reason: "question" } });
  h.check("needs input", 1);
  h.backend.dispose();
}
// Questions may resolve or fail without an Enter observed by the PTY monitor.
{
  const h = claudeFixture();
  const tool = { toolId: "auto-resolved-question", toolName: "AskUserQuestion" };
  h.event("agent-running", { turnStart: true });
  h.event("agent-activity", { ...tool, phase: "start" });
  h.event("agent-attention", { ...tool, attention: { state: "waiting", reason: "question" } });
  h.check("needs input", 1);
  h.event("agent-activity", { ...tool, phase: "stop" });
  h.event("agent-running", { ...tool, turnStart: false });
  h.check("working", 0);
  h.backend.dispose();
}
// A child question needs user attention without changing the root-turn proof.
{
  const h = claudeFixture();
  h.event("agent-running", { turnStart: true });
  h.event("agent-attention", { providerThreadId: "child", parentThreadId: "claude-root", toolName: "AskUserQuestion",
    attention: { state: "waiting", reason: "question" } });
  h.check("needs input", 1);
  assert.equal(h.snapshot().turnState, "running", "child question preserves the root state");
  assert.equal(h.projected().subagentDepth, undefined, "blocked child is counted as attention rather than working");
  h.backend.dispose();
}
for (const answered of [false, true]) {
  const h = claudeFixture();
  const tool = { toolId: "superseded-question", toolName: "AskUserQuestion" };
  h.event("agent-running", { turnStart: true });
  h.event("agent-activity", { ...tool, phase: "start" });
  h.event("agent-attention", { ...tool, attention: { state: "waiting", reason: "question" } });
  if (answered) h.input("\r");
  h.event("agent-running", { turnStart: true });
  h.check("working", 0);
  assert.equal(h.snapshot().activeTools.length, 0, "a genuine new turn supersedes prior question tools");
  assert.equal(h.snapshot().pendingInput, undefined);
  h.event("agent-activity", { ...tool, phase: "start" });
  h.event("agent-attention", { ...tool, attention: { state: "waiting", reason: "question" } });
  h.check("working", 0);
  h.backend.dispose();
}
for (const outcome of ["completed", "failed"]) {
  const h = claudeFixture();
  const tool = { toolId: "settled-question", toolName: "AskUserQuestion" };
  h.event("agent-running", { turnStart: true });
  h.event("agent-activity", { ...tool, phase: "start" });
  h.event("agent-attention", { ...tool, attention: { state: "waiting", reason: "question" } });
  h.event("agent-attention", { attention: { state: outcome, reason: outcome === "failed" ? "error" : "done" } });
  const settled = h.snapshot();
  h.event("agent-activity", { ...tool, phase: "start" });
  h.event("agent-attention", { ...tool, attention: { state: "waiting", reason: "question" } });
  assert.deepEqual(h.snapshot(), settled, "late question callbacks must not replace a response or failure");
  h.backend.dispose();
}
console.log("App runtime projection smoke passed (attention, children, exit, generations, aliases, chat isolation, Claude idle/question lifecycle)");
