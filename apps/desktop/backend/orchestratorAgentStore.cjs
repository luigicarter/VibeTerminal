'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { VERSION, LIMITS, id } = require('../shared/orchestratorAgentContract.cjs');
const { nativeKey } = require('./orchestratorRouting.cjs');
const kinds = new Set(['finding', 'decision', 'open-question', 'handoff']);
const clone = value => structuredClone(value);
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

// One writer, committed receipts, additive sidecar. No runtime/grant restoration.
function createAgentStore({ userDataPath, getSecrets = () => [], now = Date.now, fsImpl = fs.promises,
  maxBytes = LIMITS.storeBytes, maxAgentBytes = LIMITS.agentNoteBytes } = {}) {
  const filename = path.join(userDataPath, 'orchestrator-agents-v1.json'), backup = `${filename}.bak`;
  let state = { version: VERSION, revision: 0, identities: [], notes: [] }, status = 'new', blocked = false;
  let chain = Promise.resolve();
  const clean = value => {
    const secrets = getSecrets();
    if (!Array.isArray(secrets)) throw new Error('Agent record redaction is unavailable.');
    let result = String(value);
    for (const secret of secrets.filter(s => typeof s === 'string' && s)) result = result.split(secret).join('[redacted]');
    return result.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})/gi, '[redacted]');
  };
  function valid(value) {
    const fields = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
    return fields(value, ['version', 'revision', 'identities', 'notes']) && value.version === VERSION && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
      Array.isArray(value.identities) && value.identities.length <= LIMITS.identities &&
      value.identities.every(v => fields(v, ['agentId', 'nativeIdentity', 'name', 'kind']) && id(v.agentId) &&
        fields(v.nativeIdentity, ['provider', 'home', 'workspace', 'id']) &&
        ['provider', 'home', 'workspace'].every(k => id(v.nativeIdentity[k])) && (v.nativeIdentity.id === undefined || id(v.nativeIdentity.id))) &&
      new Set(value.identities.map(v => v.agentId)).size === value.identities.length &&
      new Set(value.identities.map(v => nativeKey(v.nativeIdentity)).filter(Boolean)).size === value.identities.filter(v => nativeKey(v.nativeIdentity)).length &&
      Array.isArray(value.notes) && value.notes.every(n => fields(n, ['id', 'agentId', 'workItemId', 'requestId', 'kind', 'body', 'operationId', 'provenance', 'revision', 'createdAt', 'updatedAt']) &&
        id(n.id) && id(n.agentId) && id(n.requestId) && kinds.has(n.kind) &&
        typeof n.body === 'string' && bytes(n.body) <= LIMITS.noteBytes && Number.isSafeInteger(n.revision) && n.revision > 0 &&
        Number.isFinite(n.createdAt) && Number.isFinite(n.updatedAt) && id(n.operationId) && n.provenance === 'orchestrator-inference') &&
      new Set(value.notes.map(n => n.id)).size === value.notes.length;
  }
  function load(file) {
    if (fs.statSync(file).size > maxBytes) throw new Error('Agent record store exceeds its size limit.');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== VERSION) { blocked = true; status = 'unsupported-version'; throw new Error(status); }
    if (!valid(value)) throw new Error('Invalid agent record store.');
    return value;
  }
  try { state = load(filename); status = 'loaded'; }
  catch (error) {
    if (!blocked && error.code !== 'ENOENT') {
      try { state = load(backup); status = 'recovered-backup'; }
      catch { blocked = true; if (status !== 'unsupported-version') status = 'unreadable'; }
    }
  }
  function enqueue(change) {
    const operation = chain.then(async () => {
      if (blocked) throw new Error(`Agent notes are read-only: ${status}.`);
      const next = clone(state), result = change(next);
      if (result.unchanged) return clone(result.value);
      next.revision++;
      if (!valid(next) || bytes(next) > maxBytes) throw new Error('Agent record storage limit or schema rejected this write. Existing records were retained.');
      const temporary = `${filename}.${randomUUID()}.tmp`, backupTemporary = `${backup}.${randomUUID()}.tmp`;
      await fsImpl.mkdir(userDataPath, { recursive: true });
      try {
        const handle = await fsImpl.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(next), 'utf8'); await handle.sync(); } finally { await handle.close(); }
        // A recovered backup remains intact until a new primary has committed.
        if (status === 'loaded' || status === 'saved') {
          await fsImpl.copyFile(filename, backupTemporary);
          await fsImpl.rename(backupTemporary, backup);
        }
        await fsImpl.rename(temporary, filename);
        state = next; status = 'saved';
        return clone(result.value);
      } finally {
        await fsImpl.rm(temporary, { force: true }).catch(() => {});
        await fsImpl.rm(backupTemporary, { force: true }).catch(() => {});
      }
    });
    chain = operation.catch(() => {});
    return operation;
  }
  return {
    status: () => ({ status, writable: !blocked, revision: state.revision }),
    identities: () => clone(state.identities),
    noteVersion: agentId => JSON.stringify(state.notes.filter(n => n.agentId === agentId).map(n => [n.id, n.revision, n.operationId])),
    syncIdentities(identities) {
      return enqueue(next => {
        // Exact identity fields are not redacted into different routing keys.
        // Reject a secret-bearing identity rather than persist or rename it.
        if (clean(JSON.stringify(identities)) !== JSON.stringify(identities)) throw new Error('Sensitive data was found in agent identity metadata.');
        const selected = identities.map(v => ({ agentId: v.agentId, nativeIdentity: v.nativeIdentity, name: v.name, kind: v.kind }));
        if (JSON.stringify(next.identities) === JSON.stringify(selected)) return { unchanged: true, value: { ok: true, status: 'unchanged' } };
        next.identities = clone(selected);
        return { value: { ok: true, status: 'saved' } };
      });
    },
    list({ agentId, workItemId, offset = 0, limit = 20 } = {}) {
      const selected = state.notes.filter(n => (!agentId || n.agentId === agentId) && (!workItemId || n.workItemId === workItemId));
      const start = Math.max(0, Number(offset) || 0), size = Math.max(1, Math.min(20, Number(limit) || 20));
      return clone({ notes: selected.slice(start, start + size), total: selected.length, nextOffset: start + size < selected.length ? start + size : null });
    },
    write(input, { requestId, knownAgent, knownWorkItem } = {}) {
      return enqueue(next => {
        if (!input || Object.keys(input).some(k => !['id', 'agentId', 'workItemId', 'kind', 'body', 'expectedRevision', 'operationId'].includes(k)) ||
          !id(input.agentId) || !knownAgent || !id(requestId) || !id(input.operationId) || !kinds.has(input.kind) || typeof input.body !== 'string' ||
          !input.body.trim() || bytes(input.body) > LIMITS.noteBytes || input.workItemId && (!id(input.workItemId) || !knownWorkItem)) throw new Error('A note needs known agent/work/request scope and bounded text.');
        const priorOperation = next.notes.find(n => n.operationId === input.operationId && n.requestId === requestId);
        const body = clean(input.body);
        if (priorOperation) {
          if (priorOperation.agentId !== input.agentId || priorOperation.workItemId !== input.workItemId || priorOperation.body !== body || priorOperation.kind !== input.kind || input.id && priorOperation.id !== input.id) throw new Error('A note operation cannot change its content.');
          return { unchanged: true, value: { ok: true, status: 'saved', note: priorOperation } };
        }
        const old = input.id && next.notes.find(n => n.id === input.id);
        if (input.id && !old || old && (old.agentId !== input.agentId || old.workItemId !== input.workItemId)) throw new Error('Unknown note in this agent/work scope.');
        if ((input.expectedRevision ?? 0) !== (old?.revision || 0)) throw new Error('The note changed; read its current revision before editing.');
        const note = { id: old?.id || `note_${randomUUID()}`, agentId: input.agentId, ...(input.workItemId && { workItemId: input.workItemId }),
          requestId, kind: input.kind, body, operationId: input.operationId, provenance: 'orchestrator-inference',
          revision: (old?.revision || 0) + 1, createdAt: old?.createdAt || now(), updatedAt: now() };
        next.notes = next.notes.filter(n => n.id !== note.id).concat(note);
        if (bytes(next.notes.filter(n => n.agentId === note.agentId)) > maxAgentBytes) throw new Error('This agent note limit is reached; earlier notes were retained.');
        return { value: { ok: true, status: 'saved', note } };
      });
    },
    clearNotes(agentId) { return enqueue(next => { next.notes = agentId ? next.notes.filter(n => n.agentId !== agentId) : []; return { value: { ok: true, status: 'cleared' } }; }); },
    flush: () => chain
  };
}
module.exports = { createAgentStore };
