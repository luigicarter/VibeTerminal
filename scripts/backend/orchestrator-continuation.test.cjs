'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { prepareContinuation, commitContinuation, resultDependencyBlocker } = require('../../backend/orchestratorContinuation.cjs');
const { createTaskScheduler } = require('../../backend/orchestratorTasks.cjs');

function fixture(status = 'needs-answer') {
  let changes = 0;
  const scheduler = createTaskScheduler({ onChange: () => { changes++; } });
  const owner = scheduler.create({ text: 'Investigate the problem.', origin: 'text' });
  const successor = scheduler.create({ text: 'Try again.', origin: 'text' });
  owner.context = { pendingCommand: { requestId: owner.task.requestId, instruction: owner.input.text, grants: [{ kind: 'delegate_task', targets: [] }] } };
  successor.context = { pendingCommand: null };
  scheduler.update(owner, { status, question: { id: 'question' }, ...(status === 'failed' && { error: 'Discovery failed.' }) });
  const ticket = (requiredResultsTransferred = true, extra = {}) => prepareContinuation({ owner, successor, requiredResultsTransferred, ...extra });
  return { owner, successor, scheduler, ticket, changes: () => changes };
}

test('failed undispatched continuation preserves failure and atomically installs one recovery owner', () => {
  const f = fixture('failed'), before = f.changes();
  const ticket = f.ticket();
  assert(f.owner.context.pendingCommand); assert.equal(f.successor.context.pendingCommand, null);
  commitContinuation(ticket, { batch: f.scheduler.batch });
  assert.equal(f.changes(), before + 1);
  assert.equal(f.owner.task.status, 'failed'); assert.equal(f.owner.task.error, 'Discovery failed.');
  assert.equal(f.owner.task.controlDisposition, 'transferred'); assert.equal(f.owner.context.pendingCommand, null);
  assert.equal(f.successor.context.pendingCommand.instruction, f.owner.input.text);
  assert.equal(f.successor.task.continuedFromRequestId, f.owner.task.requestId);
  assert.match(resultDependencyBlocker(f.owner), /whole task result/);
  assert.throws(() => commitContinuation(ticket), /changed/);
});

test('clarification becomes continued, while precommit failures and competing revisions leave ownership intact', () => {
  const f = fixture(); const original = f.owner.context.pendingCommand;
  assert.throws(() => f.ticket(true, { validate() { throw new Error('Invalid dependency'); } }), /Invalid/);
  assert.equal(f.owner.context.pendingCommand, original);
  const first = f.ticket(), second = f.ticket();
  commitContinuation(first, { batch: f.scheduler.batch });
  assert.equal(f.owner.task.status, 'continued'); assert.equal(f.owner.task.question, undefined);
  assert.throws(() => commitContinuation(second), /changed/);
});

test('commit rechecks changing action evidence without losing the original pending objective', () => {
  const f = fixture(); let allowed = true;
  const ticket = f.ticket(true, { validate() { if (!allowed) throw new Error('Already submitted'); } });
  allowed = false;
  assert.throws(() => commitContinuation(ticket), /Already submitted/);
  assert(f.owner.context.pendingCommand); assert.equal(f.successor.context.pendingCommand, null);
});

test('partial required result transfer retains original native wait and blocks whole-request dependencies', async () => {
  const f = fixture(); f.owner.executionDone = true;
  const wait = { targetId: 'a', generation: 'g', done: false, delivered: true, turnId: 'turn' };
  f.owner.waits.push(wait); f.owner.lanes = [{ key: 'workspace:C:/repo', targetIds: ['a'] }];
  commitContinuation(f.ticket(), { batch: f.scheduler.batch });
  assert.equal(f.owner.task.status, 'waiting-results'); assert.equal(f.owner.waits[0], wait);
  const dependent = f.scheduler.create({ text: 'Use the whole result', origin: 'text' });
  dependent.task.dependsOn = [f.owner.task.requestId];
  await assert.rejects(f.scheduler.waitForDependencies(dependent), /whole task result/);
  wait.done = true;
  f.scheduler.reconcile([]);
  assert.equal(f.owner.task.status, 'continued');
});

test('ancillary-only transfer preserves a fully dispatched producer and native result eligibility', () => {
  const f = fixture(); const wait = { done: true, failed: false, turnId: 't', completedResult: { turnId: 't' } };
  f.owner.waits.push(wait);
  commitContinuation(f.ticket(false), { batch: f.scheduler.batch });
  assert.equal(f.owner.task.status, 'finished'); assert.equal(f.owner.waits[0], wait);
  assert.equal(resultDependencyBlocker(f.owner), undefined);
});

