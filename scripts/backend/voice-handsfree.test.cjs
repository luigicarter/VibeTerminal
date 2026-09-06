const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { createRecording } = require('../../backend/voiceAudio.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.fail('Condition did not settle'); }
function fixture(options = {}) {
  const settings = { handsFreeEnabled: true }, relayState = { enabled: true, requests: [] }, sent = [], dispatched = [], uploads = [], packets = [], analyses = [];
  let callbacks, controller, stopped = 0, starts = 0, position = 0, token = 1;
  const service = { start: async () => { starts++; if (options.start) await options.start(); }, dispose: () => { stopped++; }, feed: packet => packets.push(packet), analyze: async input => {
    analyses.push(input); return options.analyze ? options.analyze(input) : { probability: .99, complete: true, ...input, samples: undefined };
  } };
  controller = createVoiceController({ getSettings: () => settings, getKey: () => 'test-key', inferenceFactory: value => { callbacks = value; return service; },
    orchestrator: { getState: () => relayState, send: async input => { sent.push(input); return { ok: true }; }, dispatch: async input => { dispatched.push(input); return { ok: true }; } },
    onAudio: chunk => { if (chunk.done && !chunk.cancelled && !options.manualPlayback) setImmediate(() => controller.configure({ playbackDone: chunk.replyId })); },
    fetch: async (url, init) => { if (url.endsWith('/transcriptions')) { uploads.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ text: options.text ?? 'Hey Vibe, show my agents' }) }; } return { ok: true, headers: new Headers({ 'content-type': 'audio/pcm' }), body: (async function* () { yield Buffer.alloc(480); })() }; }
  });
  const f = { controller, settings, relayState, sent, dispatched, uploads, packets, analyses, get stopped() { return stopped; }, get starts() { return starts; }, get callbacks() { return callbacks; },
    async activate() { controller.configure({ captureToken: token }); await controller.setListening(true); await controller.configure({ refreshHandsFree: true }); },
    capture(ms = 100, value = 0) { const length = ms * 16; const result = controller.frames({ samples: Array(length).fill(value), sampleRate: 16000, captureToken: token, sampleStart: position }); position += length; return result; },
    classify(packet, speech = false, wake = false) { callbacks.onFrame({ ...packet, samples: undefined, sampleEnd: packet.sampleStart + packet.samples.length, speech, ...(wake ? { wake: { keyword: 'HEY VIBE', startSample: packet.sampleStart, lastTokenSample: packet.sampleStart + packet.samples.length } } : {}) }); },
    frame(ms = 100, speech = false, wake = false) { f.capture(ms, speech ? .001 : 0); f.classify(packets.at(-1), speech, wake); },
    changeCapture(next) { token = next; position = 0; controller.configure({ captureToken: next }); }
  };
  return f;
}
test('hands-free defaults off, starts once when enabled, and stops on mute', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); f.settings.handsFreeEnabled = false;
  await f.activate(); assert.equal(f.starts, 0); assert.equal(f.controller.getState().handsFreeStatus, 'off');
  f.settings.handsFreeEnabled = true; await f.controller.configure({ refreshHandsFree: true }); assert.equal(f.starts, 1);
  await f.controller.configure({ refreshHandsFree: true }); assert.equal(f.starts, 1);
  await f.controller.setListening(false); assert.equal(f.stopped, 1); assert.equal(f.controller.getState().handsFreeStatus, 'off');
});
test('neural speech bypasses RMS gate and wake plus immediate command preserves all buffered audio', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); await f.activate();
  for (let i = 0; i < 20; i++) f.frame();
  f.frame(100, true, true); assert.equal(f.controller.getState().recordingSource, 'wake');
  f.frame(100, true); f.frame(); f.frame(); await until(() => f.sent.length);
  assert.equal(f.sent[0].text, 'show my agents');
  const wav = Buffer.from(f.uploads[0].input_audio.data, 'base64');
  assert.equal((wav.length - 44) / 2, 32000 + 4800, 'two seconds of history plus every live sample survive');
});
test('pre-wake silence does not consume grace and wake-only transcription is never relayed', async t => {
  const f = fixture({ text: 'Hey Vibe!' }); t.after(() => f.controller.dispose()); await f.activate();
  for (let i = 0; i < 20; i++) f.frame(); f.frame(100, true, true);
  for (let i = 0; i < 59; i++) f.frame();
  assert.equal(f.uploads.length, 0); assert.equal(f.controller.getState().phase, 'recording');
  f.frame(); await until(() => f.uploads.length && f.controller.getState().phase === 'listening'); assert.equal(f.sent.length, 0);
});
test('speech resuming during completion invalidates the result, including speech awaiting VAD', async t => {
  let resolve;
  const f = fixture({ analyze: input => new Promise(done => { resolve = () => done({ ...input, probability: .99, complete: true }); }) }); t.after(() => f.controller.dispose()); await f.activate();
  f.frame(100, true, true); f.frame(100, true); f.frame(); f.frame(); assert.equal(f.analyses.length, 1);
  f.capture(100, .001); const resumed = f.packets.at(-1);
  resolve(); await tick(); assert.equal(f.uploads.length, 0, 'unclassified received audio must veto immediate sending');
  f.classify(resumed, true); await tick(); assert.equal(f.uploads.length, 0);
  f.frame(); f.frame(); assert.equal(f.analyses.length, 2); resolve(); await until(() => f.sent.length);
});
test('unsure completion continues listening and shows a Space hint after three seconds', async t => {
  const f = fixture({ analyze: async input => ({ ...input, probability: .2, complete: false }) }); t.after(() => f.controller.dispose()); await f.activate();
  f.frame(100, true, true); f.frame(100, true);
  for (let i = 0; i < 30; i++) { f.frame(); await tick(); }
  assert.equal(f.uploads.length, 0); assert.equal(f.controller.getState().finishHint, true); assert.equal(f.analyses.length, 1, 'unchanged silence does not repeatedly invoke completion');
  f.frame(100, true); assert.equal(f.controller.getState().finishHint, false);
});
test('short tap cannot discard automatic capture, and hold adoption preserves source and ownership', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); await f.activate(); f.frame(100, true, true); f.frame(100, true);
  f.controller.configure({ pushToTalk: 'cancel', holdId: 1 }); assert.equal(f.controller.getState().recordingSource, 'wake');
  f.controller.configure({ pushToTalk: 'start', holdId: 2 }); assert.equal(f.controller.getState().recordingSource, 'ptt');
  assert.equal(f.controller.configure({ pushToTalk: 'stop', holdId: 1 }).status, 'stale-hold');
  f.controller.configure({ pushToTalk: 'cancel', holdId: 2 }); assert.equal(f.controller.getState().recordingSource, 'wake');
  f.controller.configure({ pushToTalk: 'start', holdId: 3 }); f.capture();
  f.controller.configure({ pushToTalk: 'stop', holdId: 3 }); await until(() => f.sent.length); assert.equal(f.sent[0].text, 'show my agents');
});
test('short neural answer starts after playback, stops no-answer timer, and dispatches original identity', async t => {
  const f = fixture({ text: 'yes' }); t.after(() => f.controller.dispose()); await f.activate();
  const interaction = { id: 'request', sessionId: 'pane', generation: 4, revision: 2, state: 'pending', kind: 'question', questions: [{ id: 'confirm', question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] };
  f.relayState.requests = [interaction]; await f.controller.announceInteraction(interaction);
  assert.equal(f.controller.getState().phase, 'awaiting-answer'); f.frame(100, true); assert.equal(f.controller.getState().recordingSource, 'answer');
  f.frame(); f.frame(); await until(() => f.dispatched.length);
  assert.deepEqual(f.dispatched[0], { kind: 'answer_question', targetId: 'pane', requestId: 'request', generation: 4, revision: 2, answers: { confirm: 'Yes' } }); assert.equal(f.sent.length, 0);
});
test('old capture and stream events cannot wake or finish a newer microphone generation', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); await f.activate(); f.capture(); const old = f.packets.at(-1);
  f.changeCapture(2); f.classify(old, true, true); assert.equal(f.controller.getState().phase, 'listening');
  assert.equal(f.controller.frames({ samples: [0], sampleRate: 16000, captureToken: 1, sampleStart: 0 }).status, 'stale-capture');
  f.frame(100, true, true); assert.equal(f.controller.getState().phase, 'recording');
  f.changeCapture(3); assert.equal(f.controller.getState().phase, 'listening'); assert.equal(f.uploads.length, 0);
});
test('runtime failure cancels automatic capture, keeps PTT available, and retries explicitly', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); await f.activate(); f.frame(100, true, true);
  f.callbacks.onError(Error('worker exited')); assert.equal(f.controller.getState().handsFreeStatus, 'unavailable'); assert.equal(f.controller.getState().phase, 'listening');
  assert.equal(f.controller.configure({ pushToTalk: 'start' }).status, 'recording'); f.controller.configure({ pushToTalk: 'cancel' });
  await f.controller.configure({ refreshHandsFree: true }); assert.equal(f.starts, 2); assert.equal(f.controller.getState().handsFreeStatus, 'ready'); assert.equal(f.uploads.length, 0);
});
test('automatic maximum cancels instead of uploading and completion tail retains full recording', async t => {
  const f = fixture({ analyze: async input => ({ ...input, probability: .1, complete: false }) }); t.after(() => f.controller.dispose()); await f.activate(); f.frame(100, true, true);
  for (let i = 0; i < 599; i++) f.frame(100, true);
  assert.equal(f.controller.getState().phase, 'listening'); assert.equal(f.uploads.length, 0); assert.match(f.controller.getState().error, /60 seconds/);
  const recording = createRecording({ preRoll: [Float32Array.from([1, 2, 3])], endpointing: false }); recording.push(Float32Array.from([4, 5]));
  assert.deepEqual([...recording.tail(3)], [3, 4, 5]); assert.deepEqual([...recording.finish()], [1, 2, 3, 4, 5]);
});
test('late startup cannot reopen muted capture and startup failure remains retryable', async t => {
  let release;
  const f = fixture({ start: () => new Promise(resolve => { release = resolve; }) }); t.after(() => f.controller.dispose());
  const activating = f.activate(); await until(() => release); await f.controller.setListening(false); release(); await activating;
  assert.equal(f.controller.getState().handsFreeStatus, 'off'); assert.equal(f.stopped, 1);
  const failed = fixture({ start: () => { throw Error('load failed'); } }); t.after(() => failed.controller.dispose()); await failed.activate();
  assert.equal(failed.controller.getState().handsFreeStatus, 'unavailable'); const attempts = failed.starts;
  await failed.controller.configure({ refreshHandsFree: true }); assert.equal(failed.starts, attempts + 1);
});
test('playback suppresses wake frames and pending request resolution cancels an automatic answer', async t => {
  const f = fixture({ text: 'yes', manualPlayback: true }); t.after(() => f.controller.dispose()); await f.activate(); f.capture(); const old = f.packets.at(-1);
  const speaking = f.controller.speak({ text: 'Here is the result', origin: 'voice' }); await tick(); assert.equal(f.controller.getState().phase, 'speaking');
  const count = f.packets.length; f.capture(); assert.equal(f.packets.length, count); f.classify(old, true, true); assert.equal(f.controller.getState().phase, 'speaking');
  f.controller.configure({ playbackDone: f.controller.getState().replyId });
  await speaking;
  const interaction = { id: 'request', sessionId: 'pane', generation: 4, revision: 2, state: 'pending', kind: 'question', questions: [{ id: 'confirm', question: 'Continue?', options: [{ label: 'Yes' }] }] };
  f.relayState.requests = [interaction]; const announcement = f.controller.announceInteraction(interaction); await tick(); f.controller.configure({ playbackDone: f.controller.getState().replyId }); await announcement; f.frame(100, true);
  f.relayState.requests = []; f.controller.resolveInteraction(interaction);
  assert.equal(f.controller.getState().phase, 'listening'); assert.equal(f.controller.getState().recordingSource, undefined); assert.equal(f.uploads.length, 0); assert.equal(f.dispatched.length, 0);
});
test('manual transcripts retain a spoken wake prefix, and capture supports arbitrary packet sizes', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); await f.activate();
  f.capture(13, .1); f.capture(37, .1); f.controller.configure({ pushToTalk: 'start', holdId: 1 }); f.capture(251, .1);
  f.controller.configure({ pushToTalk: 'stop', holdId: 1 }); await until(() => f.sent.length);
  assert.equal(f.sent[0].text, 'Hey Vibe, show my agents'); assert.equal(Buffer.from(f.uploads[0].input_audio.data, 'base64').length, 44 + 301 * 16 * 2);
});
test('adopted short tap and resumed speech cannot schedule concurrent completion', async t => {
  let settle;
  const f = fixture({ analyze: input => new Promise(resolve => { settle = () => resolve({ ...input, probability: .99, complete: true }); }) }); t.after(() => f.controller.dispose()); await f.activate();
  f.frame(100, true, true); f.frame(100, true); f.frame(); f.frame(); assert.equal(f.analyses.length, 1);
  f.controller.configure({ pushToTalk: 'start', holdId: 1 }); f.controller.configure({ pushToTalk: 'cancel', holdId: 1 });
  f.frame(100, true); f.frame(); f.frame(); assert.equal(f.analyses.length, 1, 'old inference remains sole owner until settled');
  settle(); await tick(); assert.equal(f.uploads.length, 0); f.frame(); assert.equal(f.analyses.length, 2);
  settle(); await until(() => f.sent.length); assert.equal(f.controller.getState().handsFreeStatus, 'ready');
});
test('completion scheduling and cancellation errors do not disable hands-free', async t => {
  let attempts = 0;
  const f = fixture({ analyze: async input => { if (++attempts < 3) throw Object.assign(Error('temporary'), { name: attempts === 1 ? 'BusyError' : 'AbortError' }); return { ...input, probability: .99, complete: true }; } });
  t.after(() => f.controller.dispose()); await f.activate(); f.frame(100, true, true); f.frame(100, true); f.frame(); f.frame(); await tick();
  assert.equal(f.controller.getState().handsFreeStatus, 'ready'); f.frame(); await tick(); assert.equal(f.controller.getState().handsFreeStatus, 'ready'); f.frame(); await until(() => f.sent.length);
});
test('a new manual hold owns existing audio while an older flush release is still pending', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); await f.activate();
  f.controller.configure({ pushToTalk: 'start', holdId: 1 }); f.capture(300, .1);
  f.controller.configure({ pushToTalk: 'start', holdId: 2 });
  assert.equal(f.controller.configure({ pushToTalk: 'stop', holdId: 1 }).status, 'stale-hold'); assert.equal(f.uploads.length, 0);
  f.capture(100, .1); f.controller.configure({ pushToTalk: 'stop', holdId: 2 }); await until(() => f.sent.length);
  assert.equal(Buffer.from(f.uploads[0].input_audio.data, 'base64').length, 44 + 400 * 16 * 2);
});
test('a short adopted tap invalidates a cached completion waiting for VAD backlog', async t => {
  let settle;
  const f = fixture({ analyze: input => new Promise(resolve => { settle = () => resolve({ ...input, probability: .99, complete: true }); }) }); t.after(() => f.controller.dispose()); await f.activate();
  f.frame(100, true, true); f.frame(100, true); f.frame(); f.frame(); f.capture(); settle(); await tick();
  assert.equal(f.uploads.length, 0);
  f.controller.configure({ pushToTalk: 'start', holdId: 1 }); f.controller.configure({ pushToTalk: 'cancel', holdId: 1 }); f.frame();
  assert.equal(f.uploads.length, 0, 'old cached completion cannot commit after ownership changes'); assert.equal(f.analyses.length, 2);
  settle(); await until(() => f.sent.length);
});
test('speech queued at the answer deadline survives until VAD classifies it', async t => {
  const f = fixture({ text: 'yes', analyze: async input => ({ ...input, probability: .1, complete: false }) }); t.after(() => f.controller.dispose()); await f.activate();
  const interaction = { id: 'request', sessionId: 'pane', generation: 4, revision: 2, state: 'pending', kind: 'question', questions: [{ id: 'confirm', question: 'Continue?', options: [{ label: 'Yes' }] }] };
  f.relayState.requests = [interaction]; await f.controller.announceInteraction(interaction);
  for (let i = 0; i < 149; i++) f.frame();
  f.capture(100, .001); assert.equal(f.controller.getState().phase, 'awaiting-answer'); f.classify(f.packets.at(-1), true);
  assert.equal(f.controller.getState().recordingSource, 'answer');
  for (let i = 0; i < 151; i++) { f.frame(); await tick(); }
  assert.equal(f.controller.getState().phase, 'recording', 'no-answer timeout stops when speech begins'); assert.equal(f.uploads.length, 0);
});
test('a command wholly buffered before delayed wake detection survives the conservative six-second grace', async t => {
  const f = fixture({ text: 'Hey Vibe, stop' }); t.after(() => f.controller.dispose()); await f.activate();
  f.capture(300, .001); const wake = f.packets.at(-1); f.capture(300, .002); f.classify(wake, true, true);
  for (let i = 0; i < 59; i++) f.frame(); assert.equal(f.uploads.length, 0);
  f.frame(); await until(() => f.sent.length); assert.equal(f.sent[0].text, 'stop');
  const wav = Buffer.from(f.uploads[0].input_audio.data, 'base64'); assert.equal(wav.length, 44 + 6600 * 16 * 2);
  assert.equal(wav.readInt16LE(44 + 300 * 16 * 2), Math.round(.002 * 32767), 'buffered command audio remains intact');
});
