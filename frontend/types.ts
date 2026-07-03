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
  | "fusion"
  // Selection-only kind for the ribbon: an Open Fusion launch creates a real
  // `kind: "opencode"` session with `openFusion: true`, so OpenCode terminal
  // behavior and thread discovery stay unchanged while the app injects a
  // pane-scoped OpenCode config.
  | "openfusion";

export type AgentThreadProvider = "codex" | "claude" | "opencode" | "cursor";

export type AgentLaunchMode = "new" | "resume";

export type FusionClaudeModel = string;

export type FusionCodexModel = string;

// Claude-side effort: the exact `claude --effort` enum plus "auto" (= omit the
// flag). Codex speaks a DIFFERENT enum — verified against the codex 0.142
// binary: minimal|low|medium|high|xhigh|ultra, with NO "max". Sharing one type
// let the UI offer Codex a "max" it rejects, which broke every delegation.
export type FusionEffort = "auto" | "low" | "medium" | "high" | "xhigh" | "max";

export type FusionCodexEffort =
  | "auto"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "ultra";

export type FusionRunMode = "auto" | "plan";

export type OpenFusionModel = string;

export interface FusionSettings {
  mode: FusionRunMode;
  model: FusionClaudeModel;
  codexModel: FusionCodexModel;
  claudeEffort: FusionEffort;
  codexEffort: FusionCodexEffort;
}

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

export type AgentBackgroundActivitySource = "opus" | "codex";

export interface AgentBackgroundActivityItem {
  id: string;
  label: string;
  detail?: string;
  source?: AgentBackgroundActivitySource;
}

export interface AgentBackgroundActivity {
  active: boolean;
  count: number;
  updatedAt: number;
  source?: AgentBackgroundActivitySource;
  items?: AgentBackgroundActivityItem[];
}

