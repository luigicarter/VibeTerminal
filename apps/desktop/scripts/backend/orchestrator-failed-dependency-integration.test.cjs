'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { observeWorkItemCommits } = require('./orchestrator-work-item-persistence-fixture.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Expected task transition did not occur.');
}
const reply = content => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
async function fixture(t, { restoredTasks, restoredWorkItems } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-task-reports-'));
  if (restoredTasks) fs.writeFileSync(path.join(root, 'orchestrator-conversation.json'), JSON.stringify({ tasks: restoredTasks }));
  if (restoredWorkItems) fs.writeFileSync(path.join(root, 'orchestrator-work-items.json'), JSON.stringify({ version: 1, items: restoredWorkItems }));
  const f = { effects: [], speech: [], models: [], sessions: ['a', 'b'].map(id => ({ id, name: `Agent ${id}`, generation: 'g', kind: 'fusion', cwd: path.join(root, id), turnState: 'idle', status: 'idle' })) };
  f.commits = observeWorkItemCommits(t, path.join(root, 'orchestrator-work-items.json'), () => f.app?.getState().tasks);
  f.plan = context => ({ goal: context.instruction, executionMode: 'direct', actions: [{ kind: 'send_prompt', targetIds: [context.targetId || 'a'], text: context.instruction }] });
  f.app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false }, now: () => f.now ?? Date.now(),
    getSessions: () => f.sessions, getRoots: () => ({ documents: root, projects: [] }),
    interpretIntent: context => f.plan(context),
    readSession: async ({ id }) => f.read ? f.read(id) : { ok: true, generation: f.sessions.find(item => item.id === id)?.generation, turnId: f.sessions.find(item => item.id === id)?.turnId, text: `Current output from ${id}` },
    dispatchAction: async action => {
      f.effects.push(action);
      if (f.dispatch) return f.dispatch(action);
      const session = f.sessions.find(session => session.id === action.targetId);
      Object.assign(session, { turnState: 'running', turnId: action.actionId, actionId: action.actionId, turnStartedAt: Date.now() });
      return { ok: true, status: 'written', turnId: session.turnId };
    }, onSpeak: event => { f.speech.push(event); return f.speak ? f.speak(event) : { ok: true }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'brain', context_length: 128000, supported_parameters: ['tools'] }] }));
      const body = JSON.parse(options.body); f.models.push(body);
      return new Response(JSON.stringify(f.respond ? f.respond(body) : reply('Observed progress.')));
    } });
  await f.app.configure({ apiKey: 'fixture-secret', sessionOnly: true, model: 'brain' });
  assert.equal((await f.app.setEnabled(true)).ok, true);
  f.reports = requestId => f.app.getState().messages.filter(message => message.origin === 'task' && (!requestId || message.requestId === requestId));
  f.finish = async (id, status = 'completed') => {
    const session = f.sessions.find(session => session.id === id);
    Object.assign(session, { turnState: status, completedTurnId: session.turnId, completedActionId: session.actionId, turnEndedAt: Date.now() });
    await f.app.refresh(); await tick();
  };
  t.after(async () => {
    await f.app.dispose();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('vibe-task-reports-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}


function completeDuringDispatch(f, status) {
  f.dispatch = async action => {
    const session = f.sessions.find(item => item.id === action.targetId);
    Object.assign(session, { turnState: status, turnId: action.actionId, actionId: action.actionId,
      completedActionId: action.actionId, completedTurnId: action.actionId,
      turnStartedAt: Date.now(), turnEndedAt: Date.now(), ...(status === 'failed' && { error: 'Immediate agent failure.' }) });
    return { ok: true, status: 'written', turnId: action.actionId };
  };
}
function dependOn(f, requestId) {
  f.plan = context => ({ goal: context.instruction, executionMode: 'reason', dependsOnRequestIds: [requestId],
    actions: [{ kind: 'send_prompt', targetIds: ['b'], text: 'Apply the review findings.' }] });
  f.respond = body => {
    if (body.messages.some(message => message.role === 'tool')) return reply('Sent.');
    const grant = JSON.parse(body.messages.find(message => message.role === 'user').content).authorizedCommands.grants[0];
    return { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'dependent-send', type: 'function',
      function: { name: 'workspace', arguments: JSON.stringify({ kind: 'send_prompt', grantId: grant.id, targetId: 'b' }) } }] } }] };
  };
}

test('a failed agent turn observed before finalization stays failed and cannot unlock a dependency', async t => {
  const f = await fixture(t);
  completeDuringDispatch(f, 'failed');
  const first = await f.app.send({ text: 'Review changes', origin: 'text', targetId: 'a' });
  const task = f.app.getState().tasks.find(item => item.requestId === first.requestId);
  assert.equal(task.status, 'failed');
  assert.match(task.error, /Immediate agent failure/);
  assert.ok(f.reports(first.requestId).some(report => report.status === 'failed'));
  dependOn(f, first.requestId);
  const dependent = await f.app.send({ text: 'Apply those findings after the review succeeds', origin: 'text', targetId: 'b' });
  assert.equal(dependent.ok, false);
  assert.equal(f.app.getState().tasks.find(item => item.requestId === dependent.requestId).status, 'paused');
  assert.deepEqual(f.effects.map(action => action.targetId), ['a']);
});

