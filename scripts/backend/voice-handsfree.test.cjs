const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { createRecording } = require('../../backend/voiceAudio.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.fail('Condition did not settle'); }
function fixture(options = {}) {
  const settings = { handsFreeEnabled: true }, relayState = { enabled: true, requests: [] }, sent = [], dispatched = [], uploads = [], packets = [], analyses = [], diagnostics = [];
  let callbacks, controller, stopped = 0, starts = 0, position = 0, token = 1;
  const service = { start: async () => { starts++; if (options.start) await options.start(); }, dispose: () => { stopped++; }, feed: packet => packets.push(packet), analyze: async input => {
    analyses.push(input); return options.analyze ? options.analyze(input) : { probability: .99, complete: true, ...input, samples: undefined };
  } };
  controller = createVoiceController({ getSettings: () => settings, getKey: () => 'test-key', inferenceFactory: value => { callbacks = value; return service; },
    orchestrator: { recordDiagnostic: event => diagnostics.push(event), getState: () => relayState, send: async input => { sent.push(input); return { ok: true }; }, dispatch: async input => { dispatched.push(input); return { ok: true }; } },
    onAudio: chunk => { if (chunk.done && !chunk.cancelled && !options.manualPlayback) setImmediate(() => controller.configure({ playbackDone: chunk.replyId })); },
    fetch: async (url, init) => { if (url.endsWith('/transcriptions')) { uploads.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ text: options.text ?? 'Hey Vibe, show my agents' }) }; } return { ok: true, headers: new Headers({ 'content-type': 'audio/pcm' }), body: (async function* () { yield Buffer.alloc(480); })() }; }
  });
  const f = { controller, settings, relayState, sent, dispatched, uploads, packets, analyses, diagnostics, get stopped() { return stopped; }, get starts() { return starts; }, get callbacks() { return callbacks; },
    async activate() { controller.configure({ captureToken: token }); await controller.setListening(true); await controller.configure({ refreshHandsFree: true }); },
    capture(ms = 100, value = 0) { const length = ms * 16; const result = controller.frames({ samples: Array(length).fill(value), sampleRate: 16000, captureToken: token, sampleStart: position }); position += length; return result; },
    classify(packet, speech = false, wake = false) { callbacks.onFrame({ ...packet, samples: undefined, sampleEnd: packet.sampleStart + packet.samples.length, speech, ...(wake ? { wake: { keyword: 'HEY VIBE', startSample: packet.sampleStart, lastTokenSample: packet.sampleStart + packet.samples.length } } : {}) }); },
    frame(ms = 100, speech = false, wake = false) { while (ms > 0) { const duration = Math.min(ms, 100); f.capture(duration, speech ? .001 : 0); f.classify(packets.at(-1), speech, wake); ms -= duration; } },
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
  f.frame(100, true); f.frame(1200); await until(() => f.sent.length);
  assert.equal(f.sent[0].text, 'show my agents');
  const wav = Buffer.from(f.uploads[0].input_audio.data, 'base64');
  assert.equal((wav.length - 44) / 2, 32000 + 20800, 'two seconds of history plus every live sample survive');
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
  f.frame(); f.frame(); assert.equal(f.analyses.length, 2); resolve(); await tick(); f.frame(1000); await until(() => f.sent.length);
});
test('short unsure speech retries after three seconds without uploading doubtful audio', async t => {
  const f = fixture({ analyze: async input => ({ ...input, probability: .2, complete: false }) }); t.after(() => f.controller.dispose()); await f.activate();
  f.frame(100, true, true); f.frame(100, true);
  for (let i = 0; i < 30; i++) { f.frame(); await tick(); }
  await until(() => f.controller.getState().phase === 'listening');
  assert.equal(f.uploads.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.controller.getState().recordingId, undefined); assert.equal(f.analyses.length, 1);
  assert.equal(f.diagnostics.filter(x => x.event === 'voice_recording').at(-1).reason, 'short-speech');
  assert.equal(f.diagnostics.filter(x => x.event === 'voice_recording').at(-1).stage, 'cancel');
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
  f.frame(1200); await until(() => f.dispatched.length);
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
  settle(); await tick(); f.frame(1000); await until(() => f.sent.length); assert.equal(f.controller.getState().handsFreeStatus, 'ready');
});
test('completion scheduling and cancellation errors do not disable hands-free', async t => {
  let attempts = 0;
  const f = fixture({ analyze: async input => { if (++attempts < 3) throw Object.assign(Error('temporary'), { name: attempts === 1 ? 'BusyError' : 'AbortError' }); return { ...input, probability: .99, complete: true }; } });
  t.after(() => f.controller.dispose()); await f.activate(); f.frame(100, true, true); f.frame(100, true); f.frame(); f.frame(); await tick();
  assert.equal(f.controller.getState().handsFreeStatus, 'ready'); f.frame(); await tick(); assert.equal(f.controller.getState().handsFreeStatus, 'ready'); f.frame(); await tick(); f.frame(1000); await until(() => f.sent.length);
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
  f.controller.configure({ pushToTalk: 'start', holdId: 1 }); f.controller.configure({ pushToTalk: 'cancel', holdId: 1 }); f.frame(200);
  assert.equal(f.uploads.length, 0, 'old cached completion cannot commit after ownership changes'); assert.equal(f.analyses.length, 2);
  settle(); await tick(); f.frame(1000); await until(() => f.sent.length);
});
test('speech queued at the answer deadline survives until VAD classifies it', async t => {
  const f = fixture({ text: 'yes', analyze: async input => ({ ...input, probability: .1, complete: false }) }); t.after(() => f.controller.dispose()); await f.activate();
  const interaction = { id: 'request', sessionId: 'pane', generation: 4, revision: 2, state: 'pending', kind: 'question', questions: [{ id: 'confirm', question: 'Continue?', options: [{ label: 'Yes' }] }] };
  f.relayState.requests = [interaction]; await f.controller.announceInteraction(interaction);
  for (let i = 0; i < 149; i++) f.frame();
  f.capture(100, .001); assert.equal(f.controller.getState().phase, 'awaiting-answer'); f.classify(f.packets.at(-1), true);
  assert.equal(f.controller.getState().recordingSource, 'answer');
  for (let i = 0; i < 151; i++) { f.frame(); await tick(); }
  assert.equal(f.controller.getState().phase, 'awaiting-answer', 'short speech retries the current question with a fresh answer deadline'); assert.equal(f.uploads.length, 0);
});
test('a command wholly buffered before delayed wake detection survives the conservative six-second grace', async t => {
  const f = fixture({ text: 'Hey Vibe, stop' }); t.after(() => f.controller.dispose()); await f.activate();
  f.capture(300, .001); const wake = f.packets.at(-1); f.capture(300, .002); f.classify(wake, true, true);
  for (let i = 0; i < 59; i++) f.frame(); assert.equal(f.uploads.length, 0);
  f.frame(); await until(() => f.sent.length); assert.equal(f.sent[0].text, 'stop');
  const wav = Buffer.from(f.uploads[0].input_audio.data, 'base64'); assert.equal(wav.length, 44 + 6600 * 16 * 2);
  assert.equal(wav.readInt16LE(44 + 300 * 16 * 2), Math.round(.002 * 32767), 'buffered command audio remains intact');
});

