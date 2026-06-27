const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const GIT_STATUS_TIMEOUT_MS = 5_000;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

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

function runGit(args, cwd, timeoutMs = GIT_STATUS_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(stdout, "utf8") < MAX_GIT_OUTPUT_BYTES) {
        stdout += chunk.toString("utf8");
      }
    });

    child.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr, "utf8") < MAX_GIT_OUTPUT_BYTES) {
        stderr += chunk.toString("utf8");
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr,
        error,
        timedOut
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        timedOut
      });
    });
  });
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

  try {
    const stat = fs.statSync(resolvedCwd);
    if (!stat.isDirectory()) {
      return unavailableSummary(resolvedCwd, "Workspace path is not a folder.");
    }
  } catch {
    return unavailableSummary(resolvedCwd, "Workspace folder does not exist.");
  }

  const statusResult = await runGit(
    ["status", "--porcelain=v1", "-b", "--untracked-files=all"],
    resolvedCwd
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
      statusResult.stderr.trim() ||
        normalizeGitError(statusResult.error) ||
        "Git status failed."
    );
  }

  const rootResult = await runGit(["rev-parse", "--show-toplevel"], resolvedCwd);
  const root = rootResult.ok ? rootResult.stdout.trim() : undefined;
  const diffResult = await runGit(["diff", "--numstat", "HEAD", "--"], resolvedCwd);
  const diffStats = diffResult.ok
    ? parseDiffNumstat(diffResult.stdout)
    : { insertions: 0, deletions: 0 };

  return parseCodeChangeStatus(statusResult.stdout, {
    cwd: resolvedCwd,
    root,
    diffStats
  });
}

module.exports = {
  getCodeChangeSummary,
  parseBranchLine,
  parseCodeChangeStatus,
  parseDiffNumstat
};
