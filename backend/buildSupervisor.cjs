const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const RUNNING = "running";
const EXITED = "exited";
const FAILED = "failed";
const CANCELLED = "cancelled";
const TERMINAL_STATUSES = new Set([EXITED, FAILED, CANCELLED]);

function numericEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function cloneEntry(entry) {
  return entry ? { ...entry } : null;
}

function createBuildId() {
  return `build-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseExitCode(text) {
  const match = String(text || "").match(/-?\d+/);
  if (!match) return null;
  const value = Number.parseInt(match[0], 10);
  return Number.isFinite(value) ? value : null;
}

function processIsAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") return true;
    return false;
  }
}

function tailFile(filePath, maxBytes = 65536) {
  const byteLimit = Number.isFinite(Number(maxBytes)) ? Math.max(0, Number(maxBytes)) : 65536;
  if (!filePath || byteLimit <= 0) return "";
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.size <= 0) return "";
    const byteCount = Math.min(byteLimit, stats.size);
    const buffer = Buffer.alloc(byteCount);
    fs.readSync(fd, buffer, 0, byteCount, stats.size - byteCount);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

function killProcessTree(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(numericPid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
    } catch {
      // best-effort cancellation
    }
    return;
  }
  try {
    process.kill(-numericPid, "SIGTERM");
  } catch {
    try {
      process.kill(numericPid, "SIGTERM");
    } catch {
      // best-effort cancellation
    }
  }
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const buildId = String(raw.buildId || "").trim();
  if (!buildId) return null;
  const status = TERMINAL_STATUSES.has(raw.status) ? raw.status : RUNNING;
  return {
    buildId,
    sessionId: raw.sessionId != null ? String(raw.sessionId) : "",
    command: raw.command != null ? String(raw.command) : "",
    cwd: raw.cwd != null ? String(raw.cwd) : "",
    pid: Number.isFinite(Number(raw.pid)) ? Number(raw.pid) : null,
    logPath: raw.logPath != null ? String(raw.logPath) : "",
    sentinelPath: raw.sentinelPath != null ? String(raw.sentinelPath) : "",
    status,
    exitCode:
      Number.isInteger(raw.exitCode) || raw.exitCode === null ? raw.exitCode : null,
    startedAt: Number.isFinite(Number(raw.startedAt)) ? Number(raw.startedAt) : Date.now(),
    endedAt:
      Number.isFinite(Number(raw.endedAt)) && TERMINAL_STATUSES.has(status)
        ? Number(raw.endedAt)
        : null
  };
}

function createBuildSupervisor({ baseDir, emit, pollMs } = {}) {
  if (!baseDir || typeof baseDir !== "string") {
    throw new Error("createBuildSupervisor requires baseDir");
  }
  const emitEvent = typeof emit === "function" ? emit : () => {};
  const intervalMs =
    Number.isFinite(Number(pollMs)) && Number(pollMs) > 0
      ? Number(pollMs)
      : numericEnv("VIBE_BUILD_POLL_MS", 3000);
  const livenessGraceMs = numericEnv("VIBE_BUILD_LIVENESS_GRACE_MS", 5000);
  const registryPath = path.join(baseDir, "registry.json");
  const registry = new Map();
  const settledBuildIds = new Set();
  let interval = null;

  fs.mkdirSync(baseDir, { recursive: true });

  function persist() {
    fs.mkdirSync(baseDir, { recursive: true });
    const tmpPath = `${registryPath}.tmp`;
    const entries = Array.from(registry.values()).map(cloneEntry);
    fs.writeFileSync(tmpPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, registryPath);
  }

  function loadRegistry() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        // Keep startup tolerant: a corrupt registry should not block the app.
      }
      return;
    }
    const entries = Array.isArray(raw) ? raw : Object.values(raw || {});
    for (const value of entries) {
      const entry = normalizeEntry(value);
      if (!entry) continue;
      registry.set(entry.buildId, entry);
      if (entry.status !== RUNNING) settledBuildIds.add(entry.buildId);
    }
  }

  function tailLog(buildId, maxBytes = 65536) {
    const entry = registry.get(String(buildId || ""));
    if (!entry) return "";
    const byteLimit = Number.isFinite(Number(maxBytes)) ? Number(maxBytes) : 65536;
    return tailFile(entry.logPath, Math.max(0, byteLimit));
  }

  function settle(entry) {
    if (!entry || settledBuildIds.has(entry.buildId)) return false;
    settledBuildIds.add(entry.buildId);
    emitEvent({
      type: "build-task",
      phase: "settled",
      buildId: entry.buildId,
      sessionId: entry.sessionId,
      id: entry.sessionId,
      status: entry.status,
      exitCode: entry.exitCode,
      tail: tailLog(entry.buildId),
      command: entry.command,
      cwd: entry.cwd,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt
    });
    return true;
  }

  function markSettled(entry, status, exitCode) {
    if (!entry || entry.status !== RUNNING) return false;
    entry.status = status;
    entry.exitCode = exitCode;
    entry.endedAt = Date.now();
    persist();
    return settle(entry);
  }

  function pollEntry(entry) {
    if (!entry || entry.status !== RUNNING) return;
    if (entry.sentinelPath) {
      let sentinelText = "";
      try {
        sentinelText = fs.readFileSync(entry.sentinelPath, "utf8");
      } catch {
        sentinelText = "";
      }
      if (sentinelText.trim()) {
        const exitCode = parseExitCode(sentinelText);
        markSettled(entry, exitCode === 0 ? EXITED : FAILED, exitCode);
        return;
      }
    }

    const ageMs = Date.now() - Number(entry.startedAt || 0);
    if (ageMs >= livenessGraceMs && !processIsAlive(entry.pid)) {
      markSettled(entry, FAILED, null);
    }
  }

  function pollOnce() {
    for (const entry of Array.from(registry.values())) {
      pollEntry(entry);
    }
  }

  function start() {
    if (interval) return;
    interval = setInterval(pollOnce, intervalMs);
    if (typeof interval.unref === "function") interval.unref();
    pollOnce();
  }

  function register({
    buildId,
    sessionId,
    command,
    cwd,
    pid,
    logPath,
    sentinelPath,
    startedAt
  } = {}) {
    const id = String(buildId || createBuildId()).trim() || createBuildId();
    const entry = {
      buildId: id,
      sessionId: sessionId != null ? String(sessionId) : "",
      command: command != null ? String(command) : "",
      cwd: cwd != null ? String(cwd) : "",
      pid: Number.isFinite(Number(pid)) ? Number(pid) : null,
      logPath: logPath != null ? String(logPath) : "",
      sentinelPath: sentinelPath != null ? String(sentinelPath) : "",
      status: RUNNING,
      exitCode: null,
      startedAt: Number.isFinite(Number(startedAt)) ? Number(startedAt) : Date.now(),
      endedAt: null
    };
    registry.set(id, entry);
    settledBuildIds.delete(id);
    persist();
    start();
    return cloneEntry(entry);
  }

  function get(buildId) {
    return cloneEntry(registry.get(String(buildId || "")));
  }

  function list() {
    return Array.from(registry.values()).map(cloneEntry);
  }

  function cancel(buildId) {
    const entry = registry.get(String(buildId || ""));
    if (!entry) return null;
    if (entry.status !== RUNNING) return cloneEntry(entry);
    killProcessTree(entry.pid);
    markSettled(entry, CANCELLED, null);
    return cloneEntry(entry);
  }

  function cleanup() {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    persist();
  }

  loadRegistry();

  return {
    start,
    register,
    get,
    list,
    tailLog,
    cancel,
    cleanup
  };
}

module.exports = {
  createBuildSupervisor,
  tailFile
};
