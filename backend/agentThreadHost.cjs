const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const {
  findCodexThread,
  listCodexThreads,
  confirmCodexThread,
  normalizeThreadTitle
} = require("./agentThreads.cjs");

const MAX_TRANSCRIPT_HEAD_BYTES = 256 * 1024;
const DEFAULT_TRANSCRIPT_LIMIT = 5000;
const MAX_DISCOVERY_VISITS = 20000;

function normalizePathForCompare(value) {
  if (!value) {
    return "";
  }

  try {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch {
    return process.platform === "win32" ? String(value).toLowerCase() : String(value);
  }
}

function isSamePath(a, b) {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

function statMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function addRecentFile(files, file, limit) {
  files.push(file);
  if (files.length > limit * 2) {
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    files.length = limit;
  }
}

function collectJsonlFiles(rootDir, limit = DEFAULT_TRANSCRIPT_LIMIT) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const stack = [rootDir];
  const files = [];
  let visited = 0;

  while (stack.length > 0 && visited < MAX_DISCOVERY_VISITS) {
    const current = stack.pop();
    visited += 1;
    let entries = [];

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    const dirs = [];

    entries.forEach((entry) => {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Claude writes a `<session-id>/subagents/agent-*.jsonl` tree that
        // duplicates the parent session's id/cwd. Descending into it only
        // multiplies I/O and can push the real session file past the file cap,
        // so skip it — the parent transcript already carries the id we need.
        if (entry.name !== "subagents") {
          dirs.push(entryPath);
        }
        return;
      }

      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        addRecentFile(
          files,
          { path: entryPath, mtimeMs: statMtimeMs(entryPath) },
          limit
        );
      }
    });

    dirs
      .sort((a, b) => statMtimeMs(a) - statMtimeMs(b))
      .forEach((dirPath) => stack.push(dirPath));
  }

  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((file) => file.path);
}

function readTranscriptHead(filePath, maxBytes) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function readHeadLines(filePath, maxLines) {
  return readTranscriptHead(filePath, MAX_TRANSCRIPT_HEAD_BYTES)
    .split(/\r?\n/)
    .slice(0, maxLines);
}

function toExcludedSet(excludeIds) {
  return new Set(
    Array.isArray(excludeIds)
      ? excludeIds.filter(Boolean).map(String)
      : []
  );
}

// Claude message content is either a string or an array of content blocks
// (`{ type: "text", text: "..." }`, tool calls, etc.). Joining the array
// directly would stringify objects into "[object Object]" titles.
function extractClaudeText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        return typeof part?.text === "string" ? part.text : "";
      })
      .join("")
      .trim();
  }

  return "";
}

function claudeProjectsDir() {
  const claudeHome =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(claudeHome, "projects");
}

// Titles this app itself once forced onto sessions via `claude --name`
// ("Claude 2", "Fusion 1 copy"). They carry no information about the
// conversation, so harvesting falls through to the first real prompt; a
// deliberately renamed session keeps its custom title.
const GENERIC_CUSTOM_TITLE = /^(?:claude|fusion)\s+\d+(?:\s+copy)*$/i;

// Transcript texts that read as user messages but are not the user's prompt:
// slash-command envelopes, local command output, and the resume caveat banner.
function isClaudeMetaText(text) {
  return (
    text.startsWith("<command-") ||
    text.startsWith("<local-command-") ||
    text.startsWith("Caveat:")
  );
}

