const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const ts = require("typescript");

const attentionPath = path.join(__dirname, "..", "..", "frontend", "attention.ts");
const appPath = path.join(__dirname, "..", "..", "frontend", "App.tsx");
const terminalPanePath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "components",
  "TerminalPane.tsx"
);
const fusionChatPanePath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "components",
  "FusionChatPane.tsx"
);
const stylesPath = path.join(__dirname, "..", "..", "frontend", "styles.css");
const source = fs.readFileSync(attentionPath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  },
  fileName: attentionPath
}).outputText;

const testModule = new Module(attentionPath, module);
testModule.filename = attentionPath;
testModule.paths = Module._nodeModulePaths(path.dirname(attentionPath));
testModule._compile(compiled, attentionPath);

const {
  attentionFromTerminalEvent,
  attentionFromEvent,
  clearUnreadAttention,
  isSessionWorking,
  isTurnTelemetryKind,
  normalizeAttention,
  reconcileStatus,
  shouldMarkAttentionUnread,
  shouldShowAttentionDot,
  shouldUseTerminalEventAttention,
  statusFromAttentionState,
  statusFromTerminalEvent
} = testModule.exports;

const completed = {
  state: "completed",
  reason: "done",
  source: "shim",
  updatedAt: 100
};
const failed = {
  state: "failed",
  reason: "exit",
  source: "shim",
  updatedAt: 101
};
const waiting = {
  state: "waiting",
  reason: "question",
  source: "provider",
  updatedAt: 102
};
const none = {
  state: "none",
  source: "process",
  updatedAt: 103
};
const terminalData = {
  id: "terminal-one",
  type: "data",
  data: "working"
};
const terminalRunningSnapshot = {
  id: "terminal-one",
  type: "snapshot",
  data: "",
  isRunning: true
};
const terminalCompletedSnapshot = {
  id: "terminal-one",
  type: "snapshot",
  data: "",
  isRunning: false,
  exitCode: 0
};
const terminalCompletedExit = {
  id: "terminal-one",
  type: "exit",
  exitCode: 0
};
const terminalFailedExit = {
  id: "terminal-one",
  type: "exit",
  exitCode: 1
};
const terminalError = {
  id: "terminal-one",
  type: "error",
  message: "spawn failed"
};

assert.strictEqual(normalizeAttention(undefined).state, "none");
assert.strictEqual(attentionFromEvent(completed, true).unread, true);
assert.strictEqual(attentionFromEvent(completed, false).unread, false);
assert.strictEqual(attentionFromEvent(none, true).unread, false);
assert.strictEqual(statusFromTerminalEvent(terminalData), "running");
assert.strictEqual(statusFromTerminalEvent(terminalRunningSnapshot), "running");
assert.strictEqual(statusFromTerminalEvent(terminalCompletedSnapshot), "done");
assert.strictEqual(statusFromTerminalEvent(terminalFailedExit), "failed");
assert.strictEqual(
  attentionFromTerminalEvent(terminalCompletedExit, 200).state,
  "completed"
);
assert.strictEqual(
  attentionFromTerminalEvent(terminalCompletedExit, 200).reason,
  "done"
);
assert.strictEqual(
  attentionFromTerminalEvent(terminalFailedExit, 201).state,
  "failed"
);
assert.strictEqual(
  attentionFromTerminalEvent(terminalFailedExit, 201).reason,
  "exit"
);
assert.strictEqual(
  attentionFromTerminalEvent(terminalError, 202).message,
  "spawn failed"
);
assert.strictEqual(
  shouldUseTerminalEventAttention({ id: "plain", kind: "terminal" }),
  true
);
assert.strictEqual(
  shouldUseTerminalEventAttention({ id: "gemini", kind: "gemini" }),
  true
);
assert.strictEqual(
  shouldUseTerminalEventAttention({ id: "codex", kind: "codex" }),
  false
);
assert.strictEqual(
  shouldUseTerminalEventAttention({ id: "claude", kind: "claude" }),
  false
);
assert.strictEqual(
  shouldUseTerminalEventAttention({ id: "opencode", kind: "opencode" }),
  false
);
assert.strictEqual(
  shouldUseTerminalEventAttention({ id: "cursor", kind: "cursor" }),
  false
);
assert.strictEqual(
  shouldMarkAttentionUnread("one", "one", ["one"], completed),
  false
);
assert.strictEqual(
  shouldMarkAttentionUnread("one", "one", ["two"], completed),
  true
);
assert.strictEqual(
  shouldMarkAttentionUnread("one", null, ["one"], completed),
  true
);
assert.strictEqual(
  shouldMarkAttentionUnread("one", "one", ["one"], none),
  false
);

assert.strictEqual(
  shouldShowAttentionDot({ id: "one", attention: { ...completed, unread: true } }),
  true
);
assert.strictEqual(
  shouldShowAttentionDot({ id: "two", attention: { ...failed, unread: true } }),
  true
);
assert.strictEqual(
  shouldShowAttentionDot({ id: "three", attention: { ...waiting, unread: true } }),
  true
);
assert.strictEqual(
  shouldShowAttentionDot({ id: "four", attention: { ...completed, unread: false } }),
  false
);
assert.strictEqual(
  shouldShowAttentionDot({ id: "five", attention: { ...none, unread: true } }),
  false
);

const readSession = { id: "six", attention: { ...completed, unread: false } };
assert.strictEqual(clearUnreadAttention(readSession), readSession);

