const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const GIT_STATUS_TIMEOUT_MS = 5_000;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_UNTRACKED_LINE_COUNT_BYTES = 2 * 1024 * 1024;
// Bound filesystem work and Git concurrency across toolbar, popup and relay reads.
const MAX_UNTRACKED_FILES_SCANNED = 2_000;
const MAX_UNTRACKED_SCAN_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_GIT_PROCESSES = 4;
let activeGitProcesses = 0;
const gitWaiters = [];
const summaryRequests = new Map();
const overviewRequests = new Map();

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function shareRequest(requests, cwd, read) {
  const key = pathKey(cwd);
  if (!requests.has(key)) {
    const request = read().finally(() => requests.delete(key));
    requests.set(key, request);
  }
  return requests.get(key);
}

function emptyCounts() {
  return {
    changedFiles: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
    insertions: 0,
    deletions: 0
  };
}

function parseBranchLine(line) {
  const summary = line.replace(/^##\s*/, "");
  const trackingMatch = summary.match(/\[([^\]]+)\]\s*$/);
  const trackingText = trackingMatch?.[1] ?? "";
  const branchText = trackingMatch
    ? summary.slice(0, trackingMatch.index).trim()
    : summary.trim();
  const aheadMatch = trackingText.match(/ahead\s+(\d+)/);
  const behindMatch = trackingText.match(/behind\s+(\d+)/);

  let branch = branchText;
  let upstream;

  if (branchText.startsWith("No commits yet on ")) {
    branch = branchText.replace("No commits yet on ", "");
  } else if (branchText.startsWith("Initial commit on ")) {
    branch = branchText.replace("Initial commit on ", "");
  } else if (branchText.includes("...")) {
    const [local, remote] = branchText.split("...");
    branch = local || branchText;
    upstream = remote || undefined;
  } else if (branchText === "HEAD (no branch)") {
    branch = "detached";
  }

  return {
    branch,
    upstream,
    upstreamState: !upstream ? "none" : /\bgone\b/.test(trackingText) ? "gone" : "tracked",
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0
  };
}

function isConflictStatus(indexStatus, worktreeStatus) {
  return (
    indexStatus === "U" ||
    worktreeStatus === "U" ||
    ["DD", "AA"].includes(`${indexStatus}${worktreeStatus}`)
  );
}

function parseDiffNumstat(stdout) {
  const stats = {
    insertions: 0,
    deletions: 0
  };

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const [insertions, deletions] = line.split("\t");
    const parsedInsertions = Number(insertions);
    const parsedDeletions = Number(deletions);

    if (Number.isFinite(parsedInsertions)) {
      stats.insertions += parsedInsertions;
    }

    if (Number.isFinite(parsedDeletions)) {
      stats.deletions += parsedDeletions;
    }
  }

  return stats;
}

function mergeDiffStats(...stats) {
  return stats.reduce(
    (merged, stat) => ({
      insertions: merged.insertions + Number(stat?.insertions || 0),
      deletions: merged.deletions + Number(stat?.deletions || 0)
    }),
    { insertions: 0, deletions: 0 }
  );
}

function parseNullSeparatedPaths(stdout) {
  return stdout.split("\0").filter(Boolean);
}

function countBufferLines(buffer) {
  if (!buffer.length || buffer.includes(0)) return 0;
  let lines = 0;
  for (let index = buffer.indexOf(10); index !== -1; index = buffer.indexOf(10, index + 1)) lines++;
  return buffer[buffer.length - 1] === 10 ? lines : lines + 1;
}

