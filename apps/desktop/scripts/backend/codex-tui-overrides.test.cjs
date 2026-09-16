'use strict';
// Codex 0.154's idle composer sparkle repaints forever while the composer is
// empty. Every Codex-family pane Lina launches must carry `-c tui.whimsy=false`
// at the ACTIVE command level (root `-c` can be discarded when a subcommand
// also carries `-c`, see backend/codexWebNative.cjs), on fresh launches and on
// `resume <id>`, without disturbing the lifecycle-hook overrides.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  CODEX_TUI_CONFIG_OVERRIDES,
  codexLifecycleConfigOverrides,
  codexLifecycleTrustOverride,
  createAgentTelemetryManager
} = require('../../backend/agentTelemetry.cjs');
const { launchSpec } = require('../../backend/openCodexCli.cjs');
const { nativeArgs } = require('../../backend/codexWebNative.cjs');

const WHIMSY = 'tui.whimsy=false';

// Positions of every `-c <value>` pair, so "after the subcommand" and "exactly
// once" are checked on the real argv rather than on a joined string.
function overrideIndexes(args, value) {
  const found = [];
  for (let index = 0; index < args.length - 1; index++) {
    if ((args[index] === '-c' || args[index] === '--config') && args[index + 1] === value) found.push(index);
  }
  return found;
}

test('the TUI override list is its own frozen list, separate from the hook overrides', () => {
  assert.deepEqual(CODEX_TUI_CONFIG_OVERRIDES, [WHIMSY]);
  assert.ok(Object.isFrozen(CODEX_TUI_CONFIG_OVERRIDES));
  // Never in the lifecycle-hook list: backend/openCodexCli.cjs consumes that
  // list as hook definitions and codexLifecycleTrustOverride hashes exactly
  // those handlers, so an extra entry would break hook trust.
  const hooks = codexLifecycleConfigOverrides('/usr/bin/node', '/tmp/lina/observer.cjs', false);
  assert.equal(hooks.length, 7);
  assert.ok(hooks.every(entry => entry.startsWith('hooks.')));
  assert.ok(!hooks.some(entry => entry.includes('tui.')));
  assert.ok(!codexLifecycleTrustOverride('/usr/bin/node', '/tmp/lina/observer.cjs', false).includes('tui.'));
});

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-codex-tui-'));
  const options = { baseDir: path.join(root, 'shims'), openCodeHome: path.join(root, 'opencode') };
  const managers = [];
  const manager = () => { const m = createAgentTelemetryManager(options); managers.push(m); return m; };
  t.after(() => {
    for (const m of managers) m.cleanup();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('lina-codex-tui-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, options, manager };
}

test('session preparation publishes the TUI overrides in their own env variable', async t => {
  const f = await fixture(t);
  const instrument = await (f.manager()).prepareSession('tui-env', { provider: 'codex' });
  assert.deepEqual(JSON.parse(instrument.env.VIBE_TERMINAL_CODEX_TUI_OVERRIDES), [WHIMSY]);
  const hooks = JSON.parse(instrument.env.VIBE_TERMINAL_CODEX_HOOK_OVERRIDES);
  assert.equal(hooks.length, 7);
  assert.ok(!hooks.some(entry => entry.includes('tui.')));
});

// Spawns the wrapper the pane would run and returns the argv the real CLI saw.
// On Windows that is the generated codex.cmd -> codex.ps1 wrapper (the
// production path); elsewhere the node shim-runner the sh wrapper execs.
async function wrapperArgs(f, { userArgs = [], usePowerShell = false, env: extraEnv = {}, drop = [] } = {}) {
  const instrument = await (f.manager()).prepareSession(`argv-${Math.random().toString(36).slice(2)}`, { provider: 'codex' });
  const stem = usePowerShell ? 'ps' : 'node';
  const fakeBin = fs.mkdtempSync(path.join(f.root, `bin-${stem}-`));
  const output = path.join(fakeBin, 'args.json');
  const provider = process.platform === 'win32' ? path.join(fakeBin, 'codex.ps1') : path.join(fakeBin, 'codex');
  fs.writeFileSync(provider, process.platform === 'win32'
    ? '[System.IO.File]::WriteAllText($env:LINA_TEST_ARGS, (ConvertTo-Json -Compress -InputObject @($args)))'
    : '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.LINA_TEST_ARGS,JSON.stringify(process.argv.slice(2)));\n');
  if (process.platform !== 'win32') fs.chmodSync(provider, 0o755);
  const env = { ...process.env, ...instrument.env, VIBE_TERMINAL_ORIGINAL_PATH: fakeBin + path.delimiter + process.env.PATH, LINA_TEST_ARGS: output, ...extraEnv };
  for (const key of drop) delete env[key];
  const runDir = fs.readdirSync(f.options.baseDir).map(name => path.join(f.options.baseDir, name))
    .find(dir => fs.existsSync(path.join(dir, 'shim-runner.cjs')));
  // codex.cmd is a two-line forwarder to codex.ps1; drive the .ps1 directly so
  // node's .cmd spawn restrictions do not stand in for the wrapper's own logic.
  const [command, args] = usePowerShell
    ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(instrument.shimDir, 'codex.ps1'), ...userArgs]]
    : [process.execPath, [path.join(runDir, 'shim-runner.cjs'), 'codex', ...userArgs]];
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('wrapper timeout')); }, 20000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', value => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 0);
  return { args: JSON.parse(fs.readFileSync(output, 'utf8')), instrument };
}

