const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOrchestratorHistory } = require('../../backend/orchestratorHistory.cjs');
const { listCodexThreads } = require('../../backend/agentThreads.cjs');
test('model title selection rechecks all pages, rejects rename and incomplete discovery', async () => {
  const cwd = process.cwd(); let complete = true; let threads = [{ id: 'one', title: 'Shared', updatedAt: 2 }, { id: 'two', title: 'Shared', updatedAt: 1 }];
  const service = createOrchestratorHistory({ getKnownScopes: () => [{ provider: 'codex', cwd }], lookupThreads: async () => ({ status: 'found', complete, threads }) });
  const page = await service.list({ limit: 1 }); const reference = page.conversations[0].reference;
  assert.equal(page.nextOffset, 1);
  await assert.rejects(service.resolve({ reference, selection: { kind: 'title', value: 'Shared', provider: 'codex' } }), /ambiguous/);
  assert.equal((await service.resolve({ reference, selection: { kind: 'id', value: 'one', provider: 'codex' } })).id, 'one');
  threads = [{ id: 'one', title: 'Renamed!' }];
  assert.equal((await service.resolve(reference)).title, 'Renamed!');
  await assert.rejects(service.resolve({ reference, selection: { kind: 'title', value: 'Shared' } }), /current title is "Renamed!"/);
  complete = false;
  await assert.rejects(service.resolve({ reference, selection: { kind: 'id', value: 'one', provider: 'codex' } }), /incomplete/);
});
test('model folder basename and home qualifiers retain authoritative ambiguity scope', async () => {
  const cwd = path.join(process.cwd(), 'first', 'shared'); const other = path.join(process.cwd(), 'second', 'shared');
  const service = createOrchestratorHistory({ getKnownScopes: () => [{ provider: 'claude', cwd }, { provider: 'claude', cwd: other }, { provider: 'claude-custom', cwd, claudeHome: 'custom' }], lookupThreads: async () => ({ status: 'found', threads: [{ id: 'same', title: 'Same' }] }) });
  const reference = (await service.list({ provider: 'claude', cwd })).conversations[0].reference;
  await assert.rejects(service.resolve({ reference, selection: { kind: 'title', value: 'Same', provider: 'claude', cwd: 'shared', claudeHome: 'global' } }), /ambiguous/);
  await assert.rejects(service.resolve({ reference, selection: { kind: 'id', value: 'same', provider: 'claude', cwd } }), /ambiguous/);
  assert.equal((await service.resolve({ reference, selection: { kind: 'id', value: 'same', provider: 'claude', cwd, claudeHome: 'global' } })).cwd, cwd);
});
test('Codex Fusion provenance applies only to individually owned root conversations', async () => {
  const cwd = process.cwd();
  const service = createOrchestratorHistory({ getKnownScopes: () => [{ provider: 'fusion', plannerProvider: 'codex', fusion: true, cwd, ownedThreadIds: ['fusion-root'] }, { provider: 'codex', cwd }], lookupThreads: async () => ({ status: 'found', threads: [{ id: 'fusion-root', title: 'Fusion' }, { id: 'plain-root', title: 'Plain' }] }) });
  const conversations = (await service.list()).conversations;
  assert.equal(conversations.find(c => c.id === 'fusion-root').provider, 'fusion');
  assert.equal(conversations.find(c => c.id === 'plain-root').provider, 'codex');
  const fusion = conversations.find(c => c.id === 'fusion-root');
  assert.equal((await service.resolve({ reference: fusion.reference, selection: { kind: 'title', value: 'Fusion', provider: 'fusion', cwd } })).id, 'fusion-root');
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  function write(relative, values) {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Array.isArray(values) ? values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') : values);
    return file;
  }
  return { root, cwd, write };
}
test('Codex native discovery excludes children, searches titles, and reads bounded human messages', async t => {
  const f = fixture(t); const codex = path.join(f.root, 'codex');
  const meta = (id, extra = {}) => ({ type: 'session_meta', payload: { id, cwd: f.cwd, timestamp: '2026-09-01T00:00:00Z', name: 'Fix terminal colors', ...extra } });
  f.write('codex/sessions/rollout-date-root-123.jsonl', [meta('root-123'), '{broken',
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Change the colors' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(1000) }] } }]);
  f.write('codex/sessions/rollout-date-child.jsonl', [meta('child', { parent_thread_id: 'root-123' })]);
  const service = createOrchestratorHistory({ homes: { codex }, getKnownScopes: () => [{ provider: 'codex', cwd: f.cwd }], lookupThreads: payload => listCodexThreads(payload, { codexHome: codex }) });
  const listed = await service.list({ query: 'colors' });
  assert.equal(listed.conversations.length, 1);
  assert.equal(listed.conversations[0].id, 'root-123');
  assert.equal(JSON.stringify(listed).includes('rollout-date'), false);
  const read = await service.read({ reference: listed.conversations[0].reference, maxChars: 30 });
  assert.equal(read.messages[0].text.length, 30); assert.equal(read.truncated, true);
  assert.equal(read.untrustedContent, true);
  assert.equal((await service.list({ query: 'missing' })).conversations.length, 0);
  await assert.rejects(service.read({ reference: '../../secret' }), /Unknown/);
});
test('references bind Claude home provenance and never fall back across homes', async t => {
  const f = fixture(t); const custom = path.join(f.root, 'custom'); const global = path.join(f.root, 'global');
  const record = text => ({ type: 'user', sessionId: 'shared-id', cwd: f.cwd, timestamp: '2026-09-01T00:00:00Z', message: { content: text } });
  f.write('custom/projects/project/shared-id.jsonl', [record('custom secret')]);
  f.write('global/projects/project/shared-id.jsonl', [record('global secret')]);
  const service = createOrchestratorHistory({ homes: { claude: global, claudeCustom: custom }, getKnownScopes: () => [{ provider: 'claude', cwd: f.cwd, claudeHome: 'custom', providerProfileId: 'profile-a', ownedThreadIds: ['shared-id'] }], lookupThreads: async () => ({ status: 'found', threads: [{ id: 'shared-id', title: 'Custom chat' }] }) });
  const [entry] = (await service.list()).conversations;
  const result = await service.read({ reference: entry.reference });
  assert.equal(result.messages[0].text, 'custom secret');
  assert.equal(result.identity.providerProfileId, 'profile-a');
  fs.unlinkSync(path.join(custom, 'projects/project/shared-id.jsonl'));
  assert.equal((await service.read({ reference: entry.reference })).status, 'unavailable');
});
test('Open Fusion preserves trusted broker identity and supports explicit unavailable transcript', async t => {
  const f = fixture(t); const calls = [];
  const service = createOrchestratorHistory({ getKnownScopes: () => [{ provider: 'openfusion', cwd: f.cwd }], lookupThreads: async payload => { calls.push(payload); return { status: 'found', threads: [{ id: 'ses_root', title: 'Root' }, { id: 'ses_child', parentID: 'ses_root' }, { id: '../escape' }] }; } });
  const result = await service.list(); assert.equal(result.conversations.length, 1);
  assert.equal(calls[0].provider, 'opencode'); assert.equal(calls[0].openFusion, true);
  assert.equal((await service.read({ reference: result.conversations[0].reference })).status, 'unsupported');
  assert.equal((await service.list({ provider: 'terminal' })).status, 'unsupported');
  const isolated = createOrchestratorHistory({ getKnownScopes: () => [{ provider: 'openfusion', cwd: f.cwd }] });
  assert.match((await isolated.list()).warnings[0].message, /app-owned/);
});
test('native index cannot escape its store and forged reference cannot supply a path', async t => {
  const f = fixture(t); const kimi = path.join(f.root, 'kimi');
  f.write('outside/context.jsonl', [{ role: 'user', content: 'outside secret' }]);
  f.write('kimi/session_index.jsonl', [{ sessionId: 'root', workDir: f.cwd, sessionDir: path.join(f.root, 'outside') }]);
  const service = createOrchestratorHistory({ homes: { kimi }, getKnownScopes: () => [{ provider: 'kimi', cwd: f.cwd }], lookupThreads: async () => ({ status: 'found', threads: [{ id: 'root' }] }) });
  const reference = (await service.list()).conversations[0].reference;
  assert.equal((await service.read({ reference, path: path.join(f.root, 'outside/context.jsonl') })).status, 'unavailable');
});
test('deduplication, pagination, partial diagnostics and reference revalidation', async t => {
  const f = fixture(t); let available = true;
  const service = createOrchestratorHistory({ getKnownScopes: () => ['kimi', 'kimi-custom', 'qwen'].map(provider => ({ provider, cwd: f.cwd })), lookupThreads: async payload => payload.provider === 'qwen' ? { status: 'failed', message: 'Store locked' } : { status: 'found', threads: available ? [{ id: 'a', updatedAt: 2 }, { id: 'b', updatedAt: 1 }] : [] } });
  const first = await service.list({ limit: 1 });
  assert.equal(first.nextOffset, 1); assert.equal(first.warnings.length, 1);
  const second = await service.list({ limit: 1, offset: 1 }); assert.equal(second.conversations[0].id, 'b'); assert.equal(second.nextOffset, null);
  available = false; await assert.rejects(service.resolve(first.conversations[0].reference), /no longer/);
});
test('OpenCode export validates root/cwd/session and excludes tool, synthetic and foreign message content', () => {
  const { parseOpenCodeExport } = require('../../backend/orchestratorHistoryHost.cjs');
  const identity = { id: 'ses_root', cwd: process.cwd() };
  const exported = { info: { id: identity.id, directory: identity.cwd }, messages: [
    { info: { sessionID: identity.id, role: 'assistant' }, parts: [{ type: 'text', text: 'Answer' }, { type: 'tool', text: 'tool secret' }, { type: 'text', synthetic: true, text: 'internal' }] },
    { info: { sessionID: 'ses_child', role: 'assistant' }, parts: [{ type: 'text', text: 'foreign' }] }
  ] };
  assert.deepEqual(parseOpenCodeExport(exported, identity).messages, [{ role: 'assistant', text: 'Answer' }]);
  assert.throws(() => parseOpenCodeExport({ ...exported, info: { ...exported.info, parentID: 'parent' } }, identity));
  assert.throws(() => parseOpenCodeExport(exported, { ...identity, cwd: path.dirname(identity.cwd) }));
});
test('dedicated helper starts lazily, handles list, and rejects requests after disposal', async () => {
  const { createOrchestratorHistoryProcess } = require('../../backend/orchestratorHistoryProcess.cjs');
  const service = createOrchestratorHistoryProcess({ getConfig: () => ({ scopes: [] }), timeoutMs: 5000 });
  try { const result = await service.list(); assert.equal(result.ok, true); assert.deepEqual(result.conversations, []); }
  finally { service.dispose(); }
  await assert.rejects(service.list(), /disposed/);
});
test('helper timeout kills task process and a subsequent list restarts with expired references', async () => {
  const { EventEmitter } = require('events');
  const { createOrchestratorHistoryProcess } = require('../../backend/orchestratorHistoryProcess.cjs');
  let killed = 0; let spawned = 0;
  const service = createOrchestratorHistoryProcess({ timeoutMs: 10, fork: () => {
    spawned++; const child = new EventEmitter(); child.kill = () => { killed++; }; child.send = message => {
      if (spawned > 1) setImmediate(() => child.emit('message', { id: message.id, result: { ok: true } }));
    }; return child;
  } });
  // Keep the test alive: production Electron owns the event loop, timer is unref'd.
  const keepalive = setTimeout(() => {}, 1000);
  try { await assert.rejects(service.list(), /timed out/); assert.equal(killed, 1); assert.equal((await service.list()).ok, true); assert.equal(spawned, 2); }
  finally { clearTimeout(keepalive); service.dispose(); }
});
test('native Cursor, Gemini, Qwen and Kimi formats return human prose', async t => {
  const f = fixture(t);
  const { encodeCursorProjectDir, qwenChatsDir } = require('../../backend/agentThreadHost.cjs');
  const homes = Object.fromEntries(['cursor', 'gemini', 'qwen', 'kimi'].map(provider => [provider, path.join(f.root, provider)]));
  const cursor = `cursor/projects/${encodeCursorProjectDir(f.cwd)}/agent-transcripts/root/root.jsonl`;
  f.write(cursor, [{ role: 'user', message: { content: [{ type: 'text', text: 'Cursor prompt' }] } }]);
  const geminiFile = f.write('gemini/tmp/hash/chats/session-root.json', JSON.stringify({ sessionId: 'root', messages: [{ type: 'user', content: 'Gemini prompt' }, { type: 'gemini', content: 'Gemini reply' }] }));
  f.write(path.relative(f.root, path.join(qwenChatsDir(f.cwd, homes.qwen), 'root.jsonl')), [{ type: 'user', sessionId: 'root', message: { parts: [{ text: 'Qwen prompt' }] } }]);
  f.write('kimi/session_index.jsonl', [{ sessionId: 'root', workDir: f.cwd, sessionDir: path.join(homes.kimi, 'sessions/root') }]);
  f.write('kimi/sessions/root/agents/main/wire.jsonl', [{ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'Kimi prompt' }], toolCalls: [], origin: 'user' } }]);
  const service = createOrchestratorHistory({ homes, getKnownScopes: () => Object.keys(homes).map(provider => ({ provider, cwd: f.cwd })), lookupThreads: async payload => ({ status: 'found', threads: [{ id: 'root', transcriptPath: payload.provider === 'gemini' ? geminiFile : undefined }] }) });
  for (const conversation of (await service.list()).conversations) {
    const result = await service.read({ reference: conversation.reference });
    assert.equal(result.ok, true, conversation.provider);
    assert.match(result.messages[0].text, new RegExp(conversation.provider, 'i'));
  }
});
test('large JSONL reads skip malformed records and report complete coverage', async t => {
  const f = fixture(t); const kimi = path.join(f.root, 'kimi');
  f.write('kimi/session_index.jsonl', [{ sessionId: 'root', workDir: f.cwd, sessionDir: path.join(kimi, 'sessions/root') }]);
  f.write('kimi/sessions/root/context.jsonl', ['x'.repeat(3 * 1024 * 1024), { role: 'assistant', content: 'Recent answer' }]);
  const service = createOrchestratorHistory({ homes: { kimi }, getKnownScopes: () => [{ provider: 'kimi', cwd: f.cwd }], lookupThreads: async () => ({ status: 'found', threads: [{ id: 'root' }] }) });
  const result = await service.read({ reference: (await service.list()).conversations[0].reference });
  assert.deepEqual(result.messages, [{ role: 'assistant', text: 'Recent answer' }]); assert.equal(result.truncated, false); assert.equal(result.hasMore, false);
});
test('shared custom Claude home never assigns an unproven profile to discovered chats', async t => {
  const f = fixture(t);
  const service = createOrchestratorHistory({ getKnownScopes: () => [
    { provider: 'claude', cwd: f.cwd, claudeHome: 'custom' },
    { provider: 'claude', cwd: f.cwd, claudeHome: 'custom', providerProfileId: 'profile-a', ownedThreadIds: ['chat-a'] },
    { provider: 'claude', cwd: f.cwd, claudeHome: 'custom', providerProfileId: 'profile-b', ownedThreadIds: ['chat-b'] }
  ], lookupThreads: async () => ({ status: 'found', threads: ['chat-a', 'chat-b', 'unknown'].map(id => ({ id })) }) });
  const result = await service.list();
  assert.equal(result.conversations.find(chat => chat.id === 'chat-a').providerProfileId, 'profile-a');
  assert.equal(result.conversations.find(chat => chat.id === 'chat-b').providerProfileId, 'profile-b');
  assert.equal(result.conversations.find(chat => chat.id === 'unknown').providerProfileId, undefined);
  assert.equal(JSON.stringify(result).includes('ownedThreadIds'), false);
});
