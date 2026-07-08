// Fusion adapter MCP-surface smoke test.
//
// Spawns backend/fusion-adapter.cjs and drives its north (MCP stdio) side the
// way Claude Code would: `initialize` then `tools/list`. Asserts the hand-rolled
// MCP server identifies itself and exposes the Fusion tools. This guards the
// riskiest hand-written piece without needing codex auth or a model turn (the
// full app-server turn round-trip is covered by the end-to-end check).

const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const { createRequire } = require("module");
const os = require("os");
const path = require("path");
const vm = require("vm");

const adapterPath = path.join(__dirname, "..", "..", "backend", "fusion-adapter.cjs");
const isWin = process.platform === "win32";
const {
  FAST_SERVICE_TIER,
  FANOUT_MAX_TASKS,
  VERDICT_MARKER,
  buildClaudeExecutorArgs,
  buildCodexInvestigationTask,
  buildCodexVerifierTask,
  buildFanoutScoutTask,
  buildFanoutWorkstreamTask,
  combineFanoutResults,
  fanoutFileConflicts,
  normalizeFanoutTasks,
  cleanClaudeEffort,
  codexMcpServerConfigKey,
  commandExecutionDisplayText,
  displayCommandFromItem,
  extractVerifierVerdict,
  fastTierForModel,
  goalStatusForVerdict,
  normalizeGoal,
  normalizeGoalStatus,
  shouldAutoSyncGoalStatus,
  shouldReplaceGoalForTask,
  summarizeAgentMessageForDisplay,
  summarizeCommandExecution,
  stripVerifierVerdictFromSummary,
  translateWorkspaceMcpServerConfig,
  unwrapShellCommand,
  workspaceMcpConfigOverrides,
  turnErrorMessage
} = require(adapterPath);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const child = spawn(process.execPath, [adapterPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Eager boot is opt-in. Without that env flag the adapter still connects
      // lazily, so the MCP surface is exercised without a live app-server.
      VIBE_TERMINAL_FUSION_WS: "ws://127.0.0.1:1",
      VIBE_TERMINAL_SESSION_ID: "fusion-adapter-smoke"
    }
  });

  const responses = new Map();
  let buffer = "";

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for MCP responses"));
    }, 10000);

    function cleanup() {
      clearTimeout(timer);
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
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });

    child.stdout.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (responses.has(1) && responses.has(2) && responses.has(3)) {
          try {
            const init = responses.get(1);
            assert(
              init.result && init.result.serverInfo && init.result.serverInfo.name === "fusion-codex",
              `initialize did not identify the fusion adapter: ${JSON.stringify(init)}`
            );
            assert(
              init.result.capabilities && init.result.capabilities.tools,
              "initialize did not advertise tools capability"
            );
            const list = responses.get(2);
            const tools = list.result && list.result.tools ? list.result.tools : [];
            const names = tools.map((t) => t.name);
            assert(names.includes("codex_goal_set"), "tools/list missing codex_goal_set");
            assert(names.includes("codex_goal_get"), "tools/list missing codex_goal_get");
            assert(names.includes("codex_goal_clear"), "tools/list missing codex_goal_clear");
            assert(names.includes("codex_investigate"), "tools/list missing codex_investigate");
            assert(names.includes("codex_implement"), "tools/list missing codex_implement");
            assert(names.includes("codex_watch_build"), "tools/list missing codex_watch_build");
            assert(names.includes("codex_respond"), "tools/list missing codex_respond");
            assert(names.includes("codex_steer_resolve"), "tools/list missing codex_steer_resolve");
            assert(names.includes("codex_cancel"), "tools/list missing codex_cancel");
            const goalTool = tools.find((t) => t.name === "codex_goal_set");
            assert(
              goalTool && /native Codex per-thread goal/i.test(goalTool.description),
              "codex_goal_set description missing native-goal contract"
            );
            const implementTool = tools.find((t) => t.name === "codex_implement");
            assert(
              implementTool &&
                /guidance for Codex/i.test(implementTool.description) &&
                /independently verifying/i.test(implementTool.description) &&
                /picture\/image generation/i.test(implementTool.description) &&
                /browser navigation\/control\/automation/i.test(implementTool.description),
              "codex_implement description missing Claude-guides-Codex contract"
            );
            const source = fs.readFileSync(adapterPath, "utf8");
            assert(source.includes('notify("initialized")'), "adapter does not send initialized notification");
            assert(source.includes("PARKED_REQUEST_METHODS"), "adapter does not allowlist parked request methods");
            assert(
              source.includes('"item/permissions/requestApproval"') &&
                source.includes('method.endsWith("permissions/requestApproval")'),
              "adapter should park Codex permission approval requests instead of auto-denying them"
            );
            assert(source.includes('method === "currentTime/read"'), "adapter does not handle currentTime/read");
            assert(source.includes("unsupportedServerRequest"), "adapter does not fail unsupported server requests explicitly");
            assert(
              source.includes('rpc("turn/steer"') &&
                source.includes('rpc("turn/interrupt"') &&
                source.includes("activeTurnId") &&
                source.includes("fusion.adapterReady"),
              "adapter should expose terminal-scoped direct Codex steer/interrupt control"
            );
            assert(source.includes("goalReached"), "adapter does not return the structured verifier fields");
            assert(
              source.includes('"features.goals": true') &&
                source.includes('"features.fast_mode": true') &&
                source.includes("params.serviceTier") &&
                source.includes('rpc("model/list"'),
              "adapter must enable native Codex goals + FastMode and resolve serviceTier through model/list"
            );
            assert(
              source.includes('sandbox: "danger-full-access"') &&
                source.includes('approvalPolicy: "never"') &&
                source.includes("function fusionCodexSandboxPolicy") &&
                source.includes('return { type: "dangerFullAccess" };') &&
                (source.match(/sandboxPolicy: fusionCodexSandboxPolicy\(\)/g) || []).length >= 1,
              "adapter should run Fusion Codex implementation turns with full access and no routine approval prompts"
            );
            assert(
              source.includes("function fusionCodexInvestigateSandboxPolicy") &&
                source.includes('return { type: "readOnly" };') &&
                source.includes("sandboxPolicy: fusionCodexInvestigateSandboxPolicy()") &&
                source.includes("VIBE_FUSION_INVESTIGATE_SANDBOX") &&
                /return process\.platform === "win32"\s*\?\s*fusionCodexSandboxPolicy\(\)\s*:\s*\{ type: "readOnly" \}/.test(source),
              "codex_investigate must use Codex's read-only OS sandbox on POSIX but keep full access on win32 (read-only sandbox bootstrap still fails there: CreateProcessAsUserW 1312 on codex 0.142.4), with VIBE_FUSION_INVESTIGATE_SANDBOX overriding either way"
            );
            assert(
              source.includes("function resetCodexProcessState") &&
                source.includes("codexInitialized = false"),
              "adapter should reset initialization state when replacing the Codex worker"
            );
            assert(
              source.includes("codex_steer_resolve") &&
                source.includes("const PLAN_MODE_ALLOWED_TOOLS = new Set(["),
              "Plan mode should allow steering-route resolution while keeping implementation blocked"
            );
            assert(source.includes('rpc("thread/goal/set"'), "adapter does not call native goal set");
            assert(source.includes('rpc("thread/goal/get"'), "adapter does not call native goal get");
            assert(source.includes('rpc("thread/goal/clear"'), "adapter does not call native goal clear");
            assert(source.includes("buildCodexVerifierTask(task)"), "adapter does not wrap Codex tasks with the verifier contract");
            const cancelResponseText = responses.get(3).result.content[0].text;
            const cancelResponse = JSON.parse(cancelResponseText);
            assert(cancelResponse.status === "cancelled", `codex_cancel call should succeed: ${cancelResponseText}`);
            assert(
              source.includes("VIBE_FUSION_EAGER_BOOT") &&
                source.includes("warmupCodexThread") &&
                source.includes("threadReady"),
              "adapter should eager-boot and de-dupe startup thread initialization"
            );
            assert(
              source.includes("function isCurrentCodexChild") &&
                source.includes("if (!isCurrentCodexChild(child))") &&
                source.includes("codexBuffer = \"\""),
              "adapter should ignore stale app-server stdout/exit after a replacement child starts"
            );
            assert(
              source.includes(".then(handleTurnStartResponse)") &&
                source.includes('refreshTurnIdleTimer("turn/start response")'),
              "adapter should treat the turn/start response itself as live turn progress"
            );
            assert(
              source.includes("isTurnProgressNotification") &&
                source.includes('method === "item/agentMessage/delta"') &&
                source.includes("appendAgentMessageDelta"),
              "adapter should keep the bridge alive on streamed app-server progress events"
            );
            assert(
              source.includes('turn.status === "failed"') &&
                source.includes("turnErrorMessage(turn)"),
              "adapter should surface failed turn/completed status instead of reporting a synthetic stall"
            );
            assert(
              source.includes("TURN_HARD_TIMEOUT_MS") &&
                source.includes("hardTimer") &&
                source.includes("Fusion turn exceeded the maximum duration"),
              "adapter must arm a non-disableable hard turn ceiling so the turn waiter always resolves"
            );
            assert(
              source.includes("function codexCancel") &&
                source.includes('name: "codex_cancel"') &&
                source.includes("parked.clear()"),
              "adapter must expose an orchestrator-reachable codex_cancel escape hatch that clears parked state"
            );
            assert(
              source.includes('status: "steer_routing"') &&
                source.includes("function codexSteerResolve") &&
                source.includes("STEER_ROUTE_TIMEOUT_MS") &&
                source.includes('status: "routing"') &&
                source.includes("buildSteerRoutingResult"),
              "adapter must route active implementation steering through the planner with a watchdog"
            );
            assert(
              source.includes("Number.isFinite(n) && n > 0 ? n : 600000"),
              "adapter must floor the idle-timeout env so 0/NaN cannot silently disable the only idle backstop"
            );
            cleanup();
            resolve();
          } catch (error) {
            cleanup();
            reject(error);
          }
        }
      }
    });

    // Drive the MCP handshake.
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fusion-adapter-smoke", version: "0.0.0" }
        }
      })}\n`
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "codex_cancel",
          arguments: {}
        }
      })}\n`
    );
  });
}

function writeFakeAppServer(dir, options = {}) {
  const markerFile = options.markerFile ? JSON.stringify(options.markerFile) : "null";
  const threadStartParamsFile = options.threadStartParamsFile
    ? JSON.stringify(options.threadStartParamsFile)
    : "null";
  const delayThreadStartMs = Number(options.delayThreadStartMs || 0);
  fs.writeFileSync(
    path.join(dir, "app-server"),
    `
const fs = require("fs");
const readline = require("readline");
const markerFile = ${markerFile};
const threadStartParamsFile = ${threadStartParamsFile};
const delayThreadStartMs = ${Number.isFinite(delayThreadStartMs) ? delayThreadStartMs : 0};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function sendThreadStart(id) {
  send({ id, result: { thread: { id: "thread-1" } } });
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === "model/list") {
    send({ id: msg.id, result: { data: [{ id: "gpt-5.5", model: "gpt-5.5", isDefault: true, serviceTiers: [{ id: "priority", name: "Fast", description: "Fastest inference" }] }], nextCursor: null } });
    return;
  }
  if (msg.method === "thread/start") {
    if (markerFile) fs.appendFileSync(markerFile, "thread-started\\n");
    if (threadStartParamsFile) fs.writeFileSync(threadStartParamsFile, JSON.stringify(msg.params, null, 2));
    if (delayThreadStartMs > 0) {
      setTimeout(() => sendThreadStart(msg.id), delayThreadStartMs);
    } else {
      sendThreadStart(msg.id);
    }
    return;
  }
  if (msg.method === "thread/goal/set") {
    send({
      id: msg.id,
      result: {
        goal: {
          threadId: "thread-1",
          objective: msg.params.objective || "",
          status: msg.params.status || "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1
        }
      }
    });
    return;
  }
  if (msg.method === "turn/start") {
    send({
      id: msg.id,
      result: {
        turn: {
          id: "turn-1",
          items: [],
          itemsView: "full",
          status: "failed",
          error: { message: "Fake upstream failed.", additionalDetails: "Retry with auth." },
          startedAt: 1,
          completedAt: 2,
          durationMs: 1
        }
      }
    });
    return;
  }
  if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
`
  );
}

function waitForFile(file, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${path.basename(file)}`));
      }
    }, 50);
  });
}

async function assertWorkspaceMcpConfigInjectedIntoThreadStart() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-thread-mcp-"));
  const markerFile = path.join(tempDir, "thread-started.txt");
  const threadStartParamsFile = path.join(tempDir, "thread-start-params.json");
  writeFakeAppServer(tempDir, { markerFile, threadStartParamsFile });
  fs.writeFileSync(
    path.join(tempDir, ".mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          docs: {
            command: "node",
            args: ["docs-mcp.js"],
            env: { DOCS_TOKEN: "local" }
          },
          remote: {
            url: "https://example.test/mcp",
            headers: { "X-Test": "yes" }
          }
        }
      },
      null,
      2
    )}\n`
  );

  const child = spawn(process.execPath, [adapterPath], {
    cwd: tempDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      VIBE_FUSION_CODEX_BIN: process.execPath,
      VIBE_TERMINAL_FUSION_CWD: tempDir,
      VIBE_TERMINAL_SESSION_ID: "fusion-adapter-thread-mcp"
    }
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  function cleanup() {
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fusion-adapter-thread-mcp", version: "0.0.0" }
        }
      })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "codex_goal_get", arguments: {} }
      })}\n`
    );
    await waitForFile(threadStartParamsFile);
    const params = JSON.parse(fs.readFileSync(threadStartParamsFile, "utf8"));
    assert(params.cwd === tempDir, `thread/start should use workspace cwd: ${JSON.stringify(params)}`);
    assert(
      params.config?.["features.goals"] === true &&
        params.config?.["features.fast_mode"] === true,
      `thread/start should preserve existing feature flags: ${JSON.stringify(params)}`
    );
    assert(
      params.config?.["mcp_servers.docs"]?.command === "node" &&
        params.config?.["mcp_servers.docs"]?.args?.[0] === "docs-mcp.js" &&
        params.config?.["mcp_servers.docs"]?.env?.DOCS_TOKEN === "local",
      `thread/start should include stdio workspace MCP config override: ${JSON.stringify(params)}`
    );
    assert(
      params.config?.["mcp_servers.remote"]?.url === "https://example.test/mcp" &&
        params.config?.["mcp_servers.remote"]?.http_headers?.["X-Test"] === "yes",
      `thread/start should include HTTP workspace MCP config override: ${JSON.stringify(params)}`
    );
  } catch (error) {
    throw new Error(`${error.message}; stderr=${stderr}`);
  } finally {
    cleanup();
  }
}

async function assertEagerBootStartsThread() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-eager-"));
  const markerFile = path.join(tempDir, "thread-started.txt");
  writeFakeAppServer(tempDir, { markerFile });
  const child = spawn(process.execPath, [adapterPath], {
    cwd: tempDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      VIBE_FUSION_CODEX_BIN: process.execPath,
      VIBE_TERMINAL_FUSION_CWD: tempDir,
      VIBE_TERMINAL_SESSION_ID: "fusion-adapter-eager",
      VIBE_FUSION_EAGER_BOOT: "1"
    }
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  function cleanup() {
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  try {
    await waitForFile(markerFile);
  } catch (error) {
    throw new Error(`${error.message}; adapter stderr=${stderr}`);
  } finally {
    cleanup();
  }
}

function callAdapterToolDuringEagerBootUsesOneThreadStart() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-dedupe-"));
  const markerFile = path.join(tempDir, "thread-started.txt");
  writeFakeAppServer(tempDir, { markerFile, delayThreadStartMs: 200 });
  const child = spawn(process.execPath, [adapterPath], {
    cwd: tempDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      VIBE_FUSION_CODEX_BIN: process.execPath,
      VIBE_TERMINAL_FUSION_CWD: tempDir,
      VIBE_TERMINAL_SESSION_ID: "fusion-adapter-dedupe",
      VIBE_FUSION_EAGER_BOOT: "1"
    }
  });

  const responses = new Map();
  let buffer = "";
  let stderr = "";

  function cleanup() {
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for eager de-dupe result; stderr=${stderr}`));
    }, 10000);

    child.on("error", (error) => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("exit", (code) => {
      if (responses.has(2)) return;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`adapter exited before eager de-dupe result: code=${code}; stderr=${stderr}`));
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (responses.has(2)) {
          clearTimeout(timer);
          try {
            const response = responses.get(2);
            const text = response.result.content[0].text;
            const parsed = JSON.parse(text);
            const starts = fs.readFileSync(markerFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
            assert(parsed.status === "ok", `goal get should succeed after eager boot: ${text}`);
            assert(starts.length === 1, `expected one thread/start during eager boot race, got ${starts.length}`);
            cleanup();
            resolve();
          } catch (error) {
            cleanup();
            reject(error);
          }
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fusion-adapter-dedupe", version: "0.0.0" }
        }
      })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "codex_goal_get", arguments: {} }
      })}\n`
    );
  });
}

function callAdapterToolWithFakeAppServer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-fake-"));
  writeFakeAppServer(tempDir);
  const child = spawn(process.execPath, [adapterPath], {
    cwd: tempDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      VIBE_FUSION_CODEX_BIN: process.execPath,
      VIBE_TERMINAL_FUSION_CWD: tempDir,
      VIBE_TERMINAL_SESSION_ID: "fusion-adapter-fake",
      VIBE_FUSION_TURN_IDLE_TIMEOUT_MS: "200"
    }
  });

  const responses = new Map();
  let buffer = "";
  let stderr = "";

  function cleanup() {
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for fake app-server tool result"));
    }, 10000);

    child.on("error", (error) => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("exit", (code) => {
      if (responses.has(2)) return;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`adapter exited before fake tool result: code=${code}; stderr=${stderr}`));
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (responses.has(2)) {
          clearTimeout(timer);
          try {
            const response = responses.get(2);
            const text = response.result.content[0].text;
            const parsed = JSON.parse(text);
            assert(parsed.status === "failed", `fake turn should fail: ${text}`);
            assert(
              parsed.error === "Fake upstream failed. Retry with auth.",
              `failed turn should preserve app-server error details, got ${text}`
            );
            cleanup();
            resolve();
          } catch (error) {
            cleanup();
            reject(error);
          }
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fusion-adapter-fake", version: "0.0.0" }
        }
      })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "codex_implement", arguments: { task: "do work" } }
      })}\n`
    );
  });
}

