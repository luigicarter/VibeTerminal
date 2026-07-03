import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Ban,
  Check,
  Copy,
  CopyPlus,
  ExternalLink,
  GripVertical,
  KeyRound,
  Maximize2,
  Minimize2,
  Orbit,
  Play,
  Plus,
  RefreshCcw,
  RotateCcw,
  X
} from "lucide-react";
import clsx from "clsx";
import { shouldShowAttentionDot } from "../attention";
import { cwdConflictChipLabel, cwdConflictTitle } from "../cwdConflicts";
import type { CwdConflict } from "../cwdConflicts";
import type {
  AgentAttentionEvent,
  AgentProfile,
  AgentSession,
  AgentThreadRef,
  OpenFusionAuthMethod,
  OpenFusionChatEvent,
  OpenFusionChatMessage,
  OpenFusionChatRole,
  OpenFusionProvider,
  OpenFusionToolMeta,
  SessionStatus
} from "../types";
import {
  customProviderIdForName,
  parseCustomProviderContextLimit,
  validateCustomProviderBaseUrl,
  validateCustomProviderModelId,
  validateCustomProviderName,
  validateOpenFusionModel
} from "../openFusion";

export interface OpenFusionSettingsChange {
  plannerModel?: string;
  executorModel?: string;
}

interface OpenFusionChatPaneProps {
  session: AgentSession;
  profile: AgentProfile;
  // Thread ids active in OTHER panes: the resume picker marks them and refuses
  // to open the same conversation twice (two panes writing one session id).
  claimedThreadIds?: string[];
  cwdConflict?: CwdConflict;
  isMaximized: boolean;
  isSelected: boolean;
  onClose: () => void;
  onDuplicate: () => void;
  onRestart: () => void;
  // Bare call resumes the stashed last chat; with a threadRef it resumes that
  // specific saved chat (the resume picker's selection).
  onResume: (threadRef?: AgentThreadRef) => void;
  onClear: () => void;
  onSettingsChange: (settings: OpenFusionSettingsChange) => void;
  onAdd: () => void;
  onSelect: () => void;
  onMaximize: () => void;
  onThreadRefChange: (threadRef: AgentThreadRef) => void;
  onStatusChange: (status: SessionStatus) => void;
  onAttention: (attention: AgentAttentionEvent) => void;
}

const COMPOSER_MAX_PX = 160;
const ROLE_LABELS: Record<"user" | OpenFusionChatRole, string> = {
  user: "You",
  brain: "Brain",
  executor: "Executor",
  investigator: "Scout"
};

// OpenCode's home-screen placeholder examples, verbatim.
const PROMPT_EXAMPLES = [
  "Fix a TODO in the codebase",
  "What is the tech stack of this project?",
  "Fix broken tests"
];

// Compact duration like OpenCode's Locale.duration: "12s", "1m 23s", "1h 2m".
function formatDurationShort(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

interface PendingPermission {
  requestId: string;
  role: OpenFusionChatRole;
  permission: string;
  patterns: string[];
  title?: string;
}

// One model the user is adding to a custom provider: the id the endpoint
// expects, the display name the pickers show, and an optional context window
// (tokens). Without a context limit opencode treats the window as unknown —
// calls still work, but auto-compaction is disabled for that model.
interface CustomModelDraft {
  id: string;
  name: string;
  contextLimit?: number;
}

// The connect flow mirrors OpenCode's own "Connect a provider" dialog: pick an
// auth method when a provider registers more than one, answer the method's
// prompt fields, then either store an API key (+ prompt answers as credential
// metadata) or run the OAuth authorize/callback pair.
//
// The custom-* stages are the add-custom-provider walk (OpenAI-compatible
// endpoint): name → base URL → optional key → one or more models (id +
// display name) → review/save. They ride the same AuthFlow state so the
// panel, focus trap, Esc-cancel, nonce, and auth-result plumbing all apply
// unchanged; the collected fields travel inside the step objects.
type AuthFlowStage =
  | { stage: "method" }
  | { stage: "prompts"; methodIndex: number; promptIndex: number; values: Record<string, string> }
  | { stage: "key"; methodIndex: number; metadata?: Record<string, string> }
  | { stage: "oauth-start"; methodIndex: number }
  | {
      stage: "oauth";
      methodIndex: number;
      flow: "code" | "auto";
      url: string;
      instructions: string;
    }
  | { stage: "waiting"; methodIndex: number }
  | { stage: "custom-name" }
  | { stage: "custom-url"; name: string }
  | { stage: "custom-key"; name: string; baseURL: string }
  | {
      stage: "custom-model-id";
      name: string;
      baseURL: string;
      key: string;
      models: CustomModelDraft[];
    }
  | {
      stage: "custom-model-name";
      name: string;
      baseURL: string;
      key: string;
      models: CustomModelDraft[];
      modelId: string;
    }
  | {
      stage: "custom-model-context";
      name: string;
      baseURL: string;
      key: string;
      models: CustomModelDraft[];
      modelId: string;
      modelName: string;
    }
  | {
      stage: "custom-review";
      name: string;
      baseURL: string;
      key: string;
      models: CustomModelDraft[];
    };

const CUSTOM_TEXT_STAGES = new Set([
  "custom-name",
  "custom-url",
  "custom-key",
  "custom-model-id",
  "custom-model-name",
  "custom-model-context"
]);

interface AuthFlow {
  providerId: string;
  name: string;
  nonce: string;
  methods: OpenFusionAuthMethod[];
  step: AuthFlowStage;
}

const DEFAULT_AUTH_METHODS: OpenFusionAuthMethod[] = [{ type: "api", label: "API key" }];

function deviceCodeFromInstructions(instructions: string) {
  return /[A-Z0-9]{4}-[A-Z0-9]{4,5}/.exec(instructions || "")?.[0] ?? "";
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

type PickerState =
  | { role: "brain" | "executor"; provider?: OpenFusionProvider }
  | { connect: "connect" | "disconnect" }
  // Saved-chat resume picker: null = list still loading. `error` renders as
  // "couldn't read" — an error must never masquerade as "no saved chats".
  | { resume: AgentThreadRef[] | null; error?: string }
  | null;

const SLASH_COMMANDS = [
  { name: "/brain-model", desc: "Pick the Brain (planner) model" },
  { name: "/executor-model", desc: "Pick the Executor model" },
  { name: "/connect", desc: "Connect a provider (API key or OAuth)" },
  { name: "/custom-provider", desc: "Add an OpenAI-compatible provider (your URL, key, and model names)" },
  { name: "/disconnect", desc: "Remove a provider's stored credential" },
  { name: "/models", desc: "Show the current Brain and Executor models" },
  { name: "/resume", desc: "Pick a saved chat from this folder to resume" },
  { name: "/details", desc: "Toggle tool execution details" },
  { name: "/new", desc: "Start a fresh conversation" },
  { name: "/clear", desc: "Clear this conversation" },
  { name: "/help", desc: "List the available commands" }
];

// The connect picker surfaces well-known providers first (the order opencode's
// own dialog uses for its "Popular" group), then the rest alphabetically —
// otherwise a 149-provider alphabetical catalog buries openrouter at #93.
const POPULAR_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "xai",
  "groq",
  "mistral",
  "deepseek",
  "github-copilot",
  "amazon-bedrock",
  "azure",
  "opencode"
];

function popularRank(id: string) {
  const index = POPULAR_PROVIDERS.indexOf(id);
  return index === -1 ? POPULAR_PROVIDERS.length : index;
}

function sortProvidersForPicker<T extends { id: string; name: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const rank = popularRank(a.id) - popularRank(b.id);
    return rank !== 0 ? rank : a.name.localeCompare(b.name);
  });
}

// Rows shown per picker page before the "N more — keep typing" hint row. The
// list scrolls; this only bounds render size, and the hint row makes the
// truncation VISIBLE (a hard silent cap of 14 was how "there isn't even an
// option to connect OpenRouter" happened).
const PICKER_PAGE_SIZE = 24;

function moreRow(key: string, remaining: number): SlashMenuItem {
  return {
    key,
    label: `… ${remaining} more`,
    desc: "Keep typing to filter the list"
  };
}

function clip(value: string, max: number) {
  const text = (value ?? "").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

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

function previewText(text: string): string {
  const line = (text ?? "")
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);
  return line ? clip(line, 120) : "(no output)";
}

// Collapsed STREAMING rows tick along on their latest line — a first-line
// preview would freeze the row the moment it starts. Only the tail is scanned:
// this runs on every flush of a growing block, and splitting the whole text
// each time would make long streams progressively slower.
function lastLinePreview(text: string): string {
  const tail = (text ?? "").slice(-600);
  const lines = tail.split("\n").map((value) => value.trim()).filter(Boolean);
  const line = lines[lines.length - 1];
  return line ? clip(line, 120) : "…";
}

function titleFromFirstPrompt(text: string) {
  return clip(text.replace(/\s+/g, " ").trim(), 80);
}

function shortModelLabel(model: string | undefined, fallback: string) {
  const value = (model || fallback).trim();
  const slash = value.indexOf("/");
  return slash > 0 ? value.slice(slash + 1) : value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

// ── OpenCode TUI parity: tool icons, labels, and row shapes ─────────────────
// Mirrors packages/tui/src/routes/session/index.tsx (v1.17.11): the same icon
// glyphs, pending texts, and label formats the real OpenCode TUI renders.

const TOOL_ICONS: Record<string, string> = {
  bash: "$",
  read: "→",
  glob: "✱",
  grep: "✱",
  list: "✱",
  webfetch: "%",
  websearch: "◈",
  write: "←",
  edit: "←",
  apply_patch: "%",
  task: "│",
  question: "→",
  skill: "→"
};

const TOOL_PENDING: Record<string, string> = {
  bash: "Writing command...",
  read: "Reading file...",
  glob: "Finding files...",
  grep: "Searching content...",
  webfetch: "Fetching from the web...",
  websearch: "Searching web...",
  write: "Preparing write...",
  edit: "Preparing edit...",
  apply_patch: "Preparing patch...",
  task: "Delegating...",
  todowrite: "Updating todos...",
  question: "Asking questions...",
  skill: "Loading skill..."
};

function toolIcon(name: string, status: OpenFusionChatMessage["toolStatus"]) {
  if (name === "task" && status === "done") return "✓";
  return TOOL_ICONS[name] ?? "⚙";
}

function titlecase(value: string) {
  const text = (value || "").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// opencode's `input()` helper: primitive args rendered as [k=v, …].
function inputSummary(input: unknown, omit: string[] = []): string {
  const data = asRecord(input);
  const primitives = Object.entries(data).filter(([key, value]) => {
    if (omit.includes(key)) return false;
    return (
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    );
  });
  if (!primitives.length) return "";
  return `[${primitives.map(([key, value]) => `${key}=${clip(String(value), 60)}`).join(", ")}]`;
}

// The one-line row text per tool, matching OpenCode's InlineTool children.
function toolLabel(name: string, input: unknown, meta?: OpenFusionToolMeta): string {
  const data = asRecord(input);
  switch (name) {
    case "read":
      return `Read ${firstString(data.filePath, data.path) || "file"} ${inputSummary(input, ["filePath", "path"])}`.trimEnd();
    case "edit":
      return `Edit ${firstString(data.filePath, data.path) || "file"}`;
    case "write":
      return `Write ${firstString(data.filePath, data.path) || "file"}`;
    case "bash":
      return firstString(data.command, data.description) || "command";
    case "glob": {
      const where = firstString(data.path);
      const count = meta?.count;
      return `Glob "${firstString(data.pattern)}"${where ? ` in ${where}` : ""}${
        typeof count === "number" ? ` (${count} ${count === 1 ? "match" : "matches"})` : ""
      }`;
    }
    case "grep": {
      const where = firstString(data.path);
      const matches = meta?.matches;
      return `Grep "${clip(firstString(data.pattern), 80)}"${where ? ` in ${where}` : ""}${
        typeof matches === "number" ? ` (${matches} ${matches === 1 ? "match" : "matches"})` : ""
      }`;
    }
    case "webfetch":
      return `WebFetch ${clip(firstString(data.url), 100)}`;
    case "websearch":
      return `WebSearch "${clip(firstString(data.query), 80)}"`;
    case "todowrite":
      return "Todos";
    case "todoread":
      return "Read the task list";
    case "skill":
      return `Skill "${firstString(data.name)}"`;
    default:
      return `${name} ${inputSummary(input)}`.trimEnd();
  }
}

// OpenCode's formatSubagentTitle: "Executor Task — description".
function subagentTitle(input: unknown, fallbackTitle: string) {
  const data = asRecord(input);
  const agent = titlecase(firstString(data.subagent_type) || "executor");
  const description = firstString(data.description, fallbackTitle) || "subtask";
  return `${agent} Task — ${clip(description, 160)}`;
}

interface TodoEntry {
  status: string;
  content: string;
}

function parseTodos(value: unknown): TodoEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const todo = asRecord(item);
    const status = firstString(todo.status);
    const content = firstString(todo.content);
    return status && content ? [{ status, content }] : [];
  });
}

// OpenCode treats permission-rejected tool errors as "denied" (strikethrough).
function isDeniedError(text: string) {
  return (
    text.includes("QuestionRejectedError") ||
    text.includes("rejected permission") ||
    text.includes("specified a rule") ||
    text.includes("user dismissed")
  );
}

const OUTPUT_COLLAPSE_LINES = 10;

function collapseOutput(text: string, maxLines: number) {
  const lines = (text ?? "").split("\n");
  if (lines.length <= maxLines) return { output: text, overflow: false };
  return { output: lines.slice(0, maxLines).join("\n"), overflow: true };
}

