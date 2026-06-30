import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  CopyPlus,
  GripVertical,
  Maximize2,
  Minimize2,
  Play,
  Plus,
  RefreshCcw,
  RotateCcw,
  Send,
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
  FusionClaudeModel,
  FusionCodexModel,
  FusionChatEvent,
  FusionEffort,
  FusionRunMode,
  FusionSettings,
  SessionStatus
} from "../types";

interface FusionChatPaneProps {
  session: AgentSession;
  profile: AgentProfile;
  isMaximized: boolean;
  isSelected: boolean;
  onClose: () => void;
  onDuplicate: () => void;
  onRestart: () => void;
  onResume: () => void;
  onClear: () => void;
  onSettingsChange: (settings: FusionSettings) => void;
  onAdd: () => void;
  onSelect: () => void;
  onMaximize: () => void;
  onThreadRefChange: (threadRef: AgentThreadRef) => void;
  onStatusChange: (status: SessionStatus) => void;
  onAttention: (attention: AgentAttentionEvent) => void;
}

const OPUS_LABEL = "Opus 4.8";
const DEFAULT_FUSION_MODEL: FusionClaudeModel = "opus";
const DEFAULT_FUSION_CODEX_MODEL: FusionCodexModel = "auto";
const DEFAULT_FUSION_EFFORT: FusionEffort = "auto";
const DEFAULT_FUSION_RUN_MODE: FusionRunMode = "auto";
const FUSION_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;
const FUSION_EFFORT_LABELS: Record<FusionEffort, string> = {
  auto: "Auto",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max"
};
const FUSION_RUN_MODE_LABELS: Record<FusionRunMode, string> = {
  auto: "Auto",
  plan: "Plan"
};
const FUSION_EFFORT_VALUES = Object.keys(FUSION_EFFORT_LABELS) as FusionEffort[];
const FUSION_COMPOSER_MAX_PX = 160;
const MAX_COMPOSER_PATHS = 32;

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

interface SlashCommand {
  name: string;
  arg?: string;
  desc: string;
  takesArg?: boolean;
  submenu?: boolean;
}

interface SlashMenuItem {
  key: string;
  label: string;
  desc: string;
  command?: string;
  fill?: string;
}

interface SlashMenu {
  title: string;
  items: SlashMenuItem[];
}

// The "/" palette — the Fusion equivalent of the slash menu a real CLI draws
// inside xterm. Every entry routes back through handleSlashCommand.
const FUSION_SLASH_COMMANDS: SlashCommand[] = [
  { name: "/plan", desc: "Switch Fusion to Plan mode" },
  { name: "/auto", desc: "Switch Fusion to Auto mode" },
  { name: "/mode", desc: "Toggle Auto/Plan mode" },
  { name: "/speed", desc: "Fusion speed presets", submenu: true },
  { name: "/effort", desc: "Fusion reasoning effort", submenu: true },
  { name: "/opus", desc: "Advanced planning role settings", submenu: true },
  { name: "/codex", desc: "Advanced execution role settings", submenu: true },
  { name: "/fast", desc: "Switch Fusion to the fast preset" },
  { name: "/claude", arg: "<model>", desc: "Set the planning model", takesArg: true },
  { name: "/models", desc: "Show the current models and effort" },
  { name: "/resume", desc: "Resume the last Claude Fusion chat" },
  { name: "/clear", desc: "Clear this conversation" },
  { name: "/help", desc: "List the available commands" }
];

const FREE_TEXT_SLASH_COMMANDS = [
  ...FUSION_SLASH_COMMANDS.filter((cmd) => cmd.takesArg).map((cmd) => cmd.name),
  "/model claude",
  "/model codex"
];

type FusionRoleScope = "harness" | "planning" | "execution";
type FusionSpeedPreset = "fast" | "balanced" | "deep" | "max";

const FUSION_SPEED_LABELS: Record<FusionSpeedPreset, string> = {
  fast: "Fast",
  balanced: "Balanced",
  deep: "Deep",
  max: "Max"
};

const FUSION_SPEED_VALUES = Object.keys(FUSION_SPEED_LABELS) as FusionSpeedPreset[];

const roleName = (scope: FusionRoleScope) =>
  scope === "planning"
    ? "Planning"
    : scope === "execution"
      ? "Execution"
      : "Fusion";

const scopeCommand = (scope: FusionRoleScope) =>
  scope === "harness" ? "fusion" : scope;

const effortItems = (prefix: string, scope: FusionRoleScope = "harness"): SlashMenuItem[] =>
  FUSION_EFFORT_VALUES.map((effort) => ({
    key: `${prefix}-${scope}-effort-${effort}`,
    label: `${roleName(scope)} ${FUSION_EFFORT_LABELS[effort]}`,
    desc:
      scope === "harness"
        ? effort === "auto"
          ? "Use runtime defaults across the harness"
          : `Set both Fusion roles to ${effort}`
        : effort === "auto"
          ? `Use the runtime default for ${roleName(scope).toLowerCase()}`
          : `Set ${roleName(scope).toLowerCase()} effort to ${effort}`,
    command:
      prefix === "/effort"
        ? `${prefix} ${scopeCommand(scope)} ${effort}`
        : `${prefix} effort ${effort}`
  }));