async function countUntrackedInsertions(root, stdout) {
  const paths = parseNullSeparatedPaths(stdout);
  let remainingBytes = MAX_UNTRACKED_SCAN_TOTAL_BYTES;
  let total = 0;
  let truncated = paths.length > MAX_UNTRACKED_FILES_SCANNED;

  for (const relativePath of paths.slice(0, MAX_UNTRACKED_FILES_SCANNED)) {
    const filePath = path.join(root, relativePath);
    let handle;
    try {
      // Do not follow untracked links into unrelated folders or special files.
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_UNTRACKED_LINE_COUNT_BYTES || stat.size > remainingBytes) {
        truncated = true;
        continue;
      }
      handle = await fs.promises.open(filePath, "r");
      // A bounded read also holds the budget if the file grows after lstat.
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      remainingBytes -= stat.size;
      total += countBufferLines(buffer.subarray(0, bytesRead));
      if (bytesRead !== stat.size || (await handle.stat()).size !== stat.size) truncated = true;
    } catch {
      truncated = true;
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return { insertions: total, deletions: 0, truncated };
}

function parseCodeChangeStatus(stdout, options = {}) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("## "));
  const branchInfo = branchLine
    ? parseBranchLine(branchLine)
    : { branch: "", upstream: undefined, ahead: 0, behind: 0 };
  const counts = emptyCounts();
  const diffStats = options.diffStats ?? {
    insertions: 0,
    deletions: 0
  };

  for (const line of lines) {
    if (line.startsWith("## ") || line.startsWith("!!")) {
      continue;
    }

    const indexStatus = line[0] ?? " ";
    const worktreeStatus = line[1] ?? " ";

    counts.changedFiles += 1;

    if (indexStatus === "?" && worktreeStatus === "?") {
      counts.untracked += 1;
      continue;
    }

    if (isConflictStatus(indexStatus, worktreeStatus)) {
      counts.conflicts += 1;
      continue;
    }

    if (indexStatus !== " " && indexStatus !== "?") {
      counts.staged += 1;
    }

    if (worktreeStatus !== " " && worktreeStatus !== "?") {
      counts.unstaged += 1;
    }
  }

  return {
    state: counts.changedFiles > 0 ? "dirty" : "clean",
    cwd: options.cwd,
    root: options.root,
    ...branchInfo,
    ...counts,
    insertions: diffStats.insertions,
    deletions: diffStats.deletions,
    updatedAt: Date.now()
  };
}

function normalizeGitError(error) {
  return error && typeof error.message === "string"
    ? error.message
    : "Could not inspect Git changes.";
}

async function runGit(args, cwd, timeoutMs = GIT_STATUS_TIMEOUT_MS) {
  if (activeGitProcesses >= MAX_GIT_PROCESSES) await new Promise(resolve => gitWaiters.push(resolve));
  else activeGitProcesses++;
  try {
    return await new Promise((resolve) => {
      const child = spawn("git", args, {
        cwd,
        windowsHide: true,
        // Every git call we make is read-only; this also stops status/diff from
        // taking optional locks or refreshing the index stat cache.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", LANG: "C" },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        const remaining = MAX_GIT_OUTPUT_BYTES - stdoutBytes;
        if (chunk.length > remaining) truncated = true;
        if (remaining > 0) stdout.push(chunk.subarray(0, remaining));
        stdoutBytes += Math.min(chunk.length, remaining);
      });

      child.stderr.on("data", (chunk) => {
        const remaining = MAX_GIT_OUTPUT_BYTES - stderrBytes;
        if (chunk.length > remaining) truncated = true;
        if (remaining > 0) stderr.push(chunk.subarray(0, remaining));
        stderrBytes += Math.min(chunk.length, remaining);
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          code: null,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          truncated,
          error,
          timedOut
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          ok: code === 0 && !timedOut && !truncated,
          code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          truncated,
          timedOut
        });
      });
    });
  } finally {
    const next = gitWaiters.shift();
    if (next) next();
    else activeGitProcesses--;
  }
}

function gitFailure(result, operation) {
  if (result.timedOut) return `${operation} timed out.`;
  if (result.truncated) return `${operation} exceeded the output limit.`;
  return result.stderr.trim() || `${operation}: ${normalizeGitError(result.error)}`;
}

function isNotGitRepository(result) {
  return (
    result.code === 128 &&
    /not a git repository|not a git command/i.test(result.stderr)
  );
}

function unavailableSummary(cwd, message) {
  return {
    state: "unavailable",
    cwd,
    ...emptyCounts(),
    ahead: 0,
    behind: 0,
    updatedAt: Date.now(),
    message
  };
}

async function getCodeChangeSummary(cwd) {
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    return unavailableSummary("", "A workspace path is required.");
  }

  const resolvedCwd = path.resolve(cwd);
  return shareRequest(summaryRequests, resolvedCwd, async () => {
    try { return await readCodeChangeSummary(resolvedCwd); }
    catch (error) { return unavailableSummary(resolvedCwd, normalizeGitError(error)); }
  });
}

