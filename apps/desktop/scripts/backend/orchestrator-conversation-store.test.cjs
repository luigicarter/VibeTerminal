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

test('continuation history restores disposition and lineage without executable recovery authority', async t => {
  const { store, now } = fixture(t);
  await store.save({ tasks: [
    { requestId: 'failed', status: 'failed', error: 'Discovery failed', updatedAt: now, controlDisposition: 'transferred', continuedByRequestId: 'next', resultScopeTransferred: true, controlRevision: 7, pendingCommand: { grants: ['unsafe'] } },
    { requestId: 'clarified', status: 'continued', updatedAt: now, controlDisposition: 'transferred', continuedByRequestId: 'next' },
    { requestId: 'next', status: 'running', updatedAt: now, continuedFromRequestId: 'failed', controlDisposition: 'active', unboundCreation: true }
  ] });
  const [failed, clarified, next] = store.load().tasks;
  assert.equal(failed.status, 'failed'); assert.equal(failed.resultScopeTransferred, true);
  assert.equal(failed.continuedByRequestId, 'next'); assert.equal(failed.pendingCommand, undefined); assert.equal(failed.controlRevision, undefined);
  assert.equal(clarified.status, 'continued'); assert.equal(next.status, 'paused');
  assert.equal(next.continuedFromRequestId, 'failed'); assert.equal(next.unboundCreation, undefined);
});

test('close receipts retain bounded identity and observed outcomes, excluding raw scope and executable fields', async t => {
  const { store, now, file } = fixture(t);
  const close = { operationId: 'close-private-token', target: { id: 'pane', generation: 0, launchToken: 4, kind: 'codex', name: 'private target prose', grant: { close: true } },
    pane: 'removed', process: 'stopped', launchSettled: true, verifiedAt: now,
    targetCount: 8, verifiedTargetCount: 7, remainingTargetCount: 1, newTargetCount: 2, supersededTargetCount: 0, scopeEmpty: false,
    error: 'private error prose', text: 'private response prose', scope: { type: 'all' }, grants: ['executable'], authorization: 'private-token' };
  await store.save({ receipts: [{ id: 'receipt', kind: 'close', status: 'closed', text: 'Recorded close.', at: now,
    actionId: 'action-private-token', grantId: 'grant', launchToken: 4, close }] });
  const [receipt] = store.load().receipts;
  assert.equal(receipt.actionId, 'action-[redacted]'); assert.equal(receipt.grantId, 'grant'); assert.equal(receipt.launchToken, 4);
  assert.deepEqual(receipt.close, { operationId: 'close-[redacted]', target: { id: 'pane', kind: 'codex', generation: 0, launchToken: 4 },
    pane: 'removed', process: 'stopped', launchSettled: true, scopeEmpty: false, verifiedAt: now,
    targetCount: 8, verifiedTargetCount: 7, remainingTargetCount: 1, newTargetCount: 2, supersededTargetCount: 0 });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /private-token|private target prose|private error prose|private response prose|executable|authorization/);
});

test('invalid close evidence cannot become success and old receipts gain no invented proof', async t => {
  const { store, now } = fixture(t);
  await store.save({ receipts: [
    { id: 'old', kind: 'close', status: 'close_requested', text: 'Requested', at: now },
    { id: 'bad', kind: 'close', status: 'closed', text: 'Claimed', at: now, actionId: 123, grantId: true, launchToken: -1,
      close: { operationId: 'a'.repeat(2000), target: { id: 'b'.repeat(2000), generation: -1, launchToken: 0.5 }, pane: 'success', process: 'complete', launchSettled: 'yes',
        verifiedAt: now + 120000, remainingTargetCount: -1, newTargetCount: 20001, scopeEmpty: 'yes', raw: 'ignored' } },
    { id: 'other', kind: 'send_prompt', status: 'written', text: 'Sent', at: now, close: { pane: 'removed' } }
  ] });
  const [old, bad, other] = store.load().receipts;
  assert.equal(old.close, undefined); assert.equal(other.close, undefined);
  assert.equal(bad.actionId, undefined); assert.equal(bad.grantId, undefined); assert.equal(bad.launchToken, undefined);
  assert.deepEqual(bad.close, { operationId: 'a'.repeat(256), target: { id: 'b'.repeat(256) } });
});