const speedItems = (scope: FusionRoleScope): SlashMenuItem[] =>
  FUSION_SPEED_VALUES.map((preset) => ({
    key: `speed-${scope}-${preset}`,
    label: `${roleName(scope)} ${FUSION_SPEED_LABELS[preset]}`,
    desc:
      scope === "harness"
        ? preset === "fast"
          ? "Fast planning and low execution effort"
          : preset === "balanced"
            ? "Default Fusion balance"
            : preset === "deep"
              ? "High effort across Fusion"
              : "Maximum effort across Fusion"
        : scope === "planning"
          ? preset === "fast"
            ? "Fast planning model and low planning effort"
            : preset === "balanced"
              ? "Opus planning with automatic effort"
              : preset === "deep"
                ? "Opus planning with high effort"
                : "Opus planning with max effort"
          : preset === "fast"
            ? "Low execution effort"
            : preset === "balanced"
              ? "Automatic execution effort"
              : preset === "deep"
                ? "High execution effort"
                : "Max execution effort",
    command: `/speed ${scopeCommand(scope)} ${preset}`
  }));

const filterSlashItems = (items: SlashMenuItem[], query: string) => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  return items.filter((item) =>
    `${item.label} ${item.desc}`.toLowerCase().includes(normalized)
  );
};

function hasFreeTextSlashArgument(input: string) {
  const normalized = input.trim().replace(/\s+/g, " ").toLowerCase();
  return FREE_TEXT_SLASH_COMMANDS.some((command) =>
    normalized.startsWith(command + " ") &&
      normalized.slice(command.length).trim().length > 0
  );
}

function buildSlashMenu(input: string): SlashMenu {
  if (!input.startsWith("/")) {
    return { title: "", items: [] };
  }

  if (hasFreeTextSlashArgument(input)) {
    return { title: "", items: [] };
  }

  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();
  const submenu = (command: string, title: string, items: SlashMenuItem[]) => {
    const query = lower.startsWith(`${command} `)
      ? trimmed.slice(command.length).trim()
      : "";
    return { title, items: filterSlashItems(items, query) };
  };

  if (lower === "/opus" || lower.startsWith("/opus ")) {
    return submenu("/opus", "Planning Role", [
      {
        key: "opus-model",
        label: "Model Opus 4.8",
        desc: "Planning and review model",
        command: "/opus model"
      },
      {
        key: "opus-speed",
        label: "Speed",
        desc: "Planning speed presets",
        fill: "/speed planning "
      },
      {
        key: "opus-effort",
        label: "Effort",
        desc: "Planning effort levels",
        fill: "/effort planning "
      },
      ...effortItems("/opus", "planning")
    ]);
  }

  if (lower === "/codex" || lower.startsWith("/codex ")) {
    return submenu("/codex", "Execution Role", [
      {
        key: "codex-auto",
        label: "Default model",
        desc: "Use the configured execution model",
        command: "/codex auto"
      },
      {
        key: "codex-custom",
        label: "Custom model",
        desc: "Type an execution model id",
        fill: "/codex "
      },
      {
        key: "codex-speed",
        label: "Speed",
        desc: "Execution speed presets",
        fill: "/speed execution "
      },
      {
        key: "codex-effort",
        label: "Effort",
        desc: "Execution effort levels",
        fill: "/effort execution "
      },
      ...effortItems("/codex", "execution")
    ]);
  }

  if (lower === "/speed planning" || lower.startsWith("/speed planning ")) {
    return submenu("/speed planning", "Fusion Speed / Planning", speedItems("planning"));
  }

  if (lower === "/speed execution" || lower.startsWith("/speed execution ")) {
    return submenu("/speed execution", "Fusion Speed / Execution", speedItems("execution"));
  }

  if (lower === "/speed fusion" || lower.startsWith("/speed fusion ")) {
    return submenu("/speed fusion", "Fusion Speed / Whole Harness", speedItems("harness"));
  }

  if (lower === "/speed" || lower.startsWith("/speed ")) {
    return submenu("/speed", "Fusion Speed", [
      {
        key: "speed-fusion",
        label: "Whole harness",
        desc: "Presets for planning and execution together",
        fill: "/speed fusion "
      },
      {
        key: "speed-planning",
        label: "Planning role",
        desc: "Planning and review speed",
        fill: "/speed planning "
      },
      {
        key: "speed-execution",
        label: "Execution role",
        desc: "Implementation and verification speed",
        fill: "/speed execution "
      },
      ...speedItems("harness")
    ]);
  }

  if (lower === "/effort planning" || lower.startsWith("/effort planning ")) {
    return submenu("/effort planning", "Fusion Effort / Planning", effortItems("/effort", "planning"));
  }

  if (lower === "/effort execution" || lower.startsWith("/effort execution ")) {
    return submenu("/effort execution", "Fusion Effort / Execution", effortItems("/effort", "execution"));
  }

  if (lower === "/effort fusion" || lower.startsWith("/effort fusion ")) {
    return submenu("/effort fusion", "Fusion Effort / Whole Harness", effortItems("/effort", "harness"));
  }

  if (lower === "/effort" || lower.startsWith("/effort ")) {
    return submenu("/effort", "Fusion Effort", [
      {
        key: "effort-fusion",
        label: "Whole harness",
        desc: "Set both Fusion roles together",
        fill: "/effort fusion "
      },
      {
        key: "effort-planning",
        label: "Planning role",
        desc: "Planning and review effort",
        fill: "/effort planning "
      },
      {
        key: "effort-execution",
        label: "Execution role",
        desc: "Implementation and verification effort",
        fill: "/effort execution "
      },
      ...effortItems("/effort", "harness")
    ]);
  }

  const token = input.startsWith("/") && !/\s/.test(input) ? input.slice(1).toLowerCase() : "";
  const commands = FUSION_SLASH_COMMANDS.filter((cmd) => cmd.name.slice(1).startsWith(token));
  return {
    title: "Commands",
    items: commands.map((cmd) => ({
      key: cmd.name,
      label: `${cmd.name}${cmd.arg ? ` ${cmd.arg}` : ""}`,
      desc: cmd.desc,
      command: cmd.takesArg || cmd.submenu ? undefined : cmd.name,
      fill: cmd.takesArg || cmd.submenu ? `${cmd.name} ` : undefined
    }))
  };
}