async function readCodeChangeSummary(resolvedCwd) {
  const rootResult = await runGit(["rev-parse", "--show-toplevel"], resolvedCwd);
  if (!rootResult.ok) {
    const summary = unavailableSummary(resolvedCwd, gitFailure(rootResult, "Git repository lookup"));
    if (isNotGitRepository(rootResult)) summary.state = "not-git";
    return summary;
  }
  const root = rootResult.stdout.trim();
  // A subfolder is a view into the same working tree, not a different scope.
  if (pathKey(root) !== pathKey(resolvedCwd)) {
    return { ...await getCodeChangeSummary(root), cwd: resolvedCwd };
  }

  const statusResult = await runGit(
    ["status", "--porcelain=v1", "-b", "--untracked-files=all"],
    root
  );

  if (!statusResult.ok) {
    if (statusResult.timedOut) {
      return unavailableSummary(resolvedCwd, "Git status timed out.");
    }

    if (isNotGitRepository(statusResult)) {
      return {
        state: "not-git",
        cwd: resolvedCwd,
        ...emptyCounts(),
        ahead: 0,
        behind: 0,
        updatedAt: Date.now()
      };
    }

    return unavailableSummary(
      resolvedCwd,
      gitFailure(statusResult, "Git status")
    );
  }

  const summary = parseCodeChangeStatus(statusResult.stdout, { cwd: resolvedCwd, root });
  // Clean status already proves there are no working-tree line totals to read.
  if (summary.state === "clean") return summary;
  const unborn = /^## (?:No commits yet on|Initial commit on) /m.test(statusResult.stdout);
  const [diffResult, worktreeDiffResult, untrackedResult] = await Promise.all([
    runGit(["diff", "--no-ext-diff", "--no-textconv", "--numstat", ...(unborn ? ["--cached"] : ["HEAD"]), "--"], root),
    unborn ? runGit(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "--"], root) : null,
    summary.untracked ? runGit(["ls-files", "--others", "--exclude-standard", "--full-name", "-z"], root) : { ok: true, stdout: "" }
  ]);
  const failed = [diffResult, worktreeDiffResult, untrackedResult].find(result => result && !result.ok);
  if (failed) return { ...summary, lineTotalsAvailable: false, message: gitFailure(failed, "Git change totals") };
  const trackedDiffStats = diffResult.ok
    ? parseDiffNumstat(diffResult.stdout)
    : { insertions: 0, deletions: 0 };
  const worktreeDiffStats = worktreeDiffResult?.ok
    ? parseDiffNumstat(worktreeDiffResult.stdout)
    : { insertions: 0, deletions: 0 };
  const untrackedDiffStats = await countUntrackedInsertions(root, untrackedResult.stdout);
  const diffStats = mergeDiffStats(
    trackedDiffStats,
    worktreeDiffStats,
    untrackedDiffStats
  );

  return {
    ...summary, ...diffStats, updatedAt: Date.now(),
    lineTotalsTruncated: untrackedDiffStats.truncated,
    ...(untrackedDiffStats.truncated ? { message: "Some untracked files could not be counted within the scan limits; line totals are partial." } : {})
  };
}

function parseTrackText(trackText) {
  const aheadMatch = trackText.match(/ahead\s+(\d+)/);
  const behindMatch = trackText.match(/behind\s+(\d+)/);
  return {
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0
  };
}

function parseBranchRefs(stdout) {
  const branches = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [ref, upstream, trackText] = line.split("\t");
    const name = ref.replace(/^refs\/heads\//, "");
    if (!name) {
      continue;
    }
    const { ahead, behind } = parseTrackText(trackText || "");
    branches.push({
      id: `branch:${name}`, name, upstream: upstream || undefined, ahead, behind,
      upstreamState: !upstream ? "none" : /\bgone\b/.test(trackText || "") ? "gone" : "tracked"
    });
  }
  return branches;
}

function parseWorktreeList(stdout) {
  const worktrees = [];
  let current;
  for (const line of stdout.split("\0")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      worktrees.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (current && line === "detached") {
      current.detached = true;
    }
  }
  return worktrees;
}

