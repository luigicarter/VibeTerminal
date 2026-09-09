const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await tick(); } assert.fail('Condition did not settle'); }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const pcm = () => ({ ok: true, headers: new Headers({ 'content-type': 'audio/pcm' }), body: (async function* () { yield Buffer.alloc(480); })() });
function fixture(options = {}) {
  const settings = { handsFreeEnabled: true }, relay = { enabled: true, requests: [], tasks: [] };
  const packets = [], audio = [], speechCalls = [], uploads = [], sent = [], dispatched = [], analyses = [];
  let callbacks, position = 0;
  const controller = createVoiceController({ getKey: () => 'test-key', getSettings: () => settings,
    orchestrator: { getState: () => relay, enqueue: async input => { sent.push(input); return { ok: true }; }, dispatch: async input => { dispatched.push(input); return { ok: true }; }, cancel: () => assert.fail('Wake must not cancel terminal work') },
    inferenceFactory: value => { callbacks = value; return { start: async () => {}, dispose() {}, feed: packet => packets.push(packet), analyze: input => {
      analyses.push(input); return options.analyze ? options.analyze(input) : Promise.resolve({ ...input, probability: .99, complete: true });
    } }; },
    onAudio: chunk => audio.push(chunk),
    fetch: async (url, init) => {
      if (url.endsWith('/transcriptions')) { uploads.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ text: options.text || 'Hey Lina, do the next thing' }) }; }
      speechCalls.push(init); return options.speech ? options.speech(init, speechCalls.length) : pcm();
    }
  });
  return { controller, settings, relay, packets, audio, speechCalls, uploads, sent, dispatched, analyses,
    async activate() { controller.configure({ captureToken: 1 }); await controller.setListening(true); await controller.configure({ refreshHandsFree: true }); },
    capture(ms = 100, value = .01) {
      controller.frames({ samples: Array(ms * 16).fill(value), sampleRate: 16000, captureToken: 1, sampleStart: position }); position += ms * 16; return packets.at(-1);
    },
    classify(packet, { wake = false, speech = false } = {}) { callbacks.onFrame({ ...packet, samples: undefined, sampleEnd: packet.sampleStart + packet.samples.length, speech, ...(wake ? { wake: { keyword: 'HEY LINA', startSample: packet.sampleStart } } : {}) }); },
    wake() { const packet = this.capture(); this.classify(packet, { wake: true, speech: true }); return packet; },
    finish() { return controller.configure({ finishRecording: controller.getState().recordingId }); },
    async speak(message = {}) { const result = controller.speak({ origin: 'voice', text: 'The result is ready.', ...message }); await until(() => speechCalls.length); return { result }; }
  };
}

test('wake aborts preparing TTS, preserves buffered wake plus command and drops stale queued replies', async t => {
  const pending = deferred(), f = fixture({ speech: () => pending.promise }); t.after(() => f.controller.dispose()); await f.activate();
  const { result } = await f.speak(); const replyId = f.controller.getState().replyId;
  const queued = f.controller.speak({ origin: 'voice', requestId: 'old-queued', text: 'An obsolete report.' });
  const wake = f.capture(400, .1); f.capture(300, .2); f.classify(wake, { wake: true, speech: true });
  assert.equal(f.controller.getState().recordingSource, 'wake'); assert.equal(f.speechCalls[0].signal.aborted, true);
  assert.ok(f.audio.some(chunk => chunk.replyId === replyId && chunk.cancelled));
  const recordingId = f.controller.getState().recordingId;
  f.classify(wake, { wake: true }); f.controller.configure({ playbackDone: replyId, playbackError: 'late old error', playbackReplyId: replyId });
  pending.resolve(pcm()); assert.equal((await result).status, 'cancelled'); assert.equal((await queued).status, 'cancelled');
  assert.equal(f.controller.getState().recordingId, recordingId); assert.equal(f.speechCalls.length, 1);
  f.finish(); await until(() => f.sent.length);
  assert.deepEqual(f.sent, [{ text: 'do the next thing', origin: 'voice' }]);
  const wav = Buffer.from(f.uploads[0].input_audio.data, 'base64');
  assert.equal(wav.length, 44 + 700 * 16 * 2);
  assert.equal(wav.readInt16LE(44), Math.round(.1 * 32767));
  assert.equal(wav.readInt16LE(44 + 400 * 16 * 2), Math.round(.2 * 32767));
  assert.equal(f.audio.filter(chunk => !chunk.cancelled).length, 0, 'late TTS never reaches playback');
});

