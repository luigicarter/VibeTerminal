// Per-pane Fusion adapter: a thin bridge between Opus (the Claude pane) and this
// pane's OWN embedded Codex app-server (ONE instance per Fusion terminal).
//
//   Opus  ──stdio MCP──▶  this adapter  ──stdio JSON-RPC──▶  codex app-server (child)
//
// North side: a hand-rolled MCP stdio server exposing two tools to Opus:
//   - codex_implement(task): run a Codex turn; returns {status:"completed",...}
//     OR {status:"needs_decision", pendingId, ...} OR {status:"failed",...}.
//   - codex_respond(pendingId, decision, note?): answer a parked approval/
//     question, then continue the turn.
// South side: a JSON-RPC client over stdio to this pane's own app-server. It
// streams Codex's work back (relayed to the renderer's read-only Fusion log via
// the telemetry callback server) and parks only actionable approval requests so
// Opus decides them - never auto-approved here.
//
// stdout is the MCP channel: NOTHING but MCP JSON-RPC may be written there;
// all diagnostics go to stderr.

const http = require("http");
const { spawn } = require("child_process");

const isWin = process.platform === "win32";

// This pane's OWN embedded Codex binary (one instance per Fusion terminal).
// main resolves the bundled path. Packaged builds fail closed if it is absent;
// dev builds may pass PATH `codex` as a local fallback.
const CODEX_BIN = process.env.VIBE_FUSION_CODEX_BIN || "codex";
const CWD = process.env.VIBE_TERMINAL_FUSION_CWD || process.cwd();
const SESSION_ID = process.env.VIBE_TERMINAL_SESSION_ID;
const CALLBACK_URL = process.env.VIBE_TERMINAL_CALLBACK_URL;
const TOKEN = process.env.VIBE_TERMINAL_TELEMETRY_TOKEN;
const MODEL = process.env.VIBE_FUSION_CODEX_MODEL || null;
const REQUEST_TIMEOUT_MS = Number(process.env.VIBE_FUSION_RPC_TIMEOUT_MS || 30000);
const PARKED_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "execCommandApproval",
  "applyPatchApproval"
]);
const VERDICT_MARKER = "FUSION_VERDICT_JSON:";
const NEXT_ACTIONS = new Set(["continue", "ask_human", "done"]);

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item == null ? "" : String(item).trim()))
    .filter(Boolean);
}

function normalizeVerifierVerdict(raw, source = "parsed") {
  const bugsFound = normalizeStringList(raw && raw.bugsFound);
  const missingRequirements = normalizeStringList(raw && raw.missingRequirements);
  const hasBlockers = bugsFound.length > 0 || missingRequirements.length > 0;
  const rawGoalReached = raw && raw.goalReached === true;
  const requestedAction = raw && typeof raw.nextAction === "string" ? raw.nextAction : "";
  let nextAction = NEXT_ACTIONS.has(requestedAction)
    ? requestedAction
    : rawGoalReached && !hasBlockers
      ? "done"
      : "continue";
  if ((hasBlockers || !rawGoalReached) && nextAction === "done") {
    nextAction = "continue";
  }
  const goalReached = rawGoalReached && !hasBlockers && nextAction === "done";
  return {
    goalReached,
    bugsFound,
    missingRequirements,
    nextAction,
    summary: raw && raw.summary != null ? String(raw.summary).trim() : "",
    verdictSource: source
  };
}

function missingVerifierVerdict() {
  return normalizeVerifierVerdict(
    {
      goalReached: false,
      bugsFound: [],
      missingRequirements: ["Codex did not provide the required structured Fusion verifier verdict."],
      nextAction: "continue",
      summary: "Missing structured verifier verdict."
    },
    "missing"
  );
}

function extractVerifierVerdict(summary) {
  const lines = String(summary || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    const markerIndex = line.indexOf(VERDICT_MARKER);
    if (markerIndex === -1) continue;
    const jsonText = line.slice(markerIndex + VERDICT_MARKER.length).trim();
    try {
      return normalizeVerifierVerdict(JSON.parse(jsonText), "parsed");
    } catch {
      return normalizeVerifierVerdict(
        {
          goalReached: false,
          bugsFound: ["Codex returned malformed Fusion verifier JSON."],
          missingRequirements: ["Retry or ask Codex to produce valid verifier JSON."],
          nextAction: "continue",
          summary: "Malformed structured verifier verdict."
        },
        "malformed"
      );
    }
  }
  return missingVerifierVerdict();
}

