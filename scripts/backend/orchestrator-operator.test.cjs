'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { createOperatorObservations } = require('../../backend/orchestratorOperator.cjs');

// Script the model, not the authorization/observation/dispatch implementation.
const reply = content => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const call = (action, name = 'workspace') => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `call-${++call.sequence}`, type: 'function', function: { name, arguments: JSON.stringify(action) } }] } }] });
call.sequence = 0;
const meta = body => JSON.parse(body.messages.find(message => message.role === 'user').content);
const latest = body => JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
const read = () => call({ kind: 'read_session', targetId: 'pane' });
function operation(body, kind, extra = {}) {
  const grant = meta(body).authorizedCommands.grants.find(grant => grant.kind === 'operate_terminal');
  assert.ok(grant, 'The user objective must authorize terminal operation.');
  const observed = latest(body);
  assert.ok(observed.observationToken, 'A read must return a fresh observation token.');
  return call({ kind, grantId: grant.id, targetId: 'pane', stepId: `${kind}-${call.sequence}`, observationToken: observed.observationToken,
    ...(['send_prompt', 'terminal_interact', 'interrupt'].includes(kind) ? { observationSequence: observed.observation?.sequence, inputRevision: observed.observation?.inputRevision } : {}), ...extra });
}
const finish = body => operation(body, 'finish_terminal', { text: 'Verified the requested operation.', outcome: 'completed' });
async function fixture(t, kind = 'codex') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-operator-'));
  const f = { effects: [], steps: [], bodies: [], reads: 0, sequence: 10, sessions: [{ id: 'pane', name: 'Work', kind, provider: kind, generation: 'g1', cwd: root, status: 'running' }] };
  f.relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [{ name: 'Work', path: root }] }), getSessions: () => f.sessions,
    readSession: async () => { f.reads++; return { ok: true, id: 'pane', generation: f.sessions[0].generation, text: f.screen || 'Ready for input', sequence: f.sequence, observationSequence: f.sequence, inputRevision: 2 }; },
    dispatchAction: async action => { f.effects.push(action); return f.dispatch ? f.dispatch(action) : { ok: true, status: 'written' }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'scripted', context_length: 128000, supported_parameters: ['tools', 'tool_choice'] }] }));
      const body = JSON.parse(options.body);
      if (body.tools?.[0]?.function?.name === 'interpret_workspace') return new Response(JSON.stringify(call(f.plan, 'interpret_workspace')));
      f.bodies.push(body);
      assert.ok(f.steps.length, 'Unexpected extra model request: ' + JSON.stringify(body.messages.at(-1)));
      const step = f.steps.shift();
      try { return new Response(JSON.stringify(typeof step === 'function' ? await step(body) : step)); }
      catch (error) { f.scriptError = error; throw error; }
    } });
  t.after(async () => { await f.relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await f.relay.configure({ apiKey: 'test-key', model: 'scripted', sessionOnly: true });
  assert.equal((await f.relay.setEnabled(true)).ok, true);
  f.run = async (steps, extra = {}) => {
    f.plan = { goal: 'Operate Work to complete the user task.', actions: [{ kind: 'operate_terminal', targetIds: ['pane'], text: 'Review the latest changes; answer setup questions as needed.', answerMode: 'delegated', permissionMode: 'none', ...extra }] };
    f.steps.push(...steps);
    const result = await f.relay.send({ text: extra.answerMode === 'supplied' ? 'Use Work to review the latest changes. Answer database PostgreSQL and checks Unit and Smoke.' : 'Use Work to review the latest changes and handle setup questions for me.', origin: 'text' });
    if (f.scriptError) throw f.scriptError;
    assert.equal(f.steps.length, 0, JSON.stringify(result));
    return result;
  };
  f.continue = async (prior, text, steps) => {
    const task = f.relay.getState().tasks.find(task => task.requestId === prior.requestId);
    assert.ok(task.question?.id, 'The original operation must be waiting for its own clarification.');
    f.plan = { goal: 'Continue the unfinished operation with the supplied answer.', continuationOf: prior.requestId,
      actions: [{ kind: 'operate_terminal', sourceUserId: prior.requestId, targetIds: ['pane'] }] };
    f.steps.push(...steps);
    const result = await f.relay.send({ text, origin: 'text', replyToRequestId: prior.requestId, questionId: task.question.id });
    if (f.scriptError) throw f.scriptError;
    assert.equal(f.steps.length, 0, JSON.stringify(result)); return result;
  };
  return f;
}

test('fresh Codex reads unknown state, sends a composed task, then verifies without drafting', async t => {
  const f = await fixture(t);
  const result = await f.run([read(), body => operation(body, 'send_prompt', { text: 'Review the latest changes. Report concrete defects.' }), read(), finish, reply('Review started.')]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.reads, 2);
  assert.deepEqual(f.effects.map(action => action.kind), ['send_prompt']);
  assert.equal(f.effects[0].text, 'Review the latest changes. Report concrete defects.');
  assert.ok(f.effects[0].requestId, 'Delivery must be attributed to the application request.');
});

for (const kind of ['codex', 'openfusion']) test(`${kind} can finish from a post-action read while runtime telemetry advances`, async t => {
  const f = await fixture(t, kind);
  f.sessions[0].revision = 1;
  const result = await f.run([read(), body => operation(body, 'send_prompt', { text: 'Review the latest changes.' }),
    read(), body => { f.sessions[0].revision++; return finish(body); }, reply('Review started.')]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.reads, 2); assert.equal(f.effects.length, 1);
});

test('finishing tolerates telemetry churn without relaxing effect or token authority', () => {
  let time = 100;
  const observations = createOperatorObservations({ now: () => time });
  const target = { id: 'pane', generation: 'g1', revision: 1, kind: 'codex' };
  const screen = { ok: true, sequence: 10, inputRevision: 2 };
  const observe = () => observations.observe(target, screen);
  const finishAction = { kind: 'finish_terminal' };
  const old = observe(), consumed = observe();
  observations.consume(observations.authorize(consumed, target, { kind: 'terminal_interact', observationSequence: 10, inputRevision: 2 }), target, { kind: 'terminal_interact' });
  const fresh = observe(); target.revision++;
  assert.throws(() => observations.authorize(fresh, target, { kind: 'terminal_interact', observationSequence: 10, inputRevision: 2 }), /terminal changed/);
  assert.throws(() => observations.authorize(consumed, target, finishAction), /missing, used, or stale/);
  assert.throws(() => observations.authorize(old, target, finishAction), /after the last action/);
  assert.throws(() => observations.authorize(fresh, { ...target, generation: 'g2' }, finishAction), /missing, used, or stale/);
  assert.ok(observations.authorize(fresh, target, finishAction));
  time += 30001;
  assert.throws(() => observations.authorize(fresh, target, finishAction), /missing, used, or stale/);
});

test('menu navigation permits multiple submissions using fresh reads even if output sequence is unchanged', async t => {
  const f = await fixture(t); let firstToken;
  const result = await f.run([read(), body => { firstToken = latest(body).observationToken; return operation(body, 'terminal_interact', { keys: ['down', 'enter'] }); },
    read(), body => { assert.notEqual(latest(body).observationToken, firstToken); return operation(body, 'terminal_interact', { keys: ['enter'] }); }, read(), finish, reply('Setup completed.')]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.effects.map(action => action.keys), [['down', 'enter'], ['enter']]);
});

test('an echo with no actions is corrected before the request can finish', async t => {
  const f = await fixture(t);
  const result = await f.run([reply('You want me to review the latest changes.'), body => {
    assert.match(JSON.stringify(body.messages.slice(2)), /unfinished|remaining|execute|action|operate/i);
    return read();
  }, body => operation(body, 'send_prompt', { text: 'Review the latest changes.' }), read(), finish, reply('Review started.')]);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1);
});

