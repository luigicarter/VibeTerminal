// Headless Claude chat host for Fusion panes.
//
// A child process of main (mirrors backend/ptyHost.cjs): it spawns and manages
// ONE headless `claude` per Fusion pane, keeps it alive for multi-turn (the
// M3.1 spike confirmed `--input-format stream-json` accepts ongoing stdin user
// turns), parses each claude's stream-json stdout into clean, high-level events,
// and speaks a JSONL control protocol with main over its own stdin/stdout.
//
// Control IN (from main, one JSON per line on stdin):
//   {type:"start",  payload:{id, cwd, mcpConfig, systemPromptFile, model, allowedTools, resumeId?}}
//   {type:"input",  payload:{id, text}}
//   {type:"stop",   payload:{id}}
//   {type:"shutdown"}
// Events OUT (to main, one JSON per line on stdout): {type:"event", id, event}
//   plus {type:"ready"} on boot and {type:"closed", id, code} per session exit.
//
// The stream-json normalizer is exported (createStreamNormalizer) so the parser
// smoke can test it with a recorded fixture — no Claude, no auth, no cost.

const { spawn, execFileSync } = require("child_process");

const isWin = process.platform === "win32";
const CLAUDE_BIN = process.env.VIBE_CLAUDE_BIN || "claude";

// ---- stream-json normalizer (pure, per-session state) ----
// Turns the raw Anthropic stream-json line objects into high-level chat events.
function createStreamNormalizer() {
  let block = null; // { kind: "text"|"thinking"|"tool_use", toolId?, name?, jsonBuf? }

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

    if (msg.type === "result") {
      events.push({
        type: "result",
        subtype: msg.subtype,
        usage: msg.usage,
        costUsd: msg.total_cost_usd
      });
      return events;
    }

    // A tool_result fed back into the conversation (e.g. codex_implement's reply).
    if (msg.type === "user" && msg.message && Array.isArray(msg.message.content)) {
      for (const part of msg.message.content) {
        if (part && part.type === "tool_result") {
          events.push({
            type: "tool-result",
            toolId: part.tool_use_id,
            text:
              typeof part.content === "string"
                ? part.content
                : JSON.stringify(part.content)
          });
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
        if (d.type === "text_delta") {
          if (block && block.kind === "thinking") {
            events.push({ type: "thinking", delta: d.text || "" });
          } else {
            events.push({ type: "assistant-text", delta: d.text || "" });
          }
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
  const sessions = new Map(); // id -> { child, normalizer, buffer }

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

  function start(payload) {
    const { id, cwd, mcpConfig, systemPromptFile, model, allowedTools, resumeId } = payload;
    if (sessions.has(id)) {
      killChild(sessions.get(id).child);
      sessions.delete(id);
    }

    const launch = buildClaudeSpawn(payload);
    const child = spawn(launch.command, launch.args, {
      cwd: cwd || undefined,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    const normalizer = createStreamNormalizer();
    const state = { child, normalizer, buffer: "" };
    sessions.set(id, state);

    child.stdout.on("data", (chunk) => {
      state.buffer += chunk.toString("utf8");
      let index;
      while ((index = state.buffer.indexOf("\n")) !== -1) {
        const line = state.buffer.slice(0, index).trim();
        state.buffer = state.buffer.slice(index + 1);
        if (!line) continue;
        for (const event of normalizer(line)) {
          emit({ type: "event", id, event });
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      emit({ type: "event", id, event: { type: "stderr", text: chunk.toString("utf8") } });
    });
    child.on("error", (error) => {
      emit({ type: "event", id, event: { type: "error", message: error.message } });
    });
    child.on("exit", (code) => {
      sessions.delete(id);
      emit({ type: "closed", id, code });
    });
  }

  function input(payload) {
    const state = sessions.get(payload.id);
    if (!state) return;
    try {
      state.child.stdin.write(
        JSON.stringify({ type: "user", message: { role: "user", content: payload.text } }) + "\n"
      );
    } catch {
      // child gone
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
      else if (msg.type === "stop") stop(msg.payload);
      else if (msg.type === "shutdown") shutdown();
    }
  });
  process.stdin.on("end", shutdown);

  emit({ type: "ready" });
}

function buildClaudeArgs(payload = {}) {
  const { cwd, mcpConfig, systemPromptFile, model, allowedTools, resumeId } = payload;
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "acceptEdits"
  ];
  if (model) args.push("--model", String(model));
  if (allowedTools) args.push("--allowedTools", String(allowedTools));
  if (mcpConfig) args.push("--mcp-config", String(mcpConfig));
  if (systemPromptFile) args.push("--append-system-prompt-file", String(systemPromptFile));
  if (cwd) args.push("--add-dir", String(cwd));
  if (resumeId) args.push("--resume", String(resumeId));
  return args;
}

function windowsCmdArg(value) {
  const raw = String(value);
  if (!raw) return '""';
  const escaped = raw.replace(/([%^&|<>()"])/g, "^$1");
  return /[\s%^&|<>()"]/.test(raw) ? `"${escaped}"` : escaped;
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
