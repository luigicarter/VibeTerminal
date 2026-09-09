'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createCloseReconciliation } = require('../../backend/orchestratorCloseReconciliation.cjs');
const target = { id: 'pane', generation: 'original', launchToken: 1 };
function fixture(options = {}) {
  let at = 1000, sessions = [], proof = { ok: false, operationId: 'stop', process: 'unknown', launchSettled: false };
  const calls = [], published = [];
  const tracker = createCloseReconciliation({ now: () => at, getSessions: () => sessions,
    observe: async request => { calls.push(request); return proof; }, publish: receipt => published.push(receipt), ...options });
  const request = { operationId: 'stop', ...target, kind: 'codex' };
  const receipt = { ok: false, kind: 'close', status: 'close-partial', actionId: 'stop', grantId: 'grant', targetId: target.id, generation: target.generation,
    error: 'Stop unconfirmed', close: { operationId: 'stop', target, pane: 'removed', process: 'unknown', launchSettled: false } };
  return { tracker, calls, published, request, receipt, setProof: value => { proof = value; }, setSessions: value => { sessions = value; }, advance: value => { at += value; }, track: () => tracker.track(receipt, request) };
}
test('an unmounted pane gains late proof by observing only its original stop operation', async () => {
  const f = fixture(); f.track(); await f.tracker.refresh();
  assert.equal(f.published.length, 0); assert.deepEqual(f.calls[0], { ...f.request, observeOnly: true });
  f.setProof({ ok: true, operationId: 'stop', process: 'stopped', launchSettled: true }); f.advance(1000); await f.tracker.refresh();
  assert.equal(f.published.length, 1); const result = f.published[0];
  assert.equal(result.ok, true); assert.equal(result.status, 'closed'); assert.equal(result.error, undefined);
  assert.deepEqual(result.close.target, target); assert.equal(result.actionId, 'stop'); assert.equal(result.grantId, 'grant');
  await f.tracker.refresh(); assert.equal(f.calls.length, 2);
});
test('observation failures and unrelated proof preserve unknown state without replay', async () => {
  let calls = 0; const f = fixture({ observe: async () => { if (++calls === 1) throw Error('Host unavailable'); return { ok: true, operationId: 'another-stop', process: 'stopped', launchSettled: true }; } });
  f.track(); await f.tracker.refresh(); f.advance(1000); await f.tracker.refresh();
  assert.equal(f.published.length, 0); assert.equal(f.tracker.size(), 1);
});
test('overlapping fresh inventories coalesce one original-operation observation', async () => {
  let release, calls = 0; const f = fixture({ observe: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  f.track(); const first = f.tracker.refresh(), second = f.tracker.refresh();
  assert.equal(first, second); assert.equal(calls, 1);
  release({ ok: false, operationId: 'stop', process: 'unknown', launchSettled: false }); await first;
});
test('removed original can settle while a replacement remains; same original visible cannot', async () => {
  const f = fixture(); f.track(); f.setProof({ ok: true, operationId: 'stop', process: 'stopped', launchSettled: true });
  f.setSessions([{ ...target, visiblePane: true }]); await f.tracker.refresh(); assert.equal(f.published.length, 0);
  f.setSessions([{ ...target, launchToken: 2, generation: 'replacement', visiblePane: true }]); f.advance(1000); await f.tracker.refresh();
  assert.equal(f.published.length, 1); assert.deepEqual(f.published[0].close.target, target);
});
test('retention, observation batches, expiry and disposal are bounded', async () => {
  const calls = []; const f = fixture({ limit: 3, batchSize: 2, ttlMs: 10, observe: async request => { calls.push(request.operationId); return { ok: false }; } });
  for (let i=0;i<4;i++) f.tracker.track({ ...f.receipt, close: { ...f.receipt.close, operationId: `stop${i}` } }, { ...f.request, operationId: `stop${i}` });
  assert.equal(f.tracker.size(), 3); await f.tracker.refresh(); assert.equal(calls.length, 2);
  f.advance(11); await f.tracker.refresh(); assert.equal(f.tracker.size(), 0);
  f.track(); f.tracker.dispose(); await f.tracker.refresh(); assert.equal(calls.length, 2);
});
test('the tracker cannot register a different identity or a still-present pane', async () => {
  const f=fixture(); f.tracker.track(f.receipt, {...f.request,launchToken:2});
  f.tracker.track({...f.receipt,close:{...f.receipt.close,pane:'unknown'}},f.request);
  assert.equal(f.tracker.size(),0); await f.tracker.refresh(); assert.equal(f.calls.length,0);
});
test('failed asynchronous publication retains the original observation until accepted', async () => {
  let attempts=0;
  const f=fixture({publish:async()=>{attempts++;if(attempts===1)return {ok:false};if(attempts===2)throw Error('Inventory lost');return {ok:true};}});
  f.track();f.setProof({ok:true,operationId:'stop',process:'stopped',launchSettled:true});
  await f.tracker.refresh();assert.equal(f.tracker.size(),1);
  f.advance(1000);await f.tracker.refresh();assert.equal(f.tracker.size(),1);
  f.advance(1000);await f.tracker.refresh();assert.equal(f.tracker.size(),0);
  assert.equal(attempts,3);assert.equal(f.calls.length,3);assert(f.calls.every(request=>request.observeOnly===true&&request.operationId==='stop'));
});
