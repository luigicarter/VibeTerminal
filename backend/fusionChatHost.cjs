// Headless Claude chat host for Fusion panes.
//
// A child process of main (mirrors backend/ptyHost.cjs): it spawns and manages
// ONE headless `claude` per Fusion pane, keeps it alive for multi-turn (the
// M3.1 spike confirmed `--input-format stream-json` accepts ongoing stdin user
// turns), parses each claude's stream-json stdout into clean, high-level events,
// and speaks a JSONL control protocol with main over its own stdin/stdout.
//
// Control IN (from main, one JSON per line on stdin):
//   {type:"start",  payload:{id, cwd, mcpConfig, systemPromptFile, model, mode?, effort?, settingsFile?, tools?, allowedTools, disallowedTools?, permissionMode?, strictMcpConfig?, resumeId?}}
//   {type:"input",  payload:{id, text, steer?}}
//   {type:"settings", payload:{id, plannerFast?}}
//   {type:"interrupt", payload:{id}}   ← abort the CURRENT turn, keep the session
//   {type:"stop",   payload:{id}}       ← kill the whole session process
//   {type:"shutdown"}
// Events OUT (to main, one JSON per line on stdout): {type:"event", id, event}
//   plus {type:"ready"} on boot. Session exits are event.type === "closed".
//
// The stream-json normalizer is exported (createStreamNormalizer) so the parser
// smoke can test it with a recorded fixture — no Claude, no auth, no cost.

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { createCodexBrainSession } = require("./fusionCodexBrain.cjs");
const { createFusionGateTracker } = require("./completionGate.cjs");
const { locateClaudeTranscriptFile } = require("./agentThreadHost.cjs");
const { codexHome, locateCodexRollout } = require("./agentThreads.cjs");

const isWin = process.platform === "win32";
const CLAUDE_BIN = process.env.VIBE_CLAUDE_BIN || "claude";
const MAX_HISTORY_EVENTS = 20_000;
const CLAUDE_RESULT_BACKSTOP_MS = Math.max(
  100,
  Number.isFinite(Number(process.env.VIBE_FUSION_CLAUDE_RESULT_BACKSTOP_MS))
    ? Number(process.env.VIBE_FUSION_CLAUDE_RESULT_BACKSTOP_MS)
    : 5_000
);

function normalizeFusionPlannerFamily(value) {
  return String(value || "").trim().toLowerCase() === "codex" ? "codex" : "claude";
}

function normalizeFusionRunMode(value) {
  return String(value || "").trim().toLowerCase() === "plan" ? "plan" : "auto";
}

function planModeDirective() {
  return [
    "FUSION PLAN MODE IS ACTIVE.",
    "Investigate read-only with Read, Grep, Glob, or codex_investigate, then present a concrete implementation plan to the user.",
    "Right-size the research: answer from what you know when you can, read directly for targeted lookups, and use codex_investigate with `tasks` (2-4 self-contained questions) to run parallel scouts when the plan needs context from several disjoint areas.",
    "Do not call codex_implement, codex_respond, codex_goal_set, codex_goal_clear, or any execution tool until the user switches this pane back to Auto mode. If a steer_routing result is already pending, codex_steer_resolve may still be used to settle that live route.",
    "Execution is hard-blocked in the adapter while Plan mode is active."
  ].join("\n");
}

// One-shot corrective nudge: prepended by input() when the completion-gate
// tracker armed it (a turn settled presenting codex_implement results with no
// independent check). Only fresh non-plan, non-steer turns carry it. The user
// echo carries `text` alone, so the nudge never renders in the transcript.
const FUSION_GATE_NUDGE = [
  "FUSION COMPLETION-GATE NOTICE: your previous turn presented codex_implement",
  "results without an independent check. Before any new delegation, verify the",
  "changed files against your spec (Read them, or run codex_investigate) and",
  "state which check you ran."
].join("\n");

// Wake envelope for detached background delegations: the adapter's settled
// report is delivered to the planner as a NEW turn whose text starts with
// this header. The pane renders the echo as a report row (backgroundReport
// flag), and rehydration recognizes the header so a resumed transcript never
// shows the envelope as the user's words.
const FUSION_BACKGROUND_REPORT_HEADER = "FUSION BACKGROUND TASK REPORT";

function buildBackgroundWakeText(event) {
  const result = event.result && typeof event.result === "object" ? event.result : {};
  const status = event.cancelled
    ? "cancelled"
    : result.status === "completed"
      ? "completed"
      : "failed";
  const lines = [
    FUSION_BACKGROUND_REPORT_HEADER,
    `taskId: ${event.taskId}`,
    `title: ${event.title || "background task"}`,
    `kind: ${event.kind || "implement"}`,
    `status: ${status}`,
    ""
  ];
  if (result.status === "completed") {
    if (event.kind === "investigate") {
      lines.push("Findings:", String(result.findings || "(none)"));
    } else {
      lines.push("Summary:", String(result.summary || "(none)"));
      if (Array.isArray(result.files) && result.files.length) {
        lines.push("", `Files: ${result.files.join(", ")}`);
      }
      const verdict =
        result.verifierVerdict && typeof result.verifierVerdict === "object"
          ? result.verifierVerdict
          : {
              goalReached: result.goalReached === true,
              bugsFound: Array.isArray(result.bugsFound) ? result.bugsFound : [],
              missingRequirements: Array.isArray(result.missingRequirements)
                ? result.missingRequirements
                : [],
              nextAction: result.nextAction || "continue",
              summary: result.verifierSummary || ""
            };
      lines.push("", `Verifier verdict: ${JSON.stringify(verdict)}`);
    }
  } else {
    lines.push(`Error: ${String(result.error || "background task failed")}`);
  }
  lines.push(
    "",
    event.kind === "investigate"
      ? "Treat these findings exactly like a codex_investigate result and continue the work they were gathered for. Report the outcome to the user."
      : "Treat this exactly like a codex_implement result that just returned: run your independent check (Read the changed files, codex_investigate, or git evidence) before presenting the work or releasing a dependent milestone, then report the outcome to the user."
  );
  return lines.join("\n");
}

