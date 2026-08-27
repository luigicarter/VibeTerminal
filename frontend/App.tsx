import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  Check,
  ChevronDown,
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
  Search,
  Settings,
  TerminalSquare,
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
  clearSubagentDepth,
  clearUnreadAttention,
  codexTurnAttentionDecision,
  isSessionWorking,
  isTurnTelemetryKind,
  normalizeAttention,
  providerAttentionDecision,
  reconcileStatus,
  shouldMarkCompletedTurnUnread,
  shouldMarkAttentionUnread,
  shouldShowAttentionDot,
  shouldSuppressAgentCompletion,
  shouldUseTerminalEventAttention,
  statusFromAttentionState,
  statusFromTerminalEvent,
  summarizeSessions,
  updateDetachedTaskIds,
  updateSubagentDepth,
  type SessionSummary
} from "./attention";
import TerminalPane from "./components/TerminalPane";
import FusionChatPane from "./components/FusionChatPane";
import {
  normalizeFusionRoleSettings,
  type NormalizedFusionRoleSettings
} from "./components/fusionSlashMenu";
import OpenFusionChatPane, {
  type OpenFusionSettingsChange
} from "./components/OpenFusionChatPane";
import TiledBoard from "./components/TiledBoard";
import PaneSplit, { SPLIT_DIVIDER_PX } from "./components/PaneSplit";
import {
  buildBoardTiles,
  detachSessionFromTile,
  effectiveTileId,
  isTileAnchor,
  leafIds,
  normalizeSplitNode,
  reconcileTiles,
  setRatioAtPath,
  splitLeaf,
  subtreeMin,
  type SplitPath
} from "./components/splitTree";
import {
  createThreadRef,
  isThreadedAgentKind
} from "./sessionLaunch";
import { computeCwdConflicts } from "./cwdConflicts";
import { SettingsDialog } from "./components/SettingsDialog";
import type { InstalledCliReport } from "./electron";
import type {
  AgentAttentionEvent,
  AgentBackgroundActivity,
  AppVersionList,
  AgentKind,
  AgentProfile,
  AgentSession,
  AgentThreadRef,
  AgentThreadLookupStatus,
  BranchOverview,
  BranchOverviewEntry,
  ClaudeProviderProfile,
  CodeChangeSummary,
  FusionRunMode,
  FusionChatEvent,
  FusionSettings,
  LayoutBox,
  OpenFusionChatEvent,
  ProjectWorkspace,
  SplitNode,
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
const CODEX_INPUT_GRACE_MS = 450;
// Trusted Codex lifecycle hooks drive precise starts/waits; bare Enter is the
// compatibility fallback until trust/older-version gaps are resolved. Every
// PTY chunk refreshes this App-owned safety watchdog, including while hidden.
// It is intentionally much longer than the plain-terminal idle heuristic.
const CODEX_RUNNING_QUIET_MS = 60_000;
const DEFAULT_FUSION_RUN_MODE: FusionRunMode = "auto";

// Last-used model configuration, per terminal mode. New panes start from the
// previous session's picks instead of hard defaults — a model choice survives
// closing the pane/app until the user changes it somewhere. Run mode is
// deliberately NOT carried over (Plan vs Auto is situational).
const LAST_FUSION_SETTINGS_KEY = "vibe-terminal:last-fusion-settings";
const LAST_OPEN_FUSION_MODELS_KEY = "vibe-terminal:last-openfusion-models";

function readStoredJson(key: string): Record<string, unknown> | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredJson(key: string, value: Record<string, unknown>) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Persistence is best-effort; the session still works without it.
  }
}

function rememberFusionSettings(settings: NormalizedFusionRoleSettings) {
  writeStoredJson(LAST_FUSION_SETTINGS_KEY, { ...settings });
}

function lastFusionSettings(): NormalizedFusionRoleSettings {
  // Reads both the per-role shape and the legacy {model, codexModel,
  // claudeEffort, codexEffort} seed written before families existed.
  return normalizeFusionRoleSettings(readStoredJson(LAST_FUSION_SETTINGS_KEY));
}

function rememberOpenFusionModels(models: {
  plannerModel: string;
  executorModel: string;
}) {
  writeStoredJson(LAST_OPEN_FUSION_MODELS_KEY, models);
}

function lastOpenFusionModels() {
  const stored = readStoredJson(LAST_OPEN_FUSION_MODELS_KEY);
  return {
    plannerModel: normalizeOpenFusionModel(
      stored?.plannerModel,
      DEFAULT_OPEN_FUSION_PLANNER_MODEL
    ),
    executorModel: normalizeOpenFusionModel(
      stored?.executorModel,
      DEFAULT_OPEN_FUSION_EXECUTOR_MODEL
    )
  };
}

type AppView = "multi" | "project";

type SessionScope =
  | { type: "multi" }
  | { type: "workspace"; workspaceId: string };

type WorkspaceDropPosition = "before" | "after";

interface WorkspaceDropTarget {
  workspaceId: string;
  position: WorkspaceDropPosition;
}

interface WorkspaceContextMenuState {
  workspaceId: string;
  name: string;
  path: string;
  x: number;
  y: number;
}

interface ThreadLookupPatch {
  threadLookupStartedAt?: number;
  threadLookupStatus: AgentThreadLookupStatus;
  threadLookupMessage?: string;
}

interface PendingCodexAttention {
  providerThreadId: string;
  providerTurnId?: string;
  attention: AgentAttentionEvent;
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
    kind: "claude-custom",
    label: "Open Claude Code",
    command: "claude",
    accent: "#d97757",
    claudeCustom: true
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
  },
  {
    kind: "kimi",
    label: "Kimi",
    command: "kimi",
    accent: "#1e88e5"
  },
  {
    kind: "kimi-custom",
    label: "Kimi + CC",
    command: "kimi-custom",
    accent: "#8e24aa"
  },
  {
    kind: "qwen",
    label: "Qwen",
    command: "qwen",
    accent: "#6d7cff"
  }
];

// Every profile is offered. Gemini and Aider used to be filtered out here
// unconditionally, which hid them from the users who do have them installed;
// the launch-time CLI probe now dims what is missing instead of hiding it.
const launcherAgentProfiles = agentProfiles;

// One row in the toolbar launcher dropdown: an agent profile, a saved Claude
// provider, or one of the provider's endpoint models.
type LauncherMenuEntry = {
  key: string;
  section: "agents" | "providers";
  label: string;
  sub?: string;
  hint?: string;
  profile?: AgentProfile;
  missing?: boolean;
  indent?: boolean;
  run: () => void;
};

// Pane labels the app itself minted ("Claude 2", "Fusion 1 copy"). Older builds
// copied them into threadRef.title and forced them onto Claude via --name, so
// stored refs may still carry them. They say nothing about the conversation:
// restore strips them so the provider's own generated title can take over.
const genericSessionTitlePattern = new RegExp(
  `^(?:${agentProfiles.map((profile) => profile.label).join("|")})\\s+\\d+(?:\\s+copy)*$`,
  "i"
);

function isGenericSessionTitle(title: string | undefined) {
  return Boolean(title && genericSessionTitlePattern.test(title.trim()));
}

function sanitizeThreadRefTitle(
  ref: AgentThreadRef | undefined
): AgentThreadRef | undefined {
  if (!ref?.title || !isGenericSessionTitle(ref.title)) {
    return ref;
  }

  return { ...ref, title: undefined };
}

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

// The live per-project tally on a sidebar card. Every bucket comes from
// summarizeSessions, which is built from the same predicates the pane's own
// status pill and attention dot use, so a card can never disagree with the pane
// it is counting. Buckets that are zero are not rendered — a quiet project
// should read as quiet, not as a row of zeros — and a project with nothing
// happening falls back to the plain terminal count.
function SessionCounts({ summary }: { summary: SessionSummary }) {
  const { working, done, blocked, failed, total } = summary;

  if (!working && !done && !blocked && !failed) {
    return (
      <span className="session-counts session-counts-quiet">
        {total ? formatCount(total, "terminal") : "No terminals"}
      </span>
    );
  }

  const label = [
    working ? `${working} working` : null,
    done ? `${done} done` : null,
    blocked ? `${blocked} blocked` : null,
    failed ? `${failed} failed` : null
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <span className="session-counts" title={label} aria-label={label}>
      {working > 0 && (
        <span className="session-count session-count-working">
          <span className="session-count-glyph" aria-hidden="true" />
          {working} working
        </span>
      )}
      {done > 0 && (
        <span className="session-count session-count-done">
          <span className="session-count-glyph" aria-hidden="true">
            ✓
          </span>
          {done} done
        </span>
      )}
      {blocked > 0 && (
        <span className="session-count session-count-blocked">
          <span className="session-count-glyph" aria-hidden="true">
            △
          </span>
          {blocked} blocked
        </span>
      )}
      {failed > 0 && (
        <span className="session-count session-count-failed">
          <span className="session-count-glyph" aria-hidden="true">
            ✕
          </span>
          {failed} failed
        </span>
      )}
    </span>
  );
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

  const onBranch = summary.branch ? `On branch ${summary.branch}: ` : "";

  if (summary.state === "clean") {
    return `${onBranch}nothing new since the last commit.`;
  }

  return `${onBranch}${summary.insertions} lines written, ${summary.deletions} lines deleted.`;
}

// One branch-picker row's right-hand state. Real dirty numbers exist only
// where the branch is checked out (its own or a linked worktree's folder);
// anywhere else the most truthful branch-level state is upstream drift.
function branchStateNode(branch: BranchOverviewEntry) {
  const worktree = branch.worktree;
  if (worktree?.state === "dirty") {
    return (
      <>
        <span className="diff-insertions">+{worktree.insertions}</span>
        <span className="diff-deletions">-{worktree.deletions}</span>
      </>
    );
  }

  if (worktree?.state === "clean") {
    return <span className="diff-muted">clean</span>;
  }

  if (branch.ahead > 0 || branch.behind > 0) {
    const parts: string[] = [];
    if (branch.ahead > 0) {
      parts.push(`${branch.ahead} ahead`);
    }
    if (branch.behind > 0) {
      parts.push(`${branch.behind} behind`);
    }
    return <span className="diff-muted">{parts.join(" · ")}</span>;
  }

  return <span className="diff-muted">not checked out</span>;
}

function getProfile(kind: AgentKind) {
  return agentProfiles.find((profile) => profile.kind === kind) ?? agentProfiles[0];
}

