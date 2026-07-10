// Per-pane Fusion adapter: a thin bridge between Opus (the Claude pane) and this
// pane's OWN embedded Codex app-server (ONE instance per Fusion terminal).
//
//   Opus  ──stdio MCP──▶  this adapter  ──stdio JSON-RPC──▶  codex app-server (child)
//
// North side: a hand-rolled MCP stdio server exposing tools to Opus:
//   - codex_goal_set/get/clear: use Codex's native per-thread goal store.
//   - codex_implement(task): run a Codex turn; returns {status:"completed",...}
//     OR {status:"needs_decision", pendingId, ...} OR {status:"failed",...}.
//   - codex_watch_build(command): launch a host-supervised detached build.
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
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { tailFile } = require("./buildSupervisor.cjs");
const { modelCatalogEntry, resolveCodexEffortForModel } = require("./codexModels.cjs");

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
// Verifiable-progress watchdog: text/status churn cannot refresh it, while
// completed tool/file/command activity can keep legitimate long turns alive.
const TURN_HARD_TIMEOUT_MS = Math.max(
  Number(process.env.VIBE_FUSION_TURN_HARD_TIMEOUT_MS) || 900000,
  60000
);
// Never refreshed. This preserves the guarantee that every foreground turn
// waiter resolves even when strong progress continues indefinitely.
const TURN_ABSOLUTE_TIMEOUT_MS = Math.max(
  Number(process.env.VIBE_FUSION_TURN_ABSOLUTE_TIMEOUT_MS) || 3600000,
  TURN_HARD_TIMEOUT_MS
);
// Detached background work is non-blocking and long builds can legitimately run
// for much longer than foreground turns while still streaming progress. The
// refreshable idle timer is the liveness guard; the hard cap is only an
// absolute ceiling against truly orphaned work.
const BACKGROUND_HARD_TIMEOUT_MS = Math.max(
  Number(process.env.VIBE_FUSION_BACKGROUND_HARD_TIMEOUT_MS) || 14400000,
  60000
);
const BACKGROUND_IDLE_TIMEOUT_MS = Math.max(
  Number(process.env.VIBE_FUSION_BACKGROUND_IDLE_TIMEOUT_MS) || 1200000,
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
    "You are the Codex executor inside Terminal Fusion. You implement, run tests, debug, and verify whether the user's goal is actually reached.",
    "Claude/Opus may provide strategy, constraints, UI intent, debugging direction, and follow-up corrections; follow that guidance while still independently checking the result.",
    "Earlier turns in this thread may have been authored by a different engine or model - the user can switch families mid-thread. Judge the code and evidence in front of you, not the apparent authorship, and do not infer your own capabilities from a prior turn's byline.",
    "Within Fusion, picture/image generation and browser navigation/control/automation are Codex-owned execution work. Perform those delegated operations here and verify the resulting image or browser state.",
    "When the delegated outcome is visual - UI layout or styling, rendered pages, generated images, charts, terminal UI - do not verify it by code reading and tests alone: run or render the artifact (dev server, headless browser, the app's remote-debugging port, or the project's own preview/screenshot tooling), capture the actual visual state to an image file, VIEW that image with your image-viewing tool, and judge what you see against the intent. Name the screenshot/image path and what you observed in your summary. If you genuinely cannot render or view it in this environment, say so plainly, record it in `missingRequirements`, and set `goalReached:false` rather than passing off a code-read as a visual check; never describe an image you did not actually view.",
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
    "If the delegation named a specific MCP server/tool or a skill, you must actually invoke it to do the work - do not simulate or describe it. Confirm the real call happened and that its output was used. If a named MCP server or skill was unavailable, errored, or could not be exercised, record it in `missingRequirements` (and `bugsFound` if it indicates a defect) and set `goalReached:false` rather than claiming success.",
    'Preflight named capabilities before building work on top of them: confirm the named MCP server\'s tools are actually exposed to you and make the first real call early. If the capability is not connected - not installed, not running, unauthenticated, or its tools are absent - stop the dependent work and record the exact server/tool or skill name plus the failure reason in `missingRequirements`. Set `nextAction:"ask_human"` when fixing it needs the user (connecting, installing, or authenticating the server); use `nextAction:"continue"` only when a re-delegation could fix it without the user.',
    "",
    'If the task states it is one milestone of a larger plan, implement only that milestone and judge `goalReached` against the LARGER goal: report `goalReached:false` and `nextAction:"continue"` until the final milestone completes it, even when this milestone itself is done.'
  ].join("\n");
}

function buildCodexInvestigationTask(task) {
  return [
    task,
    "",
    "## Fusion investigation contract",
    "You are the Codex executor doing a read-only scouting pass for Terminal Fusion.",
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

// Codex 0.144.0's family union is minimal|low|medium|high|xhigh|max|ultra.
// Per-model support varies; readCodexSettings preserves the user's choice and
// applyCodexTurnSettings resolves it against live model/list before every turn.
function cleanCodexEffort(value) {
  return cleanCodexSetting(value);
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

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function tomlBareKeySegment(value) {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function tomlQuotedKeySegment(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\u0008/g, "\\b")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\f/g, "\\f")
    .replace(/\r/g, "\\r")}"`;
}

function codexMcpServerConfigKey(name) {
  const serverName = String(name || "").trim();
  if (!serverName) return null;
  const segment = tomlBareKeySegment(serverName) ? serverName : tomlQuotedKeySegment(serverName);
  return `mcp_servers.${segment}`;
}

function stringArray(value) {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item) => typeof item === "string");
  return items.length === value.length ? items : undefined;
}

function stringMap(value) {
  if (!isPlainObject(value)) return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    } else if (typeof item === "number" || typeof item === "boolean") {
      out[key] = String(item);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function copyStringField(target, source, key) {
  if (typeof source[key] === "string" && source[key].trim()) {
    target[key] = source[key];
  }
}

function copyBooleanField(target, source, key) {
  if (typeof source[key] === "boolean") {
    target[key] = source[key];
  }
}

function copyNumberField(target, source, key) {
  if (typeof source[key] === "number" && Number.isFinite(source[key])) {
    target[key] = source[key];
  }
}

function translateWorkspaceMcpServerConfig(server) {
  if (!isPlainObject(server)) return null;
  const out = {};
  copyStringField(out, server, "command");
  copyStringField(out, server, "url");
  if (!out.command && !out.url) return null;

  if (out.command) {
    delete out.url;
    const args = stringArray(server.args);
    if (args) out.args = args;
    const env = stringMap(server.env);
    if (env) out.env = env;
    copyStringField(out, server, "cwd");
  } else {
    const headers = stringMap(server.http_headers) || stringMap(server.headers);
    if (headers) out.http_headers = headers;
    const envHttpHeaders = stringMap(server.env_http_headers);
    if (envHttpHeaders) out.env_http_headers = envHttpHeaders;
    copyStringField(out, server, "bearer_token_env_var");
  }

  copyBooleanField(out, server, "enabled");
  if (typeof server.disabled === "boolean" && typeof out.enabled !== "boolean") {
    out.enabled = !server.disabled;
  }
  copyBooleanField(out, server, "required");
  copyBooleanField(out, server, "supports_parallel_tool_calls");
  copyNumberField(out, server, "startup_timeout_sec");
  copyNumberField(out, server, "startup_timeout_ms");
  copyNumberField(out, server, "tool_timeout_sec");

  const enabledTools = stringArray(server.enabled_tools);
  if (enabledTools) out.enabled_tools = enabledTools;
  const disabledTools = stringArray(server.disabled_tools);
  if (disabledTools) out.disabled_tools = disabledTools;
  const scopes = stringArray(server.scopes);
  if (scopes) out.scopes = scopes;
  copyStringField(out, server, "oauth_resource");
  copyStringField(out, server, "environment_id");
  if (typeof server.auth === "string") out.auth = server.auth;
  if (isPlainObject(server.oauth)) out.oauth = server.oauth;
  if (isPlainObject(server.tools)) out.tools = server.tools;

  return out;
}

function workspaceMcpConfigPath(cwd = CWD) {
  return path.join(cwd || process.cwd(), ".mcp.json");
}

function workspaceMcpConfigOverrides(cwd = CWD) {
  const file = workspaceMcpConfigPath(cwd);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logErr(`could not read workspace MCP config ${file}: ${error.message}`);
    }
    return {};
  }
  const servers = parsed && isPlainObject(parsed.mcpServers) ? parsed.mcpServers : null;
  if (!servers) return {};
  const overrides = {};
  for (const [name, server] of Object.entries(servers)) {
    const key = codexMcpServerConfigKey(name);
    const config = translateWorkspaceMcpServerConfig(server);
    if (!key || !config) continue;
    overrides[key] = config;
  }
  return overrides;
}