// Recognize a stored wake envelope in a resumed transcript and recover the
// row metadata (title/taskId) plus the report body for the collapsible row.
function parseBackgroundReportEnvelope(text) {
  const value = String(text || "");
  if (!value.startsWith(FUSION_BACKGROUND_REPORT_HEADER)) return null;
  const lines = value.split(/\r?\n/);
  const meta = { taskId: "", title: "" };
  for (const line of lines.slice(1, 5)) {
    const taskIdMatch = /^taskId:\s*(.*)$/.exec(line);
    if (taskIdMatch) meta.taskId = taskIdMatch[1].trim();
    const titleMatch = /^title:\s*(.*)$/.exec(line);
    if (titleMatch) meta.title = titleMatch[1].trim();
  }
  return { taskId: meta.taskId, title: meta.title, text: value };
}

function buildFusionInputContent(text, mode, steer, nudge) {
  if (mode !== "plan") {
    if (steer) {
      return [
        "STEER CURRENT FUSION TURN:",
        text,
        "",
        "Incorporate this direction into the active response. If Codex is currently running, use this as steering for the next Codex decision, correction, or follow-up delegation instead of treating it as a separate new request."
      ].join("\n");
    }
    return nudge ? [FUSION_GATE_NUDGE, "", text].join("\n") : text;
  }

  const directive = planModeDirective();
  return steer
    ? [
        directive,
        "",
        "STEER CURRENT FUSION TURN:",
        text,
        "",
        "Incorporate this direction into the active response as read-only planning guidance. Present the plan; do not delegate execution until Auto mode is restored."
      ].join("\n")
    : [directive, "", "USER REQUEST:", text].join("\n");
}

// ---- resume rehydration ----
// A resumed planner child never replays its prior conversation (claude
// `--resume` and codex `thread/resume` load context silently), so without
// this the pane showed a FRESH hero over a live old chat — "resume did
// nothing". Rebuild the visible transcript from the on-disk record: user
// prompts + assistant prose (tool rows are not replayed). Events are emitted
// with replay:true — the renderer's reattach-replay contract — so restoring
// history never latches status or attention, and they enter state.history so
// later remounts replay them like any other event.

// Tail-biased caps: recent turns matter, a 50MB transcript does not.
const REHYDRATE_MAX_BYTES = 4 * 1024 * 1024;
const REHYDRATE_MAX_EVENTS = 400;

function readTranscriptTailLines(filePath) {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - REHYDRATE_MAX_BYTES);
  const length = stat.size - start;
  const fd = fs.openSync(filePath, "r");
  let raw;
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    raw = buffer.toString("utf8", 0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  // A mid-file start almost certainly cut a line in half: drop the fragment.
  if (start > 0) {
    raw = raw.slice(raw.indexOf("\n") + 1);
  }
  return raw.split(/\r?\n/);
}

// Reverse buildFusionInputContent: stored user turns carry the harness
// envelopes (plan directive, steer wrapper, gate nudge) that must not render
// as the user's words. Keep the two functions in sync.
function unwrapFusionUserText(text) {
  let value = String(text || "");
  if (value.startsWith(FUSION_GATE_NUDGE)) {
    value = value.slice(FUSION_GATE_NUDGE.length).replace(/^\n+/, "");
  }
  const directive = planModeDirective();
  if (value.startsWith(directive)) {
    value = value.slice(directive.length).replace(/^\n+/, "");
    if (value.startsWith("USER REQUEST:")) {
      value = value.slice("USER REQUEST:".length).replace(/^\n+/, "");
    }
  }
  if (value.startsWith("STEER CURRENT FUSION TURN:")) {
    value = value.slice("STEER CURRENT FUSION TURN:".length).replace(/^\n+/, "");
    const trailer = value.lastIndexOf("\n\nIncorporate this direction");
    if (trailer !== -1) {
      value = value.slice(0, trailer);
    }
  }
  return value;
}

// Transcript texts that read as user messages but are not the user's prompt:
// slash-command envelopes, local command output, and the resume caveat banner.
function isClaudeMetaText(text) {
  return (
    text.startsWith("<command-") ||
    text.startsWith("<local-command-") ||
    text.startsWith("Caveat:")
  );
}

function claudeContentText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  // A user record whose content carries tool_result parts is tool feedback
  // (e.g. codex_implement's reply), not something the user typed.
  if (content.some((part) => part && part.type === "tool_result")) {
    return "";
  }
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

// Cap and close a rehydration event list: keep the newest turns, starting at
// a user boundary when one exists, and settle the renderer with a status-
// neutral "restored" result.
function finishRehydrationEvents(events) {
  if (!events.length) {
    return [];
  }
  let trimmed = events;
  if (events.length > REHYDRATE_MAX_EVENTS) {
    trimmed = events.slice(events.length - REHYDRATE_MAX_EVENTS);
    const firstUser = trimmed.findIndex((event) => event.type === "user");
    if (firstUser > 0) {
      trimmed = trimmed.slice(firstUser);
    }
  }
  return [...trimmed, { type: "result", subtype: "restored" }];
}

// Claude transcript (~/.claude/projects/<cwd>/<id>.jsonl): user/assistant
// records, one API message per line.
function buildClaudeRehydrationEvents(transcriptPath) {
  let lines;
  try {
    lines = readTranscriptTailLines(transcriptPath);
  } catch {
    return [];
  }

  const events = [];
  let lastWasAssistant = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.isMeta || record.isSidechain) continue;
    if (record.type === "user" && record.message) {
      const text = unwrapFusionUserText(claudeContentText(record.message.content));
      if (text && !isClaudeMetaText(text)) {
        const bg = parseBackgroundReportEnvelope(text);
        events.push(
          bg
            ? { type: "user", text: bg.text, backgroundReport: true, taskId: bg.taskId, title: bg.title }
            : { type: "user", text }
        );
        lastWasAssistant = false;
      }
      continue;
    }
    if (record.type === "assistant" && record.message) {
      const text = claudeContentText(record.message.content);
      if (text) {
        // Consecutive assistant messages merge into one bubble; keep the
        // paragraph break turn-start would have added live.
        events.push({
          type: "assistant-text",
          delta: lastWasAssistant ? `\n\n${text}` : text
        });
        lastWasAssistant = true;
      }
    }
  }
  return finishRehydrationEvents(events);
}

