const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createWakeDetector } = require('../../backend/voiceWake.cjs');
// Synthetic speech only: this test does not access a microphone, speakers, or paid API.
test('native bundled keyword model detects synthetic Hey Vibe and rejects unrelated speech', { skip: process.platform !== 'win32' }, () => {
  const sherpa = require('sherpa-onnx-node');
  const proofPath = path.resolve(__dirname, '../../.tmp/voice'); fs.mkdirSync(proofPath, { recursive: true });
  const positive = path.join(proofPath, 'hey-vibe-test.wav'), negative = path.join(proofPath, 'not-wake-test.wav');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = `Add-Type -AssemblyName System.Speech\n$voiceSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer\n$voiceSynth.SetOutputToWaveFile(${quote(positive)})\n$voiceSynth.Speak('Hey Vibe')\n$voiceSynth.SetOutputToWaveFile(${quote(negative)})\n$voiceSynth.Speak('Please list my terminal windows')\n$voiceSynth.Dispose()`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000 });
  const detector = createWakeDetector(path.resolve(__dirname, '../../vendor/voice'));
  function detects(file) {
    detector.reset(); const audio = sherpa.readWave(file);
    const resampler = new sherpa.LinearResampler(audio.sampleRate, 16000, Math.min(audio.sampleRate, 16000) * 0.45, 6);
    const samples = resampler.resample(audio.samples, true); let detected = false;
    for (let at = 0; at < samples.length; at += 1600) detected = detector.accept(samples.slice(at, at + 1600)) || detected;
    for (let i = 0; i < 10; i++) detected = detector.accept(new Float32Array(1600)) || detected;
    return detected;
  }
  const evidence = { runtime: 'sherpa-onnx-node 1.13.7', model: 'gigaspeech-3.3M-2024-01-01 int8', sampleRate: 16000, keyword: 'Hey Vibe', positive: detects(positive), negative: detects(negative), synthetic: true };
  detector.dispose(); fs.writeFileSync(path.join(proofPath, 'native-proof.json'), JSON.stringify(evidence, null, 2));
  assert.equal(evidence.positive, true); assert.equal(evidence.negative, false);
});