test('a successful turn observed before finalization supplies its exact result to a dependency', async t => {
  const f = await fixture(t);
  completeDuringDispatch(f, 'completed');
  const first = await f.app.send({ text: 'Review changes', origin: 'text', targetId: 'a' });
  assert.equal(f.app.getState().tasks.find(item => item.requestId === first.requestId).status, 'finished');
  f.read = id => ({ ok: true, completedResult: { turnId: f.sessions.find(item => item.id === id).turnId, text: 'Verified review finding.' } });
  dependOn(f, first.requestId);
  const dependent = await f.app.send({ text: 'Apply those findings after the review succeeds', origin: 'text', targetId: 'b' });
  assert.equal(dependent.ok, true, JSON.stringify(dependent));
  assert.deepEqual(f.effects.map(action => action.targetId), ['a', 'b']);
  assert.ok(f.models.some(body => body.messages.some(message => message.role === 'user' && message.content.includes('Verified review finding.'))));
});

test('a finished control request without a tracked result cannot unlock a result dependency', async t => {
  const f = await fixture(t);
  f.plan = () => ({ goal: 'Focus a', executionMode: 'direct', actions: [{ kind: 'focus_session', targetIds: ['a'] }] });
  const first = await f.app.send({ text: 'Focus a', origin: 'text' });
  assert.equal(f.app.getState().tasks.find(item => item.requestId === first.requestId).status, 'finished');
  dependOn(f, first.requestId);
  const dependent = await f.app.send({ text: 'Apply findings from that result', origin: 'text', targetId: 'b' });
  assert.equal(dependent.ok, false);
  assert.match(dependent.error, /no verified task result/);
  assert.equal(f.effects.filter(action => action.kind === 'send_prompt').length, 0);
});

test('restored finished history cannot supply a live result dependency', async t => {
  const f = await fixture(t, { restoredTasks: [{ requestId: 'saved-review', text: 'Review changes', status: 'finished', sequence: 1, updatedAt: Date.now(), targetIds: [], targets: [], dependsOn: [] }] });
  dependOn(f, 'saved-review');
  const dependent = await f.app.send({ text: 'Apply those saved review findings', origin: 'text', targetId: 'b' });
  assert.equal(dependent.ok, false);
  assert.match(dependent.error, /no verified task result/);
  assert.equal(f.effects.length, 0);
});


function savedWorkItem(f, requestId, status) {
  return f.commits.waitFor(item => item.requestIds.includes(requestId) && item.status === status, `${requestId}: ${status}`);
}
for (const ending of ['completed', 'failed']) test(`explicit ${ending} updates persisted history and clears its waiting reason`, async t => {
  const f = await fixture(t);
  const first = await f.app.send({ text: 'Review changes', origin: 'text', targetId: 'a' });
  await savedWorkItem(f, first.requestId, 'waiting-results');
  await f.finish('a', ending);
  const task = f.app.getState().tasks.find(item => item.requestId === first.requestId);
  const status = ending === 'completed' ? 'finished' : 'failed';
  assert.equal(task.status, status);
  assert.equal(task.waitingReason, undefined);
  const saved = await savedWorkItem(f, first.requestId, status);
  assert.match(saved.summary, ending === 'completed' ? /turn.*ended/ : /could not be verified as complete/);
  assert.doesNotMatch(saved.summary, /is running|result is still pending/);
  const stamp = saved.updatedAt;
  await f.app.refresh(); await f.app.refresh(); await f.app.dispose(); await f.commits.verifyDisk();
  assert.equal((await savedWorkItem(f, first.requestId, status)).updatedAt, stamp, 'Unchanged refreshes must not rewrite historical activity');
});

test('an explicit continuation replaces finished historical state with current running evidence', async t => {
  const f = await fixture(t);
  const first = await f.app.send({ text: 'Review changes', origin: 'text', targetId: 'a' });
  await f.finish('a');
  const saved = await savedWorkItem(f, first.requestId, 'finished');
  const second = await f.app.send({ text: 'Continue the review', origin: 'text', targetId: 'a', replyToRequestId: first.requestId });
  const active = await savedWorkItem(f, second.requestId, 'waiting-results');
  assert.equal(active.id, saved.id);
  assert.match(active.summary, /task is running/);
  assert.doesNotMatch(active.summary, /turn.*ended/);
  await f.finish('a');
  assert.match((await savedWorkItem(f, second.requestId, 'finished')).summary, /turn.*ended/);
  await f.app.dispose(); await f.commits.verifyDisk();
});

test('refresh does not resurrect work-item ownership or rewrite restored history', async t => {
  const at = Date.now() - 1000;
  const old = { id: 'saved-work', objective: 'Historical review', requestIds: ['saved-request'], status: 'waiting-results', summary: 'Historical result remains unverified.', createdAt: at, updatedAt: at, requiresRevalidation: false };
  const f = await fixture(t, { restoredTasks: [{ requestId: 'saved-request', text: 'Historical review', status: 'waiting-results', sequence: 1, updatedAt: at, targetIds: ['a'], dependsOn: [], workItemId: old.id }], restoredWorkItems: [old] });
  await f.app.refresh(); await f.app.refresh();
  await f.app.dispose();
  assert.equal(f.app.getState().tasks.find(task => task.requestId === 'saved-request').status, 'paused');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(f.sessions[0].cwd), 'orchestrator-work-items.json'), 'utf8')).items, [old]);
  assert.equal(f.effects.length, 0);
});
