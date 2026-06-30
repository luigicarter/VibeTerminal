import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
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
  Sparkles,
  X
} from "lucide-react";
import clsx from "clsx";
import type {
  AgentAttentionEvent,
  AgentProfile,
  AgentSession,
  AgentThreadRef,
  ChatMessage,
  FusionClaudeModel,
  FusionCodexModel,
  FusionChatEvent,
  FusionEffort,
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
const FUSION_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;
const FUSION_EFFORT_LABELS: Record<FusionEffort, string> = {
  auto: "Auto",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max"
};
const FUSION_EFFORT_VALUES = Object.keys(FUSION_EFFORT_LABELS) as FusionEffort[];
const FUSION_COMPOSER_MAX_PX = 160;

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
  { name: "/opus", desc: "Claude model and effort", submenu: true },
  { name: "/codex", desc: "Codex model and effort", submenu: true },
  { name: "/speed", desc: "Speed presets", submenu: true },
  { name: "/effort", desc: "Reasoning effort", submenu: true },
  { name: "/fast", desc: "Switch Claude to the fast model" },
  { name: "/claude", arg: "<model>", desc: "Set the Claude model", takesArg: true },
  { name: "/models", desc: "Show the current models and effort" },
  { name: "/resume", desc: "Resume the last Claude Fusion chat" },
  { name: "/clear", desc: "Clear this conversation" },
  { name: "/help", desc: "List the available commands" }
];

const effortItems = (prefix: string): SlashMenuItem[] =>
  FUSION_EFFORT_VALUES.map((effort) => ({
    key: `${prefix}-effort-${effort}`,
    label: `Effort ${FUSION_EFFORT_LABELS[effort]}`,
    desc: effort === "auto" ? "Use the runtime default" : `Use ${effort} reasoning effort`,
    command: prefix === "/effort" ? `${prefix} ${effort}` : `${prefix} effort ${effort}`
  }));

const filterSlashItems = (items: SlashMenuItem[], query: string) => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  return items.filter((item) =>
    `${item.label} ${item.desc}`.toLowerCase().includes(normalized)
  );
};

