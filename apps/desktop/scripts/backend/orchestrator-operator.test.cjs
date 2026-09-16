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
const read = (targetId = 'pane') => call({ kind: 'read_session', targetId });
function operation(body, kind, extra = {}) {
  const grant = meta(body).authorizedCommands.grants.find(grant => grant.kind === 'operate_terminal');
  assert.ok(grant, 'The user objective must authorize terminal operation.');
  const observed = latest(body);
  assert.ok(observed.observationToken, 'A read must return a fresh observation token.');
  return call({ kind, grantId: grant.id, targetId: 'pane', stepId: `${kind}-${call.sequence}`, observationToken: observed.observationToken, ...extra });
}
const finish = body => operation(body, 'finish_terminal', { text: 'Verified the requested operation.', outcome: 'completed' });
async function fixture(t, kind = 'codex') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-operator-'));
  const f = { effects: [], steps: [], bodies: [], reads: 0, sequence: 10, sessions: [{ id: 'pane', name: 'Work', kind, provider: kind, generation: 'g1', cwd: root, status: 'running' }] };
  f.relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [{ name: 'Work', path: root }] }), getSessions: () => f.sessions,
    readSession: async target => { f.reads++; if (f.readOverride) return f.readOverride(target); const session = f.sessions.find(session => session.id === target.id); return { ok: true, id: session.id, generation: session.generation, text: f.screen || 'Ready for input', sequence: f.sequence, inputRevision: 2, cols: 100, rows: 28, cursor: { x: 0, y: 0 }, cursorVisible: true, alternateScreen: false, cursorLine: { startRow: 0, text: 'Ready for input', beforeCursor: '' } }; },
    dispatchAction: async action => { f.effects.push(action); return f.dispatch ? f.dispatch(action) : { ok: true, status: 'written' }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'scripted', context_length: 128000, supported_parameters: ['tools', 'tool_choice'] }] }));
      const body = JSON.parse(options.body);
      if (body.tools?.[0]?.function?.name === 'interpret_workspace') return new Response(JSON.stringify(call(f.plan, 'interpret_workspace')));
      f.bodies.push(body);
      assert.ok(f.steps.length, 'Unexpected extra model request: ' + JSON.stringify(body.messages.at(-1)));
      const step = f.steps.shift();
      try { f.lastResponse = typeof step === 'function' ? await step(body) : step; return new Response(JSON.stringify(f.lastResponse)); }
      catch (error) { f.scriptError = error; throw error; }
    } });
  t.after(async () => { await f.relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await f.relay.configure({ apiKey: 'test-key', model: 'scripted', sessionOnly: true });
  assert.equal((await f.relay.setEnabled(true)).ok, true);
  const assertFinishText = result => {
    const lastActions = f.lastResponse?.choices?.[0]?.message?.tool_calls?.map(call => JSON.parse(call.function.arguments)) || [];
    for (const action of lastActions.filter(action => action.kind === 'finish_terminal' && action.outcome === 'completed')) {
      const receipt = result.actions?.find(item => item.kind === 'finish_terminal' && (action.stepId !== undefined ? item.stepId === action.stepId :
        item.targetId === action.targetId && (!action.grantId || item.grantId === action.grantId)));
      if (result.ok) assert.ok(receipt && (result.text === 'done' || result.text.includes(receipt.text)), 'The result acknowledges completion or preserves delivery issues, with the full finish receipt retained.');
    }
  };
  f.run = async (steps, extra = {}) => {
    f.plan = { goal: 'Operate Work to complete the user task.', ...(f.access && { access: f.access }), actions: [{ kind: 'operate_terminal', targetIds: ['pane'], text: 'Review the latest changes; answer setup questions as needed.', answerMode: 'delegated', permissionMode: 'none', ...extra }] };
    f.steps.push(...steps);
    const result = await f.relay.send({ text: extra.targetIds?.length > 1 ? extra.text : extra.answerMode === 'supplied' ? 'Use Work to review the latest changes. Answer database PostgreSQL and checks Unit and Smoke.' : 'Use Work to review the latest changes and handle setup questions for me.', origin: 'text' });
    if (f.scriptError) throw f.scriptError;
    assert.equal(f.steps.length, 0, JSON.stringify(result));
    assertFinishText(result);
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
    assert.equal(f.steps.length, 0, JSON.stringify(result)); assertFinishText(result); return result;
  };
  return f;
}

test('fresh Codex reads unknown state, sends a composed task, then verifies without drafting', async t => {
  const f = await fixture(t);
  const result = await f.run([read(), body => operation(body, 'send_prompt', { text: 'Review the latest changes. Report concrete defects.' }), read(), finish]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.reads, 2);
  assert.equal(f.bodies.length, 4, 'Read, send, read, finish use four execution fetches instead of five with a redundant final reply.');
  // Delivery is confirmed; the agent's own result is not, so the acknowledgment
  // reports the pending task instead of claiming the coding work finished.
  assert.match(result.text, /Typed the task into Work, but I haven't seen it start yet[.]/s);
  assert.deepEqual(f.effects.map(action => action.kind), ['send_prompt']);
  assert.equal(f.effects[0].text, 'Review the latest changes. Report concrete defects.');
  assert.ok(f.effects[0].requestId, 'Delivery must be attributed to the application request.');
});

test('two targets require both post-action finishes and combine their receipts without a final fetch', async t => {
  const f = await fixture(t);
  f.access = 'read-only';
  f.sessions.push({ ...f.sessions[0], id: 'second', name: 'Second', generation: 'g2' });
  const result = await f.run([
    read(), body => operation(body, 'send_prompt', { text: 'Review Work.' }), read(),
    body => operation(body, 'finish_terminal', { text: 'Work review started.', outcome: 'completed' }),
    body => { assert.equal(latest(body).status, 'interaction-complete'); return read('second'); },
    body => operation(body, 'send_prompt', { targetId: 'second', text: 'Review Second.' }), read('second'),
    body => operation(body, 'finish_terminal', { targetId: 'second', text: 'Second review started.', outcome: 'completed' })
  ], { targetIds: ['pane', 'second'], selection: 'all', text: 'Start read-only reviews in both Work and Second without editing files and verify submission.' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.bodies.length, 8, 'Both read-send-read-finish sequences need eight fetches; a ninth reply rewrite is redundant.');
  assert.equal(f.reads, 4);
  assert.deepEqual(f.effects.map(action => action.target.id), ['pane', 'second']);
  // Both deliveries are confirmed and both agent results are still pending.
  assert.match(result.text, /Typed the task into Work, but I haven't seen it start yet[.].*Typed the task into Second, but I haven't seen it start yet[.]/s);
  assert.equal(result.actions.filter(action => action.status === 'interaction-complete').length, 2);
});

for (const kind of ['codex', 'openfusion']) test(`${kind} can finish from a post-action read while runtime telemetry advances`, async t => {
  const f = await fixture(t, kind);
  f.sessions[0].revision = 1;
  const result = await f.run([read(), body => operation(body, 'send_prompt', { text: 'Review the latest changes.' }),
    read(), body => { f.sessions[0].revision++; return finish(body); }]);
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
  observations.consume(observations.authorize(consumed, target, { kind: 'terminal_interact'}), target, { kind: 'terminal_interact' });
  const fresh = observe(); target.revision++;
  assert.ok(observations.authorize(fresh, target, { kind: 'terminal_interact'}));
  assert.throws(() => observations.authorize(fresh, { ...target, turnId: 'new-turn' }, { kind: 'terminal_interact'}), /terminal changed/);
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
    read(), body => { assert.notEqual(latest(body).observationToken, firstToken); return operation(body, 'terminal_interact', { keys: ['enter'] }); }, read(), finish]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.effects.map(action => action.keys), [['down', 'enter'], ['enter']]);
});

test('an echo with no actions is corrected before the request can finish', async t => {
  const f = await fixture(t);
  const result = await f.run([reply('You want me to review the latest changes.'), body => {
    assert.match(JSON.stringify(body.messages.slice(2)), /unfinished|remaining|execute|action|operate/i);
    return read();
  }, body => operation(body, 'send_prompt', { text: 'Review the latest changes.' }), read(), finish]);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1);
});

