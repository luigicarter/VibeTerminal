const path = require('node:path');
const { fork } = require('node:child_process');

const namedError = (name, message) => Object.assign(new Error(message), { name });
function createVoiceInferenceService({ modelPath, onFrame = () => {}, onError = () => {}, onDiagnostic = () => {}, fork: spawn = fork, timers = globalThis } = {}) {
  let generation = 0, children = [], startup = null, pending = null, ready = false, disposed = false, sequence = 0;
  const frames = new Map();
  let queuedSamples = 0, reportedFrames = 0;
  function clear(timer) { if (timer != null) timers.clearTimeout(timer); }
  function close(error) {
    generation++; ready = false;
    const old = children; children = [];
    if (startup) { clear(startup.timer); startup.reject(error); startup = null; }
    if (pending) { clear(pending.timer); pending.reject(error); pending = null; }
    for (const frame of frames.values()) clear(frame.timer);
    frames.clear(); queuedSamples = 0;
    for (const child of old) { try { child.kill(); } catch {} }
  }
  function fail(message) {
    if (!children.length && !startup) return;
    const error = new Error(message);
    close(error); onDiagnostic({ type: 'error', message }); onError(error);
  }
  function send(child, message) {
    const token = generation;
    try { child.send(message, error => { if (error && token === generation) fail('Voice helper IPC failed.'); }); }
    catch { if (token === generation) fail('Voice helper IPC failed.'); }
  }
  function start() {
    if (disposed) return Promise.reject(namedError('AbortError', 'Voice service is disposed.'));
    if (ready) return Promise.resolve();
    if (startup) return startup.promise;
    const token = ++generation;
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    startup = { promise, resolve, reject, remaining: 2, timer: timers.setTimeout(() => fail('Voice models took too long to load.'), 15000) };
    try {
      for (const host of ['voiceKeywordHost.cjs', 'voiceTurnHost.cjs']) {
        const helper = path.join(__dirname, host).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
        const child = spawn(helper, [], { execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        children.push(child);
        child.on('error', () => { if (token === generation) fail('Voice helper failed.'); });
        child.on('exit', () => { if (token === generation) fail('Voice helper exited.'); });
        child.on('message', message => {
          if (token !== generation) return;
          if (message?.type === 'error') return fail('Voice inference failed.');
          if (message?.type === 'ready' && startup && !child.voiceReady) {
            child.voiceReady = true;
            if (--startup.remaining === 0) { const task = startup; startup = null; clear(task.timer); ready = true; task.resolve(); }
          } else if (message?.type === 'frame' && child === children[0]) {
            const frame = frames.get(message.id); if (!frame) return;
            clear(frame.timer); frames.delete(message.id); queuedSamples -= frame.samples.length;
            if (++reportedFrames % 50 === 0) onDiagnostic({ type: 'stream', processingMs: message.result?.processingMs, queuedSamples });
            onFrame({ ...message.result, captureToken: frame.captureToken, streamId: frame.streamId, sampleStart: frame.sampleStart, sampleEnd: frame.sampleStart + frame.samples.length });
          } else if (message?.type === 'result' && child === children[1] && pending?.id === message.id) {
            const task = pending; pending = null; clear(task.timer);
            onDiagnostic({ type: 'completion', totalMs: message.result?.totalMs, preprocessingMs: message.result?.preprocessingMs, inferenceMs: message.result?.inferenceMs, probability: message.result?.probability });
            task.resolve({ ...message.result, ...task.identity });
          }
        });
        send(child, { type: 'init', modelPath });
        if (token !== generation) break;
      }
    } catch { fail('Voice helper could not start.'); }
    return promise;
  }
  function feed(frame) {
    if (!ready) return;
    if (!(frame.samples instanceof Float32Array) || !Number.isSafeInteger(frame.sampleStart) || frame.samples.length === 0) return;
    if (queuedSamples + frame.samples.length > 8000) return fail('Voice audio processing fell behind.');
    const id = ++sequence;
    const copy = { ...frame, samples: frame.samples.slice() };
    // A paused microphone cannot grow the backlog, but its last native call can
    // still hang. Bound every outstanding response independently of new audio.
    const token = generation;
    copy.timer = timers.setTimeout(() => { if (token === generation && frames.has(id)) fail('Voice audio processing took too long.'); }, 2000);
    frames.set(id, copy); queuedSamples += copy.samples.length;
    send(children[0], { type: 'frame', id, frame: { ...frame, samples: copy.samples } });
  }
  function analyze(input) {
    if (!ready) return Promise.reject(namedError('AbortError', 'Voice service is not ready.'));
    if (pending) return Promise.reject(namedError('BusyError', 'Voice completion is already running.'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending = { id, resolve, reject, identity: { captureToken: input.captureToken, turnId: input.turnId, speechRevision: input.speechRevision }, timer: timers.setTimeout(() => fail('Voice completion took too long.'), 1000) };
      send(children[1], { type: 'analyze', id, samples: input.samples.slice(-128000) });
    });
  }
  return { start, feed, analyze, stop() { close(namedError('AbortError', 'Voice service stopped.')); }, dispose() { disposed = true; close(namedError('AbortError', 'Voice service disposed.')); } };
}
module.exports = { createVoiceInferenceService };