// Codex rollout (~/.codex/sessions/.../rollout-<ts>-<id>.jsonl): event_msg
// lines with user_message/agent_message payloads. Instruction/environment
// envelopes start with "<" and are skipped (same rule as title harvesting).
function buildCodexRehydrationEvents(rolloutPath) {
  let lines;
  try {
    lines = readTranscriptTailLines(rolloutPath);
  } catch {
    return [];
  }

  const events = [];
  let lastWasAssistant = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "event_msg" || typeof record.payload?.message !== "string") {
      continue;
    }
    if (record.payload.type === "user_message") {
      const text = unwrapFusionUserText(record.payload.message);
      if (text && !text.startsWith("<")) {
        const bg = parseBackgroundReportEnvelope(text);
        events.push(
          bg
            ? { type: "user", text: bg.text, backgroundReport: true, taskId: bg.taskId, title: bg.title }
            : { type: "user", text }
        );
        lastWasAssistant = false;
      }
    } else if (record.payload.type === "agent_message") {
      const text = record.payload.message.trim();
      if (text) {
        events.push({
          type: "assistant-text",
          delta: lastWasAssistant ? `\n\n${text}` : text
        });
        lastWasAssistant = true;
      }
    }
  }
  return finishRehydrationEvents(events);
}

function toolDisplayName(name) {
  return String(name || "").replace(/^mcp__[^_]+__/, "");
}

