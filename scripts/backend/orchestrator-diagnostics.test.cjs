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

test('voice timing and turn identity survive sanitization without audio or transcripts', async t => {
  const f = fixture(t), logger = f.open();
  logger.record({ event: 'voice_recording', stage: 'finish', reason: 'silence', recordingSource: 'wake', recordingId: 7, elapsedMs: 4800, silenceMs: 3000, voicedMs: 700, probability: .2, processingMs: 4, queuedSamples: 320, totalMs: 20, preprocessingMs: 5, inferenceMs: 15, transcript: 'private transcript', samples: [0.1], audio: 'private audio' });
  logger.record({ event: 'voice_inference', processingMs: Infinity, queuedSamples: -1, totalMs: 1e12, probability: 2, recordingSource: 'private content' });
  await logger.flush();
  const [recording, invalid] = f.read();
  assert.equal(recording.recordingId, 7); assert.equal(recording.recordingSource, 'wake');
  for (const [field, value] of Object.entries({ elapsedMs: 4800, silenceMs: 3000, voicedMs: 700, probability: .2, processingMs: 4, queuedSamples: 320, totalMs: 20, preprocessingMs: 5, inferenceMs: 15 })) assert.equal(recording[field], value, field);
  assert.equal(invalid.totalMs, 1e9);
  for (const field of ['processingMs', 'queuedSamples', 'probability', 'recordingSource']) assert.equal(invalid[field], undefined);
  assert.doesNotMatch(fs.readFileSync(f.filename, 'utf8'), /private|samples|transcript/);
});
test('adapter string errors retain the exact reason and voice reply identity with redaction', async t => {
  const f = fixture(t, { getSecrets: () => ['secret-value'] }); const logger = f.open();
  logger.record({ event: 'action-rejected', error: 'Agent host is unavailable.', replyId: 'voice-reply-1', generation: 'paused:2' });
  logger.record({ event: 'action-rejected', error: 'Failed with secret-value', replyId: 'secret-value' }); await logger.flush();
  const records = f.read(); assert.equal(records[0].error.message, 'Agent host is unavailable.'); assert.equal(records[0].replyId, 'voice-reply-1'); assert.equal(records[0].generation, 'paused:2');
  assert.equal(records[1].error.message, 'Failed with [REDACTED]'); assert.equal(records[1].replyId, '[REDACTED]');
});

test('model transport diagnostics retain bounded timing and identity without response content', async t => {
  const f = fixture(t, { getSecrets: () => ['configured-secret'] }), logger = f.open();
  const metrics = { headersMs: 23, bodyMs: 104, deadlineMs: 45000, attempt: 1, promptTokens: 900, completionTokens: 80, reasoningTokens: 12 };
  logger.record({ event: 'request_stage', stage: 'model_complete', ...metrics, provider: 'provider configured-secret', generationId: 'gen-1', toolChoice: 'auto', requestPhase: 'body', body: 'private body', reasoning: 'private reasoning', arguments: 'private arguments', cost: 42 });
  logger.record({ provider: 'p'.repeat(300), generationId: 'Bearer private-token', toolChoice: { raw: 'private choice' }, requestPhase: 'private phase', headersMs: Infinity, bodyMs: -1, deadlineMs: '45000', attempt: NaN, promptTokens: 1e12, completionTokens: -1, reasoningTokens: null });
  logger.record({ requestPhase: 'headers', toolChoice: 'named' });
  await logger.flush(); const [valid, invalid, headers] = f.read();
  for (const [field, value] of Object.entries(metrics)) assert.equal(valid[field], value, field);
  assert.equal(valid.provider, 'provider [REDACTED]'); assert.equal(valid.generationId, 'gen-1'); assert.equal(valid.toolChoice, 'auto'); assert.equal(valid.requestPhase, 'body');
  assert.equal(invalid.provider.length, 256); assert.equal(invalid.generationId, 'Bearer [REDACTED]'); assert.equal(invalid.promptTokens, 1e9);
  for (const field of ['toolChoice', 'requestPhase', 'headersMs', 'bodyMs', 'deadlineMs', 'attempt', 'completionTokens', 'reasoningTokens']) assert.equal(invalid[field], undefined, field);
  assert.equal(headers.requestPhase, 'headers'); assert.equal(headers.toolChoice, 'named');
  assert.doesNotMatch(fs.readFileSync(f.filename, 'utf8'), /configured-secret|private|arguments|"cost"/);
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
test('native control diagnostics retain bounded named controls without raw text or escape bytes', async t => {
  const f = fixture(t), logger = f.open();
  logger.record({ event:'terminal_control', nativeKeys:['ctrl-c','ctrl-u'], lifecycleMode:'preserve', editInput:true, processState:'running', agentProcessState:'exited', prompt:'private prompt', text:'private typed input', data:'\x03', keys:['private raw keys'] });
  for (const nativeKeys of [['ctrl-c','private prompt'], ['\x03'], Array(17).fill('ctrl-u'), 'ctrl-c', [42]]) logger.record({ event:'invalid-control',nativeKeys,lifecycleMode:'private mode',editInput:'yes',processState:'private state',agentProcessState:'arbitrary' });
  logger.record({event:'bounded-controls',nativeKeys:Array(16).fill('ctrl-u'),lifecycleMode:'interrupt',editInput:false,agentProcessState:'unknown'});
  await logger.flush(); const records=f.read();
  assert.deepEqual(records[0].nativeKeys,['ctrl-c','ctrl-u']); assert.equal(records[0].lifecycleMode,'preserve'); assert.equal(records[0].editInput,true); assert.equal(records[0].processState,'running'); assert.equal(records[0].agentProcessState,'exited');
  for(const record of records.slice(1,-1)) for(const field of ['nativeKeys','lifecycleMode','editInput','processState','agentProcessState']) assert.equal(record[field],undefined);
  assert.equal(records.at(-1).nativeKeys.length,16); assert.equal(records.at(-1).editInput,false);
  assert.doesNotMatch(fs.readFileSync(f.filename,'utf8'),/private|arbitrary|prompt|typed|\\u0003/);
});
