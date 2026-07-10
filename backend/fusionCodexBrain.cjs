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
// Protocol facts (generated v2 schema, codex-cli 0.144.0):
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
const { modelCatalogEntry, resolveCodexEffortForModel } = require("./codexModels.cjs");

const FUSION_BRIDGE_SERVER = "fusion-codex";
const BACKGROUND_TASK_STATUS_GUIDANCE = [
  "While a background task runs, use codex_task_status (optionally with its taskId) to peek at progress when the user asks how it is going.",
  "Peeking is read-only and never replaces reviewing the final FUSION BACKGROUND TASK REPORT."
].join("\n");
const RPC_TIMEOUT_MS = 30_000;
const THREAD_RPC_TIMEOUT_MS = 60_000;
const FAST_SERVICE_TIER = "priority";

function fastTierForModel(models, modelId) {
  const entry = modelCatalogEntry(models, modelId);
  if (!entry) return FAST_SERVICE_TIER;
  const tiers = Array.isArray(entry.serviceTiers)
    ? entry.serviceTiers
    : Array.isArray(entry.service_tiers)
      ? entry.service_tiers
      : [];
  return tiers.some((tier) => tier && tier.id === FAST_SERVICE_TIER)
    ? FAST_SERVICE_TIER
    : null;
}

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
      } else if (item.type === "commandExecution" && msg.method === "item/completed") {
        // Observe-only completion-gate evidence: the codex planner's native
        // read-only shell (git status/diff/log/show, file reads) never renders
        // in the pane, but without this event the gate tracker could not see
        // the planner's independent checks and every codex-planner delegation
        // would read as unverified. commandActions is the app-server's parsed
        // view (read actions carry the absolute path).
        events.push({
          type: "native-tool",
          name: "bash",
          command: String(item.command || ""),
          actions: Array.isArray(item.commandActions) ? item.commandActions : [],
          ok: item.status === "completed" && (item.exitCode === 0 || item.exitCode == null)
        });
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
  const toolTimeoutSec = Number(entry.tool_timeout_sec);
  return {
    mcp_servers: {
      [FUSION_BRIDGE_SERVER]: {
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args : [],
        env: entry.env && typeof entry.env === "object" ? entry.env : {},
        ...(Number.isFinite(toolTimeoutSec) && toolTimeoutSec > 0
          ? { tool_timeout_sec: toolTimeoutSec }
          : {})
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
    plannerFast,
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
  let activeModel = model ? String(model) : null;
  let fastServing = plannerFast === true;
  let modelCatalog = null;
  let modelCatalogLoaded = false;
  let lastEffortFallbackKey = "";
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

  async function readModelCatalog() {
    if (modelCatalogLoaded) return modelCatalog;
    modelCatalogLoaded = true;
    try {
      const models = [];
      let cursor = null;
      do {
        const result = await rpc("model/list", {
          includeHidden: true,
          limit: 500,
          ...(cursor ? { cursor } : {})
        });
        if (Array.isArray(result?.data)) {
          models.push(...result.data);
        }
        cursor = result?.nextCursor || null;
      } while (cursor);
      modelCatalog = models;
    } catch {
      modelCatalog = null;
    }
    return modelCatalog;
  }

  async function desiredFastServiceTier() {
    if (!fastServing) return null;
    return fastTierForModel(await readModelCatalog(), activeModel);
  }

  function noteFastUnsupported() {
    emitEvent({
      type: "activity",
      role: "opus",
      kind: "activity",
      text: "Codex planner fast serving is not available for this model; using standard serving."
    });
  }

  function noteEffortFallback(resolution) {
    const resolvedModel = resolution.model || "the selected Codex model";
    const key = `${resolvedModel}:${resolution.requested}:${resolution.effort}`;
    if (lastEffortFallbackKey === key) return;
    lastEffortFallbackKey = key;
    emitEvent({
      type: "activity",
      role: "opus",
      kind: "activity",
      text: `planning effort ${resolution.requested} is unavailable for ${resolvedModel}; using ${resolution.effort}`
    });
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
    developerInstructions = [developerInstructions.trim(), BACKGROUND_TASK_STATUS_GUIDANCE]
      .filter(Boolean)
      .join("\n\n");
    const baseParams = {
      cwd: cwd || undefined,
      sandbox: "read-only",
      approvalPolicy: "never",
      developerInstructions: developerInstructions || undefined,
      config: {
        ...bridgeConfigFromMcpFile(mcpConfigPath),
        "features.fast_mode": true
      }
    };
    if (model) {
      baseParams.model = String(model);
      threadModelPinned = true;
    }
    const serviceTier = await desiredFastServiceTier();
    baseParams.serviceTier = serviceTier;
    if (fastServing && !serviceTier) {
      noteFastUnsupported();
    }

    if (resumeId) {
      try {
        const resumed = await rpc(
          "thread/resume",
          { threadId: String(resumeId), ...baseParams },
          THREAD_RPC_TIMEOUT_MS
        );
        threadId = (resumed && resumed.thread && resumed.thread.id) || String(resumeId);
        activeModel = (resumed && resumed.model) || activeModel;
        if (fastServing && serviceTier && resumed?.serviceTier !== serviceTier) {
          noteFastUnsupported();
        }
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
    activeModel = (started && started.model) || activeModel;
    if (fastServing && serviceTier && started?.serviceTier !== serviceTier) {
      noteFastUnsupported();
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
    if (effort) {
      const effortResolution = resolveCodexEffortForModel(
        await readModelCatalog(),
        model || activeModel,
        effort
      );
      if (effortResolution.effort) {
        params.effort = effortResolution.effort;
        if (effortResolution.requested !== effortResolution.effort) {
          noteEffortFallback(effortResolution);
        }
      }
    }
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

  async function setFast(next) {
    fastServing = next === true;
    await ready;
    if (!threadId) return false;
    const serviceTier = await desiredFastServiceTier();
    await rpc("thread/settings/update", {
      threadId,
      serviceTier
    });
    if (fastServing && !serviceTier) {
      noteFastUnsupported();
    }
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
    setFast,
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