function callAdapterPlanModeRejectsImplement() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-plan-"));
  const modeFile = path.join(tempDir, "run-mode.txt");
  fs.writeFileSync(modeFile, "plan\n");
  const child = spawn(process.execPath, [adapterPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      VIBE_TERMINAL_SESSION_ID: "fusion-adapter-plan",
      VIBE_FUSION_RUN_MODE: "auto",
      VIBE_FUSION_RUN_MODE_FILE: modeFile
    }
  });

  const responses = new Map();
  let buffer = "";

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for Plan mode refusal"));
    }, 10000);

    function cleanup() {
      clearTimeout(timer);
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
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (responses.has(2)) {
          clearTimeout(timer);
          try {
            const response = responses.get(2);
            const text = response.result.content[0].text;
            const parsed = JSON.parse(text);
            assert(parsed.status === "failed", "Plan mode should fail codex_implement: " + text);
            assert(parsed.mode === "plan", "Plan mode refusal should report mode: " + text);
            assert(/Plan mode is active/i.test(parsed.error), "Plan mode refusal should explain the gate: " + text);
            cleanup();
            resolve();
          } catch (error) {
            cleanup();
            reject(error);
          }
        }
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fusion-plan", version: "0.0.0" }
        }
      }) + "\n"
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "codex_implement", arguments: { task: "edit a file" } }
      }) + "\n"
    );
  });
}
function writeApprovalResumeFakeAppServer(dir, options = {}) {
  const completeBeforeApprovalResponse = options.completeBeforeApprovalResponse === true;
  const queueSecondApproval = options.queueSecondApproval === true;
  const summaryText = JSON.stringify(
    `Approval resumed and completed.\n${VERDICT_MARKER} {"goalReached":true,"bugsFound":[],"missingRequirements":[],"nextAction":"done","summary":"Approval resume completed."}`
  );
  fs.writeFileSync(
    path.join(dir, "app-server"),
    `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const approvalRequestId = 900;
const secondApprovalRequestId = 901;
const summaryText = ${summaryText};
const completeBeforeApprovalResponse = ${completeBeforeApprovalResponse ? "true" : "false"};
const queueSecondApproval = ${queueSecondApproval ? "true" : "false"};
const answeredApprovals = new Set();
let completionSent = false;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

function goal(params = {}) {
  return {
    threadId: "thread-1",
    objective: params.objective || "do work",
    status: params.status || "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1
  };
}

function turn(status, items = []) {
  return {
    id: "turn-1",
    items,
    itemsView: "full",
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "completed" ? 2 : null,
    durationMs: status === "completed" ? 10 : null
  };
}

function commandItem() {
  return {
    type: "commandExecution",
    id: "cmd-1",
    command: "git symbolic-ref --short HEAD",
    cwd: process.cwd(),
    processId: null,
    source: "shell",
    status: "completed",
    commandActions: [],
    aggregatedOutput: "main\\n",
    exitCode: 0,
    durationMs: 5
  };
}

function agentItem() {
  return {
    type: "agentMessage",
    id: "msg-1",
    text: summaryText,
    phase: null,
    memoryCitation: null
  };
}

function sendCompletion() {
  if (completionSent) return;
  completionSent = true;
  const command = commandItem();
  const agent = agentItem();
  send({
    method: "serverRequest/resolved",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", requestId: approvalRequestId }
  });
  if (queueSecondApproval) {
    send({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-2", requestId: secondApprovalRequestId }
    });
  }
  send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: command } });
  send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: agent } });
  send({ method: "turn/completed", params: { threadId: "thread-1", turn: turn("completed", [command, agent]) } });
}

function sendApproval(id, itemId, command, reason) {
  send({
    id,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId,
      startedAtMs: Date.now(),
      approvalId: null,
      environmentId: null,
      reason,
      command,
      cwd: process.cwd(),
      commandActions: [],
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
    }
  });
}

function allApprovalsAnswered() {
  return answeredApprovals.has(approvalRequestId) &&
    (!queueSecondApproval || answeredApprovals.has(secondApprovalRequestId));
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === "model/list") {
    send({ id: msg.id, result: { data: [{ id: "gpt-5.5", model: "gpt-5.5", isDefault: true, serviceTiers: [{ id: "priority", name: "Fast", description: "Fastest inference" }] }], nextCursor: null } });
    return;
  }
  if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (msg.method === "thread/goal/set") {
    send({ id: msg.id, result: { goal: goal(msg.params || {}) } });
    return;
  }
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: turn("running") } });
    send({ method: "turn/started", params: { threadId: "thread-1", turn: turn("running") } });
    sendApproval(approvalRequestId, "cmd-1", "git symbolic-ref --short HEAD", "read branch");
    if (queueSecondApproval) {
      sendApproval(secondApprovalRequestId, "cmd-2", "git status --short", "read status");
    }
    if (completeBeforeApprovalResponse) {
      sendCompletion();
    }
    return;
  }
  if ((msg.id === approvalRequestId || (queueSecondApproval && msg.id === secondApprovalRequestId)) && msg.result) {
    answeredApprovals.add(msg.id);
    if (!completeBeforeApprovalResponse && allApprovalsAnswered()) {
      sendCompletion();
    }
    return;
  }
  if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
`
  );
}

function writeApprovalExitFakeAppServer(dir) {
  fs.writeFileSync(
    path.join(dir, "app-server"),
    `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}
function goal(params = {}) {
  return {
    threadId: "thread-exit",
    objective: params.objective || "do work",
    status: params.status || "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1
  };
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === "model/list") {
    send({ id: msg.id, result: { data: [{ id: "gpt-5.5", model: "gpt-5.5", isDefault: true, serviceTiers: [{ id: "priority", name: "Fast", description: "Fastest inference" }] }], nextCursor: null } });
    return;
  }
  if (msg.method === "thread/start") {
    send({ id: msg.id, result: { thread: { id: "thread-exit" } } });
    return;
  }
  if (msg.method === "thread/goal/set") {
    send({ id: msg.id, result: { goal: goal(msg.params || {}) } });
    return;
  }
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-exit", items: [], status: "running" } } });
    send({ method: "turn/started", params: { threadId: "thread-exit", turn: { id: "turn-exit", items: [], status: "running" } } });
    send({
      id: 902,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-exit",
        turnId: "turn-exit",
        itemId: "cmd-exit",
        reason: "read status",
        command: "git status --short",
        cwd: process.cwd(),
        commandActions: [],
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
      }
    });
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
`
  );
}

function callAdapterApprovalResumeWithFakeAppServer(options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-approval-"));
  writeApprovalResumeFakeAppServer(tempDir, options);
  const exercisePendingRecovery = options.exercisePendingRecovery === true;
  const queueSecondApproval = options.queueSecondApproval === true;
  const finalRespondId = exercisePendingRecovery ? 5 : queueSecondApproval ? 4 : 3;
  const child = spawn(process.execPath, [adapterPath], {
    cwd: tempDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      VIBE_FUSION_CODEX_BIN: process.execPath,
      VIBE_TERMINAL_FUSION_CWD: tempDir,
      VIBE_TERMINAL_SESSION_ID: options.completeBeforeApprovalResponse
        ? "fusion-adapter-approval-latched"
        : "fusion-adapter-approval",
      VIBE_FUSION_TURN_IDLE_TIMEOUT_MS: "1000",
      VIBE_FUSION_TURN_AFTER_COMMAND_TIMEOUT_MS: "100"
    }
  });

  let buffer = "";
  let stderr = "";
  let parkedPendingId = "";
  let queuedPendingId = "";
  let sentImplementProbe = false;
  let sentWrongRespondProbe = false;
  let sentFinalRespond = false;
  let finished = false;

  function cleanup() {
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finished = true;
      cleanup();
      reject(new Error(`timed out waiting for approval resume result; stderr=${stderr}`));
    }, 10000);

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("exit", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`adapter exited before approval resume result: code=${code}; stderr=${stderr}`));
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        try {
          if (msg.id === 2 && !parkedPendingId) {
            const parsed = JSON.parse(msg.result.content[0].text);
            assert(parsed.status === "needs_decision", `expected approval request, got ${msg.result.content[0].text}`);
            assert(parsed.pendingId, "approval result missing pendingId");
            parkedPendingId = parsed.pendingId;
            if (exercisePendingRecovery) {
              sentImplementProbe = true;
              child.stdin.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: 3,
                  method: "tools/call",
                  params: { name: "codex_implement", arguments: { task: "start unrelated work" } }
                })}\n`
              );
              return;
            }
            if (queueSecondApproval) {
              child.stdin.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: 3,
                  method: "tools/call",
                  params: {
                    name: "codex_respond",
                    arguments: { pendingId: parsed.pendingId, decision: "accept" }
                  }
                })}\n`
              );
              return;
            }
            sentFinalRespond = true;
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: finalRespondId,
                method: "tools/call",
                params: {
                  name: "codex_respond",
                  arguments: { pendingId: parsed.pendingId, decision: "accept" }
                }
              })}\n`
            );
          }
          if (queueSecondApproval && msg.id === 3) {
            const text = msg.result.content[0].text;
            const parsed = JSON.parse(text);
            assert(parsed.status === "needs_decision", `queued approval should surface after first response: ${text}`);
            assert(parsed.pendingId, `queued approval response missing pendingId: ${text}`);
            assert(
              parsed.pendingId !== parkedPendingId,
              `queued approval should use the next pendingId: ${text}`
            );
            assert(
              /another pending decision queued/i.test(String(parsed.warning || "")),
              `queued approval should explain that another decision is waiting: ${text}`
            );
            queuedPendingId = parsed.pendingId;
            sentFinalRespond = true;
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: finalRespondId,
                method: "tools/call",
                params: {
                  name: "codex_respond",
                  arguments: { pendingId: queuedPendingId, decision: "accept" }
                }
              })}\n`
            );
            return;
          }
          if (exercisePendingRecovery && msg.id === 3) {
            assert(sentImplementProbe, "recovery implement probe was not sent");
            const text = msg.result.content[0].text;
            const parsed = JSON.parse(text);
            assert(parsed.status === "needs_decision", `recovery implement should surface pending approval: ${text}`);
            assert(
              parsed.pendingId === parkedPendingId,
              `recovery implement returned wrong pendingId: ${text}`
            );
            assert(
              /pending decision/i.test(String(parsed.warning || "")),
              `recovery implement should explain the parked decision: ${text}`
            );
            sentWrongRespondProbe = true;
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 4,
                method: "tools/call",
                params: {
                  name: "codex_respond",
                  arguments: { pendingId: "not-the-real-id", decision: "accept" }
                }
              })}\n`
            );
            return;
          }
          if (exercisePendingRecovery && msg.id === 4) {
            assert(sentWrongRespondProbe, "wrong pendingId probe was not sent");
            const text = msg.result.content[0].text;
            const parsed = JSON.parse(text);
            assert(parsed.status === "needs_decision", `wrong pendingId should re-surface pending approval: ${text}`);
            assert(
              parsed.pendingId === parkedPendingId,
              `wrong pendingId recovery returned wrong pendingId: ${text}`
            );
            assert(
              /unknown pendingId: not-the-real-id/i.test(String(parsed.warning || "")),
              `wrong pendingId recovery should include the bad id: ${text}`
            );
            sentFinalRespond = true;
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: finalRespondId,
                method: "tools/call",
                params: {
                  name: "codex_respond",
                  arguments: { pendingId: parkedPendingId, decision: "accept" }
                }
              })}\n`
            );
            return;
          }
          if (msg.id === finalRespondId) {
            assert(sentFinalRespond, "final approval response was not sent");
            finished = true;
            clearTimeout(timer);
            const text = msg.result.content[0].text;
            const parsed = JSON.parse(text);
            assert(parsed.status === "completed", `approval resume should complete: ${text}`);
            assert(parsed.goalReached === true, `approval resume verdict should pass: ${text}`);
            assert(parsed.nextAction === "done", `approval resume should be done: ${text}`);
            assert(
              parsed.summary === "Approval resumed and completed.",
              `approval resume summary should strip verifier JSON: ${text}`
            );
            cleanup();
            resolve();
          }
        } catch (error) {
          finished = true;
          clearTimeout(timer);
          cleanup();
          reject(error);
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fusion-adapter-approval", version: "0.0.0" }
        }
      })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "codex_implement", arguments: { task: "inspect the branch" } }
      })}\n`
    );
  });
}

function callAdapterClearsParkedApprovalWhenAppServerExits() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-approval-exit-"));
  writeApprovalExitFakeAppServer(tempDir);
  const child = spawn(process.execPath, [adapterPath], {
    cwd: tempDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      VIBE_FUSION_CODEX_BIN: process.execPath,
      VIBE_TERMINAL_FUSION_CWD: tempDir,
      VIBE_TERMINAL_SESSION_ID: "fusion-adapter-approval-exit",
      VIBE_FUSION_TURN_IDLE_TIMEOUT_MS: "1000",
      VIBE_FUSION_TURN_AFTER_COMMAND_TIMEOUT_MS: "100"
    }
  });

  let buffer = "";
  let stderr = "";
  let parkedPendingId = "";
  let sentStaleRespond = false;
  let finished = false;

  function cleanup() {
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finished = true;
      cleanup();
      reject(new Error(`timed out waiting for stale approval cleanup; stderr=${stderr}`));
    }, 10000);

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("exit", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`adapter exited before stale approval cleanup result: code=${code}; stderr=${stderr}`));
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        try {
          if (msg.id === 2 && !parkedPendingId) {
            const parsed = JSON.parse(msg.result.content[0].text);
            assert(parsed.status === "needs_decision", `expected parked approval before exit: ${msg.result.content[0].text}`);
            assert(parsed.pendingId, "parked approval before exit missing pendingId");
            parkedPendingId = parsed.pendingId;
            setTimeout(() => {
              if (finished) return;
              sentStaleRespond = true;
              child.stdin.write(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: 3,
                  method: "tools/call",
                  params: {
                    name: "codex_respond",
                    arguments: { pendingId: parkedPendingId, decision: "accept" }
                  }
                })}\n`
              );
            }, 200);
            return;
          }
          if (msg.id === 3) {
            assert(sentStaleRespond, "stale approval response was not sent");
            const text = msg.result.content[0].text;
            const parsed = JSON.parse(text);
            assert(parsed.status === "error", `stale pendingId should be rejected after worker exit: ${text}`);
            assert(
              String(parsed.error || "").includes(`unknown pendingId: ${parkedPendingId}`),
              `stale pendingId should not be recoverable after worker exit: ${text}`
            );
            finished = true;
            clearTimeout(timer);
            cleanup();
            resolve();
          }
        } catch (error) {
          finished = true;
          clearTimeout(timer);
          cleanup();
          reject(error);
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fusion-adapter-approval-exit", version: "0.0.0" }
        }
      })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "codex_implement", arguments: { task: "inspect status" } }
      })}\n`
    );
  });
}

// CC-host portability guard (see docs/fusion-terminal.md "Host portability").
// The Fusion delegation engine must stay a clean stdio MCP server that runs with
// NO Electron host attached, so it can be driven by a plain `claude --mcp-config`
// if the host strategy ever changes. This boots the adapter with the three
// host-coupling env vars explicitly UNSET and drives the full
// initialize -> tools/list -> tools/call round-trip against a fake app-server. A
// future edit that hard-requires the host (an unguarded env read, a require() of
// host code, or a control server that binds unconditionally) breaks this here.
// A fake app-server that wedges the FIRST turn (parks an approval, then goes
// silent — no completion), and completes cleanly on the SECOND turn/start. This
// reproduces the "interfaces fighting" deadlock and lets us prove codex_cancel
// frees it: cancel the wedged turn, then re-delegate and reach completion.
function writeCancelWedgeFakeAppServer(dir) {
  const summaryText = JSON.stringify(
    `Re-delegated after cancel and completed.\n${VERDICT_MARKER} {"goalReached":true,"bugsFound":[],"missingRequirements":[],"nextAction":"done","summary":"Completed after cancel."}`
  );
  fs.writeFileSync(
    path.join(dir, "app-server"),
    `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const approvalRequestId = 950;
