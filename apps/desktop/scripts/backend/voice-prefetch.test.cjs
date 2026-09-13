'use strict';
// Transcription and the relay's workspace reads take about the same time, and
// neither depends on the other. The controller therefore warms the relay as the
// audio goes out, so the transcript arrives to a snapshot already in hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const { wavFromSamples } = require('../../backend/voiceAudio.cjs');
const { createVoiceController } = require('../../backend/voiceController.cjs');

const audioBase64 = wavFromSamples(Array(1600).fill(0.1)).toString('base64');

function fixture({ prefetch, transcription } = {}) {
  const f = { order: [], sent: [] };
  const orchestrator = {
    isEnabled: () => true, getState: () => ({ enabled: true }),
    ...(prefetch !== null && { prefetch: () => { f.order.push('prefetch'); return prefetch ? prefetch() : { ok: true }; } }),
    enqueue: data => { f.order.push('enqueue'); f.sent.push(data); return { ok: true, requestId: 'request', status: 'queued' }; },
    send: async () => assert.fail('enqueue is the relay entry point for a spoken command.'),
    recordSpeechUsage: () => {},
  };
  f.controller = createVoiceController({ orchestrator, getKey: async () => 'test-key-never-sent', getSettings: () => ({}), emit: () => {},
    fetch: async url => {
      assert(url.endsWith('/transcriptions'), 'Only the transcription request is expected.');
      f.order.push('stt-request');
      if (transcription) await transcription;
      f.order.push('stt-response');
      return { ok: true, json: async () => ({ text: 'open codex in vibe terminal', usage: { cost: 0.002 } }) };
    } });
  return f;
}

test('the relay snapshot is warmed as the transcription request goes out, before its response is awaited', async () => {
  let release;
  const transcription = new Promise(resolve => { release = resolve; });
  const f = fixture({ transcription });
  await f.controller.setListening(true);
  const pending = f.controller.sendAudio({ audioBase64, format: 'wav' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.order, ['prefetch', 'stt-request'], 'the warm-up happens while the audio is still in flight');
  release();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(f.order, ['prefetch', 'stt-request', 'stt-response', 'enqueue']);
  assert.deepEqual(f.sent, [{ text: 'open codex in vibe terminal', origin: 'voice' }]);
  f.controller.dispose();
});

test('a relay that cannot warm, or refuses to, never fails the spoken turn', async () => {
  for (const prefetch of [null, () => { throw new Error('Relay is off.'); }, () => ({ ok: false })]) {
    const f = fixture({ prefetch });
    await f.controller.setListening(true);
    const result = await f.controller.sendAudio({ audioBase64, format: 'wav' });
    assert.equal(result.ok, true);
    assert.deepEqual(f.sent, [{ text: 'open codex in vibe terminal', origin: 'voice' }]);
    assert.equal(f.order.at(-1), 'enqueue');
    f.controller.dispose();
  }
});
