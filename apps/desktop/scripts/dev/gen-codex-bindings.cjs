// Regenerate the version-pinned Codex app-server protocol bindings that Terminal
// Fusion builds against (see docs/fusion-terminal.md). The app-server protocol is
// experimental and churns, so we vendor the generated output for one exact Codex
// version under vendor/codex-appserver/<version>/ and regenerate on a version bump.
//
//   npm run gen:codex-bindings
//
// Writes TypeScript bindings (--experimental, so Fusion's experimental methods are
// included) and the JSON Schema. Skips cleanly if codex is not installed.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..", "..");
const isWin = process.platform === "win32";

function codex(args) {
  // Resolve codex through an explicit shell (the npm `.cmd`/`.ps1` wrappers on
  // Windows, PATH on POSIX). Build the command string ourselves rather than using
  // `shell:true` + an args array, which Node deprecates (DEP0190). Quote only on
  // whitespace: the npm `.cmd` wrapper forwards literal quotes, so quoting a
  // backslash path would reach codex with the quotes intact (os error 123). We
  // run from `rootDir` and pass relative, space-free `--out` paths to avoid it.
  const command =
    "codex " +
    args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
  const shell = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-c", command];
  return spawnSync(shell, shellArgs, { cwd: rootDir, encoding: "utf8" });
}

function codexVersion() {
  const result = codex(["--version"]);
  if (result.status !== 0 || !result.stdout) return null;
  const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function main() {
  const version = codexVersion();
  if (!version) {
    console.log(
      "SKIP gen:codex-bindings: codex not on PATH or version unreadable."
    );
    return;
  }

  // Relative, forward-slash, space-free paths (run from rootDir) so nothing needs
  // shell quoting; absolute paths only for our own fs/mkdir/count calls.
  const relBase = `vendor/codex-appserver/${version}`;
  const tsRel = `${relBase}/ts`;
  const schemaRel = `${relBase}/schema`;
  const outDir = path.join(rootDir, "vendor", "codex-appserver", version);
  const tsDir = path.join(outDir, "ts");
  const schemaDir = path.join(outDir, "schema");
  fs.mkdirSync(tsDir, { recursive: true });
  fs.mkdirSync(schemaDir, { recursive: true });

  console.log(`Generating Codex ${version} app-server bindings → ${outDir}`);

  const ts = codex([
    "app-server",
    "generate-ts",
    "--out",
    tsRel,
    "--experimental"
  ]);
  if (ts.status !== 0) {
    throw new Error(`generate-ts failed: ${ts.stderr || ts.stdout}`);
  }

  const schema = codex([
    "app-server",
    "generate-json-schema",
    "--out",
    schemaRel
  ]);
  if (schema.status !== 0) {
    throw new Error(`generate-json-schema failed: ${schema.stderr || schema.stdout}`);
  }

  const count = (dir) =>
    fs.readdirSync(dir, { recursive: true }).filter((entry) => {
      try {
        return fs.statSync(path.join(dir, entry)).isFile();
      } catch {
        return false;
      }
    }).length;

  console.log(
    `Done: ${count(tsDir)} .ts files, ${count(schemaDir)} schema files for Codex ${version}.`
  );
}

main();