// Parse a single Claude transcript, harvesting the session identity only from
// lines that belong to (or do not contradict) the target cwd, so the id/title/
// timestamp we claim provably came from this project — never from a foreign-cwd
// line that merely shares the file. A single foreign line is skipped, not a
// reason to abort the whole transcript. Returns null when the file carries no id
// for this cwd. Shared by latest-thread discovery and the existence check.
function parseClaudeTranscript(filePath, cwd) {
  try {
    const lines = readHeadLines(filePath, 40);
    let sessionId = "";
    let createdAt = 0;
    let title = "";
    let aiTitle = "";
    let customTitle = "";
    let entrypoint = "";
    let sawMatchingCwd = false;

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // Tolerate the occasional malformed line instead of discarding the
        // whole transcript.
        continue;
      }

      if (event.cwd && isSamePath(event.cwd, cwd)) {
        sawMatchingCwd = true;
      }

      if (event.cwd && !isSamePath(event.cwd, cwd)) {
        continue;
      }

      sessionId = sessionId || event.sessionId || "";
      // How the session was launched: interactive pane chats record
      // `entrypoint:"cli"`, Fusion's headless planner records `"sdk-cli"` —
      // the discriminator the Fusion resume picker filters on.
      if (!entrypoint && typeof event.entrypoint === "string") {
        entrypoint = event.entrypoint;
      }
      // A deliberate rename (`--name` / in-session rename) wins over the
      // first-prompt title — it is what Claude's own /resume picker shows.
      // Generic pane labels this app once forced are skipped instead.
      if (
        !customTitle &&
        event.type === "custom-title" &&
        typeof event.customTitle === "string" &&
        !GENERIC_CUSTOM_TITLE.test(event.customTitle.trim())
      ) {
        customTitle = normalizeThreadTitle(event.customTitle);
      }
      // Claude's generated session title (what its own picker shows) — better
      // than the raw first prompt when present.
      if (
        !aiTitle &&
        event.type === "ai-title" &&
        typeof event.aiTitle === "string"
      ) {
        aiTitle = normalizeThreadTitle(event.aiTitle);
      }
      // First-prompt title: mirrors how Claude titles untitled sessions in its
      // picker. Assistant/summary/meta lines never title a thread.
      if (
        !title &&
        event.type !== "assistant" &&
        event.type !== "summary" &&
        !event.isMeta
      ) {
        const text =
          (typeof event.lastPrompt === "string" ? event.lastPrompt : "") ||
          extractClaudeText(event.message?.content);
        if (text && !isClaudeMetaText(text.trim())) {
          title = normalizeThreadTitle(text);
        }
      }
      if (!createdAt) {
        createdAt = Date.parse(
          event.timestamp || event.message?.timestamp || ""
        );
      }
    }

    if (!sessionId || !sawMatchingCwd) {
      return null;
    }

    const stat = fs.statSync(filePath);
    return {
      provider: "claude",
      id: sessionId,
      title: customTitle || aiTitle || title,
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      updatedAt: stat.mtimeMs,
      entrypoint
    };
  } catch {
    return null;
  }
}

// Strip parse-internal fields (entrypoint) before a ref leaves the host — a
// published threadRef gets persisted in workspace state as-is.
function publishClaudeThreadRef(ref) {
  if (!ref) {
    return ref;
  }
  const { entrypoint: _entrypoint, ...threadRef } = ref;
  return threadRef;
}

function findLatestClaudeThread(cwd, after = 0, excludeIds = []) {
  const excluded = toExcludedSet(excludeIds);
  const matches = collectJsonlFiles(claudeProjectsDir())
    .map((filePath) => parseClaudeTranscript(filePath, cwd))
    .filter(
      (ref) =>
        ref &&
        ref.id &&
        !excluded.has(String(ref.id)) &&
        Number.isFinite(ref.createdAt) &&
        ref.createdAt >= after
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return publishClaudeThreadRef(matches[0] || null);
}

// Every Claude chat for a folder, newest first — the Fusion resume picker's
// data source. `fusionOnly` keeps the picker to chats the Fusion harness
// itself created (headless SDK launches record entrypoint "sdk-cli";
// interactive pane chats record "cli"). An empty projects tree is a real
// empty history, not a failure.
function listClaudeThreads(cwd, after = 0, excludeIds = [], options = {}) {
  const excluded = toExcludedSet(excludeIds);
  const seen = new Set();
  const threads = collectJsonlFiles(claudeProjectsDir())
    .map((filePath) => parseClaudeTranscript(filePath, cwd))
    .filter(
      (ref) =>
        ref &&
        ref.id &&
        !excluded.has(String(ref.id)) &&
        Number.isFinite(ref.createdAt) &&
        ref.createdAt >= after &&
        (!options.fusionOnly || ref.entrypoint === "sdk-cli")
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((ref) => {
      if (seen.has(ref.id)) {
        return false;
      }
      seen.add(ref.id);
      return true;
    })
    .map(publishClaudeThreadRef);

  return { status: "found", threads };
}

function placeholderClaudeRef(id) {
  return {
    provider: "claude",
    id,
    title: "",
    createdAt: 0,
    updatedAt: 0
  };
}

// Locate the transcript file for a specific Claude session id without reading
// any file contents. Claude stores each session as `<sessionId>.jsonl`, so we
// match by name and short-circuit on the first hit. `complete` is false when a
// directory could not be read (so the target may live in an unreadable subtree)
// or a pathological-tree backstop tripped — meaning absence could NOT be proven,
// and callers must treat that as "unknown" rather than "missing".
function locateClaudeTranscriptFile(id) {
  const target = `${id}.jsonl`;
  const root = claudeProjectsDir();
  if (!fs.existsSync(root)) {
    return { path: null, complete: true };
  }

  const stack = [root];
  const visitCap = 200000;
  let visited = 0;
  let complete = true;

  while (stack.length > 0) {
    if (visited >= visitCap) {
      complete = false;
      break;
    }
    visited += 1;

    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // The unreadable directory might be the one holding the transcript, so we
      // can no longer prove the id is absent.
      complete = false;
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Claude's `<id>/subagents/agent-*.jsonl` tree only duplicates the
        // parent id; skip it (matches collectJsonlFiles).
        if (entry.name !== "subagents") {
          stack.push(entryPath);
        }
      } else if (entry.isFile() && entry.name === target) {
        return { path: entryPath, complete: true };
      }
    }
  }

  return { path: null, complete };
}

