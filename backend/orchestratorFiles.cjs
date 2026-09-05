'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
function inside(root, target) { const relative = path.relative(root, target); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function createFiles({ getRoots }) {
  async function roots() { const supplied = await getRoots(); const entries = Array.isArray(supplied) ? supplied : [supplied?.documents, ...(supplied?.projects || [])].filter(Boolean); const result = []; for (const entry of entries || []) { const p = typeof entry === 'string' ? entry : entry.path; if (!p || !path.isAbsolute(p)) continue; try { result.push(await fs.realpath(p)); } catch {} } return [...new Set(result)]; }
  async function allowed(p) { if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('An absolute path is required.'); const canonical = await fs.realpath(p); if (!(await roots()).some(r => inside(r, canonical))) throw new Error('Path is outside allowed operating-system roots.'); return canonical; }
  return {
    roots,
    async search({ root, query = '', limit = 100 }, signal) {
      if (typeof query !== 'string' || query.length > 512) throw new Error('Invalid search.');
      const start = root ? [await allowed(root)] : await roots(); const found = []; const queue = [...start]; const visited = new Set(); let scanned = 0;
      while (queue.length && found.length < Math.min(200, Math.max(1, limit)) && scanned < 10000) {
        if (signal?.aborted) throw new Error('Cancelled.'); const dir = queue.shift(); if (visited.has(dir)) continue; visited.add(dir);
        let children; try { await allowed(dir); children = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const child of children) { if (++scanned > 10000) break; if (child.isSymbolicLink() || ['node_modules', '.git', 'AppData'].includes(child.name)) continue; const p = path.join(dir, child.name); if (child.name.toLowerCase().includes(query.toLowerCase())) found.push({ path: p, name: child.name, directory: child.isDirectory() }); if (child.isDirectory()) queue.push(p); if (found.length >= Math.min(200, Math.max(1, limit))) break; }
      }
      return { ok: true, files: found, truncated: queue.length > 0 || scanned >= 10000 };
    },
    async createProject({ parent, name }, signal) {
      if (typeof name !== 'string' || !name.trim() || name.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || name === '.' || name === '..' || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Invalid project folder name.');
      const base = await allowed(parent); const target = path.join(base, name); if (signal?.aborted) throw new Error('Cancelled.'); await fs.mkdir(target); const canonical = await allowed(target); if (!inside(base, canonical)) throw new Error('Project path changed during creation.'); return { ok: true, path: canonical };
    },
  };
}
module.exports = { createFiles, inside };
