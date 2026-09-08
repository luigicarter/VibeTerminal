const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { grokHookEvents, prepareGrokTelemetry } = require('../../backend/grokTelemetry.cjs');
const { createAgentTelemetryManager } = require('../../backend/agentTelemetry.cjs');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');

function run(command, args, input, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('Grok native metadata is passive and stop gates never become completion', () => {
  const base = { sessionId: 'root', promptId: 'turn', cwd: '/workspace', prompt: 'SECRET', lastAssistantMessage: 'SECRET' };
  assert.equal(grokHookEvents({ ...base, hookEventName: 'user_prompt_submit' })[0].providerTurnId, 'turn');
  assert.equal(grokHookEvents({ ...base, hook_event_name: 'Stop' })[0].type, 'agent.response');
  assert.equal(grokHookEvents({ ...base, hook_event_name: 'Stop', subagentType: 'explore' })[0].transcriptKind, 'subagent');
  assert.equal(grokHookEvents({ ...base, hook_event_name: 'SubagentStop', phase: 'gate', subagentId: 'child' })[0].type, 'agent.response');
  assert.deepEqual(grokHookEvents({ ...base, hook_event_name: 'Notification', notificationType: 'idle_prompt' }), []);
  const events = grokHookEvents({ ...base, hook_event_name: 'PreToolUse', toolName: 'ask_user_question', toolUseId: 'question', toolInput: { questions: ['SECRET'] } });
  assert.equal(events.at(-1).detail, 'question');
  assert.equal(JSON.stringify(events).includes('SECRET'), false);
});

test('Grok hooks preserve other files, isolate owners and execute Node/Windows telemetry into runtime', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-grok-test-'));
  const home = path.join(root, 'home');
  const hookDir = path.join(home, 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const userFile = path.join(hookDir, 'user.json');
  fs.writeFileSync(userFile, '{"hooks":{}}\n');
  const env = { ...process.env, GROK_HOME: home, USERPROFILE: home, HOME: home };
  const runtime = createTerminalRuntime();
  const launch = runtime.beginLaunch({ id: 'pane', launchToken: 1, provider: 'grok', cwd: root });
  const captured = [];
  const manager = createAgentTelemetryManager({ baseDir: path.join(root, 'shims'), openCodeHome: path.join(root, 'opencode'), emit: event => { captured.push(event); runtime.ingest(event); } });
  t.after(() => { manager.cleanup(); runtime.dispose(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('vibe-grok-test-')); fs.rmSync(root, { recursive: true, force: true }); });
  const instrument = await manager.prepareSession('pane', { provider: 'grok', generation: launch.generation, env });
  const hookPath = fs.readdirSync(hookDir).filter(file => file.startsWith('vibeterminal-')).map(file => path.join(hookDir, file))[0];
  assert.ok(hookPath);
  assert.equal(fs.readFileSync(userFile, 'utf8'), '{"hooks":{}}\n');
  assert.ok(instrument.env.VIBE_TERMINAL_ORIGINAL_PATH.includes(path.join(os.homedir(), '.grok', 'bin')));
  assert.equal(instrument.env.GROK_HOME, undefined, 'Actual launch home is preserved, not overridden');
  const observer = fs.readdirSync(manager.baseDir).find(file => /^grok-observer-.*\.cjs$/.test(file));
  const nativeEnv = { ...env, ...instrument.env };
  runtime.ingest({ id: 'pane', generation: launch.generation, type: 'created' });
  runtime.ingest({ id: 'pane', generation: launch.generation, type: 'agent-process', phase: 'start', pid: 42 });
  runtime.ingest({ id: 'pane', generation: launch.generation, type: 'agent-session', providerThreadId: 'root', rootVerified: true, phase: 'start' });
  const base = { sessionId: 'root', promptId: 'turn', cwd: root };
  const send = async hook => {
    const result = await run(process.execPath, [path.join(manager.baseDir, observer), nativeEnv.VIBE_TERMINAL_GROK_INVOCATION], hook, nativeEnv, root);
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  };
  await send({ ...base, hookEventName: 'user_prompt_submit' });
  assert.equal(runtime.getSnapshot('pane').turnState, 'running');
  await send({ ...base, hook_event_name: 'PreToolUse', toolName: 'ask_user_question', toolUseId: 'question' });
  assert.equal(runtime.getSnapshot('pane').attention.reason, 'question');
  await send({ ...base, hook_event_name: 'PostToolUse', toolName: 'ask_user_question', toolUseId: 'question' });
  assert.equal(runtime.getSnapshot('pane').attention, undefined);
  await send({ ...base, hook_event_name: 'Stop' });
  assert.equal(runtime.getSnapshot('pane').turnState, 'response');
  await send({ ...base, hook_event_name: 'SubagentStart', subagentId: 'child', subagentType: 'explore' });
  await send({ sessionId: 'child', hook_event_name: 'SubagentStop', subagentId: 'child', subagentType: 'explore', phase: 'gate' });
  assert.equal(runtime.getSnapshot('pane').children.length, 1);
  assert.equal(runtime.getSnapshot('pane').children[0].observation, 'provisional', 'A stop gate cannot prove child settlement');
  assert.equal(runtime.getSnapshot('pane').childActivity, true);
  assert.equal(runtime.getSnapshot('pane').turnState, 'response');
  await send({ sessionId: 'child', hook_event_name: 'UserPromptSubmit', subagentType: 'explore' });
  assert.equal(runtime.getSnapshot('pane').children.length, 1);
  assert.equal(runtime.getSnapshot('pane').children[0].observation, 'observed');
  await send({ sessionId: 'child', hook_event_name: 'SessionEnd', subagentType: 'explore' });
  assert.equal(runtime.getSnapshot('pane').children.length, 0);
  await send({ ...base, promptId: 'cancel-turn', hook_event_name: 'UserPromptSubmit' });
  await send({ ...base, promptId: 'cancel-turn', hook_event_name: 'StopCancelled', reason: 'user_interrupt' });
  assert.equal(runtime.getSnapshot('pane').turnState, 'interrupted');
  const before = captured.length;
  await run(process.execPath, [path.join(manager.baseDir, observer), 'wrong-owner'], { ...base, hook_event_name: 'UserPromptSubmit' }, nativeEnv, root);
  assert.equal(captured.length, before);
  if (process.platform === 'win32') {
    const command = JSON.parse(fs.readFileSync(hookPath, 'utf8')).hooks.StopFailure[0].hooks[0].command;
    const encoded = command.split(' -EncodedCommand ')[1];
    const result = await run('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { ...base, hook_event_name: 'StopFailure' }, nativeEnv, root);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(captured.at(-1).attention.state, 'failed');
    const binary = path.join(os.homedir(), '.grok', 'bin', 'grok.exe');
    if (fs.existsSync(binary)) {
      const inspect = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(instrument.shimDir, 'grok.ps1'), 'inspect', '--json'], {}, nativeEnv, root);
      assert.equal(inspect.code, 0, inspect.stderr);
      const report = JSON.parse(inspect.stdout);
      assert.ok(report.hooks.some(hook => hook.event === 'stop_cancelled'));
      assert.ok(report.hooks.some(hook => hook.event === 'subagent_stop'));
      assert.equal(report.hooks.length, 12);
      assert.equal(report.projectInstructions.length, 0, 'Native inspection must not read real profile compatibility instructions');
      t.diagnostic(`Installed Grok ${report.grokVersion}: wrapper resolved executable and inspect discovered all 12 observer hooks`);
    }
  }
  const second = prepareGrokTelemetry({ baseDir: manager.baseDir, ownerId: 'second-manager', nodePath: process.execPath, env });
  assert.notEqual(second.hookPath, hookPath);
  manager.cleanup();
  assert.equal(fs.existsSync(hookPath), false);
  assert.equal(fs.existsSync(second.hookPath), true);
  assert.equal(fs.existsSync(path.join(manager.baseDir, observer)), true);
  fs.appendFileSync(second.hookPath, ' ');
  second.cleanup();
  assert.equal(fs.existsSync(second.hookPath), true, 'Never remove a changed source');
});
