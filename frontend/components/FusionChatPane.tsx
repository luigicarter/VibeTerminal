import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CopyPlus,
  Gauge,
  GripVertical,
  Maximize2,
  Minimize2,
  Play,
  Plus,
  Cpu,
  RefreshCcw,
  RotateCcw,
  Send,
  Sparkles,
  X,
  Zap
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

// Opus makes every tool call (native tools AND the `delegate →` bridge call);
// Codex's only voice in the chat is the *result* of these bridge calls.
function isCodexTool(name: string): boolean {
  return /codex_implement|codex_respond/.test(name);
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
  if (name.endsWith("codex_implement")) {
    return `delegate → ${String(data.task ?? "")}`;
  }
  if (name.endsWith("codex_respond")) {
    return `respond → ${String(data.decision ?? "")}${data.note ? `: ${data.note}` : ""}`;
  }
  const base = name.replace(/^mcp__[^_]+__/, "");
  const hint = toolHint(base, data);
  return hint ? `${base} · ${hint}` : base;
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
  const [claudeModelDraft, setClaudeModelDraft] = useState("");
  const [codexModelDraft, setCodexModelDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const keyRef = useRef(0);
  const onThreadRefChangeRef = useRef(onThreadRefChange);
  const onStatusChangeRef = useRef(onStatusChange);
  const onAttentionRef = useRef(onAttention);
  const busyRef = useRef(false);
  const toolRoleRef = useRef(new Map<string, boolean>()); // toolId → is-Codex bridge call
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
  const fusionEffort = normalizeFusionEffort(session.fusionEffort);
  const fusionModelLabel = fusionClaudeModelLabel(fusionModel);
  const codexModelLabel = fusionCodexModelLabel(fusionCodexModel);
  const inputIsSlashCommand = input.trim().startsWith("/");
  const canResumeClaude = session.resumeRef?.provider === "claude" && Boolean(session.resumeRef.id);
  const claudeModelsListId = `${session.id}-fusion-claude-models`;
  const codexModelsListId = `${session.id}-fusion-codex-models`;

  useEffect(() => {
    onThreadRefChangeRef.current = onThreadRefChange;
    onStatusChangeRef.current = onStatusChange;
    onAttentionRef.current = onAttention;
  }, [onThreadRefChange, onStatusChange, onAttention]);

  useEffect(() => {
    setClaudeModelDraft(fusionModel);
  }, [fusionModel]);

  useEffect(() => {
    setCodexModelDraft(fusionCodexModel);
  }, [fusionCodexModel]);

  const nextKey = () => `m${keyRef.current++}`;
  const push = (entry: Omit<ChatMessage, "key" | "ts"> & { ts?: number }) =>
    setMessages((prev) => [...prev, { key: nextKey(), ts: Date.now(), ...entry }]);
  const setBusyState = (next: boolean) => {
    busyRef.current = next;
    setBusy(next);
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
    setMessages([]);
    setExpanded(new Set());
    toolRoleRef.current.clear();
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
        ...(fusionEffort === "auto" ? {} : { effort: fusionEffort })
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
          push({ role: "user", kind: "text", text: event.text });
          break;
        case "turn-start":
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
          // Opus is the actor for every call (incl. `delegate →`); record whether
          // it is a Codex bridge call so the *result* can be voiced as Codex.
          toolRoleRef.current.set(event.toolId, isCodexTool(event.name));
          push({
            role: "opus",
            kind: "tool-call",
            text: formatToolCall(event.name, event.input),
            toolId: event.toolId
          });
          break;
        }
        case "tool-result": {
          const fromCodex = toolRoleRef.current.get(event.toolId) ?? false;
          push({
            role: fromCodex ? "codex" : "opus",
            kind: "tool-result",
            text: clip(event.text ?? "", 8000),
            toolId: event.toolId
          });
          break;
        }
        case "activity":
          push({
            role: event.role,
            kind: "activity",
            text: `${event.kind ? `${event.kind}: ` : ""}${event.text ?? ""}`
          });
          break;
        case "turn-end":
          // Keep the Opus bubble open across assistant-message seams; it is
          // closed on `result`/`closed` so the whole answer stays together.
          break;
        case "result":
          stopStreaming();
          setBusyState(false);
          emitAttention("completed", "done");
          break;
        case "stderr": {
          const text = event.text.trim();
          if (text) {
            push({ role: "opus", kind: "error", text });
          }
          break;
        }
        case "error":
          stopStreaming();
          push({ role: "opus", kind: "error", text: event.message });
          setBusyState(false);
          emitAttention("failed", "error", event.message);
          break;
        case "closed":
          stopStreaming();
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

  function applySettings(settings: Partial<FusionSettings>) {
    const nextSettings = {
      model: normalizeFusionModel(settings.model ?? fusionModel),
      codexModel: normalizeFusionCodexModel(settings.codexModel ?? fusionCodexModel),
      effort: normalizeFusionEffort(settings.effort ?? fusionEffort)
    };
    if (
      nextSettings.model === fusionModel &&
      nextSettings.codexModel === fusionCodexModel &&
      nextSettings.effort === fusionEffort
    ) {
      return;
    }
    onSettingsChange(nextSettings);
  }

  function commitClaudeModelDraft() {
    const nextModel = normalizeFusionModel(claudeModelDraft);
    setClaudeModelDraft(nextModel);
    applySettings({ model: nextModel });
  }

  function commitCodexModelDraft() {
    const nextModel = normalizeFusionCodexModel(codexModelDraft);
    setCodexModelDraft(nextModel);
    applySettings({ codexModel: nextModel });
  }

  function pushCommandStatus(text: string) {
    push({ role: "opus", kind: "activity", text });
  }

  function handleSlashCommand(text: string) {
    const raw = text.trim();
    const normalized = raw.toLowerCase();
    if (!raw.startsWith("/")) {
      return false;
    }

    if (normalized === "/model" || normalized === "/models") {
      setInput("");
      pushCommandStatus(
        `models: Claude ${fusionModelLabel} (${fusionModel}) · Codex ${codexModelLabel} (${fusionCodexModel}) · effort ${FUSION_EFFORT_LABELS[fusionEffort]}`
      );
      return true;
    }

    if (normalized === "/help") {
      setInput("");
      pushCommandStatus(
        "commands: /claude <model>, /codex <model|auto>, /effort <level>, /models, /clear, /resume"
      );
      return true;
    }

    if (normalized === "/clear") {
      setInput("");
      setMessages([]);
      setBusyState(false);
      onClear();
      return true;
    }

    if (normalized === "/resume") {
      setInput("");
      if (canResumeClaude) {
        setMessages([]);
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
      applySettings({ model: "sonnet" });
      return true;
    }

    if (normalized === "/opus") {
      setInput("");
      applySettings({ model: "opus" });
      return true;
    }

    const claudeMatch = raw.match(/^\/(?:claude|model\s+claude)\s+(.+)$/i);
    if (claudeMatch) {
      const nextModel = normalizeFusionModel(claudeMatch[1]);
      setInput("");
      setClaudeModelDraft(nextModel);
      applySettings({ model: nextModel });
      return true;
    }

    const codexMatch = raw.match(/^\/(?:codex|model\s+codex)\s+(.+)$/i);
    if (codexMatch) {
      const nextModel = normalizeFusionCodexModel(codexMatch[1]);
      setInput("");
      setCodexModelDraft(nextModel);
      applySettings({ codexModel: nextModel });
      return true;
    }

    const effortMatch = normalized.match(/^\/effort\s+(auto|low|medium|high|xhigh|max)$/);
    if (effortMatch) {
      setInput("");
      applySettings({ effort: effortMatch[1] as FusionEffort });
      return true;
    }

    return false;
  }

  function send() {
    const text = input.trim();
    if (!text) return;
    if (handleSlashCommand(text)) return;
    if (busy) return;
    if (!window.vibe?.fusionChat?.sendUserTurn) {
      const message = "Fusion unavailable: fusion chat bridge is not available.";
      push({ role: "opus", kind: "error", text: message });
      emitAttention("failed", "error", message);
      return;
    }
    window.vibe.fusionChat.sendUserTurn(session.id, text);
    setInput("");
    setBusyState(true);
    onStatusChangeRef.current("running");
  }

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
          <span className="fusion-chip fusion-chip-opus">{fusionModelLabel}</span>
          <span className="fusion-chip fusion-chip-codex">{codexModelLabel}</span>
        </div>
        <div className="pane-status">
          <span className={`status-pill status-${busy ? "running" : "idle"}`}>
            {busy ? "working" : "ready"}
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
          <label className="fusion-model-field" title="Claude model">
            <Zap size={12} />
            <span>Claude</span>
            <input
              aria-label="Fusion Claude model"
              value={claudeModelDraft}
              list={claudeModelsListId}
              onChange={(event) => setClaudeModelDraft(event.target.value)}
              onBlur={commitClaudeModelDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
            <datalist id={claudeModelsListId}>
              <option value="opus" label={OPUS_LABEL} />
              <option value="sonnet" label="Fast" />
            </datalist>
          </label>
          <label className="fusion-model-field" title="Codex model">
            <Cpu size={12} />
            <span>Codex</span>
            <input
              aria-label="Fusion Codex model"
              value={codexModelDraft}
              list={codexModelsListId}
              onChange={(event) => setCodexModelDraft(event.target.value)}
              onBlur={commitCodexModelDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
            <datalist id={codexModelsListId}>
              <option value="auto" label="Default" />
              <option value="gpt-5.5" label="GPT-5.5" />
            </datalist>
          </label>
          <label className="fusion-select" title="Effort level">
            <Gauge size={12} />
            <select
              aria-label="Fusion effort level"
              value={fusionEffort}
              onChange={(event) =>
                applySettings({ effort: event.target.value as FusionEffort })
              }
            >
              {FUSION_EFFORT_VALUES.map((effort) => (
                <option key={effort} value={effort}>
                  {FUSION_EFFORT_LABELS[effort]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={clsx("fusion-verbose-toggle", verbose && "is-on")}
            title={verbose ? "Collapse tool output" : "Expand all tool output"}
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
          {messages.length === 0 ? (
            <div className="fusion-chat-empty">
              <Sparkles size={26} />
              <p>Fusion terminal — {fusionModelLabel} plans &amp; reviews, {codexModelLabel} implements.</p>
              <p className="muted">Ask for a change to get started.</p>
            </div>
          ) : (
            messages.map((m) => {
              const author = m.role === "opus" ? "Opus" : "Codex";
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

        <div className="fusion-composer">
          <textarea
            value={input}
            placeholder={busy ? "Working…" : "Ask Fusion to build, fix, or design…"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
          />
          <button
            className="fusion-send"
            title="Send (Enter)"
            disabled={!input.trim() || (busy && !inputIsSlashCommand)}
            onClick={send}
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </article>
  );
}
