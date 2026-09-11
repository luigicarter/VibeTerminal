const { spawn } = require("child_process");

const CODEX_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]{1,96}$/;
const CODEX_DEBUG_MODELS_ARGS = ["debug", "models"];
const DEFAULT_TIMEOUT_MS = 15_000;
const CODEX_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const CONSERVATIVE_CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];

function resolveCodexCommand(options = {}) {
  return options.command || options.codexBin || process.env.VIBE_FUSION_CODEX_BIN || "codex";
}

function resolveCodexArgs(options = {}) {
  return Array.isArray(options.args) && options.args.length
    ? options.args.map((arg) => String(arg))
    : CODEX_DEBUG_MODELS_ARGS;
}

function quoteCmdArg(value) {
  const text = String(value);
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function spawnCodexDebugModels(options = {}) {
  const command = resolveCodexCommand(options);
  const args = resolveCodexArgs(options);
  if (command === "codex") {
    const isWin = process.platform === "win32";
    const shell = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const commandLine = ["codex", ...args].map(quoteCmdArg).join(" ");
    const shellArgs = isWin ? ["/d", "/s", "/c", commandLine] : ["-c", commandLine];
    return spawn(shell, shellArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  }
  return spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

function killProcessTree(child) {
  if (!child) return;
  try {
    child.kill();
  } catch {
    // best effort
  }
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      });
    } catch {
      // best effort
    }
  }
}

function runCodexDebugModels(options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCodexDebugModels(options);
    } catch {
      resolve(null);
      return;
    }

    let stdout = "";
    let settled = false;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, Number(options.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
      resolve(null);
    }, timeoutMs);

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", () => {
      // stderr is intentionally not surfaced; failures fall back to curated.
    });
    child.on("error", () => finish(null));
    child.on("exit", (code) => {
      finish(code === 0 ? stdout : null);
    });
  });
}

function codexCatalogEntries(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.models)) return parsed.models;
  if (Array.isArray(parsed?.data)) return parsed.data;
  if (Array.isArray(parsed?.catalog)) return parsed.catalog;
  return [];
}

function isSelectableCodexModel(item) {
  if (item?.hidden === true || item?.internal === true || item?.selectable === false) {
    return false;
  }
  const visibility = typeof item?.visibility === "string" ? item.visibility.trim().toLowerCase() : "";
  // `codex debug models` marks internal approval-review entries as visibility:"hide".
  return !["hide", "hidden", "internal"].includes(visibility);
}

function modelCatalogEntry(models, modelId) {
  if (!Array.isArray(models) || models.length === 0) return null;
  const wanted = String(modelId || "").trim().toLowerCase();
  if (wanted) {
    return (
      models.find((model) => {
        if (!model || typeof model !== "object") return false;
        return [model.id, model.model, model.slug]
          .filter((value) => typeof value === "string")
          .some((value) => value.trim().toLowerCase() === wanted);
      }) || null
    );
  }
  return models.find((model) => model && (model.isDefault || model.is_default)) || null;
}

function supportedReasoningEfforts(model) {
  if (!model || typeof model !== "object") return [];
  const raw = [
    model.supportedReasoningEfforts,
    model.supported_reasoning_efforts,
    model.supportedReasoningLevels,
    model.supported_reasoning_levels,
    model.supportedEfforts
  ].find(Array.isArray);
  if (!raw) return [];

  const seen = new Set();
  const efforts = [];
  for (const option of raw) {
    const value =
      typeof option === "string"
        ? option
        : option?.reasoningEffort ?? option?.reasoning_effort ?? option?.effort;
    const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!CODEX_REASONING_EFFORTS.includes(effort) || seen.has(effort)) continue;
    seen.add(effort);
    efforts.push(effort);
  }
  return efforts;
}

function nearestSupportedReasoningEffort(requested, supported) {
  if (supported.includes(requested)) return requested;
  const requestedIndex = CODEX_REASONING_EFFORTS.indexOf(requested);
  if (requestedIndex < 0) return null;
  // Prefer the nearest lower effort so an unsupported high setting degrades
  // safely (ultra -> max -> xhigh, max -> xhigh). `minimal` has no lower
  // neighbor, so it falls upward to `low` when that is the model's floor.
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    if (supported.includes(CODEX_REASONING_EFFORTS[index])) {
      return CODEX_REASONING_EFFORTS[index];
    }
  }
  for (let index = requestedIndex + 1; index < CODEX_REASONING_EFFORTS.length; index += 1) {
    if (supported.includes(CODEX_REASONING_EFFORTS[index])) {
      return CODEX_REASONING_EFFORTS[index];
    }
  }
  return null;
}

function resolveCodexEffortForModel(models, modelId, value) {
  const requested = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!requested || requested === "auto" || requested === "default") {
    return { requested: null, effort: null, model: String(modelId || "").trim() || null, supported: [] };
  }
  if (!CODEX_REASONING_EFFORTS.includes(requested)) {
    return { requested, effort: null, model: String(modelId || "").trim() || null, supported: [] };
  }

  const entry = modelCatalogEntry(models, modelId);
  const advertised = supportedReasoningEfforts(entry);
  // If model/list is unavailable or a custom model is absent, use the levels
  // common to the shipped catalog. This preserves the old max->xhigh safety
  // behavior instead of sending a potentially invalid effort blindly.
  const supported = advertised.length
    ? advertised
    : [...CONSERVATIVE_CODEX_REASONING_EFFORTS];
  const effort = nearestSupportedReasoningEffort(requested, supported);
  const resolvedModel =
    [entry?.id, entry?.model, entry?.slug].find(
      (candidate) => typeof candidate === "string" && candidate.trim()
    ) || String(modelId || "").trim() || null;
  return {
    requested,
    effort,
    model: resolvedModel,
    supported,
    usedCatalog: advertised.length > 0
  };
}

function sanitizeCodexModels(parsed) {
  const seen = new Set();
  const sanitized = [];
  for (const item of codexCatalogEntries(parsed)) {
    if (!isSelectableCodexModel(item)) continue;
    const id = [
      item?.id,
      item?.model,
      item?.slug,
      item?.name
    ].find((value) => typeof value === "string" && value.trim());
    const modelId = typeof id === "string" ? id.trim() : "";
    if (!CODEX_MODEL_ID_PATTERN.test(modelId)) continue;
    const key = modelId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const label = [
      item?.display_name,
      item?.displayName,
      item?.label,
      item?.title,
      item?.name,
      item?.slug,
      item?.model,
      item?.id
    ].find((value) => typeof value === "string" && value.trim());
    const supportedEfforts = supportedReasoningEfforts(item);
    sanitized.push({
      id: modelId,
      label: String(label || modelId).trim() || modelId,
      ...(supportedEfforts.length ? { supportedEfforts } : {}),
      ...(item?.isDefault === true || item?.is_default === true ? { isDefault: true } : {})
    });
  }
  return sanitized;
}

async function fetchCodexModelCatalog(options = {}) {
  const stdout = await runCodexDebugModels(options);
  if (!stdout) return null;

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  const models = sanitizeCodexModels(parsed);
  return models.length ? models : null;
}

module.exports = {
  CODEX_REASONING_EFFORTS,
  CONSERVATIVE_CODEX_REASONING_EFFORTS,
  CODEX_MODEL_ID_PATTERN,
  fetchCodexModelCatalog,
  modelCatalogEntry,
  nearestSupportedReasoningEffort,
  resolveCodexEffortForModel,
  resolveCodexArgs,
  resolveCodexCommand,
  isSelectableCodexModel,
  sanitizeCodexModels,
  supportedReasoningEfforts
};
