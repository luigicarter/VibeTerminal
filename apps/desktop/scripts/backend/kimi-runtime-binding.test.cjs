"use strict";
// Kimi's hooks carry a session id but no proof that it is a root conversation,
// and its store lives in one home shared by kimi and kimi-custom. Both facts
// used to cost a pane its runtime pill: the first prompt's hint was parked
// until an 8s refresh (so a short turn replayed running and completed back to
// back and "working" was never painted), and a kimi-custom pane could bind its
// kimi sibling's session, after which its own hooks all looked like a child.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createTerminalRuntime } = require("../../backend/terminalRuntime.cjs");
const capabilities = require("../../shared/providerCapabilities.json");
const root = path.resolve(__dirname, "../..");

function load(file) {
  const context = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, context);
  return context.exports;
}
const { runtimeStatusLabel } = load("frontend/terminalRuntime.ts");

// A real 0.42 store: session_index.jsonl rows plus <session>/state.json v2,
// both of which kimi writes when the session is created - before any prompt.
function kimiStore(t, sessions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lina-kimi-home-"));
  const previous = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const rows = [];
  for (const [id, cwd] of Object.entries(sessions)) {
    const sessionDir = path.join(home, "sessions", "wd_fixture_0123456789ab", id);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify({
      id, version: 2, cwd: cwd.replace(/\\/g, "/"), createdAt: 9000, updatedAt: 9500, archived: false,
      agents: { main: { homedir: path.join(sessionDir, "agents", "main").replace(/\\/g, "/"), type: "main" } },
      custom: {}, lastPrompt: "", title: "", titleKind: "replaceable", isCustomTitle: false
    }));
    rows.push(JSON.stringify({ sessionId: id, sessionDir: sessionDir.replace(/\\/g, "/"), workDir: cwd.replace(/\\/g, "/") }));
  }
  fs.writeFileSync(path.join(home, "session_index.jsonl"), `${rows.join("\n")}\n`);
  return home;
}

// The wiring main.cjs installs: kimi's store confirm is one index read plus one
// state.json, so the runtime can answer a hint inside the hook's own tick.
const { confirmKimiThread, confirmKimiCustomThread } = require("../../backend/agentThreadHost.cjs");
const confirmSync = payload => !payload?.cwd || !payload.confirmId ? undefined
  : payload.provider === "kimi-custom" ? confirmKimiCustomThread(payload.cwd, payload.confirmId)
    : payload.provider === "kimi" ? confirmKimiThread(payload.cwd, payload.confirmId) : undefined;

function runtime(t, options = {}) {
  let time = 10000;
  const instance = createTerminalRuntime({ now: () => time, capabilities: p => capabilities[p], confirmSync, ...options });
  t.after(() => instance.dispose());
  return instance;
}

// The exact receiver payload a kimi root hook produces: a session id and no
// rootVerified, no providerTurnId, no agent id. Everything the pane knows about
// this turn has to come from the store read the hint triggers.
function hook(runtime, pane, generation, type, details = {}) {
  return runtime.ingest({ id: pane, generation, type, providerThreadId: details.providerThreadId, cwd: details.cwd,
    ...(details.attention ? { attention: details.attention } : {}), observedAt: details.observedAt });
}

for (const provider of ["kimi", "kimi-custom"]) {
  test(`${provider}: the first prompt's hint binds and paints working before any refresh tick`, t => {
    const cwd = process.cwd();
    kimiStore(t, { "session_11111111-1111-4111-8111-111111111111": cwd });
    const instance = runtime(t);
    const { generation } = instance.beginLaunch({ id: "pane", provider, cwd, launchToken: 1 });
    instance.ingest({ id: "pane", generation, type: "created" });
    hook(instance, "pane", generation, "agent-running",
      { providerThreadId: "session_11111111-1111-4111-8111-111111111111", cwd, observedAt: 10100 });
    const running = instance.getSnapshot("pane");
    assert.equal(running.conversation?.id, "session_11111111-1111-4111-8111-111111111111",
      "the hinted id is confirmed against the store in the hook's own tick");
    assert.equal(running.turnState, "running");
    assert.equal(running.observation, "observed");
    assert.equal(running.children.length, 0, "a root hook is never the pane's own child");
    assert.equal(instance.getRecord("pane").pendingEvents.length, 0, "nothing was parked");
    assert.equal(instance.getRecord("pane").identityHints.size, 0);
    assert.equal(runtimeStatusLabel(running), "working");

    hook(instance, "pane", generation, "agent-attention",
      { providerThreadId: "session_11111111-1111-4111-8111-111111111111", cwd, observedAt: 12900,
        attention: { state: "completed" } });
    const stopped = instance.getSnapshot("pane");
    assert.equal(stopped.turnState, "response", "kimi's Stop carries no turn id, so completion stays coarse");
    assert.equal(stopped.children.length, 0);
    assert.equal(runtimeStatusLabel(stopped), "response available");
  });
}

test("a hint whose session the store has not written yet parks exactly as before", t => {
  const cwd = process.cwd();
  kimiStore(t, {});
  const instance = runtime(t);
  const { generation } = instance.beginLaunch({ id: "pane", provider: "kimi", cwd, launchToken: 1 });
  instance.ingest({ id: "pane", generation, type: "created" });
  hook(instance, "pane", generation, "agent-running", { providerThreadId: "session_unwritten", cwd, observedAt: 10100 });
  const parked = instance.getSnapshot("pane");
  assert.equal(parked.conversation, undefined);
  assert.equal(parked.observation, "provisional");
  assert.equal(instance.getRecord("pane").identityHints.size, 1, "the hint waits for the refresh timer");
  assert.equal(instance.getRecord("pane").pendingEvents.length, 1);
});

