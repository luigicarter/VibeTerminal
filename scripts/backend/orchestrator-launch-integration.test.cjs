"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { installOrchestrator } = require("../../backend/orchestratorIntegration.cjs");
const { createOrchestrator } = require("../../backend/orchestrator.cjs");
const shellTitle = String.raw`C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`;

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
      // Renderer inventory uses the OSC display title as the session name.
      sessions.push({ id: "pane", launchToken: 1, started: true, kind: "terminal", name: shellTitle, cwd: root });
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
  return { root, integration, admitted, snapshots, uiActions,
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
  assert.equal(result.cwd, f.root, "the launch receipt reports the workspace, not the shell title");
  assert.equal(f.uiActions.filter(kind => kind === "create_session").length, 1);
});

for (const executionMode of ["direct", "reason"]) test(`${executionMode} harness creation reports the confirmed workspace despite PowerShell title`, async t => {
  const f = await fixture(t), requests = [];
  let creating = true;
  const relay = createOrchestrator({ userDataPath: path.join(f.root, "relay"), secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => f.integration.directory.list(), getRoots: () => ({ documents: f.root, projects: [f.root] }),
    interpretIntent: async () => creating
      ? { goal: "Open a terminal in the project.", executionMode, actions: [{ kind: "create_session", kindOfSession: "terminal", cwd: f.root }] }
      : { goal: "Report where the terminal was opened.", actions: [] },
    dispatchAction: async action => { assert.equal(action.kind, "create_session"); assert.equal(action.cwd, f.root); return f.create(); },
    fetch: async (url, options) => {
      const respond = message => new Response(JSON.stringify({ choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
      if (url.endsWith("/key")) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "fixture", context_length: 128000, supported_parameters: ["tools"] }] }));
      assert(url.endsWith("/chat/completions"));
      const body = JSON.parse(options.body); requests.push(body);
      const context = JSON.parse(body.messages.find(message => message.role === "user").content);
      const receipt = body.messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content)).at(-1);
      if (creating && !receipt) return respond({ tool_calls: [{ id: "create", type: "function", function: { name: "workspace", arguments: JSON.stringify({ kind: "create_session", grantId: context.authorizedCommands.grants[0].id }) } }] });
      const evidence = creating ? receipt : context.latestAction;
      assert.equal(evidence.cwd, f.root, "both the creation tool and follow-up context retain the observed cwd");
      return respond({ content: creating ? `Opened ${shellTitle} in ${evidence.cwd}.` : `Opened the terminal in ${evidence.cwd}.` });
    } });
  t.after(() => relay.dispose());
  assert.equal((await relay.configure({ apiKey: "fixture-only", model: "fixture", sessionOnly: true })).ok, true);
  assert.equal((await relay.setEnabled(true)).ok, true);
  const pending = relay.send({ text: "Open a terminal in the project", origin: "text" });
  await f.admitted;
  f.snapshots.push({ ...f.runtime, terminalTitle: shellTitle, processState: "running", launchState: "ready" });
  const result = await pending;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, `Opened the terminal in ${path.basename(f.root)}.`);
  assert.doesNotMatch(result.text, /powershell\.exe|System32|[a-z]:[\\/]/i);
  assert.equal(result.actions[0].cwd, f.root);
  assert.equal(requests.length, executionMode === "direct" ? 0 : 2);
  assert.equal(relay.getState().receipts.find(item => item.kind === "create_session").cwd, f.root);
  creating = false;
  const followup = await relay.send({ text: "Where did you open it?", origin: "text" });
  assert.equal(followup.ok, true, JSON.stringify(followup));
  assert.equal(followup.text, `Opened the terminal in ${f.root}.`);
  assert.equal(f.uiActions.filter(kind => kind === "create_session").length, 1);
  await relay.dispose();
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
