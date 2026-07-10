const assert = require("assert");
const fs = require("fs");
const path = require("path");

const appPath = path.join(__dirname, "..", "..", "frontend", "App.tsx");
const stylesPath = path.join(__dirname, "..", "..", "frontend", "styles.css");
const backendPath = path.join(__dirname, "..", "..", "backend", "main.cjs");
const preloadPath = path.join(__dirname, "..", "..", "preload", "preload.cjs");
const electronTypesPath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "electron.d.ts"
);

const appSource = fs.readFileSync(appPath, "utf8");
const stylesSource = fs.readFileSync(stylesPath, "utf8");
const backendSource = fs.readFileSync(backendPath, "utf8");
const preloadSource = fs.readFileSync(preloadPath, "utf8");
const electronTypesSource = fs.readFileSync(electronTypesPath, "utf8");

assert(
  !appSource.includes("window.vibe?.app.getCwd().then") &&
    !appSource.includes("setWorkspaces([workspace])"),
  "empty installs should not create a project from the app cwd"
);

assert(
  appSource.includes("function loadActiveView(workspaces: ProjectWorkspace[]): AppView") &&
    appSource.includes('return "multi";'),
  "empty workspace state should open in multi mode"
);

assert(
  appSource.includes("function restoreStoredSession(value: unknown)") &&
    appSource.includes("function restoreStoredWorkspace(value: unknown)") &&
    appSource.includes("function threadRefForKind(kind: AgentKind, threadRef?: AgentThreadRef)") &&
    appSource.includes("function resumableThreadRefForKind(kind: AgentKind, threadRef?: AgentThreadRef)") &&
    appSource.includes("function activeSessionThreadRef(session: AgentSession)") &&
    appSource.includes(".map(restoreStoredWorkspace)") &&
    appSource.includes(".map(restoreStoredSession)") &&
    appSource.includes("threadRef: isFusion") &&
    // Per-role family settings restore through the shared migration funnel
    // (legacy model/claudeEffort → planner, codexModel/codexEffort → executor;
    // codex "max" stays on the Codex enum — never the Claude enum).
    appSource.includes("function normalizedFusionSessionFields(session: AgentSession)") &&
    appSource.includes("normalizeFusionRoleSettings({") &&
    appSource.includes("...(isFusion ? normalizedFusionSessionFields(session) : {})") &&
    appSource.includes('session.openFusion === true || session.kind === "openfusion"') &&
    appSource.includes('isOpenFusion') &&
    appSource.includes('restoredKind: AgentKind = isFusion') &&
    appSource.includes('openFusionPlannerModel: isOpenFusion') &&
    appSource.includes('openFusionExecutorModel: isOpenFusion'),
  "workspace restore should skip corrupt saved entries and normalize Fusion/Open Fusion settings"
);

assert(
  appSource.includes("function resetSessionThreadForFreshLaunch(") &&
    appSource.includes("threadRef: undefined") &&
    appSource.includes('nextLaunchMode: "new"') &&
    appSource.includes("onFreshLaunchFallback={(patch) =>") &&
    !appSource.includes("onFreshLaunchFallback={() =>"),
  "non-Fusion missing resume fallback should clear stale thread refs; Fusion must not silently relaunch fresh"
);

assert(
  appSource.includes("const sourceThread = activeSessionThreadRef(session) ?? sessionResumeRef(session)") &&
    appSource.includes("function isThreadRefClaimedByOther(") &&
    appSource.includes("That chat is already open in another pane.") &&
    appSource.includes("const nextResumeRef =") &&
    appSource.includes("resumeRef: nextResumeRef"),
  "duplicate panes should only inherit provider-matched resumable thread refs"
);

assert(
  appSource.includes("function removeWorkspace(workspaceId: string)") &&
    appSource.includes("window.vibe?.terminal.kill(session.id)") &&
    appSource.includes("setWorkspaces(nextWorkspaces)") &&
    appSource.includes("setActiveWorkspaceId(nextActiveWorkspace?.id ?? null)"),
  "folder removal should clear state and kill its terminal sessions"
);

assert(
  appSource.includes('className="workspace-remove-button"') &&
    appSource.includes("aria-label={`Close ${workspace.name}`}") &&
    appSource.includes("onClick={() => requestWorkspaceClose(workspace.id)}"),
  "folder rows should expose an accessible close button that requests confirmation"
);

assert(
  appSource.includes("function moveWorkspace(") &&
    appSource.includes("function handleWorkspaceDragStart(") &&
    appSource.includes("function handleWorkspaceDrop(") &&
    appSource.includes("draggable={workspaces.length > 1}") &&
    appSource.includes("setWorkspaces((current) =>") &&
    appSource.includes("moveWorkspace(current, draggedWorkspaceId, targetWorkspaceId, position)") &&
    stylesSource.includes(".workspace-row.drop-before::before") &&
    stylesSource.includes(".workspace-row.drop-after::after") &&
    stylesSource.includes('.workspace-button[draggable="true"]'),
  "folder rows should support drag reordering with visible drop targets"
);

assert(
  appSource.includes("function requestWorkspaceClose(workspaceId: string)") &&
    appSource.includes("setWorkspaceClosePendingId(workspaceId)") &&
    appSource.includes('role="dialog"') &&
    appSource.includes('aria-modal="true"') &&
    appSource.includes("confirmWorkspaceClose(workspaceClosePending.id)"),
  "folder removal should show a confirmation dialog before closing"
);

assert(
  backendSource.includes('ipcMain.handle("workspace:open-in-explorer"') &&
    backendSource.includes('ipcMain.handle("workspace:open-terminal"') &&
    preloadSource.includes("openInExplorer: (path) =>") &&
    preloadSource.includes('ipcRenderer.invoke("workspace:open-in-explorer", { path })') &&
    preloadSource.includes("openTerminal: (path) =>") &&
    preloadSource.includes('ipcRenderer.invoke("workspace:open-terminal", { path })') &&
    electronTypesSource.includes("openInExplorer: (path: string)") &&
    electronTypesSource.includes("openTerminal: (path: string)"),
  "workspace actions should be exposed through main IPC, preload, and renderer types"
);

assert(
  appSource.includes("interface WorkspaceContextMenuState") &&
    appSource.includes("function openWorkspaceContextMenu(") &&
    appSource.includes("function runWorkspaceContextAction(") &&
    appSource.includes("workspaceApi.openInExplorer(workspace.path)") &&
    appSource.includes("workspaceApi.openTerminal(workspace.path)") &&
    appSource.includes("Open in file explorer") &&
    appSource.includes("Open terminal") &&
    appSource.includes("workspace-context-menu") &&
    appSource.includes("onContextMenu={(event) =>") &&
    stylesSource.includes(".workspace-context-menu") &&
    stylesSource.includes(".workspace-row.context-open .workspace-button"),
  "folder rows should expose a styled React context menu wired to workspace actions"
);

assert(
  stylesSource.includes(".workspace-row") &&
    stylesSource.includes(".workspace-remove-button") &&
    stylesSource.includes(".confirmation-backdrop") &&
    stylesSource.includes(".confirmation-dialog") &&
    stylesSource.includes(".confirmation-actions button.danger"),
  "folder remove controls and confirmation dialog should be styled"
);

assert(
  stylesSource.includes("linear-gradient(180deg, #131418 0%, #0d0e11 100%)") &&
    stylesSource.includes("inset 3px 0 0 #f4cf5a") &&
    stylesSource.includes(".workspace-context-menu button:hover"),
  "sidebar should use the refreshed visual language for rows, active states, and menus"
);

console.log("workspace smoke passed");
