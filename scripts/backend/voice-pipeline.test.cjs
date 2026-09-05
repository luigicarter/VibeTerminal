const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createRecording, wavFromSamples, createPcmFramer, shouldSpeak } = require('../../backend/voiceAudio.cjs');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { matchAnswer, questionSpeech } = require('../../backend/voiceAnswers.cjs');
const { tokenizeBpe } = require('../dev/prepare-voice-model.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function pcmResponse(chunks = [[0, 128, 255], [127, 0, 0]]) { return { ok: true, headers: new Headers({ 'Content-Type': 'audio/pcm' }), body: (async function* () { for (const chunk of chunks) yield Uint8Array.from(chunk); })() }; }
function fixture(overrides = {}) {
  const events = [], audio = [], calls = [], dispatched = [], sent = [], usage = [];
  const relayState = { enabled: true };
  let controller;
  const orchestrator = { getState: () => relayState, send: async data => { sent.push(data); return { ok: true }; }, dispatch: async data => { dispatched.push(data); return { ok: true }; }, recordSpeechUsage: (...args) => usage.push(args) };
  controller = createVoiceController({ orchestrator, getKey: () => 'test-key-never-sent', getSettings: () => ({}), keywordFactory: () => ({ accept: () => true, reset() {}, dispose() {} }), emit: state => { structuredClone(state); events.push(state); }, onAudio: chunk => { audio.push(chunk); if (chunk.done && !chunk.cancelled) setImmediate(() => controller.configure({ playbackDone: chunk.replyId })); }, fetch: async (url, options) => { calls.push({ url, options }); return url.endsWith('/transcriptions') ? { ok: true, json: async () => ({ text: 'Hey Vibe, show my agents', usage: { cost: 0.002 } }) } : pcmResponse(); }, ...overrides });
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
test('wake and manual capture upload one in-memory WAV only after voiced endpoint', async () => {
  const f = fixture(); await f.controller.setListening(true);
  f.controller.frames({ samples: Array(1600).fill(0), sampleRate: 16000 }); assert.equal(f.controller.getState().phase, 'recording');
  for (let i = 0; i < 60; i++) f.controller.frames({ samples: Array(1600).fill(0), sampleRate: 16000 }); assert.equal(f.calls.length, 0);
  f.controller.configure({ manual: true });
  for (let i = 0; i < 4; i++) f.controller.frames({ samples: Array(1600).fill(0.1), sampleRate: 16000 });
  for (let i = 0; i < 9; i++) f.controller.frames({ samples: Array(1600).fill(0), sampleRate: 16000 });
  await tick(); assert.equal(f.calls.length, 1); const payload = JSON.parse(f.calls[0].options.body);
  assert.equal(payload.model, 'openai/whisper-large-v3-turbo'); assert.equal(Buffer.from(payload.input_audio.data, 'base64').readUInt32LE(24), 16000);
  assert.deepEqual(f.sent, [{ text: 'show my agents', origin: 'voice' }]); assert.deepEqual(f.usage, [['transcription', 0.002]]);
  f.controller.dispose();
});
test('missing wake model retains working manual capture; malformed frames are rejected', async () => {
  const f = fixture({ keywordFactory: () => { throw Error('missing'); } }); await f.controller.setListening(true);
  assert.equal(f.controller.getState().phase, 'wake-error'); assert.equal(f.controller.configure({ manual: true }).ok, true);
  assert.equal(f.controller.frames({ samples: [NaN], sampleRate: 16000 }).ok, false); f.controller.dispose();
});
test('PCM boundaries preserve signed samples and text requests remain silent', async () => {
  const framer = createPcmFramer(); const bytes = Buffer.concat([framer.push([0, 128, 255]), framer.push([127, 0, 0])]); framer.finish();
  assert.deepEqual([bytes.readInt16LE(0), bytes.readInt16LE(2), bytes.readInt16LE(4)], [-32768, 32767, 0]);
  assert.equal(shouldSpeak({ origin: 'text' }), false); assert.equal(shouldSpeak({ kind: 'interaction' }), true);
  const f = fixture(); await f.controller.setListening(true); await f.controller.speak({ text: 'text answer', origin: 'text' }); assert.equal(f.calls.length, 0);
  await f.controller.speak({ text: 'voice answer', origin: 'voice' }); assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.calls[0].options.body).response_format, 'pcm'); assert.deepEqual(f.audio.map(c => c.sequence), [0, 1, 2]);
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
test('resolved announcement is discarded and does not reopen answer capture after cancellation', async () => {
  const f = fixture(); await f.controller.setListening(true);
  const interaction = { id: 'resolved', revision: 1, kind: 'question', questions: [{ question: 'Choose', options: [] }] };
  f.controller.resolveInteraction(interaction.id); assert.equal((await f.controller.announceInteraction(interaction)).status, 'resolved'); assert.equal(f.calls.length, 0); assert.equal(f.controller.getState().request, undefined); f.controller.dispose();
});
test('answer listening closes after fifteen seconds of silence without a transcription', async () => {
  const f = fixture(); await f.controller.setListening(true);
  await f.controller.announceInteraction({ id: 'waiting', revision: 1, kind: 'question', questions: [{ question: 'Which option?', options: [{ label: 'One' }] }] });
  assert.equal(f.controller.getState().phase, 'awaiting-answer');
  for (let i = 0; i < 149; i++) f.controller.frames({ samples: Array(1600).fill(0), sampleRate: 16000 });
  assert.equal(f.controller.getState().phase, 'awaiting-answer'); f.controller.frames({ samples: Array(1600).fill(0), sampleRate: 16000 });
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
  assert.equal(f.controller.getState().error, 'Could not reach OpenRouter. Check your connection and try again.');
  assert(!JSON.stringify(f.events).includes('test-key-never-sent')); f.controller.dispose();
});
test('unverified speech models cannot produce incorrectly sampled playback', async () => {
  const f = fixture({ getSettings: () => ({ ttsModel: 'unverified/tts' }) }); await f.controller.setListening(true);
  const result = await f.controller.speak({ text: 'Hello', origin: 'voice' }); assert.equal(result.ok, false); assert.match(result.error, /currently supports/); assert.equal(f.calls.length, 0); f.controller.dispose();
});
test('pinned BPE generation agrees with upstream keyword examples and custom Hey Vibe', () => {
  const model = fs.readFileSync(path.resolve(__dirname, '../../vendor/voice/bpe.model'));
  assert.equal(tokenizeBpe(model, 'HEY SIRI').join(' '), '▁HE Y ▁S I RI'); assert.equal(tokenizeBpe(model, 'HEY VIBE').join(' '), '▁HE Y ▁VI B E');
});
test('renderer schedules out-of-order chunks correctly and rejects cancelled late chunks', async () => {
  const scheduled = [];
  class Context { currentTime = 0; destination = {}; resume() { return Promise.resolve(); } close() { return Promise.resolve(); } createBuffer(_channels, length, rate) { return { duration: length / rate, copyToChannel(samples) { this.samples = [...samples]; } }; } createBufferSource() { const source = { connect() {}, disconnect() {}, stop() {}, start(at) { scheduled.push({ at, samples: source.buffer.samples }); } }; return source; } }
  const exports = {}; const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../frontend/voice/pcmPlayer.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, AudioContext: Context, setTimeout, clearTimeout, Float32Array, Map, Set });
  const player = new exports.PcmPlayer(() => {}, error => { throw Error(error); });
  const base = { replyId: 'a', sampleRate: 24000, channels: 1, format: 's16le' };
  player.push({ ...base, sequence: 1, data: [255, 127] }); player.push({ ...base, sequence: 0, data: [0, 128] }); await tick();
  assert.deepEqual(scheduled.map(s => s.samples[0]), [-1, 32767 / 32768]); assert.ok(scheduled[1].at >= scheduled[0].at);
  player.push({ ...base, sequence: 2, data: [], cancelled: true }); player.push({ ...base, sequence: 3, data: [0, 0] }); await tick(); assert.equal(scheduled.length, 2); player.dispose();
});
