'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
const { createSessionDirectory } = require('../../backend/orchestratorIntegration.cjs');
const { projectAgent } = require('../../backend/orchestratorAgents.cjs');
function fixture(t) {
  let time = 100;
  const runtime = createTerminalRuntime({ now: () => ++time }); t.after(() => runtime.dispose());
  const { generation } = runtime.beginLaunch({ id: 'pane', provider: 'claude', cwd: process.cwd(), launchToken: 1 });
  const emit = (type, extra = {}) => runtime.ingest({ id: 'pane', generation, providerThreadId: 'root', rootVerified: true, type, ...extra });
  emit('created'); emit('agent-running', { turnStart: true });
  return { runtime, generation, emit, snapshot: () => runtime.getSnapshot('pane'), child: { transcriptKind: 'subagent', taskId: 'worker' } };
}
test('unidentified native child approval survives unrelated returns and provisional Stop', t => {
  const f = fixture(t);
  f.emit('agent-attention', { ...f.child, toolName: 'Bash', attention: { state: 'waiting', reason: 'approval' } });
  f.emit('agent-running', { ...f.child, toolName: 'Read', toolId: 'unrelated', phase: 'stop', turnStart: false });
  let child = f.snapshot().children[0];
  assert.equal(child.attention.reason, 'approval'); assert.equal(child.approvals[0].identity, 'unidentified');
  f.emit('agent-response', f.child); child = f.snapshot().children[0];
  assert.equal(child.approvals.length, 1); assert.equal(child.observation, 'provisional');
  f.emit('agent-session', { ...f.child, phase: 'end' }); assert.equal(f.snapshot().children.length, 0);
});
test('two same-name child approvals settle independently and duplicate late hooks do not reopen them', t => {
  const f = fixture(t);
  for (const toolId of ['attempt-a', 'attempt-b']) f.emit('agent-attention', { ...f.child, toolName: 'Bash', toolId, attention: { state: 'waiting', reason: 'approval' } });
  assert.equal(f.snapshot().children[0].approvals.length, 2);
  f.emit('agent-activity', { ...f.child, toolName: 'Bash', toolId: 'attempt-a', phase: 'stop' });
  assert.equal(f.snapshot().children[0].attention.toolId, 'attempt-b');
  f.emit('agent-attention', { ...f.child, toolName: 'Bash', toolId: 'attempt-a', attention: { state: 'waiting', reason: 'approval' } });
  assert.equal(f.snapshot().children[0].approvals.length, 1);
  f.emit('agent-running', { ...f.child, toolName: 'Bash', toolId: 'attempt-b', phase: 'stop', turnStart: false });
  assert.equal(f.snapshot().children[0].attention, undefined);
  assert.equal(f.snapshot().childActivity, true);
});
test('missing approval IDs correlate only with one earlier active attempt in the exact child', t => {
  const f = fixture(t);
  f.emit('agent-activity', { ...f.child, toolName: 'Bash', toolId: 'unique', phase: 'start' });
  f.emit('agent-attention', { ...f.child, toolName: 'Bash', attention: { state: 'waiting', reason: 'approval' } });
  assert.equal(f.snapshot().children[0].attention.toolId, 'unique');
  f.emit('agent-activity', { ...f.child, taskId: 'other', toolName: 'Bash', toolId: 'unique', phase: 'stop' });
  assert.equal(f.snapshot().children.find(c => c.id === 'worker').approvals.length, 1);
  f.emit('agent-activity', { ...f.child, toolName: 'Bash', toolId: 'unique', phase: 'stop' });
  assert.equal(f.snapshot().children.find(c => c.id === 'worker').attention, undefined);
});
test('ambiguous active tools do not resolve an unidentified approval by name', t => {
  const f = fixture(t);
  for (const toolId of ['a', 'b']) f.emit('agent-activity', { ...f.child, toolName: 'Bash', toolId, phase: 'start' });
  f.emit('agent-attention', { ...f.child, toolName: 'Bash', attention: { state: 'waiting', reason: 'approval' } });
  f.emit('agent-activity', { ...f.child, toolName: 'Bash', toolId: 'a', phase: 'stop' });
  assert.equal(f.snapshot().children[0].attention.identity, 'unidentified');
});
test('root approvals also survive unrelated tool returns and project every pending attempt', t => {
  const f = fixture(t);
  for (const toolId of ['a', 'b']) f.emit('agent-attention', { toolName: 'Bash', toolId, attention: { state: 'waiting', reason: 'approval' } });
  f.emit('agent-running', { toolName: 'Read', toolId: 'other', phase: 'stop', turnStart: false });
  assert.equal(f.snapshot().approvals.length, 2); assert.equal(f.snapshot().turnState, 'waiting');
  const directory = createSessionDirectory({ getRuntime: () => f.runtime });
  const record = projectAgent(directory.get('pane'), { agentId: 'a', state: 'bound' });
  assert.equal(record.attention.items.length, 2);
  f.emit('agent-activity', { toolName: 'Bash', toolId: 'a', phase: 'stop' });
  f.emit('agent-activity', { toolName: 'Bash', toolId: 'b', phase: 'stop' });
  assert.equal(f.snapshot().approvals.length, 0);
});
test('old generation approval cannot affect a replacement runtime', t => {
  const f = fixture(t); f.runtime.beginLaunch({ id: 'pane', provider: 'claude', cwd: process.cwd(), launchToken: 2 });
  f.emit('agent-attention', { ...f.child, attention: { state: 'waiting', reason: 'approval' } });
  assert.equal(f.snapshot().children.length, 0);
});
