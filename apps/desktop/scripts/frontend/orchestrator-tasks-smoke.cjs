const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const cells = []; let cursor = 0;
const react = {
  useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial; return [cells[i], value => { cells[i] = typeof value === 'function' ? value(cells[i]) : value; }]; },
  useRef(initial) { const i = cursor++; return cells[i] ||= { current: initial }; },
  useEffect() {}, useLayoutEffect() {},
};
const calls = []; let acknowledge;
const api = {
  enqueue(input) { calls.push(['enqueue', input]); return new Promise(resolve => { acknowledge = resolve; }); },
  cancel: async input => { calls.push(['cancel', input]); return { ok: true }; },
  retry: async input => { calls.push(['retry', input]); return { ok: true }; },
  clearHistory: async () => { calls.push(['clear']); return { ok: true }; },
};
const mocks = {
  '../orchestratorUi': { relayApi: () => api },
  '../sessionDrafts': { useSessionDraft: () => ['', () => {}] },
  './ConversationHistory': {}, './ChangesPanel': {},
};
function load(filename) {
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = name => {
    if (name === 'react') return react;
    if (name.endsWith('.css')) return {};
    if (mocks[name]) return mocks[name];
    if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name + '.ts'));
    return original(name);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  return loaded.exports;
}
global.window = { innerHeight: 900 };
const { OrchestratorPanel } = load(path.resolve(__dirname, '../../frontend/components/OrchestratorPanel.tsx'));
const tasks = [1, 2].map(n => ({ id: `r${n}`, requestId: `r${n}`, sequence: n, text: `Task ${n}`, status: n === 1 ? 'needs-answer' : 'failed', targets: [{ id: `s${n}`, name: `Pane ${n}`, cwd: `project${n}` }], question: n === 1 ? { id: 'q1', requestId: 'r1', text: 'Which files?' } : undefined }));
tasks[0].waitingReason = 'Waiting for a verified terminal result; the instruction was sent.';
const state = { busy: true, ready: true, enabled: true, phase: 'Working', tasks, sessions: [], requests: [], messages: [
  { id: 'u1', requestId: 'r1', role: 'user', text: 'First' }, { id: 'u2', requestId: 'r2', role: 'user', text: 'Second' },
  { id: 'a2', requestId: 'r2', role: 'assistant', text: 'Second answer' }, { id: 'a1', requestId: 'r1', role: 'assistant', text: 'First answer' },
] };
function render(overrides = {}) { cursor = 0; return OrchestratorPanel({ state, sessions: [], selectedId: null, folders: [], embedded: true, onFocus() {}, onSettings() {}, ...overrides }); }
function nodes(tree) { if (!tree || typeof tree !== 'object') return []; return [tree, ...[tree.props?.children].flat(Infinity).flatMap(nodes)]; }
function text(tree) { if (typeof tree === 'string') return tree; if (!tree || typeof tree !== 'object') return ''; return [tree.props?.children].flat(Infinity).map(text).join(''); }
function find(tree, predicate) { const result = nodes(tree).find(predicate); assert.ok(result); return result; }
const composer = tree => find(tree, node => node.props?.['aria-label'] === 'Orchestrator instruction');
const button = (tree, label) => find(tree, node => node.type === 'button' && text(node).trim() === label);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
(async () => {
  let tree = render();
  assert.equal(find(tree, node => node.props?.className === 'relay-task-waiting').props.children, tasks[0].waitingReason, 'Wait reason renders independently of an error');
  assert.ok(find(tree, node => node.props?.title === 'Send instruction'));
  button(tree, 'Reply').props.onClick();
  tree = render(); composer(tree).props.onChange({ target: { value: 'the source files' } });
  tree = render(); find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls[0], ['enqueue', { text: 'the source files', origin: 'text', replyToRequestId: 'r1', questionId: 'q1' }]);
  composer(tree).props.onChange({ target: { value: 'another request' } });
  acknowledge({ ok: true, requestId: 'r3' }); await flush(); tree = render();
  assert.equal(composer(tree).props.value, 'another request', 'Acknowledgment preserves subsequently edited text');
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  acknowledge({ ok: true, requestId: 'r4' }); await flush(); tree = render();
  assert.equal(composer(tree).props.value, '', 'Accepted untouched draft clears');
  assert.equal(calls[1][1].replyToRequestId, undefined, 'Accepted reply context clears');
  const answers = nodes(tree).filter(node => node.props?.className === 'relay-message assistant');
  assert.match(text(answers[0]), /#2 · Pane 2 · project2.*Second answer/);
  assert.match(text(answers[1]), /#1 · Pane 1 · project1.*First answer/);
  button(tree, 'Cancel').props.onClick(); button(tree, 'Retry').props.onClick(); button(tree, 'Stop all').props.onClick(); await flush();
  assert.deepEqual(calls.slice(-3), [['cancel', { requestId: 'r1' }], ['retry', { requestId: 'r2' }], ['cancel', undefined]]);
  button(tree, 'Clear history').props.onClick(); await flush(); assert.deepEqual(calls.at(-1), ['clear']);
  const result = { role: 'system', origin: 'task-detail', reportKind: 'result', status: 'completed', targetId: 's1', generation: 'g', turnId: 'turn', at: 1 };
  state.messages.push(
    { ...result, id: 'result-1', requestId: 'r1', text: 'Pane 1: Initial result.' },
    { ...result, id: 'result-2', requestId: 'r2', at: 2, text: 'Pane 1: Latest result.' },
    { id: 'old-completion', role: 'system', origin: 'task', text: 'Pane 1: the agent turn completed. The requested outcome is not independently verified.' },
    { id: 'old-missing', role: 'system', origin: 'task-detail', text: 'Pane 1: The agent turn ended, but no reliable result details are available yet.' },
    { id: 'uncertain', role: 'system', origin: 'task', reportKind: 'lifecycle', status: 'unverified', text: 'Pane 1: delivery is unconfirmed.' },
  );
  const actionCount = calls.length;
  tree = render();
  const reports = nodes(tree).filter(node => node.props?.className === 'relay-message system');
  assert.equal(reports.length, 2, 'shared results merge, routine legacy notices disappear, and genuine uncertainty remains');
  assert.match(text(reports[0]), /#1, #2.*Latest result/);
  assert.match(text(reports[1]), /delivery is unconfirmed/);
  assert.equal(state.messages.length, 9, 'rendering preserves request-owned history');
  assert.equal(calls.length, actionCount, 'cleaning the conversation cannot dispatch or cancel terminal work');
  state.busy = false;
  Object.assign(tasks[0], { status: 'continued', controlDisposition: 'transferred', continuedByRequestId: 'r3', question: undefined });
  Object.assign(tasks[1], { status: 'failed', controlDisposition: 'transferred', continuedByRequestId: 'r4' });
  tree = render();
  assert.match(text(tree), /Continued in a later request/);
  assert.equal(nodes(tree).some(node => node.type === 'button' && ['Retry', 'Cancel', 'Stop all', 'Reply'].includes(text(node).trim())), false, 'retired control offers no misleading actions');
  Object.assign(tasks[0], { status: 'waiting-results', waitingReason: 'The submitted task is still running.' });
  tree = render();
  assert.ok(button(tree, 'Cancel'), 'transferred control does not hide cancellation for native work still running');
  const selected = { id: 'worker-a', name: 'Worker A', cwd: 'C:/ProjectA' };
  const projectA = { projectPath: 'C:/ProjectA', sessions: [selected] };
  tree = render(projectA);
  find(tree, node => node.props?.['aria-label'] === 'Command target').props.onChange({ target: { value: selected.id } });
  tree = render(projectA);
  assert.equal(find(tree, node => node.props?.['aria-label'] === 'Command target').props.value, selected.id);
  composer(tree).props.onChange({ target: { value: 'Inspect this terminal.' } });
  tree = render(projectA); find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls.at(-1), ['enqueue', { text: 'Inspect this terminal.', origin: 'text', targetId: selected.id }], 'An explicit terminal uses its run identity without requiring its folder to be an open project.');
  acknowledge({ ok: true, requestId: 'selected-terminal' }); await flush();
  const projectB = { projectPath: 'C:/ProjectB', sessions: [selected] };
  tree = render(projectB);
  assert.equal(find(tree, node => node.props?.['aria-label'] === 'Command target').props.value, '', 'A project switch removes stale explicit terminal selection immediately.');
  composer(tree).props.onChange({ target: { value: 'Fix this project.' } });
  tree = render(projectB); find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls.at(-1), ['enqueue', { text: 'Fix this project.', origin: 'text', projectPath: 'C:/ProjectB' }]);
  tree = render(projectA);
  assert.equal(calls.at(-1)[1].projectPath, 'C:/ProjectB', 'Switching again cannot mutate the submitted project.');
  acknowledge({ ok: true, requestId: 'project-b' }); await flush();
  console.log('Orchestrator composer race, project capture, reply association, scoped actions, and compact conversation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
