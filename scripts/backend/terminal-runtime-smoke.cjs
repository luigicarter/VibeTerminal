"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { StringDecoder } = require("node:string_decoder");
const { createTerminalRuntime: makeTerminalRuntime } = require("../../backend/terminalRuntime.cjs");
const providerCapabilities = require("../../shared/providerCapabilities.json");
const createTerminalRuntime = (options = {}) => makeTerminalRuntime({
  capabilities: (provider) => providerCapabilities[provider] || {}, ...options
});
const root = path.resolve(__dirname, "../..");

async function runtimeChecks() {
  let now = 10000;
  const runtime = createTerminalRuntime({ now: () => now });
  const first = runtime.beginLaunch({ id: "a", launchToken: 1, provider: "codex", cwd: root });
  assert.equal(runtime.beginLaunch({ id: "a", launchToken: 1 }).disposition, "attach");
  assert.equal(runtime.beginLaunch({ id: "a", launchToken: 0 }).disposition, "stale");
  const event = (type, detail = {}) => runtime.ingest({ id: "a", generation: first.generation, type, rootVerified: true, ...detail });
  event("created");
  event("data", { data: "done" });
  assert.equal(runtime.getSnapshot("a").turnState, "unknown", "output must not manufacture completion");
  event("agent-running", { providerThreadId: "root", providerTurnId: "turn1", turnStart: true });
  event("agent-activity", { phase: "start", toolId: "t", toolName: "Read" });
  event("agent-activity", { phase: "stop", toolId: "t", toolName: "Read" });
  assert.equal(runtime.getSnapshot("a").lastTool.name, "Read");
  assert.equal(runtime.getSnapshot("a").activeTools.length, 0);
  event("agent-subagent", { phase: "start", taskId: "child" });
  event("agent-attention", { providerThreadId: "root", providerTurnId: "turn1", attention: { state: "completed" } });
  assert.equal(runtime.getSnapshot("a").turnState, "completed");
  assert.equal(runtime.getSnapshot("a").turnEndedAt, now);
  assert.equal(runtime.getSnapshot("a").childActivity, true, "root completion does not erase child evidence");
  event("agent-running", { providerThreadId: "child", providerTurnId: "child-turn" });
  assert.equal(runtime.getSnapshot("a").turnState, "completed");
  event("agent-running", { providerThreadId: "root", providerTurnId: "turn2", turnStart: true });
  event("agent-running", { providerThreadId: "root", providerTurnId: "turn1", turnStart: false });
  assert.equal(runtime.getSnapshot("a").turnId, "turn2", "late old tool cannot replace active turn identity");
  event("agent-attention", { providerThreadId: "root", providerTurnId: "turn1", attention: { state: "completed" } });
  assert.equal(runtime.getSnapshot("a").turnState, "running", "old turn completion must be ignored");
  event("agent-attention", { providerThreadId: "root", providerTurnId: "turn2", attention: { state: "waiting", reason: "approval" } });
  const waitingStartedAt = runtime.getSnapshot("a").turnStartedAt;
  event("agent-running", { providerThreadId: "root", providerTurnId: "turn2", turnStart: false });
  assert.equal(runtime.getSnapshot("a").attention, undefined, "observed approval resume clears waiting attention");
  assert.equal(runtime.getSnapshot("a").turnStartedAt, waitingStartedAt);
  event("agent-process", { phase: "start", processId: "root-process" });
  event("agent-process", { phase: "start", processId: "nested-process" });
  event("agent-process", { phase: "exit", processId: "nested-process", exitCode: 1 });
  assert.equal(runtime.getSnapshot("a").agentProcessState, "running", "nested CLI exit cannot fail root process");
  event("agent-process", { phase: "exit", processId: "root-process", exitCode: 0 });
  assert.equal(runtime.getSnapshot("a").agentProcessState, "exited");
  event("agent-process", { phase: "start", processId: "root-process" });
  assert.equal(runtime.getSnapshot("a").agentProcessState, "exited", "late duplicate start cannot resurrect settled process");
  assert.equal(runtime.getSnapshot("a").turnState, "running", "process settlement never invents task success");
  event("agent-process", { phase: "start", processId: "later-process" });
  assert.equal(runtime.getSnapshot("a").agentProcessState, "exited", "new implicit invocation cannot reuse old conversation binding");
  assert.equal(runtime.getSnapshot("a").turnState, "running", "CLI exit is not task completion");
  event("exit", { exitCode: 0 });
  assert.equal(runtime.getSnapshot("a").processState, "exited");
  assert.equal(runtime.getSnapshot("a").conversation.id, "root", "shell exit retains binding");
  const second = runtime.beginLaunch({ id: "a", launchToken: 2, provider: "codex", cwd: root });
  event("title", { title: "stale" });
  assert.equal(runtime.getSnapshot("a").terminalTitle, undefined);
  assert.equal(runtime.matches({ id: "a", generation: first.generation }), false);
  runtime.stop({ id: "a", generation: second.generation });
  assert.equal(runtime.isCurrent("a", second.generation), false);
  assert.equal(runtime.listSnapshots().length, 0);
  assert.equal(runtime.beginLaunch({ id: "a", launchToken: 2 }).disposition, "stale");

  let calls = 0;
  const discovery = createTerminalRuntime({ now: () => now, lookup: async (payload) => {
    calls += 1;
    if (calls === 1) return { status: "pending" };
    return payload.confirmId ? { status: "found", threadRef: { id: payload.confirmId, title: "renamed", titleSource: "named" } } :
      { status: "found", threads: [{ id: "new", createdAt: 10000, title: "preview", titleSource: "preview" }] };
  } });
  discovery.beginLaunch({ id: "b", launchToken: 1, provider: "codex", cwd: root });
  await discovery.refresh();
  now += 120000;
  await discovery.refresh();
  assert.equal(discovery.getSnapshot("b").conversation.id, "new", "metadata continues beyond old 90s ceiling");
  now += 8000;
  await discovery.refresh();
  assert.equal(discovery.getSnapshot("b").conversation.title, "renamed");
  const unverified = createTerminalRuntime({ now: () => 10000 });
  const unverifiedLaunch = unverified.beginLaunch({ id: "u", launchToken: 1, provider: "gemini", cwd: root });
  for (const details of [{ rootVerified: false }, { rootVerified: false, parentThreadId: "parent" }]) {
    unverified.ingest({ id: "u", generation: unverifiedLaunch.generation, type: "agent-attention",
      providerThreadId: "child", attention: { state: "completed" }, ...details });
    assert.equal(unverified.getSnapshot("u").turnState, "unknown");
    assert.equal(unverified.getSnapshot("u").conversation, undefined);
  }
  const incomplete = createTerminalRuntime({ now: () => 10000, lookup: async () => ({ status: "found", complete: false,
    threads: [{ id: "partial", createdAt: 10000 }] }) });
  incomplete.beginLaunch({ id: "i", launchToken: 1, provider: "gemini", cwd: root });
  await incomplete.refresh();
  assert.equal(incomplete.getSnapshot("i").conversation, undefined);
  assert.equal(incomplete.getSnapshot("i").binding.status, "pending");
  let finishLookup;
  const racing = createTerminalRuntime({ now: () => 10000, lookup: () => new Promise((resolve) => { finishLookup = resolve; }) });
  const raceLaunch = racing.beginLaunch({ id: "r", launchToken: 1, provider: "codex", cwd: root });
  const pendingLookup = racing.refresh();
  racing.ingest({ id: "r", generation: raceLaunch.generation, type: "agent-running", providerThreadId: "native-root", rootVerified: true });
  await Promise.resolve();
  finishLookup({ status: "pending", threads: [] });
  await pendingLookup;
  assert.equal(racing.getSnapshot("r").conversation.id, "native-root");
  assert.equal(racing.getSnapshot("r").binding.status, "found");
  let verifyHint;
  const hinted = createTerminalRuntime({ now: () => 10000, lookup: (payload) => {
    assert.equal(payload.confirmId, "root-hint");
    return new Promise((resolve) => { verifyHint = resolve; });
  } });
  const hintedLaunch = hinted.beginLaunch({ id: "h", launchToken: 1, provider: "codex", cwd: root });
  hinted.ingest({ id: "h", generation: hintedLaunch.generation, type: "agent-attention", providerThreadId: "root-hint",
    providerTurnId: "finished", attention: { state: "completed" } });
  assert.equal(hinted.getSnapshot("h").turnState, "unknown");
  assert.equal(hinted.getSnapshot("h").conversation, undefined);
  const verifying = hinted.refresh();
  await Promise.resolve();
  verifyHint({ status: "found", rootVerified: true, threadRef: { id: "root-hint" } });
  await verifying;
  assert.equal(hinted.getSnapshot("h").turnState, "completed", "completion replays only after root metadata proof");
  const childFirst = createTerminalRuntime({ now: () => 10000, lookup: async (payload) => payload.confirmId ?
    { status: "found", rootVerified: false, threadRef: { id: payload.confirmId } } : { status: "found", threads: [] } });
  const childFirstLaunch = childFirst.beginLaunch({ id: "cf", launchToken: 1, provider: "codex", cwd: root });
  childFirst.ingest({ id: "cf", generation: childFirstLaunch.generation, type: "agent-attention", providerThreadId: "unknown-child",
    attention: { state: "completed" } });
  await childFirst.refresh();
  assert.equal(childFirst.getSnapshot("cf").conversation, undefined);
  assert.equal(childFirst.getSnapshot("cf").turnState, "unknown", "first inherited notify cannot self-bind root");
  const coarse = createTerminalRuntime();
  const coarseLaunch = coarse.beginLaunch({ id: "coarse", launchToken: 1, provider: "claude", cwd: root });
  const coarseEvent = (phase) => coarse.ingest({ id: "coarse", generation: coarseLaunch.generation,
    type: "agent-subagent", phase });
  coarseEvent("start"); coarseEvent("start"); coarseEvent("stop");
  assert.equal(coarse.getSnapshot("coarse").childActivity, true);
  assert.equal(coarse.getSnapshot("coarse").children.length, 0, "anonymous parallel work is not an exact child count");
  coarseEvent("stop");
  assert.equal(coarse.getSnapshot("coarse").childActivity, false);
  coarse.ingest({ id: "coarse", generation: coarseLaunch.generation, type: "agent-activity", phase: "start", toolName: "Task" });
  assert.equal(coarse.getSnapshot("coarse").childActivity, true);
  assert.equal(coarse.getSnapshot("coarse").children.length, 0);
  let dedupNow = 10000;
  const dedup = createTerminalRuntime({ now: () => dedupNow });
  const dedupLaunch = dedup.beginLaunch({ id: "d", launchToken: 1, provider: "codex", cwd: root,
    threadRef: { provider: "codex", id: "dedup-root" } });
  const dedupEvent = (type, details) => dedup.ingest({ id: "d", generation: dedupLaunch.generation,
    providerThreadId: "dedup-root", type, ...details });
  dedupEvent("agent-running", { providerTurnId: "t1", turnStart: true });
  dedupEvent("agent-attention", { providerTurnId: "t1", attention: { state: "completed", reason: "done" } });
  const firstAttention = dedup.getSnapshot("d").attention;
  const firstEnd = dedup.getSnapshot("d").turnEndedAt;
  dedupNow += 1000;
  dedupEvent("agent-attention", { providerTurnId: "t1", attention: { id: "transport-retry", state: "completed", reason: "done" } });
  assert.deepEqual(dedup.getSnapshot("d").attention, firstAttention, "duplicate completion preserves occurrence identity and time");
  assert.equal(dedup.getSnapshot("d").turnEndedAt, firstEnd);
  dedupEvent("agent-running", { providerTurnId: "t2", turnStart: true });
  dedupEvent("agent-attention", { providerTurnId: "t2", attention: { state: "waiting", reason: "approval" } });
  const waitingAttention = dedup.getSnapshot("d").attention;
  dedupNow += 1000;
  dedupEvent("agent-attention", { providerTurnId: "t2", attention: { state: "waiting", reason: "approval" } });
  assert.deepEqual(dedup.getSnapshot("d").attention, waitingAttention, "duplicate wait preserves occurrence identity and time");
  dedupEvent("agent-running", { providerTurnId: "t2", turnStart: false });
  dedupEvent("agent-attention", { providerTurnId: "t2", attention: { state: "completed", reason: "done" } });
  const secondAttention = dedup.getSnapshot("d").attention;
  assert.notEqual(secondAttention.id, firstAttention.id, "a genuine new turn gets a fresh completion occurrence");
  dedupEvent("agent-attention", { providerTurnId: "t1", attention: { state: "completed", reason: "done" } });
  assert.deepEqual(dedup.getSnapshot("d").attention, secondAttention, "old-turn completion remains rejected");
  const finality = createTerminalRuntime();
  const kimiLaunch = finality.beginLaunch({ id: "kimi-finality", launchToken: 1, provider: "kimi", cwd: root,
    threadRef: { provider: "kimi", id: "kimi-root" } });
  const kimiEvent = (type, details) => finality.ingest({ id: "kimi-finality", generation: kimiLaunch.generation,
    providerThreadId: "kimi-root", type, ...details });
  kimiEvent("agent-subagent", { phase: "start" });
  kimiEvent("agent-attention", { attention: { state: "completed", reason: "done" } });
  assert.equal(finality.getSnapshot("kimi-finality").turnState, "response");
  assert.equal(finality.getSnapshot("kimi-finality").observation, "provisional");
  kimiEvent("agent-subagent", { phase: "stop" });
  assert.equal(finality.getSnapshot("kimi-finality").childActivity, false);
  assert.equal(finality.getSnapshot("kimi-finality").turnState, "response", "coarse child Stop never auto-promotes to root completion");
  assert.equal(finality.getSnapshot("kimi-finality").attention, undefined);
  kimiEvent("agent-attention", { providerTurnId: "coarse-native-id", attention: { state: "completed", reason: "done" } });
  assert.equal(finality.getSnapshot("kimi-finality").turnState, "response", "coarse capability remains provisional even with ids");
  const exactLaunch = finality.beginLaunch({ id: "exact-finality", launchToken: 1, provider: "codex", cwd: root,
    threadRef: { provider: "codex", id: "exact-root" } });
  const exactEvent = (type, details) => finality.ingest({ id: "exact-finality", generation: exactLaunch.generation,
    providerThreadId: "exact-root", type, ...details });
  exactEvent("agent-subagent", { phase: "start", taskId: "known-child" });
  exactEvent("agent-attention", { attention: { state: "completed", reason: "done" } });
  assert.equal(finality.getSnapshot("exact-finality").turnState, "response", "authoritative provider still requires native turn attribution");
  exactEvent("agent-attention", { providerTurnId: "exact-turn", attention: { state: "completed", reason: "done" } });
  assert.equal(finality.getSnapshot("exact-finality").turnState, "completed");
  assert.equal(finality.getSnapshot("exact-finality").childActivity, true);
  exactEvent("agent-subagent", { phase: "stop", taskId: "known-child" });
  assert.equal(finality.getSnapshot("exact-finality").childActivity, false);
  assert.equal(finality.getSnapshot("exact-finality").turnState, "completed", "attributable root result remains valid after known child closes");
  const intent = createTerminalRuntime();
  const intentLaunch = intent.beginLaunch({ id: "intent", launchToken: 1, provider: "codex", cwd: root,
    threadRef: { provider: "codex", id: "notify-root" } });
  const intentEvent = (type, details = {}) => intent.ingest({ id: "intent", generation: intentLaunch.generation,
    providerThreadId: "notify-root", type, ...details });
  const input = (data) => intent.recordInput({ id: "intent", generation: intentLaunch.generation, data });
  intentEvent("created");
  const initialRevision = intent.getSnapshot("intent").revision;
  input("typing"); input("\x1b[A"); input("pasted\ntext"); input("\x03");
  assert.equal(intent.getSnapshot("intent").revision, initialRevision, "typing, paste, menu navigation and idle interrupts are not task signals");
  input("\r");
  assert.equal(intent.getSnapshot("intent").turnState, "unknown");
  assert.equal(intent.getSnapshot("intent").pendingInput, "submit");
  intentEvent("agent-attention", { providerTurnId: "notify1", attention: { state: "completed", reason: "done" } });
  assert.equal(intent.getSnapshot("intent").turnState, "completed");
  assert.equal(intent.getSnapshot("intent").pendingInput, undefined);
  const notifyFirst = intent.getSnapshot("intent").attention;
  intentEvent("agent-attention", { providerTurnId: "notify2", attention: { state: "completed", reason: "done" } });
  assert.equal(intent.getSnapshot("intent").turnId, "notify2", "second notify-only turn is accepted without a start hook");
  assert.equal(intent.getSnapshot("intent").turnStartedAt, undefined, "notify-only duration remains unknown");
  assert.notEqual(intent.getSnapshot("intent").attention.id, notifyFirst.id);
  const notifySecond = intent.getSnapshot("intent").attention;
  intentEvent("agent-attention", { providerTurnId: "notify2", attention: { state: "completed", reason: "done" } });
  intentEvent("agent-attention", { providerTurnId: "notify1", attention: { state: "completed", reason: "done" } });
  assert.deepEqual(intent.getSnapshot("intent").attention, notifySecond, "duplicate and late-old notify cannot create a new occurrence");
  input("\r");
  intentEvent("agent-attention", { providerTurnId: "notify2", attention: { state: "completed", reason: "done" } });
  assert.equal(intent.getSnapshot("intent").pendingInput, "submit", "prior-turn notify cannot fulfill a pending submission");
  assert.equal(intent.getSnapshot("intent").attention, undefined);
  intentEvent("agent-attention", { providerTurnId: "notify3", attention: { state: "completed", reason: "done" } });
  assert.equal(intent.getSnapshot("intent").pendingInput, undefined);
  assert.equal(intent.getSnapshot("intent").turnId, "notify3");
  intentEvent("agent-running", { providerTurnId: "observed4", turnStart: true });
  input("\x1b");
  assert.equal(intent.getSnapshot("intent").pendingInput, "interrupt");
  assert.equal(intent.getSnapshot("intent").turnState, "running", "requested interrupt does not assert turn ended");
  assert.equal(intent.getSnapshot("intent").turnEndedAt, undefined);
  intentEvent("agent-activity", { providerTurnId: "observed4", phase: "start", toolId: "tool4", toolName: "Read" });
  assert.equal(intent.getSnapshot("intent").pendingInput, undefined, "native activity clears an interrupt menu request");
  assert.equal(intent.getSnapshot("intent").observation, "observed");
  input("\x03");
  assert.equal(intent.getSnapshot("intent").pendingInput, "interrupt");
  intentEvent("agent-running", { providerTurnId: "observed4", turnStart: false });
  assert.equal(intent.getSnapshot("intent").pendingInput, undefined);
  intentEvent("agent-attention", { providerTurnId: "conflicting5", attention: { state: "completed" } });
  assert.equal(intent.getSnapshot("intent").turnId, "observed4", "notify-only shortcut cannot replace a conflicting observed active turn");
  intentEvent("agent-attention", { providerTurnId: "observed4", attention: { state: "completed", reason: "done" } });
  input("\r");
  intentEvent("agent-activity", { phase: "start", toolId: "unknown-turn-tool", toolName: "Read" });
  assert.equal(intent.getSnapshot("intent").turnId, undefined, "id-less new activity does not retain retired turn identity");
  intentEvent("agent-attention", { providerTurnId: "observed6", attention: { state: "completed", reason: "done" } });
  assert.equal(intent.getSnapshot("intent").turnState, "completed");
  assert.equal(intent.getSnapshot("intent").turnId, "observed6");
  intentEvent("agent-running", { providerTurnId: "approval7", turnStart: true });
  const runningRevision = intent.getSnapshot("intent").revision;
  input("\r");
  assert.equal(intent.getSnapshot("intent").revision, runningRevision, "Enter during observed work is steering, not a new pending submission");
  assert.equal(intent.getSnapshot("intent").observation, "observed");
  assert.equal(intent.getSnapshot("intent").pendingInput, undefined);
  intentEvent("agent-attention", { providerTurnId: "approval7", attention: { state: "waiting", reason: "approval" } });
  input("\r");
  assert.equal(intent.getSnapshot("intent").pendingInput, "submit");
  intentEvent("agent-attention", { providerTurnId: "approval7", attention: { state: "completed", reason: "done" } });
  assert.equal(intent.getSnapshot("intent").turnState, "completed", "approval Enter allows legitimate same-turn completion");
  assert.equal(intent.getSnapshot("intent").pendingInput, undefined);
  intentEvent("agent-running", { providerTurnId: "interrupt8", turnStart: true });
  input("\x03"); input("\r");
  assert.equal(intent.getSnapshot("intent").pendingInput, "submit");
  intentEvent("agent-running", { providerTurnId: "interrupt8", turnStart: false });
  intentEvent("agent-attention", { providerTurnId: "interrupt8", attention: { state: "completed", reason: "done" } });
  assert.equal(intent.getSnapshot("intent").pendingInput, "submit", "delayed old tool/notify cannot consume interrupt-then-submit intent");
  assert.equal(intent.getSnapshot("intent").observation, "provisional");
  intentEvent("agent-running", { providerTurnId: "new9", turnStart: true });
  assert.equal(intent.getSnapshot("intent").pendingInput, undefined);
  assert.equal(intent.getSnapshot("intent").turnId, "new9");
  assert.equal(intent.getSnapshot("intent").observation, "observed");
  const shell = createTerminalRuntime();
  const shellLaunch = shell.beginLaunch({ id: "shell", launchToken: 1, provider: "terminal", cwd: root });
  shell.ingest({ id: "shell", generation: shellLaunch.generation, type: "created" });
  shell.recordInput({ id: "shell", generation: shellLaunch.generation, data: "\r" });
  assert.equal(shell.getSnapshot("shell").pendingInput, undefined);
  const ownership = createTerminalRuntime();
  ownership.beginLaunch({ id: "owner", launchToken: 1, provider: "claude", cwd: root,
    threadRef: { provider: "claude", id: "shared" } });
  assert.equal(ownership.beginLaunch({ id: "duplicate", launchToken: 1, provider: "claude", cwd: root,
    threadRef: { provider: "claude", id: "shared" } }).disposition, "conflict");
  assert.equal(ownership.beginLaunch({ id: "custom", launchToken: 1, provider: "claude", cwd: root,
    providerProfileId: "custom-provider", threadRef: { provider: "claude", id: "shared" } }).disposition, "new");
  let sharedCalls = 0, schedulerNow = 10000;
  const shared = createTerminalRuntime({ now: () => schedulerNow, lookup: async () => {
    sharedCalls += 1; return { status: "failed", message: "temporary" };
  } });
  for (const id of ["s1", "s2"]) shared.beginLaunch({ id, launchToken: 1, provider: "codex", cwd: root });
  await shared.refresh();
  assert.equal(sharedCalls, 1, "same provider/home/cwd listing is shared across panes");
  schedulerNow += 8000;
  await shared.refresh();
  assert.equal(sharedCalls, 1, "failed metadata read backs off beyond ordinary cadence");
  schedulerNow += 8000;
  await shared.refresh();
  assert.equal(sharedCalls, 2, "backoff retries without a permanent timeout ceiling");
  const ambiguous = createTerminalRuntime({ now: () => 10000, lookup: async () => ({ status: "found", threads: [{ id: "candidate", createdAt: 10000 }] }) });
  for (const id of ["x", "y"]) ambiguous.beginLaunch({ id, launchToken: 1, provider: "codex", cwd: root });
  await ambiguous.refresh();
  assert(ambiguous.listSnapshots().every((snapshot) => snapshot.binding.status === "ambiguous"));
}