// Claude pre-assigns its session id (`--session-id <uuid>`) and later resumes
// with `claude --resume <uuid>`. That id only becomes resumable once Claude has
// persisted a transcript — i.e. after at least one exchanged message. Resuming a
// never-persisted id hard-fails with "No conversation found", which in a live
// shell pane strands the user at a bare prompt where their session should be.
//
// confirmClaudeThread answers "is this exact id safe to `--resume`?" so the
// launcher can start a clean session instead of hard-failing. If a file for the
// id exists we report it "found" (re-pinning the id with a fresh `--session-id`
// would collide), even across a cwd change. We report "missing" only when we can
// prove no such file exists; if the directory walk was incomplete we stay
// conservative and resume.
function confirmClaudeThread(cwd, id) {
  const target = String(id || "");
  if (!target) {
    return { status: "missing" };
  }

  const located = locateClaudeTranscriptFile(target);

  if (located.path) {
    const threadRef = publishClaudeThreadRef(
      parseClaudeTranscript(located.path, cwd) || placeholderClaudeRef(target)
    );
    return { status: "found", threadRef };
  }

  if (!located.complete) {
    // Could not prove the id is absent (unreadable dir or pathological tree);
    // resume rather than risk a duplicate-id collision on a fresh launch.
    return { status: "found", threadRef: placeholderClaudeRef(target) };
  }

  return { status: "missing" };
}

// Open Fusion panes pass envOverrides (XDG_DATA_HOME/XDG_CONFIG_HOME) so the
// CLI lists the app-owned OpenCode store instead of the user's global one —
// the two must never bleed into each other's discovery.
function opencodeSpawnEnv(envOverrides) {
  if (!envOverrides || typeof envOverrides !== "object") {
    return undefined;
  }
  const cleaned = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    if (typeof value === "string") {
      cleaned[key] = value;
    }
  }
  return Object.keys(cleaned).length ? { ...process.env, ...cleaned } : undefined;
}

// `opencode session list --format json` emits flat fields with millisecond
// (`Date.now()`) `created`/`updated`, so they compare directly against the
// millisecond `after` cutoff. Shared by latest-thread discovery and the
// resume-picker history listing so the two can never disagree on which
// sessions belong to a pane's folder.
function selectOpenCodeThreadRefs(sessions, cwd, after = 0, excludeIds = []) {
  const excluded = toExcludedSet(excludeIds);
  if (!Array.isArray(sessions)) {
    return [];
  }
  return sessions
    .filter(
      (session) =>
        session.id &&
        !excluded.has(String(session.id)) &&
        isSamePath(session.directory, cwd) &&
        Number(session.created || 0) >= after
    )
    .sort((a, b) => Number(b.updated || 0) - Number(a.updated || 0))
    .map((session) => ({
      provider: "opencode",
      id: session.id,
      title: session.title,
      createdAt: Number(session.created || 0),
      updatedAt: Number(session.updated || 0)
    }));
}

