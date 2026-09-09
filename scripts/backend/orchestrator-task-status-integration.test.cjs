'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
let callId = 0;
const calls = (...actions) => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: actions.map(action => ({ id: `status-${++callId}`, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(action) } })) } }] });

async function fixture(t, { started = false, priorCompleted = false, finishRespond = false, statusTurn = 'complete', askUser = false,
  ordinary = false, sameBatch = false, delivery = { ok: true, status: 'written' } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-task-status-'));
  const effects = [], requests = [];
  const session = { id: 'pane', generation: 'g1', name: 'Codex', kind: 'codex', provider: 'codex', cwd: root,
    status: 'running', started: true, processState: 'running', agentProcessState: 'running', agentPid: 1234, observation: 'observed',
    turnState: priorCompleted ? 'completed' : 'idle', ...(priorCompleted && { turnId: 'prior-turn', turnStartedAt: 10, turnEndedAt: 20, completedTurnId: 'prior-turn' }) };
  const sessions = [session];
  let mode = 'submit', round = 0;
  const app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false }, now: () => 1000,
    getSessions: () => sessions, getRoots: () => ({ documents: root, projects: [root] }),
    interpretIntent: async context => mode === 'submit'
      ? { goal: 'Fix bubble labels.', executionMode: 'reason', actions: [{ kind: ordinary ? 'send_prompt' : 'operate_terminal', targetIds: ['pane'], text: 'Fix bubble labels.', ...(!ordinary && { answerMode: 'delegated', permissionMode: 'none' }) }] }
      : { goal: mode === 'status' ? 'Check whether that task started.' : 'Explain the output.', actions: [], ...(mode === 'status' && { responseKind: 'task-status', statusTargetIds: ['pane'], ...(context.replyContext?.requestId && { statusRequestId: context.replyContext.requestId }) }) },
    readSession: async () => ({ ok: true, id: 'pane', generation: 'g1', text: session.turnState === 'running' ? 'Working on bubble labels.' : 'Fix bubble labels. [draft still in composer]', sequence: 10, inputRevision: 2 }),
    dispatchAction: async action => {
      effects.push(action);
      if (started) Object.assign(session, { turnId: 'new-turn', turnStartedAt: 1000, turnState: 'running', actionId: action.actionId });
      return delivery;
    },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] }));
      assert(url.endsWith('/chat/completions'));
      const body = JSON.parse(options.body); requests.push(body); round++;
      if (mode !== 'submit') {
        if (round % 2 === 1 && sessions.some(item => item.id === 'pane' && item.generation === 'g1')) return new Response(JSON.stringify(calls({ kind: 'read_session', targetId: 'pane' })));
        return new Response(JSON.stringify(calls(askUser ? { kind: 'ask_user', text: 'Which task do you mean?' } : { kind: 'respond', text: mode === 'status' ? 'Yes, it accepted the task and is running. Anything else?' : 'The output contains the requested bubble-label text.', responseTurn: statusTurn })));
      }
      if (ordinary) {
        const grant = JSON.parse(body.messages.find(message => message.role === 'user').content).authorizedCommands.grants[0];
        const respond = { kind: 'respond', text: 'The agent accepted the task and is definitely running.', responseTurn: 'complete' };
        if (round === 1) return new Response(JSON.stringify(calls({ kind: 'send_prompt', grantId: grant.id, targetId: 'pane' }, ...(sameBatch ? [respond] : []))));
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: respond.text } }] }));
      }
      if (round === 1 || round === 3) return new Response(JSON.stringify(calls({ kind: 'read_session', targetId: 'pane' })));
      const grant = JSON.parse(body.messages.find(message => message.role === 'user').content).authorizedCommands.grants[0];
      const observed = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
      const action = { kind: round === 2 ? 'send_prompt' : 'finish_terminal', grantId: grant.id, targetId: 'pane', stepId: `step-${round}`, observationToken: observed.observationToken,
        ...(round === 2 ? { text: 'Fix bubble labels.' } : { outcome: 'completed', text: 'The bubble-label task was accepted and is running.' }) };
      assert(round === 2 || round === 4, 'Completed operator must not need another model turn');
      return new Response(JSON.stringify(finishRespond && round === 4 ? calls(action, { kind: 'respond', text: 'It is definitely running.', responseTurn: 'complete' }) : calls(action)));
    }
  });
  t.after(async () => { await app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal((await app.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true })).ok, true);
  assert.equal((await app.setEnabled(true)).ok, true);
  return { app, session, effects, requests, closePane() { sessions.length = 0; }, replacePane() { sessions[0] = { ...session, generation: 'g2', name: 'Replacement', cwd: path.join(root, 'replacement') }; }, setMode(value) { mode = value; round = 0; } };
}

