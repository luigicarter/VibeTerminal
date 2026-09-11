const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..", "..");
const root = path.join(
  rootDir,
  ".tmp",
  `qwen-discovery-smoke-${Date.now()}-${process.pid}`
);
const qwenHome = path.join(root, "qwen-home");
const cwd = path.join(root, "repo");
const otherCwd = path.join(root, "other-repo");
const after = Date.parse("2026-08-01T16:00:00.000Z");

// The qwen discovery functions read QWEN_HOME at call time, so point it at our
// fixture before requiring the host module.
process.env.QWEN_HOME = qwenHome;

const {
  confirmQwenThread,
  findLatestQwenThread,
  listQwenThreads,
  qwenChatsDir
} = require("../../backend/agentThreadHost.cjs");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// Mirror qwen's on-disk layout: per-project chats dirs holding one
// <sessionId>.jsonl transcript per session. Records carry ISO timestamps; the
// first real user message is the title source; file mtime is the recency
// signal.
function writeSession(id, workDir, { lines, mtime }) {
  const dir = qwenChatsDir(workDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join(""));
  if (mtime) {
    fs.utimesSync(file, new Date(mtime), new Date(mtime));
  }
  return file;
}

function userLine(sessionId, timestamp, text, provenance = "real_user") {
  return {
    uuid: `${sessionId}-user`,
    sessionId,
    timestamp: iso(timestamp),
    type: "user",
    provenance,
    message: { role: "user", parts: [{ text }] }
  };
}

function systemLine(sessionId, timestamp) {
  return {
    uuid: `${sessionId}-system`,
    sessionId,
    timestamp: iso(timestamp),
    type: "system",
    provenance: "system",
    subtype: "attribution_snapshot",
    systemPayload: {}
  };
}

function find(overrides = {}) {
  return findLatestQwenThread(
    overrides.cwd ?? cwd,
    overrides.after ?? after,
    overrides.excludeIds ?? []
  );
}

