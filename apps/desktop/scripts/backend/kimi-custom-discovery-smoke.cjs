const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..", "..");
const root = path.join(
  rootDir,
  ".tmp",
  `kimi-custom-discovery-smoke-${Date.now()}-${process.pid}`
);
const kimiCustomHome = path.join(root, "kimi-custom-home");
const indexPath = path.join(kimiCustomHome, "session_index.jsonl");
const cwd = path.join(root, "repo");
const otherCwd = path.join(root, "other-repo");
const after = Date.parse("2026-06-26T16:00:00.000Z");

// The kimi-custom discovery functions resolve the shared kimi-code home
// ($KIMI_CODE_HOME or ~/.kimi-code) at call time, so point it at our fixture
// before requiring the host module.
process.env.KIMI_CODE_HOME = kimiCustomHome;

const {
  confirmKimiCustomThread,
  findLatestKimiCustomThread,
  listKimiCustomThreads
} = require("../../backend/agentThreadHost.cjs");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// Mirror Kimi's on-disk layout: an append-only session_index.jsonl whose
// sessionDir points at <home>/sessions/<workspaceId>/<sessionId>, holding
// state.json. Both shapes appear on a real machine — pre-0.42 ISO strings with
// `workDir`, and 0.42's epoch-ms numbers with `cwd`/`archived`/`titleKind` —
// so both are exercised below.
function writeSession(id, workDir, state) {
  const sessionDir = path.join(kimiCustomHome, "sessions", `wd_fixture_${id}`, id);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify(state));
  fs.appendFileSync(
    indexPath,
    `${JSON.stringify({ sessionId: id, sessionDir, workDir })}\n`
  );
}

function find(overrides = {}) {
  return findLatestKimiCustomThread(
    overrides.cwd ?? cwd,
    overrides.after ?? after,
    overrides.excludeIds ?? []
  );
}

