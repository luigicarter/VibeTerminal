const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createAgentTelemetryManager,
  kimiHookTomlBlocks,
  mergeKimiHooks,
  stripKimiHooks
} = require("../../backend/agentTelemetry.cjs");

// kimi 0.42 externalHooks/internal/types.ts — the complete hook-event enum. One
// entry outside it drops the WHOLE `[[hooks]]` array with only a warning, so a
// single stray name silently disables every vibeTerminal kimi hook.
const KIMI_HOOK_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionResult",
  "UserPromptSubmit",
  "UserPromptQueued",
  "TurnStarted",
  "Stop",
  "StopFailure",
  "Interrupt",
  "SessionStart",
  "SessionEnd",
  "SessionHeartbeat",
  "SubagentStart",
  "SubagentStop",
  "TaskStarted",
  "PreCompact",
  "PostCompact",
  "Notification"
]);

// kimi 0.42 externalHooks/configSection.ts — a `.strict()` object with exactly
// these four keys; timeout is an integer number of SECONDS between 1 and 600.
const KIMI_HOOK_FIELDS = new Set(["event", "matcher", "command", "timeout"]);

// Every tool that spawns a subagent (the mirrorAgentRun call sites) and whether
// the tool call awaits its children before returning its result. A subagent
// fires the session-level Stop hook itself, so an awaiting delegation that is
// not bracketed settles the pane "done" on its first child; a detached one has
// no bracket to close and relies on the native task metadata observer.
const DELEGATION_TOOLS = [
  // agent/tools/agent/agentTool.ts:332 — foreground path awaits; the
  // run_in_background return at :512 and the mid-run detach at :519 do not.
  { name: "Agent", awaits: true },
  // features/swarm/session/sessionSwarmService.ts:191 — every task is
  // runInBackground:false (agentSwarmTool.ts:185), runSwarm awaits
  // swarmService.run (:203), and AgentRunBatch.run resolves only once every
  // attempt has finished (session/agentRunBatch.ts:149-172).
  { name: "AgentSwarm", awaits: true },
  // features/tower/tools/spawn/spawnTool.ts:333 — runInBackground:true (:325),
  // the handle is returned unawaited (:341-347), the tool only does
  // `void handle.completion` (:200,:206) and says so in its output (:273).
  { name: "TowerSpawn", awaits: false }
];

const SHIM_ROOT = "C:/Users/tester/AppData/Roaming/vibe-terminal/agent-shims";

function orphanBlock(runId, event, type) {
  // Exactly what kimi's own TOML writer leaves behind after it round-trips the
  // file: the same hook, re-quoted as a basic string, with our marker comment
  // dropped on the floor.
  return [
    "[[hooks]]",
    `event = "${event}"`,
    `command = "powershell -NoProfile -ExecutionPolicy Bypass -File \\"${SHIM_ROOT}/${runId}/notify.ps1\\" ${type}"`,
    "timeout = 5"
  ].join("\n");
}

// A config in the state a real machine reaches: unmarked orphans from dead app
// launches, one block that still carries the marker from another dead launch, a
// hook the user wrote themselves, and ordinary settings around them.
const FIXTURE_CONFIG = [
  'default_model = "kimi-code/kimi-for-coding"',
  "",
  "# the user's own comment",
  "[thinking]",
  "enabled = true",
  'effort = "max"',
  "",
  orphanBlock("1111111111111-100-dead-run-a", "UserPromptSubmit", "agent.running"),
  "",
  orphanBlock("2222222222222-200-dead-run-b", "PostToolUse", "agent.running tool"),
  "",
  orphanBlock("3333333333333-300-dead-run-c", "Stop", "agent.completed"),
  "",
  "# vibeterminal-kimi-notify",
  "[[hooks]]",
  "event = 'StopFailure'",
  `command = 'powershell -NoProfile -ExecutionPolicy Bypass -File "${SHIM_ROOT}/4444444444444-400-dead-run-d/notify.ps1" agent.failed'`,
  "timeout = 5",
  "",
  "[[hooks]]",
  "event = 'SessionStart'",
  "command = 'C:/Users/tester/bin/my-own-session-hook.cmd --announce'",
  "timeout = 30",
  "",
  '[models."kimi-code/k3"]',
  'provider = "managed:kimi-code"',
  "max_context_size = 1048576",
  ""
].join("\n");

