const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { findCodexThread } = require("./agentThreads.cjs");

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
        // Claude writes a `<session-id>/subagents/agent-*.jsonl` tree that
        // duplicates the parent session's id/cwd. Descending into it only
        // multiplies I/O and can push the real session file past the file cap,
        // so skip it — the parent transcript already carries the id we need.
        if (entry.name !== "subagents") {
          stack.push(entryPath);
        }
        return;
      }

      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    });
  }

  return files;
}

function toExcludedSet(excludeIds) {
  return new Set(
    Array.isArray(excludeIds)
      ? excludeIds.filter(Boolean).map(String)
      : []
  );
}

// Claude message content is either a string or an array of content blocks
// (`{ type: "text", text: "..." }`, tool calls, etc.). Joining the array
// directly would stringify objects into "[object Object]" titles.
function extractClaudeText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        return typeof part?.text === "string" ? part.text : "";
      })
      .join("")
      .trim();
  }

  return "";
}

function claudeProjectsDir() {
  const claudeHome =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(claudeHome, "projects");
}

// Parse a single Claude transcript, harvesting the session identity only from
// lines that belong to (or do not contradict) the target cwd, so the id/title/
// timestamp we claim provably came from this project — never from a foreign-cwd
// line that merely shares the file. A single foreign line is skipped, not a
// reason to abort the whole transcript. Returns null when the file carries no id
// for this cwd. Shared by latest-thread discovery and the existence check.
function parseClaudeTranscript(filePath, cwd) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/).slice(0, 40);
    let sessionId = "";
    let createdAt = 0;
    let title = "";
    let sawMatchingCwd = false;

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // Tolerate the occasional malformed line instead of discarding the
        // whole transcript.
        continue;
      }

      if (event.cwd && isSamePath(event.cwd, cwd)) {
        sawMatchingCwd = true;
      }

      if (event.cwd && !isSamePath(event.cwd, cwd)) {
        continue;
      }

      sessionId = sessionId || event.sessionId || "";
      if (!title) {
        title =
          (typeof event.lastPrompt === "string" ? event.lastPrompt : "") ||
          extractClaudeText(event.message?.content);
      }
      if (!createdAt) {
        createdAt = Date.parse(
          event.timestamp || event.message?.timestamp || ""
        );
      }
    }

    if (!sessionId || !sawMatchingCwd) {
      return null;
    }

    const stat = fs.statSync(filePath);
    return {
      provider: "claude",
      id: sessionId,
      title,
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      updatedAt: stat.mtimeMs
    };
  } catch {
    return null;
  }
}

function findLatestClaudeThread(cwd, after = 0, excludeIds = []) {
  const excluded = toExcludedSet(excludeIds);
  const matches = collectJsonlFiles(claudeProjectsDir())
    .map((filePath) => parseClaudeTranscript(filePath, cwd))
    .filter(
      (ref) =>
        ref &&
        ref.id &&
        !excluded.has(String(ref.id)) &&
        Number.isFinite(ref.createdAt) &&
        ref.createdAt >= after
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return matches[0] || null;
}

function placeholderClaudeRef(id) {
  return {
    provider: "claude",
    id,
    title: "",
    createdAt: 0,
    updatedAt: 0
  };
}

// Locate the transcript file for a specific Claude session id without reading
// any file contents. Claude stores each session as `<sessionId>.jsonl`, so we
// match by name and short-circuit on the first hit. `complete` is false when a
// directory could not be read (so the target may live in an unreadable subtree)
// or a pathological-tree backstop tripped — meaning absence could NOT be proven,
// and callers must treat that as "unknown" rather than "missing".
function locateClaudeTranscriptFile(id) {
  const target = `${id}.jsonl`;
  const root = claudeProjectsDir();
  if (!fs.existsSync(root)) {
    return { path: null, complete: true };
  }

  const stack = [root];
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
      // The unreadable directory might be the one holding the transcript, so we
      // can no longer prove the id is absent.
      complete = false;
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Claude's `<id>/subagents/agent-*.jsonl` tree only duplicates the
        // parent id; skip it (matches collectJsonlFiles).
        if (entry.name !== "subagents") {
          stack.push(entryPath);
        }
      } else if (entry.isFile() && entry.name === target) {
        return { path: entryPath, complete: true };
      }
    }
  }

  return { path: null, complete };
}