function isBackgroundAgentTool(name) {
  const displayName = toolDisplayName(name);
  return displayName === "Task" || displayName === "Agent";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clipped(value, max) {
  const text = String(value || "").trim();
  return text.length > max ? text.slice(0, max) + "..." : text;
}

function backgroundAgentItem(toolId, name, input) {
  const data = asObject(input);
  const displayName = toolDisplayName(name);
  const description =
    typeof data.description === "string" && data.description.trim()
      ? data.description
      : typeof data.subagent_type === "string" && data.subagent_type.trim()
        ? data.subagent_type
        : "";
  const prompt = typeof data.prompt === "string" && data.prompt.trim() ? data.prompt : "";
  return {
    id: String(toolId || displayName + "-" + Date.now()),
    source: "opus",
    label: clipped(description || displayName + " subagent", 80),
    detail: clipped(prompt || description || displayName + " subagent running", 220)
  };
}

function appendBackgroundActivity(events, activeBackgroundAgents) {
  const items = Array.from(activeBackgroundAgents.values());
  events.push({
    type: "background-activity",
    backgroundActivity: {
      active: items.length > 0,
      count: items.length,
      source: "opus",
      items,
      updatedAt: Date.now()
    }
  });
}

function latePlannerResultUsageEvent(event) {
  const usageEvent = {
    type: "result-usage",
    subtype: event.subtype,
    lateResult: true
  };
  if (event.usage != null) usageEvent.usage = event.usage;
  if (typeof event.costUsd === "number") usageEvent.costUsd = event.costUsd;
  return usageEvent.usage != null || typeof usageEvent.costUsd === "number"
    ? usageEvent
    : null;
}

function applyPlannerTurnSettleState(state, event) {
  if (event.type === "user") {
    state.plannerTurnSettled = false;
    state.plannerResultBackstopEligible = false;
    return { event, clearBackstop: true };
  }
  if (event.type === "turn-start") {
    state.plannerTurnSettled = false;
    return { event, clearBackstop: true };
  }
  if (event.type === "tool-result" && event.completedBridgeResult) {
    state.plannerResultBackstopEligible = true;
    return { event };
  }
  if (
    event.type === "turn-end" &&
    state.plannerResultBackstopEligible &&
    !event.awaitsToolResult
  ) {
    return { event, armBackstop: true };
  }
  if (event.type === "result") {
    if (state.plannerTurnSettled) {
      return { event: latePlannerResultUsageEvent(event), skipGate: true };
    }
    state.plannerTurnSettled = true;
    state.plannerResultBackstopEligible = false;
    return { event, clearBackstop: true };
  }
  if (
    event.type === "error" ||
    event.type === "interrupted" ||
    event.type === "closed"
  ) {
    state.plannerResultBackstopEligible = false;
    return { event, clearBackstop: true };
  }
  return { event };
}

// ---- stream-json normalizer (pure, per-session state) ----
// Turns the raw Anthropic stream-json line objects into high-level chat events.
function createStreamNormalizer() {
  let block = null; // { kind: "text"|"thinking"|"tool_use", toolId?, name?, jsonBuf? }
  let turnErrorEmitted = false;
  let messageAwaitsToolResult = false;
  const activeBackgroundAgents = new Map();
  const bridgeToolIds = new Set();

  return function normalize(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }
    const events = [];

    if (msg.type === "system" && msg.subtype === "init") {
      if (msg.session_id) events.push({ type: "session", sessionId: msg.session_id });
      return events;
    }

    if (msg.type === "system" && msg.subtype === "status") {
      // Observed live (claude 2.1.200) when "/compact" is sent as a stream-json
      // user message: status:"compacting" opens the pass, then a status line
      // with compact_result ("success"/"failed") + compact_error closes it.
      if (msg.status === "compacting") {
        events.push({ type: "compact-start" });
      } else if ("compact_result" in msg) {
        events.push({
          type: "compacted",
          ok: msg.compact_result !== "failed",
          error: typeof msg.compact_error === "string" ? msg.compact_error : undefined
        });
      }
      return events;
    }

    if (msg.type === "result") {
      if (activeBackgroundAgents.size > 0) {
        activeBackgroundAgents.clear();
        appendBackgroundActivity(events, activeBackgroundAgents);
      }
      const isError = Boolean(msg.is_error);
      events.push({
        type: "result",
        subtype: msg.subtype,
        usage: msg.usage,
        costUsd: msg.total_cost_usd,
        isError,
        // The error detail for failed turns rides in `result` (e.g. a model
        // the account can't use). Skip it if the synthetic assistant error
        // already surfaced this turn — one message is enough.
        resultText:
          isError && !turnErrorEmitted && typeof msg.result === "string"
            ? msg.result
            : undefined
      });
      turnErrorEmitted = false;
      return events;
    }

    // Errors like model_not_found arrive as a COMPLETE synthetic assistant
    // message (never as stream_events), so without this branch the turn ends
    // with no output at all — a silently dead pane.
    if (msg.type === "assistant" && msg.message) {
      const err = msg.error ?? msg.message.error;
      if (err && !turnErrorEmitted) {
        turnErrorEmitted = true;
        const detail = Array.isArray(msg.message.content)
          ? msg.message.content
              .filter((part) => part && part.type === "text" && part.text)
              .map((part) => part.text)
              .join("\n")
          : "";
        const label = typeof err === "string" ? err : JSON.stringify(err);
        events.push({
          type: "turn-error",
          message: detail ? `${label}: ${detail}` : `Claude error: ${label}`
        });
      }
      return events;
    }

    // A tool_result fed back into the conversation (e.g. codex_implement's reply).
    if (msg.type === "user" && msg.message && Array.isArray(msg.message.content)) {
      for (const part of msg.message.content) {
        if (part && part.type === "tool_result") {
          const toolId = String(part.tool_use_id || "");
          const text =
            typeof part.content === "string"
              ? part.content
              : Array.isArray(part.content)
                ? part.content
                    .filter((item) => item && item.type === "text" && typeof item.text === "string")
                    .map((item) => item.text)
                    .join("\n")
                : JSON.stringify(part.content);
          const bridgeToolResult = toolId && bridgeToolIds.has(toolId);
          let parsed = null;
          if (bridgeToolResult && typeof text === "string") {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = null;
            }
          }
          const completedBridgeResult =
            Boolean(bridgeToolResult) &&
            !part.is_error &&
            Boolean(parsed && parsed.status === "completed");
          events.push({
            type: "tool-result",
            toolId: part.tool_use_id,
            text,
            // The pane's OpenCode-style tool rows settle red on real errors;
            // without this flag they could only guess from the result text.
            isError: Boolean(part.is_error),
            completedBridgeResult
          });
          if (bridgeToolResult) bridgeToolIds.delete(toolId);
          if (toolId && activeBackgroundAgents.delete(toolId)) {
            appendBackgroundActivity(events, activeBackgroundAgents);
          }
        }
      }
      return events;
    }

    if (msg.type !== "stream_event" || !msg.event) {
      return events;
    }

    const ev = msg.event;
    switch (ev.type) {
      case "message_start":
        messageAwaitsToolResult = false;
        events.push({ type: "turn-start" });
        break;
      case "content_block_start": {
        const cb = ev.content_block || {};
        if (cb.type === "tool_use") {
          messageAwaitsToolResult = true;
          block = { kind: "tool_use", toolId: cb.id, name: cb.name, jsonBuf: "" };
        } else if (cb.type === "thinking") {
          block = { kind: "thinking" };
        } else {
          block = { kind: "text" };
        }
        break;
      }
      case "content_block_delta": {
        const d = ev.delta || {};
        // Thinking blocks stream `thinking_delta` (with a `thinking` field), not
        // `text_delta` — handling only text_delta silently dropped Opus's whole
        // planning stream. Key each delta off its own type.
        if (d.type === "text_delta") {
          events.push({ type: "assistant-text", delta: d.text || "" });
        } else if (d.type === "thinking_delta") {
          events.push({ type: "thinking", delta: d.thinking || "" });
        } else if (d.type === "input_json_delta" && block && block.kind === "tool_use") {
          block.jsonBuf += d.partial_json || "";
        }
        break;
      }
      case "content_block_stop": {
        if (block && block.kind === "tool_use") {
          let input = {};
          try {
            input = block.jsonBuf ? JSON.parse(block.jsonBuf) : {};
          } catch {
            input = { _raw: block.jsonBuf };
          }
          events.push({
            type: "tool-call",
            toolId: block.toolId,
            name: block.name,
            input
          });
          if (String(block.name || "").endsWith("codex_implement")) {
            bridgeToolIds.add(String(block.toolId || ""));
          }
          if (isBackgroundAgentTool(block.name)) {
            activeBackgroundAgents.set(
              String(block.toolId || ""),
              backgroundAgentItem(block.toolId, block.name, input)
            );
            appendBackgroundActivity(events, activeBackgroundAgents);
          }
        }
        block = null;
        break;
      }
      case "message_stop":
        events.push({ type: "turn-end", awaitsToolResult: messageAwaitsToolResult });
        break;
      default:
        break;
    }
    return events;
  };
}

