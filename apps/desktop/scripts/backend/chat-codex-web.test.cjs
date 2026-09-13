'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { findLatestAgentThread } = require('../../backend/agentThreadHost.cjs');
const { createOrchestratorHistory } = require('../../backend/orchestratorHistory.cjs');
const { preparedTerminalCommand } = require('../../backend/codexWebNative.cjs');
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-web-chat-'));
  const previous = process.env.LINA_CODEX_WEB_HISTORY_HOME, globalHome = process.env.CODEX_HOME;
  const home = path.join(cwd, 'private'); process.env.LINA_CODEX_WEB_HISTORY_HOME = home; process.env.CODEX_HOME = path.join(cwd, 'global');
  t.after(() => { if (previous === undefined) delete process.env.LINA_CODEX_WEB_HISTORY_HOME; else process.env.LINA_CODEX_WEB_HISTORY_HOME = previous; if (globalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = globalHome; fs.rmSync(cwd, { recursive: true, force: true }); });
  function write(base, id, text) { const dir = path.join(base, 'sessions', '2026', '09', '13'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `rollout-${id}.jsonl`), [
    { type: 'session_meta', payload: { id, cwd, timestamp: '2026-09-13T00:00:00Z', source: 'cli' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
  ].map(row => JSON.stringify(row)).join('\n') + '\n'); }
  return { cwd, home, write };
}
test('Codex Web discovers and confirms only its private native home', async t => {
  const f = fixture(t); f.write(process.env.CODEX_HOME, 'global-only', 'Global'); f.write(f.home, 'private-chat', 'Private');
  const listed = await findLatestAgentThread({ provider: 'codex-web', cwd: f.cwd, list: true });
  assert.deepEqual(listed.threads.map(row => [row.provider, row.id]), [['codex-web', 'private-chat']]);
  const confirmed = await findLatestAgentThread({ provider: 'codex-web', cwd: f.cwd, confirmId: 'private-chat' });
  assert.equal(confirmed.rootVerified, true); assert.equal(confirmed.threadRef.provider, 'codex-web');
  const absent = await findLatestAgentThread({ provider: 'codex-web', cwd: f.cwd, confirmId: 'global-only' }); assert.equal(absent.status, 'missing');
  delete process.env.LINA_CODEX_WEB_HISTORY_HOME;
  assert.equal((await findLatestAgentThread({ provider: 'codex-web', cwd: f.cwd, list: true })).status, 'failed');
});
test('shared reader decodes Codex Web prose without reading a global lookalike', async t => {
  const f = fixture(t); f.write(f.home, 'same-id', 'Private saved conversation'); f.write(process.env.CODEX_HOME, 'same-id', 'Global lookalike');
  const history = createOrchestratorHistory({ homes: { codexWeb: f.home }, getKnownScopes: () => [{ provider: 'codex-web', cwd: f.cwd }], lookupThreads: findLatestAgentThread });
  const listed = await history.list({}); assert.equal(listed.conversations.length, 1);
  const result = await history.read({ reference: listed.conversations[0].reference });
  assert.equal(result.ok, true); assert.match(result.text, /Private saved/); assert.doesNotMatch(result.text, /Global lookalike/);
});
test('provider startup preparation preserves exact resume and rejects a changed identity', () => {
  assert.equal(preparedTerminalCommand('codex-web', 'codex-web resume exact-id', { provider: 'codex-web', id: 'exact-id' }), 'codex-web resume exact-id');
  assert.equal(preparedTerminalCommand('codex-web', 'codex-web'), 'codex-web');
  assert.throws(() => preparedTerminalCommand('codex-web', 'codex-web resume old-id', { provider: 'codex-web', id: 'new-id' }), /identity/);
  assert.throws(() => preparedTerminalCommand('codex-web', 'codex-web resume exact-id', { provider: 'codex', id: 'exact-id' }), /identity/);
});
