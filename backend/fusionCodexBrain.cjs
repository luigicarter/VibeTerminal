// Codex-family PLANNER engine for Fusion panes (backend/fusionChatHost.cjs).
//
// When a Fusion pane's planner family is "codex", the chat host spawns ONE
// `codex app-server` (stdio JSON-RPC) per pane instead of a headless `claude`,
// starts a thread that:
//   - hosts this pane's fusion-adapter as an MCP server (config.mcp_servers —
//     the same {command,args,env} entry the claude path passes via
//     --mcp-config), so the codex planner delegates through the SAME
//     codex_* bridge tools;
//   - carries the Fusion architect prompt as developerInstructions;
//   - runs under the READ-ONLY sandbox with approvalPolicy "never" — the hard
//     planner read-only lock, family-equivalent of the claude path's closed
//     --tools surface. (Live-verified 2026-07-03 on codex-cli 0.142.5: MCP
//     tool calls execute under sandbox read-only; shell writes cannot.)
//
// The normalizer translates app-server notifications into the EXACT pane
// event vocabulary the claude stream normalizer emits (session, turn-start,
// assistant-text, thinking, tool-call, tool-result, turn-end, result,
// turn-error), so the renderer, telemetry, and replay work unchanged.
//
// Protocol facts (generated v2 schema, codex-cli 0.142.5):
//   - turn terminal states ride in turn/completed: turn.status is
//     completed | interrupted | failed (no separate turn/failed method).
//   - MCP tool calls raise mcpServer/elicitation/request even under
//     approvalPolicy "never"; an unanswered elicitation wedges the thread on
//     waitingOnApproval, so the fusion bridge is auto-accepted and every
//     other server is declined.
//   - turn/steer takes {threadId, expectedTurnId, input:[...]} and may return
//     a new turn id.

const { spawn } = require("child_process");
const fs = require("fs");

const FUSION_BRIDGE_SERVER = "fusion-codex";
const RPC_TIMEOUT_MS = 30_000;
const THREAD_RPC_TIMEOUT_MS = 60_000;

function textInput(content) {
  return [{ type: "text", text: String(content ?? ""), text_elements: [] }];
}

function mcpToolCallResultText(item) {
  if (item.error) {
    return typeof item.error === "string" ? item.error : JSON.stringify(item.error);
  }
  const content = item.result && item.result.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (text) return text;
  }
  try {
    return JSON.stringify(item.result ?? null);
  } catch {
    return String(item.result);
  }
}

