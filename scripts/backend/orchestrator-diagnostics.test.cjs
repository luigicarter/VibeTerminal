'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createDiagnostics } = require('../../backend/orchestratorDiagnostics.cjs');
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-diagnostics-'));
  const loggers = [];
  const open = () => { const logger = createDiagnostics({ userDataPath: root, ...options }); loggers.push(logger); return logger; };
  t.after(async () => { await Promise.all(loggers.map(logger => logger.flush())); assert(path.resolve(root).startsWith(path.join(os.tmpdir(), 'vibe-diagnostics-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const filename = path.join(root, 'logs', 'orchestrator-errors.jsonl');
  return { root, filename, open, read: () => fs.readFileSync(filename, 'utf8').trim().split('\n').map(JSON.parse) };
}
test('diagnostics persist across reopen with one JSON object per line and only approved metadata', async t => {
  const f = fixture(t, { now: () => 0 }); const first = f.open();
  first.record({ event: 'failure', requestId: 'one', generation: 3, httpStatus: 503, error: new Error('line one\nline two'), prompt: 'private prompt', output: 'private output', body: 'private body', audio: 'private audio', apiKey: 'private key' });
  await first.flush(); const second = f.open(); second.record({ event: 'failure', requestId: 'two' }); await second.flush();
  const records = f.read(); assert.equal(records.length, 2); assert.equal(records[0].time, '1970-01-01T00:00:00.000Z'); assert.equal(records[0].error.message, 'line one\nline two'); assert.equal(records[0].httpStatus, 503); assert.equal(records[0].generation, 3); assert.equal(records[1].requestId, 'two');
  assert.doesNotMatch(fs.readFileSync(f.filename, 'utf8'), /private/);
});
test('adapter string errors retain the exact reason and voice reply identity with redaction', async t => {
  const f = fixture(t, { getSecrets: () => ['secret-value'] }); const logger = f.open();
  logger.record({ event: 'action-rejected', error: 'Agent host is unavailable.', replyId: 'voice-reply-1', generation: 'paused:2' });
  logger.record({ event: 'action-rejected', error: 'Failed with secret-value', replyId: 'secret-value' }); await logger.flush();
  const records = f.read(); assert.equal(records[0].error.message, 'Agent host is unavailable.'); assert.equal(records[0].replyId, 'voice-reply-1'); assert.equal(records[0].generation, 'paused:2');
  assert.equal(records[1].error.message, 'Failed with [REDACTED]'); assert.equal(records[1].replyId, '[REDACTED]');
});
test('configured secrets and common credential forms are redacted in every string field', async t => {
  let secret = 'configured-secret'; const f = fixture(t, { getSecrets: () => [secret] }); const logger = f.open();
  logger.record({ event: secret, model: 'Bearer another-secret', reason: 'api_key="key-value"', targetId: 'sk-or-v1-1234567890abcdef', error: { message: secret, stack: 'Authorization: Bearer token-value\naccess_token=access-value', code: secret } });
  secret = 'replacement-secret'; logger.record({ event: secret }); await logger.flush();
  const content = fs.readFileSync(f.filename, 'utf8'); assert.doesNotMatch(content, /configured-secret|replacement-secret|another-secret|key-value|1234567890abcdef|token-value|access-value/); assert.match(content, /REDACTED/);
});
test('rotation retains at most two backups and bounds even the first oversized record', async t => {
  const f = fixture(t, { maxFileBytes: 512 }); const logger = f.open();
  logger.record({ event: 'first', error: { message: '😀\n'.repeat(10000), stack: 'x'.repeat(10000) } }); await logger.flush();
  assert(fs.statSync(f.filename).size <= 512); assert.equal(f.read().length, 1);
  for (let i = 0; i < 12; i++) { logger.record({ event: String(i), error: { message: 'z'.repeat(350) } }); await logger.flush(); }
  const files = fs.readdirSync(path.dirname(f.filename)); assert.equal(files.length, 3);
  for (const file of files) { const full = path.join(path.dirname(f.filename), file); assert(fs.statSync(full).size <= 512); fs.readFileSync(full, 'utf8').trim().split('\n').forEach(line => JSON.parse(line)); }
  assert.equal(f.read().at(-1).event, '11');
});
test('disk errors and invalid event getters do not escape record or flush, and later writes recover', async t => {
  let fail = true; const f = fixture(t, { fsImpl: { ...fs.promises, mkdir: async (...args) => { if (fail) throw Object.assign(new Error('disk unavailable'), { code: 'EACCES' }); return fs.promises.mkdir(...args); } } }); const logger = f.open();
  assert.doesNotThrow(() => logger.record({ get event() { throw new Error('bad getter'); } }));
  assert.doesNotThrow(() => logger.record({ event: 'lost' })); await assert.doesNotReject(logger.flush()); fail = false; logger.record({ event: 'recovered' }); await logger.flush(); assert.deepEqual(f.read().map(r => r.event), ['recovered']);
});
test('slow disk cannot accumulate more than the bounded queue', async t => {
  let release; const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { maxQueuedRecords: 3, fsImpl: { ...fs.promises, appendFile: async (...args) => { await blocked; return fs.promises.appendFile(...args); } } }); const logger = f.open();
  for (let i = 0; i < 100; i++) logger.record({ event: String(i) });
  release(); await logger.flush(); assert.deepEqual(f.read().map(r => r.event), ['0', '1', '2']);
  logger.record({ event: 'after-drain' }); await logger.flush(); assert.equal(f.read().at(-1).event, 'after-drain');
});
test('secret lookup failure drops the record and oversized existing active logs are not retained', async t => {
  let fail = true; const f = fixture(t, { maxFileBytes: 512, getSecrets: () => { if (fail) throw new Error('secrets unavailable'); return []; } }); const logger = f.open();
  logger.record({ event: 'must not persist' }); await logger.flush(); assert.equal(fs.existsSync(f.filename), false);
  fs.mkdirSync(path.dirname(f.filename), { recursive: true }); fs.writeFileSync(f.filename, 'x'.repeat(1024));
  fail = false; logger.record({ event: 'recovered' }); await logger.flush();
  assert.deepEqual(f.read().map(r => r.event), ['recovered']); assert.deepEqual(fs.readdirSync(path.dirname(f.filename)), ['orchestrator-errors.jsonl']);
});
