const fs = require("fs");
const os = require("os");
const path = require("path");

function normalizePathForCompare(value) {
  if (!value) {
    return "";
  }

  try {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch {
    return process.platform === "win32" ? String(value).toLowerCase() : String(value);
  }
}

function isSamePath(a, b) {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

function readFirstLine(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const newlineIndex = content.indexOf("\n");
  return newlineIndex === -1 ? content : content.slice(0, newlineIndex);
}

function collectJsonlFiles(rootDir, limit = 800) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const stack = [rootDir];
  const files = [];

  while (stack.length > 0 && files.length < limit) {
    const current = stack.pop();
    let entries = [];

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.forEach((entry) => {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        return;
      }

      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    });
  }

  return files;
}

function codexHome(options = {}) {
  return (
    options.codexHome ||
    options.env?.CODEX_HOME ||
    process.env.CODEX_HOME ||
    path.join(os.homedir(), ".codex")
  );
}

function parseCodexSessionMeta(filePath) {
  try {
    const line = readFirstLine(filePath);
    const event = JSON.parse(line);
    if (event.type !== "session_meta") {
      return null;
    }

    const payload = event.payload || {};
    const createdAt = Date.parse(payload.timestamp || event.timestamp || "");
    const id = payload.session_id || payload.id;
    if (!id || !Number.isFinite(createdAt)) {
      return null;
    }

    const stat = fs.statSync(filePath);
    return {
      provider: "codex",
      id,
      title: payload.name,
      createdAt,
      updatedAt: stat.mtimeMs,
      cwd: payload.cwd,
      originator: payload.originator,
      rolloutPath: filePath
    };
  } catch {
    return null;
  }
}

function findCodexThread(payload = {}, options = {}) {
  const cwd = payload.cwd;
  const after = Number(payload.after || 0);
  const excludeIds = new Set(
    Array.isArray(payload.excludeIds)
      ? payload.excludeIds.filter(Boolean).map(String)
      : []
  );

  if (!cwd) {
    return {
      status: "failed",
      message: "Cannot discover a Codex thread without a working directory."
    };
  }

  const sessionsDir = path.join(codexHome(options), "sessions");
  const candidates = collectJsonlFiles(sessionsDir)
    .map(parseCodexSessionMeta)
    .filter((thread) => {
      if (!thread) {
        return false;
      }

      return (
        isSamePath(thread.cwd, cwd) &&
        thread.originator !== "Codex Desktop" &&
        thread.createdAt >= after &&
        !excludeIds.has(thread.id)
      );
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt)
    .map(({ cwd: _cwd, originator: _originator, rolloutPath: _rolloutPath, ...thread }) => thread);

  if (candidates.length === 0) {
    return {
      status: "pending",
      message: "Waiting for Codex to create its local thread metadata."
    };
  }

  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      candidates,
      message: `Found ${candidates.length} matching Codex threads; not guessing.`
    };
  }

  return {
    status: "found",
    threadRef: candidates[0]
  };
}

module.exports = {
  collectJsonlFiles,
  findCodexThread,
  isSamePath,
  normalizePathForCompare,
  parseCodexSessionMeta
};
