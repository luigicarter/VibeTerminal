'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createObservedLaunchFence } = require('../../backend/observedStop.cjs');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
const { createChatLaunchPreparation } = require('../../backend/chatLaunchPreparation.cjs');
const source = fs.readFileSync(path.resolve(__dirname, '../../backend/main.cjs'), 'utf8');
const start = source.indexOf('function sendObservedStop(payload) {');
const end = source.indexOf("ipcMain.handle('orchestrator:stop-session-observed'", start);
assert.ok(start > 0 && end > start);
const scope = { id: 'synthetic-pane', launchToken: 1, kind: 'terminal', operationId: 'stop-one' };

function environment(extra = {}) {
  const observedLaunches = createObservedLaunchFence(), calls = [];
  const context = { observedLaunches, observedStopHosts: new Map(), terminalRuntime: createTerminalRuntime(), chatLaunchPreparation: createChatLaunchPreparation(),
    ptyHost: {}, fusionChatHost: {}, openFusionChatHost: {},
    getAgentTelemetry: () => ({ stopFusionSessionObserved: async () => ({ ok: true, process: 'stopped', launchSettled: true }), releaseSession() {} }),
    sendToPtyHost: message => { calls.push(message); return true; },
    sendToFusionChatHost: message => { calls.push(message); return true; },
    sendToOpenFusionChatHost: message => { calls.push(message); return true; }, ...extra };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  return { ...context, calls, context };
}

test('main binds observed stop to the original host incarnation', async () => {
  const e = environment();
  await e.observedLaunches.run('terminal', scope, () => e.observedLaunches.outgoing('terminal', { ...scope, generation: 'g1' }, e.ptyHost));
  assert.equal(e.sendObservedStop(scope), true);
  e.context.ptyHost = {};
  assert.equal(e.sendObservedStop(scope), false); assert.equal(e.calls.length, 1);
});

test('main native preparation retires launch but does not manufacture stop proof', async () => {
  const e = environment(); let release;
  await e.observedLaunches.run('terminal', scope, () => {});
  const launch = e.terminalRuntime.beginLaunch({ ...scope, provider: 'terminal', cwd: process.cwd() });
  launch.record.createPromise = new Promise(resolve => { release = resolve; });
  const pending = e.prepareObservedStop({ ...scope, generation: launch.generation });
  assert.equal(e.terminalRuntime.isCurrent(scope.id, launch.generation), false);
  let done = false; void pending.then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  release(); const prepared = await pending;
  assert.equal(prepared.launchSettled, true); assert.equal(prepared.process, undefined);
  assert.equal(prepared.generation, launch.generation);
});

test('main pending chat cancellation waits its writes and retains failed executor cleanup', async () => {
  let release, cleanupCalls = 0;
  const e = environment({ getAgentTelemetry: () => ({ stopFusionSessionObserved: async () => { cleanupCalls++; return { ok: false, process: 'failed', error: 'executor refused' }; }, releaseSession() {} }) });
  const running = e.observedLaunches.run('fusion', scope, () => e.chatLaunchPreparation.run(scope.id, async isCurrent => {
    e.observedLaunches.outgoing('fusion', scope, e.fusionChatHost);
    await new Promise(resolve => { release = resolve; }); return isCurrent();
  }));
  await new Promise(resolve => setImmediate(resolve));
  const pending = e.prepareObservedStop({ ...scope, kind: 'fusion' });
  let settled = false; void pending.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  release(); await running;
  const prepared = await pending;
  assert.equal(prepared.launchSettled, true); assert.match(prepared.cleanupError, /executor refused/); assert.equal(cleanupCalls, 1);
});

test('main stale provider close cannot enter replacement preparation cleanup', async () => {
  let cleanups = 0;
  const e = environment({ getAgentTelemetry: () => ({ stopFusionSessionObserved: () => { cleanups++; }, releaseSession() {} }) });
  await e.observedLaunches.run('fusion', scope, () => {});
  await e.observedLaunches.run('openfusion', { ...scope, launchToken: 2 }, () => {});
  assert.equal((await e.prepareObservedStop({ ...scope, kind: 'fusion' })).process, 'superseded');
  assert.equal(cleanups, 0);
});
