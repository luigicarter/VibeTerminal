export type AgentKind =
  | "terminal"
  | "codex"
  | "claude"
  | "cursor"
  | "gemini"
  | "opencode"
  | "aider"
  // Selection-only kind for the ribbon: a Fusion launch creates a real
  // `kind: "claude"` session with `fusion: true`, so all claude behavior
  // (telemetry, resume, working-state) applies unchanged. No session is ever
  // persisted with kind "fusion".
  | "fusion";

export type AgentThreadProvider = "codex" | "claude" | "opencode" | "cursor";

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
  // Marks the ribbon's Fusion launcher (Opus architect + Codex executor).
  fusion?: boolean;
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
  // A Fusion pane: a claude session that delegates execution to Codex. Always
  // paired with kind === "claude".
  fusion?: boolean;
  cwd: string;
  createdAt: number;
  threadRef?: AgentThreadRef;
  // The previous conversation this pane can deliberately resume. Set when a pane
  // is restored on app reopen (its prior threadRef is moved here so the pane
  // itself launches fresh) or when the user starts a fresh chat over a running
  // one. Undefined means there is nothing to resume.
  resumeRef?: AgentThreadRef;
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
  // When true, the main process provisions Fusion instrumentation for this pane
  // (architect system prompt + Codex delegation). See backend/agentTelemetry.cjs.
  fusion?: boolean;
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
  | { id: string; type: "agent-running"; provider?: string }
  | {
      id: string;
      type: "fusion-activity";
      role: "opus" | "codex";
      kind: string;
      text?: string;
      ts?: number;
    }
  | { id: string; type: "error"; message: string }
  | { id: string; type: "exit"; exitCode?: number; signal?: number };

// One read-only entry in a Fusion pane's role-tagged activity log (Opus
// delegations + Codex's streamed work). Ephemeral per launch; never persisted.
export interface FusionLogEntry {
  role: "opus" | "codex";
  kind: string;
  text: string;
  ts: number;
}

// Normalized events from the headless Claude chat host (backend/fusionChatHost.cjs),
// broadcast on the "fusion-chat:event" channel. All carry the pane id except
// host-error (broadcast to all windows).
export type FusionChatEvent =
  | { id: string; type: "session"; sessionId: string }
  | { id: string; type: "turn-start" }
  | { id: string; type: "assistant-text"; delta: string }
  | { id: string; type: "thinking"; delta: string }
  | { id: string; type: "tool-call"; toolId: string; name: string; input: unknown }
  | { id: string; type: "tool-result"; toolId: string; text: string }
  | { id: string; type: "turn-end" }
  | { id: string; type: "result"; subtype?: string; costUsd?: number }
  | { id: string; type: "stderr"; text: string }
  | { id: string; type: "error"; message: string }
  | { id: string; type: "closed"; code?: number }
  | { type: "host-error"; message: string };

export type ChatRole = "user" | "opus" | "codex";

// One rendered entry in a Fusion pane's chat transcript (ephemeral view-model
// built from the merged Opus stream + Codex activity).
export interface ChatMessage {
  key: string;
  role: ChatRole;
  kind: "text" | "tool-call" | "tool-result" | "thinking" | "activity" | "result" | "error";
  text: string;
  toolId?: string;
  ts: number;
  streaming?: boolean;
}
