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

test('numeric zero generation dispatch and receipts preserve nested target identity', async () => {
  const h = harness(); h.s.generation = 0;
  const action = h.action('zero', { target: { id: 'p', generation: 0 }, generation: 'stale-fallback' });
  const delivered = await h.delivery.submit(action);
  assert.equal(delivered.status, 'written');
  assert.equal(delivered.generation, 0);
  assert.equal(h.writes[0].generation, 0);
  assert.equal((await h.delivery.submit(action)).generation, 0);
  assert.equal(h.writes.length, 1);
});

test('forget retires queued zero-generation delivery without writing to its replacement', async () => {
  const h = harness(); Object.assign(h.s, { generation: 0, turnState: 'running' });
  const action = h.action('zero-queued', { target: { id: 'p', generation: 0 } });
  assert.equal((await h.delivery.submit(action)).status, 'queued');
  h.delivery.forget('p', 0);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].status, 'stale-generation');
  assert.equal(h.updates[0].generation, 0);
  Object.assign(h.s, { generation: 1, turnState: 'idle' });
  await h.delivery.pump();
  assert.equal(h.writes.length, 0);
  assert.equal((await h.delivery.submit(action)).status, 'stale-generation');
});

for (const cancel of [false, true]) test(`zero-generation queued delivery ${cancel ? 'cancels' : 'dispatches'} once when readiness changes`, async () => {
  const h = harness(); Object.assign(h.s, { generation: 0, turnState: 'running' });
  const controller = new AbortController();
  const action = h.action('zero-queued', { target: { id: 'p', generation: 0 }, signal: controller.signal });
  assert.equal((await h.delivery.submit(action)).status, 'queued');
  if (cancel) controller.abort();
  Object.assign(h.s, { turnState: 'completed', turnId: 'ready' });
  await h.delivery.pump(); await h.delivery.pump();
  assert.equal(h.writes.length, cancel ? 0 : 1);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].generation, 0);
  assert.equal(h.updates[0].status, cancel ? 'cancelled' : 'written');
});
test("busy queues, observes readiness, and prevents another send on old idle evidence", async () => {
  const h = harness(); h.s.turnState = "running";
  assert.equal((await h.delivery.submit(h.action("a"))).status, "queued");
  h.s.turnState = "completed"; h.s.turnId = "one";
  await h.delivery.pump(); assert.equal(h.writes.length, 1);
  assert.equal(h.updates[0].status, "written");
  assert.equal(h.updates[0].inputDisposition, 'submitted-when-ready');
  assert.deepEqual(h.updates[0].deliveryBaseline, { submittedAt: 100000, kind: "codex", turnId: "one", turnState: "completed" });
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
    assert.equal(h.writes.length, 0, mode); assert.equal(h.drafts.length, 0, mode);
    assert.equal(h.updates[0].status, { cancel: "cancelled", restart: "stale-generation", question: "blocked", expiry: "blocked" }[mode]);
  }
});

test('observed healthy busy work keeps queued prompts beyond two minutes until ready', async () => {
  const h = harness(); Object.assign(h.s, { turnState: 'running', turnId: 'old', observation: 'observed' });
  await h.delivery.submit(h.action('long'));
  for (let i = 0; i < 4; i++) { h.advance(); await h.delivery.pump(); }
  assert.equal(h.writes.length, 0); assert.equal(h.updates.length, 0);
  Object.assign(h.s, { turnState: 'completed' });
  await h.delivery.pump();
  assert.equal(h.writes.length, 1); assert.equal(h.updates[0].status, 'written');
  assert.equal(h.updates[0].deliveryBaseline.submittedAt, 580004);
});

test('explicit busy state queues and retains a prompt just like running state', async () => {
  const h = harness(); Object.assign(h.s, { turnState: 'busy', turnId: 'old', observation: 'observed' });
  assert.equal((await h.delivery.submit(h.action('busy-alias'))).status, 'queued');
  h.advance(); await h.delivery.pump(); assert.equal(h.updates.length, 0); assert.equal(h.writes.length, 0);
  h.s.turnState = 'idle'; await h.delivery.pump(); assert.equal(h.writes.length, 1);
});

