const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_TRANSCRIPT_HEAD_BYTES = 256 * 1024;
const DEFAULT_TRANSCRIPT_LIMIT = 5000;
const MAX_DISCOVERY_VISITS = 20000;

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
  const content = readFileHead(filePath, MAX_TRANSCRIPT_HEAD_BYTES);
  const newlineIndex = content.indexOf("\n");
  return newlineIndex === -1 ? content : content.slice(0, newlineIndex);
}

const MAX_THREAD_TITLE_LENGTH = 120;

// Reduce harvested prompt text to a picker-style one-liner: first non-empty
// line, whitespace collapsed, capped. Empty string means "no usable title".
function normalizeThreadTitle(value) {
  if (typeof value !== "string") {
    return "";
  }

  const line = value
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) {
    return "";
  }

  const collapsed = line.replace(/\s+/g, " ");
  return collapsed.length > MAX_THREAD_TITLE_LENGTH
    ? `${collapsed.slice(0, MAX_THREAD_TITLE_LENGTH - 1)}…`
    : collapsed;
}

function readFileHead(filePath, maxBytes) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function statMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function addRecentFile(files, file, limit) {
  files.push(file);
  if (files.length > limit * 2) {
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    files.length = limit;
  }
}

function collectJsonlFiles(rootDir, limit = DEFAULT_TRANSCRIPT_LIMIT) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const stack = [rootDir];
  const files = [];
  let visited = 0;

  while (stack.length > 0 && visited < MAX_DISCOVERY_VISITS) {
    const current = stack.pop();
    visited += 1;
    let entries = [];

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    const dirs = [];

    entries.forEach((entry) => {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        dirs.push(entryPath);
        return;
      }

      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        addRecentFile(
          files,
          { path: entryPath, mtimeMs: statMtimeMs(entryPath) },
          limit
        );
      }
    });

    dirs
      .sort((a, b) => statMtimeMs(a) - statMtimeMs(b))
      .forEach((dirPath) => stack.push(dirPath));
  }

  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((file) => file.path);
}

function codexHome(options = {}) {
  return (
    options.codexHome ||
    options.env?.CODEX_HOME ||
    process.env.CODEX_HOME ||
    path.join(os.homedir(), ".codex")
  );
}

// Codex generates no session title: its own `codex resume` picker previews the
// first user message from the rollout. Harvest the same text (bounded to the
// head read) so panes can show it. Instruction/environment envelopes start
// with "<" and are skipped. Returns "" when the rollout has no prompt yet.
const MAX_TITLE_SCAN_LINES = 200;

function parseCodexRolloutTitle(filePath) {
  let lines;
  try {
    lines = readFileHead(filePath, MAX_TRANSCRIPT_HEAD_BYTES)
      .split(/\r?\n/)
      .slice(0, MAX_TITLE_SCAN_LINES);
  } catch {
    return "";
  }

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event?.type !== "event_msg") {
      continue;
    }

    const payload = event.payload;
    if (payload?.type !== "user_message" || typeof payload.message !== "string") {
      continue;
    }

    const text = payload.message.trim();
    if (!text || text.startsWith("<")) {
      continue;
    }

    return normalizeThreadTitle(text);
  }

  return "";
}

// Fill a candidate's title from its rollout when session_meta carried none.
// Deliberately lazy — discovery parses metas for MANY files; only the refs we
// actually return are worth a second head read.
function withRolloutTitle(thread) {
  if (!thread || thread.title) {
    return thread;
  }

  return {
    ...thread,
    title: parseCodexRolloutTitle(thread.rolloutPath) || undefined
  };
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

// Strip walk-internal fields before a codex ref leaves this module — a
// published threadRef gets persisted in workspace state as-is.
function publishCodexThreadRef(thread) {
  const {
    cwd: _cwd,
    originator: _originator,
    rolloutPath: _rolloutPath,
    ...threadRef
  } = withRolloutTitle(thread);
  return threadRef;
}

// Rollouts for a cwd that could belong to this app: same filter latest-thread
// discovery uses (Codex Desktop sessions are never ours).
function collectCodexCandidates(payload = {}, options = {}) {
  const cwd = payload.cwd;
  const after = Number(payload.after || 0);
  const excludeIds = new Set(
    Array.isArray(payload.excludeIds)
      ? payload.excludeIds.filter(Boolean).map(String)
      : []
  );
  const sessionsDir = path.join(codexHome(options), "sessions");
  return collectJsonlFiles(sessionsDir)
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
    });
}

