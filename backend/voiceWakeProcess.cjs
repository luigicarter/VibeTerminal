'use strict';
const path = require('node:path');
const { fork } = require('node:child_process');
function createWakeProcess({ modelPath, onDetected = () => {}, onError = () => {}, startupTimeoutMs = 15000, fork: spawn = fork } = {}) {
  let child, ready = false, disposed = false, generation = 0, sequence = 0, inFlight = null, pendingReset = false, queue = [], killTimer;
  let resolveReady, rejectReady;
  const started = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let startupTimer;
  const send = message => {
    if (disposed || !child?.connected) return false;
    child.send(message, error => { if (error) fail(); }); return true;
  };
  function next() {
    if (!ready || disposed || inFlight) return;
    if (pendingReset) { pendingReset = false; send({ type: 'reset' }); }
    if (!queue.length) return;
    const samples = queue.shift(); inFlight = { id: ++sequence, generation };
    send({ type: 'frames', ...inFlight, samples });
  }
  function fail() {
    if (disposed) return;
    const error = new Error('Local wake inference failed. Talk now is still available.');
    if (!ready) rejectReady(error); else onError(error.message);
    dispose();
  }
  function reset() { generation++; queue = []; pendingReset = true; next(); }
  function dispose() {
    if (disposed) return;
    clearTimeout(startupTimer); queue = []; inFlight = null;
    if (!ready) rejectReady(new Error('Wake startup cancelled.'));
    if (child?.connected) child.send({ type: 'dispose' }, () => {});
    disposed = true;
    // A stuck native decode cannot keep the app or microphone alive.
    if (child && child.exitCode == null) { killTimer = setTimeout(() => child.kill(), 500); killTimer.unref?.(); }
  }
  const api = {
    accept(samples) {
      if (disposed || !ready) return false;
      if (!samples || samples.length < 1 || samples.length > 8192) return false;
      if (queue.length >= 4) reset(); // Drop overload across a decoder reset, never grow an IPC backlog.
      queue.push(Float32Array.from(samples)); next(); return false;
    },
    reset, dispose,
    getState: () => ({ ready: ready && !disposed, disposed, queuedFrames: queue.length, inFlight: !!inFlight, pid: child?.pid }),
  };
  try {
    const helperPath = path.join(__dirname, 'voiceWakeHost.cjs').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    child = spawn(helperPath, [], {
      execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
    });
    child.on('error', fail);
    child.on('exit', () => { clearTimeout(killTimer); if (!disposed) fail(); });
    child.on('message', message => {
      if (disposed) return;
      if (message?.type === 'ready') { ready = true; clearTimeout(startupTimer); resolveReady(api); next(); }
      else if (message?.type === 'error') fail();
      else if (message?.type === 'result' && message.id === inFlight?.id) {
        inFlight = null;
        if (message.generation === generation && message.found) onDetected();
        next();
      }
    });
    startupTimer = setTimeout(fail, startupTimeoutMs); startupTimer.unref?.();
    send({ type: 'init', modelPath });
  } catch { fail(); }
  // Cancellation can dispose a helper while its model is still initializing.
  started.dispose = dispose;
  return started;
}
module.exports = { createWakeProcess };
