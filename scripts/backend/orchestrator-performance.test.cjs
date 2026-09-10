'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-performance-'));
  const messages = [{ id: 'saved', role: 'user', text: 'Preserve this complete conversation.', at: Date.now() }];
  fs.writeFileSync(path.join(root, 'orchestrator-conversation.json'), JSON.stringify({ messages, receipts: [], tasks: [] }));
  const f = { sessions: [{ id: 'pane', generation: 'g1', launchToken: 1, kind: 'terminal', cwd: root, status: 'idle' }], events: [] };
  f.app = createOrchestrator({ userDataPath: root, getSessions: () => f.sessions, onChange: state => f.events.push(state), fetch: () => assert.fail('No network expected') });
  t.after(async () => { await f.app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('unchanged inventory emits no redundant history snapshots and changed identity is still published', async t => {
  const f = await fixture(t);
  await f.app.refresh(); const initial = f.events.length;
  for (let i = 0; i < 5; i++) { f.sessions = structuredClone(f.sessions); const result = await f.app.refresh(); result.sessions[0].generation = 'cannot-mutate-owner'; }
  assert.equal(f.events.length, initial);
  for (let i = 0; i < 5; i++) assert.equal((await f.app.dispatch({ kind: 'list_sessions' })).ok, true);
  assert.equal(f.events.length, initial, 'Read-only UI polling does not republish the retained history.');
  f.sessions[0].generation = 'g2'; await f.app.refresh();
  assert.equal(f.events.length, initial + 1); assert.equal(f.events.at(-1).sessions[0].generation, 'g2');
  assert.equal(f.events.at(-1).messages[0].text, 'Preserve this complete conversation.');
  assert.equal((await f.app.refresh()).sessions[0].generation, 'g2');
});

test('control readers remain current, redact secrets and cannot mutate request ownership', async t => {
  const f = await fixture(t); await f.app.configure({ apiKey: 'fixture-private-secret', model: 'fixture', sessionOnly: true });
  await f.app.refresh();
  assert.equal(f.app.isEnabled(), false); assert.deepEqual(f.app.getTasks(), []);
  f.app.recordSpeechUsage('speech', .25); const usage = f.app.getUsage(); usage.speech = 0; assert.equal(f.app.getUsage().speech, .25);
  assert.equal(f.app.ingestInteraction({ id: 'question', sessionId: 'pane', generation: 'g1', revision: 1, kind: 'question', questions: [{ question: 'fixture-private-secret' }] }).ok, true);
  const requests = f.app.getRequests(); assert.equal(requests[0].questions[0].question, '[REDACTED]'); requests[0].state = 'resolved';
  assert.equal(f.app.getRequests()[0].state, 'pending');
  f.app.resolveInteraction({ id: 'question', sessionId: 'pane', generation: 'g1', revision: 1 }); assert.equal(f.app.getRequests()[0].state, 'resolved');
});
