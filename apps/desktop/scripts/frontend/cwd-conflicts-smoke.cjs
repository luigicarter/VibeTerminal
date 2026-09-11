// Shared-working-folder chip smoke test.
//
// Executes the real frontend/cwdConflicts.ts module (transpiled in-memory, no
// build step) against fixture sessions to lock the overlap semantics —
// normalization, boundary-safe nesting, terminal exclusion, cross-scope
// conflicts, and the active (simultaneous-turn) escalation — then grep-locks
// the App/pane/CSS wiring so the chip cannot silently fall out of the UI.

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const ts = require("typescript");

const cwdConflictsPath = path.join(__dirname, "..", "..", "frontend", "cwdConflicts.ts");
const appPath = path.join(__dirname, "..", "..", "frontend", "App.tsx");
const terminalPanePath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "components",
  "TerminalPane.tsx"
);
const fusionChatPanePath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "components",
  "FusionChatPane.tsx"
);
const openFusionChatPanePath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "components",
  "OpenFusionChatPane.tsx"
);
const stylesPath = path.join(__dirname, "..", "..", "frontend", "styles.css");

const source = fs.readFileSync(cwdConflictsPath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  },
  fileName: cwdConflictsPath
}).outputText;

const testModule = new Module(cwdConflictsPath, module);
testModule.filename = cwdConflictsPath;
testModule.paths = Module._nodeModulePaths(path.dirname(cwdConflictsPath));
testModule._compile(compiled, cwdConflictsPath);

const {
  computeCwdConflicts,
  cwdConflictChipLabel,
  cwdConflictTitle,
  cwdsOverlap,
  isCwdConflictWorkingStatus,
  normalizeCwdForConflict
} = testModule.exports;

function input(id, kind, cwd, status, scopeLabel, name) {
  return {
    session: { id, name: name ?? id, kind, cwd, status },
    scopeLabel
  };
}

// ---- normalization ----
assert.strictEqual(normalizeCwdForConflict("C:\\Repo\\"), "c:/repo");
assert.strictEqual(normalizeCwdForConflict("  /home/u/proj/ "), "/home/u/proj");
assert.strictEqual(normalizeCwdForConflict("C:/Repo\\sub"), "c:/repo/sub");
assert.strictEqual(
  normalizeCwdForConflict("C:\\REPO"),
  normalizeCwdForConflict("c:/repo")
);

// ---- overlap boundary ----
assert.strictEqual(cwdsOverlap("c:/repo", "c:/repo"), true);
assert.strictEqual(cwdsOverlap("c:/repo", "c:/repo/sub"), true);
assert.strictEqual(cwdsOverlap("c:/repo/sub", "c:/repo"), true);
assert.strictEqual(cwdsOverlap("c:/repo", "c:/repo2"), false);
assert.strictEqual(cwdsOverlap("c:/repo", "c:/repo-2"), false);
assert.strictEqual(cwdsOverlap("c:/repo/sub", "c:/repo/sub2"), false);

// ---- working statuses ----
assert.strictEqual(isCwdConflictWorkingStatus("running"), true);
assert.strictEqual(isCwdConflictWorkingStatus("starting"), true);
assert.strictEqual(isCwdConflictWorkingStatus("waiting"), false);
assert.strictEqual(isCwdConflictWorkingStatus("done"), false);
assert.strictEqual(isCwdConflictWorkingStatus("idle"), false);
assert.strictEqual(isCwdConflictWorkingStatus("failed"), false);

// ---- cross-scope conflict, cwds differing only by case/slashes ----
{
  const conflicts = computeCwdConflicts([
    input("a", "claude", "C:\\Repos\\App", "idle", "Multi", "Claude 1"),
    input("b", "codex", "c:/repos/app/", "waiting", "my-repo", "Codex 1")
  ]);
  assert.strictEqual(conflicts.size, 2);
  const a = conflicts.get("a");
  assert.strictEqual(a.peers.length, 1);
  assert.strictEqual(a.peers[0].name, "Codex 1");
  assert.strictEqual(a.peers[0].scopeLabel, "my-repo");
  assert.strictEqual(a.active, false);
  assert.strictEqual(conflicts.get("b").peers[0].scopeLabel, "Multi");
}

// ---- nested folders flag both sessions ----
{
  const conflicts = computeCwdConflicts([
    input("root", "claude", "C:\\repo", "idle", "Multi"),
    input("sub", "opencode", "c:/repo/packages/api", "idle", "Multi")
  ]);
  assert.strictEqual(conflicts.size, 2);
  assert.strictEqual(conflicts.get("root").peers[0].sessionId, "sub");
  assert.strictEqual(conflicts.get("sub").peers[0].sessionId, "root");
}