test('consumed observation tokens cannot perform a second action', async t => {
  const f = await fixture(t); let saved;
  await f.run([read(), body => { saved = JSON.parse(operation(body, 'terminal_interact', { keys: ['enter'] }).choices[0].message.tool_calls[0].function.arguments); return call(saved); },
    () => call({ ...saved, stepId: 'different-step' }), body => { assert.equal(latest(body).ok, false); assert.match(latest(body).error, /observ|read|token|fresh/i); return read(); }, finish, reply('Done.')]);
  assert.equal(f.effects.length, 1);
});

test('a changed terminal generation rejects a previously observed action', async t => {
  const f = await fixture(t);
  await f.run([read(), body => { f.sessions[0].generation = 'g2'; return operation(body, 'send_prompt', { text: 'Review changes.' }); }, body => {
    assert.equal(latest(body).ok, false); assert.match(latest(body).error, /generation|changed|restart|target/i); return call({ kind: 'ask_user', text: 'Work restarted. Which terminal should receive the review?' });
  }]);
  assert.equal(f.effects.length, 0);
});

test('an uncertain native write is never sent twice with the same step identity', async t => {
  const f = await fixture(t); let saved;
  f.dispatch = () => ({ ok: false, status: 'uncertain', error: 'Transport lost after write.' });
  const result = await f.run([read(), body => { saved = JSON.parse(operation(body, 'terminal_interact', { keys: ['enter'], stepId: 'submit-once' }).choices[0].message.tool_calls[0].function.arguments); return call(saved); },
    read(), body => operation(body, 'terminal_interact', { keys: ['enter'], stepId: saved.stepId }), read(), body => operation(body, 'finish_terminal', { text: 'Submission could not be verified.', outcome: 'blocked' }), reply('Submission could not be verified.')]);
  assert.equal(f.effects.length, 1); assert.equal(result.ok, false);
});

