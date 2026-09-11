"use strict";
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
function git(cwd, args) {
  return new Promise((resolve, reject) => execFile("git", ["--no-pager", "--literal-pathspecs", ...args],
    { cwd, windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
    (error, stdout, stderr) => error ? reject(new Error(stderr?.trim() || error.message)) : resolve(stdout)));
}
function parseStatus(text) {
  const parts = text.split("\0"), files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]; if (entry.length < 4) continue;
    const status = entry.slice(0, 2), file = { path: entry.slice(3), status, staged: status[0] !== " " && status[0] !== "?" };
    if (/[RC]/.test(status)) file.oldPath = parts[++i];
    files.push(file);
  }
  return files;
}
async function listChanges(cwd) {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const files = parseStatus(await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const fingerprint = createHash("sha256");
  for (const file of files.slice(0, 200)) {
    fingerprint.update(JSON.stringify(file));
    try { const stat = await fs.lstat(path.resolve(root, file.path)); fingerprint.update(`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`); } catch { fingerprint.update("missing"); }
  }
  return { ok: true, root, files: files.slice(0, 200), revision: fingerprint.digest("hex"), truncated: files.length > 200 };
}
async function readChange(cwd, filePath) {
  const snapshot = await listChanges(cwd);
  const item = snapshot.files.find(f => f.path === filePath);
  if (!item) throw new Error("This file is not in the current change list. Refresh changes.");
  const file = path.resolve(snapshot.root, item.path), relative = path.relative(snapshot.root, file);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("File is outside the project.");
  try { const real = await fs.realpath(file), rel = path.relative(snapshot.root, real); if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) throw new Error("File resolves outside the project."); } catch (e) { if (e.code !== "ENOENT") throw e; }
  let staged = "", unstaged = "", truncated = false;
  if (item.status === "??") {
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.alloc(128001); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      truncated = bytesRead > 128000;
      unstaged = buffer.subarray(0, Math.min(bytesRead, 128000)).includes(0) ? "Binary file (preview unavailable)." : buffer.subarray(0, Math.min(bytesRead, 128000)).toString("utf8");
    } finally { await handle.close(); }
  } else {
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--", item.path];
    [staged, unstaged] = await Promise.all([git(snapshot.root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", item.path]), git(snapshot.root, args)]);
    truncated = staged.length > 128000 || unstaged.length > 128000;
    staged = staged.slice(0, 128000); unstaged = unstaged.slice(0, 128000);
  }
  return { ok: true, ...item, revision: snapshot.revision, stagedDiff: staged, unstagedDiff: unstaged, truncated };
}
module.exports = { parseStatus, listChanges, readChange };
