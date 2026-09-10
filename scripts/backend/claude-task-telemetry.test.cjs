'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const ts = require('typescript');
const { createAgentTelemetryManager, notifyHookSource } = require('../../backend/agentTelemetry.cjs');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
const { createSessionDirectory } = require('../../backend/orchestratorIntegration.cjs');
const capabilities = require('../../shared/providerCapabilities.json');
const file = path.resolve(__dirname, '../../frontend/terminalRuntime.ts');
const ui = new Module(file, module);
ui._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, file);

async function fixture(t, engine = 'node', provider = 'claude', now = Date.now) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-claude-tasks-'));
  const runtime = createTerminalRuntime({ capabilities: p => capabilities[p], now });
  const launch = runtime.beginLaunch({ id: 'pane', provider, cwd: root, launchToken: 1, threadRef: { provider, id: 'root' } });
  const event = (type, fields = {}) => runtime.ingest({ id: 'pane', generation: launch.generation,
    providerThreadId: 'root', type, ...fields });
  event('created');
  const events = [];
  const manager = createAgentTelemetryManager({ baseDir: path.join(root, 'shims'), openCodeHome: path.join(root, 'opencode'),
    emit: e => { events.push(e); runtime.ingest(e); } });
  t.after(() => {
    manager.cleanup(); runtime.dispose();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('lina-claude-tasks-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const instrumentation = await manager.prepareSession('pane', { provider, generation: launch.generation });
  const observer = path.join(root, 'notify.cjs');
  fs.writeFileSync(observer, notifyHookSource());
  const hook = (name, fields = {}) => new Promise((resolve, reject) => {
    const type = { UserPromptSubmit: 'agent.running', PreToolUse: 'agent.running', PostToolUse: 'agent.running',
      PostToolUseFailure: 'agent.running', SubagentStart: 'agent.subagent.started', SubagentStop: 'agent.subagent.stopped', Stop: 'agent.completed' }[name];
    const args = engine === 'powershell' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(manager.runDir, 'notify.ps1')]
      : [observer];
    args.push(type);
    if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(name)) args.push('tool');
    const child = spawn(engine === 'powershell' ? 'powershell.exe' : process.execPath, args, {
      env: { ...process.env, ...instrumentation.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => {
      try { assert.equal(code, 0, stderr); assert.equal(stdout, ''); assert.equal(stderr, ''); resolve(); }
      catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ hook_event_name: name, session_id: 'root', ...fields }));
  });
  const state = () => runtime.getSnapshot('pane');
  const directory = createSessionDirectory({ getRuntime: () => runtime });
  const display = (label, status = label === 'working' ? 'running' : 'idle') => {
    assert.equal(ui.exports.runtimeStatusLabel(state()), label);
    assert.equal(ui.exports.runtimeSessionStatus(state()), status);
    assert.equal(directory.get('pane').status, label === 'response available' ? 'response' : label === 'working' ? 'running' : label);
    assert.notEqual(state().turnState, 'completed', 'Child settlement is not proof of root completion');
  };
  return { event, hook, state, display, events, runtime, launch };
}

for (const engine of ['node', ...(process.platform === 'win32' ? ['powershell'] : [])]) {
  test(`Claude ${engine}: completed Agent result settles a stopped child without changing the root response`, async t => {
    const f = await fixture(t, engine);
    await f.hook('UserPromptSubmit');
    await f.hook('SubagentStart', { agent_id: 'child', agent_type: 'Explore' });
    await f.hook('SubagentStop', { agent_id: 'child', stop_hook_active: false });
    await f.hook('Stop');
    f.display('activity unverified');
    const end = f.state().turnEndedAt;
    await f.hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'delegate',
      tool_response: { agentId: 'child', status: 'completed', prompt: 'PRIVATE_RESULT', content: ['PRIVATE_RESULT'] } });
    assert.equal(f.state().childActivity, false);
    f.display('response available');
    assert.equal(f.state().turnEndedAt, end);
    assert.ok(!JSON.stringify(f.events).includes('PRIVATE_RESULT'));
  });

  test(`Claude ${engine}: detached children settle from later root snapshots while other background work survives`, async t => {
    const f = await fixture(t, engine);
    await f.hook('UserPromptSubmit');
    await f.hook('SubagentStart', { agent_id: 'child', agent_type: 'Explore' });
    await f.hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'delegate',
      tool_response: { agentId: 'child', status: 'async_launched', isAsync: true, prompt: 'PRIVATE_RESULT' } });
    const shell = { id: 'shell', type: 'shell', status: 'running', command: 'PRIVATE_COMMAND', description: 'PRIVATE_DESCRIPTION' };
    await f.hook('Stop', { background_tasks: [{ id: 'child', type: 'subagent', status: 'running' }, shell] });
    assert.equal(f.state().children.length, 2, 'The task snapshot must not double-count a native child');
    f.display('working');
    const end = f.state().turnEndedAt;
    await f.hook('SubagentStop', { agent_id: 'child', background_tasks: [] });
    assert.equal(f.state().children.length, 2, 'A child stop cannot reconcile the parent registry');
    await f.hook('Stop', { background_tasks: [shell] });
    assert.equal(f.state().children.length, 1);
    assert.ok(!f.state().children.some(c => c.id === 'child'));
    f.display('working');
    await f.hook('Stop', { background_tasks: [] });
    assert.equal(f.state().childActivity, false);
    f.display('response available');
    assert.equal(f.state().turnEndedAt, end, 'Repeated snapshots do not move the root response time');
    assert.ok(!JSON.stringify(f.events).includes('PRIVATE_'));
  });

  test(`Claude ${engine}: empty root registry resolves a provisional child whose launch result was missed`, async t => {
    const f = await fixture(t, engine);
    await f.hook('UserPromptSubmit');
    await f.hook('SubagentStart', { agent_id: 'child' });
    await f.hook('SubagentStop', { agent_id: 'child' });
    await f.hook('Stop');
    f.display('activity unverified');
    await f.hook('Stop', { background_tasks: [] });
    assert.equal(f.state().childActivity, false);
    f.display('response available');
  });

  test(`Claude ${engine}: partial snapshots and async launch receipts do not claim a child is finished or resumed`, async t => {
    const f = await fixture(t, engine);
    await f.hook('UserPromptSubmit');
    await f.hook('SubagentStart', { agent_id: 'child' });
    await f.hook('SubagentStop', { agent_id: 'child' });
    await f.hook('Stop');
    const endedAt = f.state().turnEndedAt;
    await f.hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'call', tool_response: { agentId: 'child', status: 'async_launched', isAsync: true } });
    f.display('activity unverified');
    await f.hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'invalid-result',
      tool_response: { agentId: 'child', status: 'completed', isAsync: 'false' } });
    assert.equal(f.state().children.length, 1, 'Invalid completion schema is not evidence that the child ended');
    await f.hook('Stop', { background_tasks: [{ id: 'new-shell', type: 'shell', status: 'running' }, null] });
    assert.deepEqual(f.state().children.map(c => c.id), ['child'], 'Reject the entire malformed snapshot');
    f.display('activity unverified');
    await f.hook('Stop', { agent_id: 'other-child', background_tasks: [] });
    assert.ok(f.state().children.some(c => c.id === 'child'), 'Child-scoped Stop is not a root registry snapshot');
    assert.equal(f.state().turnEndedAt, endedAt);
    await f.hook('UserPromptSubmit');
    const before = f.events.length;
    await f.hook('Stop', { background_tasks: Array.from({ length: 256 }, (_, i) => ({
      id: `task-${i}-`.padEnd(256, 'a'), type: 'subagent', status: 'running' })) });
    assert.equal(f.events.length, before + 1, 'Oversized task metadata must not suppress the root Stop callback');
    assert.equal(f.events.at(-1).claudeBackgroundTasks, undefined);
    assert.equal(f.state().turnState, 'response');
    assert.ok(f.state().children.some(c => c.id === 'child'));
  });
}

