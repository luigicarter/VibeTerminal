const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  PROBED_AGENT_COMMANDS,
  probeInstalledClis
} = require("../../backend/cliProbe.cjs");

// The probe reads process.env.PATH, so the fixture is a temp bin dir prepended
// to it for the duration of the test.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-probe-smoke-"));
const pathKey =
  process.platform === "win32"
    ? Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") || "PATH"
    : "PATH";
const originalPath = process.env[pathKey];

function fakeBin(name) {
  // On Windows a bare `foo` on PATH is really foo.cmd/.exe, so the fixture uses
  // a PATHEXT-bearing name there to exercise the extension expansion.
  const filename = process.platform === "win32" ? `${name}.cmd` : name;
  const file = path.join(root, filename);
  fs.writeFileSync(file, "", "utf8");
  if (process.platform !== "win32") fs.chmodSync(file, 0o755);
  return file;
}

(async () => {
  try {
    fakeBin("smoke-present");
    process.env[pathKey] = [root, originalPath].filter(Boolean).join(path.delimiter);

    const report = await probeInstalledClis({
      present: "smoke-present",
      absent: "smoke-definitely-not-installed-xyz"
    });

    assert.strictEqual(
      report.clis.present.available,
      true,
      "a command on PATH must be found (PATHEXT expansion included)"
    );
    assert.strictEqual(
      path.dirname(report.clis.present.path),
      root,
      "the reported path must point at the directory it was found in"
    );
    assert.strictEqual(
      report.clis.absent.available,
      false,
      "a command that is not on PATH must report unavailable"
    );
    assert.strictEqual(report.clis.absent.path, null);
    assert.strictEqual(report.timedOut, false, "a local PATH must not time out");
    assert(
      report.directoriesScanned > 0,
      "the scan must have read at least the fixture directory"
    );

    // A nonexistent directory on PATH is normal (stale entries are common) and
    // must be skipped silently rather than failing the whole probe.
    process.env[pathKey] = [path.join(root, "does-not-exist"), root, originalPath]
      .filter(Boolean)
      .join(path.delimiter);
    const withBadDir = await probeInstalledClis({ present: "smoke-present" });
    assert.strictEqual(
      withBadDir.clis.present.available,
      true,
      "an unreadable PATH entry must not break the rest of the scan"
    );

    // The launch-time budget. This is the whole reason the probe scans
    // directories instead of statting every command x extension candidate.
    const timed = await probeInstalledClis();
    assert(
      timed.durationMs < 250,
      `probe must stay well inside the launch budget (took ${timed.durationMs.toFixed(1)}ms)`
    );

    // Kinds the launcher must never dim: Terminal has no CLI, Kimi + CC is a
    // vendored binary, and Fusion / Open Fusion ride claude / opencode.
    for (const kind of ["terminal", "kimi-custom", "fusion", "openfusion"]) {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(PROBED_AGENT_COMMANDS, kind),
        false,
        `${kind} must not be probed`
      );
    }
    assert.strictEqual(PROBED_AGENT_COMMANDS.aider, undefined, "removed Aider support must not be probed");
    for (const kind of ["codex", "claude", "cursor", "gemini", "opencode", "kimi", "qwen"]) {
      assert(PROBED_AGENT_COMMANDS[kind], `${kind} must be probed`);
    }
    assert.strictEqual(
      PROBED_AGENT_COMMANDS.cursor,
      "cursor-agent",
      "the cursor kind launches the cursor-agent binary, not `cursor`"
    );

    console.log(
      `cli probe smoke passed (${timed.durationMs.toFixed(1)}ms, ${timed.directoriesScanned} dirs)`
    );
  } finally {
    process.env[pathKey] = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
