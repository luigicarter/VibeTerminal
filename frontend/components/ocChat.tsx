import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import clsx from "clsx";

// ── Shared OpenCode-TUI-parity chat kit ──────────────────────────────────────
// The row shapes, tool glyphs, block panels, and chrome pieces both chat panes
// (Fusion and Open Fusion) render, extracted from OpenFusionChatPane so the
// Fusion pane wears the same skin. Everything here mirrors OpenCode's own TUI
// part renderers (verified against v1.17.11 packages/tui); the palette comes
// from the `.oc-skin` CSS scope, so each pane only picks its accent.
//
// This module is PRESENTATIONAL: it knows nothing about either pane's event
// stream. Panes normalize their events into `OcChatMessage` rows and hand them
// to `OcChatRow`.

export interface OcToolMeta {
  diff?: string;
  count?: number;
  matches?: number;
}

// The structural row model OcChatRow renders. Both panes' transcript message
// types satisfy it (OpenFusionChatMessage / ChatMessage narrow `role`).
export interface OcChatMessage {
  key: string;
  role: string;
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
  // Pane-supplied row label for tools whose input isn't self-describing
  // (e.g. Fusion's codex bridge calls); generic rows fall back to toolLabel().
  toolTitle?: string;
  meta?: OcToolMeta;
  // task rows: live progress line (current child work / call tally) and
  // completion stats, rendered as the "↳ …" second line like OpenCode.
  taskDetail?: string;
  // kind:"result" rows: completion-gate verdict for the settled turn — did the
  // planner independently check the last executor delegation? Neutral chip,
  // both states muted by design.
  gate?: { status: "verified" | "unverified"; evidence?: string[]; pendingSince?: number };
}

