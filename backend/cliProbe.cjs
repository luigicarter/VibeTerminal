"use strict";

// Launch-time "which agent CLIs does this machine actually have?" probe.
//
// Cost matters here: this runs on app.whenReady, before the first paint. The
// approach is one readdir per PATH directory, then pure in-memory matching of
// every command against those listings. That is O(directories) — adding more
// CLIs to the list is free. The obvious alternative (stat each
// command x PATHEXT candidate in each directory, which is what the telemetry
// shim's resolveRealCommand does) is O(dirs x commands x extensions) and
// measured ~12x slower on a 44-entry PATH, because a MISSING command is the
// expensive case: it stats every candidate in every directory before giving up.
// Spawning `where.exe`/`which` per command is slower still (process spawns).
//
// Measured on a Windows 11 box with 44 PATH entries, 7 commands:
//   readdir scan          ~6 ms cold / ~4 ms warm
//   stat-per-candidate    ~76 ms
//   where.exe x7 parallel ~169 ms
//   `<cli> --version` x7  ~1315 ms   (too slow for launch; also proves the CLI
//                                     runs, which presence alone does not)
//
// This reports presence on disk, NOT that the CLI runs or is authenticated.
// Treat a negative as a hint, never as a hard block: panes launch through a
// login shell whose PATH can be richer than the Electron process's (notably on
// macOS when launched from Finder), so a "missing" CLI may still start fine.

const fs = require("fs");
const os = require("os");
const path = require("path");

// Agent kind -> the command its launch line actually invokes. Deliberately
// excludes: "terminal" (no CLI), "kimi-custom" (vendored binary shipped with
// the app, always present), and "fusion"/"openfusion" (selection-only kinds
// that launch real claude/opencode sessions, so they are covered by those two).
const PROBED_AGENT_COMMANDS = Object.freeze({
  codex: "codex",
  claude: "claude",
  cursor: "cursor-agent",
  gemini: "gemini",
  opencode: "opencode",
  aider: "aider",
  kimi: "kimi",
  qwen: "qwen"
});

// A single unreachable network share on PATH can hang readdir for seconds, so
// every directory read races a timer and a slow one is simply skipped.
const DIRECTORY_TIMEOUT_MS = 250;
const TOTAL_TIMEOUT_MS = 1500;

function pathEnvKey(env) {
  if (process.platform !== "win32") return "PATH";
  return (
    Object.keys(env).find((key) => key.toUpperCase() === "PATH") || "PATH"
  );
}

// Every filename that could satisfy `command` in a directory listing. On
// Windows a bare `codex` on PATH is really codex.cmd/.ps1/.exe, so the command
// is expanded across PATHEXT; the preferred list is checked first so the
// reported path matches what the shell would pick.
function commandFilenames(command) {
  if (process.platform !== "win32") return [command];

  const preferred = [".exe", ".cmd", ".bat", ".ps1", ".com"];
  const fromEnv = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);

  return Array.from(new Set([""].concat(preferred, fromEnv))).map(
    (extension) => command + extension
  );
}

// Directories the pane's login shell commonly has but the Electron process may
// not — the main false-negative source on macOS/Linux. Reading a handful more
// directories costs microseconds each, so they are always included.
function extraSearchDirectories() {
  const home = os.homedir();
  if (!home) return [];

  const relative = [
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".deno", "bin"),
    path.join(home, ".cargo", "bin")
  ];

  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return relative.concat(appData ? [path.join(appData, "npm")] : []);
  }

  return relative.concat([
    "/usr/local/bin",
    "/opt/homebrew/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin")
  ]);
}

function searchDirectories() {
  const env = process.env;
  const fromPath = (env[pathEnvKey(env)] || "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  const seen = new Set();
  const directories = [];
  for (const directory of fromPath.concat(extraSearchDirectories())) {
    // The telemetry shim dir is only ever injected into a spawned pane's env,
    // never into this process's, so PATH here is the user's real one. Skip it
    // anyway rather than depend on that staying true — reporting the shim as
    // "codex is installed" would be a lie on a machine without codex.
    if (/vibe-?terminal/i.test(directory) && /shim/i.test(directory)) continue;

    const key = process.platform === "win32" ? directory.toLowerCase() : directory;
    if (seen.has(key)) continue;
    seen.add(key);
    directories.push(directory);
  }

  return directories;
}

function readDirectory(directory, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (names) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(names);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    fs.readdir(directory, (error, names) => finish(error ? null : names));
  });
}

/**
 * Scan PATH for the given commands.
 *
 * @param {Record<string, string>} commands agent kind -> command name
 * @returns {Promise<{probedAt: number, durationMs: number, timedOut: boolean,
 *   directoriesScanned: number, clis: Record<string, {command: string,
 *   available: boolean, path: string | null}>}>}
 */
async function probeInstalledClis(commands = PROBED_AGENT_COMMANDS) {
  const startedAt = process.hrtime.bigint();
  const directories = searchDirectories();

  const deadline = new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), TOTAL_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
  });

  const scan = Promise.all(
    directories.map(async (directory) => {
      const names = await readDirectory(directory, DIRECTORY_TIMEOUT_MS);
      if (!names) return null;
      // Windows filesystems are case-insensitive and POSIX ones are not, but
      // lowercasing both sides is still correct on POSIX for the exact-case
      // hit we care about, and it lets one Set serve both platforms.
      return { directory, names: new Set(names.map((name) => name.toLowerCase())) };
    })
  );

  const listings = await Promise.race([scan, deadline]);
  const timedOut = listings === "timeout";
  const usable = timedOut ? [] : listings.filter(Boolean);

  const clis = {};
  for (const [kind, command] of Object.entries(commands)) {
    const filenames = commandFilenames(command).map((name) => name.toLowerCase());
    let found = null;

    search: for (const listing of usable) {
      for (const filename of filenames) {
        if (listing.names.has(filename)) {
          found = path.join(listing.directory, filename);
          break search;
        }
      }
    }

    clis[kind] = { command, available: Boolean(found), path: found };
  }

  return {
    probedAt: Date.now(),
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    timedOut,
    directoriesScanned: usable.length,
    clis
  };
}

module.exports = { PROBED_AGENT_COMMANDS, probeInstalledClis };
