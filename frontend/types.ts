export type AgentKind =
  | "terminal"
  | "codex"
  | "claude"
  | "cursor"
  | "gemini"
  | "opencode"
  | "aider"
  | "kimi"
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

export type AgentThreadProvider = "codex" | "claude" | "opencode" | "cursor" | "kimi";

export type AgentLaunchMode = "new" | "resume";

export type FusionClaudeModel = string;

export type FusionCodexModel = string;

// Claude-side effort: the exact `claude --effort` enum plus "auto" (= omit the
// flag). Codex speaks a different family union and each model supports a
// subset; the picker and both runtimes narrow this type against model/list.
export type FusionEffort = "auto" | "low" | "medium" | "high" | "xhigh" | "max";

export type FusionCodexEffort =
  | "auto"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export type FusionRunMode = "auto" | "plan";

// Which CLI family backs a Fusion role. Either role can run either family:
// the planner and executor each pick Claude (claude CLI) or Codex (codex
// app-server) independently — an OpenFusion-style family→model choice, minus
// providers/keys (both families ride the user's existing subscriptions).
export type FusionFamily = "claude" | "codex";

// A role's effort is validated against ITS family's enum (FusionEffort for
// claude, FusionCodexEffort for codex); this union is what the wire carries.
export type FusionRoleEffort = FusionEffort | FusionCodexEffort;

export type OpenFusionModel = string;

export interface FusionSettings {
  mode: FusionRunMode;
  plannerFamily: FusionFamily;
  plannerModel: string;
  plannerEffort: FusionRoleEffort;
  plannerFast: boolean;
  executorFamily: FusionFamily;
  executorModel: string;
  executorEffort: FusionRoleEffort;
  executorFast: boolean;
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
  // than hard-failing on `--resume`. A "found" result carries a titled
  // threadRef, which doubles as the pane's generated-title refresh.
  confirmId?: string;
  // Open Fusion panes look up threads in the app-owned OpenCode store, not the
  // user's global one; main injects the matching env for the discovery host.
  openFusion?: boolean;
  // Fusion resume-picker listings keep to chats the Fusion harness itself
  // created (its headless claude planner records entrypoint "sdk-cli", unlike
  // interactive pane chats).
  fusion?: boolean;
}

// Saved-chat history for the chat panes' resume pickers: every saved chat for
// the pane's folder, newest first. A failure must read as "could not list",
// never as "no saved chats" — the two render differently.
export type AgentThreadListResult =
  | {
      status: "found";
      threads: AgentThreadRef[];
    }
  | {
      status: "failed";
      message?: string;
    };

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
  // A Fusion pane: a planner session that delegates execution to a separate
  // executor engine. Persisted with kind === "claude" for legacy reasons even
  // when the planner family is codex.
  fusion?: boolean;
  fusionPlannerFamily?: FusionFamily;
  fusionPlannerModel?: string;
  fusionPlannerEffort?: FusionRoleEffort;
  fusionPlannerFast?: boolean;
  fusionExecutorFamily?: FusionFamily;
  fusionExecutorModel?: string;
  fusionExecutorEffort?: FusionRoleEffort;
  fusionExecutorFast?: boolean;
  fusionRunMode?: FusionRunMode;
  // Legacy per-engine fields from saved panes that predate per-role families:
  // model/claudeEffort described the (always-claude) planner, codexModel/
  // codexEffort the (always-codex) executor. Read for migration only.
  fusionModel?: FusionClaudeModel;
  fusionCodexModel?: FusionCodexModel;
  fusionClaudeEffort?: FusionEffort;
  fusionCodexEffort?: FusionCodexEffort;
  // Older still: one shared effort for both roles.
  fusionEffort?: FusionEffort;
  // Open Fusion panes are persisted as kind === "opencode" with app-scoped
  // planner/executor config generated at launch time.
  openFusion?: boolean;
  openFusionPlannerModel?: OpenFusionModel;
  openFusionExecutorModel?: OpenFusionModel;
  // Plan/Auto for the Open Fusion pane. Unlike Fusion there is no host-side
  // mode state: the pane sends the mode with every turn and the host picks
  // the opencode agent per prompt.
  openFusionRunMode?: FusionRunMode;
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
  // Detached Fusion/Open Fusion delegations outlive the planner turn that
  // launched them. Their ids keep sidebar working state accurate until each
  // task settles, including across a chat-pane replay/reattach.
  detachedTaskIds?: string[];
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
      providerThreadId?: string;
      providerTurnId?: string;
      attention: AgentAttentionEvent;
    }
  // turnStart false marks mid-turn tool activity (claude PreToolUse/
  // PostToolUse): it may re-assert "working" but must not override a finished
  // done/failed pill (the hook POSTs race the turn's Stop).
  | {
      id: string;
      type: "agent-running";
      provider?: string;
      providerThreadId?: string;
      providerTurnId?: string;
      turnStart?: boolean;
    }
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

