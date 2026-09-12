'use strict';
// Exercise the shipped PowerShell -> wrapper -> native TUI path without a
// system Node/Bun on PATH, using disposable state and a local fixture provider.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  child.once('error', error => { console.error(error); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app } = require('electron'), { createServer } = require('node:http');
  const { Terminal } = require('@xterm/headless'), pty = require('node-pty');
  const packageDir = path.resolve(process.argv.find(value => value.startsWith('--package-dir='))?.slice(14) || path.join(root, 'release/win-unpacked'));
  const resourcesPath = path.join(packageDir, 'resources');
  const backend = path.join(resourcesPath, 'app.asar.unpacked/backend');
  const sourceRuntime = process.argv.includes('--source-runtime');
  const { createRuntimeManager } = require(path.join(sourceRuntime ? path.join(root, 'backend') : backend, 'openCodexRuntime.cjs'));
  const output = path.join(root, '.tmp/open-codex', `packaged-${Date.now()}`);
  const workspace = path.join(output, 'Workspace with spaces'); fs.mkdirSync(workspace, { recursive: true });
  app.setPath('userData', path.join(output, 'electron'));
  const screen = new Terminal({ cols: 120, rows: 38, allowProposedApi: true });
  const events = [], modelsUsed = [];
  let terminal, manager, server, raw = '', failure, shellExit;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = () => Array.from({ length: screen.rows }, (_, i) => screen.buffer.active.getLine(screen.buffer.active.viewportY + i)?.translateToString(true) || '').join('\n');
  async function until(check, label, timeout = 30000) {
    for (const end = Date.now() + timeout; Date.now() < end;) {
      if (failure) throw failure;
      if (shellExit !== undefined) throw new Error(`PowerShell exited early: ${shellExit}`);
      if (await check()) return;
      await wait(100);
    }
    throw new Error(`Timed out: ${label}\n${visible()}`);
  }
  async function enter(text) { terminal.write(text); await wait(200); terminal.write('\r'); }
  async function main() {
    assert.equal(process.platform, 'win32', 'This regression is the packaged Windows console launch.');
    server = createServer(async (req, res) => {
      try {
        let input = ''; for await (const chunk of req) input += chunk;
        if (req.url === '/telemetry') {
          assert.equal(req.headers['x-vibe-telemetry-token'], 'fixture-telemetry');
          events.push(JSON.parse(input)); res.end('{}'); return;
        }
        assert.equal(req.url, '/v1/chat/completions');
        const request = JSON.parse(input); modelsUsed.push(request.model);
        assert.ok(['model-one', 'model-two'].includes(request.model));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Packaged Open Codex console verified.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } catch (error) { failure = error; res.writeHead(500); res.end('Fixture failed'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const models = ['one', 'two'].map(n => ({ key: `fixture/model-${n}`, id: `model-${n}`, label: `Fixture ${n}`, providerName: 'Fixture', providerId: 'fixture', contextWindow: 32768, reasoning: false, imageInput: false }));
    manager = createRuntimeManager({ userData: path.join(output, 'app'), packaged: true,
      binaryOptions: { isPackaged: true, resourcesPath }, cliPath: path.join(backend, 'openCodexCli.cjs'), nodeCommand: path.join(packageDir, 'LinaTerminal.exe'),
      providerStore: { listProfiles: () => ({ models, defaultModel: models[0].key }), resolveModel: key => ({ ...models.find(model => model.key === key), baseUrl: baseUrl + '/v1', apiMode: 'chat-completions', apiKey: 'fixture-only' }) } });
    const prepared = await manager.prepare({ id: 'packaged-fixture', generation: 'fixture-generation' });
    fs.writeFileSync(path.join(manager.home, 'config.toml'), `sandbox_mode = "danger-full-access"\napproval_policy = "never"\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|^LINA_|^VIBE_|^CODEX_|^OPENAI_|^ELECTRON_RUN_AS_NODE$|^PATH$/i.test(key) || prepared.stripEnv.some(name => name.toLowerCase() === key.toLowerCase())) delete env[key];
    const windows = process.env.SystemRoot;
    env.PATH = [path.join(windows, 'System32'), windows, path.join(windows, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter);
    Object.assign(env, prepared.env, { VIBE_TERMINAL_CALLBACK_URL: baseUrl + '/telemetry', VIBE_TERMINAL_TELEMETRY_TOKEN: 'fixture-telemetry', VIBE_TERMINAL_SESSION_ID: 'packaged-fixture', VIBE_TERMINAL_LAUNCH_NONCE: 'fixture-generation' });
    terminal = pty.spawn(path.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NoExit'], { name: 'xterm-256color', cols: 120, rows: 38, cwd: workspace, env });
    screen.onData(data => terminal.write(data));
    terminal.onData(data => { raw += data; screen.write(data); if (/stdin is not a terminal/.test(raw)) failure = new Error('Packaged launcher lost stdin: stdin is not a terminal'); });
    terminal.onExit(event => { shellExit = event.exitCode; });
    await until(() => /PS .*?>/.test(visible()), 'initial PowerShell prompt');
    await enter(prepared.command);
    await until(() => /model:\s+fixture\/model-one/.test(visible()), 'native TUI readiness');
    fs.writeFileSync(path.join(output, 'ready.txt'), visible());
    await enter('/model');
    await until(() => /Fixture one/.test(visible()) && /Fixture two/.test(visible()), 'configured model picker');
    fs.writeFileSync(path.join(output, 'models.txt'), visible());
    terminal.write('\x1b[B'); await wait(200); terminal.write('\r');
    await until(() => /Model changed to/.test(raw), 'model change');
    terminal.write('\x1b'); await wait(200);
    await enter('Say hello to verify this terminal.');
    await until(() => raw.includes('Packaged Open Codex console verified.'), 'completed provider turn');
    assert.deepEqual(modelsUsed, ['model-two']);
    const started = events.find(event => event.type === 'agent.process.started' && event.pid);
    assert.ok(started?.processId.startsWith('open-codex:'), 'Native root PID must be reported.');
    // Two interrupts return from native Codex to the same PowerShell. This
    // also verifies that the console host stays alive for native completion.
    terminal.write('\x03'); await wait(350); terminal.write('\x03');
    await until(() => events.some(event => event.type === 'agent.process.exited' && event.processId === started.processId), 'root exit telemetry');
    const exited = events.find(event => event.type === 'agent.process.exited' && event.processId === started.processId);
    assert.equal(exited.exitCode, 0);
    await until(() => /PS .*?>/.test(visible()), 'PowerShell prompt after native exit');
    await manager.release('packaged-fixture', 'fixture-generation');
    assert.equal(fs.existsSync(prepared.env.LINA_OPEN_CODEX_CATALOG), false);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ok: true, packageDir, sourceRuntime, modelsUsed, processId: started.processId, exitCode: exited.exitCode }, null, 2));
    console.log(`Packaged PowerShell launch, native input/model switch/turn, interrupt, lifecycle and cleanup passed: ${output}`);
  }
  const timer = setTimeout(() => { console.error('Packaged smoke watchdog expired'); terminal?.kill(); app.exit(1); }, 90000);
  main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    clearTimeout(timer); fs.writeFileSync(path.join(output, 'terminal.txt'), raw); fs.writeFileSync(path.join(output, 'telemetry.json'), JSON.stringify(events, null, 2));
    if (terminal && shellExit === undefined) {
      terminal.write('\x03'); await wait(150); terminal.write('exit\r');
      for (let i = 0; i < 20 && shellExit === undefined; i++) await wait(100);
      if (shellExit === undefined) { terminal.kill(); await wait(500); }
    }
    screen.dispose(); await manager?.close(); server?.closeAllConnections(); server?.close(); app.exit(process.exitCode || 0);
  });
}