function spawnOpenCodeSessionList(cwd, envOverrides, maxCount) {
  return spawn("opencode", [
    "session",
    "list",
    "--format",
    "json",
    "--max-count",
    String(maxCount)
  ], {
    cwd,
    env: opencodeSpawnEnv(envOverrides),
    shell: process.platform === "win32",
    windowsHide: true
  });
}

function findLatestOpenCodeThread(cwd, after = 0, excludeIds = [], envOverrides) {
  const result = spawnOpenCodeSessionList(cwd, envOverrides, 100);

  return new Promise((resolve) => {
    let stdout = "";

    result.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    result.on("error", () => resolve(null));
    result.on("exit", () => {
      try {
        const sessions = JSON.parse(stdout);
        resolve(
          selectOpenCodeThreadRefs(sessions, cwd, after, excludeIds)[0] || null
        );
      } catch {
        resolve(null);
      }
    });
  });
}

// Every app-created session for a folder, newest first — the Open Fusion
// resume picker's data source. Unlike latest-discovery this FAILS rather than
// degrades: an empty-or-error listing must read as "could not list", never as
// "no saved chats". The `after` cutoff carries the migration timestamp so
// personal CLI threads that rode along in the seeded db snapshot never
// surface (see migrateOpenFusionThreadsFromGlobal).
const OPENCODE_HISTORY_LIST_MAX = 200;

function listOpenCodeThreads(cwd, after = 0, excludeIds = [], envOverrides) {
  const result = spawnOpenCodeSessionList(
    cwd,
    envOverrides,
    OPENCODE_HISTORY_LIST_MAX
  );

  return new Promise((resolve) => {
    let stdout = "";

    result.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    result.on("error", () =>
      resolve({
        status: "failed",
        message: "Could not run `opencode session list` to read saved chats."
      })
    );
    result.on("exit", (code) => {
      // A store with zero sessions prints NOTHING (exit 0) rather than "[]" —
      // that is a real empty history, not a read failure.
      if (!stdout.trim()) {
        resolve(
          code === 0
            ? { status: "found", threads: [] }
            : {
                status: "failed",
                message: "Could not read the saved-chat list from OpenCode."
              }
        );
        return;
      }
      try {
        const sessions = JSON.parse(stdout);
        resolve({
          status: "found",
          // updated === created (to the ms) means nothing ever happened in the
          // session: a ghost minted by a pane start in the eager-create era.
          // Real conversations bump `updated` on their first message. Only the
          // history listing hides them — confirm/latest lookups are untouched.
          threads: selectOpenCodeThreadRefs(sessions, cwd, after, excludeIds).filter(
            (thread) => thread.updatedAt > thread.createdAt
          )
        });
      } catch {
        resolve({
          status: "failed",
          message: "Could not read the saved-chat list from OpenCode."
        });
      }
    });
  });
}

function placeholderOpenCodeRef(id) {
  return { provider: "opencode", id, title: "", createdAt: 0, updatedAt: 0 };
}

// OpenCode resumes with `opencode --session <id>` against a session the CLI still
// knows about. confirmOpenCodeThread answers "does this id still exist?" so the
// launcher can self-heal to a fresh session instead of erroring in the live shell.
// Mirrors confirmClaudeThread's conservative contract: report "missing" only when
// the CLI succeeds and the id is provably absent; on any spawn/parse failure stay
// "found" (let the resume try) rather than discard a session that may well exist.
//
// `session list` is capped by --max-count, so an id absent from a FULL page may
// simply have fallen off the newest-N window rather than been deleted. Absence is
// only provable when the CLI returned fewer sessions than requested (the list was
// exhaustive). A truncated page without the id stays "found".
const OPENCODE_CONFIRM_LIST_MAX = 1000;

