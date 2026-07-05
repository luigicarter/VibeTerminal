// Per-pane Fusion adapter: a thin bridge between Opus (the Claude pane) and this
// pane's OWN embedded Codex app-server (ONE instance per Fusion terminal).
//
//   Opus  ──stdio MCP──▶  this adapter  ──stdio JSON-RPC──▶  codex app-server (child)
//
// North side: a hand-rolled MCP stdio server exposing tools to Opus:
//   - codex_goal_set/get/clear: use Codex's native per-thread goal store.
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

const fs = require("fs");
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
const SETTINGS_FILE = process.env.VIBE_FUSION_CODEX_SETTINGS || null;
const ENV_CODEX_MODEL = process.env.VIBE_FUSION_CODEX_MODEL || null;
const ENV_CODEX_EFFORT = process.env.VIBE_FUSION_CODEX_EFFORT || null;
const RUN_MODE_FILE = process.env.VIBE_FUSION_RUN_MODE_FILE || null;
let runMode = normalizeFusionRunMode(process.env.VIBE_FUSION_RUN_MODE);
const FAST_SERVICE_TIER = "priority";

const EAGER_BOOT = process.env.VIBE_FUSION_EAGER_BOOT === "1";
const REQUEST_TIMEOUT_MS = Number(process.env.VIBE_FUSION_RPC_TIMEOUT_MS || 30000);
const TURN_IDLE_TIMEOUT_MS = (() => {
  // env="0" is truthy, so `Number(env || default)` would treat 0 as "disabled"
  // and silently remove the only idle backstop. Floor 0/NaN/negative to default.
  const n = Number(process.env.VIBE_FUSION_TURN_IDLE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 600000;
})();
const TURN_AFTER_COMMAND_TIMEOUT_MS = Number(
  process.env.VIBE_FUSION_TURN_AFTER_COMMAND_TIMEOUT_MS || 180000
);
// Absolute per-turn ceiling: armed once at turn start, never refreshed, and
// floored so env cannot disable it. Guarantees the turn waiter (`await done`)
// always resolves even if the refreshable idle watchdog is starved by progress
// churn (the broken-sandbox retry loop) or misconfigured to 0.
const TURN_HARD_TIMEOUT_MS = Math.max(
  Number(process.env.VIBE_FUSION_TURN_HARD_TIMEOUT_MS) || 900000,
  60000
);
const STEER_ROUTE_TIMEOUT_MS = Math.max(
  Number(process.env.VIBE_FUSION_STEER_ROUTE_TIMEOUT_MS) || 20000,
  5000
);
const PARKED_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "execCommandApproval",
  "applyPatchApproval"
]);
const CONTROL_MAX_BYTES = 16 * 1024;
const VERDICT_MARKER = "FUSION_VERDICT_JSON:";
const NEXT_ACTIONS = new Set(["continue", "ask_human", "done"]);
const GOAL_STATUSES = new Set([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete"
]);
const PRESERVED_GOAL_STATUSES = new Set(["blocked", "usageLimited", "budgetLimited"]);
const MAX_GOAL_OBJECTIVE_CHARS = 4000;

function fusionCodexSandboxPolicy() {
  return { type: "dangerFullAccess" };
}

// codex_investigate turns are read-only by contract AND, where the OS sandbox
// can actually bootstrap, by Codex's read-only sandbox. Live-verified
// 2026-07-01 (codex 0.142.4, Windows 11): the Windows sandbox runner still
// fails with CreateProcessAsUserW error 1312 before ANY command runs -
// including pure reads - so win32 keeps the full-access path and stays
// read-only by task contract only. VIBE_FUSION_INVESTIGATE_SANDBOX
// (read-only | full) overrides the platform gate in either direction.
function fusionCodexInvestigateSandboxPolicy() {
  const override = String(process.env.VIBE_FUSION_INVESTIGATE_SANDBOX || "")
    .trim()
    .toLowerCase();
  if (override === "full" || override === "danger-full-access") {
    return fusionCodexSandboxPolicy();
  }
  if (override === "read-only" || override === "readonly") {
    return { type: "readOnly" };
  }
  return process.platform === "win32"
    ? fusionCodexSandboxPolicy()
    : { type: "readOnly" };
}

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
      missingRequirements: ["The implementation did not provide the required structured Fusion verifier verdict."],
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
          bugsFound: ["The implementation returned malformed Fusion verifier JSON."],
          missingRequirements: ["Retry or ask for valid verifier JSON."],
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
    "Earlier turns in this thread may have been authored by a different engine or model - the user can switch families mid-thread. Judge the code and evidence in front of you, not the apparent authorship, and do not infer your own capabilities from a prior turn's byline.",
    "Within Fusion, picture/image generation and browser navigation/control/automation are Codex-owned execution work. Perform those delegated operations here and verify the resulting image or browser state.",
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
    'If you are not sure the goal is complete, set `goalReached:false` and `nextAction:"continue"`.',
    "Never fabricate, approximate, or reconstruct command or test output. If you did not actually run a command or test, say so and set `goalReached:false` rather than reporting an assumed result.",
    "",
    'If the task states it is one milestone of a larger plan, implement only that milestone and judge `goalReached` against the LARGER goal: report `goalReached:false` and `nextAction:"continue"` until the final milestone completes it, even when this milestone itself is done.'
  ].join("\n");
}

function buildCodexInvestigationTask(task) {
  return [
    task,
    "",
    "## Fusion investigation contract",
    "You are Codex GPT-5.5 doing a read-only scouting pass for Terminal Fusion.",
    "Gather the repo context Claude needs for architecture, UI/design decisions, or implementation planning.",
    "Prefer fast file discovery, targeted reads, and concise summaries over broad narration.",
    "Do not edit files, install packages, launch apps, or make irreversible changes.",
    "",
    "Return a concise report with:",
    "- Findings: concrete facts and constraints.",
    "- Files: relevant file paths and why they matter.",
    "- Snippets: short quoted or paraphrased code snippets only when they are essential.",
    "- Suggested next step: what Claude should decide or edit next."
  ].join("\n");
}

function normalizeGoalStatus(value, fallback = "active") {
  const status = value == null ? "" : String(value).trim();
  return GOAL_STATUSES.has(status) ? status : fallback;
}

function truncateGoalObjective(value) {
  const chars = String(value || "").trim().split("");
  return chars.slice(0, MAX_GOAL_OBJECTIVE_CHARS).join("");
}

function normalizeGoal(goal) {
  if (!goal || typeof goal !== "object") return null;
  return {
    threadId: goal.threadId || goal.thread_id || "",
    objective: String(goal.objective || ""),
    status: normalizeGoalStatus(goal.status),
    tokenBudget:
      goal.tokenBudget == null && goal.token_budget == null
        ? null
        : Number(goal.tokenBudget == null ? goal.token_budget : goal.tokenBudget),
    tokensUsed: Number(goal.tokensUsed == null ? goal.tokens_used || 0 : goal.tokensUsed),
    timeUsedSeconds: Number(
      goal.timeUsedSeconds == null ? goal.time_used_seconds || 0 : goal.timeUsedSeconds
    ),
    createdAt: Number(goal.createdAt == null ? goal.created_at || 0 : goal.createdAt),
    updatedAt: Number(goal.updatedAt == null ? goal.updated_at || 0 : goal.updatedAt)
  };
}

function goalText(goal) {
  if (!goal) return "No Codex goal is set.";
  return `${goal.status}: ${goal.objective}`;
}

function goalStatusForVerdict(verdict) {
  if (!verdict || typeof verdict !== "object") return null;
  if (verdict.goalReached && verdict.nextAction === "done") return "complete";
  return null;
}

function shouldReplaceGoalForTask(goal) {
  return !goal || goal.status === "complete";
}

function shouldAutoSyncGoalStatus(goal, status) {
  return Boolean(goal && status && !PRESERVED_GOAL_STATUSES.has(goal.status));
}

function goalsUnavailableResult(error) {
  goalFeatureAvailable = false;
  return {
    status: "failed",
    goalFeatureAvailable: false,
    error: error && error.message ? error.message : String(error || "Codex goals unavailable")
  };
}

function goalsSkippedResult(reason, goal = currentGoal) {
  return {
    status: "skipped",
    goalFeatureAvailable,
    reason,
    goal
  };
}

function logErr(message) {
  try {
    process.stderr.write(`[fusion-adapter] ${message}\n`);
  } catch {
    // ignore
  }
}

function cleanCodexSetting(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const normalized = text.toLowerCase();
  return normalized === "auto" || normalized === "default" ? null : text;
}

// Codex's effort enum is minimal..ultra with NO "max". Stale settings files
// and env values from before the per-engine effort split still carry "max";
// coerce here so they degrade to xhigh instead of failing every turn with an
// unknown-variant error.
function cleanCodexEffort(value) {
  const effort = cleanCodexSetting(value);
  return effort && effort.toLowerCase() === "max" ? "xhigh" : effort;
}

// Which engine family executes delegations: "codex" (app-server, the
// original) or "claude" (persistent headless claude child). Anything else in
// the settings file degrades to codex.
function cleanExecutorFamily(value) {
  return String(value || "").trim().toLowerCase() === "claude" ? "claude" : "codex";
}

// Claude executor model: "sonnet" is the executor default; the "fast"
// shorthand and auto/default all land there too.
function cleanClaudeExecutorModel(value) {
  const text = String(value || "").trim();
  if (!text) return "sonnet";
  const lower = text.toLowerCase();
  return lower === "auto" || lower === "default" || lower === "fast" ? "sonnet" : text;
}

// Claude executor effort: the claude --effort enum. Codex-only levels coerce
// to the nearest real level (minimal→low, ultra→max) so a family flip never
// launches claude with an unknown variant.
function cleanClaudeEffort(value) {
  const effort = cleanCodexSetting(value);
  if (!effort) return null;
  const lower = effort.toLowerCase();
  if (lower === "minimal") return "low";
  if (lower === "ultra") return "max";
  return ["low", "medium", "high", "xhigh", "max"].includes(lower) ? lower : null;
}