// kimi-custom reads and writes stock kimi's home, so ownership has to be asked
// per store. Keyed on the provider label, pane B saw its sibling's session as
// the one unowned candidate for its folder and bound it.
test("same-folder kimi and kimi-custom panes never bind each other's session", async t => {
  const cwd = process.cwd();
  kimiStore(t, { "session_aaaaaaaa-1111-4111-8111-111111111111": cwd, "session_bbbbbbbb-2222-4222-8222-222222222222": cwd });
  const listed = { status: "found", threads: [
    { provider: "kimi", id: "session_aaaaaaaa-1111-4111-8111-111111111111", createdAt: 10000, updatedAt: 10000 }
  ] };
  const instance = runtime(t, { lookup: async payload => payload.list ? listed
    : { status: "found", rootVerified: true, threadRef: { id: payload.confirmId, createdAt: 10000, updatedAt: 10000 } } });
  const a = instance.beginLaunch({ id: "a", provider: "kimi", cwd, launchToken: 1 });
  instance.ingest({ id: "a", generation: a.generation, type: "created" });
  const b = instance.beginLaunch({ id: "b", provider: "kimi-custom", cwd, launchToken: 1 });
  instance.ingest({ id: "b", generation: b.generation, type: "created" });

  hook(instance, "a", a.generation, "agent-running",
    { providerThreadId: "session_aaaaaaaa-1111-4111-8111-111111111111", cwd, observedAt: 10100 });
  assert.equal(instance.getSnapshot("a").conversation?.id, "session_aaaaaaaa-1111-4111-8111-111111111111");

  // Pane B's list scan: A's session is the sole candidate the store offers and
  // it must be excluded across the shared home, not just within kimi-custom.
  await instance.refreshRecord(instance.getRecord("b"));
  assert.equal(instance.getSnapshot("b").conversation, undefined, "a sibling's bound session is not a candidate");
  assert.equal(instance.getSnapshot("b").binding.status, "pending");

  // And a hook for A's session arriving on B binds nothing and invents no child.
  hook(instance, "b", b.generation, "agent-running",
    { providerThreadId: "session_aaaaaaaa-1111-4111-8111-111111111111", cwd, observedAt: 10200 });
  const crossed = instance.getSnapshot("b");
  assert.equal(crossed.conversation, undefined, "the store confirms the id, but another pane owns it");
  assert.equal(crossed.children.length, 0, "and it must not become phantom child work");
  assert.equal(crossed.turnState, "unknown");
  assert.equal(instance.getRecord("b").identityHints.size, 1, "it parks like any unproven hint");

  // B's own session still binds, from its own hint, in its own tick.
  hook(instance, "b", b.generation, "agent-running",
    { providerThreadId: "session_bbbbbbbb-2222-4222-8222-222222222222", cwd, observedAt: 10300 });
  const own = instance.getSnapshot("b");
  assert.equal(own.conversation?.id, "session_bbbbbbbb-2222-4222-8222-222222222222");
  assert.equal(own.turnState, "running");
  assert.equal(own.children.length, 0, "and the sibling's parked hint is not replayed here as child work");
  assert.equal(runtimeStatusLabel(own), "working");
  assert.equal(instance.getSnapshot("a").conversation?.id, "session_aaaaaaaa-1111-4111-8111-111111111111",
    "and pane A keeps its own");
});

// Only "window-all-closed" ever ran agentTelemetry.cleanup(), and Electron does
// not emit it for a programmatic quit - which is the path Lina's own window
// close takes. The hook blocks and the shim run directory outlived every quit.
function shutdownFixture(overrides = {}) {
  const source = ts.createSourceFile("main.cjs",
    fs.readFileSync(path.join(root, "backend/main.cjs"), "utf8"), ts.ScriptTarget.Latest, true);
  const selected = source.statements.filter(node =>
    (ts.isFunctionDeclaration(node) && node.name?.text === "shutdownRuntimeHosts") ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source) === "runtimeHostsShutDown")));
  assert.equal(selected.length, 2, "the shipped shutdown function and its latch");
  const calls = [];
  const context = {
    chatLaunchPreparation: { cancelAll: () => calls.push("cancelAll") },
    orchestratorIntegration: { dispose: () => calls.push("orchestrator") },
    terminalRuntime: { dispose: () => calls.push("runtime") },
    agentTelemetry: { cleanup: () => calls.push("telemetry") },
    buildSupervisor: { cleanup: () => calls.push("builds") },
    ptyHost: null, agentThreadHost: null, fusionChatHost: null, openFusionChatHost: null,
    sendToPtyHost: () => {}, sendToFusionChatHost: () => {}, sendToOpenFusionChatHost: () => {}, JSON,
    ...overrides
  };
  vm.runInNewContext(`${selected.map(node => node.getText(source)).join("\n")}\nexports = shutdownRuntimeHosts;`, context);
  return { run: context.exports, calls };
}

test("the quit teardown runs once and survives a step that throws", () => {
  const once = shutdownFixture();
  once.run();
  once.run();
  assert.deepEqual(once.calls, ["cancelAll", "orchestrator", "runtime", "telemetry", "builds"],
    "both quit paths reach it, and the second call is a no-op");

  const throwing = shutdownFixture({ orchestratorIntegration: { dispose() { throw new Error("disposed twice"); } } });
  throwing.run();
  assert.deepEqual(throwing.calls, ["cancelAll", "runtime", "telemetry", "builds"],
    "a failing step never keeps the hook cleanup from running or blocks the quit");
});