function stripVerifierVerdictFromSummary(summary) {
  return String(summary || "")
    .split(/\r?\n/)
    .filter((line) => !line.includes(VERDICT_MARKER))
    .join("\n")
    .trim();
}

function buildCodexVerifierTask(task) {
  return [
    task,
    "",
    "## Fusion verifier contract",
    "You are Codex GPT-5.5 inside Terminal Fusion. You implement, run tests, debug, and verify whether the user's goal is actually reached.",
    "Claude/Opus may provide strategy, constraints, UI intent, debugging direction, and follow-up corrections; follow that guidance while still independently checking the result.",
    "Before your final answer, review the implementation for bugs, compile/runtime failures, missing requirements, and whether the original goal is complete.",
    "Your final answer MUST end with exactly one single-line JSON verdict prefixed by this marker:",
    `${VERDICT_MARKER} {"goalReached":false,"bugsFound":[],"missingRequirements":[],"nextAction":"continue","summary":""}`,
    "",
    "Verdict schema:",
    '- `goalReached`: true only when the requested goal is complete and no blocking bug remains.',
    '- `bugsFound`: concrete bugs or regressions still present.',
    '- `missingRequirements`: requested behavior or acceptance criteria still missing.',
    '- `nextAction`: "done" when complete, "continue" when Claude should redelegate/fix more, or "ask_human" when human input is required.',
    "- `summary`: one concise sentence explaining the verdict.",
    "",
    'If you are not sure the goal is complete, set `goalReached:false` and `nextAction:"continue"`.'
  ].join("\n");
}

function logErr(message) {
  try {
    process.stderr.write(`[fusion-adapter] ${message}\n`);
  } catch {
    // ignore
  }
}

// ---- read-only activity relay to the renderer (best-effort) ----
function relay(entry) {
  if (!CALLBACK_URL || !TOKEN || !SESSION_ID) return;
  try {
    const body = JSON.stringify({
      type: "fusion.activity",
      sessionId: SESSION_ID,
      ts: Date.now(),
      ...entry
    });
    const url = new URL(CALLBACK_URL);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      timeout: 1000,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-vibe-telemetry-token": TOKEN
      }
    });
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.end(body);
  } catch {
    // telemetry is best-effort
  }
}

// ---- south side: this pane's OWN Codex app-server (stdio JSON-RPC) ----
let codexChild = null;
let codexReady = null;
let codexBuffer = "";
let nextId = 1;
let threadId = null;
const pendingReq = new Map(); // app-server request id -> {resolve, reject}
const parked = new Map(); // pendingId -> {rpcId, method, params}
let currentTurn = null; // {resolve} — fulfilled by turn/completed | turn/failed | an approval request
let turnSummary = [];
let turnFiles = [];

// Spawn this pane's dedicated `codex app-server` (stdio transport). The boot
// smoke proved newline-delimited JSON-RPC over stdio works on every platform.
function connect() {
  if (codexReady) return codexReady;
  codexReady = new Promise((resolve, reject) => {
    let child;
    try {
      if (CODEX_BIN === "codex") {
        // Fallback: resolve from PATH via the shell (npm wrapper on Windows).
        const shell = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
        const args = isWin
          ? ["/d", "/s", "/c", "codex app-server"]
          : ["-c", "codex app-server"];
        child = spawn(shell, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } else {
        // Embedded binary: spawn the bundled codex directly.
        child = spawn(CODEX_BIN, ["app-server"], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        });
      }
    } catch (error) {
      reject(error);
      return;
    }

    codexChild = child;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(); // assume up; `initialize` surfaces any real failure
    }, 500);
    child.on("spawn", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
      failAll(error);
    });
    child.stdout.on("data", (chunk) => {
      codexBuffer += chunk.toString("utf8");
      let index;
      while ((index = codexBuffer.indexOf("\n")) !== -1) {
        const line = codexBuffer.slice(0, index).trim();
        codexBuffer = codexBuffer.slice(index + 1);
        if (!line) continue;
        try {
          handleSouth(JSON.parse(line));
        } catch {
          // ignore non-JSON lines
        }
      }
    });
    child.stderr.on("data", () => {});
    child.on("exit", () => {
      codexChild = null;
      codexReady = null;
      failAll(new Error("codex app-server exited"));
    });
  });
  return codexReady;
}

