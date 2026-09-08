const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { lookupGrokThread, readGrokConversation, replayGrokUpdates } = require('../../backend/grokThreads.cjs');
const { createOrchestratorHistory } = require('../../backend/orchestratorHistory.cjs');
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-grok-g3-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, cwd: path.join(home, 'workspace') };
}
async function session(f, id = ID, patch = {}, cwdDir) {
  const directory = path.join(f.home, 'sessions', cwdDir || encodeURIComponent(f.cwd), id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify({ info: { id, cwd: f.cwd }, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z', session_summary: 'Opening prompt', generated_title: 'Saved title', num_messages: 1, current_model_id: 'grok-code', ...patch }));
  return directory;
}
function update(type, text, meta = {}, eventId, method = 'session/update', more = {}) {
  return { method, params: { sessionId: ID, update: { sessionUpdate: type, content: { type: 'text', text }, _meta: meta, ...more }, ...(eventId ? { _meta: { eventId } } : {}) } };
}
const jsonl = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';
test('Grok lists named/preview roots, confirms exact identity, rejects guessing and filters children', async t => {
  const f = await fixture(t);
  await session(f);
  let result = await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f);
  assert.equal(result.rootVerified, true);
  assert.equal(result.threadRef.titleSource, 'generated');
  await session(f, ID, { title_is_manual: true });
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f)).threadRef.titleSource, 'named');
  await session(f, OTHER, { generated_title: null });
  assert.equal((await lookupGrokThread({ cwd: f.cwd }, f)).status, 'ambiguous');
  assert.equal((await lookupGrokThread({ cwd: f.cwd, list: true }, f)).threads.find(thread => thread.id === OTHER).titleSource, 'preview');
  await session(f, OTHER, { parent_session_id: ID, session_kind: 'subagent', hidden: false });
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: OTHER }, f)).rootVerified, false);
  await session(f, OTHER, { parent_session_id: ID, session_kind: 'fork' });
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: OTHER }, f)).rootVerified, true);
  assert.equal((await lookupGrokThread({ cwd: path.join(f.home, 'foreign'), confirmId: ID }, f)).rootVerified, false);
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: '../escape' }, f)).status, 'missing');
  assert.equal((await lookupGrokThread({ cwd: f.cwd, after: Date.now() }, f)).status, 'pending');
});

test('a canonicalized ancestor alias permits ordinary stores but not symlinked store roots', async t => {
  const f = await fixture(t);
  const actual = path.join(f.home, 'actual'), alias = path.join(f.home, 'alias');
  await fs.mkdir(actual);
  await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const store = { ...f, home: path.join(actual, 'store') };
  const directory = await session(store);
  await fs.writeFile(path.join(directory, 'updates.jsonl'), jsonl([update('user_message_chunk', 'Question'), update('agent_message_chunk', 'Answer')]));
  const aliasHome = path.join(alias, 'store');
  const result = await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, { home: aliasHome });
  assert.equal(result.rootVerified, true);
  assert.deepEqual((await readGrokConversation({ cwd: f.cwd, id: ID }, { home: aliasHome })).messages.map(item => item.text), ['Question', 'Answer']);
  if (process.platform === 'win32') assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, { home: aliasHome.toUpperCase() })).rootVerified, true);
  const linkedRoot = path.join(f.home, 'linked-root');
  await fs.symlink(store.home, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, { home: linkedRoot })).rootVerified, false);
});
test('native required Summary fields cannot be omitted or mistyped to establish ownership', async t => {
  const f = await fixture(t);
  for (const key of ['info', 'session_summary', 'created_at', 'updated_at', 'num_messages', 'current_model_id']) {
    await session(f, ID, { [key]: undefined });
    const result = await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f);
    assert.equal(result.rootVerified, false, key);
    assert.equal(result.status, 'pending', key);
  }
  for (const patch of [{ num_messages: -1 }, { num_messages: '1' }, { current_model_id: {} }, { created_at: 'September 1, 2026' }, { generated_title: {} }, { hidden: 'false' }, { title_is_manual: 'true' }]) {
    await session(f, ID, patch);
    assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f)).rootVerified, false);
  }
});

