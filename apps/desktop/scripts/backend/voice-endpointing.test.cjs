'use strict';
// Endpointing and transcription overlap: how long the recording waits after the
// last word, when the audio so far is sent ahead of that decision, and what the
// transcription request is told about this workspace's names.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { createDiagnostics } = require('../../backend/orchestratorDiagnostics.cjs');
const { STT_PROMPT_MAX_CHARS } = require('../../shared/voiceConfig.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 400; i++) { if (predicate()) return; await tick(); } assert.fail('Condition did not settle'); }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

// The microphone is a frame feed: each call appends audio at the current capture
// position and hands the detector the classification the helper process would
// have produced for it.
function fixture(options = {}) {
  const settings = { handsFreeEnabled: true, ...options.settings }, relayState = { enabled: true, requests: [] };
  const sent = [], uploads = [], packets = [], analyses = [], diagnostics = [];
  let callbacks, controller, position = 0, token = 1;
  const service = { start: async () => {}, dispose() {}, feed: packet => packets.push(packet),
    analyze: async input => { analyses.push(input); return options.analyze ? options.analyze(input) : { probability: .99, complete: true, ...input, samples: undefined }; } };
  controller = createVoiceController({ getSettings: () => settings, getKey: () => 'test-key', ...(options.getVocabulary && { getVocabulary: options.getVocabulary }),
    inferenceFactory: value => { callbacks = value; return service; },
    orchestrator: { recordDiagnostic: event => { diagnostics.push(event); options.record?.(event); }, getState: () => relayState, prefetch: () => ({ ok: true }), recordSpeechUsage: () => {},
      enqueue: input => { sent.push(input); return { ok: true, requestId: `request-${sent.length}` }; } },
    fetch: async (url, init) => {
      assert.ok(url.endsWith('/transcriptions'), 'only transcription requests are expected');
      const call = { body: JSON.parse(init.body), atMs: position / 16, aborted: false, samples: 0 };
      call.samples = (Buffer.from(call.body.input_audio.data, 'base64').length - 44) / 2;
      uploads.push(call);
      init.signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
      const cancelled = new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(abortError()), { once: true }));
      const payload = await Promise.race([Promise.resolve(options.transcribe ? options.transcribe(call, uploads.length) : { text: options.text ?? 'Hey Lina, show my agents' }), cancelled]);
      if (Number.isInteger(payload?.status)) return { ok: false, status: payload.status, json: async () => payload.body ?? { error: { message: 'Unrecognized request argument supplied: prompt' } } };
      return { ok: true, json: async () => payload };
    } });
  const f = { controller, settings, relayState, sent, uploads, packets, analyses, diagnostics, get callbacks() { return callbacks; },
    atMs: () => position / 16,
    async activate() { controller.configure({ captureToken: token }); await controller.setListening(true); await controller.configure({ refreshHandsFree: true }); },
    capture(ms = 100, value = 0) { const length = ms * 16; const result = controller.frames({ samples: Array(length).fill(value), sampleRate: 16000, captureToken: token, sampleStart: position }); position += length; return result; },
    classify(packet, speech = false, wake = false) { callbacks.onFrame({ ...packet, samples: undefined, sampleEnd: packet.sampleStart + packet.samples.length, speech, ...(wake ? { wake: { keyword: 'HEY LINA', startSample: packet.sampleStart, lastTokenSample: packet.sampleStart + packet.samples.length } } : {}) }); },
    frame(ms = 100, speech = false, wake = false) { while (ms > 0) { const duration = Math.min(ms, 100); f.capture(duration, speech ? .001 : 0); f.classify(packets.at(-1), speech, wake); ms -= duration; } },
    finish: () => diagnostics.filter(event => event.event === 'voice_recording' && event.stage === 'finish').at(-1),
    stt: () => diagnostics.filter(event => event.stage === 'stt_complete').at(-1),
  };
  return f;
}
// A command long enough to be a sentence, ending with the last spoken frame.
async function speak(f, voicedMs = 500) { f.frame(100, true, true); f.frame(voicedMs, true); f.frame(200); await tick(); }