// Completion-gate verdict attached by the host tracker (backend/completionGate.cjs)
// to clean turn-settle events: did the planner run an independent check (git
// evidence / read the changed files / investigator pass) after the last
// executor delegation returned? Rendered as a neutral chip on the turn-end row.
export interface CompletionGateVerdict {
  status: "verified" | "unverified";
  // Evidence labels for verified settles, e.g. "git diff", "read changed file".
  evidence?: string[];
  // Epoch ms of the executor return still awaiting a check (unverified only).
  pendingSince?: number;
}

// Normalized events from the headless Claude chat host (backend/fusionChatHost.cjs),
// broadcast on the "fusion-chat:event" channel. All carry the pane id except
// host-error (broadcast to all windows).
// replay: true marks a reattach replay of buffered history (pane remount onto a
// live host session). Replayed events rebuild the pane transcript only — they
// carry no new status/attention information and must not disturb either.
// Detached background delegation lifecycle, shared by both chat modes.
// started/settled are history-recorded (rows + composer pin rebuild on
// replay); progress is transient live ticking only.
export interface BackgroundTaskResult {
  status: "completed" | "failed" | string;
  // Fusion implement / investigate report fields.
  summary?: string;
  findings?: string;
  // Open Fusion executor report text.
  report?: string;
  files?: string[];
  error?: string;
  goalReached?: boolean;
  bugsFound?: string[];
  missingRequirements?: string[];
  nextAction?: string;
  verifierSummary?: string;
}

export type BackgroundTaskEvent =
  | {
      type: "background-task";
      phase: "started";
      taskId: string;
      title: string;
      kind: string;
      // The full delegation prompt (clipped) for the row's expandable report.
      task?: string;
    }
  | {
      type: "background-task";
      phase: "progress";
      taskId: string;
      activityKind: string;
      text: string;
      updates: number;
    }
  | {
      type: "background-task";
      phase: "settled";
      taskId: string;
      title?: string;
      kind?: string;
      cancelled?: boolean;
      // The host/engine died while the task ran (no report exists).
      orphaned?: boolean;
      updates?: number;
      durationMs?: number;
      result: BackgroundTaskResult;
    };

export type BuildTaskEvent =
  | {
      type: "build-task";
      phase: "started";
      buildId: string;
      command: string;
      startedAt: number;
    }
  | {
      type: "build-task";
      phase: "settled";
      buildId: string;
      status: string;
      exitCode: number | null;
      command: string;
    };

export type FusionChatEvent = (
  | { id: string; type: "session"; sessionId: string }
  // backgroundReport marks a host-delivered background-task report wake: the
  // pane renders a collapsible report row, never a user bubble. files (when
  // present) is the completed task's changed-file set (gate latch payload).
  | {
      id: string;
      type: "user";
      text: string;
      steer?: boolean;
      backgroundReport?: boolean;
      taskId?: string;
      title?: string;
      files?: string[];
    }
  | ({ id: string } & BackgroundTaskEvent)
  | ({ id: string } & BuildTaskEvent)
  | { id: string; type: "turn-start" }
  | { id: string; type: "assistant-text"; delta: string }
  | { id: string; type: "thinking"; delta: string }
  | { id: string; type: "tool-call"; toolId: string; name: string; input: unknown }
  // isError mirrors the stream-json tool_result's is_error flag so the pane's
  // OpenCode-style tool rows can settle red instead of guessing from text.
  | {
      id: string;
      type: "tool-result";
      toolId: string;
      text: string;
      isError?: boolean;
      completedBridgeResult?: unknown;
    }
  // Internal completion-gate evidence observation (codex-planner native shell
  // — git evidence, file reads). Panes ignore this type entirely.
  | {
      id: string;
      type: "native-tool";
      name: string;
      command: string;
      actions: unknown[];
      ok: boolean;
    }
  | { id: string; type: "activity"; role: "opus" | "codex"; kind: string; text?: string }
  | { id: string; type: "background-activity"; backgroundActivity: AgentBackgroundActivity }
  | { id: string; type: "turn-end"; awaitsToolResult?: boolean }
  | { id: string; type: "turn-error"; message: string; isError?: boolean; synthetic?: boolean }
  // "/compact" sent as a user message: the CLI runs a compaction pass
  // (system/status status:"compacting" → compact_result success|failed).
  | { id: string; type: "compact-start" }
  | { id: string; type: "compacted"; ok: boolean; error?: string }
  | {
      id: string;
      type: "result";
      subtype?: "restored" | "aborted" | "success" | "error" | (string & {});
      usage?: unknown;
      costUsd?: number;
      isError?: boolean;
      resultText?: string;
      gate?: CompletionGateVerdict;
      synthetic?: boolean;
      reason?: string;
    }
  | { id: string; type: "interrupted" }
  | { id: string; type: "stderr"; text: string }
  | { id: string; type: "error"; message: string }
  | { id: string; type: "closed"; code?: number }
  | { type: "host-error"; message: string }
) & { replay?: boolean };