test('first resumed sample ready after two minutes delivers queued prompt exactly once', async () => {
  const h = harness(); Object.assign(h.s, { turnState: 'running', turnId: 'old', observation: 'observed' });
  const action = h.action('resumed'); await h.delivery.submit(action);
  h.advance(); h.s.turnState = 'completed';
  await h.delivery.pump(); await h.delivery.pump();
  assert.equal(h.writes.length, 1); assert.equal(h.updates.length, 1);
  assert.equal((await h.delivery.submit(action)).status, 'written'); assert.equal(h.writes.length, 1);
});

test('prewrite attribution callback precedes transport without publishing a receipt', async () => {
  const order = []; let h;
  h = harness({ reserveInput: () => { order.push('reserve'); }, onBeforeWrite: metadata => {
    order.push('prepare'); assert.equal(metadata.status, 'unconfirmed'); assert.equal(metadata.ok, true);
    assert.equal(metadata.actionId, 'ordered'); assert.equal(metadata.id, 'p'); assert.equal(metadata.generation, 'g');
    assert.equal(metadata.inputDisposition, 'submitted-when-ready'); assert.equal(metadata.deliveryBaseline.turnId, 'ready-turn');
    assert.equal(h.updates.length, 0); assert.equal(h.writes.length, 0);
  }, write: async () => { order.push('write'); return { ok: true, status: 'written' }; } });
  Object.assign(h.s, { turnState: 'running', turnId: 'busy', observation: 'observed' });
  await h.delivery.submit(h.action('ordered')); assert.deepEqual(order, []);
  Object.assign(h.s, { turnState: 'completed', turnId: 'ready-turn' }); await h.delivery.pump();
  assert.deepEqual(order, ['reserve', 'prepare', 'write']); assert.equal(h.updates.length, 1);
});

test('prewrite callback failure or cancellation proves no dispatch and rolls back reservation', async () => {
  for (const mode of ['failure', 'cancel']) {
    const controller = new AbortController(); let rolledBack = 0, written = 0;
    const h = harness({ reserveInput: () => () => { rolledBack++; },
      onBeforeWrite: () => { if (mode === 'failure') throw new Error('Preparation failed'); controller.abort(); },
      write: async () => { written++; return { ok: true, status: 'written' }; } });
    const result = await h.delivery.submit(h.action(mode, { signal: controller.signal }));
    assert.equal(written, 0); assert.equal(rolledBack, 1); assert.equal(result.delivery, 'not-dispatched');
    assert.equal(result.status, mode === 'failure' ? 'rejected' : 'cancelled');
  }
});

test('expired queue behind an unresolved delivery lock does not bypass the lock', async () => {
  const h = harness(); h.s.observation = 'observed';
  await h.delivery.submit(h.action('first'));
  await h.delivery.submit(h.action('second'));
  h.advance(); await h.delivery.pump();
  assert.equal(h.writes.length, 1); assert.equal(h.updates[0].status, 'blocked');
});

test('write-failed status without no-write proof retains reservation and uncertainty lock', async () => {
  for (const status of ['write-failed', 'unconfirmed', 'uncertain']) {
    let writes = 0, rollbacks = 0;
    const h = harness({ reserveInput: () => () => { rollbacks++; },
      write: async () => { writes++; return { ok: false, status, error: 'PTY write acknowledgment failed', reason: 'Transport may have accepted bytes' }; } });
    const action = h.action('uncertain-write');
    const result = await h.delivery.submit(action);
    assert.equal(result.status, 'unknown'); assert.equal(result.ok, false);
    assert.equal(result.error, 'PTY write acknowledgment failed'); assert.equal(result.reason, 'Transport may have accepted bytes');
    assert.equal(result.deliveryBaseline.submittedAt, 100000); assert.equal(result.inputDisposition, 'submitted-when-ready');
    assert.equal(rollbacks, 0);
    assert.equal((await h.delivery.submit(action)).status, 'unknown'); assert.equal(writes, 1);
    assert.equal((await h.delivery.submit(h.action('next'))).status, 'queued');
    await h.delivery.pump(); assert.equal(writes, 1); assert.equal(rollbacks, 0);
  }
});

