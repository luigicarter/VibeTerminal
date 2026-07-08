const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { createBuildSupervisor, tailFile } = require("../../backend/buildSupervisor.cjs");

process.env.VIBE_BUILD_LIVENESS_GRACE_MS = "50";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-supervisor-smoke-"));
let supervisor = null;
let rehydratedSupervisor = null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = fn();
    if (value) return value;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

async function caseSentinelCompletion(events) {
  const buildId = "case-a-sentinel";
  const logPath = path.join(root, "case-a.log");
  const sentinelPath = path.join(root, "case-a.exit");
  const childCode = `
const fs = require("fs");
const [logPath, sentinelPath] = process.argv.slice(1);
process.on("exit", (code) => {
  fs.writeFileSync(sentinelPath, String(code) + "\\n", "utf8");
});
fs.appendFileSync(logPath, "case-a build started\\n", "utf8");
setTimeout(() => {
  fs.appendFileSync(logPath, "case-a expected log tail\\n", "utf8");
  process.exit(0);
}, 50);
`;
  const child = spawn(process.execPath, ["-e", childCode, logPath, sentinelPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();

  supervisor.register({
    buildId,
    sessionId: "fusion-session-a",
    command: "node case-a",
    cwd: root,
    pid: child.pid,
    logPath,
    sentinelPath,
    startedAt: Date.now()
  });

  const event = await waitForCondition(
    () => events.find((item) => item.buildId === buildId),
    5000,
    "sentinel completion"
  );
  const entry = supervisor.get(buildId);
  assert.strictEqual(entry.status, "exited", "sentinel completion should exit cleanly");
  assert.strictEqual(entry.sessionId, "fusion-session-a", "session id should be retained");
  assert.strictEqual(event.sessionId, "fusion-session-a", "settled event should include session id");
  assert.strictEqual(event.id, "fusion-session-a", "settled event id should route to the session");
  assert.strictEqual(entry.exitCode, 0, "sentinel completion should capture exit code");
  assert(
    event.tail.includes("case-a expected log tail"),
    "settled event should include logfile tail"
  );
  assert.strictEqual(
    events.filter((item) => item.buildId === buildId && item.phase === "settled").length,
    1,
    "sentinel completion should emit exactly one settled event"
  );
}

async function caseCrashBackstop(events) {
  const buildId = "case-b-crash";
  const dead = spawn(process.execPath, ["-e", ""], {
    stdio: "ignore",
    windowsHide: true
  });
  await waitForExit(dead);

  supervisor.register({
    buildId,
    command: "node case-b",
    cwd: root,
    pid: dead.pid,
    logPath: path.join(root, "case-b.log"),
    sentinelPath: path.join(root, "case-b.exit"),
    startedAt: Date.now() - 1000
  });

  const event = await waitForCondition(
    () => events.find((item) => item.buildId === buildId),
    5000,
    "crash backstop"
  );
  const entry = supervisor.get(buildId);
  assert.strictEqual(entry.status, "failed", "dead pid without sentinel should fail");
  assert.strictEqual(entry.exitCode, null, "dead pid without sentinel has no exit code");
  assert.strictEqual(event.status, "failed", "crash event should be failed");
  assert.strictEqual(
    events.filter((item) => item.buildId === buildId && item.phase === "settled").length,
    1,
    "crash backstop should emit exactly one settled event"
  );
}

async function caseCancel(events) {
  const buildId = "case-c-cancel";
  const logPath = path.join(root, "case-cancel.log");
  const sentinelPath = path.join(root, "case-cancel.exit");
  const childCode = `
setInterval(() => {}, 1000);
`;
  const child = spawn(process.execPath, ["-e", childCode], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  fs.writeFileSync(logPath, "case-cancel expected log tail\n", "utf8");

  supervisor.register({
    buildId,
    sessionId: "fusion-session-cancel",
    command: "node case-cancel",
    cwd: root,
    pid: child.pid,
    logPath,
    sentinelPath,
    startedAt: Date.now()
  });

  assert(
    tailFile(logPath).includes("case-cancel expected log tail"),
    "exported tailFile should read log tails"
  );
  const entry = supervisor.cancel(buildId);
  assert(entry, "cancel should return the cancelled entry");
  assert.strictEqual(entry.status, "cancelled", "cancel should mark entry cancelled");
  const event = await waitForCondition(
    () => events.find((item) => item.buildId === buildId),
    5000,
    "cancel settled event"
  );
  assert.strictEqual(event.status, "cancelled", "cancel event should be cancelled");
  assert.strictEqual(event.sessionId, "fusion-session-cancel", "cancel event should include session id");
  assert.strictEqual(event.exitCode, null, "cancel event should not invent an exit code");
  assert(
    events.filter((item) => item.buildId === buildId && item.phase === "settled").length === 1,
    "cancel should emit exactly one settled event"
  );
}

async function casePersistence() {
  const buildId = "case-d-rehydrated";
  const logPath = path.join(root, "case-d.log");
  const sentinelPath = path.join(root, "case-d.exit");
  fs.writeFileSync(logPath, "case-d rehydrate started\n", "utf8");
  supervisor.register({
    buildId,
    sessionId: "fusion-session-d",
    command: "node case-d",
    cwd: root,
    pid: process.pid,
    logPath,
    sentinelPath,
    startedAt: Date.now()
  });
  assert.strictEqual(supervisor.get(buildId).status, "running", "case-d should start running");

  supervisor.cleanup();
  supervisor = null;

  const events = [];
  rehydratedSupervisor = createBuildSupervisor({
    baseDir: root,
    pollMs: 100,
    emit: (event) => events.push(event)
  });
  const rehydrated = rehydratedSupervisor.get(buildId);
  assert(rehydrated, "running entry should rehydrate from registry");
  assert.strictEqual(rehydrated.status, "running", "rehydrated entry should remain running");
  assert.strictEqual(rehydrated.sessionId, "fusion-session-d", "rehydrated entry should keep session id");
  rehydratedSupervisor.start();

  fs.appendFileSync(logPath, "case-d expected log tail\n", "utf8");
  fs.writeFileSync(sentinelPath, "0\n", "utf8");

  const event = await waitForCondition(
    () => events.find((item) => item.buildId === buildId),
    5000,
    "rehydrated sentinel completion"
  );
  const entry = rehydratedSupervisor.get(buildId);
  assert.strictEqual(entry.status, "exited", "rehydrated entry should be watched");
  assert.strictEqual(event.sessionId, "fusion-session-d", "rehydrated settled event should include session id");
  assert.strictEqual(entry.exitCode, 0, "rehydrated entry should capture sentinel exit code");
  assert(
    event.tail.includes("case-d expected log tail"),
    "rehydrated settled event should include logfile tail"
  );
  assert.strictEqual(
    events.filter((item) => item.buildId === buildId && item.phase === "settled").length,
    1,
    "rehydrated entry should emit exactly one settled event"
  );
}

async function main() {
  const events = [];
  supervisor = createBuildSupervisor({
    baseDir: root,
    pollMs: 100,
    emit: (event) => events.push(event)
  });
  supervisor.start();

  await caseSentinelCompletion(events);
  await caseCrashBackstop(events);
  await caseCancel(events);
  await casePersistence();

  console.log("build supervisor smoke passed");
}

main()
  .catch((error) => {
    console.error("build supervisor smoke failed");
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (supervisor) supervisor.cleanup();
    if (rehydratedSupervisor) rehydratedSupervisor.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });
