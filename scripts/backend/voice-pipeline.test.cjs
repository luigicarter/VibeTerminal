const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createRecording, wavFromSamples, shouldSpeak } = require('../../backend/voiceAudio.cjs');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { matchAnswer, questionSpeech } = require('../../backend/voiceAnswers.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(condition, description) { for (let i = 0; i < 200; i++) { if (condition()) return; await tick(); } assert.fail(`Did not reach ${description}`); }
function pcmResponse(chunks = [[0, 128, 255], [127, 0, 0]]) { const pcm = Buffer.from(chunks.flat()); const wav = wavFromSamples(Array(pcm.length / 2).fill(0), 24000); pcm.copy(wav, 44); return { ok: true, headers: new Headers({ 'Content-Type': 'audio/wav' }), body: (async function* () { yield wav.subarray(0, 23); yield wav.subarray(23); })() }; }
function fixture(overrides = {}) {
  const events = [], audio = [], calls = [], dispatched = [], sent = [], usage = [];
  const relayState = { enabled: true };
  let controller;
  const orchestrator = { getState: () => relayState, send: async data => { sent.push(data); return overrides.send ? overrides.send(data) : { ok: true }; }, dispatch: async data => { dispatched.push(data); return { ok: true }; }, recordSpeechUsage: (...args) => usage.push(args) };
  controller = createVoiceController({ orchestrator, getKey: () => 'test-key-never-sent', getSettings: () => ({}), emit: state => { structuredClone(state); events.push(state); }, onAudio: chunk => { audio.push(chunk); if (chunk.done && !chunk.cancelled) setImmediate(() => controller.configure({ playbackDone: chunk.replyId })); }, fetch: async (url, options) => { calls.push({ url, options }); return url.endsWith('/transcriptions') ? { ok: true, json: async () => ({ text: 'show my agents', usage: { cost: 0.002 } }) } : pcmResponse(); }, ...overrides });
  return { controller, events, audio, calls, dispatched, sent, usage, relayState };
}
test('endpointing cancels silence, preserves samples, and caps continuous recordings', () => {
  const silence = createRecording(); let state;
  for (let i = 0; i < 60; i++) state = silence.push(new Float32Array(1600));
  assert.equal(state, 'silence');
  const recording = createRecording();
  for (let i = 0; i < 4; i++) assert.equal(recording.push(new Float32Array(1600).fill(0.1)), 'recording');
  for (let i = 0; i < 9; i++) state = recording.push(new Float32Array(1600));
  assert.equal(state, 'complete'); assert.equal(recording.finish().length, 20800);
  const capped = createRecording(); for (let i = 0; i < 600; i++) state = capped.push(new Float32Array(1600).fill(0.1)); assert.equal(state, 'complete');
  const wave = wavFromSamples([-1, 0, 1]); assert.equal(wave.toString('ascii', 0, 4), 'RIFF'); assert.equal(wave.readUInt32LE(24), 16000); assert.equal(wave.readInt16LE(44), -32768); assert.equal(wave.readInt16LE(48), 32767);
});
test('push-to-talk uploads one in-memory WAV holding the pre-roll ring and the whole hold', async () => {
  const f = fixture(); await f.controller.setListening(true);
  // Idle frames only fill the pre-roll ring; nothing is captured or uploaded.
  for (let i = 0; i < 10; i++) f.controller.frames({ samples: Array(1600).fill(0.1), sampleRate: 16000 });
  assert.equal(f.controller.getState().phase, 'listening'); assert.equal(f.calls.length, 0);
  assert.equal(f.controller.configure({ pushToTalk: 'start' }).status, 'recording');
  assert.equal(f.controller.getState().phase, 'recording');
  for (let i = 0; i < 4; i++) f.controller.frames({ samples: Array(1600).fill(0.1), sampleRate: 16000 });
  for (let i = 0; i < 12; i++) f.controller.frames({ samples: Array(1600).fill(0), sampleRate: 16000 });
  assert.equal(f.controller.getState().phase, 'recording', 'a pause never ends a held recording');
  assert.equal(f.controller.configure({ pushToTalk: 'stop' }).status, 'sent');
  await until(() => f.sent.length, 'relay request');
  assert.equal(f.calls.length, 1); const payload = JSON.parse(f.calls[0].options.body);
  assert.equal(payload.model, 'openai/whisper-large-v3-turbo');
  const wav = Buffer.from(payload.input_audio.data, 'base64');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal((wav.length - 44) / 2, 1600 * 26, 'the ring and every held frame are uploaded');
  assert.deepEqual(f.sent, [{ text: 'show my agents', origin: 'voice' }]); assert.deepEqual(f.usage, [['transcription', 0.002]]);
  f.controller.dispose();
});
test('a hold with no speech is discarded with spoken feedback and no upload; malformed frames are rejected', async () => {
  const f = fixture(); await f.controller.setListening(true);
  assert.equal(f.controller.frames({ samples: [NaN], sampleRate: 16000 }).ok, false);
  assert.equal(f.controller.configure({ pushToTalk: 'start' }).ok, true);
  for (let i = 0; i < 2; i++) f.controller.frames({ samples: Array(1600).fill(0), sampleRate: 16000 });
  assert.equal(f.controller.configure({ pushToTalk: 'stop' }).status, 'empty');
  assert.equal(f.calls.length, 0, 'silence is never uploaded');
  assert.match(f.controller.getState().reply, /didn't catch/);
  assert(f.audio.some(chunk => chunk.local && chunk.data.length));
  f.controller.dispose();
});
test('a cancelled hold uploads nothing and says nothing', async () => {
  const f = fixture(); await f.controller.setListening(true);
  for (let i = 0; i < 5; i++) f.controller.frames({ samples: Array(1600).fill(0.1), sampleRate: 16000 });
  f.controller.configure({ pushToTalk: 'start' });
  for (let i = 0; i < 3; i++) f.controller.frames({ samples: Array(1600).fill(0.1), sampleRate: 16000 });
  assert.equal(f.controller.configure({ pushToTalk: 'cancel' }).status, 'cancelled');
  await tick(); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.audio.length, 0);
  assert.equal(f.controller.getState().phase, 'listening');
  assert.doesNotMatch(f.controller.getState().reply || '', /didn't catch/);
  f.controller.dispose();
});
test('talking over a reply interrupts playback and records instead', async () => {
  let release;
  const f = fixture({ fetch: async url => url.endsWith('/transcriptions') ? { ok: true, json: async () => ({ text: 'stop that' }) } : new Promise(resolve => { release = resolve; }) });
  await f.controller.setListening(true);
  const speech = f.controller.speak({ text: 'A long spoken reply', origin: 'voice' });
  await until(() => f.controller.getState().phase === 'speaking', 'playback');
  assert.equal(f.controller.configure({ pushToTalk: 'start' }).status, 'recording');
  assert.equal(f.controller.getState().phase, 'recording');
  assert(f.audio.some(chunk => chunk.cancelled), 'the reply in flight is cut off');
  release(pcmResponse()); assert.equal((await speech).status, 'cancelled');
  f.controller.dispose();
});
test('holding to talk while a request is in flight is refused as busy', async () => {
  let release;
  const f = fixture({ send: () => new Promise(resolve => { release = resolve; }) });
  await f.controller.setListening(true);
  const pending = f.controller.sendAudio({ audioBase64: wavFromSamples(Array(1600).fill(0.1)).toString('base64'), format: 'wav' });
  await until(() => f.controller.getState().phase === 'thinking', 'relay request');
  const refused = f.controller.configure({ pushToTalk: 'start' });
  assert.equal(refused.ok, false); assert.equal(refused.status, 'busy');
  assert.equal(f.controller.getState().phase, 'thinking');
  release({ ok: true }); await pending; f.controller.dispose();
});
test('the maximum recording length ends a held turn and uploads it', async () => {
  const f = fixture({ recordingOptions: { maxMs: 500 } }); await f.controller.setListening(true);
  f.controller.configure({ pushToTalk: 'start' });
  for (let i = 0; i < 5; i++) f.controller.frames({ samples: Array(1600).fill(0.1), sampleRate: 16000 });
  assert.equal(f.controller.getState().phase, 'transcribing', 'the cap ends the turn even while the key is held');
  await until(() => f.calls.length, 'transcription request');
  assert.equal((Buffer.from(JSON.parse(f.calls[0].options.body).input_audio.data, 'base64').length - 44) / 2, 1600 * 5);
  f.controller.dispose();
});
test('an answer given by holding to talk is matched and dispatched, not sent to the brain', async () => {
  const f = fixture({ fetch: async url => url.endsWith('/transcriptions') ? { ok: true, json: async () => ({ text: 'one' }) } : pcmResponse() });
  const interaction = { id: 'req', sessionId: 'pane', generation: 1, revision: 1, state: 'pending', kind: 'question', questions: [{ id: 'color', question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] }] };
  await f.controller.setListening(true); f.relayState.requests = [interaction];
  await f.controller.announceInteraction(interaction);
  assert.equal(f.controller.getState().phase, 'awaiting-answer');
  assert.equal(f.controller.configure({ pushToTalk: 'start' }).status, 'recording');
  for (let i = 0; i < 4; i++) f.controller.frames({ samples: Array(1600).fill(0.1), sampleRate: 16000 });
  assert.equal(f.controller.configure({ pushToTalk: 'stop' }).status, 'sent');
  await until(() => f.dispatched.length, 'answer dispatch');
  assert.deepEqual(f.dispatched[0].answers, { color: 'Red' }); assert.equal(f.sent.length, 0);
  f.controller.dispose();
});
test('PCM boundaries preserve signed samples and text requests remain silent', async () => {
  assert.equal(shouldSpeak({ origin: 'text' }), false); assert.equal(shouldSpeak({ kind: 'interaction' }), true);
  const f = fixture(); await f.controller.setListening(true); await f.controller.speak({ text: 'text answer', origin: 'text' }); assert.equal(f.calls.length, 0);
  await f.controller.speak({ text: 'voice answer', origin: 'voice' }); assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.calls[0].options.body).response_format, 'pcm'); assert.deepEqual(f.audio.map(c => c.sequence), [0, 1]);
  assert.deepEqual(f.audio.flatMap(c => c.data), [0, 128, 255, 127, 0, 0]); assert.equal(f.controller.getState().phase, 'listening'); f.controller.dispose();
});
test('cancellation discards late transcription and late stream audio', async () => {
  let resolveResponse;
  const f = fixture({ fetch: () => new Promise(resolve => { resolveResponse = resolve; }) }); await f.controller.setListening(true);
  const pending = f.controller.sendAudio({ audioBase64: wavFromSamples(Array(1600).fill(0.1)).toString('base64'), format: 'wav' }); await tick(); f.controller.cancelSpeech();
  resolveResponse({ ok: true, json: async () => ({ text: 'close everything' }) }); await pending; assert.equal(f.sent.length, 0);
  const speech = f.controller.speak({ text: 'Hello', origin: 'voice' }); await tick(); f.controller.cancelSpeech(); resolveResponse(pcmResponse()); await speech;
  assert.equal(f.audio.filter(c => c.data.length).length, 0); f.controller.dispose();
});
test('permission and option answers map literally and never turn yes into always', () => {
  assert.equal(matchAnswer('yes', {}, 'permission').ok, false); assert.deepEqual(matchAnswer('allow once', {}, 'permission'), { ok: true, value: 'once' });
  const q = { options: [{ label: 'Keep files' }, { label: 'Delete files' }], multiple: true, custom: true };
  assert.deepEqual(matchAnswer('one and two', q).value, ['Keep files', 'Delete files']); assert.equal(matchAnswer('do whatever is best', q).ok, false);
  assert.deepEqual(matchAnswer('option one, option two', q).value, ['Keep files', 'Delete files']); assert.deepEqual(matchAnswer('second', q).value, ['Delete files']);
  assert.deepEqual(matchAnswer('custom answer keep only logs', q).value, ['keep only logs']);
  assert.match(questionSpeech({ sessionName: 'Coder', questions: [{ question: 'Choose', ...q }] }, 0), /Coder.*Option 1: Keep files.*Option 2: Delete files/);
});
test('multi-question voice answers dispatch original keyed choices, not a brain prompt', async () => {
  let transcript = 'two';
  const f = fixture({ fetch: async url => url.endsWith('/transcriptions') ? { ok: true, json: async () => ({ text: transcript }) } : pcmResponse() });
  const interaction = { id: 'req', revision: 2, generation: 3, sessionId: 'pane', state: 'pending', kind: 'question', questions: [{ id: 'q1', question: 'Pick a color', options: [{ label: 'Red' }, { label: 'Blue' }] }, { id: 'q2', question: 'Pick a size', options: [{ label: 'Small' }, { label: 'Large' }] }] };
  await f.controller.setListening(true); f.relayState.requests = [interaction]; await f.controller.announceInteraction(interaction);
  assert.equal(f.controller.getState().phase, 'awaiting-answer');
  const wav = wavFromSamples(Array(1600).fill(0.1)).toString('base64');
  await f.controller.sendAudio({ audioBase64: wav }); assert.equal(f.controller.getState().request.currentQuestion, 1); assert.equal(f.dispatched.length, 0);
  transcript = 'one'; await f.controller.sendAudio({ audioBase64: wav });
  assert.equal(f.sent.length, 0); assert.deepEqual(f.dispatched[0], { kind: 'answer_question', targetId: 'pane', requestId: 'req', generation: 3, revision: 2, answers: { q1: 'Blue', q2: 'Small' } });
  f.controller.dispose();
});

