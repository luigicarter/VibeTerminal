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
console.log("App runtime projection smoke passed (attention, children, exit, generations, aliases, chat isolation)");