// ---- plain terminals are not autonomous writers ----
{
  const conflicts = computeCwdConflicts([
    input("shell", "terminal", "c:/repo", "running", "Multi"),
    input("agent", "claude", "c:/repo", "running", "Multi")
  ]);
  assert.strictEqual(conflicts.size, 0);
}

// ---- empty/whitespace cwd never overlaps ----
{
  const conflicts = computeCwdConflicts([
    input("a", "claude", "", "running", "Multi"),
    input("b", "codex", "   ", "running", "Multi")
  ]);
  assert.strictEqual(conflicts.size, 0);
}

// ---- active escalation: only when BOTH sides are working ----
{
  const bothRunning = computeCwdConflicts([
    input("a", "claude", "c:/repo", "running", "Multi"),
    input("b", "codex", "c:/repo", "running", "Multi")
  ]);
  assert.strictEqual(bothRunning.get("a").active, true);
  assert.strictEqual(bothRunning.get("b").active, true);

  const oneWaiting = computeCwdConflicts([
    input("a", "claude", "c:/repo", "running", "Multi"),
    input("b", "codex", "c:/repo", "waiting", "Multi")
  ]);
  assert.strictEqual(oneWaiting.get("a").active, false);
  assert.strictEqual(oneWaiting.get("b").active, false);

  // "starting" counts as working: harnesses begin writing right after boot.
  const startingPlusRunning = computeCwdConflicts([
    input("a", "claude", "c:/repo", "starting", "Multi"),
    input("b", "codex", "c:/repo", "running", "Multi")
  ]);
  assert.strictEqual(startingPlusRunning.get("a").active, true);
}

// ---- labels and tooltips ----
{
  const passive = computeCwdConflicts([
    input("a", "claude", "c:/repo", "idle", "Multi", "Claude 1"),
    input("b", "codex", "c:/repo", "idle", "my-repo", "Codex 1")
  ]).get("a");
  assert.strictEqual(cwdConflictChipLabel(passive), "×2 here");
  assert.strictEqual(cwdConflictTitle(passive), "Also in this folder: Codex 1 (my-repo)");

  const active = computeCwdConflicts([
    input("a", "claude", "c:/repo", "running", "Multi", "Claude 1"),
    input("b", "codex", "c:/repo", "running", "my-repo", "Codex 1")
  ]).get("a");
  assert.strictEqual(cwdConflictChipLabel(active), "×2 active");
  assert.strictEqual(
    cwdConflictTitle(active),
    "Codex 1 (my-repo) is also running in this folder right now — edits can collide."
  );

  const threeWay = computeCwdConflicts([
    input("a", "claude", "c:/repo", "running", "Multi", "Claude 1"),
    input("b", "codex", "c:/repo", "running", "Multi", "Codex 1"),
    input("c", "opencode", "c:/repo", "running", "my-repo", "Open Fusion 1")
  ]).get("a");
  assert.strictEqual(cwdConflictChipLabel(threeWay), "×3 active");
  assert.ok(cwdConflictTitle(threeWay).includes(" are also running in this folder"));
}

// ---- grep contracts: the chip stays wired into App, the panes, and the CSS ----
const appSource = fs.readFileSync(appPath, "utf8");
assert.ok(appSource.includes("computeCwdConflicts("), "App.tsx should compute cwd conflicts");
assert.ok(appSource.includes('scopeLabel: "Multi"'), "App.tsx should label Multi-scope sessions");
assert.ok(appSource.includes("scopeLabel: workspace.name"), "App.tsx should label workspace sessions");
assert.strictEqual(
  appSource.split("cwdConflict={cwdConflicts.get(session.id)}").length - 1,
  3,
  "App.tsx should pass cwdConflict to all three pane components"
);

for (const panePath of [terminalPanePath, fusionChatPanePath, openFusionChatPanePath]) {
  const paneSource = fs.readFileSync(panePath, "utf8");
  const paneName = path.basename(panePath);
  assert.ok(
    paneSource.includes("cwdConflict?: CwdConflict;"),
    `${paneName} should accept the cwdConflict prop`
  );
  assert.ok(
    paneSource.includes("pane-cwd-conflict-chip"),
    `${paneName} should render the shared-folder chip`
  );
}

const stylesSource = fs.readFileSync(stylesPath, "utf8");
assert.ok(
  stylesSource.includes(".pane-title .pane-cwd-conflict-chip"),
  "styles.css should style the shared-folder chip"
);
assert.ok(
  stylesSource.includes(".pane-cwd-conflict-chip.is-active"),
  "styles.css should style the active (simultaneous-turn) escalation"
);

console.log("cwd conflicts smoke passed");