function normalizeModelId(value: unknown, fallback: string) {
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
  const model = normalizeModelId(value, DEFAULT_FUSION_MODEL);
  const lower = model.toLowerCase();
  if (lower === "fast") return "sonnet";
  if (lower === "opus" || lower === "sonnet") return lower;
  return model;
}

function normalizeFusionCodexModel(value: unknown): FusionCodexModel {
  const model = normalizeModelId(value, DEFAULT_FUSION_CODEX_MODEL);
  const lower = model.toLowerCase();
  return lower === "auto" || lower === "default" ? DEFAULT_FUSION_CODEX_MODEL : model;
}

function normalizeFusionEffort(value: unknown): FusionEffort {
  return FUSION_EFFORT_VALUES.includes(value as FusionEffort)
    ? (value as FusionEffort)
    : DEFAULT_FUSION_EFFORT;
}

function normalizeFusionRunMode(value: unknown): FusionRunMode {
  return String(value || "").trim().toLowerCase() === "plan" ? "plan" : DEFAULT_FUSION_RUN_MODE;
}

function fusionClaudeModelLabel(value: FusionClaudeModel) {
  if (value === "opus") return OPUS_LABEL;
  if (value === "sonnet") return "Fast";
  return value;
}

function fusionCodexModelLabel(value: FusionCodexModel) {
  return value === "auto" ? "Codex default" : value;
}

function fusionRunModeLabel(value: FusionRunMode) {
  return FUSION_RUN_MODE_LABELS[value];
}

function fusionSettingsSummary(settings: FusionSettings) {
  return `Mode ${fusionRunModeLabel(settings.mode)} · Planning ${fusionClaudeModelLabel(settings.model)} · Planning effort ${FUSION_EFFORT_LABELS[settings.claudeEffort]} · Execution ${fusionCodexModelLabel(settings.codexModel)} · Execution effort ${FUSION_EFFORT_LABELS[settings.codexEffort]}`;
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
  return /codex_investigate|codex_implement|codex_respond/.test(name);
}

function isCodexGoalTool(name: string): boolean {
  return /codex_goal_(?:set|get|clear)/.test(name);
}

function isInternalActivity(kind: string): boolean {
  return ["delegate", "decision", "goal", "warmup"].includes(kind);
}

function fusionRoleLabel(_role: FusionActiveRole) {
  return FUSION_SPEAKER_LABEL;
}