test('consumed observation tokens cannot perform a second action', async t => {
  const f = await fixture(t); let saved;
  await f.run([read(), body => { saved = JSON.parse(operation(body, 'terminal_interact', { keys: ['enter'] }).choices[0].message.tool_calls[0].function.arguments); return call(saved); },
    () => call({ ...saved, stepId: 'different-step' }), body => { assert.equal(latest(body).ok, false); assert.match(latest(body).error, /observ|read|token|fresh/i); return read(); }, finish]);
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
    read(), finish]);
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
    read(), finish]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.effects.length, 2);
  assert.notEqual(f.effects[0].actionId, f.effects[1].actionId);
});

test('omitting the grant ID never bypasses operator observation authority', async t => {
  const f = await fixture(t);
  // No grant ID, no token and no model read: the application takes the terminal
  // observation itself, binds it to this write and still resolves the grant.
  const result = await f.run([call({ kind: 'send_prompt', targetId: 'pane', stepId: 'unobserved', text: 'Review the latest changes.' }),
    body => { assert.equal(latest(body).ok, true); assert.equal(f.effects.length, 1); assert.equal(f.reads, 1); return read(); }, finish]);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1); assert.equal(f.effects[0].operator, true);
  assert.equal(typeof f.effects[0].grantId, 'string'); assert.equal(f.effects[0].inputSurface.inputRevision, 2);
});