for (const usePowerShell of process.platform === 'win32' ? [false, true] : [false]) {
  const label = usePowerShell ? 'PowerShell wrapper' : 'node shim runner';

  test(`${label} appends the TUI override once, after the user args`, async t => {
    const f = await fixture(t);
    const { args, instrument } = await wrapperArgs(f, { userArgs: ['--hello'], usePowerShell });
    const at = overrideIndexes(args, WHIMSY);
    assert.equal(at.length, 1, `expected exactly one ${WHIMSY}, got ${JSON.stringify(args)}`);
    // Command level: after every argument the user supplied, and after the
    // lifecycle-hook overrides, never prepended like the trust override.
    assert.ok(at[0] > args.indexOf('--hello'));
    const hooks = JSON.parse(instrument.env.VIBE_TERMINAL_CODEX_HOOK_OVERRIDES);
    assert.ok(at[0] > args.indexOf(hooks[hooks.length - 1]));
    assert.deepEqual(args.slice(0, 2), ['-c', instrument.env.VIBE_TERMINAL_CODEX_HOOK_TRUST_OVERRIDE]);
  });

  test(`${label} keeps the TUI override on a resume subcommand`, async t => {
    const f = await fixture(t);
    const { args } = await wrapperArgs(f, { userArgs: ['resume', '0199-fixture-id'], usePowerShell });
    const at = overrideIndexes(args, WHIMSY);
    assert.equal(at.length, 1);
    assert.ok(at[0] > args.indexOf('0199-fixture-id'));
    assert.deepEqual(args.slice(2, 4), ['resume', '0199-fixture-id']);
  });

  test(`${label} still applies the TUI override with no notify program`, async t => {
    const f = await fixture(t);
    const { args } = await wrapperArgs(f, { userArgs: [], usePowerShell, env: { VIBE_TERMINAL_NOTIFY_PROGRAM: '' } });
    assert.equal(overrideIndexes(args, WHIMSY).length, 1);
    assert.ok(!args.some(arg => typeof arg === 'string' && arg.startsWith('notify=')));
  });

  test(`${label} launches normally when the TUI override list is absent or malformed`, async t => {
    const f = await fixture(t);
    for (const value of [undefined, '', 'not json', '[42]']) {
      const { args } = await wrapperArgs(f, {
        userArgs: [], usePowerShell,
        ...(value === undefined ? { drop: ['VIBE_TERMINAL_CODEX_TUI_OVERRIDES'] } : { env: { VIBE_TERMINAL_CODEX_TUI_OVERRIDES: value } })
      });
      assert.equal(overrideIndexes(args, WHIMSY).length, 0);
      assert.ok(args.some(arg => typeof arg === 'string' && arg.startsWith('notify=')));
    }
  });
}

test('Open Codex appends the TUI override after its own overrides and its resume subcommand', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-open-codex-tui-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'fixture-codex.exe');
  fs.writeFileSync(binary, 'fixture');
  const env = {
    LINA_OPEN_CODEX_BIN: binary, LINA_OPEN_CODEX_HOME: path.join(root, 'home'),
    LINA_OPEN_CODEX_CATALOG: path.join(root, 'models.json'), LINA_OPEN_CODEX_MODEL: 'fixture-model',
    LINA_OPEN_CODEX_BASE_URL: 'http://127.0.0.1:1/v1', LINA_OPEN_CODEX_TOKEN: 'local-token',
    VIBE_TERMINAL_CODEX_HOOK_OVERRIDES: JSON.stringify(codexLifecycleConfigOverrides('/usr/bin/node', '/tmp/o.cjs', false)),
    VIBE_TERMINAL_CODEX_TUI_OVERRIDES: JSON.stringify(CODEX_TUI_CONFIG_OVERRIDES)
  };
  const spec = launchSpec({ ...env, VIBE_TERMINAL_NOTIFY_PROGRAM: path.join(root, 'notify.ps1') }, ['resume', 'fixture-id']);
  const at = overrideIndexes(spec.args, WHIMSY);
  assert.equal(at.length, 1);
  assert.deepEqual(spec.args.slice(0, 2), ['resume', 'fixture-id']);
  // Appended last, after argv, its own overrides, the hooks and the notify value.
  assert.equal(at[0], spec.args.length - 2);
  assert.ok(spec.args.some(arg => typeof arg === 'string' && arg.startsWith('notify=')));
  // Never smuggled in as a hook definition.
  assert.ok(!spec.args.some(arg => typeof arg === 'string' && arg.startsWith('hooks.') && arg.includes('tui.')));
  // Absent or malformed list: the pane still launches, just without the switch.
  for (const value of [undefined, 'not json', '[7]']) {
    const args = launchSpec({ ...env, VIBE_TERMINAL_CODEX_TUI_OVERRIDES: value }, []).args;
    assert.equal(overrideIndexes(args, WHIMSY).length, 0);
  }
});

test('Codex Web carries the TUI override at command level on new and resumed threads', () => {
  const state = { route: 'http://127.0.0.1:12345/v1', catalogPath: path.resolve('catalog.json'), model: 'chatgpt-web/gpt-6-astra-wm', effort: 'medium', connection: {} };
  const fresh = nativeArgs(state, []);
  assert.equal(overrideIndexes(fresh, WHIMSY).length, 1);

  const resumed = nativeArgs(state, ['resume', 'native-thread']);
  const at = overrideIndexes(resumed, WHIMSY);
  assert.equal(at.length, 1);
  assert.ok(at[0] > resumed.indexOf('native-thread'), JSON.stringify(resumed));

  // A user override still wins: its `-c` values are merged last, after ours.
  const user = nativeArgs(state, ['exec', 'resume', 'thread', '-c', 'tui.whimsy=true', '--', '-literal prompt']);
  const ours = overrideIndexes(user, WHIMSY);
  assert.equal(ours.length, 1);
  assert.ok(ours[0] < overrideIndexes(user, 'tui.whimsy=true')[0]);
  assert.deepEqual(user.slice(-2), ['--', '-literal prompt']);
});