function confirmOpenCodeThread(cwd, id, envOverrides) {
  const target = String(id || "");
  if (!target) {
    return Promise.resolve({ status: "missing" });
  }

  const result = spawnOpenCodeSessionList(
    cwd,
    envOverrides,
    OPENCODE_CONFIRM_LIST_MAX
  );

  return new Promise((resolve) => {
    let stdout = "";

    result.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    result.on("error", () =>
      resolve({ status: "found", threadRef: placeholderOpenCodeRef(target) })
    );
    result.on("exit", () => {
      try {
        const sessions = JSON.parse(stdout);
        const match = Array.isArray(sessions)
          ? sessions.find(
              (session) => session.id && String(session.id) === target
            )
          : null;

        if (match) {
          resolve({
            status: "found",
            threadRef: {
              provider: "opencode",
              id: match.id,
              title: match.title,
              createdAt: Number(match.created || 0),
              updatedAt: Number(match.updated || 0)
            }
          });
          return;
        }

        if (
          !Array.isArray(sessions) ||
          sessions.length >= OPENCODE_CONFIRM_LIST_MAX
        ) {
          // A full page means the id may exist beyond the newest-N window; a
          // non-array response proves nothing. Resume rather than silently
          // replace the user's conversation with a fresh one.
          resolve({ status: "found", threadRef: placeholderOpenCodeRef(target) });
          return;
        }

        resolve({ status: "missing" });
      } catch {
        // Unparseable output — cannot prove the id is gone, so resume.
        resolve({ status: "found", threadRef: placeholderOpenCodeRef(target) });
      }
    });
  });
}

function cursorProjectsDir() {
  return path.join(os.homedir(), ".cursor", "projects");
}

// Cursor names each project directory after its absolute cwd with the drive
// colon dropped, path separators turned into "-", and repeated separators
// collapsed (verified from a live stop-hook `transcript_path`). e.g.
// C:\Users\me\app -> "C-Users-me-app".
function encodeCursorProjectDir(cwd) {
  return path
    .resolve(cwd)
    .replace(/:/g, "")
    .replace(/[\\/]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Resolve cwd to its on-disk Cursor project directory. The drive-letter case is
// whatever the user first opened the folder as, so match case-insensitively on
// Windows rather than trusting the exact spelling.
function findCursorProjectDir(cwd) {
  const root = cursorProjectsDir();
  const encoded = encodeCursorProjectDir(cwd);
  const direct = path.join(root, encoded);
  if (fs.existsSync(direct)) {
    return direct;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const wanted =
    process.platform === "win32" ? encoded.toLowerCase() : encoded;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const name =
      process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
    if (name === wanted) {
      return path.join(root, entry.name);
    }
  }
  return null;
}

// The opening user turn is line 1 of the transcript, so a bounded head read is
// enough — never slurp a multi-MB transcript just to title a thread.
function readFileHead(filePath, maxBytes = 16384) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed / never opened.
      }
    }
  }
}

// The first transcript line is the opening user turn; harvest its text for a
// human-readable thread title, unwrapping the <user_query> tags Cursor adds.
function parseCursorTranscriptTitle(jsonlPath) {
  const content = readFileHead(jsonlPath);
  if (!content) {
    return "";
  }
  // The head read may truncate the final line mid-JSON; only the early lines
  // matter for the title, and each is parsed independently.
  const lines = content.split(/\r?\n/).slice(0, 10);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.role !== "user") {
      continue;
    }
    const text = extractClaudeText(event.message?.content);
    if (text) {
      return text
        .replace(/<\/?user_query>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  return "";
}

// Cursor stores each chat as
// ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<chatId>/<chatId>.jsonl, so
// the latest resumable chat for a cwd is the most recently modified transcript
// dir. Mirrors findLatestClaudeThread; resume launches `cursor-agent --resume`.
function findLatestCursorThread(cwd, after = 0, excludeIds = []) {
  const projectDir = findCursorProjectDir(cwd);
  if (!projectDir) {
    return null;
  }

  const transcriptsDir = path.join(projectDir, "agent-transcripts");
  let entries = [];
  try {
    entries = fs.readdirSync(transcriptsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const excluded = toExcludedSet(excludeIds);
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || excluded.has(String(entry.name))) {
      continue;
    }
    const id = entry.name;
    const jsonlPath = path.join(transcriptsDir, id, `${id}.jsonl`);
    let stat;
    try {
      stat = fs.statSync(jsonlPath);
    } catch {
      // No transcript file yet (chat created but never persisted a turn) — not
      // resumable, so skip it.
      continue;
    }

    // birthtime/ctime can be 0 on some filesystems; fall back to mtime so a real
    // chat is never wrongly excluded by the `after` cutoff.
    const createdAt = stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs || 0;
    if (createdAt < after) {
      continue;
    }
    // Defer the (bounded) title read to the winner only, so a project with many
    // chats does not pay a file read per candidate.
    matches.push({ id, jsonlPath, createdAt, updatedAt: stat.mtimeMs });
  }

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => b.updatedAt - a.updatedAt);
  const latest = matches[0];
  return {
    provider: "cursor",
    id: latest.id,
    title: parseCursorTranscriptTitle(latest.jsonlPath),
    createdAt: latest.createdAt,
    updatedAt: latest.updatedAt
  };
}

