const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const fields = {
  messages: ['id', 'role', 'text', 'at', 'requestId', 'taskId', 'replyToId', 'questionId', 'origin',
    'reportKind', 'status', 'targetId', 'generation', 'turnId', 'actionId', 'completionCue'],
  receipts: ['id', 'kind', 'targetId', 'generation', 'launchToken', 'actionId', 'grantId', 'cwd', 'status', 'text', 'at', 'requestId', 'taskId'],
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
      if (kind === 'receipts') {
        for (const key of ['actionId', 'grantId']) {
          if (typeof source[key] === 'string') item[key] = clean(source[key].slice(0, 256)); else delete item[key];
        }
        if (!Number.isSafeInteger(source.launchToken) || source.launchToken < 0) delete item.launchToken;
      }
      if (kind === 'receipts' && source.kind === 'close' && source.close && typeof source.close === 'object') {
        const close = {}, value = source.close;
        if (typeof value.operationId === 'string' && value.operationId) close.operationId = clean(value.operationId.slice(0, 256));
        if (value.target && typeof value.target === 'object') {
          const target = {};
          for (const key of ['id', 'kind']) if (typeof value.target[key] === 'string') target[key] = clean(value.target[key].slice(0, 256));
          if (typeof value.target.generation === 'string') target.generation = clean(value.target.generation.slice(0, 256));
          else if (Number.isSafeInteger(value.target.generation) && value.target.generation >= 0) target.generation = value.target.generation;
          if (Number.isSafeInteger(value.target.launchToken) && value.target.launchToken >= 0) target.launchToken = value.target.launchToken;
          if (target.id) close.target = target;
        }
        if (['present', 'removed', 'already-absent', 'superseded', 'unknown'].includes(value.pane)) close.pane = value.pane;
        if (['running', 'stopped', 'already-absent', 'superseded', 'failed', 'unknown'].includes(value.process)) close.process = value.process;
        for (const key of ['launchSettled', 'scopeEmpty']) if (typeof value[key] === 'boolean') close[key] = value[key];
        if (Number.isSafeInteger(value.verifiedAt) && value.verifiedAt >= 0 && value.verifiedAt <= now() + 60000) close.verifiedAt = value.verifiedAt;
        for (const key of ['targetCount', 'verifiedTargetCount', 'remainingTargetCount', 'newTargetCount', 'supersededTargetCount']) {
          if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 20000) close[key] = value[key];
        }
        if (Object.keys(close).length) item.close = close;
      }
      if (kind === 'messages' && source.question && typeof source.question === 'object') item.question = pick(source.question, ['id', 'requestId', 'text']);
      if (kind === 'tasks') {
        // Routing describes a past decision; it cannot restore execution authority.
        if (['legacy', 'agents-v1'].includes(source.harnessVersion)) item.harnessVersion = source.harnessVersion;
        if (typeof source.projectPath === 'string' && source.projectPath.length <= 32768) item.projectPath = clean(source.projectPath);
        const routingText = (value, limit) => typeof value === 'string' ? clean(value).slice(0, limit) : undefined;
        if (typeof source.workItemId === 'string') item.workItemId = routingText(source.workItemId, 500);
        if (Array.isArray(source.workItemIds)) item.workItemIds = source.workItemIds.filter(value => typeof value === 'string').slice(0, 100).map(value => routingText(value, 500));
        if (source.assignment && ['create', 'reuse'].includes(source.assignment.decision)) {
          item.assignment = { decision: source.assignment.decision };
          for (const [key, limit] of [['reason', 2000], ['workItemId', 500]]) {
            const value = routingText(source.assignment[key], limit);
            if (value !== undefined) item.assignment[key] = value;
          }
        }
        // Associations are historical context only. Never persist dispatch plans,
        // grants, controller state, or executable action/permission objects.
        for (const key of ['targetIds', 'dependsOn']) if (Array.isArray(source[key])) item[key] = source[key].filter(value => typeof value === 'string').slice(0, 100).map(value => clean(value.slice(0, 500)));
        if (Array.isArray(source.targets)) item.targets = source.targets.slice(0, 100).filter(target => target && typeof target.id === 'string' && target.id).map(target => pick(target, ['id', 'generation', 'cwd', 'name']));
        if (source.question && typeof source.question === 'object') item.question = pick(source.question, ['id', 'requestId', 'text']);
        for (const key of ['result', 'outcome']) if (source[key] && typeof source[key] === 'object') item[key] = pick(source[key], ['ok', 'status', 'text', 'summary', 'error', 'targetId', 'requestId', 'generation', 'at']);
      }
      if (kind === 'tasks') {
        for (const key of ['continuedFromRequestId', 'continuedByRequestId']) if (typeof source[key] === 'string') item[key] = clean(source[key].slice(0, 256));
        if (['active', 'needs-answer', 'transferred', 'completed', 'failed'].includes(source.controlDisposition)) item.controlDisposition = source.controlDisposition;
        if (typeof source.resultScopeTransferred === 'boolean') item.resultScopeTransferred = source.resultScopeTransferred;
      }
      if (restore && kind === 'tasks' && !['finished', 'completed', 'cancelled', 'continued', ...(item.controlDisposition === 'transferred' ? ['failed'] : [])].includes(item.status)) { item.status = 'paused'; item.phase = 'paused'; }
      // Older versions could retire a failed request as finished while retaining
      // its error. Preserve the history, but never restore that conflict as proof
      // of success or reconstruct executable retry authority from its prose.
      if (restore && kind === 'tasks' && ['finished', 'completed'].includes(item.status) && typeof item.error === 'string' && item.error.trim()) {
        item.status = 'paused'; item.phase = 'paused';
        if (item.controlDisposition === 'completed') delete item.controlDisposition;
      }
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
