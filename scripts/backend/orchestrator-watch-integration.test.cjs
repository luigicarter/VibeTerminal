'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 400; i++) { if (predicate()) return; await tick(); } assert.fail('Expected watch transition did not occur.'); }
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-watch-integration-'));
  const f = { effects: [], modelCalls: [], spoken: [], results: new Map(),
    sessions: ['a', 'b'].map(id => ({ id, generation: 'g', kind: 'fusion', name: `Agent ${id}`, cwd: path.join(root, id), observation: 'observed', status: 'running', turnState: 'running', turnId: `turn-${id}`, turnStartedAt: Date.now() - 1000 })) };
  f.plan = context => ({ goal: context.instruction, executionMode: 'direct', actions: [{ kind: 'watch_terminal', targetIds: [context.targetId || 'a'] }] });
  f.app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => f.sessions, getRoots: () => ({ documents: root, projects: [] }), interpretIntent: context => f.plan(context),
    readSession: async query => f.read ? f.read(query) : { ok: true, generation: query.generation, turnId: f.sessions.find(item => item.id === query.id)?.turnId, text: 'Agent: inspected the routes and is running unit tests.', completedResult: f.results.get(query.completedTurnId) },
    dispatchAction: async action => { f.effects.push(action); return { ok: true, status: 'written' }; },
    onSpeak: async event => { f.spoken.push(event); return { ok: true }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'brain', context_length: 128000, supported_parameters: ['tools'] }] }));
      const body = JSON.parse(options.body); f.modelCalls.push(body);
      const value = f.reply ? await f.reply(body) : body.messages[0].content.startsWith('Describe') ? 'The agent reports inspecting routes; unit tests are still running.' : 'The agent reported fixing route validation and passing 12 tests; deployment remains pending.';
      return new Response(JSON.stringify(typeof value === 'string' ? { choices: [{ finish_reason: 'stop', message: { content: value } }] } : value));
    } });
  await f.app.configure({ apiKey: 'watch-fixture-secret', sessionOnly: true, model: 'brain' });
  assert.equal((await f.app.setEnabled(true)).ok, true);
  f.details = requestId => f.app.getState().messages.filter(item => item.origin === 'task-detail' && (!requestId || item.requestId === requestId));
  f.reports = requestId => f.app.getState().messages.filter(item => item.origin === 'task' && (!requestId || item.requestId === requestId));
  f.end = (id, text = 'Fixed route validation. 12 tests passed. Deployment pending.', status = 'completed') => {
    const session = f.sessions.find(item => item.id === id);
    Object.assign(session, { turnState: status, status, turnEndedAt: Date.now(), completedTurnId: session.turnId });
    const result = { turnId: session.turnId, status, at: session.turnEndedAt, source: 'chat-events', text };
    f.results.set(session.turnId, result); f.app.observeWork([session], result); return { ...session };
  };
  t.after(async () => {
    await f.app.dispose();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('vibe-watch-integration-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}

test('watch existing work, retain written results and acknowledge completion with request-owned speech', async t => {
  const f = await fixture(t);
  const response = await f.app.send({ text: 'Watch Agent a and tell me when it finishes and what it did.', targetId: 'a', origin: 'voice' });
  assert.equal(response.ok, true, JSON.stringify(response)); assert.match(response.text, /watching Agent a/);
  await until(() => f.details(response.requestId).some(item => /still running/.test(item.text)));
  assert.equal(f.effects.length, 0);
  f.end('a');
  await until(() => f.details(response.requestId).some(item => /12 tests/.test(item.text)));
  assert.equal(f.reports(response.requestId).filter(item => item.status === 'completed').length, 1);
  assert.equal(f.reports(response.requestId).find(item => item.status === 'completed').reportKind, 'lifecycle');
  assert.equal(f.details(response.requestId).find(item => /12 tests/.test(item.text)).reportKind, 'result');
  assert.equal(f.app.getState().tasks.find(item => item.requestId === response.requestId).status, 'finished');
  await until(() => f.spoken.some(item => item.completionCue));
  assert.equal(f.spoken.find(item => item.completionCue).requestId, response.requestId);
  assert.equal(f.spoken.filter(item => item.kind === 'task-result').length, 0);
  assert.ok(f.modelCalls.every(body => body.tools === undefined), 'detail models have no action tools');
  await f.app.refresh(); await tick();
  assert.equal(f.details(response.requestId).filter(item => /12 tests/.test(item.text)).length, 1);
});

test('delayed result evidence enriches completion once and never reads a newer turn as the result', async t => {
  const f = await fixture(t);
  const response = await f.app.send({ text: 'Tell me when a is done.', targetId: 'a', origin: 'text' });
  await until(() => f.details(response.requestId).length);
  const ended = { ...f.sessions[0], turnState: 'completed', turnEndedAt: Date.now() };
  f.app.observeWork([ended]);
  await until(() => f.details(response.requestId).some(item => /no reliable result details/.test(item.text)));
  assert.equal(f.details(response.requestId).find(item => /no reliable result details/.test(item.text)).reportKind, 'result-unavailable');
  Object.assign(f.sessions[0], { turnId: 'new-human-turn', turnState: 'running' });
  await f.app.refresh();
  const result = { turnId: ended.turnId, at: ended.turnEndedAt, status: 'completed', source: 'chat-events', text: 'Fixed route validation. 12 tests passed. Deployment pending.' };
  f.app.observeWork([ended], result); f.app.observeWork([ended], result);
  await until(() => f.details(response.requestId).some(item => /12 tests/.test(item.text)));
  assert.equal(f.modelCalls.filter(body => body.messages[0].content.startsWith('Summarize')).length, 1);
  assert.equal(f.app.getState().sessions[0].turnId, 'new-human-turn'); assert.equal(f.effects.length, 0);
});

test('validated cached results still summarize after the ending-snapshot cache has rotated', async t => {
  const f = await fixture(t); const releases = [];
  f.reply = body => body.messages[0].content.startsWith('Describe') ? new Promise(resolve => releases.push(resolve)) : 'The agent reported 12 tests passed.';
  const response = await f.app.send({ text: 'Watch a.', targetId: 'a', origin: 'text' });
  await f.app.send({ text: 'Watch b.', targetId: 'b', origin: 'text' });
  await until(() => releases.length === 2);
  const ended = f.end('a');
  Object.assign(f.sessions[0], { turnId: 'new-human-turn', turnState: 'running' });
  for (let i = 0; i < 201; i++) f.app.observeWork([{ ...ended, id: `unwatched-${i}`, turnId: `unwatched-turn-${i}` }]);
  releases.forEach(resolve => resolve('NO_UPDATE'));
  await until(() => f.details(response.requestId).some(item => /12 tests passed/.test(item.text)));
  assert.equal(f.modelCalls.filter(body => body.messages[0].content.startsWith('Summarize')).length, 1);
});

test('model failure preserves completion and falls back to an attributed structured excerpt', async t => {
  const f = await fixture(t);
  f.reply = body => { if (body.messages[0].content.startsWith('Summarize')) throw new Error('Fixture model unavailable.'); return 'NO_UPDATE'; };
  const response = await f.app.send({ text: 'Watch a.', targetId: 'a', origin: 'voice' });
  f.end('a', 'Changed the parser; 7 checks passed. watch-fixture-secret');
  await until(() => f.details(response.requestId).some(item => /Agent output excerpt/.test(item.text)));
  assert.match(f.details(response.requestId).at(-1).text, /7 checks passed/);
  assert.ok(!JSON.stringify(f.app.getState()).includes('watch-fixture-secret'));
  assert.ok(!JSON.stringify(f.modelCalls).includes('watch-fixture-secret'));
  assert.equal(f.effects.length, 0);
  await until(() => f.spoken.some(item => item.completionCue));
  assert.equal(f.spoken.find(item => item.completionCue).speechText, 'done');
  assert.equal(f.spoken.filter(item => item.kind === 'task-result').length, 0);
});

test('written model result keeps full detail without speaking a recap after completion', async t => {
  const f = await fixture(t);
  const verbose = 'The agent described the outcome and outstanding checks. '.repeat(90).trim();
  f.reply = body => body.messages[0].content.startsWith('Summarize') ? verbose : 'NO_UPDATE';
  const response = await f.app.send({ text: 'Watch a.', targetId: 'a', origin: 'voice' });
  f.end('a');
  await until(() => f.details(response.requestId).some(item => item.text.includes(verbose.trim())));
  assert.equal(f.spoken.filter(item => item.kind === 'task-result').length, 0);
  assert.ok(f.details(response.requestId).some(item => item.text.includes(verbose.trim())));
  assert.equal(f.modelCalls.filter(body => body.messages[0].content.startsWith('Summarize')).length, 1);
});

test('a pending summary is cancelled even after the watched task finished', async t => {
  const f = await fixture(t); let release;
  f.reply = body => body.messages[0].content.startsWith('Summarize') ? new Promise(resolve => { release = resolve; }) : 'NO_UPDATE';
  const response = await f.app.send({ text: 'Watch a.', targetId: 'a', origin: 'voice' });
  f.end('a'); await until(() => release);
  await f.app.cancel({ requestId: response.requestId }); release('Obsolete summary.'); await tick(); await tick();
  assert.ok(!f.details(response.requestId).some(item => /Obsolete/.test(item.text)));
  assert.ok(!f.spoken.some(item => item.kind === 'task-result'));
});

test('progress details are discarded when a blocker resolves during summarization', async t => {
  const f = await fixture(t); let release;
  f.reply = body => JSON.parse(body.messages[1].content).observation?.status === 'waiting' ? new Promise(resolve => { release = resolve; }) : 'NO_UPDATE';
  const response = await f.app.send({ text: 'Watch a.', targetId: 'a', origin: 'text' });
  f.sessions[0].turnState = 'waiting'; await f.app.refresh(); await until(() => release);
  f.sessions[0].turnState = 'running'; await f.app.refresh(); release('Needs an obsolete answer.'); await tick(); await tick();
  assert.ok(!f.details(response.requestId).some(item => /obsolete/.test(item.text)));
  assert.equal(f.effects.length, 0);
});

test('a replaced generation or turn returned by a live read cannot supply progress details', async t => {
  for (const mismatch of [{ generation: 'replacement', turnId: 'turn-a' }, { generation: 'g', turnId: 'new-task' }]) {
    const f = await fixture(t);
    f.read = async () => ({ ok: true, text: 'Unrelated completed work.', ...mismatch });
    const response = await f.app.send({ text: 'Watch a.', targetId: 'a', origin: 'text' });
    await tick(); await tick();
    assert.equal(f.modelCalls.length, 0); assert.equal(f.details(response.requestId).length, 0);
  }
});

test('a later blockage in the same turn cannot receive the earlier blockage summary', async t => {
  const f = await fixture(t); const releases = [];
  f.reply = body => JSON.parse(body.messages[1].content).observation?.status === 'waiting' ? new Promise(resolve => releases.push(resolve)) : 'NO_UPDATE';
  const response = await f.app.send({ text: 'Watch a.', targetId: 'a', origin: 'text' });
  f.sessions[0].turnState = 'waiting'; await f.app.refresh(); await until(() => releases.length === 1);
  f.sessions[0].turnState = 'running'; await f.app.refresh();
  f.sessions[0].turnState = 'waiting'; await f.app.refresh();
  releases[0]('Old blocker that has been resolved.');
  await until(() => releases.length === 2); releases[1]('The agent reports a new blocker.');
  await until(() => f.details(response.requestId).some(item => /new blocker/.test(item.text)));
  assert.ok(!f.details(response.requestId).some(item => /Old blocker/.test(item.text)));
});

test('a watch reports resumed progress and the next blocker without repeating unchanged polls', async t => {
  const f = await fixture(t); f.reply = () => 'NO_UPDATE';
  const response = await f.app.send({ text: 'Watch a and report status changes.', targetId: 'a', origin: 'text' });
  await f.app.refresh(); await tick();
  assert.equal(f.reports(response.requestId).filter(item => item.status === 'running').length, 1);
  f.sessions[0].turnState = 'waiting'; await f.app.refresh(); await tick();
  f.sessions[0].turnState = 'running'; await f.app.refresh(); await tick();
  await f.app.refresh(); await tick();
  assert.equal(f.reports(response.requestId).filter(item => item.status === 'running').length, 2);
  f.sessions[0].turnState = 'waiting'; await f.app.refresh(); await tick();
  assert.equal(f.reports(response.requestId).filter(item => item.status === 'needs-answer').length, 2);
  assert.equal(f.effects.length, 0);
});

test('readiness after a real completed turn also receives its supported result details', async t => {
  const f = await fixture(t);
  f.plan = () => ({ goal: 'Notify when ready', executionMode: 'direct', actions: [{ kind: 'watch_terminal', targetIds: ['a'], watchUntil: 'ready' }] });
  const response = await f.app.send({ text: 'Tell me when a is ready and what it did.', origin: 'text' });
  f.end('a');
  await until(() => f.details(response.requestId).some(item => /12 tests/.test(item.text)));
  assert.equal(f.reports(response.requestId).filter(item => item.status === 'ready').length, 1);
  assert.equal(f.effects.length, 0);
});

test('ready watch distinguishes startup readiness from accomplishments', async t => {
  const f = await fixture(t);
  Object.assign(f.sessions[0], { turnId: undefined, turnState: 'unknown', status: 'starting', observation: 'unknown' });
  f.plan = () => ({ goal: 'Tell me when ready', executionMode: 'direct', actions: [{ kind: 'watch_terminal', targetIds: ['a'], watchUntil: 'ready' }] });
  const response = await f.app.send({ text: 'Tell me when a is ready.', targetId: 'a', origin: 'voice' });
  assert.equal(response.ok, true);
  Object.assign(f.sessions[0], { turnState: 'idle', status: 'idle', observation: 'observed' }); await f.app.refresh(); await tick();
  assert.equal(f.reports(response.requestId).filter(item => item.status === 'ready').length, 1);
  assert.equal(f.details(response.requestId).length, 0);
  assert.equal(f.modelCalls.length, 0); assert.equal(f.effects.length, 0);
});

test('ambiguous work can report readiness without publishing accomplishments', async t => {
  const f = await fixture(t); f.reply = () => 'NO_UPDATE';
  f.plan = () => ({ goal: 'Tell me when ready', executionMode: 'direct', actions: [{ kind: 'watch_terminal', targetIds: ['a'], watchUntil: 'ready' }] });
  const response = await f.app.send({ text: 'Tell me when a is ready.', origin: 'voice' });
  f.sessions[0].completionAttribution = 'ambiguous';
  f.end('a', 'Unattributed accomplishment claims.');
  await f.app.refresh(); await tick();
  assert.equal(f.app.getState().tasks.find(item => item.requestId === response.requestId).status, 'finished');
  assert.equal(f.reports(response.requestId).filter(item => item.status === 'ready').length, 1);
  assert.equal(f.details(response.requestId).length, 0);
  assert.equal(f.modelCalls.filter(body => body.messages[0].content.startsWith('Summarize')).length, 0);
  assert.ok(!f.spoken.some(item => item.kind === 'task-result'));
  assert.equal(f.effects.length, 0);
  await f.app.refresh(); await tick();
  assert.equal(f.reports(response.requestId).filter(item => item.status === 'ready').length, 1);
});

for (const evidence of ['attributed', 'ambiguous', 'startup']) {
  test(`result dependency on ${evidence} readiness requires an attributable task result`, async t => {
    const f = await fixture(t); f.reply = () => 'NO_UPDATE';
    f.plan = () => ({ goal: 'Tell me when ready', executionMode: 'direct', actions: [{ kind: 'watch_terminal', targetIds: ['a'], watchUntil: 'ready' }] });
    const watch = await f.app.send({ text: 'Tell me when a is ready.', origin: 'text' });
    if (evidence === 'startup') Object.assign(f.sessions[0], { turnId: undefined, turnState: 'idle', status: 'idle' });
    else {
      if (evidence === 'ambiguous') f.sessions[0].completionAttribution = 'ambiguous';
      f.end('a');
    }
    Object.assign(f.sessions[1], { turnState: 'idle', status: 'idle' });
    await f.app.refresh();
    assert.equal(f.app.getState().tasks.find(item => item.requestId === watch.requestId).status, 'finished');
    f.plan = () => ({ goal: 'Use the watched result', dependsOnRequestIds: [watch.requestId], actions: [{ kind: 'send_prompt', targetIds: ['b'], text: 'Use the watched result.' }] });
    let receivedResults;
    f.reply = body => {
      if (!body.tools) return 'NO_UPDATE';
      if (body.messages.some(message => message.role === 'tool')) return 'Sent.';
      const context = JSON.parse(body.messages[1].content);
      receivedResults = context.dependencyResults;
      return { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'send-dependent', function: {
        name: 'workspace', arguments: JSON.stringify({ kind: 'send_prompt', grantId: context.authorizedCommands.grants[0].id, targetId: 'b' })
      } }] } }] };
    };
    const dependent = await f.app.send({ text: 'Use the watched result.', targetId: 'b', origin: 'text' });
    if (evidence === 'attributed') {
      assert.equal(dependent.ok, true, JSON.stringify(dependent));
      assert.equal(f.effects.length, 1);
      assert.match(receivedResults[0].result.text, /12 tests passed/);
    } else {
      assert.equal(dependent.ok, false);
      assert.match(dependent.error, /ready.*no attributable task result/i);
      assert.equal(f.effects.length, 0);
      assert.equal(receivedResults, undefined, 'no executor should run without the required result');
    }
  });
}