const summaryText = ${summaryText};
let turnStarts = 0;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function turn(status, items = []) {
  return { id: "turn-" + turnStarts, items, itemsView: "full", status, error: null, startedAt: 1, completedAt: status === "completed" ? 2 : null, durationMs: status === "completed" ? 10 : null };
}
function goal() {
  return { threadId: "thread-1", objective: "do work", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
}
function agentItem() {
  return { type: "agentMessage", id: "msg-1", text: summaryText, phase: null, memoryCitation: null };
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") { send({ id: msg.id, result: {} }); return; }
  if (msg.method === "model/list") { send({ id: msg.id, result: { data: [{ id: "gpt-5.5", model: "gpt-5.5", isDefault: true, serviceTiers: [{ id: "priority", name: "Fast", description: "Fastest inference" }] }], nextCursor: null } }); return; }
  if (msg.method === "thread/start") { send({ id: msg.id, result: { thread: { id: "thread-1" } } }); return; }
  if (msg.method === "thread/goal/set") { send({ id: msg.id, result: { goal: goal() } }); return; }
  if (msg.method === "turn/start") {
    turnStarts += 1;
    send({ id: msg.id, result: { turn: turn("running") } });
    send({ method: "turn/started", params: { threadId: "thread-1", turn: turn("running") } });
    if (turnStarts === 1) {
      // Wedge: park an approval, then never complete (silent child).
      send({ id: approvalRequestId, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", startedAtMs: Date.now(), approvalId: null, environmentId: null, reason: "needs approval", command: "git status --short", cwd: process.cwd(), commandActions: [], availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] } });
    } else {
      const agent = agentItem();
      send({ method: "item/completed", params: { threadId: "thread-1", turnId: turn("running").id, item: agent } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: turn("completed", [agent]) } });
    }
    return;
  }
  if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
`
  );
}

function callAdapterCancelClearsWedge() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-cancel-"));
  writeCancelWedgeFakeAppServer(tempDir);
  const child = spawn(process.execPath, [adapterPath], {
    cwd: tempDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      VIBE_FUSION_CODEX_BIN: process.execPath,
      VIBE_TERMINAL_FUSION_CWD: tempDir,
      VIBE_TERMINAL_SESSION_ID: "fusion-adapter-cancel",
      VIBE_FUSION_TURN_IDLE_TIMEOUT_MS: "5000",
      VIBE_FUSION_TURN_AFTER_COMMAND_TIMEOUT_MS: "5000"
    }
  });

  let buffer = "";
  let stderr = "";
  let finished = false;
  let sentCancel = false;
  let sentReimplement = false;

  function cleanup() {
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
        execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      } catch {
        // best-effort
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finished = true;
      cleanup();
      reject(new Error(`timed out waiting for cancel-clears-wedge result; stderr=${stderr}`));
    }, 10000);

    function fail(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    }

    child.on("error", fail);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      if (finished) return;
      fail(new Error(`adapter exited before cancel-clears-wedge result: code=${code}; stderr=${stderr}`));
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined || !msg.result || !msg.result.content) continue;
        try {
          if (msg.id === 2 && !sentCancel) {
            const parsed = JSON.parse(msg.result.content[0].text);
            assert(parsed.status === "needs_decision", `expected a parked approval before cancel: ${msg.result.content[0].text}`);
            assert(parsed.pendingId, "wedged approval missing pendingId");
            sentCancel = true;
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "codex_cancel", arguments: {} } })}\n`
            );
          } else if (msg.id === 3 && !sentReimplement) {
            const parsed = JSON.parse(msg.result.content[0].text);
            assert(parsed.status === "cancelled", `codex_cancel should report cancelled: ${msg.result.content[0].text}`);
            assert(parsed.clearedDecisions === true, `codex_cancel should clear the parked decision: ${msg.result.content[0].text}`);
            sentReimplement = true;
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "codex_implement", arguments: { task: "finish the work after cancel" } } })}\n`
            );
          } else if (msg.id === 4) {
            const parsed = JSON.parse(msg.result.content[0].text);
            assert(parsed.status === "completed", `re-delegate after cancel should complete, not wedge: ${msg.result.content[0].text}`);
            assert(parsed.goalReached === true, `re-delegate after cancel should reach the goal: ${msg.result.content[0].text}`);
            finished = true;
            clearTimeout(timer);
            cleanup();
            resolve();
          }
        } catch (error) {
          fail(error);
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fusion-cancel", version: "0.0.0" } } })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "codex_implement", arguments: { task: "do work that needs approval" } } })}\n`
    );
  });
}

function writeSteerRoutingFakeAppServer(dir, options = {}) {
  const completeOnSteer = options.completeOnSteer !== false;
  const markerDir = JSON.stringify(dir);
  const summaryText = JSON.stringify(
    `Steered work completed.\n${VERDICT_MARKER} {"goalReached":true,"bugsFound":[],"missingRequirements":[],"nextAction":"done","summary":"Steered work completed."}`
  );
  fs.writeFileSync(
    path.join(dir, "app-server"),
    `
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const markerDir = ${markerDir};
const summaryText = ${summaryText};
const completeOnSteer = ${completeOnSteer ? "true" : "false"};
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function mark(name, text = "") { fs.appendFileSync(path.join(markerDir, name), text + "\\n"); }
function goal(params = {}) {
  return { threadId: "thread-1", objective: params.objective || "do work", status: params.status || "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
}
function turn(status, items = []) {
  return { id: "turn-1", items, itemsView: "full", status, error: null, startedAt: 1, completedAt: status === "completed" ? 2 : null, durationMs: status === "completed" ? 10 : null };
}
function agentItem() {
  return { type: "agentMessage", id: "msg-steered", text: summaryText, phase: null, memoryCitation: null };
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") { send({ id: msg.id, result: {} }); return; }
  if (msg.method === "model/list") { send({ id: msg.id, result: { data: [{ id: "gpt-5.5", model: "gpt-5.5", isDefault: true, serviceTiers: [{ id: "priority", name: "Fast", description: "Fastest inference" }] }], nextCursor: null } }); return; }
  if (msg.method === "thread/start") { send({ id: msg.id, result: { thread: { id: "thread-1" } } }); return; }
  if (msg.method === "thread/goal/set") { send({ id: msg.id, result: { goal: goal(msg.params || {}) } }); return; }
  if (msg.method === "turn/start") {
    mark("turn-started.txt");
    send({ id: msg.id, result: { turn: turn("running") } });
    send({ method: "turn/started", params: { threadId: "thread-1", turn: turn("running") } });
    return;
  }
  if (msg.method === "turn/steer") {
    const text = (((msg.params || {}).input || [])[0] || {}).text || "";
    mark("steered.txt", text);
    send({ id: msg.id, result: { turnId: "turn-1" } });
    if (completeOnSteer) {
      const agent = agentItem();
      send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: agent } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: turn("completed", [agent]) } });
    }
    return;
  }
  if (msg.method === "turn/interrupt") {
    mark("interrupted.txt");
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
`
  );
}

function waitForCondition(check, timeoutMs = 10000, label = "condition") {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      try {
        const value = check();
        if (value) {
          clearInterval(timer);
          resolve(value);
          return;
        }
      } catch {
        // keep waiting
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 25);
  });
}

function postJson(urlString, token, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        timeout: 5000,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-vibe-telemetry-token": token
        }
      },
      (response) => {
        let responseBody = "";
        response.on("data", (chunk) => {
          responseBody += chunk.toString("utf8");
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(responseBody || "{}"));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy();
      reject(new Error("POST timed out"));
    });
    request.end(body);
  });
}

function createFusionCallbackServer(token) {
  let controlUrl = "";
  const events = [];
  const server = http.createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.headers["x-vibe-telemetry-token"] !== token) {
      response.writeHead(403);
      response.end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      try {
        const event = JSON.parse(body || "{}");
        events.push(event);
        if (event.type === "fusion.adapterReady" && event.controlUrl) {
          controlUrl = String(event.controlUrl).replace(/\/$/, "");
        }
      } catch {
        // ignore
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        callbackUrl: `http://127.0.0.1:${address.port}/agent-event`,
        getControlUrl: () => controlUrl,
        getEvents: () => events.slice()
      });
    });
  });
}

function callAdapterSteerRoutingWithFakeAppServer(mode) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `fusion-adapter-steer-${mode}-`));
  writeSteerRoutingFakeAppServer(tempDir, { completeOnSteer: mode === "push" });
  const token = `steer-token-${Date.now()}-${Math.random()}`;
  const sessionId = `fusion-adapter-steer-${mode}`;
  let callback = null;
  let child = null;
  let finished = false;
  let buffer = "";
  let stderr = "";
  const responses = new Map();

  function cleanup() {
    if (callback && callback.server) {
      try {
        callback.server.close();
      } catch {
        // ignore
      }
    }
    if (child) {
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
          execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        } catch {
          // best-effort
        }
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return createFusionCallbackServer(token).then((createdCallback) => {
    callback = createdCallback;
    child = spawn(process.execPath, [adapterPath], {
      cwd: tempDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        VIBE_FUSION_CODEX_BIN: process.execPath,
        VIBE_TERMINAL_FUSION_CWD: tempDir,
        VIBE_TERMINAL_SESSION_ID: sessionId,
        VIBE_TERMINAL_CALLBACK_URL: callback.callbackUrl,
        VIBE_TERMINAL_TELEMETRY_TOKEN: token,
        VIBE_FUSION_STEER_ROUTE_TIMEOUT_MS: "5000",
        VIBE_FUSION_TURN_IDLE_TIMEOUT_MS: "5000",
        VIBE_FUSION_TURN_AFTER_COMMAND_TIMEOUT_MS: "5000"
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) responses.set(msg.id, msg);
        } catch {
          // ignore
        }
      }
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finished = true;
        cleanup();
        reject(new Error(`timed out waiting for steer-routing ${mode}; stderr=${stderr}`));
      }, 15000);

      function fail(error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        cleanup();
        reject(error);
      }

      child.on("error", fail);
      child.on("exit", (code) => {
        if (finished) return;
        fail(new Error(`adapter exited before steer-routing ${mode}: code=${code}; stderr=${stderr}`));
      });

      (async () => {
        try {
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: `fusion-steer-${mode}`, version: "0.0.0" } } })}\n`
          );
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "codex_implement", arguments: { task: "do steered work" } } })}\n`
          );
          const controlUrl = await waitForCondition(() => callback.getControlUrl(), 5000, "adapter control url");
          await waitForFile(path.join(tempDir, "turn-started.txt"), 5000);
          const steerResponse = await postJson(`${controlUrl}/steer`, token, {
            sessionId,
            text: "change direction"
          });
          assert(steerResponse.status === "routing", `expected routing steer response, got ${JSON.stringify(steerResponse)}`);
          const routed = await waitForCondition(() => responses.get(2), 5000, "steer_routing MCP result");
          const routedParsed = JSON.parse(routed.result.content[0].text);
          assert(routedParsed.status === "steer_routing", `expected steer_routing result, got ${routed.result.content[0].text}`);
          assert(/change direction/.test(routedParsed.userSteer), `steer_routing should include user steer: ${routed.result.content[0].text}`);
          assert(!fs.existsSync(path.join(tempDir, "interrupted.txt")), "routing should not interrupt executor before planner decision");

          if (mode === "push") {
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "codex_steer_resolve", arguments: { decision: "push", text: "refined change direction" } } })}\n`
            );
            const pushed = await waitForCondition(() => responses.get(3), 5000, "push resolution");
            const parsed = JSON.parse(pushed.result.content[0].text);
            assert(parsed.status === "completed", `push should resume and complete: ${pushed.result.content[0].text}`);
            assert(parsed.goalReached === true, `push completion should carry verifier result: ${pushed.result.content[0].text}`);
            const steeredText = fs.readFileSync(path.join(tempDir, "steered.txt"), "utf8");
            assert(/refined change direction/.test(steeredText), "push should deliver refined steer text to executor");
            assert(!fs.existsSync(path.join(tempDir, "interrupted.txt")), "push should not interrupt executor");
          } else {
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "codex_steer_resolve", arguments: { decision: "replan" } } })}\n`
            );
            const replanned = await waitForCondition(() => responses.get(3), 5000, "replan resolution");
            const parsed = JSON.parse(replanned.result.content[0].text);
            assert(parsed.status === "steer_replan_ready", `replan should stop executor and return ready state: ${replanned.result.content[0].text}`);
            await waitForFile(path.join(tempDir, "interrupted.txt"), 5000);
          }

          finished = true;
          clearTimeout(timer);
          cleanup();
          resolve();
        } catch (error) {
          fail(error);
        }
      })();
    });
  });
}

