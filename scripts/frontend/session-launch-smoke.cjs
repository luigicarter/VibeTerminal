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
const openFusionPath = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "openFusion.ts"
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

const openFusionSource = fs.readFileSync(openFusionPath, "utf8");
const compiledOpenFusion = ts.transpileModule(openFusionSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  },
  fileName: openFusionPath
}).outputText;
const openFusionModule = new Module(openFusionPath, module);
openFusionModule.filename = openFusionPath;
openFusionModule.paths = Module._nodeModulePaths(path.dirname(openFusionPath));
openFusionModule._compile(compiledOpenFusion, openFusionPath);
const {
  validateOpenFusionModel
} = openFusionModule.exports;

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
      name: "Claude 2",
      nextLaunchMode: "new",
      threadRef: { id: "uuid-2" }
    })
  ),
  "claude --session-id uuid-2",
  "claude new with an id should pin the session id and nothing else — forcing " +
    "--name overrides the title Claude generates for its own /resume picker"
);

// A mode override forces a fresh launch even when the session is set to resume —
// this is how the self-healing launcher recovers from a non-resumable id (no
// persisted transcript) while keeping Claude pinned to the pane's session id.
assert.strictEqual(
  buildLaunchCommand(
    session({
      kind: "claude",
      command: "claude",
      name: "Chat1",
      nextLaunchMode: "resume",
      threadRef: { id: "uuid-2", title: "Chat1" }
    }),
    { mode: "new" }
  ),
  "claude --session-id uuid-2",
  "a mode override should force a fresh claude launch even when resume is set"
);

// The command is typed into the platform shell, so argument quoting must match
// the shell. Single-quote wrapping is literal in both; only the embedded-quote
// escape differs (PowerShell doubles '', POSIX closes/escapes/reopens '\'').
assert.strictEqual(
  buildLaunchCommand(
    session({
      kind: "claude",
      command: "claude",
      nextLaunchMode: "resume",
      threadRef: { id: "My Project" }
    }),
    { platform: "win32" }
  ),
  "claude --resume 'My Project'",
  "an argument with spaces should be single-quoted"
);
assert.strictEqual(
  buildLaunchCommand(
    session({
      kind: "claude",
      command: "claude",
      nextLaunchMode: "resume",
      threadRef: { id: "It's mine" }
    }),
    { platform: "win32" }
  ),
  "claude --resume 'It''s mine'",
  "embedded single quotes should be doubled for PowerShell"
);
assert.strictEqual(
  buildLaunchCommand(
    session({
      kind: "claude",
      command: "claude",
      nextLaunchMode: "resume",
      threadRef: { id: "It's mine" }
    }),
    { platform: "linux" }
  ),
  "claude --resume 'It'\\''s mine'",
  "embedded single quotes should be backslash-escaped for POSIX shells"
);

// PowerShell also treats the typographic single quotes (U+2018/U+2019/U+201A/
// U+201B, common from autocorrect/paste) as string delimiters, so they must be
// doubled too — otherwise they terminate the argument and break the launch line.
assert.strictEqual(
  buildLaunchCommand(
    session({
      kind: "claude",
      command: "claude",
      nextLaunchMode: "resume",
      threadRef: { id: "Mike’s App" }
    }),
    { platform: "win32" }
  ),
  "claude --resume 'Mike’’s App'",
  "typographic single quotes should be doubled for PowerShell"
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
    session({
      kind: "opencode",
      command: "opencode",
      openFusion: true,
      nextLaunchMode: "new"
    })
  ),
  "opencode --agent planner",
  "Open Fusion should launch OpenCode directly into the planner agent"
);
assert.strictEqual(
  buildLaunchCommand(
    session({
      kind: "opencode",
      command: "opencode",
      openFusion: true,
      nextLaunchMode: "resume",
      threadRef: { id: "ofs9" }
    })
  ),
  "opencode --session ofs9 --agent planner",
  "Open Fusion resume should keep the planner agent selected"
);

