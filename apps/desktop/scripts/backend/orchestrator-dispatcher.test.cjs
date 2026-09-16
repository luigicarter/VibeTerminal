'use strict';
// The application performs a bound task handoff itself: read, send, read,
// finish, through the ordinary grant/observation/receipt validators. It authors
// no assistant or tool message, so every assistant turn in any model transcript
// is the model's own. A delivery it cannot complete returns control with one
// plain user-role report and is never retried.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createDispatcher } = require('../../backend/orchestratorDispatcher.cjs');
const { normalizeIntent, bindDelegatedTask } = require('../../backend/orchestratorIntent.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const jsonResponse = body => new Response(JSON.stringify(body));

// --- unit: one bound grant, scripted action results -------------------------

function unit({ send = { ok: true, status: 'written' }, session: overrides = {}, requests = [] } = {}) {
  const cwd = process.platform === 'win32' ? 'C:\\project' : '/project';
  const objective = 'Investigate the performance of the orchestrator.';
  const session = { id: 'pane', generation: 'g1', kind: 'codex', provider: 'codex', cwd, launchToken: 1, name: 'Codex 1',
    started: true, status: 'idle', processState: 'running', agentProcessState: 'running', agentPid: 44,
    observation: 'observed', turnState: 'idle', revision: 1, ...overrides };
  const compiled = normalizeIntent({ goal: 'Investigate the performance issue.',
    actions: [{ kind: 'delegate_task', text: objective, cwd, assignmentMode: 'auto' }] },
    { instruction: 'Use one of the empty terminals to investigate performance.', requestId: 'user-1', sessions: [session], requests: [] });
  const plan = bindDelegatedTask(compiled, compiled.grants[0].id, session,
    { sessions: [session], expectedTarget: { id: session.id, generation: session.generation, launchToken: session.launchToken } });
  const f = { plan, session, objective, actions: [], outcomes: [], diagnostics: [], receipts: [], reads: 0 };
  f.dispatcher = createDispatcher({
    doAction: async action => {
      f.actions.push(structuredClone(action));
      if (action.kind === 'read_session') return { ok: true, observationToken: `token-${++f.reads}`, observation: { text: 'Ready.' } };
      if (action.kind === 'send_prompt') return structuredClone(send);
      if (action.kind === 'finish_terminal') {
        return action.outcome === 'blocked'
          ? { ok: false, status: 'blocked', text: action.text, targetId: action.targetId }
          : { ok: true, status: 'interaction-complete', text: action.text, targetId: action.targetId };
      }
      throw new Error(`Unexpected action ${action.kind}`);
    },
    observations: () => ({ authorize: () => ({}) }),
    getSessions: () => [session], getRequests: () => requests,
    getOperation: () => ({ steps: 0, uncertain: false, sentTasks: new Set(), history: [] }),
    getWaits: () => [],
    recordDiagnostic: entry => f.diagnostics.push(entry),
    receipt: (action, result) => f.receipts.push({ kind: action.kind, ok: result?.ok }),
    outcomes: f.outcomes, diagnosticContext: { requestId: 'request-1' } });
  f.run = () => f.dispatcher.run({ plan, grants: plan.grants, modelRound: 0 });
  f.grantId = plan.grants[0].id;
  return f;
}

test('a bound handoff reads, sends, reads again and finishes, each step under its own dispatch id', async () => {
  const f = unit();
  const result = await f.run();
  assert.deepEqual(f.actions.map(action => action.kind), ['read_session', 'send_prompt', 'read_session', 'finish_terminal']);
  assert.deepEqual(result.handled, [f.grantId]);
  assert.deepEqual(result.fallback, []);
  const steps = f.actions.filter(action => action.stepId).map(action => action.stepId);
  assert.equal(steps.length, 2, 'only the two authorized writes carry a step');
  for (const step of steps) assert.match(step, /^dispatch-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(new Set(steps).size, 2, 'a step is never replayed');
  // Every write is bound to the token minted by the read immediately before it.
  assert.equal(f.actions[1].observationToken, 'token-1');
  assert.equal(f.actions[3].observationToken, 'token-2');
  assert.equal(f.actions[1].text, f.objective);
  assert.equal(f.actions[1].grantId, f.grantId);
  assert.equal(f.actions[3].outcome, 'completed');
  assert.deepEqual(f.outcomes.map(outcome => outcome.kind), ['send_prompt', 'finish_terminal']);
  const stages = f.diagnostics.filter(entry => entry.stage === 'dispatch');
  assert.deepEqual(stages.map(entry => [entry.handledCount, entry.fallbackCount]), [[1, 0]]);
  assert.deepEqual(f.diagnostics.filter(entry => entry.stage === 'tool_started').map(entry => entry.actionKind),
    ['read_session', 'send_prompt', 'read_session', 'finish_terminal']);
  assert.deepEqual(f.diagnostics.filter(entry => entry.stage === 'tool_complete').map(entry => entry.actionKind),
    ['read_session', 'send_prompt', 'read_session', 'finish_terminal']);
});

test('a refused send returns control with its reason and never finishes the operation', async () => {
  const f = unit({ send: { ok: false, status: 'input-surface-unverified', delivery: 'not-dispatched',
    error: 'Open Claude Code 11 could not accept input. The terminal is showing a startup screen.' } });
  const result = await f.run();
  assert.deepEqual(f.actions.map(action => action.kind), ['read_session', 'send_prompt']);
  assert.deepEqual(result.handled, []);
  assert.deepEqual(result.fallback, [{ grantId: f.grantId, targetId: 'pane', status: 'input-surface-unverified',
    reason: 'Open Claude Code 11 could not accept input. The terminal is showing a startup screen.', screen: 'Ready.' }]);
  assert.equal(f.outcomes.some(outcome => outcome.kind === 'finish_terminal'), false);
  assert.deepEqual(f.diagnostics.filter(entry => entry.stage === 'dispatch').map(entry => [entry.handledCount, entry.fallbackCount]), [[0, 1]]);
});

// The application retries a screen race itself, inside the native adapter, where
// it can prove nothing was written and that the input revision never moved. By
// the time a refusal reaches the dispatcher that retry is already spent, so a
// second send here would be a duplicate prompt.
test('a refused write already carries its attempt count and is handed back once', async () => {
  const f = unit({ send: { ok: false, status: 'stale-observation', delivery: 'not-dispatched', reason: 'surface-changed', attempts: 3 } });
  const result = await f.run();
  assert.equal(f.actions.filter(action => action.kind === 'send_prompt').length, 1);
  assert.deepEqual(f.actions.map(action => action.kind), ['read_session', 'send_prompt']);
  assert.deepEqual(result.handled, []);
  assert.equal(result.fallback.length, 1);
  assert.equal(result.fallback[0].status, 'stale-observation');
  assert.equal(f.outcomes.some(outcome => outcome.kind === 'finish_terminal'), false);
});

test('an unknown write outcome stops without retrying the write', async () => {
  const f = unit({ send: { ok: false, status: 'unknown', error: 'Action adapter returned no acknowledgment.' } });
  const result = await f.run();
  assert.equal(f.actions.filter(action => action.kind === 'send_prompt').length, 1, 'an uncertain write is never replayed');
  assert.deepEqual(f.actions.map(action => action.kind), ['read_session', 'send_prompt', 'read_session', 'finish_terminal']);
  assert.equal(f.actions[3].outcome, 'blocked');
  assert.equal(f.actions[3].text, 'Prompt delivery is unconfirmed. It has not been replayed.');
  assert.deepEqual(result.handled, []);
  assert.equal(result.fallback.length, 1);
  assert.equal(result.fallback[0].status, 'blocked');
  assert.match(result.fallback[0].reason, /unconfirmed/);
});

for (const [name, options] of [
  ['a pending interaction', { requests: [{ id: 'q1', sessionId: 'pane', generation: 'g1', state: 'pending', kind: 'question' }] }],
  ['a waiting terminal', { session: { status: 'waiting' } }],
  ['a dirty composer', { session: { composer: { dirty: true } } }],
  ['a reserved composer', { session: { composer: { reserved: true } } }],
]) test(`${name} hands control back before any write`, async () => {
  const f = unit(options);
  const result = await f.run();
  assert.deepEqual(f.actions.map(action => action.kind), ['read_session'], 'nothing is typed');
  assert.deepEqual(result.handled, []);
  assert.deepEqual(result.fallback, [{ grantId: f.grantId, targetId: 'pane', status: 'pending-interaction',
    reason: 'The terminal is waiting on input that is not this task.', screen: 'Ready.' }]);
});

// --- integration: the whole request, through the real relay ------------------

// `commandCompiler: false` forces the model interpretation route for a sentence
// the deterministic compiler would otherwise take before any model call.
async function relay(t, { sendResults = [], plan, commandCompiler } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dispatcher-'));
  const f = { root, sessions: [], effects: [], bodies: [], sends: 0 };
  f.sessions.push({ id: 'pane', name: 'Codex 1', kind: 'codex', provider: 'codex', cwd: root, generation: 'g1', launchToken: 1,
    conversationId: 'conversation-pane', started: true, status: 'idle', observation: 'observed', processState: 'running',
    agentProcessState: 'running', agentPid: 55, turnState: 'idle', revision: 1, lastActivityAt: 1000 });
  f.relay = createOrchestrator({ userDataPath: root, ...(commandCompiler !== undefined && { commandCompiler }), secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [{ name: path.basename(root), path: root }] }),
    getSessions: () => f.sessions, getLaunchers: async () => [{ kind: 'codex', label: 'Codex', available: true, configured: true }],
    readSession: async target => ({ ok: true, id: target.id, generation: target.generation, text: 'Ready.', sequence: 10, inputRevision: 2 }),
    dispatchAction: async action => {
      f.effects.push(action);
      if (action.kind !== 'send_prompt') return { ok: true, status: 'written' };
      return sendResults[f.sends++] || { ok: true, status: 'written' };
    },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return jsonResponse({ data: {} });
      if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'scripted', context_length: 128000, supported_parameters: ['tools', 'tool_choice'] }] });
      const body = JSON.parse(options.body);
      f.bodies.push(body);
      if (body.tools?.some(tool => tool.function.name === 'interpret_workspace')) {
        return jsonResponse({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'intent-1', type: 'function',
          function: { name: 'interpret_workspace', arguments: JSON.stringify(plan(root)) } }] } }] });
      }
      try { return f.executor(body); } catch (error) { f.fetchError = error; throw error; }
    } });
  t.after(async () => { await f.relay.cancel(); await f.relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await f.relay.configure({ apiKey: 'test-key', model: 'scripted', sessionOnly: true });
  assert.equal((await f.relay.setEnabled(true)).ok, true);
  f.executor = () => assert.fail('No executor model round is expected');
  f.executorBodies = () => f.bodies.filter(body => !body.tools?.some(tool => tool.function.name === 'interpret_workspace'));
  f.appAuthored = body => body.messages.filter(message => message.role === 'assistant');
  return f;
}

// Both routes into a healthy delegated start are locked: the request costs at
// most one model call, and whichever route it took, the application authors no
// assistant turn and the delivery finishes in code.
async function healthyStart(t, options) {
  const objective = 'Investigate the performance of the orchestrator.';
  const f = await relay(t, { plan: root => ({ goal: objective, actions: [{ kind: 'delegate_task', text: objective, cwd: root }] }), ...options });
  const result = await f.relay.send({ text: `Have a Codex terminal ${objective}`, origin: 'text', projectPath: f.root });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt']);
  assert.equal(f.effects[0].targetId, 'pane');
  assert.equal(f.effects[0].text, objective);
  for (const body of f.bodies) {
    assert.deepEqual(f.appAuthored(body), [], 'the application authors no assistant turn');
    assert.equal(body.messages.some(message => (message.tool_calls || []).some(call => /^(?:agent-handoff|dispatch)-/.test(String(call.id)))), false);
    assert.equal(body.messages.some(message => message.role === 'tool'), false);
  }
  assert.equal(result.actions.filter(action => action.kind === 'finish_terminal' && action.status === 'interaction-complete').length, 1);
  return f;
}

test('a healthy delegated start completes on at most one model call and no assistant turn at all', { timeout: 4000 }, async t => {
  // The deterministic compiler reads this sentence itself once the request
  // carries a project view, so the call count is zero rather than one. Either
  // way the executor is never reached and the dispatcher finishes in code.
  const f = await healthyStart(t);
  assert.ok(f.bodies.length <= 1, `interpretation is the only model call that may happen, saw ${f.bodies.length}`);
  assert.deepEqual(f.executorBodies(), [], 'no executor round either way');
});

test('the same start on the model route still costs exactly one interpretation call', { timeout: 4000 }, async t => {
  const f = await healthyStart(t, { commandCompiler: false });
  assert.equal(f.bodies.length, 1, 'interpretation is the only model call');
  assert.deepEqual(f.executorBodies(), [], 'the interpretation is not followed by an executor round');
});

test('a refused send reaches the model as one user-role delivery report it can act on', { timeout: 4000 }, async t => {
  const objective = 'Investigate the performance of the orchestrator.';
  const f = await relay(t, { plan: root => ({ goal: objective, actions: [{ kind: 'delegate_task', text: objective, cwd: root }] }),
    sendResults: [{ ok: false, status: 'input-surface-unverified', delivery: 'not-dispatched',
      error: 'Codex 1 could not accept input. It is asking whether to trust the files in this folder.' }] });
  let round = 0;
  const issued = new Set();
  const call = action => {
    const id = `model-${++round}`; issued.add(id);
    return jsonResponse({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id,
      type: 'function', function: { name: 'workspace', arguments: JSON.stringify(action) } }] } }] });
  };
  // Every assistant turn in the transcript must be one this stub actually wrote.
  const onlyModelTurns = body => {
    for (const message of body.messages.filter(message => message.role === 'assistant')) {
      for (const toolCall of message.tool_calls || []) assert.ok(issued.has(toolCall.id), `assistant tool call ${toolCall.id} was never returned by the model`);
      assert.ok((message.tool_calls || []).length || typeof message.content === 'string', 'an assistant turn carries either the model tool calls or its own text');
    }
  };
  f.executor = body => {
    const executorRound = f.executorBodies().length;
    onlyModelTurns(body);
    const grant = JSON.parse(body.messages.find(message => message.role === 'user').content).authorizedCommands.grants[0];
    if (executorRound === 1) {
      // Exactly one application report, addressed to the model as user text.
      const reports = body.messages.filter(message => message.role === 'user' && String(message.content).includes('deliveryReport'));
      assert.equal(reports.length, 1);
      assert.deepEqual(f.appAuthored(body), []);
      assert.equal(body.messages.some(message => message.role === 'tool'), false);
      const entries = JSON.parse(reports[0].content).deliveryReport;
      assert.equal(entries.length, 1);
      assert.equal(entries[0].targetId, 'pane');
      assert.equal(entries[0].status, 'input-surface-unverified');
      assert.match(entries[0].reason, /whether to trust the files in this folder/);
      assert.equal(entries[0].screen, 'Ready.');
      return call({ kind: 'read_session', targetId: 'pane' });
    }
    const observed = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
    if (executorRound === 2) {
      return call({ kind: 'send_prompt', grantId: grant.id, targetId: 'pane', stepId: 'model-send', observationToken: observed.observationToken,
        text: grant.text});
    }
    // The application observed the pane after the model's own send. That screen
    // and its token arrive as a user-role observation, never as a tool result
    // answering a read the model never asked for.
    const observations = body.messages.filter(message => message.role === 'user')
      .map(message => { try { return JSON.parse(message.content); } catch { return null; } })
      .filter(payload => payload && Object.keys(payload).join() === 'observation')
      .map(payload => payload.observation);
    assert.equal(observations.length, 1, 'one application observation after the send');
    const supplied = observations[0];
    assert.equal(supplied.targetId, 'pane');
    assert.equal(supplied.generation, 'g1');
    assert.equal(typeof supplied.observationToken, 'string');
    assert.equal(supplied.observation.text, 'Ready.');
    assert.equal(body.messages.filter(message => message.role === 'tool').length, 2, 'only the model’s own two calls have tool results');
    f.suppliedObservation = supplied;
    return call({ kind: 'finish_terminal', grantId: grant.id, targetId: 'pane', stepId: 'model-finish',
      observationToken: supplied.observationToken, outcome: 'completed', text: 'The task prompt was submitted.' });
  };
  const result = await f.relay.send({ text: `Have a Codex terminal ${objective}`, origin: 'text', projectPath: f.root });
  assert.equal(result.ok, true, JSON.stringify(result) + String(f.fetchError?.message || ''));
  assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt', 'send_prompt']);
  assert.equal(f.effects[1].text, objective);
  assert.ok(f.suppliedObservation, 'the model acted on the application observation');
  // Not one application-authored assistant turn in any request body, ever.
  for (const body of f.bodies) {
    onlyModelTurns(body);
    assert.equal(body.messages.some(message => message.role === 'assistant' &&
      (message.tool_calls || []).some(item => /^(?:agent-handoff|dispatch)-/.test(String(item.id)))), false);
  }
  assert.equal(f.bodies.filter(body => body.messages.filter(message => message.role === 'user' && String(message.content).includes('deliveryReport')).length > 1).length, 0);
});

