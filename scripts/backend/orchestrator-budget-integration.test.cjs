'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { modelInputBudget } = require('../../backend/orchestratorBudget.cjs');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const reply = text => json({ choices: [{ message: { content: text } }] });
const calls = actions => json({ choices: [{ message: { tool_calls: actions.map((action, index) => ({ id: `call${index}`, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(action) } })) } }] });
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-budget-integration-'));
  const bodies = [], events = [], source = { id: 's', sequence: 10, text: 'RECENT ' + 'x'.repeat(5000), history: ['OLD_PRIVATE_HISTORY'], raw: 'RAW_PRIVATE_SOURCE' };
  let clock = 1, handler = () => reply('Ready');
  const contextLength = options.contextLength || 16384;
  const instance = createOrchestrator({ userDataPath: dir, now: () => clock, onUpstreamError: e => events.push(e), getSessions: async () => [{ id: 's', generation: 1, name: 'Worker', status: 'running' }], readSession: async () => structuredClone(source), dispatchAction: options.dispatchAction, fetch: async (url, request) => {
    if (url.endsWith('/key')) return json({ data: {} });
    if (url.includes('/models')) return json({ data: [{ id: 'brain', context_length: contextLength, supported_parameters: ['tools'] }] });
    const body = JSON.parse(request.body); bodies.push(body);
    assert.ok(Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools || [] })) <= modelInputBudget(contextLength, body.max_tokens));
    return handler(body);
  } });
  t.after(() => { instance.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { instance, bodies, events, source, handle(fn) { handler = fn; }, advance() { clock += 120000; }, async ready() { await instance.configure({ apiKey: 'test', sessionOnly: true, model: 'brain' }); assert.equal((await instance.setEnabled(true)).ok, true); } };
}
test('real model requests stay bounded, preserve instruction, strip history without changing source', async t => {
  const f = fixture(t); await f.ready(); let round = 0;
  f.handle(() => ++round === 1 ? calls([{ kind: 'read_session', targetId: 's' }]) : reply('Read the recent excerpt'));
  const instruction = 'Read Worker exactly as asked: ' + 'qualifier '.repeat(250);
  assert.equal((await f.instance.send({ text: instruction, origin: 'text' })).ok, true);
  for (const body of f.bodies) assert.equal(JSON.parse(body.messages.find(m => m.role === 'user').content).instruction, instruction);
  assert.ok(!JSON.stringify(f.bodies).includes('OLD_PRIVATE_HISTORY')); assert.ok(!JSON.stringify(f.bodies).includes('RAW_PRIVATE_SOURCE'));
  assert.equal(f.source.history[0], 'OLD_PRIVATE_HISTORY');
  const direct = await f.instance.dispatch({ kind: 'read_session', targetId: 's' });
  assert.equal(direct.observation.history[0], 'OLD_PRIVATE_HISTORY');
});
test('source budgets reset each round and cursor bookmarks continue across user requests', async t => {
  const visited = [];
  const f = fixture(t, { contextLength: 65536, dispatchAction: async action => {
    const page = Number(action.cursor || 0); visited.push(page);
    return { ok: true, text: `PAGE${page} ` + 'x'.repeat(2600), nextCursor: String(page + 1), hasMore: true, range: { start: page, end: page + 1 }, coverage: { complete: false } };
  } }); await f.ready();
  for (let batch = 0; batch < 2; batch++) {
    let round = 0;
    f.handle(body => {
      if (round++ === 0 && batch === 1) assert.equal(JSON.parse(body.messages.find(m => m.role === 'user').content).readBookmarks[0].cursor, '12');
      if (round > 4) return reply('Continue when requested');
      return calls(Array.from({ length: 3 }, (_, i) => ({ kind: 'read_conversation', reference: 'ref', cursor: String(batch * 12 + (round - 1) * 3 + i) })));
    });
    assert.equal((await f.instance.send({ text: 'Continue reading the source', origin: 'text' })).ok, true);
  }
  assert.deepEqual(visited, Array.from({ length: 24 }, (_, i) => i));
  for (let page = 0; page < 24; page++) assert.ok(f.bodies.some(body => body.messages.some(m => m.role === 'tool' && m.content.includes(`PAGE${page} `))));
});
test('local context refusal never reports an upstream credit failure', async t => {
  const f = fixture(t, { contextLength: 4096 }); await f.ready();
  const result = await f.instance.send({ text: 'Read Worker', origin: 'voice' });
  assert.equal(result.ok, false); assert.match(result.error, /Local context limit/); assert.equal(f.events.length, 0); assert.equal(f.bodies.length, 0);
});
test('billing monitor pause survives unsuccessful retry and resumes after manual success', async t => {
  const f = fixture(t); await f.ready();
  f.handle(() => json({ error: { code: 402 } }, 402)); await f.instance.refresh({ monitor: true });
  assert.equal(f.instance.getState().monitoringPaused, true); f.advance(); await f.instance.refresh({ monitor: true }); assert.equal(f.bodies.length, 1);
  f.handle(() => json({ error: { code: 503 } }, 503)); await f.instance.send({ text: 'Retry', origin: 'text' });
  assert.equal(f.instance.getState().monitoringPaused, true); f.advance(); await f.instance.refresh({ monitor: true }); assert.equal(f.bodies.length, 2);
  f.handle(() => reply('Success')); assert.equal((await f.instance.send({ text: 'Retry', origin: 'text' })).ok, true);
  assert.equal(f.instance.getState().monitoringPaused, false); await f.instance.refresh({ monitor: true }); assert.equal(f.bodies.length, 4);
});
test('a source page rejected before model delivery does not advance the cross-request bookmark', async t => {
  let reads = 0;
  const f = fixture(t, { dispatchAction: async () => { reads++; return { ok: true, text: 'PAGE_CONTENT ' + 'x'.repeat(3000), nextCursor: 'unseen-next', hasMore: true }; } });
  await f.ready();
  f.handle(() => calls([{ kind: 'read_conversation', reference: 'ref' }]));
  const result = await f.instance.send({ text: 'Read source. ' + 'x'.repeat(7000), origin: 'text' });
  assert.equal(reads, 1); assert.match(result.error, /Local context limit/);
  let nextBookmarks;
  f.handle(body => {
    nextBookmarks = JSON.parse(body.messages.find(m => m.role === 'user').content).readBookmarks;
    return reply('Ready to retry the same page');
  });
  assert.equal((await f.instance.send({ text: 'Retry with a smaller page', origin: 'text' })).ok, true);
  assert.ok(!nextBookmarks.some(bookmark => bookmark.cursor === 'unseen-next'));
});