function callAdapterDeadWindowSteerSkips() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-steer-dead-"));
  const token = `steer-token-${Date.now()}-${Math.random()}`;
  const sessionId = "fusion-adapter-steer-dead";
  let callback = null;
  let child = null;
  return createFusionCallbackServer(token)
    .then((createdCallback) => {
      callback = createdCallback;
      child = spawn(process.execPath, [adapterPath], {
        cwd: tempDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          VIBE_FUSION_CODEX_BIN: process.execPath,
          VIBE_TERMINAL_FUSION_CWD: tempDir,
          VIBE_TERMINAL_SESSION_ID: sessionId,
          VIBE_TERMINAL_CALLBACK_URL: callback.callbackUrl,
          VIBE_TERMINAL_TELEMETRY_TOKEN: token
        }
      });
      return waitForCondition(() => callback.getControlUrl(), 5000, "adapter control url");
    })
    .then((controlUrl) =>
      postJson(`${controlUrl}/steer`, token, {
        sessionId,
        text: "dead window steer"
      })
    )
    .then((result) => {
      assert(
        result.status === "skipped" && result.reason === "no_active_turn",
        `dead-window steer should skip without buffering: ${JSON.stringify(result)}`
      );
    })
    .finally(() => {
      if (callback && callback.server) {
        try {
          callback.server.close();
        } catch {
          // ignore
        }
      }
      if (child) {
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
            execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
          } catch {
            // best-effort
          }
        }
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function assertAdapterRunsHostFree() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-hostfree-"));
  writeFakeAppServer(tempDir);
  const env = {
    ...process.env,
    VIBE_FUSION_CODEX_BIN: process.execPath,
    VIBE_TERMINAL_FUSION_CWD: tempDir
  };
  // The three documented host-coupling vars (and the legacy WS hint) must be
  // absent so this proves the adapter never *requires* the Electron host.
  delete env.VIBE_TERMINAL_CALLBACK_URL;
  delete env.VIBE_TERMINAL_TELEMETRY_TOKEN;
  delete env.VIBE_TERMINAL_SESSION_ID;
  delete env.VIBE_TERMINAL_FUSION_WS;

  const child = spawn(process.execPath, [adapterPath], {
    cwd: tempDir,
    stdio: ["pipe", "pipe", "pipe"],
    env
  });

  const responses = new Map();
  let buffer = "";
  let stderr = "";

  function cleanup() {
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for host-free round-trip; stderr=${stderr}`));
    }, 10000);

    child.on("error", (error) => {
      clearTimeout(timer);
      cleanup();
      reject(error);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("exit", (code) => {
      if (responses.has(3)) return;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`adapter exited before host-free round-trip: code=${code}; stderr=${stderr}`));
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (responses.has(1) && responses.has(2) && responses.has(3)) {
          clearTimeout(timer);
          try {
            const init = responses.get(1);
            assert(
              init.result && init.result.serverInfo && init.result.serverInfo.name === "fusion-codex",
              `host-free initialize did not identify the adapter: ${JSON.stringify(init)}`
            );
            const tools = responses.get(2).result && responses.get(2).result.tools ? responses.get(2).result.tools : [];
            const names = tools.map((t) => t.name);
            for (const tool of ["codex_goal_set", "codex_goal_get", "codex_goal_clear", "codex_investigate", "codex_implement", "codex_watch_build", "codex_respond", "codex_steer_resolve", "codex_cancel"]) {
              assert(names.includes(tool), `host-free tools/list missing ${tool}`);
            }
            const callText = responses.get(3).result.content[0].text;
            const parsed = JSON.parse(callText);
            assert(parsed.status === "cancelled", `host-free tools/call round-trip should succeed: ${callText}`);
            cleanup();
            resolve();
          } catch (error) {
            cleanup();
            reject(error);
          }
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fusion-adapter-hostfree", version: "0.0.0" }
        }
      })}\n`
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "codex_cancel", arguments: {} }
      })}\n`
    );
  });
}

// Pin the portability boundary at the source level: the adapter's coupling to the
// Electron host must stay limited to the three documented env vars, each guarded so
// the relay/control surface no-ops when they are unset. Deleting a guard (which
// would silently re-couple the adapter to the host) fails CI here.
function assertPortabilityGuards() {
  const source = fs.readFileSync(adapterPath, "utf8");
  assert(
    source.includes("process.env.VIBE_TERMINAL_CALLBACK_URL") &&
      source.includes("process.env.VIBE_TERMINAL_TELEMETRY_TOKEN") &&
      source.includes("process.env.VIBE_TERMINAL_SESSION_ID"),
    "adapter host coupling must stay limited to the three documented env vars"
  );
  assert(
    source.includes("if (!CALLBACK_URL || !TOKEN || !SESSION_ID) return"),
    "postTelemetry must no-op when host telemetry env vars are unset"
  );
  assert(
    source.includes("if (controlServer || !TOKEN || !SESSION_ID) return"),
    "startControlServer must not bind when host control env vars are unset"
  );
}

function assertGoalSchema() {
  const rootDir = path.join(__dirname, "..", "..");
  const clientSchema = fs.readFileSync(
    path.join(rootDir, "vendor", "codex-appserver", "0.142.3", "schema", "ClientRequest.json"),
    "utf8"
  );
  const serverSchema = fs.readFileSync(
    path.join(rootDir, "vendor", "codex-appserver", "0.142.3", "schema", "ServerNotification.json"),
    "utf8"
  );
  for (const method of ["thread/goal/set", "thread/goal/get", "thread/goal/clear"]) {
    assert(clientSchema.includes(method), `generated client schema missing ${method}`);
  }
  assert(serverSchema.includes("thread/goal/updated"), "generated server schema missing goal update notification");
  assert(serverSchema.includes("thread/goal/cleared"), "generated server schema missing goal clear notification");
}

function assertVerifierHelpers() {
  const investigation = buildCodexInvestigationTask("find relevant files");
  assert(investigation.includes("read-only scouting pass"), "investigation task should be read-only");
  assert(investigation.includes("Findings"), "investigation task should request findings");
  assert(!investigation.includes(VERDICT_MARKER), "investigation task should not use verifier verdicts");

  const wrapped = buildCodexVerifierTask("implement the thing");
  assert(wrapped.includes(VERDICT_MARKER), "wrapped task missing verdict marker");
  assert(wrapped.includes("goalReached"), "wrapped task missing goalReached schema");
  assert(
    wrapped.includes("follow that guidance while still independently checking"),
    "wrapped task missing Claude-guides-Codex rule"
  );
  assert(
    wrapped.includes("picture/image generation") &&
      wrapped.includes("browser navigation/control/automation"),
    "wrapped task should tell Codex it owns image generation and browser control"
  );
  assert(
    wrapped.includes("When the delegated outcome is visual") &&
      wrapped.includes("VIEW that image with your image-viewing tool") &&
      wrapped.includes("never describe an image you did not actually view"),
    "wrapped task must mandate rendering + actually viewing visual outcomes, not code-read verification"
  );
  assert(
    wrapped.includes("one milestone of a larger plan") &&
      wrapped.includes("judge `goalReached` against the LARGER goal"),
    "wrapped task missing the milestone goalReached clause (mid-plan verdicts must stay continue)"
  );
  assert(
    wrapped.includes("switch families mid-thread"),
    "wrapped task missing the mid-thread engine/model identity clause"
  );
  assert(
    wrapped.includes("Never fabricate, approximate, or reconstruct command or test output"),
    "wrapped task missing the anti-simulation command/test output clause"
  );
  assert(
    wrapped.includes("Preflight named capabilities before building work on top of them") &&
      wrapped.includes('Set `nextAction:"ask_human"` when fixing it needs the user'),
    "wrapped task missing the capability preflight / connect-escalation clause"
  );

  const summary =
    "Implemented and tested.\n" +
    `${VERDICT_MARKER} {"goalReached":false,"bugsFound":["button overflows"],"missingRequirements":["mobile layout"],"nextAction":"continue","summary":"Not done yet."}`;
  const verdict = extractVerifierVerdict(summary);
  assert(verdict.goalReached === false, "verdict goalReached should parse false");
  assert(verdict.nextAction === "continue", "verdict nextAction should parse continue");
  assert(verdict.bugsFound[0] === "button overflows", "verdict bugs should parse");
  assert(verdict.missingRequirements[0] === "mobile layout", "verdict requirements should parse");
  assert(
    stripVerifierVerdictFromSummary(summary) === "Implemented and tested.",
    "verdict marker should be stripped from display summary"
  );

  const doneVerdict = extractVerifierVerdict(
    `${VERDICT_MARKER} {"goalReached":true,"bugsFound":[],"missingRequirements":[],"nextAction":"done","summary":"Complete."}`
  );
  assert(doneVerdict.goalReached === true, "done verdict should parse goalReached true");
  assert(doneVerdict.nextAction === "done", "done verdict should parse nextAction done");

  const contradictory = extractVerifierVerdict(
    `${VERDICT_MARKER} {"goalReached":true,"bugsFound":["regression remains"],"missingRequirements":["tests not run"],"nextAction":"done","summary":"Complete."}`
  );
  assert(contradictory.goalReached === false, "blockers should force goalReached false");
  assert(contradictory.nextAction === "continue", "blockers should force continue");
  assert(contradictory.bugsFound[0] === "regression remains", "blocker bug should remain visible");

  const missing = extractVerifierVerdict("No marker here.");
  assert(missing.goalReached === false, "missing verdict should fail closed");
  assert(missing.nextAction === "continue", "missing verdict should force continue");
  assert(missing.verdictSource === "missing", "missing verdict should report source");

  const malformed = extractVerifierVerdict(`${VERDICT_MARKER} {"goalReached":`);
  assert(malformed.goalReached === false, "malformed verdict should fail closed");
  assert(malformed.verdictSource === "malformed", "malformed verdict should report source");

  assert(normalizeGoalStatus("complete") === "complete", "valid goal status should pass through");
  assert(normalizeGoalStatus("bogus") === "active", "invalid goal status should fall back to active");
  const normalizedGoal = normalizeGoal({
    threadId: "thread-1",
    objective: "ship it",
    status: "paused",
    tokenBudget: 100,
    tokensUsed: 7,
    timeUsedSeconds: 3,
    createdAt: 1,
    updatedAt: 2
  });
  assert(normalizedGoal.status === "paused", "goal status should normalize");
  assert(normalizedGoal.tokensUsed === 7, "goal usage should normalize");
  assert(goalStatusForVerdict(doneVerdict) === "complete", "done verdict should complete native goal");
  assert(goalStatusForVerdict(verdict) === null, "continue verdict should not overwrite native goal");
  assert(
    goalStatusForVerdict({ goalReached: false, nextAction: "ask_human" }) === null,
    "ask_human verdict should not overwrite native goal"
  );
  assert(shouldReplaceGoalForTask(null), "missing goal should create fallback goal");
  assert(
    shouldReplaceGoalForTask({ status: "complete" }),
    "complete goal should be replaced for fallback work"
  );
  assert(
    !shouldReplaceGoalForTask({ status: "active" }),
    "active goal should not be replaced for fallback work"
  );
  assert(
    shouldAutoSyncGoalStatus({ status: "active" }, "complete"),
    "active goal should sync to complete"
  );
  assert(
    !shouldAutoSyncGoalStatus({ status: "budgetLimited" }, "complete"),
    "budget-limited goal should not be auto-overwritten"
  );
  assert(
    !shouldAutoSyncGoalStatus({ status: "usageLimited" }, "complete"),
    "usage-limited goal should not be auto-overwritten"
  );
  assert(
    !shouldAutoSyncGoalStatus({ status: "blocked" }, "complete"),
    "blocked goal should not be auto-overwritten"
  );
  assert(
    turnErrorMessage({
      error: {
        message: "Network failed.",
        additionalDetails: "Retry later."
      }
    }) === "Network failed. Retry later.",
    "turnErrorMessage should preserve server failure details"
  );
  assert(
    turnErrorMessage({ error: null }, "fallback") === "fallback",
    "turnErrorMessage should fall back when the turn has no error payload"
  );
  const codeDump =
    "Writing generated code to frontend/src/components/Header.tsx\n" +
    "```tsx\n" +
    "import { Logo } from './Logo';\n" +
    Array.from({ length: 90 }, (_, index) => `export const Row${index} = () => <div className="row-${index}" />;`).join("\n") +
    "\n```";
  assert(
    summarizeAgentMessageForDisplay(codeDump) === "writing frontend/src/components/Header.tsx",
    "large code-like agent messages should summarize to the target file"
  );
  assert(
    summarizeAgentMessageForDisplay("Short status update.") === "Short status update.",
    "short agent messages should pass through"
  );
}

function assertWorkspaceMcpConfigOverrides() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-mcp-config-"));
  try {
    fs.writeFileSync(
      path.join(tempDir, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            docs: {
              command: "node",
              args: ["server.js", "--stdio"],
              env: { API_KEY: "test", PORT: 1234 },
              disabled: false,
              startup_timeout_sec: 3
            },
            "http.server": {
              url: "https://example.test/mcp",
              headers: { Authorization: "Bearer test" },
              env_http_headers: { "X-Api-Key": "API_KEY_ENV" },
              enabled: true
            },
            invalid: {
              args: ["missing-command-or-url"]
            }
          }
        },
        null,
        2
      )}\n`
    );
    const overrides = workspaceMcpConfigOverrides(tempDir);
    assert(
      codexMcpServerConfigKey("docs") === "mcp_servers.docs",
      "plain MCP server names should use a dotted config key"
    );
    assert(
      codexMcpServerConfigKey("http.server") === 'mcp_servers."http.server"',
      "MCP server names containing dots should be TOML-quoted in dotted config keys"
    );
    assert(
      overrides["mcp_servers.docs"]?.command === "node" &&
        overrides["mcp_servers.docs"]?.args?.[1] === "--stdio" &&
        overrides["mcp_servers.docs"]?.env?.PORT === "1234" &&
        overrides["mcp_servers.docs"]?.enabled === true &&
        overrides["mcp_servers.docs"]?.startup_timeout_sec === 3,
      `stdio MCP server should translate into Codex mcp_servers override shape: ${JSON.stringify(overrides)}`
    );
    assert(
      overrides['mcp_servers."http.server"']?.url === "https://example.test/mcp" &&
        overrides['mcp_servers."http.server"']?.http_headers?.Authorization === "Bearer test" &&
        overrides['mcp_servers."http.server"']?.env_http_headers?.["X-Api-Key"] === "API_KEY_ENV",
      `HTTP MCP server should translate headers into Codex mcp_servers override shape: ${JSON.stringify(overrides)}`
    );
    assert(
      !Object.prototype.hasOwnProperty.call(overrides, "mcp_servers.invalid"),
      `invalid MCP server entries should be skipped instead of breaking thread/start: ${JSON.stringify(overrides)}`
    );
    assert(
      translateWorkspaceMcpServerConfig({ command: "node", url: "https://bad.example" })?.command === "node",
      "stdio MCP translation should prefer command and drop incompatible HTTP fields"
    );
    assert(
      Object.keys(workspaceMcpConfigOverrides(path.join(tempDir, "missing"))).length === 0,
      "missing workspace .mcp.json should produce no overrides"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertCommandDisplayHelpers() {
  const wrappedPwsh =
    `"C:\\Users\\ahmed\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -Command "rg -n \\"skill|mcp\\" ."`;
  assert(
    commandExecutionDisplayText({
      type: "commandExecution",
      command: wrappedPwsh,
      commandActions: [{ command: 'rg -n "skill|mcp" .' }]
    }) === 'rg -n "skill|mcp" .',
    "commandActions should provide the clean command display"
  );
  assert(
    displayCommandFromItem({
      type: "commandExecution",
      command: "ignored raw command",
      command_actions: [{ command: "  ls -la  " }, { command: "rg TODO ." }]
    }) === "ls -la ; rg TODO .",
    "snake_case command_actions should join clean action commands"
  );
  assert(
    commandExecutionDisplayText({
      type: "commandExecution",
      command: 'pwsh -Command "git status --short"'
    }) === "git status --short",
    "pwsh -Command wrapper should unwrap to the inner command"
  );
  assert(
    commandExecutionDisplayText({
      type: "commandExecution",
      command: 'bash -lc "npm run build"'
    }) === "npm run build",
    "bash -lc wrapper should unwrap to the inner command"
  );
  assert(
    summarizeCommandExecution({
      type: "commandExecution",
      command: 'Set-Content foo.txt -Value "hello"',
      commandActions: [{ command: "ignored clean command" }]
    }) === "write foo.txt",
    "content-write detection should still use the raw command before display cleanup"
  );
  assert(
    commandExecutionDisplayText({
      type: "commandExecution",
      command: "git log --oneline -5"
    }) === "git log --oneline -5",
    "plain commands without a shell wrapper should pass through unchanged"
  );
  assert(
    unwrapShellCommand('cmd.exe /c "dir /b"') === "dir /b",
    "cmd.exe /c wrapper should unwrap to the inner command"
  );
}

