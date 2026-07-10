// Headless OpenCode chat host for Open Fusion panes.
//
// A child process of main (mirrors backend/fusionChatHost.cjs): it spawns ONE
// `opencode serve` per Open Fusion pane with that pane's OPENCODE_* env, creates
// (or resumes) the pane session over the server HTTP API, subscribes to the
// server's /event SSE feed, and normalizes OpenCode's event vocabulary into the
// same high-level chat events the Fusion pane speaks — so the renderer never
// sees OpenCode's wire format.
//
// Control IN (from main, one JSON per line on stdin):
//   {type:"start",      payload:{id, cwd, env, plannerModel, executorModel, resumeId?}}
//   {type:"input",      payload:{id, text}}
//   {type:"permission", payload:{id, requestId, reply}}   ← "once"|"always"|"reject"
//   {type:"planner-model", payload:{id, model}}           ← live Brain switch (next prompt)
//   {type:"providers",  payload:{id}}                     ← replies with a "providers" event
//   {type:"auth-set",   payload:{id, providerId, key, metadata?, nonce?}}
//                                                          ← store an API key (opencode auth store)
//   {type:"auth-remove", payload:{id, providerId}}        ← disconnect a provider
//   {type:"oauth-authorize", payload:{id, providerId, method, inputs?, nonce?}}
//                                                          ← start an OAuth method; replies "oauth-authorize"
//   {type:"oauth-callback", payload:{id, providerId, method, code?, nonce?}}
//                                                          ← complete OAuth ("auto" blocks until the
//                                                            device flow finishes); replies "auth-result"
//   {type:"custom-provider-set", payload:{id, providerId, name, baseURL, models, key?, nonce?}}
//                                                          ← define an OpenAI-compatible provider in the
//                                                            app-owned global OpenCode config (live via
//                                                            PATCH /global/config); replies "auth-result"
//   {type:"custom-provider-remove", payload:{id, providerId, removedFromConfig?}}
//                                                          ← main already dropped the config entry; this
//                                                            removes the credential and nudges servers to
//                                                            reload the file; replies "auth-result"
//   {type:"interrupt",  payload:{id}}                     ← abort the current turn, keep the server
//   {type:"stop",       payload:{id}}                     ← kill the pane's server
//   {type:"shutdown"}
// Events OUT (to main, one JSON per line on stdout): {type:"event", id, event}
//   plus {type:"ready"} on boot. Session exits are event.type === "closed".
//
// The SSE normalizer is exported (createOpenCodeEventNormalizer) so the parser
// smoke can replay a recorded event fixture — no OpenCode, no auth, no cost.

const { spawn, execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { windowsCmdArg } = require("./fusionChatHost.cjs");
const { createOpenFusionGateTracker } = require("./completionGate.cjs");

const isWin = process.platform === "win32";
const OPENCODE_BIN = process.env.VIBE_OPENCODE_BIN || "opencode";
const MAX_HISTORY_EVENTS = 20_000;
const MAX_TOOL_OUTPUT_CHARS = 20_000;
const PORT_TIMEOUT_MS = 30_000;
const SSE_RETRY_MS = 1_500;
const SSE_MAX_RETRIES = 5;
const STEER_ROUTER_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.VIBE_OPENFUSION_STEER_ROUTER_TIMEOUT_MS) || 20_000
);
const STEER_ROUTER_POLL_MS = Math.max(
  100,
  Number(process.env.VIBE_OPENFUSION_STEER_ROUTER_POLL_MS) || 500
);

function clipText(value, max = MAX_TOOL_OUTPUT_CHARS) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text;
}

// The slice of OpenCode's tool state.metadata the pane renders: edit diffs and
// glob/grep hit counts. Everything else in metadata stays server-side.
function toolMeta(metadata) {
  const source = metadata && typeof metadata === "object" ? metadata : {};
  const meta = {};
  if (typeof source.diff === "string" && source.diff.trim()) meta.diff = clipText(source.diff);
  if (Number.isFinite(source.count)) meta.count = Number(source.count);
  if (Number.isFinite(source.matches)) meta.matches = Number(source.matches);
  return Object.keys(meta).length ? meta : undefined;
}

function splitModelId(model) {
  const raw = String(model || "").trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  // Model ids may themselves contain "/" (openrouter/google/gemini-…): the
  // provider is only the FIRST segment.
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
}

// Standing completion-gate reminder appended to every Brain turn. The planner
// system prompt states the gate once, but over long conversations each accepted
// executor report becomes in-context precedent for rubber-stamping the next one;
// a per-turn reminder keeps the gate salient. The marker prefix is how the host
// recognizes its own part again: rehydration drops marked parts so a resumed
// transcript never shows the reminder as user text (live rendering never sees it
// — the pane echo carries only the user's own text, and the SSE normalizer drops
// non-assistant parts).
const OPEN_FUSION_GATE_MARKER = "[Open Fusion standing reminder]";
const OPEN_FUSION_GATE_REMINDER =
  `${OPEN_FUSION_GATE_MARKER} Executor reports are evidence, not verdicts: ` +
  "before presenting delegated work as done, verify it independently (git diff/status, " +
  "read the changed files, or an investigator pass) and state which check you ran. " +
  "While a background task runs, use the vibeterminal background_status tool to peek " +
  "at progress when the user asks; peeking is read-only and never replaces independently " +
  "reviewing the final report.";
// Plan-mode variant: the executor-verification copy is inapplicable while the
// executor is permission-denied. Same marker prefix — rehydration filters
// reminder parts by that prefix, so a new prefix would leak into resumed
// transcripts as user text.
const OPEN_FUSION_PLAN_REMINDER =
  `${OPEN_FUSION_GATE_MARKER} Plan mode is active: stay read-only. Investigate ` +
  "directly or via the investigator scout; the executor is permission-denied until " +
  "the user accepts the plan. End your reply with the complete milestone plan.";
// One-shot corrective nudge: armed by the completion-gate tracker when a turn
// settled presenting an executor report with no independent check, consumed by
// the next non-plan, non-queued turn. Same marker prefix — rehydration filters
// marked parts by that prefix, so a new prefix would leak into resumed
// transcripts as user text.
const OPEN_FUSION_GATE_NUDGE =
  `${OPEN_FUSION_GATE_MARKER} Correction: the previous executor delegation was ` +
  "presented without an independent check. Verify it now (git diff/status, read " +
  "the changed files, or an investigator pass) and state which check you ran " +
  "before continuing.";

const OPEN_FUSION_EXECUTOR_STEER_PREFIX =
  "Live user steering for this active Open Fusion executor task:\n";

// ---- detached background delegations ----
// The Brain's background_task MCP tool (app-owned "vibeterminal" bridge in the
// generated config) relays here via main. The host runs the delegation on a
// HOST-CREATED session driven by the executor-bg primary agent, watches the
// raw SSE feed for its completion, and — when it settles — wakes the Brain
// with the report as a NEW turn (queued host-side while the root is busy).
const OPEN_FUSION_BACKGROUND_MARKER = "[Open Fusion background report]";
const BACKGROUND_MAX_TASKS = 4;
const BACKGROUND_IDLE_TIMEOUT_MS = 600_000;
const BACKGROUND_HARD_TIMEOUT_MS = 14_400_000;
const BACKGROUND_REPORT_MAX_CHARS = 24_000;
const BACKGROUND_STATUS_MAX_ACTIVITY = 20;
const BACKGROUND_STATUS_MAX_SETTLED = 8;

function backgroundTaskTitleOf(description, prompt) {
  const source = String(description || "").trim() || String(prompt || "").trim();
  const firstLine =
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || "background task";
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine;
}

function buildOpenFusionBackgroundContract(prompt) {
  return [
    String(prompt || "").trim(),
    "",
    "## Detached background task",
    "You are running as a DETACHED background Open Fusion task: the Brain is not blocked on this call and nobody can answer mid-turn questions.",
    "If something is ambiguous, choose the most reasonable interpretation within your stated scope, or stop and record the blocker in your report.",
    "Finish with your standard OPEN_FUSION_EXECUTOR_REPORT block; your final message is delivered to the Brain when you finish, so make it self-contained."
  ].join("\n");
}

function buildOpenFusionBackgroundWakeText(event) {
  const result = event.result && typeof event.result === "object" ? event.result : {};
  const status = event.cancelled
    ? "cancelled"
    : result.status === "completed"
      ? "completed"
      : "failed";
  return [
    OPEN_FUSION_BACKGROUND_MARKER,
    `taskId: ${event.taskId}`,
    `title: ${event.title || "background task"}`,
    `status: ${status}`,
    "",
    result.status === "completed"
      ? `Executor report:\n${String(result.report || "(no report returned)")}`
      : `Error: ${String(result.error || "background task failed")}`,
    "",
    "Treat this exactly like a task tool result that just returned: verify it independently (git evidence, read the changed files, or an investigator pass) before presenting the work or releasing a dependent milestone, then report the outcome to the user."
  ].join("\n");
}

// Recognize a stored wake part in a resumed transcript and recover the row
// metadata (title/taskId) plus the report body for the collapsible row.
function parseOpenFusionBackgroundReport(text) {
  const value = String(text || "");
  if (!value.startsWith(OPEN_FUSION_BACKGROUND_MARKER)) return null;
  const meta = { taskId: "", title: "" };
  for (const line of value.split(/\r?\n/).slice(1, 5)) {
    const taskIdMatch = /^taskId:\s*(.*)$/.exec(line);
    if (taskIdMatch) meta.taskId = taskIdMatch[1].trim();
    const titleMatch = /^title:\s*(.*)$/.exec(line);
    if (titleMatch) meta.title = titleMatch[1].trim();
  }
  return { taskId: meta.taskId, title: meta.title, text: value };
}

function buildPlannerTurnParts(text, mode, options = {}) {
  const parts = [
    { type: "text", text: String(text ?? "") },
    {
      type: "text",
      text: mode === "plan" ? OPEN_FUSION_PLAN_REMINDER : OPEN_FUSION_GATE_REMINDER
    }
  ];
  if (options.nudge) parts.push({ type: "text", text: OPEN_FUSION_GATE_NUDGE });
  return parts;
}

function buildExecutorSteerParts(text) {
  return [{ type: "text", text: `${OPEN_FUSION_EXECUTOR_STEER_PREFIX}${String(text ?? "").trim()}` }];
}

function compactWhitespace(value, max = 1200) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function buildExecutorSteerPromptRequest(childSessionId, executorModel, text) {
  const sessionId = String(childSessionId || "").trim();
  const steerText = String(text || "").trim();
  const model = splitModelId(executorModel);
  if (!sessionId || !steerText || !model) return null;
  return {
    path: `/session/${encodeURIComponent(sessionId)}/prompt_async`,
    body: {
      agent: "executor",
      parts: buildExecutorSteerParts(steerText),
      model
    }
  };
}

function buildPlannerPromptRequest(sessionId, plannerModel, text, mode = "auto") {
  const rootSessionId = String(sessionId || "").trim();
  const promptText = String(text || "").trim();
  const model = splitModelId(plannerModel);
  if (!rootSessionId || !promptText || !model) return null;
  return {
    path: `/session/${encodeURIComponent(rootSessionId)}/prompt_async`,
    body: {
      agent: mode === "plan" ? "plan" : "planner",
      parts: buildPlannerTurnParts(promptText, mode, { nudge: false }),
      model
    }
  };
}

function buildOpenFusionSteerDecisionPrompt(userSteer, snapshot = {}) {
  return [
    "You are the Open Fusion Brain routing live user steering while your main Brain turn is blocked inside one or more native executor tasks.",
    "Decide which active executor child, if any, the user's steering targets, and whether it should be injected into that child, should stop/replan that child, or should be ignored.",
    "Return JSON only, no markdown, with this schema:",
    '{"action":"inject|replan|ignore","childSessionId":"active child session id or empty","text":"refined instruction or amended executor task","reason":"short reason"}',
    "",
    "Decision policy:",
    "- inject: the steer clarifies, corrects, or nudges one active executor task without changing scope.",
    "- replan: the steer changes scope, invalidates one active executor task, or requires a different delegation.",
    "- ignore: the steer is empty, irrelevant, or already satisfied.",
    "- When multiple active executor tasks are listed, choose the childSessionId whose taskPrompt/activity best matches the user steer.",
    "- When only one active executor task is listed, use that childSessionId for inject/replan.",
    "",
    `User steer:\n${String(userSteer || "").trim()}`,
    "",
    `Executor snapshot:\n${JSON.stringify(snapshot || {}, null, 2)}`
  ].join("\n");
}

function parseOpenFusionSteerDecision(value, fallbackText = "") {
  const raw = String(value || "").trim();
  let parsed = null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [
    fenced ? fenced[1] : "",
    raw,
    raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)
  ].filter((candidate) => candidate && candidate.includes("{") && candidate.includes("}"));
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // try the next shape
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      action: "inject",
      childSessionId: "",
      text: String(fallbackText || "").trim(),
      reason: "router_decision_parse_failed",
      fallback: true
    };
  }
  const action = String(parsed.action || parsed.decision || "").trim().toLowerCase();
  const normalized = ["inject", "replan", "ignore"].includes(action) ? action : "inject";
  return {
    action: normalized,
    childSessionId: String(parsed.childSessionId || parsed.sessionId || parsed.targetChildSessionId || "").trim(),
    text: String(parsed.text || "").trim() || String(fallbackText || "").trim(),
    reason: String(parsed.reason || "").trim(),
    fallback: normalized !== action
  };
}

