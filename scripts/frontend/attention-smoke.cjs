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
  appSource.includes('event.type === "activity" && event.kind === "warmup_error"') &&
    appSource.includes("applyFusionAttention(event.id") &&
    appSource.includes("Fusion execution bridge failed to start."),
  "Fusion warmup errors should mark the session failed and request attention"
);
assert(
  appSource.includes("fusionBridgeToolRef") &&
    appSource.includes('event.type === "tool-call"') &&
    appSource.includes("/codex_implement|codex_respond/") &&
    appSource.includes("if (!isFusionBridgeTool)") &&
    appSource.includes("fusionBridgeToolRef.current.delete(toolKey)"),
  "Fusion waiting cleanup should only react to Codex bridge tool results"
);
assert(
  appSource.includes("function stopSessionProcess(session") &&
    appSource.includes("window.vibe?.fusionChat?.stop(session.id)") &&
    appSource.includes("window.vibe?.terminal.kill(session.id)") &&
    appSource.includes("void stopSessionProcess(session)") &&
    appSource.includes("stopSessionProcess(session).then("),
  "Fusion should stop only through explicit close/restart/resume actions"
);
assert(
  appSource.includes("function clearFusionSession(") &&
    appSource.includes("threadRef: undefined") &&
    appSource.includes("resumeRef: currentClaudeRef ?? previousClaudeRef") &&
    appSource.includes("function updateFusionSettings("),
  "Fusion clear/settings should restart Claude-backed Fusion sessions without fabricating thread ids"
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
assert(
  terminalPaneSource.includes('event.type === "host-error" || event.type === "host-exit"') &&
    terminalPaneSource.includes('event.id && event.id !== session.id') &&
    terminalPaneSource.includes('setStatus("failed")'),
  "terminal pane should render host-level PTY failures instead of ignoring id-less events"
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
    fusionChatPaneSource.includes("const FUSION_SLASH_COMMANDS") &&
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