function buildSlashMenu(input: string): SlashMenu {
  if (!input.startsWith("/")) {
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
    return submenu("/opus", "Opus", [
      {
        key: "opus-model",
        label: "Opus 4.8",
        desc: "Claude orchestrator model",
        command: "/opus model"
      },
      {
        key: "opus-speed-fast",
        label: "Speed Fast",
        desc: "Fast Claude model + low effort",
        command: "/speed fast"
      },
      {
        key: "opus-speed-balanced",
        label: "Speed Balanced",
        desc: "Opus + automatic effort",
        command: "/speed balanced"
      },
      {
        key: "opus-speed-deep",
        label: "Speed Deep",
        desc: "Opus + high effort",
        command: "/speed deep"
      },
      {
        key: "opus-speed-max",
        label: "Speed Max",
        desc: "Opus + max effort",
        command: "/speed max"
      },
      ...effortItems("/opus")
    ]);
  }

  if (lower === "/codex" || lower.startsWith("/codex ")) {
    return submenu("/codex", "Codex", [
      {
        key: "codex-auto",
        label: "Default model",
        desc: "Use the configured Codex default",
        command: "/codex auto"
      },
      {
        key: "codex-custom",
        label: "Custom model",
        desc: "Type a Codex model id",
        fill: "/codex "
      },
      ...effortItems("/codex")
    ]);
  }

  if (lower === "/speed" || lower.startsWith("/speed ")) {
    return submenu("/speed", "Speed", [
      {
        key: "speed-fast",
        label: "Fast",
        desc: "Claude fast model + low effort",
        command: "/speed fast"
      },
      {
        key: "speed-balanced",
        label: "Balanced",
        desc: "Opus + automatic effort",
        command: "/speed balanced"
      },
      {
        key: "speed-deep",
        label: "Deep",
        desc: "Opus + high effort",
        command: "/speed deep"
      },
      {
        key: "speed-max",
        label: "Max",
        desc: "Opus + max effort",
        command: "/speed max"
      }
    ]);
  }

  if (lower === "/effort" || lower.startsWith("/effort ")) {
    return submenu("/effort", "Effort", effortItems("/effort"));
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

function fusionClaudeModelLabel(value: FusionClaudeModel) {
  if (value === "opus") return OPUS_LABEL;
  if (value === "sonnet") return "Fast";
  return value;
}

function fusionCodexModelLabel(value: FusionCodexModel) {
  return value === "auto" ? "Codex default" : value;
}

function fusionSettingsSummary(settings: FusionSettings) {
  return `Opus ${fusionClaudeModelLabel(settings.model)} · Opus effort ${FUSION_EFFORT_LABELS[settings.claudeEffort]} · Codex ${fusionCodexModelLabel(settings.codexModel)} · Codex effort ${FUSION_EFFORT_LABELS[settings.codexEffort]}`;
}

interface ToolMeta {
  name: string;
  isCodexBridge: boolean;
  isGoalTool: boolean;
}

// Opus makes every tool call. Fusion bridge calls are plumbing; Codex's
// user-facing voice is the concise result/status we derive from those calls.
function isCodexBridgeTool(name: string): boolean {
  return /codex_implement|codex_respond/.test(name);
}

function isCodexGoalTool(name: string): boolean {
  return /codex_goal_(?:set|get|clear)/.test(name);
}

function isInternalActivity(kind: string): boolean {
  return ["delegate", "decision", "goal"].includes(kind);
}

const baseName = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() ?? value;
const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max)}…` : value;

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
    const detail = String(parsed.detail ?? "Codex needs a decision.");
    return `needs ${kind}: ${clip(detail, 180)}`;
  }

  if (status === "completed") {
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
    return `failed: ${clip(String(parsed.error ?? "Codex returned an error."), 220)}`;
  }

  if (status === "ok" || status === "skipped") {
    return status;
  }

  return previewToolResult(text);
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
  const [interrupting, setInterrupting] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const keyRef = useRef(0);
  const interruptingRef = useRef(false);
  const pendingRestartNoticeRef = useRef<string | null>(null);
  const waitingForDecisionRef = useRef(false);
  const onThreadRefChangeRef = useRef(onThreadRefChange);
  const onStatusChangeRef = useRef(onStatusChange);
  const onAttentionRef = useRef(onAttention);
  const busyRef = useRef(false);
  const toolRoleRef = useRef(new Map<string, ToolMeta>());
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
  const fusionModelLabel = fusionClaudeModelLabel(fusionModel);
  const codexModelLabel = fusionCodexModelLabel(fusionCodexModel);
  const fusionSettingsLine = fusionSettingsSummary({
    model: fusionModel,
    codexModel: fusionCodexModel,
    claudeEffort: fusionClaudeEffort,
    codexEffort: fusionCodexEffort
  });
  const inputIsSlashCommand = input.trim().startsWith("/");
  const canResumeClaude = session.resumeRef?.provider === "claude" && Boolean(session.resumeRef.id);
  const slashMenu = buildSlashMenu(input);
  const slashMenuOpen = slashMenu.items.length > 0;
  const visibleMessages = verbose ? messages : messages.filter((message) => !message.internal);

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
    setWaitingState(false);
    setInterruptingState(false);
    setBusyState(false);
    onStatusChangeRef.current("starting");
    let cancelled = false;
    const resumeId =
      session.nextLaunchMode === "resume" && session.threadRef?.provider === "claude"
        ? session.threadRef.id
        : undefined;
    const fusionChat = window.vibe?.fusionChat;
    if (!fusionChat?.start) {
      const message = "Fusion unavailable: fusion chat bridge is not available.";
      push({ role: "opus", kind: "error", text: message });
      emitAttention("failed", "error", message);
      return;
    }
    const startTimer = window.setTimeout(() => {
      const startPayload = {
        id: session.id,
        cwd: session.cwd,
        resumeId,
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
          onThreadRefChangeRef.current({
            provider: "claude",
            id: event.sessionId,
            title: session.name,
            createdAt: session.createdAt,
            updatedAt: Date.now()
          });
          break;
        case "user":
          push({ role: "user", kind: "text", text: event.steer ? `Steer: ${event.text}` : event.text });
          break;
        case "turn-start":
          setInterruptingState(false);
          setWaitingState(false);
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
          appendStreaming("text", event.delta);
          break;
        case "thinking":
          appendStreaming("thinking", event.delta);
          break;
        case "tool-call": {
          // Opus is the actor for every call. Record bridge metadata so the
          // result can be voiced as concise Codex implementation status.
          const isCodexBridge = isCodexBridgeTool(event.name);
          const isGoalTool = isCodexGoalTool(event.name);
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
            setWaitingState(true);
            setBusyState(false);
            onStatusChangeRef.current("waiting");
            emitAttention(
              "waiting",
              parsed.status === "needs_decision" ? "approval" : "question",
              text
            );
          }
          break;
        }
        case "activity":
          push({
            role: event.role,
            kind: "activity",
            text: `${event.kind ? `${event.kind}: ` : ""}${event.text ?? ""}`,
            internal: isInternalActivity(event.kind || "")
          });
          break;
        case "turn-end":
          // Keep the Opus bubble open across assistant-message seams; it is
          // closed on `result`/`closed` so the whole answer stays together.
          break;
        case "result":
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
          stopStreaming();
          setInterruptingState(false);
          setWaitingState(false);
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
          stopStreaming();
          setInterruptingState(false);
          setWaitingState(false);
          push({ role: "opus", kind: "error", text: event.message });
          setBusyState(false);
          emitAttention("failed", "error", event.message);
          break;
        case "closed":
          stopStreaming();
          setInterruptingState(false);
          if (event.code != null && event.code !== 0) {
            const message = `Fusion process exited with code ${event.code}.`;
            setBusyState(false);
            push({ role: "opus", kind: "error", text: message });
            emitAttention("failed", "exit", message);
          } else if (busyRef.current) {
            const message = "Fusion process closed before returning a result.";
            setBusyState(false);
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
      model: normalizeFusionModel(settings.model ?? fusionModel),
      codexModel: normalizeFusionCodexModel(settings.codexModel ?? fusionCodexModel),
      claudeEffort: normalizeFusionEffort(settings.claudeEffort ?? fusionClaudeEffort),
      codexEffort: normalizeFusionEffort(settings.codexEffort ?? fusionCodexEffort)
    };
    if (
      nextSettings.model === fusionModel &&
      nextSettings.codexModel === fusionCodexModel &&
      nextSettings.claudeEffort === fusionClaudeEffort &&
      nextSettings.codexEffort === fusionCodexEffort
    ) {
      pushCommandStatus(`Already using ${fusionSettingsSummary(nextSettings)}.`);
      return;
    }
    const notice = session.started
      ? `${busyRef.current ? "Interrupting current turn and restarting" : "Restarting"} Fusion with ${fusionSettingsSummary(nextSettings)}.`
      : `Saved Fusion ${label}: ${fusionSettingsSummary(nextSettings)}.`;
    pendingRestartNoticeRef.current = session.started ? notice : null;
    pushCommandStatus(notice);
    onSettingsChange(nextSettings);
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
        "commands: /opus, /codex, /speed <fast|balanced|deep|max>, /claude <model>, /codex <model|auto>, /effort <level>, /models, /clear, /resume"
      );
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
      applySettings({ model: "sonnet", claudeEffort: "low", codexEffort: "low" }, "speed");
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
      handleSlashCommand(`/speed ${opusSpeedMatch[1]}`);
      return true;
    }

    if (normalized === "/speed" || normalized === "/claude" || normalized === "/codex" || normalized === "/effort") {
      setInput(`${normalized} `);
      composerRef.current?.focus();
      return true;
    }

    const speedMatch = raw.match(/^\/speed\s+(.+)$/i);
    if (speedMatch) {
      const value = speedMatch[1].trim().toLowerCase();
      if (value === "fast") {
        setInput("");
        applySettings({ model: "sonnet", claudeEffort: "low", codexEffort: "low" }, "speed");
        return true;
      }
      if (value === "balanced" || value === "opus") {
        setInput("");
        applySettings({ model: "opus", claudeEffort: "auto", codexEffort: "auto" }, "speed");
        return true;
      }
      if (value === "deep") {
        setInput("");
        applySettings({ model: "opus", claudeEffort: "high", codexEffort: "high" }, "speed");
        return true;
      }
      if (value === "max") {
        setInput("");
        applySettings({ model: "opus", claudeEffort: "max", codexEffort: "max" }, "speed");
        return true;
      }
      const nextModel = normalizeFusionModel(value);
      setInput("");
      applySettings({ model: nextModel }, "speed");
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

    const codexMatch = raw.match(/^\/(?:codex|model\s+codex)\s+(.+)$/i);
    if (codexMatch) {
      const nextModel = normalizeFusionCodexModel(codexMatch[1]);
      setInput("");
      applySettings({ codexModel: nextModel }, "Codex model");
      return true;
    }

    const effortMatch = normalized.match(/^\/effort\s+(auto|low|medium|high|xhigh|max)$/);
    if (effortMatch) {
      setInput("");
      applySettings({
        claudeEffort: effortMatch[1] as FusionEffort,
        codexEffort: effortMatch[1] as FusionEffort
      }, "effort");
      return true;
    }

    if (normalized.startsWith("/effort ")) {
      setInput("");
      pushCommandStatus("Unknown effort. Use /effort auto, low, medium, high, xhigh, or max.");
      return true;
    }

    return false;
  }

  function send() {
    const text = input.trim();
    if (!text) return;
    if (handleSlashCommand(text)) return;
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
    window.vibe.fusionChat.sendUserTurn(session.id, text);
    setInput("");
    setInterruptingState(false);
    setBusyState(true);
    onStatusChangeRef.current("running");
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
      className={clsx("terminal-pane", "fusion-pane")}
      style={{ "--pane-accent": profile.accent } as React.CSSProperties}
      onPointerDown={onSelect}
    >
      <header className="pane-header pane-drag-zone" title="Drag header to move pane">
        <div className="pane-title">
          <GripVertical className="drag-grip" size={15} />
          <Sparkles size={15} />
          <span>{session.name}</span>
          <span className="fusion-chip fusion-chip-opus" title={fusionSettingsLine}>Fusion</span>
        </div>
        <div className="pane-status">
          <span className={`status-pill status-${busy ? "running" : waiting ? "waiting" : "idle"}`}>
            {busy ? "working" : waiting ? "waiting" : "ready"}
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
              Fusion
            </span>
            {verbose && (
              <>
                <span className="fusion-setting">
                  <span className="fusion-setting-key">Opus</span>
                  {fusionModelLabel} / {FUSION_EFFORT_LABELS[fusionClaudeEffort]}
                </span>
                <span className="fusion-setting">
                  <span className="fusion-setting-key">Codex</span>
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
              const author = verbose ? (m.role === "opus" ? "Opus" : "Codex") : "Fusion";
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
            <div className="chat-msg chat-opus chat-kind-status">
              <span className="chat-gutter chat-spinner">✻</span>
              <div className="chat-body">
                <span className="chat-text muted">Working…</span>
              </div>
            </div>
          )}
        </div>

        <div className="fusion-input-area">
          <div className="fusion-composer">
            <textarea
              ref={composerRef}
              value={input}
              placeholder={
                busy
                  ? "Steer the running turn…"
                  : waiting
                    ? "Answer Fusion to continue…"
                    : "Ask Fusion to build, fix, or design…"
              }
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
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
          <div className="fusion-input-settings" title={fusionSettingsLine}>
            {fusionSettingsLine}
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
