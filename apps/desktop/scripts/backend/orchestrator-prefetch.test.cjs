'use strict';
// The pane inventory, the project roots and the launcher catalog say nothing
// about what the user asked for, so a request no longer pays for them one after
// another in front of interpretation. These tests measure that: what the reads
// cost when they overlap, what the same reads cost when every warm read is
// refused and the request falls back to the old serial shape, and the rules that
// keep a warm snapshot honest - one consumer, two seconds of pane freshness, and
// nothing carried across a cancellation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));
const READ_KINDS = ['sessions', 'roots', 'launchers'];

async function fixture(t, { delayMs = 0, failFirst = false, clock } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-prefetch-'));
  const f = { root, calls: { sessions: [], roots: [], launchers: [] }, interpretedAt: [], armed: false, failReads: false };
  f.armedCalls = kind => f.calls[kind].filter(entry => entry.armed);
  f.count = kind => f.armedCalls(kind).length;
  const read = async kind => {
    const entry = { kind, armed: f.armed, startedAt: Date.now() };
    f.calls[kind].push(entry);
    if (entry.armed && failFirst && f.armedCalls(kind).length === 1) { entry.endedAt = Date.now(); entry.failed = true; throw new Error(`Fixture ${kind} read refused.`); }
    if (delayMs) await wait(delayMs);
    entry.endedAt = Date.now();
    if (f.failReads) { entry.failed = true; throw new Error(`Fixture ${kind} read refused.`); }
  };
  const sessions = [{ id: 'pane', generation: 'g1', launchToken: 1, name: 'Fixture', kind: 'codex', provider: 'codex', cwd: root, status: 'idle' }];
  f.app = createOrchestrator({
    userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    ...(clock && { now: () => Date.now() + clock.offset }),
    getSessions: async () => { await read('sessions'); return sessions; },
    getRoots: async () => { await read('roots'); return { documents: root, projects: [root] }; },
    getLaunchers: async () => { await read('launchers'); return [{ kind: 'codex', label: 'Codex', available: true, configured: true }]; },
    getWorkspaceState: async () => ({ ok: false }),
    dispatchAction: async () => assert.fail('A question answered from knowledge dispatches no terminal effect.'),
    interpretIntent: async () => { f.interpretedAt.push(Date.now()); return { goal: 'Answer from what Lina already knows.', actions: [], access: 'read-only' }; },
    fetch: async url => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] }));
      assert(url.endsWith('/chat/completions'), 'No unhandled network requests');
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Standing by.' } }] }));
    },
  });
  t.after(async () => { await f.app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal((await f.app.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true })).ok, true);
  assert.equal((await f.app.setEnabled(true)).ok, true);
  f.armed = true;
  return f;
}

test('the inventory, roots and launcher catalog are read in parallel from submit, not serially before interpretation', async t => {
  const f = await fixture(t, { delayMs: 300 });
  const submittedAt = Date.now();
  const result = await f.app.send({ text: 'What can you do for me?', origin: 'text' });
  assert.equal(result.ok, true);
  assert.equal(f.interpretedAt.length, 1);
  const elapsed = f.interpretedAt[0] - submittedAt;
  for (const kind of READ_KINDS) assert.equal(f.count(kind), 1, `${kind} is read exactly once`);
  const starts = READ_KINDS.map(kind => f.armedCalls(kind)[0].startedAt);
  assert(Math.max(...starts) - Math.min(...starts) < 150, `the three reads start together (spread ${Math.max(...starts) - Math.min(...starts)} ms)`);
  assert(Math.min(...starts) - submittedAt < 150, 'the reads start at submit, not after interpretation is reached');
  assert(elapsed >= 250, `interpretation still waits for the reads it needs (${elapsed} ms)`);
  assert(elapsed < 750, `submit to interpretation is one read, not three (${elapsed} ms)`);
  console.log(`prefetched submit -> interpretation: ${elapsed} ms (three 300 ms workspace reads)`);
});