// The executor's task report comes back wrapped in <task …><task_result>…</…>.
function extractTaskResult(text: string) {
  const match = /<task_result>([\s\S]*?)<\/task_result>/.exec(text ?? "");
  return (match ? match[1] : text ?? "").trim();
}

function permissionDetail(pending: PendingPermission) {
  const patterns = pending.patterns.filter(Boolean).join(", ");
  const scope = pending.title ? `${pending.title} — ` : "";
  return `${scope}${pending.permission}${patterns ? ` (${patterns})` : ""}`;
}

// OpenCode's "blocks" busy spinner: a knight-rider sweep of block cells,
// animated in CSS (styles.css .oc-spinner).
function OcSpinner() {
  return (
    <span className="oc-spinner" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

// Brain prose renders as markdown like the OpenCode TUI. Links must open in
// the system browser — a plain anchor would navigate the Electron window.
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              if (href) void window.vibe?.openFusionChat?.openExternal(href);
            }}
          >
            {children}
          </a>
        )
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

// Unified-diff body for Edit tool rows, colored like OpenCode's diff view.
// File headers are dropped — the block title already names the file.
const DiffBlock = memo(function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.replace(/\n+$/, "").split("\n");
  return (
    <div className="oc-diff">
      {lines.map((line, i) => {
        if (
          line.startsWith("+++") ||
          line.startsWith("---") ||
          line.startsWith("diff ") ||
          line.startsWith("Index:") ||
          line.startsWith("\\ No newline")
        ) {
          return null;
        }
        const kind = line.startsWith("@@")
          ? "hunk"
          : line.startsWith("+")
            ? "add"
            : line.startsWith("-")
              ? "del"
              : "ctx";
        return (
          <div key={i} className={`oc-diff-line is-${kind}`}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
});

// Block-letter wordmark in OpenCode's exact logo technique (left word muted,
// right word bold, "_/^/~" shadow cells), spelling OPEN FUSION. Letter shapes
// reuse OpenCode's glyph font; F/U/S/I are derived in the same style.
const LOGO_LEFT = [
  "                   ",
  "█▀▀█ █▀▀█ █▀▀█ █▀▀▄",
  "█__█ █__█ █^^^ █__█",
  "▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀~~▀"
];
const LOGO_RIGHT = [
  "                          ",
  "█▀▀▀ █__█ █▀▀▀ █ █▀▀█ █▀▀▄",
  "█^^^ █__█ ^^^█ █ █__█ █__█",
  "▀    ▀▀▀▀ ▀▀▀▀ ▀ ▀▀▀▀ ▀~~▀"
];

function LogoLine({ line, bold }: { line: string; bold?: boolean }) {
  return (
    <span className={clsx("oc-logo-word", bold && "is-bold")}>
      {Array.from(line).map((ch, i) => {
        if (ch === "_") {
          return (
            <span key={i} className="oc-logo-shbg">
              {" "}
            </span>
          );
        }
        if (ch === "^") {
          return (
            <span key={i} className="oc-logo-shbg">
              ▀
            </span>
          );
        }
        if (ch === "~") {
          return (
            <span key={i} className="oc-logo-sh">
              ▀
            </span>
          );
        }
        return <span key={i}>{ch}</span>;
      })}
    </span>
  );
}

function OpenFusionLogo() {
  return (
    <div className="oc-logo" role="img" aria-label="Open Fusion">
      {LOGO_LEFT.map((line, i) => (
        <div key={i} className="oc-logo-row">
          <LogoLine line={line} />
          <LogoLine line={LOGO_RIGHT[i]} bold />
        </div>
      ))}
    </div>
  );
}

// One transcript row, memoized: a streaming delta re-renders ONLY the growing
// bubble instead of reconciling every row of a long transcript per chunk —
// that full-list churn is what made streaming feel choppy.
//
// Row shapes mirror OpenCode's TUI part renderers (v1.17.11): user blocks with
// a colored left bar, markdown prose, inline tool rows with icon glyphs, block
// panels for bash output / diffs / todos, "+ Thought" collapsibles, and
// "Agent Task — description" delegation rows with a "↳" progress line.
const OpenFusionChatRow = memo(function OpenFusionChatRow({
  m,
  isExpanded,
  onToggle
}: {
  m: OpenFusionChatMessage;
  isExpanded: boolean;
  onToggle: (key: string) => void;
}) {
  // Subagent text streams (the executor's code-in-progress, Scout's report
  // drafts) are raw work product like tool output and reasoning — never
  // full-width transcript prose.
  const isSubagentStream = m.kind === "text" && m.role !== "user" && m.role !== "brain";
  if ((m.kind === "thinking" || isSubagentStream) && !m.text.trim()) {
    return null;
  }

  if (m.kind === "tool") {
    const name = m.toolName ?? "tool";
    const status = m.toolStatus ?? "running";
    const data = asRecord(m.toolInput);
    const denied = status === "error" && isDeniedError(m.toolOutput ?? "");
    const failed = status === "error" && !denied;

    // Delegations: OpenCode's Task row — spinner/│ while running, ✓ when done,
    // "Executor Task — description" + "↳ current work / N toolcalls · 12s".
    // Click reveals the subagent's report.
    if (name === "task") {
      const report = (m.toolOutput ?? "").trim();
      return (
        <div className={clsx("oc-tool", "oc-task", `is-${status}`, denied && "is-denied", failed && "is-failed")}>
          <div
            className={clsx("oc-tool-row", report && "oc-clickable")}
            onClick={report ? () => onToggle(m.key) : undefined}
          >
            <span className="oc-tool-icon">
              {status === "running" ? <OcSpinner /> : toolIcon(name, status)}
            </span>
            <span className="oc-tool-label">
              {subagentTitle(m.toolInput, m.text)}
              {m.taskDetail && <span className="oc-task-detail">{"\n"}↳ {m.taskDetail}</span>}
            </span>
          </div>
          {isExpanded && report && (
            <div className="oc-task-report">
              <Markdown text={report} />
            </div>
          )}
        </div>
      );
    }

    // Bash: OpenCode's block panel — "$ command" plus output, collapsed at 10
    // lines with the TUI's "Click to expand" affordance.
    if (name === "bash") {
      const command = firstString(data.command, data.description) || "command";
      const output = (m.toolOutput ?? "").trim();
      if (status === "running") {
        return (
          <div className="oc-tool is-running">
            <div className="oc-tool-row">
              <span className="oc-tool-icon">
                <OcSpinner />
              </span>
              <span className="oc-tool-label">{command}</span>
            </div>
          </div>
        );
      }
      const collapsed = collapseOutput(output, OUTPUT_COLLAPSE_LINES);
      const shown = isExpanded || !collapsed.overflow ? output : collapsed.output;
      return (
        <div
          className={clsx("oc-block", failed && "is-failed", collapsed.overflow && "oc-clickable")}
          onClick={collapsed.overflow ? () => onToggle(m.key) : undefined}
        >
          <div className="oc-block-cmd">$ {command}</div>
          {shown && <pre className={clsx("oc-block-output", failed && "is-error")}>{shown}</pre>}
          {collapsed.overflow && (
            <div className="oc-block-hint">{isExpanded ? "Click to collapse" : "Click to expand"}</div>
          )}
        </div>
      );
    }

    // Edits that came back with a diff: OpenCode's "← Edit path" diff panel.
    if (name === "edit" && status === "done" && m.meta?.diff) {
      return (
        <div className="oc-block">
          <div className="oc-block-title">← Edit {firstString(data.filePath, data.path) || "file"}</div>
          <DiffBlock diff={m.meta.diff} />
        </div>
      );
    }

    // Todos: OpenCode's "# Todos" checklist panel.
    if (name === "todowrite" && status !== "error") {
      const todos = parseTodos(data.todos);
      if (todos.length) {
        return (
          <div className="oc-block">
            <div className="oc-block-title"># Todos</div>
            <div className="oc-todos">
              {todos.map((todo, i) => (
                <div key={i} className={clsx("oc-todo", `is-${todo.status}`)}>
                  [{todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "•" : " "}]{" "}
                  {todo.content}
                </div>
              ))}
            </div>
          </div>
        );
      }
    }

    // Everything else: OpenCode's inline one-liner. "~ pending" before the
    // input arrives, bright while running, muted once complete, red + click-
    // to-expand on failure, strikethrough when the user denied it.
    const hasInput = Object.keys(data).length > 0;
    const error = (m.toolOutput ?? "").trim();
    return (
      <div className={clsx("oc-tool", `is-${status}`, denied && "is-denied", failed && "is-failed")}>
        <div
          className={clsx("oc-tool-row", failed && error && "oc-clickable")}
          onClick={failed && error ? () => onToggle(m.key) : undefined}
        >
          {!hasInput && status === "running" ? (
            <span className="oc-tool-pending">~ {TOOL_PENDING[name] ?? "Working..."}</span>
          ) : (
            <>
              <span className="oc-tool-icon">
                {status === "running" && name === "read" ? <OcSpinner /> : toolIcon(name, status)}
              </span>
              <span className="oc-tool-label">{toolLabel(name, m.toolInput, m.meta)}</span>
            </>
          )}
        </div>
        {failed && isExpanded && error && <pre className="oc-tool-error">{error}</pre>}
      </div>
    );
  }

  // Reasoning: OpenCode's spinner-while-thinking, then a "+ Thought: title"
  // one-liner that expands to the full trace.
  if (m.kind === "thinking") {
    const content = m.text.replace("[REDACTED]", "").trim();
    if (m.streaming) {
      return (
        <div className="oc-thought">
          <span className="oc-thought-head">
            <OcSpinner /> Thinking
          </span>
        </div>
      );
    }
    const title = clip(content.split("\n").find((line) => line.trim()) ?? "", 100);
    return (
      <div className="oc-thought">
        <span className="oc-thought-head oc-clickable" onClick={() => onToggle(m.key)}>
          {isExpanded ? "- " : "+ "}Thought: {title}
        </span>
        {isExpanded && <pre className="oc-thought-body">{content}</pre>}
      </div>
    );
  }

  // Subagent work product: a muted "↳" ticker line (OpenCode keeps subagent
  // internals out of the parent transcript; the Details toggle reveals these).
  if (isSubagentStream) {
    const preview = m.streaming ? lastLinePreview(m.text) : previewText(m.text);
    const expandable = preview !== m.text.trim();
    return (
      <div className={clsx("oc-workline", `oc-role-${m.role}`)}>
        <span
          className={clsx("oc-workline-text", expandable && "oc-clickable")}
          onClick={expandable ? () => onToggle(m.key) : undefined}
        >
          ↳ {isExpanded ? m.text : preview}
          {m.streaming && <span className="oc-caret">▋</span>}
        </span>
      </div>
    );
  }

  // Turn completion: OpenCode's "▣ Mode · model · duration" line.
  if (m.kind === "result") {
    return (
      <div className="oc-turnend">
        <span className="oc-turnend-mark">▣ </span>
        <span className="oc-turnend-mode">{m.text}</span>
        {m.taskDetail && <span className="oc-turnend-meta"> · {m.taskDetail}</span>}
      </div>
    );
  }

  // Errors: OpenCode's left-bordered error panel.
  if (m.kind === "error") {
    return <div className="oc-errorblock">{m.text}</div>;
  }

  // System notices ("Provider connected.", "Turn interrupted.").
  if (m.kind === "activity" || m.kind === "tool-call" || m.kind === "tool-result") {
    return <div className="oc-note">{m.text}</div>;
  }

  // User prompt: OpenCode's accent-barred panel block.
  if (m.role === "user") {
    return (
      <div className="oc-user">
        <div className="oc-user-text">{m.text}</div>
      </div>
    );
  }

  // Brain prose: markdown, OpenCode's TextPart.
  return (
    <div className={clsx("oc-md", m.streaming && "is-streaming")}>
      <Markdown text={m.text} />
      {m.streaming && <span className="oc-caret">▋</span>}
    </div>
  );
});

export default function OpenFusionChatPane({
  session,
  profile,
  claimedThreadIds,
  cwdConflict,
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
}: OpenFusionChatPaneProps) {
  const [messages, setMessages] = useState<OpenFusionChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  // Messages sent mid-turn (steering). The server has them queued; they stay
  // pinned above the composer — opencode's QUEUED badge mechanic — until the
  // Brain's next step absorbs them into context, then they join the transcript
  // at that point instead of drowning mid-stream.
  const [steering, setSteering] = useState<{ key: string; text: string }[]>([]);
  const [activeRole, setActiveRole] = useState<OpenFusionChatRole>("brain");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // OpenCode's /details defaults ON: tool rows are part of the transcript.
  const [verbose, setVerbose] = useState(true);
  // Last turn's usage — the composer status row's right-side readout, like
  // OpenCode's context/cost line.
  const [usage, setUsage] = useState<{
    costUsd?: number;
    tokens?: { input: number; output: number; reasoning: number };
  } | null>(null);
  // Cycling composer placeholder, OpenCode's "Ask anything..." examples.
  const [placeholderIndex, setPlaceholderIndex] = useState(() =>
    Math.floor(Math.random() * PROMPT_EXAMPLES.length)
  );
  const [slashIndex, setSlashIndex] = useState(0);
  // Esc hides the input-derived command menu without erasing the typed text;
  // any input change re-arms it.
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [picker, setPicker] = useState<PickerState>(null);
  // Serializes saved-chat list requests: a stale response (picker closed and
  // reopened, or closed outright) must not repopulate the menu.
  const resumeListRequestRef = useRef(0);
  const [providers, setProviders] = useState<OpenFusionProvider[] | null>(null);
  const [availableProviders, setAvailableProviders] = useState<{ id: string; name: string }[]>([]);
  // False when the connected list loaded but the full catalog fetch failed —
  // the pickers must say the list is partial instead of silently refusing
  // providers as "not in the catalog".
  const [catalogOk, setCatalogOk] = useState(true);
  const [authFlow, setAuthFlow] = useState<AuthFlow | null>(null);
  // Shared text field for the auth flow's current input (key, prompt answer,
  // or pasted OAuth code). Never echoed into the transcript.
  const [authText, setAuthText] = useState("");
  const [providerAuthMethods, setProviderAuthMethods] = useState<
    Record<string, OpenFusionAuthMethod[]>
  >({});
  // The picker role that led into a connect flow, so a successful connect can
  // drop the user back into the model pick they were doing.
  const authReturnRoleRef = useRef<"brain" | "executor" | null>(null);
  // Set on a successful connect: when the refreshed catalog lands, drill the
  // picker straight into the newly connected provider's model list — the same
  // connect → browse-models handoff opencode's own dialog performs.
  const pendingModelBrowseRef = useRef<{
    role: "brain" | "executor";
    providerId: string;
  } | null>(null);
  const authInputRef = useRef<HTMLInputElement | null>(null);
  // First button of a buttons-only auth stage (method choice / select prompt):
  // focused on entry so keyboard users aren't typing into the composer while
  // the auth panel is open (that's how pasted API keys ended up in the chat
  // input).
  const authPrimaryButtonRef = useRef<HTMLButtonElement | null>(null);
  const authFlowRef = useRef<AuthFlow | null>(null);
  const authNonceRef = useRef(0);
  // /connect issued before the provider catalog arrived: open the flow as soon
  // as the providers event lands.
  const pendingConnectRef = useRef<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // Keeps the highlighted menu row visible now that picker lists scroll
  // instead of being hard-capped.
  const activeMenuItemRef = useRef<HTMLLIElement | null>(null);
  const keyRef = useRef(0);
  const busyRef = useRef(false);
  const interruptingRef = useRef(false);
  const waitingRef = useRef(false);
  // Follow the stream only while the user is at the bottom — auto-scroll used
  // to yank the view down on EVERY delta, which made reading scrollback during
  // a turn impossible. Scrolling back to the bottom re-pins.
  const pinnedToBottomRef = useRef(true);
  // streamKey (streamId:kind) -> transcript message key, so concurrent streams
  // each append to their own bubble.
  const streamBubblesRef = useRef(new Map<string, string>());
  // Event-handler mirror of `steering` (the handler closure is frozen at mount).
  const steeringRef = useRef<{ key: string; text: string }[]>([]);
  // An abort settles as session.idle → a trailing "result" event; this latch
  // keeps that settle from overwriting the interrupted waiting-state with
  // done/completed. Armed by "interrupted", cleared by the next turn-start.
  const interruptSettledRef = useRef(false);
  const pendingRestartNoticeRef = useRef<string | null>(null);
  // Turn wall-clock start, for the "▣ Brain · model · 32s" completion line.
  const turnStartRef = useRef(0);
  // Running delegations: task toolId -> row key + stats, plus an index from
  // subagent kind to the task currently owning that kind's child events —
  // powers the Task rows' "↳ current work / N toolcalls · 12s" line.
  const tasksByToolIdRef = useRef(
    new Map<string, { key: string; startTs: number; toolcalls: number }>()
  );
  const taskRoleIndexRef = useRef(new Map<string, string>());
  const threadIdRef = useRef("");
  const threadTitleRef = useRef("");
  const onThreadRefChangeRef = useRef(onThreadRefChange);
  const onStatusChangeRef = useRef(onStatusChange);
  const onAttentionRef = useRef(onAttention);

  // No default models: "" = not chosen yet. The pane gates the first turn on
  // connect-a-provider + explicit Brain/Executor picks instead of assuming a
  // vendor pair the app-owned (initially empty) credential store can't serve.
  const plannerModel =
    validateOpenFusionModel(session.openFusionPlannerModel) === null
      ? String(session.openFusionPlannerModel).trim()
      : "";
  const executorModel =
    validateOpenFusionModel(session.openFusionExecutorModel) === null
      ? String(session.openFusionExecutorModel).trim()
      : "";
  const modelsReady = Boolean(plannerModel && executorModel);
  // Current picks, readable from the session-scoped event handler (its closure
  // is frozen at first render, which used to misroute the post-connect
  // drill-in to "brain" even when the Brain was already set).
  const plannerModelRef = useRef(plannerModel);
  const executorModelRef = useRef(executorModel);
  plannerModelRef.current = plannerModel;
  executorModelRef.current = executorModel;
  const brainLabel = plannerModel ? shortModelLabel(plannerModel, "") : "not set";
  const executorLabel = executorModel
    ? shortModelLabel(executorModel, "")
    : "not set";
  const modelsLine = `Brain ${plannerModel || "not set"} · Executor ${executorModel || "not set"}`;
  // Composer status readout, like OpenCode's context/cost line.
  const usageLabel = (() => {
    if (!usage) return "";
    const total = usage.tokens
      ? usage.tokens.input + usage.tokens.output + usage.tokens.reasoning
      : 0;
    return [
      total > 0 ? `${total >= 1000 ? `${(total / 1000).toFixed(1)}k` : total} tokens` : "",
      typeof usage.costUsd === "number" && usage.costUsd > 0
        ? `$${usage.costUsd.toFixed(2)}`
        : ""
    ]
      .filter(Boolean)
      .join(" · ");
  })();
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
  const showAttention = shouldShowAttentionDot(session);
  const canResume =
    session.resumeRef?.provider === "opencode" && Boolean(session.resumeRef.id);
  // OpenCode's /details-off rule: successful completed tool rows disappear,
  // running/failed rows stay, delegations (task) stay. Everything tagged
  // internal (subagent work product, stderr) needs details on.
  const visibleMessages = verbose
    ? messages
    : messages.filter((message) => {
        if (message.kind === "tool") {
          return message.toolName === "task" || message.toolStatus !== "done";
        }
        return !message.internal;
      });

  useEffect(() => {
    onThreadRefChangeRef.current = onThreadRefChange;
    onStatusChangeRef.current = onStatusChange;
    onAttentionRef.current = onAttention;
  }, [onThreadRefChange, onStatusChange, onAttention]);

  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const resize = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`;
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

  useEffect(() => {
    setSlashIndex(0);
    setMenuDismissed(false);
  }, [input, picker]);

  // Rotate the composer's example placeholder like OpenCode's home prompt.
  useEffect(() => {
    const timer = window.setInterval(
      () => setPlaceholderIndex((index) => (index + 1) % PROMPT_EXAMPLES.length),
      10_000
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    activeMenuItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [slashIndex]);

  useEffect(() => {
    authFlowRef.current = authFlow;
  }, [authFlow]);

  // Every auth stage takes keyboard focus: text stages focus their input,
  // buttons-only stages (method choice, select prompts) focus their first
  // button — otherwise keystrokes (like a pasted API key) land in the
  // composer behind the panel.
  useEffect(() => {
    if (!authFlow) return;
    const step = authFlow.step;
    if (
      step.stage === "key" ||
      CUSTOM_TEXT_STAGES.has(step.stage) ||
      (step.stage === "prompts" &&
        authFlow.methods[step.methodIndex]?.prompts?.[step.promptIndex]?.type !==
          "select") ||
      (step.stage === "oauth" && step.flow === "code")
    ) {
      authInputRef.current?.focus();
    } else if (
      step.stage === "method" ||
      step.stage === "prompts" ||
      step.stage === "custom-review"
    ) {
      authPrimaryButtonRef.current?.focus();
    }
  }, [authFlow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, busy]);

  const handleChatScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  const nextKey = () => `m${keyRef.current++}`;
  const push = (
    entry: Omit<OpenFusionChatMessage, "key" | "ts"> & { ts?: number }
  ) => {
    const key = nextKey();
    setMessages((prev) => [...prev, { key, ts: Date.now(), ...entry }]);
    return key;
  };
  const queueSteering = (text: string) => {
    steeringRef.current = [...steeringRef.current, { key: nextKey(), text }];
    setSteering(steeringRef.current);
  };
  // Move pinned steering messages into the transcript — at the absorption
  // point (next Brain step) they land exactly where they entered the model's
  // context; at a turn boundary they land last, right above the composer.
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
        text: item.text,
        ts: Date.now()
      }))
    ]);
  };
  const setBusyState = (next: boolean) => {
    busyRef.current = next;
    setBusy(next);
  };
  const setWaitingState = (next: boolean) => {
    waitingRef.current = next;
    setWaiting(next);
  };
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

  function publishThreadRef() {
    const threadId = threadIdRef.current;
    if (!threadId) return;
    onThreadRefChangeRef.current({
      provider: "opencode",
      id: threadId,
      // Never fall back to the pane's placeholder label ("Open Fusion 2") —
      // the title stays empty until OpenCode generates a real one.
      title: threadTitleRef.current || session.threadRef?.title,
      createdAt: session.threadRef?.createdAt ?? session.createdAt,
      updatedAt: Date.now()
    });
  }

  // (Re)attach to the headless OpenCode server on launch. The host owns the
  // process lifetime; unmounting this view must not stop the pane's engine when
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
              role: "brain",
              kind: "activity",
              text: restartNotice,
              ts: Date.now()
            }
          ]
        : []
    );
    setExpanded(new Set());
    setActiveRole("brain");
    setPendingPermission(null);
    setWaitingState(false);
    setInterruptingState(false);
    setBusyState(false);
    setFailed(false);
    setPicker(null);
    streamBubblesRef.current.clear();
    steeringRef.current = [];
    setSteering([]);
    interruptSettledRef.current = false;
    onStatusChangeRef.current("starting");
    let cancelled = false;
    const resumeThreadRef =
      session.nextLaunchMode === "resume" &&
      session.threadRef?.provider === "opencode" &&
      session.threadRef.id
        ? session.threadRef
        : undefined;
    threadIdRef.current = resumeThreadRef?.id ?? "";
    threadTitleRef.current = resumeThreadRef?.title ?? "";
    const resumeId = resumeThreadRef?.id;
    const openFusionChat = window.vibe?.openFusionChat;
    if (!openFusionChat?.start) {
      const message = "Open Fusion unavailable: the chat bridge is not available.";
      push({ role: "brain", kind: "error", text: message });
      emitAttention("failed", "error", message);
      return;
    }
    const startTimer = window.setTimeout(() => {
      void (async () => {
        if (cancelled) return;

        // Confirm the saved session id before resuming — the server is the
        // final authority, but a missing thread should self-heal to a fresh
        // chat instead of a dead pane (same contract as the other panes).
        let effectiveResumeId = resumeId;
        if (resumeId && window.vibe?.agentThreads) {
          try {
            const confirm = await window.vibe.agentThreads.findLatest({
              provider: "opencode",
              cwd: session.cwd,
              confirmId: resumeId,
              // Look in the app-owned OpenCode store, not the user's global one.
              openFusion: true
            });
            if (confirm?.status === "missing") {
              effectiveResumeId = undefined;
              threadIdRef.current = "";
              threadTitleRef.current = "";
              push({
                role: "brain",
                kind: "activity",
                text: "The saved Open Fusion chat is no longer available to resume. Starting a fresh chat instead."
              });
            }
          } catch {
            // Confirmation unavailable: attempt the resume rather than discard
            // a conversation that may well exist.
          }
        }

        if (cancelled) return;

        openFusionChat
          .start({
            id: session.id,
            cwd: session.cwd,
            resumeId: effectiveResumeId,
            plannerModel,
            executorModel
          })
          .then((result) => {
            if (cancelled || !result || result.ok !== false) return;
            const message = `Open Fusion unavailable: ${result.error}`;
            push({ role: "brain", kind: "error", text: message });
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

  // Normalize the host event stream into the transcript view-model.
  useEffect(() => {
    // Stream deltas are BATCHED: each one used to be its own setMessages (its
    // own render + forced scroll layout), so a fast stream re-rendered the
    // whole transcript dozens of times a second — the choppiness. Deltas now
    // buffer and flush at most once per animation frame; every non-delta event
    // flushes synchronously first so transcript ordering never changes.
    const pendingDeltas: {
      role: OpenFusionChatRole;
      kind: "text" | "thinking";
      delta: string;
      streamId?: string;
    }[] = [];
    let deltaFlushHandle: number | null = null;
    const applyDeltaBatch = () => {
      if (!pendingDeltas.length) return;
      const batch = pendingDeltas.splice(0, pendingDeltas.length);
      setMessages((prev) => {
        let next: OpenFusionChatMessage[] | null = null;
        for (const { role, kind, delta, streamId } of batch) {
          if (kind === "thinking" && !delta.trim()) continue;
          const arr = (next ??= prev.slice());
          // Bubbles are keyed by the producing OpenCode part (streamId):
          // several parts can stream CONCURRENTLY on one feed (parallel Scout
          // subagents, reasoning beside text), and merging by role alone
          // interleaved them chunk-by-chunk into one garbled paragraph. Each
          // stream appends to its OWN bubble wherever it sits in the
          // transcript.
          const streamKey = streamId ? `${streamId}:${kind}` : null;
          if (streamKey) {
            const messageKey = streamBubblesRef.current.get(streamKey);
            let index = -1;
            if (messageKey) {
              for (let i = arr.length - 1; i >= 0; i -= 1) {
                if (arr[i].key === messageKey) {
                  index = i;
                  break;
                }
              }
            }
            if (index !== -1 && arr[index].streaming) {
              arr[index] = { ...arr[index], text: arr[index].text + delta };
              continue;
            }
            const key = nextKey();
            streamBubblesRef.current.set(streamKey, key);
            // Streamed bubbles stay in the transcript: only Brain TEXT renders
            // as prose — thinking renders as OpenCode's "+ Thought" line, and
            // subagent streams (the executor's code-in-progress, Scout's
            // drafts) are Details-lane work product like OpenCode keeps
            // subagent internals out of the parent transcript.
            arr.push({
              key,
              role,
              kind,
              text: delta,
              ts: Date.now(),
              streaming: true,
              internal: kind === "text" && role !== "brain"
            });
            continue;
          }
          // Legacy path (events without streamId, e.g. history replayed by an
          // older host): append to the open bubble while it is the latest
          // message; a role or kind switch starts a fresh bubble.
          const last = arr[arr.length - 1];
          if (last && last.role === role && last.kind === kind && last.streaming) {
            arr[arr.length - 1] = { ...last, text: last.text + delta };
            continue;
          }
          for (let i = 0; i < arr.length; i += 1) {
            if (arr[i].streaming) arr[i] = { ...arr[i], streaming: false };
          }
          arr.push({
            key: nextKey(),
            role,
            kind,
            text: delta,
            ts: Date.now(),
            streaming: true,
            internal: kind === "text" && role !== "brain"
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
    const appendStreaming = (
      role: OpenFusionChatRole,
      kind: "text" | "thinking",
      delta: string,
      streamId?: string
    ) => {
      pendingDeltas.push({ role, kind, delta, streamId });
      if (deltaFlushHandle === null) {
        deltaFlushHandle = requestAnimationFrame(() => {
          deltaFlushHandle = null;
          applyDeltaBatch();
        });
      }
    };
    const stopStreaming = () => {
      streamBubblesRef.current.clear();
      setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
    };
    // An abort/exit leaves tool rows spinning forever — settle them as aborted
    // (OpenCode's server marks aborted tool parts as errors the same way).
    const settleRunningTools = () => {
      tasksByToolIdRef.current.clear();
      taskRoleIndexRef.current.clear();
      setMessages((prev) =>
        prev.map((m) =>
          m.kind === "tool" && m.toolStatus === "running"
            ? { ...m, toolStatus: "error" as const, toolOutput: m.toolOutput || "aborted" }
            : m
        )
      );
    };
    // OpenCode's turn-completion line: "▣ Brain · model · 32s".
    const pushTurnEnd = (interrupted: boolean) => {
      const duration = turnStartRef.current ? Date.now() - turnStartRef.current : 0;
      turnStartRef.current = 0;
      push({
        role: "brain",
        kind: "result",
        text: "Brain",
        taskDetail: [
          shortModelLabel(plannerModelRef.current, "model"),
          duration ? formatDurationShort(duration) : "",
          interrupted ? "interrupted" : ""
        ]
          .filter(Boolean)
          .join(" · ")
      });
    };

    const handleChat = (event: OpenFusionChatEvent) => {
      if (!("id" in event) || event.id !== session.id) {
        if (event.type === "host-error") {
          push({ role: "brain", kind: "error", text: event.message });
          setInterruptingState(false);
          setBusyState(false);
          emitAttention("failed", "error", event.message);
        }
        return;
      }
      if (event.type !== "assistant-text" && event.type !== "thinking") {
        flushDeltas();
      }
      switch (event.type) {
        case "session":
          threadIdRef.current = event.sessionId;
          publishThreadRef();
          // The engine is ready: load the provider catalog now so the
          // first-run gate and needs-auth labels have real data, instead of
          // waiting for the user to open a picker.
          void window.vibe?.openFusionChat?.requestProviders(session.id);
          break;
        case "user":
          if (!threadTitleRef.current) {
            threadTitleRef.current = titleFromFirstPrompt(event.text);
            publishThreadRef();
          }
          if (event.queued) {
            queueSteering(event.text);
          } else {
            push({ role: "user", kind: "text", text: event.text });
          }
          break;
        case "turn-start":
          // A fresh turn reads the whole message list — anything still pinned
          // is in its context now.
          flushSteering();
          interruptSettledRef.current = false;
          turnStartRef.current = Date.now();
          tasksByToolIdRef.current.clear();
          taskRoleIndexRef.current.clear();
          setActiveRole("brain");
          setInterruptingState(false);
          setWaitingState(false);
          setFailed(false);
          setPendingPermission(null);
          setBusyState(true);
          onStatusChangeRef.current("running");
          break;
        case "step-start":
          // The Brain started its next step: queued steering is absorbed.
          flushSteering();
          break;
        case "assistant-text":
          setActiveRole(event.role);
          appendStreaming(event.role, "text", event.delta, event.streamId);
          break;
        case "thinking":
          setActiveRole(event.role);
          appendStreaming(event.role, "thinking", event.delta, event.streamId);
          break;
        case "stream-end": {
          // The producing part finished — retire ITS bubble's caret now
          // instead of leaving every finished row blinking until the turn
          // settles. Pending deltas already flushed via the non-delta gate
          // above. stopStreaming() stays the net for interrupts/aborts, whose
          // parts never get a time.end.
          const keys: string[] = [];
          for (const kind of ["text", "thinking"] as const) {
            const streamKey = `${event.streamId}:${kind}`;
            const messageKey = streamBubblesRef.current.get(streamKey);
            if (messageKey) {
              keys.push(messageKey);
              streamBubblesRef.current.delete(streamKey);
            }
          }
          if (keys.length) {
            setMessages((prev) =>
              prev.map((m) => (keys.includes(m.key) && m.streaming ? { ...m, streaming: false } : m))
            );
          }
          break;
        }
        case "tool-call": {
          setActiveRole(event.role);
          const isDelegation = event.name === "task" && event.role === "brain";
          // One OpenCode-style row per call; the matching tool-result updates
          // it in place (status → done/error, output, meta).
          const key = push({
            role: event.role,
            kind: "tool",
            text: event.title ?? "",
            toolId: event.toolId,
            toolName: event.name,
            toolStatus: "running",
            toolInput: event.input
          });
          if (isDelegation) {
            const agentKind =
              firstString(asRecord(event.input).subagent_type) === "investigator"
                ? "investigator"
                : "executor";
            tasksByToolIdRef.current.set(event.toolId, {
              key,
              startTs: Date.now(),
              toolcalls: 0
            });
            taskRoleIndexRef.current.set(agentKind, event.toolId);
          } else if (event.role !== "brain") {
            // A subagent's tool: tick the owning Task row's "↳ …" line, like
            // OpenCode's live "↳ Read path" under a running task.
            const taskId = taskRoleIndexRef.current.get(event.role);
            const task = taskId ? tasksByToolIdRef.current.get(taskId) : undefined;
            if (task) {
              task.toolcalls += 1;
              const detail = event.title
                ? `${titlecase(event.name)} ${clip(event.title, 80)}`
                : clip(toolLabel(event.name, event.input), 80);
              setMessages((prev) =>
                prev.map((row) => (row.key === task.key ? { ...row, taskDetail: detail } : row))
              );
            }
          }
          break;
        }
        case "tool-result": {
          setActiveRole(event.role);
          const isDelegation = event.name === "task";
          const text = isDelegation
            ? extractTaskResult(event.text)
            : clip(event.text ?? "", 8000);
          // Completed delegations get OpenCode's "↳ N toolcalls · 12s" line.
          const task = tasksByToolIdRef.current.get(event.toolId);
          let taskDetail: string | undefined;
          if (task) {
            const duration = formatDurationShort(Date.now() - task.startTs);
            taskDetail =
              task.toolcalls > 0
                ? `${task.toolcalls} toolcall${task.toolcalls === 1 ? "" : "s"} · ${duration}`
                : duration;
            tasksByToolIdRef.current.delete(event.toolId);
            for (const [kind, id] of taskRoleIndexRef.current) {
              if (id === event.toolId) taskRoleIndexRef.current.delete(kind);
            }
          }
          setMessages((prev) => {
            let found = false;
            const next = prev.map((row) => {
              if (row.kind !== "tool" || row.toolId !== event.toolId || row.toolStatus !== "running") {
                return row;
              }
              found = true;
              return {
                ...row,
                toolStatus: event.ok ? ("done" as const) : ("error" as const),
                toolOutput: text || undefined,
                meta: event.meta ?? row.meta,
                taskDetail: taskDetail ?? row.taskDetail
              };
            });
            if (found) return next;
            // Result without a matching call (snapshot edge): synthesize.
            return [
              ...next,
              {
                key: nextKey(),
                ts: Date.now(),
                role: event.role,
                kind: "tool" as const,
                toolId: event.toolId,
                toolName: event.name,
                toolStatus: event.ok ? ("done" as const) : ("error" as const),
                toolInput: undefined,
                toolOutput: text || undefined,
                meta: event.meta,
                text: event.title ?? "",
                taskDetail
              }
            ];
          });
          break;
        }
        case "permission": {
          const pending: PendingPermission = {
            requestId: event.requestId,
            role: event.role,
            permission: event.permission,
            patterns: event.patterns,
            title: event.title
          };
          setPendingPermission(pending);
          setWaitingState(true);
          onStatusChangeRef.current("waiting");
          const detail = permissionDetail(pending);
          push({
            role: event.role,
            kind: "activity",
            text: `Permission requested: ${detail}`
          });
          emitAttention("waiting", "approval", detail);
          break;
        }
        case "permission-resolved":
          setPendingPermission((current) =>
            current && current.requestId === event.requestId ? null : current
          );
          setWaitingState(false);
          if (busyRef.current) {
            onStatusChangeRef.current("running");
          }
          break;
        case "auth-result": {
          const flow = authFlowRef.current;
          const mine = Boolean(flow && event.nonce && event.nonce === flow.nonce);
          if (event.ok && event.action === "connect") {
            if (mine) {
              setAuthFlow(null);
              setAuthText("");
            }
            push({
              role: "brain",
              kind: "activity",
              text: `Provider '${event.providerId}' connected.`
            });
            if (mine) {
              // Match opencode's connect → browse handoff: after a successful
              // connect, open the new provider's model list for the role that
              // led here (or the first unset role for a bare /connect). The
              // drill-in happens when the refreshed providers event lands.
              // Reads the CURRENT picks via refs — this closure is frozen at
              // first render.
              const returnRole =
                authReturnRoleRef.current ??
                (!plannerModelRef.current
                  ? "brain"
                  : !executorModelRef.current
                    ? "executor"
                    : "brain");
              pendingModelBrowseRef.current = {
                role: returnRole,
                providerId: event.providerId
              };
              setPicker({ role: returnRole });
              setInput("");
              composerRef.current?.focus();
            }
            authReturnRoleRef.current = null;
          } else if (event.ok) {
            // A custom-provider removal reports nuance (e.g. "only the
            // credential was removed") through message.
            push({
              role: "brain",
              kind: "activity",
              text: event.message || `Provider '${event.providerId}' disconnected.`
            });
          } else {
            // Failures from a cancelled/superseded flow stay quiet; everything
            // else (including nonce-less disconnect errors) surfaces.
            if (event.nonce && !mine) break;
            push({
              role: "brain",
              kind: "error",
              text: event.message || `Could not update provider '${event.providerId}'.`
            });
            if (mine) {
              setAuthFlow(null);
              setAuthText("");
            }
          }
          break;
        }
        case "oauth-authorize": {
          const flow = authFlowRef.current;
          if (!flow || event.nonce !== flow.nonce) break;
          if (!event.ok) {
            push({
              role: "brain",
              kind: "error",
              text: event.message || "Could not start the OAuth flow."
            });
            setAuthFlow(null);
            break;
          }
          const methodIndex =
            "methodIndex" in flow.step ? flow.step.methodIndex : 0;
          const flowKind = event.flow === "code" ? "code" : "auto";
          setAuthFlow({
            ...flow,
            step: {
              stage: "oauth",
              methodIndex,
              flow: flowKind,
              url: event.url || "",
              instructions: event.instructions || ""
            }
          });
          setAuthText("");
          if (event.url) {
            void window.vibe?.openFusionChat?.openExternal(event.url);
          }
          if (flowKind === "auto") {
            // Device flow: the server blocks in the callback until the browser
            // side finishes, then the result arrives as auth-result.
            void window.vibe?.openFusionChat
              ?.oauthCallback(session.id, flow.providerId, methodIndex, undefined, flow.nonce)
              .then((result) => {
                if (result && result.ok === false) {
                  push({
                    role: "brain",
                    kind: "error",
                    text: result.error || "Could not complete the OAuth flow."
                  });
                  setAuthFlow(null);
                }
              });
          }
          break;
        }
        case "providers":
          if (event.ok) {
            setProviders(event.connected ?? []);
            setAvailableProviders(event.available ?? []);
            setProviderAuthMethods(event.authMethods ?? {});
            setCatalogOk(event.catalogOk !== false);
            const browse = pendingModelBrowseRef.current;
            if (browse) {
              pendingModelBrowseRef.current = null;
              const provider = (event.connected ?? []).find(
                (entry) => entry.id === browse.providerId
              );
              if (provider) {
                setPicker({ role: browse.role, provider });
                setInput("");
                composerRef.current?.focus();
              }
            }
            const pendingConnect = pendingConnectRef.current;
            if (pendingConnect) {
              pendingConnectRef.current = null;
              openAuthFlow(pendingConnect, event.authMethods ?? {}, [
                ...(event.available ?? []),
                ...(event.connected ?? [])
              ]);
            }
          } else {
            // Keep whatever catalog we already had (no state write) — wiping
            // it on a failed refresh downgraded a working picker to an empty
            // dead end.
            // A queued /connect must not pop an auth panel minutes later when
            // some future refresh succeeds.
            if (pendingConnectRef.current) {
              pendingConnectRef.current = null;
              push({
                role: "brain",
                kind: "error",
                text: `${event.message || "Could not load the provider catalog."} Run /connect again once the engine is ready.`
              });
            } else {
              push({
                role: "brain",
                kind: "activity",
                text: event.message || "Could not load the provider catalog.",
                internal: false
              });
            }
          }
          break;
        case "result": {
          // Aborts settle as session.idle → a trailing result; the
          // "interrupted" lane owns status + attention for those, so this
          // event must not re-brand the turn as done/completed.
          const interruptSettle = interruptSettledRef.current || interruptingRef.current;
          interruptSettledRef.current = false;
          setActiveRole("brain");
          stopStreaming();
          setInterruptingState(false);
          setBusyState(false);
          if (event.tokens || typeof event.costUsd === "number") {
            setUsage({ costUsd: event.costUsd, tokens: event.tokens });
          }
          if (event.subtype === "restored") {
            onStatusChangeRef.current("idle");
            break;
          }
          if (interruptSettle) {
            pushTurnEnd(true);
            onStatusChangeRef.current("waiting");
            flushSteering();
            break;
          }
          pushTurnEnd(false);
          if (waitingRef.current) {
            onStatusChangeRef.current("waiting");
          } else {
            onStatusChangeRef.current("done");
            emitAttention("completed", "done");
          }
          flushSteering();
          break;
        }
        case "interrupted":
          interruptSettledRef.current = true;
          stopStreaming();
          settleRunningTools();
          setInterruptingState(false);
          setBusyState(false);
          setWaitingState(false);
          setPendingPermission(null);
          // A message queued before the interrupt is still in the session's
          // history — surface it under the marker as the freshest entry so
          // the user sees it will lead the next turn.
          flushSteering();
          onStatusChangeRef.current("waiting");
          emitAttention("waiting", "question", "Turn interrupted — tell Open Fusion how to continue.");
          break;
        case "stderr":
          if (event.text.trim()) {
            push({ role: "brain", kind: "activity", text: event.text.trim(), internal: true });
          }
          break;
        case "error": {
          stopStreaming();
          settleRunningTools();
          setInterruptingState(false);
          setBusyState(false);
          setWaitingState(false);
          setPendingPermission(null);
          setFailed(true);
          push({ role: event.role ?? "brain", kind: "error", text: event.message });
          flushSteering();
          onStatusChangeRef.current("failed");
          emitAttention("failed", "error", event.message);
          break;
        }
        case "closed": {
          stopStreaming();
          settleRunningTools();
          setInterruptingState(false);
          flushSteering();
          const wasBusy = busyRef.current;
          setBusyState(false);
          setWaitingState(false);
          setPendingPermission(null);
          if ((event.code ?? 0) !== 0 || wasBusy) {
            const message = `Open Fusion engine exited (${event.code ?? "unknown"}).`;
            setFailed(true);
            push({ role: "brain", kind: "error", text: message });
            onStatusChangeRef.current("failed");
            emitAttention("failed", "exit", message);
          } else {
            onStatusChangeRef.current("idle");
          }
          break;
        }
        default:
          break;
      }
    };

    const unsubscribe = window.vibe?.openFusionChat?.onEvent(handleChat);
    return () => {
      unsubscribe?.();
      if (deltaFlushHandle !== null) {
        cancelAnimationFrame(deltaFlushHandle);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  function interrupt() {
    if (!busyRef.current || interruptingRef.current) return;
    setInterruptingState(true);
    void window.vibe?.openFusionChat?.interrupt(session.id);
  }

  function answerPermission(reply: "once" | "always" | "reject") {
    const pending = pendingPermission;
    if (!pending) return;
    setPendingPermission(null);
    setWaitingState(false);
    if (busyRef.current) {
      onStatusChangeRef.current("running");
    }
    push({
      role: "user",
      kind: "text",
      text:
        reply === "reject"
          ? `Rejected: ${permissionDetail(pending)}`
          : `${reply === "always" ? "Allowed for the session" : "Allowed"}: ${permissionDetail(pending)}`
    });
    void window.vibe?.openFusionChat
      ?.permission(session.id, pending.requestId, reply)
      .then((result) => {
        if (result && result.ok === false && result.error) {
          push({ role: "brain", kind: "error", text: result.error });
        }
      });
  }

  function saveModels(change: OpenFusionSettingsChange, note: string) {
    void window.vibe?.openFusionChat
      ?.saveModels(session.id, change)
      .then((result) => {
        if (result && result.ok === false) {
          push({
            role: "brain",
            kind: "error",
            text: result.error || "Could not save the Open Fusion model."
          });
          return;
        }
        push({ role: "brain", kind: "activity", text: note });
        if (change.executorModel) {
          pendingRestartNoticeRef.current =
            "Executor model updated — restarting the pane to apply it.";
        }
        onSettingsChange(change);
      });
  }

  function applyModelPick(role: "brain" | "executor", model: string) {
    const validation = validateOpenFusionModel(model);
    if (validation) {
      push({ role: "brain", kind: "error", text: validation });
      return;
    }
    if (role === "brain") {
      saveModels(
        { plannerModel: model },
        `Brain model set to ${model} — applies from the next turn.`
      );
    } else {
      saveModels(
        { executorModel: model },
        `Executor model set to ${model} — restarting to apply.`
      );
    }
  }

  function openModelPicker(role: "brain" | "executor") {
    setPicker({ role });
    setInput("");
    // Always refresh on open: the catalog and auth state may have changed
    // since the last load (and a failed earlier load finally gets its retry).
    void window.vibe?.openFusionChat?.requestProviders(session.id);
    composerRef.current?.focus();
  }

  function openConnectPicker(mode: "connect" | "disconnect" = "connect") {
    setPicker({ connect: mode });
    setInput("");
    void window.vibe?.openFusionChat?.requestProviders(session.id);
    composerRef.current?.focus();
  }

  // List every saved chat for this folder from the app-owned OpenCode store
  // (newest first) so the user can resume the one they want — not just the
  // stashed last chat. The current conversation is excluded: "resuming" it
  // would only restart the pane.
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
    list({
      provider: "opencode",
      cwd: session.cwd,
      openFusion: true,
      excludeIds: threadIdRef.current ? [threadIdRef.current] : undefined
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

  function nextAuthNonce() {
    authNonceRef.current += 1;
    return `${session.id}-auth-${authNonceRef.current}`;
  }

  function stepForMethod(
    methods: OpenFusionAuthMethod[],
    methodIndex: number
  ): AuthFlowStage {
    const method = methods[methodIndex];
    if (method?.prompts?.length) {
      return { stage: "prompts", methodIndex, promptIndex: 0, values: {} };
    }
    return method?.type === "oauth"
      ? { stage: "oauth-start", methodIndex }
      : { stage: "key", methodIndex };
  }

  function requestOauthAuthorize(
    flow: AuthFlow,
    methodIndex: number,
    inputs: Record<string, string>
  ) {
    void window.vibe?.openFusionChat
      ?.oauthAuthorize(session.id, flow.providerId, methodIndex, inputs, flow.nonce)
      .then((result) => {
        if (result && result.ok === false) {
          push({
            role: "brain",
            kind: "error",
            text: result.error || "Could not start the OAuth flow."
          });
          setAuthFlow(null);
        }
      });
  }

  // methodsMap/names let the providers-event handler open a queued /connect
  // with the payload it just received instead of a stale state closure.
  function openAuthFlow(
    providerIdRaw: string,
    methodsMap?: Record<string, OpenFusionAuthMethod[]>,
    names?: { id: string; name: string }[]
  ) {
    let providerId = providerIdRaw.trim();
    if (!providerId) return;
    // Honesty guard (opencode's own dialog warns here too): a key stored for
    // an id outside the catalog would never be used — Open Fusion generates
    // the pane config, so there is no opencode.json for the user to wire a
    // custom provider into. Refuse instead of reporting a useless "connected".
    // Matching is case-insensitive ("/connect OpenRouter" should work); the
    // catalog id is what gets stored. With a PARTIAL catalog (the full list
    // failed to load) the guard can't be trusted, so the attempt proceeds.
    const catalog = names ?? [...availableProviders, ...(providers ?? [])];
    const needle = providerId.toLowerCase();
    const match = catalog.find((entry) => entry.id.toLowerCase() === needle);
    if (match) {
      providerId = match.id;
    } else if (catalog.length && catalogOk) {
      const close = catalog
        .filter(
          (entry) =>
            entry.id.toLowerCase().includes(needle) ||
            entry.name.toLowerCase().includes(needle)
        )
        .slice(0, 3)
        .map((entry) => entry.id);
      push({
        role: "brain",
        kind: "error",
        text: `'${providerId}' is not a provider in the OpenCode catalog, so a stored key would never be used.${
          close.length ? ` Did you mean: ${close.join(", ")}?` : ""
        } Run /connect to browse the provider list.`
      });
      return;
    }
    const map = methodsMap ?? providerAuthMethods;
    const methods = map[providerId]?.length ? map[providerId] : DEFAULT_AUTH_METHODS;
    const flow: AuthFlow = {
      providerId,
      name:
        (names ?? availableProviders).find((provider) => provider.id === providerId)
          ?.name || providerId,
      nonce: nextAuthNonce(),
      methods,
      step: methods.length > 1 ? { stage: "method" } : stepForMethod(methods, 0)
    };
    setPicker(null);
    setInput("");
    setAuthText("");
    setAuthFlow(flow);
    if (flow.step.stage === "oauth-start") {
      requestOauthAuthorize(flow, flow.step.methodIndex, {});
    }
  }

  // Add-custom-provider flow (OpenAI-compatible endpoint). Rides the AuthFlow
  // state machine — its stages carry the collected fields, so cancelling at
  // any point drops everything and nothing persists until Save.
  function openCustomProviderFlow() {
    setPicker(null);
    setInput("");
    setAuthText("");
    setAuthFlow({
      providerId: "",
      name: "custom provider",
      nonce: nextAuthNonce(),
      methods: [],
      step: { stage: "custom-name" }
    });
  }

  function advanceCustomStage(value: string) {
    const flow = authFlow;
    if (!flow) return;
    const step = flow.step;
    const text = value.trim();
    if (step.stage === "custom-name") {
      const error = validateCustomProviderName(text);
      if (error) {
        push({ role: "brain", kind: "error", text: error });
        return;
      }
      setAuthText("");
      setAuthFlow({ ...flow, name: text, step: { stage: "custom-url", name: text } });
    } else if (step.stage === "custom-url") {
      const error = validateCustomProviderBaseUrl(text);
      if (error) {
        push({ role: "brain", kind: "error", text: error });
        return;
      }
      setAuthText("");
      setAuthFlow({
        ...flow,
        step: { stage: "custom-key", name: step.name, baseURL: new URL(text).href }
      });
    } else if (step.stage === "custom-key") {
      // Empty is deliberate: keyless local endpoints (LM Studio, llama.cpp)
      // are a first-class case, and a config-defined provider counts as
      // connected without a credential.
      setAuthText("");
      setAuthFlow({
        ...flow,
        step: {
          stage: "custom-model-id",
          name: step.name,
          baseURL: step.baseURL,
          key: text,
          models: []
        }
      });
    } else if (step.stage === "custom-model-id") {
      const error = validateCustomProviderModelId(text);
      if (error) {
        push({ role: "brain", kind: "error", text: error });
        return;
      }
      setAuthText("");
      setAuthFlow({
        ...flow,
        step: { ...step, stage: "custom-model-name", modelId: text }
      });
    } else if (step.stage === "custom-model-name") {
      setAuthText("");
      setAuthFlow({
        ...flow,
        step: {
          ...step,
          stage: "custom-model-context",
          modelName: text || step.modelId
        }
      });
    } else if (step.stage === "custom-model-context") {
      const parsed = parseCustomProviderContextLimit(text);
      if (!parsed.ok) {
        push({ role: "brain", kind: "error", text: parsed.message });
        return;
      }
      setAuthText("");
      setAuthFlow({
        ...flow,
        step: {
          stage: "custom-review",
          name: step.name,
          baseURL: step.baseURL,
          key: step.key,
          models: [
            ...step.models,
            {
              id: step.modelId,
              name: step.modelName,
              ...(parsed.limit ? { contextLimit: parsed.limit } : {})
            }
          ]
        }
      });
    }
  }

  function addAnotherCustomModel() {
    const flow = authFlow;
    if (!flow || flow.step.stage !== "custom-review") return;
    setAuthText("");
    setAuthFlow({
      ...flow,
      step: {
        stage: "custom-model-id",
        name: flow.step.name,
        baseURL: flow.step.baseURL,
        key: flow.step.key,
        models: flow.step.models
      }
    });
  }

  function submitCustomProvider() {
    const flow = authFlow;
    if (!flow || flow.step.stage !== "custom-review") return;
    const step = flow.step;
    // The id comes from the display name. Reusing the slug of an existing
    // custom (config-sourced) provider means redefining it; colliding with a
    // catalog provider id instead gets a -custom suffix so the definition
    // never merges into a stock provider by accident.
    const providerId = customProviderIdForName(
      step.name,
      [
        ...availableProviders.map((provider) => provider.id),
        ...(providers ?? [])
          .filter((provider) => provider.source !== "config")
          .map((provider) => provider.id)
      ],
      (providers ?? [])
        .filter((provider) => provider.source === "config")
        .map((provider) => provider.id)
    );
    setAuthFlow({ ...flow, providerId, step: { stage: "waiting", methodIndex: 0 } });
    setAuthText("");
    void window.vibe?.openFusionChat
      ?.customProviderSet(
        session.id,
        {
          providerId,
          name: step.name,
          baseURL: step.baseURL,
          models: step.models,
          key: step.key || undefined
        },
        flow.nonce
      )
      .then((result) => {
        if (result && result.ok === false) {
          push({
            role: "brain",
            kind: "error",
            text: result.error || "Could not save the custom provider."
          });
          setAuthFlow(null);
        }
      });
  }

  function selectAuthMethod(methodIndex: number) {
    const flow = authFlow;
    if (!flow || flow.step.stage !== "method") return;
    const step = stepForMethod(flow.methods, methodIndex);
    const next = { ...flow, step };
    setAuthText("");
    setAuthFlow(next);
    if (step.stage === "oauth-start") {
      requestOauthAuthorize(next, step.methodIndex, {});
    }
  }

  function finishAuthPrompts(
    flow: AuthFlow,
    methodIndex: number,
    values: Record<string, string>
  ) {
    const method = flow.methods[methodIndex];
    if (method?.type === "oauth") {
      const next: AuthFlow = { ...flow, step: { stage: "oauth-start", methodIndex } };
      setAuthFlow(next);
      requestOauthAuthorize(next, methodIndex, values);
    } else {
      setAuthFlow({ ...flow, step: { stage: "key", methodIndex, metadata: values } });
    }
  }

  function advanceAuthPrompt(value: string) {
    const flow = authFlow;
    if (!flow || flow.step.stage !== "prompts") return;
    const method = flow.methods[flow.step.methodIndex];
    const prompt = method?.prompts?.[flow.step.promptIndex];
    const trimmed = value.trim();
    if (!prompt || !trimmed) return;
    const values = { ...flow.step.values, [prompt.key]: trimmed };
    const nextIndex = flow.step.promptIndex + 1;
    setAuthText("");
    if (method?.prompts && nextIndex < method.prompts.length) {
      setAuthFlow({
        ...flow,
        step: { ...flow.step, promptIndex: nextIndex, values }
      });
    } else {
      finishAuthPrompts(flow, flow.step.methodIndex, values);
    }
  }

  function submitAuthKey() {
    const flow = authFlow;
    if (!flow || flow.step.stage !== "key") return;
    const key = authText.trim();
    if (!key) return;
    const { methodIndex, metadata } = flow.step;
    setAuthFlow({ ...flow, step: { stage: "waiting", methodIndex } });
    setAuthText("");
    void window.vibe?.openFusionChat
      ?.setProviderKey(session.id, flow.providerId, key, metadata, flow.nonce)
      .then((result) => {
        if (result && result.ok === false) {
          push({
            role: "brain",
            kind: "error",
            text: result.error || "Could not store the provider key."
          });
          setAuthFlow(null);
        }
      });
  }

  function submitOauthCode() {
    const flow = authFlow;
    if (!flow || flow.step.stage !== "oauth" || flow.step.flow !== "code") return;
    const code = authText.trim();
    if (!code) return;
    const { methodIndex } = flow.step;
    setAuthFlow({ ...flow, step: { stage: "waiting", methodIndex } });
    setAuthText("");
    void window.vibe?.openFusionChat
      ?.oauthCallback(session.id, flow.providerId, methodIndex, code, flow.nonce)
      .then((result) => {
        if (result && result.ok === false) {
          push({
            role: "brain",
            kind: "error",
            text: result.error || "Could not complete the OAuth flow."
          });
          setAuthFlow(null);
        }
      });
  }

  function cancelAuthFlow() {
    setAuthFlow(null);
    setAuthText("");
    authReturnRoleRef.current = null;
  }

  function disconnectProvider(providerId: string) {
    const id = providerId.trim();
    if (!id) return;
    // Config-sourced providers are user-added custom definitions: removing
    // one drops the definition from the app-owned OpenCode config, not just
    // its stored credential.
    const custom = (providers ?? []).some(
      (provider) => provider.id === id && provider.source === "config"
    );
    const call = custom
      ? window.vibe?.openFusionChat?.customProviderRemove(session.id, id)
      : window.vibe?.openFusionChat?.removeProviderKey(session.id, id);
    void call?.then((result) => {
      if (result && result.ok === false) {
        push({
          role: "brain",
          kind: "error",
          text: result.error || "Could not remove the provider credential."
        });
      }
    });
  }

  function showModels() {
    const connectedIds = providers ? new Set(providers.map((entry) => entry.id)) : null;
    const describe = (model: string) => {
      const providerID = model.split("/")[0];
      return connectedIds && providerID && !connectedIds.has(providerID)
        ? `${model} (needs auth — /connect ${providerID})`
        : model;
    };
    push({
      role: "brain",
      kind: "activity",
      text: `Brain ${describe(plannerModel)} · Executor ${describe(executorModel)}`
    });
  }

  function showHelp() {
    push({
      role: "brain",
      kind: "activity",
      text: SLASH_COMMANDS.map((cmd) => `${cmd.name} — ${cmd.desc}`).join("\n")
    });
  }

  function handleSlashCommand(raw: string): boolean {
    const text = raw.trim();
    const [name, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (name) {
      case "/brain-model":
      case "/brain":
        if (arg) applyModelPick("brain", arg);
        else openModelPicker("brain");
        return true;
      case "/executor-model":
      case "/executor":
      case "/body":
        if (arg) applyModelPick("executor", arg);
        else openModelPicker("executor");
        return true;
      case "/connect":
      case "/auth":
      case "/login":
        if (arg) {
          const providerId = arg.split(/\s+/)[0];
          if (providers === null) {
            // Method metadata comes with the provider catalog; open the flow
            // as soon as it lands.
            pendingConnectRef.current = providerId;
            void window.vibe?.openFusionChat?.requestProviders(session.id);
            push({
              role: "brain",
              kind: "activity",
              text: "Loading the provider catalog…"
            });
          } else {
            openAuthFlow(providerId);
          }
        } else {
          // Bare /connect opens the provider browser (it used to dead-end
          // into a usage string — there was no way to DISCOVER providers).
          openConnectPicker("connect");
        }
        return true;
      case "/custom-provider":
      case "/add-provider":
        openCustomProviderFlow();
        return true;
      case "/disconnect":
      case "/logout":
        if (arg) {
          disconnectProvider(arg.split(/\s+/)[0]);
        } else {
          openConnectPicker("disconnect");
        }
        return true;
      case "/models":
      case "/openfusion":
        showModels();
        return true;
      case "/resume":
      case "/sessions":
        openResumePicker();
        return true;
      case "/clear":
      case "/new":
        onClear();
        return true;
      case "/details":
        setVerbose((value) => !value);
        push({
          role: "brain",
          kind: "activity",
          text: `Tool execution details ${verbose ? "hidden" : "shown"}.`
        });
        return true;
      case "/help":
        showHelp();
        return true;
      default:
        return false;
    }
  }

  function send() {
    // While a connect flow is open the keyboard belongs to it — pressing
    // Enter in the composer must not fire the first-run gate message (and a
    // key pasted here by mistake must not sit exposed): hand focus to the
    // flow's input instead.
    if (authFlow) {
      authInputRef.current?.focus();
      authPrimaryButtonRef.current?.focus();
      return;
    }
    const text = input.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      if (handleSlashCommand(text)) {
        setInput("");
        return;
      }
    }
    // First-run gate: no turn leaves the pane until both roles have an
    // explicitly picked model (slash commands above stay usable — they ARE the
    // setup path).
    if (!modelsReady) {
      push({
        role: "brain",
        kind: "activity",
        text: !plannerModel
          ? "Pick a Brain model first (/brain-model — connect a provider if the list is empty)."
          : "Pick an Executor model first (/executor-model)."
      });
      return;
    }
    setInput("");
    setFailed(false);
    // Sending implies following the conversation again.
    pinnedToBottomRef.current = true;
    window.vibe?.openFusionChat?.sendUserTurn(session.id, text);
    if (!busyRef.current) {
      setBusyState(true);
      onStatusChangeRef.current("running");
    }
  }

  // ---- slash palette / model picker / connect picker menu ----
  const menu: SlashMenu = (() => {
    const filter = input.trim().toLowerCase();
    const matchesFilter = (entry: { id: string; name: string }) =>
      !filter ||
      entry.name.toLowerCase().includes(filter) ||
      entry.id.toLowerCase().includes(filter);
    if (picker && "resume" in picker) {
      if (picker.resume === null) {
        return { title: "Resume a chat — reading saved chats…", items: [] };
      }
      const claimed = new Set(claimedThreadIds ?? []);
      const threads = picker.resume.filter(
        (thread) =>
          thread.id &&
          thread.id !== threadIdRef.current &&
          (!filter ||
            (thread.title ?? "").toLowerCase().includes(filter) ||
            thread.id.toLowerCase().includes(filter))
      );
      const items: SlashMenuItem[] = threads
        .slice(0, PICKER_PAGE_SIZE)
        .map((thread) => ({
          key: `resume-${thread.id}`,
          label: clip(thread.title?.trim() || "Untitled chat", 80),
          desc: claimed.has(thread.id!)
            ? "open in another pane"
            : formatThreadAge(thread.updatedAt),
          command: `__resume:${thread.id}`
        }));
      if (threads.length > PICKER_PAGE_SIZE) {
        items.push(moreRow("resume-more", threads.length - PICKER_PAGE_SIZE));
      }
      // Listing failed but the pane still stashes its last chat: offer that
      // directly instead of a dead end.
      if (picker.error && canResume) {
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
              : "No saved chats for this folder",
          desc:
            picker.error ??
            "Chats appear here once a conversation has started."
        });
      }
      return { title: "Resume a chat — type to filter", items };
    }
    if (picker && "connect" in picker) {
      const mode = picker.connect;
      if (!providers) {
        return {
          title:
            mode === "connect"
              ? "Connect a provider — loading the catalog…"
              : "Disconnect a provider — loading…",
          items: []
        };
      }
      const items: SlashMenuItem[] = [];
      if (mode === "disconnect") {
        const connected = sortProvidersForPicker(providers).filter(matchesFilter);
        for (const provider of connected.slice(0, PICKER_PAGE_SIZE)) {
          items.push({
            key: `disc-${provider.id}`,
            label: provider.name,
            desc:
              provider.source === "config"
                ? "custom provider — select to remove it (definition + key)"
                : "connected — select to remove its credential",
            command: `__disconnect:${provider.id}`
          });
        }
        if (connected.length > PICKER_PAGE_SIZE) {
          items.push(moreRow("disc-more", connected.length - PICKER_PAGE_SIZE));
        }
        return { title: "Disconnect a provider — type to filter", items };
      }
      const connectedIds = new Set(providers.map((provider) => provider.id));
      const candidates = sortProvidersForPicker([
        ...availableProviders,
        ...providers.map((provider) => ({ id: provider.id, name: provider.name }))
      ]).filter(matchesFilter);
      for (const provider of candidates.slice(0, PICKER_PAGE_SIZE)) {
        items.push({
          key: `conn-${provider.id}`,
          label: provider.name,
          desc: connectedIds.has(provider.id)
            ? "connected ✓ — select to replace the credential"
            : "select to connect (API key or OAuth)",
          command: `__connect:${provider.id}`
        });
      }
      if (candidates.length > PICKER_PAGE_SIZE) {
        items.push(moreRow("conn-more", candidates.length - PICKER_PAGE_SIZE));
      }
      if (
        filter &&
        /^[a-z0-9._-]+$/.test(filter) &&
        !candidates.some((entry) => entry.id.toLowerCase() === filter)
      ) {
        items.push({
          key: "conn-typed",
          label: `Connect '${filter}'`,
          desc: catalogOk
            ? "Not in the catalog list — attempt anyway"
            : "Catalog unavailable — attempt this provider id",
          command: `__connect:${filter}`
        });
      }
      items.push({
        key: "conn-custom-add",
        label: "Add custom provider (OpenAI-compatible)…",
        desc: "Your own base URL and key — name the provider and its models yourself",
        command: "__custom-provider"
      });
      if (!catalogOk) {
        items.push({
          key: "conn-partial",
          label: "Partial list",
          desc: "The full provider catalog failed to load — showing connected providers only."
        });
      }
      return { title: "Connect a provider — type to filter", items };
    }
    if (picker) {
      const roleLabel = picker.role === "brain" ? "Brain" : "Executor";
      if (!providers) {
        return {
          title: `${roleLabel} model — loading the provider catalog…`,
          items: []
        };
      }
      if (!picker.provider) {
        // One-shot model search (opencode's /models feel): typing matches
        // models across ALL connected providers directly, so picking a model
        // never requires drilling into a provider first. Browsing by provider
        // stays available when the filter is empty. Provider rows always rank
        // ABOVE flat model matches so a provider search ("openrouter") is
        // never crowded out by incidental model-name hits.
        const connectedRows = providers.filter(matchesFilter).map((provider) => ({
          key: `prov-${provider.id}`,
          label: provider.name,
          desc: `connected · ${provider.models.length} models`,
          command: `__provider:${provider.id}`
        }));
        const modelMatchesAll = filter
          ? providers.flatMap((provider) =>
              provider.models
                .filter(
                  (model) =>
                    model.name.toLowerCase().includes(filter) ||
                    `${provider.id}/${model.id}`.toLowerCase().includes(filter)
                )
                .map((model) => ({
                  key: `flat-${provider.id}/${model.id}`,
                  label: model.name,
                  desc: `${provider.id}/${model.id}`,
                  command: `__model:${provider.id}/${model.id}`
                }))
            )
          : [];
        const needsAuthAll = sortProvidersForPicker(availableProviders).filter(matchesFilter);
        const items: SlashMenuItem[] = [...connectedRows];
        items.push(...modelMatchesAll.slice(0, 8));
        if (modelMatchesAll.length > 8) {
          items.push(moreRow("flat-more", modelMatchesAll.length - 8));
        }
        const needsAuthBudget = Math.max(PICKER_PAGE_SIZE - items.length, 6);
        for (const provider of needsAuthAll.slice(0, needsAuthBudget)) {
          items.push({
            key: `avail-${provider.id}`,
            label: provider.name,
            desc: "needs auth — select to connect",
            command: `__needs-auth:${provider.id}`
          });
        }
        if (needsAuthAll.length > needsAuthBudget) {
          items.push(moreRow("avail-more", needsAuthAll.length - needsAuthBudget));
        }
        items.push({
          key: "open-connect",
          label: "Connect a provider…",
          desc: "Browse the full provider catalog",
          command: "__open-connect"
        });
        items.push({
          key: "custom",
          label: "Custom model id…",
          desc: "Type any provider/model id",
          fill: picker.role === "brain" ? "/brain-model " : "/executor-model "
        });
        if (!catalogOk) {
          items.push({
            key: "catalog-partial",
            label: "Partial list",
            desc: "The full provider catalog failed to load — showing connected providers only."
          });
        }
        return {
          title: `${roleLabel} model — type to search all models, or pick a provider`,
          items
        };
      }
      const providerModels = picker.provider.models.filter(
        (model) =>
          !filter ||
          model.name.toLowerCase().includes(filter) ||
          model.id.toLowerCase().includes(filter)
      );
      const items: SlashMenuItem[] = providerModels
        .slice(0, PICKER_PAGE_SIZE)
        .map((model) => ({
          key: `model-${model.id}`,
          label: model.name,
          desc: model.id,
          command: `__model:${picker.provider!.id}/${model.id}`
        }));
      if (providerModels.length > PICKER_PAGE_SIZE) {
        items.push(moreRow("model-more", providerModels.length - PICKER_PAGE_SIZE));
      }
      items.push({
        key: "custom",
        label: "Custom model id…",
        desc: "Type any provider/model id",
        fill: picker.role === "brain" ? "/brain-model " : "/executor-model "
      });
      return {
        title: `${roleLabel} model — ${picker.provider.name}`,
        items
      };
    }
    if (!input.startsWith("/") || input.includes(" ")) {
      return { title: "", items: [] };
    }
    const token = input.trim().toLowerCase();
    return {
      title: "Commands",
      items: SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(token)).map((cmd) => ({
        key: cmd.name,
        label: cmd.name,
        desc: cmd.desc,
        command: cmd.name
      }))
    };
  })();
  const menuOpen =
    picker !== null || (menu.items.length > 0 && !menuDismissed);
  // "Connected" providers that never needed a key (the opencode zen free
  // tier) don't count as the user having connected anything — the first-run
  // gate must still lead with Connect.
  const onlyKeylessProviders =
    providers !== null && providers.every((provider) => provider.id === "opencode");

  function applyMenuSelection(item: SlashMenuItem | undefined) {
    if (!item) return;
    if (item.fill !== undefined) {
      setPicker(null);
      setInput(item.fill);
      composerRef.current?.focus();
      return;
    }
    if (!item.command) return;
    const pickerRole = picker && "role" in picker ? picker.role : null;
    if (item.command.startsWith("__resume:")) {
      const threadId = item.command.slice("__resume:".length);
      const thread =
        picker && "resume" in picker && picker.resume
          ? picker.resume.find((entry) => entry.id === threadId)
          : undefined;
      setPicker(null);
      setInput("");
      if (!thread) return;
      if (claimedThreadIds?.includes(threadId)) {
        push({
          role: "brain",
          kind: "activity",
          text: "That chat is already open in another pane."
        });
        return;
      }
      onResume(thread);
      return;
    }
    if (item.command === "__resume-last") {
      setPicker(null);
      setInput("");
      onResume();
      return;
    }
    if (item.command.startsWith("__provider:")) {
      const providerId = item.command.slice("__provider:".length);
      const provider = providers?.find((entry) => entry.id === providerId);
      if (provider && pickerRole) {
        setPicker({ role: pickerRole, provider });
        setInput("");
      }
      return;
    }
    if (item.command.startsWith("__needs-auth:")) {
      const providerId = item.command.slice("__needs-auth:".length);
      authReturnRoleRef.current = pickerRole;
      openAuthFlow(providerId);
      return;
    }
    if (item.command.startsWith("__connect:")) {
      const providerId = item.command.slice("__connect:".length);
      authReturnRoleRef.current = pickerRole;
      openAuthFlow(providerId);
      return;
    }
    if (item.command.startsWith("__disconnect:")) {
      const providerId = item.command.slice("__disconnect:".length);
      setPicker(null);
      setInput("");
      disconnectProvider(providerId);
      return;
    }
    if (item.command === "__open-connect") {
      authReturnRoleRef.current = pickerRole;
      openConnectPicker("connect");
      return;
    }
    if (item.command === "__custom-provider") {
      authReturnRoleRef.current = pickerRole;
      openCustomProviderFlow();
      return;
    }
    if (item.command.startsWith("__model:")) {
      const model = item.command.slice("__model:".length);
      const role = pickerRole ?? "brain";
      setPicker(null);
      setInput("");
      applyModelPick(role, model);
      return;
    }
    // Top-level command: run argless commands directly, otherwise fill.
    setInput(`${item.command} `);
    if (handleSlashCommand(item.command)) {
      setInput("");
    }
  }

  // Esc interrupts the running turn while the pane is selected, even when focus
  // sits outside the composer.
  useEffect(() => {
    if (!busy || !isSelected) return undefined;
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A pending permission owns Esc (OpenCode's reject key); interrupting
      // instead would abort the whole turn the user was asked to unblock.
      if (pendingPermission) {
        answerPermission("reject");
        return;
      }
      interrupt();
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, isSelected, session.id, pendingPermission]);

  const activeRoleLabel = ROLE_LABELS[activeRole];

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
  const pillStatus = waiting
    ? "waiting"
    : busy
      ? "running"
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
        "openfusion-pane",
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
          <Orbit size={15} />
          <span title={session.threadRef?.title || session.name}>
            {session.threadRef?.title || session.name}
          </span>
          <span className={clsx("openfusion-role-chip", `is-${activeRole}`)} title={modelsLine}>
            {activeRoleLabel}
          </span>
          {cwdConflict && (
            <span
              className={clsx(
                "pane-cwd-conflict-chip",
                cwdConflict.active && "is-active"
              )}
              title={cwdConflictTitle(cwdConflict)}
            >
              {cwdConflictChipLabel(cwdConflict)}
            </span>
          )}
        </div>
        <div className="pane-status">
          {/* waiting outranks busy: a permission ask leaves the server turn
              busy, but the pane is blocked on the human. */}
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
            title={session.started ? "Restart Open Fusion" : "Start Open Fusion"}
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
      <div className="fusion-chat" onPointerDown={onSelect}>
        <div className="fusion-chat-scroll" ref={scrollRef} onScroll={handleChatScroll}>
          {visibleMessages.length === 0 ? (
            <div className="oc-hero">
              <OpenFusionLogo />
              <p className="oc-hero-tag">
                Two specialists, one loop — the Brain plans and reviews, the Executor
                writes and runs.
              </p>
              <p className="oc-hero-hint">
                {modelsReady ? (
                  <>
                    Ask anything to get started <span className="oc-hero-sep">·</span>{" "}
                    <span className="oc-hero-key">/help</span> commands
                  </>
                ) : (
                  <>
                    Get started <span className="oc-hero-key">/connect</span>
                  </>
                )}
              </p>
            </div>
          ) : (
            visibleMessages.map((m) => (
              <OpenFusionChatRow
                key={m.key}
                m={m}
                isExpanded={expanded.has(m.key)}
                onToggle={toggleExpanded}
              />
            ))
          )}
        </div>

        <div className="fusion-input-area">
          {pendingPermission && (
            <div className="oc-permission" role="group" aria-label="Permission request">
              <div className="oc-permission-title">Permission required</div>
              <div className="oc-permission-body">{permissionDetail(pendingPermission)}</div>
              <div className="oc-permission-options">
                <button type="button" className="is-primary" onClick={() => answerPermission("once")}>
                  Allow once <span className="oc-key">enter</span>
                </button>
                <button type="button" onClick={() => answerPermission("always")}>
                  Allow always
                </button>
                <button type="button" onClick={() => answerPermission("reject")}>
                  Reject <span className="oc-key">esc</span>
                </button>
              </div>
            </div>
          )}
          {authFlow && (
            <div
              className="fusion-decision-panel"
              role="group"
              aria-label="Connect provider"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  cancelAuthFlow();
                }
              }}
            >
              <div className="fusion-decision-copy">
                <span className="fusion-decision-kind">
                  {authFlow.step.stage.startsWith("custom-")
                    ? "Add custom provider"
                    : `Connect ${authFlow.name}`}
                </span>
                <span className="fusion-decision-detail">
                  {authFlow.step.stage === "custom-name" &&
                    "Name this provider — it appears in the model pickers (e.g. 'My OpenRouter', 'Local LM Studio')."}
                  {authFlow.step.stage === "custom-url" &&
                    "OpenAI-compatible base URL (e.g. https://api.example.com/v1 or http://localhost:1234/v1)."}
                  {authFlow.step.stage === "custom-key" &&
                    `API key for '${authFlow.name}' — stored by OpenCode's credential store, never by vibeTerminal. Keyless local servers can skip this.`}
                  {authFlow.step.stage === "custom-model-id" &&
                    "Model id exactly as the endpoint expects it (e.g. llama-3.3-70b-versatile). You can add more afterwards."}
                  {authFlow.step.stage === "custom-model-name" &&
                    `Display name for '${authFlow.step.modelId}' — how it shows in the pickers. Enter keeps the id.`}
                  {authFlow.step.stage === "custom-model-context" &&
                    `Context window of '${authFlow.step.modelName}' in tokens (e.g. 128k) — used for auto-compaction and the usage display. Enter skips it (calls still work; compaction stays off).`}
                  {authFlow.step.stage === "custom-review" &&
                    `${authFlow.name} · ${authFlow.step.baseURL} · ${
                      authFlow.step.key ? "key set" : "no key (local endpoint)"
                    } · ${authFlow.step.models
                      .map((model) => {
                        const ctx = model.contextLimit
                          ? `, ${
                              model.contextLimit >= 1000
                                ? `${Math.round(model.contextLimit / 1000)}k`
                                : model.contextLimit
                            } ctx`
                          : "";
                        return model.name === model.id
                          ? `${model.id}${ctx}`
                          : `${model.name} (${model.id}${ctx})`;
                      })
                      .join(", ")}`}
                  {authFlow.step.stage === "method" &&
                    "Choose how to sign in. Credentials are stored by OpenCode's own credential store, never by vibeTerminal."}
                  {authFlow.step.stage === "prompts" &&
                    (authFlow.methods[authFlow.step.methodIndex]?.prompts?.[
                      authFlow.step.promptIndex
                    ]?.message ??
                      "Provide the requested value.")}
                  {authFlow.step.stage === "key" &&
                    `${
                      authFlow.methods[authFlow.step.methodIndex]?.label || "API key"
                    } for '${authFlow.providerId}' — stored by OpenCode's credential store, never by vibeTerminal.`}
                  {authFlow.step.stage === "oauth-start" && "Starting the sign-in flow…"}
                  {authFlow.step.stage === "oauth" &&
                    (authFlow.step.instructions ||
                      "Finish signing in with the opened browser page.")}
                  {authFlow.step.stage === "waiting" && "Connecting…"}
                </span>
              </div>

              {authFlow.step.stage === "method" && (
                <div className="fusion-decision-actions">
                  {authFlow.methods.map((method, index) => (
                    <button
                      key={`${method.type}-${index}`}
                      ref={index === 0 ? authPrimaryButtonRef : undefined}
                      className={clsx(
                        "fusion-decision-button",
                        index === 0 && "is-primary"
                      )}
                      type="button"
                      onClick={() => selectAuthMethod(index)}
                    >
                      <KeyRound size={14} />
                      <span>{method.label}</span>
                    </button>
                  ))}
                  <button
                    className="fusion-decision-button"
                    type="button"
                    title="Cancel"
                    onClick={cancelAuthFlow}
                  >
                    <Ban size={14} />
                    <span>Cancel</span>
                  </button>
                </div>
              )}

              {authFlow.step.stage === "prompts" &&
                (() => {
                  const step = authFlow.step;
                  const prompt =
                    authFlow.methods[step.methodIndex]?.prompts?.[step.promptIndex];
                  if (!prompt) return null;
                  if (prompt.type === "select") {
                    return (
                      <div className="fusion-decision-actions">
                        {(prompt.options ?? []).map((option, index) => (
                          <button
                            key={option.value}
                            ref={index === 0 ? authPrimaryButtonRef : undefined}
                            className={clsx(
                              "fusion-decision-button",
                              index === 0 && "is-primary"
                            )}
                            type="button"
                            title={option.hint || option.value}
                            onClick={() => advanceAuthPrompt(option.value)}
                          >
                            <Check size={14} />
                            <span>{option.label}</span>
                          </button>
                        ))}
                        <button
                          className="fusion-decision-button"
                          type="button"
                          title="Cancel"
                          onClick={cancelAuthFlow}
                        >
                          <Ban size={14} />
                          <span>Cancel</span>
                        </button>
                      </div>
                    );
                  }
                  return (
                    <div className="openfusion-auth-row">
                      <input
                        ref={authInputRef}
                        className="openfusion-auth-input"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={prompt.placeholder || prompt.key}
                        value={authText}
                        onChange={(e) => setAuthText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            advanceAuthPrompt(authText);
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            cancelAuthFlow();
                          }
                        }}
                      />
                      <button
                        className="fusion-decision-button is-primary"
                        type="button"
                        disabled={!authText.trim()}
                        onClick={() => advanceAuthPrompt(authText)}
                      >
                        <Check size={14} />
                        <span>Next</span>
                      </button>
                      <button
                        className="fusion-decision-button"
                        type="button"
                        title="Cancel"
                        onClick={cancelAuthFlow}
                      >
                        <Ban size={14} />
                        <span>Cancel</span>
                      </button>
                    </div>
                  );
                })()}

              {authFlow.step.stage === "key" && (
                <div className="openfusion-auth-row">
                  <input
                    ref={authInputRef}
                    className="openfusion-auth-input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={`${authFlow.providerId} API key…`}
                    value={authText}
                    onChange={(e) => setAuthText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        submitAuthKey();
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        cancelAuthFlow();
                      }
                    }}
                  />
                  <button
                    className="fusion-decision-button is-primary"
                    type="button"
                    title="Store the key and connect"
                    disabled={!authText.trim()}
                    onClick={submitAuthKey}
                  >
                    <KeyRound size={14} />
                    <span>Connect</span>
                  </button>
                  <button
                    className="fusion-decision-button"
                    type="button"
                    title="Cancel"
                    onClick={cancelAuthFlow}
                  >
                    <Ban size={14} />
                    <span>Cancel</span>
                  </button>
                </div>
              )}

              {CUSTOM_TEXT_STAGES.has(authFlow.step.stage) && (
                <div className="openfusion-auth-row">
                  <input
                    ref={authInputRef}
                    className="openfusion-auth-input"
                    type={authFlow.step.stage === "custom-key" ? "password" : "text"}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={
                      authFlow.step.stage === "custom-name"
                        ? "Provider name…"
                        : authFlow.step.stage === "custom-url"
                          ? "https://api.example.com/v1"
                          : authFlow.step.stage === "custom-key"
                            ? "API key (optional for local endpoints)…"
                            : authFlow.step.stage === "custom-model-id"
                              ? "Model id…"
                              : authFlow.step.stage === "custom-model-context"
                                ? "Context window, e.g. 128k (Enter skips)…"
                                : "Model display name (Enter keeps the id)…"
                    }
                    value={authText}
                    onChange={(e) => setAuthText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        advanceCustomStage(authText);
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        cancelAuthFlow();
                      }
                    }}
                  />
                  <button
                    className="fusion-decision-button is-primary"
                    type="button"
                    disabled={
                      !authText.trim() &&
                      authFlow.step.stage !== "custom-key" &&
                      authFlow.step.stage !== "custom-model-name" &&
                      authFlow.step.stage !== "custom-model-context"
                    }
                    onClick={() => advanceCustomStage(authText)}
                  >
                    <Check size={14} />
                    <span>
                      {authFlow.step.stage === "custom-key" && !authText.trim()
                        ? "Skip — no key"
                        : authFlow.step.stage === "custom-model-context" && !authText.trim()
                          ? "Skip"
                          : "Next"}
                    </span>
                  </button>
                  <button
                    className="fusion-decision-button"
                    type="button"
                    title="Cancel"
                    onClick={cancelAuthFlow}
                  >
                    <Ban size={14} />
                    <span>Cancel</span>
                  </button>
                </div>
              )}

              {authFlow.step.stage === "custom-review" && (
                <div className="fusion-decision-actions">
                  <button
                    ref={authPrimaryButtonRef}
                    className="fusion-decision-button is-primary"
                    type="button"
                    title="Save the provider into Open Fusion's own OpenCode config"
                    onClick={submitCustomProvider}
                  >
                    <Check size={14} />
                    <span>Save provider</span>
                  </button>
                  <button
                    className="fusion-decision-button"
                    type="button"
                    onClick={addAnotherCustomModel}
                  >
                    <Plus size={14} />
                    <span>Add another model</span>
                  </button>
                  <button
                    className="fusion-decision-button"
                    type="button"
                    title="Cancel"
                    onClick={cancelAuthFlow}
                  >
                    <Ban size={14} />
                    <span>Cancel</span>
                  </button>
                </div>
              )}

              {authFlow.step.stage === "oauth" && (
                <>
                  <div className="openfusion-auth-link" title={authFlow.step.url}>
                    <span className="openfusion-auth-url">{authFlow.step.url}</span>
                    <button
                      className="fusion-decision-button"
                      type="button"
                      title="Open in browser"
                      onClick={() => {
                        if (authFlow.step.stage === "oauth") {
                          void window.vibe?.openFusionChat?.openExternal(
                            authFlow.step.url
                          );
                        }
                      }}
                    >
                      <ExternalLink size={14} />
                      <span>Open</span>
                    </button>
                    <button
                      className="fusion-decision-button"
                      type="button"
                      title="Copy link or device code"
                      onClick={() => {
                        if (authFlow.step.stage !== "oauth") return;
                        const code = deviceCodeFromInstructions(
                          authFlow.step.instructions
                        );
                        window.vibe?.clipboard.writeText(code || authFlow.step.url);
                      }}
                    >
                      <Copy size={14} />
                      <span>
                        {deviceCodeFromInstructions(authFlow.step.instructions)
                          ? "Copy code"
                          : "Copy link"}
                      </span>
                    </button>
                  </div>
                  {authFlow.step.flow === "code" ? (
                    <div className="openfusion-auth-row">
                      <input
                        ref={authInputRef}
                        className="openfusion-auth-input"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="Paste the code from the browser…"
                        value={authText}
                        onChange={(e) => setAuthText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            submitOauthCode();
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            cancelAuthFlow();
                          }
                        }}
                      />
                      <button
                        className="fusion-decision-button is-primary"
                        type="button"
                        disabled={!authText.trim()}
                        onClick={submitOauthCode}
                      >
                        <Check size={14} />
                        <span>Complete</span>
                      </button>
                      <button
                        className="fusion-decision-button"
                        type="button"
                        title="Cancel"
                        onClick={cancelAuthFlow}
                      >
                        <Ban size={14} />
                        <span>Cancel</span>
                      </button>
                    </div>
                  ) : (
                    <div className="openfusion-auth-row">
                      <span className="openfusion-auth-waiting">
                        <span className="chat-spinner">✻</span> Waiting for the
                        browser sign-in to finish…
                      </span>
                      <button
                        className="fusion-decision-button"
                        type="button"
                        title="Cancel"
                        onClick={cancelAuthFlow}
                      >
                        <Ban size={14} />
                        <span>Cancel</span>
                      </button>
                    </div>
                  )}
                </>
              )}

              {(authFlow.step.stage === "oauth-start" ||
                authFlow.step.stage === "waiting") && (
                <div className="openfusion-auth-row">
                  <span className="openfusion-auth-waiting">
                    <span className="chat-spinner">✻</span>{" "}
                    {authFlow.step.stage === "waiting" ? "Connecting…" : "Starting…"}
                  </span>
                  <button
                    className="fusion-decision-button"
                    type="button"
                    title="Cancel"
                    onClick={cancelAuthFlow}
                  >
                    <Ban size={14} />
                    <span>Cancel</span>
                  </button>
                </div>
              )}
            </div>
          )}
          {/* First-run gate: Open Fusion assumes nothing — no provider, no
              models. The gate walks connect → pick and only then frees the
              first turn. Hidden while an auth flow or picker is open so it
              never stacks under those panels. */}
          {session.started && !modelsReady && !authFlow && !picker && providers !== null && (
            <div
              className="fusion-decision-panel openfusion-gate"
              role="group"
              aria-label="Finish Open Fusion setup"
            >
              <div className="fusion-decision-copy">
                <span className="fusion-decision-kind">
                  {onlyKeylessProviders
                    ? "Connect a provider to start"
                    : "Pick your models to start"}
                </span>
                <span className="fusion-decision-detail">
                  {onlyKeylessProviders
                    ? "Open Fusion assumes nothing: connect a model provider (OpenRouter, Anthropic, OpenAI, …) — keys live in vibeTerminal's own store, never in your personal OpenCode setup. The free opencode zen models work without a key if you just pick models."
                    : !plannerModel && !executorModel
                      ? "Choose the Brain (planner) and Executor models for this pane."
                      : !plannerModel
                        ? "Choose the Brain (planner) model for this pane."
                        : "Choose the Executor model for this pane."}
                </span>
              </div>
              <div className="fusion-decision-actions">
                {/* Connect is ALWAYS reachable from the gate: the keyless zen
                    provider means `providers` is never empty, so a
                    connected-count check would hide this forever. */}
                <button
                  className={clsx(
                    "fusion-decision-button",
                    onlyKeylessProviders && "is-primary"
                  )}
                  type="button"
                  title="Browse and connect a model provider"
                  onClick={() => openConnectPicker("connect")}
                >
                  <KeyRound size={14} />
                  <span>Connect a provider</span>
                </button>
                {!plannerModel && (
                  <button
                    className={clsx(
                      "fusion-decision-button",
                      !onlyKeylessProviders && "is-primary"
                    )}
                    type="button"
                    onClick={() => openModelPicker("brain")}
                  >
                    <Check size={14} />
                    <span>Pick Brain model</span>
                  </button>
                )}
                {!executorModel && (
                  <button
                    className={clsx(
                      "fusion-decision-button",
                      !onlyKeylessProviders && Boolean(plannerModel) && "is-primary"
                    )}
                    type="button"
                    onClick={() => openModelPicker("executor")}
                  >
                    <Check size={14} />
                    <span>Pick Executor model</span>
                  </button>
                )}
              </div>
            </div>
          )}
          {steering.length > 0 && (
            <div className="openfusion-steering" role="status" aria-label="Queued messages">
              {steering.map((item) => (
                <div key={item.key} className="openfusion-steering-item">
                  <span className="openfusion-steering-badge">Queued</span>
                  <span className="openfusion-steering-text">{clip(item.text, 400)}</span>
                </div>
              ))}
              <span className="openfusion-steering-hint">
                Held here until the Brain's next step picks it up · Esc interrupts now
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
                  waiting
                    ? "Answer the request above to continue…"
                    : busy
                      ? "Queue the next instruction…"
                      : !modelsReady
                        ? "Connect a provider and pick models to start…"
                        : `Ask anything... "${PROMPT_EXAMPLES[placeholderIndex % PROMPT_EXAMPLES.length]}"`
                }
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (menuOpen) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setSlashIndex((i) => (menu.items.length ? (i + 1) % menu.items.length : 0));
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setSlashIndex((i) =>
                        menu.items.length
                          ? (i - 1 + menu.items.length) % menu.items.length
                          : 0
                      );
                      return;
                    }
                    // Tab selects only inside a picker; elsewhere it keeps its
                    // browser meaning so keyboard users can reach the auth
                    // panel's buttons.
                    if (
                      (e.key === "Enter" && !e.shiftKey) ||
                      (e.key === "Tab" && picker !== null)
                    ) {
                      e.preventDefault();
                      applyMenuSelection(menu.items[slashIndex] ?? menu.items[0]);
                      return;
                    }
                    if (e.key === "Escape") {
                      // One level up per press: provider's model list → provider
                      // list → closed. The input-derived command menu hides but
                      // KEEPS the typed text (it used to be wiped).
                      e.preventDefault();
                      if (picker && "role" in picker && picker.provider) {
                        setPicker({ role: picker.role });
                        setInput("");
                        return;
                      }
                      if (picker) {
                        setPicker(null);
                        setInput("");
                        return;
                      }
                      setMenuDismissed(true);
                      return;
                    }
                  }
                  // OpenCode's permission dialog keys: enter allows (when not
                  // sending text), esc rejects.
                  if (pendingPermission) {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      answerPermission("reject");
                      return;
                    }
                    if (e.key === "Enter" && !e.shiftKey && !input.trim()) {
                      e.preventDefault();
                      answerPermission("once");
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
              <div className="oc-prompt-meta" title={modelsLine}>
                <span className="oc-prompt-agent">Brain</span>
                <span className="oc-prompt-sep">·</span>
                <span className="oc-prompt-model">{brainLabel}</span>
                <span className="oc-prompt-pair">⇄</span>
                <span className="oc-prompt-model is-executor">{executorLabel}</span>
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
                  {usageLabel && <span className="oc-usage">{usageLabel}</span>}
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
          {menuOpen && (
            <div className="fusion-slash-panel" aria-label="Slash command options">
              <div className="fusion-slash-title">{menu.title || "Commands"}</div>
              <ul className="fusion-slash-menu" role="listbox" aria-label={menu.title || "Commands"}>
                {menu.items.map((item, i) => (
                  <li
                    key={item.key}
                    ref={i === slashIndex ? activeMenuItemRef : undefined}
                    role="option"
                    aria-selected={i === slashIndex}
                    className={clsx("fusion-slash-item", i === slashIndex && "is-active")}
                    onMouseMove={() => setSlashIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyMenuSelection(item);
                    }}
                  >
                    <span className="fusion-slash-name">{item.label}</span>
                    <span className="fusion-slash-desc">{item.desc}</span>
                  </li>
                ))}
                {menu.items.length === 0 && (
                  <li className="fusion-slash-item">
                    <span className="fusion-slash-desc">Loading…</span>
                  </li>
                )}
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
          {pendingPermission && <span className="oc-footer-perm">△ 1 Permission</span>}
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
            <span className="oc-footer-dot">•</span> Open<b>Fusion</b>
          </span>
        </div>
      </footer>
    </article>
  );
}