function placeholderCursorRef(id) {
  return { provider: "cursor", id, title: "", createdAt: 0, updatedAt: 0 };
}

// Cursor resumes with `cursor-agent --resume <chatId>`. confirmCursorThread
// answers "does this chat still exist?" so the launcher can self-heal to a fresh
// session instead of erroring in the live shell. Mirrors confirmClaudeThread's
// conservative contract: report "missing" only when the projects tree is
// readable and the chat dir is absent; otherwise stay "found" and let resume try.
function confirmCursorThread(cwd, id) {
  const target = String(id || "");
  if (!target) {
    return { status: "missing" };
  }

  const projectDir = findCursorProjectDir(cwd);
  if (!projectDir) {
    // Cannot prove absence (the project dir may not have been scanned yet);
    // resume rather than discard a chat that may exist.
    return { status: "found", threadRef: placeholderCursorRef(target) };
  }

  const chatDir = path.join(projectDir, "agent-transcripts", target);
  if (fs.existsSync(chatDir)) {
    const jsonlPath = path.join(chatDir, `${target}.jsonl`);
    let updatedAt = 0;
    let createdAt = 0;
    try {
      const stat = fs.statSync(jsonlPath);
      updatedAt = stat.mtimeMs;
      createdAt = stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs || 0;
    } catch {
      // Dir exists without a transcript file; still treat as resumable.
    }
    return {
      status: "found",
      threadRef: {
        provider: "cursor",
        id: target,
        title: updatedAt ? parseCursorTranscriptTitle(jsonlPath) : "",
        createdAt,
        updatedAt
      }
    };
  }

  return { status: "missing" };
}

// Kimi Code CLI stores every session under $KIMI_CODE_HOME/sessions and keeps
// an append-only index at <home>/session_index.jsonl — one JSON line per
// session: { sessionId, sessionDir, workDir }. sessionDir is recorded absolute
// (forward slashes, even on Windows), so it stays valid across home
// relocations; state.json inside it carries { title, lastPrompt, createdAt,
// updatedAt } with ISO timestamps. The env is read at call time so tests can
// repoint the home per case.
function kimiHome() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
}

function parseKimiSessionIndex() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(kimiHome(), "session_index.jsonl"), "utf8");
  } catch {
    return { entries: [], readable: false };
  }

  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (record && record.sessionId && record.sessionDir && record.workDir) {
        entries.push({
          sessionId: String(record.sessionId),
          sessionDir: String(record.sessionDir),
          workDir: String(record.workDir)
        });
      }
    } catch {
      // Skip a malformed index line; the rest are still usable.
    }
  }
  return { entries, readable: true };
}

function parseKimiTimestampMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// state.json holds the display title (or, before one is generated, the opening
// prompt) and the ISO timestamps the threadRef needs.
function readKimiSessionState(sessionDir) {
  let state;
  try {
    state = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "state.json"), "utf8")
    );
  } catch {
    return null;
  }
  return {
    title: normalizeThreadTitle(state?.title || state?.lastPrompt || ""),
    createdAt: parseKimiTimestampMs(state?.createdAt),
    updatedAt: parseKimiTimestampMs(state?.updatedAt)
  };
}

