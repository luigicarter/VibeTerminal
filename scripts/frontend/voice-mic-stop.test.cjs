'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { createVoiceController } = require('../../backend/voiceController.cjs');
const { createTaskScheduler } = require('../../backend/orchestratorTasks.cjs');
const { wavFromSamples } = require('../../backend/voiceAudio.cjs');
const tick = () => new Promise(setImmediate);

function indicator() {
  const cells = [], effects = []; let cursor = 0;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], value => { cells[i] = typeof value === 'function' ? value(cells[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return cells[i] ||= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (!cells[i] || deps.some((d, j) => d !== cells[i].deps[j])) cells[i] = { deps, value: fn() }; return cells[i].value; },
    useEffect(fn, deps) { const i = cursor++; if (!cells[i] || deps.some((d, j) => d !== cells[i].deps[j])) { cells[i] = { deps }; effects.push(fn); } },
  };
  function load(filename) {
    const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
    const original = mod.require.bind(mod);
    mod.require = name => {
      if (name === 'react') return react;
      if (name.endsWith('.css')) return {};
      if (name === 'lucide-react') return { Mic: 'mic', MicOff: 'mic-off', Send: 'send', X: 'x' };
      const sibling = path.resolve(path.dirname(filename), name + '.ts');
      return name.startsWith('.') && fs.existsSync(sibling) ? load(sibling) : original(name);
    };
    mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
    return mod.exports;
  }
  const Component = load(path.resolve(__dirname, '../../frontend/VoiceIndicator.tsx')).default;
  return () => { cursor = 0; const tree = Component(); while (effects.length) effects.shift()(); return tree?.props.children.find(node => node?.props?.className === 'voice-mic'); };
}

for (const phase of ['transcribing', 'thinking']) test(`mic stop during ${phase} preserves unrelated requests and releases no recording`, async t => {
  const tasks = createTaskScheduler();
  const first = tasks.create({ text: 'First unrelated task', origin: 'text' });
  const second = tasks.create({ text: 'Second unrelated task', origin: 'text' });
  tasks.update(first, { status: 'running' }); tasks.update(second, { status: 'needs-answer' });
  let release, notify = () => {}, voice;
  const configurations = [], cancellations = [], pendingInput = new Promise(resolve => { release = resolve; });
  const orchestrator = { getState: () => ({ enabled: true, tasks: tasks.snapshot() }), cancel: input => { cancellations.push(input); return tasks.cancel(input?.requestId); }, enqueue: () => pendingInput };
  voice = createVoiceController({ orchestrator, getKey: () => 'test', emit: state => notify(state),
    inferenceFactory: () => ({ start: async () => {}, feed() {}, dispose() {} }),
    fetch: async () => phase === 'transcribing' ? pendingInput : new Response(JSON.stringify({ text: 'New voice task' })),
  });
  const previousWindow = global.window, previousDocument = global.document;
  t.after(() => { voice.dispose(); global.window = previousWindow; global.document = previousDocument; });
  await voice.setListening(true);
  const audio = voice.sendAudio({ audioBase64: wavFromSamples(Array(4000).fill(.1)).toString('base64') });
  await tick(); assert.equal(voice.getState().phase, phase);
  global.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  global.window = { vibe: { orchestrator, voice: {
    getState: async () => ({ ...voice.getState(), indicatorVisible: true }), onState: callback => { notify = state => callback({ ...state, indicatorVisible: true }); return () => {}; },
    cancelSpeech: async () => voice.cancelSpeech(), configure: async patch => { configurations.push(patch); return voice.configure(patch); },
  } } };
  const render = indicator(); render(); await tick(); const mic = render();
  assert.match(mic.props['aria-label'], /Stop current voice turn/);
  mic.props.onPointerDown({ button: 0, preventDefault() {} }); await tick();
  mic.props.onPointerUp({ button: 0 }); await tick();
  assert.deepEqual(cancellations, []);
  assert.deepEqual(tasks.snapshot().map(task => task.status), ['running', 'needs-answer']);
  assert.equal(first.controller.signal.aborted, false); assert.equal(second.controller.signal.aborted, false);
  assert.deepEqual(configurations, []);
  assert.equal(voice.getState().phase, 'listening');
  release(phase === 'transcribing' ? new Response(JSON.stringify({ text: 'Late transcription' })) : { ok: true, status: 'queued' });
  await audio;
  assert.equal(voice.getState().phase, 'listening');
});