// ---- per-family executor settings + claude engine coverage ----

// readCodexSettings captures VIBE_FUSION_CODEX_SETTINGS at module load, so
// each parse case runs in a fresh node child with the env set before require.
function readSettingsInChild(settingsFile) {
  const out = execFileSync(
    process.execPath,
    ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(adapterPath)}).readCodexSettings()))`],
    { env: { ...process.env, VIBE_FUSION_CODEX_SETTINGS: settingsFile } }
  );
  return JSON.parse(out.toString("utf8"));
}

function assertExecutorSettingsParsing() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-settings-"));
  try {
    const file = path.join(tempDir, "fusion-settings.json");

    fs.writeFileSync(file, JSON.stringify({ executorFamily: "claude", executorModel: "fast", executorEffort: "ultra", executorFast: true }));
    let parsed = readSettingsInChild(file);
    assert(parsed.family === "claude", `family should parse claude: ${JSON.stringify(parsed)}`);
    assert(parsed.model === "sonnet", `claude "fast" should coerce to sonnet: ${JSON.stringify(parsed)}`);
    assert(parsed.effort === "max", `claude effort ultra should coerce to max: ${JSON.stringify(parsed)}`);
    assert(parsed.fast === true, `executorFast true should parse: ${JSON.stringify(parsed)}`);

    fs.writeFileSync(file, JSON.stringify({ executorFamily: "claude", executorEffort: "minimal" }));
    parsed = readSettingsInChild(file);
    assert(parsed.model === "sonnet", `claude executor should default to sonnet: ${JSON.stringify(parsed)}`);
    assert(parsed.effort === "low", `claude effort minimal should coerce to low: ${JSON.stringify(parsed)}`);
    assert(parsed.fast === false, `missing executorFast should default false: ${JSON.stringify(parsed)}`);

    // Legacy pre-family file: codexModel/codexEffort only.
    fs.writeFileSync(file, JSON.stringify({ codexModel: "gpt-5.5", codexEffort: "max", executorFast: true }));
    parsed = readSettingsInChild(file);
    assert(parsed.family === "codex", `legacy file should stay codex: ${JSON.stringify(parsed)}`);
    assert(parsed.model === "gpt-5.5", `legacy codexModel should parse: ${JSON.stringify(parsed)}`);
    assert(parsed.effort === "xhigh", `legacy codex max should self-heal to xhigh: ${JSON.stringify(parsed)}`);
    assert(parsed.fast === true, `codex executorFast should parse: ${JSON.stringify(parsed)}`);

    fs.writeFileSync(file, JSON.stringify({ executorFamily: "codex", executorModel: "auto", executorEffort: "" }));
    parsed = readSettingsInChild(file);
    assert(parsed.model === null, `codex auto model should clear to null: ${JSON.stringify(parsed)}`);

    // In-process helper coverage (env-independent).
    assert(cleanClaudeEffort("ultra") === "max", "cleanClaudeEffort should coerce ultra to max");
    assert(cleanClaudeEffort("minimal") === "low", "cleanClaudeEffort should coerce minimal to low");
    assert(cleanClaudeEffort("auto") === null, "cleanClaudeEffort should treat auto as unset");
    assert(cleanClaudeEffort("bogus") === null, "cleanClaudeEffort should drop unknown levels");
    assert(FAST_SERVICE_TIER === "priority", "Codex Fast service tier request value must be priority");
    assert(
      fastTierForModel(
        [{ id: "gpt-fast", serviceTiers: [{ id: "priority", name: "Fast" }] }],
        "gpt-fast"
      ) === "priority",
      "fastTierForModel should return priority for a model that advertises it"
    );
    assert(
      fastTierForModel([{ id: "gpt-standard", serviceTiers: [] }], "gpt-standard") === null,
      "fastTierForModel should leave standard serving when the model does not advertise priority"
    );
    assert(
      fastTierForModel(null, "custom-model") === "priority",
      "unknown catalog should fall back to app-server service-tier validation"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertClaudeExecutorArgs() {
  const defaults = buildClaudeExecutorArgs({});
  const flag = (args, name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const defaultSettingsFile = flag(defaults, "--settings");
  assert(
    flag(defaults, "--permission-mode") === "bypassPermissions",
    `claude executor must run bypassPermissions (codex dangerFullAccess parity): ${defaults.join(" ")}`
  );
  assert(flag(defaults, "--model") === "sonnet", `claude executor default model should be sonnet: ${defaults.join(" ")}`);
  assert(!defaults.includes("--effort"), `unset effort should omit the flag: ${defaults.join(" ")}`);
  assert(defaultSettingsFile && fs.existsSync(defaultSettingsFile), `unset fast should pass a Claude settings file: ${defaults.join(" ")}`);
  assert(
    JSON.parse(fs.readFileSync(defaultSettingsFile, "utf8")).fastMode === false,
    `unset fast should explicitly disable Claude fastMode: ${defaults.join(" ")}`
  );
  assert(defaults.includes("--input-format"), "claude executor must speak stream-json");
  const custom = buildClaudeExecutorArgs({ model: "opus", effort: "high", fast: true });
  const customSettingsFile = flag(custom, "--settings");
  assert(flag(custom, "--model") === "opus", `custom model should pass through: ${custom.join(" ")}`);
  assert(flag(custom, "--effort") === "high", `custom effort should pass through: ${custom.join(" ")}`);
  assert(customSettingsFile && fs.existsSync(customSettingsFile), `executorFast should pass a Claude settings file: ${custom.join(" ")}`);
  assert(
    JSON.parse(fs.readFileSync(customSettingsFile, "utf8")).fastMode === true,
    `executorFast should pass Claude fastMode: ${custom.join(" ")}`
  );
}

// A fake claude CLI: consumes one stream-json user message, replays assistant
// narration + Bash + MultiEdit progress, streams a final verdict, then
// emits the result line. Records its argv so the cmd.exe quoting path is
// asserted end-to-end.
function writeFakeClaudeExecutor(dir) {
  const scriptPath = path.join(dir, "fake-claude.js");
  fs.writeFileSync(
    scriptPath,
    `