const openFusionCurrent = {
  plannerModel: "anthropic/claude-sonnet-4-5",
  executorModel: "opencode/gpt-5.1-codex"
};
assert.strictEqual(
  validateOpenFusionModel("auto") !== null &&
    validateOpenFusionModel("bad model") !== null &&
    validateOpenFusionModel("openai/gpt-5.1") === null,
  true,
  "Open Fusion model validator should reject placeholders/spaces and allow provider ids"
);
assert.deepStrictEqual(
  {
    plannerModel: validateOpenFusionModel(openFusionCurrent.plannerModel),
    executorModel: validateOpenFusionModel(openFusionCurrent.executorModel)
  },
  {
    plannerModel: null,
    executorModel: null
  },
  "Open Fusion default launch models should validate"
);
assert.strictEqual(
  buildLaunchCommand(
    session({
      kind: "cursor",
      command: "cursor-agent",
      nextLaunchMode: "resume",
      threadRef: { id: "chat-7" }
    })
  ),
  "cursor-agent --resume chat-7",
  "cursor resume with an id should build a resume command"
);
assert.strictEqual(
  buildLaunchCommand(
    session({ kind: "cursor", command: "cursor-agent", nextLaunchMode: "resume" })
  ),
  "cursor-agent",
  "cursor resume without an id should fall back to a plain launch"
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
assert.strictEqual(defaultLaunchMode("cursor", 2, true), "resume");
assert.strictEqual(defaultLaunchMode("cursor", 1, false), "new");
assert.strictEqual(defaultLaunchMode("opencode", 3, false), "new");
assert.strictEqual(defaultLaunchMode("terminal", 1, true), "new");
assert.strictEqual(defaultLaunchMode("gemini", 5, true), "new");

// Regression tripwire: the xterm-lifecycle effect (the one that disposes the
// terminal) must depend ONLY on session.id. If launchCommand leaks into its
// deps, a resume id discovered mid-session tears down and blanks the live pane.
const terminalPaneSource = fs.readFileSync(terminalPanePath, "utf8");
assert(
  terminalPaneSource.includes("launchCommand"),
  "TerminalPane should still build a launch command"
);
assert(
  !terminalPaneSource.includes("open-fusion-control-strip") &&
    !terminalPaneSource.includes("parseOpenFusionSlashCommand") &&
    terminalPaneSource.includes("providerLogoSrc"),
  "Open Fusion panes should not render app-level model controls over the OpenCode TUI"
);

const lifecycleIdx = terminalPaneSource.indexOf("terminal.dispose()");
assert(
  lifecycleIdx !== -1,
  "expected a terminal-lifecycle effect that disposes the xterm instance"
);
const depsStart = terminalPaneSource.indexOf("}, [", lifecycleIdx);
const depsEnd = terminalPaneSource.indexOf("]);", depsStart);
assert(
  depsStart !== -1 && depsEnd !== -1,
  "expected the terminal-lifecycle effect to have a dependency array"
);
// Strip line comments (the deps comment legitimately mentions launchCommand) so
// the check only sees the actual dependency identifiers.
const lifecycleDeps = terminalPaneSource
  .slice(depsStart, depsEnd)
  .replace(/\/\/[^\n]*\n/g, "");
assert(
  !lifecycleDeps.includes("launchCommand"),
  "the terminal-lifecycle effect must not depend on launchCommand (it would blank the live pane on a mid-session resume id)"
);

assert(
  terminalPaneSource.includes("onFreshLaunchFallbackRef.current") &&
    terminalPaneSource.includes('currentSession.kind !== "claude"') &&
    terminalPaneSource.includes("forceThreadLookupTokenRef.current = currentSession.launchToken") &&
    terminalPaneSource.includes("(currentSession.threadRef?.id && !forceLookup)") &&
    terminalPaneSource.includes("latestSession.launchToken !== launchToken") &&
    terminalPaneSource.includes("latestSession.cwd !== cwd") &&
    terminalPaneSource.includes("threadLookupAfterRef.current !== lookupStartedAt") &&
    terminalPaneSource.includes("claimedThreadIdsRef.current.includes(result.threadRef.id)") &&
    terminalPaneSource.includes("forceThreadLookupTokenRef.current = null"),
  "a missing non-Claude resume id should fall back to a fresh launch, clear stale state, force rediscovery, and ignore stale async lookup results"
);

console.log("session launch smoke passed");
