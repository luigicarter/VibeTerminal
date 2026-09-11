'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { spawn } = require('node:child_process');
const { createHostStopObserver, createObservedLaunchFence, createObservedStopBroker } = require('../../backend/observedStop.cjs');

const scope = { id: 'synthetic-pane', launchToken: 1, generation: 'generation-1' };
const request = (operationId = 'stop-1', extra = {}) => ({ ...scope, operationId, kind: 'terminal', ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
function host(kill = () => true, timeoutMs = 20) {
  let current = scope;
  const child = new EventEmitter(); child.pid = 12345; child.exitCode = null;
  const events = [];
  const observer = createHostStopObserver({ lookup: () => current, kill, timeoutMs, emit: event => events.push(event) });
  observer.track(scope, child);
  return { observer, child, events, replace: value => { current = value; } };
}

test('acknowledgment and synthetic closed are not exit proof; actual exit survives session removal', async () => {
  let kills = 0;
  const h = host(() => { kills++; return true; }, 1000);
  const pending = h.observer.stop(request(), () => h.replace(undefined));
  await tick(); h.child.emit('closed'); await tick();
  assert.equal(h.events.length, 0);
  h.child.emit('exit', 0);
  assert.equal((await pending).process, 'stopped'); assert.equal(kills, 1);
  assert.equal((await h.observer.stop(request())).process, 'stopped'); assert.equal(kills, 1);
});

test('delayed stale stop preserves replacement generation and launch token', async () => {
  let kills = 0; const h = host(() => { kills++; });
  const pending = h.observer.stop(request());
  h.replace({ ...scope, launchToken: 2, generation: 'generation-2' });
  assert.equal((await pending).process, 'superseded'); assert.equal(kills, 0);
});

for (const [name, kill] of [['false', () => false], ['throw', () => { throw new Error('kill rejected'); }]]) {
  test(`${name} kill is failed and cannot be replayed or converted by later root exit`, async () => {
    let calls = 0; const h = host(() => { calls++; return kill(); });
    assert.equal((await h.observer.stop(request())).process, 'failed');
    h.child.emit('exit', 1);
    assert.equal((await h.observer.stop(request('read-again'))).process, 'failed'); assert.equal(calls, 1);
  });
}

test('timeout retains original process; reconciliation does not send a second kill', async () => {
  let calls = 0; const h = host(() => { calls++; });
  assert.equal((await h.observer.stop(request())).process, 'unknown');
  const later = h.observer.stop(request('reconcile')); await tick();
  h.child.emit('exit', 0);
  assert.equal((await later).process, 'stopped'); assert.equal(calls, 1);
});

test('natural root exit never proves that its surviving descendants are absent', async () => {
  const h = host(); h.child.emit('exit', 0); h.replace(undefined);
  assert.equal((await h.observer.stop(request())).process, 'unknown');
});

test('same-operation observeOnly reconciles a late exit without another kill', async () => {
  let kills = 0; const h = host(() => { kills++; });
  assert.equal((await h.observer.stop(request())).process, 'unknown');
  h.child.emit('exit', 0);
  assert.equal((await h.observer.stop(request('stop-1', { observeOnly: true }))).process, 'stopped');
  assert.equal(kills, 1);
  assert.equal((await h.observer.stop(request('missing', { observeOnly: true }))).process, 'unknown');
  assert.equal(kills, 1);
});

test('absent host entry is positive absence; untracked current entry remains unknown', async () => {
  const observer = createHostStopObserver({ lookup: () => undefined });
  assert.equal((await observer.stop(request())).process, 'already-absent');
  const unknown = createHostStopObserver({ lookup: () => scope });
  assert.equal((await unknown.stop(request())).process, 'unknown');
});

test('numeric generation zero remains exact through stop and observation', async () => {
  const observer = createHostStopObserver({ lookup: () => undefined });
  const zero = request('zero', { generation: 0 });
  assert.equal((await observer.stop(zero)).process, 'already-absent');
  assert.equal((await observer.stop({ ...zero, observeOnly: true })).generation, 0);
});

test('operation IDs cannot be rebound to a different launch', async () => {
  const h = host(); h.child.emit('exit', 0);
  await h.observer.stop(request());
  assert.equal((await h.observer.stop(request('stop-1', { launchToken: 2 }))).process, 'failed');
});

test('launch cancellation waits preparation, fences delayed IPC and permits higher-token replacement', async () => {
  const fence = createObservedLaunchFence(); let release, sent = 0;
  const pending = fence.run('fusion', scope, async () => {
    await new Promise(resolve => { release = resolve; });
    if (fence.outgoing('fusion', scope)) sent++;
  });
  await tick();
  const cancelled = fence.cancel('fusion', scope);
  let settled = false; void cancelled.settled.then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  assert.equal((await fence.run('fusion', scope, () => { sent++; })).cancelled, true);
  await fence.run('fusion', { ...scope, launchToken: 2 }, () => { sent++; });
  release(); await pending; await cancelled.settled;
  assert.equal(sent, 1);
  assert.equal(fence.get('fusion', scope.id).launchToken, 2);
  assert.equal(fence.cancel('fusion', scope).superseded, true);
});

test('never-started pane tombstone rejects a delayed first create; bounded table fails closed', async () => {
  const fence = createObservedLaunchFence({ capacity: 1 });
  await fence.cancel('terminal', scope).settled;
  assert.equal((await fence.run('terminal', scope, () => true)).cancelled, true);
  assert.ok((await fence.run('terminal', { ...scope, id: 'other' }, () => true)).error);
  assert.ok(fence.cancel('terminal', { ...scope, id: 'other' }).error);
  assert.equal(await fence.run('terminal', { ...scope, launchToken: 2 }, () => 'replacement'), 'replacement');
});

test('a stale close cannot cancel replacement preparation in another provider', async () => {
  const fence = createObservedLaunchFence();
  await fence.run('fusion', scope, () => true);
  await fence.run('openfusion', { ...scope, launchToken: 2 }, () => true);
  let cleanup = false;
  assert.equal(fence.cancel('fusion', scope, () => { cleanup = true; }).superseded, true);
  assert.equal(cleanup, false);
  assert.equal(fence.canSend('openfusion', { ...scope, launchToken: 2 }), true);
});

test('broker ignores synthetic/stale evidence and requires preparation before host stop', async () => {
  let release, sent;
  const broker = createObservedStopBroker({ timeoutMs: 100, prepare: () => new Promise(resolve => { release = resolve; }), send: payload => { sent = payload; return true; } });
  const pending = broker.stop(request()); await tick(); assert.equal(sent, undefined);
  assert.equal(broker.receive({ ...request(), type: 'closed', process: 'stopped' }), false);
  release({ launchSettled: true }); await tick();
  assert.equal(broker.receive({ ...request(), generation: 'stale', type: 'stop-observed-result', process: 'stopped' }), false);
  assert.equal(broker.receive({ ...request(), type: 'stop-observed-result', process: 'stopped' }), true);
  assert.deepEqual([(await pending).ok, (await pending).launchSettled], [true, true]);
});

test('host send failure is absence only when launch fence proves nothing was dispatched', async () => {
  for (const neverDispatched of [true, false]) {
    const broker = createObservedStopBroker({ prepare: () => ({ launchSettled: true, neverDispatched }), send: () => false });
    assert.equal((await broker.stop(request())).process, neverDispatched ? 'already-absent' : 'unknown');
  }
});

test('preparation timeout never sends a late mutation', async () => {
  let release, sent = 0;
  const broker = createObservedStopBroker({ timeoutMs: 10, prepare: () => new Promise(resolve => { release = resolve; }), send: () => { sent++; return true; } });
  const result = await broker.stop(request());
  assert.equal(result.process, 'unknown'); assert.equal(result.launchSettled, false);
  release({ launchSettled: true }); await tick(); assert.equal(sent, 0);
});

test('failed executor cleanup still stops root but never publishes successful closure', async () => {
  let sent;
  const broker = createObservedStopBroker({ prepare: () => ({ launchSettled: true, cleanupError: 'Executor cleanup failed.' }), send: payload => { sent = payload; return true; } });
  const pending = broker.stop(request()); await tick(); assert.ok(sent);
  broker.receive({ ...request(), type: 'stop-observed-result', process: 'stopped' });
  assert.equal((await pending).process, 'failed'); assert.match((await pending).error, /Executor/);
});

test('broker observes the same timed-out operation after late host exit without preparation or kill', async () => {
  let prepares = 0, writes = 0, broker;
  const child = new EventEmitter(); child.pid = 1234;
  const observer = createHostStopObserver({ lookup: () => scope, timeoutMs: 10, kill: () => { writes++; }, emit: event => broker.receive(event) });
  observer.track(scope, child);
  broker = createObservedStopBroker({ prepare: () => { prepares++; return { launchSettled: true }; }, send: payload => { void observer.stop(payload); return true; }, timeoutMs: 100 });
  assert.equal((await broker.stop(request())).process, 'unknown');
  child.emit('exit', 0);
  const observed = await broker.stop(request('stop-1', { observeOnly: true }));
  assert.equal(observed.process, 'stopped'); assert.equal(observed.launchSettled, true);
  assert.equal(prepares, 1); assert.equal(writes, 1);
});

test('real Windows process tree exit settles observed stop', { skip: process.platform !== 'win32' }, async () => {
  const script = 'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{windowsHide:true,stdio:"ignore"}); console.log(c.pid);setInterval(()=>{},1000);';
  const child = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const [data] = await once(child.stdout, 'data');
  const descendantPid = Number(String(data).trim()); assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  const observer = createHostStopObserver({ lookup: () => scope, timeoutMs: 5000 });
  observer.track(scope, child);
  try {
    assert.equal((await observer.stop(request())).process, 'stopped');
    assert.throws(() => process.kill(descendantPid, 0), 'the actual descendant must also be gone');
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill();
    try { process.kill(descendantPid); } catch {}
  }
});

test('real root exit leaving a child before close remains unverified', { skip: process.platform !== 'win32' }, async () => {
  const script = 'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{windowsHide:true,detached:true,stdio:"ignore"});console.log(c.pid);c.unref();';
  const child = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const observer = createHostStopObserver({ lookup: () => undefined }); observer.track(scope, child);
  const exit = once(child, 'exit');
  const [data] = await once(child.stdout, 'data'); const descendantPid = Number(String(data).trim());
  try {
    await exit; process.kill(descendantPid, 0);
    assert.equal((await observer.stop(request())).process, 'unknown');
    process.kill(descendantPid, 0);
  } finally { try { process.kill(descendantPid); } catch {} }
});
