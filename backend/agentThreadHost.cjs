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

function findLatestClaudeThread(cwd, after = 0) {
  const claudeHome =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const projectsDir = path.join(claudeHome, "projects");
  const matches = collectJsonlFiles(projectsDir)
    .map((filePath) => {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split(/\r?\n/).slice(0, 20);
        let sessionId = "";
        let createdAt = 0;
        let title = "";
        let sawMatchingCwd = false;

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          const event = JSON.parse(line);
          sessionId = sessionId || event.sessionId;
          title = title || event.lastPrompt || event.message?.content;
          createdAt =
            createdAt || Date.parse(event.timestamp || event.message?.timestamp || "");

          if (event.cwd && !isSamePath(event.cwd, cwd)) {
            return null;
          }

          if (event.cwd && isSamePath(event.cwd, cwd)) {
            sawMatchingCwd = true;
          }
        }

        if (
          !sessionId ||
          !sawMatchingCwd ||
          !Number.isFinite(createdAt) ||
          createdAt < after
        ) {
          return null;
        }

        const stat = fs.statSync(filePath);
        return {
          provider: "claude",
          id: sessionId,
          title,
          createdAt,
          updatedAt: stat.mtimeMs
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return matches[0] || null;
}

function findLatestOpenCodeThread(cwd, after = 0) {
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

  return new Promise((resolve) => {
    let stdout = "";

    result.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    result.on("error", () => resolve(null));
    result.on("exit", () => {
      try {
        const sessions = JSON.parse(stdout);
        const latest =
          sessions
            .filter(
              (session) =>
                session.id &&
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
    const threadRef = findLatestClaudeThread(cwd, after);
    return threadRef
      ? { status: "found", threadRef }
      : {
          status: "pending",
          message: "Waiting for Claude to create its local session metadata."
        };
  }

  if (payload.provider === "opencode") {
    const threadRef = await findLatestOpenCodeThread(cwd, after);
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

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on("line", async (line) => {
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
});

emit({ type: "ready" });
