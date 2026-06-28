import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
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
import {
  EMPTY_ATTENTION,
  attentionFromEvent,
  attentionFromTerminalEvent,
  clearUnreadAttention,
  normalizeAttention,
  reconcileStatus,
  shouldMarkAttentionUnread,
  shouldShowAttentionDot,
  shouldUseTerminalEventAttention,
  statusFromAttentionState,
  statusFromTerminalEvent
} from "./attention";
import TerminalPane from "./components/TerminalPane";
import TiledBoard from "./components/TiledBoard";
import {
  createThreadRef,
  defaultLaunchMode,
  isThreadedAgentKind
} from "./sessionLaunch";
import type {
  AgentAttentionEvent,
  AgentKind,
  AgentProfile,
  AgentSession,
  AgentThreadRef,
  AgentThreadLookupStatus,
  CodeChangeSummary,
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

type AppView = "multi" | "project";

type SessionScope =
  | { type: "multi" }
  | { type: "workspace"; workspaceId: string };

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
    accent: "#f2c94c"
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

function migrateLayout(layout: LayoutBox): LayoutBox {
  if (layout.unit === "fluid") {
    const tightenedLayout = tightenDefaultFluidGutters(layout);

    return {
      x: Math.max(0, Math.min(tightenedLayout.x, 100)),
      y: Math.max(LEGACY_BOARD_PADDING, tightenedLayout.y),
      w: Math.max(1, Math.min(tightenedLayout.w, 100)),
      h: Math.max(DEFAULT_MIN_PANE_HEIGHT, tightenedLayout.h),
      unit: "fluid"
    };
  }

  return {
    x: (layout.x / LEGACY_GRID_COLS) * 100,
    y: LEGACY_BOARD_PADDING + layout.y * (LEGACY_ROW_HEIGHT + LEGACY_BOARD_GAP),
    w: (layout.w / LEGACY_GRID_COLS) * 100,
    h:
      layout.h * LEGACY_ROW_HEIGHT +
      Math.max(0, layout.h - 1) * LEGACY_BOARD_GAP,
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
  const sessionName = name ?? `${profile.label} ${existingSessions.length + 1}`;

  return {
    id: createId("session"),
    name: sessionName,
    kind,
    command: profile.command,
    cwd,
    createdAt: Date.now(),
    threadRef: createThreadRef(kind, sessionName),
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

function restoreSession(session: AgentSession): AgentSession {
  const launchToken = session.launchToken ?? 0;
  const previousStatus = session.status ?? "idle";
  const shouldAutoStart =
    session.started === true &&
    previousStatus !== "done" &&
    previousStatus !== "failed";

  return {
    ...session,
    started: shouldAutoStart,
    launchToken,
    nextLaunchMode: defaultLaunchMode(
      session.kind,
      launchToken,
      Boolean(session.threadRef?.id)
    ),
    threadRef: session.threadRef,
    threadLookupStartedAt: undefined,
    threadLookupStatus: session.threadRef?.id ? "found" : "idle",
    threadLookupMessage: undefined,
    status: shouldAutoStart ? "idle" : previousStatus,
    attention: normalizeAttention(session.attention),
    layout: migrateLayout(session.layout)
  };
}

function loadWorkspaces(): ProjectWorkspace[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as ProjectWorkspace[];
    return parsed.map((workspace) => ({
      ...workspace,
      sessions: workspace.sessions.map(restoreSession)
    }));
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
    return parsed.map(restoreSession);
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

export default function App() {
  const [initialState] = useState(() => {
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
  const attentionSelectionRef = useRef<{
    selectedSessionId: string | null;
    visibleSessionIds: string[];
  }>({
    selectedSessionId: null,
    visibleSessionIds: []
  });
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

      if ("id" in event) {
        applyTerminalStatus(event.id, statusFromTerminalEvent(event));

        const attention = attentionFromTerminalEvent(event);
        if (attention) {
          applyTerminalAttention(event.id, attention);
        }
      }
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
      const nextStatus = reconcileStatus(session.status, status);
      return nextStatus === session.status
        ? session
        : { ...session, status: nextStatus };
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
    updateScopeSessions(scope, (sessions) => [
      ...sessions,
      {
        ...createSession(session.kind, session.cwd, sessions),
        name: `${session.name} copy`,
        command: session.command
      }
    ]);
  }

  function closeSession(scope: SessionScope, sessionId: string) {
    window.vibe?.terminal.kill(sessionId);
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
      window.vibe?.terminal.kill(session.id);
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
    window.vibe?.terminal.kill(session.id).then(() => {
      updateScopeSessions(scope, (sessions) =>
        sessions.map((item) =>
          item.id === session.id
            ? {
                ...item,
                started: true,
                launchToken: item.launchToken + 1,
                nextLaunchMode:
                  isThreadedAgentKind(item.kind) && item.threadRef?.id
                    ? "resume"
                    : "new",
                threadLookupStartedAt: undefined,
                threadLookupStatus: item.threadRef?.id ? "found" : "idle",
                threadLookupMessage: undefined,
                status: "idle",
                attention: EMPTY_ATTENTION
              }
            : item
        )
      );
    });
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

  function workspaceHasUnreadAttention(workspace: ProjectWorkspace) {
    return workspace.sessions.some(shouldShowAttentionDot);
  }

  const multiModeHasUnreadAttention =
    multiSessions.some(shouldShowAttentionDot);

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
            multiModeHasUnreadAttention && "has-attention"
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
            {multiModeHasUnreadAttention && (
              <span className="attention-dot" aria-hidden="true" />
            )}
          </div>
          <span className="multi-mode-subtitle">
            {formatCount(multiSessions.length, "terminal")}
          </span>
        </button>

        <div className="sidebar-section-title">Folders</div>
        <div className="workspace-list">
          {workspaces.map((workspace) => {
            const hasUnreadAttention = workspaceHasUnreadAttention(workspace);

            return (
              <div className="workspace-row" key={workspace.id}>
                <button
                  type="button"
                  className={clsx(
                    "workspace-button",
                    activeView === "project" &&
                      workspace.id === activeWorkspace?.id &&
                      "active",
                    hasUnreadAttention && "has-attention"
                  )}
                  onClick={() => {
                    setSelectedSessionId(null);
                    setActiveWorkspaceId(workspace.id);
                    setActiveView("project");
                  }}
                >
                  <span
                    className={clsx(
                      "attention-dot",
                      !hasUnreadAttention && "attention-dot-empty"
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
            {agentProfiles.map((profile) => (
              <button
                key={profile.kind}
                onClick={() => addSession(profile.kind)}
                style={{ "--agent-accent": profile.accent } as React.CSSProperties}
              >
                <Plus size={14} />
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
                content: (
                  <TerminalPane
                    session={session}
                    profile={getProfile(session.kind)}
                    claimedThreadIds={claimedThreadIds(session.id)}
                    isMaximized={session.id === maximizedSessionId}
                    isArranging={isArranging}
                    onClose={() => closeSession(activeScope, session.id)}
                    onDuplicate={() => duplicateSession(activeScope, session)}
                    onRestart={() => restartSession(activeScope, session)}
                    onAdd={() =>
                      addSessionForCwd(activeScope, session.kind, session.cwd)
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
                  {agentProfiles.map((profile) => (
                    <button
                      key={profile.kind}
                      onClick={() => addSession(profile.kind)}
                    >
                      <Plus size={16} />
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