// ---- pure notification normalizer (exported for the parse smoke) ----
// normalize(msg) -> { events, reply } where `reply` is a complete JSON-RPC
// response object the caller must write back (elicitations / unsupported
// server requests), and `events` are pane-vocabulary events to emit.
function createCodexBrainNormalizer() {
  let sessionEmitted = false;
  let activeTurnId = null;
  let latestUsage = null;
  let lastErrorMessage = "";
  let interruptRequested = false;

  function normalize(msg) {
    const events = [];
    let reply;
    if (!msg || typeof msg !== "object") {
      return { events, reply };
    }

    // Server -> client REQUEST (has both id and method): must be answered or
    // the thread wedges on waitingOnApproval.
    if (msg.id !== undefined && typeof msg.method === "string") {
      if (msg.method === "mcpServer/elicitation/request") {
        const fromBridge = msg.params && msg.params.serverName === FUSION_BRIDGE_SERVER;
        reply = {
          jsonrpc: "2.0",
          id: msg.id,
          result: fromBridge ? { action: "accept", content: {} } : { action: "decline" }
        };
      } else {
        reply = {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `unsupported server request: ${msg.method}` }
        };
        events.push({
          type: "stderr",
          text: `[fusion-brain] declined server request ${msg.method}\n`
        });
      }
      return { events, reply };
    }

    if (typeof msg.method !== "string") {
      return { events, reply };
    }
    const params = msg.params || {};

    if (msg.method === "thread/started") {
      const threadId = params.thread && params.thread.id;
      if (threadId && !sessionEmitted) {
        sessionEmitted = true;
        events.push({ type: "session", sessionId: threadId });
      }
      return { events, reply };
    }

    if (msg.method === "turn/started") {
      activeTurnId = (params.turn && params.turn.id) || null;
      lastErrorMessage = "";
      events.push({ type: "turn-start" });
      return { events, reply };
    }

    if (msg.method === "item/agentMessage/delta") {
      events.push({ type: "assistant-text", delta: params.delta || "" });
      return { events, reply };
    }

    if (/reasoning/i.test(msg.method) && /delta/i.test(msg.method)) {
      events.push({ type: "thinking", delta: params.delta || params.text || "" });
      return { events, reply };
    }

    if (msg.method === "item/started" || msg.method === "item/completed") {
      const item = params.item || {};
      if (item.type === "mcpToolCall") {
        if (msg.method === "item/started") {
          events.push({
            type: "tool-call",
            toolId: item.id,
            name:
              item.server === FUSION_BRIDGE_SERVER
                ? `mcp__${FUSION_BRIDGE_SERVER}__${item.tool}`
                : `${item.server}__${item.tool}`,
            input: item.arguments || {}
          });
        } else {
          events.push({
            type: "tool-result",
            toolId: item.id,
            text: mcpToolCallResultText(item),
            isError: Boolean(item.error)
          });
        }
      }
      return { events, reply };
    }

    if (msg.method === "thread/tokenUsage/updated") {
      latestUsage = params.tokenUsage || null;
      return { events, reply };
    }

    // Transient model errors (willRetry) surface as diagnostics only; fatal
    // ones are remembered for the failed turn/completed that follows.
    if (msg.method === "error") {
      const message =
        (params.error && params.error.message) || params.message || "Codex planner error";
      if (params.willRetry) {
        events.push({
          type: "stderr",
          text: `[fusion-brain] transient error (retrying): ${message}\n`
        });
      } else {
        lastErrorMessage = String(message);
      }
      return { events, reply };
    }

    if (msg.method === "mcpServer/startupStatus/updated") {
      if (params.status === "error") {
        events.push({
          type: "stderr",
          text: `[fusion-brain] MCP server ${params.name || "?"} failed to start: ${
            params.error || "unknown error"
          }\n`
        });
      }
      return { events, reply };
    }

    if (msg.method === "turn/completed") {
      const turn = params.turn || {};
      activeTurnId = null;
      const status = turn.status;
      if (status === "failed") {
        const message =
          (turn.error && turn.error.message) ||
          lastErrorMessage ||
          "Fusion planner turn failed.";
        events.push({ type: "turn-error", message });
        events.push({ type: "result", subtype: "error", isError: true });
      } else if (status === "interrupted") {
        // The pane already showed "interrupted" when the user asked for it —
        // an interrupted turn must not read as a failure.
        events.push({ type: "turn-end" });
        events.push({
          type: "result",
          subtype: "aborted",
          usage: latestUsage || undefined,
          isError: false
        });
      } else {
        events.push({ type: "turn-end" });
        events.push({
          type: "result",
          subtype: "success",
          usage: latestUsage || undefined,
          isError: false
        });
      }
      interruptRequested = false;
      return { events, reply };
    }

    return { events, reply };
  }

  return {
    normalize,
    noteInterruptRequested() {
      interruptRequested = true;
    },
    wasInterruptRequested() {
      return interruptRequested;
    },
    getActiveTurnId() {
      return activeTurnId;
    }
  };
}

// Reads the claude-path --mcp-config file and returns the fusion bridge
// server entry as a codex config override table.
function bridgeConfigFromMcpFile(mcpConfigPath) {
  const parsed = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8"));
  const servers = parsed && parsed.mcpServers ? parsed.mcpServers : {};
  const entry = servers[FUSION_BRIDGE_SERVER] || servers[Object.keys(servers)[0]];
  if (!entry || !entry.command) {
    throw new Error(`no MCP server entry found in ${mcpConfigPath}`);
  }
  return {
    mcp_servers: {
      [FUSION_BRIDGE_SERVER]: {
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args : [],
        env: entry.env && typeof entry.env === "object" ? entry.env : {}
      }
    }
  };
}

