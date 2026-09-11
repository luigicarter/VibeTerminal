const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const react = { useState: value => [typeof value === 'function' ? value() : value, () => {}], useRef: current => ({ current }), useEffect() {}, useLayoutEffect() {} };
function load(filename) {
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = name => {
    if (name === 'react') return react;
    if (name.endsWith('.css')) return {};
    if (name === '../orchestratorUi') return { relayApi: () => null };
    if (name === '../sessionDrafts') return { useSessionDraft: () => ['', () => {}] };
    if (['./ConversationHistory', './ChangesPanel'].includes(name)) return {};
    if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name + '.ts'));
    return original(name);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  return loaded.exports;
}
global.window = { innerHeight: 900 };
const { OrchestratorPanel } = load(path.resolve(__dirname, '../../frontend/components/OrchestratorPanel.tsx'));
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]; }
function text(tree) { return typeof tree === 'string' ? tree : !tree || typeof tree !== 'object' ? '' : [tree.props?.children].flat(Infinity).map(text).join(''); }
for (const decision of ['create', 'reuse', undefined]) {
  const task = { id: 'r', requestId: 'r', sequence: 1, status: 'running', targets: [], assignment: decision ? { decision, reason: 'Related <task> & context', workItemId: 'private-internal-id' } : undefined };
  const state = { ready: true, enabled: true, tasks: [task], messages: [{ id: 'u', requestId: 'r', role: 'user', text: 'Do work' }] };
  const tree = OrchestratorPanel({ state, sessions: [], selectedId: null, folders: [], embedded: true, onFocus() {}, onSettings() {} });
  const line = nodes(tree).find(node => node.props?.className === 'relay-task-routing');
  if (!decision) assert.equal(line, undefined);
  else {
    assert.equal(text(line), `${decision === 'create' ? 'New agent' : 'Existing agent'} · Related <task> & context`);
    assert.equal(line.props.dangerouslySetInnerHTML, undefined);
  }
  assert.ok(!text(tree).includes('private-internal-id'));
}
console.log('Orchestrator routing details smoke passed');