function ptyChecks() {
  const events = [], spawned = [], timers = [];
  const pty = { spawn: () => {
    const terminal = { writes: [], resize() {}, write(data) { this.writes.push(data); }, kill() {},
      onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; } };
    spawned.push(terminal); return terminal;
  } };
  const context = vm.createContext({
    require: (name) => name === "node-pty" ? pty : name === "readline" ? { createInterface: () => ({ on() {} }) } : require(name),
    process: { platform: "win32", env: {}, stdin: {}, cwd: () => root,
      stdout: { write: (line) => events.push(JSON.parse(line)) }, exit() {} },
    setTimeout: (fn) => timers.push(fn)
  });
  vm.runInContext(fs.readFileSync(path.join(root, "backend/ptyHost.cjs"), "utf8"), context);
  const create = { id: "pane", launchToken: 1, generation: "g1", command: "codex" };
  context.handleMessage({ type: "create", payload: create });
  for (const fn of timers.splice(0)) fn();
  assert.equal(spawned.length, 1);
  spawned[0].data("hello\x1b]2;Terminal ");
  spawned[0].data("Title\x1b");
  spawned[0].data("\\ world");
  assert.equal(events.find((event) => event.type === "title").title, "Terminal Title");
  assert.equal(events.filter((event) => event.type === "data").map((event) => event.data).join(""), "hello\x1b]2;Terminal Title\x1b\\ world");
  context.handleMessage({ type: "create", payload: create });
  assert.equal(spawned.length, 1);
  assert.equal(events.at(-1).terminalTitle, "Terminal Title");
  context.handleMessage({ type: "input", payload: { id: "pane", generation: "stale", data: "NO" } });
  assert(!spawned[0].writes.includes("NO"));
  context.handleMessage({ type: "create", payload: { ...create, launchToken: 2, generation: "g2" } });
  const count = events.length;
  spawned[0].exit({ exitCode: 0 });
  assert.equal(events.length, count, "old onExit callback cannot terminate replacement");
}

