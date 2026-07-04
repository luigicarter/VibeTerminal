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
//   {type:"interrupt", payload:{id}}   ← abort the CURRENT turn, keep the session
//   {type:"stop",   payload:{id}}       ← kill the whole session process
//   {type:"shutdown"}
// Events OUT (to main, one JSON per line on stdout): {type:"event", id, event}
//   plus {type:"ready"} on boot. Session exits are event.type === "closed".
//
// The stream-json normalizer is exported (createStreamNormalizer) so the parser
// smoke can test it with a recorded fixture — no Claude, no auth, no cost.

const { spawn, execFileSync } = require("child_process");
const { createCodexBrainSession } = require("./fusionCodexBrain.cjs");

const isWin = process.platform === "win32";
const CLAUDE_BIN = process.env.VIBE_CLAUDE_BIN || "claude";
const MAX_HISTORY_EVENTS = 20_000;

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
    "Do not call codex_implement, codex_respond, codex_goal_set, codex_goal_clear, or any execution tool until the user switches this pane back to Auto mode.",
    "Execution is hard-blocked in the adapter while Plan mode is active."
  ].join("\n");
}

function buildFusionInputContent(text, mode, steer) {
  if (mode !== "plan") {
    return steer
      ? [
          "STEER CURRENT FUSION TURN:",
          text,
          "",
          "Incorporate this direction into the active response. If Codex is currently running, use this as steering for the next Codex decision, correction, or follow-up delegation instead of treating it as a separate new request."
        ].join("\n")
      : text;
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

// ---- stream-json normalizer (pure, per-session state) ----
// Turns the raw Anthropic stream-json line objects into high-level chat events.
function createStreamNormalizer() {
  let block = null; // { kind: "text"|"thinking"|"tool_use", toolId?, name?, jsonBuf? }
  let turnErrorEmitted = false;
  const activeBackgroundAgents = new Map();

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
          events.push({
            type: "tool-result",
            toolId: part.tool_use_id,
            text:
              typeof part.content === "string"
                ? part.content
                : JSON.stringify(part.content),
            // The pane's OpenCode-style tool rows settle red on real errors;
            // without this flag they could only guess from the result text.
            isError: Boolean(part.is_error)
          });
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
        events.push({ type: "turn-start" });
        break;
      case "content_block_start": {
        const cb = ev.content_block || {};
        if (cb.type === "tool_use") {
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
        events.push({ type: "turn-end" });
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

  function emitSessionEvent(id, state, event) {
    state.history.push(cloneEvent(event));
    if (state.history.length > MAX_HISTORY_EVENTS) {
      state.history.splice(0, state.history.length - MAX_HISTORY_EVENTS);
    }
    emit({ type: "event", id, event });
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

  function start(payload) {
    const { id, cwd } = payload;
    if (sessions.has(id)) {
      const existingState = sessions.get(id);
      if (existingState?.child) {
        existingState.mode = normalizeFusionRunMode(payload.mode);
        replaySession(id, existingState);
        return;
      }

      sessions.delete(id);
    }

    // Per-role families: a codex planner runs `codex app-server` behind the
    // same control protocol and event vocabulary as the headless claude.
    if (normalizeFusionPlannerFamily(payload.plannerFamily) === "codex") {
      startCodexBrain(payload);
      return;
    }

    const launch = buildClaudeSpawn(payload);
    const child = spawn(launch.command, launch.args, {
      cwd: cwd || undefined,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    const normalizer = createStreamNormalizer();
    const state = { child, normalizer, buffer: "", history: [], mode: normalizeFusionRunMode(payload.mode) };
    sessions.set(id, state);

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
      state.child = null;
      emitSessionEvent(id, state, { type: "closed", code });
    });
  }

  // Spawn and wire a codex-family planner: one `codex app-server` child per
  // pane, MCP-hosting this pane's fusion-adapter, normalized onto the SAME
  // event vocabulary as the claude stream path (history/replay included).
  function startCodexBrain(payload) {
    const { id, cwd } = payload;
    const state = {
      child: null,
      brain: null,
      engine: "codex",
      history: [],
      mode: normalizeFusionRunMode(payload.mode)
    };
    sessions.set(id, state);
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
        resumeId: payload.resumeId || undefined,
        emitEvent
      });
    } catch (error) {
      emitSessionEvent(id, state, {
        type: "error",
        message: `Fusion planner failed to start: ${error.message}`
      });
      return;
    }
    state.brain = brain;
    state.child = brain.child;
    brain.child.on("exit", (code) => {
      if (sessions.get(id) !== state) return;
      state.child = null;
      emitSessionEvent(id, state, { type: "closed", code });
    });
  }

  function input(payload) {
    const id = payload?.id;
    const text = String(payload?.text ?? "");
    const steer = Boolean(payload?.steer);
    const state = sessions.get(id);
    if (!state) {
      emitDirectSessionEvent(id, {
        type: "error",
        message: "Fusion session is not running. Restart Fusion to continue."
      });
      return;
    }

    if (!state.child) {
      emitSessionEvent(id, state, {
        type: "error",
        message: "Fusion process is closed. Restart Fusion to continue."
      });
      return;
    }

    if (state.engine === "codex") {
      emitSessionEvent(id, state, { type: "user", text, steer });
      const content = buildFusionInputContent(text, normalizeFusionRunMode(state.mode), steer);
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
      const content = buildFusionInputContent(text, normalizeFusionRunMode(state.mode), steer);
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
      killChild(state.child);
      sessions.delete(payload.id);
    }
  }

  function shutdown() {
    for (const { child } of sessions.values()) killChild(child);
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
      else if (msg.type === "mode") mode(msg.payload);
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

module.exports = { buildClaudeArgs, buildClaudeSpawn, createStreamNormalizer, windowsCmdArg };

if (require.main === module) {
  runHost();
}