test('wake cancels streaming reader and only the wake phrase interrupts speech', async t => {
  let readerCancelled = 0;
  const f = fixture({ speech: () => ({ ok: true, headers: new Headers({ 'content-type': 'audio/pcm' }), body: new ReadableStream({ start(stream) { stream.enqueue(Buffer.alloc(4800)); }, cancel() { readerCancelled++; } }) }) });
  t.after(() => f.controller.dispose()); await f.activate(); const { result } = await f.speak(); await until(() => f.audio.length);
  const packet = f.capture(); f.classify(packet, { speech: true }); assert.equal(f.controller.getState().phase, 'speaking');
  f.wake(); assert.equal(f.controller.getState().phase, 'recording'); assert.equal(f.speechCalls[0].signal.aborted, true);
  assert.equal((await result).status, 'cancelled'); assert.ok(readerCancelled > 0); assert.ok(f.audio.at(-1).cancelled);
});

test('a provider ignoring cancellation cannot block fresh speech or overwrite its playback callbacks', async t => {
  const pending = deferred(), f = fixture({ speech: (_, n) => n === 1 ? pending.promise : pcm() });
  t.after(() => f.controller.dispose()); await f.activate(); const { result: old } = await f.speak(); f.wake(); f.finish(); await until(() => f.sent.length);
  const fresh = f.controller.speak({ origin: 'voice', text: 'The fresh result.' }); await until(() => f.audio.some(chunk => chunk.done && !chunk.cancelled));
  const freshId = f.controller.getState().replyId;
  pending.resolve(pcm()); assert.equal((await old).status, 'cancelled');
  assert.equal(f.controller.getState().replyId, freshId); assert.equal(f.controller.getState().phase, 'speaking');
  f.controller.configure({ playbackDone: freshId }); assert.equal((await fresh).ok, true); assert.equal(f.controller.getState().phase, 'listening');
});

for (const kind of ['task', 'native', 'permission', 'followup']) test(`wake during ${kind} question preserves the answer route and strips the prefix`, async t => {
  const f = fixture({ text: kind === 'permission' ? 'Hey Lina, allow once' : 'Hey Lina, yes' }); t.after(() => f.controller.dispose()); await f.activate();
  let speech;
  if (kind === 'native' || kind === 'permission') {
    const interaction = { id: 'native-q', sessionId: 'pane', generation: 4, revision: 2, state: 'pending', kind: kind === 'permission' ? 'permission' : 'question', detail: 'Allow this?', questions: [{ id: 'confirm', question: 'Continue?', options: [{ label: 'Yes' }] }] };
    f.relay.requests = [interaction]; speech = f.controller.announceInteraction(interaction);
  } else {
    const question = { id: 'q1', requestId: 'r1', text: 'Continue?' }; f.relay.tasks = [{ requestId: 'r1', status: 'needs-answer', ...(kind === 'task' && { question }) }];
    speech = f.controller.speak({ origin: 'voice', requestId: 'r1', text: question.text, ...(kind === 'task' ? { question } : { responseTurn: 'listen' }) });
  }
  await until(() => f.audio.some(chunk => chunk.done)); f.wake(); assert.equal((await speech).status, 'cancelled'); f.finish();
  await until(() => f.sent.length || f.dispatched.length);
  if (kind === 'native' || kind === 'permission') {
    assert.equal(f.sent.length, 0);
    assert.deepEqual(f.dispatched[0], { kind: kind === 'permission' ? 'permission' : 'answer_question', targetId: 'pane', requestId: 'native-q', generation: 4, revision: 2, ...(kind === 'permission' ? { decision: 'once' } : { answers: { confirm: 'Yes' } }) });
  } else assert.deepEqual(f.sent[0], { text: 'yes', origin: 'voice', replyToRequestId: 'r1', ...(kind === 'task' && { questionId: 'q1' }) });
});

