const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationStore } = require('../../backend/orchestratorConversationStore.cjs');

test('routing history is bounded, redacted descriptive metadata and restores paused', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-routing-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const store = createConversationStore({ userDataPath: dir, now: () => now, getSecrets: () => ['private-token'] });
  await store.save({ tasks: [{ requestId: 'r', status: 'running', updatedAt: now,
    workItemId: 'w'.repeat(800), workItemIds: Array(110).fill('w'.repeat(800)).concat([{}]),
    assignment: { decision: 'reuse', reason: 'private-token' + 'x'.repeat(3000), workItemId: 'w', grant: { allowed: true }, controller: {}, launchPromise: {}, action: 'submit' },
    grants: ['submit'], controller: {}, launchPromise: {},
  }, { requestId: 'bad', status: 'finished', updatedAt: now, assignment: { decision: 'submit', reason: 'invalid' } }] });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'orchestrator-conversation.json'), 'utf8')).tasks[0];
  assert.equal(saved.status, 'running');
  assert.equal(saved.workItemId.length, 500);
  assert.equal(saved.workItemIds.length, 100);
  assert.ok(saved.workItemIds.every(id => id.length === 500));
  assert.deepEqual(Object.keys(saved.assignment).sort(), ['decision', 'reason', 'workItemId']);
  assert.equal(saved.assignment.reason.length, 2000);
  assert.ok(saved.assignment.reason.startsWith('[redacted]'));
  for (const key of ['grants', 'controller', 'launchPromise']) assert.equal(saved[key], undefined);
  const loaded = store.load().tasks;
  assert.equal(loaded[0].status, 'paused');
  assert.deepEqual(loaded[0].assignment, saved.assignment);
  assert.equal(loaded[1].assignment, undefined);
});
