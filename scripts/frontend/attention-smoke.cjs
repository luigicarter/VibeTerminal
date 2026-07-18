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
const openFusionChatPanePath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "components",
  "OpenFusionChatPane.tsx"
);
const preloadPath = path.join(__dirname, "..", "..", "preload", "preload.cjs");
const mainPath = path.join(__dirname, "..", "..", "backend", "main.cjs");
const stylesPath = path.join(__dirname, "..", "..", "frontend", "styles.css");
const typesPath = path.join(__dirname, "..", "..", "frontend", "types.ts");
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
  codexTurnAttentionDecision,
  isCodexTurnSubmitInput,
  isHumanTerminalInput,
  isSessionWorking,
  isTurnTelemetryKind,
  providerAttentionDecision,
  normalizeAttention,
  reconcileStatus,
  shouldMarkCompletedTurnUnread,
  shouldSettleStatusOnPaneUnmount,
  shouldMarkAttentionUnread,
  shouldShowAttentionDot,
  shouldUseTerminalEventAttention,
  statusAfterUserInput,
  statusFromAttentionState,
  statusFromTerminalEvent,
  updateDetachedTaskIds
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
// A snapshot is a REPLAY (remount/reattach), not fresh activity: a live
// process must not read as "working" from replayed bytes — that used to wipe
// a settled done/failed pill on every workspace switch.
assert.strictEqual(statusFromTerminalEvent(terminalRunningSnapshot), null);
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
  shouldUseTerminalEventAttention({ id: "kimi", kind: "kimi" }),
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

// The sidebar "working" spinner lights for a foreground turn or an in-flight
// detached task, never for a booting ("starting"), idle, or waiting pane alone.
assert.strictEqual(isSessionWorking({ status: "running" }), true);
assert.strictEqual(
  isSessionWorking({ status: "done", detachedTaskIds: ["bg-1"] }),
  true
);
assert.strictEqual(
  isSessionWorking({ status: "idle", detachedTaskIds: ["bg-1", "bg-2"] }),
  true
);
assert.strictEqual(isSessionWorking({ status: "done", detachedTaskIds: [] }), false);
assert.strictEqual(isSessionWorking({ status: "starting" }), false);
assert.strictEqual(isSessionWorking({ status: "waiting" }), false);
assert.strictEqual(isSessionWorking({ status: "done" }), false);
assert.strictEqual(isSessionWorking({ status: "idle" }), false);

// Detached task lifecycle is idempotent by id so live events plus reattach
// replay cannot double-count, and any settled variant releases only its id.
const detachedBase = { status: "done" };
const detachedStarted = updateDetachedTaskIds(detachedBase, {
  type: "background-task",
  phase: "started",
  taskId: "bg-1",
  title: "first",
  kind: "task"
});
assert.deepStrictEqual(detachedStarted.detachedTaskIds, ["bg-1"]);
assert.strictEqual(
  updateDetachedTaskIds(detachedStarted, {
    type: "background-task",
    phase: "started",
    taskId: "bg-1",
    title: "first replay",
    kind: "task"
  }),
  detachedStarted
);
const detachedSecond = updateDetachedTaskIds(detachedStarted, {
  type: "background-task",
  phase: "started",
  taskId: "bg-2",
  title: "second",
  kind: "task"
});
assert.deepStrictEqual(detachedSecond.detachedTaskIds, ["bg-1", "bg-2"]);
assert.strictEqual(
  updateDetachedTaskIds(detachedSecond, {
    type: "background-task",
    phase: "progress",
    taskId: "bg-1",
    activityKind: "file",
    text: "working",
    updates: 1
  }),
  detachedSecond
);
const detachedOneLeft = updateDetachedTaskIds(detachedSecond, {
  type: "background-task",
  phase: "settled",
  taskId: "bg-1",
  cancelled: true,
  result: { status: "failed" }
});
assert.deepStrictEqual(detachedOneLeft.detachedTaskIds, ["bg-2"]);
assert.strictEqual(
  updateDetachedTaskIds(detachedOneLeft, {
    type: "background-task",
    phase: "settled",
    taskId: "unknown",
    orphaned: true,
    result: { status: "failed" }
  }),
  detachedOneLeft
);
assert.strictEqual(
  updateDetachedTaskIds(detachedOneLeft, {
    type: "background-task",
    phase: "settled",
    taskId: "bg-2",
    orphaned: true,
    result: { status: "failed" }
  }).detachedTaskIds,
  undefined
);
assert.strictEqual(shouldMarkCompletedTurnUnread(detachedStarted, true), false);
assert.strictEqual(shouldMarkCompletedTurnUnread(detachedBase, true), true);
assert.strictEqual(shouldMarkCompletedTurnUnread(detachedBase, false), false);

// claude/opencode/cursor/kimi have a turn-start signal (cursor's
// beforeSubmitPrompt hook, kimi's config.toml UserPromptSubmit hook), so they
// suppress the output-flow working heuristic. codex and plain terminals fall
// back to it.
assert.strictEqual(isTurnTelemetryKind("claude"), true);
assert.strictEqual(isTurnTelemetryKind("opencode"), true);
assert.strictEqual(isTurnTelemetryKind("cursor"), true);
assert.strictEqual(isTurnTelemetryKind("kimi"), true);
assert.strictEqual(isTurnTelemetryKind("codex"), false);
assert.strictEqual(isTurnTelemetryKind("terminal"), false);