function readCodexSettings() {
  const fallback = {
    family: "codex",
    model: cleanCodexSetting(ENV_CODEX_MODEL),
    effort: cleanCodexEffort(ENV_CODEX_EFFORT),
    fast: false,
    source: "env"
  };
  if (!SETTINGS_FILE) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    const family = cleanExecutorFamily(parsed?.executorFamily);
    if (family === "claude") {
      return {
        family,
        model: cleanClaudeExecutorModel(parsed?.executorModel),
        effort: cleanClaudeEffort(parsed?.executorEffort),
        fast: parsed?.executorFast === true,
        source: "file"
      };
    }
    return {
      family,
      // executorModel/executorEffort are the canonical fields; legacy files
      // (pre-family builds) carry only codexModel/codexEffort.
      model: cleanCodexSetting(parsed?.executorModel ?? parsed?.codexModel),
      effort: cleanCodexEffort(parsed?.executorEffort ?? parsed?.codexEffort),
      fast: parsed?.executorFast === true,
      source: "file"
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logErr("could not read Fusion Codex settings file: " + error.message);
    }
    return fallback;
  }
}

function applyCodexModelSetting(params, settings = readCodexSettings()) {
  if (settings.model) params.model = settings.model;
  return settings;
}

function modelCatalogEntry(models, modelId) {
  if (!Array.isArray(models) || models.length === 0) return null;
  const wanted = String(modelId || "").trim();
  if (wanted) {
    return (
      models.find((model) => model && (model.id === wanted || model.model === wanted)) || null
    );
  }
  return models.find((model) => model && (model.isDefault || model.is_default)) || null;
}

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

function noteExecutorFastUnsupported() {
  relay({
    role: "codex",
    kind: "activity",
    text: "execution fast serving is not available for this Codex model; using standard serving"
  });
}

async function applyCodexFastTier(params, settings = readCodexSettings()) {
  if (!settings.fast) {
    params.serviceTier = null;
    return settings;
  }
  const tier = fastTierForModel(
    await readModelCatalog(),
    settings.model || activeThreadResolvedModel || activeThreadModel
  );
  params.serviceTier = tier;
  if (!tier) {
    noteExecutorFastUnsupported();
  }
  return settings;
}

async function applyCodexTurnSettings(params, settings = readCodexSettings()) {
  if (settings.effort) {
    params.effort = settings.effort;
  } else if (settings.source === "file") {
    params.effort = null;
  }
  await applyCodexFastTier(params, settings);
  return settings;
}

function resetCodexThreadForModelChange(nextModel) {
  if (!threadId || nextModel === activeThreadModel) return false;
  threadId = null;
  threadReady = null;
  currentGoal = null;
  goalFeatureAvailable = null;
  activeThreadModel = null;
  activeThreadResolvedModel = null;
  relay({ role: "codex", kind: "activity", text: "execution model updated; starting a fresh Codex thread" });
  return true;
}

function normalizeFusionRunMode(value) {
  return String(value || "").trim().toLowerCase() === "plan" ? "plan" : "auto";
}

