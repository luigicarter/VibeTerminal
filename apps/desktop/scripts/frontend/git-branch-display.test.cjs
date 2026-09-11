const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const compiled = ts.transpileModule(fs.readFileSync("frontend/gitDisplayState.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const context = { exports: {}, require }; vm.runInNewContext(compiled, context);
const { createGitDisplayObserver, upstreamLabel, worktreeLabel, branchPopupPosition } = context.exports;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
test("late project and closed-popup responses cannot overwrite the current snapshot", async () => {
  const a = deferred(), b = deferred(), published = [];
  const observer = (cwd, request) => createGitDisplayObserver({ cwd, expanded: true, readSummary: () => assert.fail(), readOverview: () => request.promise, publish: value => { if (value.overview) published.push(value.overview.cwd); } });
  const first = observer("a", a), firstRun = first.refresh(); first.dispose();
  const second = observer("b", b), secondRun = second.refresh();
  b.resolve({ state: "ok", cwd: "b", branches: [] }); await secondRun;
  a.resolve({ state: "ok", cwd: "a", branches: [] }); await firstRun;
  assert.deepEqual(published, ["b"]);
  const closed = deferred(), old = observer("b", closed), run = old.refresh(); old.dispose();
  closed.reject("obsolete error"); await run; assert.deepEqual(published, ["b"]);
});
test("refresh is single-flight, repeatable, and reports failures", async () => {
  const pending = deferred(), updates = []; let reads = 0;
  const observer = createGitDisplayObserver({ cwd: "a", expanded: true, readSummary: () => assert.fail(), readOverview: () => { reads++; return reads === 1 ? pending.promise : Promise.reject("Git IPC failed"); }, publish: value => updates.push(value) });
  const run = observer.refresh(); await observer.refresh(); assert.equal(reads, 1);
  pending.resolve({ state: "ok", branches: [], summary: { branch: "new-branch" } }); await run;
  assert.equal(updates.at(-1).summary.branch, "new-branch");
  await observer.refresh(); assert.equal(reads, 2); assert.equal(updates.at(-1).overview.state, "unavailable"); assert.equal(updates.at(-1).overview.message, "Git IPC failed");
});
test("working-tree labels and upstream labels preserve different kinds of state", () => {
  assert.match(upstreamLabel({ upstream: "origin/main", upstreamState: "tracked", ahead: 2, behind: 3 }), /2 ahead · 3 behind/);
  assert.match(upstreamLabel({ upstream: "origin/gone", upstreamState: "gone" }), /Upstream missing/);
  assert.equal(upstreamLabel({ upstreamState: "none" }), "No upstream");
  assert.match(upstreamLabel({ upstream: "origin/main", upstreamState: "tracked", ahead: 0, behind: 0 }), /fetched upstream/);
  assert.equal(worktreeLabel({ state: "dirty", changedFiles: 1, conflicts: 0 }), "1 changed file");
  assert.match(worktreeLabel({ state: "dirty", changedFiles: 2, conflicts: 1 }), /1 conflict/);
  assert.equal(worktreeLabel({ state: "unavailable" }), "Changes unavailable");
});
test("popup placement stays below the toolbar and inside compact viewports", () => {
  for (const [width, height] of [[1440, 960], [1024, 700], [600, 400]]) {
    const result = branchPopupPosition({ bottom: 99, right: width - 20 }, width, height);
    assert(result.top >= 99); assert(result.left >= 8); assert(result.left + result.width <= width - 8); assert(result.top + result.maxHeight <= height - 8);
  }
});
