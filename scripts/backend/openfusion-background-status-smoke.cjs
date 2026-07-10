// Open Fusion detached-background status smoke.
//
// Locks the read-only bridge contract (list/detail/missing snapshot), the
// host's pane-scoped MCP env augmentation, and one real stdio MCP tools/call.

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..", "..");
const tempDir = path.join(
  rootDir,
  ".tmp",
  `openfusion-background-status-smoke-${Date.now()}-${process.pid}`
);
const statusFile = path.join(tempDir, "background-status.json");
const bridgePath = path.join(rootDir, "backend", "openFusionBackgroundMcp.cjs");
const hostPath = path.join(rootDir, "backend", "openFusionChatHost.cjs");

process.env.VIBE_TERMINAL_BG_STATUS_FILE = statusFile;

const { TOOLS, readBackgroundStatus } = require(bridgePath);
const {
  backgroundStatusFileForEnv,
  withBackgroundStatusEnv,
  writeBackgroundStatusSnapshotFile
} = require(path.join(rootDir, "backend", "openFusionChatHost.cjs"));

function invokeStatusMcp(taskId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath], {
      cwd: rootDir,
      env: {
        ...process.env,
        VIBE_TERMINAL_BG_STATUS_FILE: statusFile,
        // A status peek must not POST even when callback wiring exists.
        VIBE_TERMINAL_CALLBACK_URL: "http://127.0.0.1:1/background",
        VIBE_TERMINAL_TELEMETRY_TOKEN: "unused-status-token",
        VIBE_TERMINAL_SESSION_ID: "status-smoke-pane"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const replies = [];
    let stdout = "";
    let stderr = "";
    let gotCallReply = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`background_status MCP call timed out: ${stderr}`));
    }, 5_000);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      let index;
      while ((index = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (!line) continue;
        const reply = JSON.parse(line);
        replies.push(reply);
        if (reply.id === 3) {
          gotCallReply = true;
          child.stdin.end();
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!gotCallReply || code !== 0) {
        reject(
          new Error(
            `background_status MCP call failed (code=${code}, gotReply=${gotCallReply}): ${stderr}`
          )
        );
        return;
      }
      resolve(replies);
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} }
      })}\n`
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "background_status", arguments: { taskId } }
      })}\n`
    );
  });
}