test('write-failed with explicit not-dispatched proof remains recoverable', async () => {
  let writes = 0, rollbacks = 0;
  const h = harness({ reserveInput: () => () => { rollbacks++; },
    write: async () => { writes++; return writes === 1 ? { ok: false, status: 'write-failed', delivery: 'not-dispatched', error: 'Nothing written' } : { ok: true, status: 'written' }; } });
  const result = await h.delivery.submit(h.action('unsent'));
  assert.equal(result.status, 'write-failed'); assert.equal(result.delivery, 'not-dispatched');
  assert.equal(result.inputDisposition, undefined); assert.equal(rollbacks, 1);
  assert.equal((await h.delivery.submit(h.action('retry'))).status, 'written'); assert.equal(writes, 2);
});

test('extended busy queues still cancel or reject lost readiness without a write', async () => {
  for (const mode of ['cancel', 'restart', 'waiting', 'unknown']) {
    const h = harness(); Object.assign(h.s, { turnState: 'running', observation: 'observed' });
    const controller = new AbortController(); await h.delivery.submit(h.action(mode, { signal: controller.signal }));
    h.advance(); await h.delivery.pump();
    if (mode === 'cancel') controller.abort();
    else if (mode === 'restart') h.s.generation = 'new';
    else h.s.turnState = mode;
    await h.delivery.pump();
    assert.equal(h.writes.length, 0); assert.equal(h.updates.length, 1);
    assert.equal(h.updates[0].ok, false);
  }
});

