'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { isTaskSubmission } = require('../../backend/orchestratorSubmission.cjs');
const { normalizeTerminalKeys, validateTerminalControls } = require('../../shared/terminalControls.cjs');
const { createTaskScheduler } = require('../../backend/orchestratorTasks.cjs');

for (const controls of [{ submit: true }, ...[' Enter ', ' CTRL-M ', 'Ctrl-J'].map(key => ({ keys: [key] })),
  ...['click', 'up'].map(action => ({ mouse: { x: 2, y: 2, button: 'left', action } }))]) {
  test(`task submission classification preserves authority and normalized controls: ${JSON.stringify(controls)}`, () => {
    const proposal = { kind: 'terminal_interact', inputPurpose: 'task', ...controls };
    assert.equal(validateTerminalControls({ ...proposal, ...(proposal.keys && { keys: normalizeTerminalKeys(proposal.keys) }) }).ok, true);
    assert.equal(isTaskSubmission(proposal), false, 'Unclaimed terminal input is not an operator task');
    assert.equal(isTaskSubmission(proposal, { operator: true }), true, 'Pre-claim scheduling uses the same accepted controls');
    assert.equal(isTaskSubmission({ ...proposal, operator: true }), true);
    assert.equal(isTaskSubmission({ ...proposal, operator: true, inputPurpose: 'interaction' }), false);
    const scheduler = createTaskScheduler(), job = scheduler.create({ text: 'Submit task' });
    scheduler.track(job, { ...proposal, actionId: 'unclaimed', targetId: 'pane', generation: 'g' }, { ok: true, status: 'written' });
    assert.equal(job.waits.length, 0);
    scheduler.track(job, { ...proposal, operator: true, actionId: 'claimed', targetId: 'pane', generation: 'g' }, { ok: true, status: 'written' });
    assert.equal(job.waits.length, 1);
  });
}

test('drafts, navigation and interaction-only mouse controls do not become task submissions', () => {
  for (const controls of [{ text: 'draft' }, { keys: ['down'] }, { mouse: { action: 'down' } }, { mouse: { action: 'move' } }]) {
    assert.equal(isTaskSubmission({ kind: 'terminal_interact', operator: true, inputPurpose: 'task', ...controls }), false);
  }
  assert.equal(isTaskSubmission({ kind: 'send_prompt' }), true);
});
