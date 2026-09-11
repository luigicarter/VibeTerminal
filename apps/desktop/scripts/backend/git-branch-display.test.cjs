const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { execFileSync } = require("node:child_process");
const { getBranchOverview, getCodeChangeSummary } = require("../../backend/codeChanges.cjs");

test("real Git branches, worktrees, changes and subfolder scope", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lina-branches-"));
  const emptyConfig = path.join(base, "gitconfig"); fs.writeFileSync(emptyConfig, "");
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous;
    assert(path.resolve(base).startsWith(path.join(os.tmpdir(), "lina-branches-")));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Branch Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repo = path.join(base, "repo"); fs.mkdirSync(repo); git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "first.txt"), "base\n");
  const unborn = await getBranchOverview(repo);
  assert.equal(unborn.state, "ok"); assert.equal(unborn.branches[0].current, true);
  assert.equal(unborn.branches[0].worktrees[0].changedFiles, 1);
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const original = git(repo, "rev-parse", "HEAD");
  git(repo, "config", "remote.origin.url", path.join(base, "local-only.git"));
  git(repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(repo, "update-ref", "refs/remotes/origin/main", original);
  git(repo, "branch", "--set-upstream-to=origin/main", "main");
  fs.appendFileSync(path.join(repo, "first.txt"), "local\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "unpushed");
  const clean = await getBranchOverview(repo);
  assert.equal(clean.branches[0].ahead, 1); assert.equal(clean.branches[0].worktrees[0].state, "clean");
  git(repo, "update-ref", "refs/remotes/origin/remote-only", original);
  git(repo, "branch", "missing-upstream");
  git(repo, "update-ref", "refs/remotes/origin/deleted", original);
  git(repo, "branch", "--set-upstream-to=origin/deleted", "missing-upstream"); git(repo, "update-ref", "-d", "refs/remotes/origin/deleted");
  const linked = path.join(base, "caf\u00e9 worktree");
  git(repo, "worktree", "add", "-q", "-b", "linked", linked);
  fs.writeFileSync(path.join(linked, "asset.bin"), Buffer.from([0, 1, 2]));
  const sub = path.join(repo, "sub"); fs.mkdirSync(sub);
  fs.writeFileSync(path.join(repo, "outside.txt"), "outside\n"); fs.writeFileSync(path.join(sub, "inside.txt"), "inside\n");
  const [fromRoot, fromSub, overview] = await Promise.all([getCodeChangeSummary(repo), getCodeChangeSummary(sub), getBranchOverview(sub)]);
  assert.equal(fromRoot.insertions, 2); assert.equal(fromSub.insertions, 2); assert.equal(fromSub.changedFiles, 2);
  assert.equal(overview.summary.insertions, 2); assert.equal(overview.branches.find(b => b.current).worktrees[0].insertions, 2);
  assert(!overview.branches.some(b => b.name === "remote-only"));
  assert.equal(overview.branches.find(b => b.name === "missing-upstream").upstreamState, "gone");
  const binary = overview.branches.find(b => b.name === "linked").worktrees[0];
  assert.equal(binary.changedFiles, 1); assert.equal(binary.insertions, 0); assert.equal(binary.state, "dirty"); assert.match(binary.path, /caf\u00e9 worktree$/);
  // Missing registered worktrees must retain their error and their location.
  const moved = path.join(base, "moved-worktree");
  for (const target of [linked, moved]) assert(path.resolve(target).startsWith(path.resolve(base) + path.sep));
  fs.renameSync(linked, moved);
  try {
    const missing = (await getBranchOverview(repo)).branches.find(b => b.name === "linked").worktrees[0];
    assert.equal(missing.state, "unavailable"); assert(missing.message);
  } finally { fs.renameSync(moved, linked); }
  git(repo, "checkout", "-q", "--detach");
  const detached = await getBranchOverview(repo);
  const current = detached.branches.find(b => b.current);
  assert(current.detached); assert.equal(current.worktrees[0].changedFiles, 2); assert.equal(current.worktrees[0].insertions, 2);
  // Oversized untracked content is explicitly partial, not silently exact zero.
  fs.writeFileSync(path.join(repo, "large.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  assert.equal((await getCodeChangeSummary(repo)).lineTotalsTruncated, true);
  fs.unlinkSync(path.join(repo, "large.txt"));
  // Use conflicting index stages without a merge command or modifying a user's repo.
  const blob = git(repo, "rev-parse", "HEAD:first.txt");
  git(repo, "update-index", "--force-remove", "first.txt");
  execFileSync("git", ["update-index", "--index-info"], { cwd: repo, windowsHide: true, input: `100644 ${blob} 1\tfirst.txt\n100644 ${blob} 2\tfirst.txt\n100644 ${blob} 3\tfirst.txt\n`, stdio: ["pipe", "pipe", "pipe"] });
  assert.equal((await getBranchOverview(repo)).branches.find(b => b.current).worktrees[0].conflicts, 1);
});

function mockedGit(respond) {
  const source = fs.readFileSync(path.resolve(__dirname, "../../backend/codeChanges.cjs"), "utf8");
  const calls = []; let active = 0, peak = 0;
  const spawn = (_name, args, options) => {
    calls.push({ args, cwd: options.cwd }); active++; peak = Math.max(peak, active);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setTimeout(() => {
      const result = respond(args, options.cwd);
      for (const chunk of result.chunks || [Buffer.from(result.stdout || "")]) child.stdout.emit("data", chunk);
      if (result.stderr) child.stderr.emit("data", Buffer.from(result.stderr));
      active--; child.emit("close", result.code || 0);
    }, 5);
    return child;
  };
  const context = { module: { exports: {} }, require: name => name === "child_process" ? { spawn } : require(name), Buffer, process, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  return { api: context.module.exports, calls, peak: () => peak };
}
function healthy(args, cwd) {
  if (args[0] === "rev-parse") return { stdout: cwd + "\n" };
  if (args[0] === "status") return { stdout: "## main...origin/main [ahead 1]\n" };
  if (args[0] === "for-each-ref") return { stdout: "refs/heads/main\torigin/main\t[ahead 1]\n" };
  if (args[0] === "worktree") return { stdout: `worktree ${cwd}\0HEAD 123456789\0branch refs/heads/main\0\0` };
  return { stdout: "" };
}
test("branch/ref/status failures and truncated output never become successful empty lists", async () => {
  for (const command of ["status", "for-each-ref", "worktree"]) {
    const mock = mockedGit((args, cwd) => args[0] === command ? { code: 128, stderr: "fixture read failure" } : healthy(args, cwd));
    const result = await mock.api.getBranchOverview(path.resolve("fixture"));
    assert.equal(result.state, "unavailable", command); assert.match(result.message, /fixture read failure/);
  }
  const capped = mockedGit((args, cwd) => args[0] === "for-each-ref" ? { chunks: [Buffer.alloc(1024 * 1024, 65), Buffer.from("overflow")] } : healthy(args, cwd));
  const result = await capped.api.getBranchOverview(path.resolve("fixture"));
  assert.equal(result.state, "unavailable"); assert.match(result.message, /output limit/);
});
test("diff failures preserve dirty file counts and mark line totals unavailable", async () => {
  const mock = mockedGit((args, cwd) => args[0] === "status" ? { stdout: "## main\n M first.txt\n" } : args[0] === "diff" ? { code: 1, stderr: "diff fixture failure" } : healthy(args, cwd));
  const summary = await mock.api.getCodeChangeSummary(path.resolve("fixture"));
  assert.equal(summary.state, "dirty"); assert.equal(summary.changedFiles, 1); assert.equal(summary.lineTotalsAvailable, false); assert.match(summary.message, /diff fixture failure/);
});
test("concurrent requests share scans and bound Git child processes", async () => {
  const mock = mockedGit(healthy); const cwd = path.resolve("shared-fixture");
  await Promise.all(Array.from({ length: 12 }, () => mock.api.getCodeChangeSummary(cwd)));
  assert.equal(mock.calls.length, 2, "one root lookup and one clean status scan");
  await Promise.all(Array.from({ length: 12 }, (_, i) => mock.api.getBranchOverview(path.resolve(`fixture-${i}`))));
  assert(mock.peak() <= 4); assert(mock.peak() > 1);
});
