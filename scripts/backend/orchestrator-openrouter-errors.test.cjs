'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { classifyOpenRouterError, classifyTransportError, readOpenRouterResponse, upstreamErrorInfo } = require('../../backend/openRouterErrors.cjs');
const response = (status, body) => new Response(JSON.stringify(body), { status });
test('HTTP status and error envelopes classify without leaking provider bodies', async () => {
  for (const [status, category] of [[402, 'credits'], [401, 'auth'], [403, 'request'], [408, 'timeout'], [429, 'rate-limit'], [503, 'upstream'], [400, 'request']]) {
    for (const httpStatus of [status, 200]) {
      await assert.rejects(readOpenRouterResponse(response(httpStatus, { error: { code: status, message: 'SECRET api-key', metadata: {} } })), error => {
        assert.equal(error.category, category); assert.equal(error.status, status); assert.ok(!JSON.stringify(upstreamErrorInfo(error)).includes('SECRET')); return true;
      });
    }
  }
  for (const status of [401, 402]) for (const metadata of [{ provider_name: 'provider' }, { provider_error_code: 'balance' }, { is_byok: true }, { raw: 'private upstream payload' }]) {
    assert.equal(classifyOpenRouterError(status, { error: { metadata } }).category, 'upstream');
  }
  await assert.rejects(readOpenRouterResponse(new Response('<html>SECRET</html>', { status: 503 })), { category: 'upstream' });
  await assert.rejects(readOpenRouterResponse(new Response('not json', { status: 200 })), { category: 'upstream' });
  await assert.rejects(readOpenRouterResponse(response(200, null)), { category: 'upstream' });
});
test('error response reading is bounded', async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(16384)); }, cancel() { cancelled = true; } });
  await assert.rejects(readOpenRouterResponse(new Response(body, { status: 503 })), { category: 'upstream' });
  assert.ok(pulls <= 5); assert.equal(cancelled, true);
});
test('transport failures distinguish network, timeout and user cancellation', () => {
  assert.equal(classifyTransportError(new TypeError('SECRET')).category, 'network');
  assert.equal(classifyTransportError(new DOMException('timeout', 'TimeoutError')).category, 'timeout');
  const controller = new AbortController(); controller.abort();
  assert.equal(classifyTransportError(new Error('failed'), { signal: controller.signal }).name, 'AbortError');
  assert.equal(upstreamErrorInfo(classifyTransportError(new DOMException('cancel', 'AbortError'))), undefined);
});
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-upstream-errors-')); const events = [];
  let fail, chat;
  const instance = createOrchestrator({ userDataPath: dir, onUpstreamError: e => events.push(e), getSessions: async () => [{ id: 's', generation: 1, status: 'running' }], fetch: async (url, options) => {
    if (fail) return fail(url, options);
    if (url.endsWith('/key')) return response(200, { data: {} });
    if (url.includes('/models')) return response(200, { data: [{ id: 'brain', supported_parameters: ['tools'] }] });
    return chat ? chat(options) : response(402, { error: { code: 402, message: 'SECRET' } });
  } });
  t.after(() => { instance.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { instance, events, fail: fn => { fail = fn; }, chat: fn => { chat = fn; }, ready: async () => { await instance.configure({ apiKey: 'SECRET', sessionOnly: true, model: 'brain' }); assert.equal((await instance.setEnabled(true)).ok, true); } };
}
test('voice and text failures preserve error string and emit exactly once', async t => {
  const f = fixture(t); await f.ready();
  for (const origin of ['voice', 'text']) {
    const result = await f.instance.send({ text: 'hello', origin });
    assert.equal(typeof result.error, 'string'); assert.equal(result.upstreamError.category, 'credits');
    assert.equal(f.events.at(-1).origin, origin); assert.equal(f.events.at(-1).operation, 'brain');
  }
  assert.equal(f.events.length, 2); assert.ok(!JSON.stringify(f.events).includes('SECRET'));
});
test('monitor failure notifies once', async t => {
  const f = fixture(t); await f.ready(); await f.instance.refresh({ monitor: true });
  assert.equal(f.events.length, 1); assert.equal(f.events[0].origin, 'monitor');
});
test('models and connection failures notify, missing key remains local', async t => {
  const f = fixture(t);
  assert.equal((await f.instance.testConnection()).ok, false);
  await assert.rejects(f.instance.models()); assert.equal(f.events.length, 0);
  await f.ready(); f.fail(() => response(401, { error: { code: 401 } }));
  assert.equal((await f.instance.testConnection()).upstreamError.category, 'auth');
  await assert.rejects(f.instance.models('speech')); assert.equal(f.events.length, 2);
  assert.deepEqual(f.events.map(e => e.operation), ['connection', 'models']);
});
test('cancelled and superseded failures never notify', async t => {
  const f = fixture(t); await f.ready(); let entered, finish;
  const pending = new Promise(resolve => { entered = resolve; });
  f.chat(async () => { entered(); return new Promise(resolve => { finish = resolve; }); });
  const result = f.instance.send({ text: 'hello', origin: 'voice' }); await pending;
  await f.instance.cancel(); finish(response(402, { error: { code: 402 } }));
  assert.equal((await result).status, 'cancelled'); assert.equal(f.events.length, 0);
});
test('settings changes suppress late catalog and connection notifications', async t => {
  const f = fixture(t); await f.ready(); let entered, finish;
  let pending = new Promise(resolve => { entered = resolve; });
  f.fail(async () => { entered(); return new Promise(resolve => { finish = resolve; }); });
  const connection = f.instance.testConnection(); await pending;
  await f.instance.configure({ model: 'other' }); finish(response(402, { error: { code: 402 } }));
  assert.equal((await connection).upstreamError, undefined); assert.equal(f.events.length, 0);
  pending = new Promise(resolve => { entered = resolve; });
  const catalog = assert.rejects(f.instance.models('speech')); await pending;
  await f.instance.cancel(); finish(response(503, { error: { code: 503 } }));
  await catalog; assert.equal(f.events.length, 0);
});