test('confident completion waits through a short thinking pause and restarts when speech resumes', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); await f.activate();
  f.frame(100, true, true); f.frame(500, true); f.frame(200); await tick();
  assert.equal(f.analyses.length, 1); assert.equal(f.uploads.length, 0, '200ms pause must not send');
  f.frame(800); assert.equal(f.uploads.length, 0, 'one-second thinking pause must not send');
  f.frame(300, true); f.frame(200); await tick();
  assert.equal(f.analyses.length, 2); f.frame(999); assert.equal(f.uploads.length, 0);
  f.frame(1); await until(() => f.sent.length);
  assert.equal(f.diagnostics.filter(x => x.event === 'voice_recording' && x.stage === 'finish').at(-1).reason, 'semantic');
});

test('uncertain semantic result finishes after three seconds quiet and preserves queued speech', async t => {
  const f = fixture({ analyze: async input => ({ ...input, probability: .2, complete: false }) }); t.after(() => f.controller.dispose()); await f.activate();
  f.frame(100, true, true); f.frame(500, true); f.frame(200); await tick();
  f.frame(2799); assert.equal(f.uploads.length, 0);
  f.capture(1); const deadline = f.packets.at(-1); f.capture(300, .001); const resumed = f.packets.at(-1);
  f.classify(deadline); assert.equal(f.uploads.length, 0, 'unclassified audio prevents silence fallback');
  f.classify(resumed, true); f.frame(200); await tick(); f.frame(2799); assert.equal(f.uploads.length, 0);
  f.frame(1); await until(() => f.sent.length);
  assert.equal(f.analyses.length, 2);
  const events = f.diagnostics.filter(x => x.event === 'voice_recording');
  assert.deepEqual(events.map(x => [x.stage, x.reason]), [['start', 'wake'], ['finish', 'silence-fallback']]);
  assert.ok(events.every(x => !('transcript' in x) && !('audio' in x) && !('samples' in x)));
});