const fs = require("fs");
const path = require("path");
fs.writeFileSync(path.join(__dirname, "claude-argv.txt"), process.argv.slice(2).join("\\n"));
const controlFile = path.join(__dirname, "claude-control.jsonl");
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function ev(event) { send({ type: "stream_event", event }); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "control_request") {
    fs.appendFileSync(controlFile, JSON.stringify(msg) + "\\n");
    return;
  }
  if (msg.type !== "user") return;
  send({ type: "system", subtype: "init", session_id: "fake-claude-exec" });
  ev({ type: "message_start" });
  ev({ type: "content_block_start", content_block: { type: "text" } });
  ev({ type: "content_block_delta", delta: { type: "text_delta", text: "I will inspect the failure and update the file." } });
  ev({ type: "content_block_stop" });
  ev({ type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Bash" } });
  ev({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "echo hi" }) } });
  ev({ type: "content_block_stop" });
  ev({ type: "content_block_start", content_block: { type: "tool_use", id: "t2", name: "MultiEdit" } });
  ev({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: "src/app.ts" }) } });
  ev({ type: "content_block_stop" });
  ev({ type: "content_block_start", content_block: { type: "text" } });
  ev({ type: "content_block_delta", delta: { type: "text_delta", text: "Implemented via fake claude executor.\\n${VERDICT_MARKER} {\\"goalReached\\":true,\\"bugsFound\\":[],\\"missingRequirements\\":[],\\"nextAction\\":\\"done\\",\\"summary\\":\\"Fake done.\\"}" } });
  ev({ type: "content_block_stop" });
  ev({ type: "message_stop" });
  send({ type: "result", subtype: "success", is_error: false });
});
`
  );
  if (isWin) {
    const cmdPath = path.join(dir, "fake-claude.cmd");
    fs.writeFileSync(cmdPath, `@"${process.execPath}" "%~dp0fake-claude.js" %*\r\n`);
    return cmdPath;
  }
  const shPath = path.join(dir, "fake-claude");
  fs.writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
  fs.chmodSync(shPath, 0o755);
  return shPath;
}

// Behavioral: executorFamily "claude" routes codex_implement through the
// claude engine (fake app-server untouched), the local goal store fills the
// native-goal contract, and flipping the settings file to codex re-routes the
// NEXT call to the app-server engine.
function callAdapterImplementWithFakeClaudeExecutor() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-claude-exec-"));
  const markerFile = path.join(tempDir, "thread-started.txt");
  writeFakeAppServer(tempDir, { markerFile });
  const fakeClaudeBin = writeFakeClaudeExecutor(tempDir);
  const settingsFile = path.join(tempDir, "fusion-settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ executorFamily: "claude", executorModel: "sonnet", executorFast: true }));
  const token = `claude-exec-token-${Date.now()}-${Math.random()}`;
  let callback = null;
  let child = null;
  const responses = new Map();
  let buffer = "";
  let stderr = "";
  let finished = false;

  function cleanup() {
    if (callback && callback.server) {
      try {
        callback.server.close();
      } catch {
        // ignore
      }
    }
    if (child) {
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
          execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        } catch {
          // best-effort
        }
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return createFusionCallbackServer(token).then((createdCallback) => new Promise((resolve, reject) => {
    callback = createdCallback;
    child = spawn(process.execPath, [adapterPath], {
      cwd: tempDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        VIBE_FUSION_CODEX_BIN: process.execPath,
        VIBE_FUSION_CLAUDE_BIN: fakeClaudeBin,
        VIBE_TERMINAL_FUSION_CWD: tempDir,
        VIBE_TERMINAL_SESSION_ID: "fusion-adapter-claude-exec",
        VIBE_TERMINAL_CALLBACK_URL: callback.callbackUrl,
        VIBE_TERMINAL_TELEMETRY_TOKEN: token,
        VIBE_FUSION_CODEX_SETTINGS: settingsFile,
        VIBE_FUSION_TURN_IDLE_TIMEOUT_MS: "8000"
      }
    });
    const timer = setTimeout(() => {
      finished = true;
      cleanup();
      reject(new Error(`timed out waiting for claude executor result; stderr=${stderr}`));
    }, 20000);

    function fail(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    }

    child.on("error", fail);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      if (finished) return;
      fail(new Error(`adapter exited before claude executor result: code=${code}; stderr=${stderr}`));
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined || !msg.result || !msg.result.content) continue;
        responses.set(msg.id, msg);
        try {
          if (msg.id === 2) {
            const text = msg.result.content[0].text;
            const parsed = JSON.parse(text);
            assert(parsed.status === "completed", `claude executor implement should complete: ${text}`);
            assert(parsed.goalReached === true, `claude executor verdict should parse: ${text}`);
            assert(
              /Implemented via fake claude executor/.test(parsed.summary || "") &&
                !(parsed.summary || "").includes(VERDICT_MARKER),
              `claude executor summary should keep assistant text but strip the verdict: ${text}`
            );
            assert(
              Array.isArray(parsed.files) && parsed.files.includes("src/app.ts"),
              `claude executor should record Edit file paths: ${text}`
            );
            assert(
              !fs.existsSync(markerFile),
              "claude-family implement must not boot the codex app-server"
            );
            const argvFile = path.join(tempDir, "claude-argv.txt");
            assert(fs.existsSync(argvFile), "fake claude executor argv record missing");
            const argv = fs.readFileSync(argvFile, "utf8");
            assert(
              argv.includes("bypassPermissions") && argv.includes("sonnet"),
              `claude executor argv should carry bypassPermissions + model: ${argv}`
            );
            assert(
              argv.includes("--settings"),
              `claude executor argv should carry startup fastMode settings file: ${argv}`
            );
            const argvLines = argv.split(/\r?\n/).filter(Boolean);
            const settingsArg = argvLines[argvLines.indexOf("--settings") + 1];
            assert(settingsArg && fs.existsSync(settingsArg), `claude executor settings file should exist: ${argv}`);
            assert(
              JSON.parse(fs.readFileSync(settingsArg, "utf8")).fastMode === true,
              `claude executor settings file should carry startup fastMode=true: ${settingsArg}`
            );
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "codex_goal_get", arguments: {} } })}\n`
            );
          } else if (msg.id === 3) {
            const text = msg.result.content[0].text;
            const parsed = JSON.parse(text);
            assert(parsed.status === "ok", `local goal store should answer goal_get: ${text}`);
            assert(
              parsed.goal && parsed.goal.threadId === "claude-executor",
              `claude executor goal should come from the local store: ${text}`
            );
            assert(
              parsed.goal.status === "complete",
              `done verdict should have synced the local goal to complete: ${text}`
            );
            fs.writeFileSync(settingsFile, JSON.stringify({ executorFamily: "claude", executorModel: "sonnet", executorFast: false }));
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "codex_implement", arguments: { task: "second fake claude pass" } } })}\n`
            );
          } else if (msg.id === 4) {
            const text = msg.result.content[0].text;
            const parsed = JSON.parse(text);
            assert(parsed.status === "completed", `second claude executor implement should complete: ${text}`);
            const controlFile = path.join(tempDir, "claude-control.jsonl");
            assert(fs.existsSync(controlFile), "fast-only Claude executor change should send a live control request");
            const controls = fs
              .readFileSync(controlFile, "utf8")
              .split(/\r?\n/)
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            assert(
              controls.some(
                (control) =>
                  control.request?.subtype === "apply_flag_settings" &&
                  control.request?.settings?.fastMode === false
              ),
              `fast-only Claude executor change should apply fastMode=false live: ${JSON.stringify(controls)}`
            );
            child.stdin.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "codex_implement", arguments: { task: "background fake claude pass", background: true } } })}\n`
            );
          } else if (msg.id === 5) {
            const text = msg.result.content[0].text;
            const parsed = JSON.parse(text);
            assert(parsed.status === "started", `background claude executor should detach: ${text}`);
            waitForCondition(() => {
              const backgroundEvents = callback.getEvents().filter(
                (event) => event.type === "fusion.background-task"
              );
              const progressKinds = backgroundEvents
                .filter((event) => event.phase === "progress")
                .map((event) => event.activityKind);
              return (
                progressKinds.includes("message") &&
                progressKinds.includes("command") &&
                progressKinds.includes("file") &&
                backgroundEvents.some((event) => event.phase === "settled")
              )
                ? backgroundEvents
                : null;
            }, 5000, "claude background executor progress telemetry")
              .then((backgroundEvents) => {
                assert(
                  backgroundEvents.some(
                    (event) =>
                      event.phase === "progress" &&
                      event.activityKind === "message" &&
                      /inspect the failure and update the file/.test(event.text || "")
                  ),
                  `background claude executor should relay assistant narration as message progress: ${JSON.stringify(backgroundEvents)}`
                );
                assert(
                  backgroundEvents.some(
                    (event) =>
                      event.phase === "progress" &&
                      event.activityKind === "command" &&
                      /echo hi/.test(event.text || "")
                  ),
                  `background claude executor should relay Bash as command progress: ${JSON.stringify(backgroundEvents)}`
                );
                assert(
                  backgroundEvents.some(
                    (event) =>
                      event.phase === "progress" &&
                      event.activityKind === "file" &&
                      /src\/app\.ts/.test(event.text || "")
                  ),
                  `background claude executor should relay MultiEdit as file progress: ${JSON.stringify(backgroundEvents)}`
                );
                // Flip the settings file to codex: the NEXT call must re-route to
                // the app-server engine (fake app-server boots, thread marker).
                fs.writeFileSync(settingsFile, JSON.stringify({ executorFamily: "codex" }));
                child.stdin.write(
                  `${JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "codex_goal_get", arguments: {} } })}\n`
                );
              })
              .catch(fail);
          } else if (msg.id === 6) {
            const text = msg.result.content[0].text;
            const parsed = JSON.parse(text);
            assert(parsed.status === "ok", `codex goal_get after family flip should succeed: ${text}`);
            assert(parsed.goal === null, `family flip should reset the goal store: ${text}`);
            assert(
              fs.existsSync(markerFile),
              "family flip to codex should boot the app-server engine"
            );
            waitForCondition(() => {
              const activities = callback.getEvents().filter(
                (event) => event.type === "fusion.activity" && event.role === "codex"
              );
              const byKind = new Map(activities.map((event) => [event.kind, event.text || ""]));
              return byKind.has("message") && byKind.has("command") && byKind.has("file")
                ? activities
                : null;
            }, 5000, "claude executor progress telemetry")
              .then((activities) => {
                assert(
                  activities.some(
                    (event) =>
                      event.kind === "message" &&
                      /inspect the failure and update the file/.test(event.text || "")
                  ),
                  `claude executor should relay assistant narration as message progress: ${JSON.stringify(activities)}`
                );
                assert(
                  activities.some((event) => event.kind === "command" && /echo hi/.test(event.text || "")),
                  `claude executor should relay Bash as command progress: ${JSON.stringify(activities)}`
                );
                assert(
                  activities.some((event) => event.kind === "file" && /src\/app\.ts/.test(event.text || "")),
                  `claude executor should relay MultiEdit as file progress: ${JSON.stringify(activities)}`
                );
                finished = true;
                clearTimeout(timer);
                cleanup();
                resolve();
              })
              .catch(fail);
          }
        } catch (error) {
          fail(error);
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fusion-adapter-claude-exec", version: "0.0.0" }
        }
      })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "codex_implement", arguments: { task: "do executor work" } }
      })}\n`
    );
  }));
}

// ---- parallel fan-out coverage ----

function assertFanoutHelpers() {
  // Input normalization: single task, batch, caps, and mutual exclusion.
  assert(normalizeFanoutTasks("do it").task === "do it", "single task should pass through");
  assert(
    normalizeFanoutTasks("", ["only one"]).task === "only one",
    "a one-entry tasks array should collapse to the single-task path"
  );
  assert(
    Array.isArray(normalizeFanoutTasks("", ["a", "b"]).tasks),
    "a two-entry tasks array should select the fan-out path"
  );
  assert(
    /at most 4/.test(normalizeFanoutTasks("", ["a", "b", "c", "d", "e"]).error || ""),
    "more than FANOUT_MAX_TASKS entries must error asking to consolidate"
  );
  assert(FANOUT_MAX_TASKS === 4, "fan-out cap should stay at 4 parallel tasks");
  assert(
    /not both/.test(normalizeFanoutTasks("x", ["a", "b"]).error || ""),
    "task alongside tasks must be rejected"
  );
  assert(
    /required/.test(normalizeFanoutTasks("", []).error || "") ||
      /non-empty/.test(normalizeFanoutTasks("", []).error || ""),
    "an empty tasks array must be rejected"
  );

  // Worker task wrappers carry the parallel-scope contract.
  const scoutTask = buildFanoutScoutTask("map the backend", 0, 3);
  assert(
    scoutTask.includes(buildCodexInvestigationTask("map the backend")) &&
      /Parallel scout 1 of 3/.test(scoutTask) &&
      /No mid-turn questions/.test(scoutTask),
    "scout wrapper must keep the investigation contract and add the parallel-scope clause"
  );
  const workTask = buildFanoutWorkstreamTask("implement feature", 1, 2);
  assert(
    workTask.includes(buildCodexVerifierTask("implement feature")) &&
      /Parallel workstream 2 of 2/.test(workTask) &&
      /Touch ONLY the files/.test(workTask) &&
      /LARGER goal/.test(workTask) &&
      /missingRequirements/.test(workTask),
    "workstream wrapper must keep the verifier contract and add scope/goal/no-question clauses"
  );

  // Conflict detection: same path reported by two workers (case-insensitive,
  // separator-normalized on win32).
  const conflicts = fanoutFileConflicts([
    { files: ["src/a.js", "src/shared.js"] },
    { files: ["src/b.js", isWin ? "src\\SHARED.js" : "src/shared.js"] }
  ]);
  assert(
    conflicts.length === 1 && /shared\.js$/i.test(conflicts[0]),
    `overlapping worker files must surface as fileConflicts: ${JSON.stringify(conflicts)}`
  );
  assert(
    fanoutFileConflicts([{ files: ["src/a.js", "src/a.js"] }, { files: ["src/b.js"] }]).length === 0,
    "a single worker repeating its own file is not a conflict"
  );

  // Combined investigate result: per-scout sections + files union.
  const scoutCombined = combineFanoutResults("investigate", ["q1", "q2"], [
    { status: "completed", findings: "found one", files: ["a.js"] },
    { status: "failed", error: "boom" }
  ]);
  assert(scoutCombined.status === "completed", "scout aggregate always completes");
  assert(
    scoutCombined.scouts.length === 2 &&
      scoutCombined.scouts[1].findings.includes("boom") &&
      /Scout 1\/2/.test(scoutCombined.findings) &&
      /Scout 2\/2/.test(scoutCombined.findings) &&
      scoutCombined.files.includes("a.js"),
    `scout aggregate must carry per-scout sections and the files union: ${JSON.stringify(scoutCombined)}`
  );

  // Combined implement result: per-worker verdicts, conflicts, aggregate gates.
  const implCombined = combineFanoutResults("implement", ["w1", "w2"], [
    {
      status: "completed",
      summary: "did w1",
      files: ["src/a.js", "src/shared.js"],
      goalReached: true,
      bugsFound: [],
      missingRequirements: [],
      nextAction: "done",
      verifierVerdict: { goalReached: true, nextAction: "done" }
    },
    {
      status: "completed",
      summary: "did w2",
      files: ["src/b.js", "src/shared.js"],
      goalReached: true,
      bugsFound: ["off-by-one"],
      missingRequirements: [],
      nextAction: "done",
      verifierVerdict: { goalReached: true, nextAction: "done" }
    }
  ]);
  assert(
    implCombined.workers.length === 2 &&
      implCombined.fileConflicts &&
      implCombined.fileConflicts.includes("src/shared.js") &&
      implCombined.goalReached === false &&
      implCombined.nextAction === "continue" &&
      /overlapping files/i.test(implCombined.warning || "") &&
      implCombined.bugsFound.includes("off-by-one"),
    `file conflicts must gate the aggregate to continue: ${JSON.stringify(implCombined)}`
  );
  const cleanCombined = combineFanoutResults("implement", ["w1", "w2"], [
    {
      status: "completed",
      summary: "did w1",
      files: ["src/a.js"],
      goalReached: true,
      bugsFound: [],
      missingRequirements: [],
      nextAction: "done",
      verifierVerdict: {}
    },
    {
      status: "completed",
      summary: "did w2",
      files: ["src/b.js"],
      goalReached: false,
      bugsFound: [],
      missingRequirements: [],
      nextAction: "continue",
      verifierVerdict: {}
    }
  ]);
  assert(
    cleanCombined.goalReached === false && cleanCombined.nextAction === "continue",
    "a mid-plan workstream verdict must keep the aggregate on continue"
  );
  const askCombined = combineFanoutResults("implement", ["w1"], [
    {
      status: "completed",
      summary: "blocked",
      files: [],
      goalReached: false,
      bugsFound: [],
      missingRequirements: ["credentials"],
      nextAction: "ask_human",
      verifierVerdict: {}
    }
  ]);
  assert(askCombined.nextAction === "ask_human", "a worker's ask_human must surface on the aggregate");

  // Source anchors for the wiring that the fake-server scenarios cannot see.
  const source = fs.readFileSync(adapterPath, "utf8");
  assert(
    source.includes("const fanoutWorkers = new Map()") &&
      source.includes("function fanoutWorkerForParams") &&
      source.includes("handleFanoutNotification(fanoutWorker, method, params)"),
    "handleNotification must route fan-out worker events to worker-scoped state"
  );
  assert(
    source.includes("function resolveFanoutServerRequest") &&
      source.includes("FANOUT_QUESTION_ANSWER"),
    "fan-out server requests must be auto-resolved inline, never parked"
  );
  assert(
    (source.match(/abortFanoutWorkers\(/g) || []).length >= 4,
    "codexCancel/failAll/resetCodexProcessState must abort fan-out workers"
  );
  assert(
    source.includes('runClaudeFanoutSequential("investigate"') &&
      source.includes('runClaudeFanoutSequential("implement"') &&
      source.includes("parallel: false"),
    "the claude executor family must run batched tasks sequentially with the same combined shape"
  );
  assert(
    source.includes("const withGoal = currentGoal ? { ...result, goal: currentGoal } : result;"),
    "a fan-out implement result must never auto-sync the native goal"
  );
  const investigateTool = source.includes('"2-4 self-contained, non-overlapping scouting tasks');
  const implementTool = source.includes("ONLY for verified-disjoint work");
  assert(investigateTool && implementTool, "both bridge tools must document the tasks[] fan-out surface");

  // ---- main-thread turn discipline (the goal-turn completion-drop fix) ----
  assert(
    source.includes("function notificationThreadId") &&
      source.includes("sourceThreadId && sourceThreadId !== threadId") &&
      source.includes("resolving anyway") &&
      source.includes("if (nextTurnId && !activeTurnId) {") &&
      source.includes("south handler error"),
    "handleNotification must thread-filter child traffic, resolveCompletedTurn must resolve (log) on id mismatch, the turn/start response must not clobber a notification-set id, and handler throws must be logged"
  );

  // ---- detached background delegations ----
  assert(
    source.includes("const backgroundWorkers = new Map()") &&
      source.includes("function startBackgroundDelegation") &&
      source.includes("function finalizeBackgroundWorker") &&
      source.includes('type: "fusion.background-task"') &&
      source.includes("BACKGROUND_QUESTION_ANSWER") &&
      source.includes("function cancelBackgroundTask") &&
      source.includes('"/background-cancel"'),
    "the adapter must own the detached background worker engine (registry, telemetry relay, cancel surface)"
  );
  assert(
    source.includes("if (backgroundWorkers.has(candidate)) return backgroundWorkers.get(candidate);") &&
      source.includes("if (!worker.background) {"),
    "background workers must route like fan-out workers WITHOUT refreshing the foreground turn's idle timer"
  );
  assert(
    (source.match(/abortBackgroundWorkers\(/g) || []).length >= 4,
    "failAll/resetCodexProcessState/resetHarness must settle background workers (they never vanish silently)"
  );
  assert(
    source.includes('engines === "codex" && worker.child') &&
      source.includes('{ engines: "codex" }'),
    "a codex process failure must not kill claude-family background children"
  );
  assert(
    source.includes("background: {") &&
      source.includes("codex_cancel {taskId}") &&
      source.includes("if (taskId) {"),
    "codex_implement/codex_investigate must expose background:true and codex_cancel must take a scoped taskId"
  );
  assert(
    source.includes("const BACKGROUND_HARD_TIMEOUT_MS") &&
      source.includes("VIBE_FUSION_BACKGROUND_HARD_TIMEOUT_MS") &&
      source.includes("const BACKGROUND_IDLE_TIMEOUT_MS") &&
      source.includes("VIBE_FUSION_BACKGROUND_IDLE_TIMEOUT_MS") &&
      source.includes("idleTimeoutMs: BACKGROUND_IDLE_TIMEOUT_MS") &&
      source.includes("idleTimeoutMs: TURN_IDLE_TIMEOUT_MS") &&
      source.includes("}, BACKGROUND_HARD_TIMEOUT_MS);") &&
      !/Fusion background task exceeded the maximum duration\."\s*\}\);\s*\}, TURN_HARD_TIMEOUT_MS\);/.test(source),
    "background workers must use separate idle/hard timeouts without changing foreground/fan-out hard caps"
  );
  assert(
    source.includes("function interruptTimedOutBackgroundWorker") &&
      source.includes('rpc("turn/interrupt", { threadId: worker.threadId, turnId: worker.turnId })') &&
      source.includes("if (worker.background) interruptTimedOutBackgroundWorker(worker);") &&
      source.includes("// Codex-family background workers ride the shared app-server"),
    "background timeout paths must interrupt codex-family worker turns instead of only settling locally"
  );
  assert(
    source.includes('name: "codex_watch_build"') &&
      source.includes("async function codexWatchBuild(command, cwd)") &&
      source.includes('type: "fusion.build-task"') &&
      source.includes('phase: "started"') &&
      source.includes("detached: true") &&
      source.includes("watchedBuildRunnerSource") &&
      source.includes("child.unref()"),
    "codex_watch_build must launch a detached process and emit started build telemetry"
  );
  assert(
    source.includes('"/v:on"') &&
      source.includes("windowsVerbatimArguments: isWin") &&
      source.includes('"/bin/sh"') &&
      source.includes("writeSentinel(code)"),
    "codex_watch_build must write real exit-code sentinels on win32 and posix"
  );
  const planToolsBlock = source.match(/const PLAN_MODE_ALLOWED_TOOLS = new Set\(\[([\s\S]*?)\]\);/);
  assert(
    planToolsBlock && !planToolsBlock[1].includes("codex_watch_build"),
    "codex_watch_build must not be allowed in Fusion Plan mode"
  );
}

function loadAdapterInternalsWithFakeTimers(env = {}) {
  const adapterRequire = createRequire(adapterPath);
  const source = `${fs.readFileSync(adapterPath, "utf8")}\n
