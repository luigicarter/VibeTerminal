'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createAgentDirectory } = require('../../backend/orchestratorAgents.cjs');
const { createAgentQueries } = require('../../backend/orchestratorAgentQueries.cjs');
const { buildAgentContext } = require('../../backend/orchestratorAgentContext.cjs');
const { LIMITS } = require('../../shared/orchestratorAgentContract.cjs');
const { agent } = require('./orchestrator-agent-fixtures.cjs');
function fixture(count = 1) {
  let sequence = 0;
  const directory = createAgentDirectory({ makeId: () => `agent-${String(++sequence).padStart(4, '0')}` });
  const sessions = Array.from({ length: count }, (_, i) => agent(`worker-${i}`));
  const queries = createAgentQueries({ directory }); directory.reconcile(sessions);
  return { directory, sessions, queries };
}

test('directory pages cover all 200 agents within byte/count budgets without reading source bodies', () => {
  const f = fixture(200), ids = []; let cursor;
  for (const s of f.sessions) Object.defineProperty(s, 'transcript', { get() { assert.fail('No transcript reads'); } });
  do {
    const page = f.queries.find({ cursor }); assert.equal(page.ok, true);
    assert(page.agents.length <= LIMITS.pageEntries); assert(Buffer.byteLength(JSON.stringify(page)) <= LIMITS.pageBytes);
    ids.push(...page.agents.map(a => a.agentId)); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 200); assert.equal(new Set(ids).size, 200);
});

test('metadata changes preserve membership cursors and filter membership changes invalidate them', () => {
  const f = fixture(25), page = f.queries.find();
  f.sessions[0].name = 'Renamed'; f.directory.reconcile(f.sessions);
  assert.equal(f.queries.find({ cursor: page.nextCursor }).ok, true);
  const filtered = f.queries.find({ state: 'idle', limit: 2 });
  f.sessions[0].status = 'running'; f.directory.reconcile(f.sessions);
  assert.equal(f.queries.find({ state: 'idle', cursor: filtered.nextCursor }).status, 'invalid-cursor');
  assert.throws(() => f.queries.find({ cursor: 'invented' }), /Invalid agent cursor/);
});

test('section paging does not silently omit children or let old cursors read replacement state', () => {
  const f = fixture(); f.sessions[0].children = Array.from({length: 35}, (_, i) => ({id: `child-${i}`}));
  f.directory.reconcile(f.sessions); const agentId = f.directory.forSurface(f.sessions[0].id).agentId;
  const first = f.queries.read({ agentId, sections: ['activity'] });
  assert.equal(first.sections.identity, undefined); assert.equal(first.sections.activity.children.length, 20);
  assert.equal(first.coverage['activity.children'].total, 35);
  const second = f.queries.read({ agentId, sections: ['activity'], cursor: first.nextCursor });
  assert.equal(second.sections.activity.children.length, 15);
  f.sessions[0].turnState = 'running'; f.directory.reconcile(f.sessions);
  assert.equal(f.queries.read({ agentId, sections: ['activity'], cursor: first.nextCursor }).status, 'invalid-cursor');
});

test('bootstrap context remains bounded and a project alone does not select an unrelated agent', () => {
  const measurements = [];
  for (const count of [1, 20, 200]) {
    const f = fixture(count);
    const unaddressed = buildAgentContext({ records: f.directory.list() });
    assert.deepEqual(unaddressed.agents, []); assert.equal(unaddressed.agentDirectory.total, count);
    const selected = buildAgentContext({ records: f.directory.list(), targetId: 'worker-0' });
    assert.equal(selected.agents.length, 1); assert.equal(selected.agents[0].surfaceId, 'worker-0');
    measurements.push(Buffer.byteLength(JSON.stringify(selected)));
  }
  assert(Math.max(...measurements) - Math.min(...measurements) < 20);
});

test('large relevant groups keep complete coverage metadata rather than pretending the index is the whole selection', () => {
  const f = fixture(200), targets = f.sessions.map(s => ({id:s.id}));
  const context = buildAgentContext({ records: f.directory.list(), targets });
  assert.equal(context.agentDirectory.relevant, 200); assert.equal(context.agentDirectory.truncated, true);
  assert(context.agents.length <= LIMITS.bootstrapEntries); assert.equal(targets.length, 200);
});

test('archived agents retain history while losing live run and eligibility', () => {
  const f = fixture(), old = f.directory.list()[0]; f.directory.reconcile([]);
  assert.equal(f.queries.find().total, 0);
  assert.equal(f.queries.find({ includeArchived: true }).agents[0].state, 'archived');
  assert.equal(f.directory.resolve(old.agentId), null);
  assert.deepEqual(f.queries.read({ agentId: old.agentId, sections: ['capabilities'] }).sections.capabilities.operations, {});
});

test('clearing archived records frees capacity without changing current agent identity', () => {
  const f = fixture(2), [closed, current] = f.directory.list();
  f.directory.reconcile([f.sessions[1]]);
  f.directory.forgetArchived();
  assert.equal(f.directory.get(closed.agentId), undefined);
  assert.equal(f.directory.forSurface('worker-1').agentId, current.agentId);
  assert.equal(f.directory.all().length, 1);
});