async function main() {
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    const statusTool = TOOLS.find((tool) => tool.name === "background_status");
    assert(statusTool, "TOOLS should list background_status");
    assert.strictEqual(
      statusTool.inputSchema?.properties?.taskId?.type,
      "string",
      "background_status taskId should be an optional string"
    );
    assert(
      !Array.isArray(statusTool.inputSchema.required) ||
        !statusTool.inputSchema.required.includes("taskId"),
      "background_status should not require taskId"
    );
    const hostSource = fs.readFileSync(hostPath, "utf8");
    assert(
      hostSource.includes("fs.renameSync(tempFile, file);") &&
        hostSource.includes("const BACKGROUND_STATUS_MAX_ACTIVITY = 20;") &&
        hostSource.includes("const BACKGROUND_STATUS_MAX_SETTLED = 8;") &&
        /state\.backgroundTasks\.set\(taskId, task\);\s*writeBackgroundStatusFile\(id, state\);/.test(
          hostSource
        ) &&
        /task\.cancelled = true;\s*writeBackgroundStatusFile\(id, state\);/.test(hostSource) &&
        hostSource.includes('task.cancelled ? "cancelling"') &&
        /task\.recentActivity\.push[\s\S]*?writeBackgroundStatusFile\(id, state\);/.test(
          hostSource
        ) &&
        /state\.backgroundSettled\.unshift[\s\S]*?writeBackgroundStatusFile\(id, state\);/.test(
          hostSource
        ) &&
        hostSource.includes(
          "recentActivity: task.recentActivity.slice(-BACKGROUND_STATUS_MAX_ACTIVITY)"
        ) &&
        hostSource.includes("result: settledEvent.result"),
      "host should atomically refresh status on start, cancel, progress, and settle"
    );

    const startedAt = Date.now() - 5_000;
    const fixture = {
      updatedAt: Date.now() - 20,
      tasks: [
        {
          taskId: "obg-running",
          title: "Inspect background status",
          state: "running",
          startedAt,
          elapsedMs: 1,
          updates: 2,
          files: ["backend/example.cjs"],
          recentActivity: [
            { ts: Date.now() - 100, kind: "command", text: "$ node --check example.cjs" }
          ]
        }
      ],
      settled: [
        {
          taskId: "obg-settled",
          title: "Earlier task",
          status: "completed",
          cancelled: false,
          startedAt: Date.now() - 2_234,
          durationMs: 1234,
          elapsedMs: 1234,
          settledAt: Date.now() - 1_000,
          updates: 4,
          files: ["backend/settled.cjs"],
          recentActivity: [
            { ts: Date.now() - 1_100, kind: "file", text: "edit backend/settled.cjs" }
          ],
          result: {
            status: "completed",
            report: "done",
            files: ["backend/settled.cjs"]
          }
        }
      ]
    };
    fs.writeFileSync(statusFile, `${JSON.stringify(fixture, null, 2)}\n`);

    const listed = readBackgroundStatus();
    assert.strictEqual(listed.status, "ok");
    assert.strictEqual(listed.tasks.length, 1);
    assert.strictEqual(listed.settled.length, 1);
    assert.strictEqual(listed.tasks[0].state, "running");
    assert.strictEqual(listed.settled[0].state, "settled");
    assert(
      listed.tasks[0].elapsedMs >= 4_500 && listed.tasks[0].elapsedMs < 60_000,
      "running elapsedMs should be refreshed from startedAt"
    );

    const running = readBackgroundStatus(" obg-running ");
    assert.strictEqual(running.status, "ok");
    assert.strictEqual(running.task.state, "running");
    assert.deepStrictEqual(running.task.files, ["backend/example.cjs"]);
    assert.strictEqual(running.task.recentActivity.length, 1);

    const settled = readBackgroundStatus("obg-settled");
    assert.strictEqual(settled.status, "ok");
    assert.strictEqual(settled.task.state, "settled");
    assert.strictEqual(settled.task.status, "completed");
    assert.deepStrictEqual(settled.task.files, ["backend/settled.cjs"]);
    assert.strictEqual(settled.task.recentActivity.length, 1);
    assert.strictEqual(settled.task.result.report, "done");

    const unknown = readBackgroundStatus("obg-unknown");
    assert.strictEqual(unknown.status, "error");
    assert.strictEqual(unknown.error, "Unknown background taskId: obg-unknown");
    assert.strictEqual(unknown.tasks.length, 1);

    const paneDir = path.join(tempDir, "pane");
    const expectedStatusFile = path.join(paneDir, "background-status.json");
    const paneEnv = {
      VIBE_TERMINAL_OPEN_FUSION_DIR: paneDir,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        mcp: {
          vibeterminal: {
            type: "local",
            environment: {
              VIBE_TERMINAL_CALLBACK_URL: "http://127.0.0.1/callback",
              VIBE_TERMINAL_TELEMETRY_TOKEN: "token",
              VIBE_TERMINAL_SESSION_ID: "pane"
            }
          }
        },
        agent: {
          planner: {
            permission: {
              "*": "deny",
              vibeterminal_background_task: "allow",
              vibeterminal_background_cancel: "allow"
            }
          }
        }
      })
    };
    assert.strictEqual(backgroundStatusFileForEnv(paneEnv), expectedStatusFile);
    assert.strictEqual(
      backgroundStatusFileForEnv(paneEnv, expectedStatusFile),
      expectedStatusFile,
      "the explicit host payload path should remain the pane isolation boundary"
    );
    const wiredEnv = withBackgroundStatusEnv(paneEnv, expectedStatusFile);
    const wiredConfig = JSON.parse(wiredEnv.OPENCODE_CONFIG_CONTENT);
    assert.strictEqual(wiredEnv.VIBE_TERMINAL_BG_STATUS_FILE, expectedStatusFile);
    assert.strictEqual(
      wiredConfig.mcp.vibeterminal.environment.VIBE_TERMINAL_BG_STATUS_FILE,
      expectedStatusFile,
      "effective vibeterminal MCP config should carry the snapshot path"
    );
    assert.deepStrictEqual(
      Object.keys(wiredConfig.agent.planner.permission),
      ["*", "vibeterminal_background_task", "vibeterminal_background_cancel"],
      "status env wiring must not reorder the load-bearing permission map"
    );
    const hostFixture = path.join(paneDir, "host-written.json");
    assert.strictEqual(
      writeBackgroundStatusSnapshotFile(hostFixture, fixture),
      true,
      "host snapshot writes should succeed"
    );
    assert.strictEqual(JSON.parse(fs.readFileSync(hostFixture, "utf8")).tasks[0].taskId, "obg-running");
    const replacementFixture = { ...fixture, updatedAt: fixture.updatedAt + 1 };
    assert.strictEqual(
      writeBackgroundStatusSnapshotFile(hostFixture, replacementFixture),
      true,
      "host snapshot writes should atomically replace an existing snapshot"
    );
    assert.strictEqual(
      JSON.parse(fs.readFileSync(hostFixture, "utf8")).updatedAt,
      replacementFixture.updatedAt
    );
    assert.strictEqual(
      writeBackgroundStatusSnapshotFile(tempDir, fixture),
      false,
      "snapshot write failures should be swallowed and reported as false"
    );

    const mcpReplies = await invokeStatusMcp("obg-running");
    const listedTools = mcpReplies.find((reply) => reply.id === 2)?.result?.tools || [];
    assert(
      listedTools.some((tool) => tool.name === "background_status"),
      "real MCP tools/list should expose background_status"
    );
    const callText = mcpReplies.find((reply) => reply.id === 3)?.result?.content?.[0]?.text;
    const callResult = JSON.parse(callText);
    assert.strictEqual(callResult.status, "ok");
    assert.strictEqual(callResult.task.taskId, "obg-running");
    assert.strictEqual(callResult.task.state, "running");

    const missing = readBackgroundStatus("", path.join(tempDir, "missing.json"));
    assert.deepStrictEqual(missing, {
      status: "ok",
      tasks: [],
      settled: [],
      note: "No background tasks have run in this pane session."
    });
    const emptyFile = path.join(tempDir, "empty.json");
    fs.writeFileSync(emptyFile, JSON.stringify({ tasks: [], settled: [] }));
    assert.deepStrictEqual(readBackgroundStatus("obg-missing", emptyFile), missing);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log("Open Fusion background status smoke passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