test('restoring contradictory historical success pauses it without rewriting content or granting retry authority', async t => {
  const { store, now, file } = fixture(t);
  const messages = [{ id: 'message', role: 'assistant', text: 'The historical answer stays unchanged.', at: now }];
  const snapshot = { messages, tasks: [
    { requestId: 'normal', status: 'finished', updatedAt: now, text: 'A normal control completed.' },
    ...['finished', 'completed'].map(status => ({ requestId: status, status, controlDisposition: 'completed', updatedAt: now,
      text: 'Investigate the issue.', summary: 'Original historical summary.', error: 'Routing discovery failed.',
      grants: [{ kind: 'delegate_task' }], pendingCommand: { instruction: 'Execute this' }, executionAuthority: true })),
    { requestId: 'blank-error', status: 'finished', error: '  ', updatedAt: now }
  ] };
  await store.save(snapshot);
  const before = fs.readFileSync(file, 'utf8');
  const restored = store.load();
  assert.equal(restored.tasks[0].status, 'finished');
  for (const item of restored.tasks.slice(1, 3)) {
    assert.equal(item.status, 'paused'); assert.equal(item.phase, 'paused');
    assert.equal(item.error, 'Routing discovery failed.'); assert.equal(item.text, 'Investigate the issue.');
    assert.equal(item.summary, 'Original historical summary.'); assert.equal(item.controlDisposition, undefined);
    assert.equal(item.grants, undefined); assert.equal(item.pendingCommand, undefined); assert.equal(item.executionAuthority, undefined);
  }
  assert.equal(restored.tasks[3].status, 'finished');
  assert.deepEqual(restored.messages, messages);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'load projects conservatively without rewriting the stored transcript');
  assert.equal(JSON.parse(before).tasks[1].status, 'finished', 'save does not retrospectively reinterpret live status');
});
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
test('records saved by an older dual-harness build load and resume on the single agent harness', async t => {
  const { store, now, file, dir } = fixture(t);
  // Written the way an older build wrote it, including the retired marker.
  fs.writeFileSync(file, JSON.stringify({ tasks: [
    { id: 'old', requestId: 'old', status: 'running', harnessVersion: 'legacy', text: 'Fix checkout.', origin: 'text', sequence: 1, updatedAt: now },
    { id: 'newer', requestId: 'newer', status: 'waiting-results', harnessVersion: 'agents-v1', text: 'Review search.', origin: 'text', sequence: 2, updatedAt: now } ] }));
  const loaded = store.load();
  assert.deepEqual(loaded.tasks.map(task => task.requestId), ['old', 'newer']);
  for (const task of loaded.tasks) assert.equal(Object.hasOwn(task, 'harnessVersion'), false, 'no restored record can select a harness generation');
  assert.deepEqual(loaded.tasks.map(task => task.status), ['paused', 'paused']);
  assert.equal(loaded.tasks[0].text, 'Fix checkout.');

  const { createOrchestrator } = require('../../backend/orchestrator.cjs');
  const bodies = [];
  const app = createOrchestrator({ userDataPath: dir, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => [], getRoots: () => ({ documents: dir, projects: [] }),
    interpretIntent: () => ({ goal: 'Continue the restored request.', actions: [] }),
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] }));
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Restored request acknowledged.' } }] }));
    } });
  t.after(async () => { await app.dispose(); });
  await app.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true });
  assert.equal((await app.setEnabled(true)).ok, true);
  assert.deepEqual(app.getState().tasks.map(task => task.requestId), ['old', 'newer']);
  assert.equal(Object.hasOwn(app.getState(), 'harnessVersion'), false);
  const resumed = await app.send({ text: 'Continue the restored request.', origin: 'text', replyToRequestId: 'old' });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.ok(bodies.length, 'the restored request reaches the executor');
  // Named workspace tools and the agent system contract are the agents-v1 shape;
  // the retired single `workspace` tool would appear here instead.
  assert.equal(bodies[0].tools.some(item => item.function.name === 'workspace'), false);
  assert.ok(bodies[0].tools.some(item => item.function.name === 'find_agents'));
  assert.ok(bodies[0].tools.some(item => item.function.name === 'respond'));
  assert.match(bodies[0].messages[0].content, /find_agents/);
  assert.equal(JSON.parse(bodies[0].messages[1].content).sessionDirectory.unaddressedOmitted, true);
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
