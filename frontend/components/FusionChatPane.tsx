import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Ban,
  Check,
  CopyPlus,
  GripVertical,
  Maximize2,
  Minimize2,
  Play,
  Plus,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
  XCircle
} from "lucide-react";
import clsx from "clsx";
import { shouldShowAttentionDot } from "../attention";
import type {
  AgentAttentionEvent,
  AgentBackgroundActivity,
  AgentProfile,
  AgentSession,
  AgentThreadRef,
  ChatMessage,
  CompletionGateVerdict,
  FusionChatEvent,
  FusionFamily,
  FusionRunMode,
  FusionSettings,
  SessionStatus
} from "../types";
import {
  buildFusionPicker,
  buildSlashMenu,
  familyDisplayName,
  familyEffortLabel,
  familyEffortValues,
  familyMaxEffort,
  FUSION_SPEED_VALUES,
  fusionRoleModelLabel,
  isValidFamilyModelId,
  normalizeFusionFamily,
  normalizeFusionRoleEffort,
  normalizeFusionRoleModel,
  normalizeFusionRoleSettings,
  resolveModelArgument,
  scopeEffortValues,
  type FusionPickerState,
  type FusionRoleScope,
  type FusionSpeedPreset,
  type SlashMenu,
  type SlashMenuItem
} from "./fusionSlashMenu";
import {
  OC_LOGO_FUSION,
  OcChatRow,
  OcLogo,
  OcSpinner,
  asRecord,
  clip,
  firstString,
  formatDurationShort
} from "./ocChat";

interface FusionChatPaneProps {
  session: AgentSession;
  profile: AgentProfile;
  // Thread ids active in OTHER panes: the resume picker marks them and refuses
  // to open the same conversation twice (two panes writing one session id).
  claimedThreadIds?: string[];
  isMaximized: boolean;
  isSelected: boolean;
  onClose: () => void;
  onDuplicate: () => void;
  onRestart: () => void;
  // Bare call resumes the stashed last chat; with a threadRef it resumes that
  // specific saved chat (the resume picker's selection).
  onResume: (threadRef?: AgentThreadRef) => void;
  onClear: () => void;
  onSettingsChange: (settings: FusionSettings) => void;
  onAdd: () => void;
  onSelect: () => void;
  onMaximize: () => void;
  onThreadRefChange: (threadRef: AgentThreadRef) => void;
  onStatusChange: (status: SessionStatus) => void;
  onAttention: (attention: AgentAttentionEvent) => void;
}

const DEFAULT_FUSION_RUN_MODE: FusionRunMode = "auto";
const FUSION_RUN_MODE_LABELS: Record<FusionRunMode, string> = {
  auto: "Auto",
  plan: "Plan"
};

// The pane's picker is either the family→model drill-in (fusionSlashMenu's
// state) or the saved-chat resume picker: null = list still loading. `error`
// renders as "couldn't read" — an error must never masquerade as "no saved
// chats".
type FusionPanePickerState =
  | FusionPickerState
  | { resume: AgentThreadRef[] | null; error?: string };

// Rows shown per picker page before the "N more — keep typing" hint row (the
// list scrolls; this only bounds render size and keeps truncation VISIBLE).
const RESUME_PICKER_PAGE_SIZE = 24;

