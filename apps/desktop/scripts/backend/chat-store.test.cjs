'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createChatStore } = require('../../backend/chatStore.cjs');
const { createChatService } = require('../../backend/chatService.cjs');
const { key } = require('../../shared/chatIdentity.cjs');
const cwd = path.resolve(__dirname, '../..');
function pane(id = 'pane', nativeId = 'A') { return { id, kind: 'codex', name: 'A chat', cwd, started: true, launchToken: 1, createdAt: 1, status: 'idle', nextLaunchMode: 'resume', threadRef: nativeId ? { provider: 'codex', id: nativeId, createdAt: 1, updatedAt: 2 } : undefined }; }
const workspace = (...sessions) => ({ workspaces: [{ id: 'project', name: 'Project', path: cwd, sessions }], multiSessions: [], activeWorkspaceId: 'project', activeView: 'project' });
function fixture(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-chat-test-')); let store = createChatStore({ directory });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, get store() { return store; }, reopen() { store.close(); store = createChatStore({ directory }); return store; }, save(value, sequence = 1) { return store.checkpoint({ workspace: value, sequence, clientId: 'test' }); } };
}
test('pane closure and project removal keep exact chat, recipe, title override, archive and draft', t => {
  const f = fixture(t), p = { ...pane(), openCodexModel: 'saved-model' };
  f.store.bootstrap(workspace(p));
  let row = f.store.list()[0];
  f.store.update({ chatId: row.chatId, revision: row.revision, title: 'Personal title', archived: true });
  f.store.draft({ owner: 'native:' + row.nativeKey, revision: 1, text: 'Unsent text' });
  f.save(workspace(p));
  assert.equal(f.store.list()[0].title, 'Personal title');
  f.save({ ...workspace(), workspaces: [] }, 2);
  row = f.store.list()[0];
  assert.equal(row.conversation.id, 'A'); assert.equal(row.archived, true); assert.equal(row.paneId, undefined);
  assert.equal(row.conversation.openCodexModel, 'saved-model');
  f.store.finish(); const restored = f.reopen().bootstrap();
  assert.equal(restored.recoveryNeeded, false); assert.equal(restored.drafts['native:' + row.nativeKey].text, 'Unsent text');
});
test('backend A -> pending B -> C survives stale renderer checkpoints and abrupt restart', t => {
  const f = fixture(t); f.store.bootstrap(workspace(pane()));
  f.store.observe({ id: 'pane', launchToken: 1, revision: 2, selection: { status: 'pending', threadRef: { provider: 'codex', id: 'B' } } });
  f.save(workspace(pane()));
  assert.equal(f.store.bootstrap().workspace.workspaces[0].sessions[0].threadRef.id, 'B');
  f.store.observe({ id: 'pane', launchToken: 1, revision: 3, selection: { status: 'pending', threadRef: { provider: 'codex', id: 'C' } } });
  assert.equal(f.store.observe({ id: 'pane', launchToken: 1, revision: 1, conversation: { provider: 'codex', id: 'A' } }), false);
  const recovered = f.reopen().bootstrap();
  const current = recovered.workspace.workspaces[0].sessions[0];
  assert.equal(current.threadRef.id, 'C'); assert.equal(current.threadSelectionPending, true); assert.equal(current.started, false);
  assert.equal(recovered.recoveryNeeded, true);
  assert.deepEqual(f.store.list().map(row => row.conversation.id).sort(), ['A', 'B', 'C']);
});
test('new launch token and closed pane fence old native observations', t => {
  const f = fixture(t); f.store.bootstrap(workspace(pane()));
  f.save(workspace({ ...pane('pane', 'B'), launchToken: 2 }));
  assert.equal(f.store.observe({ id: 'pane', launchToken: 1, conversation: { provider: 'codex', id: 'wrong' } }), false);
  f.save(workspace(), 2);
  assert.equal(f.store.observe({ id: 'pane', launchToken: 2, conversation: { provider: 'codex', id: 'late' } }), false);
  assert(!f.store.list().some(row => row.conversation?.id === 'late'));
});
test('provisional chat promotes once and repeated checkpoints do not duplicate it', t => {
  const f = fixture(t); f.store.bootstrap(workspace(pane('pane', null)));
  const id = f.store.list()[0].chatId;
  f.store.draft({ owner: 'pane:pane', text: 'Before ID', revision: 1 });
  f.store.observe({ id: 'pane', launchToken: 1, revision: 1, conversation: { provider: 'codex', id: 'real' } });
  f.save(workspace(pane('pane', 'real')));
  const rows = f.store.list(); assert.equal(rows.length, 1); assert.equal(rows[0].chatId, id);
  assert.equal(f.store.bootstrap().drafts['native:' + rows[0].nativeKey].text, 'Before ID');
});
test('paused native chat retains a single binding through repeated startup normalization', t => {
  const f = fixture(t); const p = pane(); f.store.bootstrap(workspace(p));
  f.save(workspace({ ...p, started: false, threadRef: { provider: 'codex', createdAt: 1, updatedAt: 2 }, resumeRef: p.threadRef }));
  assert.equal(f.store.list().length, 1); assert.equal(f.store.list()[0].paneId, p.id);
});
test('provider and private home identities never collide; discovery preserves recipe', t => {
  const f = fixture(t), base = { provider: 'claude', id: 'same', cwd, title: 'Native' };
  assert.notEqual(key(base), key({ ...base, claudeHome: 'custom' }));
  assert.notEqual(key({ ...base, provider: 'codex' }), key({ ...base, provider: 'codex-web' }));
  f.store.importConversations([base, { ...base, claudeHome: 'custom' }]);
  f.store.bootstrap(workspace({ ...pane(), kind: 'claude', providerProfileId: 'original-profile', threadRef: { provider: 'claude', id: 'same' }, providerModelOverride: 'original-model' }));
  f.store.importConversations([{ ...base, claudeHome: 'custom', providerProfileId: 'guessed-profile', providerModelOverride: 'wrong' }]);
  const custom = f.store.list().find(row => row.conversation.claudeHome === 'custom');
  assert.equal(custom.conversation.providerProfileId, 'original-profile'); assert.equal(custom.conversation.providerModelOverride, 'original-model');
});
test('invalid and stale checkpoint cannot erase a good workspace', t => {
  const f = fixture(t); f.store.bootstrap(workspace(pane())); f.save(workspace(pane('pane', 'B')), 2);
  f.save(workspace(), 1);
  assert.equal(f.store.bootstrap().workspace.workspaces[0].sessions.length, 1);
  assert.throws(() => f.save({ ...workspace(), multiSessions: [pane(), pane()] }, 3), /Duplicate/);
  assert.equal(f.store.bootstrap().workspace.workspaces[0].sessions[0].threadRef.id, 'B');
});
test('a replaced renderer cannot overwrite the new renderer even with a larger sequence', t => {
  const f = fixture(t); f.store.bootstrap(workspace(pane()));
  f.store.checkpoint({ workspace: workspace(pane('pane', 'B')), clientId: 'old-renderer', sequence: 10 });
  f.store.checkpoint({ workspace: workspace(pane('pane', 'C')), clientId: 'new-renderer', sequence: 1 });
  const stale = f.store.checkpoint({ workspace: workspace(), clientId: 'old-renderer', sequence: 999 });
  assert.equal(stale.saved, false); assert.equal(stale.stale, true);
  assert.equal(f.store.bootstrap().workspace.workspaces[0].sessions[0].threadRef.id, 'C');
});
test('draft writes are revision-checked and never truncated', t => {
  const f = fixture(t); f.store.draft({ owner: 'pane:x', text: 'new', revision: 3 });
  assert.equal(f.store.draft({ owner: 'pane:x', text: 'old', revision: 2 }).saved, false);
  assert.throws(() => f.store.draft({ owner: 'pane:x', text: 'different', revision: 3 }), /another view/);
  assert.throws(() => f.store.draft({ owner: 'pane:x', text: 'x'.repeat(1000001), revision: 4 }), /Invalid draft/);
  assert.equal(f.store.bootstrap().drafts['pane:x'].text, 'new');
});
test('consistent backup survives reopening independently of live WAL', async t => {
  const f = fixture(t); f.store.bootstrap(workspace(pane())); await f.store.backup();
  const { DatabaseSync } = require('node:sqlite'); const copy = new DatabaseSync(path.join(f.directory, 'chat-workspace.backup.sqlite'), { readOnly: true });
  try { assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check, 'ok'); assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM chats').get().n, 1); } finally { copy.close(); }
});
test('backup rotation retains three individually readable snapshots', async t => {
  const f = fixture(t); f.store.bootstrap(workspace(pane()));
  for (let index = 0; index < 3; index++) { f.store.draft({ owner: 'pane:x', text: 'draft ' + index, revision: index }); await f.store.backup(); }
  const { DatabaseSync } = require('node:sqlite');
  for (const [suffix, expected] of [['', 'draft 2'], ['.1', 'draft 1'], ['.2', 'draft 0']]) {
    const db = new DatabaseSync(path.join(f.directory, 'chat-workspace.backup.sqlite' + suffix), { readOnly: true });
    try { assert.equal(db.prepare('SELECT text FROM drafts WHERE owner=?').get('pane:x').text, expected); } finally { db.close(); }
  }
});
test('future schema is refused without resetting existing data', t => {
  const f = fixture(t); f.store.bootstrap(workspace(pane())); f.store.close();
  const { DatabaseSync } = require('node:sqlite'), file = path.join(f.directory, 'chat-workspace.sqlite');
  const db = new DatabaseSync(file); db.exec('PRAGMA user_version=999'); db.close();
  assert.throws(() => createChatStore({ directory: f.directory }), /newer Lina/);
  const read = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(read.prepare('PRAGMA user_version').get().user_version, 999); assert.equal(read.prepare('SELECT COUNT(*) AS n FROM chats').get().n, 1); } finally { read.close(); }
});
test('bounded recovery copies do not affect catalog rows or drafts', t => {
  const f = fixture(t); f.store.bootstrap(workspace(pane())); const row = f.store.list()[0];
  const value = { messages: [{ role: 'assistant', text: 'Saved prose' }], capturedAt: 2, limited: true };
  f.store.saveCopy({ chatId: row.chatId, value }); assert.deepEqual(f.store.readCopy(row.chatId), value);
  assert.throws(() => f.store.saveCopy({ chatId: row.chatId, value: { messages: [{ text: 'x'.repeat(2 * 1024 * 1024) }] } }), /size limit/);
  assert.deepEqual(f.store.readCopy(row.chatId), value); assert.equal(f.store.list().length, 1);
});
test('a process killed after commit recovers committed identity without a shutdown handler', async t => {
  const f = fixture(t); f.store.close();
  const script = `const {createChatStore}=require(process.argv[1]);const s=createChatStore({directory:process.argv[2]});s.bootstrap(JSON.parse(process.argv[3]));process.stdout.write('committed\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script, path.resolve(__dirname, '../../backend/chatStore.cjs'), f.directory, JSON.stringify(workspace(pane()))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture timeout')); }, 10000); child.stdout.once('data', () => { clearTimeout(timer); resolve(); }); child.once('error', reject); });
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); });
  const restored = f.reopen().bootstrap(); assert.equal(restored.recoveryNeeded, true); assert.equal(restored.workspace.workspaces[0].sessions[0].threadRef.id, 'A');
});
test('exact opener refuses missing/unverified IDs and never invokes a new chat', async t => {
  const f = fixture(t); f.store.bootstrap(workspace(pane())); let result = { status: 'missing' };
  const service = createChatService({ directory: f.directory, getHistoryConfig: () => ({}), confirm: async () => result, store: { call: async (method, input) => f.store[method](input), close() {} } });
  t.after(() => service.close()); const row = f.store.list()[0];
  await assert.rejects(service.open(row.chatId), /missing/);
  result = { status: 'found', rootVerified: false, threadRef: { id: 'A' } }; await assert.rejects(service.open(row.chatId), /verified/);
  result = { status: 'found', rootVerified: true, threadRef: { id: 'A' } }; assert.equal((await service.open(row.chatId)).id, 'A');
});
