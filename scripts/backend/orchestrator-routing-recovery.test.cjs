'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRoutingRegistry } = require('../../backend/orchestratorRouting.cjs');
function fixture() {
  const registry = createRoutingRegistry();
  const { reservationId: id } = registry.reserve({ requestId: 'r', workItemId: 'w', decision: 'create' });
  return { registry, id, receipt: { id: 'pane', actionId: 'create-1', launchToken: 3, status: 'launch-timeout' }, session: { id: 'pane', generation: 'g', launchToken: 3, provider: 'codex', cwd: 'C:/repo', conversation: { id: 'native' } } };
}
test('known timeout creation recovers exact live pane once without changing later delivery uncertainty', () => {
  const { registry, id, receipt, session } = fixture();
  registry.mark(id, 'uncertain'); assert.equal(registry.recordCreation(id, receipt).ok, true);
  const recovered = registry.recoverCreation(id, session); assert.equal(recovered.status, 'bound'); assert.equal(recovered.reservation.nativeIdentity.id, 'native');
  registry.mark(id, 'unknown'); const repeated = registry.recoverCreation(id, session);
  assert.equal(repeated.reused, true); assert.equal(repeated.status, 'unknown');
});
test('recorded creation pane, launch and generation cannot be replaced', () => {
  const { registry, id, receipt, session } = fixture();
  receipt.target = { id: 'pane', generation: 'g', launchToken: 3 };
  assert.equal(registry.recordCreation(id, receipt).ok, true);
  for (const replacement of [{ id: 'different' }, { launchToken: 4 }, { actionId: 'create-2' }, { target: { id: 'pane', generation: 'new', launchToken: 3 } }]) assert.equal(registry.recordCreation(id, { ...receipt, ...replacement }).ok, false);
  for (const replacement of [{ id: 'different' }, { launchToken: 4 }, { generation: 'new' }, { generation: undefined }]) assert.equal(registry.recoverCreation(id, { ...session, ...replacement }).ok, false);
  assert.equal(registry.recoverCreation(id, session).ok, true);
});
test('creation receipts whitelist bounded metadata and require action identity', () => {
  const { registry, id, receipt } = fixture();
  assert.equal(registry.recordCreation(id, { ...receipt, actionId: undefined }).ok, false);
  assert.equal(registry.recordCreation('missing', receipt).ok, false);
  assert.equal(registry.recordCreation(id, { ...receipt, id: undefined }).ok, false);
  registry.recordCreation(id, { ...receipt, prompt: 'secret', grant: { executable: true }, target: { id: 'pane', generation: 'g', payload: 'secret' }, status: 'x'.repeat(1000) });
  const creation = registry.get(id).creation;
  assert.deepEqual(Object.keys(creation).sort(), ['actionId', 'id', 'launchToken', 'status', 'target']);
  assert.equal(creation.status.length, 80); assert.equal(creation.target.payload, undefined);
  assert.equal(registry.recordCreation(id, { ...receipt, target: { id: 'pane', generation: 'g' }, status: 'changed' }).reused, true);
  assert.equal(registry.get(id).creation.status.length, 80);
});