// Normalized events from the headless OpenCode chat host
// (backend/openFusionChatHost.cjs), broadcast on "openfusion-chat:event". The
// vocabulary mirrors FusionChatEvent with Open Fusion roles: "brain" is the
// planner primary agent; "executor"/"investigator" are its task subagents.
export type OpenFusionChatRole = "brain" | "executor" | "investigator";

// One question inside an opencode question-service request (V1 vocabulary).
export interface OpenFusionQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  // Multi-select: the answer array for this question may carry several labels.
  multiple: boolean;
  // Free-text answers allowed (opencode defaults this to true).
  custom: boolean;
}

// Same replay contract as FusionChatEvent: reattach replays are transcript
// restores, never fresh activity.
export type OpenFusionChatEvent = (
  | { id: string; type: "session"; sessionId: string; resumed?: boolean }
  // The serve is up but the pane's session is deferred to the first input
  // (fresh panes only) — carries the provider-catalog prefetch.
  | { id: string; type: "engine-ready" }
  // queued: sent mid-turn — the server persisted it and the running loop
  // absorbs it at its next step; the pane pins it above the composer until then.
  // mode: the run mode the host actually sent this turn as ("plan" | "auto").
  // Ground truth for plan-accept arming — emitted by the same call that chose
  // the opencode agent, so it stays correct across mid-turn mode flips.
  // backgroundReport: a host-delivered background-task report wake (renders as
  // a collapsible report row, never a user bubble); files arms the gate latch.
  | {
      id: string;
      type: "user";
      text: string;
      queued?: boolean;
      mode?: string;
      backgroundReport?: boolean;
      taskId?: string;
      title?: string;
      files?: string[];
    }
  | ({ id: string } & BackgroundTaskEvent)
  | { id: string; type: "turn-start" }
  // A new Brain step began (new root assistant message): any pinned queued
  // message is now part of the model's context.
  | { id: string; type: "step-start" }
  // A routed steer reached terminal disposition: drop the pinned Queued badge.
  | { id: string; type: "steer-absorbed" }
  // streamId identifies the producing OpenCode part: concurrent streams
  // (parallel subagents, reasoning beside text) must not share a bubble.
  | { id: string; type: "assistant-text"; role: OpenFusionChatRole; delta: string; streamId?: string }
  | { id: string; type: "thinking"; role: OpenFusionChatRole; delta: string; streamId?: string }
  // The producing part finished (snapshot arrived with time.end): the pane
  // retires that bubble's live caret without waiting for the turn to settle.
  | { id: string; type: "stream-end"; role: OpenFusionChatRole; streamId: string }
  | {
      id: string;
      type: "tool-call";
      toolId: string;
      name: string;
      role: OpenFusionChatRole;
      // Producing session — lets the completion-gate tracker attribute child
      // (executor) tool activity to its delegation.
      sessionID?: string;
      // On running task delegations: the spawned child session that can receive
      // best-effort live steering while the Brain's native task call is blocked.
      childSessionId?: string;
      title?: string;
      input: unknown;
    }
  | {
      id: string;
      type: "task-child";
      toolId: string;
      name: "task";
      role: "brain";
      sessionID?: string;
      childSessionId: string;
      agent: "executor" | "investigator" | string;
    }
  | {
      id: string;
      type: "tool-result";
      toolId: string;
      name: string;
      role: OpenFusionChatRole;
      sessionID?: string;
      ok: boolean;
      title?: string;
      text: string;
      // Slim slice of OpenCode's tool state.metadata: edit diffs, glob/grep
      // hit counts — what the OpenCode-style tool rows render.
      meta?: OpenFusionToolMeta;
      // On settled task delegations: the child session whose edit/write paths
      // the completion-gate tracker accumulated.
      childSessionId?: string;
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
  // opencode question service (ask tool, plan_exit): one request can carry
  // SEVERAL questions; answers reply with option labels (or typed text), one
  // array per question, in order.
  | {
      id: string;
      type: "question";
      requestId: string;
      role: OpenFusionChatRole;
      questions: OpenFusionQuestion[];
    }
  | { id: string; type: "question-resolved"; requestId: string }
  // The server compacted the session's context (manual /compact or its own
  // overflow-driven auto-compaction).
  | { id: string; type: "compacted" }
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
      gate?: CompletionGateVerdict;
    }
  | { id: string; type: "steer-route"; message: string }
  | { id: string; type: "interrupted" }
  | { id: string; type: "stderr"; text: string }
  | { id: string; type: "error"; message: string; role?: OpenFusionChatRole }
  | { id: string; type: "closed"; code?: number }
  | { type: "host-error"; message: string }
) & { replay?: boolean };

