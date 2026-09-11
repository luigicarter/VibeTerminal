const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const ts = require("typescript");
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, "../../frontend/sessionPersistence.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, context);
const { migrateRemovedAgent, serializeSession } = context.exports;
const { rememberTerminalThread } = context.exports;
const stored = { id: "old-pane", kind: "aider", name: "My pane", cwd: "C:/repo", command: "aider", started: true,
  status: "running", attention: { state: "completed", unread: true }, tileId: "old-pane",
  splitTree: { dir: "row", ratio: .5, a: { id: "old-pane" }, b: { id: "sibling" } },
  layout: { x: 0, y: 10, w: 50, h: 260 }, threadRef: { id: "old-chat" }, subagentDepth: 2 };
const migrated = migrateRemovedAgent(stored);
assert.equal(migrated.kind, "terminal");
assert.equal(migrated.started, false);
assert.equal(migrated.command, "");
for (const key of ["id", "name", "cwd", "tileId", "splitTree", "layout"]) assert.equal(migrated[key], stored[key]);
for (const key of ["threadRef", "resumeRef", "attention", "subagentDepth"]) assert.equal(migrated[key], undefined);
assert.equal(stored.kind, "aider", "migration must not mutate original input");
assert.equal(migrateRemovedAgent(null), null);
const live = { ...stored, kind: "codex", resumeRef: { id: "previous" }, threadRef: { id: "confirmed", title: "Real name" } };
const serialized = serializeSession(live);
assert.equal(serialized.status, "idle");
assert.equal(serialized.attention, undefined);
assert.equal(serialized.subagentDepth, undefined);
assert.equal(serialized.threadRef, live.threadRef);
assert.equal(serialized.resumeRef, live.resumeRef);
assert.equal(serialized.started, true, "launch intent must survive serialization");
const fusion = { ...live, fusion: true };
assert.equal(serializeSession(fusion), fusion, "chat persistence remains on its existing path");
// Execute the actual restoration/start functions without mounting Electron or React.
const appSource = fs.readFileSync(path.join(__dirname, "../../frontend/App.tsx"), "utf8");
const ast = ts.createSourceFile("App.tsx", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["restoreSession", "restartSession", "resumeSession", "hasClaudeThreadId", "threadRefForKind",
  "resumableThreadRefForKind", "canResumeSessionThread", "sessionResumeRef", "activeSessionThreadRef",
  "normalizeLaunchMode", "sanitizeThreadRefTitle"]);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) functions.push(node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(functions.length, names.size);
const capabilities = require("../../shared/providerCapabilities.json");
let freshId = 0;
let updatedSessions;
const restartMessages = [];
const restoreContext = {
  Date, Boolean, String,
  finiteNumber: (value, fallback) => Number.isFinite(value) ? value : fallback,
  normalizeSessionStatus: value => value || "idle",
  isThreadedAgentKind: kind => capabilities[kind]?.threaded === true,
  getProfile: kind => ({ label: kind, command: kind }),
  createThreadRef: kind => capabilities[kind]?.threaded ? { provider: kind, id: kind === "claude" ? `fresh-${++freshId}` : undefined } : undefined,
  normalizedFusionSessionFields: session => ({ fusionPlannerFamily: session.fusionPlannerFamily === "codex" ? "codex" : "claude" }),
  normalizeFusionRunMode: value => value,
  normalizeOpenFusionModel: value => value,
  DEFAULT_OPEN_FUSION_PLANNER_MODEL: "", DEFAULT_OPEN_FUSION_EXECUTOR_MODEL: "",
  normalizeAttention: value => value || { state: "none", unread: false },
  EMPTY_ATTENTION: { state: "none", unread: false },
  normalizeSplitNode: value => value, migrateLayout: value => value,
  isGenericSessionTitle: title => /^(Claude|Codex) \d+$/.test(title || ""),
  clearCodexTracking() {}, stopSessionProcess: () => Promise.resolve(true),
  isThreadRefClaimedByOther: () => false,
  setShellMessage: message => restartMessages.push(message),
  updateScopeSessions: (_scope, update) => { updatedSessions = update(updatedSessions); }
};
vm.createContext(restoreContext);
vm.runInContext(ts.transpileModule(functions.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText, restoreContext);
const restore = session => restoreContext.restoreSession(JSON.parse(JSON.stringify(serializeSession(session))));
const base = { id: "pane", name: "Chat", cwd: "C:/repo", started: true, launchToken: 1, status: "idle", command: "" };
for (const kind of ['claude', 'codex', 'open-codex']) {
  let current = { ...base, kind, threadRef: { provider: kind, id: 'A' }, resumeRef: { provider: kind, id: 'older' } };
  for (const id of ['B', 'C']) {
    const selected = { provider: kind, id, createdAt: 1, updatedAt: 2 };
    const snapshot = { id: 'pane', launchToken: 1, selection: { status: 'pending', revision: 1, threadRef: selected } };
    current = rememberTerminalThread(current, snapshot);
    assert.equal(restore(current).threadRef.id, id, 'close during verification preserves selected ID');
    assert.equal(restore(current).threadSelectionPending, true);
    current = rememberTerminalThread(current, { ...snapshot, conversation: selected, selection: { ...snapshot.selection, status: 'confirmed' } });
    assert.equal(restore(current).threadRef.id, id);
    assert.equal(restore(current).threadSelectionPending, undefined);
    assert.equal(rememberTerminalThread(current, { ...snapshot, launchToken: 0 }), current, 'stale generation cannot rewrite selection');
  }
  const uncertain = rememberTerminalThread(current, { id: 'pane', launchToken: 1, selection: { status: 'unavailable', revision: 3 } });
  assert.equal(restore(uncertain).threadRef, undefined);
  assert.equal(restore(uncertain).threadSelectionPending, true, 'uncertain selection never promotes an older ref');
}
for (const kind of Object.keys(capabilities).filter(kind => capabilities[kind].threaded)) {
  for (const status of ["idle", "running", "done", "failed"]) {
    const current = { provider: kind, id: `${kind}-current`, title: "My chat" };
    const previous = { provider: kind, id: `${kind}-previous` };
    const input = { ...base, kind, status, threadRef: current, resumeRef: previous };
    assert.equal(restoreContext.restoreSession(input).started, true, `${kind}/${status} legacy saved telemetry preserves launch intent`);
    const restored = restore(input);
    assert.equal(restored.started, true, `${kind}/${status} restores started intent`);
    assert.equal(restored.nextLaunchMode, "resume");
    assert.equal(restored.threadRef.id, current.id);
    assert.equal(restored.resumeRef.id, previous.id);
    assert.equal(restore(restored).threadRef.id, current.id, "repeated app reopen retains identity");
    const sibling = restore({ ...input, id: "sibling", threadRef: { ...current, id: "other-chat" } });
    assert.equal(sibling.threadRef.id, "other-chat", "same cwd never merges chat identities");
    const paused = restore({ ...input, started: false });
    assert.equal(paused.started, false);
    assert.equal(paused.nextLaunchMode, "new");
    assert.notEqual(paused.threadRef?.id, current.id);
    assert.equal(paused.resumeRef.id, current.id, "paused pane retains deliberate Resume");
    for (const threadRef of [undefined, { provider: kind }, { provider: kind, id: 123 }, { provider: kind, id: " " }, { provider: "terminal", id: "wrong-provider" }]) {
      const fresh = restore({ ...input, threadRef });
      assert.equal(fresh.nextLaunchMode, "new");
      assert.notEqual(fresh.threadRef?.id, previous.id, "New/duplicate cannot silently resume an older chat");
      assert.equal(fresh.resumeRef.id, previous.id);
    }
  }
}
for (const family of ["claude", "codex"]) {
  const fusion = restore({ ...base, kind: "fusion", fusionPlannerFamily: family, threadRef: { provider: family, id: "planner-chat" } });
  assert.equal(fusion.kind, "claude");
  assert.equal(fusion.fusion, true);
  assert.equal(fusion.nextLaunchMode, "resume");
  assert.equal(fusion.threadRef.provider, family);
  assert.equal(fusion.threadRef.id, "planner-chat");
  const mismatch = restore({ ...base, kind: "fusion", fusionPlannerFamily: family, threadRef: { provider: family === "codex" ? "claude" : "codex", id: "wrong-family" } });
  assert.equal(mismatch.nextLaunchMode, "new");
}
const openFusion = restore({ ...base, kind: "openfusion", threadRef: { provider: "opencode", id: "native-chat" } });
assert.equal(openFusion.kind, "opencode");
assert.equal(openFusion.openFusion, true);
assert.equal(openFusion.threadRef.id, "native-chat");
assert.equal(openFusion.nextLaunchMode, "resume");
assert.equal(restore({ ...base, kind: "terminal" }).nextLaunchMode, "new");
async function checkStart() {
  for (const native of [{ kind: "claude", fusion: true }, { kind: "codex", fusion: true, fusionPlannerFamily: "codex" }, { kind: "opencode", openFusion: true }, { kind: "codex" }]) {
    const paused = restore({ ...base, ...native, started: false, threadRef: { provider: native.kind, id: "paused-chat" } });
    updatedSessions = [paused];
    restoreContext.restartSession({}, paused);
    await Promise.resolve();
    assert.equal(updatedSessions[0].started, true);
    assert.equal(updatedSessions[0].nextLaunchMode, "new", "manual Start retains its prior fresh behavior");
    assert.notEqual(updatedSessions[0].threadRef?.id, "paused-chat");
    assert.equal(updatedSessions[0].resumeRef.id, "paused-chat");
    if (native.fusion || native.openFusion) {
      updatedSessions = [{ ...updatedSessions[0], threadRef: { provider: native.kind, id: "running-chat" } }];
      restoreContext.restartSession({}, updatedSessions[0]);
      await Promise.resolve();
      assert.equal(updatedSessions[0].nextLaunchMode, "new", "explicit running native-chat Restart stays fresh");
      assert.equal(updatedSessions[0].threadRef, undefined);
      assert.equal(updatedSessions[0].resumeRef.id, "running-chat");
    }
  }
  const original = { ...base, kind: 'codex' };
  for (const rejected of [false, new Error('transport unavailable')]) {
    updatedSessions = [original];
    restoreContext.stopSessionProcess = () => rejected === false ? Promise.resolve(false) : Promise.reject(rejected);
    assert.equal(await restoreContext.restartSession({}, original), false);
    assert.equal(updatedSessions[0], original, 'failed stop cannot restart a potentially live process');
  }
  assert.equal(restartMessages.length, 2, 'restart failure is visible and never an unhandled rejection');
  let stopped;
  restoreContext.stopSessionProcess = () => new Promise(resolve => { stopped = resolve; });
  updatedSessions = [original];
  const restart = restoreContext.restartSession({}, original);
  const replacement = { ...original, launchToken: 2 };
  updatedSessions = [replacement];
  stopped(true); await restart;
  assert.equal(updatedSessions[0], replacement, 'late restart cannot replace a newer launch');
  restoreContext.stopSessionProcess = () => Promise.resolve(true);
  updatedSessions = [original];
  await Promise.all([restoreContext.restartSession({}, original), restoreContext.restartSession({}, original)]);
  assert.equal(updatedSessions[0].launchToken, 2, 'concurrent restarts increment the original token once');
  const latest = { ...base, kind: 'codex', threadRef: { provider: 'codex', id: 'C' }, resumeRef: { provider: 'codex', id: 'A' } };
  updatedSessions = [latest];
  restoreContext.resumeSession({}, latest, latest.threadRef);
  await new Promise(setImmediate);
  assert.equal(updatedSessions[0].threadRef.id, 'C', 'Resume last uses the current native chat, even with older history');
  restoreContext.stopSessionProcess = () => Promise.resolve(false);
  updatedSessions = [latest];
  restoreContext.resumeSession({}, latest, latest.threadRef);
  await new Promise(setImmediate);
  assert.equal(updatedSessions[0], latest, 'failed stop cannot replace the live chat');
  restoreContext.stopSessionProcess = () => new Promise(resolve => { stopped = resolve; });
  updatedSessions = [latest];
  restoreContext.resumeSession({}, latest, latest.threadRef);
  const changed = { ...latest, threadRef: { provider: 'codex', id: 'D' } };
  updatedSessions = [changed]; stopped(true);
  await new Promise(setImmediate);
  assert.equal(updatedSessions[0], changed, 'a native chat change during stop cannot be replaced by stale resume');
}
checkStart().then(() => console.log("session persistence/migration and chat restore smoke passed")).catch(error => { console.error(error); process.exitCode = 1; });
