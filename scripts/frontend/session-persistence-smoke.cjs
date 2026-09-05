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
console.log("session persistence/migration smoke passed");
