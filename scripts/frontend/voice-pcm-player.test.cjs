'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../frontend/voice/pcmPlayer.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const tick = () => new Promise(setImmediate);
function fixture() {
  const f = { timers: new Map(), scheduled: [], started: [], done: [], errors: [], serial: 0 };
  class Context {
    currentTime = 0; destination = {};
    constructor() { f.context = this; }
    async resume() { if (f.failResume) throw Error('Output disconnected'); }
    async close() {}
    createBuffer(channels, length, rate) { return { length, duration: length / rate, channels: Array(channels), copyToChannel(samples, channel) { this.channels[channel] = [...samples]; } }; }
    createBufferSource() { const source = { connect() {}, disconnect() {}, stop() { this.stopped = true; }, start(at) { f.scheduled.push({ source, at }); } }; return source; }
  }
  const exports = {};
  vm.runInNewContext(source, { exports, AudioContext: Context, setTimeout: (fn, ms) => { const id = ++f.serial; f.timers.set(id, { fn, ms }); return id; }, clearTimeout: id => f.timers.delete(id), Float32Array, Map, Set });
  f.player = new exports.PcmPlayer(id => f.done.push(id), (message, id) => f.errors.push({ message, id }), id => f.started.push(id));
  f.advance = ms => { f.context.currentTime += ms / 1000; for (const [id, timer] of [...f.timers]) { if (timer.ms <= ms) { f.timers.delete(id); timer.fn(); } else timer.ms -= ms; } };
  f.chunk = (sequence, patch = {}) => ({ replyId: 'r', sequence, data: Array(4800).fill(0), sampleRate: 24000, channels: 1, format: 's16le', ...patch });
  return f;
}

test('first scheduled PCM output acknowledges once before EOF and done waits for the last buffer', async () => {
  const f = fixture(); f.player.push(f.chunk(0)); await tick();
  assert.equal(f.scheduled.length, 1); assert.deepEqual(f.started, []); assert.deepEqual(f.done, []);
  f.advance(35); assert.deepEqual(f.started, ['r']); assert.deepEqual(f.done, []);
  f.player.push(f.chunk(1, { data: Array(48000).fill(0) })); await tick();
  f.player.push(f.chunk(2, { data: [], done: true })); await tick();
  assert.equal(f.scheduled[1].at, 0.135); assert.deepEqual(f.started, ['r']);
  f.advance(10000); assert.deepEqual(f.done, [], 'wall time alone cannot finish suspended audio');
  f.scheduled[0].source.onended(); f.advance(100); assert.deepEqual(f.done, []);
  f.scheduled[1].source.onended(); f.advance(79); assert.deepEqual(f.done, []);
  f.advance(1); assert.deepEqual(f.done, ['r']); f.player.dispose();
});

test('stereo chunks preserve channel order and late cancelled replies cannot acknowledge or play', async () => {
  const f = fixture();
  f.player.push(f.chunk(0, { channels: 2, data: [0, 128, 255, 127, 0, 0, 0, 64] })); await tick();
  assert.deepEqual(f.scheduled[0].source.buffer.channels.map(values => [...values]), [[-1, 0], [32767 / 32768, 0.5]]);
  f.player.push(f.chunk(1, { data: [], cancelled: true })); f.advance(1000);
  assert.deepEqual(f.started, []); assert.deepEqual(f.done, []); assert.equal(f.scheduled[0].source.stopped, true);
  f.player.push(f.chunk(0)); await tick(); assert.equal(f.scheduled.length, 1); f.player.dispose();
});

test('renderer playback errors identify their reply and retire its queued audio', async () => {
  const f = fixture(); f.failResume = true;
  f.player.push(f.chunk(0)); await tick(); assert.equal(f.errors.length, 1); assert.equal(f.errors[0].id, 'r');
  f.failResume = false; f.player.push(f.chunk(1)); await tick(); assert.equal(f.scheduled.length, 0);
  f.player.push(f.chunk(0, { replyId: 'next', data: [1] })); await tick(); assert.equal(f.errors.at(-1).id, 'next');
  f.player.dispose();
});