function buildOpenFusionReplanPrompt(userSteer, amendedText, snapshot = {}) {
  const text = String(amendedText || "").trim() || String(userSteer || "").trim();
  return [
    "OPEN FUSION STEERING REPLAN:",
    "The user steered while the executor task was running. The router decided the current task should stop and the Brain should replan.",
    "",
    `User steer:\n${String(userSteer || "").trim()}`,
    "",
    `Amended instruction:\n${text}`,
    "",
    `Interrupted executor snapshot:\n${JSON.stringify(snapshot || {}, null, 2)}`,
    "",
    "Revise the plan and delegate a new executor task if needed. Do not assume the interrupted executor completed its work."
  ].join("\n");
}

function shouldRouteOpenFusionSteer(state, text) {
  return Boolean(String(text || "").trim() && hasActiveExecutorTask(state));
}

function summarizeOpenFusionExecutorActivity(event) {
  if (!event || typeof event !== "object") return "";
  if ((event.type === "assistant-text" || event.type === "thinking") && event.delta) {
    const label = event.type === "thinking" ? "thinking" : "assistant";
    return `${label}: ${compactWhitespace(event.delta, 180)}`;
  }
  if (event.type === "tool-call") {
    const input = event.input && typeof event.input === "object" ? event.input : {};
    const detail =
      event.title ||
      input.command ||
      input.filePath ||
      input.path ||
      input.pattern ||
      input.description ||
      input.prompt ||
      "";
    return `tool ${event.name || "tool"}: ${compactWhitespace(detail, 180)}`;
  }
  if (event.type === "tool-result") {
    return `tool ${event.name || "tool"} ${event.ok === false ? "failed" : "finished"}: ${compactWhitespace(event.text, 180)}`;
  }
  return "";
}

function extractOpenFusionAssistantTexts(messages) {
  const texts = [];
  for (const entry of Array.isArray(messages) ? messages : []) {
    const info = entry && entry.info && typeof entry.info === "object" ? entry.info : {};
    if (String(info.role || "") !== "assistant") continue;
    const parts = Array.isArray(entry && entry.parts) ? entry.parts : [];
    const text = parts
      .filter((part) => part && part.type === "text")
      .map((part) => String(part.text || ""))
      .join("\n")
      .trim();
    if (text) texts.push(text);
  }
  return texts;
}

function openFusionExecutorSnapshot(state) {
  const task = getPrimaryActiveExecutorTask(state) || {};
  const activeTasks = getActiveExecutorTasks(state).map((activeTask) => ({
    childSessionId: String(activeTask.childSessionId || "").trim(),
    taskPrompt: String(activeTask.taskPrompt || "").trim(),
    activity: Array.isArray(activeTask.activity) ? activeTask.activity.slice(-12) : []
  }));
  return {
    childSessionId: String(task.childSessionId || "").trim(),
    taskPrompt: String(task.taskPrompt || "").trim(),
    activity: Array.isArray(task.activity) ? task.activity.slice(-12) : [],
    activeTasks
  };
}

function getActiveExecutorTaskMap(state) {
  if (!state || typeof state !== "object") return null;
  if (!state.activeExecutorTasks || typeof state.activeExecutorTasks.values !== "function") {
    state.activeExecutorTasks = new Map();
  }
  return state.activeExecutorTasks;
}

function getActiveExecutorTasks(state) {
  if (!state || typeof state !== "object") return [];
  const map = getActiveExecutorTaskMap(state);
  if (map && typeof map.values === "function") {
    return Array.from(map.values()).filter(Boolean);
  }
  return [];
}

function getActiveExecutorTaskBySession(state, sessionID) {
  const key = String(sessionID || "");
  if (!key) return null;
  const map = getActiveExecutorTaskMap(state);
  return map && map.get(key) ? map.get(key) : null;
}

function hasActiveExecutorTask(state) {
  return getActiveExecutorTasks(state).length > 0;
}

function getPrimaryActiveExecutorTask(state) {
  const tasks = getActiveExecutorTasks(state);
  if (!tasks.length) return null;
  // M1 compatibility path: keep pre-M2 steering behavior equivalent to the
  // previous last-writer-wins single active-executor slot.
  let primary = null;
  for (const task of tasks) {
    if (!primary || Number(task.startedAt || 0) >= Number(primary.startedAt || 0)) {
      primary = task;
    }
  }
  return primary;
}

function selectOpenFusionExecutorTask(state, childSessionId) {
  const requested = String(childSessionId || "").trim();
  if (requested) {
    const task = getActiveExecutorTaskBySession(state, requested);
    if (task) return task;
  }
  return getPrimaryActiveExecutorTask(state);
}

// ---- SSE normalizer (pure, per-session state) ----
// Turns parsed OpenCode /event objects into high-level chat events. Only events
// belonging to the pane's session tree (root session + task-spawned child
// sessions) are surfaced; server-wide noise (catalog.updated, plugin.added,
// session.diff, heartbeats) is dropped here.
function createOpenCodeEventNormalizer(rootSessionId) {
  const root = String(rootSessionId || "");
  const tree = new Map(); // sessionID -> {agent, title}
  tree.set(root, { agent: "planner", title: "" });
  const messageInfo = new Map(); // messageID -> {role, agent, sessionID}
  const partProgress = new Map(); // partID -> {emitted: length, ended: bool}
  const partTypes = new Map(); // partID -> "text" | "reasoning"
  const toolStatus = new Map(); // callID -> last status emitted
  let busy = false;
  let turnStats = { input: 0, output: 0, reasoning: 0, cost: 0 };

  function roleFor(sessionID) {
    if (sessionID === root) return "brain";
    const info = tree.get(sessionID);
    return info && info.agent === "investigator" ? "investigator" : "executor";
  }

  function inTree(sessionID) {
    return tree.has(String(sessionID || ""));
  }

  function progressFor(partID) {
    let entry = partProgress.get(partID);
    if (!entry) {
      entry = { emitted: 0, ended: false };
      partProgress.set(partID, entry);
      if (partProgress.size > 4_000) {
        const oldest = partProgress.keys().next().value;
        partProgress.delete(oldest);
      }
    }
    return entry;
  }

  // text-start/reasoning-start always emit a part snapshot BEFORE the first
  // delta, so within an attached stream the type is known when deltas arrive.
  function registerPartType(partID, type) {
    if (!partID || partTypes.has(partID)) return;
    partTypes.set(partID, type);
    if (partTypes.size > 4_000) {
      const oldest = partTypes.keys().next().value;
      partTypes.delete(oldest);
    }
  }

  // Streamed content arrives twice: incremental message.part.delta while the
  // model runs AND full-text message.part.updated snapshots. Tracking the
  // emitted length per part dedupes both directions (and models that never
  // stream still surface through the snapshot path). streamId identifies the
  // producing part: several parts can stream CONCURRENTLY on one feed (parallel
  // task children, reasoning beside text), and a renderer that buckets deltas
  // by role alone interleaves them into one garbled paragraph. A snapshot with
  // part.time.end is the part's completion signal — stream-end lets the pane
  // retire that bubble's live caret without waiting for the whole turn.
  function emitStreamField(events, sessionID, part, partType, fullText) {
    const info = messageInfo.get(String(part.messageID || ""));
    if (!info || info.role !== "assistant") return;
    const partId = String(part.id || "");
    const progress = progressFor(partId);
    const text = String(fullText ?? "");
    if (!progress.ended && text.length > progress.emitted) {
      const delta = text.slice(progress.emitted);
      progress.emitted = text.length;
      events.push({
        type: partType === "reasoning" ? "thinking" : "assistant-text",
        role: roleFor(sessionID),
        delta,
        streamId: `${sessionID}:${partId}`
      });
    }
    const time = part.time && typeof part.time === "object" ? part.time : null;
    if (time && time.end && !progress.ended) {
      progress.ended = true;
      events.push({
        type: "stream-end",
        role: roleFor(sessionID),
        streamId: `${sessionID}:${partId}`
      });
    }
  }

  return function normalize(raw) {
    const event = raw && typeof raw === "object" ? raw : {};
    const type = String(event.type || "");
    const props = event.properties && typeof event.properties === "object" ? event.properties : {};
    const sessionID = String(props.sessionID || "");
    const events = [];

    switch (type) {
      case "session.created": {
        const info = props.info && typeof props.info === "object" ? props.info : {};
        const parentID = String(info.parentID || "");
        if (inTree(parentID)) {
          tree.set(String(info.id || sessionID), {
            agent: String(info.agent || "executor"),
            title: String(info.title || "")
          });
        }
        break;
      }
      case "message.updated": {
        if (!inTree(sessionID)) break;
        const info = props.info && typeof props.info === "object" ? props.info : {};
        if (info.id) {
          const messageId = String(info.id);
          const isNew = !messageInfo.has(messageId);
          messageInfo.set(messageId, {
            role: String(info.role || ""),
            agent: String(info.agent || ""),
            sessionID
          });
          if (messageInfo.size > 4_000) {
            const oldest = messageInfo.keys().next().value;
            messageInfo.delete(oldest);
          }
          // A NEW root assistant message = the run loop started its next step
          // with the full message list as context — this is the moment a
          // prompt queued mid-turn is absorbed (verified against the 1.17.11
          // run loop: each iteration re-reads messages, and its exit check
          // `lastUser.id < lastAssistant.id` forces another iteration for any
          // user message that arrived during the previous step).
          if (isNew && sessionID === root && String(info.role || "") === "assistant" && busy) {
            events.push({ type: "step-start" });
          }
        }
        break;
      }
      case "message.part.delta": {
        if (!inTree(sessionID)) break;
        // `field` names the part PROPERTY being appended, not a content kind:
        // opencode publishes field:"text" for BOTH text-delta and
        // reasoning-delta (reasoning content lives in part.text; a
        // field:"reasoning" delta does not exist in 1.17.11). The kind comes
        // from the part's registered type.
        if (String(props.field || "") !== "text") break;
        const info = messageInfo.get(String(props.messageID || ""));
        if (!info || info.role !== "assistant") break;
        const partId = String(props.partID || "");
        const partType = partTypes.get(partId);
        // Unknown part (attached mid-stream): drop the delta WITHOUT advancing
        // the cursor — the next full snapshot re-delivers this content with
        // the right kind through the length dedupe.
        if (!partType) break;
        // Content landing AFTER the part's end snapshot is a bus straggler
        // duplicating tail text the snapshot already delivered. Emitting it
        // would reopen a pane bubble whose caret nothing retires — stream-end
        // is deliberately once-per-part.
        const progress = progressFor(partId);
        if (progress.ended) break;
        const delta = String(props.delta ?? "");
        if (!delta) break;
        progress.emitted += delta.length;
        events.push({
          type: partType === "reasoning" ? "thinking" : "assistant-text",
          role: roleFor(sessionID),
          delta,
          streamId: `${sessionID}:${partId}`
        });
        break;
      }
      case "message.part.updated": {
        if (!inTree(sessionID)) break;
        const part = props.part && typeof props.part === "object" ? props.part : {};
        const partType = String(part.type || "");
        if (partType === "text" || partType === "reasoning") {
          registerPartType(String(part.id || ""), partType);
          emitStreamField(events, sessionID, part, partType, part.text);
          break;
        }
        if (partType === "step-finish") {
          const tokens = part.tokens && typeof part.tokens === "object" ? part.tokens : {};
          turnStats.input += Number(tokens.input) || 0;
          turnStats.output += Number(tokens.output) || 0;
          turnStats.reasoning += Number(tokens.reasoning) || 0;
          turnStats.cost += Number(part.cost) || 0;
          break;
        }
        if (partType !== "tool") break;
        const state = part.state && typeof part.state === "object" ? part.state : {};
        const status = String(state.status || "");
        const callID = String(part.callID || part.id || "");
        const role = roleFor(sessionID);
        const name = String(part.tool || "tool");
        const metadata = state.metadata && typeof state.metadata === "object" ? state.metadata : {};
        const childSessionId = name === "task" && metadata.sessionId ? String(metadata.sessionId) : "";
        // Register task-spawned child sessions from tool metadata too — the
        // session.created event can arrive after the first child part.
        if (childSessionId && !inTree(childSessionId)) {
          const input = state.input && typeof state.input === "object" ? state.input : {};
          tree.set(childSessionId, {
            agent: String(input.subagent_type || "executor"),
            title: String(state.title || "")
          });
        }
        const previous = toolStatus.get(callID);
        if (status === "pending" || status === "running") {
          if (childSessionId && previous === "called") {
            const input = state.input && typeof state.input === "object" ? state.input : {};
            events.push({
              type: "task-child",
              toolId: callID,
              name,
              role,
              sessionID,
              childSessionId,
              agent: String(input.subagent_type || "executor")
            });
          }
          if (previous === "called" || previous === "done") break;
          toolStatus.set(callID, "called");
          events.push({
            type: "tool-call",
            toolId: callID,
            name,
            role,
            sessionID,
            childSessionId: childSessionId || undefined,
            title: String(state.title || ""),
            input: state.input && typeof state.input === "object" ? state.input : {}
          });
          break;
        }
        if (status === "completed" || status === "error") {
          if (previous === "done") break;
          if (previous !== "called") {
            // Snapshot-only path (rehydration or missed pending event).
            events.push({
              type: "tool-call",
              toolId: callID,
              name,
              role,
              sessionID,
              childSessionId: childSessionId || undefined,
              title: String(state.title || ""),
              input: state.input && typeof state.input === "object" ? state.input : {}
            });
          }
          toolStatus.set(callID, "done");
          if (toolStatus.size > 4_000) {
            const oldest = toolStatus.keys().next().value;
            toolStatus.delete(oldest);
          }
          events.push({
            type: "tool-result",
            toolId: callID,
            name,
            role,
            sessionID,
            ok: status === "completed",
            title: String(state.title || ""),
            text: clipText(status === "completed" ? state.output : state.error || state.output),
            meta: toolMeta(metadata),
            // Links a settled task delegation to the child session whose
            // edit/write paths the completion-gate tracker accumulated.
            childSessionId: childSessionId || undefined
          });
          break;
        }
        break;
      }
      case "session.status": {
        if (sessionID !== root) break;
        const statusType = String((props.status && props.status.type) || "");
        if (statusType === "busy" && !busy) {
          busy = true;
          turnStats = { input: 0, output: 0, reasoning: 0, cost: 0 };
          events.push({ type: "turn-start" });
        }
        break;
      }
      case "session.idle": {
        if (sessionID !== root || !busy) break;
        busy = false;
        events.push({
          type: "result",
          tokens: {
            input: turnStats.input,
            output: turnStats.output,
            reasoning: turnStats.reasoning
          },
          costUsd: turnStats.cost
        });
        break;
      }
      case "session.error": {
        if (!inTree(sessionID)) break;
        const error = props.error && typeof props.error === "object" ? props.error : {};
        const data = error.data && typeof error.data === "object" ? error.data : {};
        const message = String(data.message || error.name || "OpenCode session error");
        // Aborts surface as session.error too; the interrupt path already
        // emits "interrupted", so keep those out of the error lane.
        if (/abort/i.test(String(error.name || "")) || /abort/i.test(message)) break;
        events.push({ type: "error", message, role: roleFor(sessionID) });
        break;
      }
      case "permission.asked": {
        if (!inTree(sessionID)) break;
        events.push({
          type: "permission",
          requestId: String(props.id || ""),
          role: roleFor(sessionID),
          permission: String(props.permission || ""),
          patterns: Array.isArray(props.patterns) ? props.patterns.map(String) : [],
          title: String(props.title || "")
        });
        break;
      }
      case "permission.replied": {
        if (!inTree(sessionID)) break;
        events.push({
          type: "permission-resolved",
          requestId: String(props.requestID || ""),
          reply: String(props.reply || "")
        });
        break;
      }
      case "question.asked": {
        // V1 question-service shape (1.17.13 source, string-confirmed in the
        // 1.17.11 binary): { id: "que_…", sessionID, questions: Info[], tool? }
        // — the reply URL's requestID is this event's `id`, and `questions` is
        // an ARRAY (multi-question requests are legal). Previously this fell
        // through `default` and the turn hung invisibly.
        if (!inTree(sessionID)) break;
        const questions = (Array.isArray(props.questions) ? props.questions : [])
          .map((entry) => {
            const q = entry && typeof entry === "object" ? entry : {};
            return {
              question: String(q.question || ""),
              header: String(q.header || ""),
              options: (Array.isArray(q.options) ? q.options : []).map((opt) => {
                const o = opt && typeof opt === "object" ? opt : {};
                return {
                  label: String(o.label || ""),
                  description: String(o.description || "")
                };
              }),
              multiple: q.multiple === true,
              // opencode defaults free-text answers to allowed.
              custom: q.custom !== false
            };
          })
          .filter((q) => q.question || q.options.length);
        if (!questions.length) break;
        events.push({
          type: "question",
          requestId: String(props.id || ""),
          role: roleFor(sessionID),
          questions
        });
        break;
      }
      case "session.compacted": {
        // Manual /compact AND server auto-compaction both land here — the
        // pane gets its "Context compacted." marker for free either way.
        if (sessionID !== root) break;
        events.push({ type: "compacted" });
        break;
      }
      case "question.replied":
      case "question.rejected": {
        if (sessionID && !inTree(sessionID)) break;
        events.push({
          type: "question-resolved",
          requestId: String(props.requestID || props.id || "")
        });
        break;
      }
      default:
        break;
    }
    return events;
  };
}

