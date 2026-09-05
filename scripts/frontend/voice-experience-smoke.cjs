const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
function harness(file, mocks) {
  const cells = [], effects = []; let cursor = 0;
  const react = {
    useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = initial; return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return cells[index] ||= { current: initial }; },
    useMemo(factory, deps) { const index = cursor++; if (!cells[index] || deps.some((dep, i) => dep !== cells[index].deps[i])) cells[index] = { deps, value: factory() }; return cells[index].value; },
    useEffect(effect, deps) { const index = cursor++; if (!cells[index] || deps.some((dep, i) => dep !== cells[index].deps[i])) { cells[index]?.cleanup?.(); cells[index] = { deps }; effects.push(() => { cells[index].cleanup = effect(); }); } },
  };
  const filename = path.resolve(__dirname, '../../frontend', file), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = name => name === 'react' ? react : name.endsWith('.css') ? {} : mocks[name] || original(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  return { render() { cursor = 0; const Component = loaded.exports.default || loaded.exports.OrchestratorSettings; const tree = Component(); while (effects.length) effects.shift()(); return tree; } };
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
  const voice = { onState: () => () => {}, getState: async () => ({ listening: false }), configure: async () => ({ ok: true }) };
  global.window = { vibe: { voice } };
  const settings = harness('components/OrchestratorSettings.tsx', { '../orchestratorUi': { relayApi: () => api, useOrchestrator: () => state } });
  settings.render(); await flush(); let tree = settings.render();
  assert.equal(input(tree, 'OpenRouter API key').props.disabled, true);
  assert.equal(input(tree, 'OpenRouter API key').props.value, '');
  button(tree, 'Change').props.onClick(); tree = settings.render();
  assert.equal(input(tree, 'OpenRouter API key').props.disabled, false);
  input(tree, 'Assistant model').props.onChange({ target: { value: 'new/model' } });
  input(tree, 'OpenRouter API key').props.onChange({ target: { value: 'candidate-key' } });
  tree = settings.render(); assert.equal(input(tree, 'Enable Orchestrator').props.disabled, false);
  input(tree, 'Enable Orchestrator').props.onChange({ target: { checked: true } }); await flush(); tree = settings.render();
  assert.equal(calls[0][0], 'configure'); assert.equal(calls[0][1].model, 'new/model'); assert.equal(calls[0][1].apiKey, 'candidate-key'); assert.deepEqual(calls[1], ['test']);
  assert.match(text(tree), /selected models are not ready/); assert.equal(calls.some(call => call[0] === 'enabled'), false);
  assert.equal(calls[0][1].monitoringEnabled, false); assert.equal(input(tree, 'OpenRouter API key').props.value, '');
  assert.equal(input(tree, 'OpenRouter API key').props.disabled, true);
  api.testConnection = async () => ({ ok: true, ready: true, voiceReady: false });
  input(tree, 'Enable Orchestrator').props.onChange({ target: { checked: true } }); await flush(); tree = settings.render();
  assert.equal(calls.some(call => call[0] === 'enabled'), false);
  api.testConnection = async () => ({ ok: true, ready: true, voiceReady: true });
  api.setEnabled = async value => { calls.push(['enabled', value]); state.enabled = value; return { ok: true }; };
  input(tree, 'Enable Orchestrator').props.onChange({ target: { checked: true } }); await flush(); tree = settings.render();
  assert.deepEqual(calls.at(-1), ['enabled', true]); assert.match(text(tree), /Listening for/);
  state.ready = true; tree = settings.render(); assert.equal(button(tree, 'Preview voice').props.disabled, false);
  input(tree, 'Assistant model').props.onChange({ target: { value: '' } }); tree = settings.render();
  assert.equal(button(tree, 'Preview voice').props.disabled, true);
  assert.equal(input(tree, 'Enable Orchestrator').props.disabled, false, 'Off remains available with incomplete edits');
  const beforeOff = calls.length; input(tree, 'Enable Orchestrator').props.onChange({ target: { checked: false } }); await flush(); tree = settings.render();
  assert.equal(calls.length, beforeOff + 1); assert.deepEqual(calls.at(-1), ['enabled', false]);
  const advanced = nodes(tree).find(node => node.type === 'details' && text(node).startsWith('Advanced'));
  assert.ok(nodes(advanced).includes(input(tree, 'Voice')));
  assert.ok(nodes(advanced).includes(button(tree, 'Save changes')));
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
  let captures = 0, players = 0;
  const audioMocks = { './voice/microphone': { VoiceMicrophone: class { constructor() { captures++; } stop() {} async start() {} } }, './voice/pcmPlayer': { PcmPlayer: class { constructor() { players++; } stop() { stopped++; } dispose() {} push() { pushed++; } } } };
  const overlay = harness('VoiceOverlay.tsx', audioMocks);
  assert.equal(overlay.render(), null); assert.deepEqual(events.slice(0, 3), ['state-listener', 'audio-listener', { rendererReady: true }]);
  stateListener({ phase: 'listening', listening: true, captureToken: 7 }); resolveInitial({ phase: 'off', listening: false }); await flush(); assert.equal(overlay.render(), null);
  await flush(); assert.ok(events.some(event => event?.microphoneReady === true && event.captureToken === 7));
  stateListener({ phase: 'speaking', listening: false }); assert.equal(overlay.render(), null); audioListener({ data: [0, 0] });
  assert.equal(stopped, 0, 'Muted preview must not stop playback'); assert.equal(pushed, 1);
  const beforeIndicator = events.length;
  const indicator = harness('VoiceIndicator.tsx', audioMocks);
  assert.equal(indicator.render(), null, 'No indicator until main process asks to show it');
  stateListener({ phase: 'listening', listening: true, indicatorVisible: true }); resolveInitial({ phase: 'off', listening: false, indicatorVisible: false }); await flush(); tree = indicator.render();
  assert.match(tree.props.className, /voice-indicator/);
  assert.match(nodes(tree).find(node => node.props?.className === 'voice-mic').props['aria-label'], /Hey Vibe/);
  assert.deepEqual(events.slice(beforeIndicator), ['state-listener'], 'Main indicator must not own audio or issue rendererReady');
  assert.equal(captures, 1); assert.equal(players, 1);
  document.hidden = true; visibilityChanged(); tree = indicator.render(); assert.match(tree.props.className, /voice-hidden/);
  nodes(tree).find(node => node.props?.className === 'voice-mini voice-hide').props.onClick(); await flush(); assert.ok(events.some(event => event?.hideOverlay === true));
  assert.equal(nodes(tree).filter(node => node.type === 'button').length, 3);
  stateListener({ phase: 'listening', listening: true, indicatorVisible: false }); assert.equal(indicator.render(), null);
  assert.equal(captures, 1, 'Hiding main indicator never restarts capture');
  console.log('Voice experience smoke passed: current draft enable/readiness, saved key lock, off with incomplete edits, advanced options, preview guard, capture ACK, hidden audio ownership, main-only indicator, hidden animations, muted playback, hide action.');
})().catch(error => { console.error(error); process.exitCode = 1; });
