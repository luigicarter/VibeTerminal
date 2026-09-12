'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commandCompleted } = require('../../backend/orchestratorCommandCompletion.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function example(kind = 'focus_session', status) {
  return { plan: { grants: [{ id: 'g', kind, targets: [{ id: 'a', generation: '1' }] }] },
    progress: { grants: [{ id: 'g', dispatched: true }] }, responseTurn: 'complete',
    outcomes: [{ kind, grantId: 'g', targetId: 'a', generation: '1', ok: true, status }], sessions: [{ id: 'a', generation: '1' }] };
}
test('only fully completed application effects receive an acknowledgment', () => {
  assert(commandCompleted(example()));
  for (const extra of [{ failed: true }, { question: {} }, { deferred: {} }, { unfinished: [{}] }, { responseTurn: 'listen' }, { responseTurn: 'dismiss' }]) assert.equal(commandCompleted({ ...example(), ...extra }), false);
  assert.equal(commandCompleted({ ...example(), plan: { grants: [] } }), false);
  assert.equal(commandCompleted(example('focus_session', 'invented-success')), false);
  assert.equal(commandCompleted(example('interrupt', 'requested')), false);
  assert(commandCompleted(example('interrupt', 'stopped')));
  assert(commandCompleted(example('stage_draft', 'staged')));
  assert.equal(commandCompleted(example('send_prompt', 'staged')), false);
  for (const status of ['queued', 'unknown', 'unconfirmed', 'write-failed']) assert.equal(commandCompleted(example('send_prompt', status)), false);
  const operator = example('operate_terminal'); operator.outcomes[0].kind = 'finish_terminal';
  assert.equal(commandCompleted(operator), false);
  operator.outcomes[0].status = 'interaction-complete'; assert(commandCompleted(operator));
  operator.outcomes.unshift({ kind: 'terminal_interact', grantId: 'g', targetId: 'a', ok: false });
  assert(commandCompleted(operator), 'existing caller failure recovery remains authoritative');
});

async function fixture(t, queued = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-command-done-'));
  const effects = [], spoken = [];
  const sessions = ['a', 'b'].map(id => ({ id, generation: '1', kind: 'fusion', name: id, cwd: root, turnState: 'idle' }));
  const app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => sessions, getRoots: () => ({ documents: root, projects: [] }),
    interpretIntent: () => ({ goal: 'Send both prompts', executionMode: 'direct', actions: [{ kind: 'send_prompt', targetIds: ['a', 'b'], selection: 'all', text: 'Review' }] }),
    dispatchAction: async action => { effects.push(action); return { ok: true, status: queued ? 'queued' : 'written' }; },
    onSpeak: event => { spoken.push(event); return { ok: true }; },
    fetch: async url => new Response(JSON.stringify(url.endsWith('/models') ? { data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] } : { data: {} })) });
  t.after(async () => { await app.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  await app.configure({ apiKey: 'fixture', model: 'fixture', sessionOnly: true }); await app.setEnabled(true);
  const deliver = async (index, ok = true) => {
    const action = effects[index];
    app.recordDelivery({ actionId: action.actionId, id: action.targetId, generation: '1', ok, status: ok ? 'written' : 'rejected', ...(ok ? {} : { error: 'Delivery rejected', delivery: 'not-dispatched' }) });
    await app.refresh(); await tick();
  };
  return { app, effects, spoken, sessions, deliver };
}
test('queued targets acknowledge only after both deliveries, once; later failure remains audible', async t => {
  const f = await fixture(t);
  const result = await f.app.send({ text: 'Send review to both terminals', origin: 'voice' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.text, /queued/);
  // One acknowledgment, and only after both deliveries. The delegated agent
  // result is still pending, so it reports the running task instead of cueing
  // completion.
  const acknowledgments = () => f.spoken.filter(event => Object.hasOwn(event, 'completionCue'));
  assert.equal(acknowledgments().length, 0);
  await f.deliver(0); assert.equal(acknowledgments().length, 0);
  await f.deliver(1); assert.equal(acknowledgments().length, 1);
  await f.app.refresh(); await tick(); assert.equal(acknowledgments().length, 1);
  assert.equal(acknowledgments()[0].completionCue, false);
  assert.match(acknowledgments()[0].speechText, /result is still pending/);
  assert.equal(f.app.getState().messages.filter(message => message.requestId === result.requestId && /result is still pending/.test(message.text)).length, 1);
  Object.assign(f.sessions[0], { processState: 'failed', turnState: 'failed' });
  await f.app.refresh(); await tick();
  assert(f.spoken.some(event => event.kind === 'task-report' && /failed|could not|stopped|unavailable|ended/i.test(event.text)));
});
test('failed queued delivery never becomes a completion acknowledgment', async t => {
  const f = await fixture(t);
  await f.app.send({ text: 'Send review to both terminals', origin: 'voice' });
  await f.deliver(0); await f.deliver(1, false);
  assert.equal(f.spoken.filter(event => event.completionCue).length, 0);
  assert(f.spoken.some(event => event.kind === 'task-report'));
});
test('cancelled queued command never emits a late acknowledgment', async t => {
  const f = await fixture(t);
  const result = await f.app.send({ text: 'Send review to both terminals', origin: 'voice' });
  await f.app.cancel({ requestId: result.requestId });
  await f.deliver(0); await f.deliver(1);
  assert.equal(f.spoken.filter(event => event.completionCue).length, 0);
});
