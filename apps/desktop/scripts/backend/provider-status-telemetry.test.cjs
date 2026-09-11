const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
const { createAgentTelemetryManager } = require('../../backend/agentTelemetry.cjs');
const { hookMetadata } = require('../../backend/providerHookMetadata.cjs');
const { openCodePluginSource, buildClaudeSettingsJson, codexLifecycleConfigOverrides, cursorTypeFromStatus, qwenHookGroups, mapTelemetryToAttention } = require('../../backend/agentTelemetry.cjs');

test('native child identity is independent of Task and Agent tool lifetime', () => {
  for (const tool_name of ['Task', 'Agent']) {
    const tool = hookMetadata({ hook_event_name: 'PostToolUseFailure', tool_name, tool_use_id: 'call-1' });
    assert.equal(tool.kind, 'tool');
    assert.equal(tool.phase, 'stop');
    assert.equal(tool.lifecycle, undefined);
  }
  const stop = hookMetadata({ hook_event_name: 'SubagentStop', session_id: 'parent', agent_id: 'child', agent_type: 'Explore' });
  assert.equal(stop.taskId, 'child');
  assert.equal(stop.lifecycle, 'native');
  assert.equal(stop.provisional, true);
  const hooks = JSON.parse(buildClaudeSettingsJson('/observer', false)).hooks;
  assert.ok(hooks.SubagentStart && hooks.SubagentStop);
  assert.ok(hooks.StopFailure[0].hooks[0].command.includes('agent.failed'));
  assert.ok(hooks.PermissionRequest);
  assert.equal(hooks.Notification, undefined);
  const codex = codexLifecycleConfigOverrides('/node', '/observer', false);
  assert.ok(codex.some(value => value.startsWith('hooks.SubagentStart=')));
  assert.ok(codex.some(value => value.startsWith('hooks.SubagentStop=')));
  assert.equal(cursorTypeFromStatus('aborted'), 'agent.response');
  for (const hook_event_name of ['PreToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop']) {
    assert.equal(hookMetadata({ hook_event_name, agent_id: 'child', session_id: 'parent' }).transcriptKind, 'subagent');
    assert.equal(hookMetadata({ hook_event_name, agent_type: 'custom-root', session_id: 'parent' }).transcriptKind, undefined);
  }
  assert.equal(stop.transcriptKind, undefined);
  assert.ok(qwenHookGroups('/observer', false).PostToolUseFailure);
  assert.equal(mapTelemetryToAttention({ type: 'agent.waiting', notificationType: 'idle_prompt' }), null);
});

