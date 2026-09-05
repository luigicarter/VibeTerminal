"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events");
const { installOrchestrator, createSessionDirectory } = require("../../backend/orchestratorIntegration.cjs");

function harness(t, telemetry = {}) {
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
  const snapshot = { id: "p", generation: "g", provider: "terminal", processState: "running", turnState: "idle", cwd: root };
  const send = engine => message => { sent.push({ engine, ...message }); return true; };
  const integration = installOrchestrator({ app, ipcMain: ipc, BrowserWindow: { getAllWindows: () => [main] }, screen: {},
    shell: { openPath: async value => { opened.push(value); return ""; } }, safeStorage: { isEncryptionAvailable: () => false },
    getMainWindow: () => main, getRuntime: () => ({ listSnapshots: () => [snapshot] }),
    sendPty: send("terminal"), sendFusion: send("fusion"), sendOpenFusion: send("openfusion"), getTelemetry: () => telemetry, getChanges: () => ({}) });
  t.after(() => { integration.dispose(); assert(path.resolve(root).startsWith(path.join(os.tmpdir(), "vibe-adapter-edges-"))); fs.rmSync(root, { recursive: true, force: true }); });
  return { integration, root, ui, sent, opened, snapshot, ack, manual: () => { manualInventory = true; }, setInventory: value => { inventory = value; },
    invoke: (name, payload = {}) => ipc.handlers.get(`orchestrator:${name}`)({ sender: main.webContents }, payload),
    hostAck: (message, extra = {}) => integration.incoming(message.engine, { type: "action-result", id: message.payload.id, generation: message.payload.generation, actionId: message.payload.actionId, ok: true, status: "written", ...extra }) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert(predicate(), "Expected adapter checkpoint was reached"); }

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
  const payload = { id: "chat", generation: start.payload.generation, actionId: "same", kind: "permission" };
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

test("older inventory replies cannot regress newer applied pane identity", async t => {
  const h = harness(t); h.manual(); const first = h.integration.refreshInventory(), second = h.integration.refreshInventory();
  h.ack(h.ui[1], { ok: true, sessions: [{ id: "new", name: "New" }], projectPaths: ["new-root"] }); await second;
  h.ack(h.ui[0], { ok: true, sessions: [{ id: "old", name: "Old" }], projectPaths: ["old-root"] }); await first;
  assert(h.integration.directory.get("new")); assert.equal(h.integration.directory.get("old"), undefined); assert.deepEqual(h.integration.directory.projectPaths(), ["new-root"]);
});

test("UI cancellation after dispatch reports unknown without claiming a reverted effect", async t => {
  const h = harness(t); const work = h.invoke("dispatch", { kind: "close", target: { id: "p", generation: "g" } });
  await until(() => h.ui.some(request => request.kind === "close")); const request = h.ui.find(item => item.kind === "close");
  await h.invoke("cancel"); const result = await work; assert.equal(result.status, "unknown");
  h.ack(request, { ok: true, status: "close_requested" }); assert.equal(h.ui.filter(item => item.kind === "close").length, 1);
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

test("new pane acknowledgment retains launch identity while inventory target remains provisional", async t => {
  const h = harness(t); h.setInventory([{ id: "created", kind: "codex", launchToken: 7 }]);
  const work = h.invoke("dispatch", { kind: "create_session", kindOfSession: "codex", cwd: h.root });
  await until(() => h.ui.some(request => request.kind === "create_session"));
  h.ack(h.ui.find(request => request.kind === "create_session"), { ok: true, id: "created", launchToken: 7, status: "created" });
  const result = await work; assert.deepEqual(result.target, { id: "created", generation: "paused:created:7", launchToken: 7 }); assert.equal(result.status, "created");
});