// Claude pre-assigns its session id (`--session-id <uuid>`) and later resumes
// with `claude --resume <uuid>`. That id only becomes resumable once Claude has
// persisted a transcript — i.e. after at least one exchanged message. Resuming a
// never-persisted id hard-fails with "No conversation found", which in a live
// shell pane strands the user at a bare prompt where their session should be.
//
// confirmClaudeThread answers "is this exact id safe to `--resume`?" so the
// launcher can start a clean session instead of hard-failing. If a file for the
// id exists we report it "found" (re-pinning the id with a fresh `--session-id`
// would collide), even across a cwd change. We report "missing" only when we can
// prove no such file exists; if the directory walk was incomplete we stay
// conservative and resume.
function confirmClaudeThread(cwd, id) {
  const target = String(id || "");
  if (!target) {
    return { status: "missing" };
  }

  const located = locateClaudeTranscriptFile(target);

  if (located.path) {
    const threadRef =
      parseClaudeTranscript(located.path, cwd) || placeholderClaudeRef(target);
    return { status: "found", threadRef };
  }

  if (!located.complete) {
    // Could not prove the id is absent (unreadable dir or pathological tree);
    // resume rather than risk a duplicate-id collision on a fresh launch.
    return { status: "found", threadRef: placeholderClaudeRef(target) };
  }

  return { status: "missing" };
}

function findLatestOpenCodeThread(cwd, after = 0, excludeIds = []) {
  const result = spawn("opencode", [
    "session",
    "list",
    "--format",
    "json",
    "--max-count",
    "100"
  ], {
    cwd,
    shell: process.platform === "win32",
    windowsHide: true
  });

  const excluded = toExcludedSet(excludeIds);

  return new Promise((resolve) => {
    let stdout = "";

    result.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    result.on("error", () => resolve(null));
    result.on("exit", () => {
      try {
        const sessions = JSON.parse(stdout);
        // `opencode session list --format json` emits flat fields with
        // millisecond (`Date.now()`) `created`/`updated`, so they compare
        // directly against the millisecond `after` cutoff.
        const latest =
          sessions
            .filter(
              (session) =>
                session.id &&
                !excluded.has(String(session.id)) &&
                isSamePath(session.directory, cwd) &&
                Number(session.created || 0) >= after
            )
            .sort((a, b) => Number(b.updated || 0) - Number(a.updated || 0))[0] ||
          null;

        resolve(
          latest
            ? {
                provider: "opencode",
                id: latest.id,
                title: latest.title,
                createdAt: Number(latest.created || 0),
                updatedAt: Number(latest.updated || 0)
              }
            : null
        );
      } catch {
        resolve(null);
      }
    });
  });
}

async function findLatestAgentThread(payload) {
  const cwd = payload?.cwd;
  const after = Number(payload?.after || 0);

  if (!cwd) {
    return {
      status: "failed",
      message: "Cannot discover an agent thread without a working directory."
    };
  }

  if (payload.provider === "codex") {
    return findCodexThread(payload);
  }

  if (payload.provider === "claude") {
    // A confirm request asks whether a specific pre-assigned id is safe to
    // resume, so the launcher can self-heal instead of running a doomed
    // `claude --resume <id>`.
    if (payload.confirmId) {
      return confirmClaudeThread(cwd, payload.confirmId);
    }

    const threadRef = findLatestClaudeThread(cwd, after, payload.excludeIds);
    return threadRef
      ? { status: "found", threadRef }
      : {
          status: "pending",
          message: "Waiting for Claude to create its local session metadata."
        };
  }

  if (payload.provider === "opencode") {
    const threadRef = await findLatestOpenCodeThread(
      cwd,
      after,
      payload.excludeIds
    );
    return threadRef
      ? { status: "found", threadRef }
      : {
          status: "pending",
          message: "Waiting for OpenCode to create its local session metadata."
        };
  }

  return {
    status: "failed",
    message: `Unsupported agent thread provider: ${payload.provider || "unknown"}`
  };
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function handleHostLine(line) {
  if (!line.trim()) {
    return;
  }

  let message = null;
  try {
    message = JSON.parse(line);
  } catch (error) {
    emit({
      type: "error",
      message: `Bad agent-thread host message: ${error.message}`
    });
    return;
  }

  if (message.type === "shutdown") {
    process.exit(0);
    return;
  }

  if (message.type !== "lookup") {
    emit({
      type: "error",
      requestId: message.requestId,
      message: `Unknown agent-thread host message: ${message.type}`
    });
    return;
  }

  try {
    const result = await findLatestAgentThread(message.payload);
    emit({
      type: "response",
      requestId: message.requestId,
      result
    });
  } catch (error) {
    emit({
      type: "error",
      requestId: message.requestId,
      message: error.message
    });
  }
}

function startHost() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  rl.on("line", handleHostLine);

  emit({ type: "ready" });
}

if (require.main === module) {
  startHost();
}

module.exports = {
  collectJsonlFiles,
  confirmClaudeThread,
  extractClaudeText,
  findLatestAgentThread,
  findLatestClaudeThread,
  findLatestOpenCodeThread,
  isSamePath,
  normalizePathForCompare,
  parseClaudeTranscript
};
