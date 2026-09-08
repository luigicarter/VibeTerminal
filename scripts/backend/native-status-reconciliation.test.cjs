'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
const { createAgentTelemetryManager, openCodePluginSource, codexLifecycleHookSource, notifyHookSource } = require('../../backend/agentTelemetry.cjs');
const { geminiHookSource } = require('../../backend/geminiTelemetry.cjs');
const { validateResultEvidence } = require('../../backend/orchestratorResultReports.cjs');
const capabilities = require('../../shared/providerCapabilities.json');

async function fixture(t, provider) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-native-status-reconcile-'));
  const runtime = createTerminalRuntime({ capabilities: p => capabilities[p] });
  const launch = runtime.beginLaunch({ id: 'pane', provider, launchToken: 1, cwd: root,
    threadRef: { provider, id: 'root' } });
  const event = (type, extra = {}) => runtime.ingest({ id: 'pane', generation: launch.generation, type, ...extra });
  event('created');
  const events = [];
  const manager = createAgentTelemetryManager({ baseDir: path.join(root, 'shims'), openCodeHome: path.join(root, 'opencode'),
    emit: e => { events.push(e); runtime.ingest(e); } });
  t.after(() => {
    manager.cleanup(); runtime.dispose();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('vibe-native-status-reconcile-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const instrumentation = await manager.prepareSession('pane', { provider, generation: launch.generation });
  const run = (source, hook, args = []) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source, 'fixture', ...args], {
      env: { ...process.env, ...instrumentation.env }, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `Observer exited ${code}`)));
    child.stdin.end(JSON.stringify(hook));
  });
  return { runtime, launch, events, instrumentation, event, run, state: () => runtime.getSnapshot('pane'),
    input: data => runtime.recordInput({ id: 'pane', generation: launch.generation, data }) };
}

test('OpenCode duplicate idle channels preserve a newer submit until fresh activity', async t => {
  const f = await fixture(t, 'opencode');
  const factory = vm.runInNewContext(openCodePluginSource().replace('export const VibeTerminalNotify', 'const VibeTerminalNotify') + '; VibeTerminalNotify;',
    { process: { env: f.instrumentation.env }, fetch, AbortSignal, Date });
  const plugin = await factory();
  const send = (type, properties) => plugin.event({ event: { type, properties } });
  await send('session.created', { info: { id: 'root' } });
  await send('session.status', { sessionID: 'root', status: { type: 'busy' } });
  await send('session.status', { sessionID: 'root', status: { type: 'idle' } });
  const endedAt = f.state().turnEndedAt;
  f.input('next task\r');
  await send('session.idle', { sessionID: 'root' });
  assert.equal(f.state().pendingInput, 'submit');
  assert.equal(f.state().turnEndedAt, endedAt);
  await send('session.status', { sessionID: 'root', status: { type: 'busy' } });
  assert.equal(f.state().pendingInput, undefined);
  assert.equal(f.state().turnState, 'running');
});

test('Gemini duplicate provisional AfterAgent cannot acknowledge the next prompt', async t => {
  const f = await fixture(t, 'gemini');
  const hook = hook_event_name => f.run(geminiHookSource(), { hook_event_name, session_id: 'root' });
  await hook('BeforeAgent');
  await hook('AfterAgent');
  const endedAt = f.state().turnEndedAt;
  f.input('next task\r');
  await hook('AfterAgent');
  assert.equal(f.state().pendingInput, 'submit');
  assert.equal(f.state().turnEndedAt, endedAt);
  await hook('BeforeAgent');
  assert.equal(f.state().pendingInput, undefined);
  assert.equal(f.state().turnState, 'running');
});