export interface AgentProfile {
  kind: AgentKind;
  label: string;
  command: string;
  accent: string;
  // Marks the ribbon's Fusion launcher (Opus architect + Codex executor).
  fusion?: boolean;
  // Marks the ribbon's Open Fusion launcher (OpenCode planner + executor).
  openFusion?: boolean;
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
  // Open Fusion panes look up threads in the app-owned OpenCode store, not the
  // user's global one; main injects the matching env for the discovery host.
  openFusion?: boolean;
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
  fusionModel?: FusionClaudeModel;
  fusionCodexModel?: FusionCodexModel;
  fusionClaudeEffort?: FusionEffort;
  fusionCodexEffort?: FusionCodexEffort;
  fusionRunMode?: FusionRunMode;
  // Legacy shared effort field from older saved Fusion panes. New panes store
  // separate Opus/Codex effort values but keep this readable for migration.
  fusionEffort?: FusionEffort;
  // Open Fusion panes are persisted as kind === "opencode" with app-scoped
  // planner/executor config generated at launch time.
  openFusion?: boolean;
  openFusionPlannerModel?: OpenFusionModel;
  openFusionExecutorModel?: OpenFusionModel;
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
  backgroundActivity?: AgentBackgroundActivity;
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
  // When true, the main process writes a pane-scoped OpenCode config and TUI
  // theme, then exposes it through OPENCODE_* env vars for this terminal only.
  openFusion?: boolean;
  openFusionPlannerModel?: OpenFusionModel | string;
  openFusionExecutorModel?: OpenFusionModel | string;
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
  currentVersion?: string;
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
  | { type: "host-error"; id?: string; message: string }
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
  // turnStart false marks mid-turn tool activity (claude PreToolUse/
  // PostToolUse): it may re-assert "working" but must not override a finished
  // done/failed pill (the hook POSTs race the turn's Stop).
  | { id: string; type: "agent-running"; provider?: string; turnStart?: boolean }
  | {
      id: string;
      type: "agent-background-activity";
      provider?: string;
      backgroundActivity: AgentBackgroundActivity;
    }
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
  | { id: string; type: "user"; text: string; steer?: boolean }
  | { id: string; type: "turn-start" }
  | { id: string; type: "assistant-text"; delta: string }
  | { id: string; type: "thinking"; delta: string }
  | { id: string; type: "tool-call"; toolId: string; name: string; input: unknown }
  | { id: string; type: "tool-result"; toolId: string; text: string }
  | { id: string; type: "activity"; role: "opus" | "codex"; kind: string; text?: string }
  | { id: string; type: "background-activity"; backgroundActivity: AgentBackgroundActivity }
  | { id: string; type: "turn-end" }
  | { id: string; type: "turn-error"; message: string }
  | {
      id: string;
      type: "result";
      subtype?: string;
      costUsd?: number;
      isError?: boolean;
      resultText?: string;
    }
  | { id: string; type: "interrupted" }
  | { id: string; type: "stderr"; text: string }
  | { id: string; type: "error"; message: string }
  | { id: string; type: "closed"; code?: number }
  | { type: "host-error"; message: string };

// Normalized events from the headless OpenCode chat host
// (backend/openFusionChatHost.cjs), broadcast on "openfusion-chat:event". The
// vocabulary mirrors FusionChatEvent with Open Fusion roles: "brain" is the
// planner primary agent; "executor"/"investigator" are its task subagents.
export type OpenFusionChatRole = "brain" | "executor" | "investigator";

export type OpenFusionChatEvent =
  | { id: string; type: "session"; sessionId: string; resumed?: boolean }
  | { id: string; type: "user"; text: string }
  | { id: string; type: "turn-start" }
  | { id: string; type: "assistant-text"; role: OpenFusionChatRole; delta: string }
  | { id: string; type: "thinking"; role: OpenFusionChatRole; delta: string }
  | {
      id: string;
      type: "tool-call";
      toolId: string;
      name: string;
      role: OpenFusionChatRole;
      title?: string;
      input: unknown;
    }
  | {
      id: string;
      type: "tool-result";
      toolId: string;
      name: string;
      role: OpenFusionChatRole;
      ok: boolean;
      title?: string;
      text: string;
    }
  | {
      id: string;
      type: "permission";
      requestId: string;
      role: OpenFusionChatRole;
      permission: string;
      patterns: string[];
      title?: string;
    }
  | { id: string; type: "permission-resolved"; requestId: string; reply: string }
  | {
      id: string;
      type: "auth-result";
      ok: boolean;
      providerId: string;
      action: "connect" | "disconnect";
      nonce?: string;
      message?: string;
    }
  | {
      id: string;
      type: "oauth-authorize";
      ok: boolean;
      providerId: string;
      nonce?: string;
      flow?: "code" | "auto";
      url?: string;
      instructions?: string;
      message?: string;
    }
  | {
      id: string;
      type: "providers";
      ok: boolean;
      message?: string;
      connected?: OpenFusionProvider[];
      available?: { id: string; name: string }[];
      // False when GET /provider (the full catalog) failed even though the
      // connected list loaded — the picker must say so instead of silently
      // showing connected-only.
      catalogOk?: boolean;
      // Per-provider auth methods from GET /provider/auth. Providers absent
      // from this map connect with the default single API-key method.
      authMethods?: Record<string, OpenFusionAuthMethod[]>;
    }
  | {
      id: string;
      type: "result";
      subtype?: string;
      costUsd?: number;
      tokens?: { input: number; output: number; reasoning: number };
    }
  | { id: string; type: "interrupted" }
  | { id: string; type: "stderr"; text: string }
  | { id: string; type: "error"; message: string; role?: OpenFusionChatRole }
  | { id: string; type: "closed"; code?: number }
  | { type: "host-error"; message: string };

export interface OpenFusionProvider {
  id: string;
  name: string;
  models: { id: string; name: string }[];
}

// Mirrors OpenCode's provider auth-method metadata (GET /provider/auth):
// prompts are extra fields a method needs before it can run (e.g. Cloudflare
// accountId for API-key auth, GitHub deployment type for OAuth).
export interface OpenFusionAuthPrompt {
  type: "text" | "select";
  key: string;
  message: string;
  placeholder?: string;
  options?: { label: string; value: string; hint?: string }[];
}

export interface OpenFusionAuthMethod {
  type: "api" | "oauth";
  label: string;
  prompts?: OpenFusionAuthPrompt[];
}

// One rendered entry in an Open Fusion pane's chat transcript.
export interface OpenFusionChatMessage {
  key: string;
  role: "user" | OpenFusionChatRole;
  kind:
    | "text"
    | "tool-call"
    | "tool-result"
    | "thinking"
    | "activity"
    | "result"
    | "error";
  text: string;
  toolId?: string;
  ts: number;
  streaming?: boolean;
  // Tool mechanics hidden unless the Details toggle is enabled.
  internal?: boolean;
}

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
  // Internal Fusion bridge/tool mechanics. Hidden in the normal transcript and
  // shown only when the Details toggle is enabled.
  internal?: boolean;
}