test('an enumerated session with missing summary keeps discovery incomplete until metadata arrives', async t => {
  const f = await fixture(t);
  await session(f);
  const pending = path.join(f.home, 'sessions', encodeURIComponent(f.cwd), OTHER);
  await fs.mkdir(pending);
  const list = await lookupGrokThread({ cwd: f.cwd, list: true }, f);
  assert.equal(list.complete, false);
  assert.equal((await lookupGrokThread({ cwd: f.cwd }, f)).status, 'pending');
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: OTHER }, f)).status, 'pending');
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f)).rootVerified, true);
  await session(f, OTHER);
  assert.equal((await lookupGrokThread({ cwd: f.cwd }, f)).status, 'ambiguous');
  await fs.rm(pending, { recursive: true });
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: OTHER }, f)).status, 'missing');
  assert.equal((await lookupGrokThread({ cwd: f.cwd }, f)).threadRef.id, ID);
});

test('timestamp validation matches native calendar rules without rejecting valid leap dates or offsets', async t => {
  const f = await fixture(t);
  for (const created_at of ['2026-02-31T00:00:00Z', '2026-09-01T24:00:00Z', '2026-02-29T00:00:00Z', '1900-02-29T00:00:00Z']) {
    await session(f, ID, { created_at });
    const result = await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f);
    assert.equal(result.rootVerified, false, created_at);
    assert.equal(result.status, 'pending');
  }
  for (const created_at of ['2024-02-29T23:59:59.123Z', '2000-02-29T23:59:59+03:00', '2026-09-01T00:00:00-04:00']) {
    await session(f, ID, { created_at });
    assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f)).rootVerified, true, created_at);
  }
});

test('missing hashed cwd marker cannot hide a competing session; unrelated empty folders stay ignorable', async t => {
  const f = await fixture(t);
  await session(f);
  await fs.mkdir(path.join(f.home, 'sessions', 'unrelated-empty-folder'));
  assert.equal((await lookupGrokThread({ cwd: f.cwd }, f)).threadRef.id, ID);
  await session(f, OTHER, {}, 'workspace-deadbeef');
  assert.equal((await lookupGrokThread({ cwd: f.cwd }, f)).status, 'pending');
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: OTHER }, f)).status, 'pending');
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f)).rootVerified, true);
  await fs.writeFile(path.join(f.home, 'sessions', 'workspace-deadbeef', '.cwd'), 'relative-path');
  assert.equal((await lookupGrokThread({ cwd: f.cwd }, f)).status, 'pending');
  await fs.writeFile(path.join(f.home, 'sessions', 'workspace-deadbeef', '.cwd'), f.cwd);
  assert.equal((await lookupGrokThread({ cwd: f.cwd }, f)).status, 'ambiguous');
});
test('hashed cwd markers work; duplicate relocation identity and unsafe paths fail closed', async t => {
  const f = await fixture(t);
  await session(f, ID, {}, 'workspace-deadbeef');
  await fs.writeFile(path.join(f.home, 'sessions', 'workspace-deadbeef', '.cwd'), f.cwd);
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f)).rootVerified, true);
  const duplicate = await session(f);
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f)).status, 'pending');
  await fs.rm(duplicate, { recursive: true });
  const original = path.join(f.home, 'sessions', 'workspace-deadbeef', ID);
  await fs.rename(original, path.join(f.home, 'external'));
  await fs.symlink(path.join(f.home, 'external'), original, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f)).rootVerified, false);
});

for (const metadata of ['missing', 'malformed']) test(`duplicate native ID with ${metadata} metadata cannot select the older relocation copy`, async t => {
  const f = await fixture(t);
  await session(f);
  const duplicate = await session(f, ID, {}, 'workspace-relocation');
  await fs.writeFile(path.join(f.home, 'sessions', 'workspace-relocation', '.cwd'), f.cwd);
  if (metadata === 'missing') await fs.rm(path.join(duplicate, 'summary.json'));
  else await fs.writeFile(path.join(duplicate, 'summary.json'), '{');
  const list = await lookupGrokThread({ cwd: f.cwd, list: true }, f);
  assert.equal(list.complete, false); assert.deepEqual(list.threads, []);
  const confirmed = await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f);
  assert.equal(confirmed.status, 'pending'); assert.equal(confirmed.rootVerified, false);
  await assert.rejects(readGrokConversation({ cwd: f.cwd, id: ID }, f), /no longer verified/);
  // The directory identity conflict, not unrelated incomplete metadata, is what
  // blocks this explicit ID. Removing the relocation copy restores selection.
  await fs.rm(duplicate, { recursive: true });
  await session(f, OTHER, {}, 'workspace-relocation');
  await fs.rm(path.join(f.home, 'sessions', 'workspace-relocation', OTHER, 'summary.json'));
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f)).rootVerified, true);
});

