import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  ChevronRight,
  Download,
  Folder,
  FolderOpen,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Play,
  RefreshCw,
  X
} from "lucide-react";
import clsx from "clsx";
import vibeTerminalLogo from "./assets/vibeterminal-logo.png";
import openFusionLogo from "./assets/openfusion-logo.png";
import {
  DEFAULT_OPEN_FUSION_EXECUTOR_MODEL,
  DEFAULT_OPEN_FUSION_PLANNER_MODEL,
  normalizeOpenFusionModel
} from "./openFusion";
import {
  EMPTY_ATTENTION,
  attentionFromEvent,
  attentionFromTerminalEvent,
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
} from "./attention";
import TerminalPane from "./components/TerminalPane";
import FusionChatPane from "./components/FusionChatPane";
import TiledBoard from "./components/TiledBoard";
import {
  createThreadRef,
  isThreadedAgentKind
} from "./sessionLaunch";
import type {
  AgentAttentionEvent,
  AgentBackgroundActivity,
  AgentKind,
  AgentProfile,
  AgentSession,
  AgentThreadRef,
  AgentThreadLookupStatus,
  CodeChangeSummary,
  FusionClaudeModel,
  FusionCodexModel,
  FusionEffort,
  FusionRunMode,
  FusionChatEvent,
  FusionSettings,
  LayoutBox,
  ProjectWorkspace,
  UpdateState
} from "./types";

const STORAGE_KEY = "vibe-terminal:workspaces:v2";
const ACTIVE_WORKSPACE_STORAGE_KEY = "vibe-terminal:active-workspace:v1";
const MULTI_SESSIONS_STORAGE_KEY = "vibe-terminal:multi-sessions:v1";
const ACTIVE_VIEW_STORAGE_KEY = "vibe-terminal:active-view:v1";
const SIDEBAR_WIDTH_STORAGE_KEY = "vibe-terminal:sidebar-width:v1";
const LEGACY_GRID_COLS = 12;
const LEGACY_ROW_HEIGHT = 82;
const PREVIOUS_DEFAULT_BOARD_GAP = 10;
const LEGACY_BOARD_GAP = 6;
const LEGACY_BOARD_PADDING = 10;
const DEFAULT_COLUMN_GAP_PERCENT = 0.65;
const DEFAULT_PANE_WIDTH_PERCENT = (100 - DEFAULT_COLUMN_GAP_PERCENT) / 2;
const SECOND_COLUMN_X_PERCENT = 50 + DEFAULT_COLUMN_GAP_PERCENT / 2;
const DEFAULT_PANE_HEIGHT = 260;
const DEFAULT_MIN_PANE_WIDTH = 280;
const DEFAULT_MIN_PANE_HEIGHT = 170;
const MAXIMIZED_PANE_HEIGHT = 720;
const DEFAULT_SIDEBAR_WIDTH = 292;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 520;
const MIN_WORKSPACE_WIDTH = 360;
const CODE_CHANGE_REFRESH_MS = 7_500;
const FUSION_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;
const DEFAULT_FUSION_CLAUDE_MODEL: FusionClaudeModel = "opus";
const DEFAULT_FUSION_CODEX_MODEL: FusionCodexModel = "auto";
const DEFAULT_FUSION_RUN_MODE: FusionRunMode = "auto";
const FUSION_EFFORT_VALUES: FusionEffort[] = [
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];

type AppView = "multi" | "project";

type SessionScope =
  | { type: "multi" }
  | { type: "workspace"; workspaceId: string };

type WorkspaceDropPosition = "before" | "after";

interface WorkspaceDropTarget {
  workspaceId: string;
  position: WorkspaceDropPosition;
}

interface ThreadLookupPatch {
  threadLookupStartedAt?: number;
  threadLookupStatus: AgentThreadLookupStatus;
  threadLookupMessage?: string;
}

const agentProfiles: AgentProfile[] = [
  {
    kind: "terminal",
    label: "Terminal",
    command: "",
    accent: "#f4cf5a"
  },
  {
    kind: "codex",
    label: "Codex",
    command: "codex",
    accent: "#ff9f43"
  },
  {
    kind: "claude",
    label: "Claude",
    command: "claude",
    accent: "#8fd694"
  },
  {
    kind: "fusion",
    label: "Fusion",
    command: "claude",
    accent: "#b98bff",
    fusion: true
  },
  {
    kind: "openfusion",
    label: "Open Fusion",
    command: "opencode",
    accent: "#2ee8be",
    openFusion: true
  },
  {
    kind: "cursor",
    label: "Cursor",
    command: "cursor-agent",
    accent: "#46c2c9"
  },
  {
    kind: "gemini",
    label: "Gemini",
    command: "gemini",
    accent: "#70a8ff"
  },
  {
    kind: "opencode",
    label: "OpenCode",
    command: "opencode",
    accent: "#c78bff"
  },
  {
    kind: "aider",
    label: "Aider",
    command: "aider",
    accent: "#ff6b8a"
  }
];

const launcherAgentProfiles = agentProfiles.filter(
  (profile) => profile.kind !== "gemini" && profile.kind !== "aider"
);

function createId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function folderName(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.split("/").pop() || path;
}

