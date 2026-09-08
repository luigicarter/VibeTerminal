'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { createTaskScheduler } = require('../../backend/orchestratorTasks.cjs');
const { collectTaskReports } = require('../../backend/orchestratorTaskReports.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await tick(); }
  assert.fail('Expected task transition did not occur.');
}
const reply = content => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-task-reports-'));
  const f = { effects: [], speech: [], models: [], sessions: ['a', 'b'].map(id => ({ id, name: `Agent ${id}`, generation: 'g', kind: 'fusion', cwd: path.join(root, id), turnState: 'idle', status: 'idle' })) };
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

test('scheduler prompt plus Enter retain both waits but notify once for their attributed turn', () => {
  const tasks = createTaskScheduler({ now: () => 100 });
  const job = tasks.create({ text: 'Review changes', origin: 'text' });
  const baseline = { kind: 'codex', turnId: 'old', turnState: 'idle', submittedAt: 100 };
  tasks.track(job, { kind: 'send_prompt', actionId: 'prompt', targetId: 'a', generation: 'g' }, { ok: true, status: 'written' }, baseline);
  tasks.track(job, { kind: 'terminal_interact', operator: true, inputPurpose: 'task', actionId: 'enter', targetId: 'a', generation: 'g', keys: ['enter'] }, { ok: true, status: 'written' }, baseline);
  job.executionDone = true;
  tasks.update(job, { status: 'waiting-results' });
  const session = { id: 'a', name: 'Agent a', generation: 'g', kind: 'codex', turnId: 'new', turnState: 'running', turnStartedAt: 101 };
  tasks.reconcile([session]);
  assert.equal(job.waits.length, 2, 'execution waits remain independent');
  assert.deepEqual(job.waits.map(wait => wait.turnId), ['new', 'new']);
  assert.equal(collectTaskReports(job, [session]).length, 1);
  tasks.reconcile([session]);
  assert.deepEqual(collectTaskReports(job, [session]), []);
  session.turnState = 'completed';
  tasks.reconcile([session]);
  const reports = collectTaskReports(job, [session]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'completed');
  assert.equal(job.task.status, 'finished');
});

test('completion reports and speech remain request-owned with monitoring off and another prompt queued', async t => {
  const f = await fixture(t);
  const first = await f.app.send({ text: 'Review A', targetId: 'a', origin: 'voice' });
  const second = f.app.enqueue({ text: 'Next A', targetId: 'a', origin: 'text' });
  await until(() => f.app.getState().tasks.find(task => task.requestId === second.requestId)?.targets.length);
  assert.equal(f.effects.length, 1);
  assert.equal(f.app.getSettings().monitoringEnabled, false);
  await f.app.configure({ spendingLimit: 0 });
  await f.finish('a');
  assert.equal(f.reports(first.requestId).filter(report => report.status === 'completed').length, 1);
  const spoken = f.speech.filter(event => event.kind === 'task-report');
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].requestId, first.requestId);
  assert.equal(spoken[0].responseTurn, 'complete');
  assert.match(spoken[0].text, /turn completed.*not independently verified/);
  await f.app.refresh(); await tick();
  assert.equal(f.reports(first.requestId).filter(report => report.status === 'completed').length, 1);
  assert.equal(f.models.length, 0, 'outcome reporting requires no model request');
});

test('overlapping voice submission and watch keep both completion chats but speak each turn once', async t => {
  const f = await fixture(t);
  f.sessions[0].observation = 'observed';
  const submissionPlan = f.plan;
  const first = await f.app.send({ text: 'Review A', targetId: 'a', origin: 'voice' });
  f.plan = () => ({ goal: 'Watch A', executionMode: 'direct', actions: [{ kind: 'watch_terminal', targetIds: ['a'] }] });
  const watcher = await f.app.send({ text: 'Tell me when A finishes', targetId: 'a', origin: 'voice' });
  assert.equal(watcher.ok, true, JSON.stringify(watcher));
  assert.equal(f.effects.length, 1, 'watching does not dispatch another prompt');
  await f.finish('a');
  for (const request of [first, watcher]) {
    const reports = f.reports(request.requestId).filter(report => report.status === 'completed');
    assert.equal(reports.length, 1);
    assert.match(reports[0].text, /requested outcome is not independently verified/);
  }
  assert.equal(f.speech.filter(event => event.kind === 'task-report').length, 1);
  await f.app.refresh(); await tick();
  assert.equal(f.speech.filter(event => event.kind === 'task-report').length, 1);

  f.plan = submissionPlan;
  const next = await f.app.send({ text: 'Review A again', targetId: 'a', origin: 'voice' });
  await f.finish('a');
  const spoken = f.speech.filter(event => event.kind === 'task-report');
  assert.equal(spoken.length, 2);
  assert.equal(spoken[1].requestId, next.requestId);
});

