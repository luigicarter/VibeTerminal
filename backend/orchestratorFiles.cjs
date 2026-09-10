'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
function inside(root, target) { const relative = path.relative(root, target); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function createFiles({ getRoots }) {
  async function roots() { const supplied = await getRoots(); const entries = Array.isArray(supplied) ? supplied : [supplied?.documents, ...(supplied?.locations || []), ...(supplied?.projects || [])].filter(Boolean); const result = []; for (const entry of entries || []) { const p = typeof entry === 'string' ? entry : entry.path; if (!p || !path.isAbsolute(p)) continue; try { result.push(await fs.realpath(p)); } catch {} } return [...new Set(result)]; }
  async function allowed(p) { if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('An absolute path is required.'); const canonical = await fs.realpath(p); if (!(await roots()).some(r => inside(r, canonical))) throw new Error('Path is outside allowed operating-system roots.'); return canonical; }
  return {
    roots,
    async read({ path: filename, offset = 0, limit = 4000, reference }, signal) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 4000) throw new Error('File reads require a nonnegative byte offset and a limit from 1 to 4000.');
      if (signal?.aborted) throw new Error('Cancelled.');
      const canonical = await allowed(filename), handle = await fs.open(canonical, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('Choose a regular text file.');
        const revision = createHash('sha256').update(JSON.stringify([canonical, stat.size, stat.mtimeMs, stat.ino])).digest('hex');
        if (offset && !reference || reference !== undefined && reference !== revision) throw new Error('The file changed or its page reference is missing. Read the first page again.');
        if (offset > stat.size) throw new Error('The file offset is beyond the end of the file.');
        const bytes = Buffer.alloc(Math.min(limit + 4, stat.size - offset));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
        if (bytes.subarray(0, bytesRead).includes(0)) throw new Error('Binary files are not readable as workspace text.');
        let text;
        try {
          const available = bytes.subarray(0, Math.min(limit, bytesRead));
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(available, { stream: offset + available.length < stat.size });
          if (!text && bytesRead) text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, Math.min(4, bytesRead)), { stream: offset + Math.min(4, bytesRead) < stat.size });
        } catch { throw new Error('This file page is not valid UTF-8 text.'); }
        const consumed = Buffer.byteLength(text), after = await handle.stat();
        if (signal?.aborted) throw new Error('Cancelled.');
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('The file changed while being read. Read it again.');
        const nextOffset = offset + consumed < stat.size ? offset + consumed : null;
        return { ok: true, path: canonical, reference: revision, text, offset, nextOffset, totalBytes: stat.size, truncated: nextOffset !== null };
      } finally { await handle.close(); }
    },
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
