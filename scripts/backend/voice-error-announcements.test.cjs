'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { wavFromSamples } = require('../../backend/voiceAudio.cjs');
function fixture(t, fetcher, autoDone = true) {
  const calls = [], audio = []; let controller; let time = 1000;
  const state = { enabled: true };
  controller = createVoiceController({ orchestrator: { getState: () => state, send: async () => ({ ok: true }) },
    getKey: () => 'secret-test-key', now: () => time, keywordFactory: () => ({ reset() {}, dispose() {} }),
    fetch: async (...args) => { calls.push(args); return fetcher(...args); },
    onAudio: chunk => { audio.push(chunk); if (chunk.done && !chunk.cancelled && autoDone) queueMicrotask(() => controller.configure({ playbackDone: chunk.replyId })); } });
  t.after(() => controller.dispose());
  return { controller, calls, audio, state, advance: () => { time += 60001; } };
}
const failure = (status, error = {}) => ({ ok: false, status, json: async () => ({ error: { code: status, ...error } }) });
test('transcription credit failure plays bundled PCM with no request to speech endpoint', async t => {
  const f = fixture(t, () => failure(402)); await f.controller.setListening(true);
  const result = await f.controller.sendAudio({ audioBase64: wavFromSamples(Array(1600).fill(.1)).toString('base64') });
  assert.equal(result.upstreamError.category, 'credits'); assert.equal(f.calls.length, 1);
  assert(f.audio.some(c => c.local && c.data.length)); assert(f.audio.at(-1).done);
  assert.match(f.controller.getState().reply, /insufficient credits/i);
  assert(!JSON.stringify(f.audio).includes('secret-test-key'));
});
test('speech service failure uses local fallback rather than recursively requesting speech', async t => {
  const f = fixture(t, () => failure(503)); await f.controller.setListening(true);
  const result = await f.controller.speak({ text: 'A normal spoken response', origin: 'voice' });
  assert.equal(result.upstreamError.category, 'upstream'); assert.equal(f.calls.length, 1);
  assert(f.audio.some(c => c.cancelled)); assert(f.audio.some(c => c.local && c.data.length));
});
test('provider balance errors do not announce depleted OpenRouter account credits', async t => {
  const f = fixture(t, () => failure(402, { metadata: { provider_name: 'Provider', raw: 'secret-test-key insufficient balance' } })); await f.controller.setListening(true);
  await f.controller.speak({ text: 'Reply', origin: 'voice' });
  assert.match(f.controller.getState().reply, /provider could not complete/i);
  assert(!f.controller.getState().reply.includes('insufficient credits'));
});
test('announcements respect voice mute, cancellation and category cooldown', async t => {
  const f = fixture(t, () => { throw Error('No network allowed'); });
  const info = { category: 'credits', message: 'Credit failure', origin: 'text' };
  assert.equal((await f.controller.announceError(info)).status, 'silent');
  await f.controller.setListening(true); assert.equal((await f.controller.announceError(info)).status, 'announced');
  const count = f.audio.length; assert.equal((await f.controller.announceError(info)).status, 'duplicate'); assert.equal(f.audio.length, count);
  f.advance(); assert.equal((await f.controller.announceError(info)).status, 'announced');
  await f.controller.setListening(false); assert.equal((await f.controller.announceError({ category: 'auth' })).status, 'silent');
  assert.equal(f.calls.length, 0);
  const g = fixture(t, () => { throw Error('No network allowed'); }, false); await g.controller.setListening(true);
  const playing = g.controller.announceError(info); await g.controller.setListening(false);
  assert.equal((await playing).status, 'cancelled'); assert(g.audio.at(-1).cancelled);
});
test('cancelled upstream requests produce no error announcement', async t => {
  let release; const f = fixture(t, () => new Promise(resolve => { release = resolve; })); await f.controller.setListening(true);
  const speech = f.controller.speak({ origin: 'voice', text: 'Reply' }); await new Promise(setImmediate);
  f.controller.cancelSpeech(); release(failure(402));
  assert.equal((await speech).status, 'cancelled'); assert(!f.audio.some(c => c.local));
});
test('background error announcements never discard a user recording', async t => {
  const f = fixture(t, () => { throw Error('No network allowed'); }); await f.controller.setListening(true);
  f.controller.configure({ manual: true });
  assert.equal((await f.controller.announceError({ category: 'upstream', origin: 'monitor' })).status, 'queued');
  assert.equal(f.controller.getState().phase, 'recording'); assert.equal(f.audio.length, 0);
  for (let i = 0; i < 60; i++) f.controller.frames({ samples: Array(1600).fill(0), sampleRate: 16000 });
  f.controller.cancelSpeech();
  await new Promise(setImmediate); assert.equal(f.audio.length, 0);
});
test('empty successful speech responses also use the local fallback', async t => {
  const f = fixture(t, () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/pcm' }), body: (async function* () {})() }));
  await f.controller.setListening(true);
  const result = await f.controller.speak({ origin: 'voice', text: 'Reply' });
  assert.equal(result.upstreamError.category, 'upstream'); assert.equal(f.calls.length, 1);
  assert(f.audio.some(c => c.local && c.data.length));
});
test('a broken speech stream cancels partial playback and uses local audio', async t => {
  const f = fixture(t, () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/pcm' }), body: (async function* () { yield Uint8Array.from([0, 0, 5, 0]); throw new TypeError('secret-test-key stream failed'); })() }));
  await f.controller.setListening(true);
  const result = await f.controller.speak({ origin: 'voice', text: 'Reply' });
  assert.equal(result.upstreamError.category, 'network'); assert.equal(f.calls.length, 1);
  assert(f.audio.some(c => c.cancelled)); assert(f.audio.some(c => c.local && c.data.length));
  assert(!f.controller.getState().error.includes('secret-test-key'));
});