test('text completion does not consume the automatic voice report for a matching watch', async t => {
  const f = await fixture(t);
  f.sessions[0].observation = 'observed';
  const first = await f.app.send({ text: 'Review A', targetId: 'a', origin: 'text' });
  f.plan = () => ({ goal: 'Watch A', executionMode: 'direct', actions: [{ kind: 'watch_terminal', targetIds: ['a'] }] });
  const watcher = await f.app.send({ text: 'Tell me when A finishes', targetId: 'a', origin: 'voice' });
  assert.equal(watcher.ok, true, JSON.stringify(watcher));
  await f.finish('a');
  assert.equal(f.reports(first.requestId).filter(report => report.status === 'completed').length, 1);
  assert.equal(f.reports(watcher.requestId).filter(report => report.status === 'completed').length, 1);
  const spoken = f.speech.filter(event => event.kind === 'task-report');
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].requestId, watcher.requestId);
});

test('overlapping voice requests retain result detail chats but speak matching result evidence once', async t => {
  const f = await fixture(t);
  f.sessions[0].observation = 'observed';
  const first = await f.app.send({ text: 'Review A', targetId: 'a', origin: 'voice' });
  f.plan = () => ({ goal: 'Watch A', executionMode: 'direct', actions: [{ kind: 'watch_terminal', targetIds: ['a'] }] });
  const watcher = await f.app.send({ text: 'Tell me what A did', targetId: 'a', origin: 'voice' });
  assert.equal(watcher.ok, true, JSON.stringify(watcher));
  f.respond = () => reply('The agent reported correcting validation and passing twelve tests.');
  const session = f.sessions[0];
  Object.assign(session, { turnState: 'completed', completedTurnId: session.turnId, completedActionId: session.actionId, turnEndedAt: Date.now() });
  f.app.observeWork([session], { turnId: session.turnId, status: 'completed', at: session.turnEndedAt, source: 'chat-events', text: 'Corrected validation. Twelve tests passed.' });
  const resultDetails = () => f.app.getState().messages.filter(message => message.origin === 'task-detail' && /correcting validation/.test(message.text));
  await until(() => resultDetails().length === 2);
  await tick();
  assert.deepEqual(new Set(resultDetails().map(message => message.requestId)), new Set([first.requestId, watcher.requestId]));
  assert.equal(f.speech.filter(event => event.kind === 'task-result').length, 1);
  assert.equal(f.speech.filter(event => event.kind === 'task-report').length, 1);
});

test('one target failure is reported immediately while its sibling is still running', async t => {
  const f = await fixture(t);
  f.plan = () => ({ goal: 'Review both', executionMode: 'direct', actions: [{ kind: 'send_prompt', targetIds: ['a', 'b'], selection: 'all', text: 'Review changes' }] });
  const request = await f.app.send({ text: 'Review both', origin: 'voice' });
  f.sessions[0].error = 'Provider failed with fixture-secret';
  await f.finish('a', 'failed');
  assert.equal(f.app.getState().tasks.find(task => task.requestId === request.requestId).status, 'waiting-results');
  assert.equal(f.reports(request.requestId).filter(report => report.status === 'failed').length, 1);
  assert.ok(!JSON.stringify(f.app.getState()).includes('fixture-secret'));
  assert.ok(!JSON.stringify(f.speech).includes('fixture-secret'));
  await f.finish('b');
  assert.equal(f.app.getState().tasks.find(task => task.requestId === request.requestId).status, 'failed');
  assert.match(f.reports(request.requestId).at(-1).text, /All requested terminal turns have ended/);
});