const baseName = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() ?? value;
const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max)}…` : value;

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

// A short argument hint so a tool chip reads "Read FusionChatPane.tsx", not "Read".
function toolHint(name: string, data: Record<string, unknown>): string {
  const file = data.file_path ?? data.path ?? data.notebook_path;
  if (typeof file === "string" && file) return baseName(file);
  if (name === "Bash" && typeof data.command === "string") return clip(data.command, 48);
  if ((name === "Grep" || name === "Glob") && typeof data.pattern === "string") {
    return data.pattern;
  }
  if ((name === "Agent" || name === "Task") && typeof data.description === "string") {
    return data.description;
  }
  return "";
}

function formatToolCall(name: string, input: unknown): string {
  const data = (input ?? {}) as Record<string, unknown>;
  if (name.endsWith("codex_goal_set")) {
    return "goal updated";
  }
  if (name.endsWith("codex_goal_get")) {
    return "goal checked";
  }
  if (name.endsWith("codex_goal_clear")) {
    return "goal cleared";
  }
  if (name.endsWith("codex_implement")) {
    return `implementation handoff · ${clip(String(data.task ?? ""), 180)}`;
  }
  if (name.endsWith("codex_investigate")) {
    return `investigation handoff · ${clip(String(data.task ?? ""), 180)}`;
  }
  if (name.endsWith("codex_respond")) {
    return `approval response · ${String(data.decision ?? "")}${data.note ? `: ${data.note}` : ""}`;
  }
  const base = name.replace(/^mcp__[^_]+__/, "");
  const hint = toolHint(base, data);
  return hint ? `${base} · ${hint}` : base;
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
  const [activeRole, setActiveRole] = useState<FusionActiveRole>("claude");
  const [slashIndex, setSlashIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
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
  const toolRoleRef = useRef(new Map<string, ToolMeta>());
  const claudeSessionIdRef = useRef("");
  const claudeThreadTitleRef = useRef("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [verbose, setVerbose] = useState(false);
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const fusionModel = normalizeFusionModel(session.fusionModel);
  const fusionCodexModel = normalizeFusionCodexModel(session.fusionCodexModel);
  const fusionClaudeEffort = normalizeFusionEffort(session.fusionClaudeEffort ?? session.fusionEffort);
  const fusionCodexEffort = normalizeFusionEffort(session.fusionCodexEffort ?? session.fusionEffort);
  const fusionRunMode = normalizeFusionRunMode(session.fusionRunMode);
  const fusionRunModeText = fusionRunModeLabel(fusionRunMode);
  const fusionModelLabel = fusionClaudeModelLabel(fusionModel);
  const codexModelLabel = fusionCodexModelLabel(fusionCodexModel);
  const fusionSettingsLine = fusionSettingsSummary({
    mode: fusionRunMode,
    model: fusionModel,
    codexModel: fusionCodexModel,
    claudeEffort: fusionClaudeEffort,
    codexEffort: fusionCodexEffort
  });
  const activeRoleLabel = fusionRoleLabel(activeRole);
  const inputIsSlashCommand = input.trim().startsWith("/");
  const showAttention = shouldShowAttentionDot(session);
  const backgroundActivity =
    session.backgroundActivity?.active && session.backgroundActivity.count > 0
      ? session.backgroundActivity
      : null;
  const backgroundActivityTitle = formatBackgroundActivityTitle(backgroundActivity);
  const canResumeClaude = session.resumeRef?.provider === "claude" && Boolean(session.resumeRef.id);
  const slashMenu = buildSlashMenu(input);
  const slashMenuOpen = slashMenu.items.length > 0;
  const visibleMessages = verbose ? messages : messages.filter((message) => !message.internal);
  const pendingDecisionIsQuestion = pendingDecision?.kind === "question";

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

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

  // Reset the highlighted command whenever the typed token changes.
  useEffect(() => {
    setSlashIndex(0);
  }, [input]);

  const nextKey = () => `m${keyRef.current++}`;
  const push = (entry: Omit<ChatMessage, "key" | "ts"> & { ts?: number }) =>
    setMessages((prev) => [...prev, { key: nextKey(), ts: Date.now(), ...entry }]);
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
      provider: "claude",
      id: claudeSessionId,
      title:
        claudeThreadTitleRef.current ||
        session.threadRef?.title ||
        session.name,
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
    setMessages(
      restartNotice
        ? [
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
    setActiveRole("claude");
    setWaitingState(false);
    setInterruptingState(false);
    setBusyState(false);
    setFailed(false);
    onStatusChangeRef.current("starting");
    let cancelled = false;
    const resumeThreadRef =
      session.nextLaunchMode === "resume" &&
      session.threadRef?.provider === "claude" &&
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

        const startPayload = {
          id: session.id,
          cwd: session.cwd,
          resumeId,
          mode: fusionRunMode,
          model: fusionModel,
          ...(fusionCodexModel === "auto" ? {} : { codexModel: fusionCodexModel }),
          ...(fusionClaudeEffort === "auto" ? {} : { effort: fusionClaudeEffort }),
          ...(fusionCodexEffort === "auto" ? {} : { codexEffort: fusionCodexEffort })
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
    const appendStreaming = (kind: "text" | "thinking", delta: string) =>
      setMessages((prev) => {
        if (kind === "thinking" && !delta.trim()) {
          return prev;
        }
        // Append to the open bubble while it is the latest message, so a single
        // content block streams as ONE coherent paragraph (no mid-call shred).
        // A tool chip or a kind switch starts a fresh bubble — chronological,
        // Claude-Code style. Close any other open bubble so only one caret shows.
        const last = prev[prev.length - 1];
        if (last && last.role === "opus" && last.kind === kind && last.streaming) {
          const copy = prev.slice();
          copy[copy.length - 1] = { ...last, text: last.text + delta };
          return copy;
        }
        const cleared = prev.map((m) =>
          m.role === "opus" && m.streaming ? { ...m, streaming: false } : m
        );
        return [
          ...cleared,
          { key: nextKey(), role: "opus", kind, text: delta, ts: Date.now(), streaming: true }
        ];
      });
    const stopStreaming = () =>
      setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));

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
      switch (event.type) {
        case "session":
          claudeSessionIdRef.current = event.sessionId;
          publishClaudeThreadRef();
          break;
        case "user":
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
          } else {
            push({ role: "user", kind: "text", text: event.steer ? `Steer: ${event.text}` : event.text });
          }
          break;
        case "turn-start":
          setActiveRole("claude");
          setInterruptingState(false);
          setWaitingState(false);
          setFailed(false);
          clearPendingDecision();
          setBusyState(true);
          onStatusChangeRef.current("running");
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
          toolRoleRef.current.set(event.toolId, {
            name: event.name,
            isCodexBridge,
            isGoalTool
          });
          push({
            role: "opus",
            kind: "tool-call",
            text: formatToolCall(event.name, event.input),
            toolId: event.toolId,
            internal: true
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
          const text = meta
            ? formatCodexBridgeResult(meta.name, event.text ?? "")
            : clip(event.text ?? "", 8000);
          push({
            role: fromCodex ? "codex" : "opus",
            kind: fromCodex ? "activity" : "tool-result",
            text,
            toolId: event.toolId,
            internal: !fromCodex || Boolean(meta?.isGoalTool)
          });
          if (needsDecision) {
            setPendingDecision(pendingFusionDecisionFromResult(parsed));
            setWaitingState(true);
            setBusyState(false);
            onStatusChangeRef.current("waiting");
            emitAttention(
              "waiting",
              parsed.status === "needs_decision" ? "approval" : "question",
              text
            );
          } else if (fromCodex && parsed) {
            clearPendingDecision();
            setWaitingState(false);
          }
          break;
        }
        case "activity":
          setActiveRole(event.role === "codex" ? "codex" : "claude");
          push({
            role: event.role,
            kind: "activity",
            text: `${event.kind ? `${event.kind}: ` : ""}${event.text ?? ""}`,
            internal: isInternalActivity(event.kind || "")
          });
          if (event.kind === "warmup_error") {
            const message = event.text || "Fusion execution bridge failed to start.";
            setInterruptingState(false);
            setWaitingState(false);
            setBusyState(false);
            setFailed(true);
            clearPendingDecision();
            onStatusChangeRef.current("failed");
            emitAttention("failed", "error", message);
          }
          break;
        case "turn-end":
          // Keep the Opus bubble open across assistant-message seams; it is
          // closed on `result`/`closed` so the whole answer stays together.
          break;
        case "result":
          setActiveRole("claude");
          stopStreaming();
          setInterruptingState(false);
          setBusyState(false);
          if (waitingForDecisionRef.current) {
            onStatusChangeRef.current("waiting");
          } else {
            emitAttention("completed", "done");
          }
          break;
        case "interrupted":
          setActiveRole("claude");
          stopStreaming();
          setInterruptingState(false);
          setWaitingState(false);
          setFailed(false);
          clearPendingDecision();
          setBusyState(false);
          onStatusChangeRef.current("waiting");
          setInterruptStatus("Interrupted by user.");
          break;
        case "stderr": {
          const text = event.text.trim();
          if (text) {
            push({ role: "opus", kind: "error", text, internal: true });
          }
          break;
        }
        case "error":
          setActiveRole("claude");
          stopStreaming();
          setInterruptingState(false);
          setWaitingState(false);
          push({ role: "opus", kind: "error", text: event.message });
          setBusyState(false);
          setFailed(true);
          clearPendingDecision();
          emitAttention("failed", "error", event.message);
          break;
        case "closed":
          setActiveRole("claude");
          stopStreaming();
          setInterruptingState(false);
          if (event.code != null && event.code !== 0) {
            const message = `Fusion process exited with code ${event.code}.`;
            setBusyState(false);
            setFailed(true);
            clearPendingDecision();
            push({ role: "opus", kind: "error", text: message });
            emitAttention("failed", "exit", message);
          } else if (busyRef.current) {
            const message = "Fusion process closed before returning a result.";
            setBusyState(false);
            setFailed(true);
            clearPendingDecision();
            push({ role: "opus", kind: "error", text: message });
            emitAttention("failed", "exit", message);
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function applySettings(settings: Partial<FusionSettings>, label = "settings") {
    const nextSettings = {
      mode: normalizeFusionRunMode(settings.mode ?? fusionRunMode),
      model: normalizeFusionModel(settings.model ?? fusionModel),
      codexModel: normalizeFusionCodexModel(settings.codexModel ?? fusionCodexModel),
      claudeEffort: normalizeFusionEffort(settings.claudeEffort ?? fusionClaudeEffort),
      codexEffort: normalizeFusionEffort(settings.codexEffort ?? fusionCodexEffort)
    };
    if (
      nextSettings.mode === fusionRunMode &&
      nextSettings.model === fusionModel &&
      nextSettings.codexModel === fusionCodexModel &&
      nextSettings.claudeEffort === fusionClaudeEffort &&
      nextSettings.codexEffort === fusionCodexEffort
    ) {
      pushCommandStatus(`Already using ${fusionSettingsSummary(nextSettings)}.`);
      return;
    }
    const requiresRestart =
      nextSettings.model !== fusionModel ||
      nextSettings.claudeEffort !== fusionClaudeEffort;
    const notice = session.started
      ? requiresRestart
        ? `${busyRef.current ? "Interrupting current turn and restarting" : "Restarting"} Fusion with ${fusionSettingsSummary(nextSettings)}.`
        : `Updated Fusion ${label} live: ${fusionSettingsSummary(nextSettings)}. Next Codex turn will use it.`
      : `Saved Fusion ${label}: ${fusionSettingsSummary(nextSettings)}.`;
    pendingRestartNoticeRef.current = session.started && requiresRestart ? notice : null;
    pushCommandStatus(notice);
    onSettingsChange(nextSettings);
  }

  function applyRunMode(nextMode: FusionRunMode) {
    const mode = normalizeFusionRunMode(nextMode);
    if (mode === fusionRunMode) {
      return;
    }

    const nextSettings = {
      mode,
      model: fusionModel,
      codexModel: fusionCodexModel,
      claudeEffort: fusionClaudeEffort,
      codexEffort: fusionCodexEffort
    };

    if (session.started) {
      const setMode = window.vibe?.fusionChat?.setMode;
      if (!setMode) {
        push({ role: "opus", kind: "error", text: "Fusion unavailable: mode bridge is not available." });
        return;
      }
      setMode(session.id, mode)
        .then((result) => {
          if (result && result.ok === false) {
            push({ role: "opus", kind: "error", text: `Could not set Fusion mode: ${result.error || "unknown error"}` });
            return;
          }
          onSettingsChange(nextSettings);
          pushCommandStatus(`Mode: ${mode === "plan" ? "Plan" : "Auto"}.`);
        })
        .catch((error) => {
          push({ role: "opus", kind: "error", text: `Could not set Fusion mode: ${error?.message || "unknown error"}` });
        });
      return;
    }

    onSettingsChange(nextSettings);
  }

  function toggleRunMode() {
    applyRunMode(fusionRunMode === "plan" ? "auto" : "plan");
  }

  function applySlashSelection(item: SlashMenuItem | undefined) {
    if (!item) return;
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

  function applySpeedPreset(scope: FusionRoleScope, preset: FusionSpeedPreset) {
    if (scope === "planning") {
      if (preset === "fast") {
        applySettings({ model: "sonnet", claudeEffort: "low" }, "planning speed");
      } else if (preset === "balanced") {
        applySettings({ model: "opus", claudeEffort: "auto" }, "planning speed");
      } else if (preset === "deep") {
        applySettings({ model: "opus", claudeEffort: "high" }, "planning speed");
      } else {
        applySettings({ model: "opus", claudeEffort: "max" }, "planning speed");
      }
      return;
    }

    if (scope === "execution") {
      if (preset === "fast") {
        applySettings({ codexEffort: "low" }, "execution speed");
      } else if (preset === "balanced") {
        applySettings({ codexEffort: "auto" }, "execution speed");
      } else if (preset === "deep") {
        applySettings({ codexEffort: "high" }, "execution speed");
      } else {
        applySettings({ codexEffort: "max" }, "execution speed");
      }
      return;
    }

    if (preset === "fast") {
      applySettings({ model: "sonnet", claudeEffort: "low", codexEffort: "low" }, "Fusion speed");
    } else if (preset === "balanced") {
      applySettings({ model: "opus", claudeEffort: "auto", codexEffort: "auto" }, "Fusion speed");
    } else if (preset === "deep") {
      applySettings({ model: "opus", claudeEffort: "high", codexEffort: "high" }, "Fusion speed");
    } else {
      applySettings({ model: "opus", claudeEffort: "max", codexEffort: "max" }, "Fusion speed");
    }
  }

  function applyEffortLevel(scope: FusionRoleScope, effort: FusionEffort) {
    if (scope === "planning") {
      applySettings({ claudeEffort: effort }, "planning effort");
      return;
    }

    if (scope === "execution") {
      applySettings({ codexEffort: effort }, "execution effort");
      return;
    }

    applySettings({ claudeEffort: effort, codexEffort: effort }, "Fusion effort");
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
    return FUSION_SPEED_VALUES.includes(normalized as FusionSpeedPreset)
      ? (normalized as FusionSpeedPreset)
      : null;
  }

  function setInterruptStatus(text: string) {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (
        last &&
        last.role === "opus" &&
        last.kind === "activity" &&
        (last.text === "Interrupt requested." || last.text === "Interrupted by user.")
      ) {
        const copy = prev.slice();
        copy[copy.length - 1] = { ...last, text };
        return copy;
      }
      return [...prev, { key: nextKey(), role: "opus", kind: "activity", text, ts: Date.now() }];
    });
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
        "commands: /plan, /auto, /mode, /speed, /effort, /models, /clear, /resume. Advanced: /opus, /codex, /claude <model>."
      );
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

    if (normalized === "/clear") {
      setInput("");
      setMessages([]);
      setInterruptingState(false);
      setBusyState(false);
      onClear();
      return true;
    }

    if (normalized === "/resume") {
      setInput("");
      if (canResumeClaude) {
        setMessages([]);
        setInterruptingState(false);
        setBusyState(false);
        onResume();
      } else {
        push({
          role: "opus",
          kind: "error",
          text: "No Claude Fusion chat is available to resume."
        });
      }
      return true;
    }

    if (normalized === "/fast") {
      setInput("");
      applySpeedPreset("harness", "fast");
      return true;
    }

    if (normalized === "/opus") {
      setInput("/opus ");
      composerRef.current?.focus();
      return true;
    }

    if (normalized === "/opus model") {
      setInput("");
      applySettings({ model: "opus" }, "speed");
      return true;
    }

    const opusEffortMatch = normalized.match(/^\/opus\s+effort\s+(auto|low|medium|high|xhigh|max)$/);
    if (opusEffortMatch) {
      setInput("");
      applySettings({ model: "opus", claudeEffort: opusEffortMatch[1] as FusionEffort }, "Opus effort");
      return true;
    }

    const opusSpeedMatch = normalized.match(/^\/opus\s+(?:speed\s+)?(fast|balanced|deep|max)$/);
    if (opusSpeedMatch) {
      handleSlashCommand(`/speed planning ${opusSpeedMatch[1]}`);
      return true;
    }

    if (normalized === "/speed opus") {
      setInput("");
      applySpeedPreset("harness", "balanced");
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

      const nextModel = normalizeFusionModel(value);
      setInput("");
      applySettings({ model: nextModel }, "planning model");
      return true;
    }

    const claudeMatch = raw.match(/^\/(?:claude|model\s+claude)\s+(.+)$/i);
    if (claudeMatch) {
      const nextModel = normalizeFusionModel(claudeMatch[1]);
      setInput("");
      applySettings({ model: nextModel }, "Claude model");
      return true;
    }

    const codexEffortMatch = normalized.match(/^\/codex\s+effort\s+(auto|low|medium|high|xhigh|max)$/);
    if (codexEffortMatch) {
      setInput("");
      applySettings({ codexEffort: codexEffortMatch[1] as FusionEffort }, "Codex effort");
      return true;
    }

    const codexSpeedMatch = normalized.match(/^\/codex\s+(?:speed\s+)?(fast|balanced|deep|max)$/);
    if (codexSpeedMatch) {
      setInput("");
      applySpeedPreset("execution", codexSpeedMatch[1] as FusionSpeedPreset);
      return true;
    }

    const codexMatch = raw.match(/^\/(?:codex|model\s+codex)\s+(.+)$/i);
    if (codexMatch) {
      const nextModel = normalizeFusionCodexModel(codexMatch[1]);
      setInput("");
      applySettings({ codexModel: nextModel }, "Codex model");
      return true;
    }

    const effortMatch = normalized.match(/^\/effort(?:\s+(fusion|harness|planning|planner|claude|opus|execution|executor|codex))?\s+(auto|low|medium|high|xhigh|max)$/);
    if (effortMatch) {
      setInput("");
      applyEffortLevel(normalizeRoleScope(effortMatch[1]), effortMatch[2] as FusionEffort);
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
    setWaitingState(false);
    clearPendingDecision();
    window.vibe.fusionChat.sendUserTurn(session.id, text);
    setInput("");
    setInterruptingState(false);
    setBusyState(true);
    onStatusChangeRef.current("running");
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
    setInterruptingState(true);
    setInterruptStatus("Interrupt requested.");
  }

  useEffect(() => {
    if (!busy || !isSelected) return;
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      event.preventDefault();
      interrupt();
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
    // `interrupt` reads mutable refs, so the listener stays current without
    // rebinding for every transient interrupt-request render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, isSelected, session.id]);

  return (
    <article
      className={clsx(
        "terminal-pane",
        "fusion-pane",
        showAttention && "terminal-pane-attention",
        showAttention &&
          session.attention &&
          `terminal-pane-attention-${session.attention.state}`
      )}
      style={{ "--pane-accent": profile.accent } as React.CSSProperties}
      onPointerDown={onSelect}
    >
      <header className="pane-header pane-drag-zone" title="Drag header to move pane">
        <div className="pane-title">
          <GripVertical className="drag-grip" size={15} />
          <Sparkles size={15} />
          <span>{session.name}</span>
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
          <span
            className={`status-pill status-${
              busy ? "running" : waiting ? "waiting" : failed ? "failed" : "idle"
            }`}
          >
            {busy ? "working" : waiting ? "waiting" : failed ? "failed" : "ready"}
          </span>
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
          {canResumeClaude && (
            <button title="Resume last Fusion Claude chat" onClick={onResume}>
              <RotateCcw size={14} />
            </button>
          )}
          <button title={isMaximized ? "Restore pane" : "Maximize pane"} onClick={onMaximize}>
            {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="danger" title="Close pane" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="fusion-control-strip">
        <span className="fusion-control-path">{session.cwd}</span>
        <div className="fusion-controls">
          <span className="fusion-settings-summary" title="Type /help in the composer to change these">
            <span className="fusion-setting">
              <span className="fusion-setting-key">Mode</span>
              {fusionRunModeText}
            </span>
            {verbose && (
              <>
                <span className="fusion-setting">
                  <span className="fusion-setting-key">Planning</span>
                  {fusionModelLabel} / {FUSION_EFFORT_LABELS[fusionClaudeEffort]}
                </span>
                <span className="fusion-setting">
                  <span className="fusion-setting-key">Execution</span>
                  {codexModelLabel} / {FUSION_EFFORT_LABELS[fusionCodexEffort]}
                </span>
              </>
            )}
            <span className="fusion-settings-hint">/help</span>
          </span>
          <button
            type="button"
            className={clsx("fusion-verbose-toggle", verbose && "is-on")}
            title={verbose ? "Hide internal tool details" : "Show internal tool details"}
            aria-pressed={verbose}
            onClick={() => setVerbose((value) => !value)}
          >
            {verbose ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>Details</span>
          </button>
        </div>
      </div>

      <div className="fusion-chat" onPointerDown={onSelect}>
        <div className="fusion-chat-scroll" ref={scrollRef}>
          {visibleMessages.length === 0 ? (
            <div className="fusion-chat-empty">
              <Sparkles size={26} />
              <p>Fusion terminal — one agent for planning, coding, and review.</p>
              <p className="muted">Ask for a change to get started.</p>
            </div>
          ) : (
            visibleMessages.map((m) => {
              if (m.kind === "thinking" && !m.text.trim()) {
                return null;
              }

              const author = m.role === "user" ? "You" : FUSION_SPEAKER_LABEL;
              const className = clsx("chat-msg", `chat-${m.role}`, `chat-kind-${m.kind}`);

              // Collapsible detail: a tool result or Opus's thinking. Streams open
              // (live), then folds to a one-line preview; click / Details expands.
              if (m.kind === "tool-result" || m.kind === "thinking") {
                const preview = previewToolResult(m.text);
                const expandable = !m.streaming && preview !== m.text.trim();
                const open = m.streaming || verbose || expanded.has(m.key);
                return (
                  <div key={m.key} className={className}>
                    <span className="chat-gutter">●</span>
                    <div className="chat-body">
                      <div
                        className={clsx("chat-tool", expandable && "chat-tool-expandable")}
                        onClick={expandable ? () => toggleExpanded(m.key) : undefined}
                      >
                        <span className="chat-tool-author">{author}</span>
                        <span className="chat-tool-kind">
                          {m.kind === "thinking" ? "thinking" : "↳"}
                        </span>
                        {expandable && (
                          <span className="chat-tool-caret">{open ? "▾" : "▸"}</span>
                        )}
                        <span className="chat-tool-text">
                          {open ? m.text : preview}
                          {m.streaming && <span className="chat-caret">▋</span>}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              }

              // Compact one-line chip: a tool call or side-channel activity.
              if (m.kind === "tool-call" || m.kind === "activity") {
                return (
                  <div key={m.key} className={className}>
                    <span className="chat-gutter">●</span>
                    <div className="chat-body">
                      <div className="chat-tool">
                        <span className="chat-tool-author">{author}</span>
                        <span className="chat-tool-text">{m.text}</span>
                      </div>
                    </div>
                  </div>
                );
              }

              // Prose: user message, Opus narration, or an error.
              return (
                <div key={m.key} className={className}>
                  <span className="chat-gutter">{m.role === "user" ? "›" : ""}</span>
                  <div className="chat-body">
                    {m.role !== "user" && <span className="chat-author">{author}</span>}
                    <span className="chat-text">
                      {m.text}
                      {m.streaming && <span className="chat-caret">▋</span>}
                    </span>
                  </div>
                </div>
              );
            })
          )}
          {busy && (
            <div className={clsx("chat-msg", "chat-kind-status")}>
              <span className="chat-gutter chat-spinner">✻</span>
              <div className="chat-body">
                <span className="chat-text muted">{activeRoleLabel} working…</span>
              </div>
            </div>
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
          <div className="fusion-composer">
            <textarea
              ref={composerRef}
              value={input}
              placeholder={
                busy
                  ? "Steer the running turn…"
                  : waiting
                    ? pendingDecision
                      ? pendingDecisionIsQuestion
                        ? "Type the answer for Fusion…"
                        : "Choose an approval action or add guidance…"
                      : "Answer Fusion to continue…"
                    : "Ask Fusion to build, fix, or design…"
              }
              onChange={(e) => {
                inputRef.current = e.target.value;
                setInput(e.target.value);
              }}
              onPaste={handleComposerPaste}
              onDrop={handleComposerDrop}
              onDragOver={handleComposerDragOver}
              onKeyDown={(e) => {
                if (e.key === "Tab" && e.shiftKey) {
                  e.preventDefault();
                  toggleRunMode();
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
                    setInput("");
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    applySlashSelection(slashMenu.items[slashIndex] ?? slashMenu.items[0]);
                    return;
                  }
                }
                if (e.key === "Escape" && busy) {
                  e.preventDefault();
                  interrupt();
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
            />
            <button
              className="fusion-send"
              title={busy && !inputIsSlashCommand ? "Steer current turn (Enter)" : "Send (Enter)"}
              disabled={!input.trim()}
              onClick={send}
            >
              <Send size={15} />
            </button>
          </div>
          <div className="fusion-input-settings" title={`${fusionSettingsLine} · Shift+Tab toggles mode`}>
            <span className={clsx("fusion-mode-indicator", `is-${fusionRunMode}`)}>
              Mode: {fusionRunModeText}
            </span>
            <span className="fusion-mode-shortcut">Shift+Tab</span>
            <span className="fusion-settings-detail">{fusionSettingsLine}</span>
          </div>
          {slashMenuOpen && (
            <div className="fusion-slash-panel" aria-label="Slash command options">
              <div className="fusion-slash-title">{slashMenu.title}</div>
              <ul className="fusion-slash-menu" role="listbox" aria-label={slashMenu.title}>
                {slashMenu.items.map((item, i) => (
                  <li
                    key={item.key}
                    role="option"
                    aria-selected={i === slashIndex}
                    className={clsx("fusion-slash-item", i === slashIndex && "is-active")}
                    onMouseEnter={() => setSlashIndex(i)}
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
    </article>
  );
}