test('Claude missing or malformed task snapshots cannot erase unresolved children', async t => {
  const f = await fixture(t);
  await f.hook('UserPromptSubmit');
  await f.hook('SubagentStart', { agent_id: 'child' });
  await f.hook('SubagentStop', { agent_id: 'child' });
  for (const tasks of [undefined, null, {}, '[]', [null], [{ id: 'child', type: 'subagent', status: 'unknown' }],
    [{ id: 'bad/path', type: 'subagent', status: 'running' }],
    Array.from({ length: 257 }, (_, n) => ({ id: `task-${n}`, type: 'subagent', status: 'running' }))]) {
    await f.hook('Stop', { background_tasks: tasks });
    assert.equal(f.state().childActivity, true);
    f.display('activity unverified');
  }
});

test('Claude stale, child-scoped and previous-generation snapshots cannot settle fresh activity', async t => {
  const f = await fixture(t);
  await f.hook('UserPromptSubmit');
  const old = Date.now();
  f.event('agent-subagent', { phase: 'start', lifecycle: 'native', taskId: 'child', observedAt: old + 10 });
  f.event('agent-subagent', { phase: 'stop', lifecycle: 'native', taskId: 'child', provisional: true, observedAt: old + 20 });
  const snapshot = { attention: { state: 'completed' }, claudeBackgroundTasks: [], observedAt: old + 30 };
  f.event('agent-attention', { ...snapshot, observedAt: old + 5 });
  f.event('agent-attention', { ...snapshot, generation: 'old-generation' });
  f.event('agent-attention', { ...snapshot, transcriptKind: 'subagent', taskId: 'different-child' });
  assert.ok(f.state().children.some(c => c.id === 'child'));
  f.event('agent-running', { transcriptKind: 'subagent', taskId: 'child', phase: 'start', turnStart: false, observedAt: old + 40 });
  f.event('agent-attention', snapshot);
  assert.equal(f.state().children.find(c => c.id === 'child').observation, 'observed');
  f.event('agent-attention', { ...snapshot, observedAt: old + 50 });
  assert.ok(f.state().children.some(c => c.id === 'child'), 'A root Stop is not a blanket clear for observed foreground children');
});

