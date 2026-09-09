'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createAgentTelemetryManager } = require('../../backend/agentTelemetry.cjs');

function post(url, token, value) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const request = http.request(url, { method: 'POST', timeout: 3000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-vibe-telemetry-token': token } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error('Fixture callback timed out'))); request.end(body);
  });
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-observed-telemetry-'));
  const servers = [], calls = [];
  const manager = createAgentTelemetryManager({ baseDir: path.join(root, 'shims'),
    openFusionBaseDir: path.join(root, 'openfusion'), openCodeHome: path.join(root, 'opencode-home'),
    runId: 'observed-stop-test', token: 'synthetic-test-token', nodePath: process.execPath, emit() {} });
  t.after(async () => {
    manager.cleanup();
    await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await manager.ready;
  async function adapter(label, respond) {
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const call = { label, endpoint: request.url, payload: JSON.parse(body), token: request.headers['x-vibe-telemetry-token'] };
        calls.push(call);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(request.url === '/mode' ? { status: 'ok' } : respond(call)));
      });
    });
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function register(controlUrl, generation = 'original', sessionId = 'pane') {
    const instrumentation = await manager.prepareSession(sessionId, { generation });
    const launchNonce = instrumentation.env.VIBE_TERMINAL_LAUNCH_NONCE;
    assert.equal(await post(manager.callbackUrl(), manager.token, { type: 'fusion.adapterReady', sessionId, launchNonce, controlUrl }), 204);
    return launchNonce;
  }
  return { manager, calls, adapter, register, stops: () => calls.filter(call => call.endpoint === '/stop-observed') };
}
const proof = payload => ({ ok: true, operationId: payload.operationId, launchNonce: payload.launchNonce,
  process: 'stopped', launchSettled: true });

test('observed Fusion stop binds the operation to active nonce and caches verified proof without repeating control', async t => {
  const f = await fixture(t);
  const url = await f.adapter('original', call => proof(call.payload));
  const nonce = await f.register(url);
  const result = await f.manager.stopFusionSessionObserved('pane', { operationId: 'close-1' });
  assert.deepEqual(result, { ok: true, operationId: 'close-1', launchNonce: nonce, process: 'stopped', launchSettled: true });
  assert.deepEqual(f.stops()[0].payload, { sessionId: 'pane', operationId: 'close-1', launchNonce: nonce, observeOnly: false });
  assert.equal(f.stops()[0].token, f.manager.token);
  assert.deepEqual(await f.manager.stopFusionSessionObserved('pane', { operationId: 'close-1', observeOnly: true }), result);
  assert.deepEqual(await f.manager.stopFusionSessionObserved('pane', { operationId: 'close-1' }), result);
  assert.equal(f.stops().length, 1, 'cached proof causes no second HTTP command');
  assert(f.calls.every(call => ['/mode', '/stop-observed'].includes(call.endpoint)), 'no legacy stop or task command is sent');
});

test('bare acknowledgments, mismatched identities and incomplete process proof never certify closure', async t => {
  const f = await fixture(t);
  const variants = [
    () => ({ status: 'stopped' }),
    payload => ({ ...proof(payload), operationId: 'another-operation' }),
    payload => ({ ...proof(payload), launchNonce: 'another-launch' }),
    payload => ({ ...proof(payload), launchSettled: false }),
    payload => ({ ...proof(payload), process: 'unknown' }),
    payload => ({ ...proof(payload), process: 'closed' }),
    payload => ({ ...proof(payload), ok: 'true' })
  ];
  let variant;
  const url = await f.adapter('original', call => variant(call.payload));
  await f.register(url);
  for (const [index, current] of variants.entries()) {
    variant = current;
    const operationId = `bad-${index}`;
    const result = await f.manager.stopFusionSessionObserved('pane', { operationId });
    assert.equal(result.ok, false); assert.equal(result.operationId, operationId);
    assert.equal(result.process, 'unknown'); assert.equal(result.launchSettled, false);
    assert.match(result.error, /matching process-exit evidence/);
  }
  assert.equal(f.stops().length, variants.length);
});

test('unknown observe-only operation and reuse for another session make no adapter HTTP request', async t => {
  const f = await fixture(t);
  const url = await f.adapter('original', call => proof(call.payload)); await f.register(url);
  assert.equal((await f.manager.stopFusionSessionObserved('pane', { operationId: 'never-commanded', observeOnly: true })).ok, false);
  assert.equal(f.stops().length, 0);
  await f.manager.stopFusionSessionObserved('pane', { operationId: 'bound' });
  const mismatch = await f.manager.stopFusionSessionObserved('other-pane', { operationId: 'bound' });
  assert.equal(mismatch.ok, false); assert.match(mismatch.error, /identity changed/);
  assert.equal(f.stops().length, 1);
});

test('late observation after session replacement queries original adapter and nonce without rerunning the stop command', async t => {
  const f = await fixture(t);
  const oldUrl = await f.adapter('original', call => call.payload.observeOnly ? proof(call.payload)
    : { ...proof(call.payload), ok: false, process: 'unknown', launchSettled: false });
  const nonce = await f.register(oldUrl);
  const first = await f.manager.stopFusionSessionObserved('pane', { operationId: 'late-close' });
  assert.equal(first.ok, false);
  const newUrl = await f.adapter('replacement', call => proof(call.payload));
  const replacementNonce = await f.register(newUrl, 'replacement');
  assert.notEqual(nonce, replacementNonce);
  const late = await f.manager.stopFusionSessionObserved('pane', { operationId: 'late-close', observeOnly: true });
  assert.equal(late.ok, true); assert.equal(late.launchNonce, nonce);
  assert.deepEqual(f.stops().map(call => ({ adapter: call.label, nonce: call.payload.launchNonce, observeOnly: call.payload.observeOnly })), [
    { adapter: 'original', nonce, observeOnly: false }, { adapter: 'original', nonce, observeOnly: true }
  ]);
  await f.manager.stopFusionSessionObserved('pane', { operationId: 'late-close', observeOnly: true });
  assert.equal(f.stops().length, 2, 'verified late proof is cached');
  assert.equal(f.calls.filter(call => call.label === 'replacement' && call.endpoint !== '/mode').length, 0, 'replacement receives no stop or task command');
});
