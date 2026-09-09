'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const { createCompletionAudio } = require('../../backend/voiceCompletionAudio.cjs');
const tick = () => new Promise(setImmediate);
const idle = { phase: 'listening', listening: true, muted: false, ready: true, captureToken: 7, handsFreeStatus: 'ready' };
const recording = (recordingId, recordingSource = 'ptt') => ({ ...idle, phase: 'recording', recordingId, recordingSource });
function fixture(t) {
  const f = { scheduled: [], contexts: [], closed: 0 };
  class Context {
    currentTime = 0; destination = {};
    constructor() { f.contexts.push(this); }
    async resume() { if (f.failResume) throw Error('Output unavailable'); if (f.waitForResume) await f.waitForResume; }
    async close() { f.closed++; }
    createBuffer(channels, length, rate) { return { length, duration: length / rate, sampleRate: rate, copyToChannel(samples) { this.samples = samples; } }; }
    createBufferSource() { const source = { connect() {}, disconnect() {}, stop() { this.stopped = true; }, start() { f.scheduled.push(this); } }; return source; }
  }
  const load = file => {
    const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../frontend/voice', file + '.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    vm.runInNewContext(source, { exports, AudioContext: Context, setTimeout, clearTimeout, Float32Array, require: name => { assert.equal(name, './pcmPlayer'); return load('pcmPlayer'); } });
    return exports;
  };
  f.cue = new (load('listeningCue').ListeningCue)();
  t.after(() => f.cue.dispose());
  return f;
}

test('push-to-talk and wake starts each play once; repeated updates and manual adoption stay quiet', async t => {
  const f = fixture(t);
  f.cue.update(idle); await tick(); assert.equal(f.contexts.length, 0, 'Standby is not prompt capture');
  f.cue.update(recording(1)); await tick(); assert.equal(f.scheduled.length, 1);
  f.cue.update({ ...recording(1), finishHint: true }); await tick(); assert.equal(f.scheduled.length, 1);
  f.cue.update(idle); assert.equal(f.scheduled[0].stopped, true);
  f.cue.update(recording(2, 'wake')); await tick(); assert.equal(f.scheduled.length, 2);
  f.cue.update(recording(2)); f.cue.update(recording(2, 'wake')); await tick(); assert.equal(f.scheduled.length, 2);
  f.cue.update(recording(3)); await tick(); assert.equal(f.scheduled.length, 3, 'A new recording still cues if snapshots skip idle');
});

test('an answer window cues only when detection is ready and does not cue again on answer capture', async t => {
  const f = fixture(t);
  f.cue.update({ ...idle, phase: 'speaking' });
  f.cue.update({ ...idle, phase: 'awaiting-answer', handsFreeStatus: 'loading' }); await tick(); assert.equal(f.scheduled.length, 0);
  f.cue.update({ ...idle, phase: 'awaiting-answer' }); await tick(); assert.equal(f.scheduled.length, 1);
  f.cue.update(recording(1, 'answer')); f.cue.update(recording(1));
  f.cue.update({ ...idle, phase: 'awaiting-answer' }); await tick(); assert.equal(f.scheduled.length, 1, 'Short answer hold handback stays quiet');
  f.cue.update({ ...idle, phase: 'speaking' }); assert.equal(f.scheduled[0].stopped, true);
});

test('startup snapshot, standby, mute, capture recovery and task processing do not produce a listening cue', async t => {
  const f = fixture(t);
  f.cue.update(recording(1), true); f.cue.update(recording(1));
  for (const patch of [{ phase: 'listening' }, { phase: 'off', listening: false }, { muted: true }, { captureRecovering: true }, { phase: 'transcribing' }, { phase: 'thinking' }, { phase: 'error' }]) f.cue.update({ ...recording(2), ...patch });
  await tick(); assert.equal(f.scheduled.length, 0);
});

for (const reason of ['mute', 'cancel', 'capture-change', 'dispose']) test(`${reason} fences a cue waiting for audio output to resume`, async t => {
  const f = fixture(t); let resume;
  f.waitForResume = new Promise(resolve => { resume = resolve; });
  f.cue.update(recording(1)); await tick(); assert.equal(f.contexts.length, 1);
  if (reason === 'dispose') f.cue.dispose();
  else f.cue.update(reason === 'mute' ? { ...recording(1), muted: true } : reason === 'cancel' ? idle : { ...recording(1), captureToken: 8 });
  resume(); await tick(); assert.equal(f.scheduled.length, 0);
});

test('listening notes are short, quiet, rising and different from the completion bell', async t => {
  const f = fixture(t); f.cue.update(recording(1)); await tick();
  const { buffer } = f.scheduled[0];
  assert(buffer.duration < 0.25); assert.equal(buffer.sampleRate, 24000);
  assert(Math.max(...buffer.samples.map(Math.abs)) <= 0.071);
  const crossings = (start, end) => {
    let count = 0;
    for (let i = start + 1; i < end; i++) if (buffer.samples[i - 1] < 0 && buffer.samples[i] >= 0) count++;
    return count;
  };
  assert(crossings(2160, 3960) > crossings(0, 1800), 'Second note is higher');
  assert(buffer.samples.slice(1800, 2160).every(sample => sample === 0), 'Notes have a brief separating gap');
  const done = createCompletionAudio(24000, 1);
  assert.notEqual(buffer.duration, done.durationMs / 1000);
});

test('unavailable output does not fail capture and a later recording can retry', async t => {
  const f = fixture(t); f.failResume = true;
  f.cue.update(recording(1)); await tick(); assert.equal(f.scheduled.length, 0);
  f.failResume = false; f.cue.update(idle); f.cue.update(recording(2)); await tick();
  assert.equal(f.scheduled.length, 1); assert.equal(f.contexts.length, 1, 'Reuse the cue audio context');
  f.cue.dispose(); assert.equal(f.scheduled[0].stopped, true); assert.equal(f.closed, 1);
});
