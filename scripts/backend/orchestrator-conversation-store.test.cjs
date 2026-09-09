const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createConversationStore, MAX_AGE, MAX_BYTES } = require('../../backend/orchestratorConversationStore.cjs');
const { createOrchestratorHistoryProcess } = require('../../backend/orchestratorHistoryProcess.cjs');
const { createOrchestratorHistory } = require('../../backend/orchestratorHistory.cjs');
function fixture(t, now = Date.now()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'orchestrator-conversation.json'), now, store: createConversationStore({ userDataPath: dir, now: () => now, getSecrets: () => ['private-token'] }) };
}
test('identical snapshots coalesce, committed snapshots skip IO, clear permits identical save', async t => {
  const { dir, now, store } = fixture(t); const original = fs.promises.writeFile; let writes = 0;
  fs.promises.writeFile = async (...args) => { if (String(args[0]).startsWith(dir)) writes++; return original(...args); };
  t.after(() => { fs.promises.writeFile = original; });
  const snapshot = { messages: [{ id: 'm', role: 'user', at: now, text: 'same' }] };
  const first = store.save(snapshot); assert.equal(store.save(snapshot), first); await first; await store.flush();
  await store.save(snapshot); assert.equal(writes, 1);
  await store.clear(); await store.save(snapshot); assert.equal(writes, 2); assert.equal(store.load().messages[0].text, 'same');
  await Promise.all([store.save({ messages: [{ id: 'm', role: 'user', at: now, text: 'changed' }] }), store.save(snapshot)]);
  assert.equal(writes, 4); assert.equal(store.load().messages[0].text, 'same');
});
test('failed writes never poison identical-save retry', async t => {
  const { dir, now, store } = fixture(t); const original = fs.promises.writeFile; let writes = 0;
  fs.promises.writeFile = async (...args) => { if (String(args[0]).startsWith(dir) && ++writes === 1) throw new Error('simulated write failure'); return original(...args); };
  t.after(() => { fs.promises.writeFile = original; });
  const snapshot = { messages: [{ id: 'm', role: 'user', at: now, text: 'retry' }] };
  await store.save(snapshot); await store.flush(); assert.equal(store.load().messages.length, 0);
  await store.save(snapshot); assert.equal(writes, 2); assert.equal(store.load().messages[0].text, 'retry');
});
test('redaction lookup failures skip writes and fail closed on load', async t => {
  const { dir, file, now } = fixture(t);
  const store = createConversationStore({ userDataPath: dir, getSecrets: () => { throw new Error('unavailable'); } });
  await store.save({ messages: [{ id: 'm', role: 'user', at: now, text: 'credential' }] }); assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, JSON.stringify({ messages: [{ id: 'm', role: 'user', at: now, text: 'credential' }] })); assert.deepEqual(store.load(), { messages: [], receipts: [], tasks: [] });
});
test('invalid required fields are removed and two instances use independent temporary files', async t => {
  const { dir, now, store } = fixture(t); const other = createConversationStore({ userDataPath: dir });
  const original = fs.promises.writeFile; const names = new Set();
  fs.promises.writeFile = async (...args) => { if (String(args[0]).startsWith(dir)) names.add(args[0]); return original(...args); };
  t.after(() => { fs.promises.writeFile = original; });
  await Promise.all([store.save({ messages: [{ at: now, text: 'missing id' }, { id: 'm', role: {}, text: 'bad', at: now }], tasks: [{ at: now }, { requestId: {}, status: 'running', at: now }] }), other.save({})]);
  assert.equal(names.size, 2); assert.deepEqual(store.load(), { messages: [], receipts: [], tasks: [] });
});
test('structured historical associations survive restart without executable state', async t => {
  const { store, now, file } = fixture(t);
  await store.save({ tasks: [{ id: 't', requestId: 't', at: now, status: 'waiting-results', sequence: 7, label: 'review', replyToRequestId: 'prior', targetIds: ['pane'], dependsOn: ['prior'], targets: [{ id: 'pane', generation: 3, cwd: 'C:/repo', name: 'private-token', grants: ['send'] }], question: { id: 'q', requestId: 't', text: 'private-token?', permission: true }, outcome: { status: 'sent', targetId: 'pane', text: 'private-token', actions: ['execute'] }, authorizedCommands: ['execute'], controller: { aborted: false } }] });
  const task = store.load().tasks[0]; assert.equal(task.status, 'paused'); assert.deepEqual(task.targetIds, ['pane']); assert.deepEqual(task.dependsOn, ['prior']); assert.equal(task.replyToRequestId, 'prior'); assert.equal(task.sequence, 7);
  assert.deepEqual(task.targets, [{ id: 'pane', generation: 3, cwd: 'C:/repo', name: '[redacted]' }]); assert.deepEqual(task.question, { id: 'q', requestId: 't', text: '[redacted]?' }); assert.deepEqual(task.outcome, { status: 'sent', text: '[redacted]', targetId: 'pane' });
  const raw = fs.readFileSync(file, 'utf8'); for (const forbidden of ['private-token', 'authorizedCommands', 'grants', 'controller', 'actions', 'permission']) assert.equal(raw.includes(forbidden), false);
});
test('confirmed creation cwd survives receipt persistence with ordinary redaction', async t => {
  const { store, now } = fixture(t);
  await store.save({ receipts: [{ id: 'r', kind: 'create_session', status: 'created', text: 'Action acknowledged.', at: now,
    cwd: 'C:/projects/private-token', name: 'C:/Windows/System32/powershell.exe', grant: { kind: 'create_session' } }] });
  assert.deepEqual(store.load().receipts, [{ id: 'r', kind: 'create_session', status: 'created', text: 'Action acknowledged.', at: now, cwd: 'C:/projects/[redacted]' }]);
});
test('automatic report identities survive restart without merging request-owned history or restoring authority', async t => {
  const { store, now, file } = fixture(t);
  const result = { role: 'system', origin: 'task-detail', reportKind: 'result', status: 'completed',
    targetId: 'pane', generation: 4, turnId: 'turn-private-token', actionId: 'delivery', at: now,
    text: 'The agent reported its result.' };
  await store.save({ messages: [
    { ...result, id: 'result-a', requestId: 'request-a', controller: { aborted: false }, grants: ['send_prompt'] },
    { ...result, id: 'result-b', requestId: 'request-b' },
    { ...result, id: 'missing', reportKind: 'result-unavailable', text: 'No details yet.' },
    { id: 'done', requestId: 'request-a', role: 'assistant', origin: 'voice', text: 'done', completionCue: true, at: now },
  ] });
  const messages = store.load().messages;
  assert.equal(messages.length, 4, 'the view can coalesce without deleting request-owned records');
  assert.deepEqual(messages.slice(0, 2).map(({ id, requestId, ...message }) => message), [0, 1].map(() => ({ ...result, turnId: 'turn-[redacted]' })));
  assert.equal(messages[2].reportKind, 'result-unavailable');
  assert.equal(messages[3].completionCue, true);
  const raw = fs.readFileSync(file, 'utf8');
  for (const forbidden of ['private-token', 'controller', 'grants']) assert.equal(raw.includes(forbidden), false);
});
test('clear fences an already writing snapshot and later saves remain usable', async t => {
  const { store, now, file } = fixture(t); const original = fs.promises.writeFile;
  let started; const entered = new Promise(resolve => { started = resolve; }); let release; const gate = new Promise(resolve => { release = resolve; });
  fs.promises.writeFile = async (...args) => { if (String(args[0]).startsWith(`${file}.`) && String(args[0]).endsWith('.tmp')) { started(); await gate; } return original(...args); };
  t.after(() => { fs.promises.writeFile = original; release(); });
  const writing = store.save({ messages: [{ id: 'm', role: 'user', at: now, text: 'old' }] }); await entered;
  const cleared = store.clear(); release(); await Promise.all([writing, cleared]); await store.flush();
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(`${file}.tmp`), false);
  fs.promises.writeFile = original; await store.save({ messages: [{ id: 'm', role: 'user', at: now, text: 'new' }] }); assert.equal(store.load().messages[0].text, 'new');
});
test('retention applies on load, rejects oversized/malformed files, and tolerates malformed snapshots', async t => {
  const { store, now, file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ messages: [{ id: 'm', role: 'user', at: now - MAX_AGE - 1, text: 'old' }, { id: 'm', role: 'user', at: now - MAX_AGE, text: 'boundary' }, { id: 'm', role: 'user', at: now + 60001, text: 'future' }, null, {}, { at: 'invalid' }] }));
  assert.deepEqual(store.load().messages.map(message => message.text), ['boundary']);
  fs.writeFileSync(file, 'x'.repeat(MAX_BYTES + 1)); assert.equal(store.load().messages.length, 0);
  for (const value of [null, 42, { messages: {}, tasks: [null, false, { at: now, targets: [null, { id: 'valid', secret: 'oops' }], dependsOn: [null, 'a'] }] }]) { await store.save(value); assert.ok(Array.isArray(store.load().tasks)); }
});
test('snapshot projects context, redacts secrets, expires old data, and pauses unfinished tasks', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now(); const store = createConversationStore({ userDataPath: dir, now: () => now, getSecrets: () => ['secret-token'] });
  await store.save({ messages: [{ id: 'a', at: now, text: 'hello secret-token', role: 'user', apiKey: 'oops' }, { id: 'm', role: 'user', at: now - MAX_AGE - 1, text: 'old' }], tasks: [{ id: 't', requestId: 't', at: now, status: 'running', instruction: 'hello', grants: ['execute'], controller: {} }], receipts: [] });
  const loaded = store.load(); assert.equal(loaded.messages.length, 1); assert.equal(loaded.messages[0].text, 'hello [redacted]'); assert.equal(loaded.messages[0].apiKey, undefined);
  assert.equal(loaded.tasks[0].status, 'paused'); assert.equal(loaded.tasks[0].grants, undefined);
  store.save({ messages: [{ id: 'm', role: 'user', at: now, text: 'pending' }] }); await store.clear(); await store.flush(); assert.deepEqual(store.load(), { messages: [], receipts: [], tasks: [] });
  fs.writeFileSync(path.join(dir, 'orchestrator-conversation.json'), '{partial'); assert.equal(store.load().messages.length, 0);
  await store.save({ messages: Array.from({ length: 190 }, (_, i) => ({ role: 'user', at: now, id: String(i), text: 'x'.repeat(64000) })) });
  assert.ok(fs.statSync(path.join(dir, 'orchestrator-conversation.json')).size <= MAX_BYTES); assert.ok(store.load().messages.length < 190);
});
test('helper restart refreshes cached exact identity; unknown refs never reach helper', async () => {
  const children = []; const calls = [];
  const fork = () => { const child = new EventEmitter(); children.push(child); child.kill = () => { child.exitCode = 0; }; child.send = message => {
    calls.push(message); const result = message.method === 'list' ? { conversations: [{ reference: 'opaque', id: 'native-1', provider: 'codex', cwd: process.cwd(), title: 'duplicate' }] } : message.method === 'refresh' ? { reference: 'fresh' } : { status: 'found' };
    queueMicrotask(() => child.emit('message', { id: message.id, result }));
  }; return child; };
  const service = createOrchestratorHistoryProcess({ fork });
  await service.list({}); children[0].emit('exit');
  await service.read({ reference: 'opaque' });
  assert.equal(calls.find(call => call.method === 'refresh').input.id, 'native-1'); assert.equal(calls.at(-1).input.reference, 'fresh');
  const count = calls.length; await assert.rejects(service.read({ reference: 'forged' }), { code: 'HISTORY_NEEDS_LIST' }); assert.equal(calls.length, count);
  children[1].emit('exit'); await assert.rejects(service.read({ reference: 'opaque', cursor: 'old' }), { code: 'HISTORY_CURSOR_EXPIRED' });
  service.dispose();
});
test('refresh refuses same-title substitutes and keeps original app-owned scope', async () => {
  const seen = []; let threads = [{ id: 'different', title: 'duplicate' }];
  const history = createOrchestratorHistory({ lookupThreads: input => { seen.push(input); return { status: 'found', threads }; } });
  const identity = { provider: 'openfusion', openFusion: true, cwd: process.cwd(), id: 'original', title: 'duplicate' };
  await assert.rejects(history.refresh(identity), /original store/);
  threads.push({ id: 'original', title: 'renamed' }); const refreshed = await history.refresh(identity);
  const resolved = await history.resolve(refreshed.reference); assert.equal(resolved.id, 'original'); assert.equal(resolved.title, 'renamed');
  assert.ok(seen.every(input => input.openFusion === true && input.cwd === identity.cwd));
});
test('changing trusted store binding requires fresh listing before any read', async () => {
  let home = 'one'; const calls = [];
  const service = createOrchestratorHistoryProcess({ getConfig: () => ({ homes: { claudeCustom: home } }), fork: () => {
    const child = new EventEmitter(); child.kill = () => {}; child.send = message => { calls.push(message); queueMicrotask(() => child.emit('message', { id: message.id, result: { conversations: [{ reference: 'r', id: 'same', provider: 'claude-custom', cwd: process.cwd() }] } })); }; return child;
  } });
  await service.list({}); home = 'two'; await assert.rejects(service.read({ reference: 'r' }), { code: 'HISTORY_NEEDS_LIST' }); assert.equal(calls.length, 1); service.dispose();
});