function normalizeWorkspacePath(path: string) {
  return path.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

function formatCount(count: number, label: string) {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function formatUpdatePercent(state: UpdateState) {
  const percent = state.progress?.percent;
  return Number.isFinite(percent) ? Math.round(percent ?? 0) : 0;
}

function formatCodeLineSummary(summary?: CodeChangeSummary) {
  if (!summary) {
    return "Scanning Git diff totals.";
  }

  if (summary.state === "not-git") {
    return "This folder is not a Git repository.";
  }

  if (summary.state === "unavailable") {
    return summary.message || "Git changes could not be inspected.";
  }

  if (summary.state === "clean") {
    return "Nothing new since the last commit.";
  }

  return `${summary.insertions} lines written, ${summary.deletions} lines deleted.`;
}

function getProfile(kind: AgentKind) {
  return agentProfiles.find((profile) => profile.kind === kind) ?? agentProfiles[0];
}

function hasClaudeThreadId(threadRef?: AgentThreadRef): threadRef is AgentThreadRef {
  return threadRef?.provider === "claude" && Boolean(threadRef.id);
}

function threadRefForKind(kind: AgentKind, threadRef?: AgentThreadRef) {
  return threadRef && isThreadedAgentKind(kind) && threadRef.provider === kind
    ? threadRef
    : undefined;
}

function resumableThreadRefForKind(kind: AgentKind, threadRef?: AgentThreadRef) {
  const matchingRef = threadRefForKind(kind, threadRef);
  return matchingRef?.id ? matchingRef : undefined;
}

function canResumeSessionThread(session: AgentSession) {
  return session.fusion
    ? hasClaudeThreadId(session.threadRef)
    : Boolean(resumableThreadRefForKind(session.kind, session.threadRef));
}

function sessionResumeRef(session: AgentSession) {
  return session.fusion
    ? hasClaudeThreadId(session.resumeRef)
      ? session.resumeRef
      : undefined
    : resumableThreadRefForKind(session.kind, session.resumeRef);
}

function activeSessionThreadRef(session: AgentSession) {
  return session.fusion
    ? hasClaudeThreadId(session.threadRef)
      ? session.threadRef
      : undefined
    : resumableThreadRefForKind(session.kind, session.threadRef);
}

function rectanglesOverlap(a: LayoutBox, b: LayoutBox) {
  const horizontalGap = DEFAULT_COLUMN_GAP_PERCENT;
  const verticalGap = LEGACY_BOARD_GAP;

  return (
    a.x < b.x + b.w + horizontalGap &&
    a.x + a.w + horizontalGap > b.x &&
    a.y < b.y + b.h + verticalGap &&
    a.y + a.h + verticalGap > b.y
  );
}

function layoutsMatch(a: LayoutBox, b: LayoutBox) {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    a.unit === b.unit
  );
}

function isClose(value: number, target: number, tolerance = 0.001) {
  return Math.abs(value - target) <= tolerance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeFusionModelId(value: unknown, fallback: string) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (
    !trimmed ||
    trimmed.length > 96 ||
    !FUSION_MODEL_ID_PATTERN.test(trimmed)
  ) {
    return fallback;
  }

  return trimmed;
}

function normalizeFusionModel(value: unknown): FusionClaudeModel {
  const model = normalizeFusionModelId(value, DEFAULT_FUSION_CLAUDE_MODEL);
  const lower = model.toLowerCase();
  if (lower === "fast") {
    return "sonnet";
  }

  if (lower === "opus" || lower === "sonnet") {
    return lower;
  }

  return model;
}

function normalizeFusionCodexModel(value: unknown): FusionCodexModel {
  const model = normalizeFusionModelId(value, DEFAULT_FUSION_CODEX_MODEL);
  const lower = model.toLowerCase();
  if (lower === "default" || lower === "auto") {
    return DEFAULT_FUSION_CODEX_MODEL;
  }

  return model;
}

function normalizeFusionEffort(value: unknown): FusionEffort {
  return FUSION_EFFORT_VALUES.includes(value as FusionEffort)
    ? (value as FusionEffort)
    : "auto";
}

function normalizeFusionRunMode(value: unknown): FusionRunMode {
  return String(value || "").trim().toLowerCase() === "plan" ? "plan" : DEFAULT_FUSION_RUN_MODE;
}

function normalizeBackgroundActivity(
  activity?: AgentBackgroundActivity
): AgentBackgroundActivity | undefined {
  const active = activity?.active === true;
  const count = Math.max(
    0,
    Math.floor(finiteNumber(activity?.count, active ? 1 : 0))
  );
  if (!active || count <= 0) {
    return undefined;
  }

  return {
    ...activity,
    active: true,
    count,
    updatedAt: finiteNumber(activity?.updatedAt, Date.now()),
    items: Array.isArray(activity.items) ? activity.items : []
  };
}

function normalizeSessionStatus(value: unknown) {
  return ["idle", "starting", "running", "waiting", "done", "failed"].includes(
    value as string
  )
    ? (value as AgentSession["status"])
    : "idle";
}

function normalizeLaunchMode(value: unknown) {
  return value === "resume" ? "resume" : "new";
}

function isAgentKind(value: unknown): value is AgentKind {
  return agentProfiles.some((profile) => profile.kind === value);
}

function tightenDefaultFluidGutters(layout: LayoutBox): LayoutBox {
  const next = { ...layout };

  if (isClose(layout.w, 49)) {
    next.w = DEFAULT_PANE_WIDTH_PERCENT;
  }

  if (isClose(layout.x, 51)) {
    next.x = SECOND_COLUMN_X_PERCENT;
  }

  if (isClose(layout.h, DEFAULT_PANE_HEIGHT)) {
    const oldRowStep = DEFAULT_PANE_HEIGHT + PREVIOUS_DEFAULT_BOARD_GAP;
    const row = (layout.y - LEGACY_BOARD_PADDING) / oldRowStep;
    const roundedRow = Math.round(row);

    if (Number.isFinite(row) && isClose(row, roundedRow)) {
      next.y =
        LEGACY_BOARD_PADDING +
        roundedRow * (DEFAULT_PANE_HEIGHT + LEGACY_BOARD_GAP);
    }
  }

  return next;
}

function defaultFluidLayout(): LayoutBox {
  return {
    x: 0,
    y: LEGACY_BOARD_PADDING,
    w: DEFAULT_PANE_WIDTH_PERCENT,
    h: DEFAULT_PANE_HEIGHT,
    unit: "fluid"
  };
}

function migrateLayout(layout: LayoutBox | null | undefined): LayoutBox {
  if (!isRecord(layout)) {
    return defaultFluidLayout();
  }

  const normalizedLayout: LayoutBox = {
    x: finiteNumber(layout.x, 0),
    y: finiteNumber(layout.y, LEGACY_BOARD_PADDING),
    w: finiteNumber(layout.w, DEFAULT_PANE_WIDTH_PERCENT),
    h: finiteNumber(layout.h, DEFAULT_PANE_HEIGHT),
    unit: layout.unit === "fluid" ? "fluid" : undefined
  };

  if (normalizedLayout.unit === "fluid") {
    const tightenedLayout = tightenDefaultFluidGutters(normalizedLayout);

    return {
      x: Math.max(0, Math.min(tightenedLayout.x, 100)),
      y: Math.max(LEGACY_BOARD_PADDING, tightenedLayout.y),
      w: Math.max(1, Math.min(tightenedLayout.w, 100)),
      h: Math.max(DEFAULT_MIN_PANE_HEIGHT, tightenedLayout.h),
      unit: "fluid"
    };
  }

  return {
    x: (normalizedLayout.x / LEGACY_GRID_COLS) * 100,
    y:
      LEGACY_BOARD_PADDING +
      normalizedLayout.y * (LEGACY_ROW_HEIGHT + LEGACY_BOARD_GAP),
    w: (normalizedLayout.w / LEGACY_GRID_COLS) * 100,
    h:
      normalizedLayout.h * LEGACY_ROW_HEIGHT +
      Math.max(0, normalizedLayout.h - 1) * LEGACY_BOARD_GAP,
    unit: "fluid"
  };
}

function findNextFluidLayout(sessions: AgentSession[]): LayoutBox {
  const existingLayouts = sessions.map((session) => migrateLayout(session.layout));
  const rowStep = DEFAULT_PANE_HEIGHT + LEGACY_BOARD_GAP;
  const columns = [
    { x: 0, w: DEFAULT_PANE_WIDTH_PERCENT },
    { x: SECOND_COLUMN_X_PERCENT, w: DEFAULT_PANE_WIDTH_PERCENT }
  ];
  const maxBottom = existingLayouts.reduce(
    (bottom, layout) => Math.max(bottom, layout.y + layout.h),
    LEGACY_BOARD_PADDING
  );

  for (let y = LEGACY_BOARD_PADDING; y <= maxBottom + rowStep; y += rowStep) {
    for (const column of columns) {
      const candidate: LayoutBox = {
        ...column,
        y,
        h: DEFAULT_PANE_HEIGHT,
        unit: "fluid"
      };

      if (!existingLayouts.some((layout) => rectanglesOverlap(candidate, layout))) {
        return candidate;
      }
    }
  }

  return {
    x: 0,
    y: maxBottom + LEGACY_BOARD_GAP,
    w: DEFAULT_PANE_WIDTH_PERCENT,
    h: DEFAULT_PANE_HEIGHT,
    unit: "fluid"
  };
}

function createSession(
  kind: AgentKind,
  cwd: string,
  existingSessions: AgentSession[],
  name?: string
): AgentSession {
  const profile = getProfile(kind);
  // "fusion" is a selection-only kind: persist a real claude session flagged
  // `fusion` so every existing claude path (telemetry, resume, working-state,
  // thread discovery) applies unchanged; only the launch gets Fusion wiring.
  const isFusion = profile.fusion === true;
  // "openfusion" follows the same pattern but persists as OpenCode.
  const isOpenFusion = profile.openFusion === true;
  const effectiveKind: AgentKind = isFusion
    ? "claude"
    : isOpenFusion
      ? "opencode"
      : kind;
  const sessionName = name ?? `${profile.label} ${existingSessions.length + 1}`;

  return {
    id: createId("session"),
    name: sessionName,
    kind: effectiveKind,
    fusion: isFusion || undefined,
    fusionModel: isFusion ? DEFAULT_FUSION_CLAUDE_MODEL : undefined,
    fusionCodexModel: isFusion ? DEFAULT_FUSION_CODEX_MODEL : undefined,
    fusionClaudeEffort: isFusion ? "auto" : undefined,
    fusionCodexEffort: isFusion ? "auto" : undefined,
    fusionRunMode: isFusion ? DEFAULT_FUSION_RUN_MODE : undefined,
    fusionEffort: undefined,
    openFusion: isOpenFusion || undefined,
    openFusionPlannerModel: isOpenFusion
      ? DEFAULT_OPEN_FUSION_PLANNER_MODEL
      : undefined,
    openFusionExecutorModel: isOpenFusion
      ? DEFAULT_OPEN_FUSION_EXECUTOR_MODEL
      : undefined,
    command: profile.command,
    cwd,
    createdAt: Date.now(),
    threadRef: isFusion ? undefined : createThreadRef(effectiveKind, sessionName),
    threadLookupStatus: "idle",
    nextLaunchMode: "new",
    started: true,
    launchToken: 1,
    status: "idle",
    attention: EMPTY_ATTENTION,
    layout: findNextFluidLayout(existingSessions)
  };
}

function starterWorkspace(path: string): ProjectWorkspace {
  return {
    id: createId("workspace"),
    name: folderName(path),
    path,
    sessions: []
  };
}

function isStoredSession(value: unknown): value is AgentSession {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isAgentKind(value.kind) &&
    typeof value.cwd === "string"
  );
}

function restoreSession(session: AgentSession): AgentSession {
  const launchToken = finiteNumber(session.launchToken, 0);
  const previousStatus = normalizeSessionStatus(session.status);
  const isFusion = session.fusion === true || session.kind === "fusion";
  const isOpenFusion = session.openFusion === true || session.kind === "openfusion";
  const restoredKind: AgentKind = isFusion
    ? "claude"
    : isOpenFusion
      ? "opencode"
      : session.kind;
  const profile = getProfile(
    isFusion ? "fusion" : isOpenFusion ? "openfusion" : restoredKind
  );
  const createdAt = finiteNumber(session.createdAt, Date.now());
  // A completed Fusion turn still leaves a reusable chat host while the app is
  // open, so restore the host intent whenever the pane itself was started.
  const shouldAutoStart =
    session.started === true &&
    (isFusion || (previousStatus !== "done" && previousStatus !== "failed"));

  // Reopening the app restores each pane as a FRESH terminal, never an
  // auto-resumed chat. The previously running thread is preserved as `resumeRef`
  // so the user can deliberately resume it from the pane (the Resume button),
  // while the pane itself launches a brand-new session. This deliberately
  // decouples "restore my workspace/layout" from "resume my conversation",
  // which used to be welded together. Applies to all threaded agents:
  // - claude needs a freshly minted id here — relaunching `--session-id <old>`
  //   would collide with the existing transcript — so createThreadRef hands out
  //   a new uuid for the fresh chat.
  // - codex/opencode get no id (createThreadRef returns it undefined) and so
  //   launch their plain command, letting discovery bind the new session.
  // The most recent resumable thread wins; if the pane had no thread yet we keep
  // whatever resumeRef was already stored.
  const activeThreadRef = isFusion
    ? hasClaudeThreadId(session.threadRef)
      ? session.threadRef
      : undefined
    : threadRefForKind(restoredKind, session.threadRef);
  const storedResumeRef = isFusion
    ? hasClaudeThreadId(session.resumeRef)
      ? session.resumeRef
      : undefined
    : resumableThreadRefForKind(restoredKind, session.resumeRef);
  const resumeRef = activeThreadRef?.id
    ? activeThreadRef
    : storedResumeRef;

  return {
    ...session,
    name: session.name || profile.label,
    kind: restoredKind,
    command: typeof session.command === "string" ? session.command : profile.command,
    fusion: isFusion || undefined,
    openFusion: isOpenFusion || undefined,
    createdAt,
    started: shouldAutoStart,
    launchToken,
    nextLaunchMode: normalizeLaunchMode("new"),
    threadRef: isFusion
      ? undefined
      : createThreadRef(restoredKind, session.threadRef?.title ?? session.name),
    resumeRef,
    fusionModel: isFusion
      ? normalizeFusionModel(session.fusionModel)
      : session.fusionModel,
    fusionCodexModel: isFusion
      ? normalizeFusionCodexModel(session.fusionCodexModel)
      : session.fusionCodexModel,
    fusionClaudeEffort: isFusion
      ? normalizeFusionEffort(session.fusionClaudeEffort ?? session.fusionEffort)
      : session.fusionClaudeEffort,
    fusionCodexEffort: isFusion
      ? normalizeFusionEffort(session.fusionCodexEffort ?? session.fusionEffort)
      : session.fusionCodexEffort,
    fusionRunMode: isFusion
      ? normalizeFusionRunMode(session.fusionRunMode)
      : session.fusionRunMode,
    fusionEffort: isFusion
      ? undefined
      : session.fusionEffort,
    openFusionPlannerModel: isOpenFusion
      ? normalizeOpenFusionModel(
          session.openFusionPlannerModel,
          DEFAULT_OPEN_FUSION_PLANNER_MODEL
        )
      : session.openFusionPlannerModel,
    openFusionExecutorModel: isOpenFusion
      ? normalizeOpenFusionModel(
          session.openFusionExecutorModel,
          DEFAULT_OPEN_FUSION_EXECUTOR_MODEL
        )
      : session.openFusionExecutorModel,
    threadLookupStartedAt: undefined,
    threadLookupStatus: "idle",
    threadLookupMessage: undefined,
    status: shouldAutoStart ? "idle" : previousStatus,
    attention: normalizeAttention(session.attention),
    backgroundActivity: undefined,
    layout: migrateLayout(session.layout)
  };
}