module.exports.__backgroundTimeoutTest = {
  createBackgroundWorker,
  refreshFanoutWorkerIdleTimer,
  finishFanoutWorkerTurn,
  interruptTimedOutBackgroundWorker,
  setRpcStub(fn) { rpc = fn; }
};
`;
  const timers = [];
  const context = {
    require: adapterRequire,
    module: { exports: {} },
    exports: {},
    __filename: adapterPath,
    __dirname: path.dirname(adapterPath),
    console,
    Buffer,
    URL,
    process: {
      ...process,
      env: { ...process.env, ...env },
      stdout: { write() {} },
      stderr: { write() {} },
      stdin: { setEncoding() {}, on() {} },
      cwd: () => process.cwd()
    },
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    setInterval(fn, ms) {
      const timer = { fn, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearInterval(timer) {
      if (timer) timer.cleared = true;
    }
  };
  context.global = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, {
    filename: adapterPath,
    timeout: 5000
  });
  return {
    api: context.module.exports.__backgroundTimeoutTest,
    timers
  };
}

async function assertBackgroundTimeoutCapsAndInterrupts() {
  const hardEnv = "120000";
  const idleEnv = "90000";
  const { api, timers } = loadAdapterInternalsWithFakeTimers({
    VIBE_FUSION_TURN_HARD_TIMEOUT_MS: "60000",
    VIBE_FUSION_TURN_IDLE_TIMEOUT_MS: "1000",
    VIBE_FUSION_BACKGROUND_HARD_TIMEOUT_MS: hardEnv,
    VIBE_FUSION_BACKGROUND_IDLE_TIMEOUT_MS: idleEnv
  });
  const interrupts = [];
  api.setRpcStub((method, params) => {
    interrupts.push({ method, params });
    return Promise.resolve({});
  });

  const completed = api.createBackgroundWorker("implement", "finish a long build", "bg-complete", "thread-bg-complete");
  completed.turnId = "turn-bg-complete";
  const completeResultPromise = completed.promise;
  const completeHardTimer = completed.hardTimer;
  const completeIdleTimer = completed.idleTimer;
  assert(
    completeHardTimer.ms === Number(hardEnv),
    `background hard timer should use BACKGROUND_HARD_TIMEOUT_MS, got ${completeHardTimer.ms}`
  );
  assert(
    completeIdleTimer.ms === Number(idleEnv),
    `background idle timer should use BACKGROUND_IDLE_TIMEOUT_MS, got ${completeIdleTimer.ms}`
  );
  api.refreshFanoutWorkerIdleTimer(completed, "progress after long command");
  assert(
    completed.idleTimer.ms === Number(idleEnv),
    `refreshed background idle timer should keep BACKGROUND_IDLE_TIMEOUT_MS, got ${completed.idleTimer.ms}`
  );
  api.finishFanoutWorkerTurn(completed, {
    status: "completed",
    items: [
      {
        type: "fileChange",
        id: "change-1",
        changes: [{ type: "edit", path: "src/background.js" }],
        status: "completed"
      },
      {
        type: "agentMessage",
        id: "agent-1",
        text: `Long build really completed.\n${VERDICT_MARKER} {"goalReached":true,"bugsFound":[],"missingRequirements":[],"nextAction":"done","summary":"Long build completed."}`,
        phase: null,
        memoryCitation: null
      }
    ]
  });
  const completeResult = await completeResultPromise;
  assert(
    completeResult.status === "completed" &&
      completeResult.summary.includes("Long build really completed") &&
      completeResult.files.includes("src/background.js"),
    `normal background completion should settle with real result: ${JSON.stringify(completeResult)}`
  );
  completeHardTimer.fn();
  assert(
    interrupts.length === 0,
    `normal background completion must not interrupt the worker turn: ${JSON.stringify(interrupts)}`
  );

  const hardTimedOut = api.createBackgroundWorker("implement", "timeout hard", "bg-hard", "thread-bg-hard");
  hardTimedOut.turnId = "turn-bg-hard";
  const hardResultPromise = hardTimedOut.promise;
  hardTimedOut.hardTimer.fn();
  const hardResult = await hardResultPromise;
  assert(
    hardResult.status === "failed" &&
      hardResult.error === "Fusion background task exceeded the maximum duration.",
    `hard timeout should settle with timeout failure: ${JSON.stringify(hardResult)}`
  );
  assert(
    interrupts.some(
      (entry) =>
        entry.method === "turn/interrupt" &&
        entry.params.threadId === "thread-bg-hard" &&
        entry.params.turnId === "turn-bg-hard"
    ),
    `hard timeout should interrupt the codex worker turn: ${JSON.stringify(interrupts)}`
  );

  const idleTimedOut = api.createBackgroundWorker("implement", "timeout idle", "bg-idle", "thread-bg-idle");
  idleTimedOut.turnId = "turn-bg-idle";
  const idleResultPromise = idleTimedOut.promise;
  idleTimedOut.idleTimer.fn();
  const idleResult = await idleResultPromise;
  assert(
    idleResult.status === "failed" && /stalled after background start/.test(idleResult.error || ""),
    `idle timeout should settle with stalled failure: ${JSON.stringify(idleResult)}`
  );
  assert(
    interrupts.some(
      (entry) =>
        entry.method === "turn/interrupt" &&
        entry.params.threadId === "thread-bg-idle" &&
        entry.params.turnId === "turn-bg-idle"
    ),
    `idle timeout should interrupt the codex worker turn: ${JSON.stringify(interrupts)}`
  );

  const fanout = {
    kind: "implement",
    index: 0,
    count: 1,
    threadId: "thread-fanout",
    turnId: "turn-fanout",
    idleTimeoutMs: 1000,
    settled: false,
    resolve() {}
  };
  api.refreshFanoutWorkerIdleTimer(fanout, "worker start");
  assert(
    fanout.idleTimer.ms === 1000,
    `parallel fan-out should still use its own foreground idle timeout, got ${fanout.idleTimer.ms}`
  );
  assert(
    timers.some((timer) => timer.ms === Number(hardEnv)) &&
      timers.some((timer) => timer.ms === Number(idleEnv)),
    "fake timer harness should have observed separate background hard and idle timers"
  );
}

function writeFanoutFakeAppServer(dir, options = {}) {
  const logFile = JSON.stringify(options.logFile);
  const mode = JSON.stringify(options.mode || "scout");
  const workerCount = Number(options.workerCount || 2);
  const verdict = JSON.stringify(
    `${VERDICT_MARKER} {"goalReached":false,"bugsFound":[],"missingRequirements":[],"nextAction":"continue","summary":"Workstream awaiting integration."}`
  );
  fs.writeFileSync(
    path.join(dir, "app-server"),
    `
const fs = require("fs");
const readline = require("readline");
const logFile = ${logFile};
const mode = ${mode};
const workerCount = ${workerCount};
const verdict = ${verdict};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let nextThread = 0;
let nextTurn = 0;
let approvalSeq = 900;
const pendingWorkerTurns = [];
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function log(entry) { fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n"); }
function turnShape(turnId, status, items = []) {
  return { id: turnId, items, itemsView: "full", status, error: null, startedAt: 1, completedAt: status === "completed" ? 2 : null, durationMs: 1 };
}
function completeWorkerTurn(threadId, turnId) {
  const n = threadId.replace(/\\D+/g, "");
  if (mode === "scout") {
    const agent = { type: "agentMessage", id: "msg-" + threadId, text: "Scout findings for " + threadId + " in backend/file-" + n + ".cjs", phase: null, memoryCitation: null };
    send({ method: "item/completed", params: { threadId, turnId, item: agent } });
    send({ method: "turn/completed", params: { threadId, turn: turnShape(turnId, "completed", [agent]) } });
    return;
  }
  const own = n === "2" ? "src/a.js" : "src/b.js";
  const change = { type: "fileChange", id: "fc-" + threadId, changes: [{ type: "edit", path: own }, { type: "edit", path: "src/shared.js" }], status: "completed" };
  const agent = { type: "agentMessage", id: "msg-" + threadId, text: "Workstream " + threadId + " done.\\n" + verdict, phase: null, memoryCitation: null };
  send({ method: "item/completed", params: { threadId, turnId, item: change } });
  send({ method: "item/completed", params: { threadId, turnId, item: agent } });
  send({ method: "turn/completed", params: { threadId, turn: turnShape(turnId, "completed", [change, agent]) } });
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.result && !msg.method) {
    log({ kind: "serverRequestResponse", id: msg.id, result: msg.result });
    return;
  }
  if (msg.method === "initialize") { send({ id: msg.id, result: {} }); return; }
  if (msg.method === "model/list") {
    send({ id: msg.id, result: { data: [{ id: "gpt-5.5", model: "gpt-5.5", isDefault: true, serviceTiers: [] }], nextCursor: null } });
    return;
  }
  if (msg.method === "thread/start") {
    nextThread += 1;
    const threadId = "thread-" + nextThread;
    log({ kind: "thread/start", threadId, params: msg.params });
    send({ id: msg.id, result: { thread: { id: threadId } } });
    return;
  }
  if (msg.method === "thread/goal/set") {
    log({ kind: "thread/goal/set", params: msg.params });
    send({ id: msg.id, result: { goal: { threadId: msg.params.threadId, objective: msg.params.objective || "", status: msg.params.status || "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } } });
    return;
  }
  if (msg.method === "turn/interrupt") {
    log({ kind: "turn/interrupt", params: msg.params });
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === "turn/start") {
    nextTurn += 1;
    const threadId = msg.params.threadId;
    const turnId = "turn-" + nextTurn;
    log({ kind: "turn/start", threadId, turnId, params: msg.params });
    send({ id: msg.id, result: { turn: turnShape(turnId, "running") } });
    send({ method: "turn/started", params: { threadId, turn: turnShape(turnId, "running") } });
    if (mode === "hang") return;
    if (mode === "implement" && threadId === "thread-2") {
      approvalSeq += 1;
      send({
        id: approvalSeq,
        method: "item/commandExecution/requestApproval",
        params: { threadId, turnId, itemId: "cmd-" + threadId, reason: "install package", command: "npm install leftpad", cwd: process.cwd(), commandActions: [], availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] }
      });
    }
    // Withhold every worker completion until ALL worker turns have started: a
    // serialized adapter would deadlock here, so passing proves concurrency.
    pendingWorkerTurns.push({ threadId, turnId });
    if (pendingWorkerTurns.length === workerCount) {
      for (const pending of pendingWorkerTurns) completeWorkerTurn(pending.threadId, pending.turnId);
    }
    return;
  }
  if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
`
  );
}

function spawnFanoutAdapter(tempDir, sessionId) {
  return spawn(process.execPath, [adapterPath], {
    cwd: tempDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      VIBE_FUSION_CODEX_BIN: process.execPath,
      VIBE_TERMINAL_FUSION_CWD: tempDir,
      VIBE_TERMINAL_SESSION_ID: sessionId
    }
  });
}

function readFanoutLog(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeBackgroundIsolationFakeAppServer(dir, options = {}) {
  const logFile = JSON.stringify(options.logFile);
  const verdict = JSON.stringify(
    `Background worker completed.\n${VERDICT_MARKER} {"goalReached":true,"bugsFound":[],"missingRequirements":[],"nextAction":"done","summary":"Background worker completed."}`
  );
  fs.writeFileSync(
    path.join(dir, "app-server"),
    `
const fs = require("fs");
const readline = require("readline");
const logFile = ${logFile};
const verdict = ${verdict};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let nextThread = 0;
let nextTurn = 0;
let pendingBackground = null;
let backgroundRequestResponses = 0;
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function log(entry) { fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n"); }
function turnShape(turnId, status, items = []) {
  return { id: turnId, items, itemsView: "full", status, error: null, startedAt: 1, completedAt: status === "completed" ? 2 : null, durationMs: 1 };
}
function commandItem(threadId) {
  return {
    type: "commandExecution",
    id: "cmd-" + threadId,
    command: "npm test -- --runInBand",
    cwd: process.cwd(),
    processId: null,
    source: "shell",
    status: "completed",
    commandActions: [],
    aggregatedOutput: "ok\\n",
    exitCode: 0,
    durationMs: 7
  };
}
function fileItem(threadId) {
  return {
    type: "fileChange",
    id: "file-" + threadId,
    changes: [{ type: "edit", path: "src/background-worker.js" }],
    status: "completed"
  };
}
function agentItem(threadId) {
  return {
    type: "agentMessage",
    id: "msg-" + threadId,
    text: verdict,
    phase: null,
    memoryCitation: null
  };
}
function maybeCompleteBackground() {
  if (!pendingBackground || backgroundRequestResponses < 2) return;
  const { threadId, turnId } = pendingBackground;
  pendingBackground = null;
  const agent = agentItem(threadId);
  send({ method: "turn/completed", params: { threadId, turn: turnShape(turnId, "completed", [agent]) } });
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.result && !msg.method) {
    log({ kind: "serverRequestResponse", id: msg.id, result: msg.result });
    if (msg.id === 700 || msg.id === 701) {
      backgroundRequestResponses += 1;
      maybeCompleteBackground();
    }
    return;
  }
  if (msg.method === "initialize") { send({ id: msg.id, result: {} }); return; }
  if (msg.method === "model/list") {
    send({ id: msg.id, result: { data: [{ id: "gpt-5.5", model: "gpt-5.5", isDefault: true, serviceTiers: [] }], nextCursor: null } });
    return;
  }
  if (msg.method === "thread/start") {
    nextThread += 1;
    const threadId = "thread-" + nextThread;
    log({ kind: "thread/start", threadId, params: msg.params });
    send({ id: msg.id, result: { thread: { id: threadId } } });
    return;
  }
  if (msg.method === "turn/interrupt") {
    log({ kind: "turn/interrupt", params: msg.params });
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.method === "turn/start") {
    nextTurn += 1;
    const threadId = msg.params.threadId;
    const turnId = "turn-" + nextTurn;
    log({ kind: "turn/start", threadId, turnId, params: msg.params });
    send({ id: msg.id, result: { turn: turnShape(turnId, "running") } });
    send({ method: "turn/started", params: { threadId, turn: turnShape(turnId, "running") } });
    if (threadId !== "thread-2") return;
    pendingBackground = { threadId, turnId };
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "msg-" + threadId, delta: "Background worker delta." } });
    send({ method: "item/completed", params: { threadId, turnId, item: commandItem(threadId) } });
    send({ method: "item/completed", params: { threadId, turnId, item: fileItem(threadId) } });
    send({
      id: 700,
      method: "item/tool/requestUserInput",
      params: {
        threadId,
        turnId,
        itemId: "question-" + threadId,
        questions: [{ id: "scope", header: "Scope", question: "Which background scope should be used?" }]
      }
    });
    send({
      id: 701,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId,
        itemId: "approval-" + threadId,
        reason: "background command needs approval",
        command: "Remove-Item -Recurse build",
        cwd: process.cwd(),
        commandActions: [{ command: "Remove-Item -Recurse build" }],
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
      }
    });
    return;
  }
  if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
`
  );
}

function callAdapterBackgroundTelemetryIsolation() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-background-"));
  const logFile = path.join(tempDir, "background-log.jsonl");
  writeBackgroundIsolationFakeAppServer(tempDir, { logFile });
  const token = `background-token-${Date.now()}-${Math.random()}`;
  const sessionId = "fusion-adapter-background";
  let callback = null;
  let child = null;
  let finished = false;
  let buffer = "";
  let stderr = "";
  const responses = new Map();

  function cleanup() {
    if (callback && callback.server) {
      try {
        callback.server.close();
      } catch {
        // ignore
      }
    }
    if (child) {
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
          execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        } catch {
          // best-effort
        }
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return createFusionCallbackServer(token).then((createdCallback) => {
    callback = createdCallback;
    child = spawn(process.execPath, [adapterPath], {
      cwd: tempDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        VIBE_FUSION_CODEX_BIN: process.execPath,
        VIBE_TERMINAL_FUSION_CWD: tempDir,
        VIBE_TERMINAL_SESSION_ID: sessionId,
        VIBE_TERMINAL_CALLBACK_URL: callback.callbackUrl,
        VIBE_TERMINAL_TELEMETRY_TOKEN: token,
        VIBE_FUSION_TURN_IDLE_TIMEOUT_MS: "5000",
        VIBE_FUSION_TURN_AFTER_COMMAND_TIMEOUT_MS: "5000"
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.stdout.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) responses.set(msg.id, msg);
        } catch {
          // ignore
        }
      }
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finished = true;
        cleanup();
        reject(new Error(`timed out waiting for background isolation; stderr=${stderr}`));
      }, 15000);

      function fail(error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        cleanup();
        reject(error);
      }

      child.on("error", fail);
      child.on("exit", (code) => {
        if (finished) return;
        fail(new Error(`adapter exited before background isolation completed: code=${code}; stderr=${stderr}`));
      });

      (async () => {
        try {
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fusion-background-isolation", version: "0.0.0" } } })}\n`
          );
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "codex_implement", arguments: { task: "Run the detached background telemetry isolation check", background: true } } })}\n`
          );

          const startedResponse = await waitForCondition(
            () => responses.get(2),
            5000,
            "background launch response"
          );
          const started = JSON.parse(startedResponse.result.content[0].text);
          assert(started.status === "started", `background launch should detach: ${startedResponse.result.content[0].text}`);

          await waitForCondition(
            () =>
              callback
                .getEvents()
                .some((event) => event.type === "fusion.background-task" && event.phase === "settled"),
            10000,
            "background settled telemetry"
          );

          const events = callback.getEvents();
          const mainRows = events.filter(
            (event) =>
              event.type === "fusion.activity" &&
              event.role === "codex" &&
              ["command", "message", "file", "approval"].includes(event.kind)
          );
          assert(
            mainRows.length === 0,
            `background worker action telemetry leaked into main chat: ${JSON.stringify(mainRows)}`
          );

          const backgroundEvents = events.filter((event) => event.type === "fusion.background-task");
          assert(
            backgroundEvents.some((event) => event.phase === "started") &&
              backgroundEvents.some((event) => event.phase === "settled"),
            `background task should emit started and settled telemetry: ${JSON.stringify(backgroundEvents)}`
          );
          const progressKinds = backgroundEvents
            .filter((event) => event.phase === "progress")
            .map((event) => event.activityKind);
          for (const kind of ["command", "file", "message", "approval"]) {
            assert(
              progressKinds.includes(kind),
              `background progress should include ${kind} activity, got ${JSON.stringify(progressKinds)}`
            );
          }

          const log = readFanoutLog(logFile);
          const requestResponses = log.filter((entry) => entry.kind === "serverRequestResponse");
          assert(
            requestResponses.some((entry) => entry.id === 700 && entry.result?.answers?.scope),
            `background question should be auto-answered on the wire: ${JSON.stringify(requestResponses)}`
          );
          assert(
            requestResponses.some((entry) => entry.id === 701 && entry.result?.decision === "decline"),
            `background approval should be auto-declined on the wire: ${JSON.stringify(requestResponses)}`
          );
          const backgroundTurn = log.find(
            (entry) => entry.kind === "turn/start" && entry.threadId === "thread-2"
          );
          assert(
            backgroundTurn && /Detached background task/.test(backgroundTurn.params.input[0].text),
            `background worker turn should carry the detached-task contract: ${JSON.stringify(backgroundTurn)}`
          );

          finished = true;
          clearTimeout(timer);
          cleanup();
          resolve();
        } catch (error) {
          fail(error);
        }
      })();
    });
  });
}

function callAdapterScoutFanoutWithFakeAppServer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-fanout-scout-"));
  const logFile = path.join(tempDir, "fanout-log.jsonl");
  writeFanoutFakeAppServer(tempDir, { logFile, mode: "scout" });
  const child = spawnFanoutAdapter(tempDir, "fusion-adapter-fanout-scout");

  const responses = new Map();
  let buffer = "";
  let stderr = "";
  let finished = false;

  function cleanup() {
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
        execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      } catch {
        // best-effort
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finished = true;
      cleanup();
      reject(new Error(`timed out waiting for scout fan-out result; stderr=${stderr}`));
    }, 15000);

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("exit", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`adapter exited before scout fan-out result: code=${code}; stderr=${stderr}`));
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (!responses.has(2) || !responses.has(3) || finished) continue;
        finished = true;
        clearTimeout(timer);
        try {
          const busyText = responses.get(3).result.content[0].text;
          const busy = JSON.parse(busyText);
          assert(
            busy.status === "error" && /already in progress/i.test(busy.error),
            `a concurrent call during a fan-out must be rejected: ${busyText}`
          );
          const text = responses.get(2).result.content[0].text;
          const parsed = JSON.parse(text);
          assert(parsed.status === "completed", `scout fan-out should complete: ${text}`);
          assert(
            Array.isArray(parsed.scouts) && parsed.scouts.length === 2,
            `scout fan-out should report per-scout results: ${text}`
          );
          assert(
            /Scout 1\/2/.test(parsed.findings) && /Scout 2\/2/.test(parsed.findings),
            `combined findings should carry per-scout sections: ${text}`
          );
          assert(
            parsed.files.some((f) => /file-2\.cjs$/.test(f)) &&
              parsed.files.some((f) => /file-3\.cjs$/.test(f)),
            `combined files should union both scouts' paths: ${text}`
          );
          const log = readFanoutLog(logFile);
          const threadStarts = log.filter((entry) => entry.kind === "thread/start");
          assert(
            threadStarts.length === 3,
            `scout fan-out should start main + 2 worker threads, got ${threadStarts.length}`
          );
          const workerStarts = threadStarts.slice(1);
          assert(
            workerStarts.every((entry) => entry.params?.config?.["features.goals"] !== true),
            `scout worker threads must not enable goals: ${JSON.stringify(workerStarts)}`
          );
          const turnStarts = log.filter((entry) => entry.kind === "turn/start");
          assert(
            turnStarts.length === 2 &&
              new Set(turnStarts.map((entry) => entry.threadId)).size === 2,
            `scout fan-out should run one concurrent turn per worker thread: ${JSON.stringify(turnStarts)}`
          );
          assert(
            turnStarts.every((entry) => /Parallel scout \d of 2/.test(entry.params.input[0].text)),
            "worker turns must carry the parallel-scout contract"
          );
          cleanup();
          resolve();
        } catch (error) {
          cleanup();
          reject(error);
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fusion-adapter-fanout-scout", version: "0.0.0" }
        }
      })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "codex_investigate",
          arguments: { tasks: ["map the backend turn machinery", "map the frontend chat pane"] }
        }
      })}\n`
    );
    // Sent while the fan-out is arming/running: must be rejected, not queued.
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "codex_investigate", arguments: { task: "sneak a second turn" } }
      })}\n`
    );
  });
}

