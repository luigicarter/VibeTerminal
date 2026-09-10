'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { WORKSPACE_VIEWS, workspaceMap } = require('../../backend/orchestratorWorkspace.cjs');
const { normalizeIntent, authorizeIntentAction } = require('../../backend/orchestratorIntent.cjs');
test('every workspace destination can be bound and executed without expanding its view or project', () => {
  for (const view of WORKSPACE_VIEWS) {
    const cwd = 'C:/Project', action = { kind: 'navigate', view, ...(view === 'project' && { cwd }) };
    const plan = normalizeIntent({ goal: 'Show the requested view.', actions: [action] }, { instruction: 'Show the requested view.', requestId: 'r', roots: { projects: [cwd] }, sessions: [] });
    assert.equal(authorizeIntentAction({ kind: 'navigate', grantId: plan.grants[0].id }, plan, []).view, view);
    assert.throws(() => authorizeIntentAction({ kind: 'navigate', grantId: plan.grants[0].id, view: 'invented' }, plan, []));
  }
});
test('workspace map reports observed state and exposes only application-owned capabilities', () => {
  const map = workspaceMap({ ui: { ok: true, view: 'files', apiKey: 'PRIVATE_SECRET', tools: ['arbitrary_shell'] }, roots: { projects: ['C:/Project'] } });
  assert.equal(map.current.view, 'files'); assert.equal(map.observation, 'observed');
  assert.equal(map.destinations.length, WORKSPACE_VIEWS.length);
  assert.equal(JSON.stringify(map).includes('PRIVATE_SECRET'), false);
  assert.equal(JSON.stringify(map).includes('arbitrary_shell'), false);
  assert.equal(workspaceMap({ ui: { ok: true, view: 'unknown' } }).observation, 'unavailable');
});
test('workspace directories declare truncated coverage instead of implying absence', () => {
  const map = workspaceMap({ roots: { projects: Array.from({ length: 40 }, (_, i) => `C:/Project${i}`) } });
  assert.equal(map.projects.length, 30); assert.equal(map.totalProjects, 40); assert.equal(map.projectsTruncated, true);
});