export function clip(value: string, max: number) {
  const text = (value ?? "").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function previewText(text: string): string {
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
export function lastLinePreview(text: string): string {
  const tail = (text ?? "").slice(-600);
  const lines = tail.split("\n").map((value) => value.trim()).filter(Boolean);
  const line = lines[lines.length - 1];
  return line ? clip(line, 120) : "…";
}

// Compact duration like OpenCode's Locale.duration: "12s", "1m 23s", "1h 2m".
export function formatDurationShort(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function titlecase(value: string) {
  const text = (value || "").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// ── OpenCode TUI parity: tool icons, labels, and row shapes ─────────────────
// Mirrors packages/tui/src/routes/session/index.tsx (v1.17.11): the same icon
// glyphs, pending texts, and label formats the real OpenCode TUI renders.

export const TOOL_ICONS: Record<string, string> = {
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

export const TOOL_PENDING: Record<string, string> = {
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

export function toolIcon(name: string, status: OcChatMessage["toolStatus"]) {
  if (name === "task" && status === "done") return "✓";
  return TOOL_ICONS[name] ?? "⚙";
}

// opencode's `input()` helper: primitive args rendered as [k=v, …].
export function inputSummary(input: unknown, omit: string[] = []): string {
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
// Both OpenCode (filePath) and Claude Code (file_path) argument spellings are
// understood, so the Fusion pane can pass tool inputs through untranslated.
export function toolLabel(name: string, input: unknown, meta?: OcToolMeta): string {
  const data = asRecord(input);
  const FILE_KEYS = ["filePath", "path", "file_path"];
  switch (name) {
    case "read":
      return `Read ${firstString(data.filePath, data.path, data.file_path) || "file"} ${inputSummary(input, FILE_KEYS)}`.trimEnd();
    case "edit":
      return `Edit ${firstString(data.filePath, data.path, data.file_path) || "file"}`;
    case "write":
      return `Write ${firstString(data.filePath, data.path, data.file_path) || "file"}`;
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
export function subagentTitle(input: unknown, fallbackTitle: string) {
  const data = asRecord(input);
  const agent = titlecase(firstString(data.subagent_type) || "executor");
  const description = firstString(data.description, fallbackTitle) || "subtask";
  return `${agent} Task — ${clip(description, 160)}`;
}

export interface TodoEntry {
  status: string;
  content: string;
}

export function parseTodos(value: unknown): TodoEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const todo = asRecord(item);
    const status = firstString(todo.status);
    const content = firstString(todo.content);
    return status && content ? [{ status, content }] : [];
  });
}

// OpenCode treats permission-rejected tool errors as "denied" (strikethrough).
export function isDeniedError(text: string) {
  return (
    text.includes("QuestionRejectedError") ||
    text.includes("rejected permission") ||
    text.includes("specified a rule") ||
    text.includes("user dismissed")
  );
}

export const OUTPUT_COLLAPSE_LINES = 10;

export function collapseOutput(text: string, maxLines: number) {
  const lines = (text ?? "").split("\n");
  if (lines.length <= maxLines) return { output: text, overflow: false };
  return { output: lines.slice(0, maxLines).join("\n"), overflow: true };
}

// The executor's task report comes back wrapped in <task …><task_result>…</…>.
export function extractTaskResult(text: string) {
  const match = /<task_result>([\s\S]*?)<\/task_result>/.exec(text ?? "");
  return (match ? match[1] : text ?? "").trim();
}

// OpenCode's "blocks" busy spinner: a knight-rider sweep of block cells,
// animated in CSS (styles.css .oc-spinner).
export function OcSpinner() {
  return (
    <span className="oc-spinner" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

// Prose renders as markdown like the OpenCode TUI. Links must open in the
// system browser — a plain anchor would navigate the Electron window.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
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
export const DiffBlock = memo(function DiffBlock({ diff }: { diff: string }) {
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

// ── Block-letter wordmarks ──────────────────────────────────────────────────
// OpenCode's exact logo technique ("_/^/~" shadow cells). Letter shapes reuse
// OpenCode's glyph font; F/U/S/I are derived in the same style. Panes compose
// words: Open Fusion renders OPEN (muted) + FUSION (bold); Fusion renders the
// single bold FUSION word.
export const OC_LOGO_OPEN = [
  "                   ",
  "█▀▀█ █▀▀█ █▀▀█ █▀▀▄",
  "█__█ █__█ █^^^ █__█",
  "▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀~~▀"
];
export const OC_LOGO_FUSION = [
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

export function OcLogo({
  words,
  label
}: {
  words: { lines: string[]; bold?: boolean }[];
  label: string;
}) {
  const rows = words[0]?.lines.length ?? 0;
  return (
    <div className="oc-logo" role="img" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="oc-logo-row">
          {words.map((word, w) => (
            <LogoLine key={w} line={word.lines[i] ?? ""} bold={word.bold} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── The shared transcript row ───────────────────────────────────────────────
// One row, memoized: a streaming delta re-renders ONLY the growing bubble
// instead of reconciling every row of a long transcript per chunk — that
// full-list churn is what made streaming feel choppy.
//
// Row shapes mirror OpenCode's TUI part renderers (v1.17.11): user blocks with
// a colored left bar, markdown prose, inline tool rows with icon glyphs, block
// panels for bash output / diffs / todos, "+ Thought" collapsibles, and
// "Agent Task — description" delegation rows with a "↳" progress line.
//
// `proseRole` is the pane's primary voice ("brain" / "opus"): its text renders
// as full-width markdown prose. Text from any other non-user role is subagent
// work product and renders as a Details-lane "↳" workline, the way OpenCode
// keeps subagent internals out of the parent transcript.
export const OcChatRow = memo(function OcChatRow({
  m,
  proseRole,
  isExpanded,
  onToggle
}: {
  m: OcChatMessage;
  proseRole: string;
  isExpanded: boolean;
  onToggle: (key: string) => void;
}) {
  const isSubagentStream = m.kind === "text" && m.role !== "user" && m.role !== proseRole;
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
          <div className="oc-block-title">
            ← Edit {firstString(data.filePath, data.path, data.file_path) || "file"}
          </div>
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
          {!hasInput && !m.toolTitle && status === "running" ? (
            <span className="oc-tool-pending">~ {TOOL_PENDING[name] ?? "Working..."}</span>
          ) : (
            <>
              <span className="oc-tool-icon">
                {status === "running" && name === "read" ? <OcSpinner /> : toolIcon(name, status)}
              </span>
              <span className="oc-tool-label">{m.toolTitle || toolLabel(name, m.toolInput, m.meta)}</span>
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
        {m.gate && (
          <span className="oc-turnend-gate">
            {" · "}
            {m.gate.status === "verified"
              ? `✓ checked · ${m.gate.evidence?.[0] ?? "evidence"}`
              : "unchecked"}
          </span>
        )}
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

  // Primary-voice prose: markdown, OpenCode's TextPart.
  return (
    <div className={clsx("oc-md", m.streaming && "is-streaming")}>
      <Markdown text={m.text} />
      {m.streaming && <span className="oc-caret">▋</span>}
    </div>
  );
});