for (const marker of ['missing', 'relative', 'empty', 'oversized', 'directory', 'invalid-utf8'])
test(`duplicate ID under ${marker} cwd marker blocks exact lookup and history until isolated`, async t => {
  const f = await fixture(t), original = await session(f);
  await fs.writeFile(path.join(original, 'updates.jsonl'), jsonl([update('agent_message_chunk', 'Older copy')]));
  const duplicate = await session(f, ID, {}, 'workspace-relocation');
  const cwdFile = path.join(path.dirname(duplicate), '.cwd');
  if (marker === 'directory') await fs.mkdir(cwdFile);
  else if (marker !== 'missing') await fs.writeFile(cwdFile,
    marker === 'relative' ? 'relative/workspace' : marker === 'empty' ? '' : marker === 'oversized' ? 'x'.repeat(16385) : Buffer.from([255]));
  const blocked = await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f);
  assert.equal(blocked.status, 'pending'); assert.equal(blocked.rootVerified, false);
  assert.deepEqual((await lookupGrokThread({ cwd: f.cwd, list: true }, f)).threads, []);
  await assert.rejects(readGrokConversation({ cwd: f.cwd, id: ID }, f), /no longer verified/);
  // A valid foreign marker proves isolation even when its native ID matches.
  await fs.rm(cwdFile, { force: true, recursive: true });
  await fs.writeFile(cwdFile, path.join(f.home, 'foreign-workspace'));
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f)).rootVerified, true);
  assert.equal((await readGrokConversation({ cwd: f.cwd, id: ID }, f)).messages[0].text, 'Older copy');
  // Unknown scope with a different enumerated ID does not invalidate this ID.
  await fs.rm(cwdFile); await fs.rm(duplicate, { recursive: true });
  await session(f, OTHER, {}, 'workspace-relocation');
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f)).rootVerified, true);
});

for (const failure of ['unreadable', 'folder-limit']) for (const scope of ['unknown', 'same'])
test(`${failure} ${scope}-cwd enumeration cannot certify a unique native ID`, async t => {
  const f = await fixture(t), original = await session(f);
  await fs.writeFile(path.join(original, 'updates.jsonl'), jsonl([update('agent_message_chunk', 'Older copy')]));
  const directory = path.join(f.home, 'sessions', 'workspace-unenumerated'); await fs.mkdir(directory);
  const marker = path.join(directory, '.cwd');
  if (scope === 'same') await fs.writeFile(marker, f.cwd);
  const opendir = fs.opendir;
  t.mock.method(fs, 'opendir', async (requested, ...args) => {
    if (path.resolve(requested) !== directory) return opendir(requested, ...args);
    if (failure === 'unreadable') throw Object.assign(Error('Fixture directory unreadable'), { code: 'EACCES' });
    return { async *[Symbol.asyncIterator]() { for (let index = 0; index < 10001; index++) yield { name: `entry-${index}` }; }, async close() {} };
  });
  const result = await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f);
  assert.equal(result.status, 'pending'); assert.equal(result.rootVerified, false);
  assert.deepEqual((await lookupGrokThread({ cwd: f.cwd, list: true }, f)).threads, []);
  await assert.rejects(readGrokConversation({ cwd: f.cwd, id: ID }, f), /no longer verified/);
  // Known foreign workspaces need not be enumerated, even if unreadable/large.
  await fs.writeFile(marker, path.join(f.home, 'foreign-workspace'));
  assert.equal((await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f)).rootVerified, true);
});

