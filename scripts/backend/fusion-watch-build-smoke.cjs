const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-watch-build-smoke-"));
const buildsDir = path.join(tempDir, "builds");
const token = `watch-build-${Date.now()}-${Math.random()}`;
const events = [];
let server = null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(fn, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value) return value;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function createCallbackServer() {
  server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/agent-event") {
      response.writeHead(404);
      response.end();
      return;
    }
    assert.strictEqual(
      request.headers["x-vibe-telemetry-token"],
      token,
      "telemetry token should match"
    );
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      events.push(JSON.parse(body || "{}"));
      response.writeHead(204);
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}/agent-event`);
    });
  });
}

async function main() {
  const callbackUrl = await createCallbackServer();
  process.env.VIBE_BUILD_SUPERVISOR_DIR = buildsDir;
  process.env.VIBE_TERMINAL_CALLBACK_URL = callbackUrl;
  process.env.VIBE_TERMINAL_TELEMETRY_TOKEN = token;
  process.env.VIBE_TERMINAL_SESSION_ID = "fusion-watch-build-smoke";

  const {
    buildSupervisorDir,
    codexBuildCancel,
    codexBuildStatus,
    codexWatchBuild,
    watchedBuildRunnerSource,
    watchedBuildSpawnSpec
  } = require("../../backend/fusion-adapter.cjs");
  const {
    buildBuildWakeText,
    parseBuildReportEnvelope,
    FUSION_BUILD_REPORT_HEADER
  } = require("../../backend/fusionChatHost.cjs");

  assert.strictEqual(buildSupervisorDir(), buildsDir, "adapter should use shared builds dir");
  const probeRunner = watchedBuildRunnerSource({
    command: "node -e \"process.exit(3)\"",
    cwd: tempDir,
    logPath: path.join(buildsDir, "probe.log"),
    sentinelPath: path.join(buildsDir, "probe.exit")
  });
  const probeSpec = watchedBuildSpawnSpec(path.join(buildsDir, "probe.runner.cjs"));
  assert.strictEqual(probeSpec.command, process.execPath, "adapter should detach a node runner");
  if (process.platform === "win32") {
    assert(
      probeRunner.includes('["/d", "/s", "/v:on", "/c", command]') &&
        probeRunner.includes("windowsVerbatimArguments: isWin") &&
        probeRunner.includes("writeSentinel(code)"),
      "win32 runner must use cmd.exe with delayed expansion support and write the sentinel"
    );
  }

  const result = await codexWatchBuild(
    "node -e \"require('fs').writeSync(1, 'fusion-watch-build log text\\\\n'); process.exit(3)\"",
    tempDir
  );
  assert.strictEqual(result.status, "watching", `watch tool should return immediately: ${JSON.stringify(result)}`);
  assert(result.buildId, "watch tool should return buildId");
  assert(result.pid > 0, "watch tool should return detached pid");
  assert(result.logPath.startsWith(buildsDir), "logPath should live under shared builds dir");

  const event = await waitForCondition(
    () => events.find((item) => item.type === "fusion.build-task" && item.buildId === result.buildId),
    5000,
    "started telemetry"
  );
  assert.strictEqual(event.phase, "started", "telemetry phase should be started");
  assert.strictEqual(event.sessionId, "fusion-watch-build-smoke", "telemetry should carry session id");
  assert.strictEqual(event.pid, result.pid, "telemetry should carry detached pid");
  assert.strictEqual(event.logPath, result.logPath, "telemetry should carry logPath");
  assert(event.sentinelPath.endsWith(`${result.buildId}.exit`), "telemetry should carry sentinelPath");
  assert(event.startedAt > 0, "telemetry should carry startedAt");

  await waitForCondition(
    () => fs.existsSync(event.sentinelPath) && fs.readFileSync(event.sentinelPath, "utf8").trim(),
    5000,
    "exit-code sentinel"
  );
  const exitCode = fs.readFileSync(event.sentinelPath, "utf8").trim();
  const logText = fs.readFileSync(result.logPath, "utf8");
  assert.strictEqual(exitCode, "3", `sentinel should contain real exit code, got ${exitCode}`);
  assert(logText.includes("fusion-watch-build log text"), "logfile should contain command output");

  const statusBuildId = "build-status-smoke";
  const statusLogPath = path.join(buildsDir, `${statusBuildId}.log`);
  const statusSentinelPath = path.join(buildsDir, `${statusBuildId}.exit`);
  fs.writeFileSync(statusLogPath, "status smoke expected tail\n", "utf8");
  fs.writeFileSync(statusSentinelPath, "0\n", "utf8");
  fs.writeFileSync(
    path.join(buildsDir, "registry.json"),
    `${JSON.stringify(
      [
        {
          buildId: statusBuildId,
          sessionId: "fusion-watch-build-smoke",
          command: "npm run status-smoke",
          cwd: tempDir,
          pid: 12345,
          logPath: statusLogPath,
          sentinelPath: statusSentinelPath,
          status: "running",
          exitCode: null,
          startedAt: 200,
          endedAt: null
        },
        {
          buildId: "older-build",
          command: "older",
          status: "exited",
          startedAt: 100,
          endedAt: 150
        }
      ],
      null,
      2
    )}\n`,
    "utf8"
  );
  const oneStatus = await codexBuildStatus(statusBuildId);
  assert.strictEqual(oneStatus.status, "ok", "codexBuildStatus should find a build");
  assert.strictEqual(oneStatus.build.buildId, statusBuildId, "codexBuildStatus should return build metadata");
  assert.strictEqual(oneStatus.build.status, "finishing", "running build with sentinel should be hinted as finishing");
  assert(oneStatus.tail.includes("status smoke expected tail"), "codexBuildStatus should include log tail");
  const listStatus = await codexBuildStatus("");
  assert.strictEqual(listStatus.status, "ok", "codexBuildStatus list should succeed");
  assert.strictEqual(listStatus.builds[0].buildId, statusBuildId, "codexBuildStatus should list most recent first");

  const cancelResult = await codexBuildCancel(statusBuildId);
  assert.strictEqual(cancelResult.status, "cancel-requested", "codexBuildCancel should request cancellation");
  const cancelEvent = await waitForCondition(
    () =>
      events.find(
        (item) =>
          item.type === "fusion.build-task" &&
          item.phase === "cancel-request" &&
          item.buildId === statusBuildId
      ),
    5000,
    "cancel-request telemetry"
  );
  assert.strictEqual(cancelEvent.sessionId, "fusion-watch-build-smoke", "cancel telemetry should carry session id");

  const agentTelemetrySource = fs.readFileSync(
    path.join(root, "backend", "agentTelemetry.cjs"),
    "utf8"
  );
  assert(
    agentTelemetrySource.includes('event.type === "fusion.build-task"') &&
      agentTelemetrySource.includes('type: "fusion-build-task"') &&
      agentTelemetrySource.includes("sentinelPath: event.sentinelPath"),
    "agentTelemetry should map fusion.build-task telemetry for main"
  );
  const mainSource = fs.readFileSync(path.join(root, "backend", "main.cjs"), "utf8");
  assert(
    mainSource.includes('event?.type === "fusion-build-task"') &&
      mainSource.includes('event.phase === "started"') &&
      mainSource.includes("getBuildSupervisor().register({") &&
      mainSource.includes("sessionId: event.id") &&
      mainSource.includes("sentinelPath: event.sentinelPath"),
    "main should register started build telemetry with the host build supervisor"
  );
  assert(
    mainSource.includes('event?.type === "build-task"') &&
      mainSource.includes('event.phase === "settled"') &&
      mainSource.includes('sendToFusionChatHost({') &&
      mainSource.includes('type: "build-task"') &&
      mainSource.includes("id: event.sessionId"),
    "main should route settled build supervisor events to the Fusion build-task wake path"
  );
  assert(
    mainSource.includes('event?.type === "fusion-build-task" && event.phase === "cancel-request"') &&
      mainSource.includes("getBuildSupervisor().cancel(String(event.buildId || \"\"))") &&
      mainSource.includes('phase: "started"'),
    "main should route build cancel requests and mirror started builds to the Fusion chat host"
  );

  const hostSource = fs.readFileSync(path.join(root, "backend", "fusionChatHost.cjs"), "utf8");
  assert(
    hostSource.includes('else if (msg.type === "build-task") buildTask(msg.payload);') &&
      hostSource.includes("function buildTask(payload)") &&
      hostSource.includes('phase === "started"') &&
      hostSource.includes("state.builds.set(taskId, build)") &&
      hostSource.includes('type: "build-task"') &&
      hostSource.includes("state.pendingWakes.push(wake)") &&
      hostSource.includes("maybeFlushBackgroundWakes(id, state)") &&
      hostSource.includes("parseBuildReportEnvelope(text)"),
    "fusionChatHost should dispatch settled build tasks into the background wake queue"
  );
  const adapterSource = fs.readFileSync(path.join(root, "backend", "fusion-adapter.cjs"), "utf8");
  assert(
    adapterSource.includes('name: "codex_build_status"') &&
      adapterSource.includes('name: "codex_build_cancel"') &&
      adapterSource.includes('"codex_build_status"') &&
      adapterSource.includes('phase: "cancel-request"'),
    "fusion adapter should expose build status and cancel tools"
  );
  const wakeText = buildBuildWakeText({
    buildId: "build-smoke",
    command: "npm test",
    cwd: tempDir,
    status: "failed",
    exitCode: 3,
    tail: "expected build tail"
  });
  assert(wakeText.startsWith(FUSION_BUILD_REPORT_HEADER), "build wake text should use build report header");
  assert(wakeText.includes("exit code: 3"), "build wake text should include exit code");
  assert(wakeText.includes("expected build tail"), "build wake text should include log tail");
  const parsedBuildReport = parseBuildReportEnvelope(wakeText);
  assert(
    parsedBuildReport &&
      parsedBuildReport.taskId === "build-smoke" &&
      parsedBuildReport.title === "Build: npm test",
    "build report envelope should rehydrate as a report row"
  );

  console.log("fusion watch build smoke passed");
  if (process.platform === "win32") {
    console.log(
      `win32 wrapper: ${probeSpec.command} ${probeSpec.args.join(" ")} -> cmd.exe /d /s /v:on /c <command>, stdout/stderr fd=${path.join(buildsDir, "<buildId>.log")}, sentinel=${path.join(buildsDir, "<buildId>.exit")}`
    );
  } else {
    console.log(
      `posix wrapper: ${probeSpec.command} ${probeSpec.args.join(" ")} -> /bin/sh -c <command>, stdout/stderr fd=${path.join(buildsDir, "<buildId>.log")}, sentinel=${path.join(buildsDir, "<buildId>.exit")}`
    );
  }
}

main()
  .catch((error) => {
    console.error("fusion watch build smoke failed");
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
