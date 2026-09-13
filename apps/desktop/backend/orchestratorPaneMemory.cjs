'use strict';

// Tier 2 of the brain's memory: what Lina knows about each pane it has used -
// the objective it gave that agent, the pane's title, the last prompt it typed
// there, and the last result summary it already produced. The roster the brain
// reads is this record plus live session identity, never screen text: a fresh
// result summary answers "what's the result?" without another terminal read.
const PANE_MEMORY_LIMITS = Object.freeze({ entries: 500, bytes: 1024 * 1024 });
const FIELD_CAPS = Object.freeze({ objective: 300, title: 120, lastPromptText: 200, lastResultSummary: 400, status: 40 });
const TIME_FIELDS = Object.freeze(['lastPromptAt', 'lastResultAt', 'updatedAt']);
// The brain-facing parts: what "clear history" removes while pane ownership and
// the objective that owns the work stay intact.
const TRANSIENT_FIELDS = Object.freeze(['lastPromptAt', 'lastPromptText', 'lastResultSummary', 'lastResultAt']);
const AGENT_ID = /^[\w.:@+-]{1,256}$/;

const bytes = value => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
const sameFolder = (left, right) => {
  const identity = value => String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return typeof left === 'string' && typeof right === 'string' && Boolean(left) && identity(left) === identity(right);
};

function sanitizePaneRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = {};
  for (const [field, cap] of Object.entries(FIELD_CAPS)) {
    if (typeof value[field] !== 'string') continue;
    const trimmed = value[field].trim();
    if (trimmed) record[field] = trimmed.slice(0, cap);
  }
  for (const field of TIME_FIELDS) {
    const time = Number(value[field]);
    if (Number.isFinite(time) && time > 0) record[field] = time;
  }
  if (!Number.isFinite(record.updatedAt)) return null;
  // A record with nothing but its own timestamp carries no memory.
  return Object.keys(record).length > 1 ? record : null;
}

// Invalid rows are dropped one at a time. A malformed pane record must never
// make the whole agent store unreadable and lock out identity persistence.
function sanitizePaneMemory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  let count = 0;
  for (const [agentId, entry] of Object.entries(value)) {
    if (count >= PANE_MEMORY_LIMITS.entries) break;
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) continue;
    const record = sanitizePaneRecord(entry);
    if (!record) continue;
    result[agentId] = record;
    count++;
  }
  if (bytes(result) <= PANE_MEMORY_LIMITS.bytes) return result;
  // Oldest first: the panes Lina touched most recently are the ones a follow-up
  // is about.
  const ordered = Object.entries(result).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  while (ordered.length && bytes(Object.fromEntries(ordered)) > PANE_MEMORY_LIMITS.bytes) ordered.shift();
  return Object.fromEntries(ordered);
}

function validPaneMemory(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > PANE_MEMORY_LIMITS.entries || bytes(value) > PANE_MEMORY_LIMITS.bytes) return false;
  const allowed = new Set([...Object.keys(FIELD_CAPS), ...TIME_FIELDS]);
  return keys.every(agentId => AGENT_ID.test(agentId) && (() => {
    const record = value[agentId];
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    const fields = Object.keys(record);
    return fields.length > 1 && fields.every(field => allowed.has(field)) && Number.isFinite(record.updatedAt) &&
      Object.entries(FIELD_CAPS).every(([field, cap]) => record[field] === undefined || typeof record[field] === 'string' && record[field].length <= cap) &&
      TIME_FIELDS.every(field => record[field] === undefined || Number.isFinite(record[field]) && record[field] > 0);
  })());
}

const needsInputNow = session => Boolean(session.pendingInput || session.pendingInteraction || session.manualInputPending ||
  session.interactionInputPending || session.status === 'waiting' || ['question', 'approval'].includes(session.attention?.reason));
const recencyOf = session => Math.max(Number(session?.lastActivityAt) || 0, Number(session?.turnEndedAt) || 0, Number(session?.turnStartedAt) || 0);

// One state per pane. status, turnState and readiness are three vocabularies for
// the same fact, and a single row could say "running", "idle" and "ready" at
// once. A plan only ever needs to know whether the pane is free, working,
// waiting on the user, still starting, or gone - so that is what it is told.
const PANE_STATES = Object.freeze(['free', 'working', 'needs-input', 'starting', 'stopped']);
const STOPPED_STATUS = new Set(['closed', 'exited', 'paused']);
function paneState(session) {
  if (!session || typeof session !== 'object') return 'stopped';
  if (STOPPED_STATUS.has(session.status) || session.started === false ||
    ['exited', 'failed'].includes(session.processState) || ['exited', 'failed'].includes(session.agentProcessState)) return 'stopped';
  if (needsInputNow(session)) return 'needs-input';
  if (['running', 'busy'].includes(session.turnState) || session.childActivity) return 'working';
  if (session.turnState === 'starting' || session.status === 'starting' ||
    session.launchState === 'pending' || session.readiness === 'starting') return 'starting';
  if (['running', 'busy'].includes(session.status) && !session.turnState) return 'working';
  return 'free';
}