function applyCodexModelSetting(params, settings = readCodexSettings()) {
  if (settings.model) params.model = settings.model;
  return settings;
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

function noteExecutorEffortFallback(resolution) {
  const model = resolution.model || "the selected Codex model";
  const key = `${model}:${resolution.requested}:${resolution.effort}`;
  if (lastExecutorEffortFallbackKey === key) return;
  lastExecutorEffortFallbackKey = key;
  relay({
    role: "codex",
    kind: "activity",
    text: `execution effort ${resolution.requested} is unavailable for ${model}; using ${resolution.effort}`
  });
}

async function applyCodexFastTier(params, settings = readCodexSettings(), models) {
  if (!settings.fast) {
    params.serviceTier = null;
    return settings;
  }
  const tier = fastTierForModel(
    models === undefined ? await readModelCatalog() : models,
    settings.model || activeThreadResolvedModel || activeThreadModel
  );
  params.serviceTier = tier;
  if (!tier) {
    noteExecutorFastUnsupported();
  }
  return settings;
}

async function applyCodexTurnSettings(params, settings = readCodexSettings()) {
  const models = settings.effort || settings.fast ? await readModelCatalog() : undefined;
  if (settings.effort) {
    const resolution = resolveCodexEffortForModel(
      models,
      settings.model || activeThreadResolvedModel || activeThreadModel,
      settings.effort
    );
    if (resolution.effort) {
      params.effort = resolution.effort;
      if (resolution.requested !== resolution.effort) {
        noteExecutorEffortFallback(resolution);
      }
    } else if (settings.source === "file") {
      params.effort = null;
    }
  } else if (settings.source === "file") {
    params.effort = null;
  }
  await applyCodexFastTier(params, settings, models);
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
      timeout,
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
let lastExecutorEffortFallbackKey = "";
const pendingReq = new Map(); // app-server request id -> {resolve, reject}
const parked = new Map(); // pendingId -> {rpcId, method, params}
let currentTurn = null; // fulfilled by turn/completed | turn/failed | an approval request
// True while codex_implement/codex_investigate is between its currentTurn
// check and awaitTurn (both await the thread first): a concurrent tool call in
// that window must be rejected, not allowed to reset the turn buffers.
let turnArming = false;
let activeTurnId = null;
let activeTurnKind = null;
let latchedTurnResult = null;
const timedOutTurnIds = new Set();
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
// ---- parallel fan-out state (batched scouts / executor workstreams) ----
// A batched codex_investigate/codex_implement call runs 2-4 concurrent turns
// on EPHEMERAL app-server threads while the aggregate call holds the normal
// single-turn latch. Workers stay registered (even after settling) until the
// whole fan-out finalizes, so their late notifications keep routing here
// instead of polluting the global single-turn state.
const FANOUT_MAX_TASKS = 4;
const fanoutWorkers = new Map(); // worker threadId -> worker
let fanoutActive = false; // covers the codex fan-out AND the claude sequential batch window
let activeFanoutRun = null; // {aborted} - abort skips finalize's aggregate resolve
// ---- detached background delegations ----
// codex_implement/codex_investigate {background:true} run ONE task detached:
// the tool call returns {status:"started", taskId} immediately, the work runs
// on an ephemeral worker (own thread + timers, fan-out routing rules), and
// the settle is relayed to the host as fusion.background-task telemetry — the
// host wakes the planner with the report as a NEW turn. Background workers
// never touch currentTurn/fanoutActive, never park decisions, and never sync
// the native goal.
const BACKGROUND_MAX_TASKS = 4;
const backgroundWorkers = new Map(); // routeKey (codex worker threadId | claude synthetic id) -> worker
const settledBackgroundTasks = []; // most-recent first; capped in finalizeBackgroundWorker
const BACKGROUND_ACTIVITY_MAX_ITEMS = 20;
const BACKGROUND_SETTLED_MAX_TASKS = 8;
let backgroundTaskSeq = 0;

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

function buildSupervisorDir() {
  return process.env.VIBE_BUILD_SUPERVISOR_DIR || path.join(os.tmpdir(), "fusion-builds");
}

function buildIdForWatch() {
  return `build-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function watchedBuildPaths(buildId, buildsDir = buildSupervisorDir()) {
  return {
    logPath: path.join(buildsDir, `${buildId}.log`),
    sentinelPath: path.join(buildsDir, `${buildId}.exit`),
    runnerPath: path.join(buildsDir, `${buildId}.runner.cjs`)
  };
}

function watchedBuildRunnerSource({ command, cwd, logPath, sentinelPath }) {
  return `const fs = require("fs");
const { spawn } = require("child_process");

const command = ${JSON.stringify(String(command || ""))};
const cwd = ${JSON.stringify(String(cwd || process.cwd()))};
const logPath = ${JSON.stringify(String(logPath || ""))};
const sentinelPath = ${JSON.stringify(String(sentinelPath || ""))};
const isWin = process.platform === "win32";
let logFd = null;
let settled = false;

function writeSentinel(code) {
  fs.writeFileSync(sentinelPath, String(Number.isInteger(code) ? code : 1) + "\\n", "utf8");
}

function finish(code) {
  if (settled) return;
  settled = true;
  try {
    writeSentinel(code);
  } finally {
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch {}
    }
  }
  process.exit(Number.isInteger(code) ? code : 1);
}

try {
  fs.mkdirSync(require("path").dirname(logPath), { recursive: true });
  logFd = fs.openSync(logPath, "a");
  const shell = isWin ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
  const args = isWin
    ? ["/d", "/s", "/v:on", "/c", command]
    : ["-c", command];
  const child = spawn(shell, args, {
    cwd,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    windowsVerbatimArguments: isWin
  });
  child.on("error", (error) => {
    try { fs.writeSync(logFd, "build command failed to start: " + error.message + "\\n"); } catch {}
    finish(1);
  });
  child.on("exit", (code, signal) => {
    finish(Number.isInteger(code) ? code : signal ? 1 : 0);
  });
} catch (error) {
  try {
    fs.appendFileSync(logPath, "build runner failed: " + (error && error.message ? error.message : String(error)) + "\\n", "utf8");
  } catch {}
  finish(1);
}
`;
}

function watchedBuildSpawnSpec(runnerPath) {
  return {
    command: process.execPath,
    args: [runnerPath]
  };
}

function buildRegistryPath(buildsDir = buildSupervisorDir()) {
  return path.join(buildsDir, "registry.json");
}

function normalizeBuildRegistryEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const buildId = String(raw.buildId || "").trim();
  if (!buildId) return null;
  return {
    buildId,
    sessionId: raw.sessionId != null ? String(raw.sessionId) : "",
    command: raw.command != null ? String(raw.command) : "",
    cwd: raw.cwd != null ? String(raw.cwd) : "",
    pid: Number.isFinite(Number(raw.pid)) ? Number(raw.pid) : null,
    logPath: raw.logPath != null ? String(raw.logPath) : "",
    sentinelPath: raw.sentinelPath != null ? String(raw.sentinelPath) : "",
    status: raw.status != null ? String(raw.status) : "running",
    exitCode:
      Number.isInteger(raw.exitCode) || raw.exitCode === null ? raw.exitCode : null,
    startedAt: Number.isFinite(Number(raw.startedAt)) ? Number(raw.startedAt) : null,
    endedAt: Number.isFinite(Number(raw.endedAt)) ? Number(raw.endedAt) : null
  };
}

function readBuildRegistry(buildsDir = buildSupervisorDir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(buildRegistryPath(buildsDir), "utf8"));
    const entries = Array.isArray(raw) ? raw : Object.values(raw || {});
    return entries.map(normalizeBuildRegistryEntry).filter(Boolean);
  } catch {
    return [];
  }
}

function applyFinishingHint(build, entry) {
  if (entry.status === "running" && entry.sentinelPath) {
    try {
      if (fs.existsSync(entry.sentinelPath) && fs.statSync(entry.sentinelPath).size > 0) {
        build.status = "finishing";
      }
    } catch {
      // The supervisor owns registry mutation; status hints are best-effort.
    }
  }
}

function buildEntryForStatus(entry) {
  const build = {
    buildId: entry.buildId,
    status: entry.status,
    exitCode: entry.exitCode,
    pid: entry.pid,
    command: entry.command,
    cwd: entry.cwd,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt
  };
  applyFinishingHint(build, entry);
  return build;
}

function buildEntryForList(entry) {
  const build = {
    buildId: entry.buildId,
    status: entry.status,
    command: entry.command,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt
  };
  applyFinishingHint(build, entry);
  return build;
}

async function codexBuildStatus(buildId) {
  const id = String(buildId || "").trim();
  const builds = readBuildRegistry().sort(
    (a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0)
  );
  if (!id) {
    return { status: "ok", builds: builds.map(buildEntryForList) };
  }
  const entry = builds.find((item) => item.buildId === id);
  if (!entry) {
    return { status: "not_found", buildId: id };
  }
  return {
    status: "ok",
    build: buildEntryForStatus(entry),
    tail: tailFile(entry.logPath)
  };
}

async function codexBuildCancel(buildId) {
  const id = String(buildId || "").trim();
  if (!id) {
    return {
      status: "failed",
      error: "codex_build_cancel requires buildId"
    };
  }
  postTelemetry({
    type: "fusion.build-task",
    phase: "cancel-request",
    buildId: id
  });
  return {
    status: "cancel-requested",
    buildId: id,
    note:
      "Cancellation requested; the build supervisor will kill the process tree and send a cancelled report."
  };
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

  if (fanoutActive || fanoutWorkers.size > 0) {
    // Parallel workers keep their scoped tasks; push/replan routing assumes ONE
    // executor turn. Return skipped so the host falls back to the planner-thread
    // steer path and the planner sees the steer when the fan-out returns.
    steerBuffer.pop();
    relay({
      role: "codex",
      kind: "steer",
      text: "steering left for planner thread; parallel workers keep their scoped tasks"
    });
    return { status: "skipped", reason: "fanout_active" };
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
  if (fanoutWorkers.size > 0) {
    // Interrupt every live worker; each settles through its own turn/completed
    // (interrupted) notification (idle timers backstop a silent child), and the
    // aggregate resolves normally with the per-worker interruption results.
    let interrupted = 0;
    for (const worker of fanoutWorkers.values()) {
      if (worker.settled || !worker.turnId) continue;
      interrupted += 1;
      rpc("turn/interrupt", { threadId: worker.threadId, turnId: worker.turnId }).catch(() => {});
    }
    relay({
      role: "codex",
      kind: "interrupt",
      text: `interrupting ${interrupted} parallel Fusion worker${interrupted === 1 ? "" : "s"}`
    });
    return { status: "accepted", workers: interrupted };
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
  if (turn.absoluteTimer) {
    clearTimeout(turn.absoluteTimer);
    turn.absoluteTimer = null;
  }
}

function timeoutMinutes(timeoutMs) {
  return Math.max(1, Math.ceil(timeoutMs / 60000));
}

function rememberTimedOutTurnId(turnId) {
  if (!turnId) return;
  timedOutTurnIds.add(turnId);
  while (timedOutTurnIds.size > 32) {
    timedOutTurnIds.delete(timedOutTurnIds.values().next().value);
  }
}

function isTimedOutTurnLifecycle(value) {
  const turnId = extractTurnId(value);
  return Boolean(turnId && timedOutTurnIds.has(turnId));
}

function interruptCurrentTurnForCeiling(error) {
  if (fanoutActive || fanoutWorkers.size > 0) {
    abortFanoutWorkers(error, { interrupt: true });
    return;
  }
  if (activeExecutorFamily === "claude") {
    if (!claudeTurnActive) return;
    claudeTurnActive = false;
    claudeInterruptRequested = false;
    claudeTextParts = [];
    claudeProgressTextParts = [];
    sendClaudeInterruptRequest();
    // Claude stream events carry no turn id. Retire this child after requesting
    // the interrupt so an old result cannot arrive during the next delegation.
    killClaudeExecutor();
    return;
  }
  if (!threadId || !activeTurnId) return;
  const turnId = activeTurnId;
  rememberTimedOutTurnId(turnId);
  rpc("turn/interrupt", { threadId, turnId }).catch(() => {});
}

function failCurrentTurnForCeiling(error) {
  if (!currentTurn) return;
  currentTurn.timedOut = true;
  interruptCurrentTurnForCeiling(error);
  resolveTurn({ status: "failed", error });
}

function refreshTurnHardTimer(reason = "verifiable progress") {
  if (!currentTurn) return;
  if (currentTurn.hardTimer) clearTimeout(currentTurn.hardTimer);
  const turn = currentTurn;
  turn.hardProgressReason = reason;
  const timer = setTimeout(() => {
    if (currentTurn !== turn || turn.hardTimer !== timer) return;
    failCurrentTurnForCeiling(
      `Fusion turn made no verifiable progress (tool/file/command activity) for ${timeoutMinutes(TURN_HARD_TIMEOUT_MS)} minutes and was interrupted.`
    );
  }, TURN_HARD_TIMEOUT_MS);
  turn.hardTimer = timer;
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
  timedOutTurnIds.clear();
  abortFanoutWorkers("Fusion execution process was reset.");
  abortBackgroundWorkers("Fusion execution process was reset.", { engines: "codex" });
  clearSteerRoutingState();
  currentGoal = null;
  goalFeatureAvailable = null;
}

function resetHarness(reason = "Fusion stopped.") {
  parked.clear();
  abortBackgroundWorkers(reason);
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
    if (
      request.method !== "POST" ||
      !["/steer", "/interrupt", "/stop", "/mode", "/background-cancel"].includes(request.url)
    ) {
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
        } else if (request.url === "/background-cancel") {
          result = cancelBackgroundTask(String(parsed.taskId || ""));
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
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // ignore non-JSON lines
        }
        try {
          handleSouth(parsed);
        } catch (error) {
          // A throw inside notification/response handling used to be swallowed
          // with the JSON noise, silently stranding turns. Surface it.
          logErr(
            `south handler error (${(parsed && parsed.method) || "response"}): ${error?.message || error}`
          );
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
  abortFanoutWorkers(message);
  abortBackgroundWorkers(message, { engines: "codex" });
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
const CLAUDE_FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
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
let claudeProgressTextParts = [];
let claudeInterruptSeq = 0;
let claudeFastSeq = 0;

function writeClaudeExecutorSettingsFile(fast) {
  const baseDir = SETTINGS_FILE ? path.dirname(SETTINGS_FILE) : os.tmpdir();
  const file = SETTINGS_FILE
    ? path.join(baseDir, "fusion-claude-executor-settings.json")
    : path.join(os.tmpdir(), `fusion-claude-executor-settings-${process.pid}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fastMode: fast === true }, null, 2) + "\n");
  return file;
}

