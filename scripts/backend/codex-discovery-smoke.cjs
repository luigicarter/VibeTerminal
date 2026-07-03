const fs = require("fs");
const path = require("path");
const {
  collectJsonlFiles,
  confirmCodexThread,
  findCodexThread
} = require("../../backend/agentThreads.cjs");

const rootDir = path.join(__dirname, "..", "..");
const root = path.join(
  rootDir,
  ".tmp",
  `codex-discovery-smoke-${Date.now()}-${process.pid}`
);
const codexHome = path.join(root, "codex-home");
const cwd = path.join(root, "repo");
const otherCwd = path.join(root, "other-repo");
const after = Date.parse("2026-06-26T16:00:00.000Z");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function writeRollout(id, options = {}) {
  const timestamp =
    options.timestamp ?? new Date(after + 1000).toISOString();
  const dayDir = path.join(codexHome, "sessions", "2026", "06", "26");
  fs.mkdirSync(dayDir, { recursive: true });

  const line = {
    type: "session_meta",
    payload: {
      id,
      session_id: id,
      cwd: options.cwd ?? cwd,
      // Pass an explicit `name: undefined` to mimic real rollouts, which
      // essentially never carry one.
      name: "name" in options ? options.name : `Thread ${id}`,
      timestamp,
      originator: options.originator ?? "Codex CLI"
    }
  };

  const lines = [line, ...(options.lines ?? [])];
  fs.writeFileSync(
    path.join(dayDir, `rollout-2026-06-26T16-00-01-${id}.jsonl`),
    `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`
  );
}

function discover(extraPayload = {}) {
  return findCodexThread(
    {
      cwd,
      after,
      ...extraPayload
    },
    {
      codexHome
    }
  );
}

try {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(otherCwd, { recursive: true });

  let result = discover();
  assert(result.status === "pending", "no matching session should be pending");

  writeRollout("one", { name: "One" });
  result = discover();
  assert(result.status === "found", "one matching session should be found");
  assert(result.threadRef.id === "one", "found session id should be exact");
  assert(result.threadRef.title === "One", "found title should be preserved");

  result = discover({ excludeIds: ["one"] });
  assert(result.status === "pending", "excluded matching id should be ignored");

  writeRollout("other-cwd", { cwd: otherCwd });
  result = discover();
  assert(
    result.status === "found" && result.threadRef.id === "one",
    "different cwd should not affect exact match"
  );

  writeRollout("two", { name: "Two" });
  result = discover();
  assert(result.status === "ambiguous", "two matching sessions should be ambiguous");
  assert(result.candidates.length === 2, "ambiguous result should include candidates");

  result = discover({ excludeIds: ["one"] });
  assert(
    result.status === "found" && result.threadRef.id === "two",
    "excluding an already-claimed id should allow the remaining candidate"
  );

  // confirmCodexThread: a rollout on disk for the exact id is resumable (matched
  // by the `-<id>.jsonl` filename suffix, no contents read); an unknown id is
  // missing so the launcher can self-heal to a fresh session.
  const confirmFound = confirmCodexThread(cwd, "one", { codexHome });
  assert(
    confirmFound.status === "found" && confirmFound.threadRef.id === "one",
    "an existing rollout id should confirm found"
  );

  const confirmOtherCwd = confirmCodexThread(cwd, "other-cwd", { codexHome });
  assert(
    confirmOtherCwd.status === "found",
    "confirm matches by id regardless of the rollout's cwd"
  );

  const confirmMissing = confirmCodexThread(cwd, "does-not-exist", { codexHome });
  assert(
    confirmMissing.status === "missing",
    "an absent rollout id should confirm missing so the launcher starts fresh"
  );

  // Codex generates no session title: harvest falls back to the first real
  // user_message in the rollout (instruction/environment envelopes that start
  // with "<" are skipped, and only the first line is used).
  writeRollout("three", {
    name: undefined,
    cwd: otherCwd,
    lines: [
      { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "<user_instructions>ignore me</user_instructions>"
        }
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "refactor the login flow\nand its tests"
        }
      }
    ]
  });
  const confirmTitled = confirmCodexThread(cwd, "three", { codexHome });
  assert(
    confirmTitled.status === "found" &&
      confirmTitled.threadRef.title === "refactor the login flow",
    `confirm should harvest the first real user message as the title, got: ${JSON.stringify(confirmTitled.threadRef.title)}`
  );

  // Discovery publishes the same fallback title, and internal bookkeeping
  // fields never leak into the published ref.
  writeRollout("four", {
    name: undefined,
    lines: [
      {
        type: "event_msg",
        payload: { type: "user_message", message: "ship the release" }
      }
    ]
  });
  result = discover({ excludeIds: ["one", "two"] });
  assert(
    result.status === "found" &&
      result.threadRef.id === "four" &&
      result.threadRef.title === "ship the release",
    `discovery should fall back to the rollout's first user message, got: ${JSON.stringify(result.threadRef && result.threadRef.title)}`
  );
  assert(
    !("rolloutPath" in result.threadRef) && !("cwd" in result.threadRef),
    "internal fields must not leak into published threadRefs"
  );

  const limitedFiles = collectJsonlFiles(path.join(codexHome, "sessions"), 2);
  assert(limitedFiles.length === 2, "transcript collection should honor the file cap");

  const source = fs.readFileSync(
    path.join(rootDir, "backend", "agentThreads.cjs"),
    "utf8"
  );
  assert(
    source.includes("MAX_DISCOVERY_VISITS") &&
      source.includes("addRecentFile(") &&
      source.includes("readFileHead(filePath, MAX_TRANSCRIPT_HEAD_BYTES)") &&
      !source.includes('fs.readFileSync(filePath, "utf8")'),
    "Codex discovery should bound traversal, candidate storage, and transcript reads"
  );

  console.log("Codex discovery smoke passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
