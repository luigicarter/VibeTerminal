'use strict';
// Real native inference, offline synthetic speech. This is not a microphone/accuracy benchmark.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, fork } = require('node:child_process');
const os = require('node:os');
const { loadVoiceModels } = require('../../backend/voiceModels.cjs');
const { createKeywordDetector } = require('../../backend/voiceKeywordModel.cjs');
const { createTurnDetector } = require('../../backend/voiceTurnModel.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'output/voice-handsfree');
const silence = seconds => new Float32Array(Math.round(seconds * 16000));
function concat(...arrays) { const result = new Float32Array(arrays.reduce((n, x) => n + x.length, 0)); let offset = 0; for (const array of arrays) { result.set(array, offset); offset += array.length; } return result; }
function readWav(file) {
  const wav = fs.readFileSync(file); assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  let data;
  for (let at = 12; at + 8 <= wav.length;) {
    const tag = wav.toString('ascii', at, at + 4), size = wav.readUInt32LE(at + 4);
    if (tag === 'fmt ') { assert.equal(wav.readUInt16LE(at + 8), 1); assert.equal(wav.readUInt16LE(at + 10), 1); assert.equal(wav.readUInt32LE(at + 12), 16000); assert.equal(wav.readUInt16LE(at + 22), 16); }
    if (tag === 'data') data = wav.subarray(at + 8, at + 8 + size);
    at += 8 + size + size % 2;
  }
  assert.ok(data); return Float32Array.from({ length: data.length / 2 }, (_, i) => data.readInt16LE(i * 2) / 32768);
}
function isolatedTurn(modelPath) {
  const child = fork(__filename, ['--turn-helper', modelPath], { windowsHide: true, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let sequence = 0, ended = false; const pending = new Map();
  child.on('message', message => { const item = pending.get(message.id); if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(message.error)) : item.resolve(message.result); } });
  const fail = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.on('exit', code => { ended = true; fail(new Error(`Turn smoke helper exited ${code}`)); });
  child.on('error', fail);
  return {
    predict(samples) { return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); child.kill(); reject(new Error('Turn smoke helper timeout')); }, 15000); pending.set(id, { resolve, reject, timer }); child.send({ id, samples }); }); },
    dispose() { return new Promise(resolve => {
      if (ended) { resolve(); return; }
      const timer = setTimeout(() => child.kill(), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({ dispose: true }); else child.kill();
    }); },
  };
}
async function main() {
  assert.equal(process.platform, 'win32', 'Synthetic fixture generation requires Windows System.Speech');
  fs.mkdirSync(output, { recursive: true });
  const texts = {
    wake: 'Hey Lina.', immediate: 'Hey Lina open the project and run the tests.',
    prefix: 'This is some ordinary conversation before the command.',
    negative: 'Open the project and run the tests. Save the file. Have a very nice day.',
    similar: 'Hey Mike. A high five. Stay alive. The lively environment.',
    complete: 'Open the project and run the tests.', incomplete: 'Open the project and then',
    long: 'First open the project and inspect the current files. Then check the package settings, look at the existing test scripts, and finally run the tests.',
    yes: 'Yes.', no: 'No.',
  };
  const quote = x => `'${String(x).replaceAll("'", "''")}'`;
  const commands = Object.entries(texts).map(([name, text]) => `$s.SetOutputToWaveFile(${quote(path.join(output, `${name}.wav`))},$f);$s.Speak(${quote(text)});$s.SetOutputToNull();`).join('\n');
  const synthesis = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);${commands}$s.Dispose();`], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(synthesis.status, 0, synthesis.stderr);
  const clips = Object.fromEntries(Object.keys(texts).map(name => [name, readWav(path.join(output, `${name}.wav`))]));
  const models = loadVoiceModels(path.join(root, 'vendor/voice'));
  const keyword = createKeywordDetector({ paths: models });
  const turn = isolatedTurn(models.turn.model);
  const report = { source: 'Windows System.Speech synthetic fixtures; no real microphone; development CPU, not older-PC benchmark', platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, keyword: [], turn: [], memory: {} };
  const failures = [];
  function run(name, audio, packet = 320, mode = 'wake') {
    keyword.reset(); let wakes = [], speechPackets = 0, totalMs = 0, maxPacketMs = 0;
    for (let start = 0; start < audio.length; start += packet) {
      const result = keyword.process({ samples: audio.subarray(start, start + packet), sampleStart: start, captureToken: name, streamId: 1, mode });
      if (result.wake) wakes.push(result.wake);
      if (result.speech) speechPackets++;
      totalMs += result.processingMs; maxPacketMs = Math.max(maxPacketMs, result.processingMs);
    }
    const row = { name, audioSeconds: audio.length / 16000, packet, wakes, speechPackets, totalMs, maxPacketMs, realTimeFactor: totalMs / (audio.length / 16) };
    report.keyword.push(row); return row;
  }
  try {
    run('warmup', silence(1)); await turn.predict(silence(1));
    for (const [name, audio, packet] of [
      ['wake-alone', concat(silence(0.3), clips.wake, silence(1)), 320],
      ['immediate-command', concat(silence(0.3), clips.immediate, silence(1)), 320],
      ['delayed-command', concat(clips.wake, silence(2), clips.complete, silence(1)), 320],
      ['context-prefix', concat(clips.prefix, silence(0.37), clips.wake, silence(1)), 320],
      ['long-silence-prefix', concat(silence(12), clips.wake, silence(1)), 320],
      ['packet-boundary-137', concat(silence(0.013), clips.immediate, silence(1)), 137],
      ['packet-boundary-511', concat(silence(0.031), clips.immediate, silence(1)), 511],
      ['repeated-wakes', concat(clips.wake, silence(1), clips.wake, silence(1)), 320],
    ]) { const row = run(name, audio, packet); if (row.wakes.length < (name === 'repeated-wakes' ? 2 : 1)) failures.push(`Missed ${name}`); }
    for (const [name, audio] of [['negative', clips.negative], ['similar-words', clips.similar], ['silence', silence(3)]]) {
      if (run(name, concat(audio, silence(1))).wakes.length !== 0) failures.push(`False wake ${name}`);
    }
    for (const name of ['yes', 'no', 'complete']) assert.ok(run(`vad-${name}`, concat(clips[name], silence(0.5)), 320, 'vad').speechPackets > 0, `VAD missed ${name}`);
    assert.equal(run('vad-silence', silence(1), 320, 'vad').speechPackets, 0);
    for (const name of ['complete', 'incomplete', 'yes', 'no', 'long']) {
      const prediction = await turn.predict(concat(clips[name], silence(0.2)));
      report.turn.push({ name, audioSeconds: clips[name].length / 16000, ...prediction });
      assert.ok(Number.isFinite(prediction.probability));
      assert.equal(prediction.complete, name !== 'incomplete', `Unexpected semantic completion: ${name}`);
    }
    assert.ok(clips.long.length > 128000, 'Long command fixture must exceed eight seconds');
    const long = concat(clips.long, silence(0.2));
    const full = await turn.predict(long), last = await turn.predict(long.subarray(long.length - 128000));
    assert.equal(full.probability, last.probability, 'Long command uses exactly latest eight seconds');
    report.memory = process.memoryUsage();
    assert.deepEqual(failures, [], failures.join('; ')); report.passed = true;
  } catch (error) { report.passed = false; report.error = error.message; throw error; }
  finally {
    keyword.dispose(); await turn.dispose();
    fs.writeFileSync(path.join(output, 'native-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ passed: report.passed, error: report.error, cpu: report.cpu, keyword: report.keyword.map(({ name, wakes, realTimeFactor, maxPacketMs }) => ({ name, wakes: wakes.length, realTimeFactor, maxPacketMs })), turn: report.turn, memory: report.memory, evidence: path.join(output, 'native-smoke.json') }, null, 2));
  }
}
if (process.argv[2] === '--turn-helper') {
  const ready = createTurnDetector({ modelPath: process.argv[3] });
  process.on('message', async message => {
    try {
      const detector = await ready;
      if (message.dispose) { await detector.dispose(); process.disconnect(); return; }
      const result = await detector.predict(message.samples); process.send({ id: message.id, result: { ...result, helperRss: process.memoryUsage().rss } });
    } catch (error) { if (message.dispose) process.disconnect(); else process.send({ id: message.id, error: error.message }); }
  });
} else main().catch(error => { console.error(error); process.exitCode = 1; });