test('clarification continuation cannot replay an unknown write with a new step', async t => {
  const f = await fixture(t);
  f.dispatch = () => ({ ok: false, status: 'unknown', error: 'Connection closed before acknowledgment.' });
  const first = await f.run([read(), body => operation(body, 'send_prompt', { text: 'Review the latest changes.', stepId: 'original-send' }),
    read(), call({ kind: 'ask_user', text: 'The submission is unconfirmed. Should I inspect its outcome?' })]);
  assert.equal(f.effects.length, 1);
  const continued = await f.continue(first, 'Continue the same operation and inspect its outcome.', [read(),
    body => { assert.equal(meta(body).authorizedCommands.grants[0].sourceUserId, first.requestId); return operation(body, 'send_prompt', { text: 'Review the latest changes.', stepId: 'continued-send' }); },
    body => { assert.equal(latest(body).ok, false); assert.match(latest(body).error, /unconfirmed|unknown|earlier/i); return read(); },
    body => operation(body, 'finish_terminal', { outcome: 'blocked', text: 'The original submission remains unconfirmed.' }), reply('The original submission remains unconfirmed.')]);
  assert.equal(continued.ok, false, JSON.stringify(continued)); assert.equal(f.effects.length, 1);
});

test('a known native interaction continues after clarification with the original input owner and only the answer', async t => {
  const f = await fixture(t);
  const first = await f.run([read(), body => operation(body, 'terminal_interact', { text: '/settings', submit: true }),
    read(), call({ kind: 'ask_user', text: 'Which deployment label should I enter?' })]);
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].requestId, first.requestId);
  const continued = await f.continue(first, 'Use staging-west.', [read(),
    body => { assert.equal(meta(body).authorizedCommands.grants[0].sourceUserId, first.requestId); return operation(body, 'terminal_interact', { text: 'staging-west', submit: true }); },
    read(), finish, reply('Deployment label entered.')]);
  assert.equal(continued.ok, true, JSON.stringify(continued)); assert.notEqual(continued.requestId, first.requestId);
  assert.deepEqual(f.effects.map(action => action.text), ['/settings', 'staging-west']);
  assert.deepEqual(f.effects.map(action => action.requestId), [first.requestId, first.requestId]);
  assert.equal(f.reads, 4);
});

test('a definitely not-dispatched failure can recover with a new observed step and verified completion', async t => {
  const f = await fixture(t);
  f.dispatch = () => f.effects.length === 1 ? { ok: false, status: 'not-dispatched', error: 'The input was temporarily unavailable.' } : { ok: true, status: 'written' };
  const result = await f.run([read(), body => operation(body, 'send_prompt', { text: 'Review the latest changes.', stepId: 'first-attempt' }),
    body => { assert.equal(latest(body).ok, false); return read(); }, body => operation(body, 'send_prompt', { text: 'Review the latest changes.', stepId: 'recovered-attempt' }),
    read(), finish, reply('Review started after retrying the unavailable input.')]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.effects.length, 2);
  assert.notEqual(f.effects[0].actionId, f.effects[1].actionId);
});

test('omitting the grant ID never bypasses operator observation authority', async t => {
  const f = await fixture(t);
  const result = await f.run([call({ kind: 'send_prompt', targetId: 'pane', stepId: 'unobserved', text: 'Review the latest changes.' }),
    body => { assert.equal(latest(body).ok, false); assert.equal(f.effects.length, 0); return read(); },
    body => { const action = JSON.parse(operation(body, 'send_prompt', { text: 'Review the latest changes.' }).choices[0].message.tool_calls[0].function.arguments); delete action.grantId; return call(action); },
    read(), finish, reply('Review started.')]);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1); assert.equal(f.effects[0].operator, true);
});

