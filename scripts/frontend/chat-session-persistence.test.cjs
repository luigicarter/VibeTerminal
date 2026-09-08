const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "../..");
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const persistence = { exports: {} };
vm.runInNewContext(compile(fs.readFileSync(path.join(root, "frontend/sessionPersistence.ts"), "utf8")), persistence);
const source = ts.createSourceFile("App.tsx", fs.readFileSync(path.join(root, "frontend/App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ["applyFusionChatLifecycle", "applyOpenFusionChatLifecycle"].includes(node.name?.text)) functions.push(node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(functions.length, 2);

for (const [kind, family, reducer] of [
  ["fusion", "claude", "applyFusionChatLifecycle"],
  ["fusion", "codex", "applyFusionChatLifecycle"],
  ["openFusion", "opencode", "applyOpenFusionChatLifecycle"]
]) {
  test(`${kind}/${family}: session identity persists without a mounted chat pane`, () => {
    let session = { id: "hidden-pane", kind: "claude", [kind]: true, started: true,
      createdAt: 1, status: "running", fusionPlannerFamily: family,
      resumeRef: { provider: family, id: "older-chat" } };
    const context = {
      ...persistence.exports,
      normalizedFusionSessionFields: session => ({ fusionPlannerFamily: session.fusionPlannerFamily }),
      updateAnySession: (id, update) => { if (id === session.id) session = update(session); }
    };
    vm.createContext(context);
    vm.runInContext(compile(functions.join("\n")), context);
    const event = { id: session.id, type: "session", sessionId: "saved-chat" };
    context[reducer](event);
    const saved = JSON.parse(JSON.stringify(context.serializeSession(session)));
    assert.equal(saved.threadRef.id, "saved-chat");
    assert.equal(saved.threadRef.provider, family);
    assert.equal(saved.resumeRef.id, "older-chat");
    assert.equal(saved.status, "running", "capturing identity cannot change chat activity");
    session = { ...session, threadRef: { ...session.threadRef, title: "Generated chat title" } };
    const named = session;
    context[reducer](event);
    assert.equal(session, named, "repeat identity preserves metadata and avoids another persistence write");
    for (const patch of [{ replay: true, sessionId: "old-replay" }, { sessionId: "" }, { sessionId: " " }, { id: "other-pane" }]) {
      context[reducer]({ ...event, ...patch });
      assert.equal(session, named, "stale replay, invalid identity and other panes cannot overwrite the saved chat");
    }
    session = { ...session, started: false };
    const paused = session;
    context[reducer]({ ...event, sessionId: "late-event" });
    assert.equal(session, paused, "late host events cannot rewrite a stopped pane");
  });
}
