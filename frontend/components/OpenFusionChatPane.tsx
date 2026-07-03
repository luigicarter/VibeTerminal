import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
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
  Send,
  ShieldCheck,
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
  SessionStatus
} from "../types";
import { validateOpenFusionModel } from "../openFusion";

export interface OpenFusionSettingsChange {
  plannerModel?: string;
  executorModel?: string;
}

interface OpenFusionChatPaneProps {
  session: AgentSession;
  profile: AgentProfile;
  cwdConflict?: CwdConflict;
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

// The connect flow mirrors OpenCode's own "Connect a provider" dialog: pick an
// auth method when a provider registers more than one, answer the method's
// prompt fields, then either store an API key (+ prompt answers as credential
// metadata) or run the OAuth authorize/callback pair.
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
  | { stage: "waiting"; methodIndex: number };

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
  | null;

const SLASH_COMMANDS = [
  { name: "/brain-model", desc: "Pick the Brain (planner) model" },
  { name: "/executor-model", desc: "Pick the Executor model" },
  { name: "/connect", desc: "Connect a provider (API key or OAuth)" },
  { name: "/disconnect", desc: "Remove a provider's stored credential" },
  { name: "/models", desc: "Show the current Brain and Executor models" },
  { name: "/resume", desc: "Resume the last Open Fusion chat" },
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

// One transcript row, memoized: a streaming delta re-renders ONLY the growing
// bubble instead of reconciling every row of a long transcript per chunk —
// that full-list churn is what made streaming feel choppy.
const OpenFusionChatRow = memo(function OpenFusionChatRow({
  m,
  verbose,
  isExpanded,
  onToggle
}: {
  m: OpenFusionChatMessage;
  verbose: boolean;
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

  const author = ROLE_LABELS[m.role];
  const className = clsx("chat-msg", `chat-${m.role}`, `chat-kind-${m.kind}`);

  if (m.kind === "tool-result" || m.kind === "thinking" || isSubagentStream) {
    // Raw work product stays ONE collapsed line — click expands and minimizes
    // it again, opencode-style, streaming included. While collapsed and live
    // it ticks along on its latest line instead of dumping the whole block
    // into the transcript.
    const preview = m.streaming ? lastLinePreview(m.text) : previewText(m.text);
    const expandable = preview !== m.text.trim();
    const open = verbose || isExpanded;
    return (
      <div className={className}>
        <span className="chat-gutter">●</span>
        <div className="chat-body">
          <div
            className={clsx("chat-tool", expandable && "chat-tool-expandable")}
            onClick={expandable ? () => onToggle(m.key) : undefined}
          >
            <span className="chat-tool-author">{author}</span>
            <span className="chat-tool-kind">
              {m.kind === "thinking" ? "thinking" : isSubagentStream ? "✎" : "↳"}
            </span>
            {expandable && <span className="chat-tool-caret">{open ? "▾" : "▸"}</span>}
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
      <div className={className}>
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
    <div className={className}>
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
});

export default function OpenFusionChatPane({
  session,
  profile,
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
  const [verbose, setVerbose] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  // Esc hides the input-derived command menu without erasing the typed text;
  // any input change re-arms it.
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [picker, setPicker] = useState<PickerState>(null);
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
    setMenuDismissed(false);
  }, [input, picker]);

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
      (step.stage === "prompts" &&
        authFlow.methods[step.methodIndex]?.prompts?.[step.promptIndex]?.type !==
          "select") ||
      (step.stage === "oauth" && step.flow === "code")
    ) {
      authInputRef.current?.focus();
    } else if (step.stage === "method" || step.stage === "prompts") {
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
  ) => setMessages((prev) => [...prev, { key: nextKey(), ts: Date.now(), ...entry }]);
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
            // Streamed bubbles stay in the visible transcript: only Brain TEXT
            // renders as prose — thinking and subagent streams (the executor's
            // code-in-progress, Scout's reasoning trail) render as collapsed
            // click-to-expand rows, so raw work product is reachable but never
            // dumped full-length the way it briefly was.
            arr.push({ key, role, kind, text: delta, ts: Date.now(), streaming: true });
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
            push({
              role: "brain",
              kind: "activity",
              text: `Provider '${event.providerId}' disconnected.`
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
          if (event.subtype === "restored") {
            onStatusChangeRef.current("idle");
            break;
          }
          if (interruptSettle) {
            onStatusChangeRef.current("waiting");
            flushSteering();
            break;
          }
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
          setInterruptingState(false);
          setBusyState(false);
          setWaitingState(false);
          setPendingPermission(null);
          push({ role: "brain", kind: "activity", text: "Turn interrupted." });
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
    void window.vibe?.openFusionChat
      ?.removeProviderKey(session.id, id)
      .then((result) => {
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
            desc: "connected — select to remove its credential",
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
        <div className="fusion-chat-scroll" ref={scrollRef} onScroll={handleChatScroll}>
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
            visibleMessages.map((m) => (
              <OpenFusionChatRow
                key={m.key}
                m={m}
                verbose={verbose}
                isExpanded={expanded.has(m.key)}
                onToggle={toggleExpanded}
              />
            ))
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
                <span className="fusion-decision-kind">Connect {authFlow.name}</span>
                <span className="fusion-decision-detail">
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
          <div className="fusion-composer">
            <textarea
              ref={composerRef}
              value={input}
              placeholder={
                waiting
                  ? "Answer the request above to continue…"
                  : busy
                    ? "Queue the next instruction… (Esc interrupts)"
                    : !modelsReady
                      ? "Finish setup first — connect a provider and pick models…"
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
    </article>
  );
}