function currentRunMode() {
  if (!RUN_MODE_FILE) return runMode;
  try {
    runMode = normalizeFusionRunMode(fs.readFileSync(RUN_MODE_FILE, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logErr(`could not read Fusion mode file: ${error.message}`);
    }
  }
  return runMode;
}

// ---- read-only activity relay to the renderer (best-effort) ----
function postTelemetry(entry, timeout = 1000) {
  if (!CALLBACK_URL || !TOKEN || !SESSION_ID) return;
  try {
    const body = JSON.stringify({
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

function relay(entry) {
  postTelemetry({
    type: "fusion.activity",
    ...entry
  });
}

// ---- south side: this pane's OWN Codex app-server (stdio JSON-RPC) ----
let codexChild = null;
let codexReady = null;
let codexBuffer = "";
let nextId = 1;
let threadId = null;
let threadReady = null;
let codexInitialized = false;
let activeThreadModel = null;
let activeThreadResolvedModel = null;
let modelCatalog = null;
let modelCatalogLoaded = false;
const pendingReq = new Map(); // app-server request id -> {resolve, reject}
const parked = new Map(); // pendingId -> {rpcId, method, params}
let currentTurn = null; // {resolve, idleTimer, commandTimer} - fulfilled by turn/completed | turn/failed | an approval request
// True while codex_implement/codex_investigate is between its currentTurn
// check and awaitTurn (both await the thread first): a concurrent tool call in
// that window must be rejected, not allowed to reset the turn buffers.
let turnArming = false;
let activeTurnId = null;
let activeTurnKind = null;
let latchedTurnResult = null;
let steerBuffer = [];
let steerRoutingPending = false;
let steerRoutingTimer = null;
let turnSummary = [];
let turnFiles = [];
let completedItemIds = new Set();
let agentMessageDeltas = new Map();
let currentGoal = null;
let goalFeatureAvailable = null;
let controlServer = null;

function isCurrentCodexChild(child) {
  return Boolean(child && codexChild === child);
}

function extractTurnId(value) {
  if (!value || typeof value !== "object") return null;
  const candidates = [
    value.turnId,
    value.turn_id,
    value.id,
    value.turn && value.turn.id,
    value.turn && value.turn.turnId,
    value.turn && value.turn.turn_id
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function clippedText(value, maxChars) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function bufferedSteerText() {
  return steerBuffer.map((item) => String(item || "").trim()).filter(Boolean).join("\n");
}

function clearSteerRoutingTimer() {
  if (steerRoutingTimer) {
    clearTimeout(steerRoutingTimer);
    steerRoutingTimer = null;
  }
}

function clearSteerRoutingState(options = {}) {
  const { clearBuffer = true } = options;
  clearSteerRoutingTimer();
  steerRoutingPending = false;
  if (clearBuffer) {
    steerBuffer = [];
  }
}

function executorProgressSnapshot() {
  const filesTouched = Array.from(new Set(turnFiles.filter(Boolean)));
  const deltaText = Array.from(agentMessageDeltas.values())
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .pop();
  const summaryText = turnSummary
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const lastActivity = deltaText || summaryText[summaryText.length - 1] || "";
  return {
    filesTouched,
    lastActivity: clippedText(lastActivity, 400),
    partialSummary: clippedText(summaryText.join("\n"), 1200)
  };
}

function buildSteerRoutingResult() {
  return {
    status: "steer_routing",
    userSteer: bufferedSteerText(),
    executorProgress: executorProgressSnapshot(),
    guidance:
      "The user steered mid-delegation and the executor is STILL RUNNING. Decide and answer with codex_steer_resolve: decision:'push' with (optionally refined) text folds the steer into the running executor so it keeps its momentum; decision:'replan' stops the executor so you can re-delegate with an amended codex_implement. Choose replan only if the steer changes the plan/scope; otherwise push.",
    nextAction: "steer_resolve"
  };
}

function armSteerRoutingWatchdog() {
  clearSteerRoutingTimer();
  steerRoutingTimer = setTimeout(() => {
    if (!steerRoutingPending) return;
    const steerText = bufferedSteerText();
    clearSteerRoutingState();
    relay({
      role: "codex",
      kind: "steer",
      text: "planner did not resolve steering in time; pushing it to the running executor"
    });
    pushSteerToExecutor(steerText).catch((error) => {
      relay({
        role: "codex",
        kind: "steer",
        text: `timed-out steering push failed: ${error?.message || "unknown error"}`
      });
    });
  }, STEER_ROUTE_TIMEOUT_MS);
}

async function codexSteer(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    relay({ role: "codex", kind: "steer", text: "empty steering ignored" });
    return { status: "skipped", reason: "empty_steer" };
  }
  steerBuffer.push(trimmed);

  if (steerRoutingPending) {
    relay({
      role: "codex",
      kind: "steer",
      text: "batched live steering for planner routing"
    });
    return { status: "routing", batched: true };
  }

  if (currentTurn && activeTurnKind === "implement") {
    steerRoutingPending = true;
    armSteerRoutingWatchdog();
    relay({
      role: "codex",
      kind: "steer",
      text: "routing steer to planner"
    });
    resolveTurn(buildSteerRoutingResult());
    return { status: "routing" };
  }

  if (currentTurn && activeTurnKind === "investigate") {
    const result = await pushSteerToExecutor(trimmed);
    steerBuffer.pop();
    return result.status === "accepted"
      ? { status: "steered" }
      : { status: result.status, reason: result.reason, error: result.error };
  }

  steerBuffer.pop();
  relay({
    role: "codex",
    kind: "steer",
    text: "live steering left for planner thread; no active executor turn"
  });
  return { status: "skipped", reason: "no_active_turn" };
}

async function pushSteerToExecutor(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return { status: "skipped", reason: "empty_steer" };
  }
  if (activeExecutorFamily === "claude") {
    if (!claudeTurnActive) {
      return { status: "skipped", reason: "no_active_codex_turn" };
    }
    const sent = claudeSend({
      type: "user",
      message: {
        role: "user",
        content: `Live user steering for this active Fusion turn:\n${trimmed}`
      }
    });
    if (!sent) {
      relay({ role: "codex", kind: "steer", text: "live steering failed: executor channel is not writable" });
      return { status: "failed", error: "Fusion executor channel is not writable" };
    }
    relay({ role: "codex", kind: "steer", text: "live steering accepted" });
    return { status: "accepted" };
  }
  if (!threadId || !activeTurnId) {
    return { status: "skipped", reason: "no_active_codex_turn" };
  }
  try {
    const response = await rpc("turn/steer", {
      threadId,
      expectedTurnId: activeTurnId,
      input: [
        {
          type: "text",
          text: `Live user steering for this active Fusion turn:\n${trimmed}`,
          text_elements: []
        }
      ]
    });
    const nextTurnId = extractTurnId(response);
    if (nextTurnId) {
      activeTurnId = nextTurnId;
    }
    relay({ role: "codex", kind: "steer", text: "live steering accepted" });
    return { status: "accepted", turnId: activeTurnId };
  } catch (error) {
    const message = error?.message || "Codex steer failed";
    relay({ role: "codex", kind: "steer", text: `live steering failed: ${message}` });
    return { status: "failed", error: message };
  }
}

async function codexInterrupt() {
  if (activeExecutorFamily === "claude") {
    if (!claudeTurnActive) {
      return { status: "skipped", reason: "no_active_codex_turn" };
    }
    claudeInterruptRequested = true;
    sendClaudeInterruptRequest();
    relay({ role: "codex", kind: "interrupt", text: "active Fusion turn interrupted" });
    return { status: "accepted" };
  }
  if (!threadId || !activeTurnId) {
    return { status: "skipped", reason: "no_active_codex_turn" };
  }
  try {
    const turnId = activeTurnId;
    await rpc("turn/interrupt", { threadId, turnId });
    relay({ role: "codex", kind: "interrupt", text: "active Fusion turn interrupted" });
    activeTurnId = null;
    return { status: "accepted", turnId };
  } catch (error) {
    const message = error?.message || "Interrupt failed";
    relay({ role: "codex", kind: "interrupt", text: `interrupt failed: ${message}` });
    return { status: "failed", error: message };
  }
}

function clearCurrentTurnTimers(turn = currentTurn) {
  if (!turn) return;
  if (turn.idleTimer) {
    clearTimeout(turn.idleTimer);
    turn.idleTimer = null;
  }
  if (turn.commandTimer) {
    clearTimeout(turn.commandTimer);
    turn.commandTimer = null;
  }
  if (turn.hardTimer) {
    clearTimeout(turn.hardTimer);
    turn.hardTimer = null;
  }
}

function refreshTurnIdleTimer(reason = "progress") {
  if (!currentTurn || !Number.isFinite(TURN_IDLE_TIMEOUT_MS) || TURN_IDLE_TIMEOUT_MS <= 0) {
    return;
  }
  if (currentTurn.commandTimer) {
    clearTimeout(currentTurn.commandTimer);
    currentTurn.commandTimer = null;
  }
  if (currentTurn.idleTimer) {
    clearTimeout(currentTurn.idleTimer);
  }
  currentTurn.idleTimer = setTimeout(() => {
    resolveTurn({
      status: "failed",
      error: `Fusion work stalled after ${reason}.`
    });
  }, TURN_IDLE_TIMEOUT_MS);
}

function startTurnAfterCommandTimer(command = "command") {
  if (
    !currentTurn ||
    !Number.isFinite(TURN_AFTER_COMMAND_TIMEOUT_MS) ||
    TURN_AFTER_COMMAND_TIMEOUT_MS <= 0
  ) {
    return;
  }
  if (currentTurn.commandTimer) {
    clearTimeout(currentTurn.commandTimer);
  }
  currentTurn.commandTimer = setTimeout(() => {
    resolveTurn({
      status: "failed",
      error: `Command finished but the turn did not complete: ${command}`
    });
  }, TURN_AFTER_COMMAND_TIMEOUT_MS);
}

function resetTurnBuffers() {
  clearSteerRoutingState();
  turnSummary = [];
  turnFiles = [];
  completedItemIds = new Set();
  agentMessageDeltas = new Map();
}

function resetCodexProcessState(options = {}) {
  const { clearChild = true } = options;
  if (clearChild) {
    codexChild = null;
    codexReady = null;
    codexBuffer = "";
  }
  threadId = null;
  threadReady = null;
  codexInitialized = false;
  activeThreadModel = null;
  activeThreadResolvedModel = null;
  activeTurnId = null;
  activeTurnKind = null;
  clearSteerRoutingState();
  currentGoal = null;
  goalFeatureAvailable = null;
}

function resetHarness(reason = "Fusion stopped.") {
  parked.clear();
  failAll(new Error(reason));
  killCodex();
  killClaudeExecutor();
  resetCodexProcessState();
  activeExecutorFamily = null;
  latchedTurnResult = null;
  clearSteerRoutingState();
  resetTurnBuffers();
}

function startControlServer() {
  if (controlServer || !TOKEN || !SESSION_ID) return;
  controlServer = http.createServer((request, response) => {
    if (request.method !== "POST" || !["/steer", "/interrupt", "/stop", "/mode"].includes(request.url)) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.headers["x-vibe-telemetry-token"] !== TOKEN) {
      response.writeHead(403);
      response.end();
      return;
    }

    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > CONTROL_MAX_BYTES) {
        request.destroy();
      }
    });
    request.on("end", async () => {
      try {
        const parsed = JSON.parse(body || "{}");
        if (parsed.sessionId !== SESSION_ID) {
          response.writeHead(409, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "failed", error: "session_mismatch" }));
          return;
        }
        let result;
        if (request.url === "/interrupt") {
          result = await codexInterrupt();
        } else if (request.url === "/stop") {
          resetHarness("Fusion stopped.");
          result = { status: "stopped" };
        } else if (request.url === "/mode") {
          runMode = normalizeFusionRunMode(parsed.mode);
          result = { status: "ok", mode: runMode };
        } else {
          result = await codexSteer(parsed.text);
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "failed", error: error?.message || "bad request" }));
      }
    });
  });
  controlServer.on("error", (error) => logErr(`control server error: ${error.message}`));
  controlServer.listen(0, "127.0.0.1", () => {
    const address = controlServer.address();
    if (!address || typeof address === "string") return;
    postTelemetry({
      type: "fusion.adapterReady",
      controlUrl: `http://127.0.0.1:${address.port}`
    });
  });
}

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
    codexBuffer = "";
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
      if (isCurrentCodexChild(child)) {
        resetCodexProcessState();
        failAll(error);
      }
    });
    child.stdout.on("data", (chunk) => {
      if (!isCurrentCodexChild(child)) {
        return;
      }
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
      if (!isCurrentCodexChild(child)) {
        return;
      }
      resetCodexProcessState();
      failAll(new Error("Fusion execution worker exited"));
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
  threadReady = null;
  if (isWin && codexChild.pid) {
    try {
      require("child_process").execFileSync(
        "taskkill",
        ["/pid", String(codexChild.pid), "/t", "/f"],
        { stdio: "ignore" }
      );
      resetCodexProcessState();
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
  resetCodexProcessState();
}

function failAll(error) {
  const message = error && error.message ? error.message : String(error || "Fusion execution failed");
  for (const { reject } of pendingReq.values()) reject(error);
  pendingReq.clear();
  parked.clear();
  activeTurnId = null;
  activeTurnKind = null;
  latchedTurnResult = null;
  currentGoal = null;
  goalFeatureAvailable = null;
  resolveTurn({ status: "failed", error: message });
}

// ---- claude-family executor engine ----
// A persistent headless `claude` child (stream-json in/out) that fills the
// same south-side role as the codex app-server when the executor family is
// "claude". It reuses fusionChatHost's exported arg builder + stream
// normalizer and feeds the SAME shared turn machinery (turnSummary/turnFiles,
// awaitTurn/resolveTurn, verdict extraction), so the north side and result
// shapes are identical for both engines.
const CLAUDE_EXEC_BIN = process.env.VIBE_FUSION_CLAUDE_BIN || "claude";
const CLAUDE_FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
let activeExecutorFamily = null;
let claudeChild = null;
let claudeNormalizer = null;
let claudeStdoutBuffer = "";
let claudeSpawnedModel = null;
let claudeSpawnedEffort = null;
let claudeSpawnedFast = null;
let claudeTurnActive = false;
let claudeInterruptRequested = false;
let claudeTurnErrorText = "";
let claudeTextParts = [];
let claudeInterruptSeq = 0;
let claudeFastSeq = 0;

// Engine selection is per delegation (the settings file is re-read every
// call), but NEVER mid-turn: a live settings flip applies to the NEXT
// delegation, otherwise a goal-sync inside the running turn would tear down
// the engine that is executing it.
function ensureExecutorFamily(family) {
  if (activeExecutorFamily === family) return activeExecutorFamily;
  if (currentTurn || turnArming || claudeTurnActive) {
    return activeExecutorFamily || family;
  }
  const previous = activeExecutorFamily;
  activeExecutorFamily = family;
  if (!previous) return family;
  if (previous === "claude") {
    killClaudeExecutor();
  } else {
    threadId = null;
    threadReady = null;
    activeThreadModel = null;
    activeThreadResolvedModel = null;
    goalFeatureAvailable = null;
  }
  currentGoal = null;
  relay({
    role: "codex",
    kind: "activity",
    text: `executor engine switched; starting a fresh ${family === "claude" ? "Claude" : "Codex"} executor`
  });
  return family;
}

function claudeSend(obj) {
  if (
    !claudeChild ||
    !claudeChild.stdin ||
    claudeChild.stdin.destroyed ||
    !claudeChild.stdin.writable
  ) {
    return false;
  }
  try {
    claudeChild.stdin.write(`${JSON.stringify(obj)}\n`);
    return true;
  } catch {
    return false;
  }
}

function killClaudeExecutor() {
  const child = claudeChild;
  claudeChild = null;
  claudeNormalizer = null;
  claudeStdoutBuffer = "";
  claudeSpawnedModel = null;
  claudeSpawnedEffort = null;
  claudeSpawnedFast = null;
  claudeTurnActive = false;
  claudeInterruptRequested = false;
  claudeTextParts = [];
  if (!child || child.killed) return;
  if (isWin && child.pid) {
    try {
      require("child_process").execFileSync(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        { stdio: "ignore" }
      );
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

function buildClaudeExecutorArgs(settings = {}) {
  const { buildClaudeArgs } = require("./fusionChatHost.cjs");
  return buildClaudeArgs({
    cwd: CWD,
    model: settings.model || "sonnet",
    effort: settings.effort || undefined,
    settingsFile: JSON.stringify({ fastMode: settings.fast === true }),
    // Full-autonomy parity with the codex executor's dangerFullAccess +
    // approvalPolicy "never": the executor owns all writes and execution, so
    // routine prompts never park. Investigations stay read-only by task
    // contract (the same parity the win32 codex investigate gate documents).
    permissionMode: "bypassPermissions"
  });
}

function applyClaudeExecutorFastSetting(fast) {
  const next = fast === true;
  if (claudeSpawnedFast === next) return;
  if (
    !claudeChild ||
    !claudeChild.stdin ||
    claudeChild.stdin.destroyed ||
    !claudeChild.stdin.writable
  ) {
    claudeSpawnedFast = next;
    return;
  }
  claudeFastSeq += 1;
  if (
    claudeSend({
      type: "control_request",
      request_id: `fusion_exec_fast_${claudeFastSeq}`,
      request: {
        subtype: "apply_flag_settings",
        settings: { fastMode: next }
      }
    })
  ) {
    claudeSpawnedFast = next;
  }
}

function ensureClaudeChild(settings = {}) {
  const model = settings.model || "sonnet";
  const effort = settings.effort || null;
  const fast = settings.fast === true;
  if (claudeChild && (claudeSpawnedModel !== model || claudeSpawnedEffort !== effort)) {
    relay({
      role: "codex",
      kind: "activity",
      text: "execution model updated; starting a fresh Claude executor"
    });
    killClaudeExecutor();
  }
  if (claudeChild) {
    applyClaudeExecutorFastSetting(fast);
    return;
  }
  const { windowsCmdArg, createStreamNormalizer } = require("./fusionChatHost.cjs");
  const args = buildClaudeExecutorArgs({ model, effort, fast });
  let child;
  if (isWin) {
    // The Windows claude is an npm shim (.cmd/.ps1), so always route through
    // cmd.exe with buildClaudeSpawn's quoting rules.
    const shell = process.env.ComSpec || "cmd.exe";
    child = spawn(
      shell,
      ["/d", "/s", "/c", [CLAUDE_EXEC_BIN, ...args].map(windowsCmdArg).join(" ")],
      { cwd: CWD, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
  } else {
    child = spawn(CLAUDE_EXEC_BIN, args, {
      cwd: CWD,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
  }
  claudeChild = child;
  claudeNormalizer = createStreamNormalizer();
  claudeStdoutBuffer = "";
  claudeSpawnedModel = model;
  claudeSpawnedEffort = effort;
  claudeSpawnedFast = fast;
  child.stdout.on("data", (chunk) => {
    if (claudeChild !== child) return;
    claudeStdoutBuffer += chunk.toString("utf8");
    let index;
    while ((index = claudeStdoutBuffer.indexOf("\n")) !== -1) {
      const line = claudeStdoutBuffer.slice(0, index).trim();
      claudeStdoutBuffer = claudeStdoutBuffer.slice(index + 1);
      if (!line) continue;
      for (const event of claudeNormalizer(line)) {
        handleClaudeExecutorEvent(event);
      }
    }
  });
  child.stderr.on("data", () => {});
  child.on("error", (error) => {
    if (claudeChild !== child) return;
    const wasActive = claudeTurnActive;
    killClaudeExecutor();
    if (wasActive) {
      resolveOrLatchTurn({
        status: "failed",
        error: `Fusion executor failed: ${error.message}`
      });
    }
  });
  child.on("exit", () => {
    if (claudeChild !== child) return;
    const wasActive = claudeTurnActive;
    claudeChild = null;
    claudeTurnActive = false;
    if (wasActive) {
      resolveOrLatchTurn({ status: "failed", error: "Fusion executor process exited" });
    }
  });
}

function claudeToolBaseName(name) {
  return String(name || "").replace(/^mcp__[^_]+__/, "");
}

function handleClaudeExecutorEvent(event) {
  if (!event || !claudeTurnActive) return;
  switch (event.type) {
    case "assistant-text":
      claudeTextParts.push(event.delta || "");
      refreshTurnIdleTimer("executor text");
      break;
    case "thinking":
      refreshTurnIdleTimer("executor thinking");
      break;
    case "tool-call": {
      const name = claudeToolBaseName(event.name);
      const input = event.input && typeof event.input === "object" ? event.input : {};
      if (name === "Bash") {
        relay({ role: "codex", kind: "command", text: clippedCommandPreview(input.command) });
      } else if (CLAUDE_FILE_TOOLS.has(name)) {
        const filePath = input.file_path || input.notebook_path || input.path || "";
        if (filePath) {
          turnFiles.push(String(filePath));
          relay({ role: "codex", kind: "file", text: `edit ${filePath}` });
        }
      }
      refreshTurnIdleTimer(`executor ${name || "tool"}`);
      break;
    }
    case "tool-result":
      refreshTurnIdleTimer("executor tool result");
      break;
    case "turn-error":
      claudeTurnErrorText = event.message || claudeTurnErrorText;
      refreshTurnIdleTimer("executor turn error");
      break;
    case "turn-start":
    case "turn-end":
      refreshTurnIdleTimer(event.type);
      break;
    case "result":
      finishClaudeExecutorTurn(event);
      break;
    default:
      break;
  }
}

function finishClaudeExecutorTurn(event) {
  if (!claudeTurnActive) return;
  claudeTurnActive = false;
  const text = claudeTextParts.join("").trim();
  claudeTextParts = [];
  if (text) turnSummary.push(text);
  if (claudeInterruptRequested) {
    claudeInterruptRequested = false;
    resolveOrLatchTurn({ status: "failed", error: "Fusion turn was interrupted." });
    return;
  }
  if (event && event.isError) {
    resolveOrLatchTurn({
      status: "failed",
      error:
        (typeof event.resultText === "string" && event.resultText) ||
        claudeTurnErrorText ||
        "Fusion executor turn failed"
    });
    return;
  }
  resolveOrLatchTurn(
    activeTurnKind === "investigate" ? completedInvestigationResult() : completedTurnResult()
  );
}

function sendClaudeInterruptRequest() {
  claudeInterruptSeq += 1;
  return claudeSend({
    type: "control_request",
    request_id: `fusion_exec_int_${claudeInterruptSeq}`,
    request: { subtype: "interrupt" }
  });
}

// The claude-engine turn driver: mirrors codexImplement/codexInvestigate's
// south half (the shared north guards run before dispatch).
async function claudeExecutorTurn(task, settings, kind) {
  turnArming = true;
  let done;
  let goalSetup = null;
  try {
    ensureClaudeChild(settings);
    if (kind === "implement") {
      goalSetup = await ensureGoalForTask(task);
    }
    resetTurnBuffers();
    latchedTurnResult = null;
    claudeTextParts = [];
    claudeTurnErrorText = "";
    claudeInterruptRequested = false;
    relay({
      role: "opus",
      kind: "delegate",
      text: kind === "investigate" ? `investigate: ${task}` : task
    });
    done = awaitTurn(kind);
  } finally {
    turnArming = false;
  }
  claudeTurnActive = true;
  const content =
    kind === "investigate" ? buildCodexInvestigationTask(task) : buildCodexVerifierTask(task);
  if (!claudeSend({ type: "user", message: { role: "user", content } })) {
    claudeTurnActive = false;
    resolveTurn({ status: "failed", error: "Fusion executor channel is not writable" });
  }
  const result = await done;
  if (kind === "investigate") {
    return result;
  }
  const withGoal = await syncGoalAfterTurn(result);
  if (goalSetup && goalSetup.status === "failed" && withGoal.status === "completed") {
    return { ...withGoal, goalSetup };
  }
  return withGoal;
}

// Local goal store for the claude executor: claude has no native per-thread
// goal RPC, so the adapter keeps the SAME normalized goal shape locally and
// the north-side contract (codex_goal_* results, ensureGoalForTask,
// syncGoalAfterTurn) works unchanged.
function claudeGoalSet(options = {}) {
  const objective = truncateGoalObjective(options.objective);
  const hasTokenBudget = options.tokenBudget != null && options.tokenBudget !== "";
  if (!objective && options.status == null && !hasTokenBudget) {
    return { status: "error", error: "objective, status, or tokenBudget is required" };
  }
  const base = currentGoal;
  const now = Date.now();
  let tokenBudget = base ? base.tokenBudget : null;
  if (hasTokenBudget) {
    const numeric = Number(options.tokenBudget);
    if (Number.isFinite(numeric) && numeric > 0) {
      tokenBudget = Math.floor(numeric);
    }
  }
  goalFeatureAvailable = true;
  currentGoal = normalizeGoal({
    threadId: "claude-executor",
    objective: objective || (base ? base.objective : ""),
    status:
      options.status != null ? normalizeGoalStatus(options.status) : base ? base.status : "active",
    tokenBudget,
    tokensUsed: base ? base.tokensUsed : 0,
    timeUsedSeconds: base ? base.timeUsedSeconds : 0,
    createdAt: base && base.createdAt ? base.createdAt : now,
    updatedAt: now
  });
  return { status: "ok", goal: currentGoal };
}

function claudeGoalGet() {
  goalFeatureAvailable = true;
  return { status: "ok", goal: currentGoal };
}

function claudeGoalClear() {
  goalFeatureAvailable = true;
  const cleared = Boolean(currentGoal);
  currentGoal = null;
  return { status: "ok", cleared };
}

// Send a request and await its response. South wire matches the boot smoke:
// { id, method, params } with no explicit jsonrpc field.
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReq.delete(id);
      reject(new Error(`Fusion execution request timed out: ${method}`));
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
        pending.reject(new Error("Fusion execution channel is not writable"));
      }
    }
  });
}

function notify(method, params) {
  return codexSend(params === undefined ? { method } : { method, params });
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

function shouldPreserveActiveTurn(result, options = {}) {
  if (options.preserveActiveTurn) return true;
  return Boolean(result && (result.status === "needs_decision" || result.status === "steer_routing"));
}

function resolveTurn(result, options = {}) {
  if (!currentTurn) return;
  const turn = currentTurn;
  currentTurn = null;
  if (!shouldPreserveActiveTurn(result, options)) {
    activeTurnId = null;
    activeTurnKind = null;
  }
  clearCurrentTurnTimers(turn);
  turn.resolve(result);
}

function resolveOrLatchTurn(result) {
  if (currentTurn) {
    resolveTurn(result);
    return;
  }
  latchedTurnResult = result;
  activeTurnId = null;
  activeTurnKind = null;
}

function drainLatchedTurnResult() {
  if (!currentTurn || !latchedTurnResult) return false;
  const result = latchedTurnResult;
  latchedTurnResult = null;
  resolveTurn(result);
  return true;
}

function takeLatchedTurnResult() {
  if (!latchedTurnResult) return null;
  const result = latchedTurnResult;
  latchedTurnResult = null;
  return result;
}

function pendingDecisionFor(pendingId, item) {
  if (!pendingId || !item) return null;
  return {
    pendingId,
    kind: approvalKind(item.method),
    detail: approvalDetail(item.method, item.params)
  };
}

function pendingDecisionResult(extra = {}) {
  const decisions = Array.from(parked.entries())
    .map(([pendingId, item]) => pendingDecisionFor(pendingId, item))
    .filter(Boolean);
  if (decisions.length === 0) return null;
  const [first] = decisions;
  return {
    status: "needs_decision",
    ...first,
    pendingDecisions: decisions,
    ...extra
  };
}

function turnErrorMessage(turn, fallback = "Fusion turn failed") {
  const error = turn && turn.error;
  const message = error && error.message ? String(error.message) : "";
  const detail =
    error && error.additionalDetails ? String(error.additionalDetails) : "";
  if (message && detail) return `${message} ${detail}`;
  return message || detail || fallback;
}

function completedTurnResult() {
  const streamedText = Array.from(agentMessageDeltas.values()).join("").trim();
  const rawSummary = (turnSummary.join("\n").trim() || streamedText).trim();
  const verifierVerdict = extractVerifierVerdict(rawSummary);
  const displaySummary = stripVerifierVerdictFromSummary(rawSummary);
  return {
    status: "completed",
    summary: displaySummary || verifierVerdict.summary || "(No message returned.)",
    files: Array.from(new Set(turnFiles.filter(Boolean))),
    goalReached: verifierVerdict.goalReached,
    bugsFound: verifierVerdict.bugsFound,
    missingRequirements: verifierVerdict.missingRequirements,
    nextAction: verifierVerdict.nextAction,
    verifierSummary: verifierVerdict.summary,
    verifierVerdict
  };
}

function extractReferencedFiles(text) {
  const files = new Set();
  const source = String(text || "");
  const pathRegex = /(?:^|[\s(["'`])((?:[A-Za-z]:)?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.@() -]+\.[A-Za-z0-9]+)(?=$|[\s)"'`,:;])/g;
  let match;
  while ((match = pathRegex.exec(source))) {
    const file = stripCommandPath(match[1]);
    if (file) files.add(file);
  }
  return Array.from(files).slice(0, 32);
}

function completedInvestigationResult() {
  const streamedText = Array.from(agentMessageDeltas.values()).join("").trim();
  const findings = (turnSummary.join("\n").trim() || streamedText).trim();
  const files = Array.from(
    new Set([
      ...turnFiles.filter(Boolean),
      ...extractReferencedFiles(findings)
    ])
  );
  return {
    status: "completed",
    findings: findings || "(No findings returned.)",
    files
  };
}

function accumulateTurnItem(item, options = {}) {
  if (!item || typeof item !== "object") return;
  const itemId = typeof item.id === "string" ? item.id : "";
  if (itemId && completedItemIds.has(itemId)) {
    return;
  }
  if (itemId) {
    completedItemIds.add(itemId);
  }
  if (options.relay !== false) {
    relayItem(item);
  }
  accumulate(item);
}

function accumulateTurnItems(items, options = {}) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    accumulateTurnItem(item, options);
  }
}

function resolveCompletedTurn(turn) {
  const turnId = extractTurnId(turn);
  if (activeTurnId && turnId && activeTurnId !== turnId) {
    return;
  }
  if (!currentTurn && !activeTurnId && parked.size === 0) {
    return;
  }
  accumulateTurnItems(turn && turn.items);
  const status = turn && turn.status;
  if (status === "failed") {
    resolveOrLatchTurn({ status: "failed", error: turnErrorMessage(turn) });
    return;
  }
  if (status === "interrupted") {
    resolveOrLatchTurn({ status: "failed", error: "Fusion turn was interrupted." });
    return;
  }
  resolveOrLatchTurn(
    activeTurnKind === "investigate" ? completedInvestigationResult() : completedTurnResult()
  );
}

function handleTurnStartResponse(response) {
  const nextTurnId = extractTurnId(response);
  if (nextTurnId) {
    activeTurnId = nextTurnId;
  }
  const turn = response && response.turn;
  if (!currentTurn) {
    if (
      turn &&
      (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted")
    ) {
      resolveCompletedTurn(turn);
    }
    return;
  }
  refreshTurnIdleTimer("turn/start response");
  if (!turn || typeof turn !== "object") {
    return;
  }
  accumulateTurnItems(turn.items, { relay: false });
  if (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted") {
    resolveCompletedTurn(turn);
  }
}

function isTurnProgressNotification(method, params = {}) {
  if (!currentTurn) return false;
  if (typeof method !== "string") return false;
  if (
    method === "error" ||
    method === "warning" ||
    method === "guardianWarning" ||
    method.startsWith("turn/") ||
    method.startsWith("item/") ||
    method.startsWith("hook/") ||
    method.startsWith("model/")
  ) {
    return true;
  }
  if (
    method === "thread/tokenUsage/updated" ||
    method === "thread/settings/updated" ||
    method === "thread/status/changed" ||
    method === "serverRequest/resolved"
  ) {
    return true;
  }
  return Boolean(params.turnId || params.itemId || (params.turn && params.turn.id));
}

function appendAgentMessageDelta(params = {}) {
  const itemId = typeof params.itemId === "string" && params.itemId ? params.itemId : "__default__";
  const delta = typeof params.delta === "string" ? params.delta : "";
  if (!delta) return;
  agentMessageDeltas.set(itemId, `${agentMessageDeltas.get(itemId) || ""}${delta}`);
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
  if (isTurnProgressNotification(method, params)) {
    refreshTurnIdleTimer(method);
  }
  if (method === "thread/goal/updated" && params.goal) {
    goalFeatureAvailable = true;
    currentGoal = normalizeGoal(params.goal);
    return;
  }
  if (method === "thread/goal/cleared") {
    goalFeatureAvailable = true;
    currentGoal = null;
    return;
  }
  if (method === "turn/started") {
    const nextTurnId = extractTurnId(params);
    if (nextTurnId) {
      activeTurnId = nextTurnId;
    }
    accumulateTurnItems(params.turn && params.turn.items, { relay: false });
    return;
  }
  if (method === "item/agentMessage/delta") {
    appendAgentMessageDelta(params);
    return;
  }
  if (method === "item/completed" && params.item) {
    accumulateTurnItem(params.item);
    if (params.item.type === "commandExecution" && params.item.exitCode != null) {
      startTurnAfterCommandTimer(summarizeCommandExecution(params.item));
    }
    return;
  }
  if (method === "turn/completed") {
    resolveCompletedTurn(params.turn);
    return;
  }
  if (method === "turn/failed" || method === "error") {
    const message =
      (params.error && params.error.message) || params.message || "Fusion turn failed";
    // Only latch failures tied to the in-flight turn. A stray global error with
    // no turn waiter and no active turn (or an explicit id mismatch) must not
    // park a stale failure that the next waiter would drain, nor clear live
    // turn state via resolveOrLatchTurn.
    const notificationTurnId = extractTurnId(params);
    if (
      !currentTurn &&
      (!activeTurnId || (notificationTurnId && notificationTurnId !== activeTurnId))
    ) {
      logErr(`ignored non-turn ${method} notification: ${message}`);
      return;
    }
    resolveOrLatchTurn({ status: "failed", error: message });
  }
}

function sendServerResult(id, result) {
  if (!codexSend({ id, result })) {
    resolveTurn({ status: "failed", error: "Fusion execution channel is not writable" });
  }
}

function sendServerError(id, message, code = -32603) {
  codexSend({ id, error: { code, message } });
}

function unsupportedServerRequest(msg, message) {
  const text = message || `Unsupported Fusion execution request: ${msg.method}`;
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
  if (method === "item/tool/call") {
    sendServerResult(msg.id, {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "Fusion adapter does not support dynamic execution tool calls."
        }
      ]
    });
    return;
  }
  if (method === "account/chatgptAuthTokens/refresh" || method === "attestation/generate") {
    unsupportedServerRequest(
      msg,
      `Fusion execution requested ${method}, which is not available in embedded mode.`
    );
    return;
  }
  if (!PARKED_REQUEST_METHODS.has(method)) {
    unsupportedServerRequest(msg);
    return;
  }

  const pendingId = `p${nextId++}`;
  const requestTurnId = extractTurnId(params);
  if (requestTurnId) {
    activeTurnId = requestTurnId;
  }
  refreshTurnIdleTimer(method);
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
  if (method.endsWith("permissions/requestApproval")) return "permission";
  if (method.toLowerCase().includes("filechange") || method === "applyPatchApproval")
    return "patch";
  return "command";
}

function approvalDetail(method, params) {
  if (method.endsWith("requestUserInput")) {
    return (params.questions || [])
      .map((q) => q.question || q.header)
      .filter(Boolean)
      .join(" / ") || "A question needs an answer.";
  }
  if (approvalKind(method) === "patch") {
    return params.reason || "Apply patch?";
  }
  if (approvalKind(method) === "permission") {
    const requested = params.permissions ? JSON.stringify(params.permissions) : "extra permissions";
    const reason = params.reason ? ` — ${params.reason}` : "";
    return `Approve ${requested}?${reason}`;
  }
  const commandActions = Array.isArray(params.commandActions)
    ? params.commandActions.map((action) => action.command || action.type || "command").join(", ")
    : "";
  const command = params.command || commandActions || (params.command_actions && "command") || "a command";
  const reason = params.reason ? ` — ${params.reason}` : "";
  const commandSummary = summarizeCommandExecution({ command });
  return `Run ${commandSummary}?${reason}`;
}

const COMMAND_DISPLAY_MAX_CHARS = 160;

function compactCommandDisplay(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clippedCommandPreview(value) {
  const compact = compactCommandDisplay(value);
  if (!compact) return "command";
  if (compact.length <= COMMAND_DISPLAY_MAX_CHARS) return compact;
  return `${compact.slice(0, COMMAND_DISPLAY_MAX_CHARS - 1).trimEnd()}…`;
}

function stripCommandPath(value) {
  let path = String(value || "").trim();
  for (let index = 0; index < 3; index += 1) {
    path = path.replace(/[;,)]+$/g, "").trim();
    if (path.length >= 2) {
      const first = path[0];
      const last = path[path.length - 1];
      if (
        (first === `"` && last === `"`) ||
        (first === `'` && last === `'`) ||
        (first === "`" && last === "`")
      ) {
        path = path.slice(1, -1).trim();
      }
    }
  }
  return path.replace(/\\/g, "/");
}

function usableLiteralPath(value) {
  const path = stripCommandPath(value);
  if (!path) return "";
  if (path.startsWith("-") || path.startsWith("$") || path.startsWith("@")) return "";
  if (path === "/dev/null" || path === "&1") return "";
  return path;
}

function tokenizeCommandLine(value) {
  const tokens = [];
  let token = "";
  let quote = "";
  let escaped = false;
  const pushToken = () => {
    if (token) {
      tokens.push(token);
      token = "";
    }
  };

  for (const ch of String(value || "")) {
    if (escaped) {
      token += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === "\\" && quote !== "'") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = "";
        continue;
      }
      token += ch;
      continue;
    }
    if (ch === `"` || ch === `'` || ch === "`") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch) || ch === ";" || ch === "," || ch === ")") {
      pushToken();
      continue;
    }
    token += ch;
  }
  pushToken();
  return tokens;
}

function readLeadingStringLiteral(value) {
  const text = String(value || "");
  const offset = text.match(/^\s*/)[0].length;
  const quote = text[offset];
  if (quote !== `"` && quote !== `'` && quote !== "`") return null;

  let literal = "";
  let escaped = false;
  for (let index = offset + 1; index < text.length; index += 1) {
    const ch = text[index];
    if (escaped) {
      literal += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "`" && ch === "$" && text[index + 1] === "{") {
      return null;
    }
    if (ch === quote) {
      return { value: literal, endIndex: index + 1 };
    }
    literal += ch;
  }
  return null;
}

function extractPowerShellNamedPath(commandTail) {
  const pathArgRegex = /-(?:LiteralPath|Path|FilePath)\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s\r\n;,)]+))/gi;
  let match;
  while ((match = pathArgRegex.exec(commandTail))) {
    const path = usableLiteralPath(match[1] || match[2] || match[3] || match[4]);
    if (path) return path;
  }
  return "";
}