function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from); return source.slice(from, to);
}
async function mainChecks() {
  const source = fs.readFileSync(path.join(root, "backend/main.cjs"), "utf8");
  const events = [];
  const parser = vm.createContext({ ptyHostBuffer: "", ptyHostDecoder: new StringDecoder("utf8"),
    ptyHostReady: false, terminalRuntime: null, releaseTerminalResources() {}, broadcastTerminalEvent: (e) => events.push(e) });
  vm.runInContext(section(source, "function parsePtyHostOutput(", "function releaseTerminalResources("), parser);
  const expected = "A\u2500\u{1f642}B";
  const bytes = Buffer.from(JSON.stringify({ id: "pane", type: "data", data: expected }) + "\n");
  const split = bytes.indexOf(Buffer.from("\u2500")) + 1;
  parser.parsePtyHostOutput(bytes.subarray(0, split)); parser.parsePtyHostOutput(bytes.subarray(split));
  assert.equal(events[0].data, expected);

  const { EventEmitter } = require("node:events");
  const hosts = [];
  const hostContext = vm.createContext({ ptyHost: null, ptyHostReady: false, ptyHostBuffer: "", ptyHostDecoder: new StringDecoder("utf8"),
    StringDecoder, terminalRuntime: null, getNodeHostCommand: () => "fake-node", getPtyHostPath: () => "fake-host",
    getDefaultRuntimeCwd: () => root, getNodeHostEnv: () => ({}), parsePtyHostOutput() {},
    releaseTerminalResources() {}, broadcastTerminalEvent() {}, spawn: () => {
      const host = new EventEmitter();
      host.stdout = new EventEmitter(); host.stderr = new EventEmitter(); host.stdin = new EventEmitter();
      host.kill = () => { host.killed = true; }; hosts.push(host); return host;
    } });
  vm.runInContext(section(source, "function startPtyHost()", "function broadcastFusionChatEvent("), hostContext);
  hostContext.startPtyHost(); hosts[0].emit("error", new Error("spawn failed"));
  assert.equal(hostContext.ptyHost, null, "failed spawn cannot leave an unusable host latched");
  hostContext.startPtyHost(); hosts[0].emit("exit", 1);
  assert.equal(hostContext.ptyHost, hosts[1], "late previous host exit cannot invalidate its replacement");
  hosts[1].stdin.emit("error", new Error("EPIPE"));
  assert.equal(hostContext.ptyHost, null);
  assert.equal(hosts[1].killed, true);

  const handlers = {}, sent = [], releases = [], terminalEvents = [];
  const runtime = createTerminalRuntime();
  let finishPreparation, preparations = 0, hostStarts = 0;
  const telemetry = { prepareSession: () => { preparations++; return new Promise((resolve) => { finishPreparation = resolve; }); },
    releaseSession: (...args) => releases.push(args) };
  const context = vm.createContext({ ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on() {} },
    terminalRuntime: runtime, orchestratorIntegration: null, ptyHost: null, getTerminalRuntime: () => runtime,
    resolveLaunchCwd: (cwd) => cwd === "missing-folder" ?
      { ok: false, cwd, message: "Working directory is unavailable: missing-folder" } : { ok: true, cwd: root },
    getDefaultRuntimeCwd: () => root,
    startPtyHost() { hostStarts++; }, getAgentTelemetry: () => telemetry,
    sendToPtyHost: (message) => { sent.push(message); return true; },
    releaseTerminalResources: (...args) => releases.push(args), broadcastTerminalEvent: (event) => terminalEvents.push(event) });
  vm.runInContext(section(source, 'ipcMain.handle("terminal:create"', 'ipcMain.handle("fusion-chat:start"'), context);
  vm.runInContext(source.slice(source.indexOf("function scopedTerminalPayload(")), context);
  const payload = { id: "pane", provider: "codex", command: "codex", cwd: root, launchToken: 1 };
  const creating = handlers["terminal:create"](null, payload);
  const duplicate = handlers["terminal:create"](null, payload);
  assert.equal(preparations, 1, "same-token creates share instrumentation preparation");
  handlers["terminal:kill"](null, { id: "pane" });
  finishPreparation({ env: {} });
  await Promise.all([creating, duplicate]);
  assert.deepEqual(sent.map((message) => message.type), ["kill"], "close cancels preparation before any create reaches PTY");
  assert(releases.length >= 1);
  const invalid = await handlers["terminal:create"](null, { ...payload, id: "invalid", cwd: "missing-folder" });
  assert.equal(invalid.ok, false);
  assert.equal(runtime.getSnapshot("invalid").generation, invalid.generation);
  assert.equal(runtime.getSnapshot("invalid").processState, "failed");
  assert.match(runtime.getSnapshot("invalid").binding.message, /Working directory is unavailable/);
  assert.equal(terminalEvents.at(-1).generation, invalid.generation);
  assert.equal(preparations, 1, "invalid cwd must not prepare instrumentation");
  assert.equal(hostStarts, 1, "invalid cwd must not start a PTY host");
  const eventCount = terminalEvents.length;
  const staleInvalid = await handlers["terminal:create"](null, { ...payload, cwd: "missing-folder" });
  assert.equal(staleInvalid.cancelled, true);
  assert.equal(runtime.getSnapshot("pane"), null);
  assert.equal(terminalEvents.length, eventCount, "closed stale invalid launch cannot publish a new error");
  runtime.beginLaunch({ id: "owner", launchToken: 1, provider: "codex", cwd: root,
    threadRef: { provider: "codex", id: "owned-thread" } });
  const conflict = await handlers["terminal:create"](null, { ...payload, id: "invalid", launchToken: 2,
    threadRef: { provider: "codex", id: "owned-thread" } });
  assert.equal(conflict.ok, false);
  assert.equal(runtime.getSnapshot("invalid").launchToken, 2);
  assert.equal(runtime.getSnapshot("invalid").generation, conflict.generation);
  assert.equal(runtime.getSnapshot("invalid").processState, "failed");
  assert.equal(runtime.getSnapshot("invalid").binding.status, "ambiguous");
  assert.match(conflict.error, /already belongs/);
  assert.equal(runtime.getSnapshot("owner").conversation.id, "owned-thread");
  const ownerSnapshot = runtime.getSnapshot("owner");
  runtime.ingest({ id: "owner", generation: ownerSnapshot.generation, type: "created" });
  handlers["terminal:input"](null, { id: "owner", generation: ownerSnapshot.generation, data: "\r" });
  assert.equal(runtime.getSnapshot("owner").pendingInput, "submit", "actual input IPC records intent before forwarding bytes");
  assert.equal(sent.at(-1).type, "input");
  assert.equal(sent.at(-1).payload.data, "\r");
  assert.equal(preparations, 1);
  assert.equal(hostStarts, 1);
}

(async () => {
  await runtimeChecks(); ptyChecks(); await mainChecks();
  console.log("terminal runtime smoke passed (lifecycle, stale generations, retained metadata, ambiguity, OSC, UTF8, create cancellation)");
})().catch((error) => { console.error(error); process.exitCode = 1; });