// Rehydrate a resumed session's transcript from GET /session/{id}/message into
// normalized events (no streaming — full snapshots).
function rehydrateMessages(messages, rootSessionId) {
  const events = [];
  for (const entry of Array.isArray(messages) ? messages : []) {
    const info = entry && entry.info && typeof entry.info === "object" ? entry.info : {};
    const parts = Array.isArray(entry && entry.parts) ? entry.parts : [];
    const role = String(info.role || "");
    if (role === "user") {
      const rawTexts = parts
        .filter((part) => part && part.type === "text")
        .map((part) => String(part.text || ""));
      // A stored background-report wake renders as a report row, never as the
      // user's own words.
      const bgPart = rawTexts.find((partText) =>
        partText.startsWith(OPEN_FUSION_BACKGROUND_MARKER)
      );
      if (bgPart) {
        const parsed = parseOpenFusionBackgroundReport(bgPart);
        events.push({
          type: "user",
          text: parsed.text,
          backgroundReport: true,
          taskId: parsed.taskId,
          title: parsed.title
        });
        continue;
      }
      const text = rawTexts
        // The host appends a marked gate-reminder part to every Brain turn;
        // a resumed transcript must not render it as the user's own words.
        .filter((partText) => !partText.startsWith(OPEN_FUSION_GATE_MARKER))
        .join("\n")
        .trim();
      if (text) events.push({ type: "user", text });
      continue;
    }
    if (role !== "assistant") continue;
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && String(part.text || "").trim()) {
        events.push({
          type: "assistant-text",
          role: "brain",
          delta: String(part.text),
          streamId: `${String(rootSessionId || "")}:${String(part.id || "")}`
        });
      } else if (part.type === "tool") {
        const state = part.state && typeof part.state === "object" ? part.state : {};
        const callID = String(part.callID || part.id || "");
        const name = String(part.tool || "tool");
        const metadata = state.metadata && typeof state.metadata === "object" ? state.metadata : {};
        const childSessionId = name === "task" && metadata.sessionId ? String(metadata.sessionId) : "";
        events.push({
          type: "tool-call",
          toolId: callID,
          name,
          role: "brain",
          childSessionId: childSessionId || undefined,
          title: String(state.title || ""),
          input: state.input && typeof state.input === "object" ? state.input : {}
        });
        if (state.status === "completed" || state.status === "error") {
          events.push({
            type: "tool-result",
            toolId: callID,
            name,
            role: "brain",
            ok: state.status === "completed",
            title: String(state.title || ""),
            text: clipText(state.status === "completed" ? state.output : state.error || state.output),
            meta: toolMeta(metadata),
            childSessionId: childSessionId || undefined
          });
        }
      }
    }
  }
  return events;
}

// Strip GET /provider/auth to the JSON-safe method metadata the pane renders:
// method type/label plus prompt fields (text/select) a method needs up front.
// Mirrors what OpenCode's own connect dialog consumes.
function normalizeAuthMethods(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result = {};
  for (const [providerId, methods] of Object.entries(raw)) {
    if (!Array.isArray(methods)) continue;
    const cleaned = [];
    for (const method of methods) {
      if (!method || typeof method !== "object") continue;
      const type = method.type === "oauth" ? "oauth" : method.type === "api" ? "api" : null;
      if (!type) continue;
      const prompts = [];
      for (const prompt of Array.isArray(method.prompts) ? method.prompts : []) {
        if (!prompt || typeof prompt !== "object" || !prompt.key) continue;
        const promptType = prompt.type === "select" ? "select" : "text";
        prompts.push({
          type: promptType,
          key: String(prompt.key),
          message: String(prompt.message || prompt.key),
          ...(prompt.placeholder ? { placeholder: String(prompt.placeholder) } : {}),
          ...(promptType === "select" && Array.isArray(prompt.options)
            ? {
                options: prompt.options
                  .filter((option) => option && typeof option === "object")
                  .map((option) => ({
                    label: String(option.label ?? option.value ?? ""),
                    value: String(option.value ?? ""),
                    ...(option.hint ? { hint: String(option.hint) } : {})
                  }))
              }
            : {})
        });
      }
      cleaned.push({
        type,
        label: String(method.label || (type === "api" ? "API key" : "OAuth login")),
        ...(prompts.length ? { prompts } : {})
      });
    }
    if (cleaned.length) result[String(providerId)] = cleaned;
  }
  return result;
}

// ---- custom OpenAI-compatible providers ----
// The definition lives in the app-owned GLOBAL OpenCode config
// ($XDG_CONFIG_HOME/opencode/opencode.json — every pane points there), written
// by the pane's own server via PATCH /global/config. Live-verified against
// 1.17.11: the PATCH re-reads the file, merges the body, writes the result
// back, and refreshes the running instance in place — no dispose, no pane
// restart. An EMPTY {} patch performs the same file re-read, which is the
// reload nudge other panes need for changes they didn't make themselves
// (dispose alone does NOT re-read config files while OPENCODE_CONFIG_CONTENT
// is set). A config-defined provider counts as connected even with no stored
// key (source:"config" on /config/providers), which is exactly right for
// keyless local endpoints (LM Studio, llama.cpp).
const CUSTOM_PROVIDER_NPM = "@ai-sdk/openai-compatible";
const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CUSTOM_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,95}$/;
const MAX_CUSTOM_PROVIDER_MODELS = 32;
const MIN_CUSTOM_MODEL_CONTEXT = 1_024;
const MAX_CUSTOM_MODEL_CONTEXT = 100_000_000;
// opencode's per-response cap when a model's output limit is unknown
// (maxOutputTokens = min(limit.output, 32000) || 32000, verified 1.17.11).
const OPENCODE_DEFAULT_OUTPUT_TOKENS = 32_000;

function cleanDisplayName(value, max = 64) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// Validate + shape a custom-provider definition into the PATCH /global/config
// body. Pure and exported so the smoke can lock the config shape without a
// server. Returns {ok:true, providerId, patch} or {ok:false, message}.
function buildCustomProviderPatch(payload) {
  const providerId = String(payload?.providerId || "").trim();
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(providerId)) {
    return { ok: false, message: "Provider id must be lowercase letters, numbers, '.', '_' or '-'." };
  }
  const name = cleanDisplayName(payload?.name);
  if (!name) {
    return { ok: false, message: "Provide a display name for the provider." };
  }
  let baseURL;
  try {
    baseURL = new URL(String(payload?.baseURL || "").trim());
  } catch {
    return { ok: false, message: "Provide a valid base URL (e.g. https://api.example.com/v1)." };
  }
  if ((baseURL.protocol !== "https:" && baseURL.protocol !== "http:") || baseURL.href.length > 200) {
    return { ok: false, message: "The base URL must be http(s) and at most 200 characters." };
  }
  const rawModels = Array.isArray(payload?.models) ? payload.models : [];
  const models = {};
  for (const entry of rawModels.slice(0, MAX_CUSTOM_PROVIDER_MODELS)) {
    const modelId = String(entry?.id || "").trim();
    if (!CUSTOM_MODEL_ID_PATTERN.test(modelId)) {
      return { ok: false, message: `Model id '${clipText(modelId, 60)}' is not a valid model id.` };
    }
    const model = { name: cleanDisplayName(entry?.name) || modelId };
    const contextLimit = entry?.contextLimit;
    if (contextLimit !== undefined && contextLimit !== null && contextLimit !== 0) {
      if (
        !Number.isInteger(contextLimit) ||
        contextLimit < MIN_CUSTOM_MODEL_CONTEXT ||
        contextLimit > MAX_CUSTOM_MODEL_CONTEXT
      ) {
        return {
          ok: false,
          message: `Context window for '${clipText(modelId, 60)}' must be an integer between ${MIN_CUSTOM_MODEL_CONTEXT} and ${MAX_CUSTOM_MODEL_CONTEXT} tokens.`
        };
      }
      // A known context with an unknown output limit is a live trap: opencode's
      // compaction threshold is context − 32000 (its unknown-output default),
      // which clamps to 0 for models smaller than 32k and would re-compact on
      // every step. Deriving a conservative output cap keeps the threshold
      // sane AND keeps maxOutputTokens below the model's real window.
      model.limit = {
        context: contextLimit,
        output: Math.max(
          256,
          Math.min(OPENCODE_DEFAULT_OUTPUT_TOKENS, Math.floor(contextLimit / 4))
        )
      };
    }
    models[modelId] = model;
  }
  if (!Object.keys(models).length) {
    return { ok: false, message: "Add at least one model id." };
  }
  return {
    ok: true,
    providerId,
    patch: {
      provider: {
        [providerId]: {
          npm: CUSTOM_PROVIDER_NPM,
          name,
          options: { baseURL: baseURL.href },
          models
        }
      }
    }
  };
}