test('an older unused structured token cannot act after a different observed token was consumed', async t => {
  const f = await fixture(t, 'openfusion'); let oldToken;
  const result = await f.run([read(), body => { oldToken = latest(body).observationToken; return read(); },
    body => operation(body, 'send_prompt', { text: 'Review the latest changes.' }),
    body => call({ kind: 'send_prompt', grantId: meta(body).authorizedCommands.grants[0].id, targetId: 'pane', stepId: 'old-unused-token', observationToken: oldToken, text: 'Review the latest changes again.' }),
    body => { assert.equal(latest(body).ok, false); assert.match(latest(body).error, /observ|read|token|fresh|action/i); assert.equal(f.effects.length, 1); return read(); }, finish, reply('Review started.')]);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1);
});

test('unknown delivery cannot be replayed under a new step or reported completed', async t => {
  const f = await fixture(t); f.dispatch = () => ({ ok: false, status: 'unknown', error: 'Transport closed before acknowledgment.' }); let postWriteToken;
  const result = await f.run([read(), body => operation(body, 'send_prompt', { text: 'Review changes.', stepId: 'unknown-send' }), read(),
    body => { postWriteToken = latest(body).observationToken; return operation(body, 'send_prompt', { text: 'Review changes.', stepId: 'new-retry' }); },
    body => { assert.equal(latest(body).ok, false); assert.match(latest(body).error, /unconfirmed|unknown|earlier/i); return read(); },
    body => { postWriteToken = latest(body).observationToken; return finish(body); },
    body => { assert.equal(latest(body).ok, false); assert.match(latest(body).error, /unconfirmed|blocked|unknown/i); return call({ kind: 'finish_terminal', grantId: meta(body).authorizedCommands.grants[0].id, targetId: 'pane', stepId: 'blocked-finish', observationToken: postWriteToken, outcome: 'blocked', text: 'The submission remains unconfirmed.' }); }, reply('The submission remains unconfirmed.')]);
  assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(f.effects.length, 1);
});