function extractPowerShellPositionalPath(commandTail) {
  const tokens = tokenizeCommandLine(commandTail);
  const pathOptions = new Set(["-literalpath", "-path", "-filepath"]);
  const optionsWithValues = new Set([
    "-encoding",
    "-inputobject",
    "-itemtype",
    "-name",
    "-stream",
    "-type",
    "-value",
    "-width"
  ]);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const lower = token.toLowerCase();
    if (pathOptions.has(lower)) {
      const path = usableLiteralPath(tokens[index + 1]);
      if (path) return path;
      index += 1;
      continue;
    }
    if (lower.startsWith("-")) {
      if (optionsWithValues.has(lower)) index += 1;
      continue;
    }
    const path = usableLiteralPath(token);
    if (path) return path;
  }
  return "";
}

function extractPowerShellWritePath(command) {
  const commandRegex = /\b(?:Set-Content|Add-Content|Out-File|Tee-Object|New-Item)\b/gi;
  let match;
  while ((match = commandRegex.exec(command))) {
    const commandTail = command.slice(match.index + match[0].length);
    const namedPath = extractPowerShellNamedPath(commandTail);
    if (namedPath) return namedPath;
    const positionalPath = extractPowerShellPositionalPath(commandTail);
    if (positionalPath) return positionalPath;
  }
  return "";
}

