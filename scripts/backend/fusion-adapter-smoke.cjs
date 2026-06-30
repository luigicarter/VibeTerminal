// Fusion adapter MCP-surface smoke test.
//
// Spawns backend/fusion-adapter.cjs and drives its north (MCP stdio) side the
// way Claude Code would: `initialize` then `tools/list`. Asserts the hand-rolled
// MCP server identifies itself and exposes the Fusion tools. This guards the
// riskiest hand-written piece without needing codex auth or a model turn (the
// full app-server turn round-trip is covered by the end-to-end check).

const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
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
  stripVerifierVerdictFromSummary
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
      // A dummy endpoint: the adapter connects lazily (only on a tool call), so
      // the MCP surface is exercised without a live app-server.
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
                /independently verifying/i.test(implementTool.description),
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
}

main()
  .then(() => {
    assertGoalSchema();
    assertVerifierHelpers();
    console.log("Fusion adapter smoke passed");
  })
  .catch((error) => {
    console.error(`FAIL fusion-adapter-smoke: ${error.message}`);
    process.exit(1);
  });
