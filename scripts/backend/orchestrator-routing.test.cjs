'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkItemStore, MAX_BYTES } = require('../../backend/orchestratorWorkItems.cjs');
const { createRoutingRegistry, proposeRoutingCandidates, sessionIdentity, matchesBinding } = require('../../backend/orchestratorRouting.cjs');
const session = { id: 'pane', generation: 'g1', launchToken: 1, provider: 'codex', cwd: 'C:/project', conversationId: 'thread1', observation: 'observed', processState: 'running', turnState: 'completed' };
function fixture(t, options = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-routing-'));
  const store = createWorkItemStore({ userDataPath, ...options });
  t.after(async () => { await store.flush(); assert.equal(path.dirname(path.resolve(userDataPath)), path.resolve(os.tmpdir())); assert.ok(path.basename(userDataPath).startsWith('vibe-routing-')); fs.rmSync(userDataPath, { recursive: true, force: true }); });
  return { store, userDataPath };
}
test('concurrent creation reservations deduplicate one work item while preserving original request owner', async () => {
  const registry = createRoutingRegistry();
  const [a, b] = await Promise.all(['a', 'b'].map(requestId => Promise.resolve().then(() => registry.reserve({ requestId, workItemId: 'work', decision: 'create' }))));
  assert.equal(a.id, b.id); assert.equal(b.reused, true); assert.equal(b.requestId, 'a'); assert.equal(registry.snapshot().length, 1);
  const clone = registry.get(a.id); clone.status = 'bad'; assert.equal(registry.get(a.id).status, 'reserved');
});
test('unrelated work cannot share pane generation or native conversation through another pane', () => {
  const registry = createRoutingRegistry();
  const input = { requestId: 'a', workItemId: 'a', decision: 'reuse', target: session, nativeIdentity: sessionIdentity(session) };
  assert.equal(registry.reserve(input).ok, true);
  assert.equal(registry.reserve({ ...input, requestId: 'b', workItemId: 'b' }).status, 'owned-by-other-work');
  assert.equal(registry.reserve({ ...input, requestId: 'b', workItemId: 'b', target: { ...session, id: 'other' } }).status, 'owned-by-other-work');
});
test('request A, request B, reply A use explicit historical associations, never titles', t => {
  const { store } = fixture(t);
  const a = store.create({ requestId: 'request-a', title: 'same' });
  store.create({ requestId: 'request-b', title: 'same' });
  store.bind(a.id, { target: session, nativeIdentity: sessionIdentity(session), evidence: { source: 'receipt' } });
  store.associateRequest(a.id, 'reply-a');
  assert.equal(proposeRoutingCandidates({ sessions: [session], store, requestId: 'request-b' }).candidates.length, 0);
  assert.equal(proposeRoutingCandidates({ sessions: [session], store, requestId: 'reply-a' }).candidates[0].id, 'pane');
  assert.equal(proposeRoutingCandidates({ sessions: [session], store, replyToRequestId: 'request-a' }).workItemId, a.id);
  const clone = store.get(a.id); clone.requestIds.push('fake'); assert.equal(store.findByRequest('fake'), undefined);
});
test('restart restores only revalidation hints, stripping executable state and redacting secrets', async t => {
  const { store, userDataPath } = fixture(t, { getSecrets: () => ['secret-value'] });
  const item = store.create({ requestId: 'r', objective: 'secret-value task', grant: { kind: 'send_prompt' } });
  store.bind(item.id, { target: session, nativeIdentity: sessionIdentity(session), evidence: { source: 'receipt', summary: 'secret-value' } });
  await store.flush();
  const raw = fs.readFileSync(path.join(userDataPath, 'orchestrator-work-items.json'), 'utf8');
  assert.ok(!raw.includes('secret-value')); assert.ok(!raw.includes('send_prompt'));
  const restored = createWorkItemStore({ userDataPath }).get(item.id);
  assert.equal(restored.requiresRevalidation, true);
  assert.equal(createRoutingRegistry().snapshot().length, 0);
  assert.equal(proposeRoutingCandidates({ sessions: [session], workItem: restored }).candidates[0].requiresRevalidation, true);
});
test('same-generation native conversation replacement and missing identity never match', () => {
  const binding = { target: session, nativeIdentity: sessionIdentity(session) };
  assert.equal(matchesBinding(binding, session), true);
  assert.equal(matchesBinding(binding, { ...session, conversationId: 'thread2' }), false);
  assert.equal(matchesBinding(binding, { ...session, conversationId: undefined }), false);
  assert.equal(matchesBinding({ target: session }, session), false);
  assert.equal(matchesBinding(binding, { ...session, generation: 'g2' }), false);
  const registry = createRoutingRegistry();
  const reservation = registry.reserve({ requestId: 'r', workItemId: 'w', decision: 'reuse', ...binding });
  assert.equal(registry.bind(reservation.id, { target: { ...session, generation: 'g2' }, nativeIdentity: binding.nativeIdentity }).status, 'binding-changed');
  assert.equal(registry.reconcile([{ ...session, conversationId: undefined }])[0].status, 'uncertain');
  assert.equal(registry.snapshot().length, 1);
  assert.equal(registry.reconcile([{ ...session, conversationId: 'thread2' }])[0].status, 'invalidated');
  assert.equal(registry.snapshot().length, 0);
});
test('capacity blocks explicitly; completed and unsent cancellation release; uncertainty stays reserved', () => {
  const registry = createRoutingRegistry({ maxAssignments: 1 });
  const make = workItemId => registry.reserve({ requestId: workItemId, workItemId, decision: 'create' });
  const a = make('a'); assert.equal(make('b').status, 'capacity');
  assert.equal(registry.release(a.id, { status: 'cancelled' }), true);
  const b = make('b'); registry.mark(b.id, 'unknown'); assert.equal(registry.release(b.id), false);
  assert.equal(registry.release(b.id, { status: 'cancelled' }), false);
  assert.equal(make('c').status, 'capacity');
  registry.mark(b.id, 'completed'); assert.equal(registry.release(b.id), true); assert.equal(make('c').ok, true);
});
test('bounded persistence excludes arbitrary nested objects and caps string content', async t => {
  const { store, userDataPath } = fixture(t);
  const item = store.create({ objective: 'x'.repeat(MAX_BYTES * 2), dispatchPlan: { dangerous: true } });
  assert.equal(item.objective.length, 16000, 'Task objectives retain the full supported user instruction, while remaining bounded');
  await store.flush();
  const file = path.join(userDataPath, 'orchestrator-work-items.json'); assert.ok(fs.statSync(file).size <= MAX_BYTES);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items[0].dispatchPlan, undefined);
});