test('a confident complete sentence ends after 600 ms of trailing silence', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); await f.activate();
  await speak(f);
  assert.equal(f.analyses.length, 1);
  f.frame(399); assert.equal(f.uploads.length, 0, 'nothing is sent before the short pause completes');
  f.frame(1); await until(() => f.sent.length);
  assert.equal(f.sent[0].text, 'show my agents');
  assert.equal(f.finish().reason, 'semantic'); assert.equal(f.finish().pauseMs, 600); assert.equal(f.finish().turnConfidence, .99);
  assert.equal(f.uploads.length, 1, 'the short pause outruns the early request, so the recording is sent once');
  assert.equal(f.stt().sttEarly, false); assert.equal(f.stt().sttReused, false);
});

test('a complete sentence below the confidence threshold keeps the 1,200 ms pause and reuses its early transcript', async t => {
  const f = fixture({ analyze: async input => ({ ...input, probability: .7, complete: true }) });
  t.after(() => f.controller.dispose()); await f.activate();
  await speak(f);
  f.frame(599); assert.equal(f.uploads.length, 0, 'the early request waits for 800ms of silence');
  f.frame(1); await tick();
  assert.equal(f.uploads.length, 1, 'the audio so far goes out at 800ms');
  assert.equal(f.sent.length, 0, 'the recording is still open, so nothing has been relayed');
  f.frame(399); assert.equal(f.sent.length, 0);
  f.frame(1); await until(() => f.sent.length);
  assert.equal(f.uploads.length, 1, 'nothing was appended, so the early transcript is used rather than a second request');
  assert.equal(f.sent[0].text, 'show my agents');
  assert.equal(f.finish().reason, 'semantic'); assert.equal(f.finish().pauseMs, 1200); assert.equal(f.finish().turnConfidence, .7);
  assert.equal(f.stt().sttEarly, true); assert.equal(f.stt().sttReused, true);
});

// The turn becomes confident once the speaker has actually finished, so the
// resumed sentence ends on the short pause and earns no second early request.
const resumed = () => { let call = 0; return async input => ({ ...input, probability: ++call === 1 ? .7 : .99, complete: true }); };

test('a word spoken after the early request aborts it and the whole recording is transcribed', async t => {
  const held = deferred();
  const f = fixture({ analyze: resumed(), transcribe: (call, index) => index === 1 ? held.promise : { text: 'show my agents and stop' } });
  t.after(() => f.controller.dispose()); await f.activate();
  await speak(f);
  f.frame(600); await tick(); assert.equal(f.uploads.length, 1);
  f.frame(100, true); await tick();
  assert.equal(f.uploads[0].aborted, true, 'the in-flight early request is cancelled by the resumed word');
  assert.equal(f.controller.getState().phase, 'recording'); assert.equal(f.controller.getState().error, null);
  f.frame(200); await tick(); f.frame(400); await until(() => f.sent.length);
  assert.equal(f.uploads.length, 2); assert.equal(f.uploads[1].aborted, false);
  assert.equal(f.sent[0].text, 'show my agents and stop');
  assert.ok(f.uploads[1].samples > f.uploads[0].samples, 'the second request carries the resumed speech');
  assert.equal(f.stt().sttEarly, false, 'the aborted request is not the one this turn was transcribed by');
  assert.equal(f.controller.getState().error, null, 'an abandoned early request never surfaces as an error');
  assert.equal(f.diagnostics.some(event => event.event === 'voice_error'), false);
});

test('an early transcript that arrived before speech resumed is discarded', async t => {
  const f = fixture({ analyze: resumed(), transcribe: (call, index) => ({ text: index === 1 ? 'show my agents' : 'show my agents and stop' }) });
  t.after(() => f.controller.dispose()); await f.activate();
  await speak(f);
  f.frame(600); await tick(); await tick();
  assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0].aborted, false, 'this early request completed before the speaker went on');
  f.frame(100, true); f.frame(200); await tick(); f.frame(400); await until(() => f.sent.length);
  assert.equal(f.uploads.length, 2); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, 'show my agents and stop', 'the completed early result is dropped once more was said');
  assert.equal(f.stt().sttEarly, false); assert.equal(f.stt().sttReused, false);
});

