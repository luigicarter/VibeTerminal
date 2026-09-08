'use strict';
// Run voice-native-smoke.cjs first to generate the deterministic base WAVs.
// This is synthetic regression coverage, not a real-microphone accuracy claim.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const sherpa = require('sherpa-onnx-node');
const { createKeywordDetector } = require('../../backend/voiceKeywordModel.cjs');
const { loadVoiceModels } = require('../../backend/voiceModels.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/voice-handsfree');
const silence = s => new Float32Array(Math.round(s * 16000));
function concat(...arrays) { const result = new Float32Array(arrays.reduce((n, a) => n + a.length, 0)); let p = 0; for (const a of arrays) { result.set(a, p); p += a.length; } return result; }
const read = name => sherpa.readWave(path.join(output, `${name}.wav`)).samples;
const quote = text => `'${text.replaceAll("'", "''")}'`;
const gaps = [200, 400, 800, 1200];
const variants = [];
const commands = gaps.map(gap => `$s.SetOutputToWaveFile(${quote(path.join(output, `spaced-${gap}.wav`))},$f);$s.SpeakSsml(${quote(`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">Hey <break time="${gap}ms"/> Vibe.</speak>`)});$s.SetOutputToNull();`);
for (const [voice, label] of [['Microsoft David Desktop', 'david'], ['Microsoft Zira Desktop', 'zira']]) for (const rate of [-2, 0, 2]) {
  for (const [type, text] of Object.entries({ wake: 'Hey Vibe.', immediate: 'Hey Vibe open the project and run the tests.', negative: 'Hey Mike. Hey five. Hey bye. Hey Bob. Stay alive. Have a very nice day.' })) {
    const name = `matrix-${label}-${rate}-${type}`; variants.push({ name, type, voice, rate });
    commands.push(`$s.SelectVoice(${quote(voice)});$s.Rate=${rate};$s.SetOutputToWaveFile(${quote(path.join(output, `${name}.wav`))},$f);$s.Speak(${quote(text)});$s.SetOutputToNull();`);
  }
}
const synth = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);${commands.join('\n')}$s.Dispose();`], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
if (synth.status !== 0) throw new Error(synth.stderr || 'Speech synthesis failed');
const detector = createKeywordDetector({ paths: loadVoiceModels(path.join(root, 'vendor/voice')) });
const report = { source: 'Windows System.Speech synthetic regression fixtures; no microphone or older-PC benchmark', cpu: os.cpus()[0]?.model, positive: [], negative: [], spaced: [], memory: {} };
function run(name, audio, packet = 137) {
  detector.reset(); const wakes = []; let totalMs = 0, maxPacketMs = 0;
  for (let p = 0; p < audio.length; p += packet) {
    const frame = detector.process({ samples: audio.subarray(p, p + packet), sampleStart: p, captureToken: name, streamId: 1, mode: 'wake' });
    if (frame.wake) wakes.push(frame.wake);
    totalMs += frame.processingMs; maxPacketMs = Math.max(maxPacketMs, frame.processingMs);
  }
  return { name, packet, wakes, audioSeconds: audio.length / 16000, totalMs, maxPacketMs, realTimeFactor: totalMs / (audio.length / 16) };
}
function addNoise(audio, amplitude) {
  // Fixed seed and no fixtures from user recordings. Noise includes the silence
  // before/after speech, so normalization is tested against background sound.
  let seed = 42;
  return audio.map(sample => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.max(-1, Math.min(1, sample + (seed / 0x100000000 * 2 - 1) * amplitude)); });
}
try {
  for (const gain of [0.15, 0.5, 1, 1.5]) for (const prefix of ['prefix', 'negative', 'similar']) for (const gap of [0.013, 0.1, 0.2, 0.37, 0.7, 1, 2]) {
    report.positive.push(run(`${prefix}:gap=${gap}:gain=${gain}`, concat(read(prefix), silence(gap), read('wake'), silence(1)).map(x => x * gain)));
  }
  for (const gain of [0.15, 0.5, 1, 1.5]) for (const name of ['prefix', 'negative', 'similar']) report.negative.push(run(`${name}:gain=${gain}`, concat(read(name), silence(1)).map(x => x * gain)));
  for (const variant of variants) for (const gain of [0.02, 0.05, 0.15, 1]) {
    report[variant.type === 'negative' ? 'negative' : 'positive'].push(run(`${variant.name}:gain=${gain}`, concat(silence(0.3), read(variant.name).map(x => x * gain), silence(1)), 320));
  }
  for (const packet of [137, 320, 511]) for (const name of ['matrix-david-2-immediate', 'matrix-zira-0-wake', 'matrix-david-0-negative']) {
    const audio = concat(silence(0.013), read(name).map(x => x * 0.05), silence(1));
    report[name.endsWith('negative') ? 'negative' : 'positive'].push(run(`${name}:quiet-noise:packet=${packet}`, addNoise(audio, 0.0002), packet));
  }
  for (const amplitude of [0.0002, 0.005, 0.05]) report.negative.push(run(`noise-only:${amplitude}`, addNoise(silence(5), amplitude), 320));
  for (const gap of gaps) report.spaced.push(run(`spaced-${gap}ms`, concat(silence(0.3), read(`spaced-${gap}`), silence(1)), 320));
  report.memory = process.memoryUsage();
  report.missed = report.positive.filter(x => !x.wakes.length).map(x => x.name);
  report.falseWakes = report.negative.filter(x => x.wakes.length).map(x => x.name);
  report.spacedMisses = report.spaced.filter(x => !x.wakes.length).map(x => x.name);
  report.passed = report.missed.length === 0 && report.falseWakes.length === 0 && report.spacedMisses.length === 0;
} finally {
  detector.dispose();
  fs.writeFileSync(path.join(output, 'keyword-matrix.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.passed, positives: report.positive.length, negatives: report.negative.length, missed: report.missed, falseWakes: report.falseWakes, spacedMisses: report.spacedMisses, maxPacketMs: Math.max(...report.positive.map(x => x.maxPacketMs)), maxRealTimeFactor: Math.max(...report.positive.map(x => x.realTimeFactor)), memory: report.memory }, null, 2));
if (!report.passed) process.exitCode = 1;