test('natural directions while awaiting an answer reach the semantic orchestrator with question identity', async () => {
  const interaction = { id: 'req', revision: 2, generation: 3, sessionId: 'pane', state: 'pending', kind: 'question', questions: [{ id: 'q', question: 'Pick a database', custom: true, options: [{ label: 'SQLite' }] }] };
  const state = { enabled: true, requests: [] }, routed = [];
  const f = fixture({ orchestrator: { getState: () => state, routeUserAnswer: async input => { routed.push(input); return { ok: true, text: 'Answer sent.' }; }, dispatch: async () => assert.fail('A natural direction must not become a guessed literal answer.') },
    fetch: async url => url.endsWith('/transcriptions') ? { ok: true, json: async () => ({ text: 'Use PostgreSQL for that question.' }) } : pcmResponse() });
  await f.controller.setListening(true); state.requests = [interaction]; await f.controller.announceInteraction(interaction);
  const result = await f.controller.sendAudio({ audioBase64: wavFromSamples(Array(1600).fill(0.1)).toString('base64') });
  assert.equal(result.text, 'Answer sent.'); assert.deepEqual(routed, [{ text: 'Use PostgreSQL for that question.', interaction: { id: 'req', sessionId: 'pane', generation: 3, revision: 2 } }]);
  f.controller.dispose();
});