test('an incomplete turn and a tap-length turn never take the fast paths', async t => {
  const incomplete = fixture({ analyze: async input => ({ ...input, probability: .2, complete: false }) });
  t.after(() => incomplete.controller.dispose()); await incomplete.activate();
  await speak(incomplete);
  incomplete.frame(1000); assert.equal(incomplete.uploads.length, 0, 'an incomplete turn is never transcribed early');
  incomplete.frame(1800); await until(() => incomplete.sent.length);
  assert.equal(incomplete.finish().reason, 'silence-fallback'); assert.equal(incomplete.finish().pauseMs, 1200);
  assert.equal(incomplete.finish().turnConfidence, undefined);

  // 100ms of live speech is a tap, not a sentence: it keeps the long pause even
  // when the model is sure, and is never spent on an early request.
  const tap = fixture(); t.after(() => tap.controller.dispose()); await tap.activate();
  tap.frame(100, true, true); tap.frame(100, true); tap.frame(200); await tick();
  tap.frame(999); assert.equal(tap.uploads.length, 0);
  tap.frame(1); await until(() => tap.sent.length);
  assert.equal(tap.finish().pauseMs, 1200); assert.equal(tap.uploads.length, 1);
  assert.equal(tap.stt().sttEarly, false);
});

test('push-to-talk release still sends immediately and abandons an early request', async t => {
  const held = deferred();
  const f = fixture({ analyze: async input => ({ ...input, probability: .7, complete: true }),
    transcribe: (call, index) => index === 1 ? held.promise : { text: 'show my agents' } });
  t.after(() => f.controller.dispose()); await f.activate();
  await speak(f);
  f.frame(600); await tick(); assert.equal(f.uploads.length, 1);
  f.controller.configure({ pushToTalk: 'start', holdId: 1 });
  assert.equal(f.uploads[0].aborted, true, 'taking the turn by hand abandons the early request');
  f.capture(300, .1);
  f.controller.configure({ pushToTalk: 'stop', holdId: 1 });
  await until(() => f.sent.length);
  assert.equal(f.uploads.length, 2); assert.equal(f.sent[0].text, 'show my agents');
  assert.equal(f.finish().reason, 'manual');
});

test('the transcription prompt lists product, launcher and project names within its cap', async t => {
  const projects = ['vibeTerminal', 'Aurora Ledger', 'x'.repeat(80), 'Northwind Payments Console', 'vibeTerminal', 'Ledger\nWithControl Characters'];
  const f = fixture({ getVocabulary: () => projects }); t.after(() => f.controller.dispose()); await f.activate();
  await speak(f); f.frame(600); await until(() => f.sent.length);
  const prompt = f.uploads[0].body.prompt;
  assert.ok(prompt.length <= STT_PROMPT_MAX_CHARS, `prompt is ${prompt.length} characters`);
  for (const name of ['Lina', 'Lina Terminal', 'Claude Code', 'Open Claude Code', 'Codex', 'Open Codex', 'Codex Web', 'Gemini', 'Cursor', 'Grok', 'Kimi', 'Qwen']) assert.ok(prompt.includes(name), name);
  assert.ok(prompt.startsWith('Lina, Lina Terminal, Claude Code'), 'the names a command routes on come first');
  assert.ok(prompt.includes('vibeTerminal') && prompt.includes('Aurora Ledger'), 'registered projects follow the fixed names');
  assert.equal(prompt.split('vibeTerminal').length - 1, 1, 'a repeated project name is listed once');
  assert.ok(prompt.includes('x'.repeat(40)) && !prompt.includes('x'.repeat(41)), 'each name is bounded');
  assert.ok(!prompt.includes('Northwind'), 'names that no longer fit the cap are dropped');
  assert.doesNotMatch(prompt, /[\x00-\x1f\x7f]/);
  assert.equal(f.stt().sttPrompt, true);
  // A vocabulary that throws, or is not a list of names, cannot fail a turn.
  const broken = fixture({ getVocabulary: () => { throw new Error('inventory unavailable'); } });
  t.after(() => broken.controller.dispose()); await broken.activate();
  await speak(broken); broken.frame(600); await until(() => broken.sent.length);
  assert.ok(broken.uploads[0].body.prompt.startsWith('Lina, Lina Terminal, Claude Code'));
});

