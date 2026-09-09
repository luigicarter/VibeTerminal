const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createVoiceInferenceService } = require('../../backend/voiceInferenceService.cjs');
function harness() {
  const children = [], tasks = new Map(), errors = [], frames = [], diagnostics = []; let clockId = 0;
  const service = createVoiceInferenceService({ modelPath: 'models', onError: e => errors.push(e), onFrame: f => frames.push(f), onDiagnostic: d => diagnostics.push(d),
    timers: { setTimeout(fn, ms) { const id = ++clockId; tasks.set(id, { fn, ms }); return id; }, clearTimeout(id) { tasks.delete(id); } },
    fork(host, args, options) { assert.equal(options.serialization, 'advanced'); assert.equal(options.windowsHide, true); const child = new EventEmitter(); child.sent = []; child.send = (m, cb) => { child.sent.push(m); cb?.(); }; child.kill = () => { child.killed = true; child.emit('exit'); }; children.push(child); return child; }
  });
  return { service, children, tasks, errors, frames, diagnostics, async start() { const p = service.start(); children.slice(-2).forEach(c => c.emit('message', { type: 'ready' })); await p; }, expire(ms) { const [id, task] = [...tasks].find(([,t]) => t.ms === ms); tasks.delete(id); task.fn(); } };
}
test('normal stop invalidates stale results and restart creates new helpers', async () => {
  const h = harness(); await h.start();
  h.service.feed({ samples: new Float32Array(320), sampleStart: 0, captureToken: 'a', streamId: 1, mode: 'wake' });
  const frame = h.children[0].sent.at(-1);
  h.service.stop();
  h.children[0].emit('message', { type: 'frame', id: frame.id, result: { speech: true } });
  assert.equal(h.frames.length, 0); assert.equal(h.errors.length, 0); assert.equal(h.tasks.size, 0);
  await h.start(); assert.equal(h.children.length, 4); h.service.dispose();
});
test('a 520ms callback burst queues bounded dispatch and preserves every classification', async () => {
  const h = harness(); await h.start();
  for (let i = 0; i < 26; i++) h.service.feed({ samples: new Float32Array(320), sampleStart: i * 320, captureToken: 'a', streamId: 1, mode: 'vad' });
  assert.equal(h.children[0].sent.length, 2, 'only init plus one frame enters IPC');
  assert.equal(h.errors.length, 0);
  for (let i = 0; i < 26; i++) {
    const request = h.children[0].sent.at(-1);
    assert.equal(request.frame.sampleStart, i * 320);
    h.children[0].emit('message', { type: 'frame', id: request.id, result: { speech: i === 25 } });
  }
  assert.equal(h.frames.length, 26); assert.equal(h.frames.at(-1).speech, true); assert.equal(h.tasks.size, 0);
  h.service.dispose();
});
test('completion preserves identity, rejects concurrent work without failing service', async () => {
  const h = harness(); await h.start();
  const input = { samples: new Float32Array(160000), captureToken: 8, turnId: 9, speechRevision: 3 };
  const pending = h.service.analyze(input); await assert.rejects(h.service.analyze(input), { name: 'BusyError' });
  const request = h.children[1].sent.at(-1); assert.equal(request.samples.length, 128000);
  h.children[1].emit('message', { type: 'result', id: request.id, result: { complete: true, probability: 0.9, totalMs: 12 } });
  assert.deepEqual(await pending, { complete: true, probability: 0.9, totalMs: 12, captureToken: 8, turnId: 9, speechRevision: 3 });
  assert.equal(h.errors.length, 0); h.service.dispose();
});
test('completion deadline preserves keyword service and fences old completion results', async () => {
  const h = harness(); await h.start(); const pending = h.service.analyze({ samples: new Float32Array(320), captureToken: 1, turnId: 2, speechRevision: 3 });
  const old = h.children[1], request = old.sent.at(-1);
  h.expire(1000); await assert.rejects(pending, { name: 'CompletionUnavailableError' }); assert.equal(h.errors.length, 0);
  assert.ok(old.killed); assert.ok(!h.children[0].killed);
  h.service.feed({ samples: new Float32Array(320), sampleStart: 0, mode: 'wake' });
  const frame = h.children[0].sent.at(-1); h.children[0].emit('message', { type: 'frame', id: frame.id, result: { speech: false } });
  assert.equal(h.frames.length, 1);
  h.expire(1000); const replacement = h.children.at(-1); replacement.emit('message', { type: 'ready' });
  const next = h.service.analyze({ samples: new Float32Array(320), turnId: 4 });
  old.emit('message', { type: 'result', id: request.id, result: { complete: true } });
  old.emit('message', { type: 'result', id: replacement.sent.at(-1).id, result: { complete: true, probability: 1 } });
  replacement.emit('message', { type: 'result', id: replacement.sent.at(-1).id, result: { probability: .2 } });
  assert.equal((await next).probability, .2); assert.equal(h.errors.length, 0); h.service.dispose();
});