try {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(otherCwd, { recursive: true });
  fs.mkdirSync(kimiCustomHome, { recursive: true });

  assert(find() === null, "no index file should produce no match");

  writeSession("alpha", cwd, {
    title: "Fix the flaky test",
    createdAt: iso(after + 1000),
    updatedAt: iso(after + 1000),
    workDir: cwd
  });

  let result = find();
  assert(
    result && result.id === "alpha" && result.provider === "kimi-custom",
    `the only matching session should be found, got: ${JSON.stringify(result)}`
  );
  assert(
    result.title === "Fix the flaky test",
    `title should come from state.json, got: ${JSON.stringify(result.title)}`
  );
  assert(
    result.createdAt === after + 1000 && result.updatedAt === after + 1000,
    "ISO timestamps should convert to ms"
  );

  // A session without a generated title yet falls back to its opening prompt.
  writeSession("beta", cwd, {
    lastPrompt: "summarize the diff",
    createdAt: iso(after + 2000),
    updatedAt: iso(after + 2000),
    workDir: cwd
  });

  result = find();
  assert(
    result && result.id === "beta" && result.title === "summarize the diff",
    `title should fall back to lastPrompt, got: ${JSON.stringify(result && result.title)}`
  );

  // Recency sorts on updatedAt, not index order: a resumed older session with
  // the newest update wins.
  writeSession("gamma", cwd, {
    title: "resumed chat",
    createdAt: iso(after + 500),
    updatedAt: iso(after + 9000),
    workDir: cwd
  });

  result = find();
  assert(
    result && result.id === "gamma",
    `recency must sort on updatedAt, got: ${JSON.stringify(result && result.id)}`
  );

  // Sessions from another folder never leak into this one (the index is
  // global, unlike the per-cwd claude/cursor stores).
  writeSession("delta", otherCwd, {
    title: "foreign session",
    createdAt: iso(after + 9500),
    updatedAt: iso(after + 9500),
    workDir: otherCwd
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

  // Malformed index lines and stale entries (sessionDir deleted) are skipped,
  // never aborting the lookup.
  fs.appendFileSync(indexPath, "this is not json\n");
  fs.appendFileSync(indexPath, `${JSON.stringify({ sessionId: "incomplete" })}\n`);
  fs.appendFileSync(
    indexPath,
    `${JSON.stringify({
      sessionId: "ghost",
      sessionDir: path.join(kimiCustomHome, "sessions", "wd_fixture_ghost", "ghost"),
      workDir: cwd
    })}\n`
  );

  result = find({ excludeIds: ["gamma", "beta", "alpha"] });
  assert(result === null, "stale/malformed index lines should be skipped");
  result = find();
  assert(
    result && result.id === "gamma",
    "valid sessions still resolve around malformed lines"
  );

  // Harvested titles are picker-style one-liners: first non-empty line,
  // collapsed whitespace, length-capped.
  writeSession("epsilon-long", cwd, {
    title: `\n  ${"x".repeat(300)}\nsecond line`,
    createdAt: iso(after + 9600),
    updatedAt: iso(after + 9600),
    workDir: cwd
  });
  result = find();
  assert(
    result &&
      result.id === "epsilon-long" &&
      !result.title.includes("\n") &&
      result.title.length <= 120,
    `titles should be single-line and capped, got length ${result && result.title.length}`
  );

  // listKimiCustomThreads backs the resume picker: every session for the
  // folder, newest first, foreign folders excluded.
  const listed = listKimiCustomThreads(cwd, 0, []);
  assert(
    listed.status === "found" && listed.threads.length === 4,
    `list should return this folder's 4 sessions, got: ${listed.threads.length}`
  );
  assert(
    listed.threads[0].id === "epsilon-long" &&
      listed.threads.every((thread) => thread.provider === "kimi-custom"),
    "list should be newest-first kimi-custom refs"
  );
  assert(
    listKimiCustomThreads(cwd, 0, ["epsilon-long", "gamma", "beta", "alpha"]).threads
      .length === 0,
    "list should honor excludeIds"
  );

  // confirmKimiCustomThread underpins self-healing resume: only
  // `kimi-custom --session` an id that still exists; otherwise the launcher
  // must start fresh.
  const confirmed = confirmKimiCustomThread(cwd, "alpha");
  assert(
    confirmed.status === "found" &&
      confirmed.threadRef &&
      confirmed.threadRef.title === "Fix the flaky test",
    `confirm should return the harvested title, got: ${JSON.stringify(confirmed.threadRef && confirmed.threadRef.title)}`
  );
  assert(
    confirmKimiCustomThread(cwd, "does-not-exist").status === "missing",
    "an id absent from a readable index should confirm as missing"
  );
  assert(
    confirmKimiCustomThread(cwd, "").status === "missing",
    "an empty id should confirm as missing"
  );

  // Kimi Code 0.42 writes a different state.json: epoch-MILLISECOND timestamps
  // instead of ISO strings, `cwd` instead of `workDir`, an `archived` flag, and
  // `titleKind` recording where the title came from. Reading only ISO strings
  // left every 0.42 session at 0/0, which dropped them under an `after` cutoff
  // and flattened picker recency. These live in their own folder so the older
  // fixtures above keep their counts.
  const modernCwd = path.join(root, "modern-repo");
  fs.mkdirSync(modernCwd, { recursive: true });
  const modern = (overrides = {}) => ({
    version: 2,
    cwd: modernCwd,
    archived: false,
    isCustomTitle: false,
    ...overrides
  });

  writeSession(
    "session_11111111-1111-4111-8111-111111111111",
    modernCwd,
    modern({
      id: "session_11111111-1111-4111-8111-111111111111",
      createdAt: after + 1000,
      updatedAt: after + 1000,
      lastPrompt: "wire up the status hooks",
      title: "wire up the status hooks",
      titleKind: "replaceable"
    })
  );
  let modernResult = find({ cwd: modernCwd });
  assert(
    modernResult &&
      modernResult.id === "session_11111111-1111-4111-8111-111111111111" &&
      modernResult.createdAt === after + 1000 &&
      modernResult.updatedAt === after + 1000,
    `0.42 epoch-ms timestamps must be read as-is, got: ${JSON.stringify(modernResult)}`
  );
  assert(
    modernResult.title === "wire up the status hooks" &&
      modernResult.titleSource === "preview",
    "a replaceable title is the opening prompt standing in, not a named thread"
  );

  // A model-written title is "generated"; one the user typed is "named".
  writeSession(
    "session_22222222-2222-4222-8222-222222222222",
    modernCwd,
    modern({
      createdAt: after + 2000,
      updatedAt: after + 2000,
      title: "Status hook rollout",
      titleKind: "generated"
    })
  );
  assert(
    find({ cwd: modernCwd })?.titleSource === "generated",
    "a generated title should be reported as generated"
  );
  writeSession(
    "session_33333333-3333-4333-8333-333333333333",
    modernCwd,
    modern({
      createdAt: after + 3000,
      updatedAt: after + 3000,
      title: "My own name",
      titleKind: "custom",
      isCustomTitle: true
    })
  );
  assert(
    find({ cwd: modernCwd })?.titleSource === "named",
    "a user-typed title should be reported as named"
  );

  // Archived sessions are hidden from resume, exactly as kimi's own session
  // queries hide them — but they still exist, so confirm stays conservative.
  writeSession(
    "session_44444444-4444-4444-8444-444444444444",
    modernCwd,
    modern({
      createdAt: after + 9000,
      updatedAt: after + 9000,
      archived: true,
      title: "archived work"
    })
  );
  assert(
    find({ cwd: modernCwd })?.id === "session_33333333-3333-4333-8333-333333333333",
    "an archived session must not win the latest slot"
  );
  assert(
    listKimiCustomThreads(modernCwd, 0, []).threads.every(
      (thread) => thread.id !== "session_44444444-4444-4444-8444-444444444444"
    ),
    "an archived session must not be offered in the picker"
  );
  assert(
    confirmKimiCustomThread(modernCwd, "session_44444444-4444-4444-8444-444444444444").status ===
      "found",
    "an archived session still exists, so confirm must not call it missing"
  );

  // A child session (a detached task's own session) is never a resume target.
  writeSession(
    "session_55555555-5555-4555-8555-555555555555",
    modernCwd,
    modern({
      createdAt: after + 9500,
      updatedAt: after + 9500,
      title: "child work",
      custom: {
        parent_session_id: "session_11111111-1111-4111-8111-111111111111",
        child_session_kind: "child"
      }
    })
  );
  assert(
    find({ cwd: modernCwd })?.id === "session_33333333-3333-4333-8333-333333333333",
    "a child session must not be offered as a root thread"
  );

  // The 0.42 `cwd` field is honoured the same way `workDir` was: a session
  // recorded against another folder never leaks into this one.
  writeSession(
    "session_66666666-6666-4666-8666-666666666666",
    modernCwd,
    modern({ cwd: otherCwd, createdAt: after + 9900, updatedAt: after + 9900, title: "foreign" })
  );
  assert(
    find({ cwd: modernCwd })?.id === "session_33333333-3333-4333-8333-333333333333",
    "a 0.42 session whose cwd is elsewhere must not match this folder"
  );

  // An unreadable index cannot prove absence: stay conservative ("found" with a
  // placeholder ref) and let `kimi-custom --session` try, mirroring the other
  // providers' confirm contracts.
  fs.rmSync(indexPath, { force: true });
  const conservative = confirmKimiCustomThread(cwd, "anything");
  assert(
    conservative.status === "found" &&
      conservative.threadRef &&
      conservative.threadRef.id === "anything" &&
      conservative.threadRef.provider === "kimi-custom",
    "an unreadable index should confirm as found with a placeholder ref"
  );

  console.log("Kimi-custom discovery smoke passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