test('a native control with no read is still refused; only observed operations are supplied for', async t => {
  const f = await fixture(t);
  const result = await f.run([call({ kind: 'terminal_interact', targetId: 'pane', stepId: 'unobserved', keys: ['down'], inputPurpose: 'interaction' }),
    body => { assert.equal(latest(body).ok, false); assert.match(latest(body).error, /[Rr]ead this terminal/); assert.equal(f.effects.length, 0); assert.equal(f.reads, 0); return read(); },
    body => operation(body, 'terminal_interact', { keys: ['down'], inputPurpose: 'interaction' }), read(), finish]);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1);
});

test('an older unused structured token cannot act after a different observed token was consumed', async t => {
  const f = await fixture(t, 'openfusion'); let oldToken;
  const result = await f.run([read(), body => { oldToken = latest(body).observationToken; return read(); },
    body => operation(body, 'send_prompt', { text: 'Review the latest changes.' }),
    body => call({ kind: 'send_prompt', grantId: meta(body).authorizedCommands.grants[0].id, targetId: 'pane', stepId: 'old-unused-token', observationToken: oldToken, text: 'Review the latest changes again.' }),
    body => { assert.equal(latest(body).ok, false); assert.match(latest(body).error, /observ|read|token|fresh|action/i); assert.equal(f.effects.length, 1); return read(); }, finish]);
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
  Object.assign(f.sessions[0], { turnState: 'running', turnId: 'active-turn' });
  const result = await f.run([read(), body => operation(body, 'interrupt', { inputRevision: 999 }),
    body => { assert.equal(latest(body).ok, false); assert.equal(f.effects.length, 0); return read(); },
    body => operation(body, 'interrupt'), read(), finish], { text: 'Interrupt the running task in Work and verify it stopped.', lifecycleMode: 'interrupt' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1);
  assert.equal(f.effects[0].kind, 'interrupt'); assert.equal(f.effects[0].operator, true); assert.equal(f.effects[0].inputSurface.inputRevision, 2);
});

for (const kind of ['send_prompt', 'interrupt', 'terminal_interact']) {
  test(`${kind} takes its native input evidence from its token without changing step replay identity`, async t => {
    const f = await fixture(t); let original;
    if (kind === 'interrupt') Object.assign(f.sessions[0], { turnState: 'running', turnId: 'active-turn' });
    const result = await f.run([read(), body => {
      original = JSON.parse(operation(body, kind, { ...(kind === 'send_prompt' && { text: 'Review the latest changes.' }), ...(kind === 'terminal_interact' && { keys: ['down'] }), stepId: 'derived-once' }).choices[0].message.tool_calls[0].function.arguments);
      // The model never supplies freshness numbers; there is nothing to omit.
      assert.equal(Object.hasOwn(original, 'observationSequence'), false);
      assert.equal(Object.hasOwn(original, 'inputRevision'), false);
      return call(original);
    }, body => { assert.equal(latest(body).ok, true, JSON.stringify(latest(body))); return call(original); },
    body => { assert.equal(latest(body).ok, true, 'An exact replay returns its receipt despite the consumed observation token.'); return read(); }, finish], kind === 'interrupt' ? { lifecycleMode: 'interrupt', text: 'Interrupt the running task.' } : {});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.effects.length, 1);
    assert.equal(f.effects[0].inputSurface.inputRevision, 2);
    assert.equal(f.effects[0].operator, true);
    assert.ok(f.effects[0].requestId);
  });
}

