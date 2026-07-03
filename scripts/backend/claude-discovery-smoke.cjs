const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..", "..");
const root = path.join(
  rootDir,
  ".tmp",
  `claude-discovery-smoke-${Date.now()}-${process.pid}`
);
const claudeHome = path.join(root, "claude-home");
const projectsDir = path.join(claudeHome, "projects");
const projectDir = path.join(projectsDir, "encoded-repo");
const cwd = path.join(root, "repo");
const otherCwd = path.join(root, "other-repo");
const after = Date.parse("2026-06-26T16:00:00.000Z");

// findLatestClaudeThread reads CLAUDE_CONFIG_DIR, so point it at our fixture
// before requiring the host module.
process.env.CLAUDE_CONFIG_DIR = claudeHome;

const {
  collectJsonlFiles,
  confirmClaudeThread,
  findLatestClaudeThread
} = require("../../backend/agentThreadHost.cjs");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function writeTranscript(id, lines) {
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${id}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
  );
}

function find(overrides = {}) {
  return findLatestClaudeThread(
    overrides.cwd ?? cwd,
    overrides.after ?? after,
    overrides.excludeIds ?? []
  );
}

try {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(otherCwd, { recursive: true });

  assert(find() === null, "no transcripts should produce no match");

  // Title comes from array-shaped message content; must not stringify to
  // "[object Object]".
  writeTranscript("alpha", [
    {
      sessionId: "alpha",
      cwd,
      timestamp: iso(after + 1000),
      message: {
        content: [
          { type: "text", text: "Hello " },
          { type: "tool_use", name: "Bash" },
          { type: "text", text: "world" }
        ]
      }
    }
  ]);

  let result = find();
  assert(result && result.id === "alpha", "matching transcript should be found");
  assert(
    result.title === "Hello world",
    `array content should join text blocks, got: ${JSON.stringify(result.title)}`
  );

  result = find({ excludeIds: ["alpha"] });
  assert(result === null, "excluded session id should be skipped");

  // Adversarial transcript: a leading cwd-less meta line (tolerated) and a
  // foreign-cwd line (must NOT be harvested for identity) sit above our real
  // session line. We must still resolve to the matching-cwd session id/title,
  // never the intruder's, and never abort the file.
  writeTranscript("gamma", [
    { type: "summary", summary: "Recovered session" },
    { sessionId: "intruder", cwd: otherCwd, timestamp: iso(after + 5000) },
    {
      sessionId: "gamma",
      cwd,
      timestamp: iso(after + 2000),
      message: { content: "resume me" }
    }
  ]);

  result = find({ excludeIds: ["alpha"] });
  assert(
    result && result.id === "gamma",
    `identity must come from the matching-cwd line, got: ${JSON.stringify(result)}`
  );
  assert(
    result.title === "resume me",
    `title must come from the matching-cwd line, got: ${JSON.stringify(result.title)}`
  );

  // Title harvesting mirrors Claude's own /resume picker:
  // - the generic pane label this app once forced via --name is ignored,
  // - slash-command envelopes never title a thread,
  // - only the first line of the first real prompt is used.
  writeTranscript("delta-titles", [
    { type: "custom-title", customTitle: "Claude 7", sessionId: "delta-titles" },
    { type: "agent-name", agentName: "Claude 7", sessionId: "delta-titles" },
    {
      sessionId: "delta-titles",
      cwd,
      timestamp: iso(after + 6000),
      message: { content: "<command-name>/plan</command-name>" }
    },
    {
      sessionId: "delta-titles",
      cwd,
      timestamp: iso(after + 6100),
      type: "user",
      message: { content: "fix the flaky test\nplease" }
    }
  ]);

  result = find({ excludeIds: ["alpha", "gamma"] });
  assert(
    result && result.id === "delta-titles" && result.title === "fix the flaky test",
    `a generic custom-title must fall through to the first real prompt, got: ${JSON.stringify(result && result.title)}`
  );

  // A deliberate rename (non-generic custom-title) wins over the first prompt —
  // it is what Claude's own picker shows for that session.
  writeTranscript("epsilon-renamed", [
    {
      type: "custom-title",
      customTitle: "My renamed chat",
      sessionId: "epsilon-renamed"
    },
    {
      sessionId: "epsilon-renamed",
      cwd,
      timestamp: iso(after + 7000),
      message: { content: "first prompt text" }
    }
  ]);

  result = find({ excludeIds: ["alpha", "gamma", "delta-titles"] });
  assert(
    result && result.id === "epsilon-renamed" && result.title === "My renamed chat",
    `a deliberate custom title must win over the first prompt, got: ${JSON.stringify(result && result.title)}`
  );

  // Harvested titles are capped to a picker-style one-liner.
  writeTranscript("zeta-long", [
    {
      sessionId: "zeta-long",
      cwd,
      timestamp: iso(after + 8000),
      message: { content: "x".repeat(300) }
    }
  ]);

  result = find({
    excludeIds: ["alpha", "gamma", "delta-titles", "epsilon-renamed"]
  });
  assert(
    result && result.id === "zeta-long" && result.title.length <= 120,
    `harvested titles should be capped, got length ${result && result.title.length}`
  );

  // Sessions created before the cutoff are ignored.
  writeTranscript("old", [
    { sessionId: "old", cwd, timestamp: iso(after - 1000) }
  ]);

  result = find({
    excludeIds: ["alpha", "gamma", "delta-titles", "epsilon-renamed", "zeta-long"]
  });
  assert(result === null, "sessions older than the after cutoff should be ignored");

  // confirmClaudeThread underpins self-healing resume: only `claude --resume` an
  // id whose transcript actually exists; otherwise the launcher must start fresh
  // instead of hard-failing on "No conversation found".
  assert(
    confirmClaudeThread(cwd, "alpha").status === "found",
    "an id with a persisted transcript should confirm as found"
  );
  // Confirm doubles as the pane's title refresh: it must carry the harvested
  // title back so an untitled pane can adopt the generated one.
  const confirmedTitle = confirmClaudeThread(cwd, "epsilon-renamed");
  assert(
    confirmedTitle.status === "found" &&
      confirmedTitle.threadRef &&
      confirmedTitle.threadRef.title === "My renamed chat",
    `confirm should return the harvested title, got: ${JSON.stringify(confirmedTitle.threadRef && confirmedTitle.threadRef.title)}`
  );
  assert(
    confirmClaudeThread(cwd, "does-not-exist").status === "missing",
    "an id with no transcript should confirm as missing"
  );
  assert(
    confirmClaudeThread(cwd, "").status === "missing",
    "an empty id should confirm as missing"
  );

  // An id whose `<id>.jsonl` exists but under a different cwd must still report
  // "found" — re-pinning it with a fresh `--session-id` would collide on disk.
  writeTranscript("beta", [
    { sessionId: "beta", cwd: otherCwd, timestamp: iso(after + 3000) }
  ]);
  assert(
    confirmClaudeThread(cwd, "beta").status === "found",
    "an id whose transcript exists in another cwd should still confirm as found"
  );

  // confirm walks the whole projects tree, not just the cwd's project dir, so a
  // transcript filed under any project directory is located.
  const otherProjectDir = path.join(projectsDir, "encoded-other");
  fs.mkdirSync(otherProjectDir, { recursive: true });
  fs.writeFileSync(
    path.join(otherProjectDir, "delta.jsonl"),
    `${JSON.stringify({ sessionId: "delta", cwd, timestamp: iso(after + 4000) })}\n`
  );
  assert(
    confirmClaudeThread(cwd, "delta").status === "found",
    "confirm should find a transcript in any project dir, not only the cwd's"
  );

  // Claude's `<id>/subagents/agent-*.jsonl` tree must not be walked: it only
  // duplicates the parent id and can push the real transcript past the file
  // cap.
  const subagentDir = path.join(projectDir, "alpha", "subagents");
  fs.mkdirSync(subagentDir, { recursive: true });
  fs.writeFileSync(
    path.join(subagentDir, "agent-1.jsonl"),
    `${JSON.stringify({ sessionId: "alpha", cwd, timestamp: iso(after + 1500) })}\n`
  );

  const collected = collectJsonlFiles(projectsDir);
  assert(
    collected.some((file) => file.endsWith(`${path.sep}alpha.jsonl`)),
    "main transcripts should still be collected"
  );
  assert(
    !collected.some((file) => file.includes(`${path.sep}subagents${path.sep}`)),
    "subagents transcripts should be skipped by the walk"
  );
  const limitedCollected = collectJsonlFiles(projectsDir, 2);
  assert(
    limitedCollected.length === 2,
    "Claude transcript collection should honor the file cap"
  );

  const source = fs.readFileSync(
    path.join(rootDir, "backend", "agentThreadHost.cjs"),
    "utf8"
  );
  assert(
    source.includes("MAX_DISCOVERY_VISITS") &&
      source.includes("addRecentFile(") &&
      source.includes("readTranscriptHead(filePath, MAX_TRANSCRIPT_HEAD_BYTES)") &&
      !source.includes('fs.readFileSync(filePath, "utf8")'),
    "Claude discovery should bound traversal, candidate storage, and transcript reads"
  );

  console.log("Claude discovery smoke passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