for (const replacement of [false, true]) test(`status of a submitted task remains read-only after its pane ${replacement ? 'is replaced' : 'closes'}`, async t => {
  const f = await fixture(t);
  const sent = await f.app.send({ text: 'Send the bubble-label task to Codex.', origin: 'text' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  if (replacement) f.replacePane(); else f.closePane();
  await f.app.refresh();
  f.setMode('status');
  const status = await f.app.send({ text: 'Did that task finish?', origin: 'text', replyToRequestId: sent.requestId });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.match(status.text, /terminal.*changed.*unverified/i);
  assert.match(status.text, /Codex/);
  assert.equal(f.effects.length, 1, 'Historical status never resubmits work');
  const task = f.app.getState().tasks.find(task => task.requestId === status.requestId);
  assert.deepEqual(task.targetIds, ['pane']);
  assert.equal(task.targets[0].generation, 'g1');
  assert.equal(task.targets[0].name, 'Codex');
  assert.equal(task.targets[0].cwd, f.session.cwd);
});

test('plain current status without any earlier submission is read-only and reports missing evidence', async t => {
  const f = await fixture(t);
  f.setMode('status');
  const result = await f.app.send({ text: 'Is Codex running my task?', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.text, /don't have a tracked task/);
  assert.equal(f.effects.length, 0);
});

for (const priorCompleted of [false, true]) test(`written input with live idle agent${priorCompleted ? ' and prior completed turn' : ''} cannot become running in finish or status follow-up`, async t => {
  const f = await fixture(t, { priorCompleted, finishRespond: true });
  const sent = await f.app.send({ text: 'Send the bubble-label task to Codex.', origin: 'text' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.text, 'done');
  assert.doesNotMatch(sent.text, /accepted|is running|task.*ended/);
  const finish = f.app.getState().receipts.find(receipt => receipt.kind === 'finish_terminal');
  assert.match(finish.text, /haven't confirmed that the task started/);
  f.setMode('status');
  const status = await f.app.send({ text: 'Did it really start?', origin: 'text', replyToRequestId: sent.requestId });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.match(status.text, /haven't confirmed that the task started/);
  assert.doesNotMatch(status.text, /accepted|is running/);
  assert.equal(f.effects.length, 1, 'Read-only status never replays the input');
  const projection = JSON.parse(f.requests.at(-1).messages.find(message => message.role === 'user').content).authorizedCommands;
  assert.equal(projection.responseKind, 'task-status');
  assert.deepEqual(projection.statusTargets, [{ id: 'pane', generation: 'g1', name: 'Codex' }]);
  f.setMode('explain');
  const explanation = await f.app.send({ text: 'Explain that output.', origin: 'text' });
  assert.equal(explanation.text, 'The output contains the requested bubble-label text.');
  Object.assign(f.session, { turnId: 'later-turn', turnStartedAt: 1000, turnState: 'running', actionId: f.effects[0].actionId });
  f.setMode('status');
  const running = await f.app.send({ text: 'Has that task started now?', origin: 'text', replyToRequestId: status.requestId });
  assert.match(running.text, /task is running/);
  assert.equal(f.effects.length, 1, 'New evidence changes status without another input write');
});

for (const sameBatch of [false, true]) for (const delivery of [
  { ok: true, status: 'written' },
  { ok: true, status: 'unknown' },
  { ok: false, status: 'write-failed', error: 'Transport unavailable.' }
]) test(`ordinary reason-mode submission (${delivery.status}, ${sameBatch ? 'same-batch respond' : 'raw final'}) cannot invent acceptance`, async t => {
  const f = await fixture(t, { ordinary: true, sameBatch, delivery });
  const sent = await f.app.send({ text: 'Send the bubble-label task to Codex.', origin: 'text' });
  assert.equal(f.effects.length, 1, JSON.stringify(sent));
  assert.doesNotMatch(sent.text, /accepted|definitely running/);
  assert.match(sent.text, delivery.status === 'written' ? /^done$/ : /couldn't confirm|could not be verified|Transport unavailable/);
});

test('new attributed turn acknowledges the command and retains running evidence in status responses', async t => {
  const f = await fixture(t, { started: true, priorCompleted: true });
  const sent = await f.app.send({ text: 'Send the bubble-label task to Codex.', origin: 'text' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.text, 'done');
  f.setMode('status');
  const status = await f.app.send({ text: 'Did it start?', origin: 'text', replyToRequestId: sent.requestId });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.match(status.text, /task is running/);
  assert.equal(f.effects.length, 1);
});

for (const statusTurn of ['listen', 'dismiss']) test(`task-status respond ${statusTurn} cannot bypass evidence or create a spurious question`, async t => {
  const f = await fixture(t, { statusTurn });
  const sent = await f.app.send({ text: 'Send the bubble-label task to Codex.', origin: 'text' });
  f.setMode('status');
  const status = await f.app.send({ text: 'Did it start?', origin: 'text', replyToRequestId: sent.requestId });
  assert.match(status.text, /haven't confirmed that the task started/);
  assert.equal(status.responseTurn, statusTurn === 'dismiss' ? 'dismiss' : 'complete');
  assert.equal(f.app.getState().tasks.find(task => task.requestId === status.requestId).question, undefined);
});

test('explicit ask_user retains necessary status clarification', async t => {
  const f = await fixture(t, { askUser: true });
  const sent = await f.app.send({ text: 'Send the bubble-label task to Codex.', origin: 'text' });
  f.setMode('status');
  const status = await f.app.send({ text: 'Did it start?', origin: 'text', replyToRequestId: sent.requestId });
  assert.equal(status.text, 'Which task do you mean?');
  assert.equal(status.responseTurn, 'listen');
});