test('constraints beyond the summary budget survive task history restoration', async t => {
  const { store, userDataPath } = fixture(t);
  const objective = `Review the changes. ${'Context. '.repeat(400)}Do not edit files or commit anything.`;
  const item = store.create({ cwd: 'C:\\Project', objective, requestId: 'request-long' });
  await store.flush();
  const restored = createWorkItemStore({ userDataPath });
  assert.equal(restored.get(item.id).objective, objective);
  assert.equal(restored.get(item.id).requiresRevalidation, true);
});
test('finite numeric generations survive binding, persistence and fresh identity matching', async t => {
  const { store, userDataPath } = fixture(t);
  const item = store.create({ requestId: 'numeric' });
  const numeric = { ...session, generation: 0 };
  store.bind(item.id, { target: numeric, nativeIdentity: sessionIdentity(numeric) });
  await store.flush();
  const restored = createWorkItemStore({ userDataPath }).get(item.id);
  assert.equal(restored.binding.target.generation, 0);
  assert.equal(matchesBinding(restored.binding, numeric), true);
  assert.equal(store.bind(item.id, { target: { ...session, generation: Infinity } }), null);
});
test('lookup normalizes Windows cwd and searches objective and original text', t => {
  const { store } = fixture(t);
  const item = store.create({ cwd: 'C:\\Work\\Project\\', objective: 'Repair billing', text: 'retain invoices' });
  assert.equal(store.list({ cwd: 'c:/work/project', query: 'billing' })[0].id, item.id);
  assert.equal(store.list({ cwd: 'c:/work/project', query: 'invoices' })[0].id, item.id);
  assert.equal(store.list({ cwd: 'c:/different', query: 'billing' }).length, 0);
});
test('malformed mutations return null without corrupting existing records', t => {
  const { store } = fixture(t);
  const item = store.create({ requestId: 'r', objective: 'original' });
  for (const patch of [null, [], { requestIds: 'bad' }, { requestIds: {} }]) assert.equal(store.update(item.id, patch), null);
  for (const input of [null, [], { requestIds: 'bad' }, { id: 45 }]) assert.equal(store.create(input), null);
  assert.equal(store.findByRequest('r').objective, 'original');
  assert.equal(store.snapshot().items.length, 1);
});
test('clear fences queued and in-flight writes, then permits new history', async t => {
  const { store, userDataPath } = fixture(t);
  const write = fs.promises.writeFile;
  let started, resume;
  const entering = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { resume = resolve; });
  fs.promises.writeFile = async (...args) => { if (String(args[0]).startsWith(path.join(userDataPath, 'orchestrator-work-items.json'))) { started(); await blocked; } return write.apply(fs.promises, args); };
  try {
    store.create({ objective: 'old-first' });
    await entering;
    store.create({ objective: 'old-queued' });
    const clearing = store.clear();
    assert.equal(store.snapshot().items.length, 0);
    resume(); await clearing; await store.flush();
    assert.equal(fs.existsSync(path.join(userDataPath, 'orchestrator-work-items.json')), false);
    store.create({ objective: 'new-only' }); await store.flush();
    assert.deepEqual(createWorkItemStore({ userDataPath }).list().map(i => i.objective), ['new-only']);
  } finally { resume(); fs.promises.writeFile = write; }
});
test('same work item rejects conflicting reservation scope instead of silently reusing', () => {
  const registry = createRoutingRegistry();
  const input = { requestId: 'r', workItemId: 'w', decision: 'reuse', cwd: 'C:\\Project', kindOfSession: 'codex', target: session, nativeIdentity: sessionIdentity(session) };
  const first = registry.reserve(input);
  assert.equal(registry.reserve({ ...input, requestId: 'reply', cwd: 'c:/project/' }).id, first.id);
  for (const patch of [{ cwd: 'C:/Other' }, { kindOfSession: 'claude' }, { target: { ...session, generation: 'g2' } }, { target: { ...session, launchToken: 2 } }, { nativeIdentity: { ...sessionIdentity(session), id: 'other' } }]) {
    assert.equal(registry.reserve({ ...input, ...patch }).status, 'reservation-conflict');
  }
  assert.equal(registry.snapshot().length, 1);
});
