const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const tick = () => new Promise(setImmediate);
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await tick(); } assert.fail('Condition did not settle'); }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pcm = () => new Response(Buffer.alloc(4800), { headers: { 'content-type': 'audio/pcm' } });
async function fixture(t, options = {}) {
  const calls = [], audio = [], tasks = [];
  let key = () => 'test-key';
  const voice = createVoiceController({ getKey: () => key(), orchestrator: { getState: () => ({ enabled: true, tasks }), cancel: () => assert.fail('Speech signal must not cancel work') },
    fetch: async (_, init) => { calls.push(init); return options.fetch ? options.fetch(init, calls.length) : pcm(); },
    inferenceFactory: () => ({ start: async () => {}, dispose() {}, feed() {} }),
    onAudio: chunk => audio.push(chunk)
  });
  t.after(() => voice.dispose()); await voice.setListening(true);
  return { voice, calls, audio, tasks, setKey(value) { key = value; },
    speak(signal, requestId = 'r1', extras = {}) { return voice.speak({ text: requestId + ' result.', origin: 'voice', requestId, signal, ...extras }); },
    async done() { const id = voice.getState().replyId; await until(() => audio.some(chunk => chunk.replyId === id && chunk.done && !chunk.cancelled)); voice.configure({ playbackDone: id }); }
  };
}

