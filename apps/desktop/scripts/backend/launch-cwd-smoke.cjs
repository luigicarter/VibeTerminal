const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveLaunchCwd } = require("../../backend/launchCwd.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "launch-cwd-smoke-"));

try {
  const existing = path.join(root, "workspace");
  fs.mkdirSync(existing);

  const valid = resolveLaunchCwd(existing, root);
  assert.strictEqual(valid.ok, true, "existing workspace should be valid");
  assert.strictEqual(valid.cwd, path.resolve(existing));

  const fallback = resolveLaunchCwd("", existing);
  assert.strictEqual(fallback.ok, true, "empty cwd should fall back");
  assert.strictEqual(fallback.cwd, path.resolve(existing));

  const missingPath = path.join(root, "missing");
  const missing = resolveLaunchCwd(missingPath, root);
  assert.strictEqual(missing.ok, false, "missing workspace should be rejected");
  assert.strictEqual(missing.cwd, path.resolve(missingPath));
  assert(
    missing.message.includes("Working directory is unavailable"),
    "missing workspace should produce a clear error"
  );
  assert.strictEqual(
    fs.existsSync(missingPath),
    false,
    "cwd validation must not create a missing workspace"
  );

  const filePath = path.join(root, "not-a-folder.txt");
  fs.writeFileSync(filePath, "not a directory\n", "utf8");
  const fileResult = resolveLaunchCwd(filePath, root);
  assert.strictEqual(fileResult.ok, false, "file cwd should be rejected");
  assert(
    fileResult.message.includes("Working directory is not a folder"),
    "file cwd should produce a clear error"
  );

  console.log("launch cwd smoke passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