test('Claude delayed PostToolUse preserves a newer prompt through both telemetry events', async t => {
  const f = await fixture(t, 'claude');
  const hook = (hook_event_name, type, detail) => f.run(notifyHookSource(), {
    hook_event_name, session_id: 'root', tool_use_id: 'old-tool', tool_name: 'Read'
  }, [type, ...(detail ? [detail] : [])]);
  await hook('UserPromptSubmit', 'agent.running');
  await hook('PreToolUse', 'agent.running', 'tool');
  await hook('Stop', 'agent.completed');
  const endedAt = f.state().turnEndedAt;
  f.input('next task\r');
  await hook('PostToolUse', 'agent.running', 'tool');
  assert.equal(f.state().pendingInput, 'submit');
  assert.equal(f.state().turnState, 'response');
  assert.equal(f.state().turnEndedAt, endedAt);
  assert.equal(f.events.at(-1).phase, 'stop');
  await hook('UserPromptSubmit', 'agent.running');
  assert.equal(f.state().pendingInput, undefined);
  assert.equal(f.state().turnState, 'running');
});

test('Codex provisional child Stop blocks result proof until matching generated post-gate notify', async t => {
  const f = await fixture(t, 'codex');
  const lifecycle = hook => f.run(codexLifecycleHookSource(), hook);
  const notify = (thread, turn) => f.run(notifyHookSource(), {}, ['agent.completed',
    JSON.stringify({ type: 'agent-turn-complete', 'thread-id': thread, 'turn-id': turn })]);
  await lifecycle({ hook_event_name: 'UserPromptSubmit', session_id: 'root', turn_id: 'root-turn' });
  await lifecycle({ hook_event_name: 'SubagentStart', session_id: 'root', agent_id: 'child', agent_type: 'executor' });
  const child = { session_id: 'child', turn_id: 'child-turn', agent_id: 'child', agent_type: 'executor' };
  await lifecycle({ ...child, hook_event_name: 'PreToolUse', tool_use_id: 'read', tool_name: 'Read' });
  await notify('root', 'root-turn');
  const evidence = { turnId: 'root-turn', status: 'completed', at: f.state().turnEndedAt, source: 'terminal-screen', text: 'Root result' };
  assert.equal(validateResultEvidence(f.state(), evidence), undefined);
  await lifecycle({ ...child, hook_event_name: 'SubagentStop', stop_hook_active: false });
  assert.equal(f.events.at(-1).provisional, true, 'Actual observer marks the pre-gate Stop provisional');
  assert.equal(f.state().childActivity, true);
  assert.equal(f.state().children[0].observation, 'provisional');
  assert.equal(f.state().children[0].providerThreadId, 'child');
  assert.equal(f.state().children[0].providerTurnId, 'child-turn');
  assert.equal(validateResultEvidence(f.state(), evidence), undefined);
  await notify('child', 'older-child-turn');
  assert.equal(f.state().childActivity, true, 'Different native child turn cannot settle current proof');
  await lifecycle({ ...child, hook_event_name: 'PreToolUse', tool_use_id: 'continued', tool_name: 'Read' });
  assert.equal(f.state().children[0].observation, 'observed');
  await lifecycle({ ...child, hook_event_name: 'SubagentStop', stop_hook_active: true });
  assert.equal(f.state().children[0].observation, 'provisional');
  await notify('child', 'child-turn');
  assert.equal(f.events.at(-1).providerThreadId, 'child');
  assert.equal(f.events.at(-1).rootVerified, undefined, 'Child notify cannot masquerade as a conflicting selected root');
  assert.equal(f.state().binding.status, 'found');
  assert.equal(f.state().childActivity, false);
  assert.ok(validateResultEvidence(f.state(), evidence));
});

test('OpenCode delayed provisional idle cannot erase newer child activity', async t => {
  const f = await fixture(t, 'opencode');
  let time = Date.now() - 1000, releaseStop;
  const gate = new Promise(resolve => { releaseStop = resolve; });
  const sendFetch = async (url, options) => {
    if (JSON.parse(options.body).type === 'agent.subagent.stopped') await gate;
    return fetch(url, options);
  };
  const factory = vm.runInNewContext(openCodePluginSource().replace('export const VibeTerminalNotify', 'const VibeTerminalNotify') + '; VibeTerminalNotify;',
    { process: { env: f.instrumentation.env }, fetch: sendFetch, AbortSignal, Date: { now: () => ++time } });
  const plugin = await factory();
  const send = (type, properties) => plugin.event({ event: { type, properties } });
  await send('session.created', { info: { id: 'root' } });
  await send('session.created', { info: { id: 'child', parentID: 'root' } });
  await send('session.status', { sessionID: 'child', status: { type: 'busy' } });
  const stopping = send('session.idle', { sessionID: 'child' });
  await send('session.status', { sessionID: 'child', status: { type: 'busy' } });
  const observedAt = f.state().children[0].observedAt;
  releaseStop(); await stopping;
  assert.equal(f.state().children[0].observation, 'observed');
  assert.equal(f.state().children[0].observedAt, observedAt);
  await send('session.idle', { sessionID: 'child' });
  assert.equal(f.state().children[0].observation, 'provisional');
  assert.equal(f.state().childActivity, true, 'OpenCode idle is not an authoritative post-gate settlement');
  f.event('agent-session', { phase: 'end', providerThreadId: 'child', parentThreadId: 'root', observedAt: ++time });
  assert.equal(f.state().childActivity, false, 'An explicit native session end settles retained proof');
});