test('pre-aborted speech neither fetches nor installs an abort listener', async t => {
  const f = await fixture(t), abort = new AbortController(); abort.abort();
  assert.equal((await f.speak(abort.signal)).status, 'cancelled'); assert.equal(f.calls.length, 0);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('queued abort returns promptly but cannot advance later speech past an active reply', async t => {
  const f = await fixture(t), abort = new AbortController();
  const first = f.speak(undefined, 'first'); await until(() => f.calls.length);
  const id = f.voice.getState().replyId, cancelled = f.speak(abort.signal, 'cancelled'), last = f.speak(undefined, 'last');
  abort.abort(); assert.equal((await cancelled).status, 'cancelled'); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.voice.getState().replyId, id); assert.equal(f.calls[0].signal.aborted, false);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  await f.done(); await first; await until(() => f.calls.length === 2); await f.done(); await last;
  assert.deepEqual(f.calls.map(call => JSON.parse(call.body).input), ['first result.', 'last result.']);
});

test('signal wakes a capture-blocked queue without cancelling the current recording', async t => {
  const f = await fixture(t), abort = new AbortController(); f.voice.configure({ pushToTalk: 'start', holdId: 1 });
  const cancelled = f.speak(abort.signal), later = f.speak(undefined, 'later'); await tick(); abort.abort();
  assert.equal((await cancelled).status, 'cancelled'); assert.equal(f.voice.getState().phase, 'recording');
  assert.equal(f.calls.length, 0); f.voice.configure({ pushToTalk: 'cancel', holdId: 1 });
  await until(() => f.calls.length); await f.done(); assert.equal((await later).ok, true);
});

test('signal wakes an answer-blocked queue without discarding the active question', async t => {
  const f = await fixture(t), abort = new AbortController();
  const question = { id: 'q1', requestId: 'q-request', text: 'Choose a project.' }; f.tasks.push({ requestId: 'q-request', status: 'needs-answer', question });
  const prompt = f.speak(undefined, 'q-request', { question }); await until(() => f.calls.length); await f.done(); await prompt;
  const cancelled = f.speak(abort.signal); await tick(); abort.abort();
  assert.equal((await cancelled).status, 'cancelled'); assert.equal(f.voice.getState().phase, 'awaiting-answer'); assert.equal(f.calls.length, 1);
  assert.equal(f.tasks[0].question.id, 'q1'); assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('signal during key preparation fences late completion and allows another request to speak', async t => {
  const f = await fixture(t), abort = new AbortController(), key = deferred(); let requested = false;
  f.setKey(() => { requested = true; return key.promise; }); const cancelled = f.speak(abort.signal); await until(() => requested);
  abort.abort(); assert.equal((await cancelled).status, 'cancelled'); assert.equal(f.calls.length, 0);
  f.setKey(() => 'test-key'); const later = f.speak(undefined, 'later'); await until(() => f.calls.length);
  const id = f.voice.getState().replyId; key.resolve('test-key'); await tick(); assert.equal(f.voice.getState().replyId, id); assert.equal(f.calls.length, 1);
  await f.done(); assert.equal((await later).ok, true);
});

test('signal during a noncooperative TTS fetch cancels immediately and preserves another request', async t => {
  const pending = deferred(), f = await fixture(t, { fetch: (_, count) => count === 1 ? pending.promise : pcm() }), abort = new AbortController();
  const cancelled = f.speak(abort.signal); await until(() => f.calls.length); const oldId = f.voice.getState().replyId;
  const later = f.speak(undefined, 'later'); abort.abort(); assert.equal((await cancelled).status, 'cancelled');
  assert.equal(f.calls[0].signal.aborted, true); assert.ok(f.audio.some(chunk => chunk.replyId === oldId && chunk.cancelled));
  await until(() => f.calls.length === 2); const id = f.voice.getState().replyId; pending.resolve(pcm()); await tick();
  assert.equal(f.voice.getState().replyId, id); assert.equal(f.calls[1].signal.aborted, false); await f.done(); assert.equal((await later).ok, true);
});

test('request cancellation during key preparation prevents late speech and releases the queue', { timeout: 1500 }, async t => {
  const f = await fixture(t), key = deferred(); let requested = false;
  f.setKey(() => { requested = true; return key.promise; });
  const cancelled = f.speak(undefined, 'cancelled'); await until(() => requested);
  f.voice.cancelSpeech({ requestId: 'cancelled' });
  f.setKey(() => 'test-key'); const later = f.speak(undefined, 'later');
  assert.equal((await cancelled).status, 'cancelled');
  await until(() => f.calls.length === 1);
  assert.equal(JSON.parse(f.calls[0].body).input, 'later result.');
  const id = f.voice.getState().replyId;
  key.resolve('test-key'); await tick();
  assert.equal(f.voice.getState().replyId, id);
  await f.done(); assert.equal((await later).ok, true);
});

test('request cancellation releases a noncooperative fetch without interrupting the next reply', { timeout: 1500 }, async t => {
  const pending = deferred(), f = await fixture(t, { fetch: (_, count) => count === 1 ? pending.promise : pcm() });
  const cancelled = f.speak(undefined, 'cancelled'); await until(() => f.calls.length === 1);
  const oldId = f.voice.getState().replyId, later = f.speak(undefined, 'later');
  f.voice.cancelSpeech({ requestId: 'cancelled' });
  assert.equal((await cancelled).status, 'cancelled');
  await until(() => f.calls.length === 2);
  assert.ok(f.audio.some(chunk => chunk.replyId === oldId && chunk.cancelled));
  assert.equal(f.calls[0].signal.aborted, true);
  const id = f.voice.getState().replyId;
  pending.resolve(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })); await tick();
  assert.equal(f.voice.getState().replyId, id);
  assert.equal(f.voice.getState().error, null);
  assert.equal(f.calls[1].signal.aborted, false);
  await f.done(); assert.equal((await later).ok, true);
});

test('queued request cancellation cannot let later audio overlap the active reply', { timeout: 1500 }, async t => {
  const f = await fixture(t);
  const first = f.speak(undefined, 'first'); await until(() => f.calls.length === 1);
  const id = f.voice.getState().replyId;
  const cancelled = f.speak(undefined, 'cancelled'), later = f.speak(undefined, 'later');
  f.voice.cancelSpeech({ requestId: 'cancelled' });
  assert.equal((await cancelled).status, 'cancelled'); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.voice.getState().replyId, id);
  await f.done(); await first;
  await until(() => f.calls.length === 2);
  await f.done(); assert.equal((await later).ok, true);
});

test('PTT interruption releases stalled speech while queued replies wait for capture', { timeout: 1500 }, async t => {
  const pending = deferred(), f = await fixture(t, { fetch: (_, count) => count === 1 ? pending.promise : pcm() });
  const interrupted = f.speak(undefined, 'first'); await until(() => f.calls.length === 1);
  const later = f.speak(undefined, 'later');
  f.voice.configure({ pushToTalk: 'start', holdId: 1 });
  assert.equal((await interrupted).status, 'cancelled'); await tick();
  assert.equal(f.voice.getState().phase, 'recording'); assert.equal(f.calls.length, 1);
  f.voice.configure({ pushToTalk: 'cancel', holdId: 1 });
  await until(() => f.calls.length === 2);
  const id = f.voice.getState().replyId; pending.resolve(pcm()); await tick();
  assert.equal(f.voice.getState().replyId, id);
  await f.done(); assert.equal((await later).ok, true);
});