test('a stalled final stream frame times out even without more microphone audio', async () => {
  const h = harness(); await h.start();
  h.service.feed({ samples: new Float32Array(320), sampleStart: 0, captureToken: 'a', streamId: 1, mode: 'wake' });
  const request = h.children[0].sent.at(-1);
  assert.equal(Object.hasOwn(request.frame, 'timer'), false, 'timer handles must stay in the parent');
  h.expire(2000);
  assert.equal(h.errors.length, 1); assert.match(h.errors[0].message, /too long/);
  assert.ok(h.children.every(c => c.killed)); assert.equal(h.tasks.size, 0);
  h.children[0].emit('message', { type: 'frame', id: request.id, result: { speech: true } });
  assert.equal(h.frames.length, 0);
});

test('stream acknowledgment clears its deadline and obsolete timers cannot kill a restart', async () => {
  const h = harness(); await h.start();
  const frame = { samples: new Float32Array(320), sampleStart: 0, mode: 'wake' };
  h.service.feed(frame);
  const request = h.children[0].sent.at(-1), obsolete = [...h.tasks.values()][0].fn;
  h.children[0].emit('message', { type: 'frame', id: request.id, result: { speech: false } });
  assert.equal(h.tasks.size, 0); assert.equal(h.frames.length, 1);
  h.service.stop(); await h.start(); obsolete();
  assert.equal(h.errors.length, 0); assert.ok(h.children.slice(-2).every(c => !c.killed));
  h.service.dispose();
});
test('startup deadline rejects start; normal stop aborts pending analysis', async () => {
  const h = harness(); const loading = h.service.start(); h.expire(15000); await assert.rejects(loading, /too long/);
  await h.start(); const pending = h.service.analyze({ samples: new Float32Array(320) }); h.service.stop(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(h.errors.length, 1);
});
test('keyword readiness does not wait for completion initialization or its failures', async () => {
  const h = harness(), started = h.service.start();
  h.children[0].emit('message', { type: 'ready' }); await started;
  await assert.rejects(h.service.analyze({ samples: new Float32Array(320) }), { name: 'CompletionUnavailableError' });
  h.children[1].emit('message', { type: 'error', stage: 'init', error: { name: 'Error', code: 'MODEL_MISSING', message: 'Missing model\n' + 'x'.repeat(400), samples: [1], stack: 'private' } });
  assert.equal(h.errors.length, 0); assert.ok(!h.children[0].killed);
  const diagnostic = h.diagnostics.at(-1); assert.equal(diagnostic.helper, 'completion'); assert.equal(diagnostic.stage, 'init');
  assert.equal(diagnostic.error.code, 'MODEL_MISSING'); assert.equal(diagnostic.error.message.length, 240); assert.ok(!diagnostic.error.message.includes('\n'));
  assert.equal(diagnostic.error.samples, undefined); assert.equal(diagnostic.error.stack, undefined); h.service.dispose();
});

test('sustained idle overflow discards stale wake results and resumes at newest audio', async () => {
  const h = harness(); await h.start();
  const feed = start => h.service.feed({ samples: new Float32Array(320), sampleStart: start, mode: 'wake', streamId: 1 });
  feed(0); const old = h.children[0].sent.at(-1);
  for (let i = 1; i <= 1010; i++) feed(i * 320);
  assert.equal(h.children[0].sent.length, 2); assert.equal(h.errors.length, 0);
  assert.equal(h.diagnostics.filter(d => d.reason === 'wake-backlog-discarded').length, 10);
  h.children[0].emit('message', { type: 'frame', id: old.id, result: { wake: { keyword: 'HEY_LINA' }, speech: true } });
  assert.equal(h.frames.length, 0, 'discarded in-flight wake cannot activate a recording');
  let frame = h.children[0].sent.at(-1); assert.equal(frame.frame.sampleStart, 320320);
  h.children[0].emit('message', { type: 'frame', id: old.id, result: { wake: {} } });
  assert.equal(h.frames.length, 0, 'old request id cannot consume current request');
  for (let i = 1001; i <= 1010; i++) {
    frame = h.children[0].sent.at(-1); assert.equal(frame.frame.sampleStart, i * 320);
    h.children[0].emit('message', { type: 'frame', id: frame.id, result: { speech: false } });
  }
  assert.equal(h.frames.length, 10); assert.equal(h.tasks.size, 0); h.service.dispose();
});

test('active VAD overflow fails explicitly without inventing a safe silence classification', async () => {
  const h = harness(); await h.start();
  for (let i = 0; i < 102; i++) h.service.feed({ samples: new Float32Array(320), sampleStart: i * 320, mode: 'vad' });
  assert.equal(h.errors.length, 1); assert.equal(h.errors[0].name, 'VoiceStreamDiscontinuityError');
  assert.equal(h.frames.length, 0); assert.ok(h.children.every(c => c.killed)); assert.equal(h.tasks.size, 0);
});

test('capture and mode changes discard obsolete queued work without dropping current VAD', async () => {
  const h = harness(); await h.start();
  const feed = (sampleStart, streamId, mode) => h.service.feed({ samples: new Float32Array(320), sampleStart, streamId, mode });
  feed(0, 1, 'wake'); const old = h.children[0].sent.at(-1); feed(320, 1, 'wake'); feed(640, 2, 'vad');
  h.children[0].emit('message', { type: 'frame', id: old.id, result: { wake: {}, speech: true } });
  assert.equal(h.frames.length, 0);
  const next = h.children[0].sent.at(-1); assert.equal(next.frame.sampleStart, 640); assert.equal(next.frame.mode, 'vad');
  h.children[0].emit('message', { type: 'frame', id: next.id, result: { speech: true } });
  assert.equal(h.frames.length, 1); assert.equal(h.frames[0].streamId, 2); h.service.dispose();
});

test('oversized wake is bounded and oversized VAD faults without partial classification', async () => {
  const h = harness(); await h.start();
  h.service.feed({ samples: new Float32Array(100000), sampleStart: 12, mode: 'wake' });
  const request = h.children[0].sent.at(-1); assert.equal(request.frame.samples.length, 32000); assert.equal(request.frame.sampleStart, 68012);
  h.children[0].emit('message', { type: 'frame', id: request.id, result: { speech: false } });
  h.service.feed({ samples: new Float32Array(32001), sampleStart: 100012, mode: 'vad' });
  assert.equal(h.errors[0].name, 'VoiceStreamDiscontinuityError'); assert.equal(h.frames.length, 1);
});

test('completion retries are bounded and stop/dispose fence pending retry callbacks', async () => {
  const h = harness(); await h.start();
  h.children[1].emit('exit', 1);
  for (const ms of [1000, 2000, 4000]) { h.expire(ms); h.children.at(-1).emit('exit', 1); }
  assert.equal(h.children.length, 5); assert.equal(h.tasks.size, 0); assert.equal(h.errors.length, 0);
  await assert.rejects(h.service.analyze({ samples: new Float32Array(320) }), { name: 'CompletionUnavailableError' });
  h.service.stop(); await h.start(); h.children.at(-1).emit('exit', 1);
  const obsolete = [...h.tasks.values()][0].fn; h.service.stop(); await h.start(); const count = h.children.length; obsolete();
  assert.equal(h.children.length, count); assert.equal(h.errors.length, 0);
  h.children.at(-1).emit('exit', 1); const disposedRetry = [...h.tasks.values()][0].fn; h.service.dispose(); disposedRetry();
  assert.equal(h.children.length, count); assert.equal(h.tasks.size, 0);
});

test('completion startup timeout and IPC errors never stop keyword inference', async () => {
  const h = harness(), start = h.service.start(); h.children[0].emit('message', { type: 'ready' }); await start;
  h.expire(15000); assert.equal(h.errors.length, 0); assert.ok(h.children[1].killed); assert.ok(!h.children[0].killed);
  h.expire(1000); const child = h.children.at(-1); child.emit('message', { type: 'ready' });
  child.send = (message, cb) => cb(Error('IPC disconnected'));
  await assert.rejects(h.service.analyze({ samples: new Float32Array(320) }), { name: 'CompletionUnavailableError' });
  assert.equal(h.errors.length, 0); assert.ok(!h.children[0].killed); h.service.dispose();
});

test('hosts select their own model groups and report bounded initialization errors', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  for (const [host, helper, groups] of [['voiceKeywordHost.cjs', 'keyword', ['keyword', 'vad']], ['voiceTurnHost.cjs', 'completion', ['turn']]]) {
    const process = new EventEmitter(); let selected;
    const response = new Promise(resolve => { process.send = resolve; });
    const context = { process, module: { exports: {} }, require: name => {
      if (name === './voiceModels.cjs') return { loadVoiceModels: (root, options) => { selected = options.groups; throw Object.assign(Error('model\n' + 'x'.repeat(400)), { code: 'ENOENT' }); } };
      return {};
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../backend', host), 'utf8'), context);
    await context.module.exports.run(); process.emit('message', { type: 'init', modelPath: 'fixture' });
    const message = await response;
    assert.equal(JSON.stringify(selected), JSON.stringify(groups)); assert.equal(message.helper, helper); assert.equal(message.stage, 'init');
    assert.equal(message.error.code, 'ENOENT'); assert.equal(message.error.message.length, 240); assert.ok(!message.error.message.includes('\n'));
    assert.equal(message.error.stack, undefined);
  }
});

test('keyword stream retains silence and resets only after detection or discontinuity', () => {
  const { createKeywordDetector } = require('../../backend/voiceKeywordModel.cjs');
  let streams = 0, resets = 0, reads = 0, accepts = 0, detect = false;
  class KeywordSpotter {
    createStream() { streams++; return { remaining: 0, acceptWaveform() { accepts++; this.remaining = 1; } }; }
    isReady(s) { return s.remaining > 0; }
    decode(s) { s.remaining--; }
    getResult() { reads++; return detect ? { keyword: 'HEY_LINA', start_time: 2, timestamps: [0.1, 0.3] } : {}; }
    reset() { resets++; }
  }
  class Vad { reset() {} acceptWaveform() {} isDetected() { return false; } isEmpty() { return true; } }
  const detector = createKeywordDetector({ paths: { keyword: {}, vad: {} }, sherpa: { KeywordSpotter, Vad }, verifierFactory: () => ({ accept() {}, onset() {}, verify() { return true; }, reset() {}, dispose() {} }) });
  const frame = { samples: new Float32Array(320), sampleStart: 100, captureToken: 'a', streamId: 1, mode: 'wake' };
  detector.process(frame); detector.process({ ...frame, sampleStart: 420 });
  assert.equal(streams, 1); assert.equal(resets, 0); assert.equal(reads, 2); assert.equal(accepts, 2);
  detect = true; const result = detector.process({ ...frame, sampleStart: 740 });
  assert.equal(result.wake.startSample, 100); assert.equal(result.wake.lastTokenSample, 1060); assert.equal(result.wake.timingApproximate, true); assert.equal(resets, 1);
  assert.equal(detector.process({ ...frame, sampleStart: 1060 }).wake, undefined, 'nearby stream detections are deduplicated');
  detector.process({ ...frame, sampleStart: 2000 }); assert.equal(streams, 2);
  detector.process({ ...frame, sampleStart: 2320, mode: 'vad' }); assert.equal(streams, 2); assert.equal(accepts, 5);
  detector.dispose();
});
test('companion refresh requires a new speech onset after quiet and cooldown', () => {
  const { createKeywordDetector } = require('../../backend/voiceKeywordModel.cjs');
  let count = 0, speaking = false; const accepted = [];
  class KeywordSpotter {
    createStream() { const index = count++; accepted[index] = 0; return { acceptWaveform({ samples }) { accepted[index] += samples.length; } }; }
    isReady() { return false; }
  }
  class Vad { reset() {} acceptWaveform() {} isDetected() { return speaking; } isEmpty() { return true; } }
  const detector = createKeywordDetector({ paths: { keyword: {}, vad: {} }, sherpa: { KeywordSpotter, Vad }, verifierFactory: () => ({ accept() {}, onset() {}, verify() { return true; }, reset() {}, dispose() {} }) });
  function feed(start, end, speech) { speaking = speech; for (let p = start; p < end; p += 320) detector.process({ samples: new Float32Array(320), sampleStart: p, mode: 'wake' }); }
  feed(0, 1600, false); assert.equal(count, 1);
  feed(1600, 1920, true); assert.equal(count, 2); assert.equal(accepted[1], 5120, 'first onset replays a full 300ms including left padding');
  feed(1920, 6400, true);
  feed(6400, 12800, false); feed(12800, 16000, true); assert.equal(count, 2, 'short spaced wake cannot replace companion');
  feed(16000, 35200, false); feed(35200, 38400, true); assert.equal(count, 3);
  feed(38400, 100000, true); assert.equal(count, 3, 'continuous speech never periodically resets');
  detector.dispose();
});