function buildServeSpawn(extraEnv, cwd, password) {
  const args = ["serve", "--port", "0", "--hostname", "127.0.0.1"];
  const env = {
    ...process.env,
    ...extraEnv,
    OPENCODE_SERVER_PASSWORD: password
  };
  if (isWin) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", [OPENCODE_BIN, ...args].map(windowsCmdArg).join(" ")],
      options: { cwd: cwd || undefined, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    };
  }
  return {
    command: OPENCODE_BIN,
    args,
    options: { cwd: cwd || undefined, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  };
}

function backgroundStatusFileForEnv(extraEnv, explicitPath = "") {
  const explicit = String(explicitPath || "").trim();
  if (explicit) return explicit;
  const configured = String(extraEnv?.VIBE_TERMINAL_BG_STATUS_FILE || "").trim();
  if (configured) return configured;
  const paneDir = String(extraEnv?.VIBE_TERMINAL_OPEN_FUSION_DIR || "").trim();
  return paneDir ? path.join(paneDir, "background-status.json") : "";
}

function withBackgroundStatusEnv(extraEnv, statusFile) {
  const env = { ...(extraEnv && typeof extraEnv === "object" ? extraEnv : {}) };
  if (!statusFile) return env;
  env.VIBE_TERMINAL_BG_STATUS_FILE = statusFile;
  try {
    const config = JSON.parse(String(env.OPENCODE_CONFIG_CONTENT || ""));
    const bridge = config?.mcp?.vibeterminal;
    if (bridge && typeof bridge === "object") {
      bridge.environment = {
        ...(bridge.environment && typeof bridge.environment === "object"
          ? bridge.environment
          : {}),
        VIBE_TERMINAL_BG_STATUS_FILE: statusFile
      };
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
    }
  } catch {
    // The inherited env still reaches the local MCP child; malformed config
    // remains OpenCode's own startup error rather than a host-loop failure.
  }
  return env;
}

