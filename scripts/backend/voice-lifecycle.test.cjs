'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installOrchestrator } = require('../../backend/orchestratorIntegration.cjs');
const { interpretTestIntent } = require('./orchestrator-test-intent.cjs');
const { createVoiceOverlayWindow } = require('../../backend/voiceOverlayWindow.cjs');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { STT_MODEL, TTS_MODEL, TTS_VOICE } = require('../../shared/voiceConfig.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, description) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  assert.fail(`Did not reach ${description}`);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function windows() {
  class Window extends EventEmitter {
    static instances = [];
    static failLoads = 0;
    static getAllWindows() { return this.instances.filter(window => !window.destroyed); }
    constructor(options = {}) {
      super(); this.options = options; this.visible = false; this.destroyed = false; this.sent = [];
      this.webContents = new EventEmitter();
      this.webContents.send = (channel, payload) => { this.sent.push({ channel, payload }); this.onSend?.(channel, payload); };
      this.webContents.setWindowOpenHandler = handler => { this.windowOpen = handler; };
      this.webContents.session = { setPermissionRequestHandler: handler => { this.permission = handler; } };
      Window.instances.push(this);
    }
    isDestroyed() { return this.destroyed; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    getBounds() { return this.options; }
    setBounds(bounds) { Object.assign(this.options, bounds); }
    loadURL() { return this.loadFile(); }
    loadFile() { return Window.failLoads-- > 0 ? Promise.reject(Error('fixture load failure')) : Promise.resolve(); }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
    close() { let prevented = false; this.emit('close', { preventDefault() { prevented = true; } }); if (!prevented) this.destroy(); }
  }
  const screen = new EventEmitter();
  screen.getCursorScreenPoint = () => ({ x: 50, y: 50 });
  screen.getDisplayMatching = screen.getDisplayNearestPoint = () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
  return { BrowserWindow: Window, screen };
}

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-voice-lifecycle-'));
  const { BrowserWindow, screen } = windows();
  const main = new BrowserWindow();
  const ipcMain = new EventEmitter(), handlers = new Map();
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  main.onSend = (channel, payload) => {
    if (channel === 'orchestrator:ui-action') queueMicrotask(() => ipcMain.emit('orchestrator:ui-result', { sender: main.webContents }, { id: payload.id, result: { ok: true, sessions: [], projectPaths: [] } }));
  };
  const app = new EventEmitter(); app.getPath = () => root; app.isPackaged = false;
  const calls = [], previews = [];
  let controller;
  const integration = installOrchestrator({ interpretIntent: interpretTestIntent,
    app, BrowserWindow, screen, ipcMain, getMainWindow: () => main,
    captureReadyTimeoutMs: options.captureReadyTimeoutMs,
    captureFlushTimeoutMs: options.captureFlushTimeoutMs,
    shell: {}, safeStorage: { isEncryptionAvailable: () => false },
    microphonePermission: options.microphonePermission || { isGranted: () => true, ensure: async () => ({ ok: true }), openSettings: async () => ({ ok: true }) },
    getRuntime: () => ({ listSnapshots: () => [] }), sendPty: () => false, sendFusion: () => false, sendOpenFusion: () => false,
    getTelemetry: () => ({}), getChanges: () => ({}),
    fetch: async url => {
      const endpoint = new URL(url).pathname + new URL(url).search; calls.push(endpoint);
      await options.beforeFetch?.(endpoint);
      if (endpoint.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      const kind = new URL(url).searchParams.get('output_modalities');
      if (endpoint.startsWith('/api/v1/models')) return new Response(JSON.stringify({ data: kind ? [{ id: kind === 'speech' ? TTS_MODEL : STT_MODEL, architecture: { output_modalities: [kind] } }] : [{ id: 'fixture/brain', supported_parameters: ['tools'], architecture: { input_modalities: ['text'] } }] }));
      throw Error(`Unexpected network request: ${endpoint}`);
    },
    voiceFactory: configuration => {
      controller = createVoiceController({ ...configuration, ...options.controllerOptions });
      const configure = controller.configure;
      controller.configure = patch => {
        if (patch.preview) { previews.push(controller.getState()); return { ok: true }; }
        return configure(patch);
      };
      return controller;
    },
  });
  t.after(async () => {
    await integration.dispose();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('vibe-voice-lifecycle-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const invoke = (name, payload = {}, sender = main.webContents) => handlers.get(name)({ sender }, payload);
  assert.equal((await invoke('orchestrator:configure', { apiKey: 'fixture-key', sessionOnly: true, model: 'fixture/brain', sttModel: STT_MODEL, ttsModel: TTS_MODEL, voice: TTS_VOICE })).ok, true);
  const overlay = () => BrowserWindow.instances.find(window => window !== main && !window.destroyed);
  async function renderer() {
    await until(() => overlay(), 'audio window creation');
    return invoke('voice:configure', { rendererReady: true }, overlay().webContents);
  }
  async function capture(patch = { microphoneReady: true }, token) {
    await until(() => controller.getState().listening, 'microphone start request');
    const state = await invoke('voice:get-state');
    return invoke('voice:configure', { ...patch, captureToken: token ?? state.captureToken }, overlay().webContents);
  }
  async function enable() {
    const pending = invoke('orchestrator:enabled', { enabled: true });
    await renderer(); await capture(); return pending;
  }
  return { invoke, renderer, capture, enable, overlay, BrowserWindow, controller, calls, previews, main, ipcMain };
}

test('audio renderer stays hidden and cannot take focus; native close preserves audio', async t => {
  const { BrowserWindow, screen } = windows(); let closed = 0;
  const surface = createVoiceOverlayWindow({ BrowserWindow, screen, onClosed: () => closed++ });
  t.after(() => surface.dispose()); const ready = surface.ensureReady();
  const window = surface.getWindow(), options = window.options;
  assert.equal(options.width, 112); assert.equal(options.height, 112); assert.equal(options.transparent, true);
  assert.equal(options.show, false); assert.equal(options.alwaysOnTop, false); assert.equal(options.focusable, false);
  assert.equal(options.webPreferences.sandbox, true); assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.backgroundThrottling, false);
  surface.markReady(window.webContents); await ready; assert.equal(window.visible, false);
  window.close(); assert.equal(window.visible, false); assert.equal(window.destroyed, false); assert.equal(closed, 0);
  surface.send('voice:audio', { fixture: true }); assert.equal(window.sent.at(-1).channel, 'voice:audio');
  await surface.ensureReady(); assert.equal(surface.getWindow(), window); assert.equal(window.visible, false);
});

test('manual release waits for the audio worklet tail before submitting the WAV', async t => {
  const uploads = [];
  const f = await fixture(t, { controllerOptions: { fetch: async (_url, options) => {
    uploads.push(JSON.parse(options.body)); return new Response(JSON.stringify({ text: '' }));
  } } });
  await f.enable();
  const { captureToken } = await f.invoke('voice:get-state');
  const sender = f.overlay().webContents;
  const feed = (sampleStart, count) => f.ipcMain.emit('voice:frames', { sender }, { captureToken, sampleStart, sampleRate: 16000, samples: Array(count).fill(0.1) });
  await f.invoke('voice:configure', { pushToTalk: 'start', holdId: 'tail-hold' });
  feed(0, 1600); feed(1600, 1600); feed(3200, 1600);
  let flush;
  f.overlay().onSend = (channel, payload) => { if (channel === 'voice:flush') flush = payload; };
  const released = f.invoke('voice:configure', { pushToTalk: 'stop', holdId: 'tail-hold' });
  await until(() => flush, 'worklet flush request');
  assert.equal(uploads.length, 0);
  feed(4800, 17);
  assert.equal((await f.invoke('voice:configure', { captureFlushed: true, flushId: flush.id, captureToken, sampleEnd: 4817 }, sender)).ok, true);
  assert.equal((await released).status, 'sent');
  await until(() => uploads.length, 'WAV upload');
  assert.equal(Buffer.from(uploads[0].input_audio.data, 'base64').length, 44 + 4817 * 2);
});

test('audio positions and flush acknowledgments reject stale or unauthorized capture data', async t => {
  const f = await fixture(t); await f.enable();
  const { captureToken } = await f.invoke('voice:get-state');
  const sender = f.overlay().webContents;
  let accepted = 0;
  const frames = f.controller.frames;
  f.controller.frames = payload => { accepted++; return frames(payload); };
  const packet = { captureToken, sampleStart: 0, sampleRate: 16000, samples: Array(320).fill(0.1) };
  f.ipcMain.emit('voice:frames', { sender }, { ...packet, captureToken: captureToken - 1 });
  f.ipcMain.emit('voice:frames', { sender: f.main.webContents }, packet);
  f.ipcMain.emit('voice:frames', { sender }, { ...packet, sampleStart: -1 });
  assert.equal(accepted, 0);
  f.ipcMain.emit('voice:frames', { sender }, packet);
  f.ipcMain.emit('voice:frames', { sender }, packet);
  assert.equal(accepted, 1, 'duplicate samples are not delivered twice');
  f.ipcMain.emit('voice:frames', { sender }, { ...packet, sampleStart: 640 });
  assert.equal(accepted, 2, 'a forward gap reaches discontinuity handling instead of wedging capture');
  await f.invoke('voice:configure', { pushToTalk: 'start', holdId: 'identity-hold' });
  let flush;
  f.overlay().onSend = (channel, payload) => { if (channel === 'voice:flush') flush = payload; };
  const released = f.invoke('voice:configure', { pushToTalk: 'stop', holdId: 'identity-hold' });
  await until(() => flush, 'flush request');
  const ack = { captureFlushed: true, flushId: flush.id, captureToken, sampleEnd: 960 };
  assert.equal((await f.invoke('voice:configure', ack)).status, 'stale');
  assert.equal((await f.invoke('voice:configure', { ...ack, captureToken: captureToken - 1 }, sender)).status, 'stale');
  await f.invoke('orchestrator:enabled', { enabled: false });
  assert.equal((await released).status, 'cancelled');
  assert.equal((await f.invoke('voice:configure', ack, sender)).status, 'stale');
});

test('flush deadline cancels the held attempt without uploading incomplete audio', async t => {
  let uploaded = false;
  const f = await fixture(t, { captureFlushTimeoutMs: 15, controllerOptions: { fetch: async () => { uploaded = true; throw Error('Unexpected upload'); } } });
  await f.enable();
  await f.invoke('voice:configure', { pushToTalk: 'start', holdId: 'missing-tail' });
  const result = await f.invoke('voice:configure', { pushToTalk: 'stop', holdId: 'missing-tail' });
  assert.equal(result.ok, false); assert.match(result.error, /audio did not finish/);
  assert.equal(uploaded, false); assert.equal(f.controller.getState().phase, 'listening');
});

test('failed indicator load destroys the failed renderer and permits retry', async t => {
  const { BrowserWindow, screen } = windows(); BrowserWindow.failLoads = 1;
  const failures = [];
  const surface = createVoiceOverlayWindow({ BrowserWindow, screen, onFailure: error => failures.push(error) });
  t.after(() => surface.dispose());
  const failed = surface.ensureReady(), first = surface.getWindow();
  await assert.rejects(failed, /Could not load/);
  assert.equal(first.destroyed, true); assert.equal(failures.length, 1);
  const retry = surface.ensureReady(), next = surface.getWindow();
  assert.notEqual(first, next); surface.markReady(next.webContents); await retry;
  assert.equal(next.visible, false);
});

test('activation waits for renderer and physical microphone acknowledgment', async t => {
  const f = await fixture(t); let settled = false;
  const pending = f.invoke('orchestrator:enabled', { enabled: true }).then(result => { settled = true; return result; });
  await until(() => f.overlay(), 'indicator creation'); await tick();
  assert.equal(f.controller.getState().listening, false); assert.equal(settled, false);
  await f.renderer(); await until(() => f.controller.getState().listening, 'microphone request');
  assert.equal(settled, false);
  await f.capture(); assert.equal((await pending).ok, true);
  assert.equal(f.overlay().visible, false);
  assert.equal((await f.invoke('voice:get-state')).indicatorVisible, true);
  await f.invoke('voice:configure', { hideOverlay: true });
  assert.equal((await f.invoke('voice:get-state')).indicatorVisible, false);
  assert.equal(f.controller.getState().listening, true);
  await f.invoke('orchestrator:overlay');
  assert.equal((await f.invoke('voice:get-state')).indicatorVisible, true);
  assert.equal(f.overlay().visible, false);
  f.overlay().close(); assert.equal(f.controller.getState().listening, true);
});

test('first-use consent resolves before any audio window or capture starts', async t => {
  const response = deferred(); let requested = 0;
  const f = await fixture(t, { microphonePermission: { isGranted: () => false, ensure: () => { requested++; return response.promise; } } });
  const pending = f.invoke('orchestrator:enabled', { enabled: true });
  await tick(); assert.equal(requested, 1); assert.equal(f.overlay(), undefined);
  assert.equal(f.controller.getState().listening, false);
  response.resolve({ ok: false, status: 'permission-required', error: 'Not allowed' });
  assert.equal((await pending).ok, false); assert.equal(f.controller.getState().listening, false);
  assert.equal((await f.invoke('orchestrator:get-state')).enabled, false);
});

test('turning off during consent prevents a late allow from starting capture', async t => {
  const response = deferred(); let signal;
  const f = await fixture(t, { microphonePermission: { isGranted: () => true, ensure: options => { signal = options.signal; return response.promise; } } });
  const pending = f.invoke('orchestrator:enabled', { enabled: true }); await tick();
  await f.invoke('orchestrator:enabled', { enabled: false }); assert.equal(signal.aborted, true);
  response.resolve({ ok: true }); assert.equal((await pending).status, 'cancelled');
  assert.equal(f.overlay(), undefined); assert.equal(f.controller.getState().listening, false);
});

test('microphone consent and Windows settings controls accept only the main UI', async t => {
  let requests = 0, opens = 0;
  const f = await fixture(t, { microphonePermission: { isGranted: () => true, ensure: async () => { requests++; return { ok: true }; }, openSettings: async () => { opens++; return { ok: true }; } } });
  assert.equal((await f.invoke('voice:configure', { requestMicrophoneAccess: true })).ok, true);
  assert.equal(requests, 1); assert.equal(f.overlay(), undefined);
  assert.equal((await f.enable()).ok, true);
  assert.equal((await f.invoke('voice:configure', { openMicrophoneSettings: true }, f.overlay().webContents)).ok, false);
  assert.equal(opens, 0);
  assert.equal((await f.invoke('voice:configure', { openMicrophoneSettings: true })).ok, true); assert.equal(opens, 1);
});

test('hidden audio surface refuses media access until app consent is granted', async t => {
  const { BrowserWindow, screen } = windows(); let granted = false;
  const surface = createVoiceOverlayWindow({ BrowserWindow, screen, canCapture: () => granted });
  t.after(() => surface.dispose()); const ready = surface.ensureReady(), window = surface.getWindow();
  surface.markReady(window.webContents); await ready;
  const allowed = (contents, mediaTypes) => { let answer; window.permission(contents, 'media', value => { answer = value; }, { mediaTypes }); return answer; };
  assert.equal(allowed(window.webContents, ['audio']), false);
  granted = true; assert.equal(allowed(window.webContents, ['audio']), true);
  assert.equal(allowed(window.webContents, ['video']), false); assert.equal(allowed({}, ['audio']), false);
});

test('activation ends in listening with push-to-talk available through the IPC surface', async t => {
  const f = await fixture(t);
  const result = await f.enable();
  assert.equal(result.ok, true); assert.equal(result.listening, true); assert.equal(result.voiceReady, true);
  assert.equal(f.controller.getState().listening, true); assert.equal(f.controller.getState().phase, 'listening');
  assert.equal((await f.invoke('voice:configure', { pushToTalk: 'start' })).ok, true);
  assert.equal(f.controller.getState().phase, 'recording');
  assert.equal((await f.invoke('voice:configure', { pushToTalk: 'cancel' })).status, 'cancelled');
  assert.equal(f.controller.getState().phase, 'listening');
  assert.equal((await f.invoke('voice:configure', { pushToTalk: 'sideways' })).ok, false);
});

test('physical capture failure during activation fails activation', async t => {
  const f = await fixture(t);
  const pending = f.invoke('orchestrator:enabled', { enabled: true }); await f.renderer();
  assert.equal((await f.capture({ microphoneError: 'Permission denied' })).ok, false);
  const result = await pending; assert.equal(result.ok, false); assert.match(result.error, /Permission denied/);
  assert.equal(f.controller.getState().listening, false); assert.equal((await f.invoke('orchestrator:get-state')).enabled, false);
});

test('invalid audio configuration stops capture and clears connection readiness', async t => {
  const f = await fixture(t); assert.equal((await f.enable()).ok, true);
  const result = await f.invoke('orchestrator:configure', { sttModel: 'fixture/missing-stt' });
  assert.equal(result.ok, false); assert.match(result.error, /transcription/);
  assert.equal(f.controller.getState().listening, false);
  const state = await f.invoke('orchestrator:get-state'); assert.equal(state.enabled, false); assert.equal(state.ready, false);
});

test('a valid voice settings change restarts capture and keeps the relay listening', async t => {
  const f = await fixture(t);
  assert.equal((await f.enable()).ok, true);
  const previous = (await f.invoke('voice:get-state')).captureToken;
  const pending = f.invoke('orchestrator:configure', { language: 'fr' });
  // The restart reissues the capture token; acknowledge the new one, not the retired one.
  let restarted;
  for (let i = 0; i < 200 && restarted === undefined; i++) {
    const state = await f.invoke('voice:get-state');
    if (state.listening && state.captureToken !== previous) restarted = state.captureToken; else await tick();
  }
  assert.ok(restarted !== undefined, 'Did not reach the restarted capture request');
  assert.equal((await f.invoke('voice:configure', { microphoneReady: true, captureToken: restarted }, f.overlay().webContents)).ok, true);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal((await f.invoke('orchestrator:get-state')).enabled, true);
  assert.equal(f.controller.getState().listening, true); assert.equal(f.controller.getState().phase, 'listening');
  assert.equal(f.controller.getState().muted, false);
  assert.equal((await f.invoke('voice:configure', { microphoneReady: true, captureToken: previous }, f.overlay().webContents)).status, 'stale');
});

test('missing capture acknowledgment after a device change stops the microphone', async t => {
  const f = await fixture(t, { captureReadyTimeoutMs: 150 }); assert.equal((await f.enable()).ok, true);
  const result = await f.invoke('orchestrator:configure', { microphoneId: 'second-device' });
  assert.equal(result.ok, false); assert.match(result.error, /Microphone access did not finish/);
  assert.equal(f.controller.getState().listening, false); assert.equal(f.controller.getState().phase, 'off');
  assert.equal((await f.invoke('orchestrator:get-state')).enabled, false);
});

test('unrelated settings patch preserves pending voice activation', async t => {
  const f = await fixture(t); const pending = f.invoke('orchestrator:enabled', { enabled: true });
  await until(() => f.overlay(), 'renderer wait');
  assert.equal((await f.invoke('orchestrator:configure', { monitoringIntervalSeconds: 45, spendingLimit: 2 })).ok, true);
  await f.renderer(); await f.capture(); assert.equal((await pending).ok, true);
});

test('stale microphone ready and failure tokens cannot finish or stop a newer activation', async t => {
  const f = await fixture(t); assert.equal((await f.enable()).ok, true);
  const previous = (await f.invoke('voice:get-state')).captureToken;
  await f.invoke('orchestrator:enabled', { enabled: false });
  let settled = false;
  const pending = f.invoke('orchestrator:enabled', { enabled: true }).then(result => { settled = true; return result; });
  await f.renderer(); await until(() => f.controller.getState().listening, 'new microphone request');
  assert.equal((await f.capture({ microphoneReady: true }, previous)).status, 'stale');
  assert.equal((await f.capture({ microphoneError: 'Old device failed' }, previous)).status, 'stale');
  await tick(); assert.equal(settled, false); assert.equal(f.controller.getState().listening, true);
  await f.capture(); assert.equal((await pending).ok, true);
});

test('disable during connection validation prevents later reactivation', async t => {
  const gate = deferred(); let reached = false;
  const f = await fixture(t, { beforeFetch: async endpoint => { if (endpoint.endsWith('/key')) { reached = true; await gate.promise; } } });
  const pending = f.invoke('orchestrator:enabled', { enabled: true }); await until(() => reached, 'connection validation');
  assert.equal((await f.invoke('orchestrator:enabled', { enabled: false })).ok, true); gate.resolve();
  assert.equal((await pending).ok, false); assert.equal(f.controller.getState().listening, false);
  assert.equal((await f.invoke('orchestrator:get-state')).enabled, false);
});

test('disable while capture is pending leaves the microphone closed and inactive', async t => {
  const f = await fixture(t);
  const pending = f.invoke('orchestrator:enabled', { enabled: true }); await f.renderer();
  await until(() => f.controller.getState().listening, 'microphone request');
  assert.equal((await f.invoke('orchestrator:enabled', { enabled: false })).ok, true);
  assert.equal((await pending).ok, false);
  assert.equal(f.controller.getState().listening, false); assert.equal(f.overlay().visible, false);
  assert.equal((await f.invoke('voice:configure', { pushToTalk: 'start' })).ok, false);
});

test('hidden preview waits for audio renderer without activating capture', async t => {
  const f = await fixture(t); const pending = f.invoke('voice:configure', { preview: true });
  await until(() => f.overlay(), 'hidden preview window'); assert.equal(f.previews.length, 0);
  assert.equal(f.overlay().visible, false); await f.renderer(); assert.equal((await pending).ok, true);
  assert.equal(f.previews.length, 1); assert.equal(f.previews[0].listening, false);
  assert.equal(f.controller.getState().listening, false); assert.equal(f.overlay().visible, false);
});

test('an audio renderer that never reports ready is replaced by the next attempt', async t => {
  const { BrowserWindow, screen } = windows();
  const surface = createVoiceOverlayWindow({ BrowserWindow, screen, readyTimeoutMs: 20 });
  t.after(() => surface.dispose());
  await assert.rejects(surface.ensureReady(), /Voice audio did not start/);
  const stuck = BrowserWindow.instances.length;
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'a renderer that never signalled ready is not kept');
  const retry = surface.ensureReady(); retry.catch(() => {});
  assert.equal(BrowserWindow.instances.length, stuck + 1, 'the advertised off/on retry builds a fresh renderer');
  surface.markReady(surface.getWindow().webContents); await retry;
});