assert.strictEqual(
  providerAttentionDecision(
    { kind: "codex", threadRef: { provider: "codex", id: "root" } },
    "codex",
    "root"
  ),
  "accept"
);
assert.strictEqual(
  providerAttentionDecision(
    { kind: "codex", threadRef: { provider: "codex", id: "root" } },
    "codex",
    "child"
  ),
  "reject"
);
assert.strictEqual(
  providerAttentionDecision({ kind: "codex" }, "codex", "fast-root"),
  "defer"
);
assert.strictEqual(
  providerAttentionDecision({ kind: "codex" }, "codex"),
  "reject"
);
assert.strictEqual(
  providerAttentionDecision({ kind: "claude" }, "codex", "forged"),
  "reject"
);
assert.strictEqual(
  providerAttentionDecision({ kind: "claude" }, "claude"),
  "accept"
);

// Detached legacy completions must not settle a newer Enter-started Codex
// turn, while the no-hook compatibility path can still accept a different id.
assert.strictEqual(
  codexTurnAttentionDecision("old", true, "old", [], "old"),
  "reject"
);
assert.strictEqual(
  codexTurnAttentionDecision("old", true, "old", [], "new"),
  "accept"
);
assert.strictEqual(
  codexTurnAttentionDecision("new", false, undefined, [], "old"),
  "reject"
);
assert.strictEqual(
  codexTurnAttentionDecision("new", false, undefined, [], "new"),
  "accept"
);
// Approval Enter resumes the same provider turn, so it creates no submit latch.
assert.strictEqual(
  codexTurnAttentionDecision("approval-turn", false, undefined, [], "approval-turn"),
  "accept"
);
assert.strictEqual(
  codexTurnAttentionDecision(undefined, false, undefined, ["done-turn"], "done-turn"),
  "reject"
);

// Plain terminals use TerminalPane's mounted output-idle heuristic, so their
// running state must settle on unmount. Codex turn state is submit/notify-driven
// and must survive pane unmounts just like telemetry-backed agents.
assert.strictEqual(
  shouldSettleStatusOnPaneUnmount({ kind: "terminal", status: "running" }),
  true
);
assert.strictEqual(
  shouldSettleStatusOnPaneUnmount({ kind: "codex", status: "running" }),
  false
);
assert.strictEqual(
  shouldSettleStatusOnPaneUnmount({ kind: "claude", status: "starting" }),
  true
);
assert.strictEqual(
  shouldSettleStatusOnPaneUnmount({ kind: "claude", status: "running" }),
  false
);
assert.strictEqual(
  shouldSettleStatusOnPaneUnmount({ kind: "terminal", status: "waiting" }),
  false
);

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

// Human keyboard input vs terminal-generated reports: typed text, Enter, and a
// bracketed paste count; focus reports, mouse reports, and arrow keys do not —
// clicking or focusing a finished TUI pane must never disturb its pill.
assert.strictEqual(isHumanTerminalInput("h"), true);
assert.strictEqual(isHumanTerminalInput("\r"), true);
assert.strictEqual(isHumanTerminalInput("\x1b[200~pasted prompt\x1b[201~"), true);
assert.strictEqual(isHumanTerminalInput("\x1b[I"), false); // focus in
assert.strictEqual(isHumanTerminalInput("\x1b[O"), false); // focus out
assert.strictEqual(isHumanTerminalInput("\x1b[<35;10;5M"), false); // mouse
assert.strictEqual(isHumanTerminalInput("\x1b[A"), false); // arrow key

// Codex has no provider turn-start hook. Only an actual Enter submission starts
// a turn; typing, navigation, and bracketed paste must stay status-neutral.
assert.strictEqual(isCodexTurnSubmitInput("\r"), true);
assert.strictEqual(isCodexTurnSubmitInput("\n"), true);
assert.strictEqual(isCodexTurnSubmitInput("\r\n"), true);
assert.strictEqual(isCodexTurnSubmitInput("h"), false);
assert.strictEqual(isCodexTurnSubmitInput("\x1b[A"), false);
assert.strictEqual(
  isCodexTurnSubmitInput("\x1b[200~prompt\ntext\x1b[201~"),
  false
);

// A human keystroke is the non-telemetry pane's turn-start signal: it releases
// a done/failed pill latched by turn-end telemetry (codex) or a finished
// process (plain terminal) to "waiting" — output alone must never do that.
assert.strictEqual(
  statusAfterUserInput({ kind: "codex", status: "done" }, "h"),
  "waiting"
);
assert.strictEqual(
  statusAfterUserInput({ kind: "codex", status: "failed" }, "\r"),
  "waiting"
);
assert.strictEqual(
  statusAfterUserInput({ kind: "terminal", status: "done" }, "h"),
  "waiting"
);
assert.strictEqual(
  statusAfterUserInput({ kind: "codex", status: "running" }, "h"),
  null
);
assert.strictEqual(
  statusAfterUserInput({ kind: "codex", status: "waiting" }, "h"),
  null
);
// Terminal-generated reports and the Esc key never release a latched pill.
assert.strictEqual(
  statusAfterUserInput({ kind: "codex", status: "done" }, "\x1b[I"),
  null
);
assert.strictEqual(
  statusAfterUserInput({ kind: "codex", status: "done" }, "\x1b"),
  null
);