test('anonymous native stops retain unverified coarse proof without claiming an exact child count', async t => {
  const f = await fixture(t, 'qwen');
  const hook = hook_event_name => f.run(notifyHookSource(), { hook_event_name, session_id: 'root' },
    [hook_event_name === 'SubagentStart' ? 'agent.subagent.started' : 'agent.subagent.stopped']);
  await hook('SubagentStart');
  assert.equal(f.state().coarseChildObservation, 'observed');
  await hook('SubagentStop');
  assert.equal(f.state().coarseChildObservation, 'provisional');
  assert.equal(f.state().childActivity, true);
  assert.deepEqual(f.state().children, []);
  await hook('SubagentStart');
  assert.equal(f.state().coarseChildObservation, 'observed', 'Fresh anonymous activity is visible');
});

test('Kimi nested Agent tool fallback cannot erase its issuing child lifetime', async t => {
  const f = await fixture(t, 'kimi');
  const hook = (type, hook_event_name, fields) => f.run(notifyHookSource(), {
    hook_event_name, session_id: 'root', ...fields
  }, [type, ...(type === 'agent.running' ? ['tool'] : [])]);
  const issuer = { agent_id: 'worker', tool_name: 'Read', tool_use_id: 'read' };
  await hook('agent.running', 'PreToolUse', issuer);
  assert.deepEqual(f.state().children.map(child => child.id), ['worker']);
  const delegation = { agent_id: 'worker', tool_name: 'Agent', tool_use_id: 'delegate' };
  await hook('agent.subagent.started', 'PreToolUse', delegation);
  assert.deepEqual(f.state().children.map(child => child.id).sort(), ['tool:delegate', 'worker']);
  await hook('agent.subagent.stopped', 'PostToolUse', delegation);
  assert.deepEqual(f.state().children.map(child => child.id), ['worker']);
  assert.equal(f.state().childActivity, true);

  // A root foreground fallback still cleans up its own tool bracket.
  const foreground = { tool_name: 'Agent', tool_use_id: 'foreground' };
  await hook('agent.subagent.started', 'PreToolUse', foreground);
  assert.ok(f.state().children.some(child => child.id === 'tool:foreground'));
  await hook('agent.subagent.stopped', 'PostToolUse', foreground);
  assert.deepEqual(f.state().children.map(child => child.id), ['worker']);

  // Missing tool IDs remain coarse, never aliases for the issuing agent ID.
  const anonymous = { agent_id: 'worker', tool_name: 'Agent' };
  await hook('agent.subagent.started', 'PreToolUse', anonymous);
  assert.equal(f.state().coarseChildObservation, 'observed');
  await hook('agent.subagent.stopped', 'PostToolUse', anonymous);
  assert.equal(f.state().coarseChildObservation, undefined);
  assert.deepEqual(f.state().children.map(child => child.id), ['worker']);
  await hook('agent.subagent.started', 'SubagentStart', {});
  await hook('agent.subagent.stopped', 'SubagentStop', {});
  assert.equal(f.state().coarseChildObservation, 'provisional');
  await hook('agent.subagent.started', 'PreToolUse', anonymous);
  await hook('agent.subagent.stopped', 'PostToolUse', anonymous);
  assert.equal(f.state().coarseChildObservation, 'provisional', 'Fallback settlement cannot clear unresolved native coarse proof');
});