function extractFirstStringArgumentPath(command, callRegex) {
  let match;
  while ((match = callRegex.exec(command))) {
    const literal = readLeadingStringLiteral(command.slice(match.index + match[0].length));
    if (!literal) continue;
    const path = usableLiteralPath(literal.value);
    if (path) return path;
  }
  return "";
}

function extractDotNetFileWritePath(command) {
  return extractFirstStringArgumentPath(
    command,
    /\[System\.IO\.File\]::(?:WriteAllText|WriteAllLines|AppendAllText|AppendAllLines)\s*\(\s*/gi
  );
}

function extractNodeFileWritePath(command) {
  return extractFirstStringArgumentPath(
    command,
    /\bfs\.(?:writeFileSync|writeFile|appendFileSync|appendFile)\s*\(\s*/gi
  );
}

function extractPythonOpenWritePath(command) {
  const openRegex = /\bopen\s*\(\s*/gi;
  let match;
  while ((match = openRegex.exec(command))) {
    const argumentText = command.slice(match.index + match[0].length);
    const pathLiteral = readLeadingStringLiteral(argumentText);
    if (!pathLiteral) continue;
    const modeText = argumentText.slice(pathLiteral.endIndex).trimStart();
    if (!modeText.startsWith(",")) continue;
    const modeLiteral = readLeadingStringLiteral(modeText.slice(1));
    if (!modeLiteral || !/^[wax]/i.test(modeLiteral.value)) continue;
    const path = usableLiteralPath(pathLiteral.value);
    if (path) return path;
  }
  return "";
}

function shellRedirectTargets(command) {
  const targets = [];
  let quote = "";
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === "\\" && quote !== "'") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === `"` || ch === `'` || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch !== ">") continue;

    const previous = command[index - 1] || "";
    if (previous && !/[\s|;&(]/.test(previous)) continue;
    let targetStart = index + 1;
    if (command[targetStart] === ">") targetStart += 1;
    while (/\s/.test(command[targetStart] || "")) targetStart += 1;
    if (command[targetStart] === "&") {
      targets.push("&1");
      continue;
    }
    const quoteChar = command[targetStart];
    if (quoteChar === `"` || quoteChar === `'` || quoteChar === "`") {
      let target = "";
      for (let cursor = targetStart + 1; cursor < command.length; cursor += 1) {
        if (command[cursor] === quoteChar) {
          targets.push(target);
          index = cursor;
          break;
        }
        target += command[cursor];
      }
      continue;
    }
    let targetEnd = targetStart;
    while (
      targetEnd < command.length &&
      !/\s/.test(command[targetEnd]) &&
      ![";", ",", ")"].includes(command[targetEnd])
    ) {
      targetEnd += 1;
    }
    targets.push(command.slice(targetStart, targetEnd));
    index = targetEnd;
  }
  return targets;
}

function extractShellRedirectionPath(command) {
  for (const target of shellRedirectTargets(command)) {
    const path = usableLiteralPath(target);
    if (path) return path;
  }
  return "";
}

function extractShellTeePath(command) {
  const teeRegex = /(?:^|[\s|;&])tee\b(?!-)([^\r\n]*)/gi;
  let match;
  while ((match = teeRegex.exec(command))) {
    const tokens = tokenizeCommandLine(match[1]);
    for (const token of tokens) {
      if (token === "--" || token.startsWith("-")) continue;
      const path = usableLiteralPath(token);
      if (path) return path;
    }
  }
  return "";
}

function extractCommandWritePath(command) {
  return (
    extractPowerShellWritePath(command) ||
    extractDotNetFileWritePath(command) ||
    extractNodeFileWritePath(command) ||
    extractPythonOpenWritePath(command) ||
    extractShellRedirectionPath(command) ||
    extractShellTeePath(command)
  );
}

function looksLikeContentWriteCommand(command) {
  return (
    /\b(?:Set-Content|Add-Content|Out-File|Tee-Object|New-Item)\b/i.test(command) ||
    /\[System\.IO\.File\]::(?:WriteAllText|WriteAllLines|AppendAllText|AppendAllLines)\s*\(/i.test(
      command
    ) ||
    /\bfs\.(?:writeFileSync|writeFile|appendFileSync|appendFile)\s*\(/i.test(command) ||
    /\bopen\s*\([^)]*,\s*["'`][wax]/i.test(command) ||
    shellRedirectTargets(command).length > 0 ||
    /(?:^|[\s|;&])tee\b(?!-)/i.test(command)
  );
}

function summarizeCommandExecution(item) {
  const command = String((item && item.command) || "");
  const writePath = extractCommandWritePath(command);
  if (writePath) return `write ${writePath}`;
  if (looksLikeContentWriteCommand(command)) return "write files";
  return clippedCommandPreview(command);
}

function commandExecutionDisplayText(item) {
  const summary = summarizeCommandExecution(item);
  if (item && item.exitCode != null) return `${summary} (exit ${item.exitCode})`;
  const status = item && item.status;
  if (status && status !== "completed") return `${summary} (${status})`;
  return summary;
}

function looksLikeInlineCodeDump(text) {
  const source = String(text || "");
  if (source.length < 1200) return false;
  const codeSignals = [
    /```/,
    /\b(?:import|export|const|let|function|class|interface|type)\s+[A-Za-z0-9_$]/,
    /className=["']/,
    /=>\s*[\({]/,
    /@\s*["']/,
    /Set-Content\b/i,
    /\bfs\.writeFile/i
  ];
  return codeSignals.some((pattern) => pattern.test(source));
}

function summarizeAgentMessageForDisplay(text) {
  const source = String(text || "");
  if (!looksLikeInlineCodeDump(source)) return source;
  const files = extractReferencedFiles(source);
  if (files.length > 0) {
    const visible = files.slice(0, 3).join(", ");
    const suffix = files.length > 3 ? `, +${files.length - 3} more` : "";
    return `writing ${visible}${suffix}`;
  }
  return "working with generated code";
}

function relayItem(item) {
  const type = item.type;
  if (type === "agentMessage" && item.text) {
    relay({ role: "codex", kind: "message", text: summarizeAgentMessageForDisplay(item.text) });
  } else if (type === "commandExecution") {
    relay({ role: "codex", kind: "command", text: commandExecutionDisplayText(item) });
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
  const settings = readCodexSettings();
  const requestedModel = settings.model || null;
  resetCodexThreadForModelChange(requestedModel);
  if (threadId) return threadId;
  if (!threadReady) {
    threadReady = (async () => {
      await connect();
      if (!codexInitialized) {
        await rpc("initialize", {
          clientInfo: { name: "vibeTerminal-fusion-adapter", version: "0.1.0" },
          capabilities: { experimentalApi: true }
        });
        notify("initialized");
        codexInitialized = true;
      }
      const params = {
        cwd: CWD,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        config: { "features.goals": true, "features.fast_mode": true }
      };
      applyCodexModelSetting(params, settings);
      await applyCodexFastTier(params, settings);
      const res = await rpc("thread/start", params);
      const nextThreadId = res && res.thread && res.thread.id;
      if (!nextThreadId) throw new Error("thread/start returned no thread id");
      threadId = nextThreadId;
      activeThreadModel = requestedModel;
      activeThreadResolvedModel = (res && res.model) || requestedModel;
      if (settings.fast && params.serviceTier && res?.serviceTier !== params.serviceTier) {
        noteExecutorFastUnsupported();
      }
      return threadId;
    })();
  }

  try {
    const readyThreadId = await threadReady;
    const latestModel = readCodexSettings().model || null;
    if (readyThreadId && latestModel !== activeThreadModel) {
      threadId = null;
      threadReady = null;
      currentGoal = null;
      goalFeatureAvailable = null;
      activeThreadModel = null;
      activeThreadResolvedModel = null;
      return ensureThread();
    }
    return readyThreadId;
  } catch (error) {
    threadReady = null;
    throw error;
  } finally {
    if (threadId) {
      threadReady = null;
    }
  }
}
async function warmupCodexThread() {
  try {
    const settings = readCodexSettings();
    const family = ensureExecutorFamily(settings.family);
    if (family === "claude") {
      ensureClaudeChild(settings);
    } else {
      await ensureThread();
    }
    relay({ role: "codex", kind: "warmup", text: "execution bridge ready" });
  } catch (error) {
    const message = error?.message || "Fusion execution bridge failed to start";
    logErr(`warmup failed: ${message}`);
    relay({ role: "codex", kind: "warmup_error", text: `execution bridge not ready: ${message}` });
  }
}

function awaitTurn(kind = "implement") {
  if (currentTurn) {
    throw new Error("Fusion bridge already has a pending turn waiter.");
  }
  activeTurnKind = kind;
  return new Promise((resolve) => {
    clearCurrentTurnTimers();
    currentTurn = { resolve, idleTimer: null, commandTimer: null, hardTimer: null };
    refreshTurnIdleTimer("turn start");
    // Absolute ceiling: never refreshed by refreshTurnIdleTimer, so progress
    // churn cannot keep the turn alive forever. This is the backstop that makes
    // `await done` guaranteed to resolve even when the idle watchdog is starved.
    currentTurn.hardTimer = setTimeout(() => {
      resolveTurn({
        status: "failed",
        error: "Fusion turn exceeded the maximum duration."
      });
    }, TURN_HARD_TIMEOUT_MS);
  });
}

async function codexGoalSet(options = {}) {
  const family = ensureExecutorFamily(readCodexSettings().family);
  if (family === "claude") {
    return claudeGoalSet(options);
  }
  await ensureThread();
  const params = { threadId };
  const objective = truncateGoalObjective(options.objective);
  if (objective) params.objective = objective;
  if (options.status != null) params.status = normalizeGoalStatus(options.status);
  if (options.tokenBudget != null && options.tokenBudget !== "") {
    const tokenBudget = Number(options.tokenBudget);
    if (Number.isFinite(tokenBudget) && tokenBudget > 0) {
      params.tokenBudget = Math.floor(tokenBudget);
    }
  }
  if (!params.objective && params.status == null && params.tokenBudget == null) {
    return {
      status: "error",
      error: "objective, status, or tokenBudget is required"
    };
  }

  try {
    const response = await rpc("thread/goal/set", params);
    goalFeatureAvailable = true;
    currentGoal = normalizeGoal(response && response.goal);
    return { status: "ok", goal: currentGoal };
  } catch (error) {
    return goalsUnavailableResult(error);
  }
}

async function codexGoalGet() {
  const family = ensureExecutorFamily(readCodexSettings().family);
  if (family === "claude") {
    return claudeGoalGet();
  }
  await ensureThread();
  try {
    const response = await rpc("thread/goal/get", { threadId });
    goalFeatureAvailable = true;
    currentGoal = normalizeGoal(response && response.goal);
    return { status: "ok", goal: currentGoal };
  } catch (error) {
    return goalsUnavailableResult(error);
  }
}

async function codexGoalClear() {
  const family = ensureExecutorFamily(readCodexSettings().family);
  if (family === "claude") {
    return claudeGoalClear();
  }
  await ensureThread();
  try {
    const response = await rpc("thread/goal/clear", { threadId });
    goalFeatureAvailable = true;
    currentGoal = null;
    return { status: "ok", cleared: Boolean(response && response.cleared) };
  } catch (error) {
    return goalsUnavailableResult(error);
  }
}

// Orchestrator-reachable escape hatch for a wedged turn: clears local turn state
// so the next codex_implement starts fresh, without restarting the pane. The
// Codex thread and native goal stay alive. Unlike resetHarness (host-only, kills
// the child), this keeps the bridge warm and never blocks on the child.
function codexCancel() {
  const hadActiveTurn = Boolean(currentTurn || activeTurnId || claudeTurnActive || steerRoutingPending);
  const clearedDecisions = parked.size > 0;
  // Best-effort: ask the app-server to abandon the active turn. Fire-and-forget
  // (never awaited) so a wedged or silent child cannot block the escape hatch.
  if (threadId && activeTurnId) {
    rpc("turn/interrupt", { threadId, turnId: activeTurnId }).catch(() => {});
  }
  // Same for a running claude-executor turn: request the abort and drop the
  // active flag so the child's eventual result event is ignored instead of
  // latching a stale completed result for the next waiter.
  if (claudeTurnActive) {
    claudeTurnActive = false;
    claudeInterruptRequested = false;
    claudeTextParts = [];
    sendClaudeInterruptRequest();
  }
  // Clear the local mirror and unblock any in-flight `await done` synchronously,
  // so the orchestrator is freed even if the child never replies.
  parked.clear();
  latchedTurnResult = null;
  clearSteerRoutingState();
  resolveTurn({ status: "cancelled", error: "Fusion turn cancelled by the orchestrator." });
  activeTurnId = null;
  activeTurnKind = null;
  relay({ role: "opus", kind: "cancel", text: "turn cancelled" });
  return { status: "cancelled", hadActiveTurn, clearedDecisions };
}

async function codexSteerResolve(decisionValue, text) {
  const decision = String(decisionValue || "push").trim().toLowerCase();
  if (!["push", "replan"].includes(decision)) {
    return { status: "error", error: "decision must be push or replan" };
  }
  if (!steerRoutingPending) {
    return { status: "error", error: "No pending steering route to resolve." };
  }
  clearSteerRoutingTimer();
  const steerText = String(text || "").trim() || bufferedSteerText();

  if (decision === "replan") {
    const interrupted = await codexInterrupt();
    steerRoutingPending = false;
    steerBuffer = [];
    latchedTurnResult = null;
    clearSteerRoutingTimer();
    resetTurnBuffers();
    relay({ role: "codex", kind: "steer", text: "executor stopped for steering replan" });
    return {
      status: "steer_replan_ready",
      interrupted,
      note: "Executor stopped for replanning. Call codex_implement now with your amended task."
    };
  }

  steerRoutingPending = false;

  if (latchedTurnResult) {
    const completed = takeLatchedTurnResult();
    steerBuffer = [];
    const withGoal = await syncGoalAfterTurn(completed);
    relay({
      role: "codex",
      kind: "steer",
      text: "executor finished before steering landed"
    });
    return {
      ...withGoal,
      steerNotApplied: true,
      userSteer: steerText,
      note:
        "The executor finished before your steer landed; its result is included. Call codex_implement to apply your steer as a follow-up."
    };
  }

  if (!activeTurnId && !claudeTurnActive) {
    steerBuffer = [];
    return { status: "failed", error: "No active executor turn is available for steering." };
  }

  steerBuffer = [];
  const pushed = await pushSteerToExecutor(steerText);
  if (pushed.status !== "accepted") {
    relay({
      role: "codex",
      kind: "steer",
      text: `steering push failed: ${pushed.error || pushed.reason || pushed.status}`
    });
    return {
      status: "failed",
      error: pushed.error || `Could not push steering: ${pushed.reason || pushed.status}`
    };
  }
  relay({ role: "codex", kind: "steer", text: "steering pushed to running executor" });
  const done = awaitTurn(activeTurnKind || "implement");
  drainLatchedTurnResult();
  const result = await done;
  return syncGoalAfterTurn(result);
}

async function ensureGoalForTask(task) {
  if (!shouldReplaceGoalForTask(currentGoal)) {
    return { status: "ok", goal: currentGoal, created: false };
  }
  const objective = truncateGoalObjective(task);
  if (!objective) return { status: "skipped", goal: null, created: false };
  const result = await codexGoalSet({ objective, status: "active" });
  return { ...result, created: result.status === "ok" };
}

async function syncGoalAfterTurn(result) {
  if (!result || result.status !== "completed" || !currentGoal) return result;
  const goalStatus = goalStatusForVerdict(result.verifierVerdict);
  if (!shouldAutoSyncGoalStatus(currentGoal, goalStatus)) {
    return { ...result, goal: currentGoal };
  }
  const goalResult = await codexGoalSet({ status: goalStatus });
  if (goalResult.status === "ok") {
    return { ...result, goal: goalResult.goal };
  }
  return { ...result, goalSync: goalResult };
}

async function codexImplement(task) {
  if (!task) return { status: "error", error: "task is required" };
  const mode = currentRunMode();
  if (mode === "plan") {
    return {
      status: "failed",
      mode,
      error: "Fusion Plan mode is active. codex_implement is disabled until this pane is switched back to Auto mode; investigate read-only and present an implementation plan instead."
    };
  }
  const pendingDecision = pendingDecisionResult({
    warning: "Fusion already has a pending decision; answer it before starting another task."
  });
  if (pendingDecision) {
    return pendingDecision;
  }
  if (steerRoutingPending) {
    await codexInterrupt();
    steerRoutingPending = false;
    steerBuffer = [];
    latchedTurnResult = null;
    clearSteerRoutingTimer();
    relay({ role: "codex", kind: "steer", text: "fresh delegation treated as steering replan" });
  }
  if (latchedTurnResult && !activeTurnId) {
    const result = takeLatchedTurnResult();
    const withGoal = await syncGoalAfterTurn(result);
    return {
      ...withGoal,
      warning:
        "A previously routed executor turn completed before the planner started the next delegation; review this result before re-delegating."
    };
  }
  if (currentTurn || turnArming) {
    return {
      status: "error",
      error: "Fusion turn already in progress; wait for the active turn to surface a decision or complete."
    };
  }
  {
    const settings = readCodexSettings();
    const family = ensureExecutorFamily(settings.family);
    if (family === "claude") {
      return claudeExecutorTurn(task, settings, "implement");
    }
  }
  // Held across the awaits below: a concurrent tool call passing the
  // currentTurn check during ensureThread/ensureGoalForTask would otherwise
  // reset this turn's accumulation buffers mid-flight.
  turnArming = true;
  let done;
  let goalSetup;
  try {
    await ensureThread();
    goalSetup = await ensureGoalForTask(task);
    resetTurnBuffers();
    latchedTurnResult = null;
    relay({ role: "opus", kind: "delegate", text: task });
    done = awaitTurn();
  } finally {
    turnArming = false;
  }
  const params = {
    threadId,
    input: [{ type: "text", text: buildCodexVerifierTask(task), text_elements: [] }],
    approvalPolicy: "never",
    sandboxPolicy: fusionCodexSandboxPolicy()
  };
  await applyCodexTurnSettings(params);
  rpc("turn/start", params)
    .then(handleTurnStartResponse)
    .catch((error) => resolveTurn({ status: "failed", error: error.message }));
  const result = await done;
  const withGoal = await syncGoalAfterTurn(result);
  if (goalSetup.status === "failed" && withGoal.status === "completed") {
    return { ...withGoal, goalSetup };
  }
  return withGoal;
}

async function codexInvestigate(task) {
  if (!task) return { status: "error", error: "task is required" };
  const pendingDecision = pendingDecisionResult({
    warning: "Fusion already has a pending decision; answer it before starting another task."
  });
  if (pendingDecision) {
    return pendingDecision;
  }
  if (steerRoutingPending) {
    await codexInterrupt();
    steerRoutingPending = false;
    steerBuffer = [];
    latchedTurnResult = null;
    clearSteerRoutingTimer();
    relay({ role: "codex", kind: "steer", text: "fresh investigation treated as steering replan" });
  }
  if (currentTurn || turnArming) {
    return {
      status: "error",
      error: "Fusion turn already in progress; wait for the active turn to surface a decision or complete."
    };
  }
  {
    const settings = readCodexSettings();
    const family = ensureExecutorFamily(settings.family);
    if (family === "claude") {
      return claudeExecutorTurn(task, settings, "investigate");
    }
  }
  turnArming = true;
  let done;
  try {
    await ensureThread();
    resetTurnBuffers();
    latchedTurnResult = null;
    relay({ role: "opus", kind: "delegate", text: `investigate: ${task}` });
    done = awaitTurn("investigate");
  } finally {
    turnArming = false;
  }
  const params = {
    threadId,
    input: [{ type: "text", text: buildCodexInvestigationTask(task), text_elements: [] }],
    approvalPolicy: "never",
    sandboxPolicy: fusionCodexInvestigateSandboxPolicy()
  };
  await applyCodexTurnSettings(params);
  rpc("turn/start", params)
    .then(handleTurnStartResponse)
    .catch((error) => resolveTurn({ status: "failed", error: error.message }));
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
  if (method.endsWith("permissions/requestApproval")) {
    const accepted = decision === "accept" || decision === "acceptForSession";
    return {
      permissions: accepted ? params.permissions || {} : {},
      scope: decision === "acceptForSession" ? "session" : "turn"
    };
  }
  // v2 item/.../requestApproval decisions.
  const allowed = ["accept", "acceptForSession", "decline", "cancel"];
  return { decision: allowed.includes(decision) ? decision : "decline" };
}

async function codexRespond(pendingId, decision, note) {
  if (steerRoutingPending) {
    return {
      status: "steer_routing",
      ...buildSteerRoutingResult(),
      warning:
        "A steering route is awaiting a decision. Call codex_steer_resolve with decision:'push' or decision:'replan' before answering other pending requests."
    };
  }
  if (currentTurn || turnArming) {
    return (
      pendingDecisionResult({
        warning: "Fusion is still processing the active turn result."
      }) || { status: "error", error: "Fusion is already waiting for a turn result." }
    );
  }
  const item = parked.get(pendingId);
  if (!item) {
    return (
      pendingDecisionResult({
        warning: `unknown pendingId: ${pendingId}`
      }) || { status: "error", error: `unknown pendingId: ${pendingId}` }
    );
  }
  parked.delete(pendingId);
  const result = buildDecisionResult(item.method, item.params, decision, note);
  relay({ role: "opus", kind: "decision", text: `${decision}` });
  const hasQueuedDecision = parked.size > 0;
  // Preserve the parked turn's kind: resolveTurn keeps activeTurnKind across a
  // needs_decision, so an investigate turn that parked a question must complete
  // as an investigation result, not a verifier-verdict implement result.
  const done = hasQueuedDecision ? null : awaitTurn(activeTurnKind || "implement");
  if (!codexSend({ id: item.rpcId, result })) {
    if (done) {
      resolveTurn({ status: "failed", error: "Fusion execution channel is not writable" });
    }
    return { status: "failed", error: "Fusion execution channel is not writable" };
  }
  const nextDecision = pendingDecisionResult({
    warning: "Fusion has another pending decision queued."
  });
  if (nextDecision) {
    return nextDecision;
  }
  if (!done) {
    return { status: "failed", error: "Fusion pending decision state changed before it could be surfaced." };
  }
  drainLatchedTurnResult();
  const resumed = await done;
  return syncGoalAfterTurn(resumed);
}

// ---- north side: MCP stdio server ----
const TOOLS = [
  {
    name: "codex_goal_set",
    description:
      "Create or update the native Codex per-thread goal for this Fusion pane. Use this at the start of substantial work so Codex tracks the user's top-level objective, usage, and status. Status may be active, paused, blocked, usageLimited, budgetLimited, or complete. Returns {status:'ok', goal} or {status:'failed', goalFeatureAvailable:false, error}.",
    inputSchema: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          description:
            "Top-level user objective or updated objective. Keep it concise; Codex enforces a 4000-character limit."
        },
        status: {
          type: "string",
          enum: ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]
        },
        tokenBudget: {
          type: "number",
          description: "Optional native Codex token budget for the goal."
        }
      }
    }
  },
  {
    name: "codex_goal_get",
    description:
      "Read the native Codex per-thread goal for this Fusion pane. Use it before deciding whether to continue, pause, or finish a long-running request. Returns {status:'ok', goal:null|ThreadGoal} or a failed goalFeatureAvailable:false result.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "codex_goal_clear",
    description:
      "Clear the native Codex per-thread goal for this Fusion pane after the human explicitly abandons the objective or starts a separate unrelated objective.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "codex_investigate",
    description:
      "Ask embedded Codex GPT-5.5 to do a read-only scouting pass: file discovery, targeted reads, repo navigation, dependency tracing, or concise context gathering for Claude. Use this to feed Claude findings/files/snippets before Claude does architecture or UI design thinking. Does not create or sync native goals and does not use the implementation verifier contract. Returns {status:'completed', findings, files} or {status:'failed', error}.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Read-only investigation request. Ask for concise findings, relevant file paths, and short snippets when useful."
        }
      },
      required: ["task"]
    }
  },
  {
    name: "codex_implement",
    description:
      "Delegate implementation, testing, compile/runtime fixing, refactors, repo navigation, picture/image generation, browser navigation/control/automation, bug review, or goal-completion verification to embedded Codex GPT-5.5. In Fusion Plan mode this tool refuses execution until the pane is switched back to Auto. Opus 4.8 drives architecture, strategy, UX/UI build-out when appropriate, human-facing orchestration, and guidance for Codex on constraints, UI intent, debugging direction, and follow-up corrections. Codex follows that guidance while independently verifying bugs and goal completion. Use codex_goal_set first for substantial top-level work; codex_implement will create a fallback native Codex goal if none exists and will sync goal status from the verifier verdict. Returns one of: {status:'completed', summary, files, goalReached, bugsFound, missingRequirements, nextAction, verifierVerdict, goal}; {status:'needs_decision', pendingId, kind, detail} - answer it with codex_respond; {status:'steer_routing', userSteer, executorProgress, guidance, nextAction:'steer_resolve'} - answer it with codex_steer_resolve; or {status:'failed', error}. If goalReached is false or nextAction is 'continue', continue/redelegate unless the human or an explicit Opus override says otherwise.",
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
  },
  {
    name: "codex_steer_resolve",
    description:
      "Answer a steer_routing result returned by codex_implement while the executor is still running. Use decision='push' to fold the user's steering into the running executor; optional text may refine the steer. Use decision='replan' to stop the executor, then call codex_implement with an amended task on the same persistent executor thread.",
    inputSchema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          enum: ["push", "replan"]
        },
        text: {
          type: "string",
          description: "Optional refined steering text. Defaults to the buffered user steer."
        }
      },
      required: ["decision"]
    }
  },
  {
    name: "codex_cancel",
    description:
      "Abort the in-flight Codex turn and clear any pending approvals for this Fusion pane WITHOUT restarting the pane. Use it as the escape hatch when a turn is wedged - e.g. codex_implement keeps returning a 'turn already in progress' error with no decision to answer, or a parked approval can no longer be resolved. The Codex thread and native goal stay alive, so you can re-delegate with codex_implement afterwards. Returns {status:'cancelled', hadActiveTurn, clearedDecisions}.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

const PLAN_MODE_ALLOWED_TOOLS = new Set([
  "codex_goal_get",
  "codex_investigate",
  "codex_cancel",
  "codex_steer_resolve"
]);

function sendMcp(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handleToolCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  try {
    let result;
    if (currentRunMode() === "plan" && !PLAN_MODE_ALLOWED_TOOLS.has(name)) {
      result = {
        status: "failed",
        mode: "plan",
        error: "Fusion Plan mode is active. Only read-only investigation, goal checks, and cancellation are available until Auto mode is restored."
      };
    } else if (name === "codex_goal_set") {
      result = await codexGoalSet({
        objective: args.objective != null ? String(args.objective) : "",
        status: args.status != null ? String(args.status) : undefined,
        tokenBudget: args.tokenBudget
      });
    } else if (name === "codex_goal_get") {
      result = await codexGoalGet();
    } else if (name === "codex_goal_clear") {
      result = await codexGoalClear();
    } else if (name === "codex_investigate") {
      result = await codexInvestigate(String(args.task || ""));
    } else if (name === "codex_implement") {
      result = await codexImplement(String(args.task || ""));
    } else if (name === "codex_respond") {
      result = await codexRespond(
        String(args.pendingId || ""),
        String(args.decision || ""),
        args.note != null ? String(args.note) : ""
      );
    } else if (name === "codex_steer_resolve") {
      result = await codexSteerResolve(
        String(args.decision || ""),
        args.text != null ? String(args.text) : ""
      );
    } else if (name === "codex_cancel") {
      result = codexCancel();
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
  startControlServer();

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
    resetHarness("Fusion adapter closed.");
    if (controlServer) {
      controlServer.close();
      controlServer = null;
    }
    process.exit(0);
  });

  logErr(`started (codex=${CODEX_BIN}, session=${SESSION_ID || "?"})`);
  if (EAGER_BOOT) {
    void warmupCodexThread();
  }
}

module.exports = {
  FAST_SERVICE_TIER,
  VERDICT_MARKER,
  buildClaudeExecutorArgs,
  buildCodexInvestigationTask,
  buildCodexVerifierTask,
  cleanClaudeEffort,
  extractVerifierVerdict,
  fastTierForModel,
  commandExecutionDisplayText,
  goalStatusForVerdict,
  normalizeGoal,
  normalizeGoalStatus,
  normalizeVerifierVerdict,
  readCodexSettings,
  shouldAutoSyncGoalStatus,
  shouldReplaceGoalForTask,
  summarizeAgentMessageForDisplay,
  stripVerifierVerdictFromSummary,
  turnErrorMessage
};

if (require.main === module) {
  startMcpServer();
}