function codexSend(obj) {
  if (!codexChild || !codexChild.stdin || codexChild.stdin.destroyed || !codexChild.stdin.writable) {
    return false;
  }
  try {
    codexChild.stdin.write(`${JSON.stringify(obj)}\n`);
    return true;
  } catch (error) {
    failAll(error);
    return false;
  }
}

function killCodex() {
  if (!codexChild || codexChild.killed) return;
  if (isWin && codexChild.pid) {
    try {
      require("child_process").execFileSync(
        "taskkill",
        ["/pid", String(codexChild.pid), "/t", "/f"],
        { stdio: "ignore" }
      );
      return;
    } catch {
      // fall through
    }
  }
  try {
    codexChild.kill();
  } catch {
    // ignore
  }
}

function failAll(error) {
  for (const { reject } of pendingReq.values()) reject(error);
  pendingReq.clear();
  resolveTurn({ status: "failed", error: error.message });
}

// Send a request and await its response. South wire matches the boot smoke:
// { id, method, params } with no explicit jsonrpc field.
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReq.delete(id);
      reject(new Error(`Codex app-server request timed out: ${method}`));
    }, REQUEST_TIMEOUT_MS);
    pendingReq.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });
    if (!codexSend({ id, method, params })) {
      const pending = pendingReq.get(id);
      pendingReq.delete(id);
      if (pending) {
        pending.reject(new Error("Codex app-server stdin is not writable"));
      }
    }
  });
}

function notify(method, params) {
  return codexSend(params === undefined ? { method } : { method, params });
}

function resolveTurn(result) {
  if (!currentTurn) return;
  const turn = currentTurn;
  currentTurn = null;
  turn.resolve(result);
}

function handleSouth(msg) {
  if (msg.method && msg.id !== undefined && msg.id !== null) {
    handleServerRequest(msg); // approval / question (server→client request)
    return;
  }
  if (msg.method) {
    handleNotification(msg); // streamed item / turn lifecycle
    return;
  }
  const pending = pendingReq.get(msg.id); // response to one of our requests
  if (pending) {
    pendingReq.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message || "app-server error"));
    else pending.resolve(msg.result);
  }
}

function handleNotification(msg) {
  const method = msg.method;
  const params = msg.params || {};
  if (method === "item/completed" && params.item) {
    relayItem(params.item);
    accumulate(params.item);
    return;
  }
  if (method === "turn/completed") {
    const rawSummary = turnSummary.join("\n").trim();
    const verifierVerdict = extractVerifierVerdict(rawSummary);
    const displaySummary = stripVerifierVerdictFromSummary(rawSummary);
    resolveTurn({
      status: "completed",
      summary: displaySummary || verifierVerdict.summary || "(Codex returned no message.)",
      files: Array.from(new Set(turnFiles.filter(Boolean))),
      goalReached: verifierVerdict.goalReached,
      bugsFound: verifierVerdict.bugsFound,
      missingRequirements: verifierVerdict.missingRequirements,
      nextAction: verifierVerdict.nextAction,
      verifierSummary: verifierVerdict.summary,
      verifierVerdict
    });
    return;
  }
  if (method === "turn/failed" || method === "error") {
    const message =
      (params.error && params.error.message) || params.message || "Codex turn failed";
    resolveTurn({ status: "failed", error: message });
  }
}

function sendServerResult(id, result) {
  if (!codexSend({ id, result })) {
    resolveTurn({ status: "failed", error: "Codex app-server stdin is not writable" });
  }
}

function sendServerError(id, message, code = -32603) {
  codexSend({ id, error: { code, message } });
}

function unsupportedServerRequest(msg, message) {
  const text = message || `Codex app-server requested unsupported method: ${msg.method}`;
  relay({ role: "codex", kind: "unsupported_request", text });
  sendServerError(msg.id, text);
  resolveTurn({ status: "failed", error: text });
}