function restoreStoredSession(value: unknown): AgentSession | null {
  if (!isStoredSession(value)) {
    return null;
  }

  try {
    return restoreSession(value);
  } catch {
    return null;
  }
}

function restoreStoredWorkspace(value: unknown): ProjectWorkspace | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.path !== "string"
  ) {
    return null;
  }

  const sessions = Array.isArray(value.sessions)
    ? value.sessions
        .map(restoreStoredSession)
        .filter((session): session is AgentSession => Boolean(session))
    : [];

  return {
    id: value.id,
    name: value.name,
    path: value.path,
    sessions
  };
}

function loadWorkspaces(): ProjectWorkspace[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as ProjectWorkspace[];
    return Array.isArray(parsed)
      ? parsed
          .map(restoreStoredWorkspace)
          .filter((workspace): workspace is ProjectWorkspace => Boolean(workspace))
      : [];
  } catch {
    return [];
  }
}

function loadMultiSessions(): AgentSession[] {
  try {
    const raw = localStorage.getItem(MULTI_SESSIONS_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as AgentSession[];
    return Array.isArray(parsed)
      ? parsed
          .map(restoreStoredSession)
          .filter((session): session is AgentSession => Boolean(session))
      : [];
  } catch {
    return [];
  }
}

function loadActiveWorkspaceId(workspaces: ProjectWorkspace[]) {
  const savedWorkspaceId = localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  if (
    savedWorkspaceId &&
    workspaces.some((workspace) => workspace.id === savedWorkspaceId)
  ) {
    return savedWorkspaceId;
  }

  return workspaces[0]?.id ?? null;
}

function loadActiveView(workspaces: ProjectWorkspace[]): AppView {
  if (workspaces.length === 0) {
    return "multi";
  }

  return localStorage.getItem(ACTIVE_VIEW_STORAGE_KEY) === "multi"
    ? "multi"
    : "project";
}

function maxSidebarWidth() {
  return Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - MIN_WORKSPACE_WIDTH)
  );
}

function clampSidebarWidth(width: number) {
  return clamp(width, MIN_SIDEBAR_WIDTH, maxSidebarWidth());
}

function loadSidebarWidth() {
  const savedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));

  if (Number.isFinite(savedWidth)) {
    return clampSidebarWidth(savedWidth);
  }

  return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
}