test('Claude completed nested Agent result settles its target, retaining the issuing child', async t => {
  const f = await fixture(t);
  await f.hook('UserPromptSubmit');
  await f.hook('SubagentStart', { agent_id: 'issuer' });
  await f.hook('SubagentStart', { agent_id: 'nested' });
  await f.hook('SubagentStop', { agent_id: 'nested' });
  await f.hook('PostToolUse', { agent_id: 'issuer', tool_name: 'Agent', tool_use_id: 'nested-call',
    tool_response: { agentId: 'nested', status: 'completed' } });
  assert.deepEqual(f.state().children.map(c => c.id), ['issuer']);
  f.display('working');
});

test('Claude task reconciliation metadata cannot settle other providers', async t => {
  const f = await fixture(t, 'node', 'qwen');
  await f.hook('UserPromptSubmit');
  await f.hook('SubagentStart', { agent_id: 'child' });
  await f.hook('SubagentStop', { agent_id: 'child' });
  await f.hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'call', tool_response: { agentId: 'child', status: 'completed' } });
  await f.hook('Stop', { background_tasks: [] });
  assert.equal(f.state().childActivity, true);
  assert.ok(f.events.every(e => e.claudeTaskResult === undefined && e.claudeBackgroundTasks === undefined));
});

test('Claude a later root snapshot clears old provisional children while preserving pending input and native end fences', async t => {
  const at = 10000;
  let time = at;
  const f = await fixture(t, 'node', 'claude', () => time);
  f.event('agent-running', { turnStart: true, observedAt: at });
  f.event('agent-subagent', { phase: 'start', taskId: 'child', lifecycle: 'native', observedAt: at + 1 });
  f.event('agent-subagent', { phase: 'stop', taskId: 'child', lifecycle: 'native', provisional: true, observedAt: at + 2 });
  f.event('agent-attention', { attention: { state: 'completed' }, observedAt: at + 3 });
  time = at + 4;
  f.runtime.recordInput({ id: 'pane', generation: f.launch.generation, data: 'next task\r' });
  f.event('agent-attention', { attention: { state: 'completed' }, claudeBackgroundTasks: [], observedAt: at + 10 });
  assert.equal(f.state().children.length, 0);
  assert.equal(f.state().pendingInput, 'submit', 'Child settlement does not acknowledge a later prompt');
  assert.equal(f.state().turnEndedAt, at + 3);
  f.event('agent-subagent', { phase: 'stop', taskId: 'child', lifecycle: 'native', provisional: true, observedAt: at + 10 });
  f.event('agent-subagent', { phase: 'start', taskId: 'child', lifecycle: 'native', observedAt: at + 9 });
  assert.equal(f.state().children.length, 0, 'Delayed or tied stops cannot resurrect a settled child');
  f.event('agent-subagent', { phase: 'start', taskId: 'child', lifecycle: 'native', observedAt: at + 11 });
  assert.equal(f.state().children.length, 1, 'Later native continuation is observable');
});

test('Claude task snapshots retain unclassified provisional descendants while a background parent is active', async t => {
  const f = await fixture(t);
  await f.hook('UserPromptSubmit');
  await f.hook('SubagentStart', { agent_id: 'nested' });
  await f.hook('SubagentStop', { agent_id: 'nested' });
  await f.hook('Stop', { background_tasks: [{ id: 'parent', type: 'subagent', status: 'pending' }] });
  assert.deepEqual(f.state().children.map(c => c.id).sort(), ['nested', 'parent']);
  assert.equal(f.state().children.find(c => c.id === 'nested').observation, 'provisional');
  f.display('working');
  await f.hook('Stop', { background_tasks: [] });
  assert.equal(f.state().childActivity, false);
  f.display('response available');
});
