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
const http = require("http");
const { windowsCmdArg } = require("./fusionChatHost.cjs");

const isWin = process.platform === "win32";
const OPENCODE_BIN = process.env.VIBE_OPENCODE_BIN || "opencode";
const MAX_HISTORY_EVENTS = 20_000;
const MAX_TOOL_OUTPUT_CHARS = 20_000;
const PORT_TIMEOUT_MS = 30_000;
const SSE_RETRY_MS = 1_500;
const SSE_MAX_RETRIES = 5;

function clipText(value, max = MAX_TOOL_OUTPUT_CHARS) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text;
}

function splitModelId(model) {
  const raw = String(model || "").trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  // Model ids may themselves contain "/" (openrouter/google/gemini-…): the
  // provider is only the FIRST segment.
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
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
    if (text.length > progress.emitted) {
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
        const delta = String(props.delta ?? "");
        if (!delta) break;
        progressFor(partId).emitted += delta.length;
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
        // Register task-spawned child sessions from tool metadata too — the
        // session.created event can arrive after the first child part.
        if (name === "task" && metadata.sessionId && !inTree(metadata.sessionId)) {
          const input = state.input && typeof state.input === "object" ? state.input : {};
          tree.set(String(metadata.sessionId), {
            agent: String(input.subagent_type || "executor"),
            title: String(state.title || "")
          });
        }
        const previous = toolStatus.get(callID);
        if (status === "pending" || status === "running") {
          if (previous === "called" || previous === "done") break;
          toolStatus.set(callID, "called");
          events.push({
            type: "tool-call",
            toolId: callID,
            name,
            role,
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
            ok: status === "completed",
            title: String(state.title || ""),
            text: clipText(status === "completed" ? state.output : state.error || state.output)
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
      const text = parts
        .filter((part) => part && part.type === "text")
        .map((part) => String(part.text || ""))
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
        events.push({
          type: "tool-call",
          toolId: callID,
          name,
          role: "brain",
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
            text: clipText(state.status === "completed" ? state.output : state.error || state.output)
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
    for (const event of state.history) {
      emit({ type: "event", id, event });
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
            if (!state.normalizer) continue;
            for (const event of state.normalizer(parsed)) {
              // Track turn state so auth changes never dispose an instance
              // with a delegation in flight (dispose is safe for idle panes).
              if (event.type === "turn-start") state.turnBusy = true;
              else if (
                event.type === "result" ||
                event.type === "interrupted" ||
                event.type === "error"
              ) {
                state.turnBusy = false;
              }
              emitSessionEvent(id, state, event);
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
    const created = await request(state, "POST", "/session", { title: "vibeTerminal Open Fusion" });
    if (!created || !created.id) throw new Error("OpenCode did not return a session id");
    state.sessionId = String(created.id);
    state.normalizer = createOpenCodeEventNormalizer(state.sessionId);
    connectEvents(id, state);
    emitSessionEvent(id, state, { type: "session", sessionId: state.sessionId });
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
    const launch = buildServeSpawn(env && typeof env === "object" ? env : {}, cwd, password);
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
      sessionId: "",
      normalizer: null,
      sseRequest: null,
      sseRetries: 0,
      sseGeneration: 0,
      stopping: false,
      stdoutBuffer: "",
      turnBusy: false,
      history: [],
      plannerModel: String(payload.plannerModel || ""),
      executorModel: String(payload.executorModel || "")
    };
    sessions.set(id, state);

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
    if (!state.child || !state.sessionId) {
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

    // Mid-turn sends are legal steering: the server persists the message
    // immediately and the running loop absorbs it at its next step (verified
    // 1.17.11 `ensureRunning` semantics). Tag the echo so the pane can pin it
    // above the composer instead of burying it in the streaming transcript.
    const queued = Boolean(state.turnBusy);
    emitSessionEvent(id, state, queued ? { type: "user", text, queued: true } : { type: "user", text });
    const body = { agent: "planner", parts: [{ type: "text", text }], model };
    request(state, "POST", `/session/${encodeURIComponent(state.sessionId)}/prompt_async`, body).catch(
      (error) => {
        if (sessions.get(id) !== state) return;
        emitSessionEvent(id, state, {
          type: "error",
          message: `Could not send the turn: ${error.message}`
        });
      }
    );
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
      if (s.turnBusy) {
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
        emitSessionEvent(id, state, { type: "interrupted" });
      })
      .catch(() => {
        // best-effort; the user can still Restart as the hard stop.
      });
  }

  function stop(payload) {
    const state = sessions.get(payload?.id);
    if (state) {
      state.stopping = true;
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
    for (const state of sessions.values()) {
      state.stopping = true;
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
      else if (msg.type === "planner-model") plannerModel(msg.payload);
      else if (msg.type === "providers") providers(msg.payload);
      else if (msg.type === "auth-set") authSet(msg.payload);
      else if (msg.type === "auth-remove") authRemove(msg.payload);
      else if (msg.type === "oauth-authorize") oauthAuthorize(msg.payload);
      else if (msg.type === "oauth-callback") oauthCallback(msg.payload);
      else if (msg.type === "custom-provider-set") customProviderSet(msg.payload);
      else if (msg.type === "custom-provider-remove") customProviderRemove(msg.payload);
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
  normalizeAuthMethods,
  splitModelId
};

if (require.main === module) {
  runHost();
}