// ---- the live session wrapper (spawns and drives one app-server child) ----
function createCodexBrainSession(options) {
  const {
    cwd,
    codexBin,
    mcpConfigPath,
    systemPromptFile,
    model,
    effort,
    resumeId,
    emitEvent
  } = options;

  const isWin = process.platform === "win32";
  const bin = codexBin || "codex";
  let child;
  if (bin === "codex") {
    // PATH fallback (dev builds): resolve through the shell like the adapter.
    const shell = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const args = isWin ? ["/d", "/s", "/c", "codex app-server"] : ["-c", "codex app-server"];
    child = spawn(shell, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  } else {
    child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  }

  const normalizer = createCodexBrainNormalizer();
  const pendingReq = new Map();
  let nextRequestId = 1;
  let buffer = "";
  let threadId = null;
  let threadModelPinned = false;
  let stopped = false;

  function send(obj) {
    if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error("Fusion planner process is not writable.");
    }
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  function rpc(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingReq.delete(id)) {
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, timeoutMs);
      pendingReq.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        method
      });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pendingReq.delete(id);
        reject(error);
      }
    });
  }

  function notify(method, params) {
    send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  function failAllPending(message) {
    for (const [, entry] of pendingReq) {
      entry.reject(new Error(message));
    }
    pendingReq.clear();
  }

  function handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // Response to one of our requests: no method, matching id.
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = pendingReq.get(msg.id);
      if (entry) {
        pendingReq.delete(msg.id);
        if (msg.error) {
          entry.reject(
            new Error(`${entry.method}: ${msg.error.message || JSON.stringify(msg.error)}`)
          );
        } else {
          entry.resolve(msg.result);
        }
      }
      return;
    }
    const { events, reply } = normalizer.normalize(msg);
    if (reply) {
      try {
        send(reply);
      } catch {
        // child is gone; exit handling will surface it
      }
    }
    for (const event of events) {
      emitEvent(event);
    }
  }

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    emitEvent({ type: "stderr", text: chunk.toString("utf8") });
  });
  child.on("error", (error) => {
    failAllPending(error.message);
    emitEvent({ type: "error", message: `Fusion planner failed to start: ${error.message}` });
  });
  child.on("exit", () => {
    failAllPending("Fusion planner process exited.");
  });

  async function boot() {
    await rpc("initialize", {
      clientInfo: { name: "vibeTerminal-fusion-brain", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    notify("initialized");

    let developerInstructions = "";
    try {
      developerInstructions = fs.readFileSync(systemPromptFile, "utf8");
    } catch {
      // A missing prompt file must not kill the pane; the planner just runs
      // without the architect contract (and the adapter still enforces mode).
    }
    const baseParams = {
      cwd: cwd || undefined,
      sandbox: "read-only",
      approvalPolicy: "never",
      developerInstructions: developerInstructions || undefined,
      config: bridgeConfigFromMcpFile(mcpConfigPath)
    };
    if (model) {
      baseParams.model = String(model);
      threadModelPinned = true;
    }

    if (resumeId) {
      try {
        const resumed = await rpc(
          "thread/resume",
          { threadId: String(resumeId), ...baseParams },
          THREAD_RPC_TIMEOUT_MS
        );
        threadId = (resumed && resumed.thread && resumed.thread.id) || String(resumeId);
        emitEvent({ type: "session", sessionId: threadId });
        return;
      } catch (error) {
        emitEvent({
          type: "activity",
          role: "opus",
          kind: "activity",
          text: `The saved Fusion chat could not be resumed (${error.message}). Starting a fresh chat instead.`
        });
      }
    }

    const started = await rpc("thread/start", baseParams, THREAD_RPC_TIMEOUT_MS);
    threadId = started && started.thread && started.thread.id;
    if (!threadId) {
      throw new Error("thread/start returned no thread id");
    }
    emitEvent({ type: "session", sessionId: threadId });
  }

  const ready = boot().catch((error) => {
    emitEvent({
      type: "error",
      message: `Fusion planner failed to start: ${error.message}`
    });
    throw error;
  });
  // The catch above is the user-facing surface; avoid an unhandled rejection
  // when nobody else awaits ready.
  ready.catch(() => {});

  async function sendInput(content, steer) {
    await ready;
    const activeTurnId = normalizer.getActiveTurnId();
    if (activeTurnId) {
      // Mid-turn: steer the ACTIVE turn (turn/start would be rejected).
      const response = await rpc("turn/steer", {
        threadId,
        expectedTurnId: activeTurnId,
        input: textInput(content)
      });
      return { transport: "steer", response };
    }
    const params = {
      threadId,
      input: textInput(content),
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" }
    };
    if (effort) params.effort = String(effort);
    if (model && !threadModelPinned) params.model = String(model);
    const response = await rpc("turn/start", params);
    return { transport: steer ? "queued-steer" : "turn", response };
  }

  async function interrupt() {
    const activeTurnId = normalizer.getActiveTurnId();
    if (!threadId || !activeTurnId) return false;
    normalizer.noteInterruptRequested();
    await rpc("turn/interrupt", { threadId, turnId: activeTurnId });
    return true;
  }

  function markStopped() {
    stopped = true;
  }

  return {
    child,
    ready,
    sendInput,
    interrupt,
    markStopped,
    isStopped: () => stopped,
    getThreadId: () => threadId
  };
}

module.exports = {
  FUSION_BRIDGE_SERVER,
  bridgeConfigFromMcpFile,
  createCodexBrainNormalizer,
  createCodexBrainSession
};