test('late delivery failure and terminal replacement produce issues rather than success reports', async t => {
  const f = await fixture(t); f.dispatch = () => ({ ok: true, status: 'queued' });
  const first = await f.app.send({ text: 'Queue A', targetId: 'a', origin: 'text' });
  f.app.recordDelivery({ actionId: f.effects[0].actionId, id: 'a', generation: 'g', ok: false, status: 'blocked', delivery: 'not-dispatched', error: 'Delivery queue expired.' });
  await tick();
  assert.equal(f.reports(first.requestId).at(-1).status, 'failed');
  assert.match(f.reports(first.requestId).at(-1).text, /Delivery queue expired/);
  f.dispatch = null;
  const second = await f.app.send({ text: 'Work B', targetId: 'b', origin: 'text' });
  f.sessions[1].generation = 'replacement';
  await f.app.refresh(); await tick();
  assert.match(f.reports(second.requestId).at(-1).text, /terminal changed.*unverified/);
  assert.ok(!f.reports().some(report => report.status === 'completed'));
});

test('cancelled requests do not notify or speak late completions', async t => {
  const f = await fixture(t);
  const first = await f.app.send({ text: 'Review A', targetId: 'a', origin: 'voice' });
  await f.app.cancel({ requestId: first.requestId });
  const before = f.reports(first.requestId).length;
  await f.finish('a');
  assert.equal(f.reports(first.requestId).length, before);
  assert.equal(f.speech.filter(event => event.kind === 'task-report').length, 0);
});

test('completion text is not held behind an earlier voice reply waiting for playback', async t => {
  const f = await fixture(t);
  let finishSpeech;
  f.speak = event => event.kind === 'task-report' ? { ok: true } : new Promise(resolve => { finishSpeech = resolve; });
  const sending = f.app.send({ text: 'Review A', targetId: 'a', origin: 'voice' });
  await until(() => finishSpeech);
  try {
    await f.finish('a');
    assert.equal(f.reports().filter(report => report.status === 'completed').length, 1);
  } finally { finishSpeech({ ok: true }); await sending; }
  await f.app.refresh(); await tick();
  assert.equal(f.reports().filter(report => report.status === 'completed').length, 1);
});

test('input blockers post chat without queueing stale generic speech behind a native question', async t => {
  const f = await fixture(t);
  const request = await f.app.send({ text: 'Review A', targetId: 'a', origin: 'voice' });
  f.sessions[0].turnState = 'waiting';
  await f.app.refresh(); await tick();
  assert.equal(f.reports(request.requestId).filter(report => report.status === 'needs-answer').length, 1);
  assert.equal(f.speech.filter(event => event.kind === 'task-report').length, 0);
});

test('unchanged inventories warn once if accepted input never gains start evidence', async t => {
  const f = await fixture(t); f.now = Date.now();
  f.dispatch = () => ({ ok: true, status: 'written' });
  const request = await f.app.send({ text: 'Review A', targetId: 'a', origin: 'text' });
  assert.equal(f.reports(request.requestId).length, 0);
  f.now += 60000;
  await f.app.refresh(); await tick();
  assert.match(f.reports(request.requestId).at(-1).text, /could not confirm that the agent started/);
  await f.app.refresh(); await tick();
  assert.equal(f.reports(request.requestId).length, 1);
  assert.equal(f.app.getState().tasks.find(task => task.requestId === request.requestId).status, 'waiting-results');
  assert.equal(f.effects.length, 1);
});

test('ambiguous results report uncertainty and do not unlock a dependent prompt', async t => {
  const f = await fixture(t);
  const first = await f.app.send({ text: 'Review A', targetId: 'a', origin: 'text' });
  f.plan = () => ({ goal: 'Fix findings', dependsOnRequestIds: [first.requestId], actions: [{ kind: 'send_prompt', targetIds: ['b'], text: 'Fix findings' }] });
  const second = f.app.enqueue({ text: 'Fix findings', targetId: 'b', origin: 'text' });
  await until(() => f.app.getState().tasks.find(task => task.requestId === second.requestId)?.targets.length);
  f.sessions[0].completionAttribution = 'ambiguous';
  await f.finish('a');
  assert.match(f.reports(first.requestId).at(-1).text, /could not reliably match/);
  assert.equal(f.effects.length, 1);
  assert.equal(f.app.getState().tasks.find(task => task.requestId === first.requestId).status, 'waiting-results');
  assert.ok(!f.reports(first.requestId).some(report => report.status === 'completed'));
});

