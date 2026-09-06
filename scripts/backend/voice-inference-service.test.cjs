const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createVoiceInferenceService } = require('../../backend/voiceInferenceService.cjs');
function harness() {
  const children = [], tasks = new Map(), errors = [], frames = []; let clockId = 0;
  const service = createVoiceInferenceService({ modelPath: 'models', onError: e => errors.push(e), onFrame: f => frames.push(f),
    timers: { setTimeout(fn, ms) { const id = ++clockId; tasks.set(id, { fn, ms }); return id; }, clearTimeout(id) { tasks.delete(id); } },
    fork(host, args, options) { assert.equal(options.serialization, 'advanced'); assert.equal(options.windowsHide, true); const child = new EventEmitter(); child.sent = []; child.send = (m, cb) => { child.sent.push(m); cb?.(); }; child.kill = () => { child.killed = true; child.emit('exit'); }; children.push(child); return child; }
  });
  return { service, children, tasks, errors, frames, async start() { const p = service.start(); children.slice(-2).forEach(c => c.emit('message', { type: 'ready' })); await p; }, expire(ms) { [...tasks.values()].find(t => t.ms === ms).fn(); } };
}
test('startup requires both helpers and normal stop invalidates stale results', async () => {
  const h = harness(); await h.start();
  h.service.feed({ samples: new Float32Array(320), sampleStart: 0, captureToken: 'a', streamId: 1, mode: 'wake' });
  const frame = h.children[0].sent.at(-1);
  h.service.stop();
  h.children[0].emit('message', { type: 'frame', id: frame.id, result: { speech: true } });
  assert.equal(h.frames.length, 0); assert.equal(h.errors.length, 0); assert.equal(h.tasks.size, 0);
  await h.start(); assert.equal(h.children.length, 4); h.service.dispose();
});
test('queue counts unacknowledged samples and faults once at 500ms', async () => {
  const h = harness(); await h.start();
  const frame = { samples: new Float32Array(4000), sampleStart: 0, captureToken: 'a', streamId: 1, mode: 'wake' };
  h.service.feed(frame); const first = h.children[0].sent.at(-1);
  h.children[0].emit('message', { type: 'frame', id: first.id, result: { speech: false } });
  h.service.feed(frame); h.service.feed(frame); assert.equal(h.errors.length, 0);
  h.service.feed({ ...frame, samples: new Float32Array(1) });
  assert.equal(h.errors.length, 1); assert.ok(h.children.every(c => c.killed));
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
test('completion deadline terminates activation and ignores late response', async () => {
  const h = harness(); await h.start(); const pending = h.service.analyze({ samples: new Float32Array(320), captureToken: 1, turnId: 2, speechRevision: 3 });
  h.expire(1000); await assert.rejects(pending, /too long/); assert.equal(h.errors.length, 1); assert.ok(h.children.every(c => c.killed));
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
test('keyword stream retains silence and resets only after detection or discontinuity', () => {
  const { createKeywordDetector } = require('../../backend/voiceKeywordModel.cjs');
  let streams = 0, resets = 0, reads = 0, accepts = 0, detect = false;
  class KeywordSpotter {
    createStream() { streams++; return { remaining: 0, acceptWaveform() { accepts++; this.remaining = 1; } }; }
    isReady(s) { return s.remaining > 0; }
    decode(s) { s.remaining--; }
    getResult() { reads++; return detect ? { keyword: 'HEY VIBE', start_time: 2, timestamps: [0.1, 0.3] } : {}; }
    reset() { resets++; }
  }
  class Vad { reset() {} acceptWaveform() {} isDetected() { return false; } isEmpty() { return true; } }
  const detector = createKeywordDetector({ paths: { keyword: {}, vad: {} }, sherpa: { KeywordSpotter, Vad } });
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
  const detector = createKeywordDetector({ paths: { keyword: {}, vad: {} }, sherpa: { KeywordSpotter, Vad } });
  function feed(start, end, speech) { speaking = speech; for (let p = start; p < end; p += 320) detector.process({ samples: new Float32Array(320), sampleStart: p, mode: 'wake' }); }
  feed(0, 1600, false); assert.equal(count, 1);
  feed(1600, 1920, true); assert.equal(count, 2); assert.equal(accepted[1], 5120, 'first onset replays a full 300ms including left padding');
  feed(1920, 6400, true);
  feed(6400, 12800, false); feed(12800, 16000, true); assert.equal(count, 2, 'short spaced wake cannot replace companion');
  feed(16000, 35200, false); feed(35200, 38400, true); assert.equal(count, 3);
  feed(38400, 100000, true); assert.equal(count, 3, 'continuous speech never periodically resets');
  detector.dispose();
});
