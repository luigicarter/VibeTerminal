'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_ITEMS = 500, MAX_BYTES = 1024 * 1024, MAX_AGE = 30 * 86400000;
const copy = value => value == null ? value : structuredClone(value);
const validGeneration = value => typeof value === 'string' && value.length > 0 || typeof value === 'number' && Number.isFinite(value);
const cwdKey = value => { if (typeof value !== 'string') return null; const windows = process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(value); const normalized = (windows ? path.win32 : path.posix).normalize(value).replace(/\\/g, '/').replace(/\/$/, ''); return windows ? normalized.toLowerCase() : normalized; };

// Historical affinity only. No grants, reservations or executable actions cross
// this persistence boundary; even a saved live binding requires fresh evidence.
function createWorkItemStore({ userDataPath, getSecrets = () => [], now = Date.now } = {}) {
  const file = path.join(userDataPath, 'orchestrator-work-items.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  let items = new Map(), chain = Promise.resolve(), lastError = null, epoch = 0;
  function project(source, restored = false) {
    const secrets = getSecrets();
    if (!Array.isArray(secrets)) throw new Error('Secret redaction unavailable.');
    const clean = value => secrets.filter(s => typeof s === 'string' && s).reduce((s, secret) => s.split(secret).join('[redacted]'), String(value)).replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})/gi, '[redacted]');
    const fields = (value, keys, limit = 2000) => Object.fromEntries(keys.filter(k => typeof value?.[k] === 'string').map(k => [k, clean(value[k]).slice(0, limit)]));
    if (!source || typeof source.id !== 'string' || !source.id || source.requestIds !== undefined && !Array.isArray(source.requestIds)) return null;
    const item = { ...fields(source, ['id', 'title', 'summary', 'source', 'cwd', 'status']), ...fields(source, ['objective', 'text'], 16000),
      createdAt: Number(source.createdAt), updatedAt: Number(source.updatedAt),
      requestIds: [...new Set((source.requestIds || []).filter(v => typeof v === 'string' && v).map(v => clean(v).slice(0, 500)))].slice(-100),
      requiresRevalidation: restored || source.requiresRevalidation !== false };
    if (!Number.isFinite(item.updatedAt) || item.updatedAt < now() - MAX_AGE || item.updatedAt > now() + 60000) return null;
    if (source.binding?.target?.id && validGeneration(source.binding.target.generation)) {
      item.binding = { target: fields(source.binding.target, ['id', 'generation', 'cwd']),
        nativeIdentity: fields(source.binding.nativeIdentity, ['provider', 'home', 'workspace', 'id', 'engineProvider']),
        evidence: fields(source.binding.evidence, ['source', 'summary', 'requestId']), at: Number(source.binding.at) || item.updatedAt };
      if (Number.isSafeInteger(source.binding.target.launchToken)) item.binding.target.launchToken = source.binding.target.launchToken;
      if (Number.isSafeInteger(source.binding.nativeIdentity?.selectionRevision) && source.binding.nativeIdentity.selectionRevision >= 0) {
        item.binding.nativeIdentity.selectionRevision = source.binding.nativeIdentity.selectionRevision;
      }
      if (typeof source.binding.target.generation === 'number') item.binding.target.generation = source.binding.target.generation;
    }
    return item;
  }
  function bounded(values, restored = false) {
    const selected = values.map(v => project(v, restored)).filter(Boolean).sort((a, b) => a.updatedAt - b.updatedAt).slice(-MAX_ITEMS);
    while (Buffer.byteLength(JSON.stringify({ version: 1, items: selected })) > MAX_BYTES) selected.shift();
    return selected;
  }
  try { if (fs.statSync(file).size <= MAX_BYTES) { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.version === 1 && Array.isArray(saved.items)) items = new Map(bounded(saved.items, true).map(i => [i.id, i])); } } catch { /* unavailable or invalid history gives no routing authority */ }
  function save() {
    const generation = epoch;
    const values = bounded([...items.values()]);
    items = new Map(values.map(i => [i.id, i]));
    const data = JSON.stringify({ version: 1, items: values });
    chain = chain.then(async () => {
      try {
        if (generation !== epoch) return;
        await fs.promises.mkdir(userDataPath, { recursive: true });
        if (generation !== epoch) return;
        await fs.promises.writeFile(temporary, data, { mode: 0o600 });
        if (generation !== epoch) { await fs.promises.rm(temporary, { force: true }); return; }
        await fs.promises.rename(temporary, file); lastError = null;
      }
      catch (error) { lastError = error; }
    });
  }
  function update(id, patch = {}) {
    const old = items.get(id); if (!old || !patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
    const item = project({ ...old, ...patch, id, createdAt: old.createdAt, updatedAt: now() });
    if (!item) return null;
    items.set(id, item); save(); return copy(items.get(id));
  }
  return {
    create(input = {}) { if (!input || typeof input !== 'object' || Array.isArray(input) || input.requestIds !== undefined && !Array.isArray(input.requestIds)) return null; const id = input.id || randomUUID(); if (items.has(id)) return copy(items.get(id)); const item = project({ ...input, id, requestIds: input.requestId ? [input.requestId] : input.requestIds || [], createdAt: now(), updatedAt: now(), requiresRevalidation: true }); if (!item) return null; items.set(id, item); save(); return copy(items.get(id)); },
    get: id => copy(items.get(id)),
    findByRequest: requestId => copy([...items.values()].find(i => i.requestIds.includes(requestId))),
    list({ cwd, query = '', offset = 0, limit = 50 } = {}) { return copy([...items.values()].filter(i => (!cwd || cwdKey(i.cwd) === cwdKey(cwd)) && `${i.title || ''} ${i.summary || ''} ${i.objective || ''} ${i.text || ''}`.toLowerCase().includes(String(query).toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt).slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, Math.min(100, limit)))); },
    associateRequest(id, requestId) { const old = items.get(id); return old && typeof requestId === 'string' && requestId ? update(id, { requestIds: [...old.requestIds, requestId] }) : null; },
    bind(id, { target, nativeIdentity, evidence } = {}) { if (!target?.id || !validGeneration(target.generation) || String(target.generation).startsWith('paused:')) return null; return update(id, { binding: { target, nativeIdentity, evidence, at: now() }, requiresRevalidation: false }); },
    update,
    snapshot: () => copy({ version: 1, items: [...items.values()] }),
    clear() { epoch++; items.clear(); chain = chain.then(async () => { try { await fs.promises.rm(file, { force: true }); await fs.promises.rm(temporary, { force: true }); lastError = null; } catch (error) { lastError = error; } }); return chain; },
    async flush() { await chain; if (lastError) throw lastError; }
  };
}
module.exports = { createWorkItemStore, MAX_ITEMS, MAX_BYTES, MAX_AGE };
