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
const preloadPath = path.join(__dirname, "..", "..", "preload", "preload.cjs");
const mainPath = path.join(__dirname, "..", "..", "backend", "main.cjs");
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
  isHumanTerminalInput,
  isSessionWorking,
  isTurnTelemetryKind,
  normalizeAttention,
  reconcileStatus,
  shouldSettleStatusOnPaneUnmount,
  shouldMarkAttentionUnread,
  shouldShowAttentionDot,
  shouldUseTerminalEventAttention,
  statusAfterUserInput,
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

// Plain terminals and Codex use TerminalPane's mounted output-idle heuristic.
// If that pane unmounts while marked running, the folder spinner must not stay
// stuck on "working" forever. A telemetry-backed agent that unmounts during its
// initial boot also must not stay "starting" forever. Telemetry-backed running
// state is provider-driven and should be preserved.
assert.strictEqual(
  shouldSettleStatusOnPaneUnmount({ kind: "terminal", status: "running" }),
  true
);
assert.strictEqual(
  shouldSettleStatusOnPaneUnmount({ kind: "codex", status: "running" }),
  true
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
  null
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
    appSource.includes("/codex_investigate|codex_implement|codex_respond/") &&
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
    appSource.includes("const codexSettingsChanged =") &&
    appSource.includes("?.updateSettings(session.id") &&
    appSource.includes("nextFusionModel !== currentFusionModel") &&
    appSource.includes("nextFusionClaudeEffort !== currentFusionClaudeEffort") &&
    appSource.includes('nextLaunchMode: relaunchResumeRef?.id ? "resume" : "new"'),
  "Fusion clear/planning settings should restart and resume Claude, while Codex-only settings update live"
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
  terminalPaneSource.includes('event.type === "host-error" || event.type === "host-exit"') &&
    terminalPaneSource.includes('event.id && event.id !== session.id') &&
    terminalPaneSource.includes('setStatus("failed")'),
  "terminal pane should render host-level PTY failures instead of ignoring id-less events"
);
// Keyboard input decides status where no hook or output can: a human keystroke
// releases a latched done/failed pill (codex has no turn-start telemetry, so
// without this a completed codex pane could never show working/waiting again),
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
  appSource.includes("applyAgentRunning(event.id, event.turnStart !== false)") &&
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
assert(
  fusionChatPaneSource.includes("onAttention") &&
    fusionChatPaneSource.includes('emitAttention("completed", "done")') &&
    fusionChatPaneSource.includes('emitAttention("failed", "error"') &&
    fusionChatPaneSource.includes('emitAttention("failed", "exit"'),
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
    fusionChatPaneSource.includes('"Fusion Speed / Planning"') &&
    fusionChatPaneSource.includes('"Fusion Speed / Execution"') &&
    fusionChatPaneSource.includes('"Fusion Effort / Whole Harness"') &&
    fusionChatPaneSource.includes('"Fusion Effort / Planning"') &&
    fusionChatPaneSource.includes('"Fusion Effort / Execution"') &&
    fusionChatPaneSource.includes('raw.match(/^\\/(?:claude|model\\s+claude)\\s+(.+)$/i)') &&
    fusionChatPaneSource.includes('raw.match(/^\\/(?:codex|model\\s+codex)\\s+(.+)$/i)') &&
    fusionChatPaneSource.includes("pendingRestartNoticeRef") &&
    fusionChatPaneSource.includes("Updated Fusion ${label} live") &&
    fusionChatPaneSource.includes("pendingRestartNoticeRef.current = session.started && requiresRestart ? notice : null") &&
    fusionChatPaneSource.includes("const FUSION_SLASH_COMMANDS") &&
    fusionChatPaneSource.includes("const FREE_TEXT_SLASH_COMMANDS") &&
    fusionChatPaneSource.includes(".filter((cmd) => cmd.takesArg)") &&
    fusionChatPaneSource.includes("function hasFreeTextSlashArgument") &&
    fusionChatPaneSource.includes("if (hasFreeTextSlashArgument(input))") &&
    fusionChatPaneSource.includes('className="fusion-slash-menu"') &&
    fusionChatPaneSource.includes('className="fusion-settings-summary"') &&
    fusionChatPaneSource.includes("const startPayload =") &&
    fusionChatPaneSource.includes('model: fusionModel') &&
    fusionChatPaneSource.includes(
      'fusionCodexModel === "auto" ? {} : { codexModel: fusionCodexModel }'
    ) &&
    fusionChatPaneSource.includes(
      'fusionClaudeEffort === "auto" ? {} : { effort: fusionClaudeEffort }'
    ) &&
    fusionChatPaneSource.includes(
      'fusionCodexEffort === "auto" ? {} : { codexEffort: fusionCodexEffort }'
    ) &&
    fusionChatPaneSource.includes("function applySpeedPreset") &&
    fusionChatPaneSource.includes("function applyEffortLevel") &&
    fusionChatPaneSource.includes("function normalizeRoleScope") &&
    fusionChatPaneSource.includes("function normalizeSpeedPreset") &&
    fusionChatPaneSource.includes('{ name: "/plan"') &&
    fusionChatPaneSource.includes('{ name: "/auto"') &&
    fusionChatPaneSource.includes('if (normalized === "/plan")') &&
    fusionChatPaneSource.includes('if (normalized === "/auto")') &&
    fusionChatPaneSource.includes('applySpeedPreset("execution"') &&
    fusionChatPaneSource.includes('applyEffortLevel(normalizeRoleScope(effortMatch[1]), effortMatch[2] as FusionEffort)') &&
    fusionChatPaneSource.includes('"Planning role"') &&
    fusionChatPaneSource.includes('"Execution role"') &&
    fusionChatPaneSource.includes('const FUSION_SPEAKER_LABEL = "Fusion"') &&
    fusionChatPaneSource.includes("function fusionRoleLabel") &&
    fusionChatPaneSource.includes("return FUSION_SPEAKER_LABEL") &&
    !fusionChatPaneSource.includes('"Fusion - Claude Code"') &&
    !fusionChatPaneSource.includes('"Fusion - Codex"') &&
    fusionChatPaneSource.includes("activeRoleLabel") &&
    fusionChatPaneSource.includes("formatBackgroundActivityTitle") &&
    fusionChatPaneSource.includes('className="fusion-background-activity"') &&
    fusionChatPaneSource.includes("backgroundActivity.count > 1") &&
    fusionChatPaneSource.includes('m.kind === "thinking" && !m.text.trim()'),
  "FusionChatPane should drive harness-specific speed/effort submenus, unified role labels, and empty-thinking suppression"
);
assert(
  fusionChatPaneSource.includes("function normalizeFusionModel(value: unknown)") &&
    fusionChatPaneSource.includes('case "stderr"') &&
    fusionChatPaneSource.includes("busy && !inputIsSlashCommand"),
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
    fusionChatPaneSource.includes("session.threadRef?.title ||") &&
    !fusionChatPaneSource.includes("session.resumeRef?.title ||"),
  "Fusion resume should use captured Claude session/title refs without discovery or silent fresh fallback"
);
assert(
    fusionChatPaneSource.includes("window.vibe.fusionChat.interrupt(session.id)") &&
    fusionChatPaneSource.includes("window.vibe.fusionChat.steer(session.id, text)") &&
    !fusionChatPaneSource.includes('className="fusion-stop"') &&
    !fusionChatPaneSource.includes("Stop the current turn") &&
    fusionChatPaneSource.includes("Steer current turn") &&
    fusionChatPaneSource.includes('e.key === "Escape" && busy') &&
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
    fusionChatPaneSource.includes('onStatusChangeRef.current("failed")') &&
    fusionChatPaneSource.includes('failed ? "failed" : "idle"') &&
    fusionChatPaneSource.includes("Answer Fusion to continue"),
  "FusionChatPane should render distinct waiting and failed states for approval/question turns and warmup errors"
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
  stylesSource.includes(".fusion-composer textarea") &&
    stylesSource.includes("height: 20px;"),
  "Fusion composer textarea should have a stable one-line initial height"
);
assert(
  stylesSource.includes(".chat-opus .chat-author,") &&
    stylesSource.includes(".chat-codex .chat-author { color: var(--pane-accent); }") &&
    stylesSource.includes(".chat-opus .chat-tool-author,") &&
    stylesSource.includes(".chat-codex .chat-tool-author { color: var(--pane-accent); }") &&
    !stylesSource.includes(".fusion-chip-codex"),
  "Fusion transcript should render Opus and Codex activity with one visible speaker style"
);

console.log("attention smoke passed");