export interface OpenFusionProvider {
  id: string;
  name: string;
  // OpenCode's provider source: "config" marks a definition from an
  // opencode.json — for Open Fusion panes that is the app-owned global config,
  // i.e. a user-added custom provider (removable, not just disconnectable).
  source?: string;
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

export interface OpenFusionToolMeta {
  diff?: string;
  count?: number;
  matches?: number;
  tone?: "success" | "error" | "muted";
}

export interface TaskVerdict {
  goalReached?: boolean;
  bugs?: number;
  missing?: number;
  nextAction?: "continue" | "done" | "ask_human";
  summary?: string;
  files?: number;
}

// One rendered entry in an Open Fusion pane's chat transcript.
export interface OpenFusionChatMessage {
  key: string;
  role: "user" | OpenFusionChatRole;
  kind:
    | "text"
    // One OpenCode-style row per tool call: created on tool-call, updated in
    // place by the matching tool-result (status/output/meta), like the TUI.
    | "tool"
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
  // kind:"tool" fields (mirrors OpenCode's ToolPart state).
  toolName?: string;
  toolStatus?: "running" | "done" | "error";
  toolInput?: unknown;
  toolOutput?: string;
  meta?: OpenFusionToolMeta;
  // task rows: live progress line (current child tool / toolcall tally) and
  // completion stats, rendered as the "↳ …" second line like OpenCode.
  taskDetail?: string;
  taskRole?: string;
  verdict?: TaskVerdict;
  // kind:"result" rows: completion-gate verdict chip for the settled turn.
  gate?: CompletionGateVerdict;
  // Detached background delegation rows (see OcChatMessage).
  background?: boolean;
  backgroundReport?: boolean;
}

export type ChatRole = "user" | "opus" | "codex";

// One rendered entry in a Fusion pane's chat transcript (ephemeral view-model
// built from the merged Opus stream + Codex activity). Mirrors the shared
// OcChatMessage row model (frontend/components/ocChat.tsx) with Fusion roles.
export interface ChatMessage {
  key: string;
  role: ChatRole;
  kind:
    | "text"
    // One OpenCode-style row per tool call: created on tool-call, updated in
    // place by the matching tool-result (status/output/meta), like the TUI.
    | "tool"
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
  // Internal Fusion bridge/tool mechanics. Hidden in the normal transcript and
  // shown only when the Details toggle is enabled.
  internal?: boolean;
  // kind:"tool" fields (see OcChatMessage).
  toolName?: string;
  toolStatus?: "running" | "done" | "error";
  toolInput?: unknown;
  toolOutput?: string;
  // Row label for codex bridge calls whose raw input isn't self-describing.
  toolTitle?: string;
  meta?: OpenFusionToolMeta;
  // Task (delegation) rows: live "↳ …" progress line / completion stats.
  taskDetail?: string;
  taskRole?: string;
  verdict?: TaskVerdict;
  // kind:"result" rows: completion-gate verdict chip for the settled turn.
  gate?: CompletionGateVerdict;
  // Detached background delegation rows (see OcChatMessage).
  background?: boolean;
  backgroundReport?: boolean;
}
