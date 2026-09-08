'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskSpeech } = require('../../backend/orchestratorTaskSpeech.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const { getEventListeners } = require('node:events');
function fixture(speak) {
  const calls = [];
  const announce = createTaskSpeech(event => { calls.push(event); return speak ? speak(event) : { ok: true }; });
  const args = (patch = {}) => {
    const report = { targetId: 'pane', generation: 'g', turnId: 'turn', status: 'completed', text: 'Pane: the agent turn completed.', ...patch.report };
    return { job: { waits: [{ ...report, done: true, ...patch.wait }] }, report,
      event: { kind: 'task-report', requestId: 'request', text: report.text, ...patch.event }, epoch: 1, isActive: () => true,
      ...Object.fromEntries(Object.entries(patch).filter(([key]) => !['report', 'wait', 'event'].includes(key))) };
  };
  return { announce, args, calls };
}

test('aborted duplicate settles without waiting for or cancelling shared playback', async () => {
  let finish, settled = false;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const first = f.announce(f.args());
  const controller = new AbortController();
  const duplicate = f.announce(f.args({ event: { requestId: 'cancelled-watch', signal: controller.signal } })).then(result => { settled = true; return result; });
  controller.abort();
  await tick();
  assert.equal(settled, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(await duplicate, undefined);
  finish({ ok: true });
  assert.deepEqual(await first, { ok: true });
  assert.equal((await f.announce(f.args())).status, 'duplicate');
});

test('pending matching speech waits for delivery, then suppresses duplicate across request labels', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const first = f.announce(f.args());
  const second = f.announce(f.args({ report: { text: 'Renamed pane: the agent turn completed. All requested terminal turns have ended.' }, event: { requestId: 'watch' } }));
  await tick();
  assert.equal(f.calls.length, 1);
  finish({ ok: true });
  assert.deepEqual(await first, { ok: true });
  assert.equal((await second).status, 'duplicate');
  assert.equal(f.calls.length, 1);
});

for (const outcome of [{ ok: false }, { ok: true, status: 'cancelled' }, { ok: true, status: 'silent' }, new Error('Playback failed')]) {
  test(`an unsuccessful first speech releases a pending active duplicate: ${outcome.status || outcome.message || 'ok:false'}`, async () => {
    let finish, fail;
    let attempts = 0;
    const f = fixture(() => ++attempts === 1 ? new Promise((resolve, reject) => { finish = resolve; fail = reject; }) : { ok: true });
    const first = f.announce(f.args()).catch(error => error);
    const second = f.announce(f.args({ event: { requestId: 'watch' } }));
    await tick();
    assert.equal(f.calls.length, 1);
    if (outcome instanceof Error) fail(outcome); else finish(outcome);
    await first;
    assert.deepEqual(await second, { ok: true });
    assert.deepEqual(f.calls.map(event => event.requestId), ['request', 'watch']);
    assert.equal((await f.announce(f.args())).status, 'duplicate');
  });
}

test('a pending duplicate that becomes inactive or aborted never takes over failed speech', async () => {
  for (const abort of [false, true]) {
    let finish;
    let active = true;
    const controller = new AbortController();
    const f = fixture(() => new Promise(resolve => { finish = resolve; }));
    const first = f.announce(f.args());
    const second = f.announce(f.args({ isActive: () => active, event: { signal: controller.signal } }));
    if (abort) controller.abort(); else active = false;
    finish({ ok: false });
    await Promise.all([first, second]);
    assert.equal(f.calls.length, 1);
  }
});

test('new turns, terminals, generations, epochs and speech kinds retain their own announcements', async () => {
  const f = fixture();
  for (const patch of [{}, { report: { turnId: 'next' } }, { report: { targetId: 'other' } },
    { report: { generation: 'new' } }, { epoch: 2 }, { event: { kind: 'task-result' } }]) {
    await f.announce(f.args(patch));
    assert.equal((await f.announce(f.args(patch))).status, 'duplicate');
  }
  assert.equal(f.calls.length, 6);
});

test('distinct failure explanations remain audible and exact repeated failures are suppressed', async () => {
  const f = fixture();
  for (const text of ['Pane: provider failed.', 'Pane: delivery failed.']) {
    const args = f.args({ report: { status: 'failed', text } });
    await f.announce(args);
    assert.equal((await f.announce(args)).status, 'duplicate');
  }
  assert.equal(f.calls.length, 2);
});

test('ambiguous, missing and unfinished attribution is never coalesced', async () => {
  for (const patch of [{ wait: { attributionAmbiguous: true } }, { report: { turnId: undefined } },
    { report: { targetId: undefined } }, { report: { generation: undefined } }, { wait: { done: false } }]) {
    const f = fixture();
    await f.announce(f.args(patch));
    await f.announce(f.args(patch));
    assert.equal(f.calls.length, 2);
  }
});

test('inactive requests never announce or consume another request speech', async () => {
  const f = fixture();
  const controller = new AbortController(); controller.abort();
  await f.announce(f.args({ isActive: () => false }));
  await f.announce(f.args({ event: { signal: controller.signal } }));
  assert.equal(f.calls.length, 0);
  await f.announce(f.args());
  assert.equal(f.calls.length, 1);
});

test('confirmed playback remains delivered when its request signal is subsequently aborted', async () => {
  let finish;
  const controller = new AbortController();
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const first = f.announce(f.args({ event: { signal: controller.signal } }));
  const second = f.announce(f.args({ event: { requestId: 'watch' } }));
  // The speech adapter's result determines whether playback actually completed.
  finish({ ok: true });
  controller.abort();
  await first;
  assert.equal((await second).status, 'duplicate');
  assert.equal(f.calls.length, 1);
});
