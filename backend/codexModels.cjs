const { spawn } = require("child_process");

const CODEX_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+-]{1,96}$/;
const CODEX_DEBUG_MODELS_ARGS = ["debug", "models"];
const DEFAULT_TIMEOUT_MS = 15_000;

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
    sanitized.push({ id: modelId, label: String(label || modelId).trim() || modelId });
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
  CODEX_MODEL_ID_PATTERN,
  fetchCodexModelCatalog,
  resolveCodexArgs,
  resolveCodexCommand,
  isSelectableCodexModel,
  sanitizeCodexModels
};