test('OpenCode child permission resumes through authenticated telemetry without changing the root turn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-child-resume-'));
  const runtime = createTerminalRuntime();
  const launch = runtime.beginLaunch({ id: 'pane', launchToken: 1, provider: 'opencode', cwd: root });
  const manager = createAgentTelemetryManager({ baseDir: path.join(root, 'shims'), openCodeHome: path.join(root, 'opencode'), emit: event => runtime.ingest(event) });
  t.after(() => {
    manager.cleanup(); runtime.dispose();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('vibe-child-resume-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  runtime.ingest({ id: 'pane', generation: launch.generation, type: 'created', cols: 80, rows: 24 });
  runtime.ingest({ id: 'pane', generation: launch.generation, type: 'agent-process', phase: 'start', pid: 42 });
  const instrument = await manager.prepareSession('pane', { generation: launch.generation, provider: 'opencode' });
  const factory = vm.runInNewContext(openCodePluginSource().replace('export const VibeTerminalNotify', 'const VibeTerminalNotify') + '; VibeTerminalNotify;',
    { process: { env: instrument.env }, fetch, AbortSignal, Date });
  const plugin = await factory();
  const send = (type, properties) => plugin.event({ event: { type, properties } });
  const snapshot = () => runtime.getSnapshot('pane');
  const rootState = () => {
    const s = snapshot();
    return { turnState: s.turnState, turnId: s.turnId, turnStartedAt: s.turnStartedAt, turnEndedAt: s.turnEndedAt, attention: s.attention };
  };
  await send('session.created', { info: { id: 'root', directory: root } });
  await send('session.status', { sessionID: 'root', status: { type: 'busy' } });
  await send('session.status', { sessionID: 'root', status: { type: 'idle' } });
  const baseline = rootState();
  await send('session.created', { info: { id: 'child', parentID: 'root', directory: root } });
  await send('session.status', { sessionID: 'child', status: { type: 'busy' } });
  for (const resume of ['busy', 'delta']) {
    await send('permission.asked', { sessionID: 'child' });
    assert.equal(snapshot().children.find(item => item.id === 'child').attention.reason, 'approval');
    if (resume === 'busy') await send('session.status', { sessionID: 'child', status: { type: 'busy' } });
    else await send('message.part.delta', { sessionID: 'child' });
    assert.equal(snapshot().children.find(item => item.id === 'child').attention, undefined, resume);
    assert.deepEqual(rootState(), baseline, `${resume} must not alter the root turn`);
  }
});

test('OpenCode metadata and late assistant messages cannot invent turns; approval resumes on delta', async () => {
  const savedFetch = global.fetch;
  const keys = ['VIBE_TERMINAL_CALLBACK_URL', 'VIBE_TERMINAL_TELEMETRY_TOKEN', 'VIBE_TERMINAL_SESSION_ID', 'VIBE_TERMINAL_LAUNCH_NONCE'];
  const saved = keys.map(key => process.env[key]);
  const events = [];
  try {
    for (const key of keys) process.env[key] = 'fixture';
    global.fetch = async (_url, opts) => { events.push(JSON.parse(opts.body)); return {}; };
    const create = new Function(openCodePluginSource().replace('export const VibeTerminalNotify', 'const VibeTerminalNotify') + '; return VibeTerminalNotify;')();
    const plugin = await create();
    const send = (type, extra = {}) => plugin.event({ event: { type, properties: { sessionID: 'root', ...extra } } });
    await send('session.updated', { info: { id: 'root' } });
    events.length = 0;
    await send('message.removed');
    await send('message.updated', { info: { sessionID: 'root', role: 'assistant' } });
    await send('message.updated', { info: { sessionID: 'root', role: 'user' } });
    await send('message.part.delta');
    assert.equal(events.length, 0);
    await send('session.status', { status: { type: 'busy' } });
    assert.equal(events.at(-1).type, 'agent.running');
    await send('permission.asked');
    assert.equal(events.at(-1).type, 'agent.waiting');
    await send('message.part.delta');
    assert.equal(events.at(-1).detail, 'tool');
    await send('session.status', { status: { type: 'idle' } });
    const count = events.length;
    await send('message.part.delta');
    await send('message.updated', { info: { sessionID: 'root', role: 'assistant' } });
    assert.equal(events.length, count);
    await send('session.created', { info: { id: 'child', parentID: 'root' } });
    const before = events.length;
    await send('message.updated', { sessionID: 'child', info: { sessionID: 'child', role: 'user' } });
    assert.equal(events.length, before, 'Child creation and replay do not manufacture running');
    await send('session.status', { sessionID: 'child', status: { type: 'busy' } });
    assert.equal(events.at(-1).type, 'agent.subagent.started');
    assert.equal(events.at(-1).taskId, 'child');
    await send('permission.asked', { sessionID: 'child' });
    assert.equal(events.at(-1).parentThreadId, 'root');
    assert.equal(events.at(-1).type, 'agent.waiting');
    await send('session.status', { sessionID: 'child', status: { type: 'idle' } });
    assert.equal(events.at(-1).type, 'agent.subagent.stopped');
    assert.equal(events.at(-1).provisional, true);
    await send('session.status', { sessionID: 'unseen', status: { type: 'busy' } });
    assert.equal(events.at(-1).rootVerified, false, 'Unseen session is never guessed to be a root');
  } finally {
    global.fetch = savedFetch;
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
  }
});
