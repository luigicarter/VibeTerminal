'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionDirectory } = require('../../backend/orchestratorIntegration.cjs');
const { createWorkspaceIdentity } = require('../../backend/orchestratorWorkspaceIdentity.cjs');
const { createCompletionEvidence } = require('../../backend/orchestratorCompletion.cjs');

for (const kind of ['fusion', 'openfusion']) test(`${kind} task completion binds an input and excludes stale/replayed events`, () => {
  let clock = 100;
  const directory = createSessionDirectory({ now: () => ++clock });
  const generation = directory.outgoing(kind, { type: 'start', payload: { id: 's', cwd: 'C:/project' } }).payload.generation;
  const emit = (type, extra = {}) => directory.ingest(kind, { id: 's', generation, type, ...extra });
  emit('engine-ready');
  directory.outgoing(kind, { type: 'input', payload: { id: 's', actionId: 'a' } });
  assert.equal(directory.get('s').turnState, 'idle', 'dispatch alone is not observed work');
  emit('turn-start');
  const first = directory.get('s').turnId;
  emit('assistant-text', { delta: 'The review found one bug.' });
  emit('result');
  assert.equal(directory.get('s').completedActionId, 'a');
  assert.equal(directory.get('s').completedTurnId, first);
  assert.equal(directory.get('s').turnState, 'completed');
  assert.equal(directory.readChat({ id: 's', generation }).completedResult.text, 'The review found one bug.');
  emit('turn-start', { replay: true });
  assert.equal(directory.get('s').turnId, first);
  directory.outgoing(kind, { type: 'input', payload: { id: 's', actionId: 'b' } });
  emit('turn-start');
  assert.notEqual(directory.get('s').turnId, first);
  assert.equal(directory.readChat({ id: 's', generation, completedTurnId: first }).completedResult.text, 'The review found one bug.');
  emit('result', { generation: 'stale' });
  assert.equal(directory.get('s').turnState, 'running');
  emit('result');
  assert.equal(directory.get('s').completedActionId, 'b');
});

test('native completion retains turn-scoped display evidence and excludes provisional/stale output', async () => {
  let session = { id: 's', generation: 'g', turnId: 't1', observation: 'observed', turnState: 'completed', turnStartedAt: 100, turnEndedAt: 200 };
  let output = { ok: true, generation: 'g', text: 'Review findings', outputAt: 180, sequence: 4 };
  const evidence = createCompletionEvidence({ getSession: () => session, readObservation: async () => output });
  await evidence.capture({ ...session, observation: 'provisional' });
  assert.equal(evidence.get(session), undefined);
  await evidence.capture(session);
  assert.equal(evidence.get(session).text, 'Review findings');
  session = { ...session, turnId: 't2', turnState: 'running', turnStartedAt: 300, turnEndedAt: undefined };
  assert.equal(evidence.get(session, 't1').text, 'Review findings');
  session = { ...session, turnState: 'completed', turnEndedAt: 400 };
  await evidence.capture(session);
  assert.equal(evidence.get(session), undefined, 'old display cannot stand for a new result');
  output = { ...output, outputAt: 390, text: 'Second result' };
  await evidence.capture(session);
  assert.equal(evidence.get(session).turnId, 't2');
  evidence.forget('s', 'g');
  assert.equal(evidence.get(session), undefined);
});

test('native completion is discarded if the terminal advances during decoder read', async () => {
  let resolveRead;
  let session = { id: 's', generation: 'g', turnId: 't1', observation: 'observed', turnState: 'completed', turnStartedAt: 100, turnEndedAt: 200 };
  const evidence = createCompletionEvidence({ getSession: () => session, readObservation: () => new Promise(resolve => { resolveRead = resolve; }) });
  const capture = evidence.capture(session);
  await Promise.resolve();
  session = { ...session, turnId: 't2', turnState: 'running' };
  resolveRead({ ok: true, generation: 'g', text: 'Mixed screen', outputAt: 210 });
  await capture;
  assert.equal(evidence.get(session, 't1'), undefined);
});

test('interleaved human input and rejected input never retain task completion attribution', () => {
  const directory = createSessionDirectory();
  const generation = directory.outgoing('fusion', { type: 'start', payload: { id: 's', cwd: 'C:/project' } }).payload.generation;
  const emit = (type, extra = {}) => directory.ingest('fusion', { id: 's', generation, type, ...extra });
  emit('engine-ready');
  directory.outgoing('fusion', { type: 'input', payload: { id: 's', actionId: 'a' } });
  emit('turn-start');
  directory.outgoing('fusion', { type: 'steer', payload: { id: 's', text: 'human change' } });
  emit('result');
  assert.equal(directory.get('s').completedActionId, undefined);
  assert.equal(directory.get('s').completionAttribution, 'ambiguous');
  directory.outgoing('fusion', { type: 'input', payload: { id: 's', actionId: 'b' } });
  emit('action-result', { actionId: 'b', ok: false });
  emit('turn-start'); emit('result');
  assert.equal(directory.get('s').completedActionId, undefined);
});

test('workspace lanes unify subfolders and aliases but distinguish linked worktrees', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-workspace-identity-'));
  t.after(() => { assert(path.resolve(root).startsWith(path.join(os.tmpdir(), 'vibe-workspace-identity-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const repo = path.join(root, 'repo'), linked = path.join(root, 'linked');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'nested'), { recursive: true });
  fs.mkdirSync(linked); fs.writeFileSync(path.join(linked, '.git'), 'gitdir: ../repo/.git/worktrees/linked');
  const alias = path.join(root, 'alias'); fs.symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const resolve = createWorkspaceIdentity();
  assert.equal(await resolve(repo), await resolve(path.join(repo, 'src', 'nested')));
  assert.equal(await resolve(repo), await resolve(alias));
  assert.notEqual(await resolve(repo), await resolve(linked));
  assert.equal(await resolve('relative'), null);
});
