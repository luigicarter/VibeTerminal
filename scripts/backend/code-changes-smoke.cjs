const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  getCodeChangeSummary,
  parseBranchLine,
  parseCodeChangeStatus,
  parseDiffNumstat
} = require("../../backend/codeChanges.cjs");

const root = path.join(
  os.tmpdir(),
  `code-changes-smoke-${Date.now()}-${process.pid}`
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const branch = parseBranchLine("## main...origin/main [ahead 2, behind 1]");
  assert(branch.branch === "main", "local branch should be parsed");
  assert(branch.upstream === "origin/main", "upstream branch should be parsed");
  assert(branch.ahead === 2, "ahead count should be parsed");
  assert(branch.behind === 1, "behind count should be parsed");

  const diffStats = parseDiffNumstat(
    [
      "12\t3\tfrontend/App.tsx",
      "4\t0\tbackend/codeChanges.cjs",
      "-\t-\tfrontend/assets/vibeterminal-logo.png"
    ].join("\n")
  );
  assert(diffStats.insertions === 16, "insertions should be summed");
  assert(diffStats.deletions === 3, "deletions should be summed");

  const dirty = parseCodeChangeStatus(
    [
      "## main...origin/main [ahead 2]",
      " M frontend/App.tsx",
      "A  backend/codeChanges.cjs",
      "?? scripts/backend/code-changes-smoke.cjs",
      "UU package.json"
    ].join("\n"),
    { cwd: root, root, diffStats }
  );

  assert(dirty.state === "dirty", "dirty status should be detected");
  assert(dirty.changedFiles === 4, "changed file count should include all entries");
  assert(dirty.unstaged === 1, "unstaged changes should be counted");
  assert(dirty.staged === 1, "staged changes should be counted");
  assert(dirty.untracked === 1, "untracked changes should be counted");
  assert(dirty.conflicts === 1, "conflicts should be counted");
  assert(dirty.insertions === 16, "dirty status should include insertions");
  assert(dirty.deletions === 3, "dirty status should include deletions");

  const clean = parseCodeChangeStatus("## main\n", { cwd: root, root });
  assert(clean.state === "clean", "clean status should be detected");
  assert(clean.changedFiles === 0, "clean status should have no changes");
  assert(clean.insertions === 0, "clean status should have no insertions");
  assert(clean.deletions === 0, "clean status should have no deletions");

  fs.mkdirSync(root, { recursive: true });
  const gitVersion = spawnSync("git", ["--version"], {
    windowsHide: true,
    encoding: "utf8"
  });
  const noRepo = await getCodeChangeSummary(root);

  if (gitVersion.status === 0) {
    assert(noRepo.state === "not-git", "non-repo folders should be explicit");
  } else {
    assert(
      noRepo.state === "unavailable",
      "missing git should be reported as unavailable"
    );
  }

  console.log("Code changes smoke passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