// Ages for the resume picker rows ("just now", "5m ago", "3d ago").
function formatThreadAge(updatedAt: number): string {
  const timestamp = Number(updatedAt) || 0;
  const age = Date.now() - timestamp;
  if (!timestamp || !Number.isFinite(age) || age < 0) {
    return "";
  }
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
const FUSION_COMPOSER_MAX_PX = 160;
const MAX_COMPOSER_PATHS = 32;
const IMPLEMENT_PLAN_PROMPT = "Implement the plan.";

interface ComposerFileRef {
  path: string;
  kind: "text" | "image" | "directory" | "file" | "missing";
  label: string;
  lineCount?: number;
}

interface FileWithPath extends File {
  path?: string;
}

function cleanPastedPathToken(value: string) {
  let text = value.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith("<") && text.endsWith(">"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function isPlausiblePathToken(value: string) {
  const text = cleanPastedPathToken(value);
  if (!text) return false;
  return (
    /^file:\/\//i.test(text) ||
    /^[A-Za-z]:[\\/]/.test(text) ||
    /^\\\\/.test(text) ||
    text.startsWith("/") ||
    text.startsWith("./") ||
    text.startsWith("../") ||
    text.startsWith("~") ||
    (/[\\/]/.test(text) && !/[<>|?*]/.test(text))
  );
}

function uniqueComposerPaths(paths: string[]) {
  const seen = new Set<string>();
  return paths
    .map(cleanPastedPathToken)
    .filter(Boolean)
    .filter((pathValue) => {
      const key = pathValue.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_COMPOSER_PATHS);
}

function pathsFromPlainText(text: string) {
  const paths = uniqueComposerPaths(text.split(/\r?\n/));
  if (paths.length === 0 || !paths.every(isPlausiblePathToken)) {
    return [];
  }
  return paths;
}

function pathsFromFileList(
  files: FileList,
  getPathForFile?: (file: File) => string
) {
  return uniqueComposerPaths(
    Array.from(files).map((file) => {
      try {
        return getPathForFile?.(file) || (file as FileWithPath).path || "";
      } catch {
        return (file as FileWithPath).path || "";
      }
    })
  );
}

function formatComposerFileRef(ref: ComposerFileRef) {
  return `${ref.path} ${ref.label}`;
}

function padComposerInsertion(text: string, before: string, after: string) {
  let insertion = text;
  if (before && !/\s$/.test(before)) {
    insertion = `\n${insertion}`;
  }
  if (after && !/^\s/.test(after)) {
    insertion = `${insertion}\n`;
  }
  return insertion;
}


function normalizeFusionRunMode(value: unknown): FusionRunMode {
  return String(value || "").trim().toLowerCase() === "plan" ? "plan" : DEFAULT_FUSION_RUN_MODE;
}

function fusionRunModeLabel(value: FusionRunMode) {
  return FUSION_RUN_MODE_LABELS[value];
}

function fusionSettingsSummary(settings: FusionSettings) {
  const planner = `${familyDisplayName(settings.plannerFamily)} ${fusionRoleModelLabel(settings.plannerFamily, settings.plannerModel)}`;
  const executor = `${familyDisplayName(settings.executorFamily)} ${fusionRoleModelLabel(settings.executorFamily, settings.executorModel)}`;
  const plannerFast = settings.plannerFast ? "on" : "off";
  const executorFast = settings.executorFast ? "on" : "off";
  return `Mode ${fusionRunModeLabel(settings.mode)} · Planning ${planner} · Planning effort ${familyEffortLabel(settings.plannerFamily, String(settings.plannerEffort))} · Planning fast ${plannerFast} · Execution ${executor} · Execution effort ${familyEffortLabel(settings.executorFamily, String(settings.executorEffort))} · Execution fast ${executorFast}`;
}

interface ToolMeta {
  name: string;
  isCodexBridge: boolean;
  isGoalTool: boolean;
}

interface PendingFusionDecision {
  pendingId: string;
  kind: string;
  detail: string;
}

type FusionActiveRole = "claude" | "codex";
const FUSION_SPEAKER_LABEL = "Fusion";

// Opus makes every tool call. Fusion bridge calls are plumbing; Codex's
// user-facing voice is the concise result/status we derive from those calls.
function isCodexBridgeTool(name: string): boolean {
  return /codex_investigate|codex_implement|codex_respond|codex_steer_resolve/.test(name);
}

function isCodexGoalTool(name: string): boolean {
  return /codex_goal_(?:set|get|clear)/.test(name);
}

// Claude Code's plan-ready signal. ExitPlanMode is only registered when the
// session runs in a real plan permission mode; the host relays it as a tool call
// by name, so we can treat it as the definitive "plan presented" event alongside
// the prose heuristic.
function isExitPlanTool(name: string): boolean {
  const base = name.replace(/^mcp__[^_]+__/, "");
  return base === "ExitPlanMode" || base === "exit_plan_mode";
}

function isInternalActivity(kind: string): boolean {
  return ["delegate", "decision", "goal", "warmup"].includes(kind);
}

function fusionRoleLabel(_role: FusionActiveRole) {
  return FUSION_SPEAKER_LABEL;
}

function formatBackgroundActivityTitle(activity: AgentBackgroundActivity | null) {
  if (!activity || activity.count <= 0) {
    return "";
  }

  const header =
    activity.count === 1
      ? "Background agent running"
      : `${activity.count} background agents running`;
  const details = (activity.items ?? [])
    .slice(0, 4)
    .map((item) => {
      const label = item.label || "Background agent";
      return item.detail ? `${label}: ${clip(item.detail, 160)}` : label;
    })
    .filter(Boolean);

  return details.length ? [header, ...details].join("\n") : header;
}

// Claude Code tool names → the OpenCode row vocabulary the shared OcChatRow
// glyphs/labels key on. Fusion's Claude surface is Read/Glob/Grep/Edit/Write
// plus the codex_* bridge; unknown names fall through lowercased (generic ⚙).
const CLAUDE_TOOL_NAME_MAP: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  Edit: "edit",
  Write: "write",
  NotebookEdit: "edit",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  TodoWrite: "todowrite",
  TodoRead: "todoread",
  Task: "task",
  Agent: "task"
};

function ocToolName(name: string) {
  const base = name.replace(/^mcp__[^_]+__/, "");
  return CLAUDE_TOOL_NAME_MAP[base] ?? base.toLowerCase();
}

// The two bridge calls that ARE delegations: they render as OpenCode Task rows
// ("Executor Task — description"), not as inline tool one-liners.
function isDelegationTool(name: string): boolean {
  return /codex_(?:investigate|implement)$/.test(name);
}

// Row labels for bridge mechanics whose raw input isn't self-describing —
// the shared row renders these instead of the generic "name [k=v]" form.
function bridgeToolTitle(name: string, input: unknown): string | undefined {
  const data = asRecord(input);
  if (name.endsWith("codex_goal_set")) return "Goal updated";
  if (name.endsWith("codex_goal_get")) return "Goal checked";
  if (name.endsWith("codex_goal_clear")) return "Goal cleared";
  if (name.endsWith("codex_cancel")) return "Cancel delegation";
  if (name.endsWith("codex_steer_resolve")) {
    return `Resolve steer · ${firstString(data.decision) || "push"}`;
  }
  if (name.endsWith("codex_respond")) {
    const note = firstString(data.note);
    return `Respond · ${firstString(data.decision) || "decision"}${note ? ` — ${clip(note, 80)}` : ""}`;
  }
  if (isExitPlanTool(name)) return "Plan ready";
  return undefined;
}

// Pseudo-unified diff for Edit rows. Claude's Edit input carries the exact
// old/new strings; there is no host metadata channel like OpenCode's, so the
// pane derives the panel body itself (capped — the row is a summary, not a
// diff viewer).
const EDIT_DIFF_MAX_LINES = 80;

function buildEditDiff(input: unknown): string | undefined {
  const data = asRecord(input);
  const oldText = typeof data.old_string === "string" ? data.old_string : "";
  const newText = typeof data.new_string === "string" ? data.new_string : "";
  if (!oldText && !newText) return undefined;
  const strip = (text: string) => text.replace(/\n$/, "").split("\n");
  const lines = [
    ...(oldText ? strip(oldText).map((line) => `-${line}`) : []),
    ...(newText ? strip(newText).map((line) => `+${line}`) : [])
  ];
  if (lines.length > EDIT_DIFF_MAX_LINES) {
    const over = lines.length - EDIT_DIFF_MAX_LINES;
    return [
      ...lines.slice(0, EDIT_DIFF_MAX_LINES),
      `@@ … ${over} more line${over === 1 ? "" : "s"} @@`
    ].join("\n");
  }
  return lines.join("\n");
}

// The delegation Task row's click-to-expand report, composed from the codex
// bridge's JSON reply (findings/summary, touched files, verifier verdict).
function codexTaskReport(parsed: Record<string, unknown> | null, raw: string): string {
  if (!parsed) return clip(raw ?? "", 8000);
  if (parsed.status === "steer_routing") {
    const parts: string[] = [];
    const userSteer = firstString(parsed.userSteer);
    if (userSteer) parts.push(`**User steer**\n${userSteer}`);
    const progress = asRecord(parsed.executorProgress);
    const lastActivity = firstString(progress.lastActivity);
    if (lastActivity) parts.push(`**Executor still running**\n${lastActivity}`);
    const files = Array.isArray(progress.filesTouched)
      ? progress.filesTouched.filter((file): file is string => typeof file === "string")
      : [];
    if (files.length) {
      parts.push(["**Files touched so far**", ...files.map((file) => `- ${file}`)].join("\n"));
    }
    const partialSummary = firstString(progress.partialSummary);
    if (partialSummary && partialSummary !== lastActivity) {
      parts.push(`**Partial summary**\n${partialSummary}`);
    }
    const guidance = firstString(parsed.guidance);
    if (guidance) parts.push(guidance);
    return parts.join("\n\n") || clip(raw ?? "", 8000);
  }
  const parts: string[] = [];
  const summary = firstString(parsed.findings, parsed.summary, parsed.verifierSummary);
  if (summary) parts.push(summary);
  const detail = firstString(parsed.detail);
  if (detail && detail !== summary) parts.push(detail);
  const files = Array.isArray(parsed.files)
    ? parsed.files.filter((file): file is string => typeof file === "string")
    : [];
  if (files.length) {
    parts.push(["**Files**", ...files.map((file) => `- ${file}`)].join("\n"));
  }
  const verdict = firstString(parsed.verifierVerdict);
  if (verdict && verdict !== summary) parts.push(`**Verifier:** ${verdict}`);
  return parts.join("\n\n") || clip(raw ?? "", 8000);
}

// The delegation's stashed side-channel lines, rendered as a fenced "Activity"
// block appended to the Task report. Kept out of the inline transcript so a
// long run doesn't explode into one "↳ …" sibling per Codex tool call — the
// Task row shows a single rolling line + "N updates", and this is the detail
// revealed on click. Newlines are flattened so each activity stays one line.
function activityLogBlock(activities: string[]): string {
  if (!activities.length) return "";
  const log = activities
    .map((line) => clip(line.replace(/\s*\n\s*/g, " "), 200))
    .join("\n");
  return `**Activity**\n\`\`\`\n${log}\n\`\`\``;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function formatCodexBridgeResult(name: string, text: string): string {
  const parsed = parseJsonObject(text);
  if (!parsed) return previewToolResult(text);

  if (isCodexGoalTool(name)) {
    const goal = parsed.goal as Record<string, unknown> | null | undefined;
    const status = typeof goal?.status === "string" ? goal.status : String(parsed.status ?? "updated");
    return `goal ${status}`;
  }

  const status = String(parsed.status ?? "");
  if (status === "needs_decision") {
    const kind = String(parsed.kind ?? "decision");
    const detail = String(parsed.detail ?? "Decision needed.");
    return `needs ${kind}: ${clip(detail, 180)}`;
  }

  if (status === "steer_routing") {
    return `route steer: ${clip(String(parsed.userSteer ?? "User steering is pending."), 180)}`;
  }

  if (status === "steer_replan_ready") {
    return "ready to replan";
  }

  if (status === "completed") {
    if (name.endsWith("codex_investigate")) {
      const findings = String(parsed.findings ?? "investigation finished");
      const files = Array.isArray(parsed.files) ? parsed.files.length : 0;
      return `findings: ${clip(findings, 220)}${files ? ` · ${files} file${files === 1 ? "" : "s"}` : ""}`;
    }
    const rawSummary =
      parsed.summary ?? parsed.verifierSummary ?? parsed.verifierVerdict ?? "implementation pass finished";
    const summary =
      typeof rawSummary === "string"
        ? rawSummary
        : JSON.stringify(rawSummary);
    const files = Array.isArray(parsed.files) ? parsed.files.length : 0;
    const verdict =
      parsed.goalReached === true
        ? "verified"
        : parsed.nextAction === "ask_human"
          ? "needs input"
          : "needs follow-up";
    return `${verdict}: ${clip(summary, 220)}${files ? ` · ${files} file${files === 1 ? "" : "s"}` : ""}`;
  }

  if (status === "failed" || status === "error") {
    return `failed: ${clip(String(parsed.error ?? "Request failed."), 220)}`;
  }

  if (status === "ok" || status === "skipped") {
    return status;
  }

  return previewToolResult(text);
}

function pendingFusionDecisionFromResult(
  parsed: Record<string, unknown> | null
): PendingFusionDecision | null {
  if (!parsed || parsed.status !== "needs_decision") return null;
  const pendingId = typeof parsed.pendingId === "string" ? parsed.pendingId.trim() : "";
  if (!pendingId) return null;
  return {
    pendingId,
    kind: typeof parsed.kind === "string" && parsed.kind ? parsed.kind : "decision",
    detail: typeof parsed.detail === "string" && parsed.detail ? parsed.detail : "Fusion needs a decision."
  };
}

function fusionDecisionInstruction(
  pending: PendingFusionDecision,
  decision: "accept" | "acceptForSession" | "decline" | "cancel",
  note?: string
) {
  const action =
    decision === "acceptForSession"
      ? "Approve this request for the session"
      : decision === "accept"
        ? pending.kind === "question"
          ? "Answer this question"
          : "Approve this request"
        : decision === "decline"
          ? "Decline this request"
          : "Cancel this request";
  const args = [
    `pendingId: "${pending.pendingId}"`,
    `decision: "${decision}"`,
    note ? `note: ${JSON.stringify(note)}` : ""
  ].filter(Boolean);
  return [
    `${action}.`,
    `Call codex_respond with ${args.join(", ")} now, then continue the same Fusion task.`
  ].join(" ");
}

// Collapsed one-line preview of a tool result; the full text shows on expand
// (Claude-Code style), so nothing is lost — it's just folded away by default.
function previewToolResult(text: string): string {
  const line = (text ?? "")
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);
  return line ? clip(line, 120) : "(no output)";
}

function titleFromFirstPrompt(text: string) {
  return clip(text.replace(/\s+/g, " ").trim(), 80);
}

export default function FusionChatPane({
  session,
  profile,
  claimedThreadIds,
  isMaximized,
  isSelected,
  onClose,
  onDuplicate,
  onRestart,
  onResume,
  onClear,
  onSettingsChange,
  onAdd,
  onSelect,
  onMaximize,
  onThreadRefChange,
  onStatusChange,
  onAttention
}: FusionChatPaneProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<PendingFusionDecision | null>(null);
  const [interrupting, setInterrupting] = useState(false);
  // Messages sent mid-turn (steering). Claude already has them on stdin; they
  // stay pinned above the composer — the same QUEUED mechanic as the Open
  // Fusion pane — until the next assistant message (the next API call, whose
  // context includes them) absorbs them, then they join the transcript at that
  // point instead of drowning mid-stream.
  const [steering, setSteering] = useState<{ key: string; text: string }[]>([]);
  const [activeRole, setActiveRole] = useState<FusionActiveRole>("claude");
  const [slashIndex, setSlashIndex] = useState(0);
  // Esc hides the menu for the CURRENT input without erasing what the user
  // typed (it used to wipe the whole command). Any input change re-arms it.
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  // Open Fusion-style state picker: /planner-model and /executor-model open a
  // family→model drill-in; /resume opens the saved-chat picker. While one is
  // open the composer input only filters.
  const [picker, setPicker] = useState<FusionPanePickerState>(null);
  const resumeListRequestRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Follow the stream only while the user is at the bottom — auto-scroll used
  // to yank the view down on EVERY delta, which made reading scrollback during
  // a turn impossible. Scrolling back to the bottom re-pins.
  const pinnedToBottomRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // Keeps the highlighted slash-menu row visible when the list scrolls.
  const activeMenuItemRef = useRef<HTMLLIElement | null>(null);
  const inputRef = useRef("");
  const keyRef = useRef(0);
  const interruptingRef = useRef(false);
  const pendingRestartNoticeRef = useRef<string | null>(null);
  const waitingForDecisionRef = useRef(false);
  const decisionTurnLabelsRef = useRef(new Map<string, string>());
  const onThreadRefChangeRef = useRef(onThreadRefChange);
  const onStatusChangeRef = useRef(onStatusChange);
  const onAttentionRef = useRef(onAttention);
  const busyRef = useRef(false);
  // Event-handler mirror of `steering` (the handler closure is frozen at mount).
  const steeringRef = useRef<{ key: string; text: string }[]>([]);
  const pendingSteerFlushRef = useRef<string | null>(null);
  const toolRoleRef = useRef(new Map<string, ToolMeta>());
  const claudeSessionIdRef = useRef("");
  const claudeThreadTitleRef = useRef("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // OpenCode's /details defaults ON: tool rows are part of the transcript.
  const [verbose, setVerbose] = useState(true);
  // Last turn's cost — the composer status row's right-side readout.
  const [usage, setUsage] = useState<{ costUsd?: number } | null>(null);
  // Turn wall-clock start, for the "▣ Fusion · model · 32s" completion line.
  const turnStartRef = useRef(0);
  // The running codex delegation (the bridge runs one at a time): its Task
  // row's key plus the side-channel tally that powers the "↳ …" live line.
  const delegationRef = useRef<{
    key: string;
    toolId: string;
    startTs: number;
    toolcalls: number;
    // Raw side-channel lines, stashed for the Task row's click-to-expand
    // report instead of being spilled as per-activity "↳ …" worklines.
    activities: string[];
  } | null>(null);
  const [planActionReady, setPlanActionReady] = useState(false);
  const [implementingPlan, setImplementingPlan] = useState(false);
  const [modeSwitching, setModeSwitching] = useState(false);
  const [modeFlash, setModeFlash] = useState(false);
  // Stable identity so memoized rows don't re-render when the pane does.
  const toggleExpanded = useCallback(
    (key: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    []
  );
  // Per-role family/model/effort settings, normalized with legacy-field
  // migration (old panes stored model/claudeEffort = the always-claude
  // planner, codexModel/codexEffort = the always-codex executor).
  const roleSettings = normalizeFusionRoleSettings({
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
  const {
    plannerFamily,
    plannerModel,
    plannerEffort,
    plannerFast,
    executorFamily,
    executorModel,
    executorEffort,
    executorFast
  } = roleSettings;
  const fusionRunMode = normalizeFusionRunMode(session.fusionRunMode);
  const fusionRunModeText = fusionRunModeLabel(fusionRunMode);
  const fusionModelLabel = fusionRoleModelLabel(plannerFamily, plannerModel);
  const executorModelLabel = fusionRoleModelLabel(executorFamily, executorModel);
  const fusionSettingsLine = fusionSettingsSummary({
    mode: fusionRunMode,
    ...roleSettings
  });
  const activeRoleLabel = fusionRoleLabel(activeRole);
  const inputIsSlashCommand = input.trim().startsWith("/");
  const showAttention = shouldShowAttentionDot(session);
  const backgroundActivity =
    session.backgroundActivity?.active && session.backgroundActivity.count > 0
      ? session.backgroundActivity
      : null;
  const backgroundActivityTitle = formatBackgroundActivityTitle(backgroundActivity);
  // Resume only makes sense within the SAME planner family — a claude thread
  // id means nothing to a codex planner and vice versa.
  const canResumeClaude =
    session.resumeRef?.provider === plannerFamily && Boolean(session.resumeRef.id);
  const slashMenuContext = roleSettings;
  // Saved-chat picker rows: title + age, newest first, chats open in other
  // panes marked, typed input only filters. Mirrors the Open Fusion picker.
  const buildResumeMenu = (): SlashMenu => {
    if (!picker || !("resume" in picker)) {
      return { title: "", items: [] };
    }
    if (picker.resume === null) {
      return { title: "Resume a chat — reading saved chats…", items: [] };
    }
    const filter = input.trim().toLowerCase();
    const claimed = new Set(claimedThreadIds ?? []);
    const currentId = claudeSessionIdRef.current || session.threadRef?.id || "";
    const threads = picker.resume.filter(
      (thread) =>
        thread.id &&
        thread.id !== currentId &&
        (!filter ||
          (thread.title ?? "").toLowerCase().includes(filter) ||
          thread.id.toLowerCase().includes(filter))
    );
    const items: SlashMenuItem[] = threads
      .slice(0, RESUME_PICKER_PAGE_SIZE)
      .map((thread) => ({
        key: `resume-${thread.id}`,
        label: clip(thread.title?.trim() || "Untitled chat", 80),
        desc: claimed.has(thread.id!)
          ? "open in another pane"
          : formatThreadAge(thread.updatedAt),
        command: `__resume:${thread.id}`
      }));
    if (threads.length > RESUME_PICKER_PAGE_SIZE) {
      items.push({
        key: "resume-more",
        label: `… ${threads.length - RESUME_PICKER_PAGE_SIZE} more`,
        desc: "Keep typing to filter the list"
      });
    }
    // Listing failed but the pane still stashes its last chat: offer that
    // directly instead of a dead end.
    if (picker.error && canResumeClaude) {
      items.push({
        key: "resume-last",
        label: "Resume last chat",
        desc: clip(
          session.resumeRef?.title?.trim() || "the most recent saved chat",
          60
        ),
        command: "__resume-last"
      });
    }
    if (!items.length) {
      items.push({
        key: "resume-empty",
        label: picker.error
          ? "Couldn't read saved chats"
          : filter
            ? "No saved chats match"
            : "No saved Fusion chats for this folder",
        desc:
          picker.error ??
          "Chats appear here once a Fusion conversation has started."
      });
    }
    return { title: "Resume a chat — type to filter", items };
  };
  const slashMenu = picker
    ? "resume" in picker
      ? buildResumeMenu()
      : buildFusionPicker(picker, input, slashMenuContext)
    : buildSlashMenu(input, slashMenuContext);
  const slashMenuOpen = picker !== null || (slashMenu.items.length > 0 && !slashMenuDismissed);
  // OpenCode's /details-off rule: successful completed tool rows disappear,
  // running/failed rows stay, delegations (task) stay. Everything tagged
  // internal (Codex worklines, bridge mechanics, stderr) needs details on.
  const visibleMessages = verbose
    ? messages
    : messages.filter((message) => {
        if (message.kind === "tool") {
          return message.toolName === "task" || message.toolStatus !== "done";
        }
        return !message.internal;
      });
  // Per-turn cost readout is hidden by default: on a Claude subscription the
  // reported total_cost_usd is an API-equivalent value, not an actual charge,
  // so showing a "$" reads misleadingly as a bill. Flip to true to restore it.
  const SHOW_FUSION_COST = false;
  const usageLabel =
    usage && typeof usage.costUsd === "number" && usage.costUsd > 0
      ? `$${usage.costUsd.toFixed(2)}`
      : "";
  // Footer path, OpenCode-style: parent muted, folder name bright.
  const cwdSplit = (() => {
    const norm = String(session.cwd || "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
    const idx = norm.lastIndexOf("/");
    return idx > 0
      ? { parent: norm.slice(0, idx + 1), name: norm.slice(idx + 1) }
      : { parent: "", name: norm };
  })();
  const pendingDecisionIsQuestion = pendingDecision?.kind === "question";
  const showPlanActionBar =
    planActionReady && fusionRunMode === "plan" && !busy && !waiting && !pendingDecision;
  const fusionRunModeRef = useRef(fusionRunMode);
  // Current planning-model label, readable from the session-scoped event
  // handler (its closure is frozen at mount) for the turn-completion line.
  const fusionModelLabelRef = useRef(fusionModelLabel);
  fusionModelLabelRef.current = fusionModelLabel;
  // Planner family, readable from the frozen event handler: the published
  // thread ref's provider must track the ACTIVE planner family.
  const plannerFamilyRef = useRef<FusionFamily>(plannerFamily);
  plannerFamilyRef.current = plannerFamily;
  const planResponseModeRef = useRef<FusionRunMode>("auto");
  const planResponseHadTextRef = useRef(false);
  const planExitSignaledRef = useRef(false);
  const previousRunModeRef = useRef(fusionRunMode);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    fusionRunModeRef.current = fusionRunMode;
  }, [fusionRunMode]);

  useEffect(() => {
    if (previousRunModeRef.current === fusionRunMode) {
      return undefined;
    }
    previousRunModeRef.current = fusionRunMode;
    setModeFlash(true);
    const timer = window.setTimeout(() => setModeFlash(false), 650);
    return () => window.clearTimeout(timer);
  }, [fusionRunMode]);

  useEffect(() => {
    onThreadRefChangeRef.current = onThreadRefChange;
    onStatusChangeRef.current = onStatusChange;
    onAttentionRef.current = onAttention;
  }, [onThreadRefChange, onStatusChange, onAttention]);

  // Auto-grow the composer up to a cap, then scroll — so multi-line prompts are
  // fully visible instead of being clipped to a single scrolling row.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const resize = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, FUSION_COMPOSER_MAX_PX)}px`;
    };
    resize();
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(resize);
    if (el.parentElement) {
      observer.observe(el.parentElement);
    }
    return () => observer.disconnect();
  }, [input, isMaximized]);

  // Reset the highlighted command (and re-arm a dismissed menu) whenever the
  // typed token or the picker stage changes.
  useEffect(() => {
    setSlashIndex(0);
    setSlashMenuDismissed(false);
  }, [input, picker]);

  useEffect(() => {
    activeMenuItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [slashIndex]);

  const nextKey = () => `m${keyRef.current++}`;
  const push = (entry: Omit<ChatMessage, "key" | "ts"> & { ts?: number }) => {
    const key = nextKey();
    setMessages((prev) => [...prev, { key, ts: Date.now(), ...entry }]);
    return key;
  };
  const queueSteering = (text: string) => {
    steeringRef.current = [...steeringRef.current, { key: nextKey(), text }];
    setSteering(steeringRef.current);
  };
  // Move pinned steering into the transcript — at the absorption point (next
  // assistant message) it lands exactly where it entered Claude's context; at
  // a turn boundary it lands last, right above the composer. The "Steer:"
  // prefix keeps the existing transcript labeling for mid-turn direction.
  const flushSteering = () => {
    const items = steeringRef.current;
    if (!items.length) return;
    steeringRef.current = [];
    setSteering([]);
    setMessages((prev) => [
      ...prev,
      ...items.map((item) => ({
        key: item.key,
        role: "user" as const,
        kind: "text" as const,
        text: `Steer: ${item.text}`,
        ts: Date.now()
      }))
    ]);
  };
  const setBusyState = (next: boolean) => {
    busyRef.current = next;
    setBusy(next);
  };
  const setWaitingState = (next: boolean) => {
    waitingForDecisionRef.current = next;
    setWaiting(next);
  };
  const clearPendingDecision = () => setPendingDecision(null);
  const setInterruptingState = (next: boolean) => {
    interruptingRef.current = next;
    setInterrupting(next);
  };
  const emitAttention = (
    state: AgentAttentionEvent["state"],
    reason: AgentAttentionEvent["reason"],
    message?: string
  ) => {
    onAttentionRef.current({
      state,
      reason,
      source: "provider",
      updatedAt: Date.now(),
      message
    });
  };

  function publishClaudeThreadRef() {
    const claudeSessionId = claudeSessionIdRef.current;
    if (!claudeSessionId) {
      return;
    }

    onThreadRefChangeRef.current({
      // The planner owns the pane's conversation thread: claude session ids
      // for a claude planner, codex thread ids for a codex planner.
      provider: plannerFamilyRef.current,
      id: claudeSessionId,
      // Never fall back to the pane's placeholder label ("Fusion 2") — the
      // title stays empty until a real prompt-derived one exists.
      title: claudeThreadTitleRef.current || session.threadRef?.title,
      createdAt: session.threadRef?.createdAt ?? session.createdAt,
      updatedAt: Date.now()
    });
  }

  // (Re)attach to the headless Claude process on launch. The host owns the
  // process lifetime; unmounting this view should not stop a Fusion pane when
  // the user switches projects.
  useEffect(() => {
    if (!session.started) {
      return;
    }
    const restartNotice = pendingRestartNoticeRef.current;
    pendingRestartNoticeRef.current = null;
    // A restart drops the in-flight turn: anything still pinned as steering
    // was already written to Claude's stdin, so surface it in the kept
    // transcript instead of vanishing it (fresh starts clear everything below).
    flushSteering();
    // A settings restart resumes the same Claude thread — keep the visible
    // transcript and append the notice. Wiping it read as data loss for what
    // is conceptually the same conversation. Fresh starts still clear.
    setMessages((prev) =>
      restartNotice
        ? [
            ...prev,
            {
              key: nextKey(),
              role: "opus",
              kind: "activity",
              text: restartNotice,
              ts: Date.now()
            }
          ]
        : []
    );
    setExpanded(new Set());
    toolRoleRef.current.clear();
    delegationRef.current = null;
    turnStartRef.current = 0;
    setUsage(null);
    setActiveRole("claude");
    setWaitingState(false);
    setInterruptingState(false);
    setBusyState(false);
    setFailed(false);
    setPlanActionReady(false);
    setImplementingPlan(false);
    planResponseModeRef.current = fusionRunModeRef.current;
    planResponseHadTextRef.current = false;
    planExitSignaledRef.current = false;
    // Every fresh-launch path (create/restart/resume/clear/settings-restart/
    // boot restore) resets status to "idle" before this effect runs, so
    // anything else means a remount onto a LIVE host session (project switch
    // back). The reattach replay is status-neutral, so stomping the settled
    // done/waiting/failed pill with "starting" here would never be corrected.
    if (session.status === "idle" || session.status === "starting") {
      onStatusChangeRef.current("starting");
    }
    let cancelled = false;
    const resumeThreadRef =
      session.nextLaunchMode === "resume" &&
      session.threadRef?.provider === plannerFamily &&
      session.threadRef.id
        ? session.threadRef
        : undefined;
    claudeSessionIdRef.current = resumeThreadRef?.id ?? "";
    claudeThreadTitleRef.current = resumeThreadRef?.title ?? "";
    const resumeId = resumeThreadRef?.id;
    const fusionChat = window.vibe?.fusionChat;
    if (!fusionChat?.start) {
      const message = "Fusion unavailable: fusion chat bridge is not available.";
      push({ role: "opus", kind: "error", text: message });
      emitAttention("failed", "error", message);
      return;
    }
    const startTimer = window.setTimeout(() => {
      void (async () => {
        if (cancelled) {
          return;
        }

        // A Fusion resume id is only resumable once Claude has persisted a
        // transcript for it (at least one exchanged message). Resuming a stale
        // or never-persisted id makes the headless `claude --resume` child exit
        // immediately, which surfaces here as "Fusion process exited with code
        // 1" and a dead pane. Confirm the id first and self-heal to a fresh
        // chat — the same contract TerminalPane's resolveLaunchCommand uses.
        let effectiveResumeId = resumeId;
        if (resumeId && plannerFamily === "claude" && window.vibe?.agentThreads) {
          try {
            const confirm = await window.vibe.agentThreads.findLatest({
              provider: "claude",
              cwd: session.cwd,
              confirmId: resumeId
            });
            if (confirm?.status === "missing") {
              effectiveResumeId = undefined;
              claudeSessionIdRef.current = "";
              claudeThreadTitleRef.current = "";
              push({
                role: "opus",
                kind: "activity",
                text: "The saved Fusion chat is no longer available to resume. Starting a fresh chat instead."
              });
            }
          } catch {
            // Confirmation unavailable (host down/timeout): attempt the resume
            // rather than discard a conversation that may well exist.
          }
        }

        if (cancelled) {
          return;
        }

        const startPayload = {
          id: session.id,
          cwd: session.cwd,
          resumeId: effectiveResumeId,
          mode: fusionRunMode,
          plannerFamily,
          executorFamily,
          plannerFast,
          executorFast,
          // "auto" means "let the engine use its default" — omit rather than
          // sending a literal the CLIs would treat as a model id.
          ...(plannerModel === "auto" ? {} : { model: plannerModel }),
          ...(executorModel === "auto" ? {} : { executorModel }),
          ...(plannerEffort === "auto" ? {} : { effort: plannerEffort }),
          ...(executorEffort === "auto" ? {} : { executorEffort })
        };
        fusionChat
          .start(startPayload)
          .then((result) => {
            if (cancelled || !result || result.ok !== false) return;
            const message = `Fusion unavailable: ${result.error}`;
            push({ role: "opus", kind: "error", text: message });
            emitAttention("failed", "error", message);
          });
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.launchToken, session.started]);

  // Merge the Opus stream (fusion-chat) and the Codex side-channel (fusion-activity).
  useEffect(() => {
    // Stream deltas are BATCHED: each one used to be its own setMessages (its
    // own render + forced scroll layout), so a fast stream re-rendered the
    // whole transcript dozens of times a second — the choppiness. Deltas now
    // buffer and flush at most once per animation frame; every non-delta event
    // flushes synchronously first so transcript ordering never changes.
    const pendingDeltas: { kind: "text" | "thinking"; delta: string }[] = [];
    let deltaFlushHandle: number | null = null;
    const applyDeltaBatch = () => {
      if (!pendingDeltas.length) return;
      const batch = pendingDeltas.splice(0, pendingDeltas.length);
      setMessages((prev) => {
        let next: ChatMessage[] | null = null;
        for (const { kind, delta } of batch) {
          if (kind === "thinking" && !delta.trim()) continue;
          const arr = (next ??= prev.slice());
          // Append to the open bubble while it is the latest message, so a
          // single content block streams as ONE coherent paragraph (no
          // mid-call shred). A tool chip or a kind switch starts a fresh
          // bubble — chronological, Claude-Code style. Close any other open
          // bubble so only one caret shows.
          const last = arr[arr.length - 1];
          if (last && last.role === "opus" && last.kind === kind && last.streaming) {
            arr[arr.length - 1] = { ...last, text: last.text + delta };
            continue;
          }
          for (let i = 0; i < arr.length; i += 1) {
            if (arr[i].role === "opus" && arr[i].streaming) {
              arr[i] = { ...arr[i], streaming: false };
            }
          }
          arr.push({
            key: nextKey(),
            role: "opus",
            kind,
            text: delta,
            ts: Date.now(),
            streaming: true
          });
        }
        return next ?? prev;
      });
    };
    const flushDeltas = () => {
      if (deltaFlushHandle !== null) {
        cancelAnimationFrame(deltaFlushHandle);
        deltaFlushHandle = null;
      }
      applyDeltaBatch();
    };
    const appendStreaming = (kind: "text" | "thinking", delta: string) => {
      pendingDeltas.push({ kind, delta });
      if (deltaFlushHandle === null) {
        deltaFlushHandle = requestAnimationFrame(() => {
          deltaFlushHandle = null;
          applyDeltaBatch();
        });
      }
    };
    const stopStreaming = () =>
      setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
    // An abort/exit leaves tool rows spinning forever — settle them as aborted
    // (the same rule the Open Fusion pane applies).
    const settleRunningTools = () => {
      // Preserve the interrupted delegation's stashed activity list: with the
      // per-activity worklines gone, this report is the only place it survives.
      const aborted = delegationRef.current;
      const abortedBlock = aborted ? activityLogBlock(aborted.activities) : "";
      delegationRef.current = null;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.kind !== "tool" || m.toolStatus !== "running") return m;
          const toolOutput =
            aborted && m.key === aborted.key && abortedBlock
              ? [m.toolOutput, abortedBlock].filter(Boolean).join("\n\n")
              : m.toolOutput || "aborted";
          return { ...m, toolStatus: "error" as const, toolOutput };
        })
      );
    };
    // OpenCode's turn-completion line: "▣ Fusion · Opus 4.8 · 32s".
    const pushTurnEnd = (interrupted: boolean, gate?: CompletionGateVerdict) => {
      const duration = turnStartRef.current ? Date.now() - turnStartRef.current : 0;
      turnStartRef.current = 0;
      push({
        role: "opus",
        kind: "result",
        text: FUSION_SPEAKER_LABEL,
        taskDetail: [
          fusionModelLabelRef.current,
          duration ? formatDurationShort(duration) : "",
          interrupted ? "interrupted" : ""
        ]
          .filter(Boolean)
          .join(" · "),
        gate
      });
    };

    const handleChat = (event: FusionChatEvent) => {
      if (!("id" in event) || event.id !== session.id) {
        if (event.type === "host-error") {
          push({ role: "opus", kind: "error", text: event.message });
          setInterruptingState(false);
          setBusyState(false);
          emitAttention("failed", "error", event.message);
        }
        return;
      }
      // Reattach replay rebuilds this pane's transcript and local flags after
      // a remount, but App's lifecycle mirror tracked the live events the
      // whole time — re-emitting status/attention from replayed history would
      // re-latch "done" and re-light an attention dot the user already
      // acknowledged.
      const replay = event.replay === true;
      const reportStatus: typeof onStatusChangeRef.current = (status) => {
        if (!replay) onStatusChangeRef.current(status);
      };
      const reportAttention: typeof emitAttention = (state, reason, message) => {
        if (!replay) emitAttention(state, reason, message);
      };
      if (event.type !== "assistant-text" && event.type !== "thinking") {
        flushDeltas();
      }
      switch (event.type) {
        case "session":
          claudeSessionIdRef.current = event.sessionId;
          publishClaudeThreadRef();
          break;
        case "user":
          if (!event.steer) {
            setPlanActionReady(false);
            planResponseModeRef.current = fusionRunModeRef.current;
            planResponseHadTextRef.current = false;
            planExitSignaledRef.current = false;
          }
          if (
            !event.steer &&
            !decisionTurnLabelsRef.current.has(event.text) &&
            !claudeThreadTitleRef.current
          ) {
            claudeThreadTitleRef.current = titleFromFirstPrompt(event.text);
            publishClaudeThreadRef();
          }

          if (decisionTurnLabelsRef.current.has(event.text)) {
            const label = decisionTurnLabelsRef.current.get(event.text) || "Decision sent.";
            decisionTurnLabelsRef.current.delete(event.text);
            push({ role: "user", kind: "text", text: label });
          } else if (event.steer) {
            // Mid-turn steering: pin above the composer until Claude's next
            // assistant message absorbs it — pushed inline it drowned in the
            // stream (the Open Fusion pane pins the same way).
            queueSteering(event.text);
          } else {
            push({ role: "user", kind: "text", text: event.text });
          }
          break;
        case "turn-start":
          // Each assistant message is one API call; a steer written before it
          // is in this call's context — absorbed, so it joins the transcript
          // here.
          flushSteering();
          // One answer spans several assistant messages: only the first one
          // starts the wall clock for the "▣ Fusion · …" completion line.
          if (!turnStartRef.current) {
            turnStartRef.current = Date.now();
          }
          setActiveRole("claude");
          setInterruptingState(false);
          setWaitingState(false);
          setFailed(false);
          clearPendingDecision();
          setBusyState(true);
          reportStatus("running");
          // One answer spans several assistant messages (a turn-start each); add
          // a paragraph break when text continues straight into the next message.
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (
              last &&
              last.role === "opus" &&
              last.kind === "text" &&
              last.streaming &&
              last.text &&
              !last.text.endsWith("\n")
            ) {
              const copy = prev.slice();
              copy[copy.length - 1] = { ...last, text: `${last.text}\n\n` };
              return copy;
            }
            return prev;
          });
          break;
        case "assistant-text":
          setActiveRole("claude");
          if (event.delta.trim()) {
            planResponseHadTextRef.current = true;
          }
          appendStreaming("text", event.delta);
          break;
        case "thinking":
          setActiveRole("claude");
          appendStreaming("thinking", event.delta);
          break;
        case "tool-call": {
          // Opus is the actor for every call. Record bridge metadata so the
          // result can be voiced as concise Codex implementation status.
          const isCodexBridge = isCodexBridgeTool(event.name);
          const isGoalTool = isCodexGoalTool(event.name);
          setActiveRole(isCodexBridge ? "codex" : "claude");
          // Honor Claude Code's ExitPlanMode as a first-class plan-ready trigger.
          // Dormant under the current acceptEdits mode (the tool isn't registered),
          // exact the moment a real plan permission mode is enabled.
          if (isExitPlanTool(event.name)) {
            planExitSignaledRef.current = true;
          }
          toolRoleRef.current.set(event.toolId, {
            name: event.name,
            isCodexBridge,
            isGoalTool
          });
          // One OpenCode-style row per call; the matching tool-result updates
          // it in place (status → done/error, output, meta).
          if (isDelegationTool(event.name)) {
            // Delegations are OpenCode Task rows ("Executor Task — …") with a
            // live "↳ …" line ticked by the Codex side-channel activity.
            const scout = event.name.endsWith("codex_investigate");
            const key = push({
              role: "codex",
              kind: "tool",
              text: "",
              toolId: event.toolId,
              toolName: "task",
              toolStatus: "running",
              toolInput: {
                subagent_type: scout ? "scout" : "executor",
                description:
                  firstString(asRecord(event.input).task) ||
                  (scout ? "investigation" : "implementation")
              }
            });
            delegationRef.current = {
              key,
              toolId: event.toolId,
              startTs: Date.now(),
              toolcalls: 0,
              activities: []
            };
            break;
          }
          push({
            role: "opus",
            kind: "tool",
            text: "",
            toolId: event.toolId,
            toolName: ocToolName(event.name),
            toolStatus: "running",
            toolInput: event.input,
            toolTitle: bridgeToolTitle(event.name, event.input)
          });
          break;
        }
        case "tool-result": {
          const meta = toolRoleRef.current.get(event.toolId);
          const fromCodex = meta?.isCodexBridge ?? false;
          setActiveRole(fromCodex ? "codex" : "claude");
          const parsed = meta ? parseJsonObject(event.text ?? "") : null;
          const needsDecision =
            fromCodex &&
            parsed &&
            (parsed.status === "needs_decision" || parsed.nextAction === "ask_human");
          const failed =
            Boolean(event.isError) ||
            (parsed ? parsed.status === "failed" || parsed.status === "error" : false);
          const isDelegation = Boolean(meta && isDelegationTool(meta.name));
          // Delegation rows expose the bridge's JSON as a readable report;
          // other bridge calls keep the concise status line; Claude's builtin
          // tools keep their raw output for the row body.
          // Completed delegations get OpenCode's "↳ N updates · 12s" line, and
          // their click-to-expand report carries the full activity list — the
          // per-command lines aren't shown inline anymore (see "activity").
          const delegation =
            delegationRef.current?.toolId === event.toolId ? delegationRef.current : null;
          let output = isDelegation
            ? codexTaskReport(parsed, event.text ?? "")
            : meta && (fromCodex || meta.isGoalTool || meta.name.endsWith("codex_cancel"))
              ? formatCodexBridgeResult(meta.name, event.text ?? "")
              : clip(event.text ?? "", 8000);
          let taskDetail: string | undefined;
          if (delegation) {
            const duration = formatDurationShort(Date.now() - delegation.startTs);
            taskDetail =
              delegation.toolcalls > 0
                ? `${delegation.toolcalls} update${delegation.toolcalls === 1 ? "" : "s"} · ${duration}`
                : duration;
            const block = activityLogBlock(delegation.activities);
            if (block) output = `${output}\n\n${block}`.trim();
            delegationRef.current = null;
          }
          setMessages((prev) =>
            prev.map((row) => {
              if (
                row.kind !== "tool" ||
                row.toolId !== event.toolId ||
                row.toolStatus !== "running"
              ) {
                return row;
              }
              return {
                ...row,
                toolStatus: failed ? ("error" as const) : ("done" as const),
                toolOutput: output || undefined,
                // Edit rows render OpenCode's diff panel; the input carries
                // the exact old/new strings, so derive it on completion.
                meta:
                  row.toolName === "edit" && !failed
                    ? { diff: buildEditDiff(row.toolInput) }
                    : row.meta,
                taskDetail: taskDetail ?? row.taskDetail
              };
            })
          );
          if (needsDecision) {
            setPendingDecision(pendingFusionDecisionFromResult(parsed));
            setWaitingState(true);
            setBusyState(false);
            reportStatus("waiting");
            reportAttention(
              "waiting",
              parsed.status === "needs_decision" ? "approval" : "question",
              meta ? formatCodexBridgeResult(meta.name, event.text ?? "") : ""
            );
          } else if (fromCodex && parsed) {
            clearPendingDecision();
            setWaitingState(false);
          }
          break;
        }
        case "activity": {
          setActiveRole(event.role === "codex" ? "codex" : "claude");
          const kind = event.kind || "";
          const text = event.text ?? "";
          const delegation = delegationRef.current;
          if (
            event.role === "codex" &&
            delegation &&
            (kind === "command" || kind === "file" || kind === "message")
          ) {
            // The Codex side-channel IS the delegation's live progress: tick
            // the Task row's single "↳ …" line (like OpenCode's "↳ current
            // tool") and stash the raw line for the click-to-expand report.
            // We deliberately do NOT push a per-activity workline here — that
            // flattened every Codex tool call into its own sibling "↳ …" line,
            // duplicating the "N updates" summary and burying the parent Task.
            // The full activity list now lives inside the delegation report.
            delegation.toolcalls += 1;
            const detail = kind === "command" ? `$ ${clip(text, 80)}` : clip(text, 80);
            delegation.activities.push(kind === "command" ? `$ ${text}` : text);
            setMessages((prev) =>
              prev.map((row) =>
                row.key === delegation.key ? { ...row, taskDetail: detail } : row
              )
            );
            break;
          }
          // Internal bridge mechanics outside a running turn are engine
          // chatter (the pre-turn "warmup: execution bridge ready" note) —
          // with /details defaulting ON they would replace the hero on a
          // fresh pane. warmup_error is NOT internal and always lands.
          const internal = isInternalActivity(kind);
          if (internal && !busyRef.current) {
            break;
          }
          push({
            role: event.role,
            kind: "activity",
            text: `${kind ? `${kind}: ` : ""}${text}`,
            internal
          });
          if (event.kind === "warmup_error") {
            const message = event.text || "Fusion execution bridge failed to start.";
            setInterruptingState(false);
            setWaitingState(false);
            setBusyState(false);
            setFailed(true);
            clearPendingDecision();
            reportStatus("failed");
            reportAttention("failed", "error", message);
          }
          break;
        }
        case "turn-end":
          // Keep the Opus bubble open across assistant-message seams; it is
          // closed on `result`/`closed` so the whole answer stays together.
          break;
        case "compact-start":
          push({ role: "opus", kind: "activity", text: "Compacting context…" });
          break;
        case "compacted":
          push({
            role: "opus",
            kind: event.ok ? "activity" : "error",
            text: event.ok
              ? "Context compacted."
              : `Compaction failed: ${event.error || "unknown error"}`
          });
          break;
        case "turn-error":
          // A non-streamed error (e.g. the picked model is unavailable for
          // this account) — surface it instead of ending the turn silently,
          // but keep the session alive: the next /claude pick can fix it.
          setActiveRole("claude");
          stopStreaming();
          push({
            role: "opus",
            kind: "error",
            text: /model/i.test(event.message)
              ? `${event.message} — the planning model may be unavailable to this account. Pick another with /claude.`
              : event.message
          });
          break;
        case "result":
          setActiveRole("claude");
          stopStreaming();
          // Steering that never got absorbed (turn ended first) still reached
          // Claude's history — surface it as the freshest entry, right above
          // the composer, instead of dropping it.
          flushSteering();
          setInterruptingState(false);
          setBusyState(false);
          if (typeof event.costUsd === "number" && event.costUsd > 0) {
            setUsage({ costUsd: event.costUsd });
          }
          // Rehydration settle: a restored transcript is not a finished turn —
          // no completion line, no attention, no plan-bar arming.
          if (event.subtype === "restored") {
            turnStartRef.current = 0;
            reportStatus("idle");
            break;
          }
          if (event.isError) {
            settleRunningTools();
            turnStartRef.current = 0;
            if (event.resultText) {
              push({
                role: "opus",
                kind: "error",
                text: /model/i.test(event.resultText)
                  ? `${event.resultText} — the planning model may be unavailable to this account. Pick another with /claude.`
                  : event.resultText
              });
            }
            reportAttention("failed", "error", event.resultText || "Turn failed.");
            break;
          }
          pushTurnEnd(false, event.gate);
          if (waitingForDecisionRef.current) {
            reportStatus("waiting");
          } else {
            if (
              fusionRunModeRef.current === "plan" &&
              (planExitSignaledRef.current ||
                (planResponseModeRef.current === "plan" &&
                  planResponseHadTextRef.current))
            ) {
              setPlanActionReady(true);
            }
            reportAttention("completed", "done");
          }
          break;
        case "interrupted":
          if (pendingSteerFlushRef.current) {
            const steerText = pendingSteerFlushRef.current;
            pendingSteerFlushRef.current = null;
            steeringRef.current = [];
            setSteering([]);
            setActiveRole("claude");
            stopStreaming();
            settleRunningTools();
            setInterruptingState(false);
            setWaitingState(false);
            setFailed(false);
            clearPendingDecision();
            setPlanActionReady(false);
            window.vibe?.fusionChat?.sendUserTurn(session.id, steerText);
            setBusyState(true);
            onStatusChangeRef.current("running");
            break;
          }
          setActiveRole("claude");
          stopStreaming();
          settleRunningTools();
          // A steer queued before the interrupt is still on Claude's stdin
          // history — flush it under the marker as the freshest entry so the
          // user sees it will lead the next turn.
          flushSteering();
          setInterruptingState(false);
          setWaitingState(false);
          setFailed(false);
          clearPendingDecision();
          setPlanActionReady(false);
          setBusyState(false);
          reportStatus("waiting");
          pushTurnEnd(true);
          break;
        case "stderr": {
          // Only mid-turn stderr is work product for the details lane. The
          // claude CLI prints launch-time warnings (e.g. deny-rule hints)
          // before any turn — with /details defaulting ON those would replace
          // the hero on a fresh pane. Real launch failures surface through
          // the error/closed events, not stderr.
          const text = event.text.trim();
          if (text && busyRef.current) {
            push({ role: "opus", kind: "activity", text, internal: true });
          }
          break;
        }
        case "error":
          setActiveRole("claude");
          stopStreaming();
          settleRunningTools();
          turnStartRef.current = 0;
          flushSteering();
          setInterruptingState(false);
          setWaitingState(false);
          push({ role: "opus", kind: "error", text: event.message });
          setBusyState(false);
          setFailed(true);
          clearPendingDecision();
          setPlanActionReady(false);
          reportAttention("failed", "error", event.message);
          break;
        case "closed":
          setActiveRole("claude");
          stopStreaming();
          settleRunningTools();
          turnStartRef.current = 0;
          flushSteering();
          setInterruptingState(false);
          if (event.code != null && event.code !== 0) {
            const message = `Fusion process exited with code ${event.code}.`;
            setBusyState(false);
            setFailed(true);
            clearPendingDecision();
            setPlanActionReady(false);
            push({ role: "opus", kind: "error", text: message });
            reportAttention("failed", "exit", message);
          } else if (busyRef.current) {
            const message = "Fusion process closed before returning a result.";
            setBusyState(false);
            setFailed(true);
            clearPendingDecision();
            setPlanActionReady(false);
            push({ role: "opus", kind: "error", text: message });
            reportAttention("failed", "exit", message);
          } else {
            setBusyState(false);
          }
          break;
        default:
          break;
      }
    };

    const offChat = window.vibe?.fusionChat?.onEvent(handleChat as (e: unknown) => void);
    return () => {
      offChat?.();
      if (deltaFlushHandle !== null) {
        cancelAnimationFrame(deltaFlushHandle);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleChatScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  function applySettings(settings: Partial<FusionSettings>, label = "settings") {
    const nextPlannerFamily = normalizeFusionFamily(settings.plannerFamily, plannerFamily);
    const nextExecutorFamily = normalizeFusionFamily(settings.executorFamily, executorFamily);
    // Validate BEFORE anything restarts: an unknown planning model previously
    // relaunched the pane into `claude --model <typo>`, which exits
    // immediately — a dead pane with the transcript replaced by a notice.
    if (
      typeof settings.plannerModel === "string" &&
      !isValidFamilyModelId(nextPlannerFamily, settings.plannerModel)
    ) {
      push({
        role: "opus",
        kind: "error",
        text:
          nextPlannerFamily === "claude"
            ? `'${settings.plannerModel}' is not a Claude model this pane can launch. Use opus, sonnet, or a full claude-* model id.`
            : `'${settings.plannerModel}' is not a launchable Codex model id.`
      });
      return;
    }
    if (
      typeof settings.executorModel === "string" &&
      !isValidFamilyModelId(nextExecutorFamily, settings.executorModel)
    ) {
      push({
        role: "opus",
        kind: "error",
        text:
          nextExecutorFamily === "claude"
            ? `'${settings.executorModel}' is not a Claude model this pane can launch. Use opus, sonnet, or a full claude-* model id.`
            : `'${settings.executorModel}' is not a launchable Codex model id.`
      });
      return;
    }
    // A family flip without an explicit model lands on that family's default;
    // efforts always re-normalize against the TARGET family so a saved level
    // survives the flip at the nearest real value instead of failing turns.
    const plannerFamilyChanged = nextPlannerFamily !== plannerFamily;
    const executorFamilyChanged = nextExecutorFamily !== executorFamily;
    const nextSettings: FusionSettings = {
      mode: normalizeFusionRunMode(settings.mode ?? fusionRunMode),
      plannerFamily: nextPlannerFamily,
      plannerModel: normalizeFusionRoleModel(
        nextPlannerFamily,
        "planner",
        settings.plannerModel ?? (plannerFamilyChanged ? undefined : plannerModel)
      ),
      plannerEffort: normalizeFusionRoleEffort(
        nextPlannerFamily,
        settings.plannerEffort ?? plannerEffort
      ),
      plannerFast: settings.plannerFast ?? plannerFast,
      executorFamily: nextExecutorFamily,
      executorModel: normalizeFusionRoleModel(
        nextExecutorFamily,
        "executor",
        settings.executorModel ?? (executorFamilyChanged ? undefined : executorModel)
      ),
      executorEffort: normalizeFusionRoleEffort(
        nextExecutorFamily,
        settings.executorEffort ?? executorEffort
      ),
      executorFast: settings.executorFast ?? executorFast
    };
    if (
      nextSettings.mode === fusionRunMode &&
      nextSettings.plannerFamily === plannerFamily &&
      nextSettings.plannerModel === plannerModel &&
      nextSettings.plannerEffort === plannerEffort &&
      nextSettings.plannerFast === plannerFast &&
      nextSettings.executorFamily === executorFamily &&
      nextSettings.executorModel === executorModel &&
      nextSettings.executorEffort === executorEffort &&
      nextSettings.executorFast === executorFast
    ) {
      pushCommandStatus(`Already using ${fusionSettingsSummary(nextSettings)}.`);
      return;
    }
    // Planner family/model/effort changes relaunch the planner process; fast
    // toggles and executor changes apply live.
    const requiresRestart =
      nextSettings.plannerFamily !== plannerFamily ||
      nextSettings.plannerModel !== plannerModel ||
      nextSettings.plannerEffort !== plannerEffort;
    const notice = session.started
      ? requiresRestart
        ? `${busyRef.current ? "Interrupting current turn and restarting" : "Restarting"} Fusion with ${fusionSettingsSummary(nextSettings)}.`
        : `Updated Fusion ${label} live: ${fusionSettingsSummary(nextSettings)}. Next executor turn will use it.`
      : `Saved Fusion ${label}: ${fusionSettingsSummary(nextSettings)}.`;
    pendingRestartNoticeRef.current = session.started && requiresRestart ? notice : null;
    pushCommandStatus(notice);
    onSettingsChange(nextSettings);
  }

  async function applyRunMode(nextMode: FusionRunMode) {
    const mode = normalizeFusionRunMode(nextMode);
    if (mode === fusionRunMode) {
      return true;
    }

    const nextSettings: FusionSettings = {
      mode,
      ...roleSettings
    };

    setPlanActionReady(false);

    if (session.started) {
      const setMode = window.vibe?.fusionChat?.setMode;
      if (!setMode) {
        push({ role: "opus", kind: "error", text: "Fusion unavailable: mode bridge is not available." });
        return false;
      }
      setModeSwitching(true);
      try {
        const result = await setMode(session.id, mode);
        if (result && result.ok === false) {
          push({ role: "opus", kind: "error", text: `Could not set Fusion mode: ${result.error || "unknown error"}` });
          return false;
        }
        onSettingsChange(nextSettings);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        push({ role: "opus", kind: "error", text: `Could not set Fusion mode: ${message}` });
        return false;
      } finally {
        setModeSwitching(false);
      }
    }

    onSettingsChange(nextSettings);
    return true;
  }

  function toggleRunMode() {
    if (modeSwitching || implementingPlan) return;
    void applyRunMode(fusionRunMode === "plan" ? "auto" : "plan");
  }

  function applySlashSelection(item: SlashMenuItem | undefined) {
    if (!item) return;
    const command = item.command || "";
    // Saved-chat picker rows: resume the picked conversation (refusing one
    // that is already open in another pane).
    if (command.startsWith("__resume:")) {
      const threadId = command.slice("__resume:".length);
      const thread =
        picker && "resume" in picker && picker.resume
          ? picker.resume.find((entry) => entry.id === threadId)
          : undefined;
      setPicker(null);
      setInput("");
      if (!thread) return;
      if (claimedThreadIds?.includes(threadId)) {
        push({
          role: "opus",
          kind: "activity",
          text: "That chat is already open in another pane."
        });
        return;
      }
      onResume(thread);
      return;
    }
    if (command === "__resume-last") {
      setPicker(null);
      setInput("");
      onResume();
      return;
    }
    // Picker stage tags (Open Fusion's __provider:/__model: mechanic):
    // __family advances family→model, __model commits and closes.
    if (command.startsWith("__family:")) {
      if (picker && "role" in picker) {
        setPicker({
          role: picker.role,
          family: normalizeFusionFamily(command.slice("__family:".length), plannerFamily)
        });
        setInput("");
        composerRef.current?.focus();
      }
      return;
    }
    if (command.startsWith("__model:")) {
      const match = /^(claude|codex)\/(.+)$/.exec(command.slice("__model:".length));
      const role = picker && "role" in picker ? picker.role : undefined;
      setPicker(null);
      setInput("");
      composerRef.current?.focus();
      if (match && role) {
        const family = match[1] as FusionFamily;
        const model = match[2].trim();
        if (role === "planner") {
          applySettings({ plannerFamily: family, plannerModel: model }, "planner model");
        } else {
          applySettings({ executorFamily: family, executorModel: model }, "executor model");
        }
      }
      return;
    }
    if (item.fill) {
      setInput(item.fill);
      setSlashIndex(0);
      composerRef.current?.focus();
      return;
    }
    if (item.command) {
      handleSlashCommand(item.command);
    }
  }

  function pushCommandStatus(text: string) {
    push({ role: "opus", kind: "activity", text });
  }

  // List every saved Fusion chat for this folder (newest first) so the user
  // can resume the one they want — not just the stashed last chat. Listing
  // follows the CURRENT planner family: a claude planner lists claude chats,
  // a codex planner codex threads (a thread id means nothing across families).
  function openResumePicker() {
    const requestToken = ++resumeListRequestRef.current;
    setPicker({ resume: null });
    setInput("");
    composerRef.current?.focus();
    const applyResult = (threads: AgentThreadRef[], error?: string) => {
      if (resumeListRequestRef.current !== requestToken) return;
      setPicker((current) =>
        current && "resume" in current
          ? error
            ? { resume: threads, error }
            : { resume: threads }
          : current
      );
    };
    const list = window.vibe?.agentThreads?.list;
    if (!list) {
      applyResult([], "Saved-chat history is unavailable in this build.");
      return;
    }
    const currentId = claudeSessionIdRef.current || session.threadRef?.id || "";
    list({
      provider: plannerFamily,
      cwd: session.cwd,
      fusion: true,
      excludeIds: currentId ? [currentId] : undefined
    })
      .then((result) => {
        if (result?.status === "found") {
          applyResult(result.threads ?? []);
        } else {
          applyResult([], result?.message || "Could not read the saved chats.");
        }
      })
      .catch(() => applyResult([], "Could not read the saved chats."));
  }

  // Speed presets are EFFORT presets and preserve the user's model picks.
  // Only "quick" swaps the planning model (to the family's lighter pick) and
  // lowers effort: it is the old downgrade preset under a non-conflicting name.
  function applySpeedPreset(scope: FusionRoleScope, preset: FusionSpeedPreset) {
    const quickPlannerModel = plannerFamily === "codex" ? "gpt-5.1-codex-mini" : "sonnet";
    if (scope === "planning") {
      if (preset === "quick") {
        applySettings({ plannerModel: quickPlannerModel, plannerEffort: "low" }, "planning speed");
      } else if (preset === "balanced") {
        applySettings({ plannerEffort: "auto" }, "planning speed");
      } else if (preset === "deep") {
        applySettings({ plannerEffort: "high" }, "planning speed");
      } else {
        applySettings({ plannerEffort: familyMaxEffort(plannerFamily) }, "planning speed");
      }
      return;
    }

    if (scope === "execution") {
      if (preset === "quick") {
        applySettings({ executorEffort: "low" }, "execution speed");
      } else if (preset === "balanced") {
        applySettings({ executorEffort: "auto" }, "execution speed");
      } else if (preset === "deep") {
        applySettings({ executorEffort: "high" }, "execution speed");
      } else {
        // Each family's own top level — codex has no "max", claude does.
        applySettings({ executorEffort: familyMaxEffort(executorFamily) }, "execution speed");
      }
      return;
    }

    if (preset === "quick") {
      applySettings(
        { plannerModel: quickPlannerModel, plannerEffort: "low", executorEffort: "low" },
        "Fusion speed"
      );
    } else if (preset === "balanced") {
      applySettings({ plannerEffort: "auto", executorEffort: "auto" }, "Fusion speed");
    } else if (preset === "deep") {
      applySettings({ plannerEffort: "high", executorEffort: "high" }, "Fusion speed");
    } else {
      applySettings(
        {
          plannerEffort: familyMaxEffort(plannerFamily),
          executorEffort: familyMaxEffort(executorFamily)
        },
        "Fusion speed"
      );
    }
  }

  function applyEffortLevel(scope: FusionRoleScope, effort: string) {
    const normalized = effort.trim().toLowerCase();
    if (scope === "planning") {
      const values = familyEffortValues(plannerFamily);
      if (!values.includes(normalized)) {
        pushCommandStatus(
          `Planning effort (${familyDisplayName(plannerFamily)}) supports ${values.join(", ")} — not '${effort}'.`
        );
        return;
      }
      applySettings(
        { plannerEffort: normalizeFusionRoleEffort(plannerFamily, normalized) },
        "planning effort"
      );
      return;
    }

    if (scope === "execution") {
      // Coerce across enums (claude "max" → codex "xhigh", etc.) instead of
      // failing every delegation with an unknown variant.
      applySettings(
        { executorEffort: normalizeFusionRoleEffort(executorFamily, normalized) },
        "execution effort"
      );
      return;
    }

    // Whole-harness: only levels BOTH current families accept, applied with
    // per-family translation so neither engine sees an unknown variant.
    const sharedValues = scopeEffortValues("harness", slashMenuContext);
    if (!sharedValues.includes(normalized)) {
      pushCommandStatus(
        `Whole-harness effort supports ${sharedValues.join(", ")}. Use /effort planning or /effort execution for ${effort}.`
      );
      return;
    }
    applySettings(
      {
        plannerEffort: normalizeFusionRoleEffort(plannerFamily, normalized),
        executorEffort: normalizeFusionRoleEffort(executorFamily, normalized)
      },
      "Fusion effort"
    );
  }

  function normalizeRoleScope(value: string | undefined): FusionRoleScope {
    const normalized = String(value || "").toLowerCase();
    if (["planning", "planner", "claude", "opus"].includes(normalized)) {
      return "planning";
    }
    if (["execution", "executor", "codex"].includes(normalized)) {
      return "execution";
    }
    return "harness";
  }

  function normalizeSpeedPreset(value: string | undefined): FusionSpeedPreset | null {
    const normalized = String(value || "").toLowerCase();
    if (normalized === "fast") {
      return "quick";
    }
    return FUSION_SPEED_VALUES.includes(normalized as FusionSpeedPreset)
      ? (normalized as FusionSpeedPreset)
      : null;
  }

  function applyFastServing(scope: FusionRoleScope, explicit?: boolean) {
    if (scope === "planning") {
      const next = explicit ?? !plannerFast;
      applySettings({ plannerFast: next }, "planning fast serving");
      return;
    }

    if (scope === "execution") {
      const next = explicit ?? !executorFast;
      applySettings({ executorFast: next }, "execution fast serving");
      return;
    }

    const next = explicit ?? !(plannerFast && executorFast);
    applySettings({ plannerFast: next, executorFast: next }, "fast serving");
  }

  function applyFastCommand(raw: string) {
    const args = raw
      .replace(/^\/fast\b/i, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    let scope: FusionRoleScope = "harness";
    let explicit: boolean | undefined;
    for (const arg of args) {
      const lower = arg.toLowerCase();
      if (lower === "on" || lower === "off") {
        explicit = lower === "on";
        continue;
      }
      if (["fusion", "harness", "all"].includes(lower)) {
        scope = "harness";
        continue;
      }
      if (["planning", "planner", "claude", "opus"].includes(lower)) {
        scope = "planning";
        continue;
      }
      if (["execution", "executor", "codex"].includes(lower)) {
        scope = "execution";
        continue;
      }
      pushCommandStatus("Unknown fast serving scope. Use /fast, /fast planner, /fast executor, /fast on, or /fast off.");
      return true;
    }
    applyFastServing(scope, explicit);
    return true;
  }

  function handleSlashCommand(text: string) {
    const raw = text.trim();
    const normalized = raw.toLowerCase();
    if (!raw.startsWith("/")) {
      return false;
    }

    if (normalized === "/model" || normalized === "/models") {
      setInput("");
      pushCommandStatus(`models: ${fusionSettingsLine}`);
      return true;
    }

    if (normalized === "/help") {
      setInput("");
      pushCommandStatus(
        "commands: /plan, /auto, /mode, /planner-model, /executor-model, /fast, /speed, /effort, /models, /details, /clear, /resume. Advanced: /claude <model> (planner → Claude), /codex <model> (executor → Codex)."
      );
      return true;
    }

    if (normalized === "/details") {
      setInput("");
      const next = !verbose;
      setVerbose(next);
      pushCommandStatus(`Details ${next ? "on" : "off"}.`);
      return true;
    }

    if (normalized === "/plan") {
      setInput("");
      applyRunMode("plan");
      return true;
    }

    if (normalized === "/auto") {
      setInput("");
      applyRunMode("auto");
      return true;
    }

    if (normalized === "/mode") {
      setInput("");
      toggleRunMode();
      return true;
    }

    if (normalized === "/compact") {
      setInput("");
      if (!session.started) {
        pushCommandStatus("Nothing to compact yet.");
        return true;
      }
      if (busyRef.current) {
        pushCommandStatus("Finish or interrupt the current turn before compacting.");
        return true;
      }
      // The CLI interprets "/compact" from stream-json input (verified by
      // fusion-compact-spike). Label the echo so the transcript shows intent
      // instead of a bare slash command.
      decisionTurnLabelsRef.current.set("/compact", "Compact conversation context.");
      setBusyState(true);
      onStatusChangeRef.current("running");
      window.vibe?.fusionChat?.sendUserTurn(session.id, "/compact");
      return true;
    }

    if (normalized === "/clear") {
      setInput("");
      setMessages([]);
      setPlanActionReady(false);
      setInterruptingState(false);
      setBusyState(false);
      onClear();
      return true;
    }

    if (normalized === "/resume") {
      setInput("");
      openResumePicker();
      return true;
    }

    if (normalized === "/fast" || normalized.startsWith("/fast ")) {
      setInput("");
      return applyFastCommand(raw);
    }

    // Open Fusion-parity pickers: bare command opens the family→model
    // drill-in; with an argument the pick applies directly (family/model
    // slug, or a bare id attributed by shape).
    if (normalized === "/planner-model" || normalized === "/planner") {
      setInput("");
      setPicker({ role: "planner" });
      composerRef.current?.focus();
      return true;
    }

    if (normalized === "/executor-model" || normalized === "/executor") {
      setInput("");
      setPicker({ role: "executor" });
      composerRef.current?.focus();
      return true;
    }

    const plannerModelMatch = raw.match(/^\/planner(?:-model)?\s+(.+)$/i);
    if (plannerModelMatch) {
      setInput("");
      const resolved = resolveModelArgument(plannerModelMatch[1]);
      if (!resolved) {
        pushCommandStatus(
          `Could not match '${plannerModelMatch[1].trim()}' to a family. Use claude/<model> or codex/<model>.`
        );
        return true;
      }
      applySettings(
        { plannerFamily: resolved.family, plannerModel: resolved.model },
        "planner model"
      );
      return true;
    }

    const executorModelMatch = raw.match(/^\/executor(?:-model)?\s+(.+)$/i);
    if (executorModelMatch) {
      setInput("");
      const resolved = resolveModelArgument(executorModelMatch[1]);
      if (!resolved) {
        pushCommandStatus(
          `Could not match '${executorModelMatch[1].trim()}' to a family. Use claude/<model> or codex/<model>.`
        );
        return true;
      }
      applySettings(
        { executorFamily: resolved.family, executorModel: resolved.model },
        "executor model"
      );
      return true;
    }

    if (
      normalized === "/speed" ||
      normalized === "/speed fusion" ||
      normalized === "/speed planning" ||
      normalized === "/speed execution" ||
      normalized === "/claude" ||
      normalized === "/codex" ||
      normalized === "/effort" ||
      normalized === "/effort fusion" ||
      normalized === "/effort planning" ||
      normalized === "/effort execution"
    ) {
      setInput(`${normalized} `);
      composerRef.current?.focus();
      return true;
    }

    const speedMatch = raw.match(/^\/speed(?:\s+(fusion|harness|planning|planner|claude|opus|execution|executor|codex))?\s+(.+)$/i);
    if (speedMatch) {
      const scope = normalizeRoleScope(speedMatch[1]);
      const value = speedMatch[2].trim();
      const preset = normalizeSpeedPreset(value);
      if (preset) {
        setInput("");
        applySpeedPreset(scope, preset);
        return true;
      }

      if (scope === "harness" && value.toLowerCase() === "opus") {
        setInput("");
        applySpeedPreset("harness", "balanced");
        return true;
      }

      // Previously an unknown preset was silently reinterpreted as a planning
      // MODEL and restarted the pane — a typo like "/speed maxx" killed it.
      setInput("");
      pushCommandStatus(
        `Unknown speed preset '${value}'. Use ${FUSION_SPEED_VALUES.join(", ")}.`
      );
      return true;
    }

    const claudeMatch = raw.match(/^\/(?:claude|model\s+claude)\s+(.+)$/i);
    if (claudeMatch) {
      setInput("");
      // Legacy shorthand with family-explicit semantics: the PLANNER moves to
      // the Claude family. Raw value on purpose: applySettings validates
      // against the known aliases/claude-* pattern and refuses instead of
      // silently launching a doomed process.
      applySettings(
        { plannerFamily: "claude", plannerModel: claudeMatch[1].trim() },
        "planner model"
      );
      return true;
    }

    const codexEffortMatch = normalized.match(/^\/codex\s+effort\s+(auto|minimal|low|medium|high|xhigh|ultra|max)$/);
    if (codexEffortMatch) {
      setInput("");
      applyEffortLevel("execution", codexEffortMatch[1]);
      return true;
    }

    const codexSpeedMatch = normalized.match(/^\/codex\s+(?:speed\s+)?(quick|fast|balanced|deep|max)$/);
    if (codexSpeedMatch) {
      setInput("");
      applySpeedPreset("execution", normalizeSpeedPreset(codexSpeedMatch[1]) || "quick");
      return true;
    }

    const codexMatch = raw.match(/^\/(?:codex|model\s+codex)\s+(.+)$/i);
    if (codexMatch) {
      setInput("");
      // Legacy shorthand: the EXECUTOR moves to the Codex family.
      applySettings(
        { executorFamily: "codex", executorModel: codexMatch[1].trim() },
        "executor model"
      );
      return true;
    }

    const effortMatch = normalized.match(/^\/effort(?:\s+(fusion|harness|planning|planner|claude|opus|execution|executor|codex))?\s+(auto|minimal|low|medium|high|xhigh|ultra|max)$/);
    if (effortMatch) {
      setInput("");
      applyEffortLevel(normalizeRoleScope(effortMatch[1]), effortMatch[2]);
      return true;
    }

    if (normalized.startsWith("/effort ")) {
      setInput("");
      pushCommandStatus("Unknown effort. Use /effort, /effort planning, or /effort execution.");
      return true;
    }

    return false;
  }

  function insertComposerText(text: string) {
    const el = composerRef.current;
    const currentInput = inputRef.current;
    const start = el?.selectionStart ?? currentInput.length;
    const end = el?.selectionEnd ?? currentInput.length;
    const before = currentInput.slice(0, start);
    const after = currentInput.slice(end);
    const insertion = padComposerInsertion(text, before, after);
    const nextInput = `${before}${insertion}${after}`;
    const cursor = before.length + insertion.length;
    inputRef.current = nextInput;
    setInput(nextInput);
    window.requestAnimationFrame(() => {
      const nextEl = composerRef.current;
      nextEl?.focus();
      nextEl?.setSelectionRange(cursor, cursor);
    });
  }

  async function insertComposerFileRefs(paths: string[], fallbackText?: string) {
    const nextPaths = uniqueComposerPaths(paths);
    if (nextPaths.length === 0) return false;

    const describePaths = window.vibe?.files?.describePaths;
    if (!describePaths) {
      insertComposerText(fallbackText || nextPaths.join("\n"));
      return true;
    }

    try {
      const refs = await describePaths({ cwd: session.cwd, paths: nextPaths });
      const nonMissingRefs = refs.filter((ref) => ref.kind !== "missing");
      const visibleRefs =
        fallbackText && nonMissingRefs.length === 0 ? [] : refs;
      const text =
        visibleRefs.length > 0
          ? visibleRefs.map(formatComposerFileRef).join("\n")
          : fallbackText || nextPaths.join("\n");
      insertComposerText(text);
      return true;
    } catch {
      insertComposerText(fallbackText || nextPaths.join("\n"));
      return true;
    }
  }

  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const getPathForFile = window.vibe?.files?.getPathForFile;
    const filePaths = pathsFromFileList(event.clipboardData.files, getPathForFile);
    if (filePaths.length > 0) {
      event.preventDefault();
      void insertComposerFileRefs(filePaths);
      return;
    }

    const nativeFilePaths = window.vibe?.clipboard.readFilePaths?.() ?? [];
    if (nativeFilePaths.length > 0) {
      event.preventDefault();
      void insertComposerFileRefs(nativeFilePaths);
      return;
    }

    const text = event.clipboardData.getData("text/plain");
    const textPaths = pathsFromPlainText(text);
    if (textPaths.length > 0) {
      event.preventDefault();
      void insertComposerFileRefs(textPaths, text);
    }
  }

  function handleComposerDrop(event: React.DragEvent<HTMLTextAreaElement>) {
    const getPathForFile = window.vibe?.files?.getPathForFile;
    const filePaths = pathsFromFileList(event.dataTransfer.files, getPathForFile);
    if (filePaths.length === 0) return;
    event.preventDefault();
    void insertComposerFileRefs(filePaths);
  }

  function handleComposerDragOver(event: React.DragEvent<HTMLTextAreaElement>) {
    if (Array.from(event.dataTransfer.types).includes("Files")) {
      event.preventDefault();
    }
  }

  function send() {
    const text = input.trim();
    if (!text) return;
    if (handleSlashCommand(text)) return;
    // Sending implies following the conversation again.
    pinnedToBottomRef.current = true;
    if (pendingDecisionIsQuestion && pendingDecision) {
      submitPendingDecision("accept", text);
      return;
    }
    if (!window.vibe?.fusionChat?.sendUserTurn) {
      const message = "Fusion unavailable: fusion chat bridge is not available.";
      push({ role: "opus", kind: "error", text: message });
      emitAttention("failed", "error", message);
      return;
    }
    if (busy) {
      if (!window.vibe.fusionChat.steer) {
        push({ role: "opus", kind: "error", text: "Fusion unavailable: steer bridge is not available." });
        return;
      }
      setWaitingState(false);
      window.vibe.fusionChat.steer(session.id, text);
      setInput("");
      setInterruptingState(false);
      return;
    }
    setPlanActionReady(false);
    setWaitingState(false);
    clearPendingDecision();
    window.vibe.fusionChat.sendUserTurn(session.id, text);
    setInput("");
    setInterruptingState(false);
    setBusyState(true);
    onStatusChangeRef.current("running");
  }

  async function handleImplementPlan() {
    if (busyRef.current || implementingPlan) return;
    if (!window.vibe?.fusionChat?.sendUserTurn) {
      const message = "Fusion unavailable: fusion chat bridge is not available.";
      push({ role: "opus", kind: "error", text: message });
      emitAttention("failed", "error", message);
      return;
    }

    setImplementingPlan(true);
    setPlanActionReady(false);
    const switched = await applyRunMode("auto");
    if (!switched) {
      setImplementingPlan(false);
      return;
    }

    setWaitingState(false);
    clearPendingDecision();
    window.vibe.fusionChat.sendUserTurn(session.id, IMPLEMENT_PLAN_PROMPT);
    setInput("");
    inputRef.current = "";
    setInterruptingState(false);
    setBusyState(true);
    onStatusChangeRef.current("running");
    setImplementingPlan(false);
  }

  function submitPendingDecision(
    decision: "accept" | "acceptForSession" | "decline" | "cancel",
    note?: string
  ) {
    if (!pendingDecision || !window.vibe?.fusionChat?.sendUserTurn) {
      const message = "Fusion unavailable: approval bridge is not available.";
      push({ role: "opus", kind: "error", text: message });
      emitAttention("failed", "error", message);
      return;
    }
    const text = fusionDecisionInstruction(pendingDecision, decision, note?.trim());
    const label =
      pendingDecision.kind === "question"
        ? `Answer: ${note?.trim() || ""}`
        : decision === "acceptForSession"
          ? "Approved for this session."
          : decision === "accept"
            ? "Approved."
            : decision === "decline"
              ? "Declined."
              : "Cancelled.";
    decisionTurnLabelsRef.current.set(text, label);
    clearPendingDecision();
    setWaitingState(false);
    setInput("");
    inputRef.current = "";
    setInterruptingState(false);
    setBusyState(true);
    onStatusChangeRef.current("running");
    window.vibe.fusionChat.sendUserTurn(session.id, text);
  }

  // Abort the in-flight turn but keep the session alive (Stop button / Esc), so
  // the user can immediately type again — the host sends Claude an interrupt
  // rather than killing the process (that's Restart).
  function interrupt() {
    if (!busyRef.current || interruptingRef.current) return;
    if (!window.vibe?.fusionChat?.interrupt) {
      push({ role: "opus", kind: "error", text: "Fusion unavailable: interrupt bridge is not available." });
      return;
    }
    window.vibe.fusionChat.interrupt(session.id).catch((error) => {
      setInterruptingState(false);
      push({
        role: "opus",
        kind: "error",
        text: `Could not interrupt Fusion: ${error?.message || "unknown error"}`
      });
    });
    // The composer status row shows "interrupting…" until the marker lands —
    // the settled turn then gets its "▣ … · interrupted" completion line.
    setInterruptingState(true);
  }

  function escInterrupt() {
    if (busyRef.current && !interruptingRef.current && steeringRef.current.length > 0) {
      const items = steeringRef.current;
      pendingSteerFlushRef.current =
        items.length === 1
          ? items[0].text
          : items.map((steer, index) => `${index + 1}. ${steer.text}`).join("\n\n");
    }
    interrupt();
  }

  useEffect(() => {
    if (!busy || !isSelected) return;
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      event.preventDefault();
      escInterrupt();
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
    // `interrupt` reads mutable refs, so the listener stays current without
    // rebinding for every transient interrupt-request render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, isSelected, session.id]);

  // A settled "done" is a notification, not a resting state: once the user
  // engages the pane again (clicks it, or types the next prompt), the finished
  // turn is acknowledged and the pill returns to "ready". waiting/failed stay
  // put — they still need an answer / carry the error until the next turn.
  const acknowledgeCompletedTurn = () => {
    if (session.status === "done") {
      onStatusChangeRef.current("idle");
    }
  };

  const handlePanePointerDown = () => {
    onSelect();
    acknowledgeCompletedTurn();
  };

  // The local flags only know the live lane (a turn in flight); how the pane
  // SETTLED — finished a turn, interrupted and waiting on the user, failed —
  // lives in the app-reconciled session.status, the same source the sidebar
  // reads. Without it every settled pane collapses into "ready", so a pane
  // that is just waiting for input is indistinguishable from one that
  // finished a task.
  const settledStatus =
    session.status === "done" ||
    session.status === "waiting" ||
    session.status === "failed"
      ? session.status
      : null;
  const pillStatus = busy
    ? "running"
    : waiting
      ? "waiting"
      : failed
        ? "failed"
        : (settledStatus ?? "idle");
  const pillLabel =
    pillStatus === "running" ? "working" : pillStatus === "idle" ? "ready" : pillStatus;

  return (
    <article
      className={clsx(
        "terminal-pane",
        "fusion-pane",
        "oc-skin",
        showAttention && "terminal-pane-attention",
        showAttention &&
          session.attention &&
          `terminal-pane-attention-${session.attention.state}`
      )}
      style={{ "--pane-accent": profile.accent } as React.CSSProperties}
      onPointerDown={handlePanePointerDown}
    >
      <header className="pane-header pane-drag-zone" title="Drag header to move pane">
        <div className="pane-title">
          <GripVertical className="drag-grip" size={15} />
          <Sparkles size={15} />
          <span title={session.threadRef?.title || session.name}>
            {session.threadRef?.title || session.name}
          </span>
          <span className="fusion-chip" title={fusionSettingsLine}>
            {activeRoleLabel}
          </span>
          {backgroundActivity && (
            <span
              className="fusion-background-activity"
              title={backgroundActivityTitle}
              aria-label={backgroundActivityTitle}
            >
              <span className="fusion-background-dot" aria-hidden="true" />
              {backgroundActivity.count > 1 && (
                <span className="fusion-background-count">{backgroundActivity.count}</span>
              )}
            </span>
          )}
        </div>
        <div className="pane-status">
          <span className={`status-pill status-${pillStatus}`}>{pillLabel}</span>
        </div>
        <div className="pane-actions">
          <button title="Add matching pane" onClick={onAdd}>
            <Plus size={14} />
          </button>
          <button title="Duplicate pane" onClick={onDuplicate}>
            <CopyPlus size={14} />
          </button>
          <button
            title={session.started ? "Restart Fusion" : "Start Fusion"}
            onClick={onRestart}
          >
            {session.started ? <RefreshCcw size={14} /> : <Play size={14} />}
          </button>
          <button title="Resume a saved chat" onClick={openResumePicker}>
            <RotateCcw size={14} />
          </button>
          <button title={isMaximized ? "Restore pane" : "Maximize pane"} onClick={onMaximize}>
            {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="danger" title="Close pane" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="fusion-chat" onPointerDown={handlePanePointerDown}>
        <div className="fusion-chat-scroll" ref={scrollRef} onScroll={handleChatScroll}>
          {visibleMessages.length === 0 ? (
            <div className="oc-hero">
              <OcLogo words={[{ lines: OC_LOGO_FUSION, bold: true }]} label="Fusion" />
              <p className="oc-hero-tag">
                One agent for planning, coding, and review —{" "}
                {familyDisplayName(plannerFamily)} plans,{" "}
                {familyDisplayName(executorFamily)} builds.
              </p>
              <p className="oc-hero-hint">
                Ask anything to get started <span className="oc-hero-sep">·</span>{" "}
                <span className="oc-hero-key">/help</span> commands
              </p>
            </div>
          ) : (
            visibleMessages.map((m) => (
              <OcChatRow
                key={m.key}
                m={m}
                proseRole="opus"
                isExpanded={expanded.has(m.key)}
                onToggle={toggleExpanded}
              />
            ))
          )}
        </div>

        <div className="fusion-input-area">
          {pendingDecision && (
            <div className="fusion-decision-panel" role="group" aria-label="Fusion decision">
              <div className="fusion-decision-copy">
                <span className="fusion-decision-kind">{pendingDecision.kind}</span>
                <span className="fusion-decision-detail">{pendingDecision.detail}</span>
              </div>
              {pendingDecisionIsQuestion ? (
                <button
                  className="fusion-decision-button is-primary"
                  type="button"
                  title="Send this answer to Fusion"
                  disabled={!input.trim()}
                  onClick={() => submitPendingDecision("accept", input.trim())}
                >
                  <Check size={14} />
                  <span>Send answer</span>
                </button>
              ) : (
                <div className="fusion-decision-actions">
                  <button
                    className="fusion-decision-button is-primary"
                    type="button"
                    title="Approve once"
                    onClick={() => submitPendingDecision("accept")}
                  >
                    <Check size={14} />
                    <span>Approve</span>
                  </button>
                  <button
                    className="fusion-decision-button"
                    type="button"
                    title="Approve similar requests for this session"
                    onClick={() => submitPendingDecision("acceptForSession")}
                  >
                    <ShieldCheck size={14} />
                    <span>Approve session</span>
                  </button>
                  <button
                    className="fusion-decision-button"
                    type="button"
                    title="Decline this request"
                    onClick={() => submitPendingDecision("decline")}
                  >
                    <Ban size={14} />
                    <span>Decline</span>
                  </button>
                  <button
                    className="fusion-decision-button"
                    type="button"
                    title="Cancel this request"
                    onClick={() => submitPendingDecision("cancel")}
                  >
                    <XCircle size={14} />
                    <span>Cancel</span>
                  </button>
                </div>
              )}
            </div>
          )}
          {showPlanActionBar && (
            <div className="fusion-plan-action-bar" role="group" aria-label="Plan actions">
              <span className="fusion-plan-action-label">Implement this plan?</span>
              <button
                className="fusion-plan-action-button is-primary"
                type="button"
                title="Switch to Auto and send: Implement the plan."
                disabled={implementingPlan || modeSwitching}
                onClick={() => {
                  void handleImplementPlan();
                }}
              >
                <Play size={14} />
                <span>Implement plan</span>
              </button>
            </div>
          )}
          {steering.length > 0 && (
            <div className="fusion-steering" role="status" aria-label="Queued steering">
              {steering.map((item) => (
                <div key={item.key} className="fusion-steering-item">
                  <span className="fusion-steering-badge">Queued</span>
                  <span className="fusion-steering-text">{clip(item.text, 400)}</span>
                </div>
              ))}
              <span className="fusion-steering-hint">
                Held here until Fusion's next step picks it up · Esc pushes it in now
              </span>
            </div>
          )}
          <div className="oc-prompt">
            <div className="oc-prompt-box">
              <textarea
                className="oc-prompt-input"
                ref={composerRef}
                value={input}
                placeholder={
                  busy
                    ? "Steer current turn…"
                    : waiting
                      ? pendingDecision
                        ? pendingDecisionIsQuestion
                          ? "Type the answer for Fusion…"
                          : "Choose an approval action or add guidance…"
                        : "Answer Fusion to continue…"
                      : showPlanActionBar
                        ? "Implement the plan, or type to refine it…"
                        : "Ask Fusion to build, fix, or design…"
                }
                onChange={(e) => {
                  inputRef.current = e.target.value;
                  setInput(e.target.value);
                  acknowledgeCompletedTurn();
                }}
                onPaste={handleComposerPaste}
                onDrop={handleComposerDrop}
                onDragOver={handleComposerDragOver}
                onKeyDown={(e) => {
                  // Shift+Tab flips Plan/Auto — but never while the slash menu
                  // is open OR a slash command is being typed (with the menu
                  // closed by filtering/dismissal a stray Shift+Tab used to
                  // silently switch modes mid-command). It is always swallowed
                  // so focus never escapes the composer backwards.
                  if (e.key === "Tab" && e.shiftKey) {
                    e.preventDefault();
                    if (!slashMenuOpen && !inputIsSlashCommand) {
                      toggleRunMode();
                    }
                    return;
                  }
                  if (slashMenuOpen) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setSlashIndex((i) => (i + 1) % slashMenu.items.length);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setSlashIndex((i) => (i - 1 + slashMenu.items.length) % slashMenu.items.length);
                      return;
                    }
                    if (e.key === "Tab") {
                      e.preventDefault();
                      applySlashSelection(slashMenu.items[slashIndex] ?? slashMenu.items[0]);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      // Picker open: Esc backs out ONE stage per press
                      // (model → family → closed), Open Fusion's mechanic.
                      // The resume picker has one stage, so Esc just closes it.
                      if (picker && "role" in picker && picker.family) {
                        setPicker({ role: picker.role });
                        setInput("");
                        return;
                      }
                      if (picker) {
                        setPicker(null);
                        setInput("");
                        return;
                      }
                      // Close the menu but KEEP the typed input (a second Esc
                      // clears it below). It used to erase the whole command.
                      setSlashMenuDismissed(true);
                      return;
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      applySlashSelection(slashMenu.items[slashIndex] ?? slashMenu.items[0]);
                      return;
                    }
                  }
                  // Tab while typing a slash command (menu filtered closed):
                  // swallow it so completion attempts don't blur the composer.
                  if (e.key === "Tab" && inputIsSlashCommand) {
                    e.preventDefault();
                    return;
                  }
                  if (e.key === "Escape") {
                    if (busy) {
                      e.preventDefault();
                      escInterrupt();
                      return;
                    }
                    if (input) {
                      e.preventDefault();
                      setInput("");
                      return;
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={1}
              />
              {/* OpenCode's prompt-box meta row: the agent slot is Fusion's
                  Plan/Auto mode (clickable, Shift+Tab still toggles), then the
                  planning ⇄ execution model pair. */}
              <div
                className="oc-prompt-meta fusion-settings-summary"
                title={`${fusionSettingsLine} · Shift+Tab toggles mode`}
              >
                <button
                  type="button"
                  className={clsx(
                    "oc-prompt-agent",
                    `is-${fusionRunMode}`,
                    modeFlash && "is-flashing"
                  )}
                  title={`Switch to ${fusionRunMode === "plan" ? "Auto" : "Plan"} mode (Shift+Tab)`}
                  aria-pressed={fusionRunMode === "plan"}
                  disabled={modeSwitching || implementingPlan}
                  onClick={toggleRunMode}
                >
                  {fusionRunModeText}
                </button>
                <span className="oc-prompt-sep">·</span>
                <button
                  type="button"
                  className="oc-prompt-model"
                  title={`Planner: ${familyDisplayName(plannerFamily)} ${fusionModelLabel} — click to change (/planner-model)`}
                  onClick={() => {
                    setPicker({ role: "planner" });
                    composerRef.current?.focus();
                  }}
                >
                  {fusionModelLabel}
                </button>
                <span className="oc-prompt-pair">⇄</span>
                <button
                  type="button"
                  className="oc-prompt-model is-executor"
                  title={`Executor: ${familyDisplayName(executorFamily)} ${executorModelLabel} — click to change (/executor-model)`}
                  onClick={() => {
                    setPicker({ role: "executor" });
                    composerRef.current?.focus();
                  }}
                >
                  {executorModelLabel}
                </button>
              </div>
            </div>
          </div>
          <div className="oc-prompt-status">
            <div className="oc-prompt-status-left">
              {busy && (
                <>
                  <OcSpinner />
                  {interrupting && <span className="oc-status-note">interrupting…</span>}
                </>
              )}
            </div>
            <div className="oc-prompt-status-right">
              {busy ? (
                <span className="oc-hint">
                  <span className="oc-hint-key">esc</span> interrupt
                </span>
              ) : (
                <>
                  {SHOW_FUSION_COST && usageLabel && <span className="oc-usage">{usageLabel}</span>}
                  <span className="oc-hint">
                    <span className="oc-hint-key">shift+tab</span>{" "}
                    {fusionRunMode === "plan" ? "auto" : "plan"} mode
                  </span>
                  <span className="oc-hint">
                    <span className="oc-hint-key">/help</span> commands
                  </span>
                  <span className="oc-hint">
                    <span className="oc-hint-key">enter</span> send
                  </span>
                </>
              )}
            </div>
          </div>
          {slashMenuOpen && (
            <div className="fusion-slash-panel" aria-label="Slash command options">
              <div className="fusion-slash-title">{slashMenu.title}</div>
              <ul className="fusion-slash-menu" role="listbox" aria-label={slashMenu.title}>
                {slashMenu.items.map((item, i) => (
                  <li
                    key={item.key}
                    ref={i === slashIndex ? activeMenuItemRef : undefined}
                    role="option"
                    aria-selected={i === slashIndex}
                    className={clsx("fusion-slash-item", i === slashIndex && "is-active")}
                    onMouseMove={() => setSlashIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applySlashSelection(item);
                    }}
                  >
                    <span className="fusion-slash-name">{item.label}</span>
                    <span className="fusion-slash-desc">{item.desc}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      <footer className="oc-footer">
        <span className="oc-footer-path" title={session.cwd}>
          <span className="oc-footer-parent">{cwdSplit.parent}</span>
          <span className="oc-footer-name">{cwdSplit.name}</span>
        </span>
        <div className="oc-footer-right">
          {pendingDecision && <span className="oc-footer-perm">△ 1 Decision</span>}
          <button
            type="button"
            className={clsx("oc-footer-details", verbose && "is-on")}
            aria-pressed={verbose}
            title="Toggle tool execution details (/details)"
            onClick={() => setVerbose((value) => !value)}
          >
            /details {verbose ? "on" : "off"}
          </button>
          <span className="oc-footer-brand">
            <span className="oc-footer-dot">•</span> <b>Fusion</b>
          </span>
        </div>
      </footer>
    </article>
  );
}