test('cancelling one watch does not interrupt existing work or its sibling watch', async t => {
  const f = await fixture(t); f.reply = () => 'NO_UPDATE';
  const a = await f.app.send({ text: 'Watch a.', targetId: 'a', origin: 'text' });
  const b = await f.app.send({ text: 'Watch b.', targetId: 'b', origin: 'text' });
  await f.app.cancel({ requestId: a.requestId }); f.end('a'); f.end('b'); await tick();
  assert.equal(f.reports(a.requestId).filter(item => item.status === 'completed').length, 0);
  assert.equal(f.reports(b.requestId).filter(item => item.status === 'completed').length, 1);
  assert.equal(f.effects.length, 0);
});

test('retrying an unregistered watch preserves its original turn through an executor failure', async t => {
  const f = await fixture(t);
  f.plan = () => ({ goal: 'Watch the current task', executionMode: 'reason', actions: [{ kind: 'watch_terminal', targetIds: ['a'] }] });
  f.reply = () => { throw Error('Fixture executor unavailable.'); };
  const first = await f.app.send({ text: 'Watch a.', targetId: 'a', origin: 'text' });
  assert.equal(first.ok, false);
  f.sessions[0].turnId = 'newer-human-turn'; f.sessions[0].turnStartedAt = Date.now();
  f.reply = body => body.messages.some(message => message.role === 'tool') ? 'The original task is no longer current.' : { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'watch', function: { name: 'workspace', arguments: JSON.stringify({ kind: 'watch_terminal', targetId: 'a', grantId: JSON.parse(body.messages[1].content).authorizedCommands.grants[0].id }) } }] } }] };
  const retry = f.app.retry({ requestId: first.requestId }); assert.equal(retry.ok, true);
  await until(() => f.app.getState().tasks.find(item => item.requestId === retry.requestId)?.status === 'failed');
  assert.ok(f.app.getState().receipts.some(item => item.requestId === retry.requestId && /original task/.test(item.text)));
  assert.equal(f.reports(retry.requestId).filter(item => item.status === 'running').length, 0);
  assert.equal(f.effects.length, 0);
});
