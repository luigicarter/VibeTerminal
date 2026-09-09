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

// Run the real host message loops with disposable process handles. The only
// substitutions are OS spawning/killing and timers; no coding agent is opened.
function boot(file, engine) {
  const filename = path.resolve(__dirname, '../../backend', file), realRequire = createRequire(filename);
  const events = [], children = [], timers = new Set(), stdin = new EventEmitter(), lines = new EventEmitter();
  stdin.setEncoding = () => {};
  function child() {
    const item = new EventEmitter(); item.pid = 10000 + children.length; item.exitCode = null;
    item.stdin = { writable: true, write: () => true };
    item.stdout = new EventEmitter(); item.stderr = new EventEmitter();
    item.kill = () => { item.killed = true; return true; };
    item.onExit = callback => { item.on('exit', callback); return { dispose: () => item.off('exit', callback) }; };
    item.onData = () => ({ dispose() {} }); item.write = () => {}; item.resize = () => {};
    children.push(item); return item;
  }
  const module = { exports: {} };
  function requireMock(name) {
    if (name === 'child_process') return { ...require('node:child_process'), spawn: child, execFileSync: () => {} };
    if (name === 'node-pty') return { spawn: child };
    if (name === 'readline') return { createInterface: () => lines };
    if (name === './observedStop.cjs') return { ...stopModule, createHostStopObserver: options => stopModule.createHostStopObserver({ ...options, timeoutMs: 100, kill: handle => { handle.observedKills = (handle.observedKills || 0) + 1; return true; } }) };
    if (name === './fusionCodexBrain.cjs' && engine === 'codex') return { createCodexBrainSession: () => ({ child: child(), ready: Promise.resolve(), initialize: () => Promise.resolve(), interrupt: () => Promise.resolve() }) };
    return realRequire(name);
  }
  requireMock.main = module;
  const context = { module, exports: module.exports, require: requireMock, __dirname: path.dirname(filename), __filename: filename,
    Buffer, URL, console, structuredClone, setImmediate, clearImmediate,
    setTimeout: (callback, ms) => { const timer = setTimeout(callback, ms); timers.add(timer); return timer; },
    clearTimeout: timer => { clearTimeout(timer); timers.delete(timer); }, setInterval: () => ({ unref() {} }), clearInterval() {},
    process: { platform: process.platform, env: { ...process.env }, cwd: () => process.cwd(), stdin,
      stdout: { write: data => { for (const line of String(data).trim().split('\n')) if (line) events.push(JSON.parse(line)); } },
      on() {}, exit() {}, pid: process.pid }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { children, events, send: (type, payload) => {
    const line = JSON.stringify({ type, payload });
    if (file === 'ptyHost.cjs') lines.emit('line', line); else stdin.emit('data', `${line}\n`);
  }, cleanup: () => { for (const timer of timers) clearTimeout(timer); } };
}

for (const [file, kind, engine] of [['ptyHost.cjs', 'terminal'], ['fusionChatHost.cjs', 'fusion'], ['fusionChatHost.cjs', 'fusion-codex', 'codex'], ['openFusionChatHost.cjs', 'openfusion']]) {
  test(`${kind} real host: synthetic closure cannot certify exit; actual exit survives deleted map`, async () => {
    const h = boot(file, engine), scope = { id: 'owned-test-pane', generation: 'gen-one', launchToken: 1, cwd: process.cwd(), ...(engine && { plannerFamily: engine }) };
    try {
      h.send(kind === 'terminal' ? 'create' : 'start', scope);
      assert.equal(h.children.length, 1, JSON.stringify(h.events));
      h.send('stop-observed', { ...scope, operationId: 'op-one' }); await tick();
      assert.equal(h.children[0].observedKills, 1);
      assert.equal(h.events.filter(event => event.type === 'stop-observed-result').length, 0);
      h.children[0].emit('exit', kind === 'terminal' ? { exitCode: 0 } : 0); await tick();
      assert.equal(h.events.find(event => event.type === 'stop-observed-result')?.process, 'stopped');
    } finally { h.cleanup(); }
  });

  test(`${kind} real host: delayed old stop does not kill replacement`, async () => {
    const h = boot(file, engine), scope = { id: 'owned-test-pane', generation: 'gen-one', launchToken: 1, cwd: process.cwd(), ...(engine && { plannerFamily: engine }) };
    try {
      h.send(kind === 'terminal' ? 'create' : 'start', scope);
      h.send('stop-observed', { ...scope, operationId: 'op-one' });
      h.send(kind === 'terminal' ? 'create' : 'start', { ...scope, generation: 'gen-two', launchToken: 2 });
      await tick();
      assert.equal(h.children.length, 2);
      assert.equal(h.children[1].observedKills, undefined);
      assert.equal(h.events.find(event => event.type === 'stop-observed-result')?.process, 'superseded');
    } finally { h.cleanup(); }
  });
}
