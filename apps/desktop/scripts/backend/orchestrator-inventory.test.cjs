'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createInventoryRefresh } = require('../../backend/orchestratorInventory.cjs');
const tick = () => new Promise(setImmediate);
function fixture() {
  const pending = [], applied = [];
  const reader = createInventoryRefresh({ read: () => new Promise(resolve => pending.push(resolve)), apply: result => applied.push(result.value) });
  return { reader, pending, applied };
}
test('simultaneous inventory consumers share a single read', async () => {
  const f = fixture(); const a = f.reader.refresh(), b = f.reader.refresh(); await tick();
  assert.strictEqual(a, b); assert.equal(f.pending.length, 1);
  f.pending[0]({ ok: true, value: 'snapshot' }); await Promise.all([a, b]); assert.deepEqual(f.applied, ['snapshot']);
});
test('post-mutation inventory never reuses or applies a pre-mutation result', async () => {
  for (const olderFirst of [false, true]) {
    const f = fixture(); const a = f.reader.refresh(); await tick(); f.reader.invalidate();
    const b = f.reader.refresh(); await tick();
    if (olderFirst) { f.pending[0]({ ok: true, value: 'old' }); await tick(); }
    f.pending[1]({ ok: true, value: 'new' }); await b;
    if (!olderFirst) f.pending[0]({ ok: true, value: 'old' });
    assert.equal((await a).value, 'new'); assert.deepEqual(f.applied, ['new']); assert.equal(f.pending.length, 2);
  }
});
