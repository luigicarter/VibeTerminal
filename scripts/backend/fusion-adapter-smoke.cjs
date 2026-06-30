// Fusion adapter MCP-surface smoke test.
//
// Spawns backend/fusion-adapter.cjs and drives its north (MCP stdio) side the
// way Claude Code would: `initialize` then `tools/list`. Asserts the hand-rolled
// MCP server identifies itself and exposes the Fusion tools. This guards the
// riskiest hand-written piece without needing codex auth or a model turn (the
// full app-server turn round-trip is covered by the end-to-end check).

const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const adapterPath = path.join(__dirname, "..", "..", "backend", "fusion-adapter.cjs");
const isWin = process.platform === "win32";
const {
  VERDICT_MARKER,
  buildCodexVerifierTask,
  extractVerifierVerdict,
  goalStatusForVerdict,
  normalizeGoal,
  normalizeGoalStatus,
  shouldAutoSyncGoalStatus,
  shouldReplaceGoalForTask,
  stripVerifierVerdictFromSummary,
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
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (responses.has(1) && responses.has(2)) {
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
            assert(names.includes("codex_implement"), "tools/list missing codex_implement");
            assert(names.includes("codex_respond"), "tools/list missing codex_respond");
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
              source.includes('config: { "features.goals": true }'),
              "adapter does not enable native Codex goals with the verified feature override"
            );
            assert(source.includes('rpc("thread/goal/set"'), "adapter does not call native goal set");
            assert(source.includes('rpc("thread/goal/get"'), "adapter does not call native goal get");
            assert(source.includes('rpc("thread/goal/clear"'), "adapter does not call native goal clear");
            assert(source.includes("buildCodexVerifierTask(task)"), "adapter does not wrap Codex tasks with the verifier contract");
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
  });
}

function writeFakeAppServer(dir, options = {}) {
  const markerFile = options.markerFile ? JSON.stringify(options.markerFile) : "null";
  const delayThreadStartMs = Number(options.delayThreadStartMs || 0);
  fs.writeFileSync(
    path.join(dir, "app-server"),
    `
const fs = require("fs");
const readline = require("readline");
const markerFile = ${markerFile};
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
  if (msg.method === "thread/start") {
    if (markerFile) fs.appendFileSync(markerFile, "thread-started\\n");
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
            for (const tool of ["codex_goal_set", "codex_goal_get", "codex_goal_clear", "codex_implement", "codex_respond"]) {
              assert(names.includes(tool), `host-free tools/list missing ${tool}`);
            }
            const callText = responses.get(3).result.content[0].text;
            const parsed = JSON.parse(callText);
            assert(parsed.status === "ok", `host-free tools/call round-trip should succeed: ${callText}`);
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
        params: { name: "codex_goal_get", arguments: {} }
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
}

main()
  .then(async () => {
    assertGoalSchema();
    assertVerifierHelpers();
    assertPortabilityGuards();
    await assertEagerBootStartsThread();
    await callAdapterToolDuringEagerBootUsesOneThreadStart();
    await callAdapterToolWithFakeAppServer();
    await assertAdapterRunsHostFree();
    await callAdapterApprovalResumeWithFakeAppServer();
    await callAdapterApprovalResumeWithFakeAppServer({ completeBeforeApprovalResponse: true });
    await callAdapterApprovalResumeWithFakeAppServer({ exercisePendingRecovery: true });
    await callAdapterApprovalResumeWithFakeAppServer({ queueSecondApproval: true });
    await callAdapterClearsParkedApprovalWhenAppServerExits();
    console.log("Fusion adapter smoke passed");
  })
  .catch((error) => {
    console.error(`FAIL fusion-adapter-smoke: ${error.message}`);
    process.exit(1);
  });