// The frozen sequence/inputRevision stay as the model's proof it is acting on
// the read it was given. What the native adapter actually fences the write on is
// the input surface, because a pane that repaints itself moves the sequence and
// nothing else. Both travel with the token.
test('an observation token records the input surface beside the counters it freezes', () => {
  const observations = createOperatorObservations();
  const target = { id: 'pane', generation: 'g1', revision: 1, kind: 'codex', provider: 'codex' };
  const screen = { ok: true, id: 'pane', generation: 'g1', sequence: 4, inputRevision: 1, cols: 80, rows: 10,
    cursor: { x: 2, y: 3 }, cursorVisible: true, cursorLine: { startRow: 3, text: '› Ask Codex to do anything', beforeCursor: '› ' },
    cursorContext: { startRow: 1, rows: ['', '', '› Ask Codex to do anything', ''] },
    text: 'OpenAI Codex\nmodel: gpt-6-astra\n\n› Ask Codex to do anything' };
  const record = observations.authorize(observations.observe(target, screen), target, { kind: 'send_prompt' });
  assert.equal(record.sequence, 4); assert.equal(record.inputRevision, 1);
  assert.equal(record.surface.composer.empty, true);
  assert.equal(record.surface.inputRevision, 1);
  assert.equal(record.surface.line.beforeCursor, '› ');
  assert.equal(JSON.stringify(record.surface).includes('Ask Codex'), false, 'the surface never carries the screen text');
  assert.equal(Object.hasOwn(record.surface, 'sequence'), false, 'the surface never carries the output counter');
  // A read with no input revision captured no surface, so it cannot authorize.
  assert.throws(() => observations.authorize(observations.observe(target, { ...screen, inputRevision: undefined }), target, { kind: 'send_prompt' }),
    /captured input surface/);
});

test('an operator effect carries the observed input surface to the native adapter', async t => {
  const f = await fixture(t);
  const result = await f.run([read(), body => operation(body, 'send_prompt', { text: 'Review the latest changes.' }), read(), finish]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.effects.length, 1);
  const surface = f.effects[0].inputSurface;
  assert.ok(surface, 'the operator effect carries the observed input surface');
  assert.equal(surface.inputRevision, 2);
  assert.equal(surface.id, 'pane');
  assert.equal(JSON.stringify(surface).includes('Ready for input'), false);
});

test('derived counters require valid fresh evidence and never replace supplied mismatches', () => {
  let time = 100;
  const observations = createOperatorObservations({ now: () => time });
  const target = { id: 'pane', generation: 'g1', revision: 1, kind: 'codex' };
  const token = observations.observe(target, { sequence: 0, inputRevision: 0 });
  for (const kind of ['send_prompt', 'interrupt', 'terminal_interact']) {
    assert.ok(observations.authorize(token, target, { kind }));
    assert.ok(observations.authorize(token, { ...target, revision: 2 }, { kind }));
    assert.throws(() => observations.authorize(token, { ...target, turnId: 'new-turn' }, { kind }), /terminal changed/);
    assert.throws(() => observations.authorize(token, { ...target, generation: 'g2' }, { kind }), /missing, used, or stale/);
    // A read that never saw an input revision captured no surface, so it cannot
    // authorize native input however fresh its token is.
    for (const screen of [{ sequence: 0 }, { sequence: 0, inputRevision: -1 }, {}])
      assert.throws(() => observations.authorize(observations.observe(target, screen), target, { kind }), /captured input surface/);
  }
  assert.ok(observations.authorize(token, target, { kind: 'terminal_interact' }));
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
  assert.equal(f.effects[0].inputSurface.inputRevision, 2);
});

test('completion after an action requires another read, not the consumed pre-action observation', async t => {
  const f = await fixture(t); let token;
  const result = await f.run([read(), body => { token = latest(body).observationToken; return operation(body, 'send_prompt', { text: 'Review the latest changes.' }); },
    body => call({ kind: 'finish_terminal', grantId: meta(body).authorizedCommands.grants[0].id, targetId: 'pane', stepId: 'premature-finish', observationToken: token, text: 'Done.', outcome: 'completed' }),
    body => { assert.equal(latest(body).ok, false); assert.match(latest(body).error, /observ|read|token|fresh/i); return read(); }, finish]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.reads, 2); assert.equal(f.effects.length, 1);
});

