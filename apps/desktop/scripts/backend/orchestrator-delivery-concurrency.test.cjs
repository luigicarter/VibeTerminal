'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrchestratorDelivery } = require('../../backend/orchestratorDelivery.cjs');
const tick = () => new Promise(setImmediate);
function fixture(options = {}) {
  const sessions = new Map(), writes = [], updates = [], releases = new Map();
  const delivery = createOrchestratorDelivery({ getSession: id => sessions.get(id), onUpdate: r => updates.push(r),
    write: p => { writes.push(p); return new Promise(resolve => releases.set(p.actionId, resolve)); }, ...options });
  const session = (id, provider = 'codex', busy = true) => {
    const s = { id, generation: id, provider, started: true, processState: 'running', agentProcessState: 'running', agentPid: 123,
      turnState: busy ? 'running' : 'idle', observation: 'observed' };
    sessions.set(id, s); return s;
  };
  const action = (id, actionId = id, signal) => ({ actionId, target: { id, generation: id }, text: 'fixture', signal });
  const release = (id, result = { ok: true, status: 'written' }) => { assert(releases.has(id), `Missing write ${id}`); releases.get(id)(result); };
  return { delivery, sessions, writes, updates, session, action, release };
}

test('independent queued targets and newly ready targets progress while A acknowledgment is held', async () => {
  const f = fixture();
  for (const id of ['a', 'b', 'c']) { f.session(id); assert.equal((await f.delivery.submit(f.action(id))).status, 'queued'); }
  f.sessions.get('a').turnState = 'idle'; f.sessions.get('b').turnState = 'idle';
  const first = f.delivery.observe(); await tick();
  assert.deepEqual(f.writes.map(w => w.id), ['a', 'b']);
  f.release('b'); await tick();
  f.sessions.get('c').turnState = 'idle'; const second = f.delivery.observe(); await tick();
  assert.deepEqual(f.writes.map(w => w.id), ['a', 'b', 'c']);
  f.release('c'); await second;
  assert.equal(f.updates.find(r => r.actionId === 'a'), undefined);
  f.release('a'); await first; f.delivery.dispose();
});

test('default four slots cover direct writes and queued writes; completion admits next target automatically', async () => {
  const f = fixture(); const pending = [];
  for (let i = 0; i < 6; i++) { const id = String(i); f.session(id, 'terminal', false); pending.push(f.delivery.submit(f.action(id))); }
  await tick(); assert.equal(f.writes.length, 4);
  assert.equal((await pending[4]).status, 'queued'); assert.equal((await pending[5]).status, 'queued');
  f.release('1'); await tick(); assert.deepEqual(f.writes.map(w => w.id), ['0', '1', '2', '3', '4']);
  f.release('2'); await tick(); assert.equal(f.writes.length, 6);
  for (const id of ['0', '3', '4', '5']) f.release(id);
  await Promise.all(pending); await tick(); f.delivery.dispose();
});

test('plain shell direct and queued sends retain same-target FIFO and action dedup under reentrant hooks', async () => {
  let f; f = fixture({ onBeforeWrite: () => { void f.delivery.observe(); } });
  f.session('shell', 'terminal', false);
  const first = f.delivery.submit(f.action('shell', 'one'));
  assert.strictEqual(f.delivery.submit(f.action('shell', 'one')), first);
  assert.equal((await f.delivery.submit(f.action('shell', 'two'))).status, 'queued');
  assert.equal((await f.delivery.submit(f.action('shell', 'three'))).status, 'queued');
  await f.delivery.observe(); assert.deepEqual(f.writes.map(w => w.actionId), ['one']);
  f.release('one'); await first; await tick();
  assert.deepEqual(f.writes.map(w => w.actionId), ['one', 'two']);
  await f.delivery.observe(); await f.delivery.observe();
  f.release('two'); await tick(); assert.deepEqual(f.writes.map(w => w.actionId), ['one', 'two', 'three']);
  f.release('three'); await tick();
  assert.equal((await f.delivery.submit(f.action('shell', 'two'))).status, 'written');
  assert.equal(f.writes.length, 3); f.delivery.dispose();
});

test('queued in-flight abort, expiry and generation change preserve actual acknowledgment', async () => {
  let now = 0; const f = fixture({ now: () => now, maxWaitMs: 10 }); const controller = new AbortController();
  f.session('a'); await f.delivery.submit(f.action('a', 'a', controller.signal));
  f.sessions.get('a').turnState = 'idle'; const pumping = f.delivery.observe(); await tick();
  controller.abort(); now = 100; f.sessions.get('a').generation = 'new';
  await f.delivery.observe(); f.delivery.forget('a', 'a');
  assert.equal(f.updates.length, 0); assert.equal(f.writes.length, 1);
  f.release('a'); await pumping;
  assert.equal(f.updates.length, 1); assert.equal(f.updates[0].status, 'written'); f.delivery.dispose();
});

test('cancelling unsent capacity wait never writes; disposal reports in-flight unknown once', async () => {
  const f = fixture({ maxConcurrentDeliveries: 1 }); const controller = new AbortController();
  f.session('a'); f.session('b');
  await f.delivery.submit(f.action('a')); await f.delivery.submit(f.action('b', 'b', controller.signal));
  f.sessions.get('a').turnState = 'idle'; f.sessions.get('b').turnState = 'idle';
  const pumping = f.delivery.observe(); await tick(); controller.abort();
  assert.equal(f.updates.find(r => r.actionId === 'b').status, 'cancelled');
  f.delivery.dispose(); assert.equal(f.updates.find(r => r.actionId === 'a').status, 'unknown');
  f.release('a'); await pumping; assert.equal(f.updates.length, 2); assert.equal(f.writes.length, 1);
});

test('capacity release does not bypass an agent uncertainty lock; new turn evidence releases it', async () => {
  const f = fixture(); f.session('a', 'codex', false); f.session('b', 'terminal', false);
  const first = f.delivery.submit(f.action('a', 'one'));
  await tick(); assert.equal((await f.delivery.submit(f.action('a', 'two'))).status, 'queued');
  f.release('one', { ok: false, status: 'unknown' }); await first; await tick();
  const independent = f.delivery.submit(f.action('b')); await tick();
  assert.deepEqual(f.writes.map(w => w.actionId), ['one', 'b']); f.release('b'); await independent;
  await f.delivery.observe(); assert.equal(f.writes.length, 2);
  f.sessions.get('a').turnId = 'next-observed-turn';
  const pumping = f.delivery.observe(); await tick(); assert.equal(f.writes.at(-1).actionId, 'two');
  f.release('two'); await pumping; f.delivery.dispose();
});

test('pending direct dedup survives result-cache pressure before transport admission', async () => {
  const f = fixture(); f.session('a', 'terminal', false);
  const first = f.delivery.submit(f.action('a', 'first'));
  const extras = Array.from({ length: 510 }, (_, i) => f.delivery.submit({ actionId: `invalid-${i}`, text: '' }));
  assert.strictEqual(f.delivery.submit(f.action('a', 'first')), first);
  await tick(); assert.equal(f.writes.length, 1);
  f.release('first'); await Promise.all([first, ...extras]); f.delivery.dispose();
});