test('native interrupt rejects an explicit mismatched revision and preserves observed evidence', async t => {
  const f = await fixture(t);
  const result = await f.run([read(), body => operation(body, 'interrupt', { inputRevision: 999 }),
    body => { assert.equal(latest(body).ok, false); assert.equal(f.effects.length, 0); return read(); },
    body => operation(body, 'interrupt'), read(), finish, reply('Stopped the terminal.')], { text: 'Interrupt the running task in Work and verify it stopped.' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1);
  assert.equal(f.effects[0].kind, 'interrupt'); assert.equal(f.effects[0].operator, true); assert.equal(f.effects[0].observationSequence, 10); assert.equal(f.effects[0].inputRevision, 2);
});

for (const kind of ['send_prompt', 'interrupt']) for (const omitted of [['observationSequence', 'inputRevision'], ['inputRevision'], ['observationSequence']]) {
  test(`${kind} derives omitted ${omitted.join('/')} from its token without changing step replay identity`, async t => {
    const f = await fixture(t); let original;
    const result = await f.run([read(), body => {
      original = JSON.parse(operation(body, kind, { ...(kind === 'send_prompt' && { text: 'Review the latest changes.' }), stepId: 'derived-once' }).choices[0].message.tool_calls[0].function.arguments);
      for (const field of omitted) delete original[field];
      return call(original);
    }, body => { assert.equal(latest(body).ok, true, JSON.stringify(latest(body))); return call(original); },
    body => { assert.equal(latest(body).ok, true, 'An exact replay returns its receipt despite the consumed observation token.'); return read(); }, finish, reply('Done.')]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.effects.length, 1);
    assert.equal(f.effects[0].observationSequence, 10);
    assert.equal(f.effects[0].inputRevision, 2);
    assert.equal(f.effects[0].operator, true);
    assert.ok(f.effects[0].requestId);
  });
}

test('derived counters require valid fresh evidence and never replace supplied mismatches', () => {
  let time = 100;
  const observations = createOperatorObservations({ now: () => time });
  const target = { id: 'pane', generation: 'g1', revision: 1, kind: 'codex' };
  const token = observations.observe(target, { sequence: 0, inputRevision: 0 });
  for (const kind of ['send_prompt', 'interrupt']) {
    assert.ok(observations.authorize(token, target, { kind }));
    for (const field of ['observationSequence', 'inputRevision']) for (const value of [1, null, -1])
      assert.throws(() => observations.authorize(token, target, { kind, [field]: value }), /screen sequence and input revision/);
    assert.throws(() => observations.authorize(token, { ...target, revision: 2 }, { kind }), /terminal changed/);
    assert.throws(() => observations.authorize(token, { ...target, generation: 'g2' }, { kind }), /missing, used, or stale/);
    for (const screen of [{ sequence: 0 }, { inputRevision: 0 }, { sequence: -1, inputRevision: 0 }, { sequence: 0, inputRevision: -1 }])
      assert.throws(() => observations.authorize(observations.observe(target, screen), target, { kind }), /screen sequence and input revision/);
  }
  assert.throws(() => observations.authorize(token, target, { kind: 'terminal_interact' }), /screen sequence and input revision/);
  time += 30001;
  assert.throws(() => observations.authorize(token, target, { kind: 'send_prompt' }), /missing, used, or stale/);
});

test('a write using derived evidence remains unconfirmed and cannot be replayed with a fresh step', async t => {
  const f = await fixture(t); let original;
  f.dispatch = () => ({ ok: false, status: 'unknown', error: 'No acknowledgment.' });
  const result = await f.run([read(), body => {
    original = JSON.parse(operation(body, 'send_prompt', { text: 'Review changes.', stepId: 'unknown-derived' }).choices[0].message.tool_calls[0].function.arguments);
    delete original.observationSequence; delete original.inputRevision; return call(original);
  }, () => call(original), body => { assert.equal(latest(body).status, 'unknown'); return read(); },
  body => operation(body, 'send_prompt', { text: 'Review changes.', stepId: 'another-step' }),
  body => { assert.match(latest(body).error, /unconfirmed/); return read(); },
  body => operation(body, 'finish_terminal', { outcome: 'blocked', text: 'Submission remains unconfirmed.' }), reply('Submission remains unconfirmed.')]);
  assert.equal(result.ok, false);
  assert.equal(f.effects.length, 1);
  assert.equal(f.effects[0].inputRevision, 2);
});

test('completion after an action requires another read, not the consumed pre-action observation', async t => {
  const f = await fixture(t); let token;
  const result = await f.run([read(), body => { token = latest(body).observationToken; return operation(body, 'send_prompt', { text: 'Review the latest changes.' }); },
    body => call({ kind: 'finish_terminal', grantId: meta(body).authorizedCommands.grants[0].id, targetId: 'pane', stepId: 'premature-finish', observationToken: token, text: 'Done.', outcome: 'completed' }),
    body => { assert.equal(latest(body).ok, false); assert.match(latest(body).error, /observ|read|token|fresh/i); return read(); }, finish, reply('Review started and verified.')]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.reads, 2); assert.equal(f.effects.length, 1);
});

for (const kind of ['fusion', 'openfusion']) for (const answerMode of ['supplied', 'delegated']) {
  test(`${kind} ${answerMode} answers support custom text and multiple selections`, async t => {
    const f = await fixture(t, kind);
    f.relay.ingestInteraction({ id: 'setup', sessionId: 'pane', generation: 'g1', revision: 3, kind: 'question', questions: [
      { id: 'database', question: 'Database?', custom: true, options: [{ label: 'SQLite' }] },
      { id: 'checks', question: 'Checks?', multiple: true, options: [{ label: 'Unit' }, { label: 'Smoke' }] }
    ] });
    const result = await f.run([read(), body => operation(body, 'answer_question', { requestId: 'setup', revision: 3, answerTexts: { database: 'PostgreSQL', checks: 'Unit and Smoke' } }),
      read(), finish, reply('Setup answered.')], { answerMode, ...(answerMode === 'supplied' ? { text: 'Answer database PostgreSQL and checks Unit and Smoke.', answerTexts: { database: 'PostgreSQL', checks: 'Unit and Smoke' } } : {}) });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1);
    assert.equal(f.effects[0].requestId, 'setup'); assert.equal(f.effects[0].revision, 3);
    assert.deepEqual(f.effects[0].answers, { database: 'PostgreSQL', checks: ['Unit', 'Smoke'] });
  });
}
