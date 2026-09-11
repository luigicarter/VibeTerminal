'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const stopModule = require('../../backend/observedStop.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function adapter() {
  const filename = path.resolve(__dirname, '../../backend/fusion-adapter.cjs'), realRequire = createRequire(filename), children = [];
  let endpoint;
  const context = {
    module: { exports: {} }, __filename: filename, __dirname: path.dirname(filename), Buffer, URL, console, structuredClone,
    setTimeout, clearTimeout, setInterval, clearInterval,
    process: { ...process, env: { ...process.env, VIBE_TERMINAL_SESSION_ID: 'test-adapter', VIBE_TERMINAL_LAUNCH_NONCE: 'test-nonce', VIBE_TERMINAL_TELEMETRY_TOKEN: 'test-token', VIBE_FUSION_EAGER_BOOT: '0' } },
    require(name) {
      if (name === 'child_process') return { ...require('node:child_process'), spawn: () => {
        const child = new EventEmitter(); child.pid = 1000 + children.length; child.exitCode = null;
        child.stdin = { writable: true, write: () => true }; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => { child.legacyKills = (child.legacyKills || 0) + 1; return true; };
        children.push(child); return child;
      } };
      if (name === 'http') return { ...require('node:http'), createServer: handler => { endpoint = handler; return { on() {}, listen() {}, close() {} }; } };
      if (name === './observedStop.cjs') return { ...stopModule, createHostStopObserver: options => stopModule.createHostStopObserver({ ...options, timeoutMs: 15, kill: child => { child.observedKills = (child.observedKills || 0) + 1; return !child.refuse; } }) };
      return realRequire(name);
    }
  };
  vm.createContext(context); vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  context.startControlServer();
  return { context, children, spawn: () => vm.runInContext("spawn('synthetic-worker', [])", context), request: body => new Promise(resolve => {
    const req = new EventEmitter(); req.method = 'POST'; req.url = '/stop-observed'; req.headers = { 'x-vibe-telemetry-token': 'test-token' };
    endpoint(req, { writeHead() {}, end: text => resolve(JSON.parse(text)) });
    req.emit('data', JSON.stringify({ sessionId: 'test-adapter', launchNonce: 'test-nonce', operationId: 'adapter-stop', ...body })); req.emit('end');
  }) };
}

test('adapter endpoint fences nonce, awaits all owned child exits and refuses late spawn', async () => {
  const a = adapter(); for (let i = 0; i < 3; i++) a.spawn();
  assert.equal((await a.request({ launchNonce: 'stale' })).process, 'superseded');
  assert.ok(a.children.every(child => !child.observedKills));
  const pending = a.request({}); await tick();
  assert.ok(a.children.every(child => child.observedKills === 1));
  assert.throws(() => a.spawn(), /stopping/);
  for (const child of a.children) { child.exitCode = 0; child.emit('exit', 0); }
  const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.process, 'stopped'); assert.equal(result.launchNonce, 'test-nonce');
});

test('adapter kill failure remains failed; legacy reset does not replay the attempted kill', async () => {
  const a = adapter(), child = a.spawn(); child.refuse = true;
  const result = await a.request({});
  assert.equal(result.process, 'failed'); assert.equal(child.observedKills, 1); assert.equal(child.legacyKills, undefined);
  child.emit('exit', 0);
  assert.equal((await a.request({ observeOnly: true })).process, 'failed'); assert.equal(child.observedKills, 1);
});

test('adapter timeout can be observed under the original operation without a second mutation', async () => {
  const a = adapter(), child = a.spawn();
  assert.equal((await a.request({})).process, 'unknown');
  child.exitCode = 0; child.emit('exit', 0);
  assert.equal((await a.request({ observeOnly: true })).process, 'stopped');
  assert.equal(child.observedKills, 1);
});

test('adapter natural root exit is not full tree proof, while other live workers still receive stop', async () => {
  const a = adapter(), earlier = a.spawn(), active = a.spawn(); earlier.exitCode = 0; earlier.emit('exit', 0);
  const stopping = a.request({}); await tick();
  assert.equal(active.observedKills, 1); active.exitCode = 0; active.emit('exit', 0);
  assert.equal((await stopping).process, 'unknown');
});

test('adapter observe-only unknown operation does not fence or stop workers', async () => {
  const a = adapter(), child = a.spawn();
  const result = await a.request({ observeOnly: true });
  assert.equal(result.process, 'unknown'); assert.equal(result.launchSettled, false);
  assert.equal(child.observedKills, undefined); a.spawn();
});