// A Fusion pane's conversation belongs to its PLANNER: claude session ids for
// a claude planner, codex thread ids for a codex planner. Either provider is
// a resumable Fusion thread ref (family match is enforced at launch time).
function hasClaudeThreadId(threadRef?: AgentThreadRef): threadRef is AgentThreadRef {
  return (
    (threadRef?.provider === "claude" || threadRef?.provider === "codex") &&
    Boolean(threadRef.id)
  );
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

// Per-role Fusion settings normalization lives in the shared menu module
// (normalizeFusionRoleSettings) so App, the pane, and the settings smoke all
// migrate legacy fields identically. This helper maps a session's stored
// fields through it and clears the legacy fields.
function normalizedFusionSessionFields(session: AgentSession) {
  const role = normalizeFusionRoleSettings({
    plannerFamily: session.fusionPlannerFamily,
    plannerModel: session.fusionPlannerModel,
    plannerEffort: session.fusionPlannerEffort,
    plannerFast: session.fusionPlannerFast,
    executorFamily: session.fusionExecutorFamily,
    executorModel: session.fusionExecutorModel,
    executorEffort: session.fusionExecutorEffort,
    executorFast: session.fusionExecutorFast,
    model: session.fusionModel,
    claudeEffort: session.fusionClaudeEffort ?? session.fusionEffort,
    codexModel: session.fusionCodexModel,
    codexEffort: session.fusionCodexEffort ?? session.fusionEffort
  });
  return {
    fusionPlannerFamily: role.plannerFamily,
    fusionPlannerModel: role.plannerModel,
    fusionPlannerEffort: role.plannerEffort,
    fusionPlannerFast: role.plannerFast,
    fusionExecutorFamily: role.executorFamily,
    fusionExecutorModel: role.executorModel,
    fusionExecutorEffort: role.executorEffort,
    fusionExecutorFast: role.executorFast,
    fusionModel: undefined,
    fusionCodexModel: undefined,
    fusionClaudeEffort: undefined,
    fusionCodexEffort: undefined,
    fusionEffort: undefined
  };
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
  // Only anchors occupy board space. A grouped non-anchor still carries the
  // layout it had before it joined a tile (kept so popping it out has a box to
  // restore), and counting that dead data would reserve space nothing renders.
  const existingLayouts = sessions
    .filter(isTileAnchor)
    .map((session) => migrateLayout(session.layout));
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
  name?: string,
  options?: { providerProfileId?: string; providerModelOverride?: string }
): AgentSession {
  const profile = getProfile(kind);
  // "fusion" is a selection-only kind: persist a real claude session flagged
  // `fusion` so every existing claude path (telemetry, resume, working-state,
  // thread discovery) applies unchanged; only the launch gets Fusion wiring.
  const isFusion = profile.fusion === true;
  // "openfusion" follows the same pattern but persists as OpenCode.
  const isOpenFusion = profile.openFusion === true;
  // "claude-custom" too: a real claude session pinned to a provider profile.
  const isClaudeCustom = profile.claudeCustom === true;
  const effectiveKind: AgentKind = isFusion
    ? "claude"
    : isOpenFusion
      ? "opencode"
      : isClaudeCustom
        ? "claude"
        : kind;
  const sessionName = name ?? `${profile.label} ${existingSessions.length + 1}`;
  // New panes inherit the last-used model configuration for their mode (the
  // normalizers fall back to the stock defaults when nothing is stored yet).
  const fusionSeed = isFusion ? lastFusionSettings() : null;
  const openFusionSeed = isOpenFusion ? lastOpenFusionModels() : null;

  return {
    id: createId("session"),
    name: sessionName,
    kind: effectiveKind,
    fusion: isFusion || undefined,
    fusionPlannerFamily: fusionSeed?.plannerFamily,
    fusionPlannerModel: fusionSeed?.plannerModel,
    fusionPlannerEffort: fusionSeed?.plannerEffort,
    fusionPlannerFast: fusionSeed?.plannerFast,
    fusionExecutorFamily: fusionSeed?.executorFamily,
    fusionExecutorModel: fusionSeed?.executorModel,
    fusionExecutorEffort: fusionSeed?.executorEffort,
    fusionExecutorFast: fusionSeed?.executorFast,
    fusionRunMode: isFusion ? DEFAULT_FUSION_RUN_MODE : undefined,
    fusionModel: undefined,
    fusionCodexModel: undefined,
    fusionClaudeEffort: undefined,
    fusionCodexEffort: undefined,
    fusionEffort: undefined,
    openFusion: isOpenFusion || undefined,
    openFusionPlannerModel: openFusionSeed?.plannerModel,
    openFusionExecutorModel: openFusionSeed?.executorModel,
    openFusionRunMode: isOpenFusion ? DEFAULT_FUSION_RUN_MODE : undefined,
    providerProfileId: isClaudeCustom
      ? options?.providerProfileId || "default-custom"
      : undefined,
    providerModelOverride: isClaudeCustom
      ? options?.providerModelOverride || undefined
      : undefined,
    command: profile.command,
    cwd,
    createdAt: Date.now(),
    threadRef: isFusion ? undefined : createThreadRef(effectiveKind),
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
  // Threaded agent kinds set status "done"/"failed" from per-turn telemetry
  // while their process is still alive, so a finished TURN must not read as a
  // finished PROCESS: they always restore as a fresh launch (the old chat is
  // stashed in resumeRef either way). Only non-threaded panes treat done/failed
  // as "the process exited; stay paused".
  const shouldAutoStart =
    session.started === true &&
    (isFusion ||
      isThreadedAgentKind(restoredKind) ||
      (previousStatus !== "done" && previousStatus !== "failed"));

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
  // Stored refs from older builds carry the pane's placeholder label as their
  // title; strip it so the harvested (generated) title can replace it.
  const resumeRef = sanitizeThreadRefTitle(
    activeThreadRef?.id ? activeThreadRef : storedResumeRef
  );

  // Attention describes a moment inside the OLD process, which restore always
  // replaces with a fresh terminal (see the launch note above). A stale
  // "waiting" is the damaging one: it claims an approval/question prompt is on
  // screen for a pane that has not even started, so every project that ever
  // parked a pane at its idle prompt reads as "blocked" on the next launch.
  // Panes that stay paused on a finished process keep their completed/failed
  // state, which still matches the status restored beside it — but never its
  // `unread` dot: that badge means "you have not seen this yet", and across a
  // relaunch every stored result is old news.
  const restoredAttention = normalizeAttention(session.attention);
  const attention =
    shouldAutoStart || restoredAttention.state === "waiting"
      ? EMPTY_ATTENTION
      : restoredAttention.unread
        ? { ...restoredAttention, unread: false }
        : restoredAttention;

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
    threadRef: isFusion ? undefined : createThreadRef(restoredKind),
    resumeRef,
    ...(isFusion ? normalizedFusionSessionFields(session) : {}),
    fusionRunMode: isFusion
      ? normalizeFusionRunMode(session.fusionRunMode)
      : session.fusionRunMode,
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
    openFusionRunMode: isOpenFusion
      ? normalizeFusionRunMode(session.openFusionRunMode)
      : session.openFusionRunMode,
    threadLookupStartedAt: undefined,
    threadLookupStatus: "idle",
    threadLookupMessage: undefined,
    status: shouldAutoStart ? "idle" : previousStatus,
    attention,
    backgroundActivity: undefined,
    detachedTaskIds: undefined,
    subagentDepth: undefined,
    // Shape validation only — a single session cannot know whether its siblings
    // exist, so membership is repaired by reconcileTiles once the sessions are
    // a set (see restoreStoredWorkspace / loadMultiSessions).
    tileId: typeof session.tileId === "string" ? session.tileId : undefined,
    splitTree: normalizeSplitNode(session.splitTree),
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
    ? reconcileTiles(
        value.sessions
          .map(restoreStoredSession)
          .filter((session): session is AgentSession => Boolean(session))
      )
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
      ? reconcileTiles(
          parsed
            .map(restoreStoredSession)
            .filter((session): session is AgentSession => Boolean(session))
        )
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
  const storedWidth = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
  const savedWidth = storedWidth === null ? NaN : Number(storedWidth);

  if (Number.isFinite(savedWidth) && savedWidth > 0) {
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
    if (
      screenshotFixture?.mode === "openfusion" ||
      screenshotFixture?.mode === "fusion-picker" ||
      screenshotFixture?.mode === "fusion-builds"
    ) {
      const workspace = starterWorkspace(screenshotFixture.cwd);
      const kind = screenshotFixture.mode === "openfusion" ? "openfusion" : "fusion";
      const session = createSession(
        kind,
        screenshotFixture.cwd,
        [],
        screenshotFixture.mode === "openfusion"
          ? "Open Fusion"
          : screenshotFixture.mode === "fusion-builds"
            ? "Fusion Build Rows"
            : "Fusion Picker"
      );
      const screenshotSession: AgentSession = {
        ...session,
        id: screenshotFixture.mode === "fusion-builds" ? "screenshot-fusion-builds" : session.id,
        command:
          screenshotFixture.mode === "openfusion"
            ? screenshotFixture.openCodeCommand?.trim() || session.command
            : session.command,
        started:
          screenshotFixture.mode === "openfusion"
            ? session.started
            : false,
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

    // Visual QA for split tiles and the sidebar card counts: a 3-terminal tile
    // (two side by side over one full-width) next to an ordinary solo pane.
    if (screenshotFixture?.mode === "split") {
      const workspace = starterWorkspace(screenshotFixture.cwd);
      const cwd = screenshotFixture.cwd;
      const anchor = createSession("terminal", cwd, [], "Split A");
      const right = createSession("terminal", cwd, [anchor], "Split B");
      const below = createSession("terminal", cwd, [anchor, right], "Split C");
      const solo = createSession("terminal", cwd, [anchor, right, below], "Solo");
      const tileLayout: LayoutBox = {
        x: 0,
        y: LEGACY_BOARD_PADDING,
        w: 64,
        h: 620,
        unit: "fluid"
      };
      const splitTree: SplitNode = {
        dir: "col",
        ratio: 0.55,
        a: { dir: "row", ratio: 0.5, a: { id: anchor.id }, b: { id: right.id } },
        b: { id: below.id }
      };

      return {
        workspaces: [
          {
            ...workspace,
            sessions: [
              {
                ...anchor,
                started: false,
                tileId: anchor.id,
                splitTree,
                layout: tileLayout
              },
              { ...right, started: false, tileId: anchor.id },
              { ...below, started: false, tileId: anchor.id },
              {
                ...solo,
                started: false,
                status: "running" as const,
                layout: {
                  x: 66,
                  y: LEGACY_BOARD_PADDING,
                  w: 34,
                  h: 620,
                  unit: "fluid" as const
                }
              }
            ]
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
  // Settings dialog (File → Settings… / topbar gear). The hint is shown when
  // the dialog was opened as a detour, e.g. "Open Claude Code" with no
  // provider configured yet.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsHint, setSettingsHint] = useState<string | null>(null);
  // The toolbar launcher dropdown: one trigger opens a searchable list of
  // every agent profile plus the saved Claude providers and, per provider,
  // the model list its API key exposes (null while/after a failed fetch —
  // the provider header item still launches with the profile model).
  const [launcherMenuOpen, setLauncherMenuOpen] = useState(false);
  const [launcherQuery, setLauncherQuery] = useState("");
  const [launcherHighlight, setLauncherHighlight] = useState(0);
  const launcherSearchRef = useRef<HTMLInputElement | null>(null);
  const [providerList, setProviderList] = useState<ClaudeProviderProfile[] | null>(
    null
  );
  const [providerModels, setProviderModels] = useState<
    Record<string, { id: string; label: string }[] | null>
  >({});
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
  const codexRunningWatchdogsRef = useRef<Map<string, number>>(new Map());
  const codexWatchdogSettledRef = useRef<Set<string>>(new Set());
  const codexLastInputAtRef = useRef<Map<string, number>>(new Map());
  const codexActiveTurnIdsRef = useRef<Map<string, string>>(new Map());
  const codexSubmitPendingRef = useRef<Map<string, string | null>>(new Map());
  const codexSettledTurnIdsRef = useRef<Map<string, string[]>>(new Map());
  // Synchronous event-order latch for provider hooks. React state and the
  // sessions snapshot ref update after commit, while independent hook POSTs
  // can race one another in the same tick.
  const codexTurnLiveRef = useRef<Map<string, boolean>>(new Map());
  const sessionsByIdRef = useRef<Map<string, AgentSession>>(new Map());
  const pendingCodexAttentionRef = useRef<
    Map<string, PendingCodexAttention[]>
  >(new Map());
  const fusionBridgeToolRef = useRef<Map<string, boolean>>(new Map());
  const [shellMessage, setShellMessage] = useState<string | null>(null);
  // null = the PATH scan has not answered yet, so nothing is dimmed. Only a
  // definite "not found" dims a launcher — never the pending state, which would
  // flash every button grey for a frame on a slow probe.
  const [installedClis, setInstalledClis] = useState<InstalledCliReport | null>(
    null
  );
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [versionPickerOpen, setVersionPickerOpen] = useState(false);
  // null = not fetched yet (the menu shows a loading note).
  const [versionList, setVersionList] = useState<AppVersionList | null>(null);
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
  const [workspaceContextMenu, setWorkspaceContextMenu] =
    useState<WorkspaceContextMenuState | null>(null);
  const [branchPicker, setBranchPicker] = useState<{
    open: boolean;
    loading: boolean;
    overview?: BranchOverview;
  }>({ open: false, loading: false });

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
  const activeScreenshotFixture = window.vibe?.app.screenshotFixture;
  const screenshotFusionPicker =
    activeScreenshotFixture?.mode === "fusion-picker"
      ? {
          role: activeScreenshotFixture.role,
          family: activeScreenshotFixture.family
        }
      : undefined;
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
  useLayoutEffect(() => {
    sessionsByIdRef.current = new Map(
      allSessions.map((session) => [session.id, session])
    );
  }, [multiSessions, workspaces]);
  const cwdConflicts = useMemo(
    () =>
      computeCwdConflicts([
        ...multiSessions.map((session) => ({
          session,
          scopeLabel: "Multi"
        })),
        ...workspaces.flatMap((workspace) =>
          workspace.sessions.map((session) => ({
            session,
            scopeLabel: workspace.name
          }))
        )
      ]),
    [multiSessions, workspaces]
  );
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
        (fixture?.mode !== "openfusion" &&
          fixture?.mode !== "fusion-picker" &&
          fixture?.mode !== "fusion-builds") ||
        boardSessions.length > 0 ||
        multiSessions.length > 0
      ) {
        return;
      }

      const workspace =
        activeWorkspace?.sessions.length === 0
          ? { ...activeWorkspace, path: fixture.cwd, name: folderName(fixture.cwd) }
          : starterWorkspace(fixture.cwd);
      const kind = fixture.mode === "openfusion" ? "openfusion" : "fusion";
      const session = createSession(
        kind,
        fixture.cwd,
        [],
        fixture.mode === "openfusion"
          ? "Open Fusion CLI"
          : fixture.mode === "fusion-builds"
            ? "Fusion Build Rows"
            : "Fusion Picker"
      );
      const screenshotSession: AgentSession = {
        ...session,
        id: fixture.mode === "fusion-builds" ? "screenshot-fusion-builds" : session.id,
        started: fixture.mode === "openfusion" ? session.started : false,
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
    let cancelled = false;
    window.vibe?.app?.getInstalledClis?.().then(
      (report) => {
        if (!cancelled) setInstalledClis(report);
      },
      () => {
        // A failed probe leaves every launcher enabled, which is the safe
        // default: presence is a hint, not a gate.
      }
    );

    return () => {
      cancelled = true;
    };
  }, []);

  // A launcher is dimmed only when the probe positively reports its CLI
  // missing. Kinds with no PATH command of their own (Terminal, the vendored
  // Kimi + CC) are absent from the report and stay normal. Fusion and Open
  // Fusion are not probed either: they launch claude/opencode sessions, so
  // their entries follow those two.
  const agentCliMissing = useCallback(
    (kind: AgentKind) => {
      if (!installedClis) return false;
      const probeKind =
        kind === "fusion" || kind === "claude-custom"
          ? "claude"
          : kind === "openfusion"
            ? "opencode"
            : kind;
      const entry = installedClis.clis?.[probeKind];
      return Boolean(entry) && !entry.available;
    },
    [installedClis]
  );

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
    if (!workspaceContextMenu) {
      return;
    }

    if (
      !workspaces.some(
        (workspace) => workspace.id === workspaceContextMenu.workspaceId
      )
    ) {
      setWorkspaceContextMenu(null);
    }
  }, [workspaceContextMenu, workspaces]);

  useEffect(() => {
    if (!workspaceContextMenu) {
      return;
    }

    const closeMenu = () => setWorkspaceContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(".workspace-context-menu")
      ) {
        return;
      }

      closeMenu();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [workspaceContextMenu]);

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
        applyAgentAttention(
          event.id,
          event.attention,
          event.provider,
          event.providerThreadId,
          event.providerTurnId
        );
      }

      if (event.type === "agent-running") {
        applyAgentRunning(
          event.id,
          event.turnStart !== false,
          event.provider,
          event.providerThreadId,
          event.providerTurnId
        );
      }

      if (event.type === "agent-subagent") {
        applyAgentSubagent(event.id, event.phase, event.provider);
        return;
      }

      if (event.type === "agent-background-activity") {
        applyAgentBackgroundActivity(event.id, event.backgroundActivity);
        return;
      }

      if ("id" in event && typeof event.id === "string") {
        if (event.type === "data") {
          refreshCodexRunningWatchdog(event.id);
        }

        // Raw output does not directly drive the pill here. It refreshes only
        // an already-started Codex turn's App-owned safety watchdog; telemetry
        // drives other agents, and mounted plain terminals retain their
        // input-aware heuristic. snapshot/exit/error still settle centrally.
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
    return () => {
      for (const timeoutId of codexRunningWatchdogsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      codexRunningWatchdogsRef.current.clear();
      codexWatchdogSettledRef.current.clear();
      codexLastInputAtRef.current.clear();
      codexActiveTurnIdsRef.current.clear();
      codexSubmitPendingRef.current.clear();
      codexSettledTurnIdsRef.current.clear();
      codexTurnLiveRef.current.clear();
      pendingCodexAttentionRef.current.clear();
    };
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
    return window.vibe?.openFusionChat?.onEvent((event: OpenFusionChatEvent) => {
      if (event.type === "host-error") {
        setShellMessage(event.message);
        return;
      }

      applyOpenFusionChatLifecycle(event);
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

  // Native application menu actions (File/Edit/View). The ref indirection keeps
  // the single subscription while always running the latest addSession/scope
  // closures.
  const menuActionRef = useRef<(action: string) => void>(() => {});
  useEffect(() => {
    menuActionRef.current = (action: string) => {
      if (action === "open-settings") {
        setSettingsHint(null);
        setSettingsOpen(true);
      } else if (action === "toggle-sidebar") {
        setSidebarOpen((open) => !open);
      } else if (action === "new-terminal") {
        void addSession("terminal");
      } else if (action === "new-claude") {
        void addSession("claude");
      } else if (action === "open-claude-code") {
        void addSession("claude-custom");
      }
    };
  });
  useEffect(() => {
    if (!window.vibe?.menu?.onEvent) {
      return;
    }
    const unsubscribe = window.vibe.menu.onEvent((event) => {
      if (event?.type === "action" && typeof event.action === "string") {
        menuActionRef.current(event.action);
      }
    });
    return unsubscribe;
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

  // The picker shows one workspace's branches; it can't survive a workspace
  // switch without showing stale rows.
  useEffect(() => {
    setBranchPicker({ open: false, loading: false });
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!branchPicker.open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setBranchPicker((current) => ({ ...current, open: false }));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [branchPicker.open]);

  async function toggleBranchPicker() {
    if (branchPicker.open) {
      setBranchPicker((current) => ({ ...current, open: false }));
      return;
    }
    if (!activeWorkspace || !window.vibe?.workspace.getBranches) {
      return;
    }
    setBranchPicker({ open: true, loading: true });
    try {
      const overview = await window.vibe.workspace.getBranches(
        activeWorkspace.path
      );
      setBranchPicker((current) =>
        current.open ? { open: true, loading: false, overview } : current
      );
    } catch {
      setBranchPicker((current) =>
        current.open ? { open: true, loading: false } : current
      );
    }
  }

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

    if (status === "done" || status === "failed") {
      clearCodexRunningWatchdog(sessionId);
    }

    updateAnySession(sessionId, (session) => {
      // claude/opencode "working" is telemetry-driven, so never let raw terminal
      // output (a snapshot replay on reconnect, a focus/click redraw) flip them
      // to "running" — that is the typing/selecting false positive we are fixing.
      if (status === "running" && isTurnTelemetryKind(session.kind)) {
        return session;
      }

      // A dead agent has no live children by definition, so a real process
      // exit/error always releases the delegation bracket.
      const settled = status === "done" || status === "failed";
      const nextStatus = reconcileStatus(session.status, status);
      if (nextStatus === session.status) {
        return settled ? clearSubagentDepth(session) : session;
      }

      const next = { ...session, status: nextStatus };
      return settled ? clearSubagentDepth(next) : next;
    });
  }

  // A genuine turn START (provider telemetry, or the renderer-owned Codex
  // submit fallback) forces the pane to "running" even
  // past done/failed stickiness and drops stale unread attention. Mid-turn tool activity (claude
  // PreToolUse/PostToolUse, turnStart false) goes through reconcileStatus
  // instead: the hook POSTs ride independent short-lived processes with no
  // ordering guarantee, so a tool event that lands after the turn's Stop must
  // not resurrect a finished pane's spinner (or clear its attention dot).
  function applyAgentRunning(
    sessionId: string,
    turnStart = true,
    provider?: string,
    providerThreadId?: string,
    providerTurnId?: string
  ) {
    if (provider === "codex") {
      const session = sessionsByIdRef.current.get(sessionId);
      if (!turnStart && codexTurnLiveRef.current.get(sessionId) === false) {
        return;
      }
      if (
        !turnStart &&
        session &&
        reconcileStatus(session.status, "running") !== "running"
      ) {
        return;
      }
      const decision = providerAttentionDecision(
        session,
        provider,
        providerThreadId
      );
      if (decision === "reject") {
        return;
      }
      if (turnStart) {
        codexTurnLiveRef.current.set(sessionId, true);
        codexSubmitPendingRef.current.delete(sessionId);
      }
      if (providerTurnId) {
        codexActiveTurnIdsRef.current.set(sessionId, providerTurnId);
      }
      armCodexRunningWatchdog(sessionId);
    }

    updateAnySession(sessionId, (session) => {
      if (!turnStart && reconcileStatus(session.status, "running") !== "running") {
        return session;
      }

      // A genuine turn start supersedes the previous turn outright, so no
      // delegation opened by that turn can still be in flight. This is the
      // primary expiry for the subagent bracket. Mid-turn tool activity must
      // NOT clear it — that would drop a live delegation on the parent's very
      // next tool call.
      const subagentDepth = turnStart ? undefined : session.subagentDepth;

      if (
        session.status === "running" &&
        !session.attention?.unread &&
        !session.backgroundActivity &&
        session.subagentDepth === subagentDepth
      ) {
        return session;
      }

      return {
        ...session,
        status: "running",
        backgroundActivity: undefined,
        subagentDepth,
        attention: {
          state: "none",
          unread: false,
          updatedAt: Date.now(),
          source: "provider"
        }
      };
    });
  }

  // A subagent delegation opened or closed. The OPEN half is the only signal
  // besides a genuine turn start that may push a pane past the done/failed
  // latch: it is emitted from a tool-call boundary the model itself created, so
  // unlike raw PTY output it can never be a keystroke echo, a focus/mouse
  // report, a TUI redraw or a replayed snapshot.
  function applyAgentSubagent(
    sessionId: string,
    phase: "start" | "stop",
    provider?: string
  ) {
    if (phase === "start") {
      if (provider === "codex") {
        // Codex's bracket is derived from CHILD tool hooks, which can
        // legitimately land after the root turn settled — so it stays
        // latch-respecting, exactly like codex tool activity already is.
        updateAnySession(sessionId, (session) =>
          reconcileStatus(session.status, "running") === "running"
            ? { ...session, status: "running" }
            : session
        );
      } else {
        applyAgentRunning(sessionId, true, provider);
      }
    }

    // Ordering is load-bearing: applyAgentRunning's turn-start branch clears
    // subagentDepth, so the increment has to land after it.
    updateAnySession(sessionId, (session) =>
      updateSubagentDepth(session, phase)
    );
  }

  function clearCodexRunningWatchdog(sessionId: string) {
    const timeoutId = codexRunningWatchdogsRef.current.get(sessionId);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      codexRunningWatchdogsRef.current.delete(sessionId);
    }
    codexWatchdogSettledRef.current.delete(sessionId);
  }

  function clearCodexTracking(sessionId: string) {
    clearCodexRunningWatchdog(sessionId);
    codexLastInputAtRef.current.delete(sessionId);
    pendingCodexAttentionRef.current.delete(sessionId);
    codexActiveTurnIdsRef.current.delete(sessionId);
    codexSubmitPendingRef.current.delete(sessionId);
    codexSettledTurnIdsRef.current.delete(sessionId);
    codexTurnLiveRef.current.delete(sessionId);
  }

  function armCodexRunningWatchdog(sessionId: string) {
    clearCodexRunningWatchdog(sessionId);
    const timeoutId = window.setTimeout(() => {
      if (codexRunningWatchdogsRef.current.get(sessionId) !== timeoutId) {
        return;
      }
      codexRunningWatchdogsRef.current.delete(sessionId);
      const session = sessionsByIdRef.current.get(sessionId);
      if (session?.kind !== "codex" || session.status !== "running") {
        return;
      }
      codexWatchdogSettledRef.current.add(sessionId);
      updateAnySession(sessionId, (session) =>
        session.kind === "codex" && session.status === "running"
          ? { ...session, status: "waiting" }
          : session
      );
    }, CODEX_RUNNING_QUIET_MS);
    codexRunningWatchdogsRef.current.set(sessionId, timeoutId);
  }

  function refreshCodexRunningWatchdog(sessionId: string) {
    const lastInputAt = codexLastInputAtRef.current.get(sessionId) ?? 0;
    if (Date.now() - lastInputAt < CODEX_INPUT_GRACE_MS) {
      return;
    }

    if (codexRunningWatchdogsRef.current.has(sessionId)) {
      armCodexRunningWatchdog(sessionId);
      return;
    }

    // A safety timeout is not authoritative turn completion. If real PTY work
    // resumes later, restore running and start a fresh quiet window even while
    // the pane is hidden.
    if (codexWatchdogSettledRef.current.has(sessionId)) {
      applyAgentRunning(sessionId, true);
      armCodexRunningWatchdog(sessionId);
    }
  }

  function applyCodexTurnStart(sessionId: string) {
    const session = sessionsByIdRef.current.get(sessionId);
    const approvalResume =
      session?.attention?.state === "waiting" &&
      session.attention.reason === "approval";
    if (!approvalResume) {
      pendingCodexAttentionRef.current.delete(sessionId);
      codexSubmitPendingRef.current.set(
        sessionId,
        codexActiveTurnIdsRef.current.get(sessionId) ?? null
      );
    }
    codexTurnLiveRef.current.set(sessionId, true);
    applyAgentRunning(sessionId, true);
    armCodexRunningWatchdog(sessionId);
  }

  function rememberSettledCodexTurn(sessionId: string, turnId: string) {
    const settled = codexSettledTurnIdsRef.current.get(sessionId) ?? [];
    codexSettledTurnIdsRef.current.set(
      sessionId,
      [...settled.filter((candidate) => candidate !== turnId), turnId].slice(-8)
    );
  }

  function recordCodexTerminalInput(sessionId: string) {
    codexLastInputAtRef.current.set(sessionId, Date.now());
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

  function applyAcceptedAgentAttention(
    sessionId: string,
    attentionEvent: AgentAttentionEvent
  ) {
    clearCodexRunningWatchdog(sessionId);
    const selection = attentionSelectionRef.current;
    const attentionStatus = statusFromAttentionState(attentionEvent.state);

    updateAnySession(sessionId, (session) => {
      const nextStatus = attentionStatus
        ? reconcileStatus(session.status, attentionStatus)
        : session.status;

      // An idle "your turn" prompt means the agent is blocked on the human,
      // which is incompatible with a delegation still running. This is what
      // closes the one bracket leak claude can produce: a DENIED Task fires
      // PreToolUse but never PostToolUse. An "approval" wait must NOT reset —
      // that is a child asking permission mid-delegation.
      const releasesDelegation =
        attentionEvent.state === "waiting" && attentionEvent.reason === "question";

      // A SETTLED turn owns its attention. claude fires its idle Notification
      // (idle_prompt -> waiting/question) about a minute after every turn ends,
      // and it lands on a pane whose status is already a latched done/failed.
      // reconcileStatus keeps the pill honest, but writing the attention anyway
      // did two visible kinds of damage: the sidebar counted the finished pane
      // as "blocked", and the unread flag re-raised an attention dot the user
      // had already dismissed — for a pane that had done nothing. Keep the
      // completion/failure that settled the turn instead.
      //
      // Scoped to "waiting" on purpose: a late completed/failed still writes
      // (it describes the same settled turn), and while the pane is running,
      // starting or idle the event applies normally — that is the ~60s liveness
      // backstop for a turn whose Stop hook never landed. Mid-turn approval
      // waits are unaffected: a permission prompt can only occur inside a turn,
      // whose UserPromptSubmit already released the latch.
      const settled = session.status === "done" || session.status === "failed";
      const keepSettledAttention = settled && attentionEvent.state === "waiting";

      return {
        ...session,
        status: nextStatus,
        // Still released even when the notification itself is dropped: the
        // bracket expiry is a fact about the delegation, not a notification.
        subagentDepth: releasesDelegation ? undefined : session.subagentDepth,
        attention: keepSettledAttention
          ? session.attention
          : attentionFromEvent(
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

  function applyAgentAttention(
    sessionId: string,
    attentionEvent: AgentAttentionEvent,
    provider?: string,
    providerThreadId?: string,
    providerTurnId?: string
  ) {
    const decision = providerAttentionDecision(
      sessionsByIdRef.current.get(sessionId),
      provider,
      providerThreadId
    );
    if (decision === "defer" && providerThreadId) {
      const pending = pendingCodexAttentionRef.current.get(sessionId) ?? [];
      pending.push({ providerThreadId, providerTurnId, attention: attentionEvent });
      // One launch can report several child completions before discovery.
      // Keep a small bounded tail and decide only after the root id is known.
      pendingCodexAttentionRef.current.set(sessionId, pending.slice(-8));
      return;
    }
    if (decision === "reject") {
      return;
    }

    if (provider === "codex") {
      const activeTurnId = codexActiveTurnIdsRef.current.get(sessionId);
      const submitPending = codexSubmitPendingRef.current.has(sessionId);
      if (
        codexTurnAttentionDecision(
          activeTurnId,
          submitPending,
          codexSubmitPendingRef.current.get(sessionId),
          codexSettledTurnIdsRef.current.get(sessionId) ?? [],
          providerTurnId,
          codexTurnLiveRef.current.get(sessionId)
        ) === "reject"
      ) {
        return;
      }
      codexSubmitPendingRef.current.delete(sessionId);
      if (providerTurnId) {
        codexActiveTurnIdsRef.current.set(sessionId, providerTurnId);
      }
      if (attentionEvent.state === "completed" || attentionEvent.state === "failed") {
        if (providerTurnId) {
          rememberSettledCodexTurn(sessionId, providerTurnId);
        }
        codexActiveTurnIdsRef.current.delete(sessionId);
        codexTurnLiveRef.current.set(sessionId, false);
      }
    }

    // A completion that lands while a subagent delegation is open cannot be
    // attributed to the pane's own turn (kimi/kimi-custom fire the
    // session-level Stop at a CHILD's turn end), so drop it rather than latch
    // a false "done". Placed after the codex gates above so codex's own turn
    // bookkeeping still runs for a completion codex itself accepted, and before
    // applyAcceptedAgentAttention so neither status nor attention is written.
    const current = sessionsByIdRef.current.get(sessionId);
    if (current && shouldSuppressAgentCompletion(current, attentionEvent)) {
      return;
    }

    applyAcceptedAgentAttention(sessionId, attentionEvent);
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

  function addSessionForCwd(
    scope: SessionScope,
    kind: AgentKind,
    cwd: string,
    options?: { providerProfileId?: string; providerModelOverride?: string }
  ) {
    updateScopeSessions(scope, (sessions) => [
      ...sessions,
      createSession(kind, cwd, sessions, undefined, options)
    ]);
  }

  function sessionCreationKind(session: AgentSession): AgentKind {
    return session.fusion
      ? "fusion"
      : session.openFusion
        ? "openfusion"
        : session.providerProfileId
          ? "claude-custom"
          : session.kind;
  }

  // Provider-pinned panes must keep their pin through split/duplicate/
  // add-matching — otherwise the copy silently launches against the user's own
  // Anthropic login instead of the source pane's custom endpoint.
  function providerOptionsFor(session: AgentSession) {
    return session.providerProfileId
      ? {
          providerProfileId: session.providerProfileId,
          providerModelOverride: session.providerModelOverride
        }
      : undefined;
  }

  // Split a pane in two inside its own tile. The new terminal is created the
  // same way "Add matching pane" creates one; the only difference is that it
  // joins the source's tile instead of taking a board box of its own.
  function splitSession(
    scope: SessionScope,
    session: AgentSession,
    dir: "row" | "col"
  ) {
    let createdId: string | null = null;

    updateScopeSessions(scope, (sessions) => {
      const created = createSession(
        sessionCreationKind(session),
        session.cwd,
        sessions,
        undefined,
        providerOptionsFor(session)
      );
      createdId = created.id;

      const tileId = effectiveTileId(session);
      const anchor = sessions.find((candidate) => candidate.id === tileId);
      const tree = anchor?.splitTree ?? { id: session.id };
      const nextTree = splitLeaf(tree, session.id, dir, created.id);
      // A solo pane becomes the anchor of the tile it just created.
      const anchorId = anchor?.splitTree ? tileId : session.id;

      return [
        ...sessions.map((candidate) => {
          if (candidate.id === anchorId) {
            return { ...candidate, tileId: anchorId, splitTree: nextTree };
          }
          return leafIds(nextTree).includes(candidate.id)
            ? { ...candidate, tileId: anchorId, splitTree: undefined }
            : candidate;
        }),
        { ...created, tileId: anchorId, splitTree: undefined }
      ];
    });

    if (createdId) {
      setSelectedSessionId(createdId);
    }
  }

  // Give a grouped pane its own board tile again. It needs a fresh box: its
  // stored layout is the one it had before joining, which for the anchor is the
  // tile's own box and would land exactly on top of it.
  function popOutSession(scope: SessionScope, session: AgentSession) {
    updateScopeSessions(scope, (sessions) => {
      const detached = detachSessionFromTile(sessions, session.id);
      const others = detached.filter(
        (candidate) => candidate.id !== session.id
      );
      return detached.map((candidate) =>
        candidate.id === session.id
          ? { ...candidate, layout: findNextFluidLayout(others) }
          : candidate
      );
    });
  }

  function setTileRatio(
    scope: SessionScope,
    tileId: string,
    path: SplitPath,
    ratio: number
  ) {
    updateScopeSessions(scope, (sessions) => {
      let changed = false;
      const next = sessions.map((session) => {
        if (session.id !== tileId || !session.splitTree) {
          return session;
        }
        const splitTree = setRatioAtPath(session.splitTree, path, ratio);
        if (splitTree === session.splitTree) {
          return session;
        }
        changed = true;
        return { ...session, splitTree };
      });

      return changed ? next : sessions;
    });
  }

  async function addSession(
    kind: AgentKind,
    options?: { providerProfileId?: string; providerModelOverride?: string }
  ) {
    if (!activeScope) {
      return;
    }

    // "Open Claude Code" needs a provider profile (endpoint + key) to launch
    // against; without one, route the click into Settings instead of spawning
    // a pane that would fail closed.
    if (kind === "claude-custom") {
      let profileCount = 0;
      try {
        const list = await window.vibe?.claudeProviders?.list?.();
        profileCount = list?.profiles?.length ?? 0;
      } catch {
        // A broken store/IPC must still surface: open Settings rather than
        // swallowing the click.
        profileCount = 0;
      }
      if (profileCount === 0) {
        setSettingsHint(
          "Add a Claude provider below, then launch Open Claude Code."
        );
        setSettingsOpen(true);
        return;
      }
    }

    if (activeScope.type === "multi") {
      const cwd = await window.vibe?.workspace.selectFolder();
      if (cwd) {
        addSessionForCwd(activeScope, kind, cwd, options);
      }
      return;
    }

    if (activeWorkspace) {
      addSessionForCwd(activeScope, kind, activeWorkspace.path, options);
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
        ...createSession(
          sessionCreationKind(session),
          session.cwd,
          sessions,
          undefined,
          providerOptionsFor(session)
        ),
        name: `${session.name} copy`,
        command: session.command,
        // The copy keeps the source's Fusion family/model/effort/mode settings
        // instead of silently reverting to defaults.
        ...(session.fusion
          ? {
              ...normalizedFusionSessionFields(session),
              fusionRunMode: normalizeFusionRunMode(session.fusionRunMode)
            }
          : {}),
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
        openFusionRunMode: session.openFusion
          ? normalizeFusionRunMode(session.openFusionRunMode)
          : undefined,
        resumeRef: sourceThread
      }
    ]);
  }

  function stopSessionProcess(session: AgentSession): Promise<boolean> {
    if (session.fusion) {
      return window.vibe?.fusionChat?.stop(session.id) ?? Promise.resolve(false);
    }

    if (session.openFusion) {
      return window.vibe?.openFusionChat?.stop(session.id) ?? Promise.resolve(false);
    }

    return window.vibe?.terminal.kill(session.id) ?? Promise.resolve(false);
  }

  function closeSession(scope: SessionScope, session: AgentSession) {
    clearCodexTracking(session.id);
    void stopSessionProcess(session);
    const sessionId = session.id;
    updateScopeSessions(scope, (sessions) =>
      // Detach first so the tile collapses into its surviving sibling (and
      // re-anchors, keeping the tile's board box) before the session is gone.
      detachSessionFromTile(sessions, sessionId).filter(
        (candidate) => candidate.id !== sessionId
      )
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
      clearCodexTracking(session.id);
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
    clearCodexTracking(session.id);
    stopSessionProcess(session).then(() => {
      updateScopeSessions(scope, (sessions) =>
        sessions.map((item) => {
          if (item.id !== session.id) {
            return item;
          }

          const currentChatRef = item.fusion
            ? hasClaudeThreadId(item.threadRef)
              ? item.threadRef
              : undefined
            : activeSessionThreadRef(item);
          const previousChatRef = sessionResumeRef(item);
          // Chat panes (Fusion, Open Fusion) restart FRESH; their old thread is
          // stashed as resumeRef so Resume stays a deliberate action.
          const isChatPane = Boolean(item.fusion || item.openFusion);
          const canResume = !isChatPane && canResumeSessionThread(item);
          return {
            ...item,
            ...(isChatPane
              ? {
                  threadRef: undefined,
                  resumeRef: currentChatRef ?? previousChatRef
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
            backgroundActivity: undefined,
            detachedTaskIds: undefined,
            subagentDepth: undefined
          };
        })
      );
    });
  }

  function applyFusionChatLifecycle(event: FusionChatEvent) {
    if (!("id" in event) || typeof event.id !== "string") {
      return;
    }

    // Detached task history is the exception to replay neutrality: replayed
    // starts without a matching settle rehydrate real work still owned by the
    // live host. The id reducer is idempotent and touches no status/attention.
    if (event.type === "background-task") {
      updateAnySession(event.id, (session) =>
        session.fusion ? updateDetachedTaskIds(session, event) : session
      );
      return;
    }

    // Reattach replay (pane remount onto a live host session) is a transcript
    // restore for the pane, not fresh activity. This mirror tracked the live
    // events while the pane was unmounted, so it already holds the settled
    // status/attention — reprocessing the replay would re-latch "done" and
    // re-mark the attention dot the user already acknowledged.
    if (event.replay) {
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
        /codex_investigate|codex_implement|codex_respond|codex_steer_resolve/.test(event.name)
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
            // This result only ends the foreground launcher turn. Keep the
            // spinner unopposed; the wake-report turn owns the real done dot.
            shouldMarkCompletedTurnUnread(
              session,
              shouldMarkFusionAttentionUnread(event.id, attentionEvent)
            )
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

        // Any in-flight state is stranded by a dead host: "waiting" especially
        // (a pending needs_decision can never be answered), so it must fail
        // too, not sit waiting on a process that is gone. done/idle stay put —
        // that is a normal shutdown.
        const inFlight =
          session.status === "running" ||
          session.status === "waiting" ||
          session.status === "starting" ||
          Boolean(session.detachedTaskIds?.length);
        if (!inFlight) {
          return session.backgroundActivity || session.detachedTaskIds
            ? {
                ...session,
                backgroundActivity: undefined,
                detachedTaskIds: undefined
              }
            : session;
        }

        const message =
          event.code != null && event.code !== 0
            ? `Fusion process exited with code ${event.code}.`
            : session.status === "waiting"
              ? "Fusion process closed while a decision was still pending."
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
          detachedTaskIds: undefined,
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

  function applyOpenFusionAttention(
    sessionId: string,
    attentionEvent: AgentAttentionEvent
  ) {
    const attentionStatus = statusFromAttentionState(attentionEvent.state);
    updateAnySession(sessionId, (session) => {
      if (!session.openFusion) {
        return session;
      }

      return {
        ...session,
        status: attentionStatus
          ? reconcileStatus(session.status, attentionStatus)
          : session.status,
        attention: attentionFromEvent(
          attentionEvent,
          shouldMarkFusionAttentionUnread(sessionId, attentionEvent)
        )
      };
    });
  }

  // App-level mirror of the Open Fusion pane's lifecycle so the sidebar status
  // pill and attention dot stay correct even while the pane is unmounted
  // (project switched away). Same contract as applyFusionChatLifecycle.
  function applyOpenFusionChatLifecycle(event: OpenFusionChatEvent) {
    if (!("id" in event) || typeof event.id !== "string") {
      return;
    }

    // Process replayed starts/settles before the neutrality guard for the same
    // live-host rehydration contract as Fusion. Progress remains state-neutral.
    if (event.type === "background-task") {
      updateAnySession(event.id, (session) =>
        session.openFusion ? updateDetachedTaskIds(session, event) : session
      );
      return;
    }

    // Same replay contract as applyFusionChatLifecycle: a reattach replay
    // carries no new status/attention information — skip it.
    if (event.replay) {
      return;
    }

    if (event.type === "turn-start") {
      updateAnySession(event.id, (session) =>
        session.openFusion
          ? { ...session, status: "running", attention: EMPTY_ATTENTION }
          : session
      );
      return;
    }

    if (event.type === "permission") {
      applyOpenFusionAttention(event.id, {
        state: "waiting",
        reason: "approval",
        source: "provider",
        updatedAt: Date.now(),
        message: `Permission requested: ${event.permission}`
      });
      return;
    }

    if (event.type === "permission-resolved") {
      updateAnySession(event.id, (session) =>
        session.openFusion && session.status === "waiting"
          ? { ...session, status: "running", attention: EMPTY_ATTENTION }
          : session
      );
      return;
    }

    if (event.type === "result") {
      if (event.subtype === "restored") {
        return;
      }
      updateAnySession(event.id, (session) => {
        if (!session.openFusion) {
          return session;
        }

        if (session.status === "waiting") {
          return session;
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
          attention: attentionFromEvent(
            attentionEvent,
            // The detached task still owns sidebar working state. Its later
            // wake-report turn will produce the completed attention signal.
            shouldMarkCompletedTurnUnread(
              session,
              shouldMarkFusionAttentionUnread(event.id, attentionEvent)
            )
          )
        };
      });
      return;
    }

    if (event.type === "interrupted") {
      updateAnySession(event.id, (session) =>
        session.openFusion ? { ...session, status: "waiting" } : session
      );
      return;
    }

    if (event.type === "error") {
      applyOpenFusionAttention(event.id, {
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
        if (!session.openFusion) {
          return session;
        }

        // A dead engine strands any in-flight state — "waiting" especially (a
        // pending permission can never be answered) — so it must fail rather
        // than sit waiting. done/idle stay put: that is a normal shutdown.
        const inFlight =
          session.status === "running" ||
          session.status === "waiting" ||
          session.status === "starting" ||
          Boolean(session.detachedTaskIds?.length);
        if (!inFlight) {
          return session.detachedTaskIds
            ? { ...session, detachedTaskIds: undefined }
            : session;
        }

        const message =
          event.code != null && event.code !== 0
            ? `Open Fusion engine exited with code ${event.code}.`
            : session.status === "waiting"
              ? "Open Fusion engine closed while a request was still pending."
              : "Open Fusion engine closed before returning a result.";
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
          detachedTaskIds: undefined,
          attention: attentionFromEvent(
            attentionEvent,
            shouldMarkFusionAttentionUnread(event.id, attentionEvent)
          )
        };
      });
    }
  }

  // Deliberately resume a previous conversation. Mirrors restartSession but
  // forces nextLaunchMode "resume" against the stashed resumeRef — or, when the
  // Open Fusion resume picker hands over a specific saved chat, against that
  // targetRef. The outgoing active thread becomes the next resumeRef so
  // switching back does not discard the current conversation pointer.
  function resumeSession(
    scope: SessionScope,
    session: AgentSession,
    targetRef?: AgentThreadRef
  ) {
    const resumeRef = targetRef?.id ? targetRef : sessionResumeRef(session);
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

    clearCodexTracking(session.id);
    stopSessionProcess(session).then(() => {
      updateScopeSessions(scope, (sessions) =>
        sessions.map((item) => {
          if (item.id !== session.id) {
            return item;
          }

          const latestResumeRef = targetRef?.id
            ? targetRef
            : sessionResumeRef(item);
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
            backgroundActivity: undefined,
            detachedTaskIds: undefined,
            subagentDepth: undefined
          };
        })
      );
    });
  }

  function clearFusionSession(scope: SessionScope, session: AgentSession) {
    if (!session.fusion && !session.openFusion) {
      return;
    }

    stopSessionProcess(session).then(() => {
      updateScopeSessions(scope, (sessions) =>
        sessions.map((item) => {
          if (item.id !== session.id) {
            return item;
          }

          const currentChatRef = item.fusion
            ? hasClaudeThreadId(item.threadRef)
              ? item.threadRef
              : undefined
            : activeSessionThreadRef(item);
          const previousChatRef = sessionResumeRef(item);

          return {
            ...item,
            started: true,
            launchToken: item.launchToken + 1,
            nextLaunchMode: "new",
            threadRef: undefined,
            resumeRef: currentChatRef ?? previousChatRef,
            threadLookupStartedAt: undefined,
            threadLookupStatus: "idle",
            threadLookupMessage: undefined,
            status: "idle",
            attention: EMPTY_ATTENTION,
            backgroundActivity: undefined,
            detachedTaskIds: undefined,
            subagentDepth: undefined
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

    const next = normalizeFusionRoleSettings(settings);
    const nextFusionRunMode = normalizeFusionRunMode(settings.mode);
    const current = normalizeFusionRoleSettings({
      plannerFamily: session.fusionPlannerFamily,
      plannerModel: session.fusionPlannerModel,
      plannerEffort: session.fusionPlannerEffort,
      plannerFast: session.fusionPlannerFast,
      executorFamily: session.fusionExecutorFamily,
      executorModel: session.fusionExecutorModel,
      executorEffort: session.fusionExecutorEffort,
      executorFast: session.fusionExecutorFast,
      model: session.fusionModel,
      claudeEffort: session.fusionClaudeEffort ?? session.fusionEffort,
      codexModel: session.fusionCodexModel,
      codexEffort: session.fusionCodexEffort ?? session.fusionEffort
    });
    // Planner family/model/effort changes relaunch the planner process;
    // executor settings and fast-serving toggles apply live.
    const plannerFamilyChanged = next.plannerFamily !== current.plannerFamily;
    const requiresRestart =
      plannerFamilyChanged ||
      next.plannerModel !== current.plannerModel ||
      next.plannerEffort !== current.plannerEffort;
    const executorSettingsChanged =
      next.executorFamily !== current.executorFamily ||
      next.executorModel !== current.executorModel ||
      next.executorEffort !== current.executorEffort;
    const fastSettingsChanged =
      next.plannerFast !== current.plannerFast ||
      next.executorFast !== current.executorFast;

    // Carry the pick forward: the next NEW Fusion pane starts from this
    // configuration instead of the stock defaults.
    rememberFusionSettings(next);

    if (session.started && !requiresRestart && (executorSettingsChanged || fastSettingsChanged)) {
      window.vibe?.fusionChat
        ?.updateSettings(session.id, {
          plannerFamily: next.plannerFamily,
          plannerFast: next.plannerFast,
          executorFamily: next.executorFamily,
          executorModel: next.executorModel,
          executorEffort: next.executorEffort,
          executorFast: next.executorFast
        })
        .catch(() => {});
    }

    const applySettings = () => {
      updateScopeSessions(scope, (sessions) =>
        sessions.map((item) => {
          if (item.id !== session.id) {
            return item;
          }

          // A thread only survives the relaunch within the SAME planner
          // family — a claude session id means nothing to a codex planner.
          const familyRef = (ref?: AgentThreadRef) =>
            ref?.provider === next.plannerFamily && ref.id ? ref : undefined;
          const currentPlannerRef = familyRef(
            hasClaudeThreadId(item.threadRef) ? item.threadRef : undefined
          );
          const previousPlannerRef = familyRef(sessionResumeRef(item));
          const relaunchResumeRef = currentPlannerRef ?? previousPlannerRef;
          return {
            ...item,
            fusionPlannerFamily: next.plannerFamily,
            fusionPlannerModel: next.plannerModel,
            fusionPlannerEffort: next.plannerEffort,
            fusionPlannerFast: next.plannerFast,
            fusionExecutorFamily: next.executorFamily,
            fusionExecutorModel: next.executorModel,
            fusionExecutorEffort: next.executorEffort,
            fusionExecutorFast: next.executorFast,
            fusionRunMode: nextFusionRunMode,
            fusionModel: undefined,
            fusionCodexModel: undefined,
            fusionClaudeEffort: undefined,
            fusionCodexEffort: undefined,
            fusionEffort: undefined,
            ...(requiresRestart && item.fusion
              ? {
                  threadRef: relaunchResumeRef,
                  resumeRef: currentPlannerRef ? previousPlannerRef : undefined
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
                  attention: EMPTY_ATTENTION,
                  detachedTaskIds: undefined,
                  subagentDepth: undefined
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

  // Open Fusion model changes: the pane already persisted models.json through
  // the host; here we mirror the pick into the session (so restore/duplicate
  // keep it) and restart the pane when the Executor changed — that model is
  // baked into the generated OpenCode config, unlike the live-switching Brain.
  function updateOpenFusionSettings(
    scope: SessionScope,
    session: AgentSession,
    settings: OpenFusionSettingsChange
  ) {
    if (!session.openFusion) {
      return;
    }

    const nextPlannerModel = normalizeOpenFusionModel(
      settings.plannerModel ?? session.openFusionPlannerModel,
      DEFAULT_OPEN_FUSION_PLANNER_MODEL
    );
    const nextExecutorModel = normalizeOpenFusionModel(
      settings.executorModel ?? session.openFusionExecutorModel,
      DEFAULT_OPEN_FUSION_EXECUTOR_MODEL
    );
    // Plan/Auto is renderer-only state (the host reads it per turn from the
    // input payload), so a mode change never restarts the pane.
    const nextRunMode = normalizeFusionRunMode(
      settings.runMode ?? session.openFusionRunMode
    );
    const currentExecutorModel = normalizeOpenFusionModel(
      session.openFusionExecutorModel,
      DEFAULT_OPEN_FUSION_EXECUTOR_MODEL
    );
    const requiresRestart = nextExecutorModel !== currentExecutorModel;

    // Carry the pair forward for the next NEW Open Fusion pane (only once
    // both roles are chosen — a half-configured pair shouldn't half-seed the
    // first-run gate).
    if (nextPlannerModel && nextExecutorModel) {
      rememberOpenFusionModels({
        plannerModel: nextPlannerModel,
        executorModel: nextExecutorModel
      });
    }

    const applySettings = () => {
      updateScopeSessions(scope, (sessions) =>
        sessions.map((item) => {
          if (item.id !== session.id) {
            return item;
          }

          const currentChatRef = activeSessionThreadRef(item);
          const previousChatRef = sessionResumeRef(item);
          const relaunchResumeRef = currentChatRef ?? previousChatRef;
          return {
            ...item,
            openFusionPlannerModel: nextPlannerModel,
            openFusionExecutorModel: nextExecutorModel,
            openFusionRunMode: nextRunMode,
            ...(requiresRestart && item.started
              ? {
                  threadRef: relaunchResumeRef,
                  resumeRef: currentChatRef ? previousChatRef : undefined,
                  started: true,
                  launchToken: item.launchToken + 1,
                  nextLaunchMode: (relaunchResumeRef?.id ? "resume" : "new") as
                    | "resume"
                    | "new",
                  threadLookupStartedAt: undefined,
                  threadLookupStatus: (relaunchResumeRef?.id ? "found" : "idle") as
                    | "found"
                    | "idle",
                  threadLookupMessage: undefined,
                  status: "idle" as const,
                  attention: EMPTY_ATTENTION,
                  detachedTaskIds: undefined,
                  subagentDepth: undefined
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
    status: AgentSession["status"],
    // force skips the done/failed latch. Reserved for the pane's human-input
    // signal (statusAfterUserInput): a keystroke is the non-telemetry
    // equivalent of a turn start, so it may release a latched pill where
    // process output never can.
    options?: { force?: boolean }
  ) {
    updateScopeSessions(scope, (sessions) => {
      let changed = false;
      const nextSessions = sessions.map((session) => {
        if (session.id !== sessionId) {
          return session;
        }

        const nextStatus = options?.force
          ? status
          : reconcileStatus(session.status, status);
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

    const pending = pendingCodexAttentionRef.current.get(sessionId);
    if (pending?.length) {
      pendingCodexAttentionRef.current.delete(sessionId);
      const rootAttention = [...pending]
        .reverse()
        .find((event) => event.providerThreadId === threadRef.id);
      if (rootAttention) {
        const activeTurnId = codexActiveTurnIdsRef.current.get(sessionId);
        if (
          codexTurnAttentionDecision(
            activeTurnId,
            codexSubmitPendingRef.current.has(sessionId),
            codexSubmitPendingRef.current.get(sessionId),
            codexSettledTurnIdsRef.current.get(sessionId) ?? [],
            rootAttention.providerTurnId
          ) === "reject"
        ) {
          return;
        }
        codexSubmitPendingRef.current.delete(sessionId);
        if (
          rootAttention.attention.state === "completed" ||
          rootAttention.attention.state === "failed"
        ) {
          if (rootAttention.providerTurnId) {
            rememberSettledCodexTurn(sessionId, rootAttention.providerTurnId);
          }
          codexActiveTurnIdsRef.current.delete(sessionId);
          codexTurnLiveRef.current.set(sessionId, false);
        }
        // Functional state updates preserve call order, so the thread binding
        // above lands before this status/attention update.
        applyAcceptedAgentAttention(sessionId, rootAttention.attention);
      } else {
        // A lifecycle event for a thread other than the discovered pane root
        // must not poison the next root completion's turn-id latch.
        codexActiveTurnIdsRef.current.delete(sessionId);
      }
    }
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

  // Every workspace's sessions live in renderer state and keep receiving live
  // status/attention updates while their folder is in the background (all
  // mutations go through updateAnySession, and the event subscriptions are
  // mounted once), so the cards tally without any new state, IPC, or polling.
  const multiModeSummary = summarizeSessions(multiSessions);

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

  function openWorkspaceContextMenu(
    event: ReactMouseEvent<HTMLElement>,
    workspace: ProjectWorkspace
  ) {
    event.preventDefault();
    event.stopPropagation();
    setWorkspaceContextMenu({
      workspaceId: workspace.id,
      name: workspace.name,
      path: workspace.path,
      x: Math.min(event.clientX, Math.max(16, window.innerWidth - 238)),
      y: Math.min(event.clientY, Math.max(16, window.innerHeight - 122))
    });
  }

  async function runWorkspaceContextAction(
    action: "explorer" | "terminal",
    workspace: WorkspaceContextMenuState
  ) {
    setWorkspaceContextMenu(null);

    const workspaceApi = window.vibe?.workspace;
    if (!workspaceApi) {
      setShellMessage("Workspace actions are unavailable in this window.");
      return;
    }

    try {
      const result =
        action === "explorer"
          ? await workspaceApi.openInExplorer(workspace.path)
          : await workspaceApi.openTerminal(workspace.path);

      if (result?.ok) {
        return;
      }

      setShellMessage(
        result?.error ||
          (action === "explorer"
            ? "Could not open the folder in file explorer."
            : "Could not open a terminal for this folder.")
      );
    } catch (err) {
      setShellMessage(String(err));
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

  // Maximize operates on the TILE, not the sub-pane. Maximizing one terminal of
  // a split to fill its tile would hide its siblings, and a hidden pane has a
  // zero-sized box that xterm cannot measure — exactly the state all-visible
  // splits exist to avoid.
  const maximizedTileId = maximizedSessionId
    ? effectiveTileId(
        boardSessions.find((session) => session.id === maximizedSessionId) ?? {
          id: maximizedSessionId
        }
      )
    : null;
  const visibleSessions = boardSessions.filter(
    (session) => !maximizedTileId || effectiveTileId(session) === maximizedTileId
  );
  const boardTiles = buildBoardTiles(visibleSessions);
  const updateNoticeKey = updateState
    ? [
        updateState.status,
        updateState.info?.version ?? "",
        updateState.errorMessage ?? ""
      ].join(":")
    : "";
  const shouldShowUpdateOverlay =
    updateState !== null &&
    ["available", "downloading", "downloaded", "switching", "error"].includes(
      updateState.status
    ) &&
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
    updateState?.status === "checking" ||
    updateState?.status === "downloading" ||
    updateState?.status === "switching";

  const appVersion = updateState?.currentVersion ?? "";

  // Same dismissal rules as the folder context menu: Escape, or a press
  // anywhere outside the picker.
  useEffect(() => {
    if (!versionPickerOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setVersionPickerOpen(false);
      }
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".version-picker")) {
        setVersionPickerOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [versionPickerOpen]);

  // Same dismissal rules as the version picker: Escape, or a press anywhere
  // outside the launcher menu.
  useEffect(() => {
    if (!launcherMenuOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setLauncherMenuOpen(false);
      }
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".launcher-picker")) {
        setLauncherMenuOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [launcherMenuOpen]);

  // Every open starts a fresh search and lands focus in the search box.
  useEffect(() => {
    if (!launcherMenuOpen) {
      return;
    }
    setLauncherQuery("");
    setLauncherHighlight(0);
    launcherSearchRef.current?.focus();
  }, [launcherMenuOpen]);

  // Providers and their model lists are fetched on open rather than at launch:
  // same reasoning as the version picker — rare, deliberate, off the startup
  // path.
  async function toggleLauncherMenu() {
    if (launcherMenuOpen) {
      setLauncherMenuOpen(false);
      return;
    }
    setLauncherMenuOpen(true);
    const list = await window.vibe?.claudeProviders?.list?.();
    setProviderList(list?.profiles ?? []);
    if (list?.profiles?.length) {
      void window.vibe?.claudeProviders
        ?.listModels?.()
        .then((result) => {
          if (!result?.ok) {
            return;
          }
          const next: Record<string, { id: string; label: string }[] | null> = {};
          for (const entry of result.providers) {
            next[entry.providerId] = entry.models;
          }
          setProviderModels(next);
        })
        .catch(() => {});
    }
  }

  function launchClaudeCustom(providerProfileId?: string, modelId?: string) {
    setLauncherMenuOpen(false);
    void addSession("claude-custom", {
      providerProfileId: providerProfileId || "default-custom",
      providerModelOverride: modelId || undefined
    });
  }

  // The launcher dropdown's flat item list: agent profiles first, then the
  // saved Claude providers with their endpoint models. The search box filters
  // all of them by label (provider/model rows also match on model id).
  const launcherQueryText = launcherQuery.trim().toLowerCase();
  const launcherEntries: LauncherMenuEntry[] = [];
  for (const profile of launcherAgentProfiles) {
    if (
      launcherQueryText &&
      !profile.label.toLowerCase().includes(launcherQueryText)
    ) {
      continue;
    }
    launcherEntries.push({
      key: profile.kind,
      section: "agents",
      label: profile.label,
      hint: agentCliMissing(profile.kind)
        ? `${profile.label} was not found on your PATH — click to launch anyway`
        : undefined,
      profile,
      missing: agentCliMissing(profile.kind),
      run: () => {
        setLauncherMenuOpen(false);
        void addSession(profile.kind);
      }
    });
  }
  for (const provider of providerList ?? []) {
    const providerMatches =
      !launcherQueryText ||
      provider.name.toLowerCase().includes(launcherQueryText) ||
      provider.model.toLowerCase().includes(launcherQueryText);
    const models = (providerModels[provider.id] ?? []).filter(
      (model) =>
        !launcherQueryText ||
        providerMatches ||
        model.label.toLowerCase().includes(launcherQueryText) ||
        model.id.toLowerCase().includes(launcherQueryText)
    );
    if (!providerMatches && models.length === 0) {
      continue;
    }
    launcherEntries.push({
      key: `provider:${provider.id}`,
      section: "providers",
      label: provider.name,
      sub: provider.model,
      hint: `${provider.baseUrl} — ${provider.model}`,
      run: () => launchClaudeCustom(provider.id)
    });
    for (const model of models) {
      launcherEntries.push({
        key: `provider:${provider.id}:${model.id}`,
        section: "providers",
        label: model.label,
        sub: model.id,
        hint: `${provider.name} — ${model.id}`,
        indent: true,
        run: () => launchClaudeCustom(provider.id, model.id)
      });
    }
  }
  // Arrow keys can leave the highlight past the end once a search narrows the
  // list; clamp it to the rows that actually exist.
  const launcherActiveIndex = Math.min(
    launcherHighlight,
    Math.max(launcherEntries.length - 1, 0)
  );

  function handleLauncherSearchKeyDown(
    event: ReactKeyboardEvent<HTMLInputElement>
  ) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setLauncherHighlight((current) =>
        Math.min(current + 1, launcherEntries.length - 1)
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setLauncherHighlight((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      launcherEntries[launcherActiveIndex]?.run();
    } else if (event.key === "Escape") {
      setLauncherMenuOpen(false);
    }
  }

  function renderLauncherEntry(entry: LauncherMenuEntry, index: number) {
    const highlighted = index === launcherActiveIndex;
    return (
      <button
        key={entry.key}
        role="option"
        aria-selected={highlighted}
        className={clsx(
          "launcher-picker-item",
          highlighted && "is-active",
          entry.missing && "agent-launcher-missing",
          entry.indent && "launcher-picker-model"
        )}
        style={
          entry.profile
            ? ({ "--agent-accent": entry.profile.accent } as React.CSSProperties)
            : undefined
        }
        title={entry.hint}
        ref={
          highlighted
            ? (node) => {
                node?.scrollIntoView({ block: "nearest" });
              }
            : undefined
        }
        onMouseMove={() => setLauncherHighlight(index)}
        onClick={entry.run}
      >
        {entry.profile &&
          (entry.profile.openFusion ? (
            <img className="agent-launcher-logo" src={openFusionLogo} alt="" />
          ) : (
            <Plus size={13} />
          ))}
        <span className="launcher-picker-item-label">{entry.label}</span>
        {entry.sub && (
          <span className="launcher-picker-item-sub">{entry.sub}</span>
        )}
      </button>
    );
  }

  function dismissUpdateOverlay() {
    setDismissedUpdateKey(updateNoticeKey);
  }

  // Releases are fetched on open rather than at launch: this is a rare,
  // deliberate action, and it keeps startup off the network.
  async function toggleVersionPicker() {
    if (versionPickerOpen) {
      setVersionPickerOpen(false);
      return;
    }

    setVersionPickerOpen(true);
    setVersionList(null);

    const result = await window.vibe?.updates.listVersions();
    setVersionList(
      result ?? {
        ok: false,
        message: "Version switching is unavailable in this window.",
        versions: []
      }
    );
  }

  async function selectAppVersion(version: string) {
    setVersionPickerOpen(false);
    setDismissedUpdateKey(null);

    const result = await window.vibe?.updates.installVersion(version);
    if (!result) {
      setShellMessage("Version switching is unavailable in this window.");
      return;
    }

    if (!result.ok) {
      setShellMessage(result.message || `Couldn't switch to v${version}.`);
    }
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
            <SessionCounts summary={multiModeSummary} />
          </span>
        </button>

        <div className="sidebar-section-title">
          Folders
          {workspaces.length > 0 && (
            <span className="sidebar-section-count">{workspaces.length}</span>
          )}
        </div>
        <div
          className="workspace-list"
          onDragLeave={handleWorkspaceListDragLeave}
        >
          {workspaces.length === 0 && (
            <div className="workspace-empty-hint">
              No folders yet.
              <br />
              Open one to start working.
            </div>
          )}
          {workspaces.map((workspace) => {
            const hasUnreadAttention = workspaceHasUnreadAttention(workspace);
            const hasWorking =
              !hasUnreadAttention && workspaceHasWorking(workspace);
            const summary = summarizeSessions(workspace.sessions);
            const isDropTarget =
              workspaceDropTarget?.workspaceId === workspace.id;

            return (
              <div
                className={clsx(
                  "workspace-row",
                  workspaceContextMenu?.workspaceId === workspace.id &&
                    "context-open",
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
                onContextMenu={(event) =>
                  openWorkspaceContextMenu(event, workspace)
                }
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
                  <span className="workspace-name">{workspace.name}</span>
                  <ChevronRight size={15} />
                  <span className="workspace-path" title={workspace.path}>
                    {workspace.path}
                  </span>
                  <SessionCounts summary={summary} />
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

      {workspaceContextMenu && (
        <div
          className="workspace-context-menu"
          role="menu"
          aria-label={`Folder actions for ${workspaceContextMenu.name}`}
          style={
            {
              "--context-menu-x": `${workspaceContextMenu.x}px`,
              "--context-menu-y": `${workspaceContextMenu.y}px`
            } as CSSProperties
          }
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="workspace-context-menu-title">
            <Folder size={14} />
            <span>{workspaceContextMenu.name}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              runWorkspaceContextAction("explorer", workspaceContextMenu)
            }
          >
            <FolderOpen size={15} />
            <span>Open in file explorer</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              runWorkspaceContextAction("terminal", workspaceContextMenu)
            }
          >
            <TerminalSquare size={15} />
            <span>Open terminal</span>
          </button>
        </div>
      )}

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
            <button
              className="icon-button"
              title="Settings (Ctrl+,)"
              onClick={() => {
                setSettingsHint(null);
                setSettingsOpen(true);
              }}
            >
              <Settings size={17} />
            </button>
            {currentAppVersionLabel && (
              <span className="app-version" title="Current app version">
                {currentAppVersionLabel}
              </span>
            )}
            <button onClick={checkForUpdates} disabled={updateCheckDisabled}>
              <RefreshCw size={16} />
              {updateCheckLabel}
            </button>
            <div className="version-picker">
              <button
                className="version-picker-toggle"
                title="Switch to another version"
                aria-haspopup="listbox"
                aria-expanded={versionPickerOpen}
                onClick={toggleVersionPicker}
              >
                <ChevronDown size={15} />
              </button>
              {versionPickerOpen && (
                <div className="version-picker-menu" role="listbox">
                  <div className="version-picker-title">
                    Switch version
                    {currentAppVersionLabel && (
                      <span>now {currentAppVersionLabel}</span>
                    )}
                  </div>
                  {versionList === null ? (
                    <div className="version-picker-note">Loading releases…</div>
                  ) : !versionList.ok ? (
                    <div className="version-picker-note">
                      {versionList.message ?? "Couldn't read releases."}
                    </div>
                  ) : versionList.versions.length === 0 ? (
                    <div className="version-picker-note">
                      No published releases.
                    </div>
                  ) : (
                    <div className="version-picker-list">
                      {versionList.versions.map((entry) => {
                        const isCurrent =
                          entry.version === (versionList.currentVersion ?? appVersion);
                        return (
                          <button
                            key={entry.version}
                            role="option"
                            aria-selected={isCurrent}
                            className={clsx(
                              "version-picker-item",
                              isCurrent && "is-current"
                            )}
                            disabled={isCurrent || !entry.installable}
                            title={
                              !entry.installable
                                ? "This release has no Windows installer."
                                : isCurrent
                                  ? "Already installed"
                                  : `Install v${entry.version}`
                            }
                            onClick={() => selectAppVersion(entry.version)}
                          >
                            <span className="version-picker-version">
                              v{entry.version}
                            </span>
                            {entry.prerelease && (
                              <span className="version-picker-tag">pre</span>
                            )}
                            <span className="version-picker-state">
                              {isCurrent
                                ? "current"
                                : !entry.installable
                                  ? "no installer"
                                  : ""}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="version-picker-footer">
                    Picking a version downloads its installer and closes the app.
                  </div>
                </div>
              )}
            </div>
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
            <div className="launcher-picker">
              <button
                className="launcher-picker-toggle"
                title="Launch a terminal or coding agent"
                aria-haspopup="listbox"
                aria-expanded={launcherMenuOpen}
                onClick={() => void toggleLauncherMenu()}
                style={{ "--agent-accent": "var(--accent)" } as React.CSSProperties}
              >
                <Plus size={14} />
                New terminal
                <ChevronDown size={13} />
              </button>
              {launcherMenuOpen && (
                <div
                  className="launcher-picker-menu"
                  role="listbox"
                  aria-label="Launch a terminal or coding agent"
                >
                  <div className="launcher-picker-search">
                    <Search size={14} />
                    <input
                      ref={launcherSearchRef}
                      type="text"
                      placeholder="Search terminals and agents…"
                      value={launcherQuery}
                      onChange={(event) => {
                        setLauncherQuery(event.target.value);
                        setLauncherHighlight(0);
                      }}
                      onKeyDown={handleLauncherSearchKeyDown}
                    />
                  </div>
                  <div className="launcher-picker-list">
                    {launcherEntries.length === 0 ? (
                      <div className="launcher-picker-note">
                        No matches for “{launcherQuery.trim()}”.
                      </div>
                    ) : (
                      launcherEntries.map((entry, index) => (
                        <Fragment key={entry.key}>
                          {(index === 0 ||
                            launcherEntries[index - 1].section !==
                              entry.section) && (
                            <div className="launcher-picker-title">
                              {entry.section === "agents"
                                ? "Agents"
                                : "Claude providers"}
                            </div>
                          )}
                          {renderLauncherEntry(entry, index)}
                        </Fragment>
                      ))
                    )}
                    {!launcherQueryText && providerList === null && (
                      <>
                        <div className="launcher-picker-title">
                          Claude providers
                        </div>
                        <div className="launcher-picker-note">Loading…</div>
                      </>
                    )}
                    {!launcherQueryText && providerList?.length === 0 && (
                      <>
                        <div className="launcher-picker-title">
                          Claude providers
                        </div>
                        <div className="launcher-picker-note">
                          No providers yet — add an endpoint + API key to use
                          Open Claude Code.
                        </div>
                        <button
                          className="launcher-picker-item"
                          onClick={() => {
                            setLauncherMenuOpen(false);
                            setSettingsHint(
                              "Add a Claude provider below, then launch Open Claude Code."
                            );
                            setSettingsOpen(true);
                          }}
                        >
                          Add a provider…
                        </button>
                      </>
                    )}
                    {!launcherQueryText &&
                      providerList !== null &&
                      providerList.length > 0 && (
                        <button
                          className="launcher-picker-item"
                          onClick={() => {
                            setLauncherMenuOpen(false);
                            setSettingsHint(null);
                            setSettingsOpen(true);
                          }}
                        >
                          Manage providers…
                        </button>
                      )}
                  </div>
                </div>
              )}
            </div>
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
              {activeWorkspaceChangeSummary?.branch && (
                <button
                  type="button"
                  className="diff-branch diff-branch-button"
                  title="Show all branches and their state"
                  onClick={() => void toggleBranchPicker()}
                >
                  {activeWorkspaceChangeSummary.branch}
                  <ChevronDown size={11} />
                </button>
              )}
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
              {branchPicker.open && (
                <>
                  <div
                    className="branch-picker-backdrop"
                    onClick={() =>
                      setBranchPicker((current) => ({
                        ...current,
                        open: false
                      }))
                    }
                  />
                  <div
                    className="branch-picker"
                    role="menu"
                    aria-label="Branch states"
                  >
                    <div className="branch-picker-title">Branches</div>
                    {branchPicker.loading ? (
                      <div className="branch-picker-empty">
                        Loading branches…
                      </div>
                    ) : !branchPicker.overview ||
                      branchPicker.overview.state !== "ok" ||
                      branchPicker.overview.branches.length === 0 ? (
                      <div className="branch-picker-empty">
                        {branchPicker.overview?.message ||
                          "No branches found."}
                      </div>
                    ) : (
                      branchPicker.overview.branches.map((branch) => (
                        <div
                          key={branch.name}
                          className={clsx(
                            "branch-picker-row",
                            branch.current && "is-current"
                          )}
                          title={
                            branch.upstream
                              ? `Tracks ${branch.upstream}`
                              : undefined
                          }
                        >
                          <span className="branch-picker-name">
                            {branch.current && <Check size={12} />}
                            {branch.name}
                          </span>
                          <span className="branch-picker-state">
                            {branchStateNode(branch)}
                          </span>
                        </div>
                      ))
                    )}
                    <div className="branch-picker-note">
                      Uncommitted changes only exist where a branch is checked
                      out.
                    </div>
                  </div>
                </>
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
              items={boardTiles.map((tile) => {
                const renderSessionPane = (session: AgentSession) =>
                  session.fusion ? (
                  <FusionChatPane
                    session={session}
                    profile={getProfile("fusion")}
                    initialPicker={screenshotFusionPicker}
                    claimedThreadIds={claimedThreadIds(session.id)}
                    cwdConflict={cwdConflicts.get(session.id)}
                    isMaximized={session.id === maximizedSessionId}
                    isSelected={session.id === selectedSessionId}
                    onClose={() => closeSession(activeScope, session)}
                    onDuplicate={() => duplicateSession(activeScope, session)}
                    onRestart={() => restartSession(activeScope, session)}
                    onResume={(threadRef) =>
                      resumeSession(activeScope, session, threadRef)
                    }
                    onClear={() => clearFusionSession(activeScope, session)}
                    onSettingsChange={(settings) =>
                      updateFusionSettings(activeScope, session, settings)
                    }
                    onAdd={() =>
                      addSessionForCwd(
                        activeScope,
                        sessionCreationKind(session),
                        session.cwd,
                        providerOptionsFor(session)
                      )
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
                ) : session.openFusion ? (
                  <OpenFusionChatPane
                    session={session}
                    profile={getProfile("openfusion")}
                    claimedThreadIds={claimedThreadIds(session.id)}
                    cwdConflict={cwdConflicts.get(session.id)}
                    isMaximized={session.id === maximizedSessionId}
                    isSelected={session.id === selectedSessionId}
                    onClose={() => closeSession(activeScope, session)}
                    onDuplicate={() => duplicateSession(activeScope, session)}
                    onRestart={() => restartSession(activeScope, session)}
                    onResume={(threadRef) =>
                      resumeSession(activeScope, session, threadRef)
                    }
                    onClear={() => clearFusionSession(activeScope, session)}
                    onSettingsChange={(settings) =>
                      updateOpenFusionSettings(activeScope, session, settings)
                    }
                    onAdd={() =>
                      addSessionForCwd(
                        activeScope,
                        sessionCreationKind(session),
                        session.cwd,
                        providerOptionsFor(session)
                      )
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
                      session.fusion ? getProfile("fusion") : getProfile(session.kind)
                    }
                    claimedThreadIds={claimedThreadIds(session.id)}
                    cwdConflict={cwdConflicts.get(session.id)}
                    isMaximized={session.id === maximizedSessionId}
                    isArranging={isArranging}
                    isGrouped={Boolean(session.tileId)}
                    // An ungrouped pane keeps the original behaviour: it takes
                    // focus when it mounts, so a freshly launched terminal is
                    // typeable without clicking into it first. Only a split
                    // tile needs the selective gate, because several terminals
                    // mount into one frame there and the last one would win.
                    autoFocus={
                      !session.tileId || session.id === selectedSessionId
                    }
                    onClose={() => closeSession(activeScope, session)}
                    onDuplicate={() => duplicateSession(activeScope, session)}
                    onSplit={(dir) => splitSession(activeScope, session, dir)}
                    onPopOut={() => popOutSession(activeScope, session)}
                    onRestart={() => restartSession(activeScope, session)}
                    onResume={() => resumeSession(activeScope, session)}
                    onAdd={() =>
                      addSessionForCwd(
                        activeScope,
                        sessionCreationKind(session),
                        session.cwd,
                        providerOptionsFor(session)
                      )
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
                    onInputStatusRelease={(status) => {
                      if (session.kind === "codex" && status === "waiting") {
                        clearCodexRunningWatchdog(session.id);
                        codexActiveTurnIdsRef.current.delete(session.id);
                        codexTurnLiveRef.current.set(session.id, false);
                      }
                      // Esc is the TUI interrupt and cancels the agent's
                      // foreground children with it, so it is also the user's
                      // one-key escape from a delegation bracket that leaked.
                      if (status === "waiting") {
                        updateAnySession(session.id, clearSubagentDepth);
                      }
                      updateSessionStatus(activeScope, session.id, status, {
                        force: true
                      });
                    }}
                    onDelegationTimeout={() =>
                      updateAnySession(session.id, clearSubagentDepth)
                    }
                    onCodexTurnStart={() =>
                      applyCodexTurnStart(session.id)
                    }
                    onCodexInput={() =>
                      recordCodexTerminalInput(session.id)
                    }
                  />
                  );

                const isMaximizedTile = tile.id === maximizedTileId;
                // A split tile advertises what its partition actually needs, so
                // sanitizeLayout/settleLayouts grow it and re-pack its
                // neighbours with no new sizing code here.
                const partitionMin = tile.tree
                  ? subtreeMin(
                      tile.tree,
                      DEFAULT_MIN_PANE_WIDTH,
                      DEFAULT_MIN_PANE_HEIGHT,
                      SPLIT_DIVIDER_PX
                    )
                  : { minW: DEFAULT_MIN_PANE_WIDTH, minH: DEFAULT_MIN_PANE_HEIGHT };

                return {
                  id: tile.id,
                  minW: isMaximizedTile
                    ? Math.max(DEFAULT_MIN_PANE_WIDTH * 2, partitionMin.minW)
                    : partitionMin.minW,
                  minH: isMaximizedTile
                    ? Math.max(DEFAULT_MIN_PANE_HEIGHT * 2, partitionMin.minH)
                    : partitionMin.minH,
                  layout: isMaximizedTile
                    ? {
                        x: 0,
                        y: LEGACY_BOARD_PADDING,
                        w: 100,
                        h: MAXIMIZED_PANE_HEIGHT,
                        unit: "fluid" as const
                      }
                    : tile.anchor.layout,
                  content: tile.tree ? (
                    <PaneSplit
                      node={tile.tree}
                      leafMinW={DEFAULT_MIN_PANE_WIDTH}
                      leafMinH={DEFAULT_MIN_PANE_HEIGHT}
                      // Same arranging flag TiledBoard uses, so every pane in
                      // the tile defers its fit until the drag settles: one PTY
                      // resize per pane per drag, not one per frame.
                      onArrangeChange={setIsArranging}
                      onRatioChange={(path, ratio) =>
                        setTileRatio(activeScope, tile.id, path, ratio)
                      }
                      renderPane={(paneId) => {
                        const member = tile.members.find(
                          (candidate) => candidate.id === paneId
                        );
                        return member ? renderSessionPane(member) : null;
                      }}
                    />
                  ) : (
                    renderSessionPane(tile.anchor)
                  )
                };
              })}
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
                  {launcherAgentProfiles.map((profile) => {
                    const missing = agentCliMissing(profile.kind);
                    return (
                      <button
                        key={profile.kind}
                        className={clsx(missing && "agent-launcher-missing")}
                        title={
                          missing
                            ? `${profile.label} was not found on your PATH — click to launch anyway`
                            : undefined
                        }
                        onClick={() => addSession(profile.kind)}
                      >
                        {profile.openFusion ? (
                          <img className="agent-launcher-logo" src={openFusionLogo} alt="" />
                        ) : (
                          <Plus size={16} />
                        )}
                        {profile.label}
                      </button>
                    );
                  })}
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
                : updateState.status === "switching"
                  ? "Switching version"
                  : updateState.status === "error"
                    ? "Update failed"
                    : "Update available"}
            </strong>
            {updateState.status !== "downloading" &&
              updateState.status !== "switching" && (
              <button
                className="update-overlay-dismiss"
                aria-label="Dismiss update notice"
                onClick={dismissUpdateOverlay}
              >
                  <X size={13} />
                </button>
              )}
          </div>

          {/* No Restart button here on purpose: nothing is staged with
              electron-updater, so its quitAndInstall would have nothing to
              install. The installer is already running and closes the app. */}
          {updateState.status === "switching" && (
            <p>
              Installing vibeTerminal {updateVersion}. The app will close and
              reopen on that version.
            </p>
          )}

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

      {settingsOpen && (
        <SettingsDialog
          hint={settingsHint}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsHint(null);
          }}
        />
      )}
    </div>
  );
}