const unreadSession = { id: "seven", attention: { ...completed, unread: true } };
const clearedSession = clearUnreadAttention(unreadSession);
assert.notStrictEqual(clearedSession, unreadSession);
assert.strictEqual(clearedSession.attention.unread, false);

// The sidebar "working" spinner only lights for an actively running pane, never
// for a booting ("starting"), idle, or waiting one.
assert.strictEqual(isSessionWorking({ status: "running" }), true);
assert.strictEqual(isSessionWorking({ status: "starting" }), false);
assert.strictEqual(isSessionWorking({ status: "waiting" }), false);
assert.strictEqual(isSessionWorking({ status: "done" }), false);
assert.strictEqual(isSessionWorking({ status: "idle" }), false);

// claude/opencode/cursor have a turn-start signal (cursor's beforeSubmitPrompt
// hook), so they suppress the output-flow working heuristic. codex and plain
// terminals fall back to it.
assert.strictEqual(isTurnTelemetryKind("claude"), true);
assert.strictEqual(isTurnTelemetryKind("opencode"), true);
assert.strictEqual(isTurnTelemetryKind("cursor"), true);
assert.strictEqual(isTurnTelemetryKind("codex"), false);
assert.strictEqual(isTurnTelemetryKind("terminal"), false);

// A coding agent runs inside the pane shell, so its lifecycle only surfaces
// through telemetry attention. Those states must map onto the pill status.
assert.strictEqual(statusFromAttentionState("waiting"), "waiting");
assert.strictEqual(statusFromAttentionState("completed"), "done");
assert.strictEqual(statusFromAttentionState("failed"), "failed");
assert.strictEqual(statusFromAttentionState("none"), null);

// Idle output and a returning shell prompt must not resurrect a finished pane,
// but live panes still move freely between working and waiting, and a restart
// ("starting") always wins.
assert.strictEqual(reconcileStatus("idle", "running"), "running");
assert.strictEqual(reconcileStatus("running", "waiting"), "waiting");
assert.strictEqual(reconcileStatus("waiting", "running"), "running");
assert.strictEqual(reconcileStatus("done", "running"), "done");
assert.strictEqual(reconcileStatus("done", "waiting"), "done");
assert.strictEqual(reconcileStatus("failed", "running"), "failed");
assert.strictEqual(reconcileStatus("done", "starting"), "starting");
assert.strictEqual(reconcileStatus("done", "done"), "done");

const appSource = fs.readFileSync(appPath, "utf8");
assert(
  appSource.includes("statusFromTerminalEvent(event)") &&
    appSource.includes("attentionFromTerminalEvent(event)") &&
    appSource.includes("applyTerminalAttention(event.id, attention)"),
  "app-level terminal listener should monitor process status and attention"
);
assert(
  appSource.includes("statusFromAttentionState(attentionEvent.state)") &&
    appSource.includes("reconcileStatus("),
  "agent attention should drive the pill status through reconcileStatus"
);
assert(
  appSource.includes("function sessionCreationKind") &&
    appSource.includes('session.fusion ? "fusion" : session.kind') &&
    appSource.includes("applyAgentAttention(session.id, attention)"),
  "Fusion add/duplicate and completion attention should use the app attention path"
);
assert(
  appSource.includes('event.type === "agent-running"') &&
    appSource.includes("applyAgentRunning("),
  "app should turn agent-running telemetry into a forced running status"
);
assert(
  appSource.includes('event.type !== "data"'),
  "app-level listener should no longer derive running status from raw output"
);
assert(
  appSource.includes("workspaceHasWorking(") &&
    appSource.includes("isSessionWorking") &&
    appSource.includes("attention-dot-working"),
  "sidebar should render a working spinner driven by isSessionWorking"
);

const workspaceRowIndex = appSource.indexOf('"workspace-button"');
const workspaceDotIndex = appSource.indexOf('"attention-dot"', workspaceRowIndex);
const workspaceFolderIndex = appSource.indexOf("<Folder", workspaceRowIndex);
assert(
  workspaceDotIndex !== -1 &&
    workspaceFolderIndex !== -1 &&
    workspaceDotIndex < workspaceFolderIndex,
  "workspace attention dot should render before the folder icon"
);

const terminalPaneSource = fs.readFileSync(terminalPanePath, "utf8");
assert(
  !terminalPaneSource.includes("onFocus={onSelect}"),
  "terminal focus should not clear unread attention"
);
assert(
  terminalPaneSource.includes("IDLE_AFTER_MS") &&
    terminalPaneSource.includes("markActive(") &&
    terminalPaneSource.includes('setStatus("waiting")'),
  "terminal pane should fall back to a waiting status when output goes idle"
);

const fusionChatPaneSource = fs.readFileSync(fusionChatPanePath, "utf8");
assert(
  fusionChatPaneSource.includes("onAttention") &&
    fusionChatPaneSource.includes('emitAttention("completed", "done")') &&
    fusionChatPaneSource.includes('emitAttention("failed", "error"') &&
    fusionChatPaneSource.includes('emitAttention("failed", "exit"'),
  "FusionChatPane should emit completed/failed attention events"
);

const stylesSource = fs.readFileSync(stylesPath, "utf8");
assert(
  stylesSource.includes("grid-template-columns: 9px 18px minmax(0, 1fr) 16px;"),
  "workspace row grid should reserve dot space before the folder icon"
);

console.log("attention smoke passed");