// The latest resumable Kimi session for a folder. The index is append-ordered,
// but updatedAt from state.json is the real recency signal (a resumed older
// session jumps ahead), so sort on it. Resume launches `kimi --session <id>`.
function findLatestKimiThread(cwd, after = 0, excludeIds = []) {
  const excluded = toExcludedSet(excludeIds);
  const { entries } = parseKimiSessionIndex();
  const matches = [];

  for (const entry of entries) {
    if (excluded.has(entry.sessionId) || !isSamePath(entry.workDir, cwd)) {
      continue;
    }
    const state = readKimiSessionState(entry.sessionDir);
    if (!state) {
      // Index line without a readable session dir (deleted/moved) — skip it.
      continue;
    }
    if (state.createdAt < after) {
      continue;
    }
    matches.push({ id: entry.sessionId, ...state });
  }

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => b.updatedAt - a.updatedAt);
  const latest = matches[0];
  return {
    provider: "kimi",
    id: latest.id,
    title: latest.title,
    createdAt: latest.createdAt,
    updatedAt: latest.updatedAt
  };
}

// Every Kimi session for a folder, newest first — the resume picker's data
// source. An empty or unreadable index is a real empty history, not a failure.
function listKimiThreads(cwd, after = 0, excludeIds = []) {
  const excluded = toExcludedSet(excludeIds);
  const { entries } = parseKimiSessionIndex();
  const threads = [];

  for (const entry of entries) {
    if (excluded.has(entry.sessionId) || !isSamePath(entry.workDir, cwd)) {
      continue;
    }
    const state = readKimiSessionState(entry.sessionDir);
    if (!state || state.createdAt < after) {
      continue;
    }
    threads.push({
      provider: "kimi",
      id: entry.sessionId,
      title: state.title,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt
    });
  }

  threads.sort((a, b) => b.updatedAt - a.updatedAt);
  return { status: "found", threads };
}

function placeholderKimiRef(id) {
  return { provider: "kimi", id, title: "", createdAt: 0, updatedAt: 0 };
}

// Kimi resumes with `kimi --session <id>`. confirmKimiThread answers "does this
// session still exist?" so the launcher can self-heal to a fresh session
// instead of erroring in the live shell. Mirrors the other providers'
// conservative contract: report "missing" only when the index is readable and
// the id is absent; an unreadable index stays "found" and lets resume try.
function confirmKimiThread(cwd, id) {
  const target = String(id || "");
  if (!target) {
    return { status: "missing" };
  }

  const { entries, readable } = parseKimiSessionIndex();
  const entry = entries.find((candidate) => candidate.sessionId === target);
  if (!entry) {
    return readable
      ? { status: "missing" }
      : { status: "found", threadRef: placeholderKimiRef(target) };
  }

  const state = readKimiSessionState(entry.sessionDir);
  return {
    status: "found",
    threadRef: state
      ? {
          provider: "kimi",
          id: target,
          title: state.title,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt
        }
      : placeholderKimiRef(target)
  };
}

