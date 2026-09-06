'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceController } = require('../../backend/voiceController.cjs');
function fixture(t, fetch, options = {}) {
  const events = []; let controller;
  controller = createVoiceController({
    orchestrator: { getState: () => ({ enabled: true }), send: async () => ({ ok: true }), recordDiagnostic: event => { events.push(event); return options.hook?.(event); } },
    getKey: () => 'private-key', getSettings: () => ({ sttModel: 'test-stt' }), fetch,
    errorAudio: { load: () => ({ pcm: Buffer.alloc(2), durationMs: 1 }) },
    onAudio: chunk => { if (chunk.done && !chunk.cancelled) queueMicrotask(() => controller.configure(options.playbackFailure && !chunk.local ? { playbackError: 'device failed' } : { playbackDone: chunk.replyId })); },
  });
  t.after(() => controller.dispose());
  return { controller, events };
}
const failure = () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'private-key provider payload' } }) });
const audioBase64 = 'private-recorded-audio'.repeat(10);
test('transcription records bounded provider metadata without recorded content', async t => {
  const { controller, events } = fixture(t, failure); await controller.setListening(true);
  assert.equal((await controller.sendAudio({ audioBase64 })).ok, false);
  assert.equal(events.length, 1); assert.equal(events[0].stage, 'transcription');
  assert.equal(events[0].httpStatus, 429); assert.equal(events[0].category, 'rate-limit'); assert.equal(events[0].model, 'test-stt');
  assert(!JSON.stringify(events).match(/private-key|provider payload|private-recorded-audio/));
});
test('speech failure records identity without reply text', async t => {
  const { controller, events } = fixture(t, failure);
  await controller.speak({ preview: true, text: 'private reply text', id: 'request-1' });
  assert.equal(events.length, 1); assert.equal(events[0].stage, 'speech'); assert.equal(events[0].requestId, 'request-1'); assert(events[0].replyId);
  assert(!JSON.stringify(events).includes('private reply text'));
});
test('playback and microphone failures are recorded without extra announcements', async t => {
  const response = () => ({ ok: true, headers: { get: () => 'audio/pcm' }, body: (async function* () { yield Buffer.alloc(20); })() });
  const { controller, events } = fixture(t, response, { playbackFailure: true });
  assert.equal((await controller.speak({ preview: true, text: 'private reply' })).ok, false);
  controller.configure({ microphoneError: 'Microphone device unavailable' });
  assert.deepEqual(events.map(e => e.stage), ['playback', 'microphone']);
});
test('cancellation and ordinary guards produce no diagnostic', async t => {
  let release; const { controller, events } = fixture(t, () => new Promise(resolve => { release = resolve; }));
  await controller.sendAudio({ audioBase64 });
  const pending = controller.speak({ preview: true, text: 'private reply' }); await new Promise(setImmediate);
  controller.cancelSpeech(); release(failure());
  assert.equal((await pending).status, 'cancelled'); assert.equal(events.length, 0);
});
test('throwing and rejecting diagnostic hooks cannot change failure behavior', async t => {
  for (const hook of [() => { throw Error('logger failed'); }, () => Promise.reject(Error('logger failed'))]) {
    const { controller, events } = fixture(t, failure, { hook });
    assert.equal((await controller.speak({ preview: true, text: 'hello' })).ok, false);
    assert.equal(events.length, 1);
  }
  await new Promise(setImmediate);
});
test('announcing an existing error does not log it again', async t => {
  const { controller, events } = fixture(t, failure); await controller.setListening(true);
  await controller.announceError({ category: 'upstream', operation: 'orchestration' });
  assert.equal(events.length, 0);
});