// For telemetry kinds the keystroke only matters while an APPROVAL is pending:
// answering it has no hook of its own (PreToolUse fired before the prompt,
// PostToolUse fires when the tool ends), so the answer flips waiting->running.
// An idle "your turn" wait stays put — UserPromptSubmit will report the turn.
assert.strictEqual(
  statusAfterUserInput(
    {
      kind: "claude",
      status: "waiting",
      attention: { ...waiting, reason: "approval", unread: false }
    },
    "y"
  ),
  "running"
);
assert.strictEqual(
  statusAfterUserInput(
    {
      kind: "claude",
      status: "waiting",
      attention: { ...waiting, reason: "question", unread: false }
    },
    "y"
  ),
  null
);
assert.strictEqual(
  statusAfterUserInput({ kind: "claude", status: "done" }, "h"),
  null
);
assert.strictEqual(
  statusAfterUserInput({ kind: "opencode", status: "failed" }, "h"),
  null
);

// A bare Esc while a telemetry-kind turn is "running" is the TUI interrupt key
// (no hook fires for an interrupt), so it settles the pill to "waiting"
// immediately; any other state, kind, or key ignores it.
assert.strictEqual(
  statusAfterUserInput({ kind: "claude", status: "running" }, "\x1b"),
  "waiting"
);
assert.strictEqual(
  statusAfterUserInput({ kind: "opencode", status: "running" }, "\x1b"),
  "waiting"
);
// kimi hooks report the same events as claude, so the same keystroke rules
// apply: an approval answer flips waiting->running, and a bare Esc settles a
// running turn to waiting.
assert.strictEqual(
  statusAfterUserInput(
    {
      kind: "kimi",
      status: "waiting",
      attention: { ...waiting, reason: "approval", unread: false }
    },
    "y"
  ),
  "running"
);
assert.strictEqual(
  statusAfterUserInput({ kind: "kimi", status: "running" }, "\x1b"),
  "waiting"
);
assert.strictEqual(
  statusAfterUserInput({ kind: "claude", status: "running" }, "h"),
  null
);
assert.strictEqual(
  statusAfterUserInput(
    {
      kind: "claude",
      status: "waiting",
      attention: { ...waiting, reason: "approval", unread: false }
    },
    "\x1b"
  ),
  null
);
assert.strictEqual(
  statusAfterUserInput({ kind: "codex", status: "running" }, "\x1b"),
  "waiting"
);
assert.strictEqual(
  statusAfterUserInput({ kind: "codex", status: "running" }, "\x03"),
  "waiting"
);

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
    appSource.includes('session.fusion ? "fusion" : session.openFusion ? "openfusion" : session.kind') &&
    appSource.includes("applyAgentAttention(session.id, attention)"),
  "Fusion/Open Fusion add/duplicate and completion attention should use the app attention path"
);
assert(
  appSource.includes("isThreadedAgentKind(restoredKind) ||") &&
    appSource.includes('(previousStatus !== "done" && previousStatus !== "failed"));'),
  "Fusion and threaded-agent restore should relaunch a persisted pane even after the previous turn completed"
);
assert(
  appSource.includes('event.type === "activity" && event.kind === "warmup_error"') &&
    appSource.includes("applyFusionAttention(event.id") &&
    appSource.includes("Fusion execution bridge failed to start."),
  "Fusion warmup errors should mark the session failed and request attention"
);
assert(
    appSource.includes("fusionBridgeToolRef") &&
    appSource.includes('event.type === "tool-call"') &&
    appSource.includes("/codex_investigate|codex_implement|codex_respond|codex_steer_resolve/") &&
    appSource.includes("if (!isFusionBridgeTool)") &&
    appSource.includes("fusionBridgeToolRef.current.delete(toolKey)"),
  "Fusion waiting cleanup should only react to Codex bridge tool results"
);
assert(
  appSource.includes("function stopSessionProcess(session") &&
    appSource.includes("window.vibe?.fusionChat?.stop(session.id)") &&
    appSource.includes("window.vibe?.openFusionChat?.stop(session.id)") &&
    appSource.includes("window.vibe?.terminal.kill(session.id)") &&
    appSource.includes("void stopSessionProcess(session)") &&
    appSource.includes("stopSessionProcess(session).then("),
  "Fusion/Open Fusion should stop only through explicit close/restart/resume actions"
);
assert(
  appSource.includes("function clearFusionSession(") &&
    appSource.includes("threadRef: undefined") &&
    appSource.includes("resumeRef: currentChatRef ?? previousChatRef") &&
    appSource.includes("function updateFusionSettings(") &&
    appSource.includes("const executorSettingsChanged =") &&
    appSource.includes("?.updateSettings(session.id") &&
    appSource.includes("next.plannerModel !== current.plannerModel") &&
    appSource.includes("next.plannerEffort !== current.plannerEffort") &&
    appSource.includes('nextLaunchMode: relaunchResumeRef?.id ? "resume" : "new"'),
  "Fusion clear/planner settings should restart and resume the planner thread, while executor-only settings update live"
);
assert(
  appSource.includes("function updateOpenFusionSettings(") &&
    appSource.includes("nextExecutorModel !== currentExecutorModel") &&
    appSource.includes("function applyOpenFusionChatLifecycle(") &&
    appSource.includes("applyOpenFusionAttention(event.id") &&
    appSource.includes("window.vibe?.openFusionChat?.onEvent(") &&
    appSource.includes("<OpenFusionChatPane"),
  "Open Fusion chat pane should mirror lifecycle app-side and restart only on Executor changes"
);
const fusionLifecycleSource = appSource.slice(
  appSource.indexOf("function applyFusionChatLifecycle("),
  appSource.indexOf("function parseFusionToolResult(")
);
const openFusionLifecycleSource = appSource.slice(
  appSource.indexOf("function applyOpenFusionChatLifecycle("),
  appSource.indexOf("function resumeSession(")
);
assert(
  source.includes("export function updateDetachedTaskIds(") &&
    source.includes('event.phase === "started"') &&
    source.includes('event.phase === "progress"') &&
    source.includes("currentTaskIds.filter") &&
    fusionLifecycleSource.includes('event.type === "background-task"') &&
    fusionLifecycleSource.includes("updateDetachedTaskIds(session, event)") &&
    openFusionLifecycleSource.includes('event.type === "background-task"') &&
    openFusionLifecycleSource.includes("updateDetachedTaskIds(session, event)"),
  "Fusion and Open Fusion lifecycle mirrors should idempotently track detached task starts/settles before replay guards"
);
assert(
  fusionLifecycleSource.indexOf('event.type === "background-task"') <
      fusionLifecycleSource.indexOf("if (event.replay)") &&
    openFusionLifecycleSource.indexOf('event.type === "background-task"') <
      openFusionLifecycleSource.indexOf("if (event.replay)") &&
    fusionLifecycleSource.includes("shouldMarkCompletedTurnUnread(") &&
    openFusionLifecycleSource.includes("shouldMarkCompletedTurnUnread("),
  "replayed detached task lifecycle should rehydrate working state while launcher results suppress unread done attention"
);
assert(
  appSource.includes('event.type === "agent-running"') &&
    appSource.includes("applyAgentRunning(") &&
    appSource.includes('event.type === "agent-background-activity"') &&
    appSource.includes("applyAgentBackgroundActivity(event.id, event.backgroundActivity)"),
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
const terminalDisposeForCleanupIdx = terminalPaneSource.indexOf("terminal.dispose()");
const cleanupStart = terminalPaneSource.lastIndexOf(
  "return () => {",
  terminalDisposeForCleanupIdx
);
const cleanupEnd = terminalDisposeForCleanupIdx;
const cleanupBlock = terminalPaneSource.slice(cleanupStart, cleanupEnd);
assert(
  cleanupStart !== -1 &&
    cleanupEnd !== -1 &&
    cleanupBlock.includes("shouldSettleStatusOnPaneUnmount(sessionRef.current)") &&
    cleanupBlock.indexOf('setStatus("waiting")') <
      cleanupBlock.indexOf("clearIdleTimer()"),
  "terminal pane unmount should settle stale status before clearing the idle timer"
);
assert(
  terminalPaneSource.includes('sessionRef.current.kind === "codex"') &&
    terminalPaneSource.includes("isCodexTurnSubmitInput(data)") &&
    terminalPaneSource.includes("onCodexTurnStartRef.current()") &&
    terminalPaneSource.includes("function armCodexStartingSettle()"),
  "codex should use submit/notify turn state and reserve the idle timer for boot"
);
assert(
  appSource.includes("onCodexTurnStart={() =>") &&
    appSource.includes("applyCodexTurnStart(session.id)") &&
    appSource.includes("codexActiveTurnIdsRef.current.delete(sessionId)") &&
    appSource.includes("codexTurnLiveRef.current.set(sessionId, true)"),
  "codex turn start should be lifted into app state so it survives pane unmount"
);
assert(
  appSource.includes("CODEX_RUNNING_QUIET_MS = 60_000") &&
    appSource.includes("function armCodexRunningWatchdog(sessionId: string)") &&
    appSource.includes("refreshCodexRunningWatchdog(event.id)") &&
    appSource.includes("clearCodexRunningWatchdog(sessionId)"),
  "codex should have an App-owned quiet watchdog refreshed by hidden-pane PTY data"
);
assert(
  appSource.includes("codexWatchdogSettledRef") &&
    appSource.includes("codexWatchdogSettledRef.current.has(sessionId)") &&
    appSource.includes("applyAgentRunning(sessionId, true)"),
  "codex activity after a safety timeout should restore running and re-arm"
);
assert(
  appSource.includes("providerAttentionDecision(") &&
    appSource.includes("pendingCodexAttentionRef") &&
    appSource.includes("event.providerThreadId === threadRef.id"),
  "Codex completion should defer until root discovery and reject child threads"
);
assert(
  appSource.includes("codexActiveTurnIdsRef") &&
    appSource.includes("codexSubmitPendingRef") &&
    appSource.includes("codexSettledTurnIdsRef") &&
    appSource.includes("codexTurnAttentionDecision(") &&
    appSource.includes("rootAttention.attention.state === \"completed\"") &&
    appSource.includes("codexTurnLiveRef.current.set(sessionId, false)"),
  "Codex completion should reject delayed turns and clean accepted deferred turns"
);
assert(
  appSource.includes("const approvalResume =") &&
    appSource.includes('session.attention.reason === "approval"') &&
    appSource.includes("if (!approvalResume)"),
  "Codex approval Enter should preserve the active provider turn"
);
assert(
  appSource.includes("session?.kind !== \"codex\" || session.status !== \"running\"") &&
    appSource.indexOf("session?.kind !== \"codex\" || session.status !== \"running\"") <
      appSource.indexOf("codexWatchdogSettledRef.current.add(sessionId)"),
  "Codex watchdog should only mark a pane settled when it actually times out from running"
);
assert(
  terminalPaneSource.includes("useLayoutEffect(() => {") &&
    terminalPaneSource.includes("sessionRef.current = session;"),
  "terminal input should see committed session state before native xterm events"
);
assert(
  appSource.includes("CODEX_INPUT_GRACE_MS = 450") &&
    appSource.includes("recordCodexTerminalInput(session.id)") &&
    appSource.includes("Date.now() - lastInputAt < CODEX_INPUT_GRACE_MS") &&
    terminalPaneSource.includes("onCodexInputRef.current()"),
  "global codex activity recovery should ignore immediate user echo/redraw output"
);
assert(
  appSource.includes('session.kind === "codex" && status === "waiting"') &&
    appSource.includes("clearCodexRunningWatchdog(session.id)"),
  "codex Esc/Ctrl+C input should settle waiting and cancel the stale-running watchdog"
);
assert(
  terminalPaneSource.includes('event.type === "host-error" || event.type === "host-exit"') &&
    terminalPaneSource.includes('event.id && event.id !== session.id') &&
    terminalPaneSource.includes('setStatus("failed")'),
  "terminal pane should render host-level PTY failures instead of ignoring id-less events"
);
// Keyboard input decides status where no hook or output can: a human keystroke
// releases a latched done/failed pill (Codex keeps this as its compatibility
// path when lifecycle hooks are unavailable),
// answers a pending claude approval, and a bare Esc settles an interrupted
// telemetry turn. It must bypass reconcileStatus (the dedicated release
// callback, not onStatusChange); statusAfterUserInput itself filters
// terminal-generated input reports.
assert(
  terminalPaneSource.includes("statusAfterUserInput(sessionRef.current, data)") &&
    terminalPaneSource.includes("onInputStatusReleaseRef.current(releasedStatus)"),
  "terminal pane should let keyboard input release/settle the status pill"
);
// A telemetry-kind "running" that lost its turn-end hook (Esc interrupt fires
// no Stop; a notify POST can be lost) must not stay "working" forever: total
// output silence settles it to waiting. The settle only fires if the status is
// unchanged since arming (a starting->running transition must not settle a
// fresh turn after the shorter boot delay).
assert(
  terminalPaneSource.includes("TELEMETRY_RUNNING_QUIET_MS") &&
    terminalPaneSource.includes("function armTelemetrySettle()") &&
    terminalPaneSource.includes("sessionRef.current.status === armedFor"),
  "terminal pane should settle a stale telemetry 'running' after prolonged output silence"
);
// A snapshot is a replay (remount/reattach): it must not mark the pane working
// (markActiveFromOutput is called for live "data" only — 1 definition + 1 call
// site) and the launch effect must not reset a settled pill to "starting" on
// remount (every genuine launch path resets status to "idle" first).
assert(
  terminalPaneSource.includes("armTelemetrySettle();") &&
    terminalPaneSource.split("markActiveFromOutput(").length === 3 &&
    terminalPaneSource.includes('if (sessionRef.current.status === "idle") {'),
  "remounts (snapshot replays) must not disturb a settled status pill"
);
assert(
  appSource.includes("onInputStatusRelease={(status)") &&
    appSource.includes("options?.force") &&
    appSource.includes("force: true"),
  "app should apply the pane's human-input status release without reconcileStatus"
);
// Mid-turn tool activity (turnStart false) must respect the done/failed latch:
// hook POSTs race, so a PostToolUse landing after Stop cannot resurrect the
// spinner. Only a genuine turn start forces "running".
assert(
  appSource.includes("event.turnStart !== false,") &&
    appSource.includes("event.providerThreadId,") &&
    appSource.includes('!turnStart && reconcileStatus(session.status, "running") !== "running"'),
  "tool-driven agent-running events should go through the done/failed latch"
);
// A dead Fusion host strands any in-flight state — waiting especially (the
// pending decision can never be answered) — so closed must fail those too.
assert(
  appSource.includes('session.status === "waiting" ||') &&
    appSource.includes("Fusion process closed while a decision was still pending."),
  "Fusion closed while waiting/starting should mark the pane failed"
);

const fusionChatPaneSource = fs.readFileSync(fusionChatPanePath, "utf8");
const typesSource = fs.readFileSync(typesPath, "utf8");
// The pure slash-menu/catalog logic was extracted to fusionSlashMenu.ts so the
// settings smoke can execute it; grep-contract checks for those pieces read
// the module instead of the component.
const fusionSlashMenuSource = fs.readFileSync(
  path.join(__dirname, "..", "..", "frontend", "components", "fusionSlashMenu.ts"),
  "utf8"
);
// The transcript row shapes live in the shared OpenCode-parity kit (ocChat.tsx)
// both chat panes render through; row-level contracts are asserted there.
const ocChatSource = fs.readFileSync(
  path.join(__dirname, "..", "..", "frontend", "components", "ocChat.tsx"),
  "utf8"
);
assert(
  fusionChatPaneSource.includes("onAttention") &&
    fusionChatPaneSource.includes('reportAttention("completed", "done")') &&
    fusionChatPaneSource.includes('reportAttention("failed", "error"') &&
    fusionChatPaneSource.includes('reportAttention("failed", "exit"'),
  "FusionChatPane should emit completed/failed attention events"
);
assert(
  !fusionChatPaneSource.includes("fusionChat.stop(session.id)") &&
    fusionChatPaneSource.includes('case "user"') &&
    fusionChatPaneSource.includes('case "activity"'),
  "FusionChatPane unmount should preserve host sessions and rebuild from replayed events"
);
assert(
  fusionChatPaneSource.includes('normalized === "/clear"') &&
    fusionChatPaneSource.includes('normalized === "/resume"') &&
    fusionChatPaneSource.includes('normalized === "/fast"') &&
    fusionChatPaneSource.includes('normalized === "/speed"') &&
    fusionSlashMenuSource.includes("function roleControlMenu") &&
    fusionSlashMenuSource.includes('name: "/planner"') &&
    fusionSlashMenuSource.includes('name: "/executor"') &&
    fusionSlashMenuSource.includes('command: modelCommand') &&
    fusionSlashMenuSource.includes('command: `/effort ${scopeCommand(scope)} ${effort}`') &&
    fusionSlashMenuSource.includes('command: `/fast ${role} on`') &&
    fusionSlashMenuSource.includes('label: "Fast serving — On"') &&
    fusionChatPaneSource.includes('raw.match(/^\\/(?:claude|model\\s+claude)\\s+(.+)$/i)') &&
    fusionChatPaneSource.includes('raw.match(/^\\/(?:codex|model\\s+codex)\\s+(.+)$/i)') &&
    fusionChatPaneSource.includes("pendingRestartNoticeRef") &&
    fusionChatPaneSource.includes("Updated Fusion ${label} live") &&
    fusionChatPaneSource.includes("pendingRestartNoticeRef.current = session.started && requiresRestart ? notice : null") &&
    fusionSlashMenuSource.includes("const FUSION_SLASH_COMMANDS") &&
    fusionSlashMenuSource.includes("const FREE_TEXT_SLASH_COMMANDS") &&
    fusionSlashMenuSource.includes('FREE_TEXT_SLASH_COMMANDS = ["/model claude", "/model codex"]') &&
    fusionSlashMenuSource.includes("function hasFreeTextSlashArgument") &&
    fusionSlashMenuSource.includes("if (hasFreeTextSlashArgument(input))") &&
    fusionChatPaneSource.includes('className="fusion-slash-menu"') &&
    fusionChatPaneSource.includes('className="oc-prompt-meta fusion-settings-summary"') &&
    fusionChatPaneSource.includes("const startPayload =") &&
    fusionChatPaneSource.includes("plannerFamily,") &&
    fusionChatPaneSource.includes(
      '(plannerModel === "auto" ? {} : { model: plannerModel })'
    ) &&
    fusionChatPaneSource.includes(
      '(executorModel === "auto" ? {} : { executorModel })'
    ) &&
    fusionChatPaneSource.includes(
      '(plannerEffort === "auto" ? {} : { effort: plannerEffort })'
    ) &&
    fusionChatPaneSource.includes(
      '(executorEffort === "auto" ? {} : { executorEffort })'
    ) &&
    fusionChatPaneSource.includes("function applySpeedPreset") &&
    fusionChatPaneSource.includes("function applyEffortLevel") &&
    fusionChatPaneSource.includes("function normalizeRoleScope") &&
    fusionChatPaneSource.includes("function normalizeSpeedPreset") &&
    fusionSlashMenuSource.includes('{ name: "/plan"') &&
    fusionSlashMenuSource.includes('{ name: "/auto"') &&
    fusionChatPaneSource.includes('if (normalized === "/plan")') &&
    fusionChatPaneSource.includes('if (normalized === "/auto")') &&
    fusionChatPaneSource.includes('applySpeedPreset("execution"') &&
    fusionChatPaneSource.includes('applyEffortLevel(normalizeRoleScope(effortMatch[1]), effortMatch[2])') &&
    fusionSlashMenuSource.includes('`Planner (${familyDisplayName(contextPlannerFamily(context))})`') &&
    fusionSlashMenuSource.includes('`Executor (${familyDisplayName(contextExecutorFamily(context))})`') &&
    fusionChatPaneSource.includes('const FUSION_SPEAKER_LABEL = "Fusion"') &&
    fusionChatPaneSource.includes("function fusionPipelineNodeLabel") &&
    fusionChatPaneSource.includes("const plannerPipelineLabel") &&
    fusionChatPaneSource.includes("const executorPipelineLabel") &&
    fusionChatPaneSource.includes("text: FUSION_SPEAKER_LABEL") &&
    !fusionChatPaneSource.includes('"Fusion - Claude Code"') &&
    !fusionChatPaneSource.includes('"Fusion - Codex"') &&
    fusionChatPaneSource.includes("formatBackgroundActivityTitle") &&
    fusionChatPaneSource.includes('className="fusion-background-activity"') &&
    fusionChatPaneSource.includes("backgroundActivity.count > 1") &&
    fusionChatPaneSource.includes('proseRole="opus"') &&
    ocChatSource.includes('(m.kind === "thinking" || isSubagentStream) && !m.text.trim()'),
  "FusionChatPane should drive per-role settings submenus, legacy speed/effort commands, unified role labels, and empty-thinking suppression"
);
assert(
  fusionSlashMenuSource.includes("function normalizeFusionModel(value: unknown)") &&
    fusionChatPaneSource.includes('case "stderr"') &&
    // Slash commands stay usable mid-turn: send() routes through
    // handleSlashCommand BEFORE the busy branch steers.
    fusionChatPaneSource.includes("if (handleSlashCommand(text)) return;"),
  "FusionChatPane should normalize restored settings, show stderr, and allow slash commands while busy"
);
assert(
  !fusionChatPaneSource.includes("window.vibe?.agentThreads?.findLatest") &&
    !fusionChatPaneSource.includes("confirmId: launchResumeId") &&
    !fusionChatPaneSource.includes("onFreshLaunchFallbackRef.current()") &&
    fusionChatPaneSource.includes("const resumeThreadRef =") &&
    fusionChatPaneSource.includes("const resumeId = resumeThreadRef?.id;") &&
    fusionChatPaneSource.includes("claudeSessionIdRef.current = event.sessionId") &&
    fusionChatPaneSource.includes("claudeThreadTitleRef.current = titleFromFirstPrompt(event.text)") &&
    fusionChatPaneSource.includes("function publishClaudeThreadRef()") &&
    fusionChatPaneSource.includes("title: claudeThreadTitleRef.current || session.threadRef?.title") &&
    !fusionChatPaneSource.includes("session.resumeRef?.title ||"),
  "Fusion resume should use captured Claude session/title refs without discovery or silent fresh fallback"
);
assert(
    fusionChatPaneSource.includes("window.vibe.fusionChat.interrupt(session.id)") &&
    fusionChatPaneSource.includes("window.vibe.fusionChat.steer(session.id, text)") &&
    !fusionChatPaneSource.includes('className="fusion-stop"') &&
    !fusionChatPaneSource.includes("Stop the current turn") &&
    fusionChatPaneSource.includes("Steer current turn") &&
    // Escape is now tiered (dismiss menu -> interrupt busy turn -> clear
    // input); the busy branch still interrupts.
    fusionChatPaneSource.includes('if (e.key === "Escape")') &&
    fusionChatPaneSource.includes("interrupt();") &&
    fusionChatPaneSource.includes('e.key === "Enter" && !e.shiftKey') &&
    fusionChatPaneSource.includes('case "interrupted"') &&
    fusionChatPaneSource.includes('window.addEventListener("keydown", handleWindowKeyDown)') &&
    fusionChatPaneSource.includes("isSelected") &&
    appSource.includes("isSelected={session.id === selectedSessionId}"),
  "FusionChatPane should interrupt with Escape and submit prompt/steer with Enter, without a composer stop button"
);
assert(
    fusionChatPaneSource.includes("useLayoutEffect") &&
    fusionChatPaneSource.includes("composerRef") &&
    fusionChatPaneSource.includes("el.scrollHeight") &&
    fusionChatPaneSource.includes("FUSION_COMPOSER_MAX_PX") &&
    fusionChatPaneSource.includes("ResizeObserver"),
  "FusionChatPane composer should size before first paint and auto-grow with content"
);
assert(
  fusionChatPaneSource.includes("handleComposerPaste") &&
    fusionChatPaneSource.includes("handleComposerDrop") &&
    fusionChatPaneSource.includes("pathsFromPlainText") &&
    fusionChatPaneSource.includes("pathsFromFileList") &&
    fusionChatPaneSource.includes("window.vibe?.files?.describePaths") &&
    fusionChatPaneSource.includes("window.vibe?.clipboard.readFilePaths") &&
    fusionChatPaneSource.includes("onPaste={handleComposerPaste}") &&
    fusionChatPaneSource.includes("onDrop={handleComposerDrop}") &&
    fusionChatPaneSource.includes("onDragOver={handleComposerDragOver}"),
  "FusionChatPane composer should translate pasted/dropped paths into file references"
);
assert(
  fusionChatPaneSource.includes("waitingForDecisionRef") &&
    fusionChatPaneSource.includes("setWaitingState(true)") &&
    fusionChatPaneSource.includes("const [failed, setFailed] = useState(false)") &&
    fusionChatPaneSource.includes('event.kind === "warmup_error"') &&
    fusionChatPaneSource.includes('reportStatus("failed")') &&
    fusionChatPaneSource.includes("Answer Fusion to continue"),
  "FusionChatPane should render distinct waiting and failed states for approval/question turns and warmup errors"
);
// The chat panes' local flags only cover a turn in flight; how the pane
// settled (done / waiting-on-the-user / failed) must come from the
// app-reconciled session.status — otherwise a finished turn and a pane merely
// waiting for input both read "ready" in the header pill.
const openFusionChatPaneSource = fs.readFileSync(openFusionChatPanePath, "utf8");
for (const [label, chatPaneSource] of [
  ["FusionChatPane", fusionChatPaneSource],
  ["OpenFusionChatPane", openFusionChatPaneSource]
]) {
  assert(
    chatPaneSource.includes('session.status === "done"') &&
      chatPaneSource.includes('session.status === "waiting"') &&
      chatPaneSource.includes('session.status === "failed"') &&
      chatPaneSource.includes("const pillStatus = ") &&
      chatPaneSource.includes("status-${pillStatus}") &&
      !chatPaneSource.includes('failed ? "failed" : "idle"'),
    `${label} pill should mirror settled done/waiting/failed from session.status instead of collapsing to "ready"`
  );
  // Reattach replay (pane remount onto a live host session) is a transcript
  // restore, not fresh activity: the pane rebuilds its local state from
  // replayed events but must not re-emit status/attention — App's lifecycle
  // mirror tracked the live events the whole time, and re-emitting would
  // re-latch "done" and re-light an acknowledged attention dot on every
  // project switch.
  assert(
    chatPaneSource.includes("const replay = event.replay === true") &&
      chatPaneSource.includes("if (!replay) onStatusChangeRef.current(status)") &&
      chatPaneSource.includes("if (!replay) emitAttention(state, reason, message)"),
    `${label} should gate status/attention emission off replayed events`
  );
  // The launch effect must not reset a settled pill to "starting" on a plain
  // remount: every genuine launch path resets status to "idle" first, and the
  // status-neutral replay would never correct the stomp.
  assert(
    chatPaneSource.includes(
      'if (session.status === "idle" || session.status === "starting") {'
    ),
    `${label} remount over a live session must not reset the pill to "starting"`
  );
  // A settled "done" is a notification, not a resting state: engaging the
  // pane again (click or typing the next prompt) acknowledges it back to
  // "ready". waiting/failed stay put until answered / the next turn.
  assert(
    chatPaneSource.includes("const acknowledgeCompletedTurn = ") &&
      chatPaneSource.includes('onStatusChangeRef.current("idle")') &&
      chatPaneSource.includes("onPointerDown={handlePanePointerDown}") &&
      !chatPaneSource.includes("onPointerDown={onSelect}") &&
      chatPaneSource.includes("acknowledgeCompletedTurn();"),
    `${label} should release an acknowledged "done" back to ready on click/typing`
  );
}

assert(
  openFusionChatPaneSource.includes('case "steer-route"') &&
    openFusionChatPaneSource.includes("Steering: ${event.message.trim()}") &&
    typesSource.includes('type: "steer-route"; message: string'),
  "OpenFusionChatPane should surface planner-decision steering route events as visible activity rows"
);
assert(
  openFusionChatPaneSource.includes("taskChildIndexRef") &&
    !openFusionChatPaneSource.includes("taskRoleIndexRef") &&
    openFusionChatPaneSource.includes('case "task-child"') &&
    openFusionChatPaneSource.includes("taskChildIndexRef.current.set(event.childSessionId, event.toolId)") &&
    openFusionChatPaneSource.includes("taskChildIndexRef.current.get(event.sessionID)") &&
    ocChatSource.includes("oc-task-role") &&
    typesSource.includes('type: "task-child"'),
  "OpenFusionChatPane should attribute parallel executor progress by childSessionId and show a task role chip"
);

// The app-side lifecycle mirrors must ignore replayed events wholesale — they
// already hold the settled status/attention (they kept tracking live events
// while the pane was unmounted).
assert(
  appSource.split("if (event.replay) {").length === 3,
  "both chat lifecycle mirrors should skip replayed events"
);

const preloadSource = fs.readFileSync(preloadPath, "utf8");
assert(
  preloadSource.includes("parseWindowsClipboardFilePaths") &&
    preloadSource.includes('clipboard.readBuffer("FileNameW")') &&
    preloadSource.includes("webUtils?.getPathForFile") &&
    preloadSource.includes("getPathForFile: (file) => getPathForDroppedFile(file)") &&
    preloadSource.includes('ipcRenderer.invoke("files:describe-paths", payload)'),
  "preload should expose clipboard and dropped-file path helpers for composer references"
);

const mainSource = fs.readFileSync(mainPath, "utf8");
assert(
  mainSource.includes("IMAGE_FILE_EXTENSIONS") &&
    mainSource.includes("TEXT_FILE_EXTENSIONS") &&
    mainSource.includes("countTextLines") &&
    mainSource.includes('label: "[image]"') &&
    mainSource.includes('label: `[${lineCount} ${lineCount === 1 ? "line" : "lines"}]`') &&
    mainSource.includes('ipcMain.handle("files:describe-paths"'),
  "main process should describe composer paths with Codex-style file labels"
);

const stylesSource = fs.readFileSync(stylesPath, "utf8");
assert(
  stylesSource.includes("grid-template-columns: 9px 18px minmax(0, 1fr) 16px;"),
  "workspace row grid should reserve dot space before the folder icon"
);
assert(
  stylesSource.includes(".fusion-input-area") &&
    stylesSource.includes(".fusion-slash-panel") &&
    stylesSource.includes(".fusion-slash-title") &&
    !stylesSource.includes(".fusion-stop"),
  "Fusion slash-command palette should render as a submenu panel under the input"
);
assert(
  stylesSource.includes(".oc-skin .oc-prompt-input") &&
    !stylesSource.includes(".fusion-composer"),
  "Fusion composer should render as the shared OpenCode prompt box"
);
// The OpenCode-parity rows carry no per-speaker author labels at all — the
// pane speaks with one voice; role only tints Details-lane worklines.
assert(
  stylesSource.includes(".oc-skin .oc-md") &&
    stylesSource.includes(".oc-skin .oc-tool-row") &&
    stylesSource.includes(".oc-skin .oc-workline.oc-role-codex") &&
    !stylesSource.includes(".chat-tool-author") &&
    !stylesSource.includes(".fusion-chip-codex"),
  "Fusion transcript should render OpenCode-parity rows in the shared oc-skin with one visible speaker style"
);

console.log("attention smoke passed");
