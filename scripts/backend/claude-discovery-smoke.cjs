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

  // Sessions created before the cutoff are ignored.
  writeTranscript("old", [
    { sessionId: "old", cwd, timestamp: iso(after - 1000) }
  ]);

  result = find({ excludeIds: ["alpha", "gamma"] });
  assert(result === null, "sessions older than the after cutoff should be ignored");

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

  console.log("Claude discovery smoke passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