// Local branches and detached worktrees. No fetch or repository mutation.
async function getBranchOverview(cwd) {
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    return {
      state: "unavailable",
      branches: [],
      message: "A workspace path is required."
    };
  }

  const resolvedCwd = path.resolve(cwd);
  return shareRequest(overviewRequests, resolvedCwd, async () => {
    try { return await readBranchOverview(resolvedCwd); }
    catch (error) { return { state: "unavailable", cwd: resolvedCwd, branches: [], message: normalizeGitError(error) }; }
  });
}

async function readBranchOverview(resolvedCwd, retry = true) {
  const summary = await getCodeChangeSummary(resolvedCwd);
  const unavailable = message => ({ state: "unavailable", cwd: resolvedCwd, branches: [], summary, message, updatedAt: Date.now() });
  if (!summary.root || ["not-git", "unavailable"].includes(summary.state)) {
    return { ...unavailable(summary.message), state: summary.state };
  }
  const [refsResult, worktreeResult] = await Promise.all([runGit(
    [
      "for-each-ref",
      "--format=%(refname)%09%(upstream:short)%09%(upstream:track)",
      "refs/heads"
    ],
    summary.root
  ), runGit(["worktree", "list", "--porcelain", "-z"], summary.root)]);
  if (!refsResult.ok) return unavailable(gitFailure(refsResult, "Git branch list"));
  if (!worktreeResult.ok) return unavailable(gitFailure(worktreeResult, "Git worktree list"));
  const branches = parseBranchRefs(refsResult.stdout);
  const worktrees = parseWorktreeList(worktreeResult.stdout);
  const currentWorktree = worktrees.find(worktree => pathKey(worktree.path) === pathKey(summary.root));
  if (!currentWorktree || (currentWorktree.branch || "detached") !== summary.branch) {
    if (retry) return readBranchOverview(resolvedCwd, false);
    return unavailable("The checked-out branch changed during inspection. Refresh to read it again.");
  }
  const currentBranch = currentWorktree.branch;
  // A repo with no commits yet has an unborn branch that for-each-ref can't see.
  if (currentBranch && !branches.some((branch) => branch.name === currentBranch)) {
    branches.unshift({ id: `branch:${currentBranch}`, name: currentBranch, upstreamState: "none", ahead: 0, behind: 0 });
  }
  const entries = branches.map((branch) => ({
    ...branch, current: branch.name === currentBranch, worktrees: []
  }));
  // Bound concurrent summary scans as well as the underlying Git processes.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, worktrees.length) }, async () => {
    while (cursor < worktrees.length) {
      const worktree = worktrees[cursor++];
      const current = worktree === currentWorktree;
      let observed = current ? summary : await getCodeChangeSummary(worktree.path);
      if (["clean", "dirty"].includes(observed.state) && observed.branch !== (worktree.branch || "detached")) {
        observed = unavailableSummary(worktree.path, "Branch changed during inspection. Refresh to read it again.");
      }
      const detail = {
        path: worktree.path, state: observed.state, insertions: observed.insertions,
        deletions: observed.deletions, changedFiles: observed.changedFiles, conflicts: observed.conflicts,
        message: observed.message, lineTotalsAvailable: observed.lineTotalsAvailable,
        lineTotalsTruncated: observed.lineTotalsTruncated
      };
      if (worktree.detached) {
        entries.push({ id: `detached:${worktree.path}`, name: `Detached HEAD (${worktree.head?.slice(0, 8) || "unknown"})`, detached: true, current, upstreamState: "none", ahead: 0, behind: 0, worktrees: [detail] });
      } else {
        entries.find(entry => entry.name === worktree.branch)?.worktrees.push(detail);
      }
    }
  }));
  for (const entry of entries) entry.worktrees.sort((a, b) => a.path.localeCompare(b.path));
  entries.sort(
    (a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );

  return {
    state: "ok",
    cwd: resolvedCwd,
    current: currentBranch || undefined,
    branches: entries,
    summary,
    updatedAt: Date.now()
  };
}

module.exports = {
  getBranchOverview,
  getCodeChangeSummary,
  parseBranchLine,
  parseCodeChangeStatus,
  parseDiffNumstat,
  parseNullSeparatedPaths
};
