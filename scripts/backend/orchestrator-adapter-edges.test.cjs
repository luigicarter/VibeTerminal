"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events");
const { installOrchestrator, createSessionDirectory } = require("../../backend/orchestratorIntegration.cjs");
const { interpretTestIntent } = require('./orchestrator-test-intent.cjs');

function harness(t, telemetry = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-adapter-edges-"));
  const ipc = new EventEmitter(); ipc.handlers = new Map(); ipc.handle = (name, fn) => ipc.handlers.set(name, fn);
  const app = new EventEmitter(); app.getPath = () => root;
  const ui = [], sent = [], opened = []; let manualInventory = false, inventory = [];
  const main = { isDestroyed: () => false, webContents: new EventEmitter() };
  const ack = (request, result) => ipc.emit("orchestrator:ui-result", { sender: main.webContents }, { id: request.id, result });
  main.webContents.send = (channel, request) => {
    if (channel !== "orchestrator:ui-action") return;
    ui.push(request);
    if (request.kind === "inventory" && !manualInventory) queueMicrotask(() => ack(request, { ok: true, sessions: inventory, projectPaths: [root] }));
  };
  const snapshot = { id: "p", generation: "g", launchToken: 1, provider: "terminal", processState: "running", turnState: "idle", cwd: root };
  const send = engine => message => { sent.push({ engine, ...message }); return true; };
  const integration = installOrchestrator({ interpretIntent: interpretTestIntent, app, ipcMain: ipc, BrowserWindow: { getAllWindows: () => [main] }, screen: {},
    shell: { openPath: async value => { opened.push(value); return ""; } }, safeStorage: { isEncryptionAvailable: () => false },
    getMainWindow: () => main, getRuntime: () => ({ listSnapshots: () => [snapshot] }),
    sendPty: send("terminal"), sendFusion: send("fusion"), sendOpenFusion: send("openfusion"), getTelemetry: () => telemetry, getChanges: () => ({}), ...options });
  t.after(async () => { await integration.dispose(); assert(path.resolve(root).startsWith(path.join(os.tmpdir(), "vibe-adapter-edges-"))); fs.rmSync(root, { recursive: true, force: true }); });
  return { integration, root, ui, sent, opened, snapshot, ack, manual: () => { manualInventory = true; }, setInventory: value => { inventory = value; },
    invoke: (name, payload = {}) => ipc.handlers.get(`orchestrator:${name}`)({ sender: main.webContents }, payload),
    hostAck: (message, extra = {}) => integration.incoming(message.engine, { type: "action-result", id: message.payload.id, generation: message.payload.generation, actionId: message.payload.actionId, ok: true, status: "written", ...extra }) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert(predicate(), "Expected adapter checkpoint was reached"); }

test("navigation waits for renderer acknowledgment and propagates rejected projects without host effects", async t => {
  const h = harness(t);
  const invalid = await h.invoke("dispatch", { kind: "navigate", view: "credentials" });
  assert.equal(invalid.ok, false);
  assert.equal(h.ui.filter(request => request.kind === "navigate").length, 0);
  for (const view of ["settings", "history", "orchestrator", "multi", "project"]) {
    let settled = false;
    const before = h.ui.length;
    const action = { kind: "navigate", view, ...(view === "project" ? { cwd: h.root } : {}) };
    const pending = h.invoke("dispatch", action).then(result => { settled = true; return result; });
    await until(() => h.ui.slice(before).some(request => request.kind === "navigate"));
    const request = h.ui.slice(before).find(request => request.kind === "navigate");
    await tick(); assert.equal(settled, false);
    assert.equal(request.payload.view, view);
    const result = view === "project" ? { ok: false, error: "That project is not open." } : { ok: true, status: "navigated", view };
    h.ack(request, result);
    assert.deepEqual(await pending, result);
  }
  assert.equal(h.sent.length, 0);
  assert.equal(h.opened.length, 0);
});

test("host acknowledgment must match engine, session, generation and action ID", async t => {
  const h = harness(t); let settled = false;
  const work = h.invoke("dispatch", { kind: "send_prompt", target: { id: "p", generation: "g" }, text: "hello" }).then(value => { settled = true; return value; });
  await until(() => h.sent.length === 1); const message = h.sent[0];
  h.integration.incoming("openfusion", { type: "action-result", id: "p", generation: "g", actionId: message.payload.actionId, ok: true });
  h.hostAck(message, { id: "other" }); h.hostAck(message, { generation: "old" }); h.hostAck(message, { actionId: "other" });
  await tick(); assert.equal(settled, false);
  h.snapshot.generation = "new"; // Correct late ACK still belongs to the original write.
  h.hostAck(message); assert.equal((await work).status, "written");
});

test("pending host action ID collision does not replace its original waiter", async t => {
  const h = harness(t); const start = h.integration.outgoing("openfusion", { type: "start", payload: { id: "chat", cwd: h.root } });
  h.integration.incoming("openfusion", { id: "chat", generation: start.payload.generation, type: "interaction-request", requestId: "permission", kind: "permission", revision: 1 });
  const payload = { id: "chat", generation: start.payload.generation, actionId: "same", kind: "permission", requestId: "permission", revision: 1, reply: "once" };
  const first = h.integration.answerExisting("openfusion", payload);
  const duplicate = await h.integration.answerExisting("openfusion", payload);
  assert.equal(duplicate.ok, false); assert.match(duplicate.error, /pending/); assert.equal(h.sent.length, 1);
  h.hostAck(h.sent[0]); assert.equal((await first).ok, true);
});

test("cancellation during path checks prevents file, folder and UI effects", async t => {
  const h = harness(t), file = path.join(h.root, "notes.txt"); fs.writeFileSync(file, "fixture");
  const original = fs.promises.realpath; t.after(() => { fs.promises.realpath = original; });
  for (const kind of ["open_file", "open_folder", "add_project"]) {
    const target = kind === "open_file" ? file : h.root; let entered = false, release;
    fs.promises.realpath = async value => { if (!entered && value === target) { entered = true; await new Promise(resolve => { release = resolve; }); } return original(value); };
    const work = h.invoke("dispatch", { kind, path: target }); await until(() => entered); await h.invoke("cancel"); release();
    assert.equal((await work).ok, false); assert.equal(h.opened.length, 0); assert.equal(h.ui.some(request => request.kind === "add_project"), false);
  }
});

test("overlapping inventory readers share one current pane snapshot", async t => {
  const h = harness(t); h.manual(); const first = h.integration.refreshInventory(), second = h.integration.refreshInventory();
  await until(() => h.ui.length === 1);
  h.ack(h.ui[0], { ok: true, sessions: [{ id: "new", name: "New" }], projectPaths: ["new-root"] }); await Promise.all([first, second]);
  assert.equal(h.ui.length, 1);
  assert(h.integration.directory.get("new")); assert.equal(h.integration.directory.get("old"), undefined); assert.deepEqual(h.integration.directory.projectPaths(), ["new-root"]);
});

test("UI cancellation after dispatch reports unknown without claiming a reverted effect", async t => {
  const h = harness(t); const work = h.invoke("dispatch", { kind: "close", target: { id: "p", generation: "g" } });
  await until(() => h.ui.some(request => request.kind === "close")); const request = h.ui.find(item => item.kind === "close");
  await h.invoke("cancel"); const result = await work; assert.equal(result.status, "unknown");
  h.ack(request, { ok: true, status: "close_requested" }); assert.equal(h.ui.filter(item => item.kind === "close").length, 1);
});

test("close receipts require fresh committed pane removal, while runtime orphans are not panes", async t => {
  const h = harness(t);
  const pane = { id: "p", launchToken: 1, kind: "terminal", cwd: h.root, projectId: "project" };
  h.setInventory([pane]);
  const work = h.invoke("dispatch", { kind: "close", target: { id: "p", generation: "g" } });
  await until(() => h.ui.some(request => request.kind === "close"));
  const request = h.ui.find(request => request.kind === "close");
  h.ack(request, { ok: true, status: "closed", close: { operationId: request.payload.actionId, target: request.payload.target,
    pane: "removed", process: "stopped", launchSettled: true } });
  const result = await work;
  assert.equal(result.ok, false); assert.equal(result.close.pane, "unknown");
  h.setInventory([]); await h.integration.refreshInventory();
  assert.equal(h.integration.directory.get("p").visiblePane, false);
});

test("failed fresh inventory prevents close mutation using cached pane metadata", async t => {
  const h = harness(t); h.setInventory([{ id: "p", launchToken: 1, kind: "terminal", cwd: h.root }]);
  await h.integration.refreshInventory(); h.manual();
  const before = h.ui.length;
  let settled = false;
  const work = h.invoke("dispatch", { kind: "close", target: { id: "p", generation: "g" } }).then(result => { settled = true; return result; });
  const acknowledged = new Set();
  for (let round = 0; round < 100 && !settled; round++) {
    await tick();
    for (const request of h.ui.slice(before).filter(item => item.kind === "inventory" && !acknowledged.has(item.id))) {
      acknowledged.add(request.id); h.ack(request, { ok: false, error: "Inventory unavailable" });
    }
  }
  assert.equal(settled, true);
  const result = await work;
  assert.equal(result.ok, false); assert.equal(h.ui.some(request => request.kind === "close"), false);
});

test("fresh inventory observes late stop proof after pane removal without another UI close", async t => {
  const queries = [];
  const h = harness(t, {}, { observeStoppedSession: async request => {
    queries.push(request);
    return { ok: true, operationId: request.operationId, process: "stopped", launchSettled: true };
  } });
  h.setInventory([{ id: "p", launchToken: 1, kind: "terminal", cwd: h.root }]);
  const work = h.invoke("dispatch", { kind: "close", target: { id: "p", generation: "g" } });
  await until(() => h.ui.some(request => request.kind === "close"));
  const request = h.ui.find(request => request.kind === "close");
  h.setInventory([]);
  h.ack(request, { ok: false, status: "close-partial", close: { operationId: request.payload.actionId, target: request.payload.target,
    pane: "removed", process: "unknown", launchSettled: false } });
  assert.equal((await work).ok, false);
  await h.integration.refreshInventory(); await until(() => queries.length === 1);
  assert.deepEqual(queries[0], { operationId: request.payload.actionId, id: "p", generation: "g", launchToken: 1, kind: "terminal", observeOnly: true });
  await h.integration.refreshInventory();
  assert.equal(queries.length, 1); assert.equal(h.ui.filter(request => request.kind === "close").length, 1);
  assert.equal(h.sent.length, 0);
});

test("cancellation or generation change while native Fusion interrupt awaits prevents later host effect", async t => {
  for (const mode of ["cancel", "restart"]) {
    let entered = false, release;
    const h = harness(t, { interruptFusionSession: async () => { entered = true; await new Promise(resolve => { release = resolve; }); } });
    const start = h.integration.outgoing("fusion", { type: "start", payload: { id: "chat", cwd: h.root } });
    const work = h.invoke("dispatch", { kind: "interrupt", target: { id: "chat", generation: start.payload.generation } }); await until(() => entered);
    if (mode === "cancel") await h.invoke("cancel");
    else { h.integration.outgoing("fusion", { type: "stop", payload: { id: "chat" } }); h.integration.outgoing("fusion", { type: "start", payload: { id: "chat", cwd: h.root } }); }
    release(); assert.equal((await work).ok, false); assert.equal(h.sent.length, 0);
  }
});

test("runtime conversation title wins over lagging UI name and known aliases remain usable", () => {
  const directory = createSessionDirectory({ getRuntime: () => ({ listSnapshots: () => [{ id: "p", generation: "g", provider: "codex", conversation: { title: "Fresh title" } }] }) });
  directory.updateUi([{ id: "p", name: "Old title", threadRef: { title: "Saved title" } }]);
  const session = directory.get("p"); assert.equal(session.name, "Fresh title"); assert.equal(session.conversationTitle, "Fresh title");
  assert.deepEqual(session.aliases, ["Old title", "Saved title", "Fresh title"]);
});

test("new pane acknowledgment waits for the matching live runtime before returning a target", async t => {
  const h = harness(t); h.setInventory([{ id: "created", kind: "codex", launchToken: 7 }]);
  let settled = false;
  const work = h.invoke("dispatch", { kind: "create_session", kindOfSession: "codex", cwd: h.root }).then(result => { settled = true; return result; });
  await until(() => h.ui.some(request => request.kind === "create_session"));
  h.ack(h.ui.find(request => request.kind === "create_session"), { ok: true, id: "created", launchToken: 7, status: "created" });
  await until(() => h.integration.directory.get("created")?.generation === "paused:created:7");
  await tick(); assert.equal(settled, false, "A renderer pane acknowledgment does not confirm a running process");
  Object.assign(h.snapshot, { id: "created", generation: "created-runtime", launchToken: 7, provider: "codex", processState: "running" });
  const result = await work;
  assert.deepEqual(result.target, { id: "created", generation: "created-runtime", launchToken: 7 });
  assert.equal(result.status, "created"); assert.equal(result.processState, "running");
  assert.equal(h.ui.filter(request => request.kind === "create_session").length, 1);
});
