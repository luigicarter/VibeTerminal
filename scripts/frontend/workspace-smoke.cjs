const assert = require("assert");
const fs = require("fs");
const path = require("path");

const appPath = path.join(__dirname, "..", "..", "frontend", "App.tsx");
const stylesPath = path.join(__dirname, "..", "..", "frontend", "styles.css");

const appSource = fs.readFileSync(appPath, "utf8");
const stylesSource = fs.readFileSync(stylesPath, "utf8");

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
    appSource.includes("normalizeFusionModel(session.fusionModel)") &&
    appSource.includes("normalizeFusionCodexModel(session.fusionCodexModel)") &&
    appSource.includes("normalizeFusionEffort(session.fusionClaudeEffort ?? session.fusionEffort)") &&
    appSource.includes("normalizeFusionEffort(session.fusionCodexEffort ?? session.fusionEffort)") &&
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
  stylesSource.includes(".workspace-row") &&
    stylesSource.includes(".workspace-remove-button") &&
    stylesSource.includes(".confirmation-backdrop") &&
    stylesSource.includes(".confirmation-dialog") &&
    stylesSource.includes(".confirmation-actions button.danger"),
  "folder remove controls and confirmation dialog should be styled"
);

console.log("workspace smoke passed");