test('a refused prefetch falls back to exactly one direct read each, at the old serial cost', async t => {
  const f = await fixture(t, { delayMs: 300, failFirst: true });
  const submittedAt = Date.now();
  const result = await f.app.send({ text: 'What can you do for me?', origin: 'text' });
  assert.equal(result.ok, true);
  const elapsed = f.interpretedAt[0] - submittedAt;
  for (const kind of READ_KINDS) {
    assert.equal(f.count(kind), 2, `${kind}: one refused prefetch and one direct fallback, never more`);
    assert.equal(f.armedCalls(kind)[0].failed, true);
    assert.equal(f.armedCalls(kind)[1].failed, undefined);
  }
  assert(elapsed >= 800, `the fallback path is the old serial one (${elapsed} ms)`);
  console.log(`un-prefetched submit -> interpretation: ${elapsed} ms (every prefetch refused; three serial 300 ms reads)`);
});

test('a warmed snapshot is consumed by exactly one following request', async t => {
  const f = await fixture(t, { delayMs: 20 });
  assert.deepEqual(f.app.prefetch(), { ok: true });
  assert.deepEqual(f.app.prefetch(), { ok: true });
  await wait(80);
  for (const kind of READ_KINDS) assert.equal(f.count(kind), 1, `${kind}: a second warm call inside the cache window starts nothing`);
  assert.equal((await f.app.send({ text: 'What can you do for me?', origin: 'text' })).ok, true);
  for (const kind of READ_KINDS) assert.equal(f.count(kind), 1, `${kind}: the request consumed the warmed read instead of repeating it`);
  assert.equal((await f.app.send({ text: 'And what else?', origin: 'text' })).ok, true);
  for (const kind of READ_KINDS) assert.equal(f.count(kind), 2, `${kind}: the next request reads for itself`);
  await f.app.setEnabled(false);
  assert.equal(f.app.prefetch().ok, false, 'a disabled relay warms nothing');
});

test('a warmed pane snapshot older than two seconds is re-read; roots and the catalog are not pane state', async t => {
  const clock = { offset: 0 };
  const f = await fixture(t, { delayMs: 10, clock });
  assert.equal(f.app.prefetch().ok, true);
  await wait(60);
  for (const kind of READ_KINDS) assert.equal(f.count(kind), 1);
  clock.offset = 2200; // Inside the 3 s warm window, past the 2 s pane-freshness rule.
  assert.equal((await f.app.send({ text: 'What can you do for me?', origin: 'text' })).ok, true);
  assert.equal(f.count('sessions'), 2, 'panes move while a request waits its turn, so the snapshot is re-read');
  assert.equal(f.count('roots'), 1, 'the project roots are still the warmed ones');
  assert.equal(f.count('launchers'), 1, 'the launcher catalog is still the warmed one');
});

test('cancelling during a prefetch leaks no unhandled rejection and carries no snapshot into the next epoch', async t => {
  const leaks = [];
  const onLeak = reason => leaks.push(reason);
  process.on('unhandledRejection', onLeak);
  t.after(() => process.off('unhandledRejection', onLeak));
  const f = await fixture(t, { delayMs: 60 });
  f.failReads = true;
  assert.equal(f.app.prefetch().ok, true);
  const pending = f.app.send({ text: 'Start something long.', origin: 'text' }).then(result => result, error => ({ ok: false, error: String(error) }));
  await tick();
  await f.app.cancel();
  assert.equal((await pending).ok, false);
  await wait(200); await tick(); await tick();
  assert.deepEqual(leaks.map(String), [], 'a refused or abandoned prefetch is captured, never left unhandled');

  f.failReads = false;
  assert.equal(f.app.prefetch().ok, true);
  await wait(120);
  const warmed = READ_KINDS.map(kind => f.count(kind));
  await f.app.cancel();
  assert.equal((await f.app.send({ text: 'What can you do for me?', origin: 'text' })).ok, true);
  READ_KINDS.forEach((kind, index) => assert.equal(f.count(kind), warmed[index] + 1, `${kind}: a snapshot warmed before a cancellation is discarded`));
  await wait(50); await tick();
  assert.deepEqual(leaks.map(String), []);
});
