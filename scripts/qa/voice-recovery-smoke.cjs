'use strict';
// Offline native helper/controller recovery regression. Uses an existing synthetic
// wake fixture; never opens a microphone or calls a provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { createVoiceInferenceService } = require('../../backend/voiceInferenceService.cjs');
const root = path.resolve(__dirname, '../..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { assert.ok(Date.now() < deadline, `Timed out: ${description}`); await wait(10); }
}
function readWake() {
  const file = path.join(root, 'output/voice-handsfree/wake.wav');
  assert.ok(fs.existsSync(file), 'Missing synthetic wake.wav; run smoke:voice:native to create the fixture first.');
  const wav = fs.readFileSync(file); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  let data, validFormat = false;
  for (let at = 12; at + 8 <= wav.length;) {
    const size = wav.readUInt32LE(at + 4), tag = wav.toString('ascii', at, at + 4); assert.ok(at + 8 + size <= wav.length);
    if (tag === 'fmt ') { assert.ok(size >= 16); assert.equal(wav.readUInt16LE(at + 8), 1); assert.equal(wav.readUInt16LE(at + 10), 1); assert.equal(wav.readUInt32LE(at + 12), 16000); assert.equal(wav.readUInt16LE(at + 22), 16); validFormat = true; }
    if (tag === 'data') data = wav.subarray(at + 8, at + 8 + size);
    at += 8 + size + size % 2;
  }
  assert.ok(validFormat && data?.length && data.length % 2 === 0, 'Expected nonempty mono PCM16 16kHz fixture');
  return Float32Array.from({ length: data.length / 2 }, (_, i) => data.readInt16LE(i * 2) / 32768);
}
async function main() {
  const wakeAudio = readWake(), children = [], classifications = [], diagnostics = [], states = [], uploads = [], dispatches = [];
  const captureToken = 'offline-native-recovery'; let position = 0, activations = 0;
  const controller = createVoiceController({
    modelPath: path.join(root, 'vendor/voice'), getKey: () => 'offline-test-key', getSettings: () => ({ handsFreeEnabled: true }),
    emit: state => states.push(state),
    orchestrator: { getState: () => ({ enabled: true, requests: [] }), recordDiagnostic: event => diagnostics.push(event), send: async input => { dispatches.push(input); return { ok: true }; }, dispatch: async input => { dispatches.push(input); return { ok: true }; } },
    fetch: async (...args) => { uploads.push(args[0]); throw Error('Unexpected provider request in offline recovery smoke'); },
    inferenceFactory: options => {
      const activation = ++activations;
      return createVoiceInferenceService({ ...options,
        onFrame: event => { classifications.push({ activation, ...event }); options.onFrame(event); },
        fork: (...args) => {
          const child = fork(...args), entry = { child, activation, helper: path.basename(args[0]), ready: false, exited: false, frames: [] }; children.push(entry);
          child.on('message', message => { if (message?.type === 'ready') entry.ready = true; });
          child.once('exit', () => { entry.exited = true; });
          const send = child.send.bind(child);
          child.send = (message, ...rest) => { if (message?.type === 'frame') entry.frames.push(message); return send(message, ...rest); };
          return child;
        },
      });
    },
  });
  function feed(samples) {
    const start = position; position += samples.length;
    const result = controller.frames({ samples, sampleRate: 16000, captureToken, sampleStart: start });
    assert.notEqual(result?.ok, false, `Frame refused: ${JSON.stringify(result)}`);
    return position;
  }
  async function acknowledged(samples) {
    const end = feed(samples);
    await until(() => classifications.some(frame => frame.sampleEnd === end), `classification ending at ${end}`);
  }
  async function recognizeWake() {
    for (let i = 0; i < 25; i++) await acknowledged(new Float32Array(320));
    const parts = [wakeAudio, new Float32Array(16000)];
    for (const part of parts) {
      for (let at = 0; at < part.length; at += 320) {
        await acknowledged(part.subarray(at, at + 320));
        if (controller.getState().recordingSource === 'wake') return;
      }
    }
    assert.fail('Native wake phrase was not recognized');
  }
  try {
    controller.configure({ captureToken }); await controller.setListening(true);
    await until(() => controller.getState().handsFreeStatus === 'ready', 'initial keyword readiness');
    assert.equal(activations, 1);
    for (let i = 0; i < 26; i++) feed(new Float32Array(320));
    await until(() => classifications.length === 26, 'all 26 synchronous burst classifications');
    assert.deepEqual(classifications.map(frame => frame.sampleEnd), Array.from({ length: 26 }, (_, i) => (i + 1) * 320));
    assert.equal(controller.getState().handsFreeStatus, 'ready');
    assert.equal(diagnostics.filter(event => event.event === 'voice_error' && event.stage === 'hands-free').length, 0);
    const initialKeyword = children.find(entry => entry.helper === 'voiceKeywordHost.cjs');
    const initialCompletion = children.find(entry => entry.helper === 'voiceTurnHost.cjs');
    await until(() => initialCompletion.ready, 'initial completion readiness');
    const stateBoundary = states.length; initialCompletion.child.kill();
    await until(() => initialCompletion.exited, 'completion helper termination');
    assert.equal(controller.getState().handsFreeStatus, 'ready'); assert.equal(initialKeyword.exited, false);
    await recognizeWake();
    assert.equal(activations, 1, 'completion failure must not recreate keyword activation');
    assert.ok(states.slice(stateBoundary).every(state => state.handsFreeStatus === 'ready'), 'completion failure disrupted keyword availability');
    assert.equal(controller.getState().phase, 'recording');
    const firstRecording = controller.getState().recordingId, oldRequest = initialKeyword.frames.at(-1);
    const restartStarted = Date.now(); initialKeyword.child.kill();
    await until(() => controller.getState().handsFreeStatus === 'recovering', 'keyword failure recovery state');
    assert.equal(controller.getState().phase, 'listening'); assert.equal(controller.getState().recordingId, undefined);
    assert.equal(uploads.length, 0); assert.equal(dispatches.length, 0);
    await until(() => activations === 2 && controller.getState().handsFreeStatus === 'ready', 'automatic keyword restart');
    const recoveryMs = Date.now() - restartStarted;
    assert.equal(controller.getState().listening, true);
    const beforeStale = classifications.length;
    initialKeyword.child.emit('message', { type: 'frame', id: oldRequest.id, result: { wake: { keyword: 'HEY_LINA' }, speech: true } });
    initialKeyword.child.emit('error', Error('obsolete helper error'));
    assert.equal(classifications.length, beforeStale); assert.equal(controller.getState().phase, 'listening'); assert.equal(controller.getState().handsFreeStatus, 'ready');
    await recognizeWake();
    assert.equal(controller.getState().phase, 'recording'); assert.equal(controller.getState().recordingSource, 'wake');
    assert.notEqual(controller.getState().recordingId, firstRecording);
    assert.equal(uploads.length, 0); assert.equal(dispatches.length, 0);
    assert.equal(diagnostics.filter(event => event.event === 'voice_recording' && event.reason === 'inference-recovery' && event.stage === 'cancel').length, 1);
    const wakeEvents = classifications.filter(frame => frame.wake); assert.equal(wakeEvents.length, 2);
    console.log(JSON.stringify({ test: 'native-voice-recovery', burstClassifications: 26, nativeWakes: wakeEvents.length, keywordActivations: activations, recoveryMs, unchangedCaptureToken: captureToken, finalSamplePosition: position, uploads: uploads.length, dispatches: dispatches.length }));
  } finally {
    controller.dispose();
    for (const entry of children) if (!entry.exited) entry.child.kill();
    await until(() => children.every(entry => entry.exited), 'all owned helpers exit', 5000);
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
