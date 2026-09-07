const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const fields = {
  messages: ['id', 'role', 'text', 'at', 'requestId', 'taskId', 'replyToId', 'questionId', 'origin'],
  receipts: ['id', 'kind', 'targetId', 'generation', 'status', 'text', 'at', 'requestId', 'taskId'],
  tasks: ['id', 'requestId', 'text', 'instruction', 'originalInstruction', 'status', 'phase', 'at', 'createdAt', 'updatedAt', 'targetId', 'generation', 'projectId', 'cwd', 'terminalId', 'question', 'questionId', 'result', 'error', 'replyToId', 'replyToRequestId', 'sequence', 'label', 'summary', 'outcome', 'origin'],
};
const empty = () => ({ messages: [], receipts: [], tasks: [] });
function createConversationStore({ userDataPath, getSecrets = () => [], now = Date.now }) {
  const file = path.join(userDataPath, 'orchestrator-conversation.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  let chain = Promise.resolve(); let epoch = 0; let committed = null; let pendingSave = null;
  function project(snapshot, restore = false) {
    const providedSecrets = getSecrets();
    if (!Array.isArray(providedSecrets)) throw new Error('Secret redaction is unavailable.');
    const secrets = providedSecrets.filter(value => typeof value === 'string' && value.length);
    const clean = text => secrets.reduce((value, secret) => value.split(secret).join('[redacted]'), text).replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})/gi, '[redacted]');
    function pick(source, keys) {
      const item = {};
      if (!source || typeof source !== 'object') return item;
      for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string') item[key] = clean(value.slice(0, 64000));
        else if (typeof value === 'number' && Number.isFinite(value)) item[key] = value;
        else if (typeof value === 'boolean') item[key] = value;
      }
      return item;
    }
    const result = empty(); const cutoff = now() - MAX_AGE;
    for (const kind of Object.keys(fields)) for (const source of (Array.isArray(snapshot?.[kind]) ? snapshot[kind] : []).slice(-20000)) {
      if (!source || typeof source !== 'object') continue;
      if (kind === 'messages' && (typeof source.id !== 'string' || !source.id || !['user', 'assistant', 'system'].includes(source.role) || typeof source.text !== 'string')) continue;
      if (kind === 'tasks' && (typeof source.requestId !== 'string' || !source.requestId || typeof source.status !== 'string' || !source.status)) continue;
      if (kind === 'receipts' && (typeof source.id !== 'string' || !source.id || typeof source.status !== 'string' || typeof source.text !== 'string')) continue;
      const at = Number(source.updatedAt ?? source.at ?? source.createdAt);
      if (!Number.isFinite(at) || at < cutoff || at > now() + 60000) continue;
      const item = pick(source, fields[kind]);
      if (kind === 'messages' && source.question && typeof source.question === 'object') item.question = pick(source.question, ['id', 'requestId', 'text']);
      if (kind === 'tasks') {
        // Associations are historical context only. Never persist dispatch plans,
        // grants, controller state, or executable action/permission objects.
        for (const key of ['targetIds', 'dependsOn']) if (Array.isArray(source[key])) item[key] = source[key].filter(value => typeof value === 'string').slice(0, 100).map(value => clean(value.slice(0, 500)));
        if (Array.isArray(source.targets)) item.targets = source.targets.slice(0, 100).filter(target => target && typeof target.id === 'string' && target.id).map(target => pick(target, ['id', 'generation', 'cwd', 'name']));
        if (source.question && typeof source.question === 'object') item.question = pick(source.question, ['id', 'requestId', 'text']);
        for (const key of ['result', 'outcome']) if (source[key] && typeof source[key] === 'object') item[key] = pick(source[key], ['ok', 'status', 'text', 'summary', 'error', 'targetId', 'requestId', 'generation', 'at']);
      }
      if (restore && kind === 'tasks' && !['finished', 'completed', 'cancelled'].includes(item.status)) { item.status = 'paused'; item.phase = 'paused'; }
      result[kind].push(item);
    }
    // Evict oldest records together rather than favoring one history category.
    const stamp = item => Number(item.updatedAt ?? item.at ?? item.createdAt);
    const records = Object.entries(result).flatMap(([kind, items]) => items.map(item => ({ kind, item, size: Buffer.byteLength(JSON.stringify(item)) + 1 }))).sort((a, b) => stamp(a.item) - stamp(b.item));
    let bytes = Buffer.byteLength(JSON.stringify(empty())) + records.reduce((total, record) => total + record.size, 0);
    const evicted = new Set();
    for (const record of records) { if (bytes <= MAX_BYTES) break; evicted.add(record.item); bytes -= record.size; }
    for (const kind of Object.keys(fields)) result[kind] = result[kind].filter(item => !evicted.has(item));
    return result;
  }
  function enqueue(fn) { chain = chain.then(fn).catch(() => {}); return chain; }
  return {
    load() { try { if (fs.statSync(file).size > MAX_BYTES) return empty(); return project(JSON.parse(fs.readFileSync(file, 'utf8')), true); } catch { return empty(); } },
    save(snapshot) {
      const generation = epoch; let data;
      try { data = JSON.stringify(project(snapshot)); } catch { return Promise.resolve(); }
      if (pendingSave?.generation === generation && pendingSave.data === data) return pendingSave.promise;
      if (!pendingSave && committed === data) return chain;
      const record = { generation, data, promise: null };
      const operation = enqueue(async () => {
        if (generation !== epoch) return;
        if (committed === data) return;
        await fs.promises.mkdir(userDataPath, { recursive: true });
        await fs.promises.writeFile(temporary, data, { mode: 0o600 });
        if (generation !== epoch) { await fs.promises.rm(temporary, { force: true }); return; }
        await fs.promises.rename(temporary, file);
        if (generation === epoch) committed = data;
      });
      record.promise = operation.finally(() => { if (pendingSave === record) pendingSave = null; });
      pendingSave = record;
      return record.promise;
    },
    clear() { epoch++; committed = null; pendingSave = null; return enqueue(async () => { await fs.promises.rm(file, { force: true }); await fs.promises.rm(temporary, { force: true }); }); },
    flush() { return chain; },
  };
}
module.exports = { createConversationStore, MAX_BYTES, MAX_AGE };