test('speech failure keeps its local alert ahead of queued replies', { timeout: 1500 }, async t => {
  const f = await fixture(t, { fetch: (_, count) => count === 1
    ? new Response('{"error":{"message":"Unauthorized"}}', { status: 401, headers: { 'content-type': 'application/json' } }) : pcm() });
  const failed = f.speak(undefined, 'first'), later = f.speak(undefined, 'later');
  await until(() => f.audio.some(chunk => chunk.local && chunk.done)); await tick();
  assert.equal(f.calls.length, 1);
  await f.done(); assert.equal((await failed).ok, false);
  await until(() => f.calls.length === 2);
  await f.done(); assert.equal((await later).ok, true);
});

test('signal during a local error alert cancels that audio before the next reply starts', { timeout: 1500 }, async t => {
  const f = await fixture(t, { fetch: (_, count) => count === 1
    ? new Response('{"error":{"message":"Unauthorized"}}', { status: 401, headers: { 'content-type': 'application/json' } }) : pcm() });
  const abort = new AbortController();
  const failed = f.speak(abort.signal, 'first'), later = f.speak(undefined, 'later');
  await until(() => f.audio.some(chunk => chunk.local && chunk.done));
  const oldId = f.voice.getState().replyId;
  abort.abort(); assert.equal((await failed).status, 'cancelled');
  await until(() => f.calls.length === 2);
  const cancellation = f.audio.findIndex(chunk => chunk.replyId === oldId && chunk.cancelled);
  assert.ok(cancellation >= 0, 'The old local alert must be stopped, not just abandoned');
  const nextAudio = f.audio.findIndex(chunk => chunk.replyId === f.voice.getState().replyId && !chunk.cancelled);
  assert.ok(nextAudio < 0 || cancellation < nextAudio);
  await f.done(); assert.equal((await later).ok, true);
});

test('PTT during a local error alert owns capture and keeps later speech queued', { timeout: 1500 }, async t => {
  const f = await fixture(t, { fetch: (_, count) => count === 1
    ? new Response('{"error":{"message":"Unauthorized"}}', { status: 401, headers: { 'content-type': 'application/json' } }) : pcm() });
  const abort = new AbortController();
  const failed = f.speak(abort.signal, 'first'), later = f.speak(undefined, 'later');
  await until(() => f.audio.some(chunk => chunk.local && chunk.done));
  const oldId = f.voice.getState().replyId;
  f.voice.configure({ pushToTalk: 'start', holdId: 1 });
  assert.equal((await failed).status, 'cancelled'); await tick();
  assert.ok(f.audio.some(chunk => chunk.replyId === oldId && chunk.cancelled));
  assert.equal(f.voice.getState().phase, 'recording'); assert.equal(f.calls.length, 1);
  abort.abort(); await tick();
  assert.equal(f.voice.getState().phase, 'recording', 'Old speech signal cannot cancel the new capture');
  f.voice.configure({ pushToTalk: 'cancel', holdId: 1 });
  await until(() => f.calls.length === 2);
  await f.done(); assert.equal((await later).ok, true);
});

