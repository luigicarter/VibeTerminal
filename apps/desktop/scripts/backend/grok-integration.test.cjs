'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { launcherCatalog } = require('../../backend/orchestratorLaunchers.cjs');
const { normalizeIntent } = require('../../backend/orchestratorIntent.cjs');
const { authorizeModelAction, identifySessionGroup } = require('../../backend/orchestratorPolicy.cjs');
const { formatDirectOutcomes } = require('../../backend/orchestratorResponse.cjs');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
const { createAgentTelemetryManager } = require('../../backend/agentTelemetry.cjs');
const { grokHookEvents } = require('../../backend/grokTelemetry.cjs');
const { lookupGrokThread } = require('../../backend/grokThreads.cjs');
const capabilities = require('../../shared/providerCapabilities.json');

test('Grok installer directories are discovered even when the app inherited an older PATH', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-grok-probe-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('vibe-grok-probe-'));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const bin = path.join(home, '.grok', 'bin');
  const custom = path.join(home, 'custom-bin');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(custom);
  const filename = process.platform === 'win32' ? 'grok.exe' : 'grok';
  fs.writeFileSync(path.join(bin, filename), 'fixture');
  const file = path.resolve(__dirname, '../../backend/cliProbe.cjs');
  const requireFrom = createRequire(file);
  const env = { PATH: '' };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, require: name => name === 'os' ? { homedir: () => home } : requireFrom(name),
    process: { platform: process.platform, env, hrtime: process.hrtime }, setTimeout, clearTimeout });
  assert.equal(module.exports.PROBED_AGENT_COMMANDS.grok, 'grok');
  let result = await module.exports.probeInstalledClis({ grok: 'grok' });
  assert.equal(result.clis.grok.path, path.join(bin, filename));
  env.GROK_BIN_DIR = custom;
  fs.writeFileSync(path.join(custom, filename), 'fixture');
  result = await module.exports.probeInstalledClis({ grok: 'grok' });
  assert.equal(result.clis.grok.path, path.join(custom, filename));
  fs.unlinkSync(path.join(custom, filename)); fs.unlinkSync(path.join(bin, filename));
  result = await module.exports.probeInstalledClis({ grok: 'grok' });
  assert.equal(result.clis.grok.available, false);
});

test('Grok participates in task creation and spoken provider selection', () => {
  const [launcher] = launcherCatalog([{ kind: 'grok', label: 'Grok Build', available: true, configured: true }]);
  assert.equal(launcher.kind, 'grok'); assert.ok(launcher.defaultRank > 0);
  assert.equal(launcher.capabilities.codingAgent, true);
  const plan = normalizeIntent({ goal: 'Review with Grok Build.', actions: [{ kind: 'delegate_task', text: 'Review the changes.', kindOfSession: 'grok', assignmentMode: 'new', cwd: process.cwd() }] },
    { instruction: 'Have Grok Build review the changes in a new terminal.', requestId: 'grok-request', sessions: [], requests: [], projects: [{ name: 'vibeTerminal', path: process.cwd() }] });
  assert.equal(plan.grants[0].args.kindOfSession, 'grok');
  const sessions = [{ id: 'g', generation: 'g1', kind: 'grok', provider: 'grok', cwd: process.cwd() },
    { id: 'c', generation: 'g2', kind: 'codex', cwd: process.cwd() }];
  for (const label of ['Grok', 'Grok Build']) {
    assert.equal(authorizeModelAction({ kind: 'focus_session' }, { text: `Focus ${label}` }, sessions).targetId, 'g');
    const group = identifySessionGroup({ text: `List ${label} terminals`, projectContext: { path: process.cwd() } }, sessions);
    assert.ok(group);
    assert.deepEqual(group.candidates, [{ id: 'g', generation: 'g1' }], 'provider selection never expands to Codex');
  }
  const text = formatDirectOutcomes([{ kind: 'create_session', ok: true, status: 'created', processState: 'running', target: { id: 'g', generation: 'g1' } }], sessions);
  assert.match(text, /Grok Build/);
  const setup = require('../../backend/workspaceSetups.cjs').sanitizeSetup({ version: 1, name: 'Grok workspace', scope: 'global', panes: [
    { localId: 'pane-1', config: { kind: 'grok', name: 'Grok Build', command: 'grok' },
      path: { kind: 'absolute', value: process.cwd() }, layout: { x: 0, y: 0, w: 560, h: 260 } }
  ] });
  assert.equal(setup.panes[0].config.kind, 'grok', 'saved workspace recipes retain Grok panes');
});

