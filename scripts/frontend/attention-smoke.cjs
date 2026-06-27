const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const ts = require("typescript");

const attentionPath = path.join(__dirname, "..", "..", "frontend", "attention.ts");
const appPath = path.join(__dirname, "..", "..", "frontend", "App.tsx");
const terminalPanePath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "components",
  "TerminalPane.tsx"
);
const stylesPath = path.join(__dirname, "..", "..", "frontend", "styles.css");
const source = fs.readFileSync(attentionPath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  },
  fileName: attentionPath
}).outputText;

const testModule = new Module(attentionPath, module);
testModule.filename = attentionPath;
testModule.paths = Module._nodeModulePaths(path.dirname(attentionPath));
testModule._compile(compiled, attentionPath);

const {
  attentionFromEvent,
  clearUnreadAttention,
  normalizeAttention,
  shouldMarkAttentionUnread,
  shouldShowAttentionDot
} = testModule.exports;

const completed = {
  state: "completed",
  reason: "done",
  source: "shim",
  updatedAt: 100
};
const failed = {
  state: "failed",
  reason: "exit",
  source: "shim",
  updatedAt: 101
};
const waiting = {
  state: "waiting",
  reason: "question",
  source: "provider",
  updatedAt: 102
};
const none = {
  state: "none",
  source: "process",
  updatedAt: 103
};

assert.strictEqual(normalizeAttention(undefined).state, "none");
assert.strictEqual(attentionFromEvent(completed, true).unread, true);
assert.strictEqual(attentionFromEvent(completed, false).unread, false);
assert.strictEqual(attentionFromEvent(none, true).unread, false);
assert.strictEqual(
  shouldMarkAttentionUnread("one", "one", ["one"], completed),
  false
);
assert.strictEqual(
  shouldMarkAttentionUnread("one", "one", ["two"], completed),
  true
);
assert.strictEqual(
  shouldMarkAttentionUnread("one", null, ["one"], completed),
  true
);
assert.strictEqual(
  shouldMarkAttentionUnread("one", "one", ["one"], none),
  false
);

assert.strictEqual(
  shouldShowAttentionDot({ id: "one", attention: { ...completed, unread: true } }),
  true
);
assert.strictEqual(
  shouldShowAttentionDot({ id: "two", attention: { ...failed, unread: true } }),
  true
);
assert.strictEqual(
  shouldShowAttentionDot({ id: "three", attention: { ...waiting, unread: true } }),
  true
);
assert.strictEqual(
  shouldShowAttentionDot({ id: "four", attention: { ...completed, unread: false } }),
  false
);
assert.strictEqual(
  shouldShowAttentionDot({ id: "five", attention: { ...none, unread: true } }),
  false
);

const readSession = { id: "six", attention: { ...completed, unread: false } };
assert.strictEqual(clearUnreadAttention(readSession), readSession);

const unreadSession = { id: "seven", attention: { ...completed, unread: true } };
const clearedSession = clearUnreadAttention(unreadSession);
assert.notStrictEqual(clearedSession, unreadSession);
assert.strictEqual(clearedSession.attention.unread, false);

const appSource = fs.readFileSync(appPath, "utf8");
const workspaceRowIndex = appSource.indexOf('"workspace-button"');
const workspaceDotIndex = appSource.indexOf('"attention-dot"', workspaceRowIndex);
const workspaceFolderIndex = appSource.indexOf("<Folder", workspaceRowIndex);
assert(
  workspaceDotIndex !== -1 &&
    workspaceFolderIndex !== -1 &&
    workspaceDotIndex < workspaceFolderIndex,
  "workspace attention dot should render before the folder icon"
);

const terminalPaneSource = fs.readFileSync(terminalPanePath, "utf8");
assert(
  !terminalPaneSource.includes("onFocus={onSelect}"),
  "terminal focus should not clear unread attention"
);

const stylesSource = fs.readFileSync(stylesPath, "utf8");
assert(
  stylesSource.includes("grid-template-columns: 9px 18px minmax(0, 1fr) 16px;"),
  "workspace row grid should reserve dot space before the folder icon"
);

console.log("attention smoke passed");