test('combined UUID discovery budget cannot certify an ID before unseen competing names', async t => {
  const f = await fixture(t); await session(f);
  const unknown = ['workspace-one', 'workspace-two'].map(name => path.join(f.home, 'sessions', name));
  for (const directory of unknown) await fs.mkdir(directory);
  const opendir = fs.opendir;
  t.mock.method(fs, 'opendir', async (requested, ...args) => {
    if (!unknown.includes(path.resolve(requested))) return opendir(requested, ...args);
    return { async *[Symbol.asyncIterator]() {
      for (let index = 0; index < 5001; index++) yield { name: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}` };
    }, async close() {} };
  });
  const result = await lookupGrokThread({ cwd: f.cwd, confirmId: ID }, f);
  assert.equal(result.status, 'pending'); assert.equal(result.rootVerified, false);
  await assert.rejects(readGrokConversation({ cwd: f.cwd, id: ID }, f), /no longer verified/);
});
test('authoritative replay joins chunks, retains user turns, applies rewind and excludes thoughts/tools/host turns', () => {
  const records = [
    update('user_message_chunk', 'First', { promptIndex: 0 }, 'e0'),
    update('agent_message_chunk', 'Hello ', {}, 'e1'),
    update('agent_message_chunk', 'world', {}, 'e2'),
    update('agent_message_chunk', 'world', {}, 'e2'),
    update('agent_thought_chunk', 'SECRET'),
    update('user_message_chunk', 'HOST', { hostTurn: true }),
    update('user_message_chunk', 'Discarded', { promptIndex: 1 }),
    update('agent_message_chunk', 'Discarded reply'),
    update('rewind_marker', '', {}, null, '_x.ai/session/update', { target_prompt_index: 1 }),
    update('user_message_chunk', 'Replacement', { promptIndex: 1 }),
    update('agent_message_chunk', 'Final')
  ];
  assert.deepEqual(replayGrokUpdates(jsonl(records), ID), [
    { role: 'user', text: 'First' }, { role: 'assistant', text: 'Hello world' },
    { role: 'user', text: 'Replacement' }, { role: 'assistant', text: 'Final' }
  ]);
  assert.throws(() => replayGrokUpdates(jsonl([update('agent_message_chunk', 'a', {}, 'same'), update('agent_message_chunk', 'b', {}, 'same')]), ID), /Conflicting/);
  assert.throws(() => replayGrokUpdates(jsonl([{ ...records[0], params: { ...records[0].params, sessionId: OTHER } }]), ID), /identity/);
});
test('history pages and searches authoritative transcript; changed content invalidates cursors', async t => {
  const f = await fixture(t), directory = await session(f);
  const file = path.join(directory, 'updates.jsonl');
  await fs.writeFile(file, jsonl([update('user_message_chunk', 'Question'), update('agent_message_chunk', 'Answer '.repeat(100))]));
  const history = createOrchestratorHistory({ homes: { grok: f.home }, getKnownScopes: () => [{ provider: 'grok', cwd: f.cwd }], lookupThreads: payload => lookupGrokThread(payload, f) });
  const list = await history.list({ provider: 'grok' });
  assert.equal(list.conversations.length, 1);
  const reference = list.conversations[0].reference;
  const page = await history.read({ reference, maxChars: 50 });
  assert.equal(page.nativeSource, 'grok-updates');
  assert.equal(page.historyCompleteness, 'complete');
  assert.equal(page.hasMore, true);
  assert.ok((await history.read({ reference, cursor: page.nextCursor, maxChars: 50 })).messages.length);
  assert.ok((await history.search({ reference, query: 'Question' })).matches.length);
  await fs.appendFile(file, jsonl([update('user_message_chunk', 'New')]));
  await assert.rejects(history.read({ reference, cursor: page.nextCursor }), /cursor/);
});
test('rewinds follow marked and legacy prompt boundaries, including adjacent prompts', () => {
  const records = [
    update('user_message_chunk', 'Legacy '), update('user_message_chunk', 'prompt'),
    update('agent_message_chunk', 'Response'),
    update('user_message_chunk', 'Keep', { promptIndex: 1 }),
    update('user_message_chunk', 'Remove', { promptIndex: 2 }),
    update('rewind_marker', '', {}, null, '_x.ai/session/update', { target_prompt_index: 2 }),
    update('agent_message_chunk', 'Resumed')
  ];
  assert.deepEqual(replayGrokUpdates(jsonl(records), ID).map(message => message.text), ['Legacy prompt', 'Response', 'Keep', 'Resumed']);
  records.push(update('rewind_marker', '', {}, null, '_x.ai/session/update', { target_prompt_index: 0 }));
  assert.deepEqual(replayGrokUpdates(jsonl(records), ID), []);
});
test('legacy context is explicitly limited; invalid authoritative data never falls back', async t => {
  const f = await fixture(t), directory = await session(f);
  await fs.writeFile(path.join(directory, 'chat_history.jsonl'), jsonl([{ type: 'user', content: [{ type: 'text', text: 'Current only' }] }, { type: 'user', synthetic_reason: 'context', content: [{ type: 'text', text: 'SECRET' }] }, { type: 'assistant', content: 'Response', reasoning: { text: 'SECRET' } }]));
  const fallback = await readGrokConversation({ cwd: f.cwd, id: ID }, f);
  assert.equal(fallback.limited, true);
  assert.equal(fallback.source, 'grok-chat-context');
  assert.equal(fallback.messages.length, 2);
  await fs.writeFile(path.join(directory, 'updates.jsonl'), '{');
  await assert.rejects(readGrokConversation({ cwd: f.cwd, id: ID }, f));
  await fs.writeFile(path.join(directory, 'updates.jsonl'), 'x'.repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(readGrokConversation({ cwd: f.cwd, id: ID }, f), /limit/);
});