test('an observed turn end is reported before a newer human turn replaces the inventory', async t => {
  const f = await fixture(t);
  const first = await f.app.send({ text: 'Review A', targetId: 'a', origin: 'text' });
  const sibling = await f.app.send({ text: 'Review B', targetId: 'b', origin: 'text' });
  const ended = { ...f.sessions[0], observation: 'observed', turnState: 'completed', turnEndedAt: Date.now(), completedTurnId: f.sessions[0].turnId, completedActionId: f.sessions[0].actionId };
  f.app.observeWork([{ ...ended, observation: 'provisional' }]);
  assert.equal(f.reports(first.requestId).filter(report => report.status === 'completed').length, 0);
  f.app.observeWork([ended]);
  Object.assign(f.sessions[0], { turnId: 'new-human-turn', turnState: 'running', actionId: undefined, turnStartedAt: Date.now() + 1 });
  await f.app.refresh(); await tick();
  assert.equal(f.reports(first.requestId).filter(report => report.status === 'completed').length, 1);
  assert.equal(f.app.getState().tasks.find(task => task.requestId === first.requestId).status, 'finished');
  assert.equal(f.app.getState().tasks.find(task => task.requestId === sibling.requestId).status, 'waiting-results');
  assert.equal(f.app.getState().sessions.find(session => session.id === 'a').turnId, 'new-human-turn');
  f.app.observeWork([ended]);
  assert.equal(f.reports(first.requestId).filter(report => report.status === 'completed').length, 1);
});

test('queued prompts do not starve optional model lookups, and turn-only changes trigger monitoring', async t => {
  const f = await fixture(t);
  await f.app.send({ text: 'Review A', targetId: 'a', origin: 'text' });
  const second = f.app.enqueue({ text: 'Next A', targetId: 'a', origin: 'text' });
  await until(() => f.app.getState().tasks.find(task => task.requestId === second.requestId)?.targets.length);
  assert.equal(f.app.getState().busy, true);
  await f.app.configure({ monitoringEnabled: true });
  await f.app.refresh({ monitor: true });
  assert.equal(f.models.length, 1);
  assert.equal(JSON.parse(f.models[0].messages[1].content).observations[0].turnState, 'running');
  f.sessions[0].turnState = 'waiting';
  await f.app.refresh({ monitor: true });
  assert.equal(f.models.filter(body => JSON.parse(body.messages[1].content).observations).length, 2, 'turn state changes need no output timestamp change');
  assert.ok(f.models.some(body => JSON.parse(body.messages[1].content).observation?.status === 'waiting'), 'blocker gets a separate read-only progress report');
  assert.equal(f.reports().filter(report => report.status === 'needs-answer').length, 1);
});

test('failed reads and clipped model replies leave changed observations available for another lookup', async t => {
  const f = await fixture(t); f.sessions.splice(1);
  await f.app.configure({ monitoringEnabled: true });
  f.read = () => ({ ok: false, error: 'Decoder temporarily unavailable.' });
  await f.app.refresh({ monitor: true });
  assert.equal(f.models.length, 0);
  f.read = () => ({ ok: true, text: 'Finished output.' });
  f.respond = () => ({ choices: [{ finish_reason: 'length', message: { content: 'The task has' } }] });
  await f.app.refresh({ monitor: true });
  assert.equal(f.models.length, 1);
  assert.equal(f.app.getState().messages.length, 0);
  f.respond = () => reply('The agent reported a result.');
  await f.app.refresh({ monitor: true });
  await f.app.refresh({ monitor: true });
  assert.equal(f.models.length, 2);
  assert.equal(f.app.getState().messages.length, 1);
});