for (const failure of ['tts-error', 'missing-key']) for (const mode of ['request', 'signal', 'ptt', 'all'])
test(`${mode} cancellation owns ${failure} local audio and fences stale playback`, { timeout: 1500 }, async t => {
  const f = await fixture(t, { fetch: (_, count) => failure === 'tts-error' && count === 1
    ? new Response('{"error":{"message":"Unauthorized"}}', { status: 401, headers: { 'content-type': 'application/json' } }) : pcm() });
  if (failure === 'missing-key') f.setKey(() => null);
  const abort = new AbortController();
  const failed = f.speak(abort.signal, 'first'), queued = f.speak(undefined, 'queued');
  await until(() => f.audio.some(chunk => chunk.local && chunk.done));
  const oldId = f.voice.getState().replyId, fetches = f.calls.length;
  f.setKey(() => 'test-key');
  if (mode === 'request') f.voice.cancelSpeech({ requestId: 'first' });
  else if (mode === 'signal') abort.abort();
  else if (mode === 'ptt') f.voice.configure({ pushToTalk: 'start', holdId: 1 });
  else f.voice.cancelSpeech();
  assert.equal((await failed).status, 'cancelled');
  assert.ok(f.audio.some(chunk => chunk.replyId === oldId && chunk.cancelled), 'Stop the local alert before releasing its queue slot');
  let later = queued;
  if (mode === 'all') { assert.equal((await queued).status, 'cancelled'); later = f.speak(undefined, 'fresh'); }
  if (mode === 'ptt') {
    await tick(); assert.equal(f.voice.getState().phase, 'recording'); assert.equal(f.calls.length, fetches);
    abort.abort(); f.voice.configure({ playbackDone: oldId });
    assert.equal(f.voice.getState().phase, 'recording');
    f.voice.configure({ pushToTalk: 'cancel', holdId: 1 });
  }
  await until(() => f.calls.length === fetches + 1);
  const nextId = f.voice.getState().replyId;
  abort.abort(); f.voice.configure({ playbackDone: oldId }); await tick();
  assert.equal(f.voice.getState().replyId, nextId); assert.equal(f.calls.at(-1).signal.aborted, false);
  await f.done(); assert.equal((await later).ok, true);
});

test('spoken dismissal keeps its result while cancelling queued speech', async t => {
  const f = await fixture(t);
  const dismissed = f.speak(undefined, 'dismissal', { responseTurn: 'dismiss' });
  const cancelled = f.speak(undefined, 'later');
  assert.equal((await dismissed).status, 'dismissed');
  assert.equal((await cancelled).status, 'cancelled');
  assert.equal(f.calls.length, 0);
});

for (const streaming of [true, false]) test(`signal cancels ${streaming ? 'streaming reader' : 'renderer playback'} and cleans its listener`, async t => {
  let readerCancelled = false;
  const f = await fixture(t, streaming ? { fetch: () => new Response(new ReadableStream({ start(stream) { stream.enqueue(Buffer.alloc(4800)); }, cancel() { readerCancelled = true; } }), { headers: { 'content-type': 'audio/pcm' } }) } : {}), abort = new AbortController();
  const speech = f.speak(abort.signal); await until(() => streaming ? f.audio.length : f.audio.some(chunk => chunk.done));
  const id = f.voice.getState().replyId; abort.abort(); assert.equal((await speech).status, 'cancelled');
  assert.ok(f.audio.some(chunk => chunk.replyId === id && chunk.cancelled)); assert.equal(f.voice.getState().phase, 'listening');
  if (streaming) await until(() => readerCancelled);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  f.voice.configure({ playbackDone: id, playbackError: 'stale', playbackReplyId: id }); assert.equal(f.voice.getState().error, null);
});

test('successful speech removes signal listener and a late abort leaves the next reply alone', async t => {
  const f = await fixture(t), abort = new AbortController(); const first = f.speak(abort.signal); await until(() => f.calls.length);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 1); await f.done(); assert.equal((await first).ok, true);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  const later = f.speak(undefined, 'later'); await until(() => f.calls.length === 2); const id = f.voice.getState().replyId;
  abort.abort(); assert.equal(f.voice.getState().replyId, id); assert.equal(f.calls[1].signal.aborted, false); await f.done(); await later;
});

test('a late signal from abandoned TTS cannot cancel newer speech', async t => {
  const pending = deferred(), f = await fixture(t, { fetch: (_, count) => count === 1 ? pending.promise : pcm() }), abort = new AbortController();
  const abandoned = f.speak(abort.signal); await until(() => f.calls.length); f.voice.cancelSpeech();
  const later = f.speak(undefined, 'later'); await until(() => f.calls.length === 2); const id = f.voice.getState().replyId;
  abort.abort(); assert.equal((await abandoned).status, 'cancelled'); assert.equal(f.voice.getState().replyId, id);
  assert.equal(f.calls[1].signal.aborted, false); assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  pending.resolve(pcm()); await tick(); await f.done(); assert.equal((await later).ok, true);
});
