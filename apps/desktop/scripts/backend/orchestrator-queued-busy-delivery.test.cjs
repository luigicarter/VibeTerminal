'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrchestratorDelivery } = require('../../backend/orchestratorDelivery.cjs');
const { createQueuedInputAttempts } = require('../../backend/orchestratorQueuedInputAttempts.cjs');
const tick = () => new Promise(setImmediate);

function fixture(t, options = {}) {
  const sessions = new Map(), busyWrites = [], idleWrites = [], updates = [];
  const delivery = createOrchestratorDelivery({ getSession: id => sessions.get(id),
    write: async payload => { idleWrites.push(payload); return { ok: true, status: 'written' }; },
    writeBusyPrompt: async action => { busyWrites.push(action); return { ok: true, status: 'written', inputDisposition: 'submitted-while-running' }; },
    onUpdate: result => updates.push(result), ...options });
  t.after(() => delivery.dispose());
  const session = (id = 'p', extra = {}) => {
    const s = { id, generation: 'g', kind: 'codex', provider: 'codex', processState: 'running', agentProcessState: 'running',
      agentPid: 42, observation: 'observed', turnState: 'running', turnId: 'turn-1', turnStartedAt: 1, pendingInput: true, ...extra };
    sessions.set(id, s); return s;
  };
  const action = (id = 'p', actionId = 'a', extra = {}) => ({ actionId, requestId: 'request', operator: true, target: { id, generation: 'g' }, text: 'Followup', ...extra });
  return { delivery, session, action, busyWrites, idleWrites, updates };
}

test('busy promotion keeps the original owner, payload, routing and final dedup result', async t => {
  const f = fixture(t), s = f.session();
  const a = f.action('p', 'original');
  assert.equal((await f.delivery.submit(a)).status, 'queued'); s.pendingInput = false;
  await f.delivery.pump(); await f.delivery.pump();
  assert.equal(f.idleWrites.length, 0); assert.equal(f.busyWrites.length, 1);
  assert.equal(f.busyWrites[0].actionId, 'original'); assert.equal(f.busyWrites[0].requestId, 'request');
  assert.equal(f.busyWrites[0].text, a.text); assert.deepEqual(f.busyWrites[0].target, a.target);
  assert.equal((await f.delivery.submit(a)).inputDisposition, 'submitted-while-running');
  assert.equal(f.updates.length, 1);
});

test('busy promotion shares global capacity and same-terminal FIFO until fresh turn evidence', async t => {
  const calls = [], releases = new Map();
  const f = fixture(t, { maxConcurrentDeliveries: 1, writeBusyPrompt: action => {
    calls.push(action.actionId); return new Promise(resolve => releases.set(action.actionId, resolve));
  } });
  const p = f.session('p'), q = f.session('q');
  for (const action of [f.action('p', 'p1'), f.action('p', 'p2'), f.action('q', 'q1')]) assert.equal((await f.delivery.submit(action)).status, 'queued');
  p.pendingInput = false; q.pendingInput = false;
  const first = f.delivery.pump(); await tick(); assert.deepEqual(calls, ['p1']);
  releases.get('p1')({ ok: true, status: 'written' }); await first; await tick();
  assert.deepEqual(calls, ['p1', 'q1'], 'Same-turn delivery lock preserves FIFO without starving independent targets');
  releases.get('q1')({ ok: true, status: 'written' }); await tick();
  p.turnId = 'turn-2'; p.turnStartedAt = 2;
  const next = f.delivery.pump(); await tick(); assert.deepEqual(calls, ['p1', 'q1', 'p2']);
  releases.get('p2')({ ok: true, status: 'written' }); await next;
  assert.equal(f.updates.length, 3);
});

for (const mode of ['legacy', 'other-provider']) test(`${mode} prompts retain ordinary idle delivery`, async t => {
  const f = fixture(t), s = f.session('p', mode === 'other-provider' ? { kind: 'claude', provider: 'claude' } : {});
  const a = f.action('p', 'a', mode === 'legacy' ? { operator: false } : {});
  assert.equal((await f.delivery.submit(a)).status, 'queued'); s.pendingInput = false;
  await f.delivery.pump(); assert.equal(f.busyWrites.length, 0); assert.equal(f.idleWrites.length, 0);
  s.turnState = 'completed'; await f.delivery.pump();
  assert.equal(f.idleWrites.length, 1); assert.equal(f.busyWrites.length, 0);
});

test('idle-only work cannot queue or acquire busy delivery authority', async t => {
  const f = fixture(t); const s = f.session();
  const result = await f.delivery.submit(f.action('p', 'idle-only', { targetAvailability: 'idle' }));
  assert.equal(result.delivery, 'not-dispatched'); assert.equal(result.status, 'blocked');
  s.pendingInput = false; await f.delivery.pump(); s.turnState = 'completed'; await f.delivery.pump();
  assert.equal(f.busyWrites.length + f.idleWrites.length, 0);
});

test('cancellation during guarded busy preparation fences input and publishes one result', async t => {
  let release;
  const writes = [];
  const f = fixture(t, { writeBusyPrompt: async action => {
    await new Promise(resolve => { release = resolve; });
    if (action.signal.aborted) return { ok: false, status: 'cancelled', delivery: 'not-dispatched' };
    writes.push(action); return { ok: true, status: 'written' };
  } });
  const s = f.session(); await f.delivery.submit(f.action()); s.pendingInput = false;
  const pumping = f.delivery.pump(); await tick(); f.delivery.cancel(); release(); await pumping;
  assert.equal(writes.length, 0); assert.equal(f.updates.length, 1); assert.equal(f.updates[0].status, 'cancelled');
  s.turnState = 'completed'; await f.delivery.pump(); assert.equal(writes.length, 0);
});

test('attempt aliases retain late correlation, isolate request/generation and never evict active ownership', () => {
  const aliases = createQueuedInputAttempts({ maxCompleted: 1 });
  const action = id => ({ actionId: id, requestId: 'request', target: { id: 'p', generation: 'g' } });
  const event = id => ({ id: 'p', generation: 'g', actionId: id });
  aliases.remember('active-attempt', action('active-original'));
  aliases.remember('old-attempt', action('old-original')); aliases.complete('old-attempt');
  aliases.remember('new-attempt', action('new-original')); aliases.complete('new-attempt');
  assert.equal(aliases.correlate(event('old-attempt')).actionId, 'old-attempt', 'Completed aliases are bounded');
  assert.equal(aliases.correlate(event('active-attempt')).actionId, 'active-original');
  assert.equal(aliases.correlate(event('new-attempt')).actionId, 'new-original', 'Late acknowledgement keeps original owner');
  assert.equal(aliases.correlate({ ...event('new-attempt'), completedActionId: 'new-attempt' }).completedActionId, 'new-original');
  for (const patch of [{ id: 'other' }, { generation: 'replacement' }, { requestId: 'other-request' }]) {
    assert.equal(aliases.correlate({ ...event('new-attempt'), ...patch }).actionId, 'new-attempt');
  }
  aliases.forget('p', 'g'); assert.equal(aliases.correlate(event('active-attempt')).actionId, 'active-attempt');
  aliases.remember('dispose-attempt', action('dispose-original')); aliases.clear();
  assert.equal(aliases.correlate(event('dispose-attempt')).actionId, 'dispose-attempt');
});
