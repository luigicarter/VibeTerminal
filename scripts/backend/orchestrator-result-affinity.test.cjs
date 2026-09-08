'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createTaskScheduler } = require('../../backend/orchestratorTasks.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { formatTaskWait } = require('../../backend/orchestratorTaskStatus.cjs');

const session = { id: 'pane', generation: 'g', kind: 'codex', provider: 'codex', cwd: 'C:/project',
  conversationId: 'original', turnState: 'idle', observation: 'observed', processState: 'running' };
const ending = { turnId: 'turn', turnState: 'completed', turnStartedAt: 101, turnEndedAt: 102 };
function tracked(initial = session, receipt = {}) {
  const scheduler = createTaskScheduler({ now: () => 100 });
  const job = scheduler.create({ text: 'Review the original conversation', origin: 'text' });
  scheduler.track(job, { kind: 'send_prompt', actionId: 'sent', targetId: 'pane', generation: 'g' },
    { ok: true, status: 'written', ...receipt }, { ...initial, submittedAt: 100 });
  job.executionDone = true; scheduler.update(job, { status: 'waiting-results' });
  return { scheduler, job };
}

for (const replacement of [{ conversationId: 'other' }, { provider: 'claude' }, { home: 'custom' }, { cwd: 'C:/other' }])
  test(`a different native source cannot complete submitted work: ${JSON.stringify(replacement)}`, () => {
    const { scheduler, job } = tracked();
    scheduler.reconcile([{ ...session, ...ending, ...replacement, completedActionId: 'sent', completedTurnId: 'turn' }]);
    assert.equal(job.task.status, 'failed'); assert.match(job.waits[0].error, /native conversation changed/);
  });

test('temporarily missing native identity cannot complete work and can recover only the original source', () => {
  const { scheduler, job } = tracked();
  scheduler.reconcile([{ ...session, ...ending, conversationId: undefined }]);
  assert.equal(job.task.status, 'waiting-results'); assert.equal(job.waits[0].attributionAmbiguous, true);
  scheduler.reconcile([{ ...session, ...ending }]);
  assert.equal(job.task.status, 'finished'); assert.equal(job.waits[0].failed, false);
});

test('a first native ID latches without blocking new workers and cannot be replaced later', () => {
  const { scheduler, job } = tracked({ ...session, conversationId: undefined });
  scheduler.reconcile([{ ...session, turnId: 'turn', turnState: 'running', turnStartedAt: 101 }]);
  assert.equal(job.waits[0].nativeIdentity.id, 'original');
  scheduler.reconcile([{ ...session, ...ending, conversationId: 'other' }]);
  assert.equal(job.task.status, 'failed');
});

test('same source with normalized Windows directory casing retains completion evidence', () => {
  const { scheduler, job } = tracked();
  scheduler.reconcile([{ ...session, ...ending, cwd: 'c:\\PROJECT\\' }]);
  assert.equal(job.task.status, 'finished');
});

test('historical completion remains distinct from the pane current conversation in status replies', () => {
  const { scheduler, job } = tracked();
  scheduler.reconcile([{ ...session, ...ending }]);
  const text = formatTaskWait(job.waits[0], { ...session, conversationId: 'replacement', name: 'Unrelated work' });
  assert.match(text, /recorded agent turn.*ended/);
  assert.match(text, /current conversation no longer matches/);
  assert.doesNotMatch(text, /in Unrelated work/);
});

for (const watchUntil of ['ready', 'completion']) test(`${watchUntil} watch cannot follow a different native conversation`, () => {
  const scheduler = createTaskScheduler({ now: () => 100 });
  const job = scheduler.create({ text: 'Watch the current task', origin: 'text' });
  const running = { ...session, turnId: 'turn', turnState: 'running', turnStartedAt: 99 };
  scheduler.watch(job, { actionId: 'watch', watchUntil, watchTarget: { id: 'pane', generation: 'g', turnId: 'turn' } }, running);
  job.executionDone = true; scheduler.update(job, { status: 'waiting-results' });
  scheduler.reconcile([{ ...running, ...ending, conversationId: 'other' }]);
  assert.equal(job.task.status, 'failed');
});

test('a replacement conversation result cannot release a real Orchestrator dependency', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-result-affinity-'));
  const sessions = [{ ...session, cwd: root }, { ...session, id: 'next', cwd: root, conversationId: 'next-conversation' }];
  const effects = []; let prerequisite;
  const relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [root] }), getSessions: () => sessions,
    interpretIntent: context => ({ goal: context.instruction, executionMode: 'direct',
      ...(prerequisite && { dependsOnRequestIds: [prerequisite] }),
      actions: [{ kind: 'send_prompt', targetIds: [prerequisite ? 'next' : 'pane'], text: context.instruction }] }),
    dispatchAction: action => { effects.push(action); return { ok: true, status: 'written' }; },
    fetch: async url => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] }));
      throw Error('This direct request must not need an execution model.');
    } });
  t.after(async () => { await relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await relay.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true }); await relay.setEnabled(true);
  const first = await relay.send({ text: 'Review the original conversation', origin: 'text' });
  prerequisite = first.requestId;
  Object.assign(sessions[0], { ...ending, conversationId: 'replacement', turnStartedAt: Date.now() + 1, turnEndedAt: Date.now() + 2 });
  await relay.refresh();
  assert.equal(relay.getState().tasks.find(task => task.requestId === prerequisite).status, 'failed');
  const next = await relay.send({ text: 'Use that review result', origin: 'text' });
  assert.equal(next.ok, false); assert.deepEqual(effects.map(action => action.targetId), ['pane']);
});