function handleServerRequest(msg) {
  const method = String(msg.method || "");
  const params = msg.params || {};

  if (method === "currentTime/read") {
    sendServerResult(msg.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
    return;
  }
  if (method === "mcpServer/elicitation/request") {
    sendServerResult(msg.id, { action: "decline", content: null, _meta: null });
    return;
  }
  if (method === "item/permissions/requestApproval") {
    relay({
      role: "codex",
      kind: "permission",
      text: "Codex requested extra permissions; Fusion denied the request."
    });
    sendServerResult(msg.id, { permissions: {}, scope: "turn" });
    return;
  }
  if (method === "item/tool/call") {
    sendServerResult(msg.id, {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "Fusion adapter does not support dynamic Codex tool calls."
        }
      ]
    });
    return;
  }
  if (method === "account/chatgptAuthTokens/refresh" || method === "attestation/generate") {
    unsupportedServerRequest(
      msg,
      `Codex app-server requested ${method}, which Fusion cannot satisfy in embedded mode.`
    );
    return;
  }
  if (!PARKED_REQUEST_METHODS.has(method)) {
    unsupportedServerRequest(msg);
    return;
  }

  const pendingId = `p${nextId++}`;
  parked.set(pendingId, { rpcId: msg.id, method, params });
  const detail = approvalDetail(method, params);
  relay({ role: "codex", kind: "approval", text: detail });
  resolveTurn({
    status: "needs_decision",
    pendingId,
    kind: approvalKind(method),
    detail
  });
}

function approvalKind(method) {
  if (method.endsWith("requestUserInput")) return "question";
  if (method.toLowerCase().includes("filechange") || method === "applyPatchApproval")
    return "patch";
  return "command";
}

function approvalDetail(method, params) {
  if (method.endsWith("requestUserInput")) {
    return (params.questions || [])
      .map((q) => q.question || q.header)
      .filter(Boolean)
      .join(" / ") || "Codex is asking a question.";
  }
  if (approvalKind(method) === "patch") {
    return params.reason || "Codex wants to apply a patch.";
  }
  const commandActions = Array.isArray(params.commandActions)
    ? params.commandActions.map((action) => action.command || action.type || "command").join(", ")
    : "";
  const command = params.command || commandActions || (params.command_actions && "command") || "a command";
  const reason = params.reason ? ` — ${params.reason}` : "";
  return `Codex wants to run ${command}${reason}`;
}

function relayItem(item) {
  const type = item.type;
  if (type === "agentMessage" && item.text) {
    relay({ role: "codex", kind: "message", text: item.text });
  } else if (type === "commandExecution") {
    const exit = item.exitCode != null ? ` (exit ${item.exitCode})` : "";
    relay({ role: "codex", kind: "command", text: `${item.command || "command"}${exit}` });
  } else if (type === "fileChange") {
    const files = (item.changes || [])
      .map((c) => `${c.type || "edit"} ${c.path || c.move_path || ""}`.trim())
      .join(", ");
    relay({ role: "codex", kind: "file", text: files || "file changes" });
  }
}

function accumulate(item) {
  if (item.type === "agentMessage" && item.text) turnSummary.push(item.text);
  if (item.type === "fileChange") {
    for (const c of item.changes || []) {
      if (c.path || c.move_path) turnFiles.push(c.path || c.move_path);
    }
  }
}

async function ensureThread() {
  if (threadId) return threadId;
  await connect();
  await rpc("initialize", {
    clientInfo: { name: "vibeTerminal-fusion-adapter", version: "0.1.0" },
    capabilities: { experimentalApi: true }
  });
  notify("initialized");
  const params = {
    cwd: CWD,
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "user"
  };
  if (MODEL) params.model = MODEL;
  const res = await rpc("thread/start", params);
  threadId = res && res.thread && res.thread.id;
  if (!threadId) throw new Error("thread/start returned no thread id");
  return threadId;
}

function awaitTurn() {
  return new Promise((resolve) => {
    currentTurn = { resolve };
  });
}

async function codexImplement(task) {
  if (!task) return { status: "error", error: "task is required" };
  await ensureThread();
  turnSummary = [];
  turnFiles = [];
  relay({ role: "opus", kind: "delegate", text: task });
  const done = awaitTurn();
  rpc("turn/start", {
    threadId,
    input: [{ type: "text", text: buildCodexVerifierTask(task), text_elements: [] }],
    approvalPolicy: "on-request",
    approvalsReviewer: "user"
  }).catch((error) => resolveTurn({ status: "failed", error: error.message }));
  return done;
}

