'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../backend/agentTelemetry.cjs'), 'utf8');
const start = source.indexOf('  const fusionObservedStops = new Map();');
const end = source.indexOf('  // Cursor has no per-invocation hook flag', start);
assert.ok(start > 0 && end > start);
function fixture(answer) {
  const requests = [], sessions = new Map([['pane', { launchNonce: 'nonce-old' }]]), controls = new Map([['pane', 'http://127.0.0.1:1234']]);
  const context = { sessions, fusionAdapterControls: controls, normalizeSessionId: id => id,
    postFusionAdapterControl: async (...args) => { requests.push(args); return answer(...args); } };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  return { stop: context.stopFusionSessionObserved, sessions, controls, requests };
}
const proof = { operationId: 'op', launchNonce: 'nonce-old', ok: true, process: 'stopped', launchSettled: true };

test('telemetry observed wrapper rejects legacy acknowledgments and mismatched adapter proof', async () => {
  for (const answer of [{ status: 'stopped' }, { ...proof, launchNonce: 'replacement' }, { ...proof, operationId: 'other' }, { ...proof, launchSettled: false }]) {
    const f = fixture(() => answer);
    assert.equal((await f.stop('pane', { operationId: 'op' })).process, 'unknown');
  }
});

test('telemetry observation retains original adapter URL and nonce after replacement', async () => {
  let ready = false;
  const f = fixture(() => ready ? proof : { ...proof, ok: false, process: 'unknown' });
  await f.stop('pane', { operationId: 'op' });
  f.sessions.set('pane', { launchNonce: 'nonce-new' }); f.controls.set('pane', 'http://127.0.0.1:9876'); ready = true;
  assert.equal((await f.stop('pane', { operationId: 'op', observeOnly: true })).process, 'stopped');
  const [, endpoint, payload, options] = f.requests[1];
  assert.equal(endpoint, '/stop-observed'); assert.equal(payload.observeOnly, true);
  assert.equal(payload.launchNonce, 'nonce-old'); assert.equal(options.controlUrl, 'http://127.0.0.1:1234'); assert.equal(options.timeoutMs, 2000);
});

test('telemetry observe-only missing operation never registers or sends', async () => {
  const f = fixture(() => proof);
  assert.equal((await f.stop('pane', { operationId: 'op', observeOnly: true })).process, 'unknown');
  assert.equal(f.requests.length, 0);
});

test('telemetry exact successful proof is cached and an operation cannot change pane', async () => {
  const f = fixture(() => proof);
  assert.equal((await f.stop('pane', { operationId: 'op' })).ok, true);
  assert.equal((await f.stop('pane', { operationId: 'op', observeOnly: true })).ok, true);
  assert.equal((await f.stop('other', { operationId: 'op' })).ok, false);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0][3].timeoutMs, 6500);
});
