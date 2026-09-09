const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
for (const file of ['VoiceIndicator.tsx', 'components/OrchestratorSettings.tsx']) {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(path.resolve(__dirname, '../../frontend', file)));
  assert.ok(!source.includes('\r\r\n'), `${file} contains doubled carriage returns`);
  assert.ok(!source.includes('\uFFFD'), `${file} contains replacement characters`);
}
function harness(file, mocks) {
  const cells = [], effects = []; let cursor = 0;
  const react = {
    useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = initial; return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return cells[index] ||= { current: initial }; },
    useMemo(factory, deps) { const index = cursor++; if (!cells[index] || deps.some((dep, i) => dep !== cells[index].deps[i])) cells[index] = { deps, value: factory() }; return cells[index].value; },
    useEffect(effect, deps) { const index = cursor++; if (!cells[index] || deps.some((dep, i) => dep !== cells[index].deps[i])) { cells[index]?.cleanup?.(); cells[index] = { deps }; effects.push(() => { cells[index].cleanup = effect(); }); } },
  };
  // Un-mocked relative imports are real sibling sources, compiled the same way.
  const load = filename => {
    const loaded = new Module(filename, module);
    loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const original = loaded.require.bind(loaded);
    loaded.require = name => {
      if (name === 'react') return react;
      if (name.endsWith('.css')) return {};
      if (mocks[name]) return mocks[name];
      const sibling = ['.ts', '.tsx'].map(extension => path.resolve(path.dirname(filename), name + extension)).find(candidate => fs.existsSync(candidate));
      return sibling ? load(sibling) : original(name);
    };
    loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
    return loaded.exports;
  };
  const exported = load(path.resolve(__dirname, '../../frontend', file));
  return { render() { cursor = 0; const Component = exported.default || exported.OrchestratorSettings; const tree = Component(); while (effects.length) effects.shift()(); return tree; } };
}
function nodes(tree) { if (!tree || typeof tree !== 'object') return []; const children = tree.props?.children; return [tree, ...[children].flat(Infinity).flatMap(nodes)]; }
function text(tree) { if (typeof tree === 'string') return tree; if (!tree || typeof tree !== 'object') return ''; return [tree?.props?.children].flat(Infinity).map(text).join(''); }
function button(tree, label) { const result = nodes(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(result, `Missing ${label}`); return result; }
function input(tree, label) { const parent = nodes(tree).find(node => node.type === 'label' && text(node).trimStart().startsWith(label)); assert.ok(parent, `Missing ${label}`); return nodes(parent).find(node => ['input', 'select'].includes(node.type)); }
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
(async () => {
  const calls = [];
  const state = { enabled: false, ready: false, settings: { hasKey: true, model: 'old/model', ttsModel: 'supported/speech', voice: 'warm', sttModel: 'stt', monitoringEnabled: false }, preferences: [], usage: {} };
  const api = { models: async () => [{ id: 'supported/speech', voices: [{ id: 'warm', name: 'Warm' }] }], configure: async patch => { calls.push(['configure', patch]); return { ok: true }; }, testConnection: async () => { calls.push(['test']); return { ok: true, ready: false }; } };
  const voice = { onFlush: () => () => {}, onState: () => () => {}, getState: async () => ({ listening: false }), configure: async () => ({ ok: true }) };
  global.window = { vibe: { voice } };
  const settings = harness('components/OrchestratorSettings.tsx', { '../orchestratorUi': { relayApi: () => api, useOrchestrator: () => state } });
  settings.render(); await flush(); let tree = settings.render();
  assert.equal(input(tree, 'Hands-free voice').props.checked, false);
  assert.equal(input(tree, 'OpenRouter API key').props.disabled, true);
  assert.equal(input(tree, 'OpenRouter API key').props.value, '');
  button(tree, 'Change').props.onClick(); tree = settings.render();
  assert.equal(input(tree, 'OpenRouter API key').props.disabled, false);
  input(tree, 'Hands-free voice').props.onChange({ target: { checked: true } });
  input(tree, 'Assistant model').props.onChange({ target: { value: 'new/model' } });
  input(tree, 'OpenRouter API key').props.onChange({ target: { value: 'candidate-key' } });
  tree = settings.render(); assert.equal(input(tree, 'Enable Orchestrator').props.disabled, false);
  input(tree, 'Enable Orchestrator').props.onChange({ target: { checked: true } }); await flush(); tree = settings.render();
  assert.equal(calls[0][0], 'configure'); assert.equal(calls[0][1].model, 'new/model'); assert.equal(calls[0][1].apiKey, 'candidate-key'); assert.deepEqual(calls[1], ['test']);
  assert.match(text(tree), /selected models are not ready/); assert.equal(calls.some(call => call[0] === 'enabled'), false);
  assert.equal(calls[0][1].handsFreeEnabled, true); assert.equal(calls[0][1].monitoringEnabled, false); assert.equal(input(tree, 'OpenRouter API key').props.value, '');
  assert.equal(input(tree, 'OpenRouter API key').props.disabled, true);
  api.testConnection = async () => ({ ok: true, ready: true, voiceReady: false });
  input(tree, 'Enable Orchestrator').props.onChange({ target: { checked: true } }); await flush(); tree = settings.render();
  assert.equal(calls.some(call => call[0] === 'enabled'), false);
  api.testConnection = async () => ({ ok: true, ready: true, voiceReady: true });
  api.setEnabled = async value => { calls.push(['enabled', value]); state.enabled = value; return { ok: true }; };
  input(tree, 'Enable Orchestrator').props.onChange({ target: { checked: true } }); await flush(); tree = settings.render();
  assert.deepEqual(calls.at(-1), ['enabled', true]); assert.match(text(tree), /[Hh]old Space to talk/);
  state.ready = true; tree = settings.render(); assert.equal(button(tree, 'Preview voice').props.disabled, false);
  input(tree, 'Assistant model').props.onChange({ target: { value: '' } }); tree = settings.render();
  assert.equal(button(tree, 'Preview voice').props.disabled, true);
  assert.equal(input(tree, 'Enable Orchestrator').props.disabled, false, 'Off remains available with incomplete edits');
  const beforeOff = calls.length; input(tree, 'Enable Orchestrator').props.onChange({ target: { checked: false } }); await flush(); tree = settings.render();
  assert.equal(calls.length, beforeOff + 1); assert.deepEqual(calls.at(-1), ['enabled', false]);
  const advanced = nodes(tree).find(node => node.type === 'details' && text(node).startsWith('Advanced'));
  assert.ok(nodes(advanced).includes(input(tree, 'Voice')));
  assert.ok(!nodes(advanced).includes(button(tree, 'Save changes')), 'Save stays visible when Advanced is collapsed');
  assert.equal(nodes(tree).filter(node => node.type === 'button' && text(node) === 'Save changes').length, 1);
  const unsavedStatus = nodes(tree).find(node => node.props?.role === 'status' && text(node).startsWith('Unsaved changes.'));
  assert.ok(unsavedStatus); assert.ok(!nodes(advanced).includes(unsavedStatus));
  let deviceCaptures = 0, trackStops = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => { deviceCaptures++; return { getTracks: () => [{ stop() { trackStops++; } }] }; }, enumerateDevices: async () => [] } } });
  voice.configure = async () => ({ ok: false, error: 'Microphone not allowed' });
  button(tree, 'Refresh microphones').props.onClick(); await flush(); tree = settings.render();
  assert.equal(deviceCaptures, 0); assert.match(text(tree), /Microphone not allowed/);
  const permissionCalls = [];
  voice.configure = async patch => { permissionCalls.push(patch); return { ok: true }; };
  button(tree, 'Refresh microphones').props.onClick(); await flush(); tree = settings.render();
  assert.deepEqual(permissionCalls[0], { requestMicrophoneAccess: true }); assert.equal(deviceCaptures, 1); assert.equal(trackStops, 1);
  button(tree, 'Open Windows microphone settings').props.onClick(); await flush();
  assert.deepEqual(permissionCalls.at(-1), { openMicrophoneSettings: true });
  let visibilityChanged;
  global.document = { hidden: false, addEventListener: (name, cb) => { if (name === 'visibilitychange') visibilityChanged = cb; }, removeEventListener() {} };
  let stateListener, audioListener, resolveInitial; let stopped = 0, pushed = 0;
  const events = [];
  voice.onState = cb => { stateListener = cb; events.push('state-listener'); return () => {}; };
  voice.onAudio = cb => { audioListener = cb; events.push('audio-listener'); return () => {}; };
  voice.getState = () => new Promise(resolve => { resolveInitial = resolve; });
  voice.configure = async patch => { events.push(patch); return { ok: true }; };
  voice.cancelSpeech = async () => {};
  global.window.vibe.orchestrator = { cancel: async () => {} };
  let captures = 0, players = 0, frameCallback, flushListener;
  voice.frames = frame => events.push({ frame });
  voice.onFlush = cb => { flushListener = cb; return () => { flushListener = undefined; }; };
  const audioMocks = { './voice/microphone': { VoiceMicrophone: class { constructor() { captures++; } stop() {} async start(cb) { frameCallback = cb; } async flush() { frameCallback([0.25], 320); return 321; } } }, './voice/pcmPlayer': { PcmPlayer: class { constructor() { players++; } stop() { stopped++; } dispose() {} push() { pushed++; } } } };
  const overlay = harness('VoiceOverlay.tsx', audioMocks);
  assert.equal(overlay.render(), null); assert.deepEqual(events.slice(0, 3), ['state-listener', 'audio-listener', { rendererReady: true }]);
  stateListener({ phase: 'listening', listening: true, captureToken: 7 }); resolveInitial({ phase: 'off', listening: false }); await flush(); assert.equal(overlay.render(), null);
  await flush(); assert.ok(events.some(event => event?.microphoneReady === true && event.captureToken === 7));
  flushListener({ id: 'wrong', captureToken: 6 }); await flush();
  assert.equal(events.some(event => event?.captureFlushed), false);
  flushListener({ id: 'flush-1', captureToken: 7 }); await flush();
  const frameIndex = events.findIndex(event => event?.frame);
  assert.deepEqual(events[frameIndex].frame, { samples: [0.25], sampleStart: 320, sampleRate: 16000, captureToken: 7 });
  assert.deepEqual(events[frameIndex + 1], { captureFlushed: true, flushId: 'flush-1', captureToken: 7, sampleEnd: 321 });
  stateListener({ phase: 'speaking', listening: false }); assert.equal(overlay.render(), null); audioListener({ data: [0, 0] });
  assert.equal(stopped, 0, 'Muted preview must not stop playback'); assert.equal(pushed, 1);
  const beforeIndicator = events.length;
  const indicator = harness('VoiceIndicator.tsx', audioMocks);
  assert.equal(indicator.render(), null, 'No indicator until main process asks to show it');
  stateListener({ phase: 'listening', listening: true, indicatorVisible: true }); resolveInitial({ phase: 'off', listening: false, indicatorVisible: false }); await flush(); tree = indicator.render();
  assert.match(tree.props.className, /voice-indicator/);
  assert.match(nodes(tree).find(node => node.props?.className === 'voice-mic').props['aria-label'], /Hold to talk/);
  assert.deepEqual(events.slice(beforeIndicator), ['state-listener'], 'Main indicator must not own audio or issue rendererReady');
  assert.equal(captures, 1); assert.equal(players, 1);
  stateListener({ phase: 'listening', listening: true, indicatorVisible: true, handsFreeStatus: 'ready' }); tree = indicator.render();
  assert.match(text(tree), /Say Hey Lina/);
  stateListener({ phase: 'speaking', listening: true, indicatorVisible: true, handsFreeStatus: 'ready', wakeInterruptReady: true }); tree = indicator.render();
  assert.match(text(tree), /Speaking.*Hey Lina.*interrupt/);
  stateListener({ phase: 'speaking', listening: true, indicatorVisible: true, handsFreeStatus: 'ready', wakeInterruptReady: false }); tree = indicator.render();
  assert.match(text(tree), /Speaking.*Space to interrupt/); assert.doesNotMatch(text(tree), /Hey Lina/);
  stateListener({ phase: 'awaiting-answer', listening: true, indicatorVisible: true, handsFreeStatus: 'ready' }); tree = indicator.render();
  assert.match(text(tree), /Listening for your answer.*never mind/);
  stateListener({ phase: 'awaiting-answer', listening: true, indicatorVisible: true, handsFreeStatus: 'unavailable' }); tree = indicator.render();
  assert.match(text(tree), /Automatic listening unavailable.*Space to answer/);
  stateListener({ phase: 'recording', listening: true, indicatorVisible: true, recordingSource: 'wake', recordingId: 31 }); tree = indicator.render();
  assert.match(text(tree), /speak naturally/); assert.doesNotMatch(text(tree), /release Space/);
  assert.equal(nodes(tree).find(node => node.props?.role === 'status').props.className, 'voice-status');
  const mic = () => nodes(tree).find(node => node.props?.className === 'voice-mic').props;
  const pointer = { button: 0, preventDefault() {} };
  let beforeGesture = events.length;
  mic().onPointerDown({ ...pointer, button: 2 }); mic().onPointerUp({ button: 2 }); await flush();
  assert.equal(events.length, beforeGesture, 'Right-click never sends');
  mic().onPointerDown(pointer); mic().onPointerUp({ button: 2 }); await flush();
  assert.equal(events.length, beforeGesture, 'Right-button release cannot finish a left-button gesture');
  mic().onPointerCancel();
  mic().onPointerDown(pointer); mic().onPointerLeave(); mic().onPointerUp(pointer); await flush();
  assert.equal(events.length, beforeGesture, 'Leaving automatic Send never submits or starts PTT');
  mic().onPointerDown(pointer); mic().onPointerCancel(); mic().onPointerUp(pointer); await flush();
  assert.equal(events.length, beforeGesture, 'Cancelled automatic pointer never submits');
  mic().onPointerDown(pointer); mic().onPointerUp(pointer); await flush();
  assert.deepEqual(events.slice(beforeGesture), [{ finishRecording: 31 }], 'A quick automatic click sends without adopting a Space hold');
  beforeGesture = events.length;
  mic().onPointerDown(pointer);
  stateListener({ phase: 'listening', listening: true, indicatorVisible: true }); tree = indicator.render();
  mic().onPointerUp(pointer); await flush();
  assert.deepEqual(events.slice(beforeGesture), [], 'A stale click cannot submit or start another turn');
  beforeGesture = events.length;
  mic().onPointerDown(pointer); await flush(); mic().onPointerUp(pointer); await flush();
  assert.equal(events[beforeGesture].pushToTalk, 'start'); assert.equal(events.at(-1).pushToTalk, 'cancel', 'Short manual tap remains guarded');
  const realNow = Date.now; let gestureTime = 1000;
  try {
    Date.now = () => gestureTime;
    mic().onPointerDown(pointer); await flush(); gestureTime += 350; mic().onPointerUp(pointer); await flush();
    assert.equal(events.at(-1).pushToTalk, 'stop', 'Manual mouse hold still sends on release');
  } finally { Date.now = realNow; }
  stateListener({ phase: 'recording', listening: true, indicatorVisible: true, recordingSource: 'wake', finishHint: true }); tree = indicator.render();
  assert.match(text(tree), /click Send when finished/);
  const readyTurn = recordingId => ({ phase: 'recording', listening: true, indicatorVisible: true, recordingSource: 'wake', recordingId });
  stateListener(readyTurn(41)); tree = indicator.render();
  const configureSuccess = voice.configure;
  let staleSubmissions = 0;
  voice.configure = async () => { staleSubmissions++; return { ok: false, error: 'Stale Send failed.' }; };
  mic().onPointerDown(pointer);
  stateListener(readyTurn(42)); tree = indicator.render(); mic().onPointerUp(pointer); await flush(); tree = indicator.render();
  assert.equal(staleSubmissions, 0, 'Old pointer release does not call even a failing backend for a newer turn');
  assert.match(text(tree), /Listening/); assert.doesNotMatch(text(tree), /Stale Send failed/);
  mic().onPointerDown(pointer);
  stateListener({ ...readyTurn(42), recordingSource: 'ptt' }); tree = indicator.render(); mic().onPointerUp(pointer); await flush();
  assert.equal(staleSubmissions, 0, 'Manual adoption of the same recording ID disarms automatic Send');
  stateListener(readyTurn(42)); tree = indicator.render(); mic().onPointerDown(pointer);
  stateListener({ ...readyTurn(42), recordingSource: 'ptt' });
  stateListener(readyTurn(42)); tree = indicator.render(); mic().onPointerUp(pointer); await flush();
  assert.equal(staleSubmissions, 0, 'Adoption and handback invalidate the original gesture even when ID/source match again');
  let adoptedFailure;
  voice.configure = () => new Promise(resolve => { adoptedFailure = resolve; });
  mic().onPointerDown(pointer); mic().onPointerUp(pointer);
  stateListener({ ...readyTurn(42), recordingSource: 'ptt' }); tree = indicator.render();
  adoptedFailure({ ok: false, error: 'Automatic flush failed after adoption.' }); await flush(); tree = indicator.render();
  assert.doesNotMatch(text(tree), /Automatic flush failed after adoption/, 'Source changes fence already pending automatic feedback');
  stateListener(readyTurn(41)); tree = indicator.render();
  voice.configure = async patch => { events.push(patch); return { ok: false, error: 'Microphone audio did not finish.' }; };
  mic().onPointerDown(pointer); mic().onPointerUp(pointer); await flush(); tree = indicator.render();
  assert.match(text(tree), /Microphone audio did not finish/);
  stateListener({ ...readyTurn(41), finishHint: true }); tree = indicator.render();
  assert.match(text(tree), /Microphone audio did not finish/, 'Same-turn updates preserve failure feedback');
  stateListener(readyTurn(42)); tree = indicator.render();
  assert.match(text(tree), /Listening/); assert.doesNotMatch(text(tree), /Microphone audio did not finish/);
  let finishFailed;
  voice.configure = () => new Promise(resolve => { finishFailed = resolve; });
  mic().onPointerDown(pointer); mic().onPointerUp(pointer);
  stateListener(readyTurn(43)); tree = indicator.render();
  finishFailed({ ok: false, error: 'Old flush failed.' }); await flush(); tree = indicator.render();
  assert.doesNotMatch(text(tree), /Old flush failed/, 'A late failure from an old turn cannot overwrite the current status');
  voice.configure = configureSuccess;
  beforeGesture = events.length;
  mic().onKeyDown({ key: 'Enter', repeat: false }); mic().onKeyDown({ key: 'Enter', repeat: true }); await flush();
  assert.deepEqual(events.slice(beforeGesture), [{ finishRecording: 43 }], 'Holding Enter sends only once');
  stateListener({ phase: 'listening', listening: true, indicatorVisible: true }); tree = indicator.render();
  let manualStopFailed;
  voice.configure = patch => patch.pushToTalk === 'stop' ? new Promise(resolve => { manualStopFailed = resolve; }) : Promise.resolve({ ok: true });
  try {
    gestureTime = 1000; Date.now = () => gestureTime;
    mic().onPointerDown(pointer); await flush(); gestureTime += 350; mic().onPointerUp(pointer);
    stateListener(readyTurn(44)); tree = indicator.render();
    manualStopFailed({ ok: false, error: 'Old manual flush failed.' }); await flush(); tree = indicator.render();
    assert.match(text(tree), /Listening/); assert.doesNotMatch(text(tree), /Old manual flush failed/, 'Manual results cannot shadow authoritative state for a newer turn');
  } finally { Date.now = realNow; voice.configure = configureSuccess; }
  stateListener({ phase: 'listening', listening: true, indicatorVisible: true, handsFreeStatus: 'unavailable', handsFreeError: 'Retry hands-free voice.' }); tree = indicator.render();
  assert.match(text(tree), /Retry hands-free voice.*Hold Space/);
  document.hidden = true; visibilityChanged(); tree = indicator.render(); assert.match(tree.props.className, /voice-hidden/);
  const dismissVoice = nodes(tree).find(node => node.props?.className === 'voice-mini voice-hide');
  assert.equal(dismissVoice.props['aria-label'], 'Dismiss voice conversation');
  dismissVoice.props.onClick(); await flush(); assert.ok(events.some(event => event?.dismiss === true));
  assert.equal(nodes(tree).filter(node => node.type === 'button').length, 3);
  stateListener({ phase: 'listening', listening: true, indicatorVisible: false }); assert.equal(indicator.render(), null);
  assert.equal(captures, 1, 'Hiding main indicator never restarts capture');
  const keys = {};
  global.HTMLElement = class {};
  window.addEventListener = (name, handler) => { keys[name] = handler; };
  window.removeEventListener = () => {};
  const keyboard = harness('VoicePushToTalk.tsx', {});
  const indicatorStateListener = stateListener;
  keyboard.render();
  stateListener({ phase: 'listening' }); resolveInitial({ phase: 'off' }); await flush();
  beforeGesture = events.length;
  keys.keydown({ code: 'Space', preventDefault() {} }); await flush();
  assert.equal(events[beforeGesture].pushToTalk, 'start', 'Late initial off state cannot override live listening for Space');
  keys.keyup({ code: 'Space', preventDefault() {} }); await flush();
  voice.configure = async patch => {
    if (patch.pushToTalk === 'stop') {
      const failed = { phase: 'listening', listening: true, indicatorVisible: true, error: 'Microphone audio did not finish.' };
      stateListener(failed); indicatorStateListener(failed);
      return { ok: false, error: failed.error };
    }
    return { ok: true };
  };
  try {
    gestureTime = 1000; Date.now = () => gestureTime;
    keys.keydown({ code: 'Space', preventDefault() {} }); await flush();
    gestureTime += 350; keys.keyup({ code: 'Space', preventDefault() {} }); await flush();
    tree = indicator.render();
    assert.match(text(tree), /Microphone audio did not finish/, 'Keyboard errors published by backend state are visible in the indicator');
    assert.equal(nodes(tree).find(node => node.props?.className === 'voice-status').props.role, 'alert');
  } finally { Date.now = realNow; voice.configure = configureSuccess; }
  harness('VoicePushToTalk.tsx', {}).render();
  stateListener({ phase: 'off' }); resolveInitial({ phase: 'listening' }); await flush();
  beforeGesture = events.length;
  keys.keydown({ code: 'Space', preventDefault() {} }); await flush();
  assert.equal(events.length, beforeGesture, 'Late initial listening state cannot reactivate Space after a live off event');
  console.log('Voice experience smoke passed: current draft enable/readiness, saved key lock, off with incomplete edits, advanced options, preview guard, capture ACK, hidden audio ownership, main-only indicator, hidden animations, muted playback, hide action.');
})().catch(error => { console.error(error); process.exitCode = 1; });
