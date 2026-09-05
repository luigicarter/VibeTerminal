"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createOrchestratorDelivery } = require("../../backend/orchestratorDelivery.cjs");
const { createTerminalRuntime } = require("../../backend/terminalRuntime.cjs");
function harness(extra = {}) {
  let time = 100000;
  const s = { id: "p", generation: "g", provider: "codex", processState: "running", agentProcessState: "running", agentPid: 42, turnState: "idle", lastActivityAt: 1 };
  const writes = [], drafts = [], updates = [];
  const delivery = createOrchestratorDelivery({ getSession: () => s, now: () => time, write: async p => { writes.push(p); return { ok: true, status: "written", delivery: "pty-transport-only" }; }, stage: async (a, reason) => { drafts.push({ a, reason }); return { ok: true, status: "staged" }; }, onUpdate: r => updates.push(r), ...extra });
  return { s, writes, drafts, updates, delivery, advance: () => { time += 120001; }, action: (actionId, rest = {}) => ({ actionId, target: { id: "p", generation: "g" }, text: "hello", ...rest }) };
}
test("long-idle agent uses background transport and action IDs deduplicate", async () => {
  const h = harness();
  assert.equal((await h.delivery.submit(h.action("a"))).status, "written");
  assert.equal((await h.delivery.submit(h.action("a"))).status, "written");
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].recipientEvidence.observedAt, 100000);
  assert.equal(h.writes[0].promptText, "hello");
  assert.equal(h.drafts.length, 0);
});
test("busy queues, observes readiness, and prevents another send on old idle evidence", async () => {
  const h = harness(); h.s.turnState = "running";
  assert.equal((await h.delivery.submit(h.action("a"))).status, "queued");
  h.s.turnState = "completed"; h.s.turnId = "one";
  await h.delivery.pump(); assert.equal(h.writes.length, 1);
  assert.equal(h.updates[0].status, "written");
  assert.equal((await h.delivery.submit(h.action("b"))).status, "queued");
  h.s.revision = 999; h.s.lastActivityAt = 100001;
  await h.delivery.pump(); assert.equal(h.writes.length, 1);
  h.s.turnState = "running"; await h.delivery.pump();
  h.s.turnState = "completed"; await h.delivery.pump();
  assert.equal(h.writes.length, 2);
});
test("cancel, restart, pending question and expiry never inject queued work", async () => {
  for (const mode of ["cancel", "restart", "question", "expiry"]) {
    const h = harness(); h.s.turnState = "running";
    const controller = new AbortController();
    await h.delivery.submit(h.action("a", { signal: controller.signal }));
    if (mode === "cancel") controller.abort();
    if (mode === "restart") h.s.generation = "new";
    if (mode === "question") h.s.turnState = "waiting";
    if (mode === "expiry") h.advance();
    await h.delivery.pump();
    assert.equal(h.writes.length, 0, mode);
    assert.equal(h.updates[0].status, { cancel: "cancelled", restart: "stale-generation", question: "staged", expiry: "staged" }[mode]);
  }
});
test("cancelling queued work after transport dispatch preserves the actual acknowledgment", async () => {
  for (const outcome of [{ ok: true, status: "written" }, { ok: false, status: "unknown" }, { ok: false, status: "needs-staging" }]) {
    let resolveWrite, writeCount = 0;
    const h = harness({ write: () => { writeCount++; return new Promise(resolve => { resolveWrite = resolve; }); } });
    const controller = new AbortController(); h.s.turnState = "running";
    const action = h.action("a", { signal: controller.signal });
    assert.equal((await h.delivery.submit(action)).status, "queued");
    h.s.turnState = "completed";
    const pumping = h.delivery.pump();
    assert.equal(writeCount, 1);
    controller.abort(); h.delivery.cancel(); h.delivery.forget("p", "g");
    assert.equal(h.updates.length, 0);
    resolveWrite(outcome); await pumping;
    assert.equal(h.updates.length, 1);
    assert.equal(h.updates[0].status, outcome.status);
    assert.equal((await h.delivery.submit(action)).status, outcome.status);
    assert.equal(writeCount, 1); assert.equal(h.drafts.length, 0);
  }
});
test("unobserved and stopped providers report honest outcomes", async () => {
  for (const provider of ["codex", "claude", "cursor", "gemini", "opencode", "kimi", "kimi-custom", "qwen"]) {
    const h = harness(); h.s.provider = provider; h.s.turnState = "unknown";
    assert.equal((await h.delivery.submit(h.action("a"))).status, "staged");
    h.s.processState = "exited";
    assert.equal((await h.delivery.submit(h.action("b"))).status, "not-running");
    assert.equal(h.writes.length, 0);
  }
});
test("unknown acknowledgment keeps delivery lock and a definite rejection releases it", async () => {
  const h = harness({ write: async () => ({ ok: false, status: "unknown" }) });
  assert.equal((await h.delivery.submit(h.action("a"))).status, "unknown");
  assert.equal((await h.delivery.submit(h.action("b"))).status, "queued");
  const j = harness({ write: async () => ({ ok: false, status: "write-failed" }) });
  assert.equal((await j.delivery.submit(j.action("a"))).status, "write-failed");
  assert.equal((await j.delivery.submit(j.action("b"))).status, "write-failed");
});
test("occupied user input stages and rolls back the submission reservation", async () => {
  let rollbackCount = 0;
  const h = harness({ reserveInput: () => () => { rollbackCount++; }, write: async () => ({ ok: false, status: "input-buffer-occupied" }) });
  assert.equal((await h.delivery.submit(h.action("a"))).status, "staged");
  assert.equal(h.drafts.length, 1); assert.equal(rollbackCount, 1);
});
test("submitted text reserves runtime input and rollback cannot clear a later observation", () => {
  const runtime = createTerminalRuntime();
  const { generation } = runtime.beginLaunch({ id: "p", provider: "codex", launchToken: 1 });
  const record = runtime.getRecord("p"); record.snapshot.processState = "running"; record.snapshot.turnState = "idle";
  const reserved = runtime.recordInput({ id: "p", generation, data: "a multiline\nprompt\r" });
  assert.equal(reserved.pendingInput, "submit");
  assert.equal(runtime.releaseInput(reserved).pendingInput, undefined);
  const second = runtime.recordInput({ id: "p", generation, data: "next\r" });
  record.snapshot.revision++;
  assert.equal(runtime.releaseInput(second), null);
  assert.equal(runtime.getSnapshot("p").pendingInput, "submit");
  runtime.dispose();
});
test("PTY multiline framing follows split bracketed-paste mode and deduplicates writes", () => {
  const events = [], terminals = [];
  const context = vm.createContext({ require: name => name === "node-pty" ? { spawn() { const t = { pid: 42, writes: [], onData(fn) { this.data = fn; }, onExit() {}, resize() {}, kill() {}, write(data) { this.writes.push(data); } }; terminals.push(t); return t; } } : name === "readline" ? { createInterface: () => ({ on() {} }) } : require(name), process: { platform: "win32", env: {}, stdin: {}, cwd: () => process.cwd(), stdout: { write: line => events.push(JSON.parse(line)) }, kill() {} }, setTimeout() {} });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../backend/ptyHost.cjs"), "utf8"), context);
  context.handleMessage({ type: "create", payload: { id: "p", generation: "g", launchToken: 1 } });
  const send = (actionId, promptText = "one\ntwo") => { context.handleMessage({ type: "action", payload: { id: "p", generation: "g", actionId, kind: "input", data: promptText + "\r", promptText, expectedAgentPid: 42, recipientEvidence: { generation: "g", pid: 42, state: "idle", observedAt: Date.now() } } }); return events.at(-1); };
  assert.equal(send("a").status, "needs-staging");
  for (const chunk of ["\x1b", "[", "?20", "04h"]) terminals[0].data(chunk);
  assert.equal(send("b").status, "written"); send("b");
  assert.deepEqual(terminals[0].writes, ["\x1b[200~one\ntwo\x1b[201~\r"]);
  terminals[0].data("\x1b[?2004l");
  assert.equal(send("c").status, "needs-staging");
  assert.equal(send("d", "hello\x03").status, "invalid-action");
  const manual = data => context.handleMessage({ type: "input", payload: { id: "p", generation: "g", data } });
  for (const [index, report] of ["\x1b[O", "\x1b[I", "\x1b[12;80R", "\x1b[?12;80R", "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[0n"].entries()) {
    manual(report);
    assert.equal(send(`report${index}`, "background prompt").status, "written");
  }
  manual("unfinished user text");
  manual("\x1b[O"); manual("\x1b[1;1R"); manual("\x1b[?1;2c");
  const count = terminals[0].writes.length;
  terminals[0].data("some output\r\n");
  assert.equal(send("e", "another prompt").status, "input-buffer-occupied");
  assert.equal(terminals[0].writes.length, count);
  assert(terminals[0].writes.includes("unfinished user text"));
  manual("\r");
  assert.equal(send("f", "another prompt").status, "written");
  manual("\x1b[A");
  assert.equal(send("g", "another prompt").status, "input-buffer-occupied");
  manual("\x03");
  assert.equal(send("h", "another prompt").status, "written");
});