test('silence fallback cannot end a manual hold or an obsolete capture', async t => {
  const f = fixture({ analyze: async input => ({ ...input, probability: .2, complete: false }) }); t.after(() => f.controller.dispose()); await f.activate();
  f.frame(100, true, true); f.frame(500, true); f.frame(200); await tick();
  f.capture(100); const old = f.packets.at(-1);
  f.controller.configure({ pushToTalk: 'start', holdId: 1 }); f.classify(old); for (let i = 0; i < 30; i++) f.capture();
  assert.equal(f.uploads.length, 0); assert.equal(f.controller.getState().recordingSource, 'ptt');
  f.controller.configure({ pushToTalk: 'stop', holdId: 1 }); await until(() => f.sent.length);
  assert.equal(f.diagnostics.filter(x => x.stage === 'finish').at(-1).reason, 'manual');
  f.frame(100, true, true); f.frame(500, true); f.capture(100); const cancelled = f.packets.at(-1);
  f.changeCapture(2); f.classify(cancelled); assert.equal(f.uploads.length, 1);
  assert.equal(f.diagnostics.filter(x => x.stage === 'cancel').at(-1).reason, 'cancelled');
});

test('explicit send finishes only its current automatic recording and cannot end a manual hold', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); await f.activate();
  f.frame(100, true, true); f.frame(300, true);
  const id = f.controller.getState().recordingId; assert.ok(Number.isSafeInteger(id));
  for (const stale of [undefined, String(id), id + 1]) assert.equal(f.controller.configure({ finishRecording: stale }).status, 'stale-recording');
  assert.equal(f.uploads.length, 0);
  assert.equal(f.controller.configure({ finishRecording: id }).status, 'sent');
  assert.equal(f.controller.configure({ finishRecording: id }).status, 'stale-recording');
  await until(() => f.sent.length); assert.equal(f.uploads.length, 1); assert.equal(f.controller.getState().recordingId, undefined);
  assert.equal(f.diagnostics.filter(x => x.stage === 'finish').at(-1).reason, 'manual-send');
  f.frame(100, true, true); const next = f.controller.getState().recordingId;
  assert.notEqual(next, id); assert.equal(f.controller.configure({ finishRecording: id }).status, 'stale-recording');
  f.controller.configure({ pushToTalk: 'start', holdId: 1 }); f.capture(300, .1);
  assert.equal(f.controller.configure({ finishRecording: next }).status, 'stale-recording');
  assert.equal(f.controller.getState().recordingSource, 'ptt'); assert.equal(f.uploads.length, 1);
  f.controller.configure({ pushToTalk: 'stop', holdId: 1 }); await until(() => f.sent.length === 2);
});

test('completion diagnostics retain bounded confidence without recorded content', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); await f.activate();
  for (const probability of [.2, -1, 2, NaN]) f.callbacks.onDiagnostic({ type: 'completion', probability, samples: [1], transcript: 'private' });
  const events = f.diagnostics.filter(x => x.event === 'voice_inference');
  assert.deepEqual(events.map(x => x.probability), [.2, 0, 1, undefined]);
  assert.ok(events.every(x => !('samples' in x) && !('transcript' in x)));
});

test('handing a short manual hold back starts a fresh quiet window and retains its speech', async t => {
  const f = fixture({ analyze: async input => ({ ...input, probability: .2, complete: false }) }); t.after(() => f.controller.dispose()); await f.activate();
  f.frame(100, true, true); f.frame(500, true); f.frame(2900); await tick();
  f.controller.configure({ pushToTalk: 'start', holdId: 1 }); f.capture(100, .1);
  f.controller.configure({ pushToTalk: 'cancel', holdId: 1 });
  f.frame(100); await tick(); assert.equal(f.uploads.length, 0, 'old 2900ms quiet must not combine with new 100ms quiet');
  f.frame(2800); await tick(); assert.equal(f.uploads.length, 0);
  f.frame(100); await until(() => f.sent.length);
  const wav = Buffer.from(f.uploads[0].input_audio.data, 'base64');
  assert.equal(wav.length, 44 + 6600 * 16 * 2);
  assert.equal(wav.readInt16LE(44 + 3500 * 16 * 2), Math.round(.1 * 32767), 'speech from manual hold is preserved');
});

