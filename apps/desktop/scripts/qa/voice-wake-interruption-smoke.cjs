'use strict';
// Real local keyword/VAD/turn models with synthetic fixtures and mocked cloud audio.
// No physical microphone, audible playback, live provider, or terminal actions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { createVoiceInferenceService } = require('../../backend/voiceInferenceService.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp', 'voice-wake-interruption', `${Date.now()}-${process.pid}`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const silence = ms => new Float32Array(ms * 16);
function samples(name) {
  const file = path.join(root, 'output/voice-handsfree', `${name}.wav`);
  assert(fs.existsSync(file), `Missing ${name}.wav; run npm run smoke:voice:native first.`);
  const wav = fs.readFileSync(file);
  for (let at = 12; at + 8 <= wav.length;) {
    const size = wav.readUInt32LE(at + 4);
    if (wav.toString('ascii', at, at + 4) === 'data') return Float32Array.from({ length: size / 2 }, (_, i) => wav.readInt16LE(at + 8 + i * 2) / 32768);
    at += 8 + size + size % 2;
  }
  throw Error('Missing WAV samples.');
}
function concat(...parts) {
  const result = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
async function until(check, label) {
  const end = Date.now() + 15000;
  while (!check()) { assert(Date.now() < end, `Timed out: ${label}`); await wait(20); }
}
async function run(mode, audio, commandEnd) {
  let position = 0, aborted = false, firstAudio = false;
  const sent = [], wakes = [], cancellations = [], uploads = [], diagnostics = [];
  const controller = createVoiceController({
    modelPath: path.join(root, 'vendor/voice'), getKey: () => 'offline-fixture',
    getSettings: () => ({ handsFreeEnabled: true }),
    orchestrator: { getState: () => ({ enabled: true }),
      recordDiagnostic: event => { if (event.event === 'voice_recording') diagnostics.push({ ...event, atMs: position / 16 }); },
      send: async input => { sent.push(input); return { ok: true }; } },
    inferenceFactory: options => createVoiceInferenceService({ ...options, onFrame: frame => {
      if (frame.wake) wakes.push({ sampleMs: frame.sampleEnd / 16, phase: controller.getState().phase });
      options.onFrame(frame);
    } }),
    onAudio: chunk => {
      if (chunk.cancelled) cancellations.push({ replyId: chunk.replyId, atMs: position / 16 });
      else if (chunk.data?.length) { firstAudio = true; controller.configure({ playbackStarted: chunk.replyId }); }
    },
    fetch: async (url, init) => {
      if (url.endsWith('/transcriptions')) {
        uploads.push({ atMs: position / 16, samples: (Buffer.from(JSON.parse(init.body).input_audio.data, 'base64').length - 44) / 2 });
        return new Response(JSON.stringify({ text: 'Hey Lina, open the project and run the tests' }));
      }
      assert(url.endsWith('/speech'), 'All cloud calls must be mocked here.');
      if (mode === 'preparation') return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => { aborted = true; reject(init.signal.reason); }, { once: true });
      });
      return new Response(new ReadableStream({ start(stream) {
        stream.enqueue(Buffer.alloc(4800));
        init.signal.addEventListener('abort', () => { aborted = true; stream.error(init.signal.reason); }, { once: true });
      } }), { headers: { 'content-type': 'audio/pcm;rate=24000;channels=1' } });
    },
  });
  let speaking;
  try {
    controller.configure({ captureToken: mode });
    await controller.setListening(true); await controller.configure({ refreshHandsFree: true });
    assert.equal(controller.getState().handsFreeStatus, 'ready');
    speaking = controller.speak({ origin: 'voice', requestId: `old-${mode}`, text: 'The agent reports the parser fix is complete. All seven checks passed.' });
    await until(() => controller.getState().phase === 'speaking' && (mode === 'preparation' || firstAudio), 'active speech');
    for (let at = 0; at < audio.length; at += 320) {
      const part = audio.subarray(at, at + 320); position = at + part.length;
      controller.frames({ samples: part, sampleRate: 16000, captureToken: mode, sampleStart: at });
      await wait(20);
    }
    await until(() => sent.length, 'new command after interruption');
    const previous = await speaking;
    assert.equal(previous.status, 'cancelled');
    assert.equal(wakes.length, 1); assert.equal(wakes[0].phase, 'speaking');
    assert(aborted, 'Wake must abort the old speech request.');
    assert.equal(cancellations.length, 1);
    assert.equal(uploads.length, 1); assert(uploads[0].atMs >= commandEnd / 16, 'Do not upload before the command ends.');
    assert.equal(sent.length, 1); assert.equal(sent[0].text, 'open the project and run the tests');
    const report = { mode, wakes, cancellations, uploads, firstAudio, aborted, previousStatus: previous.status,
      sentText: sent[0].text, phase: controller.getState().phase, diagnostics };
    console.log(JSON.stringify(report)); return report;
  } finally { controller.dispose(); await speaking?.catch(() => {}); }
}
(async () => {
  const wake = samples('wake'), command = samples('complete'), prefix = silence(400), gap = silence(400);
  const audio = concat(prefix, wake, gap, command, silence(4500));
  const commandEnd = prefix.length + wake.length + gap.length + command.length;
  const report = { physicalMicrophoneVerified: false, audiblePlaybackVerified: false, liveProviderVerified: false, cases: [] };
  fs.mkdirSync(output, { recursive: true });
  for (const mode of ['preparation', 'playback']) report.cases.push(await run(mode, audio, commandEnd));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${path.join(output, 'report.json')}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
