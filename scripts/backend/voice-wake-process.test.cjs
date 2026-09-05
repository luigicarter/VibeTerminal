const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createWakeProcess } = require('../../backend/voiceWakeProcess.cjs');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('hidden native helper starts, decodes silence outside the caller, and exits on disposal', async () => {
  let detections = 0, errors = 0;
  const helper = await createWakeProcess({ modelPath: path.resolve(__dirname, '../../vendor/voice'), onDetected: () => detections++, onError: () => errors++ });
  const pid = helper.getState().pid; assert.ok(pid && pid !== process.pid);
  for (let i = 0; i < 4; i++) helper.accept(new Float32Array(1600));
  const deadline = Date.now() + 3000;
  while (helper.getState().inFlight && Date.now() < deadline) await wait(20);
  assert.equal(helper.getState().inFlight, false); assert.equal(helper.getState().queuedFrames, 0);
  assert.equal(detections, 0); assert.equal(errors, 0); helper.dispose();
  let alive = true;
  const exitDeadline = Date.now() + 2500;
  while (alive && Date.now() < exitDeadline) { await wait(30); try { process.kill(pid, 0); } catch { alive = false; } }
  assert.equal(alive, false, 'Owned wake helper must exit after mute/dispose');
});
test('helper backpressure bounds queued frames and rejects stale detection after reset', async () => {
  let child, options, detected = 0;
  const messages = [];
  const startup = createWakeProcess({ modelPath: 'fixture', onDetected: () => detected++, fork: (_file, _args, passed) => {
    options = passed; child = new EventEmitter(); child.connected = true; child.pid = 123; child.exitCode = null;
    child.send = (message, callback) => { messages.push(message); callback?.(); if (message.type === 'dispose') { child.exitCode = 0; child.connected = false; child.emit('exit', 0); } };
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
    queueMicrotask(() => child.emit('message', { type: 'ready' })); return child;
  } });
  const helper = await startup;
  assert.equal(options.windowsHide, true); assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
  for (let i = 0; i < 100; i++) helper.accept(new Float32Array(1600));
  assert.ok(helper.getState().queuedFrames <= 4); assert.equal(messages.filter(m => m.type === 'frames').length, 1);
  assert.equal(messages.filter(m => m.type === 'reset').length, 0, 'Overload resets must coalesce behind the one in-flight frame');
  const first = messages.find(m => m.type === 'frames'); helper.reset(); child.emit('message', { type: 'result', id: first.id, generation: first.generation, found: true });
  assert.equal(detected, 0); helper.dispose();
});
test('mute cancels native helper startup and cannot reactivate voice later', async () => {
  const voice = createVoiceController({ orchestrator: { getState: () => ({ enabled: true }) }, getKey: () => 'fixture', modelPath: path.resolve(__dirname, '../../vendor/voice') });
  const startup = voice.setListening(true); await wait(5); await voice.setListening(false); await startup;
  assert.equal(voice.getState().listening, false); assert.equal(voice.getState().phase, 'off'); voice.dispose();
});
