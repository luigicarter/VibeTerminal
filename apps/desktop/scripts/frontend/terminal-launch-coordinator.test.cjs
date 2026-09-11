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
test('pending selected chat resumes only its confirmed root and never the older reference', async () => {
  for (const kind of ['claude', 'codex', 'open-codex']) {
    const selected = session('pane', { kind, nextLaunchMode: 'resume', threadSelectionPending: true,
      threadRef: { provider: kind, id: 'C' }, resumeRef: { provider: kind, id: 'A' } });
    for (const reply of [undefined, { status: 'failed' }, { status: 'found', rootVerified: false, threadRef: { id: 'C' } },
      { status: 'found', rootVerified: true, threadRef: { id: 'other' } }]) {
      const h = harness(undefined, { confirmThread: async p => { assert.equal(p.confirmId, 'C'); return reply; } });
      h.reconcile([selected]); await flush();
      assert.equal(h.calls.length, 0); assert.equal(h.errors.length, 1);
    }
    const h = harness(undefined, { confirmThread: async () => ({ status: 'found', rootVerified: true, threadRef: selected.threadRef }) });
    h.reconcile([selected]); await flush();
    assert.equal(h.calls[0].threadRef.id, 'C'); assert.match(h.calls[0].command, /resume C$/);
  }
});
function harness(create, options = {}) {
  let sessions = [];
  const calls = [], errors = [];
  const coordinator = createTerminalLaunchCoordinator({
    platform: "win32",
    create: payload => { calls.push(payload); return create ? create(payload) : Promise.resolve({ ok: true }); },
    isCurrent: candidate => sessions.some(current => current.id === candidate.id && current.started && current.launchToken === candidate.launchToken),
    onError: (candidate, message) => errors.push({ id: candidate.id, message }),
    ...options
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

const resumedSession = (kind, patch = {}) => session(kind, {
  kind, command: kind === "cursor" ? "cursor-agent" : kind,
  nextLaunchMode: "resume", threadRef: { provider: kind, id: `${kind}-saved`, createdAt: 1, updatedAt: 1 },
  ...patch
});

test("confirmation preserves exact saved IDs for every threaded provider", async () => {
  const lookups = [];
  const h = harness(undefined, { confirmThread: async payload => {
    lookups.push(payload);
    return { status: "found", threadRef: { provider: payload.provider, id: payload.confirmId } };
  } });
  const commands = {
    codex: "codex resume codex-saved", claude: "claude --resume claude-saved",
    opencode: "opencode --session opencode-saved --auto", cursor: "cursor-agent --resume cursor-saved",
    gemini: "gemini --resume gemini-saved", kimi: "kimi --session kimi-saved",
    "kimi-custom": "kimi-custom --session kimi-custom-saved", qwen: "qwen --resume qwen-saved",
    grok: "grok --resume grok-saved",
    'open-codex': 'open-codex resume open-codex-saved'
  };
  const providers = Object.entries(require("../../shared/providerCapabilities.json"))
    .filter(([, capability]) => capability.threaded).map(([kind]) => kind);
  assert.deepEqual(Object.keys(commands).sort(), providers.sort(), "every threaded provider needs an exact resume expectation");
  h.reconcile(Object.keys(commands).map(kind => resumedSession(kind,
    kind === "claude" ? { providerProfileId: "custom-profile" } : {})));
  await flush();
  assert.deepEqual(h.calls.map(call => call.command), Object.values(commands));
  assert.equal(lookups.length, providers.length);
  for (const lookup of lookups) {
    assert.equal(lookup.confirmId, `${lookup.provider}-saved`);
    assert.equal(lookup.cwd, "C:/repo");
    assert.equal(lookup.claudeHome, lookup.provider === "claude" ? "custom" : undefined);
  }
});

test("missing sessions start fresh and notify persistence without retaining non-Claude identity", async () => {
  const fallbacks = [];
  const h = harness(undefined, {
    confirmThread: async () => ({ status: "missing" }),
    onFreshLaunchFallback: (original, fresh) => fallbacks.push({ original, fresh })
  });
  const kinds = ["claude", "codex", "opencode", "cursor", "gemini", "kimi", "kimi-custom", "qwen", "grok"];
  h.reconcile(kinds.map(kind => resumedSession(kind)));
  await flush();
  assert.equal(fallbacks.length, kinds.length);
  assert.equal(h.calls[0].command, "claude --session-id claude-saved");
  assert.equal(h.calls[0].threadRef.id, "claude-saved");
  for (let index = 0; index < kinds.length; index++) {
    assert.equal(fallbacks[index].fresh.nextLaunchMode, "new");
    assert.equal(fallbacks[index].original.nextLaunchMode, "resume");
    assert.equal(fallbacks[index].fresh.threadLookupStatus, "pending");
    if (index) {
      assert.equal(h.calls[index].threadRef, undefined);
      assert(!h.calls[index].command.includes("-saved"));
      assert.equal(fallbacks[index].fresh.threadRef, undefined);
    }
  }
});

test("uncertain or unavailable confirmation still attempts the saved conversation", async () => {
  for (const status of ["failed", "pending", "ambiguous", "throw"]) {
    const h = harness(undefined, {
      confirmThread: async () => { if (status === "throw") throw new Error("offline"); return { status }; },
      onFreshLaunchFallback: () => assert.fail("Uncertain lookup must not discard history")
    });
    h.reconcile([resumedSession("codex")]);
    await flush();
    assert.equal(h.calls[0].command, "codex resume codex-saved");
    assert.equal(h.calls[0].threadRef.id, "codex-saved");
  }
});

test("close, restart, pause and unmount cancel in-flight confirmation before state changes or create", async () => {
  for (const action of ["close", "restart", "pause", "unmount"]) {
    const pending = [], fallbacks = [];
    const h = harness(undefined, {
      confirmThread: () => new Promise(resolve => pending.push(resolve)),
      onFreshLaunchFallback: (...args) => fallbacks.push(args)
    });
    const original = resumedSession("codex");
    h.reconcile([original]);
    await flush();
    if (action === "close") h.reconcile([]);
    if (action === "restart") h.reconcile([{ ...original, launchToken: 2 }]);
    if (action === "pause") h.reconcile([{ ...original, started: false }]);
    if (action === "unmount") h.coordinator.suspend();
    await flush();
    pending[0]({ status: "missing" });
    await flush();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(fallbacks, []);
    if (action === "restart") {
      pending[1]({ status: "found", threadRef: original.threadRef });
      await flush();
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].launchToken, 2);
    }
  }
});

test("fresh launches skip confirmation and cancellation in fallback prevents process creation", async () => {
  const fresh = harness(undefined, { confirmThread: () => assert.fail("Fresh launch needs no lookup") });
  fresh.reconcile([session("shell"), resumedSession("claude", { nextLaunchMode: "new" })]);
  await flush();
  assert.equal(fresh.calls.length, 2);
  const cancelled = harness(undefined, {
    confirmThread: async () => ({ status: "missing" }),
    onFreshLaunchFallback: original => cancelled.coordinator.cancel(original.id, original.launchToken)
  });
  cancelled.reconcile([resumedSession("codex")]);
  await flush();
  assert.deepEqual(cancelled.calls, []);
});
