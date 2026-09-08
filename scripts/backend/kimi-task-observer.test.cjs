const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { readKimiTaskActivity } = require("../../backend/kimiTaskObserver.cjs");
const { confirmKimiThread } = require("../../backend/agentThreadHost.cjs");

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-kimi-task-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const sessionDir = path.join(home, "sessions", "test");
  await fs.mkdir(path.join(sessionDir, "agents", "main", "tasks"), { recursive: true });
  return { home, sessionDir };
}
async function writeTask(f, owner, taskId, changes = {}) {
  const dir = path.join(f.sessionDir, "agents", owner, "tasks");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${taskId}.json`);
  await fs.writeFile(file, JSON.stringify({ taskId, kind: "agent", agentId: "child-1", status: "running", startedAt: 100, endedAt: null, ...changes }));
  return file;
}
test("concurrent child tasks preserve identity; only terminal metadata is exposed", async (t) => {
  const f = await fixture(t);
  await Promise.all([
    writeTask(f, "main", "agent-12345678", { description: "PRIVATE", response: "PRIVATE" }),
    writeTask(f, "child-1", "agent-12345678", { status: "completed", endedAt: 200 }),
    writeTask(f, "main", "bash-abcdefgh", { kind: "process", status: "failed", endedAt: 200 })
  ]);
  const results = await Promise.all(Array.from({ length: 4 }, () => readKimiTaskActivity(f)));
  for (const result of results) {
    assert.equal(result.availability, "available");
    assert.equal(result.active, true);
    assert.equal(new Set(result.items.map((item) => item.id)).size, 3);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  }
  for (const status of ["completed", "failed", "timed_out", "killed", "lost"]) {
    await writeTask(f, "main", "agent-12345678", { status, endedAt: 200 });
    assert.equal((await readKimiTaskActivity(f)).active, false);
  }
});
test("missing layout is unavailable; an existing compatible main agent can be empty", async (t) => {
  const f = await fixture(t);
  assert.equal((await readKimiTaskActivity(f)).active, false);
  await fs.rmdir(path.join(f.sessionDir, "agents", "main", "tasks"));
  assert.equal((await readKimiTaskActivity(f)).active, null);
});
test("truncated, malformed, oversized and invalid status records never imply idle", async (t) => {
  const f = await fixture(t);
  const file = await writeTask(f, "main", "agent-12345678");
  assert.equal((await readKimiTaskActivity(f)).active, true);
  for (const content of ["{", "null", "x".repeat(32769), JSON.stringify({ taskId: "agent-12345678", kind: "agent", status: "idle", startedAt: 100, endedAt: null })]) {
    await fs.writeFile(file, content);
    const result = await readKimiTaskActivity(f);
    assert.equal(result.availability, "unavailable");
    assert.equal(result.active, null);
  }
});
test("path escape and directory junction are rejected", async (t) => {
  const f = await fixture(t);
  assert.equal((await readKimiTaskActivity({ ...f, sessionDir: path.dirname(f.home) })).availability, "unavailable");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-kimi-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(f.sessionDir, "agents", "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await readKimiTaskActivity(f)).availability, "unavailable");
});
test("scan limits fail closed and task output directories are not read", async (t) => {
  const f = await fixture(t);
  const file = await writeTask(f, "main", "agent-12345678");
  const output = file.slice(0, -5);
  await fs.mkdir(output);
  await fs.writeFile(path.join(output, "output.log"), "PRIVATE");
  assert.equal((await readKimiTaskActivity(f)).availability, "available");
  await Promise.all(Array.from({ length: 64 }, (_, i) => fs.mkdir(path.join(f.sessionDir, "agents", `child-${i}`))));
  assert.equal((await readKimiTaskActivity(f)).availability, "unavailable");
});
test("invalid filenames and mismatched task IDs fail closed", async (t) => {
  const f = await fixture(t);
  const file = await writeTask(f, "main", "agent-12345678", { taskId: "other-12345678" });
  assert.equal((await readKimiTaskActivity(f)).availability, "unavailable");
  await fs.rename(file, path.join(path.dirname(file), "invalid.json"));
  assert.equal((await readKimiTaskActivity(f)).availability, "unavailable");
});
test("confirmation enriches only root verified sessions while sync callers retain their contract", async (t) => {
  const f = await fixture(t);
  const cwd = path.join(f.home, "work");
  await fs.writeFile(path.join(f.home, "session_index.jsonl"), JSON.stringify({ sessionId: "test", sessionDir: f.sessionDir, workDir: cwd }) + "\n");
  await fs.writeFile(path.join(f.sessionDir, "state.json"), JSON.stringify({ title: "Test", workDir: cwd }));
  await writeTask(f, "main", "agent-12345678");
  assert.equal(confirmKimiThread(cwd, "test", { home: f.home }).rootVerified, true);
  const enriched = await confirmKimiThread(cwd, "test", { home: f.home, includeActivity: true });
  assert.equal(enriched.nativeBackgroundActivity.active, true);
  const foreign = await confirmKimiThread(f.home, "test", { home: f.home, includeActivity: true });
  assert.equal(foreign.nativeBackgroundActivity, undefined);
});
