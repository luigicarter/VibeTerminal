"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { installOrchestrator } = require("../../backend/orchestratorIntegration.cjs");

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-launch-integration-"));
  const ipc = new EventEmitter(); ipc.handlers = new Map(); ipc.handle = (name, fn) => ipc.handlers.set(name, fn);
  const app = new EventEmitter(); app.getPath = () => root;
  const main = { isDestroyed: () => false, webContents: new EventEmitter() };
  const sessions = [], snapshots = [], uiActions = [];
  let created;
  const admitted = new Promise(resolve => { created = resolve; });
  main.webContents.send = (channel, action) => {
    if (channel !== "orchestrator:ui-action") return;
    uiActions.push(action.kind);
    let result;
    if (action.kind === "inventory") result = { ok: true, sessions, projectPaths: [root] };
    else if (action.kind === "create_session") {
      sessions.push({ id: "pane", launchToken: 1, started: true, kind: "terminal", cwd: root });
      result = { ok: true, id: "pane", launchToken: 1, status: "starting" }; created();
    } else throw Error(`Unexpected UI action ${action.kind}`);
    queueMicrotask(() => ipc.emit("orchestrator:ui-result", { sender: main.webContents }, { id: action.id, result }));
  };
  const integration = installOrchestrator({ app, ipcMain: ipc, BrowserWindow: { getAllWindows: () => [main] },
    screen: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => false }, getMainWindow: () => main,
    getRuntime: () => ({ listSnapshots: () => snapshots }), getTelemetry: () => ({}), getChanges: () => ({}),
    sendPty: () => { throw Error("Creation wait must not write terminal input"); }, sendFusion: () => false, sendOpenFusion: () => false });
  t.after(async () => {
    await integration.dispose();
    assert(path.resolve(root).startsWith(path.join(os.tmpdir(), "vibe-launch-integration-")));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { integration, admitted, snapshots, uiActions,
    create: () => ipc.handlers.get("orchestrator:dispatch")({ sender: main.webContents }, { kind: "create_session", kindOfSession: "terminal", cwd: root }),
    runtime: { id: "pane", generation: "actual-generation", launchToken: 1, provider: "terminal", cwd: root, turnState: "idle", revision: 1 } };
}

test("public creation waits for both process and launcher, never acknowledging a paused target", async t => {
  const f = await fixture(t); let settled = false;
  const pending = f.create().then(value => { settled = true; return value; });
  await f.admitted; await new Promise(setImmediate);
  assert.equal(settled, false, "adding pane state cannot finish creation");
  f.snapshots.push({ ...f.runtime, processState: "running", launchState: "pending" });
  f.integration.incoming("terminal", { id: "pane", generation: f.runtime.generation, type: "created", pid: 123 });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(settled, false, "a process awaiting its launcher cannot finish creation");
  f.snapshots[0].launchState = "ready";
  const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.processState, "running");
  assert.equal(result.target.generation, f.runtime.generation);
  assert.equal(f.uiActions.filter(kind => kind === "create_session").length, 1);
});

test("public creation reports launch failure while retaining the created pane identity", async t => {
  const f = await fixture(t);
  const pending = f.create(); await f.admitted;
  f.snapshots.push({ ...f.runtime, processState: "failed", binding: { message: "Missing executable" } });
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.status, "launch-failed");
  assert.equal(result.id, "pane"); assert.equal(result.target, undefined);
  assert.match(result.error, /Missing executable/);
  assert.equal(f.uiActions.filter(kind => kind === "create_session").length, 1);
});