const implicitFinish = body => call({ kind: 'finish_terminal', grantId: meta(body).authorizedCommands.grants[0].id,
  targetId: 'pane', text: 'Verified the requested operation.', outcome: 'completed' });

test('request-owned metadata completes read-send-read-finish and repeated call identity dispatches once', async t => {
  const f = await fixture(t); let sent;
  const result = await f.run([read(), () => sent = call({ kind: 'send_prompt', targetId: 'pane', text: 'Review the latest changes.' }),
    () => sent, body => { assert.equal(latest(body).ok, true); assert.equal(f.effects.length, 1); return read(); }, implicitFinish]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.effects.length, 1); assert.equal(f.reads, 2);
  assert.equal(typeof f.effects[0].stepId, 'string'); assert.ok(f.effects[0].stepId.length);
  assert.equal(f.effects[0].inputSurface.inputRevision, 2);
});

test('a same-response batched read cannot supply implicit evidence to its already chosen action', async t => {
  const f = await fixture(t);
  const batched = read();
  batched.choices[0].message.tool_calls.push(...call({ kind: 'send_prompt', targetId: 'pane', text: 'Review the latest changes.' }).choices[0].message.tool_calls);
  const result = await f.run([batched, body => {
    // The model's same-response read is still not implicit evidence: the write
    // was authorized by the application's own newer observation, not by it.
    assert.equal(latest(body).ok, true); assert.equal(f.effects.length, 1); assert.equal(f.reads, 2);
    return read();
  }, implicitFinish]);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1);
});

test('a failed current read prevents implicit fallback to an earlier successful read', async t => {
  const f = await fixture(t);
  const result = await f.run([read(), () => { f.readOverride = () => ({ ok: false, error: 'Synthetic current read failed.' }); return read(); },
    body => { assert.equal(latest(body).ok, false); return call({ kind: 'send_prompt', targetId: 'pane', text: 'Review the latest changes.' }); },
    body => { assert.equal(latest(body).ok, false); assert.equal(f.effects.length, 0); delete f.readOverride; return read(); },
    () => call({ kind: 'send_prompt', targetId: 'pane', text: 'Review the latest changes.' }), read(), implicitFinish, reply('The input was inspected after submission.')]);
  assert.equal(result.upstreamError, undefined, JSON.stringify(result)); assert.equal(f.effects.length, 1);
});

// An invented observationToken is not evidence of anything, so it is treated as
// absent and the action binds to the model's latest unused read of that pane.
// The ladder's T4.4 spent nine rejections and 32 model calls on tokens like
// "obs-session_…" and "96" before this; a token the operator really minted is
// still checked exactly as before (used, stale, wrong pane).
for (const invented of ['', null, 'not-a-real-token']) {
  test(`supplied invented observationToken=${JSON.stringify(invented)} binds to the latest real read`, async t => {
    const f = await fixture(t);
    const result = await f.run([read(), () => call({ kind: 'send_prompt', targetId: 'pane', text: 'Review the latest changes.', observationToken: invented }),
      body => { assert.equal(latest(body).ok, true, JSON.stringify(latest(body))); assert.equal(f.effects.length, 1); return read(); }, implicitFinish]);
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1);
  });
}
// An explicitly supplied step identity is never replaced by an application one.
for (const invalid of [{ stepId: '' }, { stepId: null }]) {
  test(`supplied invalid ${Object.keys(invalid)[0]}=${JSON.stringify(Object.values(invalid)[0])} is not silently replaced`, async t => {
    const f = await fixture(t);
    const result = await f.run([read(), () => call({ kind: 'send_prompt', targetId: 'pane', text: 'Review the latest changes.', ...invalid }),
      body => { assert.equal(latest(body).ok, false); assert.equal(f.effects.length, 0); return call({ kind: 'send_prompt', targetId: 'pane', text: 'Review the latest changes.' }); },
      read(), implicitFinish]);
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1);
  });
}

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

