'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { formatDirectOutcomes } = require('../../backend/orchestratorResponse.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const sessions = [{ id: 'a', name: 'Codex', generation: 1, kind: 'codex', status: 'running' }];
const format = (kind, status, extra = {}) => formatDirectOutcomes([{ kind, status, ok: true, targetId: 'a', ...extra }], sessions);

test('delivery wording distinguishes sent, queued, draft, and uncertain outcomes', () => {
  assert.equal(format('send_prompt', 'written'), 'Sent the prompt to Codex.');
  assert.match(format('send_prompt', 'queued'), /Queued.*hasn't been sent yet/);
  assert.match(format('send_prompt', 'staged'), /draft.*hasn't been sent/);
  assert.match(format('stage_draft', 'acknowledged'), /draft.*hasn't been sent/);
  for (const status of ['unknown', 'unconfirmed']) assert.match(format('send_prompt', status, { ok: false }), /couldn't confirm.*haven't sent it again/);
  assert.match(format('send_prompt', 'blocked', { ok: false, error: 'The terminal has a pending question.' }), /couldn't complete.*pending question/);
});

test('interrupt acknowledgement never claims a verified stop', () => {
  assert.equal(format('interrupt', 'written'), 'Requested a stop in Codex.');
  assert.equal(format('interrupt', 'stopped'), 'Codex stopped.');
  assert.equal(format('focus_session', 'acknowledged'), 'Switched to Codex.');
  assert.equal(formatDirectOutcomes([{ kind: 'navigate', ok: true, grantId: 'g' }], [], [{ id: 'g', args: { view: 'history' } }]), 'Opened History.');
});

test('direct focus uses the named outcome without an executor completion', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-response-'));
  const effects = [];
  const app = createOrchestrator({ userDataPath: dir, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: async () => sessions, getRoots: async () => ({ documents: dir, projects: [] }),
    interpretIntent: async () => ({ goal: 'Focus Codex.', executionMode: 'direct', actions: [{ kind: 'focus_session', targetIds: ['a'] }] }),
    dispatchAction: async action => { effects.push(action); return { ok: true, status: 'written' }; },
    fetch: async url => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'brain', supported_parameters: ['tools'] }] }));
      throw new Error('Direct execution must not call the completion model.');
    } });
  t.after(async () => { await app.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await app.configure({ apiKey: 'test-key', sessionOnly: true, model: 'brain' })).ok, true);
  assert.equal((await app.setEnabled(true)).ok, true);
  const result = await app.send({ text: 'Focus Codex', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, 'Switched to Codex.');
  assert.deepEqual(effects.map(item => item.kind), ['focus_session']);
});