// Engine selection is per delegation (the settings file is re-read every
// call), but NEVER mid-turn: a live settings flip applies to the NEXT
// delegation, otherwise a goal-sync inside the running turn would tear down
// the engine that is executing it.
function ensureExecutorFamily(family) {
  if (activeExecutorFamily === family) return activeExecutorFamily;
  if (currentTurn || turnArming || claudeTurnActive || fanoutActive) {
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

function writeChildJson(child, obj) {
  if (!child || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
    return false;
  }
  try {
    child.stdin.write(`${JSON.stringify(obj)}\n`);
    return true;
  } catch {
    return false;
  }
}

function claudeSend(obj) {
  return writeChildJson(claudeChild, obj);
}

function killChildProcessTree(child) {
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
  killChildProcessTree(child);
}

function buildClaudeExecutorArgs(settings = {}) {
  const { buildClaudeArgs } = require("./fusionChatHost.cjs");
  return buildClaudeArgs({
    cwd: CWD,
    model: settings.model || "sonnet",
    effort: settings.effort || undefined,
    settingsFile: writeClaudeExecutorSettingsFile(settings.fast === true),
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

function shouldRelayClaudeProgressMessage(text) {
  const trimmed = String(text || "").trim();
  return Boolean(trimmed && !trimmed.includes(VERDICT_MARKER));
}

function flushClaudeProgressMessage() {
  const text = claudeProgressTextParts.join("").trim();
  claudeProgressTextParts = [];
  if (!shouldRelayClaudeProgressMessage(text)) return;
  relay({ role: "codex", kind: "message", text: summarizeAgentMessageForDisplay(text) });
}

function flushBackgroundClaudeProgressMessage(worker) {
  const text = (worker.progressTextParts || []).join("").trim();
  worker.progressTextParts = [];
  if (!shouldRelayClaudeProgressMessage(text)) return;
  postBackgroundProgress(worker, "message", summarizeAgentMessageForDisplay(text));
}

function handleClaudeExecutorEvent(event) {
  if (!event || !claudeTurnActive) return;
  switch (event.type) {
    case "assistant-text":
      claudeTextParts.push(event.delta || "");
      claudeProgressTextParts.push(event.delta || "");
      refreshTurnIdleTimer("executor text");
      break;
    case "thinking":
      refreshTurnIdleTimer("executor thinking");
      break;
    case "tool-call": {
      flushClaudeProgressMessage();
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
      refreshTurnHardTimer(`executor ${name || "tool"}`);
      break;
    }
    case "tool-result":
      refreshTurnIdleTimer("executor tool result");
      refreshTurnHardTimer("executor tool result");
      break;
    case "turn-error":
      claudeTurnErrorText = event.message || claudeTurnErrorText;
      refreshTurnIdleTimer("executor turn error");
      break;
    case "turn-start":
    case "turn-end":
      if (event.type === "turn-end" && event.awaitsToolResult) {
        flushClaudeProgressMessage();
      }
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
  claudeProgressTextParts = [];
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
    claudeProgressTextParts = [];
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
  if (isTimedOutTurnLifecycle(turn)) {
    logErr(`ignored late turn/completed from timed-out turn ${turnId}`);
    return;
  }
  if (activeTurnId && turnId && activeTurnId !== turnId) {
    // Main-thread completions are authoritative even on an id mismatch:
    // turn/start on an already-busy thread (the native goal turn) returns a
    // SUBMISSION id that never becomes a turn, and dropping the real
    // TurnCompleted here stranded the waiter until the idle/hard timers fired
    // a false "exceeded the maximum duration" failure. Child-thread traffic
    // never reaches this handler (thread routing in handleNotification), so
    // log the mismatch and resolve anyway.
    logErr(`turn/completed id mismatch (active ${activeTurnId}, completed ${turnId}); resolving anyway`);
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

function handleTurnStartResponse(response, requestedTurn = null) {
  const nextTurnId = extractTurnId(response);
  if (requestedTurn && requestedTurn.timedOut) {
    if (nextTurnId) {
      rememberTimedOutTurnId(nextTurnId);
      if (threadId) {
        rpc("turn/interrupt", { threadId, turnId: nextTurnId }).catch(() => {});
      }
    }
    return;
  }
  if (nextTurnId && timedOutTurnIds.has(nextTurnId)) {
    logErr(`ignored late turn/start response from timed-out turn ${nextTurnId}`);
    return;
  }
  // The response's turn id is the SUBMISSION id (turn_processor returns it as
  // turn_id). When the thread was already running a turn — the native goal
  // turn started by thread/goal/set — the submission is absorbed into that
  // turn and its id never becomes a real turn. A turn/started notification is
  // authoritative; never let the response overwrite an id one already set.
  if (nextTurnId && !activeTurnId) {
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

function isStrongCodexProgressNotification(method, params = {}) {
  if (method === "item/completed") {
    return Boolean(params.item && typeof params.item === "object");
  }
  return Boolean(
    method === "item/started" &&
      params.item &&
      typeof params.item === "object" &&
      params.item.type === "commandExecution"
  );
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

function notificationThreadId(params) {
  if (!params || typeof params !== "object") return null;
  const candidates = [
    params.threadId,
    params.thread_id,
    params.conversationId,
    params.conversation_id,
    params.thread && params.thread.id
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function handleNotification(msg) {
  const method = msg.method;
  const params = msg.params || {};
  // Fan-out and background worker events route to their scoped state and must
  // never touch the global single-turn machinery (a worker's turn/completed
  // would otherwise resolve the aggregate with a bogus single-turn result).
  const fanoutWorker = fanoutWorkerForParams(params);
  if (fanoutWorker) {
    handleFanoutNotification(fanoutWorker, method, params);
    return;
  }
  // Executor-spawned child threads (subagent/review children with their own
  // thread ids) stream on this same client. Their lifecycle must never touch
  // the main-thread turn machinery: a child turn/started used to hijack
  // activeTurnId, and a child's deltas/items polluted the main turn buffers.
  const sourceThreadId = notificationThreadId(params);
  if (sourceThreadId && sourceThreadId !== threadId) {
    if (method === "turn/started" || method === "turn/completed" || method === "turn/failed") {
      logErr(`ignored ${method} from non-main thread ${sourceThreadId}`);
    }
    return;
  }
  const staleTurnId = extractTurnId(params);
  if (
    staleTurnId &&
    timedOutTurnIds.has(staleTurnId) &&
    (method.startsWith("turn/") || method.startsWith("item/"))
  ) {
    logErr(`ignored late ${method} from timed-out turn ${staleTurnId}`);
    return;
  }
  if (isTurnProgressNotification(method, params)) {
    refreshTurnIdleTimer(method);
  }
  if (isStrongCodexProgressNotification(method, params)) {
    refreshTurnHardTimer(method);
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
    if (isTimedOutTurnLifecycle(params)) {
      logErr(`ignored late ${method} from timed-out turn ${notificationTurnId}`);
      return;
    }
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
  {
    // Requests raised by fan-out workers are answered inline, never parked.
    // While a fan-out is active, an UNMATCHED request is handled the same way
    // as matched ones: parking it would resolve the aggregate turn.
    const fanoutWorker = fanoutWorkerForParams(params);
    if (fanoutWorker || fanoutActive) {
      resolveFanoutServerRequest(fanoutWorker, msg);
      return;
    }
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

function readFirstShellToken(raw) {
  const source = String(raw || "");
  const text = source.trimStart();
  if (!text) return null;

  const quote = text[0];
  if (quote === `"` || quote === `'`) {
    let token = "";
    let escaped = false;
    for (let index = 1; index < text.length; index += 1) {
      const ch = text[index];
      if (escaped) {
        token += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\" && quote === `"` && text[index + 1] === quote) {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        return {
          token,
          rest: text.slice(index + 1).trimStart()
        };
      }
      token += ch;
    }
    return null;
  }

  const match = text.match(/^(\S+)([\s\S]*)$/);
  if (!match) return null;
  return {
    token: match[1],
    rest: (match[2] || "").trimStart()
  };
}

function shellBaseName(value) {
  const name = String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .toLowerCase();
  return name.replace(/\.exe$/i, "");
}

function stripOuterShellScriptQuotes(value) {
  const text = String(value || "").trim();
  const quote = text[0];
  if (quote !== `"` && quote !== `'`) return text;
  if (text.length < 2 || text[text.length - 1] !== quote) return null;
  const inner = text.slice(1, -1);
  if (quote === `"`) return inner.replace(/\\"/g, `"`).replace(/""/g, `"`);
  return inner.replace(/\\'/g, `'`).replace(/''/g, `'`);
}

function unwrapShellCommand(raw) {
  try {
    const source = String(raw || "");
    const first = readFirstShellToken(source);
    if (!first || !first.token || !first.rest) return source;

    const shell = shellBaseName(first.token);
    const flagMatch = first.rest.match(/^(-command|-lc|-c|\/c|\/k)(?:\s+|$)([\s\S]*)$/i);
    if (!flagMatch) return source;

    const flag = flagMatch[1].toLowerCase();
    const script = flagMatch[2];
    if (!script || !script.trim()) return source;

    const isPowerShell = shell === "pwsh" || shell === "powershell";
    const isPosixShell = shell === "bash" || shell === "sh" || shell === "zsh";
    const isCmd = shell === "cmd";
    const allowed =
      (isPowerShell && (flag === "-command" || flag === "-c" || flag === "-lc")) ||
      (isPosixShell && (flag === "-c" || flag === "-lc")) ||
      (isCmd && (flag === "/c" || flag === "/k"));
    if (!allowed) return source;

    const display = stripOuterShellScriptQuotes(script);
    return display == null ? source : display;
  } catch {
    return String(raw || "");
  }
}

function displayCommandFromItem(item) {
  const actions = Array.isArray(item?.commandActions)
    ? item.commandActions
    : Array.isArray(item?.command_actions)
      ? item.command_actions
      : [];
  if (actions.length > 0) {
    const commands = actions
      .map((action) => (typeof action?.command === "string" ? action.command.trim() : ""))
      .filter(Boolean);
    if (commands.length > 0) return commands.join(" ; ");
  }
  return unwrapShellCommand(String(item?.command || ""));
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
  const display = displayCommandFromItem(item);
  return clippedCommandPreview(display || command);
}

function commandExecutionDisplayText(item) {
  const summary = summarizeCommandExecution(item);
  if (item && item.exitCode != null) return `${summary} (exit ${item.exitCode})`;
  const status = item && item.status;
  if (status && status !== "completed") return `${summary} (${status})`;
  return summary;
}

function summarizeJsonValue(value, maxChars = 160, depth = 0) {
  if (value == null) return "";
  if (typeof value === "string") return clippedText(value, maxChars);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth >= 2) return "";
  if (Array.isArray(value)) {
    const parts = [];
    for (const entry of value.slice(0, 4)) {
      const remaining = Math.max(16, maxChars - parts.join("; ").length);
      const summary = summarizeJsonValue(entry, remaining, depth + 1);
      if (summary) parts.push(summary);
      if (parts.join("; ").length >= maxChars) break;
    }
    return clippedText(parts.join("; "), maxChars);
  }
  if (typeof value === "object") {
    for (const key of ["text", "message", "summary", "result"]) {
      if (typeof value[key] === "string" && value[key].trim()) {
        return clippedText(value[key], maxChars);
      }
    }
    const parts = [];
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const entry = value[key];
      const remaining = Math.max(16, maxChars - parts.join(", ").length - key.length - 2);
      const summary = summarizeJsonValue(entry, remaining, depth + 1);
      if (summary) parts.push(`${key}: ${summary}`);
      if (parts.length >= 4 || parts.join(", ").length >= maxChars) break;
    }
    return clippedText(parts.join(", "), maxChars);
  }
  return "";
}

function mcpToolCallDisplayText(item) {
  const server = String(item?.server || "server").trim();
  const tool = String(item?.tool || "tool").trim();
  const label = `mcp: ${server}.${tool}`;
  const details = [];
  if (item?.status) details.push(String(item.status));
  if (item?.error?.message) {
    details.push(clippedText(item.error.message, 160));
  } else if (item?.result?.content) {
    const summary = summarizeJsonValue(item.result.content);
    if (summary) details.push(summary);
  }
  return details.length ? `${label} - ${clippedText(details.join(": "), 160)}` : label;
}

function webSearchDisplayText(item) {
  const action = item?.action || {};
  const query =
    item?.query ||
    action.query ||
    (Array.isArray(action.queries) ? action.queries.filter(Boolean).join(", ") : "") ||
    action.url ||
    action.pattern ||
    "search";
  return `web search: ${clippedText(query, 160)}`;
}

function collabAgentDisplayText(item) {
  const tool = String(item?.tool || "tool").trim();
  const details = [];
  if (item?.status) details.push(String(item.status));
  if (item?.model) details.push(String(item.model));
  if (Array.isArray(item?.receiverThreadIds) && item.receiverThreadIds.length) {
    details.push(`${item.receiverThreadIds.length} agent${item.receiverThreadIds.length === 1 ? "" : "s"}`);
  }
  return details.length ? `collab: ${tool} - ${details.join(", ")}` : `collab: ${tool}`;
}

function subAgentActivityDisplayText(item) {
  const kind = String(item?.kind || "activity").trim();
  const agent = path.basename(String(item?.agentPath || "")).trim();
  return agent ? `sub-agent: ${kind} ${agent}` : `sub-agent: ${kind}`;
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

function threadItemActivity(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "agentMessage" && item.text) {
    return { kind: "message", text: summarizeAgentMessageForDisplay(item.text) };
  }
  if (item.type === "commandExecution") {
    return { kind: "command", text: commandExecutionDisplayText(item) };
  }
  if (item.type === "fileChange") {
    const files = (item.changes || [])
      .map((c) => `${c.type || "edit"} ${c.path || c.move_path || ""}`.trim())
      .join(", ");
    return { kind: "file", text: files || "file changes" };
  }
  if (item.type === "mcpToolCall") {
    return { kind: "command", text: mcpToolCallDisplayText(item) };
  }
  if (item.type === "webSearch") {
    return { kind: "command", text: webSearchDisplayText(item) };
  }
  if (item.type === "collabAgentToolCall") {
    return { kind: "command", text: collabAgentDisplayText(item) };
  }
  if (item.type === "subAgentActivity") {
    return { kind: "command", text: subAgentActivityDisplayText(item) };
  }
  // Reasoning items are intentionally not relayed to the UI activity stream.
  return null;
}

function relayItem(item) {
  const activity = threadItemActivity(item);
  if (activity) relay({ role: "codex", ...activity });
}

function accumulate(item) {
  if (item.type === "agentMessage" && item.text) turnSummary.push(item.text);
  if (item.type === "fileChange") {
    for (const c of item.changes || []) {
      if (c.path || c.move_path) turnFiles.push(c.path || c.move_path);
    }
  }
}

// ---- parallel fan-out (batched scouts / executor workstreams) ----
// codex_investigate/codex_implement accept `tasks` (2-4 self-contained tasks)
// and run one concurrent turn per task on an ephemeral thread. The aggregate
// call keeps the normal single-turn latch (awaitTurn) so every existing guard
// holds; only the worker-scoped event routing below is new.

// Validates the task/tasks input. Returns {task} for the classic single-task
// path, {tasks} for a parallel batch, or {error}.
function normalizeFanoutTasks(taskValue, tasksValue) {
  const hasTask = typeof taskValue === "string" && taskValue.trim().length > 0;
  const tasks = Array.isArray(tasksValue)
    ? tasksValue.map((t) => String(t || "").trim()).filter(Boolean)
    : null;
  if (hasTask && tasks && tasks.length > 0) {
    return { error: "Provide either task or tasks, not both." };
  }
  if (tasks) {
    if (tasks.length === 0) {
      return { error: "tasks must contain at least one non-empty task." };
    }
    if (tasks.length === 1) return { task: tasks[0] };
    if (tasks.length > FANOUT_MAX_TASKS) {
      return {
        error: `tasks supports at most ${FANOUT_MAX_TASKS} parallel entries; consolidate the work into fewer, larger self-contained scopes.`
      };
    }
    return { tasks };
  }
  if (hasTask) return { task: String(taskValue) };
  return { error: "task (string) or tasks (array of 2-4 strings) is required" };
}

function fanoutWorkerForParams(params) {
  if (!params || typeof params !== "object") return null;
  if (fanoutWorkers.size === 0 && backgroundWorkers.size === 0) return null;
  const candidates = [
    params.threadId,
    params.thread_id,
    params.conversationId,
    params.conversation_id,
    params.thread && params.thread.id
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) {
      if (fanoutWorkers.has(candidate)) return fanoutWorkers.get(candidate);
      // Background workers route exactly like fan-out workers: scoped state,
      // never the global single-turn machinery.
      if (backgroundWorkers.has(candidate)) return backgroundWorkers.get(candidate);
    }
  }
  // Fallback for payloads that carry only a turn id.
  const turnId = extractTurnId(params);
  if (!turnId) return null;
  for (const worker of fanoutWorkers.values()) {
    if (worker.turnId && worker.turnId === turnId) return worker;
  }
  for (const worker of backgroundWorkers.values()) {
    if (worker.turnId && worker.turnId === turnId) return worker;
  }
  return null;
}

function fanoutWorkerLabel(worker) {
  if (worker.background) return `background: ${worker.title}`;
  return `${worker.kind === "investigate" ? "scout" : "workstream"} ${worker.index + 1}/${worker.count}`;
}

function fanoutWorkerNoun(worker) {
  return worker && worker.background ? "background task" : "parallel worker";
}

function clearFanoutWorkerTimers(worker) {
  if (worker.idleTimer) {
    clearTimeout(worker.idleTimer);
    worker.idleTimer = null;
  }
  if (worker.hardTimer) {
    clearTimeout(worker.hardTimer);
    worker.hardTimer = null;
  }
  if (worker.absoluteTimer) {
    clearTimeout(worker.absoluteTimer);
    worker.absoluteTimer = null;
  }
}

function refreshFanoutWorkerIdleTimer(worker, reason = "progress") {
  const idleTimeoutMs =
    Number.isFinite(Number(worker.idleTimeoutMs)) && Number(worker.idleTimeoutMs) > 0
      ? Number(worker.idleTimeoutMs)
      : TURN_IDLE_TIMEOUT_MS;
  if (worker.settled || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    return;
  }
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  worker.idleTimer = setTimeout(() => {
    if (worker.background) interruptTimedOutBackgroundWorker(worker);
    settleFanoutWorker(worker, {
      status: "failed",
      error: `Fusion ${fanoutWorkerNoun(worker)} stalled after ${reason}.`
    });
  }, idleTimeoutMs);
}

function interruptTimedOutBackgroundWorker(worker) {
  if (!worker || worker.settled || !worker.background) return;
  worker.timedOut = true;
  // Codex-family background workers ride the shared app-server, so there is no
  // process tree to kill here; interrupt the specific turn. Claude-family
  // background workers have worker.child and are reaped in finalizeBackgroundWorker.
  if (!worker.child && worker.turnId) {
    rpc("turn/interrupt", { threadId: worker.threadId, turnId: worker.turnId }).catch(() => {});
  }
}

function interruptTimedOutFanoutWorker(worker) {
  if (!worker || worker.settled) return;
  worker.timedOut = true;
  if (worker.background) {
    interruptTimedOutBackgroundWorker(worker);
    return;
  }
  if (worker.turnId) {
    rpc("turn/interrupt", { threadId: worker.threadId, turnId: worker.turnId }).catch(() => {});
  }
}

function fanoutWorkerHardTimeoutError(worker) {
  if (worker.background) {
    return "Fusion background task exceeded the maximum duration.";
  }
  return `Fusion parallel worker made no verifiable progress (tool/file/command activity) for ${timeoutMinutes(TURN_HARD_TIMEOUT_MS)} minutes and was interrupted.`;
}

function refreshFanoutWorkerHardTimer(worker, reason = "verifiable progress") {
  if (!worker || worker.settled) return;
  const hardTimeoutMs = Number(worker.hardTimeoutMs);
  const absoluteTimeoutMs = Number(worker.absoluteTimeoutMs);
  if (!Number.isFinite(hardTimeoutMs) || hardTimeoutMs <= 0) return;
  const now = Date.now();
  if (!Number.isFinite(worker.absoluteDeadline)) {
    worker.absoluteDeadline = now + absoluteTimeoutMs;
  }
  const remainingAbsolute = Math.max(0, worker.absoluteDeadline - now);
  const delay = Number.isFinite(remainingAbsolute)
    ? Math.min(hardTimeoutMs, remainingAbsolute)
    : hardTimeoutMs;
  if (worker.hardTimer) clearTimeout(worker.hardTimer);
  worker.hardProgressReason = reason;
  const timer = setTimeout(() => {
    if (worker.settled || worker.hardTimer !== timer) return;
    interruptTimedOutFanoutWorker(worker);
    settleFanoutWorker(worker, {
      status: "failed",
      error: fanoutWorkerHardTimeoutError(worker)
    });
  }, delay);
  worker.hardTimer = timer;
}

// Settles the worker's promise. The worker stays in the registry until the
// whole fan-out finalizes so its late notifications keep routing here instead
// of leaking into the global single-turn handlers.
function settleFanoutWorker(worker, result) {
  if (worker.settled) return;
  worker.settled = true;
  clearFanoutWorkerTimers(worker);
  worker.resolve(result);
}

function createFanoutWorker(kind, task, index, count, workerThreadId) {
  const worker = {
    kind,
    task,
    index,
    count,
    threadId: workerThreadId,
    turnId: null,
    summary: [],
    files: [],
    notes: [],
    itemIds: new Set(),
    deltas: new Map(),
    idleTimeoutMs: TURN_IDLE_TIMEOUT_MS,
    hardTimeoutMs: TURN_HARD_TIMEOUT_MS,
    absoluteTimeoutMs: TURN_ABSOLUTE_TIMEOUT_MS,
    absoluteDeadline: null,
    idleTimer: null,
    hardTimer: null,
    absoluteTimer: null,
    settled: false,
    resolve: null,
    promise: null
  };
  worker.promise = new Promise((resolve) => {
    worker.resolve = resolve;
  });
  worker.absoluteTimer = setTimeout(() => {
    if (worker.settled) return;
    interruptTimedOutFanoutWorker(worker);
    settleFanoutWorker(worker, {
      status: "failed",
      error:
        "Fusion parallel worker exceeded the maximum duration and was interrupted. Re-delegate a smaller milestone or use background delegation."
    });
  }, TURN_ABSOLUTE_TIMEOUT_MS);
  refreshFanoutWorkerHardTimer(worker, "worker start");
  refreshFanoutWorkerIdleTimer(worker, "worker start");
  return worker;
}

function relayFanoutItem(worker, item) {
  if (worker.background) {
    relayBackgroundItem(worker, item);
    return;
  }
  const label = fanoutWorkerLabel(worker);
  const activity = threadItemActivity(item);
  if (activity) relay({ role: "codex", kind: activity.kind, text: `[${label}] ${activity.text}` });
}

function accumulateFanoutItem(worker, item, options = {}) {
  if (!item || typeof item !== "object") return;
  const itemId = typeof item.id === "string" ? item.id : "";
  if (itemId && worker.itemIds.has(itemId)) return;
  if (itemId) worker.itemIds.add(itemId);
  if (options.relay !== false) relayFanoutItem(worker, item);
  if (item.type === "agentMessage" && item.text) worker.summary.push(item.text);
  if (item.type === "fileChange") {
    for (const c of item.changes || []) {
      if (c.path || c.move_path) worker.files.push(c.path || c.move_path);
    }
  }
}

function accumulateFanoutItems(worker, items, options = {}) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    accumulateFanoutItem(worker, item, options);
  }
}

function fanoutWorkerNotesBlock(worker) {
  if (!worker.notes.length) return "";
  return `\n\n[auto-handled requests]\n- ${worker.notes.join("\n- ")}`;
}

function fanoutWorkerInvestigationResult(worker) {
  const streamedText = Array.from(worker.deltas.values()).join("").trim();
  const findings = (worker.summary.join("\n").trim() || streamedText).trim();
  const files = Array.from(
    new Set([...worker.files.filter(Boolean), ...extractReferencedFiles(findings)])
  );
  return {
    status: "completed",
    findings: `${findings || "(No findings returned.)"}${fanoutWorkerNotesBlock(worker)}`,
    files
  };
}

function fanoutWorkerTurnResult(worker) {
  const streamedText = Array.from(worker.deltas.values()).join("").trim();
  const rawSummary = (worker.summary.join("\n").trim() || streamedText).trim();
  const verifierVerdict = extractVerifierVerdict(rawSummary);
  const displaySummary = stripVerifierVerdictFromSummary(rawSummary);
  return {
    status: "completed",
    summary: `${displaySummary || verifierVerdict.summary || "(No message returned.)"}${fanoutWorkerNotesBlock(worker)}`,
    files: Array.from(new Set(worker.files.filter(Boolean))),
    goalReached: verifierVerdict.goalReached,
    bugsFound: verifierVerdict.bugsFound,
    missingRequirements: verifierVerdict.missingRequirements,
    nextAction: verifierVerdict.nextAction,
    verifierSummary: verifierVerdict.summary,
    verifierVerdict
  };
}

function finishFanoutWorkerTurn(worker, turn) {
  accumulateFanoutItems(worker, turn && turn.items);
  const status = turn && turn.status;
  if (status === "failed") {
    settleFanoutWorker(worker, { status: "failed", error: turnErrorMessage(turn) });
    return;
  }
  if (status === "interrupted") {
    settleFanoutWorker(worker, {
      status: "failed",
      error: `Fusion ${fanoutWorkerNoun(worker)} was interrupted.`,
      cancelled: worker.cancelled === true
    });
    return;
  }
  settleFanoutWorker(
    worker,
    worker.kind === "investigate"
      ? fanoutWorkerInvestigationResult(worker)
      : fanoutWorkerTurnResult(worker)
  );
}

// Worker-scoped twin of handleNotification: called for any notification whose
// payload resolves to a registered fan-out worker.
function handleFanoutNotification(worker, method, params) {
  if (worker.settled) return;
  refreshFanoutWorkerIdleTimer(worker, method);
  const strongProgress = isStrongCodexProgressNotification(method, params);
  if (strongProgress) {
    refreshFanoutWorkerHardTimer(worker, method);
  }
  // Worker progress is aggregate progress: keep the aggregate waiter's idle
  // backstop from firing while any worker is still streaming. Background
  // workers have NO aggregate waiter — their progress must never keep an
  // unrelated foreground turn alive.
  if (!worker.background) {
    refreshTurnIdleTimer(`fanout ${method}`);
    if (strongProgress) refreshTurnHardTimer(`fanout ${method}`);
  }
  if (method === "turn/started") {
    const turnId = extractTurnId(params);
    if (turnId) worker.turnId = turnId;
    accumulateFanoutItems(worker, params.turn && params.turn.items, { relay: false });
    return;
  }
  if (method === "item/agentMessage/delta") {
    const itemId =
      typeof params.itemId === "string" && params.itemId ? params.itemId : "__default__";
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (delta) worker.deltas.set(itemId, `${worker.deltas.get(itemId) || ""}${delta}`);
    return;
  }
  if (method === "item/completed" && params.item) {
    accumulateFanoutItem(worker, params.item);
    return;
  }
  if (method === "turn/completed") {
    finishFanoutWorkerTurn(worker, params.turn);
    return;
  }
  if (method === "turn/failed" || method === "error") {
    const message =
      (params.error && params.error.message) ||
      params.message ||
      `Fusion ${fanoutWorkerNoun(worker)} failed`;
    settleFanoutWorker(worker, { status: "failed", error: message });
  }
}

const FANOUT_QUESTION_ANSWER =
  "This task is running as one of several parallel Fusion workers, so no mid-turn questions are available. " +
  "Choose the most reasonable interpretation within your stated scope, or stop and report the blocker in your final report.";

const BACKGROUND_QUESTION_ANSWER =
  "This task is running as a detached background Fusion task, so no mid-turn questions are available. " +
  "Choose the most reasonable interpretation within your stated scope, or stop and report the blocker in your final report.";

// During a fan-out, server->client requests are answered inline (never
// parked): parking one would resolve the aggregate turn with needs_decision
// while the other workers keep running.
function resolveFanoutServerRequest(worker, msg) {
  const method = String(msg.method || "");
  const params = msg.params || {};
  const label = worker ? fanoutWorkerLabel(worker) : "parallel worker";
  const note = (text) => {
    if (worker) worker.notes.push(text);
  };
  const reportAutoHandledRequest = (mainText, backgroundText = mainText) => {
    if (worker && worker.background) {
      postBackgroundProgress(worker, "approval", backgroundText);
      return;
    }
    relay({ role: "codex", kind: "approval", text: `[${label}] ${mainText}` });
  };
  if (method.endsWith("requestUserInput")) {
    const answers = {};
    const autoAnswer =
      worker && worker.background ? BACKGROUND_QUESTION_ANSWER : FANOUT_QUESTION_ANSWER;
    for (const q of params.questions || []) {
      answers[q.id] = { answers: [autoAnswer] };
    }
    codexSend({ id: msg.id, result: { answers } });
    note(`question auto-answered (report blockers in the final report): ${approvalDetail(method, params)}`);
    reportAutoHandledRequest("question auto-deferred to the final report");
    return;
  }
  if (PARKED_REQUEST_METHODS.has(method)) {
    codexSend({ id: msg.id, result: buildDecisionResult(method, params, "decline") });
    const kind = approvalKind(method);
    note(`${kind} auto-declined: ${approvalDetail(method, params)}`);
    reportAutoHandledRequest(`${kind} auto-declined (parallel worker)`, `${kind} auto-declined`);
    return;
  }
  sendServerError(msg.id, `Fusion parallel workers do not support ${method}.`);
  note(`unsupported request ${method} refused`);
}

function buildFanoutScoutTask(task, index, count) {
  return [
    buildCodexInvestigationTask(task),
    "",
    `## Parallel scout ${index + 1} of ${count}`,
    "You are one of several read-only scouts investigating disjoint areas in parallel.",
    "Stay strictly within the scope of YOUR task above; other scouts cover the rest.",
    "No mid-turn questions are available: if something is ambiguous, choose the most reasonable read-only interpretation and note the ambiguity in your findings."
  ].join("\n");
}

function buildFanoutWorkstreamTask(task, index, count) {
  return [
    buildCodexVerifierTask(task),
    "",
    `## Parallel workstream ${index + 1} of ${count}`,
    "You are one of several executor workstreams running IN PARALLEL on this same checkout.",
    "Touch ONLY the files inside your workstream's stated scope. If a correct implementation seems to require editing a file outside that scope, do not edit it - report the need in your summary and verdict instead.",
    "Files changing underneath you that you did not edit may be another parallel workstream's work: do not overwrite or 'fix' them; note the overlap in your report.",
    'This workstream is one part of a larger parallel plan: judge goalReached against the LARGER goal (report goalReached:false and nextAction:"continue" unless your work alone truly completes it).',
    'No mid-turn questions are available in a parallel workstream: if you hit a genuine blocker, stop, list it in missingRequirements, and recommend nextAction:"continue".'
  ].join("\n");
}

async function startFanoutThread(kind, settings) {
  const params = {
    cwd: CWD,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    // Executor workstreams get the same workspace MCP surface as the main
    // executor thread; scouts stay minimal (no goals, no MCP injection).
    config: kind === "implement" ? { ...workspaceMcpConfigOverrides(CWD) } : {}
  };
  applyCodexModelSetting(params, settings);
  await applyCodexFastTier(params, settings);
  const res = await rpc("thread/start", params);
  const workerThreadId = res && res.thread && res.thread.id;
  if (!workerThreadId) throw new Error("thread/start returned no thread id for a parallel worker");
  return workerThreadId;
}

async function runFanoutWorker(kind, task, index, count, run) {
  const settings = readCodexSettings();
  const workerThreadId = await startFanoutThread(kind, settings);
  // A cancel/reset that landed while thread/start was in flight must not
  // launch a stray turn the abort path could no longer see.
  if (run && run.aborted) {
    return { status: "failed", error: "Fusion fan-out was cancelled before this worker started." };
  }
  const worker = createFanoutWorker(kind, task, index, count, workerThreadId);
  fanoutWorkers.set(workerThreadId, worker);
  relay({
    role: "codex",
    kind: "activity",
    text: `[${fanoutWorkerLabel(worker)}] started: ${clippedText(task, 160)}`
  });
  const text =
    kind === "investigate"
      ? buildFanoutScoutTask(task, index, count)
      : buildFanoutWorkstreamTask(task, index, count);
  const params = {
    threadId: workerThreadId,
    input: [{ type: "text", text, text_elements: [] }],
    approvalPolicy: "never",
    sandboxPolicy:
      kind === "investigate" ? fusionCodexInvestigateSandboxPolicy() : fusionCodexSandboxPolicy()
  };
  await applyCodexTurnSettings(params);
  rpc("turn/start", params)
    .then((response) => {
      const turnId = extractTurnId(response);
      if (turnId && !worker.turnId) worker.turnId = turnId;
      if (worker.timedOut && worker.turnId) {
        rpc("turn/interrupt", { threadId: worker.threadId, turnId: worker.turnId }).catch(() => {});
        return;
      }
      const turn = response && response.turn;
      if (!turn || typeof turn !== "object" || worker.settled) return;
      accumulateFanoutItems(worker, turn.items, { relay: false });
      if (["completed", "failed", "interrupted"].includes(turn.status)) {
        finishFanoutWorkerTurn(worker, turn);
      }
    })
    .catch((error) => settleFanoutWorker(worker, { status: "failed", error: error.message }));
  return worker.promise;
}

function clearFanoutRegistry() {
  for (const worker of fanoutWorkers.values()) clearFanoutWorkerTimers(worker);
  fanoutWorkers.clear();
}

// Hard-stops every worker (used by cancel/reset/child-death paths). Marks the
// active run aborted so finalize does not also resolve the aggregate - the
// caller owns the aggregate result after an abort.
function abortFanoutWorkers(reason, options = {}) {
  if (activeFanoutRun) activeFanoutRun.aborted = true;
  if (fanoutWorkers.size === 0) return false;
  for (const worker of Array.from(fanoutWorkers.values())) {
    if (options.interrupt && !worker.settled && worker.turnId) {
      rpc("turn/interrupt", { threadId: worker.threadId, turnId: worker.turnId }).catch(() => {});
    }
    settleFanoutWorker(worker, { status: "failed", error: reason });
  }
  clearFanoutRegistry();
  return true;
}

// Launches all workers; resolves the aggregate awaitTurn() waiter once the
// last worker settles. Never rejects - per-worker failures land in their slot.
function runCodexFanout(kind, tasks) {
  fanoutActive = true;
  const run = { aborted: false };
  activeFanoutRun = run;
  const results = new Array(tasks.length).fill(null);
  let settled = 0;
  const finalize = () => {
    if (activeFanoutRun === run) activeFanoutRun = null;
    fanoutActive = false;
    clearFanoutRegistry();
    if (!run.aborted) {
      resolveOrLatchTurn(combineFanoutResults(kind, tasks, results));
    }
  };
  tasks.forEach((task, index) => {
    runFanoutWorker(kind, task, index, tasks.length, run)
      .catch((error) => ({ status: "failed", error: error?.message || String(error) }))
      .then((result) => {
        results[index] = result || { status: "failed", error: "worker returned no result" };
        settled += 1;
        if (settled === tasks.length) finalize();
      });
  });
}

function fanoutFileConflicts(workers) {
  const seen = new Map(); // normalized path -> {path, count}
  for (const worker of workers) {
    const unique = new Set(
      (worker.files || []).map((f) => String(f || "").trim()).filter(Boolean)
    );
    for (const file of unique) {
      const key = isWin ? file.toLowerCase().replace(/\//g, "\\") : file;
      const entry = seen.get(key) || { path: file, count: 0 };
      entry.count += 1;
      seen.set(key, entry);
    }
  }
  return Array.from(seen.values())
    .filter((entry) => entry.count > 1)
    .map((entry) => entry.path);
}

function fanoutSectionLabel(kind, index, count) {
  return `${kind === "investigate" ? "Scout" : "Workstream"} ${index + 1}/${count}`;
}

function combineFanoutResults(kind, tasks, results) {
  const count = tasks.length;
  const normalized = results.map(
    (result) => result || { status: "failed", error: "worker returned no result" }
  );
  const files = Array.from(
    new Set(normalized.flatMap((result) => (Array.isArray(result.files) ? result.files : [])))
  );
  if (kind === "investigate") {
    const scouts = normalized.map((result, index) => ({
      task: tasks[index],
      status: result.status,
      findings:
        result.status === "completed"
          ? result.findings
          : `(scout failed: ${result.error || "unknown error"})`,
      files: Array.isArray(result.files) ? result.files : []
    }));
    const findings = scouts
      .map(
        (scout, index) =>
          `### ${fanoutSectionLabel(kind, index, count)} - ${clippedText(scout.task, 160)}\n${scout.findings}`
      )
      .join("\n\n");
    return { status: "completed", findings, files, scouts };
  }
  const workers = normalized.map((result, index) => ({
    task: tasks[index],
    status: result.status,
    summary:
      result.status === "completed"
        ? result.summary
        : `(workstream failed: ${result.error || "unknown error"})`,
    files: Array.isArray(result.files) ? result.files : [],
    goalReached: result.goalReached === true,
    bugsFound: Array.isArray(result.bugsFound) ? result.bugsFound : [],
    missingRequirements: Array.isArray(result.missingRequirements)
      ? result.missingRequirements
      : [],
    nextAction: result.nextAction || "continue",
    verifierVerdict: result.verifierVerdict || null
  }));
  const fileConflicts = fanoutFileConflicts(workers);
  const completedCount = workers.filter((w) => w.status === "completed").length;
  const allDone = workers.every(
    (w) => w.status === "completed" && w.goalReached && w.nextAction === "done"
  );
  const askHuman = workers.some((w) => w.nextAction === "ask_human");
  const goalReached = allDone && fileConflicts.length === 0;
  const nextAction = askHuman ? "ask_human" : goalReached ? "done" : "continue";
  const conflictWarning = fileConflicts.length
    ? `Parallel workstreams touched overlapping files: ${fileConflicts.join(", ")}. Review those files for conflicting edits before proceeding.`
    : "";
  const verifierSummary = `Aggregate of ${count} parallel workstreams: ${completedCount} completed, ${count - completedCount} failed${
    fileConflicts.length ? `, ${fileConflicts.length} overlapping file(s)` : ""
  }.`;
  const bugsFound = Array.from(new Set(workers.flatMap((w) => w.bugsFound)));
  const missingRequirements = Array.from(
    new Set(workers.flatMap((w) => w.missingRequirements))
  );
  const summarySections = workers.map(
    (w, index) =>
      `### ${fanoutSectionLabel(kind, index, count)} - ${clippedText(w.task, 160)}\n${w.summary}`
  );
  const result = {
    status: "completed",
    summary: [conflictWarning, ...summarySections].filter(Boolean).join("\n\n"),
    files,
    goalReached,
    bugsFound,
    missingRequirements,
    nextAction,
    verifierSummary,
    verifierVerdict: {
      goalReached,
      bugsFound,
      missingRequirements,
      nextAction,
      summary: verifierSummary
    },
    workers
  };
  if (fileConflicts.length) {
    result.fileConflicts = fileConflicts;
    result.warning = conflictWarning;
  }
  return result;
}

// The claude executor engine is a single persistent child, so a batched call
// runs its tasks sequentially through the same shared turn machinery. Same
// API and combined result shape; `parallel:false` tells the planner the batch
// was serialized.
async function runClaudeFanoutSequential(kind, tasks, settings) {
  fanoutActive = true;
  try {
    const results = [];
    for (let index = 0; index < tasks.length; index += 1) {
      const wrapped = [
        tasks[index],
        "",
        `## Batched ${kind === "investigate" ? "scout" : "workstream"} ${index + 1} of ${tasks.length}`,
        "This task is part of a batched delegation that this executor engine runs sequentially.",
        "Stay strictly within this task's stated scope; the other batch entries are handled separately."
      ].join("\n");
      const result = await claudeExecutorTurn(wrapped, settings, kind);
      results.push(result);
      if (result && (result.status === "cancelled" || /not writable|process exited/i.test(result.error || ""))) {
        break;
      }
    }
    while (results.length < tasks.length) {
      results.push({ status: "failed", error: "batch stopped after an earlier engine failure" });
    }
    const combined = combineFanoutResults(kind, tasks, results);
    return {
      ...combined,
      parallel: false,
      note: "The current executor engine runs batched tasks sequentially."
    };
  } finally {
    fanoutActive = false;
  }
}

// ---- detached background delegation engine ----
// A background worker is a fan-out-shaped worker (same routing map lookups,
// same buffers, own idle/hard timers, inline server-request resolution) whose
// settle feeds fusion.background-task telemetry instead of an aggregate turn
// latch. It never touches currentTurn/fanoutActive, so foreground turns and
// user conversation stay fully available while it runs.

function backgroundTaskTitle(task) {
  const firstLine =
    String(task || "")
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || "background task";
  return clippedText(firstLine, 64);
}

function buildBackgroundTaskText(kind, task) {
  const base =
    kind === "investigate" ? buildCodexInvestigationTask(task) : buildCodexVerifierTask(task);
  return [
    base,
    "",
    "## Detached background task",
    "You are running as a DETACHED background Fusion task: the planner is not blocked on this call and no mid-turn questions or approvals are available.",
    "If something is ambiguous, choose the most reasonable interpretation within your stated scope, or stop and report the blocker in your final report" +
      (kind === "investigate" ? "." : " and verdict."),
    "Your final report is delivered to the planner when you finish; make it self-contained."
  ].join("\n");
}

function createBackgroundWorker(kind, task, taskId, routeKey) {
  const worker = {
    background: true,
    taskId,
    title: backgroundTaskTitle(task),
    startedAt: Date.now(),
    kind,
    task,
    index: 0,
    count: 1,
    threadId: routeKey,
    child: null,
    normalizer: null,
    stdoutBuffer: "",
    textParts: [],
    progressTextParts: [],
    turnId: null,
    summary: [],
    files: [],
    recentActivity: [],
    notes: [],
    itemIds: new Set(),
    deltas: new Map(),
    idleTimeoutMs: BACKGROUND_IDLE_TIMEOUT_MS,
    hardTimeoutMs: BACKGROUND_HARD_TIMEOUT_MS,
    absoluteTimeoutMs: BACKGROUND_HARD_TIMEOUT_MS,
    absoluteDeadline: null,
    idleTimer: null,
    hardTimer: null,
    absoluteTimer: null,
    settled: false,
    cancelled: false,
    updates: 0,
    resolve: null,
    promise: null
  };
  worker.promise = new Promise((resolve) => {
    worker.resolve = resolve;
  });
  refreshFanoutWorkerHardTimer(worker, "background start");
  refreshFanoutWorkerIdleTimer(worker, "background start");
  return worker;
}

function postBackgroundProgress(worker, activityKind, text) {
  if (!activityKind || worker.settled) return;
  worker.updates += 1;
  worker.recentActivity.push({
    ts: Date.now(),
    kind: activityKind,
    text: clippedText(text, 400)
  });
  if (worker.recentActivity.length > BACKGROUND_ACTIVITY_MAX_ITEMS) {
    worker.recentActivity.splice(
      0,
      worker.recentActivity.length - BACKGROUND_ACTIVITY_MAX_ITEMS
    );
  }
  postTelemetry({
    type: "fusion.background-task",
    phase: "progress",
    taskId: worker.taskId,
    title: worker.title,
    activityKind,
    text: clippedText(text, 400),
    updates: worker.updates
  });
}

function relayBackgroundItem(worker, item) {
  const activity = threadItemActivity(item);
  if (activity) postBackgroundProgress(worker, activity.kind, activity.text);
}

// The settled payload rides the telemetry callback server (64 KiB body cap);
// clip the long fields so a verbose executor cannot drop its own report.
function clipBackgroundResult(result) {
  const out = { ...(result || { status: "failed", error: "background worker returned no result" }) };
  if (typeof out.summary === "string") out.summary = clippedText(out.summary, 24000);
  if (typeof out.findings === "string") out.findings = clippedText(out.findings, 24000);
  if (typeof out.error === "string") out.error = clippedText(out.error, 2000);
  if (typeof out.verifierSummary === "string") {
    out.verifierSummary = clippedText(out.verifierSummary, 2000);
  }
  if (Array.isArray(out.files)) out.files = out.files.slice(0, 64);
  return out;
}

function finalizeBackgroundWorker(worker, result) {
  backgroundWorkers.delete(worker.threadId);
  clearFanoutWorkerTimers(worker);
  if (worker.child) {
    const child = worker.child;
    worker.child = null;
    killChildProcessTree(child);
  }
  const settled = result || { status: "failed", error: "background worker returned no result" };
  const settledAt = Date.now();
  const clippedResult = clipBackgroundResult(settled);
  const cancelled = worker.cancelled === true || settled.cancelled === true;
  settledBackgroundTasks.unshift({
    taskId: worker.taskId,
    title: worker.title,
    kind: worker.kind,
    state: cancelled ? "cancelled" : settled.status === "completed" ? "completed" : "failed",
    task: worker.task,
    startedAt: worker.startedAt,
    cancelled,
    durationMs: settledAt - worker.startedAt,
    elapsedMs: settledAt - worker.startedAt,
    settledAt,
    updates: worker.updates,
    files: Array.from(
      new Set([
        ...worker.files,
        ...(Array.isArray(clippedResult.files) ? clippedResult.files : [])
      ].filter(Boolean))
    ).slice(0, 64),
    recentActivity: worker.recentActivity.slice(),
    result: clippedResult
  });
  settledBackgroundTasks.splice(BACKGROUND_SETTLED_MAX_TASKS);
  postTelemetry(
    {
      type: "fusion.background-task",
      phase: "settled",
      taskId: worker.taskId,
      title: worker.title,
      kind: worker.kind,
      cancelled,
      updates: worker.updates,
      durationMs: Date.now() - worker.startedAt,
      result: clippedResult
    },
    3000
  );
}

async function startCodexBackgroundWorker(kind, task, taskId, settings) {
  // Boots the shared app-server child if needed; background threads ride it.
  await ensureThread();
  const workerThreadId = await startFanoutThread(kind, settings);
  const worker = createBackgroundWorker(kind, task, taskId, workerThreadId);
  backgroundWorkers.set(workerThreadId, worker);
  const params = {
    threadId: workerThreadId,
    input: [{ type: "text", text: buildBackgroundTaskText(kind, task), text_elements: [] }],
    approvalPolicy: "never",
    sandboxPolicy:
      kind === "investigate" ? fusionCodexInvestigateSandboxPolicy() : fusionCodexSandboxPolicy()
  };
  await applyCodexTurnSettings(params);
  rpc("turn/start", params)
    .then((response) => {
      const turnId = extractTurnId(response);
      if (turnId && !worker.turnId) worker.turnId = turnId;
      if (worker.timedOut && worker.turnId) {
        rpc("turn/interrupt", { threadId: worker.threadId, turnId: worker.turnId }).catch(() => {});
        return;
      }
      const turn = response && response.turn;
      if (!turn || typeof turn !== "object" || worker.settled) return;
      accumulateFanoutItems(worker, turn.items, { relay: false });
      if (["completed", "failed", "interrupted"].includes(turn.status)) {
        finishFanoutWorkerTurn(worker, turn);
      }
    })
    .catch((error) => settleFanoutWorker(worker, { status: "failed", error: error.message }));
  return worker;
}

function handleBackgroundClaudeEvent(worker, event) {
  if (!event || worker.settled) return;
  switch (event.type) {
    case "assistant-text":
      worker.textParts.push(event.delta || "");
      worker.progressTextParts.push(event.delta || "");
      refreshFanoutWorkerIdleTimer(worker, "executor text");
      break;
    case "thinking":
      refreshFanoutWorkerIdleTimer(worker, "executor thinking");
      break;
    case "tool-call": {
      flushBackgroundClaudeProgressMessage(worker);
      const name = claudeToolBaseName(event.name);
      const input = event.input && typeof event.input === "object" ? event.input : {};
      if (name === "Bash") {
        postBackgroundProgress(worker, "command", clippedCommandPreview(input.command));
      } else if (CLAUDE_FILE_TOOLS.has(name)) {
        const filePath = input.file_path || input.notebook_path || input.path || "";
        if (filePath) {
          worker.files.push(String(filePath));
          postBackgroundProgress(worker, "file", `edit ${filePath}`);
        }
      }
      refreshFanoutWorkerIdleTimer(worker, `executor ${name || "tool"}`);
      refreshFanoutWorkerHardTimer(worker, `executor ${name || "tool"}`);
      break;
    }
    case "tool-result":
      refreshFanoutWorkerIdleTimer(worker, "executor tool result");
      refreshFanoutWorkerHardTimer(worker, "executor tool result");
      break;
    case "turn-end":
      if (event.awaitsToolResult) {
        flushBackgroundClaudeProgressMessage(worker);
      }
      refreshFanoutWorkerIdleTimer(worker, "executor turn end");
      break;
    case "result": {
      const text = worker.textParts.join("").trim();
      worker.textParts = [];
      worker.progressTextParts = [];
      if (text) worker.summary.push(text);
      if (event.isError) {
        settleFanoutWorker(worker, {
          status: "failed",
          error:
            (typeof event.resultText === "string" && event.resultText) ||
            "Fusion background executor turn failed"
        });
        return;
      }
      settleFanoutWorker(
        worker,
        worker.kind === "investigate"
          ? fanoutWorkerInvestigationResult(worker)
          : fanoutWorkerTurnResult(worker)
      );
      break;
    }
    default:
      break;
  }
}

function startClaudeBackgroundWorker(kind, task, taskId, settings) {
  const worker = createBackgroundWorker(kind, task, taskId, `claude-${taskId}`);
  backgroundWorkers.set(worker.threadId, worker);
  const { windowsCmdArg, createStreamNormalizer } = require("./fusionChatHost.cjs");
  const args = buildClaudeExecutorArgs({
    model: settings.model || "sonnet",
    effort: settings.effort || null,
    fast: settings.fast === true
  });
  let child;
  try {
    if (isWin) {
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
  } catch (error) {
    backgroundWorkers.delete(worker.threadId);
    clearFanoutWorkerTimers(worker);
    throw error;
  }
  worker.child = child;
  worker.normalizer = createStreamNormalizer();
  child.stdout.on("data", (chunk) => {
    if (worker.child !== child) return;
    worker.stdoutBuffer += chunk.toString("utf8");
    let index;
    while ((index = worker.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = worker.stdoutBuffer.slice(0, index).trim();
      worker.stdoutBuffer = worker.stdoutBuffer.slice(index + 1);
      if (!line) continue;
      for (const event of worker.normalizer(line)) {
        handleBackgroundClaudeEvent(worker, event);
      }
    }
  });
  child.stderr.on("data", () => {});
  child.on("error", (error) => {
    settleFanoutWorker(worker, {
      status: "failed",
      error: `Fusion background executor failed: ${error.message}`
    });
  });
  child.on("exit", () => {
    settleFanoutWorker(worker, {
      status: "failed",
      error: "Fusion background executor process exited before finishing.",
      cancelled: worker.cancelled === true
    });
  });
  if (!writeChildJson(child, {
    type: "user",
    message: { role: "user", content: buildBackgroundTaskText(kind, task) }
  })) {
    settleFanoutWorker(worker, {
      status: "failed",
      error: "Fusion background executor channel is not writable"
    });
  }
  return worker;
}

function findBackgroundWorkerByTaskId(taskId) {
  const wanted = String(taskId || "").trim();
  if (!wanted) return null;
  for (const worker of backgroundWorkers.values()) {
    if (worker.taskId === wanted) return worker;
  }
  return null;
}

function activeBackgroundTaskList() {
  return Array.from(backgroundWorkers.values()).map((worker) => ({
    taskId: worker.taskId,
    title: worker.title,
    kind: worker.kind
  }));
}

function runningBackgroundTaskSnapshot(worker, now = Date.now()) {
  const assistantText =
    worker.summary.join("\n") + (worker.child ? worker.textParts.join("") : "");
  return {
    taskId: worker.taskId,
    title: worker.title,
    kind: worker.kind,
    state: "running",
    task: clippedText(worker.task, 400),
    startedAt: worker.startedAt,
    elapsedMs: now - worker.startedAt,
    updates: worker.updates,
    files: Array.from(new Set(worker.files)).slice(0, 64),
    recentActivity: worker.recentActivity.slice(),
    latestText: clippedText(assistantText.slice(-1000), 1000)
  };
}

function codexTaskStatus(taskId) {
  const wanted = String(taskId || "").trim();
  const now = Date.now();
  if (!wanted) {
    return {
      status: "ok",
      active: Array.from(backgroundWorkers.values())
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((worker) => runningBackgroundTaskSnapshot(worker, now)),
      recentlySettled: settledBackgroundTasks.slice(),
      note:
        "This peek is read-only and never blocks or settles a background task. The full report still arrives as a FUSION BACKGROUND TASK REPORT."
    };
  }
  const worker = findBackgroundWorkerByTaskId(wanted);
  if (worker) {
    return { status: "ok", task: runningBackgroundTaskSnapshot(worker, now) };
  }
  const settled = settledBackgroundTasks.find((entry) => entry.taskId === wanted);
  if (settled) {
    return {
      status: "ok",
      task: { ...settled },
      note:
        "This task already settled; its full report was (or is being) delivered as a FUSION BACKGROUND TASK REPORT message."
    };
  }
  return {
    status: "not_found",
    taskId: wanted,
    error: `Unknown background taskId: ${wanted}`,
    active: activeBackgroundTaskList(),
    recentlySettled: settledBackgroundTasks.slice()
  };
}

function cancelBackgroundTask(taskId) {
  const worker = findBackgroundWorkerByTaskId(taskId);
  if (!worker) {
    return {
      status: "error",
      error: `Unknown background taskId: ${taskId || "(none)"}`,
      backgroundTasks: activeBackgroundTaskList()
    };
  }
  worker.cancelled = true;
  if (worker.child) {
    writeChildJson(worker.child, {
      type: "control_request",
      request_id: `fusion_bg_int_${worker.taskId}`,
      request: { subtype: "interrupt" }
    });
  } else if (worker.turnId) {
    rpc("turn/interrupt", { threadId: worker.threadId, turnId: worker.turnId }).catch(() => {});
  }
  settleFanoutWorker(worker, {
    status: "failed",
    error: "Background task cancelled.",
    cancelled: true
  });
  return { status: "cancelled", taskId: worker.taskId, title: worker.title };
}

// Hard-stops background workers on process-level failures. engines:"codex"
// scopes the abort to workers riding the app-server child (a codex crash must
// not kill an unrelated claude-family background child); "all" is the
// stop/reset path. Every abort still settles → finalize → settled telemetry,
// so the planner is woken with the failure instead of the task vanishing.
function abortBackgroundWorkers(reason, options = {}) {
  const { engines = "all" } = options;
  if (backgroundWorkers.size === 0) return false;
  for (const worker of Array.from(backgroundWorkers.values())) {
    if (engines === "codex" && worker.child) continue;
    if (!worker.settled && !worker.child && worker.turnId) {
      rpc("turn/interrupt", { threadId: worker.threadId, turnId: worker.turnId }).catch(() => {});
    }
    if (worker.child) {
      // Kill synchronously: the stop path may exit the process before the
      // async finalize (promise microtask) would get to it.
      const child = worker.child;
      worker.child = null;
      killChildProcessTree(child);
    }
    settleFanoutWorker(worker, { status: "failed", error: reason });
  }
  return true;
}

async function startBackgroundDelegation(kind, task) {
  if (backgroundWorkers.size >= BACKGROUND_MAX_TASKS) {
    return {
      status: "error",
      error: `At most ${BACKGROUND_MAX_TASKS} background tasks may run at once; wait for one to settle or cancel one with codex_cancel {taskId}.`,
      backgroundTasks: activeBackgroundTaskList()
    };
  }
  const settings = readCodexSettings();
  const family = ensureExecutorFamily(settings.family);
  backgroundTaskSeq += 1;
  const taskId = `bg-${backgroundTaskSeq}`;
  let worker;
  try {
    worker =
      family === "claude"
        ? startClaudeBackgroundWorker(kind, task, taskId, settings)
        : await startCodexBackgroundWorker(kind, task, taskId, settings);
  } catch (error) {
    return { status: "failed", error: error?.message || String(error) };
  }
  postTelemetry({
    type: "fusion.background-task",
    phase: "started",
    taskId,
    title: worker.title,
    kind,
    task: clippedText(task, 8000)
  });
  worker.promise.then((result) => finalizeBackgroundWorker(worker, result));
  return {
    status: "started",
    taskId,
    title: worker.title,
    note:
      "The delegation is running as a detached background task. End your turn and tell the user what is running; the full report arrives as a FUSION BACKGROUND TASK REPORT message in a later turn. Review that report with your normal independent verification before acting on it."
  };
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
        config: {
          "features.goals": true,
          "features.fast_mode": true,
          ...workspaceMcpConfigOverrides(CWD)
        }
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
    currentTurn = {
      resolve,
      idleTimer: null,
      commandTimer: null,
      hardTimer: null,
      absoluteTimer: null
    };
    refreshTurnIdleTimer("turn start");
    refreshTurnHardTimer("turn start");
    const turn = currentTurn;
    turn.absoluteTimer = setTimeout(() => {
      if (currentTurn !== turn) return;
      failCurrentTurnForCeiling(
        "Fusion turn exceeded the maximum duration and was interrupted. Re-delegate a smaller milestone or use background delegation."
      );
    }, TURN_ABSOLUTE_TIMEOUT_MS);
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

async function codexWatchBuild(command, cwd) {
  const normalizedCommand = String(command || "").trim();
  if (!normalizedCommand) {
    return {
      status: "failed",
      error: "codex_watch_build requires a non-empty command"
    };
  }
  const resolvedCwd = path.resolve(String(cwd || CWD || process.cwd()));
  const buildsDir = buildSupervisorDir();
  const buildId = buildIdForWatch();
  const { logPath, sentinelPath, runnerPath } = watchedBuildPaths(buildId, buildsDir);
  const startedAt = Date.now();
  try {
    fs.mkdirSync(buildsDir, { recursive: true });
    fs.rmSync(sentinelPath, { force: true });
    fs.writeFileSync(logPath, "", "utf8");
    fs.writeFileSync(
      runnerPath,
      watchedBuildRunnerSource({
        command: normalizedCommand,
        cwd: resolvedCwd,
        logPath,
        sentinelPath
      }),
      "utf8"
    );
    const spec = watchedBuildSpawnSpec(runnerPath);
    const child = spawn(spec.command, spec.args, {
      cwd: resolvedCwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    postTelemetry({
      type: "fusion.build-task",
      phase: "started",
      buildId,
      command: clippedText(normalizedCommand, 8000),
      cwd: resolvedCwd,
      pid: child.pid,
      logPath,
      sentinelPath,
      startedAt
    });
    return {
      status: "watching",
      buildId,
      logPath,
      pid: child.pid,
      note:
        "Build launched detached; it survives turn boundaries. End your turn - a completion report will arrive in a later turn."
    };
  } catch (error) {
    return {
      status: "failed",
      error: error?.message || String(error)
    };
  }
}

// Orchestrator-reachable escape hatch for a wedged turn: clears local turn state
// so the next codex_implement starts fresh, without restarting the pane. The
// Codex thread and native goal stay alive. Unlike resetHarness (host-only, kills
// the child), this keeps the bridge warm and never blocks on the child.
function codexCancel(taskId) {
  // With a taskId this is a scoped background-task cancel: the foreground
  // turn, parked decisions, and other background tasks stay untouched.
  if (taskId) {
    return cancelBackgroundTask(taskId);
  }
  const hadActiveTurn = Boolean(
    currentTurn || activeTurnId || claudeTurnActive || steerRoutingPending || fanoutWorkers.size > 0
  );
  const clearedDecisions = parked.size > 0;
  // Best-effort: ask the app-server to abandon the active turn. Fire-and-forget
  // (never awaited) so a wedged or silent child cannot block the escape hatch.
  if (threadId && activeTurnId) {
    rpc("turn/interrupt", { threadId, turnId: activeTurnId }).catch(() => {});
  }
  // Same for any parallel fan-out workers: interrupt their turns and settle
  // them locally; the aborted-run flag stops the fan-out's own finalize from
  // latching a stale aggregate result over this cancel.
  abortFanoutWorkers("Fusion turn cancelled by the orchestrator.", { interrupt: true });
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
  const result = { status: "cancelled", hadActiveTurn, clearedDecisions };
  if (backgroundWorkers.size > 0) {
    // A plain cancel never touches detached background tasks; tell the
    // planner they are still running so it does not assume they were killed.
    result.backgroundTasks = activeBackgroundTaskList();
    result.note = "Detached background tasks keep running; cancel one with codex_cancel {taskId}.";
  }
  return result;
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

async function codexImplement(taskValue, tasksValue, backgroundValue) {
  const normalized = normalizeFanoutTasks(taskValue, tasksValue);
  if (normalized.error) return { status: "error", error: normalized.error };
  const task = normalized.task || null;
  const tasks = normalized.tasks || null;
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
  if (backgroundValue) {
    if (!task) {
      return {
        status: "error",
        error:
          "background:true requires a single `task`; background fan-out is not supported. Run one background delegation per independent milestone."
      };
    }
    return startBackgroundDelegation("implement", task);
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
  if (currentTurn || turnArming || fanoutActive) {
    return {
      status: "error",
      error: "Fusion turn already in progress; wait for the active turn to surface a decision or complete."
    };
  }
  {
    const settings = readCodexSettings();
    const family = ensureExecutorFamily(settings.family);
    if (family === "claude") {
      if (tasks) return runClaudeFanoutSequential("implement", tasks, settings);
      return claudeExecutorTurn(task, settings, "implement");
    }
  }
  // Held across the awaits below: a concurrent tool call passing the
  // currentTurn check during ensureThread/ensureGoalForTask would otherwise
  // reset this turn's accumulation buffers mid-flight.
  turnArming = true;
  let done;
  let turnWaiter;
  let goalSetup;
  try {
    await ensureThread();
    goalSetup = await ensureGoalForTask(tasks ? tasks.join("\n") : task);
    resetTurnBuffers();
    latchedTurnResult = null;
    relay({
      role: "opus",
      kind: "delegate",
      text: tasks
        ? `${tasks.length} parallel workstreams: ${clippedText(tasks[0], 200)}`
        : task
    });
    done = awaitTurn();
    turnWaiter = currentTurn;
  } finally {
    turnArming = false;
  }
  if (tasks) {
    runCodexFanout("implement", tasks);
    const result = await done;
    // A fan-out never auto-syncs the native goal (parallel workstreams are
    // mid-plan milestones by contract); attach the goal state for review only.
    const withGoal = currentGoal ? { ...result, goal: currentGoal } : result;
    if (goalSetup.status === "failed" && withGoal.status === "completed") {
      return { ...withGoal, goalSetup };
    }
    return withGoal;
  }
  const params = {
    threadId,
    input: [{ type: "text", text: buildCodexVerifierTask(task), text_elements: [] }],
    approvalPolicy: "never",
    sandboxPolicy: fusionCodexSandboxPolicy()
  };
  await applyCodexTurnSettings(params);
  if (currentTurn === turnWaiter) {
    rpc("turn/start", params)
      .then((response) => handleTurnStartResponse(response, turnWaiter))
      .catch((error) => {
        if (currentTurn === turnWaiter) {
          resolveTurn({ status: "failed", error: error.message });
        }
      });
  }
  const result = await done;
  const withGoal = await syncGoalAfterTurn(result);
  if (goalSetup.status === "failed" && withGoal.status === "completed") {
    return { ...withGoal, goalSetup };
  }
  return withGoal;
}

async function codexInvestigate(taskValue, tasksValue, backgroundValue) {
  const normalized = normalizeFanoutTasks(taskValue, tasksValue);
  if (normalized.error) return { status: "error", error: normalized.error };
  const task = normalized.task || null;
  const tasks = normalized.tasks || null;
  const pendingDecision = pendingDecisionResult({
    warning: "Fusion already has a pending decision; answer it before starting another task."
  });
  if (pendingDecision) {
    return pendingDecision;
  }
  if (backgroundValue) {
    if (!task) {
      return {
        status: "error",
        error:
          "background:true requires a single `task`; background fan-out is not supported. Run one background delegation per independent milestone."
      };
    }
    return startBackgroundDelegation("investigate", task);
  }
  if (steerRoutingPending) {
    await codexInterrupt();
    steerRoutingPending = false;
    steerBuffer = [];
    latchedTurnResult = null;
    clearSteerRoutingTimer();
    relay({ role: "codex", kind: "steer", text: "fresh investigation treated as steering replan" });
  }
  if (currentTurn || turnArming || fanoutActive) {
    return {
      status: "error",
      error: "Fusion turn already in progress; wait for the active turn to surface a decision or complete."
    };
  }
  {
    const settings = readCodexSettings();
    const family = ensureExecutorFamily(settings.family);
    if (family === "claude") {
      if (tasks) return runClaudeFanoutSequential("investigate", tasks, settings);
      return claudeExecutorTurn(task, settings, "investigate");
    }
  }
  turnArming = true;
  let done;
  let turnWaiter;
  try {
    await ensureThread();
    resetTurnBuffers();
    latchedTurnResult = null;
    relay({
      role: "opus",
      kind: "delegate",
      text: tasks
        ? `investigate (${tasks.length} parallel scouts): ${clippedText(tasks[0], 200)}`
        : `investigate: ${task}`
    });
    done = awaitTurn("investigate");
    turnWaiter = currentTurn;
  } finally {
    turnArming = false;
  }
  if (tasks) {
    runCodexFanout("investigate", tasks);
    return done;
  }
  const params = {
    threadId,
    input: [{ type: "text", text: buildCodexInvestigationTask(task), text_elements: [] }],
    approvalPolicy: "never",
    sandboxPolicy: fusionCodexInvestigateSandboxPolicy()
  };
  await applyCodexTurnSettings(params);
  if (currentTurn === turnWaiter) {
    rpc("turn/start", params)
      .then((response) => handleTurnStartResponse(response, turnWaiter))
      .catch((error) => {
        if (currentTurn === turnWaiter) {
          resolveTurn({ status: "failed", error: error.message });
        }
      });
  }
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
  if (currentTurn || turnArming || fanoutActive) {
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
  if (done) refreshTurnHardTimer("approval resolved");
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
      "Ask the embedded Codex executor to do a read-only scouting pass: file discovery, targeted reads, repo navigation, dependency tracing, or concise context gathering for Claude. Use this to feed Claude findings/files/snippets before Claude does architecture or UI design thinking. Does not create or sync native goals and does not use the implementation verifier contract. Pass `task` for one scout. When the context you need spans 2-4 DISJOINT areas, pass `tasks` instead (2-4 self-contained scouting questions) to run parallel read-only scouts concurrently; the result returns per-scout sections plus a combined findings/files view. Returns {status:'completed', findings, files, scouts?} or {status:'failed', error}.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Read-only investigation request. Ask for concise findings, relevant file paths, and short snippets when useful."
        },
        tasks: {
          type: "array",
          items: { type: "string" },
          description:
            "2-4 self-contained, non-overlapping scouting tasks to run as PARALLEL read-only scouts. Each scout sees only its own task, so make every entry independently answerable. Use instead of task, not alongside it."
        },
        background: {
          type: "boolean",
          description:
            "Run this investigation as a DETACHED background task: the call returns {status:'started', taskId, title} immediately so you can end your turn and keep talking with the user; the findings arrive later as a FUSION BACKGROUND TASK REPORT message opening a new turn. Use only when the user asked for background work or wants to keep the conversation available during a long scout. Requires task (not tasks)."
        }
      }
    }
  },
  {
    name: "codex_implement",
    description:
      "Delegate implementation, testing, compile/runtime fixing, refactors, repo navigation, picture/image generation, browser navigation/control/automation, bug review, or goal-completion verification to the embedded Codex executor. In Fusion Plan mode this tool refuses execution until the pane is switched back to Auto. The Claude planner drives architecture, strategy, UX/UI build-out when appropriate, human-facing orchestration, and guidance for Codex on constraints, UI intent, debugging direction, and follow-up corrections. Codex follows that guidance while independently verifying bugs and goal completion. Use codex_goal_set first for substantial top-level work; codex_implement will create a fallback native Codex goal if none exists and will sync goal status from the verifier verdict. Returns one of: {status:'completed', summary, files, goalReached, bugsFound, missingRequirements, nextAction, verifierVerdict, goal}; {status:'needs_decision', pendingId, kind, detail} - answer it with codex_respond; {status:'steer_routing', userSteer, executorProgress, guidance, nextAction:'steer_resolve'} - answer it with codex_steer_resolve; or {status:'failed', error}. If goalReached is false or nextAction is 'continue', continue/redelegate unless the human or an explicit Opus override says otherwise. Pass `task` for one delegation; pass `tasks` (2-4 entries) ONLY for verified-disjoint parallel workstreams after the mandatory parallel-safety check - the combined result adds workers[] (per-workstream verdicts) and fileConflicts, and never auto-completes the native goal.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Complete, self-contained instructions for Codex: the files, the intent, constraints, acceptance criteria, and what to verify. Codex does not share your context."
        },
        tasks: {
          type: "array",
          items: { type: "string" },
          description:
            "2-4 self-contained workstreams to run as PARALLEL executors on this same checkout. ONLY for verified-disjoint work: no shared file ownership, no ordering dependency, no shared artifacts (lockfiles, generated files, the same tests). Name each workstream's files and scope explicitly. The combined result reports per-workstream verdicts plus fileConflicts when workstreams touched the same file; it never auto-completes the native goal - review every verdict and run an integration verification before declaring done. Use instead of task, not alongside it."
        },
        background: {
          type: "boolean",
          description:
            "Run this delegation as a DETACHED background task: the call returns {status:'started', taskId, title} immediately so you can end your turn and keep talking with the user; the full report (summary, files, verifier verdict) arrives later as a FUSION BACKGROUND TASK REPORT message opening a new turn - review it with your normal independent verification before acting on it. Use only when the user asked for background work or wants to keep chatting during long INDEPENDENT work; never run dependent milestones in the background concurrently. Requires task (not tasks). Cancel with codex_cancel {taskId}."
        }
      }
    }
  },
  {
    name: "codex_watch_build",
    description:
      "Launch a long-running build/compile command detached and monitored by Fusion, decoupled from the 15-minute agent-turn cap. Returns {status:'watching', buildId, logPath, pid} immediately; the planner should end its turn and will later receive a completion report in a later turn.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Exact build/compile command line to run in the host shell."
        },
        cwd: {
          type: "string",
          description:
            "Optional working directory. Defaults to this Fusion pane's working directory."
        }
      },
      required: ["command"]
    }
  },
  {
    name: "codex_build_status",
    description:
      "Read Fusion's host-supervised detached build registry. With buildId, returns the build status, exit code, process metadata, and a log tail; without buildId, lists known builds most-recent first. Safe in Plan mode.",
    inputSchema: {
      type: "object",
      properties: {
        buildId: {
          type: "string",
          description: "Optional buildId returned by codex_watch_build."
        }
      }
    }
  },
  {
    name: "codex_task_status",
    description:
      "Peek at Fusion's detached background delegations WITHOUT blocking or affecting them. Without taskId, returns {status:'ok', active, recentlySettled}: active contains running snapshots (title, kind, elapsed, update count, recent activity) and recentlySettled is bounded newest-first memory. With taskId, returns that task's detail including recent activity, files touched so far, and the latest assistant text. Read-only and safe in Plan mode; the full report still arrives later as a FUSION BACKGROUND TASK REPORT. Cancel with codex_cancel {taskId}.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Optional taskId returned by a detached background delegation."
        }
      }
    }
  },
  {
    name: "codex_build_cancel",
    description:
      "Request cancellation of a host-supervised detached build by buildId. The build supervisor kills the process tree and sends a cancelled completion report. This terminates a process and is blocked in Plan mode.",
    inputSchema: {
      type: "object",
      properties: {
        buildId: {
          type: "string",
          description: "buildId returned by codex_watch_build."
        }
      },
      required: ["buildId"]
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
      "Abort the in-flight Codex turn and clear any pending approvals for this Fusion pane WITHOUT restarting the pane. Use it as the escape hatch when a turn is wedged - e.g. codex_implement keeps returning a 'turn already in progress' error with no decision to answer, or a parked approval can no longer be resolved. The Codex thread and native goal stay alive, so you can re-delegate with codex_implement afterwards. Returns {status:'cancelled', hadActiveTurn, clearedDecisions}. With `taskId` it instead cancels ONLY that detached background task (foreground turn and other background tasks untouched) and returns {status:'cancelled', taskId, title}.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description:
            "Optional background taskId (from a {status:'started'} background delegation) to cancel just that task."
        }
      }
    }
  }
];

const PLAN_MODE_ALLOWED_TOOLS = new Set([
  "codex_goal_get",
  "codex_investigate",
  "codex_build_status",
  "codex_task_status",
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
      result = await codexInvestigate(String(args.task || ""), args.tasks, args.background === true);
    } else if (name === "codex_implement") {
      result = await codexImplement(String(args.task || ""), args.tasks, args.background === true);
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
    } else if (name === "codex_watch_build") {
      result = await codexWatchBuild(
        String(args.command || ""),
        args.cwd != null ? String(args.cwd) : ""
      );
    } else if (name === "codex_build_status") {
      result = await codexBuildStatus(args.buildId != null ? String(args.buildId) : "");
    } else if (name === "codex_task_status") {
      result = codexTaskStatus(args.taskId != null ? String(args.taskId).trim() : "");
    } else if (name === "codex_build_cancel") {
      result = await codexBuildCancel(args.buildId != null ? String(args.buildId) : "");
    } else if (name === "codex_cancel") {
      result = codexCancel(args.taskId != null ? String(args.taskId).trim() : "");
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
  FANOUT_MAX_TASKS,
  BACKGROUND_MAX_TASKS,
  BACKGROUND_ACTIVITY_MAX_ITEMS,
  BACKGROUND_SETTLED_MAX_TASKS,
  VERDICT_MARKER,
  backgroundTaskTitle,
  buildBackgroundTaskText,
  clipBackgroundResult,
  buildClaudeExecutorArgs,
  buildCodexInvestigationTask,
  buildCodexVerifierTask,
  buildFanoutScoutTask,
  buildFanoutWorkstreamTask,
  buildSupervisorDir,
  codexBuildCancel,
  codexBuildStatus,
  codexTaskStatus,
  combineFanoutResults,
  codexWatchBuild,
  fanoutFileConflicts,
  normalizeFanoutTasks,
  cleanClaudeEffort,
  codexMcpServerConfigKey,
  displayCommandFromItem,
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
  summarizeCommandExecution,
  threadItemActivity,
  stripVerifierVerdictFromSummary,
  translateWorkspaceMcpServerConfig,
  unwrapShellCommand,
  readBuildRegistry,
  settledBackgroundTasks,
  watchedBuildRunnerSource,
  watchedBuildSpawnSpec,
  workspaceMcpConfigOverrides,
  turnErrorMessage
};

if (require.main === module) {
  startMcpServer();
}
