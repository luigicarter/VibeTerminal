'use strict';
// Exercise the shipped helpers with the shipped Electron executable, no microphone
// or cloud request. Model accuracy is covered separately by the native fixture run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const appDirectory = path.resolve(process.argv[2] || path.join(root, 'release/win-unpacked'));
const executable = path.join(appDirectory, 'vibeTerminal.exe');
const resources = path.join(appDirectory, 'resources');
const backend = path.join(resources, 'app.asar.unpacked/backend');
const { createVoiceInferenceService } = require(path.join(backend, 'voiceInferenceService.cjs'));
const { loadVoiceModels } = require(path.join(backend, 'voiceModels.cjs'));
const modelPath = path.join(resources, 'voice');
const report = { executable, models: loadVoiceModels(modelPath).manifest.files.length, physicalMicrophoneVerified: false, liveProviderVerified: false };
let service, frameResolve, frameReject;
async function main() {
  assert(fs.existsSync(executable));
  const errors = [];
  service = createVoiceInferenceService({ modelPath,
    fork: (file, args, options) => fork(file, args, { ...options, execPath: executable }),
    onFrame: frame => frameResolve?.(frame),
    onError: error => { errors.push(error.message); frameReject?.(error); },
  });
  const started = performance.now(); await service.start(); report.startupMs = performance.now() - started;
  const frame = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Packaged streaming helper timed out.')), 2000);
    frameResolve = value => { clearTimeout(timer); resolve(value); };
    frameReject = error => { clearTimeout(timer); reject(error); };
    service.feed({ samples: new Float32Array(320), sampleStart: 0, captureToken: 1, streamId: 1, mode: 'wake' });
  });
  assert.equal(frame.speech, false); assert.equal(frame.sampleEnd, 320);
  report.frame = frame;
  const result = await service.analyze({ samples: new Float32Array(128000), captureToken: 1, turnId: 2, speechRevision: 3 });
  assert.equal(result.captureToken, 1); assert.equal(result.turnId, 2); assert.equal(result.speechRevision, 3);
  assert(Number.isFinite(result.probability)); assert.deepEqual(errors, []);
  report.completion = result; report.passed = true;
}
main().catch(error => { report.passed = false; report.error = error.stack; process.exitCode = 1; }).finally(() => {
  service?.dispose();
  const output = path.join(root, 'output/voice-handsfree'); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'packaged-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
});