function buildDecisionResult(method, params, decision, note) {
  if (method.endsWith("requestUserInput")) {
    const answers = {};
    for (const q of params.questions || []) {
      answers[q.id] = { answers: [note || ""] };
    }
    return { answers };
  }
  // Legacy ReviewDecision enum (execCommandApproval / applyPatchApproval).
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    const map = {
      accept: "approved",
      acceptForSession: "approved_for_session",
      decline: "denied",
      cancel: "abort"
    };
    return { decision: map[decision] || "denied" };
  }
  // v2 item/.../requestApproval decisions.
  const allowed = ["accept", "acceptForSession", "decline", "cancel"];
  return { decision: allowed.includes(decision) ? decision : "decline" };
}

async function codexRespond(pendingId, decision, note) {
  const item = parked.get(pendingId);
  if (!item) return { status: "error", error: `unknown pendingId: ${pendingId}` };
  parked.delete(pendingId);
  const result = buildDecisionResult(item.method, item.params, decision, note);
  relay({ role: "opus", kind: "decision", text: `${decision}` });
  const done = awaitTurn();
  if (!codexSend({ id: item.rpcId, result })) {
    resolveTurn({ status: "failed", error: "Codex app-server stdin is not writable" });
  }
  return done;
}

// ---- north side: MCP stdio server ----
const TOOLS = [
  {
    name: "codex_implement",
    description:
      "Delegate implementation, testing, compile/runtime fixing, refactors, repo navigation, bug review, or goal-completion verification to embedded Codex GPT-5.5. Opus 4.8 drives architecture, strategy, UX/UI build-out when appropriate, human-facing orchestration, and guidance for Codex on constraints, UI intent, debugging direction, and follow-up corrections. Codex follows that guidance while independently verifying bugs and goal completion. Returns one of: {status:'completed', summary, files, goalReached, bugsFound, missingRequirements, nextAction, verifierVerdict}; {status:'needs_decision', pendingId, kind, detail} - answer it with codex_respond; or {status:'failed', error}. If goalReached is false or nextAction is 'continue', continue/redelegate unless the human or an explicit Opus override says otherwise.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Complete, self-contained instructions for Codex: the files, the intent, constraints, acceptance criteria, and what to verify. Codex does not share your context."
        }
      },
      required: ["task"]
    }
  },
  {
    name: "codex_respond",
    description:
      "Answer a pending Codex approval or question returned by codex_implement, then continue the turn. For a command or patch approval, set decision to accept | acceptForSession | decline | cancel. For a clarifying question, set decision to 'accept' and put your answer in note. Returns the same result shapes as codex_implement.",
    inputSchema: {
      type: "object",
      properties: {
        pendingId: { type: "string" },
        decision: {
          type: "string",
          enum: ["accept", "acceptForSession", "decline", "cancel"]
        },
        note: { type: "string" }
      },
      required: ["pendingId", "decision"]
    }
  }
];

function sendMcp(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handleToolCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  try {
    let result;
    if (name === "codex_implement") {
      result = await codexImplement(String(args.task || ""));
    } else if (name === "codex_respond") {
      result = await codexRespond(
        String(args.pendingId || ""),
        String(args.decision || ""),
        args.note != null ? String(args.note) : ""
      );
    } else {
      sendMcp({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      return;
    }
    sendMcp({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    });
  } catch (error) {
    sendMcp({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          { type: "text", text: JSON.stringify({ status: "error", error: error.message }) }
        ],
        isError: true
      }
    });
  }
}

function handleMcpLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    sendMcp({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fusion-codex", version: "0.1.0" }
      }
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return; // notification — no reply
  }
  if (method === "tools/list") {
    sendMcp({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    void handleToolCall(id, params);
    return;
  }
  if (method === "ping") {
    sendMcp({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (id !== undefined && id !== null) {
    sendMcp({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

function startMcpServer() {
  let stdinBuffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdinBuffer += chunk;
    let index;
    while ((index = stdinBuffer.indexOf("\n")) !== -1) {
      const line = stdinBuffer.slice(0, index).trim();
      stdinBuffer = stdinBuffer.slice(index + 1);
      if (line) handleMcpLine(line);
    }
  });
  process.stdin.on("end", () => {
    killCodex();
    process.exit(0);
  });

  logErr(`started (codex=${CODEX_BIN}, session=${SESSION_ID || "?"})`);
}

module.exports = {
  VERDICT_MARKER,
  buildCodexVerifierTask,
  extractVerifierVerdict,
  normalizeVerifierVerdict,
  stripVerifierVerdictFromSummary
};

if (require.main === module) {
  startMcpServer();
}