// ---- the host (only runs when executed as a process, not when required) ----
function runHost() {
  const sessions = new Map(); // id -> { child, normalizer, buffer, history }

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

  function clonePayload(payload) {
    try {
      return JSON.parse(JSON.stringify(payload || {}));
    } catch {
      return { ...(payload || {}) };
    }
  }

  function cloneHistory(history) {
    return Array.isArray(history) ? history.map(cloneEvent) : [];
  }

  function clearPlannerResultBackstop(state) {
    if (state?.plannerResultBackstopTimer) {
      clearTimeout(state.plannerResultBackstopTimer);
      state.plannerResultBackstopTimer = null;
    }
  }

  function armPlannerResultBackstop(id, state, delayMs, reason) {
    clearPlannerResultBackstop(state);
    state.plannerResultBackstopTimer = setTimeout(() => {
      if (sessions.get(id) !== state) return;
      state.plannerResultBackstopTimer = null;
      emitSessionEvent(id, state, {
        type: "result",
        subtype: "success",
        isError: false,
        synthetic: true,
        reason
      });
    }, delayMs);
    if (typeof state.plannerResultBackstopTimer.unref === "function") {
      state.plannerResultBackstopTimer.unref();
    }
  }

  function emitSessionEvent(id, state, event) {
    const settle = applyPlannerTurnSettleState(state, event);
    event = settle.event;
    if (settle.clearBackstop) {
      clearPlannerResultBackstop(state);
    }
    if (settle.armBackstop) {
      armPlannerResultBackstop(id, state, CLAUDE_RESULT_BACKSTOP_MS, "final-turn-end");
    }
    if (!event) return;
    // Single choke point for both planner engines: the completion-gate tracker
    // annotates clean `result` events BEFORE they reach history, so reattach
    // replay carries the gate chip for free (replaySession bypasses observe —
    // no double-fire).
    if (!settle.skipGate && state.gate) event = state.gate.observe(event);
    state.history.push(cloneEvent(event));
    if (state.history.length > MAX_HISTORY_EVENTS) {
      state.history.splice(0, state.history.length - MAX_HISTORY_EVENTS);
    }
    emit({ type: "event", id, event });
    // Host-side wake queueing for background delegations: a settled report
    // only opens a NEW planner turn when no turn is in flight — it is never
    // steered into a running one (that would hijack the live turn's topic).
    if (event.type === "user") {
      state.turnActive = true;
    } else if (
      event.type === "result" ||
      event.type === "interrupted" ||
      event.type === "error" ||
      event.type === "closed"
    ) {
      state.turnActive = false;
      if (event.type === "closed") {
        settleOrphanedBackgroundTasks(id, state);
      }
      if (Array.isArray(state.pendingWakes) && state.pendingWakes.length) {
        setImmediate(() => {
          if (sessions.get(id) !== state) return;
          maybeFlushBackgroundWakes(id, state);
        });
      }
    }
  }

  // The planner child (and the adapter with it) died while background tasks
  // were still running: their settled telemetry may never arrive, so settle
  // the rows here. No wake — the work is gone with the adapter.
  function settleOrphanedBackgroundTasks(id, state) {
    if (!(state.backgroundTasks instanceof Map) || state.backgroundTasks.size === 0) return;
    const orphans = Array.from(state.backgroundTasks.values());
    state.backgroundTasks.clear();
    for (const task of orphans) {
      emitSessionEvent(id, state, {
        type: "background-task",
        phase: "settled",
        taskId: task.taskId,
        title: task.title,
        kind: task.kind,
        cancelled: false,
        orphaned: true,
        result: {
          status: "failed",
          error: "Fusion closed while this background task was running."
        }
      });
    }
  }

  function buildBackgroundWake(event) {
    const result = event.result && typeof event.result === "object" ? event.result : {};
    const wake = {
      taskId: event.taskId,
      title: event.title || "background task",
      text: buildBackgroundWakeText(event),
      echoText: `Background task report — ${event.title || event.taskId}`
    };
    // The changed-file set rides the wake echo ONLY for a completed
    // implement-style task: that is what arms the completion-gate latch for
    // the review turn. Failed/cancelled tasks present no work as done.
    if (event.kind !== "investigate" && !event.cancelled && result.status === "completed") {
      wake.files = Array.isArray(result.files) ? result.files : [];
    }
    return wake;
  }

  function queueBackgroundWake(id, state, settledEvent) {
    if (!Array.isArray(state.pendingWakes)) state.pendingWakes = [];
    state.pendingWakes.push(buildBackgroundWake(settledEvent));
    maybeFlushBackgroundWakes(id, state);
  }

  function maybeFlushBackgroundWakes(id, state) {
    if (state.turnActive) return;
    if (!Array.isArray(state.pendingWakes) || state.pendingWakes.length === 0) return;
    // One wake at a time: the delivered wake's own turn must settle before
    // the next queued report opens a turn.
    const wake = state.pendingWakes.shift();
    deliverBackgroundWake(id, state, wake);
  }

  function deliverBackgroundWake(id, state, wake) {
    if (!state.child) {
      const restartedState = restartCleanClosedSession(id, state);
      if (restartedState?.child) {
        state = restartedState;
      } else {
        emitSessionEvent(id, state, {
          type: "error",
          message: `Fusion background task "${wake.title}" finished, but the planner is closed. Restart Fusion to review the report.`
        });
        return;
      }
    }
    const runMode = normalizeFusionRunMode(state.mode);
    const content = buildFusionInputContent(wake.text, runMode, false, false);
    const echo = {
      type: "user",
      text: wake.echoText,
      backgroundReport: true,
      taskId: wake.taskId,
      title: wake.title
    };
    if (Array.isArray(wake.files)) echo.files = wake.files;
    if (state.engine === "codex") {
      emitSessionEvent(id, state, echo);
      state.brain.sendInput(content, false).catch((error) => {
        if (sessions.get(id) !== state) return;
        emitSessionEvent(id, state, {
          type: "error",
          message: `Could not deliver the background task report: ${error.message || "planner is gone"}`
        });
      });
      return;
    }
    try {
      emitSessionEvent(id, state, echo);
      state.child.stdin.write(
        JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n"
      );
    } catch (error) {
      emitSessionEvent(id, state, {
        type: "error",
        message: `Could not deliver the background task report: ${error.message || "child process is gone"}`
      });
    }
  }

  // fusion.background-task telemetry relayed by main: track the registry,
  // mirror it to the pane (started/settled enter history so replay rebuilds
  // the rows; progress is transient ticking only), and queue the wake.
  function backgroundTask(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    if (!state) return;
    const phase = String(payload.phase || "");
    const taskId = String(payload.taskId || "");
    if (!taskId) return;
    if (!(state.backgroundTasks instanceof Map)) state.backgroundTasks = new Map();
    if (phase === "started") {
      const task = {
        taskId,
        title: String(payload.title || ""),
        kind: String(payload.kind || "implement"),
        startedAt: Date.now()
      };
      state.backgroundTasks.set(taskId, task);
      emitSessionEvent(id, state, {
        type: "background-task",
        phase: "started",
        taskId,
        title: task.title,
        kind: task.kind,
        task: typeof payload.task === "string" ? payload.task : ""
      });
      return;
    }
    if (phase === "progress") {
      // Transient by design: a long task would flood the replay history.
      emitDirectSessionEvent(id, {
        type: "background-task",
        phase: "progress",
        taskId,
        activityKind: String(payload.activityKind || "activity"),
        text: String(payload.text || ""),
        updates: Number(payload.updates) || 0
      });
      return;
    }
    if (phase !== "settled") return;
    state.backgroundTasks.delete(taskId);
    const settledEvent = {
      type: "background-task",
      phase: "settled",
      taskId,
      title: String(payload.title || ""),
      kind: String(payload.kind || "implement"),
      cancelled: payload.cancelled === true,
      updates: Number(payload.updates) || 0,
      durationMs: Number(payload.durationMs) || 0,
      result:
        payload.result && typeof payload.result === "object"
          ? payload.result
          : { status: "failed", error: "background task returned no result" }
    };
    emitSessionEvent(id, state, settledEvent);
    queueBackgroundWake(id, state, settledEvent);
  }

  function emitDirectSessionEvent(id, event) {
    if (id) {
      emit({ type: "event", id, event });
    }
  }

  function replaySession(id, state) {
    // Reattach replay is a transcript restore, not fresh activity: the flag
    // lets the renderer rebuild the pane without re-latching status or
    // re-marking the attention dot for turns the user already acknowledged.
    for (const event of state.history) {
      emit({ type: "event", id, event: { ...event, replay: true } });
    }
  }

  // Restore a resumed conversation into the pane: replay-tagged live emission
  // (status/attention-neutral) plus history entry (so remount replays keep
  // it). Deliberately NOT via emitSessionEvent — the completion-gate tracker
  // must never observe restored turns.
  function rehydrateResumedTranscript(id, state, events) {
    for (const event of events) {
      state.history.push(cloneEvent(event));
      emit({ type: "event", id, event: { ...event, replay: true } });
    }
    if (state.history.length > MAX_HISTORY_EVENTS) {
      state.history.splice(0, state.history.length - MAX_HISTORY_EVENTS);
    }
  }

  function markPlannerClosed(state, code) {
    state.child = null;
    state.lastExitCode = code;
  }

  function restartCleanClosedSession(id, state) {
    if (!state || state.child || state.lastExitCode !== 0 || !state.launchPayload) {
      return null;
    }
    const payload = { ...clonePayload(state.launchPayload), id };
    const options = {
      history: cloneHistory(state.history),
      gate: state.gate,
      preserveHistory: true,
      // Undelivered wake reports survive a clean planner restart (the work
      // finished; only the report delivery is pending). The task registry is
      // carried too — a clean exit mid-task is settled by the closed handler
      // before this restart path can run.
      backgroundTasks: state.backgroundTasks,
      pendingWakes: state.pendingWakes
    };
    clearPlannerResultBackstop(state);
    sessions.delete(id);
    start(payload, options);
    const nextState = sessions.get(id);
    return nextState?.child ? nextState : null;
  }

  function start(payload, options = {}) {
    const { id, cwd } = payload;
    if (sessions.has(id)) {
      const existingState = sessions.get(id);
      if (existingState?.child) {
        existingState.mode = normalizeFusionRunMode(payload.mode);
        existingState.launchPayload = {
          ...clonePayload(existingState.launchPayload),
          ...clonePayload(payload),
          mode: existingState.mode
        };
        replaySession(id, existingState);
        return existingState;
      }

      clearPlannerResultBackstop(existingState);
      sessions.delete(id);
    }

    // Per-role families: a codex planner runs `codex app-server` behind the
    // same control protocol and event vocabulary as the headless claude.
    if (normalizeFusionPlannerFamily(payload.plannerFamily) === "codex") {
      return startCodexBrain(payload, options);
    }

    const launch = buildClaudeSpawn(payload);
    const child = spawn(launch.command, launch.args, {
      cwd: cwd || undefined,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    const normalizer = createStreamNormalizer();
    const state = {
      child,
      normalizer,
      buffer: "",
      history: cloneHistory(options.history),
      engine: "claude",
      launchPayload: clonePayload(payload),
      lastExitCode: null,
      plannerFast: payload.plannerFast === true,
      fastSeq: 0,
      mode: normalizeFusionRunMode(payload.mode),
      gate: options.gate || createFusionGateTracker({ cwd }),
      backgroundTasks:
        options.backgroundTasks instanceof Map ? options.backgroundTasks : new Map(),
      pendingWakes: Array.isArray(options.pendingWakes) ? options.pendingWakes : [],
      turnActive: false
    };
    sessions.set(id, state);

    // `claude --resume` loads the old conversation silently; restore it into
    // the pane before any live child output arrives.
    if (payload.resumeId && !options.preserveHistory) {
      let located = null;
      try {
        located = locateClaudeTranscriptFile(String(payload.resumeId));
      } catch {
        located = null;
      }
      if (located?.path) {
        rehydrateResumedTranscript(
          id,
          state,
          buildClaudeRehydrationEvents(located.path)
        );
      }
    }

    child.stdout.on("data", (chunk) => {
      if (sessions.get(id) !== state) {
        return;
      }

      state.buffer += chunk.toString("utf8");
      let index;
      while ((index = state.buffer.indexOf("\n")) !== -1) {
        const line = state.buffer.slice(0, index).trim();
        state.buffer = state.buffer.slice(index + 1);
        if (!line) continue;
        for (const event of normalizer(line)) {
          emitSessionEvent(id, state, event);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      if (sessions.get(id) !== state) {
        return;
      }

      emitSessionEvent(id, state, { type: "stderr", text: chunk.toString("utf8") });
    });
    child.on("error", (error) => {
      if (sessions.get(id) !== state) {
        return;
      }

      emitSessionEvent(id, state, { type: "error", message: error.message });
    });
    child.on("exit", (code) => {
      if (sessions.get(id) !== state) {
        return;
      }
      markPlannerClosed(state, code);
      emitSessionEvent(id, state, { type: "closed", code });
    });
    return state;
  }

  // Spawn and wire a codex-family planner: one `codex app-server` child per
  // pane, MCP-hosting this pane's fusion-adapter, normalized onto the SAME
  // event vocabulary as the claude stream path (history/replay included).
  function startCodexBrain(payload, options = {}) {
    const { id, cwd } = payload;
    const state = {
      child: null,
      brain: null,
      engine: "codex",
      history: cloneHistory(options.history),
      launchPayload: clonePayload(payload),
      lastExitCode: null,
      mode: normalizeFusionRunMode(payload.mode),
      gate: options.gate || createFusionGateTracker({ cwd }),
      backgroundTasks:
        options.backgroundTasks instanceof Map ? options.backgroundTasks : new Map(),
      pendingWakes: Array.isArray(options.pendingWakes) ? options.pendingWakes : [],
      turnActive: false
    };
    sessions.set(id, state);

    // codex `thread/resume` loads the old conversation silently; restore it
    // into the pane before any live brain output arrives.
    if (payload.resumeId && !options.preserveHistory) {
      let located = null;
      try {
        located = locateCodexRollout(
          path.join(codexHome(), "sessions"),
          String(payload.resumeId)
        );
      } catch {
        located = null;
      }
      if (located?.path) {
        rehydrateResumedTranscript(
          id,
          state,
          buildCodexRehydrationEvents(located.path)
        );
      }
    }

    const emitEvent = (event) => {
      if (sessions.get(id) !== state) return;
      emitSessionEvent(id, state, event);
    };
    let brain;
    try {
      brain = createCodexBrainSession({
        cwd,
        codexBin: payload.codexBin || "codex",
        mcpConfigPath: payload.mcpConfig,
        systemPromptFile: payload.systemPromptFile,
        model: payload.model || undefined,
        effort: payload.effort || undefined,
        plannerFast: payload.plannerFast === true,
        resumeId: payload.resumeId || undefined,
        emitEvent
      });
    } catch (error) {
      emitSessionEvent(id, state, {
        type: "error",
        message: `Fusion planner failed to start: ${error.message}`
      });
      state.lastExitCode = 1;
      return state;
    }
    state.brain = brain;
    state.child = brain.child;
    brain.child.on("exit", (code) => {
      if (sessions.get(id) !== state) return;
      markPlannerClosed(state, code);
      emitSessionEvent(id, state, { type: "closed", code });
    });
    return state;
  }

  function input(payload) {
    const id = payload?.id;
    const text = String(payload?.text ?? "");
    const steer = Boolean(payload?.steer);
    const routed = steer && payload?.routed === true;
    let state = sessions.get(id);
    if (!state) {
      emitDirectSessionEvent(id, {
        type: "error",
        message: "Fusion session is not running. Restart Fusion to continue."
      });
      return;
    }

    if (!state.child) {
      const restartedState = restartCleanClosedSession(id, state);
      if (restartedState?.child) {
        state = restartedState;
      } else {
        emitSessionEvent(id, state, {
          type: "error",
          message: "Fusion process is closed. Restart Fusion to continue."
        });
        return;
      }
    }

    // One-shot completion-gate nudge, computed ONCE above the engine branch so
    // both planner families carry it identically. Short-circuit order is
    // load-bearing: plan-mode and steer sends must not burn the flag — it
    // stays armed for the next fresh Auto turn.
    const runMode = normalizeFusionRunMode(state.mode);
    const nudge =
      runMode !== "plan" && !steer && Boolean(state.gate && state.gate.consumeNudge());

    if (state.engine === "codex") {
      emitSessionEvent(id, state, { type: "user", text, steer });
      if (routed) {
        return;
      }
      const content = buildFusionInputContent(text, runMode, steer, nudge);
      state.brain.sendInput(content, steer).catch((error) => {
        if (sessions.get(id) !== state) return;
        emitSessionEvent(id, state, {
          type: "error",
          message: `Could not send Fusion turn: ${error.message || "planner is gone"}`
        });
      });
      return;
    }

    try {
      emitSessionEvent(id, state, { type: "user", text, steer });
      if (routed) {
        return;
      }
      const content = buildFusionInputContent(text, runMode, steer, nudge);
      state.child.stdin.write(
        JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n"
      );
    } catch (error) {
      emitSessionEvent(id, state, {
        type: "error",
        message: `Could not send Fusion turn: ${error.message || "child process is gone"}`
      });
    }
  }

  function activity(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    if (!state) return;
    emitSessionEvent(id, state, {
      type: "activity",
      role: payload.role === "opus" ? "opus" : "codex",
      kind: String(payload.kind || "activity"),
      text: payload.text == null ? "" : String(payload.text)
    });
  }

  // Interrupt the in-flight turn WITHOUT killing the session: send Claude's
  // stream-json interrupt control-request on the live child's stdin (the same
  // mechanism the Agent SDK's interrupt() uses). The process stays up so the
  // user can immediately type the next turn — unlike stop(), which kills it.
  function mode(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    if (!state) return;
    state.mode = normalizeFusionRunMode(payload.mode);
    if (state.launchPayload) {
      state.launchPayload.mode = state.mode;
    }
  }

  function settings(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    if (!state) return;
    const plannerFast = payload.plannerFast === true;
    if (state.launchPayload) {
      state.launchPayload.plannerFast = plannerFast;
    }
    if (state.engine === "codex" && state.brain?.setFast) {
      state.brain.setFast(plannerFast).catch((error) => {
        if (sessions.get(id) !== state) return;
        emitSessionEvent(id, state, {
          type: "activity",
          role: "opus",
          kind: "activity",
          text: `Could not update Codex planner fast serving: ${error.message || "planner is gone"}`
        });
      });
      return;
    }
    if (state.engine === "claude" && state.child?.stdin?.writable) {
      state.plannerFast = plannerFast;
      state.fastSeq = (state.fastSeq || 0) + 1;
      try {
        state.child.stdin.write(
          JSON.stringify({
            type: "control_request",
            request_id: `fast_${id}_${state.fastSeq}`,
            request: {
              subtype: "apply_flag_settings",
              settings: { fastMode: state.plannerFast }
            }
          }) + "\n"
        );
      } catch (error) {
        emitSessionEvent(id, state, {
          type: "activity",
          role: "opus",
          kind: "activity",
          text: `Could not update Claude planner fast serving: ${error.message || "planner is gone"}`
        });
      }
    }
  }

  function interrupt(payload) {
    const id = payload?.id;
    const state = sessions.get(id);
    if (!state || !state.child) return;

    if (state.engine === "codex") {
      // turn/interrupt aborts only the active turn; the app-server (and its
      // thread) stay up for the next input — same semantics as the claude
      // control_request path.
      emitSessionEvent(id, state, { type: "interrupted" });
      state.brain.interrupt().catch(() => {
        // best-effort; the user can still Restart as the hard stop.
      });
      return;
    }

    if (!state.child.stdin.writable) return;
    state.interruptSeq = (state.interruptSeq || 0) + 1;
    try {
      state.child.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id: `int_${id}_${state.interruptSeq}`,
          request: { subtype: "interrupt" }
        }) + "\n"
      );
      emitSessionEvent(id, state, { type: "interrupted" });
    } catch {
      // best-effort; the user can still Restart as the hard stop.
    }
  }

  function stop(payload) {
    const state = sessions.get(payload.id);
    if (state) {
      clearPlannerResultBackstop(state);
      killChild(state.child);
      sessions.delete(payload.id);
    }
  }

  function shutdown() {
    for (const state of sessions.values()) {
      clearPlannerResultBackstop(state);
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
      else if (msg.type === "activity") activity(msg.payload);
      else if (msg.type === "background-task") backgroundTask(msg.payload);
      else if (msg.type === "mode") mode(msg.payload);
      else if (msg.type === "settings") settings(msg.payload);
      else if (msg.type === "interrupt") interrupt(msg.payload);
      else if (msg.type === "stop") stop(msg.payload);
      else if (msg.type === "shutdown") shutdown();
    }
  });
  process.stdin.on("end", shutdown);

  emit({ type: "ready" });
}

