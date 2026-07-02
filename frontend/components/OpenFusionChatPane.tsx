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
  Orbit,
  Play,
  Plus,
  RefreshCcw,
  RotateCcw,
  Send,
  ShieldCheck,
  X
} from "lucide-react";
import clsx from "clsx";
import { shouldShowAttentionDot } from "../attention";
import type {
  AgentAttentionEvent,
  AgentProfile,
  AgentSession,
  AgentThreadRef,
  OpenFusionChatEvent,
  OpenFusionChatMessage,
  OpenFusionChatRole,
  OpenFusionProvider,
  SessionStatus
} from "../types";
import {
  DEFAULT_OPEN_FUSION_EXECUTOR_MODEL,
  DEFAULT_OPEN_FUSION_PLANNER_MODEL,
  validateOpenFusionModel
} from "../openFusion";

export interface OpenFusionSettingsChange {
  plannerModel?: string;
  executorModel?: string;
}

interface OpenFusionChatPaneProps {
  session: AgentSession;
  profile: AgentProfile;
  isMaximized: boolean;
  isSelected: boolean;
  onClose: () => void;
  onDuplicate: () => void;
  onRestart: () => void;
  onResume: () => void;
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

interface PendingPermission {
  requestId: string;
  role: OpenFusionChatRole;
  permission: string;
  patterns: string[];
  title?: string;
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
  | null;

const SLASH_COMMANDS = [
  { name: "/brain-model", desc: "Pick the Brain (planner) model" },
  { name: "/executor-model", desc: "Pick the Executor model" },
  { name: "/models", desc: "Show the current Brain and Executor models" },
  { name: "/resume", desc: "Resume the last Open Fusion chat" },
  { name: "/clear", desc: "Clear this conversation" },
  { name: "/help", desc: "List the available commands" }
];

function clip(value: string, max: number) {
  const text = (value ?? "").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function previewText(text: string): string {
  const line = (text ?? "")
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);
  return line ? clip(line, 120) : "(no output)";
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

// One human line per tool call, OpenCode tool vocabulary. Delegations get their
// own non-internal treatment in the event handler; everything here is the
// Details lane.
function formatToolCall(name: string, title: string, input: unknown): string {
  const data = asRecord(input);
  switch (name) {
    case "read":
      return `Read ${firstString(data.filePath, data.path) || "file"}`;
    case "edit":
      return `Edit ${firstString(data.filePath, data.path) || "file"}`;
    case "write":
      return `Write ${firstString(data.filePath, data.path) || "file"}`;
    case "bash":
      return `Run ${clip(firstString(data.command, data.description) || "command", 120)}`;
    case "glob":
      return `Find files ${firstString(data.pattern)}`;
    case "grep":
      return `Search ${clip(firstString(data.pattern), 80)}`;
    case "webfetch":
      return `Fetch ${clip(firstString(data.url), 100)}`;
    case "todowrite":
      return "Update the task list";
    case "todoread":
      return "Read the task list";
    case "task":
      return `Delegate: ${clip(firstString(title, data.description) || "subtask", 120)}`;
    default:
      return title
        ? `${name}: ${clip(title, 100)}`
        : `${name}${Object.keys(data).length ? ` ${clip(JSON.stringify(data), 100)}` : ""}`;
  }
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

export default function OpenFusionChatPane({
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
}: OpenFusionChatPaneProps) {
  const [messages, setMessages] = useState<OpenFusionChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const [activeRole, setActiveRole] = useState<OpenFusionChatRole>("brain");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [verbose, setVerbose] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [picker, setPicker] = useState<PickerState>(null);
  const [providers, setProviders] = useState<OpenFusionProvider[] | null>(null);
  const [availableProviders, setAvailableProviders] = useState<{ id: string; name: string }[]>([]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const keyRef = useRef(0);
  const busyRef = useRef(false);
  const interruptingRef = useRef(false);
  const waitingRef = useRef(false);
  const pendingRestartNoticeRef = useRef<string | null>(null);
  const threadIdRef = useRef("");
  const threadTitleRef = useRef("");
  const onThreadRefChangeRef = useRef(onThreadRefChange);
  const onStatusChangeRef = useRef(onStatusChange);
  const onAttentionRef = useRef(onAttention);

  const plannerModel =
    validateOpenFusionModel(session.openFusionPlannerModel) === null
      ? String(session.openFusionPlannerModel).trim()
      : DEFAULT_OPEN_FUSION_PLANNER_MODEL;
  const executorModel =
    validateOpenFusionModel(session.openFusionExecutorModel) === null
      ? String(session.openFusionExecutorModel).trim()
      : DEFAULT_OPEN_FUSION_EXECUTOR_MODEL;
  const brainLabel = shortModelLabel(plannerModel, DEFAULT_OPEN_FUSION_PLANNER_MODEL);
  const executorLabel = shortModelLabel(executorModel, DEFAULT_OPEN_FUSION_EXECUTOR_MODEL);
  const modelsLine = `Brain ${plannerModel} · Executor ${executorModel}`;
  const showAttention = shouldShowAttentionDot(session);
  const canResume =
    session.resumeRef?.provider === "opencode" && Boolean(session.resumeRef.id);
  const visibleMessages = verbose
    ? messages
    : messages.filter((message) => !message.internal);

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
  }, [input, picker]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, busy]);

  const nextKey = () => `m${keyRef.current++}`;
  const push = (
    entry: Omit<OpenFusionChatMessage, "key" | "ts"> & { ts?: number }
  ) => setMessages((prev) => [...prev, { key: nextKey(), ts: Date.now(), ...entry }]);
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
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  function publishThreadRef() {
    const threadId = threadIdRef.current;
    if (!threadId) return;
    onThreadRefChangeRef.current({
      provider: "opencode",
      id: threadId,
      title: threadTitleRef.current || session.threadRef?.title || session.name,
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
              confirmId: resumeId
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
    const appendStreaming = (
      role: OpenFusionChatRole,
      kind: "text" | "thinking",
      delta: string
    ) =>
      setMessages((prev) => {
        if (kind === "thinking" && !delta.trim()) {
          return prev;
        }
        // Append to the open bubble while it is the latest message so one
        // content block streams as ONE paragraph. A role or kind switch starts
        // a fresh bubble; only one caret is ever live.
        const last = prev[prev.length - 1];
        if (last && last.role === role && last.kind === kind && last.streaming) {
          const copy = prev.slice();
          copy[copy.length - 1] = { ...last, text: last.text + delta };
          return copy;
        }
        const cleared = prev.map((m) => (m.streaming ? { ...m, streaming: false } : m));
        return [
          ...cleared,
          { key: nextKey(), role, kind, text: delta, ts: Date.now(), streaming: true }
        ];
      });
    const stopStreaming = () =>
      setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));

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
      switch (event.type) {
        case "session":
          threadIdRef.current = event.sessionId;
          publishThreadRef();
          break;
        case "user":
          if (!threadTitleRef.current) {
            threadTitleRef.current = titleFromFirstPrompt(event.text);
            publishThreadRef();
          }
          push({ role: "user", kind: "text", text: event.text });
          break;
        case "turn-start":
          setActiveRole("brain");
          setInterruptingState(false);
          setWaitingState(false);
          setFailed(false);
          setPendingPermission(null);
          setBusyState(true);
          onStatusChangeRef.current("running");
          break;
        case "assistant-text":
          setActiveRole(event.role);
          appendStreaming(event.role, "text", event.delta);
          break;
        case "thinking":
          setActiveRole(event.role);
          appendStreaming(event.role, "thinking", event.delta);
          break;
        case "tool-call": {
          setActiveRole(event.role);
          const isDelegation = event.name === "task" && event.role === "brain";
          push({
            role: event.role,
            kind: isDelegation ? "activity" : "tool-call",
            text: isDelegation
              ? `Delegating to ${clip(
                  firstString(asRecord(event.input).subagent_type) || "executor",
                  24
                )}: ${clip(
                  firstString(event.title, asRecord(event.input).description) || "subtask",
                  160
                )}`
              : formatToolCall(event.name, event.title ?? "", event.input),
            toolId: event.toolId,
            internal: !isDelegation
          });
          break;
        }
        case "tool-result": {
          setActiveRole(event.role);
          const isDelegation = event.name === "task" && event.role === "brain";
          push({
            role: isDelegation ? "executor" : event.role,
            kind: isDelegation ? "tool-result" : "tool-result",
            text: isDelegation
              ? extractTaskResult(event.text)
              : clip(event.text ?? "", 8000) || "(no output)",
            toolId: event.toolId,
            internal: !isDelegation && event.ok
          });
          if (!event.ok && !isDelegation) {
            // Failed tools stay visible so the user sees why the Brain pivots.
            setMessages((prev) => {
              const copy = prev.slice();
              const last = copy[copy.length - 1];
              if (last && last.toolId === event.toolId) {
                copy[copy.length - 1] = { ...last, internal: false };
              }
              return copy;
            });
          }
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
        case "providers":
          if (event.ok) {
            setProviders(event.connected ?? []);
            setAvailableProviders(event.available ?? []);
          } else {
            setProviders([]);
            setAvailableProviders([]);
            push({
              role: "brain",
              kind: "activity",
              text: event.message || "Could not load the provider catalog.",
              internal: false
            });
          }
          break;
        case "result":
          setActiveRole("brain");
          stopStreaming();
          setInterruptingState(false);
          setBusyState(false);
          if (event.subtype === "restored") {
            onStatusChangeRef.current("idle");
            break;
          }
          if (waitingRef.current) {
            onStatusChangeRef.current("waiting");
          } else {
            onStatusChangeRef.current("done");
            emitAttention("completed", "done");
          }
          break;
        case "interrupted":
          stopStreaming();
          setInterruptingState(false);
          setBusyState(false);
          setWaitingState(false);
          setPendingPermission(null);
          push({ role: "brain", kind: "activity", text: "Turn interrupted." });
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
          setInterruptingState(false);
          setBusyState(false);
          setWaitingState(false);
          setPendingPermission(null);
          setFailed(true);
          push({ role: event.role ?? "brain", kind: "error", text: event.message });
          onStatusChangeRef.current("failed");
          emitAttention("failed", "error", event.message);
          break;
        }
        case "closed": {
          stopStreaming();
          setInterruptingState(false);
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
    if (!providers) {
      void window.vibe?.openFusionChat?.requestProviders(session.id);
    }
    composerRef.current?.focus();
  }

  function showModels() {
    push({ role: "brain", kind: "activity", text: modelsLine });
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
      case "/models":
      case "/openfusion":
        showModels();
        return true;
      case "/resume":
        onResume();
        return true;
      case "/clear":
        onClear();
        return true;
      case "/help":
        showHelp();
        return true;
      default:
        return false;
    }
  }

  function send() {
    const text = input.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      if (handleSlashCommand(text)) {
        setInput("");
        return;
      }
    }
    setInput("");
    setFailed(false);
    window.vibe?.openFusionChat?.sendUserTurn(session.id, text);
    if (!busyRef.current) {
      setBusyState(true);
      onStatusChangeRef.current("running");
    }
  }

  // ---- slash palette / model picker menu ----
  const menu: SlashMenu = (() => {
    const filter = input.trim().toLowerCase();
    if (picker) {
      const roleLabel = picker.role === "brain" ? "Brain" : "Executor";
      if (!providers) {
        return {
          title: `${roleLabel} model — loading the provider catalog…`,
          items: []
        };
      }
      if (!picker.provider) {
        const items: SlashMenuItem[] = providers
          .filter(
            (provider) =>
              !filter ||
              provider.name.toLowerCase().includes(filter) ||
              provider.id.toLowerCase().includes(filter)
          )
          .map((provider) => ({
            key: `prov-${provider.id}`,
            label: provider.name,
            desc: `connected · ${provider.models.length} models`,
            command: `__provider:${provider.id}`
          }));
        for (const provider of availableProviders) {
          if (items.length >= 14) break;
          if (
            filter &&
            !provider.name.toLowerCase().includes(filter) &&
            !provider.id.toLowerCase().includes(filter)
          ) {
            continue;
          }
          items.push({
            key: `avail-${provider.id}`,
            label: provider.name,
            desc: `needs auth: opencode auth login ${provider.id}`,
            command: `__needs-auth:${provider.id}`
          });
        }
        items.push({
          key: "custom",
          label: "Custom model id…",
          desc: "Type any provider/model id",
          fill: picker.role === "brain" ? "/brain-model " : "/executor-model "
        });
        return { title: `${roleLabel} provider`, items };
      }
      const items: SlashMenuItem[] = picker.provider.models
        .filter(
          (model) =>
            !filter ||
            model.name.toLowerCase().includes(filter) ||
            model.id.toLowerCase().includes(filter)
        )
        .slice(0, 16)
        .map((model) => ({
          key: `model-${model.id}`,
          label: model.name,
          desc: model.id,
          command: `__model:${picker.provider!.id}/${model.id}`
        }));
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
  const menuOpen = picker !== null || menu.items.length > 0;

  function applyMenuSelection(item: SlashMenuItem | undefined) {
    if (!item) return;
    if (item.fill !== undefined) {
      setPicker(null);
      setInput(item.fill);
      composerRef.current?.focus();
      return;
    }
    if (!item.command) return;
    if (item.command.startsWith("__provider:")) {
      const providerId = item.command.slice("__provider:".length);
      const provider = providers?.find((entry) => entry.id === providerId);
      if (provider && picker) {
        setPicker({ role: picker.role, provider });
        setInput("");
      }
      return;
    }
    if (item.command.startsWith("__needs-auth:")) {
      const providerId = item.command.slice("__needs-auth:".length);
      push({
        role: "brain",
        kind: "activity",
        text: `Provider '${providerId}' is not connected. Run: opencode auth login ${providerId}, then pick again.`
      });
      setPicker(null);
      setInput("");
      return;
    }
    if (item.command.startsWith("__model:")) {
      const model = item.command.slice("__model:".length);
      const role = picker?.role ?? "brain";
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
      interrupt();
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, isSelected, session.id]);

  const activeRoleLabel = ROLE_LABELS[activeRole];

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
          <span>{session.name}</span>
          <span className={clsx("openfusion-role-chip", `is-${activeRole}`)} title={modelsLine}>
            {activeRoleLabel}
          </span>
        </div>
        <div className="pane-status">
          {/* waiting outranks busy: a permission ask leaves the server turn
              busy, but the pane is blocked on the human. */}
          <span
            className={`status-pill status-${
              waiting ? "waiting" : busy ? "running" : failed ? "failed" : "idle"
            }`}
          >
            {waiting ? "waiting" : busy ? "working" : failed ? "failed" : "ready"}
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
            title={session.started ? "Restart Open Fusion" : "Start Open Fusion"}
            onClick={onRestart}
          >
            {session.started ? <RefreshCcw size={14} /> : <Play size={14} />}
          </button>
          {canResume && (
            <button title="Resume last Open Fusion chat" onClick={onResume}>
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
          <span
            className="fusion-settings-summary"
            title="Type /brain-model or /executor-model to change these"
          >
            <span className="fusion-setting">
              <span className="fusion-setting-key">Brain</span>
              {brainLabel}
            </span>
            <span className="fusion-setting">
              <span className="fusion-setting-key">Executor</span>
              {executorLabel}
            </span>
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
            <div className="openfusion-hero">
              <div className="openfusion-hero-mark">
                <Orbit size={30} />
              </div>
              <div className="openfusion-hero-word">
                OPEN<span>FUSION</span>
              </div>
              <p className="openfusion-hero-tag">
                Two specialists, one loop — the Brain plans and reviews, the Executor
                writes and runs.
              </p>
              <div className="openfusion-hero-roles">
                <div className="openfusion-hero-role is-brain">
                  <span className="openfusion-hero-role-key">Brain</span>
                  <span className="openfusion-hero-role-model">{plannerModel}</span>
                </div>
                <div className="openfusion-hero-role is-executor">
                  <span className="openfusion-hero-role-key">Executor</span>
                  <span className="openfusion-hero-role-model">{executorModel}</span>
                </div>
              </div>
              <p className="openfusion-hero-hint">
                Ask for a change to get started · /brain-model and /executor-model swap
                the pair
              </p>
            </div>
          ) : (
            visibleMessages.map((m) => {
              if (m.kind === "thinking" && !m.text.trim()) {
                return null;
              }

              const author = ROLE_LABELS[m.role];
              const className = clsx("chat-msg", `chat-${m.role}`, `chat-kind-${m.kind}`);

              if (m.kind === "tool-result" || m.kind === "thinking") {
                const preview = previewText(m.text);
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
          {busy && !pendingPermission && (
            <div className={clsx("chat-msg", "chat-kind-status")}>
              <span className="chat-gutter chat-spinner">✻</span>
              <div className="chat-body">
                <span className="chat-text muted">
                  {interrupting ? "Interrupting…" : `${activeRoleLabel} working…`}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="fusion-input-area">
          {pendingPermission && (
            <div className="fusion-decision-panel" role="group" aria-label="Permission request">
              <div className="fusion-decision-copy">
                <span className="fusion-decision-kind">
                  {ROLE_LABELS[pendingPermission.role]} permission
                </span>
                <span className="fusion-decision-detail">
                  {permissionDetail(pendingPermission)}
                </span>
              </div>
              <div className="fusion-decision-actions">
                <button
                  className="fusion-decision-button is-primary"
                  type="button"
                  title="Allow once"
                  onClick={() => answerPermission("once")}
                >
                  <Check size={14} />
                  <span>Allow</span>
                </button>
                <button
                  className="fusion-decision-button"
                  type="button"
                  title="Allow similar requests for this session"
                  onClick={() => answerPermission("always")}
                >
                  <ShieldCheck size={14} />
                  <span>Allow session</span>
                </button>
                <button
                  className="fusion-decision-button"
                  type="button"
                  title="Reject this request"
                  onClick={() => answerPermission("reject")}
                >
                  <Ban size={14} />
                  <span>Reject</span>
                </button>
              </div>
            </div>
          )}
          <div className="fusion-composer">
            <textarea
              ref={composerRef}
              value={input}
              placeholder={
                waiting
                  ? "Answer the request above to continue…"
                  : busy
                    ? "Queue the next instruction… (Esc interrupts)"
                    : "Ask Open Fusion to build, fix, or explain…"
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
                  if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                    e.preventDefault();
                    applyMenuSelection(menu.items[slashIndex] ?? menu.items[0]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setPicker(null);
                    setInput("");
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
              title="Send (Enter)"
              disabled={!input.trim()}
              onClick={send}
            >
              <Send size={15} />
            </button>
          </div>
          <div className="fusion-input-settings" title={modelsLine}>
            <span className="openfusion-pair">
              <span className="openfusion-pair-role is-brain">{brainLabel}</span>
              <span className="openfusion-pair-join">⇄</span>
              <span className="openfusion-pair-role is-executor">{executorLabel}</span>
            </span>
            <span className="fusion-settings-detail">Open Fusion · OpenCode engine</span>
          </div>
          {menuOpen && (
            <div className="fusion-slash-panel" aria-label="Slash command options">
              <div className="fusion-slash-title">{menu.title || "Commands"}</div>
              <ul className="fusion-slash-menu" role="listbox" aria-label={menu.title || "Commands"}>
                {menu.items.map((item, i) => (
                  <li
                    key={item.key}
                    role="option"
                    aria-selected={i === slashIndex}
                    className={clsx("fusion-slash-item", i === slashIndex && "is-active")}
                    onMouseEnter={() => setSlashIndex(i)}
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
    </article>
  );
}