test('native occupancy survives successor cancellation, and live lineage survives history clearing', () => {
  const f = fixture(); f.owner.executionDone = true;
  f.owner.waits.push({ done: false, delivered: true, backgroundPending: true });
  commitContinuation(f.ticket(), { batch: f.scheduler.batch });
  f.scheduler.cancel(f.successor.task.requestId); f.scheduler.clear();
  assert(f.scheduler.get(f.owner.task.requestId)); assert.equal(f.owner.waits[0].done, false);
});

test('continued nonproducers reject dependencies immediately rather than waiting forever', async () => {
  const f = fixture(); commitContinuation(f.ticket(false), { batch: f.scheduler.batch });
  const dependent = f.scheduler.create({ text: 'Use its result', origin: 'text' });
  dependent.task.dependsOn = [f.owner.task.requestId];
  await assert.rejects(f.scheduler.waitForDependencies(dependent), /without producing a task result/);
  assert.equal(dependent.task.status, 'paused');
});

test('empty-grant creation recovery and multiple clarification hops retain original live authority', () => {
  const f = fixture(); f.owner.context.pendingCommand.grants = []; f.owner.context.pendingCommand.unboundCreation = true;
  commitContinuation(f.ticket(), { batch: f.scheduler.batch });
  f.scheduler.update(f.successor, { status: 'needs-answer' });
  const third = f.scheduler.create({ text: 'Continue', origin: 'text' }); third.context = { pendingCommand: null };
  const ticket = prepareContinuation({ owner: f.successor, successor: third, requiredResultsTransferred: true });
  commitContinuation(ticket, { batch: f.scheduler.batch });
  f.scheduler.clear();
  assert(f.scheduler.get(f.owner.task.requestId)); assert(f.scheduler.get(f.successor.task.requestId));
  assert.equal(third.context.pendingCommand.requestId, f.owner.task.requestId);
  assert.equal(third.context.pendingCommand.unboundCreation, true);
  f.scheduler.cancel(third.task.requestId); f.scheduler.clear();
  assert.equal(f.scheduler.get(f.owner.task.requestId), undefined);
});

test('postcommit failure keeps successor authority and never rolls back to the predecessor', () => {
  const f = fixture(); commitContinuation(f.ticket(), { batch: f.scheduler.batch });
  f.scheduler.update(f.successor, { status: 'failed', error: 'Creation unconfirmed' });
  assert.equal(f.owner.context.pendingCommand, null);
  assert.equal(f.successor.context.pendingCommand.instruction, f.owner.input.text);
  assert.equal(f.successor.task.controlDisposition, 'failed');
});

test('main request admission excludes more than fifty historical continued controls from the active queue limit', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createOrchestrator } = require('../../backend/orchestrator.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continued-admission-'));
  const now = Date.now();
  fs.writeFileSync(path.join(root, 'orchestrator-conversation.json'), JSON.stringify({ tasks:
    Array.from({ length: 55 }, (_, index) => ({ requestId: `past-${index}`, sequence: index + 1,
      text: 'Earlier clarification', status: 'continued', controlDisposition: 'transferred',
      continuedByRequestId: `past-${index + 1}`, createdAt: now, updatedAt: now })) }));
  const app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => [], getRoots: () => ({ documents: root, projects: [] }),
    interpretIntent: context => ({ goal: context.instruction, actions: [] }),
    fetch: async url => new Response(JSON.stringify(url.endsWith('/key') ? { data: {} }
      : url.endsWith('/models') ? { data: [{ id: 'model', context_length: 128000, supported_parameters: ['tools'] }] }
        : { choices: [{ finish_reason: 'stop', message: { content: 'Ready.' } }] })) });
  t.after(async () => { await app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await app.configure({ apiKey: 'fixture', sessionOnly: true, model: 'model' }); await app.setEnabled(true);
  assert.equal(app.getState().tasks.filter(task => task.status === 'continued').length, 55);
  assert.equal(app.getState().busy, false);
  const accepted = await app.send({ text: 'Hello', origin: 'text' });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(app.getState().tasks.find(task => task.requestId === accepted.requestId).status, 'finished');
  assert.equal(app.getState().tasks.filter(task => task.status === 'continued').length, 55, 'admission does not erase retired history');
});