function buildClaudeArgs(payload = {}) {
  const {
    cwd,
    mcpConfig,
    systemPromptFile,
    model,
    effort,
    settingsFile,
    tools,
    allowedTools,
    disallowedTools,
    permissionMode,
    strictMcpConfig,
    resumeId
  } = payload;
  const effectivePermissionMode =
    typeof permissionMode === "string" && permissionMode.trim()
      ? permissionMode.trim()
      : "acceptEdits";
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    effectivePermissionMode
  ];
  if (model) args.push("--model", String(model));
  if (effort) args.push("--effort", String(effort));
  if (settingsFile) args.push("--settings", String(settingsFile));
  if (tools) args.push("--tools", String(tools));
  if (allowedTools) args.push("--allowedTools", String(allowedTools));
  // Bash stays explicitly denied; execution/browser/image tools are kept out of
  // Claude's exposed surface with --tools and the Fusion-only MCP config.
  if (disallowedTools) args.push("--disallowedTools", String(disallowedTools));
  if (strictMcpConfig) args.push("--strict-mcp-config");
  if (mcpConfig) args.push("--mcp-config", String(mcpConfig));
  if (systemPromptFile) args.push("--append-system-prompt-file", String(systemPromptFile));
  if (cwd) args.push("--add-dir", String(cwd));
  if (resumeId) args.push("--resume", String(resumeId));
  return args;
}

