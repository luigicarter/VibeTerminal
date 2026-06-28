const fs = require("fs");
const path = require("path");
const {
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
      name: options.name ?? `Thread ${id}`,
      timestamp,
      originator: options.originator ?? "Codex CLI"
    }
  };

  fs.writeFileSync(
    path.join(dayDir, `rollout-2026-06-26T16-00-01-${id}.jsonl`),
    `${JSON.stringify(line)}\n`
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

  console.log("Codex discovery smoke passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