try {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(otherCwd, { recursive: true });

  assert(find() === null, "no chats dir should produce no match");

  writeSession("alpha", cwd, {
    lines: [userLine("alpha", after + 1000, "Fix the flaky test")],
    mtime: after + 1000
  });

  let result = find();
  assert(
    result && result.id === "alpha" && result.provider === "qwen",
    `the only matching session should be found, got: ${JSON.stringify(result)}`
  );
  assert(
    result.title === "Fix the flaky test",
    `title should come from the first user message, got: ${JSON.stringify(result.title)}`
  );
  assert(
    result.createdAt === after + 1000,
    "the first record's ISO timestamp should convert to ms createdAt"
  );

  // System/preamble records ahead of the first user message set createdAt but
  // never the title; the title waits for the first real user message.
  writeSession("beta", cwd, {
    lines: [
      systemLine("beta", after + 2000),
      userLine("beta", after + 2100, "summarize the diff")
    ],
    mtime: after + 2100
  });

  result = find();
  assert(
    result && result.id === "beta" && result.title === "summarize the diff",
    `title should skip system records, got: ${JSON.stringify(result && result.title)}`
  );
  assert(
    result.createdAt === after + 2000,
    "createdAt should come from the FIRST record, not the first user record"
  );

  // Recency sorts on file mtime, not createdAt: a resumed older session keeps
  // appending to its transcript, so its file jumps ahead.
  writeSession("gamma", cwd, {
    lines: [userLine("gamma", after + 500, "resumed chat")],
    mtime: after + 9000
  });

  result = find();
  assert(
    result && result.id === "gamma",
    `recency must sort on mtime, got: ${JSON.stringify(result && result.id)}`
  );

  // Sessions from another folder live in a different project dir and never
  // leak into this one.
  writeSession("delta", otherCwd, {
    lines: [userLine("delta", after + 9500, "foreign session")],
    mtime: after + 9500
  });

  result = find();
  assert(
    result && result.id === "gamma",
    `a foreign-cwd session must not win this folder, got: ${JSON.stringify(result && result.id)}`
  );
  result = find({ cwd: otherCwd });
  assert(
    result && result.id === "delta",
    "the foreign folder should see its own session"
  );

  // excludeIds and the after cutoff both apply.
  result = find({ excludeIds: ["gamma", "beta", "alpha"] });
  assert(result === null, "excluded session ids should be skipped");
  assert(
    find({ after: after + 8000, cwd: otherCwd })?.id === "delta",
    "the after cutoff filters on createdAt"
  );
  assert(
    find({ after: after + 8000 }) === null,
    "sessions created before the after cutoff should be ignored"
  );

  // Corrupt lines are skipped, never aborting the scan; non-jsonl files in the
  // chats dir are ignored entirely.
  writeSession("epsilon", cwd, {
    lines: [
      "this is not json",
      userLine("epsilon", after + 3000, "survives the garbage")
    ],
    mtime: after + 3000
  });
  fs.writeFileSync(path.join(qwenChatsDir(cwd), "notes.txt"), "not a session");

  result = find({ excludeIds: ["gamma", "beta", "alpha"] });
  assert(
    result && result.id === "epsilon" && result.title === "survives the garbage",
    `corrupt lines should be skipped, got: ${JSON.stringify(result)}`
  );

  // Harvested titles are picker-style one-liners: first non-empty line,
  // collapsed whitespace, length-capped.
  writeSession("zeta-long", cwd, {
    lines: [userLine("zeta-long", after + 9600, `\n  ${"x".repeat(300)}\nsecond line`)],
    mtime: after + 9600
  });
  result = find();
  assert(
    result &&
      result.id === "zeta-long" &&
      !result.title.includes("\n") &&
      result.title.length <= 120,
    `titles should be single-line and capped, got length ${result && result.title.length}`
  );

  // listQwenThreads backs the resume picker: every session for the folder,
  // newest first, foreign folders excluded.
  const listed = listQwenThreads(cwd, 0, []);
  assert(
    listed.status === "found" && listed.threads.length === 5,
    `list should return this folder's 5 sessions, got: ${listed.threads.length}`
  );
  assert(
    listed.threads[0].id === "zeta-long" &&
      listed.threads.every((thread) => thread.provider === "qwen"),
    "list should be newest-first qwen refs"
  );
  assert(
    listQwenThreads(cwd, 0, ["zeta-long", "gamma", "beta", "alpha", "epsilon"])
      .threads.length === 0,
    "list should honor excludeIds"
  );

  // confirmQwenThread underpins self-healing resume: only `qwen --resume` an
  // id that still exists; otherwise the launcher must start fresh.
  const confirmed = confirmQwenThread(cwd, "alpha");
  assert(
    confirmed.status === "found" &&
      confirmed.threadRef &&
      confirmed.threadRef.title === "Fix the flaky test",
    `confirm should return the harvested title, got: ${JSON.stringify(confirmed.threadRef && confirmed.threadRef.title)}`
  );
  assert(
    confirmQwenThread(cwd, "does-not-exist").status === "missing",
    "an id absent from a readable chats dir should confirm as missing"
  );
  assert(
    confirmQwenThread(cwd, "").status === "missing",
    "an empty id should confirm as missing"
  );

  // An unreadable store cannot prove absence: stay conservative ("found" with a
  // placeholder ref) and let `qwen --resume` try, mirroring the other
  // providers' confirm contracts.
  fs.rmSync(qwenChatsDir(cwd), { recursive: true, force: true });
  const conservative = confirmQwenThread(cwd, "anything");
  assert(
    conservative.status === "found" &&
      conservative.threadRef &&
      conservative.threadRef.id === "anything",
    "a missing chats dir should confirm as found with a placeholder ref"
  );

  console.log("Qwen discovery smoke passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