test('an endpoint that refuses the prompt field is retried once without it and never asked again', async t => {
  const f = fixture({ transcribe: call => call.body.prompt ? { status: 400 } : { text: 'Hey Lina, show my agents' } });
  t.after(() => f.controller.dispose()); await f.activate();
  await speak(f); f.frame(600); await until(() => f.sent.length);
  assert.deepEqual(f.uploads.map(call => Boolean(call.body.prompt)), [true, false], 'the refusal costs one silent retry');
  assert.equal(f.sent[0].text, 'show my agents'); assert.equal(f.controller.getState().error, null);
  assert.equal(f.stt().sttPrompt, false);
  await speak(f); f.frame(600); await until(() => f.sent.length === 2);
  assert.deepEqual(f.uploads.map(call => Boolean(call.body.prompt)), [true, false, false], 'the field stays off for the rest of the session');
  assert.equal(f.diagnostics.some(event => event.event === 'voice_error'), false);
});

test('the endpointing and transcription fields survive the on-disk diagnostics sanitizer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-voice-endpointing-'));
  const logger = createDiagnostics({ userDataPath: root });
  const filename = path.join(root, 'logs', 'orchestrator-errors.jsonl');
  t.after(async () => { await logger.flush(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const record = event => logger.record(event);
  const unsure = fixture({ record, analyze: async input => ({ ...input, probability: .7, complete: true }) });
  t.after(() => unsure.controller.dispose()); await unsure.activate();
  await speak(unsure); unsure.frame(1000); await until(() => unsure.sent.length);
  const confident = fixture({ record }); t.after(() => confident.controller.dispose()); await confident.activate();
  await speak(confident); confident.frame(400); await until(() => confident.sent.length);
  await logger.flush();
  const rows = fs.readFileSync(filename, 'utf8').trim().split('\n').map(JSON.parse);
  const finishes = rows.filter(row => row.event === 'voice_recording' && row.stage === 'finish');
  assert.deepEqual(finishes.map(row => [row.pauseMs, row.turnConfidence]), [[1200, .7], [600, .99]]);
  const stt = rows.filter(row => row.stage === 'stt_complete');
  assert.deepEqual(stt.map(row => [row.sttEarly, row.sttReused, row.sttPrompt]), [[true, true, true], [false, false, true]]);
  // The fields are operational only: no transcript, audio or prompt text.
  assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /show my agents|input_audio|Claude Code/);
});

test('measured end of speech to relay latency, confident pause versus the 1,200 ms constant', async t => {
  // The transcription round trip these numbers are built on. It is the one cost
  // the endpointing change cannot remove, only start earlier.
  const STT_MS = 1100;
  async function measure(probability) {
    const f = fixture({ analyze: async input => ({ ...input, probability, complete: true }) });
    t.after(() => f.controller.dispose()); await f.activate();
    f.frame(100, true, true); f.frame(500, true);
    const speechEnd = f.atMs();
    for (let step = 0; step < 400 && !f.sent.length; step++) { f.frame(10); await tick(); }
    assert.equal(f.sent.length, 1, `probability ${probability} never reached the relay`);
    const finishedAt = f.finish().silenceMs, requestedAt = f.uploads[0].atMs - speechEnd;
    // Transcription that started during the pause has already run for the rest of it.
    return { pauseMs: finishedAt, requestedAt, latencyMs: finishedAt + Math.max(0, STT_MS - (finishedAt - requestedAt)) };
  }
  const confident = await measure(.99), unsure = await measure(.7);
  const before = { pauseMs: 1200, requestedAt: 1200, latencyMs: 1200 + STT_MS };
  console.log(JSON.stringify({ sttMs: STT_MS, before, confident, unsure }));
  assert.equal(confident.pauseMs, 600); assert.equal(unsure.pauseMs, 1200);
  assert.equal(confident.requestedAt, 600, 'a confident turn is sent as it ends');
  assert.equal(unsure.requestedAt, 800, 'an unsure turn is transcribed from 800ms while the pause runs');
  assert.equal(before.latencyMs - confident.latencyMs, 600);
  assert.equal(before.latencyMs - unsure.latencyMs, 400);
});