test('replaced question does not recover an obsolete answer identity', async t => {
  const f = fixture({ text: 'Hey Lina, show status' }); t.after(() => f.controller.dispose()); await f.activate();
  const question = { id: 'old', requestId: 'r1', text: 'Continue?' }; f.relay.tasks = [{ requestId: 'r1', status: 'needs-answer', question }];
  const { result } = await f.speak({ question, requestId: 'r1' }); f.relay.tasks[0].question = { ...question, id: 'new' };
  f.wake(); f.finish(); await until(() => f.sent.length); assert.equal((await result).status, 'cancelled');
  assert.deepEqual(f.sent[0], { text: 'show status', origin: 'voice' });
});

test('wake-only interruption keeps a pending question available for the next answer', async t => {
  const f = fixture({ text: 'Hey Lina!' }); t.after(() => f.controller.dispose()); await f.activate();
  const question = { id: 'q1', requestId: 'r1', text: 'Continue?' }; f.relay.tasks = [{ requestId: 'r1', status: 'needs-answer', question }];
  const { result } = await f.speak({ question, requestId: 'r1' }); f.wake(); f.finish(); await until(() => f.controller.getState().phase === 'awaiting-answer');
  assert.equal((await result).status, 'cancelled'); assert.equal(f.sent.length, 0); assert.equal(f.dispatched.length, 0);
});

test('a question interrupted before its first TTS byte still routes the answer to that question', async t => {
  const pending = deferred(), f = fixture({ text: 'Hey Lina, choose the second option', speech: () => pending.promise });
  t.after(() => f.controller.dispose()); await f.activate();
  const question = { id: 'q1', requestId: 'r1', text: 'Which option?' }; f.relay.tasks = [{ requestId: 'r1', status: 'needs-answer', question }];
  const { result } = await f.speak({ question, requestId: 'r1' });
  assert.equal(f.controller.getState().wakeInterruptReady, true); assert.equal(f.audio.length, 0);
  f.wake(); assert.equal(f.controller.getState().wakeInterruptReady, false); f.finish(); await until(() => f.sent.length);
  assert.deepEqual(f.sent[0], { text: 'choose the second option', origin: 'voice', replyToRequestId: 'r1', questionId: 'q1' });
  pending.resolve(pcm()); assert.equal((await result).status, 'cancelled'); assert.equal(f.controller.getState().phase, 'listening');
});

for (const action of ['disabled', 'muted', 'orchestrator-off']) test(`wake cannot start a command when ${action}`, async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); await f.activate(); const { result } = await f.speak(); const packet = f.capture();
  assert.equal(f.controller.getState().wakeInterruptReady, true);
  if (action === 'disabled') f.settings.handsFreeEnabled = false;
  if (action === 'muted') await f.controller.setListening(false);
  if (action === 'orchestrator-off') f.relay.enabled = false;
  assert.equal(f.controller.getState().wakeInterruptReady, false);
  f.classify(packet, { wake: true, speech: true }); assert.notEqual(f.controller.getState().phase, 'recording');
  assert.equal(f.sent.length, 0); assert.equal(f.uploads.length, 0);
  f.controller.cancelSpeech(); await result;
});

test('obsolete completion cannot block or fail a fresh wake recording', async t => {
  const oldAnalysis = deferred();
  const f = fixture({ analyze: input => f.analyses.length === 1 ? oldAnalysis.promise : Promise.resolve({ ...input, probability: .99, complete: true }) });
  t.after(() => f.controller.dispose()); await f.activate();
  const frame = (speech = false) => f.classify(f.capture(), { speech });
  f.wake(); frame(true); frame(); frame(); assert.equal(f.analyses.length, 1);
  f.controller.cancelSpeech(); const { result } = await f.speak(); f.wake(); await result;
  frame(true); frame(); frame(); assert.equal(f.analyses.length, 2);
  const id = f.controller.getState().recordingId; oldAnalysis.reject(Error('obsolete completion failed')); await tick();
  assert.equal(f.controller.getState().recordingId, id); assert.equal(f.controller.getState().handsFreeStatus, 'ready');
  for (let n = 0; n < 10; n++) frame(); await until(() => f.sent.length);
  assert.equal(f.sent.length, 1);
});
