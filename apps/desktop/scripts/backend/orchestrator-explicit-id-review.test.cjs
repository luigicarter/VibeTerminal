'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { reviewExistingTargets } = require('../../backend/orchestratorTargetReview.cjs');
const sessions = [
  { id: 'session_one_123', generation: 'g1', name: 'First unrelated discussion', kind: 'terminal', cwd: 'C:/project' },
  { id: 'session_two_456', generation: 'g2', name: 'Second unrelated discussion', kind: 'terminal', cwd: 'C:/project' }
];
function review(instruction, index = 0) {
  const target = sessions[index];
  return reviewExistingTargets({ grants: [{ sourceUserId: 'request', kind: 'send_prompt', targets: [{ id: target.id, generation: target.generation }], text: 'Write-Output test' }] },
    { requestId: 'request', instruction, sessions, projectContext: { path: 'C:/project' } });
}
test('typed exact pane ID authorizes only its addressed recipient', () => {
  assert.equal(review('Send session_one_123: Write-Output test').decision, 'DIRECT');
  assert.equal(review('Send to terminal session_one_123: Write-Output test').decision, 'DIRECT');
  assert.equal(review('Send session_one_123: mention Second unrelated discussion in the report').decision, 'DIRECT');
  assert.equal(review('Send session_one_123: Write-Output test', 1).decision, 'ASSIGN');
});
test('IDs appearing only inside task text or as longer lookalikes do not select a pane', () => {
  assert.equal(review('Use a Codex terminal to print session_one_123: in a report').decision, 'ASSIGN');
  assert.equal(review('Send session_one_123_extra: Write-Output test').decision, 'ASSIGN');
});