const DEAD_RUN_IDS = [
  "1111111111111-100-dead-run-a",
  "2222222222222-200-dead-run-b",
  "3333333333333-300-dead-run-c",
  "4444444444444-400-dead-run-d"
];

// Split a config into its `[[hooks]]` blocks as { event, matcher, command,
// timeout, keys } records, ignoring every other section.
function hookBlocks(toml) {
  const lines = toml.split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (/^\s*\[\[\s*hooks\s*\]\]\s*$/.test(line)) {
      current = { keys: [] };
      blocks.push(current);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    current.keys.push(match[1]);
    current[match[1]] = match[2].trim();
  }
  return blocks;
}

function unquote(value) {
  return typeof value === "string" ? value.replace(/^['"]|['"]$/g, "") : value;
}

async function ensureInto(t, config) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-kimi-hooks-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "kimi-home");
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "config.toml");
  if (config !== null) fs.writeFileSync(file, config);

  const manager = createAgentTelemetryManager({
    baseDir: path.join(base, "shims"),
    runId: "9999999999999-900-live-run"
  });
  t.after(() => manager.cleanup());
  await manager.ensureKimiHooks(home);
  return { manager, home, file, read: () => fs.readFileSync(file, "utf8") };
}

test("ensure collects orphaned hook blocks and preserves everything else", async (t) => {
  const fixture = await ensureInto(t, FIXTURE_CONFIG);
  const after = fixture.read();

  // The user's own hook survives verbatim, with its own timeout.
  const userBlock = hookBlocks(after).find(
    (block) => unquote(block.event) === "SessionStart"
  );
  assert.ok(userBlock, "the user's SessionStart hook must survive");
  assert.equal(
    unquote(userBlock.command),
    "C:/Users/tester/bin/my-own-session-hook.cmd --announce"
  );
  assert.equal(userBlock.timeout, "30");

  // Every other section comes back byte-for-byte, comment included.
  for (const kept of [
    'default_model = "kimi-code/kimi-for-coding"',
    "# the user's own comment",
    "[thinking]\nenabled = true\neffort = \"max\"",
    '[models."kimi-code/k3"]\nprovider = "managed:kimi-code"\nmax_context_size = 1048576'
  ]) {
    assert.ok(after.includes(kept), `config must preserve: ${kept}`);
  }

  // Not one reference to any dead run is left.
  for (const runId of DEAD_RUN_IDS) {
    assert.equal(after.includes(runId), false, `${runId} must be collected`);
  }

  // Exactly one current set, all of it pointing at this run.
  const ours = hookBlocks(after).filter((block) =>
    unquote(block.command).includes("notify")
  );
  assert.equal(ours.length, hookBlocks(kimiHookTomlBlocks("x/notify.sh", false)).length);
  assert.equal(
    ours.every((block) => unquote(block.command).includes("9999999999999-900-live-run")),
    true,
    "every installed hook must point at the current run directory"
  );
  assert.equal(
    (after.match(/event = 'UserPromptSubmit'/g) || []).length,
    1,
    "the turn-start hook must be installed exactly once"
  );
});

test("installed blocks stay inside kimi 0.42's strict hook schema", async (t) => {
  const fixture = await ensureInto(t, FIXTURE_CONFIG);
  const blocks = hookBlocks(fixture.read());
  assert.ok(blocks.length > 0);

  for (const block of blocks) {
    for (const key of block.keys) {
      assert.ok(
        KIMI_HOOK_FIELDS.has(key),
        `a [[hooks]] block may only carry event/matcher/command/timeout; got ${key}`
      );
    }
    assert.ok(
      KIMI_HOOK_EVENTS.has(unquote(block.event)),
      `hook event must be in kimi's enum; got ${block.event}`
    );
    assert.match(
      String(block.timeout),
      /^\d+$/,
      `timeout must be an integer number of seconds; got ${block.timeout}`
    );
    const seconds = Number(block.timeout);
    assert.ok(seconds >= 1 && seconds <= 600, `timeout out of range: ${seconds}`);
  }
});

