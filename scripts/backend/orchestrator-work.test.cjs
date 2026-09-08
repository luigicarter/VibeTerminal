'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkHistory, MAX_AGE, MAX_BYTES } = require('../../backend/orchestratorWork.cjs');

const clock = 1788796800000;
const session = (patch = {}) => ({ id: 'api', generation: 'g1', turnId: 'turn1', kind: 'codex', provider: 'codex',
  cwd: 'C:\\Projects\\API', projectName: 'API', name: 'Fix routes', observation: 'observed', turnState: 'completed',
  turnStartedAt: clock - 10000, turnEndedAt: clock - 1000, ...patch });
const result = (patch = {}) => ({ turnId: 'turn1', status: 'completed', at: clock - 1000, text: 'Updated route validation. Unit tests passed.', source: 'terminal-screen', ...patch });
function fixture(t, extra = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-work-'));
  const store = createWorkHistory({ userDataPath, now: () => clock, ...extra }), disposers = [];
  t.after(async () => {
    for (const dispose of disposers) await dispose();
    await store.flush();
    assert.equal(path.dirname(path.resolve(userDataPath)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(userDataPath).startsWith('vibe-work-'));
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });
  return { userDataPath, store, disposeAfter: fn => disposers.push(fn) };
}

test('records observed agent endings, never idle, provisional, written or shell activity', async t => {
  const { store } = fixture(t);
  for (const patch of [ { turnState: 'idle' }, { turnState: 'written' }, { turnState: 'response' }, { observation: 'provisional' },
    { observation: 'unavailable' }, { pendingInput: 'submit' }, { childActivity: true }, { turnId: undefined }, { turnEndedAt: undefined },
    { generation: 'paused:api' }, { kind: 'terminal' }, { kind: 'shell' }, { provider: 'terminal' }, { provider: 'shell' } ]) {
    assert.equal(store.observe([session(patch)]), false, JSON.stringify(patch));
  }
  assert.equal(store.snapshot().length, 0);
  assert.equal(store.observe([session()]), true);
  assert.equal(store.observe([session()]), false);
  assert.equal(store.snapshot()[0].summarySource, 'status');
  assert.match(store.snapshot()[0].summary, /no result excerpt/);
  store.observe([session({ id: 'failed', turnState: 'failed' }), session({ id: 'stopped', turnState: 'interrupted' })]);
  assert.deepEqual(new Set(store.snapshot().map(record => record.status)), new Set(['completed', 'failed', 'interrupted']));
  await store.flush();
});

test('immutable result identity and source must match, and excerpts remain evidence', async t => {
  const { store } = fixture(t);
  store.observe([session()]);
  for (const patch of [{ turnId: 'new-turn' }, { status: 'failed' }, { at: clock }, { source: 'live-screen' }, { source: undefined }]) {
    assert.equal(store.enrich(session(), result(patch)), false);
  }
  assert.equal(store.enrich(session({ turnState: 'idle' }), result()), false);
  assert.equal(store.enrich(session(), result()), true);
  assert.equal(store.snapshot()[0].summary, result().text);
  assert.equal(store.enrich(session(), result()), false);
  assert.match(store.snapshot()[0].coverage, /not.*verified/);
  // A newer authoritative correction replaces the old status and its excerpt.
  store.observe([session({ turnState: 'failed', turnEndedAt: clock })]);
  assert.equal(store.snapshot()[0].status, 'failed');
  assert.equal(store.snapshot()[0].summarySource, 'status');
  assert.equal(store.observe([session()]), false);
  await store.flush();
});

test('closure and restart retain direct terminal work with project filtering and redaction', async t => {
  const secret = 'private-real-key';
  const { store, userDataPath } = fixture(t, { getSecrets: () => [secret] });
  store.observe([session({ name: `Fix routes ${secret}` }), session({ id: 'ui', cwd: 'C:\\Projects\\UI', projectName: 'UI', generation: 4 })]);
  store.enrich(session(), result({ text: `Fixed routes ${secret} sk-abcdefghijklmnop` }));
  store.observe([]); // Closing panes does not erase records.
  await store.flush();
  assert.ok(!fs.readFileSync(path.join(userDataPath, 'orchestrator-work.json'), 'utf8').includes(secret));
  const restored = createWorkHistory({ userDataPath, now: () => clock, getSecrets: () => [secret] });
  assert.equal(restored.snapshot().length, 2);
  assert.equal(restored.list({ cwd: 'c:/projects/api/' }).total, 1);
  assert.equal(restored.list({ cwd: 'c:/projects/ap' }).total, 0);
  assert.match(restored.list({ query: 'Fixed routes' }).records[0].summary, /\[redacted\]/);
  assert.equal(restored.list({ limit: 1 }).nextOffset, 1);
  assert.equal(restored.list({ limit: 1, offset: 1 }).nextOffset, null);
  assert.equal(restored.observe([session({ id: 'ui', cwd: 'C:\\Projects\\UI', projectName: 'UI', generation: '4' })]), false);
  await restored.flush();
});

test('history handles long project paths, stale data, malformed files, and capture after close', async t => {
  const { store, userDataPath } = fixture(t);
  const cwd = `C:\\Projects\\${'nested\\'.repeat(100)}API`;
  store.observe([session({ cwd }), session({ id: 'old', turnStartedAt: clock - MAX_AGE - 2000, turnEndedAt: clock - MAX_AGE - 1000 })]);
  assert.equal(store.list({ cwd }).total, 1);
  assert.equal(store.snapshot().length, 1);
  store.observe([]);
  assert.equal(store.enrich(session({ cwd }), result({ source: 'chat-events' })), true);
  await store.flush();
  assert.equal(createWorkHistory({ userDataPath, now: () => clock }).list({ cwd }).total, 1);
  fs.writeFileSync(path.join(userDataPath, 'orchestrator-work.json'), '{broken');
  assert.deepEqual(createWorkHistory({ userDataPath, now: () => clock }).snapshot(), []);
});

test('model pages retain cursors and all records under the result context budget', async t => {
  const { store } = fixture(t);
  const observations = Array.from({ length: 32 }, (_, index) => session({ id: `work-${index}`, name: '多'.repeat(200), projectName: '目'.repeat(200), turnId: `turn-${index}` }));
  store.observe(observations);
  for (const observed of observations) store.enrich(observed, result({ turnId: observed.turnId, text: '完成了检查。'.repeat(300) }));
  let offset = 0;
  const found = [];
  do {
    const page = store.list({ limit: 200, offset });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 18000);
    assert.ok(page.records.length);
    assert.ok(page.records.every(record => record.summaryTruncated));
    found.push(...page.records.map(record => record.id));
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(new Set(found).size, 32);
  await store.flush();
});

test('large escaped Unicode project paths evict oldest records before save and survive restart', async t => {
  const { store, userDataPath } = fixture(t);
  const cwd = `C:\\${'界\\'.repeat(16382)}`;
  assert.ok(cwd.length <= 32768);
  const observations = Array.from({ length: 220 }, (_, index) => session({ id: `large-${index}`, cwd,
    turnEndedAt: clock - 1000 + index }));
  store.observe(observations);
  await store.flush();
  const file = path.join(userDataPath, 'orchestrator-work.json');
  const encoded = fs.readFileSync(file);
  assert.ok(encoded.length <= MAX_BYTES, `${encoded.length} bytes exceeds the ${MAX_BYTES}-byte load limit`);
  const saved = JSON.parse(encoded.toString('utf8')).records;
  assert.ok(saved.length > 1 && saved.length < observations.length, 'Byte limit must evict records before reaching the count limit');
  assert.equal(saved[0].terminalId, 'large-219');
  assert.deepEqual(saved.map(record => record.terminalId), Array.from({ length: saved.length }, (_, index) => `large-${219 - index}`), 'Retain the newest contiguous records');
  assert.ok(saved.every(record => record.cwd === cwd), 'Retained project identity must not be shortened');
  // The next oldest equal-sized record cannot fit: this exercises the actual
  // UTF-8 + JSON escaping boundary, not just an approximate character count.
  assert.ok(encoded.length + Buffer.byteLength(JSON.stringify(saved.at(-1))) + 1 > MAX_BYTES);
  const restored = createWorkHistory({ userDataPath, now: () => clock });
  assert.deepEqual(restored.snapshot(), saved);
  assert.equal(restored.list({ cwd }).total, saved.length);
  await restored.flush();
});

test('model reads durable completed work after close and relaunch without any effect grant', async t => {
  const { createOrchestrator } = require('../../backend/orchestrator.cjs');
  const { userDataPath, disposeAfter } = fixture(t);
  let live = [session()], modelReads = 0;
  const options = { userDataPath, now: () => clock, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: async () => live, getRoots: async () => ({ documents: userDataPath, projects: [] }),
    interpretIntent: async () => ({ goal: 'Report what has been done in API.', access: 'read-only', executionMode: 'reason', actions: [] }),
    dispatchAction: async () => { throw new Error('History queries must have no external effects.'); },
    fetch: async (url, input) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'brain', context_length: 128000, supported_parameters: ['tools'] }] }));
      const body = JSON.parse(input.body);
      const parameters = body.tools[0].function.parameters;
      assert.ok([parameters, ...(parameters.anyOf || [])].some(branch => branch.properties?.kind?.enum?.includes('list_work')));
      const tool = body.messages.find(message => message.role === 'tool');
      if (!tool) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'read-work', type: 'function', function: { name: 'workspace', arguments: JSON.stringify({ kind: 'list_work', cwd: 'c:/projects/api' }) } }] }, finish_reason: 'tool_calls' }] }));
      const evidence = JSON.parse(tool.content);
      assert.equal(evidence.records.length, 1);
      assert.equal(evidence.records[0].status, 'completed');
      assert.match(evidence.records[0].summary, /route validation/);
      modelReads++;
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'The API agent finished its turn and reported updated route validation and passing unit tests.' }, finish_reason: 'stop' }] }));
    } };
  const first = createOrchestrator(options);
  disposeAfter(() => first.dispose());
  first.observeWork(live, result());
  live = [];
  await first.refresh();
  assert.equal(first.getState().workHistory.length, 1);
  await first.dispose();
  const restored = createOrchestrator(options);
  disposeAfter(() => restored.dispose());
  assert.equal(restored.getState().workHistory.length, 1);
  await restored.configure({ apiKey: 'test-key', sessionOnly: true, model: 'brain' });
  await restored.setEnabled(true);
  const response = await restored.send({ text: "What's been done in API?", origin: 'text' });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(modelReads, 1);
  assert.equal(restored.getState().tasks[0].targets.length, 0);
});
