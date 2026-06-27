const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const ts = require("typescript");

const sessionLaunchPath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "sessionLaunch.ts"
);
const terminalPanePath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "components",
  "TerminalPane.tsx"
);

const source = fs.readFileSync(sessionLaunchPath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  },
  fileName: sessionLaunchPath
}).outputText;

const testModule = new Module(sessionLaunchPath, module);
testModule.filename = sessionLaunchPath;
testModule.paths = Module._nodeModulePaths(path.dirname(sessionLaunchPath));
testModule._compile(compiled, sessionLaunchPath);

const { buildLaunchCommand, defaultLaunchMode } = testModule.exports;

function session(overrides) {
  return {
    id: "s1",
    name: "Codex 1",
    kind: "codex",
    command: "codex",
    cwd: "/repo",
    nextLaunchMode: "new",
    ...overrides
  };
}

// buildLaunchCommand: resume only materializes when a thread id exists,
// otherwise it falls back to a plain (new) launch.
assert.strictEqual(
  buildLaunchCommand(
    session({ nextLaunchMode: "resume", threadRef: { id: "abc123" } })
  ),
  "codex resume abc123",
  "codex resume with an id should build a resume command"
);
assert.strictEqual(
  buildLaunchCommand(session({ nextLaunchMode: "resume" })),
  "codex",
  "codex resume without an id should fall back to a plain launch"
);
assert.strictEqual(
  buildLaunchCommand(
    session({
      kind: "claude",
      command: "claude",
      nextLaunchMode: "resume",
      threadRef: { id: "uuid-1" }
    })
  ),
  "claude --resume uuid-1",
  "claude resume with an id should build a resume command"
);
assert.strictEqual(
  buildLaunchCommand(
    session({
      kind: "claude",
      command: "claude",
      name: "Chat1",
      nextLaunchMode: "new",
      threadRef: { id: "uuid-2" }
    })
  ),
  "claude --session-id uuid-2 --name Chat1",
  "claude new with an id should pin the session id and name"
);
assert.strictEqual(
  buildLaunchCommand(
    session({
      kind: "opencode",
      command: "opencode",
      nextLaunchMode: "resume",
      threadRef: { id: "sess9" }
    })
  ),
  "opencode --session sess9",
  "opencode resume with an id should build a resume command"
);
assert.strictEqual(
  buildLaunchCommand(
    session({ kind: "opencode", command: "opencode", nextLaunchMode: "resume" })
  ),
  "opencode",
  "opencode resume without an id should fall back to a plain launch"
);
assert.strictEqual(
  buildLaunchCommand(
    session({ kind: "terminal", command: "ls -la", nextLaunchMode: "new" })
  ),
  "ls -la",
  "a plain terminal should run its own command verbatim"
);

// defaultLaunchMode: "resume" requires a threaded kind, a prior launch, AND a
// known thread id — so a restart/restore never claims to resume a session it
// cannot actually identify.
assert.strictEqual(defaultLaunchMode("codex", 1, true), "resume");
assert.strictEqual(defaultLaunchMode("codex", 1, false), "new");
assert.strictEqual(defaultLaunchMode("codex", 0, true), "new");
assert.strictEqual(defaultLaunchMode("claude", 2, true), "resume");
assert.strictEqual(defaultLaunchMode("opencode", 3, false), "new");
assert.strictEqual(defaultLaunchMode("terminal", 1, true), "new");
assert.strictEqual(defaultLaunchMode("gemini", 5, true), "new");

// Regression tripwire: the xterm-creation effect must NOT depend on the command
// string, or a resume id discovered mid-session would tear down and blank the
// live pane (see scripts/frontend plan + TerminalPane Effect 1).
const terminalPaneSource = fs.readFileSync(terminalPanePath, "utf8");
assert(
  terminalPaneSource.includes("launchCommand"),
  "TerminalPane should still build a launch command"
);
assert(
  !terminalPaneSource.includes(
    "launchCommand,\n    profile.accent,\n    session.cwd,"
  ),
  "the terminal-creation effect must not list launchCommand in its dependencies"
);

console.log("session launch smoke passed");