function writeBackgroundStatusSnapshotFile(statusFile, snapshot) {
  const file = String(statusFile || "").trim();
  if (!file) return false;
  let tempFile = "";
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tempFile = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(snapshot, null, 2)}\n`);
    fs.renameSync(tempFile, file);
    return true;
  } catch (error) {
    try {
      process.stderr.write(`[openfusion-host] background status write failed: ${error?.message || error}\n`);
    } catch {
      // ignore logging failures
    }
    return false;
  } finally {
    if (tempFile) {
      try {
        fs.rmSync(tempFile, { force: true });
      } catch {
        // ignore cleanup failures
      }
    }
  }
}

// ---- the host (only runs when executed as a process, not when required) ----
function runHost() {
  const sessions = new Map(); // paneId -> state

  function emit(obj) {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  function killChild(child) {
    if (!child || child.killed) return;
    if (isWin && child.pid) {
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        return;
      } catch {
        // fall through
      }
    }
    try {
      child.kill();
    } catch {
      // ignore
    }
  }

  function cloneEvent(event) {
    try {
      return JSON.parse(JSON.stringify(event));
    } catch {
      return event;
    }
  }

  function emitSessionEvent(id, state, event) {
    state.history.push(cloneEvent(event));
    if (state.history.length > MAX_HISTORY_EVENTS) {
      state.history.splice(0, state.history.length - MAX_HISTORY_EVENTS);
    }
    emit({ type: "event", id, event });
  }

  function emitDirectSessionEvent(id, event) {
    if (id) emit({ type: "event", id, event });
  }

  function replaySession(id, state) {
    // Reattach replay is a transcript restore, not fresh activity: the flag
    // lets the renderer rebuild the pane without re-latching status or
    // re-marking the attention dot for turns the user already acknowledged.
    for (const event of state.history) {
      emit({ type: "event", id, event: { ...event, replay: true } });
    }
  }

  function authHeader(state) {
    return `Basic ${Buffer.from(`opencode:${state.password}`).toString("base64")}`;
  }

  function request(state, method, path, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: state.port,
          path,
          method,
          timeout: timeoutMs || 30_000,
          headers: {
            authorization: authHeader(state),
            "content-type": "application/json",
            ...(payload ? { "content-length": Buffer.byteLength(payload) } : {})
          }
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += chunk.toString("utf8");
          });
          response.on("end", () => {
            if (response.statusCode && response.statusCode >= 400) {
              reject(new Error(`${method} ${path} → HTTP ${response.statusCode}: ${text.slice(0, 300)}`));
              return;
            }
            if (!text.trim()) {
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(text));
            } catch {
              resolve(text);
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error(`${method} ${path} timed out`));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  function emitSteerRoutingNote(id, state, text) {
    if (!text) return;
    emitSessionEvent(id, state, {
      type: "steer-route",
      message: text
    });
  }

  function clearSteerRoutingState(state) {
    if (!state) return;
    const tasks = getActiveExecutorTaskMap(state);
    if (tasks) tasks.clear();
    state.routerSessionId = null;
    state.steerRouting = false;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function ensureRouterSession(state) {
    if (state.routerSessionId) return state.routerSessionId;
    const created = await request(state, "POST", "/session", { title: "(fusion steer router)" });
    if (!created || !created.id) {
      throw new Error("OpenCode did not return a router session id");
    }
    state.routerSessionId = String(created.id);
    return state.routerSessionId;
  }

  async function readRouterAssistantText(state, routerSessionId, previousAssistantCount) {
    const deadline = Date.now() + STEER_ROUTER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const messages = await request(
        state,
        "GET",
        `/session/${encodeURIComponent(routerSessionId)}/message`,
        undefined,
        Math.min(5_000, STEER_ROUTER_TIMEOUT_MS)
      );
      const assistantTexts = extractOpenFusionAssistantTexts(messages);
      if (assistantTexts.length > previousAssistantCount) {
        return assistantTexts[assistantTexts.length - 1];
      }
      await delay(STEER_ROUTER_POLL_MS);
    }
    throw new Error("router decision timed out");
  }

  async function runSteerDecision(id, state, steerText) {
    const fallback = (reason) => ({
      action: "inject",
      text: String(steerText || "").trim(),
      reason,
      fallback: true
    });
    const snapshot = openFusionExecutorSnapshot(state);
    const prompt = buildOpenFusionSteerDecisionPrompt(steerText, snapshot);
    const model = splitModelId(state.plannerModel);
    if (!model) return fallback("planner_model_missing");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const routerSessionId = await ensureRouterSession(state);
        const beforeMessages = await request(
          state,
          "GET",
          `/session/${encodeURIComponent(routerSessionId)}/message`
        ).catch((error) => {
          if (/HTTP 404/i.test(String(error && error.message))) throw error;
          return [];
        });
        const previousAssistantCount = extractOpenFusionAssistantTexts(beforeMessages).length;
        await request(state, "POST", `/session/${encodeURIComponent(routerSessionId)}/prompt_async`, {
          agent: "planner",
          parts: [{ type: "text", text: prompt }],
          model
        });
        const assistantText = await readRouterAssistantText(state, routerSessionId, previousAssistantCount);
        const decision = parseOpenFusionSteerDecision(assistantText, steerText);
        if (decision.fallback) {
          emitSteerRoutingNote(id, state, `router reply was invalid; injecting steer directly (${decision.reason})`);
        }
        return decision;
      } catch (error) {
        if (/HTTP 404/i.test(String(error && error.message)) && state.routerSessionId && attempt === 0) {
          state.routerSessionId = null;
          continue;
        }
        emitSteerRoutingNote(
          id,
          state,
          `router decision failed; injecting steer directly (${error?.message || error})`
        );
        return fallback(error?.message || "router_decision_failed");
      }
    }
    return fallback("router_session_recreate_failed");
  }

  // ---- detached background delegations (host side) ----

  function writeBackgroundStatusFile(id, state) {
    const statusFile = String(state?.backgroundStatusFile || "").trim();
    if (!statusFile) return;
    const now = Date.now();
    const tasks = Array.from(state.backgroundTasks.values())
      .filter((task) => !task.settled)
      .map((task) => ({
        taskId: task.taskId,
        title: task.title,
        state: task.cancelled ? "cancelling" : task.running ? "running" : "starting",
        startedAt: task.startedAt,
        elapsedMs: Math.max(0, now - task.startedAt),
        updates: task.updates,
        files: Array.from(task.files).slice(0, 64),
        recentActivity: Array.isArray(task.recentActivity)
          ? task.recentActivity.slice(-BACKGROUND_STATUS_MAX_ACTIVITY)
          : []
      }));
    writeBackgroundStatusSnapshotFile(statusFile, {
      updatedAt: now,
      tasks,
      settled: Array.isArray(state.backgroundSettled)
        ? state.backgroundSettled.slice(0, BACKGROUND_STATUS_MAX_SETTLED)
        : []
    });
  }

  function clearBackgroundTaskTimers(task) {
    if (task.idleTimer) {
      clearTimeout(task.idleTimer);
      task.idleTimer = null;
    }
    if (task.hardTimer) {
      clearTimeout(task.hardTimer);
      task.hardTimer = null;
    }
  }

  function abortOpenFusionBackgroundSession(state, childSessionId) {
    const sessionId = String(childSessionId || "").trim();
    if (!sessionId) return;
    request(state, "POST", `/session/${encodeURIComponent(sessionId)}/abort`).catch(() => {});
  }

  function refreshBackgroundIdleTimer(id, state, task) {
    if (task.settled) return;
    if (task.idleTimer) clearTimeout(task.idleTimer);
    task.idleTimer = setTimeout(() => {
      if (sessions.get(id) !== state) return;
      settleBackgroundTask(id, state, task, {
        status: "failed",
        error: "Open Fusion background task stalled."
      });
    }, BACKGROUND_IDLE_TIMEOUT_MS);
    task.idleTimer.unref?.();
  }

  function settleBackgroundTask(id, state, task, result, options = {}) {
    if (task.settled) return;
    const settledAt = Date.now();
    task.settled = true;
    clearBackgroundTaskTimers(task);
    state.backgroundTasks.delete(task.taskId);
    if (task.childSessionId) state.backgroundBySession.delete(task.childSessionId);
    const settledEvent = {
      type: "background-task",
      phase: "settled",
      taskId: task.taskId,
      title: task.title,
      kind: "task",
      cancelled: task.cancelled === true || result.cancelled === true,
      updates: task.updates,
      durationMs: settledAt - task.startedAt,
      result:
        result.status === "completed"
          ? {
              status: "completed",
              report: clipText(result.report || "", BACKGROUND_REPORT_MAX_CHARS),
              files: Array.isArray(result.files) ? result.files.slice(0, 64) : []
            }
          : { status: "failed", error: clipText(result.error || "background task failed", 2_000) }
    };
    state.backgroundSettled.unshift({
      taskId: task.taskId,
      title: task.title,
      status: settledEvent.result.status,
      cancelled: settledEvent.cancelled,
      startedAt: task.startedAt,
      durationMs: settledEvent.durationMs,
      elapsedMs: settledEvent.durationMs,
      settledAt,
      updates: task.updates,
      files: Array.from(
        new Set([
          ...task.files,
          ...(Array.isArray(settledEvent.result.files) ? settledEvent.result.files : [])
        ])
      ).slice(0, 64),
      recentActivity: task.recentActivity.slice(-BACKGROUND_STATUS_MAX_ACTIVITY),
      result: settledEvent.result
    });
    if (state.backgroundSettled.length > BACKGROUND_STATUS_MAX_SETTLED) {
      state.backgroundSettled.length = BACKGROUND_STATUS_MAX_SETTLED;
    }
    writeBackgroundStatusFile(id, state);
    emitSessionEvent(id, state, settledEvent);
    // Engine-death settles have nobody to wake (the serve is gone with the
    // work); the row settle above is the whole story.
    if (options.wake !== false) {
      queueOpenFusionWake(id, state, settledEvent);
    }
  }

  function settleAllBackgroundTasks(id, state, reason) {
    if (!state.backgroundTasks || state.backgroundTasks.size === 0) return;
    for (const task of Array.from(state.backgroundTasks.values())) {
      settleBackgroundTask(id, state, task, { status: "failed", error: reason }, { wake: false });
    }
  }

  function queueOpenFusionWake(id, state, settledEvent) {
    const result =
      settledEvent.result && typeof settledEvent.result === "object" ? settledEvent.result : {};
    const wake = {
      taskId: settledEvent.taskId,
      title: settledEvent.title || "background task",
      text: buildOpenFusionBackgroundWakeText(settledEvent),
      echoText: `Background task report — ${settledEvent.title || settledEvent.taskId}`
    };
    // Changed-file set on the echo arms the completion-gate latch for the
    // review turn — completed tasks only (failed/cancelled present no work).
    if (!settledEvent.cancelled && result.status === "completed") {
      wake.files = Array.isArray(result.files) ? result.files : [];
    }
    state.pendingWakes.push(wake);
    maybeFlushOpenFusionWakes(id, state);
  }

  function maybeFlushOpenFusionWakes(id, state) {
    if (state.turnBusy) return;
    if (!state.child || !state.port || !state.sessionId) return;
    if (!Array.isArray(state.pendingWakes) || state.pendingWakes.length === 0) return;
    // One wake at a time: the delivered wake's own turn must settle before
    // the next queued report opens a turn.
    const wake = state.pendingWakes.shift();
    deliverOpenFusionWake(id, state, wake);
  }

  function deliverOpenFusionWake(id, state, wake) {
    const model = splitModelId(state.plannerModel);
    if (!model) {
      emitSessionEvent(id, state, {
        type: "error",
        message: `Background task "${wake.title}" finished, but no Brain model is set — its report could not be delivered. Pick one with /brain-model.`
      });
      return;
    }
    const echo = {
      type: "user",
      text: wake.echoText,
      backgroundReport: true,
      taskId: wake.taskId,
      title: wake.title
    };
    if (Array.isArray(wake.files)) echo.files = wake.files;
    // Host-emitted echo — route it through the gate explicitly (only the
    // normalizer loop is gate-observed by default).
    emitSessionEvent(id, state, state.gate ? state.gate.observe(echo) : echo);
    // Hold the queue until this wake's turn settles; the normalizer's
    // turn-start re-asserts this as soon as the server goes busy.
    state.turnBusy = true;
    request(state, "POST", `/session/${encodeURIComponent(state.sessionId)}/prompt_async`, {
      agent: "planner",
      parts: buildPlannerTurnParts(wake.text, "auto", { nudge: false }),
      model
    }).catch((error) => {
      if (sessions.get(id) !== state) return;
      state.turnBusy = false;
      emitSessionEvent(id, state, {
        type: "error",
        message: `Could not deliver the background task report: ${error.message || error}`
      });
    });
  }

  async function startOpenFusionBackgroundTask(id, state, taskId, description, prompt) {
    if (state.backgroundTasks.has(taskId)) return;
    const title = backgroundTaskTitleOf(description, prompt);
    const task = {
      taskId,
      title,
      prompt: clipText(String(prompt || ""), 8_000),
      childSessionId: "",
      updates: 0,
      startedAt: Date.now(),
      settled: false,
      cancelled: false,
      running: false,
      files: new Set(),
      recentActivity: [],
      seenCalls: new Set(),
      idleTimer: null,
      hardTimer: null
    };
    state.backgroundTasks.set(taskId, task);
    writeBackgroundStatusFile(id, state);
    emitSessionEvent(id, state, {
      type: "background-task",
      phase: "started",
      taskId,
      title,
      kind: "task",
      task: task.prompt
    });
    const fail = (message) =>
      settleBackgroundTask(id, state, task, { status: "failed", error: message });
    if (!state.child || !state.port) {
      fail("Open Fusion engine is not ready.");
      return;
    }
    if (!state.backgroundAgent) {
      fail("Background tasks need a pane restart to load the background executor agent.");
      return;
    }
    const model = splitModelId(state.executorModel);
    if (!model) {
      fail("No Executor model is set. Pick one with /executor-model, then retry.");
      return;
    }
    if (state.backgroundTasks.size > BACKGROUND_MAX_TASKS) {
      fail(`At most ${BACKGROUND_MAX_TASKS} background tasks may run at once; wait for one to settle or cancel one.`);
      return;
    }
    if (!String(prompt || "").trim()) {
      fail("The background task had an empty prompt.");
      return;
    }
    task.hardTimer = setTimeout(() => {
      if (sessions.get(id) !== state) return;
      abortOpenFusionBackgroundSession(state, task.childSessionId);
      settleBackgroundTask(id, state, task, {
        status: "failed",
        error: "Open Fusion background task exceeded the maximum duration."
      });
    }, BACKGROUND_HARD_TIMEOUT_MS);
    task.hardTimer.unref?.();
    refreshBackgroundIdleTimer(id, state, task);
    try {
      const created = await request(state, "POST", "/session", {
        title: `(fusion background) ${title}`
      });
      if (!created || !created.id) {
        throw new Error("OpenCode did not return a background session id");
      }
      if (sessions.get(id) !== state || task.settled) {
        abortOpenFusionBackgroundSession(state, created.id);
        return;
      }
      task.childSessionId = String(created.id);
      state.backgroundBySession.set(task.childSessionId, task);
      await request(
        state,
        "POST",
        `/session/${encodeURIComponent(task.childSessionId)}/prompt_async`,
        {
          agent: "executor-bg",
          parts: [{ type: "text", text: buildOpenFusionBackgroundContract(prompt) }],
          model
        }
      );
    } catch (error) {
      if (sessions.get(id) !== state) return;
      settleBackgroundTask(id, state, task, {
        status: "failed",
        error: `Could not start the background executor: ${error.message || error}`
      });
    }
  }

  async function finishOpenFusionBackgroundTask(id, state, task) {
    if (task.settled) return;
    try {
      const messages = await request(
        state,
        "GET",
        `/session/${encodeURIComponent(task.childSessionId)}/message`
      );
      if (sessions.get(id) !== state || task.settled) return;
      const texts = extractOpenFusionAssistantTexts(messages);
      const report = texts.length ? texts[texts.length - 1] : "";
      if (task.cancelled) {
        settleBackgroundTask(id, state, task, {
          status: "failed",
          error: "Background task cancelled.",
          cancelled: true
        });
        return;
      }
      settleBackgroundTask(id, state, task, {
        status: "completed",
        report: report || "(no report returned)",
        files: Array.from(task.files)
      });
    } catch (error) {
      if (sessions.get(id) !== state) return;
      settleBackgroundTask(id, state, task, {
        status: "failed",
        error: `Could not read the background report: ${error.message || error}`
      });
    }
  }

  function cancelOpenFusionBackgroundTask(id, state, taskId) {
    const task = state.backgroundTasks.get(String(taskId || "").trim());
    if (!task || task.settled) return;
    task.cancelled = true;
    writeBackgroundStatusFile(id, state);
    if (!task.childSessionId) {
      settleBackgroundTask(id, state, task, {
        status: "failed",
        error: "Background task cancelled.",
        cancelled: true
      });
      return;
    }
    abortOpenFusionBackgroundSession(state, task.childSessionId);
    // Belt: an abort whose error/idle never lands on the feed must still settle.
    const forceTimer = setTimeout(() => {
      if (sessions.get(id) === state && !task.settled) {
        settleBackgroundTask(id, state, task, {
          status: "failed",
          error: "Background task cancelled.",
          cancelled: true
        });
      }
    }, 10_000);
    forceTimer.unref?.();
  }

  // Raw-SSE watcher for background children: they are host-created sessions,
  // deliberately OUTSIDE the normalizer tree, so their lifecycle is tracked
  // here (pre-normalizer) and surfaced only through background-task events.
  function observeBackgroundSseEvent(id, state, raw) {
    if (!state.backgroundBySession || state.backgroundBySession.size === 0) return;
    const type = String(raw?.type || "");
    const props = raw?.properties && typeof raw.properties === "object" ? raw.properties : {};
    const sessionID = String(props.sessionID || "");
    const task = sessionID ? state.backgroundBySession.get(sessionID) : null;
    if (!task || task.settled) return;
    refreshBackgroundIdleTimer(id, state, task);
    if (type === "session.status") {
      if (String((props.status && props.status.type) || "") === "busy") {
        task.running = true;
        writeBackgroundStatusFile(id, state);
      }
      return;
    }
    if (type === "session.idle") {
      if (!task.running) return;
      void finishOpenFusionBackgroundTask(id, state, task);
      return;
    }
    if (type === "session.error") {
      const error = props.error && typeof props.error === "object" ? props.error : {};
      const data = error.data && typeof error.data === "object" ? error.data : {};
      const message = String(data.message || error.name || "background executor error");
      if (/abort/i.test(String(error.name || "")) || /abort/i.test(message)) {
        settleBackgroundTask(id, state, task, {
          status: "failed",
          error: "Background task cancelled.",
          cancelled: true
        });
        return;
      }
      settleBackgroundTask(id, state, task, { status: "failed", error: message });
      return;
    }
    if (type !== "message.part.updated") return;
    const part = props.part && typeof props.part === "object" ? props.part : {};
    if (String(part.type || "") !== "tool") return;
    const st = part.state && typeof part.state === "object" ? part.state : {};
    const status = String(st.status || "");
    if (status !== "completed" && status !== "error") return;
    const callID = String(part.callID || part.id || "");
    if (callID) {
      if (task.seenCalls.has(callID)) return;
      task.seenCalls.add(callID);
      if (task.seenCalls.size > 512) {
        const oldest = task.seenCalls.values().next().value;
        task.seenCalls.delete(oldest);
      }
    }
    const name = String(part.tool || "tool");
    const input = st.input && typeof st.input === "object" ? st.input : {};
    const filePath = String(input.filePath || input.file_path || input.path || "");
    if ((name === "edit" || name === "write") && filePath) {
      task.files.add(filePath);
    }
    task.updates += 1;
    const detail =
      name === "bash" && input.command
        ? `$ ${compactWhitespace(input.command, 160)}`
        : `${name} ${compactWhitespace(st.title || filePath || input.pattern || "", 160)}`.trim();
    const activityKind =
      name === "bash" ? "command" : name === "edit" || name === "write" ? "file" : "activity";
    task.recentActivity.push({ ts: Date.now(), kind: activityKind, text: detail });
    if (task.recentActivity.length > BACKGROUND_STATUS_MAX_ACTIVITY) {
      task.recentActivity.splice(
        0,
        task.recentActivity.length - BACKGROUND_STATUS_MAX_ACTIVITY
      );
    }
    writeBackgroundStatusFile(id, state);
    emitDirectSessionEvent(id, {
      type: "background-task",
      phase: "progress",
      taskId: task.taskId,
      activityKind,
      text: detail,
      updates: task.updates
    });
  }

  function backgroundRequest(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    if (!state) return;
    const taskId = String(payload?.taskId || "").trim();
    if (!taskId) return;
    if (String(payload?.action || "start") === "cancel") {
      cancelOpenFusionBackgroundTask(id, state, taskId);
      return;
    }
    void startOpenFusionBackgroundTask(
      id,
      state,
      taskId,
      String(payload?.description || ""),
      String(payload?.prompt || "")
    );
  }

  function observeOpenFusionTaskEvent(state, event) {
    if (!event || typeof event !== "object") return;
    const activityTask = getActiveExecutorTaskBySession(state, event.sessionID);
    if (activityTask) {
      const line = summarizeOpenFusionExecutorActivity(event);
      if (line) {
        activityTask.activity = [
          ...(Array.isArray(activityTask.activity) ? activityTask.activity : []),
          line
        ].slice(-12);
      }
    }
    if (
      (event.type === "tool-call" || event.type === "task-child") &&
      event.name === "task" &&
      event.role === "brain" &&
      event.childSessionId
    ) {
      const input = event.input && typeof event.input === "object" ? event.input : {};
      const agent = String(event.agent || input.subagent_type || "executor");
      if (agent === "executor") {
        const childSessionId = String(event.childSessionId);
        const tasks = getActiveExecutorTaskMap(state);
        const existing = tasks.get(childSessionId);
        const now = Date.now();
        tasks.set(childSessionId, {
          ...(existing || {}),
          toolId: String(event.toolId || ""),
          childSessionId,
          taskPrompt: String(input.prompt || input.description || event.title || "").trim(),
          activity: Array.isArray(existing?.activity) ? existing.activity : [],
          startedAt: existing?.startedAt || now
        });
      }
      return;
    }
    if (
      event.type === "tool-result" &&
      event.name === "task" &&
      state.activeExecutorTasks &&
      typeof state.activeExecutorTasks.entries === "function"
    ) {
      for (const [childSessionId, task] of state.activeExecutorTasks.entries()) {
        if (String(task?.toolId || "") === String(event.toolId || "")) {
          state.activeExecutorTasks.delete(childSessionId);
          break;
        }
      }
    }
    if (event.type === "result" || event.type === "interrupted" || event.type === "error") {
      const tasks = getActiveExecutorTaskMap(state);
      if (tasks) tasks.clear();
    }
  }

  function pushQueuedSteerToActiveExecutor(id, state, text, targetTask = null) {
    const task = targetTask || getPrimaryActiveExecutorTask(state);
    if (!task || !task.childSessionId) return false;
    const steerRequest = buildExecutorSteerPromptRequest(
      task.childSessionId,
      state.executorModel,
      text
    );
    if (!steerRequest) return false;
    request(state, "POST", steerRequest.path, steerRequest.body).catch((error) => {
      if (sessions.get(id) !== state) return;
      emitSessionEvent(id, state, {
        type: "stderr",
        text: `Open Fusion live executor steering failed: ${error.message || error}\n`
      });
    });
    return true;
  }

  function preserveSteerViaExecutorOrRoot(id, state, text, targetTask = null) {
    if (pushQueuedSteerToActiveExecutor(id, state, text, targetTask)) return;
    const rootPrompt = buildPlannerPromptRequest(state.sessionId, state.plannerModel, text, "auto");
    if (!rootPrompt) {
      emitSteerRoutingNote(id, state, "could not preserve steer: no executor child or root planner prompt target");
      return;
    }
    emitSteerRoutingNote(id, state, "executor child unavailable; preserving steer on the root planner");
    request(state, "POST", rootPrompt.path, rootPrompt.body).catch((error) => {
      emitSteerRoutingNote(id, state, `root planner steer preservation failed (${error?.message || error})`);
    });
  }

  async function routeSteerToPlanner(id, state, steerText) {
    if (!shouldRouteOpenFusionSteer(state, steerText)) return false;
    if (state.steerRouting) {
      emitSteerRoutingNote(id, state, "another steer is already routing; injecting this one directly");
      preserveSteerViaExecutorOrRoot(id, state, steerText);
      return true;
    }

    state.steerRouting = true;
    emitSteerRoutingNote(id, state, "routing live steer to planner decision pass");
    try {
      const snapshot = openFusionExecutorSnapshot(state);
      const decision = await runSteerDecision(id, state, steerText);
      const action = decision.action || "inject";
      const decisionText = String(decision.text || steerText || "").trim();
      const task = selectOpenFusionExecutorTask(state, decision.childSessionId);
      const childSessionId = task && task.childSessionId ? String(task.childSessionId) : "";

      if (action === "ignore") {
        emitSteerRoutingNote(id, state, `planner ignored steer${decision.reason ? `: ${decision.reason}` : ""}`);
        return true;
      }

      if (action === "replan") {
        if (!childSessionId || !state.sessionId) {
          emitSteerRoutingNote(id, state, "planner chose replan but task state vanished; injecting steer directly");
          preserveSteerViaExecutorOrRoot(id, state, decisionText || steerText, task);
          return true;
        }
        emitSteerRoutingNote(id, state, "planner chose replan; aborting executor task and queueing amended planner prompt");
        await request(state, "POST", `/session/${encodeURIComponent(childSessionId)}/abort`).catch((error) => {
          emitSteerRoutingNote(id, state, `executor task abort failed; continuing with amended root prompt (${error?.message || error})`);
        });
        const replanPrompt = buildOpenFusionReplanPrompt(steerText, decisionText, snapshot);
        const rootPrompt = buildPlannerPromptRequest(state.sessionId, state.plannerModel, replanPrompt, "auto");
        if (!rootPrompt) {
          emitSteerRoutingNote(id, state, "could not build amended planner prompt; injecting steer directly");
          preserveSteerViaExecutorOrRoot(id, state, decisionText || steerText, task);
          return true;
        }
        await request(state, "POST", rootPrompt.path, rootPrompt.body);
        const tasks = getActiveExecutorTaskMap(state);
        if (tasks && childSessionId) tasks.delete(childSessionId);
        return true;
      }

      emitSteerRoutingNote(id, state, decision.fallback ? "injecting steer directly after router fallback" : "planner chose inject");
      preserveSteerViaExecutorOrRoot(id, state, decisionText || steerText, task);
      return true;
    } catch (error) {
      emitSteerRoutingNote(id, state, `routing failed; injecting steer directly (${error?.message || error})`);
      preserveSteerViaExecutorOrRoot(id, state, steerText);
      return true;
    } finally {
      state.steerRouting = false;
    }
  }

  function postRootPlannerInput(id, state, text, mode, model, queued) {
    ensureSession(id, state, text)
      .then(() => {
        if (sessions.get(id) !== state || !state.sessionId) return;
        // One-shot completion-gate nudge: only a fresh non-plan turn consumes
        // it (short-circuit order is load-bearing — a plan or queued send must
        // not burn the flag; it stays armed for the next qualifying turn).
        const nudge =
          mode !== "plan" && !queued && Boolean(state.gate && state.gate.consumeNudge());
        const body = {
          agent: mode === "plan" ? "plan" : "planner",
          parts: buildPlannerTurnParts(text, mode, { nudge }),
          model
        };
        return request(
          state,
          "POST",
          `/session/${encodeURIComponent(state.sessionId)}/prompt_async`,
          body
        );
      })
      .catch((error) => {
        if (sessions.get(id) !== state) return;
        emitSessionEvent(id, state, {
          type: "error",
          message: `Could not send the turn: ${error.message}`
        });
      });
  }

  function connectEvents(id, state) {
    // Generation guard: every (re)connect orphans the previous stream's
    // handlers so a deliberate reattach can never double-schedule reconnects.
    const generation = (state.sseGeneration = (state.sseGeneration || 0) + 1);
    const stale = () => sessions.get(id) !== state || state.sseGeneration !== generation;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: state.port,
        path: "/event",
        method: "GET",
        headers: { authorization: authHeader(state), accept: "text/event-stream" }
      },
      (response) => {
        if (stale()) {
          response.destroy();
          return;
        }
        state.sseRetries = 0;
        let buffer = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (stale()) {
            response.destroy();
            return;
          }
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line.startsWith("data: ")) continue;
            let parsed;
            try {
              parsed = JSON.parse(line.slice(6));
            } catch {
              continue;
            }
            // An instance dispose (auth/config change) kills the event bus this
            // stream is attached to; the connection stays open but goes silent
            // (live-verified). Reattach immediately to the lazily re-created
            // instance so the next turn's events keep flowing.
            if (parsed && parsed.type === "server.instance.disposed") {
              state.sseRetries = 0;
              connectEvents(id, state);
              response.destroy();
              return;
            }
            // Background children are host-created sessions outside the
            // normalizer tree; their lifecycle rides the raw feed.
            observeBackgroundSseEvent(id, state, parsed);
            if (!state.normalizer) continue;
            for (const event of state.normalizer(parsed)) {
              observeOpenFusionTaskEvent(state, event);
              // Track turn state so auth changes never dispose an instance
              // with a delegation in flight (dispose is safe for idle panes).
              if (event.type === "turn-start") state.turnBusy = true;
              else if (
                event.type === "result" ||
                event.type === "interrupted" ||
                event.type === "error"
              ) {
                state.turnBusy = false;
                // A settled root turn is the wake window for queued
                // background reports (never steered into a running turn).
                if (Array.isArray(state.pendingWakes) && state.pendingWakes.length) {
                  setImmediate(() => {
                    if (sessions.get(id) === state) maybeFlushOpenFusionWakes(id, state);
                  });
                }
              }
              // Completion-gate tracking sees ONLY live normalizer output —
              // rehydration and reattach replay bypass it by design. observe()
              // annotates clean `result` events with the gate verdict before
              // they reach history, so replays carry the chip for free.
              emitSessionEvent(id, state, state.gate ? state.gate.observe(event) : event);
            }
          }
        });
        response.on("end", () => {
          if (!stale()) scheduleSseReconnect(id, state);
        });
        response.on("error", () => {
          if (!stale()) scheduleSseReconnect(id, state);
        });
      }
    );
    req.on("error", () => {
      if (!stale()) scheduleSseReconnect(id, state);
    });
    req.end();
    state.sseRequest = req;
  }

  function scheduleSseReconnect(id, state) {
    if (sessions.get(id) !== state || state.stopping || !state.child) return;
    state.sseRetries = (state.sseRetries || 0) + 1;
    if (state.sseRetries > SSE_MAX_RETRIES) {
      emitSessionEvent(id, state, {
        type: "error",
        message: "Lost the OpenCode event stream. Restart the pane to continue."
      });
      return;
    }
    setTimeout(() => {
      if (sessions.get(id) === state && !state.stopping && state.child) {
        connectEvents(id, state);
      }
    }, SSE_RETRY_MS * state.sseRetries).unref?.();
  }

  async function establishSession(id, state, resumeId) {
    if (resumeId) {
      try {
        const existing = await request(state, "GET", `/session/${encodeURIComponent(resumeId)}`);
        if (existing && existing.id === resumeId) {
          state.sessionId = resumeId;
          state.normalizer = createOpenCodeEventNormalizer(resumeId);
          state.gate = createOpenFusionGateTracker({ cwd: state.cwd });
          connectEvents(id, state);
          emitSessionEvent(id, state, { type: "session", sessionId: resumeId, resumed: true });
          const messages = await request(state, "GET", `/session/${encodeURIComponent(resumeId)}/message`);
          for (const event of rehydrateMessages(messages, resumeId)) {
            emitSessionEvent(id, state, event);
          }
          // Close any bubble the renderer opened while replaying the restored
          // transcript (rehydrated turns are always complete).
          emitSessionEvent(id, state, { type: "result", subtype: "restored" });
          return;
        }
      } catch {
        // fall through to a fresh session; the renderer already confirmed the
        // id via thread discovery, but the server is the final authority.
      }
    }
    // Fresh pane: session creation is DEFERRED to the first input, which
    // titles the session from that prompt. Creating one here minted a ghost
    // "vibeTerminal Open Fusion" session on every pane start and app boot —
    // the resume picker drowned in identical-titled empty chats. The
    // engine-ready ping keeps the renderer's provider-catalog prefetch (which
    // used to ride the session event).
    emitSessionEvent(id, state, { type: "engine-ready" });
  }

  // Create the pane's session on demand — at the FIRST user input — titled
  // from that prompt (opencode never re-titles a session created with an
  // explicit title, so the create-time title is what the resume picker shows
  // forever). Serialized behind a promise so rapid sends cannot double-create.
  function ensureSession(id, state, firstPromptText) {
    if (state.sessionId) return Promise.resolve();
    if (!state.sessionPromise) {
      const title =
        String(firstPromptText || "").replace(/\s+/g, " ").trim().slice(0, 80) ||
        "vibeTerminal Open Fusion";
      state.sessionPromise = (async () => {
        const created = await request(state, "POST", "/session", { title });
        if (!created || !created.id) {
          throw new Error("OpenCode did not return a session id");
        }
        if (sessions.get(id) !== state) return;
        state.sessionId = String(created.id);
        state.normalizer = createOpenCodeEventNormalizer(state.sessionId);
        state.gate = createOpenFusionGateTracker({ cwd: state.cwd });
        connectEvents(id, state);
        emitSessionEvent(id, state, { type: "session", sessionId: state.sessionId });
      })().catch((error) => {
        // A failed create must not wedge the pane: the next send retries.
        state.sessionPromise = null;
        throw error;
      });
    }
    return state.sessionPromise;
  }

  function start(payload) {
    const { id, cwd, env, resumeId } = payload || {};
    if (!id) return;
    if (sessions.has(id)) {
      const existingState = sessions.get(id);
      if (existingState?.child) {
        existingState.plannerModel = String(payload.plannerModel || existingState.plannerModel || "");
        replaySession(id, existingState);
        return;
      }
      sessions.delete(id);
    }

    const password = crypto.randomBytes(24).toString("hex");
    const paneEnv = env && typeof env === "object" ? env : {};
    const backgroundStatusFile = backgroundStatusFileForEnv(
      paneEnv,
      payload.backgroundStatusPath
    );
    // Clear stale active state before OpenCode can spawn the bridge process.
    writeBackgroundStatusSnapshotFile(backgroundStatusFile, {
      updatedAt: Date.now(),
      tasks: [],
      settled: []
    });
    const launch = buildServeSpawn(
      withBackgroundStatusEnv(paneEnv, backgroundStatusFile),
      cwd,
      password
    );
    let child;
    try {
      child = spawn(launch.command, launch.args, launch.options);
    } catch (error) {
      emitDirectSessionEvent(id, { type: "error", message: `Could not launch OpenCode: ${error.message}` });
      emitDirectSessionEvent(id, { type: "closed", code: -1 });
      return;
    }

    const state = {
      child,
      password,
      port: 0,
      cwd: String(cwd || ""),
      sessionId: "",
      // In-flight lazy session creation (first input); see ensureSession.
      sessionPromise: null,
      normalizer: null,
      gate: null,
      sseRequest: null,
      sseRetries: 0,
      sseGeneration: 0,
      stopping: false,
      stdoutBuffer: "",
      turnBusy: false,
      activeExecutorTasks: new Map(),
      routerSessionId: null,
      steerRouting: false,
      history: [],
      plannerModel: String(payload.plannerModel || ""),
      executorModel: String(payload.executorModel || ""),
      // Detached background delegations: taskId → task, childSessionId → task,
      // plus report wakes queued while the root turn is busy.
      backgroundTasks: new Map(),
      backgroundBySession: new Map(),
      backgroundSettled: [],
      backgroundStatusFile,
      pendingWakes: [],
      // Capability flag from the start payload: the generated config this
      // serve loaded includes the plan agent. Deliberately NOT set on the
      // reattach path — reattached state keeps the flag of the start that
      // actually launched its serve.
      planAgent: payload.planAgent === true,
      // Same idea: the generated config carries the vibeterminal MCP bridge
      // and the executor-bg agent this feature needs.
      backgroundAgent: payload.backgroundAgent === true
    };
    sessions.set(id, state);
    writeBackgroundStatusFile(id, state);

    const portTimer = setTimeout(() => {
      if (sessions.get(id) !== state || state.port) return;
      emitSessionEvent(id, state, {
        type: "error",
        message: "OpenCode server did not report a port within 30s."
      });
      killChild(state.child);
    }, PORT_TIMEOUT_MS);
    portTimer.unref?.();

    child.stdout.on("data", (chunk) => {
      if (sessions.get(id) !== state) return;
      state.stdoutBuffer += chunk.toString("utf8");
      if (state.port) return;
      const match = state.stdoutBuffer.match(/listening on https?:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      state.port = Number(match[1]);
      clearTimeout(portTimer);
      establishSession(id, state, typeof resumeId === "string" && resumeId.trim() ? resumeId.trim() : "").catch(
        (error) => {
          if (sessions.get(id) !== state) return;
          emitSessionEvent(id, state, {
            type: "error",
            message: `Could not open an OpenCode session: ${error.message}`
          });
        }
      );
    });
    child.stderr.on("data", (chunk) => {
      if (sessions.get(id) !== state) return;
      const text = chunk.toString("utf8");
      // opencode serve logs INFO lines to stderr under --print-logs only; keep
      // real stderr visible in the Details lane.
      emitSessionEvent(id, state, { type: "stderr", text });
    });
    child.on("error", (error) => {
      if (sessions.get(id) !== state) return;
      emitSessionEvent(id, state, { type: "error", message: error.message });
    });
    child.on("exit", (code) => {
      if (sessions.get(id) !== state) return;
      state.child = null;
      clearSteerRoutingState(state);
      // The serve died with the background work; settle the rows (no wake —
      // there is nobody left to deliver a report to).
      settleAllBackgroundTasks(id, state, "Open Fusion engine closed while this background task was running.");
      try {
        state.sseRequest?.destroy();
      } catch {
        // ignore
      }
      emitSessionEvent(id, state, { type: "closed", code });
    });
  }

  function input(payload) {
    const id = payload?.id;
    const text = String(payload?.text ?? "");
    const state = sessions.get(id);
    if (!state) {
      emitDirectSessionEvent(id, {
        type: "error",
        message: "Open Fusion session is not running. Restart the pane to continue."
      });
      return;
    }
    // Ready = the serve reported its port. The session itself is created
    // lazily below — a fresh pane has none until its first send.
    if (!state.child || !state.port) {
      emitSessionEvent(id, state, {
        type: "error",
        message: "Open Fusion engine is not ready yet. Wait a moment and try again."
      });
      return;
    }

    const model = splitModelId(state.plannerModel);
    // No default models by design: without an explicit Brain pick, refuse the
    // turn instead of letting opencode silently choose a model. The pane gates
    // this in the UI; this is the backstop.
    if (!model) {
      emitSessionEvent(id, state, {
        type: "error",
        message: "No Brain model is set. Pick one with /brain-model (connect a provider first if the list is empty)."
      });
      return;
    }

    // Per-turn agent flip: mode rides the input payload so the send and the
    // agent choice are one atomic message — no set-mode plumbing to race.
    const mode = payload?.mode === "plan" ? "plan" : "auto";
    if (mode === "plan" && !state.planAgent) {
      emitSessionEvent(id, state, {
        type: "error",
        message:
          "Plan mode needs a pane restart to load the plan agent. Restart the pane, then try /plan again."
      });
      return;
    }

    // Mid-turn sends are legal steering: the server persists the message
    // immediately and the running loop absorbs it at its next step (verified
    // 1.17.11 `ensureRunning` semantics). Tag the echo so the pane can pin it
    // above the composer instead of burying it in the streaming transcript.
    // The echo's `mode` is ground truth for the pane's plan-accept arming: it
    // is emitted by the same call that chose the agent, so it stays correct
    // across mid-turn mode flips. NOTE: a message absorbed mid-turn runs under
    // the in-flight turn's agent regardless of this field.
    const queued = Boolean(state.turnBusy);
    emitSessionEvent(
      id,
      state,
      queued ? { type: "user", text, queued: true, mode } : { type: "user", text, mode }
    );
    if (queued && text.trim()) {
      routeSteerToPlanner(id, state, text)
        .then((handled) => {
          if (!handled) {
            postRootPlannerInput(id, state, text, mode, model, queued);
          } else {
            emitSessionEvent(id, state, { type: "steer-absorbed" });
          }
        })
        .catch((error) => {
          emitSteerRoutingNote(id, state, `routing crashed; preserving root queued steer (${error?.message || error})`);
          postRootPlannerInput(id, state, text, mode, model, queued);
        });
      return;
    }
    // The first send creates the session (titled from this prompt); later
    // sends resolve instantly. Only then is the turn posted.
    postRootPlannerInput(id, state, text, mode, model, queued);
  }

  function permission(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    if (!state || !state.child) return;
    const requestId = String(payload?.requestId || "");
    const reply = ["once", "always", "reject"].includes(payload?.reply) ? payload.reply : "reject";
    if (!requestId) return;
    request(state, "POST", `/permission/${encodeURIComponent(requestId)}/reply`, { reply }).catch((error) => {
      if (sessions.get(id) !== state) return;
      emitSessionEvent(id, state, {
        type: "error",
        message: `Could not answer the permission request: ${error.message}`
      });
    });
  }

  function compact(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    if (!state || !state.child || !state.sessionId) return;
    const model = splitModelId(state.plannerModel);
    if (!model) {
      emitSessionEvent(id, state, {
        type: "error",
        message: "No Brain model is set. Pick one with /brain-model before compacting."
      });
      return;
    }
    // Summarize runs a full model turn server-side; the default 30s request
    // timeout would destroy the POST mid-compaction and surface a spurious
    // error while the server keeps compacting.
    request(
      state,
      "POST",
      `/session/${encodeURIComponent(state.sessionId)}/summarize`,
      { providerID: model.providerID, modelID: model.modelID },
      300_000
    ).catch((error) => {
      if (sessions.get(id) !== state) return;
      emitSessionEvent(id, state, {
        type: "error",
        message: `Could not compact the session: ${error.message}`
      });
    });
  }

  function question(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    if (!state || !state.child) return;
    const requestId = String(payload?.requestId || "");
    if (!requestId) return;
    const reject = payload?.reject === true;
    // Reply body: option LABELS (or typed free-text), one inner array PER
    // question in request order — indexes or a flat array 400 server-side.
    const answers = Array.isArray(payload?.answers)
      ? payload.answers.map((entry) =>
          Array.isArray(entry) ? entry.map(String) : [String(entry)]
        )
      : [];
    const path = `/question/${encodeURIComponent(requestId)}/${reject ? "reject" : "reply"}`;
    request(state, "POST", path, reject ? undefined : { answers }).catch((error) => {
      if (sessions.get(id) !== state) return;
      emitSessionEvent(id, state, {
        type: "error",
        message: `Could not answer the question: ${error.message}`
      });
    });
  }

  function plannerModel(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    if (!state) return;
    state.plannerModel = String(payload?.model || "").trim();
  }

  function providers(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    if (!state || !state.child || !state.port) {
      emitDirectSessionEvent(id, {
        type: "providers",
        ok: false,
        message: "Open Fusion engine is not ready yet."
      });
      return;
    }
    // The full catalog and auth-method map are progressive enhancements: their
    // failure must be VISIBLE (catalogOk:false), not silently collapse the
    // connect picker to connected-only — that made "/connect openrouter" get
    // refused as "not in the catalog" with no hint anything failed.
    const CATALOG_FAILED = Symbol("catalog-failed");
    Promise.all([
      request(state, "GET", "/config/providers"),
      request(state, "GET", "/provider").catch(() => CATALOG_FAILED),
      request(state, "GET", "/provider/auth").catch(() => null)
    ])
      .then(([connectedInfo, catalog, authMethodsRaw]) => {
        if (sessions.get(id) !== state) return;
        const connected = [];
        const list = connectedInfo && Array.isArray(connectedInfo.providers) ? connectedInfo.providers : [];
        for (const provider of list) {
          if (!provider || typeof provider !== "object") continue;
          const models = Object.values(provider.models || {})
            .filter((model) => model && model.id)
            .sort((a, b) => String(b.release_date || "").localeCompare(String(a.release_date || "")))
            .map((model) => ({ id: String(model.id), name: String(model.name || model.id) }));
          connected.push({
            id: String(provider.id),
            name: String(provider.name || provider.id),
            // "config" marks a definition from an opencode.json — for Open
            // Fusion that is the app-owned global config, i.e. a user-added
            // custom provider the pane can offer to remove (not just
            // disconnect). The keyless zen provider reports "custom".
            source: String(provider.source || ""),
            models
          });
        }
        const connectedIds = new Set(connected.map((provider) => provider.id));
        const catalogOk = catalog !== CATALOG_FAILED;
        const available = [];
        const all = catalogOk && catalog && Array.isArray(catalog.all) ? catalog.all : [];
        for (const provider of all) {
          if (!provider || typeof provider !== "object" || connectedIds.has(String(provider.id))) continue;
          available.push({ id: String(provider.id), name: String(provider.name || provider.id) });
        }
        available.sort((a, b) => a.name.localeCompare(b.name));
        emitDirectSessionEvent(id, {
          type: "providers",
          ok: true,
          connected,
          available,
          catalogOk,
          authMethods: normalizeAuthMethods(authMethodsRaw)
        });
      })
      .catch((error) => {
        if (sessions.get(id) !== state) return;
        emitDirectSessionEvent(id, {
          type: "providers",
          ok: false,
          message: `Could not load the provider catalog: ${error.message}`
        });
      });
  }

  // The credential store is app-level and shared by every pane, but each pane
  // runs its own `opencode serve` whose lazy instance only reflects auth
  // changes after a dispose. After a connect/disconnect in ONE pane, dispose
  // the other panes' idle instances too (never mid-turn — a dispose with a
  // delegation in flight is not worth the risk; a busy pane picks the change
  // up at its next dispose/restart) and re-emit providers everywhere so every
  // open picker refreshes.
  // reloadConfig additionally nudges each idle pane's server with an empty
  // PATCH /global/config first: that re-reads the shared config FILE and
  // refreshes the instance (custom-provider adds/removes), which a bare
  // dispose does not do while OPENCODE_CONFIG_CONTENT is set.
  function refreshProvidersAfterAuthChange(originId, { reloadConfig = false } = {}) {
    for (const [sid, s] of sessions) {
      if (sid === originId || !s.child || !s.port || s.stopping) continue;
      const refresh = () => {
        if (sessions.get(sid) === s) providers({ id: sid });
      };
      // A running detached background task counts as busy for dispose: its
      // executor turn lives in the instance a dispose would tear down.
      if (s.turnBusy || (s.backgroundTasks && s.backgroundTasks.size > 0)) {
        refresh();
      } else {
        const nudge = reloadConfig
          ? request(s, "PATCH", "/global/config", {}).catch(() => {})
          : Promise.resolve();
        nudge
          .then(() => request(s, "POST", "/instance/dispose").catch(() => {}))
          .then(refresh);
      }
    }
    providers({ id: originId });
  }

  // Store an API key in OpenCode's own auth store (the same PUT the CLI's
  // `opencode auth login` performs), then dispose the lazy instance so the next
  // request rebuilds the provider list with the new credential (live-verified:
  // /config/providers only reflects auth changes after /instance/dispose; disk
  // sessions and the /event stream survive the dispose). The key only transits
  // memory — it must never appear in emitted events or errors.
  function cleanAuthInputs(raw) {
    const inputs = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string" && value.trim() && value.length <= 512) {
          inputs[String(key)] = value.trim();
        }
      }
    }
    return inputs;
  }

  function authSet(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    const providerId = String(payload?.providerId || "").trim();
    const key = typeof payload?.key === "string" ? payload.key.trim() : "";
    const nonce = typeof payload?.nonce === "string" ? payload.nonce : undefined;
    if (!state || !state.child || !state.port) {
      emitDirectSessionEvent(id, {
        type: "auth-result",
        ok: false,
        providerId,
        action: "connect",
        nonce,
        message: "Open Fusion engine is not ready yet."
      });
      return;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(providerId) || !key || key.length > 512 || /[\r\n]/.test(key)) {
      emitSessionEvent(id, state, {
        type: "auth-result",
        ok: false,
        providerId,
        action: "connect",
        nonce,
        message: "Provide a provider id and a single-line API key."
      });
      return;
    }
    // Prompt answers (e.g. Cloudflare accountId, Azure resourceName) ride the
    // credential's metadata record — the same place `opencode auth login` puts
    // them for api-type methods.
    const metadata = cleanAuthInputs(payload?.metadata);
    const credential = {
      type: "api",
      key,
      ...(Object.keys(metadata).length ? { metadata } : {})
    };
    request(state, "PUT", `/auth/${encodeURIComponent(providerId)}`, credential)
      .then(() => request(state, "POST", "/instance/dispose"))
      .then(() => {
        if (sessions.get(id) !== state) return;
        emitSessionEvent(id, state, {
          type: "auth-result",
          ok: true,
          providerId,
          action: "connect",
          nonce
        });
        refreshProvidersAfterAuthChange(id);
      })
      .catch((error) => {
        if (sessions.get(id) !== state) return;
        emitSessionEvent(id, state, {
          type: "auth-result",
          ok: false,
          providerId,
          action: "connect",
          nonce,
          message: `Could not store the key: ${error.message}`
        });
      });
  }

  // Start an OAuth method: POST /provider/{id}/oauth/authorize with the method
  // index + collected prompt inputs. The reply carries the flow shape the TUI's
  // own connect dialog renders — "code" (paste a code back) or "auto" (device
  // flow the server completes in the blocking callback call).
  function oauthAuthorize(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    const providerId = String(payload?.providerId || "").trim();
    const method = Number.isInteger(payload?.method) ? payload.method : -1;
    const nonce = typeof payload?.nonce === "string" ? payload.nonce : undefined;
    if (!state || !state.child || !state.port || !/^[A-Za-z0-9._-]+$/.test(providerId) || method < 0) {
      emitDirectSessionEvent(id, {
        type: "oauth-authorize",
        ok: false,
        providerId,
        nonce,
        message: "Open Fusion engine is not ready yet."
      });
      return;
    }
    const inputs = cleanAuthInputs(payload?.inputs);
    request(state, "POST", `/provider/${encodeURIComponent(providerId)}/oauth/authorize`, {
      method,
      ...(Object.keys(inputs).length ? { inputs } : {})
    })
      .then((authorization) => {
        if (sessions.get(id) !== state) return;
        if (!authorization || typeof authorization !== "object" || !authorization.url) {
          emitSessionEvent(id, state, {
            type: "oauth-authorize",
            ok: false,
            providerId,
            nonce,
            message: "The provider did not return an authorization URL."
          });
          return;
        }
        emitSessionEvent(id, state, {
          type: "oauth-authorize",
          ok: true,
          providerId,
          nonce,
          flow: authorization.method === "code" ? "code" : "auto",
          url: String(authorization.url),
          instructions: String(authorization.instructions || "")
        });
      })
      .catch((error) => {
        if (sessions.get(id) !== state) return;
        emitSessionEvent(id, state, {
          type: "oauth-authorize",
          ok: false,
          providerId,
          nonce,
          message: `Could not start the OAuth flow: ${error.message}`
        });
      });
  }

  // Complete an OAuth method. "auto" flows send no code and BLOCK server-side
  // until the user finishes in the browser (device-flow polling), so this call
  // gets a long timeout. On success the instance is disposed (auth changed) and
  // the provider catalog re-emitted — the same dispose+bootstrap the TUI does.
  function oauthCallback(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    const providerId = String(payload?.providerId || "").trim();
    const method = Number.isInteger(payload?.method) ? payload.method : -1;
    const code = typeof payload?.code === "string" && payload.code.trim() ? payload.code.trim() : undefined;
    const nonce = typeof payload?.nonce === "string" ? payload.nonce : undefined;
    if (!state || !state.child || !state.port || !/^[A-Za-z0-9._-]+$/.test(providerId) || method < 0) {
      emitDirectSessionEvent(id, {
        type: "auth-result",
        ok: false,
        providerId,
        action: "connect",
        nonce,
        message: "Open Fusion engine is not ready yet."
      });
      return;
    }
    request(
      state,
      "POST",
      `/provider/${encodeURIComponent(providerId)}/oauth/callback`,
      { method, ...(code ? { code } : {}) },
      10 * 60_000
    )
      .then(() => request(state, "POST", "/instance/dispose"))
      .then(() => {
        if (sessions.get(id) !== state) return;
        emitSessionEvent(id, state, {
          type: "auth-result",
          ok: true,
          providerId,
          action: "connect",
          nonce
        });
        refreshProvidersAfterAuthChange(id);
      })
      .catch((error) => {
        if (sessions.get(id) !== state) return;
        const failed = /ProviderAuthOauthCallbackFailed/.test(error.message);
        emitSessionEvent(id, state, {
          type: "auth-result",
          ok: false,
          providerId,
          action: "connect",
          nonce,
          message: failed
            ? "OAuth authorization failed. Try connecting again."
            : `Could not complete the OAuth flow: ${error.message}`
        });
      });
  }

  function authRemove(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    const providerId = String(payload?.providerId || "").trim();
    if (!state || !state.child || !state.port || !/^[A-Za-z0-9._-]+$/.test(providerId)) {
      emitDirectSessionEvent(id, {
        type: "auth-result",
        ok: false,
        providerId,
        action: "disconnect",
        message: "Open Fusion engine is not ready yet."
      });
      return;
    }
    request(state, "DELETE", `/auth/${encodeURIComponent(providerId)}`)
      .then(() => request(state, "POST", "/instance/dispose"))
      .then(() => {
        if (sessions.get(id) !== state) return;
        emitSessionEvent(id, state, {
          type: "auth-result",
          ok: true,
          providerId,
          action: "disconnect"
        });
        refreshProvidersAfterAuthChange(id);
      })
      .catch((error) => {
        if (sessions.get(id) !== state) return;
        emitSessionEvent(id, state, {
          type: "auth-result",
          ok: false,
          providerId,
          action: "disconnect",
          message: `Could not remove the credential: ${error.message}`
        });
      });
  }

  // Define (or redefine) a custom OpenAI-compatible provider. The pane's own
  // server PATCHes the app-owned global config — live-applied and persisted in
  // one call — then the optional API key goes through the same auth store PUT
  // + dispose the normal connect flow uses. The key only transits memory.
  function customProviderSet(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    const nonce = typeof payload?.nonce === "string" ? payload.nonce : undefined;
    const shaped = buildCustomProviderPatch(payload);
    const providerId = shaped.ok ? shaped.providerId : String(payload?.providerId || "").trim();
    if (!state || !state.child || !state.port) {
      emitDirectSessionEvent(id, {
        type: "auth-result",
        ok: false,
        providerId,
        action: "connect",
        nonce,
        message: "Open Fusion engine is not ready yet."
      });
      return;
    }
    const key = typeof payload?.key === "string" ? payload.key.trim() : "";
    if (!shaped.ok || key.length > 512 || /[\r\n]/.test(key)) {
      emitSessionEvent(id, state, {
        type: "auth-result",
        ok: false,
        providerId,
        action: "connect",
        nonce,
        message: shaped.ok ? "Provide a single-line API key (or none)." : shaped.message
      });
      return;
    }
    request(state, "PATCH", "/global/config", shaped.patch)
      .then(() =>
        key
          ? request(state, "PUT", `/auth/${encodeURIComponent(providerId)}`, { type: "api", key }).then(() =>
              request(state, "POST", "/instance/dispose")
            )
          : null
      )
      .then(() => {
        if (sessions.get(id) !== state) return;
        emitSessionEvent(id, state, {
          type: "auth-result",
          ok: true,
          providerId,
          action: "connect",
          nonce
        });
        refreshProvidersAfterAuthChange(id, { reloadConfig: true });
      })
      .catch((error) => {
        if (sessions.get(id) !== state) return;
        emitSessionEvent(id, state, {
          type: "auth-result",
          ok: false,
          providerId,
          action: "connect",
          nonce,
          message: `Could not save the custom provider: ${error.message}`
        });
      });
  }

  // Remove a custom provider. Main already rewrote the config file (a PATCH
  // cannot delete a key); here the credential is dropped (best-effort — a
  // keyless local endpoint has none) and the empty PATCH makes the origin's
  // server re-read the rewritten file so the provider disappears live.
  function customProviderRemove(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    const providerId = String(payload?.providerId || "").trim();
    const removedFromConfig = Boolean(payload?.removedFromConfig);
    if (!state || !state.child || !state.port || !CUSTOM_PROVIDER_ID_PATTERN.test(providerId)) {
      emitDirectSessionEvent(id, {
        type: "auth-result",
        ok: false,
        providerId,
        action: "disconnect",
        message: "Open Fusion engine is not ready yet."
      });
      return;
    }
    request(state, "DELETE", `/auth/${encodeURIComponent(providerId)}`)
      .catch(() => null)
      .then(() => request(state, "PATCH", "/global/config", {}))
      .then(() => request(state, "POST", "/instance/dispose"))
      .then(() => {
        if (sessions.get(id) !== state) return;
        emitSessionEvent(id, state, {
          type: "auth-result",
          ok: true,
          providerId,
          action: "disconnect",
          message: removedFromConfig
            ? undefined
            : `'${providerId}' was not an Open Fusion custom provider; only its stored credential (if any) was removed.`
        });
        refreshProvidersAfterAuthChange(id, { reloadConfig: true });
      })
      .catch((error) => {
        if (sessions.get(id) !== state) return;
        emitSessionEvent(id, state, {
          type: "auth-result",
          ok: false,
          providerId,
          action: "disconnect",
          message: `Could not remove the custom provider: ${error.message}`
        });
      });
  }

  function interrupt(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    if (!state || !state.child || !state.sessionId) return;
    request(state, "POST", `/session/${encodeURIComponent(state.sessionId)}/abort`)
      .then(() => {
        if (sessions.get(id) !== state) return;
        // Synthesized outside the normalizer loop — route it through the gate
        // tracker so the aborted turn's settle is never annotated.
        const event = { type: "interrupted" };
        emitSessionEvent(id, state, state.gate ? state.gate.observe(event) : event);
      })
      .catch(() => {
        // best-effort; the user can still Restart as the hard stop.
      });
  }

  function stop(payload) {
    const state = sessions.get(payload?.id);
    if (state) {
      state.stopping = true;
      settleAllBackgroundTasks(
        payload.id,
        state,
        "Open Fusion stopped while this background task was running."
      );
      clearSteerRoutingState(state);
      try {
        state.sseRequest?.destroy();
      } catch {
        // ignore
      }
      killChild(state.child);
      sessions.delete(payload.id);
    }
  }

  function shutdown() {
    for (const [id, state] of sessions) {
      state.stopping = true;
      settleAllBackgroundTasks(
        id,
        state,
        "Open Fusion shut down while this background task was running."
      );
      clearSteerRoutingState(state);
      try {
        state.sseRequest?.destroy();
      } catch {
        // ignore
      }
      killChild(state.child);
    }
    sessions.clear();
    process.exit(0);
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "start") start(msg.payload);
      else if (msg.type === "input") input(msg.payload);
      else if (msg.type === "permission") permission(msg.payload);
      else if (msg.type === "question") question(msg.payload);
      else if (msg.type === "compact") compact(msg.payload);
      else if (msg.type === "planner-model") plannerModel(msg.payload);
      else if (msg.type === "providers") providers(msg.payload);
      else if (msg.type === "auth-set") authSet(msg.payload);
      else if (msg.type === "auth-remove") authRemove(msg.payload);
      else if (msg.type === "oauth-authorize") oauthAuthorize(msg.payload);
      else if (msg.type === "oauth-callback") oauthCallback(msg.payload);
      else if (msg.type === "custom-provider-set") customProviderSet(msg.payload);
      else if (msg.type === "custom-provider-remove") customProviderRemove(msg.payload);
      else if (msg.type === "background-request") backgroundRequest(msg.payload);
      else if (msg.type === "background-cancel")
        backgroundRequest({ ...msg.payload, action: "cancel" });
      else if (msg.type === "interrupt") interrupt(msg.payload);
      else if (msg.type === "stop") stop(msg.payload);
      else if (msg.type === "shutdown") shutdown();
    }
  });
  process.stdin.on("end", shutdown);

  emit({ type: "ready" });
}

module.exports = {
  createOpenCodeEventNormalizer,
  rehydrateMessages,
  buildCustomProviderPatch,
  buildServeSpawn,
  backgroundStatusFileForEnv,
  withBackgroundStatusEnv,
  normalizeAuthMethods,
  splitModelId,
  buildPlannerTurnParts,
  buildExecutorSteerParts,
  buildExecutorSteerPromptRequest,
  buildPlannerPromptRequest,
  buildOpenFusionSteerDecisionPrompt,
  parseOpenFusionSteerDecision,
  buildOpenFusionReplanPrompt,
  shouldRouteOpenFusionSteer,
  summarizeOpenFusionExecutorActivity,
  extractOpenFusionAssistantTexts,
  openFusionExecutorSnapshot,
  selectOpenFusionExecutorTask,
  OPEN_FUSION_EXECUTOR_STEER_PREFIX,
  OPEN_FUSION_GATE_MARKER,
  OPEN_FUSION_GATE_REMINDER,
  OPEN_FUSION_GATE_NUDGE,
  OPEN_FUSION_PLAN_REMINDER,
  OPEN_FUSION_BACKGROUND_MARKER,
  backgroundTaskTitleOf,
  writeBackgroundStatusSnapshotFile,
  buildOpenFusionBackgroundContract,
  buildOpenFusionBackgroundWakeText,
  parseOpenFusionBackgroundReport
};

if (require.main === module) {
  runHost();
}