test('the direct path executes its grants in code with no synthesized assistant message', { timeout: 4000 }, async t => {
  const f = await relay(t, { plan: () => ({ goal: 'Send the review prompt.', executionMode: 'direct',
    actions: [{ kind: 'send_prompt', targetIds: ['pane'], text: 'Review the latest changes.' }] }) });
  const result = await f.relay.send({ text: 'Put "Review the latest changes." into Codex 1.', origin: 'text', targetId: 'pane' });
  assert.equal(result.ok, true, JSON.stringify(result) + String(f.fetchError?.message || ''));
  assert.deepEqual(f.executorBodies(), [], 'a direct plan never reaches the executor model');
  for (const body of f.bodies) assert.deepEqual(f.appAuthored(body), []);
  assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt']);
  assert.equal(f.effects[0].targetId, 'pane');
  assert.equal(f.effects[0].text, 'Review the latest changes.');
  assert.equal(result.text, "Typed the task into Codex 1, but I haven't seen it start yet. I'll tell you when it does.");
  assert.deepEqual(result.actions.map(action => [action.kind, action.status]), [['send_prompt', 'written']]);
  assert.equal(f.relay.getState().receipts.filter(receipt => receipt.kind === 'send_prompt' && receipt.status === 'written').length, 1);
});

