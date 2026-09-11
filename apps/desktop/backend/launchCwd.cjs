const fs = require("fs");
const path = require("path");

function resolveLaunchCwd(rawCwd, fallbackCwd = process.cwd()) {
  const requested =
    typeof rawCwd === "string" && rawCwd.trim().length > 0
      ? rawCwd
      : fallbackCwd;
  const cwd = path.resolve(requested);

  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        cwd,
        message: `Working directory is not a folder: ${cwd}`
      };
    }
  } catch {
    return {
      ok: false,
      cwd,
      message: `Working directory is unavailable: ${cwd}`
    };
  }

  return { ok: true, cwd };
}

module.exports = {
  resolveLaunchCwd
};
