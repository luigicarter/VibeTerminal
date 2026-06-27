export type AgentKind =
  | "terminal"
  | "codex"
  | "claude"
  | "gemini"
  | "opencode"
  | "aider";

export type AgentThreadProvider = "codex" | "claude" | "opencode";

export type AgentLaunchMode = "new" | "resume";

export type AgentThreadLookupStatus =
  | "idle"
  | "pending"
  | "found"
  | "ambiguous"
  | "failed";

export type SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "waiting"
  | "done"
  | "failed";

export type AgentAttentionState =
  | "none"
  | "waiting"
  | "completed"
  | "failed";

export type AgentAttentionReason =
  | "question"
  | "approval"
  | "done"
  | "exit"
  | "error";

export type AgentAttentionSource =
  | "shim"
  | "provider"
  | "process";

export interface AgentAttention {
  state: AgentAttentionState;
  reason?: AgentAttentionReason;
  unread: boolean;
  updatedAt: number;
  source: AgentAttentionSource;
  message?: string;
}

export interface AgentAttentionEvent {
  state: AgentAttentionState;
  reason?: AgentAttentionReason;
  updatedAt: number;
  source: AgentAttentionSource;
  message?: string;
}

export interface AgentProfile {
  kind: AgentKind;
  label: string;
  command: string;
  accent: string;
}

export interface AgentThreadRef {
  provider: AgentThreadProvider;
  id?: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentThreadLookupPayload {
  provider: AgentThreadProvider;
  cwd: string;
  after?: number;
  excludeIds?: string[];
  // When set, the host confirms whether this exact pre-assigned id is safe to
  // resume (Claude) instead of discovering the latest thread. "missing" means
  // no persisted session exists for the id, so the launcher starts fresh rather
  // than hard-failing on `--resume`.
  confirmId?: string;
}

export type AgentThreadLookupResult =
  | {
      status: "found";
      threadRef: AgentThreadRef;
    }
  | {
      status: "pending" | "failed" | "missing";
      message?: string;
    }
  | {
      status: "ambiguous";
      candidates: AgentThreadRef[];
      message?: string;
    };

export interface LayoutBox {
  x: number;
  y: number;
  w: number;
  h: number;
  unit?: "fluid";
}

export interface AgentSession {
  id: string;
  name: string;
  kind: AgentKind;
  command: string;
  cwd: string;
  createdAt: number;
  threadRef?: AgentThreadRef;
  threadLookupStartedAt?: number;
  threadLookupStatus?: AgentThreadLookupStatus;
  threadLookupMessage?: string;
  nextLaunchMode: AgentLaunchMode;
  started: boolean;
  launchToken: number;
  status: SessionStatus;
  attention?: AgentAttention;
  layout: LayoutBox;
}

export interface ProjectWorkspace {
  id: string;
  name: string;
  path: string;
  sessions: AgentSession[];
}

export type CodeChangeState = "clean" | "dirty" | "not-git" | "unavailable";

export interface CodeChangeSummary {
  state: CodeChangeState;
  cwd: string;
  root?: string;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  changedFiles: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  insertions: number;
  deletions: number;
  updatedAt: number;
  message?: string;
}

export interface TerminalLaunchPayload {
  id: string;
  cwd: string;
  command?: string;
  launchToken?: number;
  cols?: number;
  rows?: number;
}

export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "not-available"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateInfo {
  version?: string;
  releaseName?: string;
  releaseDate?: string;
}

export interface UpdateProgress {
  percent?: number;
  transferred?: number;
  total?: number;
}

export interface UpdateState {
  status: UpdateStatus;
  updatedAt: number;
  info?: UpdateInfo;
  progress?: UpdateProgress;
  errorMessage?: string;
}

export interface UpdateActionResult {
  ok: boolean;
  message?: string;
}

export type TerminalEvent =
  | { type: "ready" }
  | { type: "host-error"; message: string }
  | { type: "host-exit"; message: string }
  | {
      id: string;
      type: "snapshot";
      data: string;
      isRunning: boolean;
      launchToken?: number;
      exitCode?: number;
      signal?: number;
    }
  | { id: string; type: "data"; data: string }
  | {
      id: string;
      type: "agent-attention";
      provider?: string;
      attention: AgentAttentionEvent;
    }
  | {
      id: string;
      type: "agent-telemetry";
      provider?: string;
      event: Record<string, unknown>;
    }
  | { id: string; type: "error"; message: string }
  | { id: string; type: "exit"; exitCode?: number; signal?: number };
