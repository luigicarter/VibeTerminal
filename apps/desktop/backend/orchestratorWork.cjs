'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const MAX_RECORDS = 2000;
const MAX_AGE = 90 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 6 * 1024 * 1024;
const STATUSES = new Set(['completed', 'failed', 'interrupted']);
const COVERAGE = 'Observed agent turn endings, including work started directly in terminals. Completion means the agent turn ended, not independently verified changes. Plain shells, idle states, and unobserved work are not completion evidence. History retains up to 2,000 records for 90 days.';
const projectKey = cwd => String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const keyFor = session => createHash('sha256').update(JSON.stringify([String(session.id), String(session.generation), String(session.turnId)])).digest('hex');
const eligible = session => Boolean(session?.id && session.generation != null && String(session.generation) && !String(session.generation).startsWith('paused:') && session.turnId
  && !['terminal', 'shell'].includes(session.kind) && !['terminal', 'shell'].includes(session.provider) && session.observation === 'observed'
  && STATUSES.has(session.turnState) && !session.pendingInput && !session.childActivity
  && Number.isFinite(session.turnStartedAt) && Number.isFinite(session.turnEndedAt) && session.turnEndedAt >= session.turnStartedAt);

// Historical observations only: these records never release task dependencies or
// grant authority to act. Keep them after a live terminal disappears.
function createWorkHistory({ userDataPath, getSecrets = () => [], now = Date.now } = {}) {
  const file = path.join(userDataPath, 'orchestrator-work.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const records = new Map();
  let chain = Promise.resolve(), committed = '', pending = '';
  const clean = (value, limit = 500) => {
    const secrets = getSecrets();
    if (!Array.isArray(secrets)) throw new Error('Secret redaction is unavailable.');
    return secrets.filter(secret => typeof secret === 'string' && secret).reduce((text, secret) => text.split(secret).join('[redacted]'), String(value ?? ''))
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
      .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})/gi, '[redacted]').trim().slice(0, limit);
  };
  function prune() {
    const cutoff = now() - MAX_AGE;
    for (const [id, record] of records) if (record.completedAt < cutoff || record.completedAt > now() + 60000) records.delete(id);
    const ordered = [...records.values()].sort((a, b) => b.completedAt - a.completedAt);
    // Count the actual persisted envelope and each escaped UTF-8 record once.
    // Keep a newest-first prefix; oversized history must remain readable after
    // restart under the same byte limit used by load().
    let bytes = Buffer.byteLength(JSON.stringify({ version: 1, records: [] }));
    for (let index = 0; index < ordered.length; index++) {
      const record = ordered[index];
      bytes += Buffer.byteLength(JSON.stringify(record)) + (index ? 1 : 0);
      if (index >= MAX_RECORDS || bytes > MAX_BYTES) records.delete(record.id);
    }
  }
  function snapshot() { prune(); return structuredClone([...records.values()].sort((a, b) => b.completedAt - a.completedAt || a.id.localeCompare(b.id))); }
  function save() {
    const data = JSON.stringify({ version: 1, records: snapshot() });
    if (data === committed || data === pending) return chain;
    pending = data;
    chain = chain.then(async () => {
      await fs.promises.mkdir(userDataPath, { recursive: true });
      await fs.promises.writeFile(temporary, data, { mode: 0o600 });
      await fs.promises.rename(temporary, file);
      committed = data;
    }).catch(() => {}).finally(() => { if (pending === data) pending = ''; });
    return chain;
  }
  try {
    if (fs.statSync(file).size <= MAX_BYTES) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const old of Array.isArray(saved.records) ? saved.records.slice(-MAX_RECORDS) : []) {
        if (!old || !STATUSES.has(old.status) || !['terminal-screen', 'chat-events', 'status'].includes(old.summarySource)
          || !Number.isFinite(old.startedAt) || !Number.isFinite(old.completedAt) || !Number.isFinite(old.observedAt) || old.completedAt < old.startedAt
          || !['id', 'terminalId', 'generation', 'turnId', 'cwd', 'title'].every(key => typeof old[key] === 'string' && old[key])) continue;
        const record = {};
        for (const key of ['id', 'terminalId', 'generation', 'turnId', 'cwd', 'projectName', 'provider', 'terminalName', 'title', 'status', 'summarySource', 'coverage']) record[key] = clean(old[key], key === 'cwd' ? 32768 : 500);
        record.summary = clean(old.summary, 1500);
        for (const key of ['startedAt', 'completedAt', 'observedAt']) record[key] = old[key];
        records.set(record.id, record);
      }
    }
  } catch { /* A malformed/unavailable history never blocks the workspace. */ }
  prune();
  function observe(sessions) {
    let changed = false;
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!eligible(session) || session.turnEndedAt < now() - MAX_AGE || session.turnEndedAt > now() + 60000) continue;
      const id = keyFor(session);
      const previous = records.get(id);
      if (previous && (session.turnEndedAt < previous.completedAt || session.turnEndedAt === previous.completedAt && session.turnState === previous.status)) continue;
      try {
        records.set(id, { id, terminalId: clean(session.id), generation: clean(session.generation), turnId: clean(session.turnId),
          cwd: clean(session.cwd, 32768), projectName: clean(session.projectName || path.win32.basename(session.cwd || '') || 'Project'),
          provider: clean(session.openFusion ? 'openfusion' : session.fusion ? 'fusion' : session.kind || session.provider || 'agent'),
          terminalName: clean(session.name || session.kind || session.provider || 'Agent'),
          title: clean(session.conversationTitle || session.conversation?.title || session.name || session.terminalTitle || 'Agent work'),
          status: session.turnState, startedAt: session.turnStartedAt, completedAt: session.turnEndedAt, observedAt: now(),
          summary: `Agent turn ${session.turnState}; no result excerpt captured.`, summarySource: 'status', coverage: 'Observed agent turn status; task outcome not independently verified.' });
        changed = true;
      } catch { /* Fail closed if configured secret redaction is unavailable. */ }
    }
    if (changed) save();
    return changed;
  }
  function enrich(session, result) {
    if (!eligible(session)) return false;
    observe([session]);
    const record = records.get(keyFor(session));
    if (!record || !result || !['terminal-screen', 'chat-events'].includes(result.source) || String(result.turnId) !== record.turnId || result.status !== record.status || result.at !== record.completedAt || typeof result.text !== 'string' || !result.text.trim()) return false;
    try {
      // Prefer the final part of the immutable completion excerpt, not a live
      // screen read from a newer turn. Label it as evidence, never a verified summary.
      const summary = clean(result.text, 16000).slice(-1500).trim();
      const summarySource = result.source === 'terminal-screen' ? 'terminal-screen' : 'chat-events';
      if (!summary || record.summary === summary && record.summarySource === summarySource) return false;
      Object.assign(record, { summary, summarySource, coverage: clean(result.coverage || 'Agent output at the observed turn end; claims have not been independently verified.') });
      save(); return true;
    } catch { return false; }
  }
  function list(options = {}) {
    const query = String(options.query || '').trim().toLowerCase();
    const selected = snapshot().filter(record => (!options.cwd || projectKey(record.cwd) === projectKey(options.cwd))
      && (!query || [record.title, record.terminalName, record.projectName, record.cwd, record.provider, record.summary, record.status].some(value => value.toLowerCase().includes(query))));
    const offset = Math.max(0, Math.min(MAX_RECORDS, Math.floor(Number(options.offset) || 0)));
    const limit = Math.max(1, Math.min(200, Math.floor(Number(options.limit) || 10)));
    const page = [];
    let bytes = 1000;
    for (const record of selected.slice(offset, offset + limit)) {
      const item = { ...record, summary: record.summary.slice(-500), title: record.title.slice(0, 300),
        cwd: record.cwd.slice(0, 1000), ...(record.cwd.length > 1000 && { cwdTruncated: true }),
        ...(record.summary.length > 500 && { summaryTruncated: true }) };
      const size = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (page.length && bytes + size > 18000) break;
      page.push(item); bytes += size;
    }
    return { ok: true, records: page, total: selected.length, offset,
      nextOffset: offset + page.length < selected.length ? offset + page.length : null, coverage: COVERAGE };
  }
  return { observe, enrich, snapshot, list, flush: () => chain };
}
module.exports = { createWorkHistory, eligible, projectKey, MAX_RECORDS, MAX_AGE, MAX_BYTES, COVERAGE };
