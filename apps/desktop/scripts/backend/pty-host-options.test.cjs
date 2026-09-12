'use strict';
// Console-host selection and the inbox-conhost fallback. No real PTY is spawned.
const test = require('node:test');
const assert = require('node:assert/strict');
const { windowsPtyHostOptions, describePtyHost, spawnPty } = require('../../backend/ptyHostOptions.cjs');

function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

// A pty double that records every option set it is asked to spawn with.
function fakePty(shouldThrow) {
  const calls = [];
  return {
    calls,
    spawn(file, args, options) {
      calls.push({ file, args, options });
      const error = shouldThrow(options, calls.length);
      if (error) throw error;
      return { pid: 1000 + calls.length, options };
    }
  };
}

test('windowsPtyHostOptions selects the bundled host only on Windows', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(withPlatform(platform, () => windowsPtyHostOptions({})), {},
      `${platform} must not carry a Windows-only spawn option`);
    assert.deepEqual(withPlatform(platform, () => windowsPtyHostOptions({ LINA_CONPTY_HOST: 'system' })), {});
  }
  withPlatform('win32', () => {
    assert.deepEqual(windowsPtyHostOptions({}), { useConptyDll: true });
    assert.deepEqual(windowsPtyHostOptions({ LINA_CONPTY_HOST: 'system' }), { useConptyDll: false });
    // Only the exact value flips the host; anything else keeps the bundled one.
    assert.deepEqual(windowsPtyHostOptions({ LINA_CONPTY_HOST: 'bundled' }), { useConptyDll: true });
    assert.deepEqual(windowsPtyHostOptions({ LINA_CONPTY_HOST: '' }), { useConptyDll: true });
    assert.deepEqual(windowsPtyHostOptions(undefined), { useConptyDll: true });
  });
});

test('describePtyHost names the selected console host', () => {
  assert.equal(describePtyHost({ useConptyDll: true }), 'openconsole');
  assert.equal(describePtyHost({ useConptyDll: false }), 'conhost');
  assert.equal(describePtyHost({}), 'native');
  assert.equal(describePtyHost(undefined), 'native');
});

test('spawnPty reports the requested host when the spawn succeeds', () => {
  const pty = fakePty(() => null);
  const result = spawnPty(pty, 'powershell.exe', ['-NoLogo'], { cols: 100, rows: 30 }, { useConptyDll: true });
  assert.equal(result.host, 'openconsole');
  assert.equal(result.fallbackError, null);
  assert.equal(result.terminal.pid, 1001);
  assert.equal(pty.calls.length, 1);
  assert.deepEqual(pty.calls[0].options, { cols: 100, rows: 30, useConptyDll: true });
  assert.deepEqual(pty.calls[0].args, ['-NoLogo']);
});

test('spawnPty falls back to the inbox conhost when the bundled host cannot start', () => {
  const bundledFailure = new Error('conpty.dll could not be loaded');
  const pty = fakePty((options) => (options.useConptyDll ? bundledFailure : null));
  const result = spawnPty(pty, 'powershell.exe', [], { cols: 80, rows: 24 }, { useConptyDll: true });
  assert.equal(result.host, 'conhost');
  assert.equal(result.fallbackError, bundledFailure);
  assert.equal(result.terminal.pid, 1002, 'the second spawn must be the one returned');
  assert.equal(pty.calls.length, 2);
  assert.deepEqual(pty.calls[0].options, { cols: 80, rows: 24, useConptyDll: true });
  assert.deepEqual(pty.calls[1].options, { cols: 80, rows: 24, useConptyDll: false });
});

test('spawnPty rethrows when the fallback also fails', () => {
  const pty = fakePty((options, attempt) => new Error(`attempt ${attempt} failed`));
  assert.throws(
    () => spawnPty(pty, 'powershell.exe', [], {}, { useConptyDll: true }),
    /attempt 2 failed/
  );
  assert.equal(pty.calls.length, 2);
});

test('spawnPty never retries when the bundled host was not in play', () => {
  for (const hostOptions of [{ useConptyDll: false }, {}]) {
    const pty = fakePty(() => new Error('spawn refused'));
    assert.throws(() => spawnPty(pty, 'bash', [], {}, hostOptions), /spawn refused/);
    assert.equal(pty.calls.length, 1, `hostOptions ${JSON.stringify(hostOptions)} must not retry`);
  }
});