// A fan-out ("on both terminals that are done, push the fixes") is the same
// bound handoff once per pane, in the plan's order. On the ladder the model
// loop stepped through exactly that (read, read, send, send, read, read,
// finish, finish) in five rounds and fifty seconds; the application does it
// with no model round at all, and a refusal on one pane hands back that pane.
test('a fan-out over bound panes is delivered pane by pane in code, and a refused pane is handed back', async () => {
  const cwd = process.platform === 'win32' ? 'C:\\project' : '/project';
  const pane = id => ({ id, generation: 'g-' + id, kind: 'codex', provider: 'codex', cwd, launchToken: 1, name: 'Codex ' + id,
    started: true, status: 'idle', processState: 'running', agentProcessState: 'running', agentPid: 44, observation: 'observed', turnState: 'completed', turnId: 't-' + id, revision: 1 });
  const sessions = [pane('a'), pane('b')];
  const build = () => normalizeIntent({ goal: 'Push the fixes.', actions: [{ kind: 'operate_terminal', targetIds: ['a', 'b'], selection: 'all', operationMode: 'task',
    promptMode: 'compose', text: 'Push the tested fixes.' }] }, { instruction: 'On both terminals that are done, push the fixes.', requestId: 'user-2', sessions, requests: [] });
  const harness = (send = () => ({ ok: true, status: 'written' })) => {
    const f = { actions: [], outcomes: [], reads: 0 };
    f.plan = build();
    f.dispatcher = createDispatcher({
      doAction: async action => {
        f.actions.push([action.kind, action.targetId]);
        if (action.kind === 'read_session') return { ok: true, observationToken: 'token-' + (++f.reads), observation: { text: 'Ready.' } };
        if (action.kind === 'send_prompt') return send(action);
        if (action.kind === 'finish_terminal') return { ok: true, status: 'interaction-complete', text: action.text, targetId: action.targetId };
        throw new Error('Unexpected action ' + action.kind);
      },
      observations: () => ({ authorize: () => ({}) }), getSessions: () => sessions, getRequests: () => [],
      getOperation: () => ({ steps: 0, uncertain: false, sentTasks: new Set(), history: [] }), getWaits: () => [],
      outcomes: f.outcomes, diagnosticContext: { requestId: 'request-2' } });
    return f;
  };
  const both = harness();
  const result = await both.dispatcher.run({ plan: both.plan, grants: both.plan.grants, modelRound: 0 });
  assert.deepEqual(result.handled, [both.plan.grants[0].id]);
  assert.deepEqual(result.fallback, []);
  assert.deepEqual(both.actions, [['read_session', 'a'], ['send_prompt', 'a'], ['read_session', 'a'], ['finish_terminal', 'a'],
    ['read_session', 'b'], ['send_prompt', 'b'], ['read_session', 'b'], ['finish_terminal', 'b']]);
  const refused = harness(action => action.targetId === 'b' ? { ok: false, status: 'input-buffer-occupied', delivery: 'not-dispatched', error: 'That pane may contain unsent input.' } : { ok: true, status: 'written' });
  const partial = await refused.dispatcher.run({ plan: refused.plan, grants: refused.plan.grants, modelRound: 0 });
  assert.deepEqual(partial.handled, []);
  assert.deepEqual(partial.fallback.map(item => [item.targetId, item.status]), [['b', 'input-buffer-occupied']], 'the first pane was delivered; the second is handed back with its reason');
  assert.deepEqual(refused.actions.map(item => item.join(':')), ['read_session:a', 'send_prompt:a', 'read_session:a', 'finish_terminal:a', 'read_session:b', 'send_prompt:b']);
});