test("the delegation bracket matches every awaiting delegation tool", async (t) => {
  const blocks = hookBlocks(fs.readFileSync((await ensureInto(t, FIXTURE_CONFIG)).file, "utf8"));
  const bracket = blocks.filter((block) =>
    unquote(block.command).includes("agent.subagent.")
  );
  // Opened on the pre-tool event, closed on BOTH post-tool events: an aborted or
  // throwing tool call is turned into an isError result, which arrives as
  // PostToolUseFailure rather than PostToolUse.
  const phase = (block) =>
    `${unquote(block.event)} -> ${/agent\.subagent\.\w+/.exec(unquote(block.command))[0]}`;
  assert.deepEqual(bracket.map(phase).sort(), [
    "PostToolUse -> agent.subagent.stopped",
    "PostToolUseFailure -> agent.subagent.stopped",
    "PreToolUse -> agent.subagent.started"
  ]);

  for (const block of bracket) {
    const matcher = unquote(block.matcher);
    assert.ok(matcher, `${block.event} bracket entry needs a matcher`);
    // kimi tests the matcher as a JavaScript RegExp against the tool name.
    const test = new RegExp(matcher);
    for (const tool of DELEGATION_TOOLS) {
      assert.equal(
        test.test(tool.name),
        tool.awaits,
        `${matcher} must match ${tool.name} only when its call awaits its children`
      );
    }
    // And nothing else: an over-broad matcher would open a bracket per tool call.
    for (const other of ["Bash", "Read", "Edit", "AgentSwarmExtra", "TowerStatus"]) {
      assert.equal(test.test(other), false, `${matcher} must not match ${other}`);
    }
  }
});

test("ensure is byte-identical when run again", async (t) => {
  const fixture = await ensureInto(t, FIXTURE_CONFIG);
  const once = fixture.read();
  await fixture.manager.ensureKimiHooks(fixture.home);
  assert.equal(fixture.read(), once, "a second ensure must not change a byte");
  await fixture.manager.ensureKimiHooks(fixture.home);
  assert.equal(fixture.read(), once, "and neither must a third");
});

test("a config we created is removed again on cleanup", async (t) => {
  const fixture = await ensureInto(t, null);
  assert.ok(fs.existsSync(fixture.file), "ensure should create a hooks-only config");
  assert.equal(stripKimiHooks(fixture.read()).hasOtherContent, false);
  fixture.manager.cleanup();
  assert.equal(fs.existsSync(fixture.file), false, "our own config should not outlive us");
});

test("strip recognises our commands however the file was last written", () => {
  const blocks = kimiHookTomlBlocks("/tmp/shims/run-1/notify.sh", false);
  // Literal-string form (ours), basic-string form (kimi's writer), and a
  // Windows path with backslashes all strip; a user hook never does.
  const rewritten = blocks
    .replace(/^# vibeterminal-kimi-notify\n/gm, "")
    .replace(/command = '(.*)'$/gm, (line, value) => `command = "${value.replace(/"/g, '\\"')}"`);
  assert.equal(stripKimiHooks(rewritten).trimmed, "");
  assert.equal(
    stripKimiHooks(
      '[[hooks]]\nevent = "Stop"\ncommand = "C:\\\\shims\\\\run-2\\\\notify.ps1 agent.completed"\ntimeout = 5\n'
    ).trimmed,
    ""
  );
  const userOnly = "[[hooks]]\nevent = 'Stop'\ncommand = 'notify-me.sh agent-done'\ntimeout = 5";
  assert.equal(stripKimiHooks(userOnly).trimmed, userOnly);
  assert.equal(
    mergeKimiHooks(userOnly, blocks).includes("notify-me.sh agent-done"),
    true,
    "a merge must never drop a user hook"
  );
});