test('Grok question tool owns its wait through parallel tool callbacks and a pending answer', () => {
  let time = 10000;
  const runtime = createTerminalRuntime({ now: () => time, capabilities: p => capabilities[p] });
  const launch = runtime.beginLaunch({ id: 'g', provider: 'grok', cwd: process.cwd(), launchToken: 1 });
  const event = (type, details = {}) => runtime.ingest({ id: 'g', generation: launch.generation, providerThreadId: 'root', rootVerified: true, type, ...details });
  event('created'); event('agent-running', { providerTurnId: 'prompt-1', turnStart: true });
  const question = { toolName: 'ask_user_question', toolId: 'question-1', kind: 'tool' };
  event('agent-activity', { ...question, phase: 'start' });
  event('agent-attention', { ...question, attention: { state: 'waiting', reason: 'question' } });
  const waiting = runtime.getSnapshot('g');
  time += 1000;
  runtime.recordInput({ id: 'g', generation: launch.generation, data: 'answer\r' });
  event('agent-activity', { phase: 'stop', toolName: 'read_file', toolId: 'parallel', kind: 'tool' });
  event('agent-running', { turnStart: false, toolName: 'read_file', toolId: 'parallel' });
  assert.equal(runtime.getSnapshot('g').turnState, 'waiting');
  assert.equal(runtime.getSnapshot('g').pendingInput, 'submit');
  event('agent-activity', { ...question, phase: 'stop' });
  event('agent-running', { ...question, turnStart: false, phase: 'stop' });
  assert.equal(runtime.getSnapshot('g').turnState, 'running');
  assert.equal(runtime.getSnapshot('g').turnStartedAt, waiting.turnStartedAt);
  event('agent-activity', { ...question, phase: 'start' });
  event('agent-attention', { ...question, attention: { state: 'waiting', reason: 'question' } });
  assert.equal(runtime.getSnapshot('g').turnState, 'running', 'late question cannot reopen');
  event('agent-attention', { providerTurnId: 'prompt-1', attention: { state: 'completed' } });
  assert.equal(runtime.getSnapshot('g').turnState, 'response', 'Grok Stop is provisional even with native IDs');
});

test('authenticated Grok callbacks bind separate native roots in one folder and reject old launches', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-grok-runtime-'));
  const home = path.join(root, 'profile', '.grok');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const child = '33333333-3333-4333-8333-333333333333';
  for (const id of [...ids, child]) {
    const directory = path.join(home, 'sessions', encodeURIComponent(cwd), id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ info: { id, cwd }, session_summary: 'Fixture',
      num_messages: 1, current_model_id: 'grok-build', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      ...(id === child ? { session_kind: 'subagent', parent_session_id: ids[0] } : {}) }));
  }
  const runtime = createTerminalRuntime({ capabilities: p => capabilities[p], lookup: payload => lookupGrokThread(payload, { home }) });
  const manager = createAgentTelemetryManager({ baseDir: path.join(root, 'shims'), openCodeHome: path.join(root, 'opencode'), emit: event => runtime.ingest(event) });
  t.after(() => {
    manager.cleanup(); runtime.dispose();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('vibe-grok-runtime-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const launches = [];
  for (let i = 0; i < 2; i++) {
    const pane = `pane${i}`;
    const launch = runtime.beginLaunch({ id: pane, provider: 'grok', cwd, launchToken: 1 });
    runtime.ingest({ id: pane, generation: launch.generation, type: 'created' });
    const instrument = await manager.prepareSession(pane, { provider: 'grok', generation: launch.generation, env: { ...process.env, GROK_HOME: home } });
    launches.push({ pane, launch, instrument });
  }
  const send = async (entry, hook, expected = 204) => {
    for (const event of grokHookEvents(hook)) {
      const env = entry.instrument.env;
      const response = await fetch(env.VIBE_TERMINAL_CALLBACK_URL, { method: 'POST', headers: {
        'content-type': 'application/json', 'x-vibe-telemetry-token': env.VIBE_TERMINAL_TELEMETRY_TOKEN },
        body: JSON.stringify({ ...event, sessionId: entry.pane, launchNonce: env.VIBE_TERMINAL_LAUNCH_NONCE, timestamp: Date.now() }) });
      assert.equal(response.status, expected);
      await response.text();
    }
    await runtime.refreshRecord(runtime.getRecord(entry.pane));
  };
  await send(launches[0], { sessionId: child, subagentType: 'explore', hook_event_name: 'UserPromptSubmit' });
  assert.equal(runtime.getSnapshot('pane0').conversation, undefined, 'inherited child credentials do not establish root identity');
  // Native hints can bypass the metadata backoff after this synthetic first observation.
  runtime.getRecord('pane0').nextLookupAt = 0;
  await send(launches[0], { sessionId: ids[0], hook_event_name: 'SessionStart' });
  await send(launches[1], { sessionId: ids[1], hook_event_name: 'SessionStart' });
  for (let i = 0; i < 2; i++) assert.equal(runtime.getSnapshot(`pane${i}`).conversation.id, ids[i]);
  await send(launches[0], { sessionId: ids[0], promptId: 'prompt-1', hook_event_name: 'UserPromptSubmit' });
  await send(launches[0], { sessionId: ids[0], promptId: 'prompt-1', hook_event_name: 'Stop' });
  assert.equal(runtime.getSnapshot('pane0').turnState, 'response');
  assert.equal(runtime.getSnapshot('pane0').childActivity, true);
  assert.equal(runtime.getSnapshot('pane1').turnState, 'idle');
  const replacement = runtime.beginLaunch({ id: 'pane0', provider: 'grok', cwd, launchToken: 2 });
  await manager.prepareSession('pane0', { provider: 'grok', generation: replacement.generation, env: { ...process.env, GROK_HOME: home } });
  await send(launches[0], { sessionId: ids[0], hook_event_name: 'StopCancelled' }, 409);
  assert.equal(runtime.getSnapshot('pane0').turnState, 'unknown');
});
