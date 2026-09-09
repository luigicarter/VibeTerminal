const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../../frontend/orchestratorMessages.ts');
const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
const { projectOrchestratorMessages: project } = loaded.exports;
const message = (id, patch = {}) => ({ id, role: 'system', origin: 'task-detail', reportKind: 'result', status: 'completed', targetId: 'pane', generation: 'g', turnId: 'turn', requestId: id, text: 'Pane: changed code and passed checks.', at: 1, ...patch });
test('shared terminal result displays once with all request owners without mutating raw records', () => {
  const input = Object.freeze([Object.freeze(message('request-1')), Object.freeze(message('request-2', { text: 'Another summary of the same observed result.' }))]);
  const projected = project(input);
  assert.equal(projected.length, 1);
  assert.deepEqual(projected[0].relatedRequestIds, ['request-1', 'request-2']);
  assert.equal(projected[0].text, input[1].text);
  assert.equal(projected[0].id, input[0].id);
  assert.equal(input[0].relatedRequestIds, undefined);
  assert.deepEqual(project(input), projected);
});
test('numeric zero generation coalesces and newest result text replaces excerpts with stable row identity', () => {
  const input = [message('first', { generation: 0, text: 'Fallback excerpt.', at: 10 }),
    message('richer', { generation: 0, text: 'Full result with checks.', at: 30 }),
    message('stale', { generation: 0, text: 'Older result arriving late.', at: 20 })];
  const projected = project(input);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].id, 'first');
  assert.equal(projected[0].text, 'Full result with checks.');
  assert.equal(projected[0].at, 30);
  assert.deepEqual(projected[0].relatedRequestIds, ['first', 'richer', 'stale']);
  assert.equal(input[0].text, 'Fallback excerpt.');
  for (const generation of ['', NaN, Infinity]) assert.equal(project([message('a', { generation }), message('b', { generation })]).length, 2);
  assert.equal(project([...input, message('failure', { generation: 0, status: 'failed', at: 40 })]).length, 2);
});
test('new identities, missing metadata, failures, progress and unconfirmed delivery stay distinct', () => {
  for (const patch of [{ generation: 'new' }, { turnId: 'next' }, { targetId: 'other' }]) assert.equal(project([message('a'), message('b', patch)]).length, 2);
  for (const patch of [{ generation: undefined }, { turnId: undefined }, { targetId: undefined }, { reportKind: undefined }, { status: undefined }, { status: 'failed' }, { reportKind: 'progress' }, { origin: 'task', reportKind: 'lifecycle', status: 'unverified' }]) {
    assert.equal(project([message('a', patch), message('b', patch)]).length, 2);
  }
});
test('routine lifecycle and unavailable details are hidden but all command responses remain', () => {
  const input = [message('completed', { origin: 'task', reportKind: 'lifecycle' }), message('ready', { origin: 'task', reportKind: 'lifecycle', status: 'ready' }),
    message('missing', { reportKind: 'result-unavailable' }), message('missing-failed', { reportKind: 'result-unavailable', status: 'failed' }),
    message('failure', { origin: 'task', reportKind: 'lifecycle', status: 'failed' }), message('done-1', { role: 'assistant', text: 'done', completionCue: true }), message('done-2', { role: 'assistant', text: 'done', completionCue: true }), message('user', { role: 'user' })];
  assert.deepEqual(project(input).map(item => item.id), ['failure', 'done-1', 'done-2', 'user']);
});
test('legacy filter recognizes only exact stock automatic notices', () => {
  const completed = 'Pane: the agent turn completed. The requested outcome is not independently verified. All requested terminal turns have ended.';
  const missing = 'Pane: The agent turn ended, but no reliable result details are available yet.';
  const ready = 'Pane: the terminal is ready for input. This does not establish that any task was completed.';
  const legacy = (id, text, origin = 'task') => message(id, { text, origin, reportKind: undefined, status: undefined });
  assert.equal(project([legacy('a', completed), legacy('b', completed.toUpperCase()), legacy('c', missing, 'task-detail'), legacy('d', ready)]).length, 0);
  const retained = [legacy('extra', completed + ' Please check the terminal.'), legacy('different', 'Pane: The result is unavailable due to a delivery error.'),
    { ...legacy('user', completed), role: 'user' }, { ...legacy('assistant', missing, 'task-detail'), role: 'assistant' },
    { ...legacy('actual', missing, 'task-detail'), reportKind: 'result' }, legacy('quoted', `The agent said: "${completed}"`)];
  assert.deepEqual(project(retained).map(item => item.id), retained.map(item => item.id));
});
