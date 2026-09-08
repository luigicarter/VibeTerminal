const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(name, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`frontend/voice/${name}.ts`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, setTimeout, clearTimeout, ...globals });
  return exports;
}
(async () => {
  const messages = []; let Processor;
  const { workletSource } = load('microphone');
  vm.runInNewContext(workletSource, { sampleRate: 48000, AudioWorkletProcessor: class { constructor() { this.port = { postMessage: value => messages.push(value) }; } }, registerProcessor: (_, value) => { Processor = value; } });
  const processor = new Processor();
  for (let i = 0; i < 10; i++) processor.process([[new Float32Array(128).fill(0.3)]]);
  assert.equal(messages.length, 1); assert.equal(messages[0].samples.length, 320); assert.equal(messages[0].sampleStart, 0);
  processor.port.onmessage({ data: { flush: 17 } });
  assert.equal(messages[1].samples.length, 106); assert.equal(messages[1].sampleStart, 320);
  assert.equal(messages[2].flushed, 17); assert.equal(messages[2].sampleEnd, 426);
  for (let i = 0; i < 8; i++) processor.process([[new Float32Array(128).fill(0.3)]]);
  assert.equal(messages[3].sampleStart, 426); assert.equal(messages[3].samples.length, 320);
  processor.port.onmessage({ data: { flush: 18 } });
  assert.equal(messages.at(-1).sampleEnd, 768, 'flush keeps resampler remainder and every complete output sample');
  const order = []; let node;
  const port = { postMessage({ flush }) { this.onmessage({ data: { samples: [0.1, 0.2], sampleStart: 0 } }); this.onmessage({ data: { flushed: flush, sampleEnd: 2 } }); }, close() {} };
  const { VoiceMicrophone } = load('microphone', {
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }) } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, Blob: class {},
    AudioContext: class { audioWorklet = { addModule: async () => {} }; createGain() { return { gain: {}, connect() {} }; } createMediaStreamSource() { return { connect() {} }; } async resume() {} async close() {} },
    AudioWorkletNode: class { constructor() { node = this; this.port = port; } connect() {} disconnect() {} },
  });
  const mic = new VoiceMicrophone(); await mic.start((samples, sampleStart) => order.push({ samples, sampleStart }));
  const end = await mic.flush(); order.push(end);
  assert.equal(order[0].samples.length, 2); assert.equal(order[0].sampleStart, 0); assert.equal(order[1], 2);
  node.port.postMessage = () => {};
  const pending = mic.flush(); mic.stop(); await assert.rejects(pending, /capture changed/);
  await assert.rejects(mic.flush(), /not active/);
  // Startup failures release their own resources, including when a newer start wins.
  const streams = [], contexts = [], modules = [];
  const { VoiceMicrophone: LifecycleMicrophone } = load('microphone', {
    navigator: { mediaDevices: { getUserMedia: async () => {
      const track = { stopped: false, stop() { this.stopped = true; } };
      streams.push(track); return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, Blob: class {},
    AudioContext: class {
      constructor() { contexts.push(this); }
      closed = false;
      audioWorklet = { addModule: () => new Promise((resolve, reject) => modules.push({ resolve, reject })) };
      createGain() { return { gain: {}, connect() {} }; }
      createMediaStreamSource() { return { connect() {} }; }
      async resume() { if (this.failResume) throw Error('resume failed'); }
      async close() { this.closed = true; }
    },
    AudioWorkletNode: class { port = { close() {} }; connect() {} disconnect() {} },
  });
  const lifecycle = new LifecycleMicrophone();
  const failed = lifecycle.start(() => {}); await new Promise(resolve => setImmediate(resolve));
  modules[0].reject(Error('module failed')); await assert.rejects(failed, /module failed/);
  assert.equal(streams[0].stopped, true); assert.equal(contexts[0].closed, true);
  const stale = lifecycle.start(() => {}); await new Promise(resolve => setImmediate(resolve));
  const current = lifecycle.start(() => {}); await new Promise(resolve => setImmediate(resolve));
  modules[1].reject(Error('stale failure')); await assert.rejects(stale, /stale failure/);
  assert.equal(streams[1].stopped, true); assert.equal(contexts[1].closed, true);
  assert.equal(streams[2].stopped, false); assert.equal(contexts[2].closed, false);
  contexts[2].failResume = true; modules[2].resolve();
  await assert.rejects(current, /resume failed/);
  assert.equal(streams[2].stopped, true); assert.equal(contexts[2].closed, true);
  // A delayed permission result must never replace the newer stream.
  const delayedStreams = [];
  const { VoiceMicrophone: PermissionMicrophone } = load('microphone', {
    navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => delayedStreams.push(resolve)) } },
  });
  const permission = new PermissionMicrophone();
  const oldPermission = permission.start(() => {});
  permission.stop(); let stopped = false;
  delayedStreams[0]({ getTracks: () => [{ stop() { stopped = true; } }] });
  await oldPermission; assert.equal(stopped, true);
  // Heartbeat watches delivery, never microphone loudness or flush acknowledgments.
  let clock = 0, timerId = 0; const timers = new Map(), captureNodes = [], captureContexts = [];
  const tick = ms => {
    const end = clock + ms;
    while (true) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      clock = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    clock = end;
  };
  const { VoiceMicrophone: WatchedMicrophone } = load('microphone', {
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }) } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, Blob: class {},
    AudioContext: class {
      constructor() { captureContexts.push(this); }
      state = 'running'; resumes = 0; audioWorklet = { addModule: async () => {} };
      createGain() { return { gain: {}, connect() {} }; } createMediaStreamSource() { return { connect() {} }; }
      resume() { this.resumes++; return this.resumeResult || Promise.resolve(); } async close() {}
    },
    AudioWorkletNode: class { constructor() { captureNodes.push(this); } port = { close() {} }; connect() {} disconnect() {} },
  });
  const watched = new WatchedMicrophone(); let stalls = 0, frames = 0;
  const startWatched = () => watched.start(() => frames++, undefined, undefined, () => stalls++);
  const packet = () => captureNodes.at(-1).port.onmessage({ data: { samples: [0, 0], sampleStart: 0 } });
  await startWatched(); tick(3499); assert.equal(stalls, 0);
  captureNodes.at(-1).port.onmessage({ data: { flushed: 10, sampleEnd: 0 } });
  tick(1); assert.equal(stalls, 1, 'never-delivering graph reports a stall despite flush ACK');
  tick(10000); assert.equal(stalls, 1, 'one report per capture');
  await startWatched();
  for (let i = 0; i < 5; i++) { tick(3000); packet(); }
  assert.equal(stalls, 1, 'silent PCM is healthy delivery'); assert.equal(frames, 5);
  captureContexts.at(-1).state = 'suspended'; tick(3500);
  assert.equal(captureContexts.at(-1).resumes, 2); tick(999); packet(); tick(1);
  assert.equal(stalls, 1, 'PCM after resume cancels recovery deadline');
  captureContexts.at(-1).resumeResult = Promise.reject(Error('resume denied'));
  tick(3500); await Promise.resolve(); tick(1000); assert.equal(stalls, 2, 'resume rejection still has bounded failure');
  await startWatched(); captureContexts.at(-1).state = 'suspended';
  captureContexts.at(-1).resumeResult = new Promise(() => {}); tick(3500); tick(1000);
  assert.equal(stalls, 3, 'hung resume cannot hide a stalled graph');
  await startWatched(); const oldNode = captureNodes.at(-1);
  captureContexts.at(-1).state = 'suspended'; tick(3500); watched.stop(); tick(1000);
  assert.equal(stalls, 3, 'stop cancels pending recovery');
  await startWatched(); const beforeFrames = frames;
  oldNode.port.onmessage({ data: { samples: [0], sampleStart: 0 } });
  assert.equal(frames, beforeFrames, 'stale capture cannot forward PCM or refresh heartbeat');
  tick(3500); assert.equal(stalls, 4); watched.stop(); assert.equal(timers.size, 0);
  // Execute overlay effects to verify delayed startup cannot advertise stale readiness.
  for (const action of ['stall', 'cleanup', 'error']) {
    const patches = [], cleanups = []; let finishStart, reportStall, reportError, stops = 0;
    const api = {
      configure: async patch => { patches.push(patch); }, frames() {},
      onState: () => () => {}, onAudio: () => () => {}, onFlush: () => () => {},
      getState: () => new Promise(() => {}),
    };
    const overlayExports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('frontend/VoiceOverlay.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      exports: overlayExports, window: { vibe: { voice: api } },
      require: name => name === 'react' ? {
        useMemo: fn => fn(), useState: () => [{ listening: true, captureToken: 'capture-test' }, () => {}],
        useEffect: fn => cleanups.push(fn()),
      } : name.endsWith('/microphone') ? { VoiceMicrophone: class {
        stop() { stops++; }
        start(_frame, _device, onError, onStall) { reportError = onError; reportStall = onStall; return new Promise(resolve => { finishStart = resolve; }); }
      } } : { PcmPlayer: class { push() {} dispose() {} } },
    });
    overlayExports.default();
    if (action === 'stall') reportStall('no packets');
    else if (action === 'cleanup') cleanups.at(-1)();
    else reportError(Error('The microphone disconnected.'));
    finishStart(); await Promise.resolve(); await Promise.resolve();
    assert.equal(patches.some(p => p.microphoneReady), false, `${action}: no stale ready`);
    if (action === 'stall') assert.equal(patches.filter(p => p.captureStalled && p.captureToken === 'capture-test').length, 1);
    if (action === 'error') assert.equal(patches.find(p => p.microphoneError).microphoneError, 'The microphone disconnected.');
    assert.ok(stops > 0); cleanups.forEach(fn => fn?.());
  }
  let now = 1000; const calls = [], replies = [];
  const { pressToTalk } = load('pushToTalk', { Date: { now: () => now } });
  const api = { configure: patch => { calls.push(patch); return new Promise(resolve => replies.push(resolve)); } };
  const hold = pressToTalk(api); hold.start(); now += 50; hold.release();
  assert.equal(calls[1].pushToTalk, 'cancel'); assert.equal(calls[0].holdId, calls[1].holdId);
  now += 1; hold.start(); const secondId = calls[2].holdId; assert.notEqual(secondId, calls[0].holdId);
  replies[0]({ ok: false }); await Promise.resolve(); assert.equal(hold.active(), true, 'old failed start cannot cancel newer hold');
  now += 400; hold.release(); assert.equal(calls[3].pushToTalk, 'stop'); assert.equal(calls[3].holdId, secondId);
  hold.release(); assert.equal(calls.length, 4);
  console.log('Voice capture and hold tests passed: resampling, ordered flush, startup failure cleanup, stale capture ownership and gesture identity.');
})().catch(error => { console.error(error); process.exitCode = 1; });
