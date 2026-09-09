'use strict';
// Offline real-model/controller regression. Synthetic WAVs are not microphone accuracy evidence.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { createVoiceInferenceService } = require('../../backend/voiceInferenceService.cjs');
const root = path.resolve(__dirname, '../..');
const silence = ms => new Float32Array(ms * 16);
const concat = (...parts) => { const result = new Float32Array(parts.reduce((n, x) => n + x.length, 0)); let at = 0; for (const part of parts) { result.set(part, at); at += part.length; } return result; };
function read(name) {
  const wav = fs.readFileSync(path.join(root, 'output/voice-handsfree', `${name}.wav`));
  for (let at = 12; at + 8 <= wav.length;) { const size = wav.readUInt32LE(at + 4); if (wav.toString('ascii', at, at + 4) === 'data') return Float32Array.from({ length: size / 2 }, (_, i) => wav.readInt16LE(at + 8 + i * 2) / 32768); at += 8 + size + size % 2; }
  throw Error('Missing WAV data');
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(name, audio, commandStart, commandEnd) {
  let position = 0; const uploads = [], sent = [], events = [], wakes = [], speech = [], predictions = [];
  const controller = createVoiceController({ modelPath: path.join(root, 'vendor/voice'), getKey: () => 'offline-key', getSettings: () => ({ handsFreeEnabled: true }),
    orchestrator: { getState: () => ({ enabled: true }), recordDiagnostic: event => { if (event.event === 'voice_recording') events.push({ ...event, atMs: position / 16 }); }, send: async input => { sent.push(input.text); return { ok: true }; } },
    inferenceFactory: options => createVoiceInferenceService({ ...options, onFrame: frame => { if (frame.wake) wakes.push(frame.sampleEnd / 16); if (frame.speech) speech.push(frame.sampleEnd / 16); options.onFrame(frame); }, onDiagnostic: event => { if (event.type === 'completion') predictions.push({ atMs: position / 16, ...event }); options.onDiagnostic(event); } }),
    fetch: async (url, init) => { assert.ok(url.endsWith('/transcriptions')); uploads.push({ atMs: position / 16, wavMs: (Buffer.from(JSON.parse(init.body).input_audio.data, 'base64').length - 44) / 32 }); return { ok: true, json: async () => ({ text: commandStart != null && position >= commandStart ? 'Hey Lina, open the project and run the tests' : 'Hey Lina' }) }; }
  });
  try {
    controller.configure({ captureToken: name }); await controller.setListening(true); await controller.configure({ refreshHandsFree: true }); assert.equal(controller.getState().handsFreeStatus, 'ready');
    for (let at = 0; at < audio.length; at += 320) { const samples = audio.subarray(at, at + 320); position = at + samples.length; controller.frames({ samples, sampleRate: 16000, captureToken: name, sampleStart: at }); await wait(20); }
    await wait(200);
    const report = { name, wakes, commandStartMs: commandStart == null ? null : commandStart / 16, commandEndMs: commandEnd == null ? null : commandEnd / 16, uploads, sent: sent.length, events, predictions, lastSpeechMs: speech.at(-1), phase: controller.getState().phase, handsFreeStatus: controller.getState().handsFreeStatus };
    console.log(JSON.stringify(report));
    assert.equal(wakes.length, 1); assert.equal(uploads.length, 1);
    if (commandEnd != null) { assert.ok(uploads[0].atMs >= commandEnd / 16, 'uploaded before command ended'); assert.ok(uploads[0].atMs <= commandEnd / 16 + 3500, 'completion exceeded 3.5 seconds'); assert.equal(sent.length, 1); }
    else assert.equal(sent.length, 0);
    return report;
  } finally { controller.dispose(); }
}
(async () => {
  const wake = read('wake'), command = read('complete'), prefix = silence(300);
  const scenarios = [
    ['delayed-command', concat(prefix, wake, silence(2000), command, silence(4000)), prefix.length + wake.length + 32000, prefix.length + wake.length + 32000 + command.length],
    ['mid-command-pause', concat(prefix, wake, command.subarray(0, Math.floor(command.length / 2)), silence(600), command.subarray(Math.floor(command.length / 2)), silence(4000)), prefix.length + wake.length, prefix.length + wake.length + command.length + 9600],
    ['wake-only', concat(prefix, wake, silence(7500)), null, null],
  ];
  let failed = false;
  for (const scenario of scenarios) { try { await run(...scenario); } catch (error) { failed = true; console.error(`${scenario[0]}: ${error.stack}`); } }
  if (failed) process.exitCode = 1;
})();