async function findLatestAgentThread(payload) {
  const cwd = payload?.cwd;
  const after = Number(payload?.after || 0);

  if (!cwd) {
    return {
      status: "failed",
      message: "Cannot discover an agent thread without a working directory."
    };
  }

  if (payload.provider === "codex") {
    // Confirm whether a specific rollout id is still resumable so the launcher
    // can self-heal instead of running a doomed `codex resume <id>`.
    if (payload.confirmId) {
      return confirmCodexThread(cwd, payload.confirmId);
    }

    // History listing for the Fusion resume picker (codex-planner panes).
    if (payload.list) {
      return listCodexThreads(payload);
    }

    return findCodexThread(payload);
  }

  if (payload.provider === "claude") {
    // A confirm request asks whether a specific pre-assigned id is safe to
    // resume, so the launcher can self-heal instead of running a doomed
    // `claude --resume <id>`.
    if (payload.confirmId) {
      return confirmClaudeThread(cwd, payload.confirmId);
    }

    // History listing for the Fusion resume picker: every chat for this
    // folder, newest first. `fusion` keeps it to harness-created chats.
    if (payload.list) {
      return listClaudeThreads(cwd, after, payload.excludeIds, {
        fusionOnly: Boolean(payload.fusion)
      });
    }

    const threadRef = findLatestClaudeThread(cwd, after, payload.excludeIds);
    return threadRef
      ? { status: "found", threadRef }
      : {
          status: "pending",
          message: "Waiting for Claude to create its local session metadata."
        };
  }

  if (payload.provider === "opencode") {
    // Confirm whether a specific session id is still resumable so the launcher
    // can self-heal instead of running a doomed `opencode --session <id>`.
    if (payload.confirmId) {
      return confirmOpenCodeThread(cwd, payload.confirmId, payload.opencodeEnv);
    }

    // History listing for the resume picker: every session for this folder,
    // newest first, behind the same env overrides as latest-discovery.
    if (payload.list) {
      return listOpenCodeThreads(
        cwd,
        after,
        payload.excludeIds,
        payload.opencodeEnv
      );
    }

    const threadRef = await findLatestOpenCodeThread(
      cwd,
      after,
      payload.excludeIds,
      payload.opencodeEnv
    );
    return threadRef
      ? { status: "found", threadRef }
      : {
          status: "pending",
          message: "Waiting for OpenCode to create its local session metadata."
        };
  }

  if (payload.provider === "cursor") {
    // Confirm whether a specific chat id is still resumable so the launcher can
    // self-heal instead of running a doomed `cursor-agent --resume <id>`.
    if (payload.confirmId) {
      return confirmCursorThread(cwd, payload.confirmId);
    }

    const threadRef = findLatestCursorThread(cwd, after, payload.excludeIds);
    return threadRef
      ? { status: "found", threadRef }
      : {
          status: "pending",
          message: "Waiting for Cursor to create its local session metadata."
        };
  }

  if (payload.provider === "kimi") {
    // Confirm whether a specific session id is still resumable so the launcher
    // can self-heal instead of running a doomed `kimi --session <id>`.
    if (payload.confirmId) {
      return confirmKimiThread(cwd, payload.confirmId);
    }

    // History listing for the resume picker: every session for this folder,
    // newest first.
    if (payload.list) {
      return listKimiThreads(cwd, after, payload.excludeIds);
    }

    const threadRef = findLatestKimiThread(cwd, after, payload.excludeIds);
    return threadRef
      ? { status: "found", threadRef }
      : {
          status: "pending",
          message: "Waiting for Kimi to create its local session metadata."
        };
  }

  return {
    status: "failed",
    message: `Unsupported agent thread provider: ${payload.provider || "unknown"}`
  };
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function handleHostLine(line) {
  if (!line.trim()) {
    return;
  }

  let message = null;
  try {
    message = JSON.parse(line);
  } catch (error) {
    emit({
      type: "error",
      message: `Bad agent-thread host message: ${error.message}`
    });
    return;
  }

  if (message.type === "shutdown") {
    process.exit(0);
    return;
  }

  if (message.type !== "lookup") {
    emit({
      type: "error",
      requestId: message.requestId,
      message: `Unknown agent-thread host message: ${message.type}`
    });
    return;
  }

  try {
    const result = await findLatestAgentThread(message.payload);
    emit({
      type: "response",
      requestId: message.requestId,
      result
    });
  } catch (error) {
    emit({
      type: "error",
      requestId: message.requestId,
      message: error.message
    });
  }
}

function startHost() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  rl.on("line", handleHostLine);

  emit({ type: "ready" });
}

if (require.main === module) {
  startHost();
}

module.exports = {
  collectJsonlFiles,
  confirmClaudeThread,
  confirmCursorThread,
  confirmKimiThread,
  confirmOpenCodeThread,
  encodeCursorProjectDir,
  extractClaudeText,
  findLatestAgentThread,
  findLatestClaudeThread,
  findLatestCursorThread,
  findLatestKimiThread,
  findLatestOpenCodeThread,
  isSamePath,
  listClaudeThreads,
  listKimiThreads,
  listOpenCodeThreads,
  locateClaudeTranscriptFile,
  normalizePathForCompare,
  opencodeSpawnEnv,
  selectOpenCodeThreadRefs,
  parseClaudeTranscript,
  parseCursorTranscriptTitle
};
