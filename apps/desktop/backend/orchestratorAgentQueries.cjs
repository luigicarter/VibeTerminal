'use strict';
const { randomBytes, createHmac, timingSafeEqual, createHash } = require('node:crypto');
const { VERSION, LIMITS, sections, text } = require('../shared/orchestratorAgentContract.cjs');
const clone = value => structuredClone(value);
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cwdKey = value => value ? JSON.parse(require('./orchestratorRouting.cjs').nativeKey({ provider: '_', home: '_', workspace: String(value), id: '_' }))[2] : '';

function agentIndex(record) {
  return { agentId: record.agentId, surfaceId: record.identity.surfaceId, name: text(record.identity.name, 120), kind: record.identity.kind,
    projectId: record.identity.projectId, projectName: text(record.identity.projectName, 80),
    state: record.identity.state, activity: record.activity.status, needsInput: record.attention.required,
    childWork: record.activity.childWork === true, workItemIds: record.work.items.map(w => w.id).slice(0, 8),
    workCoverage: record.work.items.length > 8 ? 'read-agent-for-more' : 'complete', revision: record.revision };
}

// Queries read only selected metadata. Native output/history remains in its
// existing reader; these methods cannot submit prompts or select task owners.
function createAgentQueries({ directory, store, workItems } = {}) {
  const secret = randomBytes(32);
  const sign = payload => createHmac('sha256', secret).update(payload).digest();
  function encode(value) { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${body}.${sign(body).toString('base64url')}`; }
  function decode(cursor) {
    if (typeof cursor !== 'string' || cursor.length > 4096) throw new Error('Invalid agent cursor. Restart this read.');
    const [body, signature, extra] = cursor.split('.');
    const expected = sign(body || ''), actual = Buffer.from(signature || '', 'base64url');
    if (extra || actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new Error('Invalid agent cursor. Restart this read.');
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  }
  function find(input = {}) {
    const query = { query: text(input.query, 500) || '', cwd: cwdKey(input.cwd), provider: input.provider || '',
      state: input.state || '', workItemId: input.workItemId || '', archived: input.includeArchived === true };
    const source = query.archived ? directory.all() : directory.list();
    const selected = source.filter(r => (!query.cwd || cwdKey(r.identity.cwd) === query.cwd) && (!query.provider ||
      [r.identity.kind, r.identity.native?.provider, ...r.identity.participants?.map(p => p.provider) || []].includes(query.provider)) &&
      (!query.state || r.activity.status === query.state || r.identity.state === query.state || query.state === 'needs-input' && r.attention.required) &&
      (!query.workItemId || r.work.items.some(w => w.id === query.workItemId)) && (!query.query ||
        [r.identity.name, r.identity.projectName, ...r.work.items.map(w => w.title)].filter(Boolean).join('\n').toLowerCase().includes(query.query.toLowerCase())))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
    const signature = digest([query, selected.map(r => r.agentId)]);
    const cursor = input.cursor ? decode(input.cursor) : null;
    if (cursor && (cursor.kind !== 'agents' || cursor.signature !== signature)) return { ok: false, status: 'invalid-cursor', error: 'Agent membership or query changed; restart this directory read.' };
    const offset = cursor?.offset || 0, limit = Math.max(1, Math.min(LIMITS.pageEntries, Number(input.limit) || LIMITS.pageEntries));
    const page = [];
    for (const r of selected.slice(offset, offset + limit)) {
      const index = agentIndex(r);
      if (bytes(page.concat(index)) > LIMITS.pageBytes - 700) break;
      page.push(index);
    }
    if (!page.length && offset < selected.length) return { ok: false, status: 'record-too-large', error: 'Agent identity metadata exceeded its directory budget. Read the selected agent directly.' };
    return { ok: true, version: VERSION, agents: page, total: selected.length, truncated: offset + page.length < selected.length,
      nextCursor: offset + page.length < selected.length ? encode({ kind: 'agents', signature, offset: offset + page.length }) : null };
  }
  function read(input) {
    const record = directory.get(input.agentId);
    if (!record) return { ok: false, status: 'unknown-agent', error: 'Find the agent before reading its record.' };
    const selected = sections(input.sections), noteRevision = store?.noteVersion?.(input.agentId) || 0;
    const signature = digest([input.agentId, selected, record.revision, selected.includes('notes') ? noteRevision : 0]);
    const cursor = input.cursor ? decode(input.cursor) : null;
    if (cursor && (cursor.kind !== 'agent' || cursor.signature !== signature)) return { ok: false, status: 'invalid-cursor', error: 'The agent record changed; restart this section read.' };
    const offset = cursor?.offset || 0, size = Math.max(1, Math.min(20, Number(input.limit) || 20));
    const result = { ok: true, version: VERSION, id: input.agentId, agentId: input.agentId, revision: record.revision,
      sourceVersion: signature, range: { offset, limit: size }, source: 'agent-record',
      readSource: { agentId: record.agentId, ...(record.identity.run && { targetId: record.identity.run.id, generation: record.identity.run.generation }), native: record.identity.native },
      sections: {}, coverage: {}, nextCursor: null };
    let more = false;
    for (const section of selected) {
      const value = section === 'notes' ? store?.list({ agentId: record.agentId, offset, limit: size }) || { notes: [], total: 0, nextOffset: null } : clone(record[section]);
      if (section === 'notes') {
        more ||= value.nextOffset !== null;
        result.sections.notes = { ...value, notes: value.notes.map(({ body, ...note }) => ({ ...note, text: body })) }; continue;
      }
      if (!value) { result.sections[section] = { status: 'unavailable' }; continue; }
      for (const [key, items] of Object.entries(value)) if (Array.isArray(items)) {
        result.coverage[`${section}.${key}`] = { total: items.length, offset, returned: Math.min(size, Math.max(0, items.length - offset)) };
        value[key] = items.slice(offset, offset + size); more ||= offset + size < items.length;
      }
      result.sections[section] = value;
    }
    if (more) result.nextCursor = encode({ kind: 'agent', signature, offset: offset + size });
    result.truncated = more;
    return result;
  }
  return { find, read,
    readWork(input) {
      const item = workItems?.get(input.workItemId);
      if (!item) return { ok: false, status: 'unknown-work-item' };
      const content = ['Objective:', item.objective || item.text || '', ...(item.summary ? ['Summary:', item.summary] : [])].join('\n');
      const signature = digest([item.id, item.updatedAt, content]), cursor = input.cursor ? decode(input.cursor) : null;
      if (cursor && (cursor.kind !== 'work' || cursor.workItemId !== item.id || cursor.signature !== signature)) return { ok: false, status: 'invalid-cursor' };
      const offset = cursor?.offset || 0;
      const page = require('./orchestratorBudget.cjs').boundedString(content.slice(offset), Math.max(128, Math.min(4000, Number(input.maxChars) || 4000)) - 64);
      const end = offset + page.length;
      return { ok: true, id: item.id, sourceVersion: signature, range: { start: offset, end },
        workItem: { id: item.id, title: item.title, status: item.status, cwd: item.cwd, binding: item.binding, requiresRevalidation: item.requiresRevalidation },
        text: page, complete: end >= content.length, authority: 'historical-reference-only',
        nextCursor: end < content.length ? encode({ kind: 'work', workItemId: item.id, signature, offset: end }) : null,
        readSource: { workItemId: item.id, sourceVersion: signature } };
    } };
}
module.exports = { createAgentQueries, agentIndex };
