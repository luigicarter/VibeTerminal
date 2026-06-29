import { useEffect, useRef, useState } from "react";
import {
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
  FusionChatEvent,
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
  onAdd: () => void;
  onSelect: () => void;
  onMaximize: () => void;
  onThreadRefChange: (threadRef: AgentThreadRef) => void;
  onStatusChange: (status: SessionStatus) => void;
  onAttention: (attention: AgentAttentionEvent) => void;
}

const OPUS_LABEL = "Opus 4.8";
const CODEX_LABEL = "Codex GPT-5.5";

function formatToolCall(name: string, input: unknown): string {
  const data = (input ?? {}) as Record<string, unknown>;
  if (name.endsWith("codex_implement")) {
    return `delegate → ${String(data.task ?? "")}`;
  }
  if (name.endsWith("codex_respond")) {
    return `respond → ${String(data.decision ?? "")}${data.note ? `: ${data.note}` : ""}`;
  }
  return name.replace(/^mcp__[^_]+__/, "");
}

export default function FusionChatPane({
  session,
  profile,
  isMaximized,
  onClose,
  onDuplicate,
  onRestart,
  onResume,
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const keyRef = useRef(0);
  const onThreadRefChangeRef = useRef(onThreadRefChange);
  const onStatusChangeRef = useRef(onStatusChange);
  const onAttentionRef = useRef(onAttention);
  const busyRef = useRef(false);

  useEffect(() => {
    onThreadRefChangeRef.current = onThreadRefChange;
    onStatusChangeRef.current = onStatusChange;
    onAttentionRef.current = onAttention;
  }, [onThreadRefChange, onStatusChange, onAttention]);

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

  // (Re)start the headless Claude process on launch; stop it on unmount/restart.
  useEffect(() => {
    if (!session.started) {
      return;
    }
    setMessages([]);
    setBusyState(false);
    onStatusChangeRef.current("starting");
    let cancelled = false;
    const resumeId =
      session.nextLaunchMode === "resume" ? session.threadRef?.id : undefined;
    const fusionChat = window.vibe?.fusionChat;
    if (!fusionChat?.start) {
      const message = "Fusion unavailable: fusion chat bridge is not available.";
      push({ role: "opus", kind: "error", text: message });
      emitAttention("failed", "error", message);
      return;
    }
    fusionChat
      .start({ id: session.id, cwd: session.cwd, resumeId })
      .then((result) => {
        if (cancelled || !result || result.ok !== false) return;
        const message = `Fusion unavailable: ${result.error}`;
        push({ role: "opus", kind: "error", text: message });
        emitAttention("failed", "error", message);
      });
    return () => {
      cancelled = true;
      fusionChat.stop(session.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.launchToken, session.started]);

  // Merge the Opus stream (fusion-chat) and the Codex side-channel (fusion-activity).
  useEffect(() => {
    const appendStreaming = (role: "opus", kind: "text" | "thinking", delta: string) =>
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === role && last.kind === kind && last.streaming) {
          const copy = prev.slice();
          copy[copy.length - 1] = { ...last, text: last.text + delta };
          return copy;
        }
        return [
          ...prev,
          { key: nextKey(), role, kind, text: delta, ts: Date.now(), streaming: true }
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
        case "turn-start":
          setBusyState(true);
          onStatusChangeRef.current("running");
          break;
        case "assistant-text":
          appendStreaming("opus", "text", event.delta);
          break;
        case "thinking":
          appendStreaming("opus", "thinking", event.delta);
          break;
        case "tool-call":
          stopStreaming();
          push({
            role: "codex",
            kind: "tool-call",
            text: formatToolCall(event.name, event.input),
            toolId: event.toolId
          });
          break;
        case "tool-result":
          push({
            role: "codex",
            kind: "tool-result",
            text: event.text.slice(0, 600),
            toolId: event.toolId
          });
          break;
        case "turn-end":
          stopStreaming();
          break;
        case "result":
          stopStreaming();
          setBusyState(false);
          emitAttention("completed", "done");
          break;
        case "error":
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

    const handleActivity = (event: { type?: string; id?: string; role?: string; kind?: string; text?: string }) => {
      if (event?.type !== "fusion-activity" || event.id !== session.id) return;
      push({
        role: event.role === "opus" ? "opus" : "codex",
        kind: "activity",
        text: `${event.kind ? `${event.kind}: ` : ""}${event.text ?? ""}`
      });
    };

    const offChat = window.vibe?.fusionChat?.onEvent(handleChat as (e: unknown) => void);
    const offTerm = window.vibe?.terminal?.onEvent(handleActivity as (e: unknown) => void);
    return () => {
      offChat?.();
      offTerm?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function send() {
    const text = input.trim();
    if (!text || busy) return;
    push({ role: "user", kind: "text", text });
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
          <span className="fusion-chip fusion-chip-opus">{OPUS_LABEL}</span>
          <span className="fusion-chip fusion-chip-codex">{CODEX_LABEL}</span>
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
          {session.resumeRef?.id && (
            <button title="Resume last Fusion chat" onClick={onResume}>
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

      <div className="fusion-chat" onPointerDown={onSelect}>
        <div className="fusion-chat-scroll" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="fusion-chat-empty">
              <Sparkles size={26} />
              <p>Fusion terminal — {OPUS_LABEL} plans &amp; reviews, {CODEX_LABEL} implements.</p>
              <p className="muted">Ask for a change to get started.</p>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.key} className={clsx("chat-msg", `chat-${m.role}`, `chat-kind-${m.kind}`)}>
                <span className="chat-gutter">
                  {m.role === "user" ? "›" : m.kind === "text" ? "" : "●"}
                </span>
                <div className="chat-body">
                  {m.role !== "user" && (
                    <span className="chat-author">
                      {m.role === "opus" ? "Opus" : "Codex"}
                      {m.kind !== "text" && <span className="chat-kind">{m.kind}</span>}
                    </span>
                  )}
                  <span className="chat-text">
                    {m.text}
                    {m.streaming && <span className="chat-caret">▋</span>}
                  </span>
                </div>
              </div>
            ))
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
            disabled={!input.trim() || busy}
            onClick={send}
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </article>
  );
}