function windowsCmdArg(value) {
  const raw = String(value);
  if (!raw) return '""';
  if (!/[\s%^&|<>()"]/.test(raw)) return raw;
  // Quote instead of caret-escaping: cmd.exe keeps ^ & | < > ( ) literal inside
  // double quotes, so a caret escape inside a quoted argument reaches the child
  // verbatim and corrupts it (e.g. --add-dir D:\repos\app^(old^)). Only embedded
  // quotes need escaping for the child's argv parser, along with the backslashes
  // directly before a quote and at the end (so the closing quote survives).
  // % cannot be escaped on a cmd command line at all; quoting at least keeps it
  // from splitting the argument.
  let escaped = "";
  let backslashes = 0;
  for (const ch of raw) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      escaped += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    escaped += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  escaped += "\\".repeat(backslashes * 2);
  return `"${escaped}"`;
}

function buildClaudeSpawn(payload = {}) {
  const args = buildClaudeArgs(payload);
  if (isWin) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", [CLAUDE_BIN, ...args].map(windowsCmdArg).join(" ")]
    };
  }
  return { command: CLAUDE_BIN, args };
}

module.exports = {
  buildClaudeArgs,
  buildClaudeSpawn,
  buildClaudeRehydrationEvents,
  buildCodexRehydrationEvents,
  buildFusionInputContent,
  buildBackgroundWakeText,
  parseBackgroundReportEnvelope,
  applyPlannerTurnSettleState,
  createStreamNormalizer,
  unwrapFusionUserText,
  windowsCmdArg,
  FUSION_BACKGROUND_REPORT_HEADER,
  FUSION_GATE_NUDGE
};

if (require.main === module) {
  runHost();
}
