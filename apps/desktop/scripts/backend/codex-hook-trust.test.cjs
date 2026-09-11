'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { codexLifecycleConfigOverrides, codexLifecycleTrustOverride, codexLifecycleHookSource,
  createAgentTelemetryManager } = require('../../backend/agentTelemetry.cjs');

function trustEntries(value) {
  return [...value.matchAll(/'([^']+)' = \{ trusted_hash = '(sha256:[a-f0-9]{64})' \}/g)].map(m => ({ key: m[1], hash: m[2] }));
}

test('POSIX normalized hook identities have stable known hashes and exact source keys', () => {
  const value = codexLifecycleTrustOverride('/usr/bin/node', '/tmp/lina/observer.cjs', false);
  assert.deepEqual(trustEntries(value).map(e => e.hash), [
    'sha256:9d4f5060a550636b93a8b5fc0821089baca8495af47420bca5bff61bd3cffd61',
    'sha256:571415bf9706af69e9be5cc7716d691b68681691c288ac246cd2892e5b382cc1',
    'sha256:981a5fc12f976479fd1410b823b6cf29106f070bd198d0636985598a616bfbf3',
    'sha256:6c79e60aad4e7a848212e8273bab7c32617d468e49c33c3f98656def3f403af0',
    'sha256:20a7f704cb1400ba1533fe72bb168eb4c9a19b4430bf49289b6a6fac4dd926d7',
    'sha256:037684c441122a35552e9fe5b180c236b790730d0c8af0325be7226374e236e6',
    'sha256:6c714c8a29bc0b916cf6b0f2de59f20a0e11a2f883aa024488722bc4045453d4'
  ]);
  assert.ok(trustEntries(value).every(e => e.key.startsWith('/<session-flags>/config.toml:') && e.key.endsWith(':0:0')));
  assert.ok(!value.includes('enabled'));
  assert.equal(codexLifecycleConfigOverrides('/usr/bin/node', '/tmp/lina/observer.cjs', false).length, 7);
});

test('Windows trust source is native C root and changed observer/executable paths change every hash', () => {
  const base = trustEntries(codexLifecycleTrustOverride('D:\\Lina\\LinaTerminal.exe', 'D:\\cache\\observer.cjs', true));
  assert.ok(base.every(e => e.key.startsWith('C:\\<session-flags>\\config.toml:')));
  for (const [exe, hook] of [['E:\\Lina\\LinaTerminal.exe', 'D:\\cache\\observer.cjs'], ['D:\\Lina\\LinaTerminal.exe', 'D:\\cache\\observer-v2.cjs']]) {
    const changed = trustEntries(codexLifecycleTrustOverride(exe, hook, true));
    assert.deepEqual(changed.map(e => e.key), base.map(e => e.key));
    assert.ok(changed.every((e, i) => e.hash !== base[i].hash));
  }
});

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-codex-hook-trust-'));
  const options = { baseDir: path.join(root, 'shims'), openCodeHome: path.join(root, 'opencode') };
  const managers = [];
  const manager = () => { const m = createAgentTelemetryManager(options); managers.push(m); return m; };
  t.after(() => {
    for (const m of managers) m.cleanup();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('lina-codex-hook-trust-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, options, manager };
}

test('cached observer is repaired before trust and later tampering or absence withholds session trust', async t => {
  const f = await fixture(t);
  const first = f.manager();
  const a = await first.prepareSession('first', { provider: 'codex', generation: 'first' });
  assert.equal(trustEntries(a.env.VIBE_TERMINAL_CODEX_HOOK_TRUST_OVERRIDE).length, 7);
  const hook = path.join(f.options.baseDir, fs.readdirSync(f.options.baseDir).find(n => /^codex-lifecycle-hook-.*\.cjs$/.test(n)));
  fs.writeFileSync(hook, '// stale cache');
  assert.equal((await first.prepareSession('changed', { provider: 'codex' })).env.VIBE_TERMINAL_CODEX_HOOK_TRUST_OVERRIDE, '');
  const next = f.manager();
  assert.equal(trustEntries((await next.prepareSession('repaired', { provider: 'codex' })).env.VIBE_TERMINAL_CODEX_HOOK_TRUST_OVERRIDE).length, 7);
  assert.equal(fs.readFileSync(hook, 'utf8'), codexLifecycleHookSource());
  fs.unlinkSync(hook);
  assert.equal((await next.prepareSession('missing', { provider: 'codex' })).env.VIBE_TERMINAL_CODEX_HOOK_TRUST_OVERRIDE, '');
  // An unreadable/unreplaceable cache entry must not prevent other providers
  // from launching. A directory simulates this without platform ACL mutation.
  fs.mkdirSync(hook);
  const obstructed = f.manager();
  const unrelated = await obstructed.prepareSession('unrelated', { provider: 'claude' });
  assert.ok(unrelated.env.VIBE_TERMINAL_CLAUDE_SETTINGS);
  assert.equal(unrelated.env.VIBE_TERMINAL_CODEX_HOOK_TRUST_OVERRIDE, '');
  assert.ok(!fs.readdirSync(f.options.baseDir).some(n => n.includes('.tmp-')));
});

test('Node wrapper preserves explicit user state after default trust and appends lifecycle definitions', async t => {
  const f = await fixture(t), m = f.manager();
  const instrument = await m.prepareSession('argv', { provider: 'codex' });
  const fakeBin = path.join(f.root, 'bin'); fs.mkdirSync(fakeBin);
  const output = path.join(f.root, 'args.json');
  const provider = process.platform === 'win32' ? path.join(fakeBin, 'codex.ps1') : path.join(fakeBin, 'codex');
  fs.writeFileSync(provider, process.platform === 'win32'
    ? `[System.IO.File]::WriteAllText($env:LINA_TEST_ARGS, (ConvertTo-Json -Compress -InputObject @($args)))`
    : '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.LINA_TEST_ARGS,JSON.stringify(process.argv.slice(2)));\n');
  if (process.platform !== 'win32') fs.chmodSync(provider, 0o755);
  const runDir = fs.readdirSync(f.options.baseDir).map(n => path.join(f.options.baseDir,n)).find(p => fs.existsSync(path.join(p,'shim-runner.cjs')));
  const user = ['-c', "hooks.state={ 'custom'={ enabled=false, trusted_hash='sha256:user' } }", '--hello'];
  const env = { ...process.env, ...instrument.env, VIBE_TERMINAL_ORIGINAL_PATH: fakeBin + path.delimiter + process.env.PATH, LINA_TEST_ARGS: output };
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(runDir,'shim-runner.cjs'),'codex',...user], { env, windowsHide:true, stdio:'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('wrapper timeout')); }, 10000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code,0);
  const args=JSON.parse(fs.readFileSync(output,'utf8'));
  assert.deepEqual(args.slice(0,2),['-c',instrument.env.VIBE_TERMINAL_CODEX_HOOK_TRUST_OVERRIDE]);
  assert.deepEqual(args.slice(2,2+user.length),user);
  assert.ok(args.slice(2+user.length).includes(JSON.parse(instrument.env.VIBE_TERMINAL_CODEX_HOOK_OVERRIDES)[0]));
});