function findCodexThread(payload = {}, options = {}) {
  if (!payload.cwd) {
    return {
      status: "failed",
      message: "Cannot discover a Codex thread without a working directory."
    };
  }

  const candidates = collectCodexCandidates(payload, options).sort(
    (a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt
  );

  const publish = publishCodexThreadRef;

  if (candidates.length === 0) {
    return {
      status: "pending",
      message: "Waiting for Codex to create its local thread metadata."
    };
  }

  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      candidates: candidates.map(publish),
      message: `Found ${candidates.length} matching Codex threads; not guessing.`
    };
  }

  return {
    status: "found",
    threadRef: publish(candidates[0])
  };
}

// Every Codex thread for a folder, newest first — the Fusion resume picker's
// data source for codex-planner panes. Unlike findCodexThread this never goes
// ambiguous: the user does the disambiguating by picking a row.
function listCodexThreads(payload = {}, options = {}) {
  if (!payload.cwd) {
    return {
      status: "failed",
      message: "Cannot list Codex threads without a working directory."
    };
  }

  const threads = collectCodexCandidates(payload, options)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(publishCodexThreadRef);

  return { status: "found", threads };
}

// Locate a Codex rollout file for a specific session id without reading file
// contents. Codex names each rollout `rollout-<timestamp>-<id>.jsonl`, so the id
// is the trailing filename component — match by suffix and short-circuit on the
// first hit. `complete` is false when a directory could not be read or a
// pathological-tree backstop tripped, meaning absence could NOT be proven and the
// caller must treat it as "unknown" rather than "missing".
function locateCodexRollout(sessionsDir, id) {
  if (!fs.existsSync(sessionsDir)) {
    return { path: null, complete: true };
  }

  const suffix = `-${id}.jsonl`;
  const stack = [sessionsDir];
  const visitCap = 200000;
  let visited = 0;
  let complete = true;

  while (stack.length > 0) {
    if (visited >= visitCap) {
      complete = false;
      break;
    }
    visited += 1;

    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // The unreadable directory might hold the rollout, so absence is no longer
      // provable.
      complete = false;
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (
        entry.isFile() &&
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(suffix)
      ) {
        return { path: entryPath, complete: true };
      }
    }
  }

  return { path: null, complete };
}

// Codex resumes with `codex resume <id>` against a rollout file on disk; if that
// rollout was deleted the resume errors in the live shell pane. confirmCodexThread
// answers "does a rollout for this exact id still exist?" so the launcher can
// self-heal to a fresh session. Mirrors confirmClaudeThread's conservative
// contract: report "missing" only when the tree was fully walked with no match;
// if the walk was incomplete, stay "found" and let the resume try.
function confirmCodexThread(cwd, id, options = {}) {
  const target = String(id || "");
  if (!target) {
    return { status: "missing" };
  }

  const sessionsDir = path.join(codexHome(options), "sessions");
  const located = locateCodexRollout(sessionsDir, target);

  if (located.path) {
    const meta = parseCodexSessionMeta(located.path);
    return {
      status: "found",
      threadRef: {
        provider: "codex",
        id: target,
        // session_meta virtually never carries a name, so fall back to the
        // first user prompt — the same text Codex's own resume picker shows.
        title: meta?.title || parseCodexRolloutTitle(located.path) || undefined,
        createdAt: meta?.createdAt ?? 0,
        updatedAt: meta?.updatedAt ?? 0
      }
    };
  }

  if (!located.complete) {
    return {
      status: "found",
      threadRef: { provider: "codex", id: target, title: undefined, createdAt: 0, updatedAt: 0 }
    };
  }

  return { status: "missing" };
}

module.exports = {
  codexHome,
  collectJsonlFiles,
  listCodexThreads,
  confirmCodexThread,
  findCodexThread,
  isSamePath,
  locateCodexRollout,
  normalizePathForCompare,
  normalizeThreadTitle,
  parseCodexRolloutTitle,
  parseCodexSessionMeta
};
