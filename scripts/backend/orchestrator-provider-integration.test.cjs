"use strict";
// Real integration composition and IPC bridges; engine acknowledgments are fixtures.
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { installOrchestrator } = require("../../backend/orchestratorIntegration.cjs");

function harness(t, provider, state = "idle") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-provider-integration-"));
  const ipc = new EventEmitter(); ipc.handlers = new Map(); ipc.handle = (key, fn) => ipc.handlers.set(key, fn);
  const app = new EventEmitter(); app.getPath = () => root; app.isPackaged = false;
  const main = { isDestroyed: () => false, webContents: new EventEmitter() };
  const sent = [], uiActions = [], steers = [];
  let integration, steerResult = { status: "steered" };
  const chat = ["fusion", "openfusion"].includes(provider);
  const snapshot = { id: "pane", generation: "generation-1", provider, cwd: root, processState: "running", agentProcessState: "running", turnState: state, turnId: "turn-1", revision: 1 };
  main.webContents.send = (channel, p) => {
    if (channel !== "orchestrator:ui-action") return;
    uiActions.push(p);
    const result = p.kind === "inventory" ? { ok: true, projectPaths: [root], sessions: [{ id: "pane", name: provider, kind: provider, cwd: root, started: true }] } : { ok: true, status: "staged" };
    queueMicrotask(() => ipc.emit("orchestrator:ui-result", { sender: main.webContents }, { id: p.id, result }));
  };
  const sender = engine => message => {
    sent.push({ engine, ...message });
    queueMicrotask(() => integration.incoming(engine, { id: message.payload.id, generation: message.payload.generation, type: "action-result", actionId: message.payload.actionId, ok: true, status: engine === "terminal" ? "written" : message.type === "steer" ? "steered" : "accepted" }));
    return true;
  };
  integration = installOrchestrator({ app, BrowserWindow: { getAllWindows: () => [main] }, ipcMain: ipc, screen: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => false }, getMainWindow: () => main,
    getRuntime: () => ({ listSnapshots: () => chat ? [] : [snapshot] }), sendPty: sender("terminal"), sendFusion: sender("fusion"), sendOpenFusion: sender("openfusion"),
    getTelemetry: () => ({ steerFusionSession: async (id, text) => { steers.push({ id, text }); return steerResult; } }), getChanges: () => ({}) });
  if (chat) {
    snapshot.generation = integration.outgoing(provider, { type: "start", payload: { id: "pane", cwd: root, mode: "plan" } }).payload.generation;
    integration.incoming(provider, { id: "pane", generation: snapshot.generation, type: state === "running" ? "turn-start" : "result" });
  } else {
    integration.incoming("terminal", { id: "pane", generation: snapshot.generation, type: "agent-process", phase: "start", pid: 12345 });
  }
  const invoke = (name, p = {}) => ipc.handlers.get(`orchestrator:${name}`)({ sender: main.webContents }, p);
  t.after(() => { integration.dispose(); const resolved = path.resolve(root); assert(resolved.startsWith(path.join(os.tmpdir(), "vibe-provider-integration-"))); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { integration, sent, steers, uiActions, snapshot, invoke, setSteer: value => { steerResult = value; },
    send: (text = "Exact payload; keep every qualifier") => invoke("dispatch", { kind: "send_prompt", target: { id: "pane", generation: snapshot.generation }, text }) };
}

for (const provider of ["fusion", "openfusion"]) {
  for (const state of ["idle", "running"]) test(`${provider} ${state}: exact structured input crosses real integration bridge and returns host acknowledgment`, async t => {
    const h = harness(t, provider, state); const reply = await h.send();
    assert.equal(reply.ok, true); assert.equal(h.sent.length, 1);
    const message = h.sent[0]; assert.equal(message.engine, provider); assert.equal(message.payload.text, "Exact payload; keep every qualifier"); assert.equal(message.payload.generation, h.snapshot.generation); assert(message.payload.actionId);
    assert.equal(message.type, provider === "fusion" && state === "running" ? "steer" : "input");
    if (provider === "fusion" && state === "running") { assert.equal(reply.status, "steered"); assert.equal(message.payload.routed, true); assert.equal(h.steers.length, 1); }
    else { assert.equal(reply.status, "accepted"); assert.equal(h.steers.length, 0); }
    if (provider === "openfusion") assert.equal(message.payload.mode, "plan");
  });
  test(`${provider}: current permission blocks all prompt transport`, async t => {
    const h = harness(t, provider); await h.integration.refreshInventory();
    h.integration.incoming(provider, { id: "pane", generation: h.snapshot.generation, type: "interaction-request", interaction: { id: "permission-1", sessionId: "pane", generation: h.snapshot.generation, revision: 1, kind: "permission", detail: "Allow?" } });
    const reply = await h.send(); assert.equal(reply.ok, false); assert.match(reply.error, /pending interaction/); assert.equal(h.sent.length, 0); assert.equal(h.steers.length, 0);
  });
}
for (const status of ["routing", "skipped", "unknown", "failed"]) test(`Fusion steering ${status} never emits duplicate input`, async t => {
  const h = harness(t, "fusion", "running"); h.setSteer({ status }); const reply = await h.send();
  assert.equal(h.steers.length, 1);
  if (["routing", "skipped"].includes(status)) { assert.equal(reply.ok, true); assert.equal(h.sent.length, 1); assert.equal(h.sent[0].type, "steer"); assert.equal(h.sent[0].payload.routed, status === "routing"); }
  else { assert.equal(reply.ok, false); assert.equal(reply.status, "unknown"); assert.equal(h.sent.length, 0); }
});

for (const provider of ["claude", "codex", "cursor", "gemini", "kimi", "kimi-custom", "qwen", "opencode"]) {
  test(`${provider}: long idle observed parent accepts once, rejects stale, queues busy then delivers`, async t => {
    const h = harness(t, provider);
    h.integration.incoming("terminal", { id: "pane", generation: h.snapshot.generation, type: "data", data: "", outputAt: Date.now() - 86400000 });
    const delivered = await h.send(); assert.equal(delivered.status, "written"); assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].payload.expectedAgentPid, 12345); assert.equal(h.sent[0].payload.recipientEvidence.generation, h.snapshot.generation); assert.equal(h.sent[0].payload.data, "Exact payload; keep every qualifier\r");
    const stale = await h.invoke("dispatch", { kind: "send_prompt", target: { id: "pane", generation: "old-generation" }, text: "never" }); assert.equal(stale.ok, false); assert.equal(h.sent.length, 1);
    h.snapshot.turnState = "running"; h.snapshot.turnId = "turn-2";
    const queued = await h.send("Queue exactly this"); assert.equal(queued.status, "queued"); assert.equal(h.sent.length, 1);
    h.snapshot.turnState = "completed"; h.snapshot.turnEndedAt = Date.now();
    await h.integration.refreshInventory(); assert.equal(h.sent.length, 2); assert.equal(h.sent[1].payload.data, "Queue exactly this\r");
    await h.integration.refreshInventory(); assert.equal(h.sent.length, 2);
  });
  test(`${provider}: unverified parent is staged, pending permission is rejected`, async t => {
    const h = harness(t, provider); h.snapshot.agentProcessState = "unknown";
    const staged = await h.send(); assert.equal(staged.status, "staged"); assert.equal(h.sent.length, 0); assert.equal(h.uiActions.filter(a => a.kind === "stage_draft").length, 1);
    h.snapshot.agentProcessState = "running"; await h.integration.refreshInventory();
    h.integration.incoming("terminal", { id: "pane", generation: h.snapshot.generation, type: "interaction-request", interaction: { id: "permission-1", sessionId: "pane", generation: h.snapshot.generation, revision: 1, kind: "permission", detail: "Allow?" } });
    const pending = await h.send(); assert.equal(pending.ok, false); assert.match(pending.error, /pending interaction/); assert.equal(h.sent.length, 0);
  });
}