test('actual attempted writes expose idle disposition, but proven unsent rejection does not', async () => {
  for (const outcome of [{ ok: false, status: 'unknown' }, { ok: false, status: 'rejected', delivery: 'not-dispatched' }]) {
    const h = harness({ write: async () => outcome });
    const result = await h.delivery.submit(h.action('a'));
    assert.equal(result.inputDisposition, outcome.delivery ? undefined : 'submitted-when-ready');
  }
  const h = harness({ write: async () => { throw new Error('ack unavailable'); } });
  assert.equal((await h.delivery.submit(h.action('a'))).inputDisposition, 'submitted-when-ready');
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
    assert.equal((await h.delivery.submit(h.action("a"))).status, "blocked");
    assert.equal((await h.delivery.submit(h.action("a"))).delivery, "not-dispatched"); assert.equal(h.drafts.length, 0);
    h.s.processState = "exited";
    assert.equal((await h.delivery.submit(h.action("b"))).status, "not-running");
    assert.equal(h.writes.length, 0);
  }
});
test("unknown acknowledgment keeps delivery lock and a definite rejection releases it", async () => {
  const h = harness({ write: async () => ({ ok: false, status: "unknown" }) });
  assert.equal((await h.delivery.submit(h.action("a"))).status, "unknown");
  assert.equal((await h.delivery.submit(h.action("b"))).status, "queued");
  const j = harness({ write: async () => ({ ok: false, status: "write-failed", delivery: 'not-dispatched' }) });
  assert.equal((await j.delivery.submit(j.action("a"))).status, "write-failed");
  assert.equal((await j.delivery.submit(j.action("b"))).status, "write-failed");
});
test("occupied user input blocks and rolls back the submission reservation", async () => {
  let rollbackCount = 0;
  const h = harness({ reserveInput: () => () => { rollbackCount++; }, write: async () => ({ ok: false, status: "input-buffer-occupied" }) });
  assert.equal((await h.delivery.submit(h.action("a"))).status, "blocked");
  assert.equal(h.drafts.length, 0); assert.equal(rollbackCount, 1);
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
  const events = [], terminals = [], timers = new Map(); let timerId = 0;
  const flushSubmit = () => { for (const [id, timer] of [...timers]) { timers.delete(id); assert.equal(timer.ms, 200); timer.fn(); } return events.at(-1); };
  const context = vm.createContext({ require: name => name === "node-pty" ? { spawn() { const t = { pid: 42, writes: [], onData(fn) { this.data = fn; }, onExit() {}, resize() {}, kill() {}, write(data) { this.writes.push(data); } }; terminals.push(t); return t; } } : name === "readline" ? { createInterface: () => ({ on() {} }) } : name === './observedStop.cjs' ? require('../../backend/observedStop.cjs') : name === '../shared/terminalControls.cjs' ? require('../../shared/terminalControls.cjs') : require('node:module').createRequire(path.resolve(__dirname, '../../backend/ptyHost.cjs'))(name), process: { platform: "win32", env: {}, stdin: {}, cwd: () => process.cwd(), stdout: { write: line => events.push(JSON.parse(line)) }, kill() {} }, setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../backend/ptyHost.cjs"), "utf8"), context);
  context.handleMessage({ type: "create", payload: { id: "p", generation: "g", launchToken: 1 } });
  const send = (actionId, promptText = "one\ntwo") => { context.handleMessage({ type: "action", payload: { id: "p", generation: "g", actionId, kind: "input", data: promptText + "\r", promptText, expectedAgentPid: 42, recipientEvidence: { generation: "g", pid: 42, state: "idle", observedAt: Date.now() } } }); return events.at(-1); };
  assert.equal(send("a").status, "needs-staging");
  for (const chunk of ["\x1b", "[", "?20", "04h"]) terminals[0].data(chunk);
  send("b"); send("b");
  assert.deepEqual(terminals[0].writes, ["\x1b[200~one\ntwo\x1b[201~"]);
  assert.equal(flushSubmit().status, "written"); send("b");
  assert.deepEqual(terminals[0].writes, ["\x1b[200~one\ntwo\x1b[201~", "\r"]);
  terminals[0].data("\x1b[?2004l");
  assert.equal(send("c").status, "needs-staging");
  assert.equal(send("d", "hello\x03").status, "invalid-action");
  const manual = data => context.handleMessage({ type: "input", payload: { id: "p", generation: "g", data } });
  for (const [index, report] of ["\x1b[O", "\x1b[I", "\x1b[12;80R", "\x1b[?12;80R", "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[0n"].entries()) {
    manual(report);
    send(`report${index}`, "background prompt"); assert.equal(flushSubmit().status, "written");
  }
  manual("unfinished user text");
  manual("\x1b[O"); manual("\x1b[1;1R"); manual("\x1b[?1;2c");
  const count = terminals[0].writes.length;
  terminals[0].data("some output\r\n");
  assert.equal(send("e", "another prompt").status, "input-buffer-occupied");
  assert.equal(terminals[0].writes.length, count);
  assert(terminals[0].writes.includes("unfinished user text"));
  manual("\r");
  send("f", "another prompt"); assert.equal(flushSubmit().status, "written");
  manual("\x1b[A");
  assert.equal(send("g", "another prompt").status, "input-buffer-occupied");
  manual("\x03");
  send("h", "another prompt"); assert.equal(flushSubmit().status, "written");
});


test('delivery abort, cancel and disposal reach an in-flight native submission without rollback', async () => {
  for (const mode of ['abort', 'cancel', 'dispose']) {
    const controller = new AbortController(); let signal, rollbacks = 0;
    const h = harness({ reserveInput: () => () => { rollbacks++; }, write: payload => {
      signal = payload.signal;
      return new Promise(resolve => signal.addEventListener('abort', () => resolve({ ok: false, status: 'unknown', partialWrite: true, submission: 'unconfirmed' }), { once: true }));
    } });
    const pending = h.delivery.submit(h.action('split', { signal: controller.signal }));
    await new Promise(setImmediate); assert.equal(signal.aborted, false);
    if (mode === 'abort') controller.abort(); else h.delivery[mode]();
    const result = await pending; assert.equal(signal.aborted, true); assert.equal(result.status, 'unknown'); assert.equal(result.partialWrite, true); assert.equal(rollbacks, 0);
  }
});
