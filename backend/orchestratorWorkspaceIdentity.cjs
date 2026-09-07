'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// A Git worktree (including a linked worktree with a .git file) owns one lane.
// Resolve junctions before walking so two aliases cannot acquire different lanes.
function createWorkspaceIdentity({ now = Date.now } = {}) {
  const cache = new Map();
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  return async function resolveWorkspaceIdentity(cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
    let resolved;
    try { resolved = await fs.realpath(cwd); } catch { resolved = path.resolve(cwd); }
    const key = normalize(resolved), cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.identity;
    let current = resolved, identity = key;
    while (true) {
      try {
        const entry = await fs.stat(path.join(current, '.git'));
        if (entry.isDirectory() || entry.isFile()) { identity = normalize(current); break; }
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) break; }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    cache.set(key, { identity, expiresAt: now() + 60000 });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return identity;
  };
}
module.exports = { createWorkspaceIdentity };
