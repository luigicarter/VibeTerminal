const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

function load(relative) {
  const filename = path.resolve(__dirname, "../../frontend", relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => name === "./sessionLaunch" ? load("sessionLaunch.ts") : originalRequire(name);
  loaded._compile(compiled, filename);
  return loaded.exports;
}
const { createTerminalLaunchCoordinator } = load("terminalLaunchCoordinator.ts");
const flush = () => new Promise(resolve => setImmediate(resolve));
const session = (id, patch = {}) => ({
  id, name: id, kind: "terminal", command: "echo launched", cwd: "C:/repo",
  started: true, launchToken: 1, nextLaunchMode: "new", ...patch
});
function harness(create) {
  let sessions = [];
  const calls = [], errors = [];
  const coordinator = createTerminalLaunchCoordinator({
    platform: "win32",
    create: payload => { calls.push(payload); return create ? create(payload) : Promise.resolve({ ok: true }); },
    isCurrent: candidate => sessions.some(current => current.id === candidate.id && current.started && current.launchToken === candidate.launchToken),
    onError: (candidate, message) => errors.push({ id: candidate.id, message })
  });
  return { coordinator, calls, errors, reconcile(next) { sessions = next; coordinator.reconcile(next); } };
}

test("started sessions launch across hidden projects, Multi and maximized peers without a pane", async () => {
  const h = harness();
  h.reconcile([session("inactive-project"), session("hidden-multi"), session("maximized-peer"),
    session("paused-restore", { started: false }), session("fusion", { fusion: true }), session("openfusion", { openFusion: true })]);
  await flush();
  assert.deepEqual(h.calls.map(call => call.id), ["inactive-project", "hidden-multi", "maximized-peer"]);
  assert(h.calls.every(call => call.cols === undefined && call.rows === undefined));
});

test("workspace navigation, metadata changes and StrictMode effect replay never relaunch a token", async () => {
  const h = harness();
  h.reconcile([session("one")]);
  h.coordinator.suspend();
  h.reconcile([session("one")]);
  await flush();
  h.reconcile([session("one", { name: "generated title", command: "different command", status: "done" })]);
  h.coordinator.suspend();
  h.reconcile([session("one")]);
  await flush();
  assert.equal(h.calls.length, 1);
  h.reconcile([session("one", { launchToken: 2 })]);
  await flush();
  assert.deepEqual(h.calls.map(call => call.launchToken), [1, 2]);
});

test("close, pause, restart and unmount fence queued preparation", async () => {
  const h = harness();
  h.reconcile([session("closed"), session("paused"), session("restarted"), session("stopped")]);
  h.coordinator.cancel("stopped", 1);
  h.reconcile([session("paused", { started: false }), session("restarted", { launchToken: 2 }), session("stopped")]);
  await flush();
  assert.deepEqual(h.calls.map(call => [call.id, call.launchToken]), [["restarted", 2]]);
  const unmounted = harness();
  unmounted.reconcile([session("unmounted")]);
  unmounted.coordinator.suspend();
  await flush();
  assert.equal(unmounted.calls.length, 0);
});

test("shared launcher preserves resume, shell quoting, model and custom provider options", async () => {
  const h = harness();
  const threadRef = { provider: "claude", id: "saved thread", createdAt: 1, updatedAt: 1 };
  h.reconcile([session("custom", { kind: "claude", command: "claude", nextLaunchMode: "resume",
    threadRef, providerProfileId: "profile-1", providerModelOverride: "model-1" })]);
  await flush();
  assert.equal(h.calls[0].command, "claude --resume 'saved thread'");
  assert.equal(h.calls[0].threadRef, threadRef);
  assert.equal(h.calls[0].providerProfileId, "profile-1");
  assert.equal(h.calls[0].providerModelOverride, "model-1");
});

test("failed launch reports once and requires a new token to retry", async () => {
  const h = harness(() => Promise.resolve({ ok: false, error: "Invalid launch folder" }));
  h.reconcile([session("failed")]);
  await flush();
  h.reconcile([session("failed")]);
  await flush();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.errors, [{ id: "failed", message: "Invalid launch folder" }]);
  h.reconcile([session("failed", { launchToken: 2 })]);
  await flush();
  assert.equal(h.calls.length, 2);
});

test("closing or restarting during backend preparation ignores stale results", async () => {
  const pending = [];
  const h = harness(() => new Promise(resolve => pending.push(resolve)));
  h.reconcile([session("closed"), session("restarted")]);
  await flush();
  h.coordinator.cancel("closed", 1);
  h.reconcile([session("restarted", { launchToken: 2 })]);
  await flush();
  pending[0]({ ok: false, error: "Old close failure" });
  pending[1]({ ok: false, error: "Old generation failure" });
  pending[2]({ ok: true });
  await flush();
  assert.deepEqual(h.errors, []);
});

test("IPC rejection is handled and cancelled backend launches stay silent", async () => {
  const rejected = harness(() => Promise.reject(new Error("Host unavailable")));
  rejected.reconcile([session("rejected")]);
  await flush();
  assert.deepEqual(rejected.errors, [{ id: "rejected", message: "Host unavailable" }]);
  const cancelled = harness(() => Promise.resolve({ ok: false, cancelled: true }));
  cancelled.reconcile([session("cancelled")]);
  await flush();
  assert.deepEqual(cancelled.errors, []);
});
