const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const source = fs.readFileSync(require("node:path").join(__dirname, "../../frontend/sessionDrafts.ts"), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const window = new EventTarget();
const exportsObject = {};
vm.runInNewContext(output, { require, exports: exportsObject, window, CustomEvent });
const { readSessionDraft, writeSessionDraft } = exportsObject;
test("Drafts stay in RAM across composer readers, use revisions, and do not cross sessions", () => {
  writeSessionDraft("one", "First draft");
  assert.equal(readSessionDraft("one").text, "First draft");
  assert.equal(readSessionDraft("two").text, "");
  const revision = readSessionDraft("one").revision;
  writeSessionDraft("one", "New draft");
  assert.throws(() => writeSessionDraft("one", "stale overwrite", revision), /Draft changed/);
});
test("Bridge stages an unmounted composer, returns current draft, and never submits", () => {
  const responses = [];
  window.addEventListener("vibe:composer-draft-result", e => responses.push(e.detail));
  window.dispatchEvent(new CustomEvent("vibe:composer-draft", { detail: { id: "unmounted", requestId: "r1", text: "Inspect this", paths: ["src/file.ts"], mode: "append" } }));
  assert.equal(responses[0].ok, true);
  assert.equal(readSessionDraft("unmounted").text, "Inspect this\nsrc/file.ts");
  window.dispatchEvent(new CustomEvent("vibe:composer-draft", { detail: { id: "unmounted", requestId: "r2", operation: "get" } }));
  assert.equal(responses[1].text, responses[0].text);
  assert.equal(responses[1].revision, responses[0].revision);
});