test('an empty answer asks the pending question again and preserves answer routing', async () => {
  let transcript = '';
  const f = fixture({ fetch: async url => url.endsWith('/transcriptions') ? { ok: true, json: async () => ({ text: transcript }) } : pcmResponse() });
  const interaction = { id: 'req', sessionId: 'pane', generation: 1, revision: 1, kind: 'question', state: 'pending', questions: [{ id: 'color', question: 'Which color?', options: [{ label: 'Red' }] }] };
  await f.controller.setListening(true); f.relayState.requests = [interaction]; await f.controller.announceInteraction(interaction);
  const audioBase64 = wavFromSamples(Array(1600).fill(.1)).toString('base64');
  assert.equal((await f.controller.sendAudio({ audioBase64 })).status, 'empty');
  assert.equal(f.controller.getState().phase, 'awaiting-answer');
  assert.match(f.controller.getState().reply, /didn't catch.*Which color/);
  assert.equal(f.dispatched.length, 0); assert.equal(f.sent.length, 0);
  transcript = 'one'; await f.controller.sendAudio({ audioBase64 });
  assert.deepEqual(f.dispatched[0].answers, { color: 'Red' }); assert.equal(f.sent.length, 0);
  f.controller.dispose();
});

test('a hold whose speech is only in the pre-roll ring is still uploaded', async () => {
  const f = fixture();
  await f.controller.setListening(true);
  // The user spoke, then pressed: the words live in the ring, and the live hold is quiet.
  for (let i = 0; i < 9; i++) f.controller.frames({ samples: Array(1600).fill(.1), sampleRate: 16000 });
  f.controller.configure({ pushToTalk: 'start' });
  for (let i = 0; i < 60; i++) f.controller.frames({ samples: Array(1600).fill(0), sampleRate: 16000 });
  assert.equal(f.controller.getState().phase, 'recording');
  f.controller.configure({ pushToTalk: 'stop' });
  await until(() => f.sent.length, 'relay request');
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].url, /\/audio\/transcriptions$/);
  assert.equal(f.sent[0].text, 'show my agents');
  assert.equal(f.audio.some(chunk => chunk.local), false);
  assert.doesNotMatch(f.controller.getState().reply || '', /didn't catch/);
  const wav = Buffer.from(JSON.parse(f.calls[0].options.body).input_audio.data, 'base64');
  assert.equal((wav.length - 44) / 2, 1600 * 69); assert(wav.readInt16LE(44) > 0); f.controller.dispose();
});
test('resolved announcement is discarded and does not reopen answer capture after cancellation', async () => {
  const f = fixture(); await f.controller.setListening(true);
  const interaction = { id: 'resolved', revision: 1, kind: 'question', questions: [{ question: 'Choose', options: [] }] };
  f.controller.resolveInteraction(interaction.id); assert.equal((await f.controller.announceInteraction(interaction)).status, 'resolved'); assert.equal(f.calls.length, 0); assert.equal(f.controller.getState().request, undefined); f.controller.dispose();
});
test('answer listening speaks missed-speech feedback after fifteen seconds without a transcription', async () => {
  const f = fixture(); await f.controller.setListening(true);
  await f.controller.announceInteraction({ id: 'waiting', revision: 1, kind: 'question', questions: [{ question: 'Which option?', options: [{ label: 'One' }] }] });
  assert.equal(f.controller.getState().phase, 'awaiting-answer');
  for (let i = 0; i < 149; i++) f.controller.frames({ samples: Array(1600).fill(0), sampleRate: 16000 });
  assert.equal(f.controller.getState().phase, 'awaiting-answer'); f.controller.frames({ samples: Array(1600).fill(0), sampleRate: 16000 });
  await tick();
  assert.match(f.controller.getState().reply, /didn't catch/);
  assert.equal(f.controller.getState().phase, 'listening'); assert.equal(f.calls.filter(c => c.url.endsWith('/transcriptions')).length, 0); f.controller.dispose();
});
test('same native request ID in two panes and after restart has independent voice identity', async () => {
  const f = fixture(); await f.controller.setListening(true);
  const base = { id: 'p1', generation: 1, revision: 1, state: 'pending', kind: 'question', questions: [{ id: 'q', question: 'Choose', options: [{ label: 'Keep' }] }] };
  const a = { ...base, sessionId: 'pane-a' }, b = { ...base, sessionId: 'pane-b' };
  f.relayState.requests = [a, b];
  await f.controller.announceInteraction(a); assert.equal((await f.controller.announceInteraction(b)).status, 'queued');
  f.relayState.requests = [b]; f.controller.resolveInteraction(a);
  await new Promise(resolve => setTimeout(resolve, 240)); await tick();
  assert.equal(f.controller.getState().phase, 'awaiting-answer'); assert.equal(f.controller.getState().request.sessionId, 'pane-b');
  const before = f.audio.filter(c => c.cancelled).length; f.controller.resolveInteraction(a);
  assert.equal(f.audio.filter(c => c.cancelled).length, before); assert.equal(f.controller.getState().phase, 'awaiting-answer');
  assert.equal((await f.controller.announceInteraction(b)).status, 'duplicate');
  f.controller.resolveInteraction(b); const restarted = { ...b, generation: 2 }; f.relayState.requests = [restarted];
  await f.controller.announceInteraction(restarted); assert.equal(f.controller.getState().request.generation, 2); assert.equal(f.controller.getState().phase, 'awaiting-answer');
  assert.equal(f.calls.filter(c => c.url.endsWith('/speech')).length, 3); f.controller.dispose();
});
test('pending validation includes pane identity, not only request ID and revision', async () => {
  const f = fixture(); await f.controller.setListening(true);
  const a = { id: 'p1', sessionId: 'a', generation: 1, revision: 1, state: 'pending', kind: 'question', questions: [{ question: 'Choose', options: [] }] };
  f.relayState.requests = [{ ...a, sessionId: 'b' }];
  assert.equal((await f.controller.announceInteraction(a)).status, 'resolved'); assert.equal(f.calls.length, 0); f.controller.dispose();
});
test('mouse prefix supersedes an active voice question and preserves the complete answer order', async () => {
  let transcript = 'two';
  let releaseFirst;
  const spoken = [];
  const f = fixture({ fetch: async (url, options) => {
    if (url.endsWith('/transcriptions')) return { ok: true, json: async () => ({ text: transcript }) };
    spoken.push(JSON.parse(options.body).input);
    if (spoken.length === 1) return new Promise(resolve => { releaseFirst = resolve; });
    return pcmResponse();
  } });
  await f.controller.setListening(true);
  const initial = { id: 'p1', sessionId: 'pane', generation: 1, revision: 1, state: 'pending', kind: 'question', questions: [
    { id: 'color', question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] },
    { id: 'size', question: 'Which size?', options: [{ label: 'Small' }, { label: 'Large' }] },
  ] };
  f.relayState.requests = [initial]; const firstAnnouncement = f.controller.announceInteraction(initial); await tick(); assert.equal(f.controller.getState().phase, 'speaking');
  const advanced = { ...initial, revision: 2, partialAnswers: [['Red']] };
  f.relayState.requests = [advanced]; const nextAnnouncement = f.controller.announceInteraction(advanced);
  assert.equal(f.audio.filter(chunk => chunk.cancelled).length, 1); releaseFirst(pcmResponse());
  assert.equal((await firstAnnouncement).status, 'cancelled'); await nextAnnouncement;
  assert.equal(f.controller.getState().phase, 'awaiting-answer'); assert.equal(f.controller.getState().request.currentQuestion, 1);
  assert.equal(spoken.length, 2); assert.match(spoken[1], /Which size/); assert.doesNotMatch(spoken[1], /Which color/);
  await f.controller.sendAudio({ audioBase64: wavFromSamples(Array(1600).fill(0.1)).toString('base64') });
  assert.deepEqual(f.dispatched[0].answers, { color: 'Red', size: 'Large' }); assert.equal(f.dispatched[0].revision, 2); assert.equal(f.dispatched.length, 1);
  assert.equal(f.sent.length, 0); f.controller.dispose();
});
test('requests received while muted announce once when enabled and resolved requests stay silent', async () => {
  const f = fixture();
  const interaction = { id: 'p1', sessionId: 'a', generation: 1, revision: 1, state: 'pending', kind: 'question', questions: [{ question: 'Choose', options: [{ label: 'Keep' }] }] };
  f.relayState.requests = [interaction]; assert.equal((await f.controller.announceInteraction(interaction)).status, 'silent'); assert.equal(f.calls.length, 0);
  await f.controller.setListening(true); await tick(); await tick(); assert.equal(f.controller.getState().phase, 'awaiting-answer'); assert.equal(f.calls.length, 1);
  assert.equal((await f.controller.announceInteraction(interaction)).status, 'duplicate');
  f.relayState.requests = []; f.controller.resolveInteraction(interaction); await f.controller.setListening(false); await f.controller.setListening(true); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.controller.getState().request, undefined); f.controller.dispose();
});
test('spending cap blocks audio requests and upstream errors never expose the key', async () => {
  const limited = fixture({ getSettings: () => ({ spendingLimit: 0 }) }); await limited.controller.setListening(true);
  await limited.controller.sendAudio({ audioBase64: wavFromSamples([1, 1, 1]).toString('base64') });
  await limited.controller.speak({ text: 'Hello', origin: 'voice' }); assert.equal(limited.calls.length, 0); limited.controller.dispose();
  const f = fixture({ fetch: async () => { throw Error('test-key-never-sent refused'); } }); await f.controller.setListening(true);
  await f.controller.sendAudio({ audioBase64: wavFromSamples([1, 1, 1]).toString('base64') });
  assert.equal(f.controller.getState().errorOperation, 'transcription'); assert.equal(f.controller.getState().phase, 'listening');
  assert(!JSON.stringify(f.events).includes('test-key-never-sent')); f.controller.dispose();
});
test('unverified speech models cannot produce incorrectly sampled playback', async () => {
  const f = fixture({ getSettings: () => ({ ttsModel: 'unverified/tts' }) }); await f.controller.setListening(true);
  const result = await f.controller.speak({ text: 'Hello', origin: 'voice' }); assert.equal(result.ok, false); assert.match(result.error, /currently supports/); assert.equal(f.calls.length, 0); f.controller.dispose();
});
test('renderer schedules out-of-order chunks correctly and rejects cancelled late chunks', async () => {
  const scheduled = [];
  class Context { currentTime = 0; destination = {}; resume() { return Promise.resolve(); } close() { return Promise.resolve(); } createBuffer(_channels, length, rate) { return { length, duration: length / rate, copyToChannel(samples) { this.samples = [...samples]; } }; } createBufferSource() { const source = { connect() {}, disconnect() {}, stop() {}, start(at) { scheduled.push({ at, samples: source.buffer.samples }); } }; return source; } }
  const exports = {}; const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../frontend/voice/pcmPlayer.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, AudioContext: Context, setTimeout, clearTimeout, Float32Array, Map, Set });
  const player = new exports.PcmPlayer(() => {}, error => { throw Error(error); });
  const base = { replyId: 'a', sampleRate: 24000, channels: 1, format: 's16le' };
  player.push({ ...base, sequence: 1, data: [255, 127] }); player.push({ ...base, sequence: 0, data: [0, 128] }); await tick();
  assert.deepEqual(scheduled.map(s => s.samples[0]), [-1, 32767 / 32768]); assert.ok(scheduled[1].at >= scheduled[0].at);
  player.push({ ...base, sequence: 2, data: [], cancelled: true }); player.push({ ...base, sequence: 3, data: [0, 0] }); await tick(); assert.equal(scheduled.length, 2); player.dispose();
});
