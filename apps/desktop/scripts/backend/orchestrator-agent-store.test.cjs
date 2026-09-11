'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createAgentStore } = require('../../backend/orchestratorAgentStore.cjs');
const { createAgentDirectory } = require('../../backend/orchestratorAgents.cjs');
const { agent } = require('./orchestrator-agent-fixtures.cjs');
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-agent-store-'));
  const store = createAgentStore({ userDataPath: root, ...options });
  t.after(async () => { await store.flush(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, file: path.join(root, 'orchestrator-agents-v1.json') };
}
const note = (op = 'op-one', body = 'Investigate authentication before proposing a fix.') => ({ agentId: 'a', kind: 'finding', body, operationId: op });
const scope = { requestId: 'request-one', knownAgent: true };

test('notes are durable before success, inferred and scoped; replays cannot change their content', async t => {
  const { store, root, file } = fixture(t);
  const saved = await store.write(note(), scope);
  assert.equal(saved.note.provenance, 'orchestrator-inference');
  assert.equal(JSON.parse(fs.readFileSync(file)).notes[0].id, saved.note.id);
  assert.equal((await store.write(note(), scope)).note.id, saved.note.id);
  await assert.rejects(store.write(note('op-one', 'Changed'), scope), /cannot change/);
  const reopened = createAgentStore({ userDataPath: root });
  assert.equal(reopened.list({ agentId: 'a' }).total, 1);
  assert.equal(reopened.list({ agentId: 'other' }).total, 0);
  assert.equal(reopened.list().notes[0].id, saved.note.id);
});

test('concurrent edits serialize and stale revision cannot erase another finding', async t => {
  const { store } = fixture(t), saved = await store.write(note(), scope);
  const edits = await Promise.allSettled(['one', 'two'].map(value => store.write({ ...note(`edit-${value}`, value), id: saved.note.id, expectedRevision: 1 }, scope)));
  assert.equal(edits.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(edits.filter(x => x.status === 'rejected').length, 1);
  assert.equal(store.list().notes[0].revision, 2);
});

test('forged provenance, runtime patches, unknown owners and cross-agent edits are rejected', async t => {
  const { store } = fixture(t);
  await assert.rejects(store.write({ ...note(), provenance: 'observed' }, scope));
  await assert.rejects(store.write({ ...note(), status: 'done' }, scope));
  await assert.rejects(store.write(note(), { requestId: 'r' }));
  const saved = await store.write(note(), scope);
  await assert.rejects(store.write({ ...note('edit'), id: saved.note.id, agentId: 'b', expectedRevision: 1 }, scope), /scope/);
  assert.equal(store.list().total, 1);
});

test('redaction occurs before persistence and redaction failure refuses mutation', async t => {
  const { store, file } = fixture(t, { getSecrets: () => ['PRIVATE_TEST_SECRET'] });
  await store.write(note('op', 'Found PRIVATE_TEST_SECRET in output.'), scope);
  assert.equal(fs.readFileSync(file, 'utf8').includes('PRIVATE_TEST_SECRET'), false);
  const bad = fixture(t, { getSecrets: () => undefined });
  await assert.rejects(bad.store.write(note(), scope), /redaction/);
  assert.equal(bad.store.list().total, 0);
});

test('commit failure never returns saved or updates the in-memory note', async t => {
  const { store, file } = fixture(t, { fsImpl: { ...fs.promises, rename: async () => { throw new Error('ENOSPC fixture'); } } });
  await assert.rejects(store.write(note(), scope), /ENOSPC/);
  assert.equal(store.list().total, 0); assert.equal(fs.existsSync(file), false);
});

test('a valid backup recovers corruption and unknown newer schemas stay read-only', async t => {
  const { store, root, file } = fixture(t);
  await store.write(note('first'), scope); await store.write(note('second'), scope);
  fs.writeFileSync(file, '{partial');
  const recovered = createAgentStore({ userDataPath: root });
  assert.equal(recovered.status().status, 'recovered-backup'); assert.equal(recovered.list().total, 1);
  await recovered.write(note('recovered'), scope);
  fs.writeFileSync(file, JSON.stringify({ version: 2 }));
  const newer = createAgentStore({ userDataPath: root });
  assert.equal(newer.status().writable, false);
  await assert.rejects(newer.write(note(), scope), /read-only/);
  assert.equal(JSON.parse(fs.readFileSync(file)).version, 2);
});

test('limits refuse new notes without dropping existing unresolved records', async t => {
  const { store } = fixture(t, { maxAgentBytes: 600 });
  await store.write(note('one', 'A'.repeat(150)), scope);
  await assert.rejects(store.write(note('two', 'B'.repeat(300)), scope), /limit/);
  assert.equal(store.list().total, 1);
});

test('identity migration is idempotent and restoring never resolves a live run', async t => {
  const { store, root } = fixture(t), directory = createAgentDirectory();
  const original = directory.reconcile([agent()])[0];
  const identity = directory.exportIdentities();
  await store.syncIdentities(identity); const revision = store.status().revision;
  await store.syncIdentities(identity); assert.equal(store.status().revision, revision);
  const restored = createAgentDirectory({ restored: createAgentStore({ userDataPath: root }).identities() });
  assert.equal(restored.resolve(original.agentId), null);
  assert.equal(restored.get(original.agentId).identity.state, 'archived');
  assert.equal(restored.reconcile([agent('worker', { generation: 'resumed', launchToken: 2 })])[0].agentId, original.agentId);
});

test('clear queues after prior writes and removes notes without removing identities', async t => {
  const { store, file } = fixture(t), directory = createAgentDirectory(); directory.reconcile([agent()]);
  await store.syncIdentities(directory.exportIdentities());
  const pending = store.write(note(), scope), cleared = store.clearNotes();
  await pending; await cleared;
  assert.equal(store.list().total, 0); assert.equal(store.identities().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file)).notes.length, 0);
});