// Application-supplied observation: the fence is unchanged, only its supplier.
test('a task with no read at all is observed by the application and then written', async t => {
  const f = await fixture(t);
  const result = await f.run([call({ kind: 'send_prompt', targetId: 'pane', text: 'Review the latest changes.' }),
    body => { assert.equal(latest(body).ok, true); assert.equal(f.reads, 1); assert.equal(f.effects.length, 1); return read(); }, implicitFinish]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].inputSurface.inputRevision, 2);
});

test('an earlier-round read still supplies the observation and no extra read is taken', async t => {
  const f = await fixture(t);
  const result = await f.run([read(), () => call({ kind: 'send_prompt', targetId: 'pane', text: 'Review the latest changes.' }),
    body => { assert.equal(latest(body).ok, true); assert.equal(f.reads, 1, 'The model read is used; the application does not read again.'); return read(); },
    implicitFinish]);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1); assert.equal(f.reads, 2);
});

test('an operator answer with no read is observed by the application before it is delivered', async t => {
  const f = await fixture(t, 'fusion');
  f.relay.ingestInteraction({ id: 'setup', sessionId: 'pane', generation: 'g1', revision: 3, kind: 'question',
    questions: [{ id: 'database', question: 'Database?', custom: true, options: [{ label: 'SQLite' }] }] });
  const result = await f.run([call({ kind: 'answer_question', targetId: 'pane', requestId: 'setup', revision: 3, answerTexts: { database: 'PostgreSQL' } }),
    body => { assert.equal(latest(body).ok, true); assert.equal(f.reads, 1); return read(); }, finish, reply('Setup answered.')], { answerMode: 'delegated' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1);
  assert.equal(f.effects[0].requestId, 'setup'); assert.deepEqual(f.effects[0].answers, { database: 'PostgreSQL' });
});

test('an application-supplied observation keeps the drift and after-action rules', () => {
  let clock = 1000;
  const observations = createOperatorObservations({ now: () => clock });
  const target = { id: 'pane', generation: 'g1', kind: 'codex', provider: 'codex', agentPid: 7, processState: 'running', agentProcessState: 'running' };
  // Exactly the executor's auto-observation sequence for the current round.
  observations.invalidate('pane');
  const readId = observations.beginRead(target, 2);
  const token = observations.observe(target, { ok: true, id: 'pane', generation: 'g1', sequence: 10, inputRevision: 2 }, [], { readId, modelRound: 2 });
  assert.equal(observations.latest(target, 2), undefined, 'A same-round read is still never implicit evidence.');
  const send = { kind: 'send_prompt', text: 'Review the latest changes.' };
  assert.throws(() => observations.authorize(token, { ...target, pendingInput: true }, send), /The terminal changed after the last observation/);
  assert.throws(() => observations.authorize('not-a-real-token', target, send), /missing, used, or stale/);
  const record = observations.authorize(token, target, send);
  observations.consume(record, target, send);
  assert.throws(() => observations.authorize(token, target, send), /missing, used, or stale/);
});

// A Brain that pages with beforeSequence: 1 is reading the current screen (there
// is nothing before the first sample), and a current read mints the token every
// later step binds to. The ladder's T3.3 spent 33 calls on reads that minted none.
test('a read with beforeSequence 1 is the current screen and mints the observation token', async t => {
  const f = await fixture(t);
  const result = await f.run([call({ kind: 'read_session', targetId: 'pane', beforeSequence: 1 }),
    body => { assert.equal(typeof latest(body).observationToken, 'string', JSON.stringify(latest(body)).slice(0, 300)); return call({ kind: 'send_prompt', targetId: 'pane', text: 'Review the latest changes.' }); },
    read(), implicitFinish]);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1);
});

// Every tier-5 navigation step on the completion ladder carried a mouse "move"
// beside its typed text ("/status" + Enter + move to 1,1) and was refused for
// mixing controls. The move is a no-op the model adds by habit and is dropped;
// a click beside typed text is still two steps and still refused.
test('a mouse move beside typed navigation text is dropped rather than refused', async t => {
  const f = await fixture(t);
  const result = await f.run([read(), body => operation(body, 'terminal_interact', { text: '/status', keys: ['enter'], inputPurpose: 'interaction',
    mouse: { x: 1, y: 1, button: 'left', action: 'move' } }), read(), finish]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.effects.map(action => action.kind), ['terminal_interact']);
  assert.equal(f.effects[0].mouse, undefined);
  assert.equal(f.effects[0].text, '/status');
});
