// Fusion app-server boot smoke test.
//
// Validates that the Codex `app-server` JSON-RPC protocol that Terminal Fusion
// drives (see docs/fusion-terminal.md) still speaks the handshake we build
// against. It spawns `codex app-server` (stdio transport), validates the
// initialize response, then exercises native thread goals without a model turn,
// auth, or network. If the bundled/pinned Codex bumps to a version whose
// protocol drifts, this fails CI instead of users.
//
// Skips cleanly when codex is not installed (dev machines without it; Fusion
// itself ships its own bundled binary).

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const isWin = process.platform === "win32";
const REQUEST_ID = 1;
const TIMEOUT_MS = 20000;
const requireEmbedded =
  process.argv.includes("--require-embedded") || process.env.VIBE_REQUIRE_EMBEDDED_CODEX === "1";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function embeddedCodex() {
  const exe = isWin ? "codex.exe" : "codex";
  const candidate = path.join(
    __dirname,
    "..",
    "..",
    "vendor",
    "codex-bin",
    `${process.platform}-${process.arch}`,
    exe
  );
  return fs.existsSync(candidate) ? candidate : null;
}

function expectedCodexVersion() {
  const appserverDir = path.join(__dirname, "..", "..", "vendor", "codex-appserver");
  try {
    const versions = fs
      .readdirSync(appserverDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
      .map((entry) => entry.name);
    return versions.length === 1 ? versions[0] : null;
  } catch {
    return null;
  }
}

function readCodexVersion(binary) {
  try {
    const output = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 10000
    });
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function assertEmbeddedVersion(binary) {
  const expected = expectedCodexVersion();
  if (!expected) return;
  const actual = readCodexVersion(binary);
  assert(
    actual === expected,
    `embedded Codex version ${actual || "unknown"} does not match vendored app-server schema ${expected}`
  );
}

function codexAvailable() {
  if (embeddedCodex()) return true;
  if (requireEmbedded) return false;
  try {
    execFileSync(isWin ? "where" : "which", ["codex"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function spawnAppServer(env = {}) {
  // Prefer the EMBEDDED binary (exactly what a Fusion pane spawns); fall back to
  // a PATH `codex` via the shell (npm `.cmd`/`.ps1` wrappers on Windows).
  const embedded = embeddedCodex();
  if (embedded) {
    return spawn(embedded, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...env }
    });
  }
  if (requireEmbedded) {
    throw new Error("embedded Codex binary is required but vendor/codex-bin is missing");
  }
  const shell = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const args = isWin
    ? ["/d", "/s", "/c", "codex app-server"]
    : ["-c", "codex app-server"];
  return spawn(shell, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ...env }
  });
}

function killProcessTree(child) {
  try {
    child.stdin.end();
  } catch {
    // ignore
  }
  try {
    child.kill();
  } catch {
    // ignore
  }
  if (isWin && child.pid) {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore"
      });
    } catch {
      // best-effort
    }
  }
}

async function withAppServer(env, run) {
  const child = spawnAppServer(env);
  let nextId = 1;
  let stdout = "";
  let stderr = "";
  const pending = new Map();

  const timer = setTimeout(() => {
    for (const { reject, method } of pending.values()) {
      reject(new Error(`Timed out waiting for ${method}.\nstderr: ${stderr.slice(0, 500)}`));
    }
    pending.clear();
  }, TIMEOUT_MS);

  function rpc(method, params) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
    });
  }

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    let index;
    while ((index = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, index).trim();
      stdout = stdout.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!message || message.id === undefined || !pending.has(message.id)) continue;
      const pendingRequest = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        pendingRequest.reject(new Error(`${pendingRequest.method}: ${message.error.message}`));
      } else {
        pendingRequest.resolve(message.result);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    return await run({ rpc, stderr: () => stderr });
  } finally {
    clearTimeout(timer);
    pending.clear();
    killProcessTree(child);
  }
}

async function smokeGoalProtocol() {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-goal-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-goal-cwd-"));
  try {
    await withAppServer({ CODEX_HOME: codexHome }, async ({ rpc }) => {
      await rpc("initialize", {
        clientInfo: { name: "vibeTerminal-fusion-goal-smoke", version: "0.0.0" },
        capabilities: { experimentalApi: true }
      });
      const start = await rpc("thread/start", {
        cwd,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        config: { "features.goals": true }
      });
      const threadId = start && start.thread && start.thread.id;
      assert(threadId, `thread/start returned no thread id: ${JSON.stringify(start)}`);

      const set = await rpc("thread/goal/set", {
        threadId,
        objective: "verify Fusion native goal protocol",
        status: "active"
      });
      assert(
        set && set.goal && set.goal.objective === "verify Fusion native goal protocol",
        `thread/goal/set returned unexpected result: ${JSON.stringify(set)}`
      );

      const get = await rpc("thread/goal/get", { threadId });
      assert(
        get && get.goal && get.goal.status === "active",
        `thread/goal/get returned unexpected result: ${JSON.stringify(get)}`
      );

      const clear = await rpc("thread/goal/clear", { threadId });
      assert(clear && clear.cleared === true, `thread/goal/clear failed: ${JSON.stringify(clear)}`);
    });
  } finally {
    try {
      fs.rmSync(codexHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

async function main() {
  if (!codexAvailable()) {
    if (requireEmbedded) {
      throw new Error(
        "missing embedded Codex binary; run npm run prepare:codex-bin:required before release smokes"
      );
    }
    console.log(
      "SKIP fusion-appserver-smoke: codex not on PATH " +
        "(Fusion ships a bundled binary; for dev install the Codex CLI)."
    );
    return;
  }

  if (requireEmbedded) {
    assertEmbeddedVersion(embeddedCodex());
  }

  const child = spawnAppServer();
  let stdout = "";
  let stderr = "";
  let settled = false;

  const cleanup = () => {
    killProcessTree(child);
  };

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `No JSON-RPC response to initialize within ${TIMEOUT_MS}ms.\n` +
            `stderr: ${stderr.slice(0, 500)}`
        )
      );
    }, TIMEOUT_MS);

    const tryParseResponse = () => {
      // The stdio transport is newline-delimited JSON. Scan complete lines for
      // our response id; ignore notifications (no id) and any non-JSON log lines.
      let index;
      while ((index = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message && message.id === REQUEST_ID) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(message);
          return;
        }
      }
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      tryParseResponse();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `app-server exited (code ${code}) before responding.\n` +
            `stderr: ${stderr.slice(0, 500)}`
        )
      );
    });

    const initialize = {
      id: REQUEST_ID,
      method: "initialize",
      params: {
        clientInfo: { name: "vibeTerminal-fusion-smoke", version: "0.0.0" },
        capabilities: { experimentalApi: true }
      }
    };
    child.stdin.write(`${JSON.stringify(initialize)}\n`);
  });

  cleanup();

  assert(
    !result.error,
    `initialize returned an error: ${JSON.stringify(result.error)}`
  );
  assert(
    result.result && typeof result.result === "object",
    `initialize response missing a result object: ${JSON.stringify(result)}`
  );

  await smokeGoalProtocol();

  console.log("PASS fusion-appserver-smoke: app-server initialize and goal protocol OK.");
}

main().catch((error) => {
  console.error(`FAIL fusion-appserver-smoke: ${error.message}`);
  process.exit(1);
});