function getWorkspaceDropPosition(
  element: HTMLElement,
  clientY: number
): WorkspaceDropPosition {
  const rect = element.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function moveWorkspace(
  workspaces: ProjectWorkspace[],
  draggedWorkspaceId: string,
  targetWorkspaceId: string,
  position: WorkspaceDropPosition
) {
  if (draggedWorkspaceId === targetWorkspaceId) {
    return workspaces;
  }

  const draggedIndex = workspaces.findIndex(
    (workspace) => workspace.id === draggedWorkspaceId
  );
  const targetIndex = workspaces.findIndex(
    (workspace) => workspace.id === targetWorkspaceId
  );

  if (draggedIndex === -1 || targetIndex === -1) {
    return workspaces;
  }

  const nextWorkspaces = [...workspaces];
  const [draggedWorkspace] = nextWorkspaces.splice(draggedIndex, 1);
  const adjustedTargetIndex = nextWorkspaces.findIndex(
    (workspace) => workspace.id === targetWorkspaceId
  );

  if (!draggedWorkspace || adjustedTargetIndex === -1) {
    return workspaces;
  }

  const insertIndex =
    position === "after" ? adjustedTargetIndex + 1 : adjustedTargetIndex;
  nextWorkspaces.splice(insertIndex, 0, draggedWorkspace);

  const orderChanged = nextWorkspaces.some(
    (workspace, index) => workspace.id !== workspaces[index]?.id
  );

  return orderChanged ? nextWorkspaces : workspaces;
}

export default function App() {
  const [initialState] = useState(() => {
    const screenshotFixture = window.vibe?.app.screenshotFixture;
    if (screenshotFixture?.mode === "openfusion") {
      const workspace = starterWorkspace(screenshotFixture.cwd);
      const session = createSession(
        "openfusion",
        screenshotFixture.cwd,
        [],
        "Open Fusion CLI"
      );
      const screenshotSession: AgentSession = {
        ...session,
        command: screenshotFixture.openCodeCommand?.trim() || session.command,
        layout: {
          x: LEGACY_BOARD_PADDING,
          y: LEGACY_BOARD_PADDING,
          w: 100 - LEGACY_BOARD_PADDING * 2,
          h: 640,
          unit: "fluid"
        }
      };

      return {
        workspaces: [
          {
            ...workspace,
            sessions: [screenshotSession]
          }
        ],
        activeWorkspaceId: workspace.id,
        multiSessions: [],
        activeView: "project" as AppView,
        sidebarWidth: loadSidebarWidth()
      };
    }

    const initialWorkspaces = loadWorkspaces();
    return {
      workspaces: initialWorkspaces,
      activeWorkspaceId: loadActiveWorkspaceId(initialWorkspaces),
      multiSessions: loadMultiSessions(),
      activeView: loadActiveView(initialWorkspaces),
      sidebarWidth: loadSidebarWidth()
    };
  });
  const [workspaces, setWorkspaces] = useState<ProjectWorkspace[]>(
    initialState.workspaces
  );
  const [multiSessions, setMultiSessions] = useState<AgentSession[]>(
    initialState.multiSessions
  );
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    initialState.activeWorkspaceId
  );
  const [activeView, setActiveView] = useState<AppView>(initialState.activeView);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(initialState.sidebarWidth);
  const [maximizedSessionId, setMaximizedSessionId] = useState<string | null>(
    null
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const screenshotFixtureSeededRef = useRef(false);
  const attentionSelectionRef = useRef<{
    selectedSessionId: string | null;
    visibleSessionIds: string[];
  }>({
    selectedSessionId: null,
    visibleSessionIds: []
  });
  const fusionBridgeToolRef = useRef<Map<string, boolean>>(new Map());
  const [shellMessage, setShellMessage] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [workspaceChangeSummaries, setWorkspaceChangeSummaries] = useState<
    Record<string, CodeChangeSummary>
  >({});
  const [dismissedUpdateKey, setDismissedUpdateKey] = useState<string | null>(
    null
  );
  const [isArranging, setIsArranging] = useState(false);
  const [workspaceClosePendingId, setWorkspaceClosePendingId] = useState<
    string | null
  >(null);
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(
    null
  );
  const [workspaceDropTarget, setWorkspaceDropTarget] =
    useState<WorkspaceDropTarget | null>(null);

  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ??
    workspaces[0] ??
    null;
  const activeScope: SessionScope | null =
    activeView === "multi"
      ? { type: "multi" }
      : activeWorkspace
        ? { type: "workspace", workspaceId: activeWorkspace.id }
        : null;
  const boardSessions =
    activeScope?.type === "multi"
      ? multiSessions
      : activeWorkspace?.sessions ?? [];
  const visibleSessionIds = boardSessions.map((session) => session.id);
  const boardTitle = activeView === "multi" ? "Multi mode" : activeWorkspace?.name ?? "No folder";
  const boardSubtitle =
    activeView === "multi"
      ? "Free terminal board"
      : activeWorkspace?.path ?? "Open a folder to start";
  const workspaceChangeFingerprint = workspaces
    .map((workspace) => `${workspace.id}:${workspace.path}`)
    .join("|");
  const activeWorkspaceChangeSummary = activeWorkspace
    ? workspaceChangeSummaries[activeWorkspace.id]
    : undefined;
  const allSessions = [
    ...multiSessions,
    ...workspaces.flatMap((workspace) => workspace.sessions)
  ];
  const workspaceClosePending =
    workspaces.find((workspace) => workspace.id === workspaceClosePendingId) ??
    null;
  const workspaceClosePendingSessionCount =
    workspaceClosePending?.sessions.length ?? 0;

  useEffect(() => {
    if (screenshotFixtureSeededRef.current) {
      return;
    }

    screenshotFixtureSeededRef.current = true;
    let cancelled = false;

    window.vibe?.app.getScreenshotFixture?.().then((fixture) => {
      if (
        cancelled ||
        fixture?.mode !== "openfusion" ||
        boardSessions.length > 0 ||
        multiSessions.length > 0
      ) {
        return;
      }

      const workspace =
        activeWorkspace?.sessions.length === 0
          ? { ...activeWorkspace, path: fixture.cwd, name: folderName(fixture.cwd) }
          : starterWorkspace(fixture.cwd);
      const session = createSession(
        "openfusion",
        fixture.cwd,
        [],
        "Open Fusion CLI"
      );
      const screenshotSession: AgentSession = {
        ...session,
        layout: {
          x: LEGACY_BOARD_PADDING,
          y: LEGACY_BOARD_PADDING,
          w: 100 - LEGACY_BOARD_PADDING * 2,
          h: 640,
          unit: "fluid"
        }
      };

      setWorkspaces(() => [
        {
          ...workspace,
          sessions: [screenshotSession]
        }
      ]);
      setActiveWorkspaceId(workspace.id);
      setActiveView("project");
      setSelectedSessionId(screenshotSession.id);
    });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspace, boardSessions.length, multiSessions.length]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces));
  }, [workspaces]);

  useEffect(() => {
    localStorage.setItem(MULTI_SESSIONS_STORAGE_KEY, JSON.stringify(multiSessions));
  }, [multiSessions]);

  useEffect(() => {
    if (activeWorkspaceId) {
      localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, activeWorkspaceId);
      return;
    }

    localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  }, [activeWorkspaceId]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, activeView);
  }, [activeView]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    const handleWindowResize = () => {
      setSidebarWidth((current) => clampSidebarWidth(current));
    };

    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
    };
  }, []);

  useEffect(() => {
    if (
      maximizedSessionId &&
      !boardSessions.some((session) => session.id === maximizedSessionId)
    ) {
      setMaximizedSessionId(null);
    }
  }, [boardSessions, maximizedSessionId]);

  useEffect(() => {
    if (!workspaceClosePending) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorkspaceClosePendingId(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [workspaceClosePending]);

  useEffect(() => {
    attentionSelectionRef.current = {
      selectedSessionId,
      visibleSessionIds
    };
  }, [selectedSessionId, visibleSessionIds]);

  useEffect(() => {
    return window.vibe?.terminal.onEvent((event) => {
      if (event.type === "host-error" || event.type === "host-exit") {
        setShellMessage(event.message);
      }

      if (event.type === "agent-attention") {
        applyAgentAttention(event.id, event.attention);
      }

      if (event.type === "agent-running") {
        applyAgentRunning(event.id);
      }

      if (event.type === "agent-background-activity") {
        applyAgentBackgroundActivity(event.id, event.backgroundActivity);
        return;
      }

      if ("id" in event && typeof event.id === "string") {
        // Output ("data") no longer drives the working/idle pill from here: a
        // pane's working state comes from turn telemetry (claude/opencode) or
        // the mounted pane's input-aware heuristic (codex/plain terminals), so a
        // user's own keystroke echo can never read as "working". snapshot/exit/
        // error still settle status centrally for every pane.
        if (event.type !== "data") {
          applyTerminalStatus(event.id, statusFromTerminalEvent(event));
        }

        const attention = attentionFromTerminalEvent(event);
        if (attention) {
          applyTerminalAttention(event.id, attention);
        }
      }
    });
  }, []);

  useEffect(() => {
    return window.vibe?.fusionChat?.onEvent((event: FusionChatEvent) => {
      if (event.type === "host-error") {
        setShellMessage(event.message);
        return;
      }

      applyFusionChatLifecycle(event);
    });
  }, []);

  useEffect(() => {
    let disposed = false;

    window.vibe?.updates.getState().then((state) => {
      if (!disposed) {
        setUpdateState(state);
      }
    });

    const unsubscribe = window.vibe?.updates.onEvent((state) => {
      setUpdateState(state);
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (workspaces.length === 0 || !window.vibe?.workspace.getCodeChanges) {
      setWorkspaceChangeSummaries({});
      return;
    }

    let disposed = false;
    let refreshInFlight = false;

    const refreshCodeChanges = async () => {
      if (refreshInFlight) {
        return;
      }

      refreshInFlight = true;

      try {
        const summaries = await Promise.all(
          workspaces.map(async (workspace) => {
            const summary = await window.vibe?.workspace.getCodeChanges(
              workspace.path
            );
            return summary ? ([workspace.id, summary] as const) : null;
          })
        );

        if (disposed) {
          return;
        }

        const nextSummaries: Record<string, CodeChangeSummary> = {};
        summaries.forEach((entry) => {
          if (entry) {
            nextSummaries[entry[0]] = entry[1];
          }
        });
        setWorkspaceChangeSummaries(nextSummaries);
      } finally {
        refreshInFlight = false;
      }
    };

    void refreshCodeChanges();
    const interval = window.setInterval(
      () => void refreshCodeChanges(),
      CODE_CHANGE_REFRESH_MS
    );

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [workspaceChangeFingerprint]);

  function updateWorkspace(
    workspaceId: string,
    updater: (workspace: ProjectWorkspace) => ProjectWorkspace
  ) {
    setWorkspaces((current) => {
      let changed = false;
      const nextWorkspaces = current.map((workspace) => {
        if (workspace.id !== workspaceId) {
          return workspace;
        }

        const nextWorkspace = updater(workspace);
        if (nextWorkspace === workspace) {
          return workspace;
        }

        changed = true;
        return nextWorkspace;
      });

      return changed ? nextWorkspaces : current;
    });
  }

  function updateScopeSessions(
    scope: SessionScope,
    updater: (sessions: AgentSession[]) => AgentSession[]
  ) {
    if (scope.type === "multi") {
      setMultiSessions((current) => {
        const nextSessions = updater(current);
        return nextSessions === current ? current : nextSessions;
      });
      return;
    }

    updateWorkspace(scope.workspaceId, (workspace) => {
      const nextSessions = updater(workspace.sessions);
      return nextSessions === workspace.sessions
        ? workspace
        : {
            ...workspace,
            sessions: nextSessions
          };
    });
  }

  function updateAnySession(
    sessionId: string,
    updater: (session: AgentSession) => AgentSession
  ) {
    setMultiSessions((current) => {
      let changed = false;
      const nextSessions = current.map((session) => {
        if (session.id !== sessionId) {
          return session;
        }

        const nextSession = updater(session);
        changed = changed || nextSession !== session;
        return nextSession;
      });

      return changed ? nextSessions : current;
    });

    setWorkspaces((current) => {
      let changed = false;
      const nextWorkspaces = current.map((workspace) => {
        let sessionsChanged = false;
        const nextSessions = workspace.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          const nextSession = updater(session);
          sessionsChanged = sessionsChanged || nextSession !== session;
          return nextSession;
        });

        if (!sessionsChanged) {
          return workspace;
        }

        changed = true;
        return {
          ...workspace,
          sessions: nextSessions
        };
      });

      return changed ? nextWorkspaces : current;
    });
  }

  function applyTerminalStatus(
    sessionId: string,
    status: AgentSession["status"] | null
  ) {
    if (!status) {
      return;
    }

    updateAnySession(sessionId, (session) => {
      // claude/opencode "working" is telemetry-driven, so never let raw terminal
      // output (a snapshot replay on reconnect, a focus/click redraw) flip them
      // to "running" — that is the typing/selecting false positive we are fixing.
      if (status === "running" && isTurnTelemetryKind(session.kind)) {
        return session;
      }

      const nextStatus = reconcileStatus(session.status, status);
      return nextStatus === session.status
        ? session
        : { ...session, status: nextStatus };
    });
  }

  // A claude/opencode turn actually started (UserPromptSubmit / busy event), so
  // force the pane to "running" even past the done/failed stickiness — a new turn
  // legitimately supersedes the previous result — and drop any stale unread dot.
  function applyAgentRunning(sessionId: string) {
    updateAnySession(sessionId, (session) => {
      if (session.status === "running" && !session.attention?.unread && !session.backgroundActivity) {
        return session;
      }

      return {
        ...session,
        status: "running",
        backgroundActivity: undefined,
        attention: {
          state: "none",
          unread: false,
          updatedAt: Date.now(),
          source: "provider"
        }
      };
    });
  }

  function applyAgentBackgroundActivity(
    sessionId: string,
    activity: AgentBackgroundActivity
  ) {
    const backgroundActivity = normalizeBackgroundActivity(activity);
    updateAnySession(sessionId, (session) => {
      if (!backgroundActivity && !session.backgroundActivity) {
        return session;
      }

      return {
        ...session,
        backgroundActivity
      };
    });
  }

  function applyAgentAttention(
    sessionId: string,
    attentionEvent: AgentAttentionEvent
  ) {
    const selection = attentionSelectionRef.current;
    const attentionStatus = statusFromAttentionState(attentionEvent.state);

    updateAnySession(sessionId, (session) => {
      const nextStatus = attentionStatus
        ? reconcileStatus(session.status, attentionStatus)
        : session.status;

      return {
        ...session,
        status: nextStatus,
        attention: attentionFromEvent(
          attentionEvent,
          shouldMarkAttentionUnread(
            sessionId,
            selection.selectedSessionId,
            selection.visibleSessionIds,
            attentionEvent
          )
        )
      };
    });
  }

  function applyTerminalAttention(
    sessionId: string,
    attentionEvent: AgentAttentionEvent
  ) {
    const selection = attentionSelectionRef.current;

    updateAnySession(sessionId, (session) => {
      if (!shouldUseTerminalEventAttention(session)) {
        return session;
      }

      return {
        ...session,
        attention: attentionFromEvent(
          attentionEvent,
          shouldMarkAttentionUnread(
            sessionId,
            selection.selectedSessionId,
            selection.visibleSessionIds,
            attentionEvent
          )
        )
      };
    });
  }

  function clearSessionAttention(sessionId: string) {
    updateAnySession(sessionId, clearUnreadAttention);
  }

  function selectSession(sessionId: string) {
    setSelectedSessionId(sessionId);
    clearSessionAttention(sessionId);
  }

  function addSessionForCwd(scope: SessionScope, kind: AgentKind, cwd: string) {
    updateScopeSessions(scope, (sessions) => [
      ...sessions,
      createSession(kind, cwd, sessions)
    ]);
  }

  function sessionCreationKind(session: AgentSession): AgentKind {
    return session.fusion ? "fusion" : session.openFusion ? "openfusion" : session.kind;
  }

  async function addSession(kind: AgentKind) {
    if (!activeScope) {
      return;
    }

    if (activeScope.type === "multi") {
      const cwd = await window.vibe?.workspace.selectFolder();
      if (cwd) {
        addSessionForCwd(activeScope, kind, cwd);
      }
      return;
    }

    if (activeWorkspace) {
      addSessionForCwd(activeScope, kind, activeWorkspace.path);
    }
  }

  function duplicateSession(scope: SessionScope, session: AgentSession) {
    // A duplicate is a fresh pane (two panes must never resume the same id), but
    // it inherits the source's conversation as `resumeRef` so the copy can offer
    // "Resume last chat" to continue where the original left off.
    const sourceThread = activeSessionThreadRef(session) ?? sessionResumeRef(session);
    updateScopeSessions(scope, (sessions) => [
      ...sessions,
      {
        ...createSession(sessionCreationKind(session), session.cwd, sessions),
        name: `${session.name} copy`,
        command: session.command,
        openFusionPlannerModel: session.openFusion
          ? normalizeOpenFusionModel(
              session.openFusionPlannerModel,
              DEFAULT_OPEN_FUSION_PLANNER_MODEL
            )
          : undefined,
        openFusionExecutorModel: session.openFusion
          ? normalizeOpenFusionModel(
              session.openFusionExecutorModel,
              DEFAULT_OPEN_FUSION_EXECUTOR_MODEL
            )
          : undefined,
        resumeRef: sourceThread
      }
    ]);
  }

  function stopSessionProcess(session: AgentSession): Promise<boolean> {
    if (session.fusion) {
      return window.vibe?.fusionChat?.stop(session.id) ?? Promise.resolve(false);
    }

    return window.vibe?.terminal.kill(session.id) ?? Promise.resolve(false);
  }

  function closeSession(scope: SessionScope, session: AgentSession) {
    void stopSessionProcess(session);
    const sessionId = session.id;
    updateScopeSessions(scope, (sessions) =>
      sessions.filter((session) => session.id !== sessionId)
    );

    if (maximizedSessionId === sessionId) {
      setMaximizedSessionId(null);
    }

    if (selectedSessionId === sessionId) {
      setSelectedSessionId(null);
    }
  }

  function requestWorkspaceClose(workspaceId: string) {
    setWorkspaceClosePendingId(workspaceId);
  }

  function cancelWorkspaceClose() {
    setWorkspaceClosePendingId(null);
  }

  function confirmWorkspaceClose(workspaceId: string) {
    setWorkspaceClosePendingId(null);
    removeWorkspace(workspaceId);
  }

  function removeWorkspace(workspaceId: string) {
    const workspaceIndex = workspaces.findIndex(
      (workspace) => workspace.id === workspaceId
    );
    const workspace = workspaces[workspaceIndex];

    if (!workspace) {
      return;
    }

    const removedSessionIds = new Set(
      workspace.sessions.map((session) => session.id)
    );
    workspace.sessions.forEach((session) => {
      void stopSessionProcess(session);
    });

    const nextWorkspaces = workspaces.filter(
      (item) => item.id !== workspaceId
    );

    setWorkspaces(nextWorkspaces);

    if (
      activeWorkspaceId === workspaceId ||
      !nextWorkspaces.some((item) => item.id === activeWorkspaceId)
    ) {
      const nextActiveWorkspace =
        nextWorkspaces[Math.min(workspaceIndex, nextWorkspaces.length - 1)] ??
        null;

      setActiveWorkspaceId(nextActiveWorkspace?.id ?? null);

      if (!nextActiveWorkspace && activeView === "project") {
        setActiveView("multi");
      }
    }

    if (maximizedSessionId && removedSessionIds.has(maximizedSessionId)) {
      setMaximizedSessionId(null);
    }

    if (selectedSessionId && removedSessionIds.has(selectedSessionId)) {
      setSelectedSessionId(null);
    }
  }

  function restartSession(scope: SessionScope, session: AgentSession) {
    stopSessionProcess(session).then(() => {
      updateScopeSessions(scope, (sessions) =>
        sessions.map((item) => {
          if (item.id !== session.id) {
            return item;
          }

          const currentClaudeRef = hasClaudeThreadId(item.threadRef)
            ? item.threadRef
            : undefined;
          const previousClaudeRef = sessionResumeRef(item);
          const canResume = !item.fusion && canResumeSessionThread(item);
          return {
            ...item,
            ...(item.fusion
              ? {
                  threadRef: undefined,
                  resumeRef: currentClaudeRef ?? previousClaudeRef
                }
              : {}),
            started: true,
            launchToken: item.launchToken + 1,
            nextLaunchMode: canResume ? "resume" : "new",
            threadLookupStartedAt: undefined,
            threadLookupStatus: canResume ? "found" : "idle",
            threadLookupMessage: undefined,
            status: "idle",
            attention: EMPTY_ATTENTION,
            backgroundActivity: undefined
          };
        })
      );
    });
  }

  function applyFusionChatLifecycle(event: FusionChatEvent) {
    if (!("id" in event) || typeof event.id !== "string") {
      return;
    }

    if (event.type === "turn-start") {
      updateAnySession(event.id, (session) => {
        if (!session.fusion) {
          return session;
        }

        return {
          ...session,
          status: "running",
          attention: EMPTY_ATTENTION,
          backgroundActivity: undefined
        };
      });
      return;
    }

    if (event.type === "activity" && event.kind === "warmup_error") {
      applyFusionAttention(event.id, {
        state: "failed",
        reason: "error",
        source: "provider",
        updatedAt: Date.now(),
        message: event.text || "Fusion execution bridge failed to start."
      });
      return;
    }

    if (event.type === "tool-call") {
      fusionBridgeToolRef.current.set(
        `${event.id}:${event.toolId}`,
        /codex_investigate|codex_implement|codex_respond/.test(event.name)
      );
      return;
    }

    if (event.type === "tool-result") {
      const toolKey = `${event.id}:${event.toolId}`;
      const isFusionBridgeTool = fusionBridgeToolRef.current.get(toolKey) === true;
      fusionBridgeToolRef.current.delete(toolKey);
      if (!isFusionBridgeTool) {
        return;
      }
      const parsed = parseFusionToolResult(event.text);
      if (parsed?.status === "needs_decision" || parsed?.nextAction === "ask_human") {
        applyFusionAttention(event.id, {
          state: "waiting",
          reason: parsed.status === "needs_decision" ? "approval" : "question",
          source: "provider",
          updatedAt: Date.now(),
          message:
            typeof parsed.detail === "string"
              ? parsed.detail
              : "Fusion needs a decision to continue."
        });
      } else if (parsed?.status === "failed" || parsed?.status === "error") {
        applyFusionAttention(event.id, {
          state: "failed",
          reason: "error",
          source: "provider",
          updatedAt: Date.now(),
          message:
            typeof parsed.error === "string"
              ? parsed.error
              : "Fusion returned an error."
        });
      } else if (parsed) {
        updateAnySession(event.id, (session) =>
          session.fusion && session.status === "waiting"
            ? { ...session, status: "running", attention: EMPTY_ATTENTION, backgroundActivity: undefined }
            : session
        );
      }
      return;
    }

    if (event.type === "result") {
      updateAnySession(event.id, (session) => {
        if (!session.fusion) {
          return session;
        }

        if (session.status === "waiting") {
          return session.backgroundActivity
            ? { ...session, backgroundActivity: undefined }
            : session;
        }

        const attentionEvent: AgentAttentionEvent = {
          state: "completed",
          reason: "done",
          source: "provider",
          updatedAt: Date.now()
        };

        return {
          ...session,
          status: reconcileStatus(session.status, "done"),
          backgroundActivity: undefined,
          attention: attentionFromEvent(
            attentionEvent,
            shouldMarkFusionAttentionUnread(event.id, attentionEvent)
          )
        };
      });
      return;
    }

    if (event.type === "interrupted") {
      updateAnySession(event.id, (session) =>
        session.fusion ? { ...session, status: "waiting", backgroundActivity: undefined } : session
      );
      return;
    }

    if (event.type === "error") {
      applyFusionAttention(event.id, {
        state: "failed",
        reason: "error",
        source: "provider",
        updatedAt: Date.now(),
        message: event.message
      });
      return;
    }

    if (event.type === "closed") {
      updateAnySession(event.id, (session) => {
        if (!session.fusion) {
          return session;
        }

        if (session.status !== "running") {
          return session.backgroundActivity
            ? { ...session, backgroundActivity: undefined }
            : session;
        }

        const message =
          event.code != null && event.code !== 0
            ? `Fusion process exited with code ${event.code}.`
            : "Fusion process closed before returning a result.";
        const attentionEvent: AgentAttentionEvent = {
          state: "failed",
          reason: "exit",
          source: "provider",
          updatedAt: Date.now(),
          message
        };

        return {
          ...session,
          status: "failed",
          backgroundActivity: undefined,
          attention: attentionFromEvent(
            attentionEvent,
            shouldMarkFusionAttentionUnread(event.id, attentionEvent)
          )
        };
      });
    }
  }

  function parseFusionToolResult(text: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  function shouldMarkFusionAttentionUnread(
    sessionId: string,
    attentionEvent: AgentAttentionEvent
  ) {
    const selection = attentionSelectionRef.current;
    return shouldMarkAttentionUnread(
      sessionId,
      selection.selectedSessionId,
      selection.visibleSessionIds,
      attentionEvent
    );
  }

  function applyFusionAttention(
    sessionId: string,
    attentionEvent: AgentAttentionEvent
  ) {
    const attentionStatus = statusFromAttentionState(attentionEvent.state);
    updateAnySession(sessionId, (session) => {
      if (!session.fusion) {
        return session;
      }

      return {
        ...session,
        status: attentionStatus
          ? reconcileStatus(session.status, attentionStatus)
          : session.status,
        backgroundActivity:
          attentionEvent.state === "completed" || attentionEvent.state === "failed"
            ? undefined
            : session.backgroundActivity,
        attention: attentionFromEvent(
          attentionEvent,
          shouldMarkFusionAttentionUnread(sessionId, attentionEvent)
        )
      };
    });
  }

  // Deliberately resume the pane's previous conversation. Mirrors restartSession
  // but forces nextLaunchMode "resume" against the stashed resumeRef. The
  // outgoing active thread becomes the next resumeRef so switching back does not
  // discard the current conversation pointer.
  function resumeSession(scope: SessionScope, session: AgentSession) {
    const resumeRef = sessionResumeRef(session);
    if (!resumeRef?.id) {
      return;
    }

    if (isThreadRefClaimedByOther(session.id, resumeRef)) {
      updateScopeSessions(scope, (sessions) =>
        sessions.map((item) =>
          item.id === session.id
            ? {
                ...item,
                threadLookupStatus: "failed",
                threadLookupMessage: "That chat is already open in another pane."
              }
            : item
        )
      );
      return;
    }

    stopSessionProcess(session).then(() => {
      updateScopeSessions(scope, (sessions) =>
        sessions.map((item) => {
          if (item.id !== session.id) {
            return item;
          }

          const latestResumeRef = sessionResumeRef(item);
          if (!latestResumeRef?.id) {
            return item;
          }

          const currentThreadRef = activeSessionThreadRef(item);
          const nextResumeRef =
            currentThreadRef?.id &&
            (currentThreadRef.provider !== latestResumeRef.provider ||
              currentThreadRef.id !== latestResumeRef.id)
              ? currentThreadRef
              : undefined;

          return {
            ...item,
            started: true,
            launchToken: item.launchToken + 1,
            nextLaunchMode: "resume",
            threadRef: latestResumeRef,
            resumeRef: nextResumeRef,
            threadLookupStartedAt: undefined,
            threadLookupStatus: "found",
            threadLookupMessage: undefined,
            status: "idle",
            attention: EMPTY_ATTENTION,
            backgroundActivity: undefined
          };
        })
      );
    });
  }

  function clearFusionSession(scope: SessionScope, session: AgentSession) {
    if (!session.fusion) {
      return;
    }

    stopSessionProcess(session).then(() => {
      updateScopeSessions(scope, (sessions) =>
        sessions.map((item) => {
          if (item.id !== session.id) {
            return item;
          }

          const currentClaudeRef = hasClaudeThreadId(item.threadRef)
            ? item.threadRef
            : undefined;
          const previousClaudeRef = sessionResumeRef(item);

          return {
            ...item,
            started: true,
            launchToken: item.launchToken + 1,
            nextLaunchMode: "new",
            threadRef: undefined,
            resumeRef: currentClaudeRef ?? previousClaudeRef,
            threadLookupStartedAt: undefined,
            threadLookupStatus: "idle",
            threadLookupMessage: undefined,
            status: "idle",
            attention: EMPTY_ATTENTION,
            backgroundActivity: undefined
          };
        })
      );
    });
  }

  function updateFusionSettings(
    scope: SessionScope,
    session: AgentSession,
    settings: FusionSettings
  ) {
    if (!session.fusion) {
      return;
    }

    const nextFusionModel = normalizeFusionModel(settings.model);
    const nextFusionCodexModel = normalizeFusionCodexModel(settings.codexModel);
    const nextFusionClaudeEffort = normalizeFusionEffort(settings.claudeEffort);
    const nextFusionCodexEffort = normalizeFusionEffort(settings.codexEffort);
    const nextFusionRunMode = normalizeFusionRunMode(settings.mode);
    const currentFusionModel = normalizeFusionModel(session.fusionModel);
    const currentFusionCodexModel = normalizeFusionCodexModel(session.fusionCodexModel);
    const currentFusionClaudeEffort = normalizeFusionEffort(
      session.fusionClaudeEffort ?? session.fusionEffort
    );
    const currentFusionCodexEffort = normalizeFusionEffort(
      session.fusionCodexEffort ?? session.fusionEffort
    );
    const requiresRestart =
      nextFusionModel !== currentFusionModel ||
      nextFusionClaudeEffort !== currentFusionClaudeEffort;
    const codexSettingsChanged =
      nextFusionCodexModel !== currentFusionCodexModel ||
      nextFusionCodexEffort !== currentFusionCodexEffort;

    if (session.started && !requiresRestart && codexSettingsChanged) {
      window.vibe?.fusionChat
        ?.updateSettings(session.id, {
          codexModel: nextFusionCodexModel,
          codexEffort: nextFusionCodexEffort
        })
        .catch(() => {});
    }

    const applySettings = () => {
      updateScopeSessions(scope, (sessions) =>
        sessions.map((item) => {
          if (item.id !== session.id) {
            return item;
          }

          const currentClaudeRef = hasClaudeThreadId(item.threadRef)
            ? item.threadRef
            : undefined;
          const previousClaudeRef = sessionResumeRef(item);
          const relaunchResumeRef = currentClaudeRef ?? previousClaudeRef;
          return {
            ...item,
            fusionModel: nextFusionModel,
            fusionCodexModel: nextFusionCodexModel,
            fusionClaudeEffort: nextFusionClaudeEffort,
            fusionCodexEffort: nextFusionCodexEffort,
            fusionRunMode: nextFusionRunMode,
            fusionEffort: undefined,
            ...(requiresRestart && item.fusion
              ? {
                  threadRef: relaunchResumeRef,
                  resumeRef: currentClaudeRef ? previousClaudeRef : undefined
                }
              : {}),
            ...(requiresRestart && item.started
              ? {
                  started: true,
                  launchToken: item.launchToken + 1,
                  nextLaunchMode: relaunchResumeRef?.id ? "resume" : "new",
                  threadLookupStartedAt: undefined,
                  threadLookupStatus: relaunchResumeRef?.id ? "found" : "idle",
                  threadLookupMessage: undefined,
                  status: "idle" as const,
                  attention: EMPTY_ATTENTION
                }
              : {})
          };
        })
      );
    };

    if (session.started && requiresRestart) {
      stopSessionProcess(session).then(applySettings);
    } else {
      applySettings();
    }
  }

  function updateSessionStatus(
    scope: SessionScope,
    sessionId: string,
    status: AgentSession["status"]
  ) {
    updateScopeSessions(scope, (sessions) => {
      let changed = false;
      const nextSessions = sessions.map((session) => {
        if (session.id !== sessionId) {
          return session;
        }

        const nextStatus = reconcileStatus(session.status, status);
        if (nextStatus === session.status) {
          return session;
        }

        changed = true;
        return { ...session, status: nextStatus };
      });

      return changed ? nextSessions : sessions;
    });
  }

  function persistLayout(scope: SessionScope, nextLayouts: Record<string, LayoutBox>) {
    updateScopeSessions(scope, (sessions) => {
      let changed = false;
      const nextSessions = sessions.map((session) => {
        const item = nextLayouts[session.id];
        if (!item) {
          return session;
        }

        const nextLayout = {
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          unit: "fluid" as const
        };

        if (layoutsMatch(session.layout, nextLayout)) {
          return session;
        }

        changed = true;
        return {
          ...session,
          layout: nextLayout
        };
      });

      return changed ? nextSessions : sessions;
    });
  }

  function updateSessionThreadRef(
    scope: SessionScope,
    sessionId: string,
    threadRef: AgentThreadRef
  ) {
    updateScopeSessions(scope, (sessions) =>
      sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              threadRef: {
                ...session.threadRef,
                ...threadRef
              },
              threadLookupStatus: "found",
              threadLookupMessage: undefined
            }
          : session
      )
    );
  }

  function resetSessionThreadForFreshLaunch(
    scope: SessionScope,
    sessionId: string,
    patch: ThreadLookupPatch
  ) {
    updateScopeSessions(scope, (sessions) =>
      sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              threadRef: undefined,
              nextLaunchMode: "new",
              threadLookupStartedAt: patch.threadLookupStartedAt,
              threadLookupStatus: patch.threadLookupStatus,
              threadLookupMessage: patch.threadLookupMessage
            }
          : session
      )
    );
  }

  function updateSessionThreadLookup(
    scope: SessionScope,
    sessionId: string,
    patch: ThreadLookupPatch
  ) {
    updateScopeSessions(scope, (sessions) => {
      let changed = false;
      const nextSessions = sessions.map((session) => {
        if (session.id !== sessionId) {
          return session;
        }

        if (
          session.threadLookupStartedAt === patch.threadLookupStartedAt &&
          session.threadLookupStatus === patch.threadLookupStatus &&
          session.threadLookupMessage === patch.threadLookupMessage
        ) {
          return session;
        }

        changed = true;
        return {
          ...session,
          ...patch
        };
      });

      return changed ? nextSessions : sessions;
    });
  }

  function claimedThreadIds(sessionId: string) {
    return allSessions
      .filter((session) => session.id !== sessionId)
      .map((session) => session.threadRef?.id)
      .filter((id): id is string => Boolean(id));
  }

  function isThreadRefClaimedByOther(
    sessionId: string,
    threadRef?: AgentThreadRef
  ) {
    if (!threadRef?.id) {
      return false;
    }

    return allSessions.some(
      (session) =>
        session.id !== sessionId &&
        session.threadRef?.provider === threadRef.provider &&
        session.threadRef.id === threadRef.id
    );
  }

  function workspaceHasUnreadAttention(workspace: ProjectWorkspace) {
    return workspace.sessions.some(shouldShowAttentionDot);
  }

  function workspaceHasWorking(workspace: ProjectWorkspace) {
    return workspace.sessions.some(isSessionWorking);
  }

  const multiModeHasUnreadAttention =
    multiSessions.some(shouldShowAttentionDot);

  const multiModeHasWorking = multiSessions.some(isSessionWorking);

  function handleSidebarResizePointerDown(
    event: ReactPointerEvent<HTMLDivElement>
  ) {
    if (!sidebarOpen || event.button !== 0) {
      return;
    }

    event.preventDefault();

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const handle = event.currentTarget;

    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // Window listeners still carry the resize if capture is unavailable.
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }

      moveEvent.preventDefault();
      setSidebarWidth(
        clampSidebarWidth(startWidth + moveEvent.clientX - startX)
      );
    };

    const finishResize = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) {
        return;
      }

      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // Capture may already be released if focus moved away.
      }

      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };

    window.addEventListener("pointermove", handlePointerMove, {
      passive: false
    });
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
  }

  function handleSidebarResizeKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>
  ) {
    if (!sidebarOpen) {
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSidebarWidth((current) => clampSidebarWidth(current - 16));
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      setSidebarWidth((current) => clampSidebarWidth(current + 16));
    }

    if (event.key === "Home") {
      event.preventDefault();
      setSidebarWidth(MIN_SIDEBAR_WIDTH);
    }

    if (event.key === "End") {
      event.preventDefault();
      setSidebarWidth(maxSidebarWidth());
    }
  }

  function updateWorkspaceDropTarget(nextTarget: WorkspaceDropTarget | null) {
    setWorkspaceDropTarget((currentTarget) => {
      if (
        currentTarget?.workspaceId === nextTarget?.workspaceId &&
        currentTarget?.position === nextTarget?.position
      ) {
        return currentTarget;
      }

      return nextTarget;
    });
  }

  function handleWorkspaceDragStart(
    event: ReactDragEvent<HTMLButtonElement>,
    workspaceId: string
  ) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", workspaceId);
    setDraggingWorkspaceId(workspaceId);
    updateWorkspaceDropTarget(null);
  }

  function handleWorkspaceDragOver(
    event: ReactDragEvent<HTMLDivElement>,
    targetWorkspaceId: string
  ) {
    if (!draggingWorkspaceId || draggingWorkspaceId === targetWorkspaceId) {
      updateWorkspaceDropTarget(null);
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    updateWorkspaceDropTarget({
      workspaceId: targetWorkspaceId,
      position: getWorkspaceDropPosition(event.currentTarget, event.clientY)
    });
  }

  function handleWorkspaceDrop(
    event: ReactDragEvent<HTMLDivElement>,
    targetWorkspaceId: string
  ) {
    const draggedWorkspaceId =
      draggingWorkspaceId || event.dataTransfer.getData("text/plain");
    const position =
      workspaceDropTarget?.workspaceId === targetWorkspaceId
        ? workspaceDropTarget.position
        : getWorkspaceDropPosition(event.currentTarget, event.clientY);

    event.preventDefault();
    setDraggingWorkspaceId(null);
    updateWorkspaceDropTarget(null);

    if (!draggedWorkspaceId) {
      return;
    }

    setWorkspaces((current) =>
      moveWorkspace(current, draggedWorkspaceId, targetWorkspaceId, position)
    );
  }

  function handleWorkspaceDragEnd() {
    setDraggingWorkspaceId(null);
    updateWorkspaceDropTarget(null);
  }

  function handleWorkspaceListDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (
      !(nextTarget instanceof Node) ||
      !event.currentTarget.contains(nextTarget)
    ) {
      updateWorkspaceDropTarget(null);
    }
  }

  async function openFolder() {
    const path = await window.vibe?.workspace.selectFolder();
    if (!path) {
      return;
    }

    const existingWorkspace = workspaces.find(
      (workspace) =>
        normalizeWorkspacePath(workspace.path) === normalizeWorkspacePath(path)
    );

    if (existingWorkspace) {
      setActiveWorkspaceId(existingWorkspace.id);
      setActiveView("project");
      return;
    }

    const workspace = starterWorkspace(path);
    setWorkspaces((current) => [workspace, ...current]);
    setActiveWorkspaceId(workspace.id);
    setActiveView("project");
  }

  const visibleSessions =
    boardSessions.filter(
      (session) => !maximizedSessionId || session.id === maximizedSessionId
    );
  const updateNoticeKey = updateState
    ? [
        updateState.status,
        updateState.info?.version ?? "",
        updateState.errorMessage ?? ""
      ].join(":")
    : "";
  const shouldShowUpdateOverlay =
    updateState !== null &&
    ["available", "downloading", "downloaded", "error"].includes(updateState.status) &&
    dismissedUpdateKey !== updateNoticeKey;
  const updateVersion = updateState?.info?.version
    ? `v${updateState.info.version}`
    : "a new version";
  const currentAppVersionLabel = updateState?.currentVersion
    ? `v${updateState.currentVersion}`
    : null;
  const updatePercent = updateState ? formatUpdatePercent(updateState) : 0;
  const updateCheckLabel =
    updateState?.status === "checking"
      ? "Checking..."
      : updateState?.status === "downloaded"
        ? "Update ready"
        : updateState?.status === "available"
          ? "Update available"
          : updateState?.status === "downloading"
            ? "Downloading..."
            : "Check for update";
  const updateCheckDisabled =
    updateState?.status === "checking" || updateState?.status === "downloading";

  function dismissUpdateOverlay() {
    setDismissedUpdateKey(updateNoticeKey);
  }

  async function checkForUpdates() {
    setDismissedUpdateKey(null);

    const result = await window.vibe?.updates.check();
    if (!result) {
      setShellMessage("Update checks are unavailable in this window.");
      return;
    }

    if (!result.ok || result.message) {
      setShellMessage(result.message || "Update check failed.");
    }
  }

  async function downloadUpdate() {
    const result = await window.vibe?.updates.download();
    if (result && !result.ok) {
      setUpdateState((current) => ({
        status: "error",
        updatedAt: Date.now(),
        info: current?.info,
        errorMessage: result.message || "Update failed."
      }));
    }
  }

  async function restartToUpdate() {
    await window.vibe?.updates.restart();
  }

  return (
    <div
      className={clsx("app-shell", !sidebarOpen && "sidebar-collapsed")}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <aside className="sidebar" aria-label="Projects and chats">
        <div className="brand">
          <div className="brand-mark">
            <img src={vibeTerminalLogo} alt="" aria-hidden="true" />
          </div>
          <div>
            <h1>vibeTerminal</h1>
            <span>agent cockpit</span>
          </div>
        </div>

        <button className="open-folder-button" onClick={openFolder}>
          <FolderOpen size={17} />
          Open Folder
        </button>

        <button
          className={clsx(
            "multi-mode-card",
            activeView === "multi" && "active",
            multiModeHasUnreadAttention && "has-attention",
            !multiModeHasUnreadAttention &&
              multiModeHasWorking &&
              "has-working"
          )}
          aria-label="Multi mode"
          onClick={() => {
            setSelectedSessionId(null);
            setActiveView("multi");
          }}
        >
          <div className="multi-mode-heading">
            <LayoutGrid size={15} />
            <span>Multi mode</span>
            {multiModeHasUnreadAttention ? (
              <span className="attention-dot" aria-hidden="true" />
            ) : multiModeHasWorking ? (
              <span
                className="attention-dot attention-dot-working"
                aria-hidden="true"
              />
            ) : null}
          </div>
          <span className="multi-mode-subtitle">
            {formatCount(multiSessions.length, "terminal")}
          </span>
        </button>

        <div className="sidebar-section-title">Folders</div>
        <div
          className="workspace-list"
          onDragLeave={handleWorkspaceListDragLeave}
        >
          {workspaces.map((workspace) => {
            const hasUnreadAttention = workspaceHasUnreadAttention(workspace);
            const hasWorking =
              !hasUnreadAttention && workspaceHasWorking(workspace);
            const isDropTarget =
              workspaceDropTarget?.workspaceId === workspace.id;

            return (
              <div
                className={clsx(
                  "workspace-row",
                  draggingWorkspaceId === workspace.id && "dragging",
                  isDropTarget &&
                    workspaceDropTarget?.position === "before" &&
                    "drop-before",
                  isDropTarget &&
                    workspaceDropTarget?.position === "after" &&
                    "drop-after"
                )}
                key={workspace.id}
                onDragOver={(event) =>
                  handleWorkspaceDragOver(event, workspace.id)
                }
                onDrop={(event) => handleWorkspaceDrop(event, workspace.id)}
              >
                <button
                  type="button"
                  className={clsx(
                    "workspace-button",
                    activeView === "project" &&
                      workspace.id === activeWorkspace?.id &&
                      "active",
                    hasUnreadAttention && "has-attention",
                    hasWorking && "has-working"
                  )}
                  draggable={workspaces.length > 1}
                  onDragStart={(event) =>
                    handleWorkspaceDragStart(event, workspace.id)
                  }
                  onDragEnd={handleWorkspaceDragEnd}
                  onClick={() => {
                    setSelectedSessionId(null);
                    setActiveWorkspaceId(workspace.id);
                    setActiveView("project");
                  }}
                >
                  <span
                    className={clsx(
                      "attention-dot",
                      hasWorking && "attention-dot-working",
                      !hasUnreadAttention &&
                        !hasWorking &&
                        "attention-dot-empty"
                    )}
                    aria-hidden="true"
                  />
                  <Folder size={16} />
                  <span>{workspace.name}</span>
                  <ChevronRight size={15} />
                </button>
                <button
                  type="button"
                  className="workspace-remove-button"
                  title={`Close ${workspace.name}`}
                  aria-label={`Close ${workspace.name}`}
                  onClick={() => requestWorkspaceClose(workspace.id)}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>

      </aside>

      {sidebarOpen && (
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={maxSidebarWidth()}
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={0}
          onKeyDown={handleSidebarResizeKeyDown}
          onPointerDown={handleSidebarResizePointerDown}
        />
      )}

      <main className="workspace">
        <header className="topbar">
          <button
            className="icon-button"
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>

          <div className="workspace-title">
            <LayoutGrid size={19} />
            <div className="workspace-title-copy">
              <strong>{boardTitle}</strong>
              <span>{boardSubtitle}</span>
            </div>
          </div>

          <div className="quick-actions">
            {currentAppVersionLabel && (
              <span className="app-version" title="Current app version">
                {currentAppVersionLabel}
              </span>
            )}
            <button onClick={checkForUpdates} disabled={updateCheckDisabled}>
              <RefreshCw size={16} />
              {updateCheckLabel}
            </button>
          </div>
        </header>

        {shellMessage && (
          <div className="host-message" role="status">
            {shellMessage}
            <button onClick={() => setShellMessage(null)}>Dismiss</button>
          </div>
        )}

        <section className="agent-toolbar" aria-label="Agent launchers">
          <div className="agent-toolbar-actions">
            {launcherAgentProfiles.map((profile) => (
              <button
                key={profile.kind}
                onClick={() => addSession(profile.kind)}
                style={{ "--agent-accent": profile.accent } as React.CSSProperties}
              >
                {profile.openFusion ? (
                  <img className="agent-launcher-logo" src={openFusionLogo} alt="" />
                ) : (
                  <Plus size={14} />
                )}
                {profile.label}
              </button>
            ))}
          </div>

          {activeView === "project" && activeWorkspace && (
            <div
              className={clsx(
                "code-line-summary",
                activeWorkspaceChangeSummary &&
                  `code-change-${activeWorkspaceChangeSummary.state}`
              )}
              title={formatCodeLineSummary(activeWorkspaceChangeSummary)}
              aria-label={formatCodeLineSummary(activeWorkspaceChangeSummary)}
            >
              {activeWorkspaceChangeSummary?.state === "dirty" ? (
                <>
                  <span className="diff-insertions">
                    +{activeWorkspaceChangeSummary.insertions} written
                  </span>
                  <span className="diff-deletions">
                    -{activeWorkspaceChangeSummary.deletions} deleted
                  </span>
                </>
              ) : (
                <span className="diff-muted">
                  {activeWorkspaceChangeSummary?.state === "not-git"
                    ? "No Git repo"
                    : activeWorkspaceChangeSummary?.state === "unavailable"
                      ? "Git unavailable"
                      : activeWorkspaceChangeSummary?.state === "clean"
                        ? "Nothing new"
                        : "Scanning changes"}
                </span>
              )}
            </div>
          )}
        </section>

        <section className="terminal-board">
          {activeScope && visibleSessions.length > 0 ? (
            <TiledBoard
              disabled={Boolean(maximizedSessionId)}
              onArrangeChange={setIsArranging}
              onLayoutCommit={(layouts) => persistLayout(activeScope, layouts)}
              items={visibleSessions.map((session) => ({
                id: session.id,
                minW:
                  session.id === maximizedSessionId
                    ? DEFAULT_MIN_PANE_WIDTH * 2
                    : DEFAULT_MIN_PANE_WIDTH,
                minH:
                  session.id === maximizedSessionId
                    ? DEFAULT_MIN_PANE_HEIGHT * 2
                    : DEFAULT_MIN_PANE_HEIGHT,
                layout:
                  session.id === maximizedSessionId
                    ? {
                        x: 0,
                        y: LEGACY_BOARD_PADDING,
                        w: 100,
                        h: MAXIMIZED_PANE_HEIGHT,
                        unit: "fluid"
                      }
                    : session.layout,
                content: session.fusion ? (
                  <FusionChatPane
                    session={session}
                    profile={getProfile("fusion")}
                    isMaximized={session.id === maximizedSessionId}
                    isSelected={session.id === selectedSessionId}
                    onClose={() => closeSession(activeScope, session)}
                    onDuplicate={() => duplicateSession(activeScope, session)}
                    onRestart={() => restartSession(activeScope, session)}
                    onResume={() => resumeSession(activeScope, session)}
                    onClear={() => clearFusionSession(activeScope, session)}
                    onSettingsChange={(settings) =>
                      updateFusionSettings(activeScope, session, settings)
                    }
                    onAdd={() =>
                      addSessionForCwd(activeScope, sessionCreationKind(session), session.cwd)
                    }
                    onSelect={() => selectSession(session.id)}
                    onMaximize={() =>
                      setMaximizedSessionId((current) =>
                        current === session.id ? null : session.id
                      )
                    }
                    onThreadRefChange={(threadRef) =>
                      updateSessionThreadRef(activeScope, session.id, threadRef)
                    }
                    onStatusChange={(status) =>
                      updateSessionStatus(activeScope, session.id, status)
                    }
                    onAttention={(attention) =>
                      applyAgentAttention(session.id, attention)
                    }
                  />
                ) : (
                  <TerminalPane
                    session={session}
                    profile={
                      session.openFusion
                        ? getProfile("openfusion")
                        : session.fusion
                          ? getProfile("fusion")
                          : getProfile(session.kind)
                    }
                    providerLogoSrc={session.openFusion ? openFusionLogo : undefined}
                    claimedThreadIds={claimedThreadIds(session.id)}
                    isMaximized={session.id === maximizedSessionId}
                    isArranging={isArranging}
                    onClose={() => closeSession(activeScope, session)}
                    onDuplicate={() => duplicateSession(activeScope, session)}
                    onRestart={() => restartSession(activeScope, session)}
                    onResume={() => resumeSession(activeScope, session)}
                    onAdd={() =>
                      addSessionForCwd(activeScope, sessionCreationKind(session), session.cwd)
                    }
                    onSelect={() => selectSession(session.id)}
                    onMaximize={() =>
                      setMaximizedSessionId((current) =>
                        current === session.id ? null : session.id
                      )
                    }
                    onThreadRefChange={(threadRef) =>
                      updateSessionThreadRef(activeScope, session.id, threadRef)
                    }
                    onFreshLaunchFallback={(patch) =>
                      resetSessionThreadForFreshLaunch(
                        activeScope,
                        session.id,
                        patch
                      )
                    }
                    onThreadLookupChange={(patch) =>
                      updateSessionThreadLookup(activeScope, session.id, patch)
                    }
                    onStatusChange={(status) =>
                      updateSessionStatus(activeScope, session.id, status)
                    }
                  />
                )
              }))}
            />
          ) : (
            <div className="empty-state">
              <Play size={42} />
              <h2>Choose what to spin up.</h2>
              <p>
                {activeView === "multi"
                  ? "Add terminals or coding agents from any repo onto this free board."
                  : "Open a folder, then add only the terminal or coding agent panes you want for that folder."}
              </p>
              {activeScope ? (
                <div className="empty-actions">
                  {launcherAgentProfiles.map((profile) => (
                    <button
                      key={profile.kind}
                      onClick={() => addSession(profile.kind)}
                    >
                      {profile.openFusion ? (
                        <img className="agent-launcher-logo" src={openFusionLogo} alt="" />
                      ) : (
                        <Plus size={16} />
                      )}
                      {profile.label}
                    </button>
                  ))}
                </div>
              ) : (
                <button onClick={openFolder}>
                  <FolderOpen size={17} />
                  Open Folder
                </button>
              )}
            </div>
          )}
        </section>
      </main>

      {shouldShowUpdateOverlay && updateState && (
        <aside className="update-overlay" aria-live="polite">
          <div className="update-overlay-heading">
            <strong>
              {updateState.status === "downloaded"
                ? "Update ready"
                : updateState.status === "error"
                  ? "Update failed"
                  : "Update available"}
            </strong>
            {updateState.status !== "downloading" && (
              <button
                className="update-overlay-dismiss"
                aria-label="Dismiss update notice"
                onClick={dismissUpdateOverlay}
              >
                <X size={13} />
              </button>
            )}
          </div>

          {updateState.status === "available" && (
            <>
              <p>vibeTerminal {updateVersion} is ready to download.</p>
              <div className="update-overlay-actions">
                <button onClick={dismissUpdateOverlay}>Later</button>
                <button className="primary" onClick={downloadUpdate}>
                  <Download size={15} />
                  Update
                </button>
              </div>
            </>
          )}

          {updateState.status === "downloading" && (
            <>
              <p>Downloading vibeTerminal {updateVersion}.</p>
              <div
                className="update-progress"
                aria-label={`Update download ${updatePercent}%`}
              >
                <span style={{ width: `${updatePercent}%` }} />
              </div>
            </>
          )}

          {updateState.status === "downloaded" && (
            <>
              <p>Restart when your terminals are in a good place. The update installs silently.</p>
              <div className="update-overlay-actions">
                <button onClick={dismissUpdateOverlay}>Later</button>
                <button className="primary" onClick={restartToUpdate}>
                  <RefreshCw size={15} />
                  Restart
                </button>
              </div>
            </>
          )}

          {updateState.status === "error" && (
            <>
              <p>{updateState.errorMessage || "The update could not be installed."}</p>
              <div className="update-overlay-actions">
                <button onClick={dismissUpdateOverlay}>Dismiss</button>
              </div>
            </>
          )}
        </aside>
      )}

      {workspaceClosePending && (
        <div
          className="confirmation-backdrop"
          onClick={cancelWorkspaceClose}
        >
          <section
            className="confirmation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-close-title"
            aria-describedby="workspace-close-description"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="confirmation-mark" aria-hidden="true">
              <Folder size={22} />
            </div>

            <div className="confirmation-copy">
              <h2 id="workspace-close-title">
                Close {workspaceClosePending.name}?
              </h2>
              <p id="workspace-close-description">
                This removes the folder from the sidebar and closes{" "}
                {formatCount(workspaceClosePendingSessionCount, "terminal pane")}.
                Your files stay on disk.
              </p>
              <span>{workspaceClosePending.path}</span>
            </div>

            <div className="confirmation-actions">
              <button onClick={cancelWorkspaceClose} autoFocus>
                Cancel
              </button>
              <button
                className="danger"
                onClick={() => confirmWorkspaceClose(workspaceClosePending.id)}
              >
                Close Folder
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
