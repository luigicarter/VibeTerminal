'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const { checkpoint, checkpointFromStorage } = require('../qa/workspace-fixture.cjs');
const wanted = { workspaces: [{ id: 'fixture', path: 'C:/fixture', name: 'Fixture', sessions: [] }], multiSessions: [], activeWorkspaceId: 'fixture', activeView: 'project' };
function context() {
  let ready = false;
  const calls = [], values = new Map([
    ['vibe-terminal:workspaces:v2', JSON.stringify(wanted.workspaces)],
    ['vibe-terminal:active-workspace:v1', 'fixture']
  ]);
  return { calls, values, ready: () => { ready = true; }, scope: {
    document: { querySelector: () => ready ? {} : null }, localStorage: { getItem: key => values.get(key) || null },
    crypto: { randomUUID: () => 'fixture' }, Date, setTimeout,
    window: { vibe: { chats: { checkpoint: async value => { calls.push(JSON.parse(JSON.stringify(value.workspace))); return { saved: true }; } } } }
  } };
}
test('fixture checkpoint waits for the initial renderer bootstrap before seeding', async () => {
  const f = context(), pending = vm.runInNewContext(checkpoint(wanted), f.scope);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 0);
  f.calls.push({ workspaces: [], multiSessions: [] }); f.ready();
  await pending; assert.deepEqual(f.calls.at(-1), wanted);
});
test('a bootstrap localStorage refresh cannot erase the captured fixture snapshot', async () => {
  const f = context(), pending = vm.runInNewContext(checkpointFromStorage, f.scope);
  f.values.set('vibe-terminal:workspaces:v2', '[]');
  f.values.delete('vibe-terminal:active-workspace:v1'); f.ready();
  await pending; assert.deepEqual(f.calls[0], wanted);
});