function callAdapterImplementFanoutWithFakeAppServer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-fanout-impl-"));
  const logFile = path.join(tempDir, "fanout-log.jsonl");
  writeFanoutFakeAppServer(tempDir, { logFile, mode: "implement" });
  const child = spawnFanoutAdapter(tempDir, "fusion-adapter-fanout-impl");

  const responses = new Map();
  let buffer = "";
  let stderr = "";
  let finished = false;

  function cleanup() {
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
        execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      } catch {
        // best-effort
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finished = true;
      cleanup();
      reject(new Error(`timed out waiting for implement fan-out result; stderr=${stderr}`));
    }, 15000);

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("exit", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`adapter exited before implement fan-out result: code=${code}; stderr=${stderr}`));
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (!responses.has(2) || finished) continue;
        finished = true;
        clearTimeout(timer);
        try {
          const text = responses.get(2).result.content[0].text;
          const parsed = JSON.parse(text);
          assert(parsed.status === "completed", `implement fan-out should complete: ${text}`);
          assert(
            Array.isArray(parsed.workers) && parsed.workers.length === 2,
            `implement fan-out should report per-workstream results: ${text}`
          );
          assert(
            parsed.workers.every((w) => w.nextAction === "continue" && w.goalReached === false),
            `per-workstream verifier verdicts should parse: ${text}`
          );
          assert(
            parsed.fileConflicts && parsed.fileConflicts.includes("src/shared.js"),
            `overlapping workstream files should surface as fileConflicts: ${text}`
          );
          assert(
            /overlapping files/i.test(parsed.warning || "") && /Workstream 1\/2/.test(parsed.summary),
            `aggregate summary should carry the conflict warning and per-workstream sections: ${text}`
          );
          assert(
            parsed.goalReached === false && parsed.nextAction === "continue",
            `aggregate must stay on continue: ${text}`
          );
          assert(
            parsed.files.includes("src/a.js") &&
              parsed.files.includes("src/b.js") &&
              parsed.files.includes("src/shared.js"),
            `aggregate files should union all workstreams: ${text}`
          );
          assert(
            /auto-declined/.test(parsed.summary),
            `a worker's exceptional approval should be auto-declined and reported: ${text}`
          );
          const log = readFanoutLog(logFile);
          const goalSets = log.filter((entry) => entry.kind === "thread/goal/set");
          assert(goalSets.length === 1, `fan-out should create one fallback goal, got ${goalSets.length}`);
          assert(
            /workstream A/.test(goalSets[0].params.objective) &&
              /workstream B/.test(goalSets[0].params.objective),
            `fallback goal objective should join the workstream tasks: ${JSON.stringify(goalSets[0])}`
          );
          assert(
            !goalSets.some((entry) => entry.params.status === "complete"),
            "a fan-out must never auto-complete the native goal"
          );
          const declineResponse = log.find(
            (entry) => entry.kind === "serverRequestResponse" && entry.id > 900
          );
          assert(
            declineResponse && declineResponse.result && declineResponse.result.decision === "decline",
            `the worker approval should be auto-declined on the wire: ${JSON.stringify(declineResponse)}`
          );
          const turnStarts = log.filter((entry) => entry.kind === "turn/start");
          assert(
            turnStarts.every((entry) => /Parallel workstream \d of 2/.test(entry.params.input[0].text)),
            "worker turns must carry the parallel-workstream contract"
          );
          cleanup();
          resolve();
        } catch (error) {
          cleanup();
          reject(error);
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fusion-adapter-fanout-impl", version: "0.0.0" }
        }
      })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "codex_implement",
          arguments: { tasks: ["build workstream A in src/a.js", "build workstream B in src/b.js"] }
        }
      })}\n`
    );
  });
}

function callAdapterCancelDuringFanout() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-adapter-fanout-cancel-"));
  const logFile = path.join(tempDir, "fanout-log.jsonl");
  writeFanoutFakeAppServer(tempDir, { logFile, mode: "hang" });
  const child = spawnFanoutAdapter(tempDir, "fusion-adapter-fanout-cancel");

  const responses = new Map();
  let buffer = "";
  let stderr = "";
  let finished = false;
  let sentCancel = false;

  function cleanup() {
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
        execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      } catch {
        // best-effort
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finished = true;
      cleanup();
      reject(new Error(`timed out waiting for fan-out cancel; stderr=${stderr}`));
    }, 15000);

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("exit", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`adapter exited before fan-out cancel result: code=${code}; stderr=${stderr}`));
    });

    // Wait for both hung worker turns to start, then cancel.
    const poll = setInterval(() => {
      if (sentCancel || finished) return;
      const turnStarts = readFanoutLog(logFile).filter((entry) => entry.kind === "turn/start");
      if (turnStarts.length >= 2) {
        sentCancel = true;
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "codex_cancel", arguments: {} }
          })}\n`
        );
      }
    }, 50);

    child.stdout.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (!responses.has(2) || !responses.has(3) || finished) continue;
        finished = true;
        clearTimeout(timer);
        clearInterval(poll);
        try {
          const cancelText = responses.get(3).result.content[0].text;
          const cancel = JSON.parse(cancelText);
          assert(cancel.status === "cancelled", `cancel during fan-out should succeed: ${cancelText}`);
          assert(cancel.hadActiveTurn === true, `cancel should see the active fan-out: ${cancelText}`);
          const fanoutText = responses.get(2).result.content[0].text;
          const fanout = JSON.parse(fanoutText);
          assert(
            fanout.status === "cancelled",
            `the hung fan-out call should resolve as cancelled: ${fanoutText}`
          );
          const interrupts = await waitForCondition(() => {
            const rows = readFanoutLog(logFile).filter((entry) => entry.kind === "turn/interrupt");
            return new Set(rows.map((entry) => entry.params.threadId)).size >= 2 ? rows : null;
          }, 2000, "fan-out worker interrupts");
          assert(
            new Set(interrupts.map((entry) => entry.params.threadId)).size >= 2,
            `cancel must interrupt every fan-out worker thread: ${JSON.stringify(interrupts)}`
          );
          cleanup();
          resolve();
        } catch (error) {
          cleanup();
          reject(error);
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fusion-adapter-fanout-cancel", version: "0.0.0" }
        }
      })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "codex_investigate", arguments: { tasks: ["hang one", "hang two"] } }
      })}\n`
    );
  });
}

main()
  .then(async () => {
    assertGoalSchema();
    assertVerifierHelpers();
    assertWorkspaceMcpConfigOverrides();
    assertCommandDisplayHelpers();
    assertPortabilityGuards();
    assertExecutorSettingsParsing();
    assertClaudeExecutorArgs();
    await assertWorkspaceMcpConfigInjectedIntoThreadStart();
    await assertEagerBootStartsThread();
    await callAdapterToolDuringEagerBootUsesOneThreadStart();
    await callAdapterToolWithFakeAppServer();
    await callAdapterPlanModeRejectsImplement();
    await assertAdapterRunsHostFree();
    await callAdapterApprovalResumeWithFakeAppServer();
    await callAdapterApprovalResumeWithFakeAppServer({ completeBeforeApprovalResponse: true });
    await callAdapterApprovalResumeWithFakeAppServer({ exercisePendingRecovery: true });
    await callAdapterApprovalResumeWithFakeAppServer({ queueSecondApproval: true });
    await callAdapterClearsParkedApprovalWhenAppServerExits();
    await callAdapterCancelClearsWedge();
    await callAdapterSteerRoutingWithFakeAppServer("push");
    await callAdapterSteerRoutingWithFakeAppServer("replan");
    await callAdapterDeadWindowSteerSkips();
    await callAdapterImplementWithFakeClaudeExecutor();
    assertFanoutHelpers();
    await assertBackgroundTimeoutCapsAndInterrupts();
    await callAdapterBackgroundTelemetryIsolation();
    await callAdapterScoutFanoutWithFakeAppServer();
    await callAdapterImplementFanoutWithFakeAppServer();
    await callAdapterCancelDuringFanout();
    console.log("Fusion adapter smoke passed");
  })
  .catch((error) => {
    console.error(`FAIL fusion-adapter-smoke: ${error.message}`);
    process.exit(1);
  });
