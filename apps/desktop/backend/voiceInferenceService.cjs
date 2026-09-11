const path = require('node:path');
const { fork } = require('node:child_process');

const namedError = (name, message) => Object.assign(new Error(message), { name });
const MAX_QUEUED_SAMPLES = 32000;
const COMPLETION_RETRY_MS = [1000, 2000, 4000];
function createVoiceInferenceService({ modelPath, onFrame = () => {}, onError = () => {}, onDiagnostic = () => {}, fork: spawn = fork, timers = globalThis } = {}) {
  let generation = 0, keyword = null, completion = null, startup = null, pending = null, ready = false, disposed = false, sequence = 0;
  let queue = [], queuedSamples = 0, current = null, streamIdentity = null, reportedFrames = 0;
  let completionStartupTimer = null, completionRetryTimer = null, completionRetries = 0;
  function clear(timer) { if (timer != null) timers.clearTimeout(timer); }
  function kill(child) { try { child?.kill(); } catch {} }
  function identity(frame) { return JSON.stringify([frame.captureToken, frame.streamId, frame.mode]); }
  function details(error) {
    const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240) : undefined;
    return { name: clean(error?.name), message: clean(error?.message), code: clean(error?.code) };
  }
  function close(error) {
    generation++; ready = false;
    const oldKeyword = keyword, oldCompletion = completion; keyword = null; completion = null;
    if (startup) { clear(startup.timer); startup.reject(error); startup = null; }
    if (pending) { clear(pending.timer); pending.reject(error); pending = null; }
    clear(current?.timer); clear(completionStartupTimer); clear(completionRetryTimer);
    current = null; queue = []; queuedSamples = 0; streamIdentity = null;
    completionStartupTimer = null; completionRetryTimer = null;
    kill(oldKeyword); kill(oldCompletion);
  }
  function failKeyword(message, error, name = 'Error', stage = 'stream') {
    if (!keyword && !startup) return;
    const failure = namedError(name, message);
    close(failure); onDiagnostic({ type: 'error', helper: 'keyword', stage, message, error: details(error || failure) }); onError(failure);
  }
  function failCompletion(message, error, stage = 'completion') {
    if (!completion) return;
    const old = completion; completion = null; clear(completionStartupTimer); completionStartupTimer = null;
    const failure = namedError('CompletionUnavailableError', message);
    if (pending) { const task = pending; pending = null; clear(task.timer); task.reject(failure); }
    kill(old);
    onDiagnostic({ type: 'error', helper: 'completion', stage, message, error: details(error || failure) });
    if (!disposed && keyword && completionRetries < COMPLETION_RETRY_MS.length) {
      const token = generation;
      completionRetryTimer = timers.setTimeout(() => {
        completionRetryTimer = null;
        if (token === generation && !disposed && keyword) startCompletion();
      }, COMPLETION_RETRY_MS[completionRetries++]);
    }
  }
  function send(child, message, helper) {
    const token = generation;
    const failed = error => {
      if (token !== generation || child !== (helper === 'keyword' ? keyword : completion)) return;
      if (helper === 'keyword') failKeyword('Voice helper IPC failed.', error, 'Error', 'ipc');
      else failCompletion('Voice completion IPC failed.', error, 'ipc');
    };
    try { child.send(message, error => { if (error) failed(error); }); }
    catch (error) { failed(error); }
  }
  function spawnHelper(host) {
    const helper = path.join(__dirname, host).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    return spawn(helper, [], { execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  }
  function dispatch() {
    if (!ready || !keyword || current || !queue.length) return;
    const frame = queue.shift(); queuedSamples -= frame.samples.length;
    const token = generation, id = ++sequence;
    current = { ...frame, id, obsolete: false, timer: timers.setTimeout(() => {
      if (token === generation && current?.id === id) failKeyword('Voice audio processing took too long.');
    }, 2000) };
    send(keyword, { type: 'frame', id, frame }, 'keyword');
  }
  function startCompletion() {
    if (disposed || !keyword || completion) return;
    const token = generation;
    try {
      const child = spawnHelper('voiceTurnHost.cjs'); completion = child;
      const live = () => token === generation && completion === child;
      child.on('error', error => { if (live()) failCompletion('Voice completion helper failed.', error, 'process'); });
      child.on('exit', (code, signal) => { if (live()) failCompletion('Voice completion helper exited.', { code: String(code ?? signal ?? '') }, 'process'); });
      child.on('message', message => {
        if (!live()) return;
        if (message?.type === 'error') return failCompletion('Voice completion inference failed.', message.error, message.stage === 'init' ? 'init' : 'completion');
        if (message?.type === 'ready') { child.voiceReady = true; clear(completionStartupTimer); completionStartupTimer = null; }
        else if (message?.type === 'result' && pending?.id === message.id) {
          const task = pending; pending = null; clear(task.timer);
          onDiagnostic({ type: 'completion', helper: 'completion', totalMs: message.result?.totalMs, preprocessingMs: message.result?.preprocessingMs, inferenceMs: message.result?.inferenceMs, probability: message.result?.probability });
          task.resolve({ ...message.result, ...task.identity });
        }
      });
      completionStartupTimer = timers.setTimeout(() => { if (live()) failCompletion('Voice completion model took too long to load.', undefined, 'init'); }, 15000);
      send(child, { type: 'init', modelPath }, 'completion');
    } catch (error) {
      // Keep the same failure/retry path even when fork itself throws.
      completion = { kill() {} }; failCompletion('Voice completion helper could not start.', error, 'init');
    }
  }
  function start() {
    if (disposed) return Promise.reject(namedError('AbortError', 'Voice service is disposed.'));
    if (ready) return Promise.resolve();
    if (startup) return startup.promise;
    const token = ++generation; completionRetries = 0;
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    startup = { promise, resolve, reject, timer: timers.setTimeout(() => { if (token === generation) failKeyword('Voice models took too long to load.', undefined, 'Error', 'init'); }, 15000) };
    try {
      const child = spawnHelper('voiceKeywordHost.cjs'); keyword = child;
      const live = () => token === generation && keyword === child;
      child.on('error', error => { if (live()) failKeyword('Voice helper failed.', error, 'Error', 'process'); });
      child.on('exit', (code, signal) => { if (live()) failKeyword('Voice helper exited.', { code: String(code ?? signal ?? '') }, 'Error', 'process'); });
      child.on('message', message => {
        if (!live()) return;
        if (message?.type === 'error') return failKeyword('Voice inference failed.', message.error, 'Error', message.stage === 'init' ? 'init' : 'stream');
        if (message?.type === 'ready' && startup) {
          const task = startup; startup = null; clear(task.timer); ready = true; task.resolve();
        } else if (message?.type === 'frame' && current?.id === message.id) {
          const frame = current; current = null; clear(frame.timer);
          if (++reportedFrames % 50 === 0) onDiagnostic({ type: 'stream', helper: 'keyword', processingMs: message.result?.processingMs, queuedSamples });
          if (!frame.obsolete) onFrame({ ...message.result, captureToken: frame.captureToken, streamId: frame.streamId, sampleStart: frame.sampleStart, sampleEnd: frame.sampleStart + frame.samples.length });
          dispatch();
        }
      });
      send(child, { type: 'init', modelPath }, 'keyword');
      if (live()) startCompletion();
    } catch (error) { failKeyword('Voice helper could not start.', error, 'Error', 'init'); }
    return promise;
  }
  function feed(frame) {
    if (!ready) return;
    if (!(frame.samples instanceof Float32Array) || !Number.isSafeInteger(frame.sampleStart) || frame.samples.length === 0) return;
    const nextIdentity = identity(frame);
    if (streamIdentity !== nextIdentity) {
      queue = []; queuedSamples = 0; if (current) current.obsolete = true;
      streamIdentity = nextIdentity;
    }
    if (queuedSamples + frame.samples.length > MAX_QUEUED_SAMPLES) {
      if (frame.mode !== 'wake' || queue.some(item => item.mode !== 'wake') || (current && !current.obsolete && current.mode !== 'wake')) {
        return failKeyword('Voice audio stream was interrupted by processing backlog.', undefined, 'VoiceStreamDiscontinuityError');
      }
      // Idle wake audio may be discarded, but never fabricate silence for a VAD
      // recording. A gap resets native keyword state on the next dispatched frame.
      queue = []; queuedSamples = 0; if (current) current.obsolete = true;
      onDiagnostic({ type: 'stream', helper: 'keyword', reason: 'wake-backlog-discarded', queuedSamples: 0 });
    }
    const samples = frame.samples.slice(-MAX_QUEUED_SAMPLES);
    const copy = { ...frame, samples, sampleStart: frame.sampleStart + frame.samples.length - samples.length };
    queue.push(copy); queuedSamples += samples.length; dispatch();
  }
  function analyze(input) {
    if (!ready) return Promise.reject(namedError('AbortError', 'Voice service is not ready.'));
    if (pending) return Promise.reject(namedError('BusyError', 'Voice completion is already running.'));
    if (!completion?.voiceReady) return Promise.reject(namedError('CompletionUnavailableError', 'Voice completion is warming up or unavailable.'));
    return new Promise((resolve, reject) => {
      const id = ++sequence, child = completion, token = generation;
      pending = { id, resolve, reject, identity: { captureToken: input.captureToken, turnId: input.turnId, speechRevision: input.speechRevision }, timer: timers.setTimeout(() => {
        if (token === generation && completion === child && pending?.id === id) failCompletion('Voice completion took too long.');
      }, 1000) };
      send(child, { type: 'analyze', id, samples: input.samples.slice(-128000) }, 'completion');
    });
  }
  return { start, feed, analyze, stop() { close(namedError('AbortError', 'Voice service stopped.')); }, dispose() { disposed = true; close(namedError('AbortError', 'Voice service disposed.')); } };
}
module.exports = { createVoiceInferenceService };