test('short-speech retry drains queued classifications and lets a current question be answered again', async t => {
  let probability = .2;
  const f = fixture({ text: 'yes', analyze: async input => ({ ...input, probability, complete: probability > .5 }) }); t.after(() => f.controller.dispose()); await f.activate();
  const interaction = { id: 'request', sessionId: 'pane', generation: 4, revision: 2, state: 'pending', kind: 'question', questions: [{ id: 'confirm', question: 'Continue?', options: [{ label: 'Yes' }] }] };
  f.relayState.requests = [interaction]; await f.controller.announceInteraction(interaction);
  f.frame(100, true); f.frame(2900); await tick();
  f.capture(100); const deadline = f.packets.at(-1); f.capture(100, .001); const queuedSpeech = f.packets.at(-1);
  f.classify(deadline); assert.equal(f.controller.getState().phase, 'recording', 'pending speech classifications must block cancellation');
  f.classify(queuedSpeech, true); f.frame(2900); await tick(); assert.equal(f.controller.getState().phase, 'recording');
  f.frame(100); await until(() => f.controller.getState().phase === 'awaiting-answer');
  assert.equal(f.uploads.length, 0); assert.equal(f.dispatched.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.controller.getState().request.id, interaction.id);
  probability = .99; f.frame(100, true); f.frame(1200); await until(() => f.dispatched.length);
  assert.deepEqual(f.dispatched[0], { kind: 'answer_question', targetId: 'pane', requestId: 'request', generation: 4, revision: 2, answers: { confirm: 'Yes' } });
});

test('resolved question cannot be reopened by a late short-speech deadline', async t => {
  const f = fixture({ analyze: async input => ({ ...input, probability: .2, complete: false }) }); t.after(() => f.controller.dispose()); await f.activate();
  const interaction = { id: 'request', sessionId: 'pane', generation: 4, revision: 2, state: 'pending', kind: 'question', questions: [{ id: 'confirm', question: 'Continue?', options: [{ label: 'Yes' }] }] };
  f.relayState.requests = [interaction]; await f.controller.announceInteraction(interaction);
  f.frame(100, true); f.frame(2900); await tick(); f.capture(100); const deadline = f.packets.at(-1);
  f.relayState.requests = []; f.controller.resolveInteraction(interaction); f.classify(deadline); await tick();
  assert.equal(f.controller.getState().phase, 'listening'); assert.equal(f.uploads.length, 0); assert.equal(f.dispatched.length, 0);
});

test('manual flush failure publishes feedback only for its current hold and allows retry', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); await f.activate();
  f.controller.configure({ pushToTalk: 'start', holdId: 1 }); f.capture(300, .1);
  f.controller.configure({ pushToTalk: 'start', holdId: 2 });
  assert.equal(f.controller.failPushToTalk(1, 'old failure').status, 'stale-hold');
  assert.equal(f.controller.getState().phase, 'recording'); assert.equal(f.controller.getState().error, null);
  assert.equal(f.controller.failPushToTalk(2, 'Microphone flush failed').status, 'cancelled');
  assert.equal(f.controller.getState().phase, 'listening'); assert.equal(f.controller.getState().error, 'Microphone flush failed'); assert.equal(f.uploads.length, 0);
  f.controller.configure({ pushToTalk: 'start', holdId: 3 }); assert.equal(f.controller.getState().error, null);
  assert.equal(f.controller.failPushToTalk(2, 'late failure').status, 'stale-hold');
  f.capture(300, .1); f.controller.configure({ pushToTalk: 'stop', holdId: 3 }); await until(() => f.sent.length);
  assert.equal(f.controller.failPushToTalk(3, 'duplicate failure').status, 'stale-hold');
});

test('off and busy push-to-talk refusals publish authoritative voice feedback', async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  const off = f.controller.configure({ pushToTalk: 'start', holdId: 1 }); assert.equal(off.ok, false); assert.equal(f.controller.getState().error, off.error);
  await f.activate(); f.controller.configure({ pushToTalk: 'start', holdId: 2 }); f.capture(300, .1);
  f.controller.configure({ pushToTalk: 'stop', holdId: 2 }); assert.equal(f.controller.getState().phase, 'transcribing');
  const busy = f.controller.configure({ pushToTalk: 'start', holdId: 3 }); assert.equal(busy.status, 'busy'); assert.equal(f.controller.getState().error, busy.error);
  await until(() => f.sent.length);
});