// store: the agent store (paneMemory/savePaneMemory). resolveAgentId maps a live
// pane to its durable agent identity; a pane with no identity (a plain shell)
// simply has no memory and still appears in the roster from live fields.
// onRecord receives every accepted change so the durable memory store can keep
// its own pane fact beside this one, addressed by live pane rather than identity.
function createPaneMemory({ store, now = Date.now, resolveAgentId = () => null, onError = () => {}, onRecord = () => {} } = {}) {
  let records = sanitizePaneMemory(store?.paneMemory?.());
  let writing = false, dirty = false;
  function persist() {
    if (!store?.savePaneMemory || writing) { dirty = writing; return; }
    writing = true; dirty = false;
    Promise.resolve(store.savePaneMemory(records))
      .catch(error => onError(error))
      .finally(() => { writing = false; if (dirty) { dirty = false; persist(); } });
  }
  function apply(agentId, patch, sessionId) {
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId) || !patch || typeof patch !== 'object') return null;
    const previous = records[agentId];
    const merged = sanitizePaneRecord({ ...previous, ...patch, updatedAt: now() });
    if (!merged) return null;
    // Only a real change earns a write; a repeated observation must not churn
    // the store on every reconcile just because the clock moved.
    if (previous && JSON.stringify({ ...previous, updatedAt: 0 }) === JSON.stringify({ ...merged, updatedAt: 0 })) return { ...previous };
    records = sanitizePaneMemory({ ...records, [agentId]: merged });
    persist();
    const current = records[agentId] ? { ...records[agentId] } : null;
    if (current) { try { onRecord({ agentId, sessionId, record: current }); } catch (error) { onError(error); } }
    return current;
  }
  return {
    get(agentId) { const record = records[agentId]; return record ? { ...record } : null; },
    snapshot() { return structuredClone(records); },
    remember(agentId, patch) { return apply(agentId, patch); },
    // The same update addressed by live pane instead of durable identity.
    rememberPane(sessionId, patch) {
      const agentId = resolveAgentId(sessionId);
      return agentId ? apply(agentId, patch, sessionId) : null;
    },
    // Clear history keeps what a pane is for and drops what Lina said and heard.
    clearTransient() {
      let changed = false;
      const next = {};
      for (const [agentId, record] of Object.entries(records)) {
        const kept = { ...record };
        for (const field of TRANSIENT_FIELDS) if (kept[field] !== undefined) { delete kept[field]; changed = true; }
        const sanitized = sanitizePaneRecord({ ...kept, updatedAt: record.updatedAt });
        if (sanitized) next[agentId] = sanitized;
        else changed = true;
      }
      if (!changed) return false;
      records = next;
      persist();
      return true;
    },
    roster({ cwd, sessions = [], limit = 24 } = {}) {
      const live = sessions.filter(session => session && typeof session.id === 'string' &&
        !['closed', 'exited'].includes(session.status) && session.processState !== 'exited' &&
        (!cwd || sameFolder(session.cwd, cwd)));
      return live.slice().sort((a, b) => recencyOf(b) - recencyOf(a)).slice(0, Math.max(0, limit)).map(session => {
        const record = records[resolveAgentId(session.id)] || {};
        const row = { id: session.id, name: session.name, title: record.title || session.conversationTitle,
          provider: session.kind || session.provider, state: paneState(session),
          objective: record.objective, lastPromptAt: record.lastPromptAt,
          lastResultSummary: record.lastResultSummary ? record.lastResultSummary.slice(0, 200) : undefined };
        for (const key of Object.keys(row)) if (row[key] === undefined || row[key] === null || row[key] === '') delete row[key];
        return row;
      });
    },
  };
}

// Roster rows are ordered newest-first, so the budget drops the least recent.
function boundedRoster(rows, { maxBytes = 4096 } = {}) {
  let result = Array.isArray(rows) ? rows.slice() : [];
  while (result.length > 1 && bytes(result) > maxBytes) result.pop();
  return result;
}

module.exports = { createPaneMemory, sanitizePaneMemory, sanitizePaneRecord, validPaneMemory, boundedRoster, paneState,
  PANE_MEMORY_LIMITS, PANE_STATES, TRANSIENT_FIELDS };
