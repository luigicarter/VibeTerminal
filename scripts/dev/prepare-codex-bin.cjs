// Embed the Codex binary for Fusion. Locates the native `codex` executable that
// the `@openai/codex` npm package installs and copies it into
// vendor/codex-bin/<platform>-<arch>/ so electron-builder `extraResources` can
// bundle it and each Fusion pane can spawn its own embedded instance
// (see backend/fusion-adapter.cjs + resolveCodexBin in backend/main.cjs).
//
//   npm run prepare:codex-bin
//
// The binary is large (~300 MB) and gitignored — this populates it from the
// local npm install. For CI/release, fetch the platform binary the same way on
// the build machine. Skips cleanly if codex is not installed.

const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const isWin = process.platform === "win32";
const exeName = isWin ? "codex.exe" : "codex";
const MIN_NATIVE_BYTES = 50 * 1024 * 1024; // the real Rust binary, not the JS shim
const rootDir = path.join(__dirname, "..", "..");
const outDir = path.join(rootDir, "vendor", "codex-bin", `${process.platform}-${process.arch}`);
const dest = path.join(outDir, exeName);
const required = process.argv.includes("--required") || process.env.VIBE_REQUIRE_CODEX_BIN === "1";

function skip(message) {
  if (required) {
    throw new Error(message.replace(/^SKIP /, "Required "));
  }
  console.log(message);
}

function findLargest(baseDir) {
  let best = null;
  let bestSize = 0;
  const stack = [baseDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name === exeName) {
        try {
          const size = fs.statSync(full).size;
          if (size > bestSize) {
            best = full;
            bestSize = size;
          }
        } catch {
          // ignore
        }
      }
    }
  }
  return bestSize >= MIN_NATIVE_BYTES ? best : null;
}

function candidateSearchBases() {
  const bases = [];
  const envRoots = process.env.VIBE_CODEX_BIN_SEARCH_ROOTS;
  if (envRoots) {
    for (const entry of envRoots.split(path.delimiter)) {
      if (entry.trim()) {
        bases.push(entry.trim());
      }
    }
  }

  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    bases.push(path.join(globalRoot, "@openai"));
  } catch {
    if (!bases.length) {
      skip("SKIP prepare:codex-bin: could not run `npm root -g`.");
    }
  }

  return bases;
}

function expectedCodexVersion() {
  const appserverDir = path.join(rootDir, "vendor", "codex-appserver");
  try {
    const versions = fs
      .readdirSync(appserverDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
      .map((entry) => entry.name);
    return versions.length === 1 ? versions[0] : null;
  } catch {
    return null;
  }
}

function readCodexVersion(binary) {
  try {
    const output = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 10000
    });
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function versionIssue(source) {
  const expected = expectedCodexVersion();
  if (!expected) return null;

  const actual = readCodexVersion(source);
  if (actual === expected) return null;

  return actual
    ? `Codex binary version ${actual} does not match vendored app-server schema ${expected}.`
    : `Could not read Codex binary version; expected ${expected}.`;
}

function checkVersion(source) {
  const message = versionIssue(source);
  if (!message) return;
  if (required) {
    throw new Error(message);
  }
  console.warn(`WARN prepare:codex-bin: ${message}`);
}

function preparedBinaryReady() {
  try {
    const stat = fs.statSync(dest);
    if (stat.size < MIN_NATIVE_BYTES) return false;
  } catch {
    return false;
  }
  const message = versionIssue(dest);
  if (message) {
    if (required) {
      console.warn(`WARN prepare:codex-bin: existing embedded binary is not usable: ${message}`);
    }
    return false;
  }
  return true;
}

function main() {
  if (required && preparedBinaryReady()) {
    const mb = Math.round(fs.statSync(dest).size / 1024 / 1024);
    console.log(`Embedded Codex already prepared: ${dest} (${mb} MB)`);
    return;
  }

  const searchBases = candidateSearchBases().filter((base) => fs.existsSync(base));
  if (!searchBases.length) {
    skip("SKIP prepare:codex-bin: @openai/codex not found in configured or global npm roots.");
    return;
  }

  let source = null;
  let versionMismatch = null;
  for (const searchBase of searchBases) {
    const candidate = findLargest(searchBase);
    if (!candidate) continue;
    const issue = versionIssue(candidate);
    if (!issue) {
      source = candidate;
      break;
    }
    versionMismatch = `${candidate}: ${issue}`;
    if (!required && !source) {
      source = candidate;
    }
  }

  if (!source) {
    if (required && versionMismatch) {
      throw new Error(versionMismatch);
    }
    skip(
      `SKIP prepare:codex-bin: no native ${exeName} (>= ${Math.round(MIN_NATIVE_BYTES / 1024 / 1024)} MB) found under ${searchBases.join(", ")}.`
    );
    return;
  }

  checkVersion(source);
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(source, dest);
  if (!isWin) {
    fs.chmodSync(dest, 0o755);
  }
  const mb = Math.round(fs.statSync(dest).size / 1024 / 1024);
  console.log(`Embedded Codex: ${source}\n             → ${dest} (${mb} MB)`);
}

main();
