'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');

async function fixture(t, { count = 8, reason = false, modelIntent = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-close-chain-'));
  const f = { root, sessions: [], effects: [], spoken: [], plans: [], intentBodies: [], reviews: [], reads: 0, modelReplies: 0 };
  f.pane = (id, extra = {}) => ({ id, name: `Worker ${id}`, generation: `g-${id}`, launchToken: 1, visiblePane: true,
    projectId: 'project', board: 'project', inventoryRevision: 1, cwd: root, kind: 'codex', provider: 'codex',
    started: true, status: 'idle', processState: 'running', agentProcessState: 'running', agentPid: 101, observation: 'observed', turnState: 'idle', ...extra });
  f.sessions = Array.from({ length: count }, (_, i) => f.pane(`pane-${i}`, i >= count / 2 ? { status: 'paused', started: false, processState: 'exited', agentProcessState: 'exited' } : {}));
  f.plan = { goal: 'Close all project terminals.', executionMode: reason ? 'reason' : 'direct', actions: [{ kind: 'close', scope: { type: 'project', projectId: 'project' } }] };
  const json = body => new Response(JSON.stringify(body)); let toolId = 0;
  const tool = (name, args) => ({ id: `tool-${++toolId}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  f.closed = action => {
    const target = { id: action.targetId, generation: action.generation, launchToken: action.target?.launchToken ?? 1 };
    f.sessions = f.sessions.filter(item => item.id !== target.id);
    return { ok: true, status: 'closed', close: { operationId: action.actionId, target, pane: 'removed', process: 'stopped', launchSettled: true } };
  };
  f.app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => { f.reads++; if (f.inventoryFails) throw Error('Synthetic inventory unavailable.'); return f.sessions; },
    getRoots: () => ({ documents: root, projects: [{ id: 'project', name: 'Project', path: root }] }),
    interpretIntent: modelIntent ? undefined : () => f.plan,
    onSpeak: event => { f.spoken.push(event); return { ok: true }; },
    dispatchAction: action => { assert.equal(action.kind, 'close'); f.effects.push(action); return f.close ? f.close(action) : f.closed(action); },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return json({ data: {} });
      if (url.endsWith('/models')) return json({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] });
      const body = JSON.parse(options.body);
      if (body.messages[0].content.startsWith('Review terminal close authorization')) {
        const payload = JSON.parse(body.messages[1].content); f.reviews.push(payload);
        if (f.reviewError) throw f.reviewError;
        const reviewed = { operations: payload.operations.map(operation => ({ operation: operation.operation,
          condition: f.condition || 'unconditional', count: f.expectedCount ?? null,
          evidence: [{ sourceId: 'current', quote: payload.currentInstruction }] })) };
        f.onReview?.();
        return json({ choices: [{ finish_reason: 'stop', message: { content: f.reviewResponse ?? JSON.stringify(reviewed) } }] });
      }
      if (body.tools?.some(item => item.function.name === 'interpret_workspace')) {
        f.intentBodies.push(body); const plan = f.plans.shift(); assert.ok(plan);
        return json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [tool(f.planningTool || 'interpret_workspace', typeof plan === 'function' ? plan(body) : plan)] } }] });
      }
      f.modelReplies++;
      const context = JSON.parse(body.messages.find(message => message.role === 'user').content);
      const grant = context.authorizedCommands.grants.find(item => item.kind === 'close');
      if (!grant) return json({ choices: [{ finish_reason: 'stop', message: { content: 'The earlier request failed during interpretation; no terminal action was dispatched.' } }] });
      const remaining = grant.targets.filter(target => !f.effects.some(action => action.targetId === target.id));
      if (remaining.length || !grant.targets.length && f.modelReplies === 1) {
        const targets = remaining.length ? remaining.slice(0, 4) : [null];
        return json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: targets.map(target => tool('workspace', { kind: 'close', grantId: grant.id, ...(target && { targetId: target.id }) })) } }] });
      }
      return json({ choices: [{ finish_reason: 'stop', message: { content: 'All terminals closed successfully.' } }] });
    }
  });
  t.after(async () => { await f.app.cancel(); await f.app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('vibe-close-chain-')); fs.rmSync(root, { recursive: true, force: true }); });
  await f.app.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true }); await f.app.setEnabled(true);
  f.run = (text = 'Close all terminals in Project.') => f.app.send({ text, origin: 'voice' });
  return f;
}

test('main close pipeline closes eight visible active and paused panes and acknowledges verified completion', async t => {
  const f = await fixture(t); const result = await f.run();
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 8); assert.equal(f.sessions.length, 0);
  assert.equal(new Set(f.effects.map(action => action.targetId)).size, 8);
  assert.equal(result.text, 'done'); assert.equal(f.spoken.filter(event => event.completionCue).length, 1);
});

test('partial and unknown process closure overrides model success and never emits done', async t => {
  const f = await fixture(t, { count: 2, reason: true });
  f.close = action => { const result = f.closed(action); return f.effects.length === 1 ? result : { ...result, status: 'close_requested', close: { ...result.close, process: 'unknown' } }; };
  const result = await f.run(); assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(f.modelReplies, 2); assert.match(result.text, /Closed 1 of 2/); assert.match(result.text, /unconfirmed/);
  assert.doesNotMatch(result.text, /All terminals closed successfully/); assert.equal(f.spoken.filter(event => event.completionCue).length, 0);
});

test('empty project reports a factual no-op with zero adapter effects', async t => {
  const f = await fixture(t, { count: 0 }); const result = await f.run();
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 0);
  assert.match(result.text, /No .*terminals.*close/i); assert.notEqual(result.text, 'done');
});

test('new pane arriving during close is preserved and reported without bare done', async t => {
  const f = await fixture(t, { count: 2 });
  f.close = action => { const result = f.closed(action); if (f.effects.length === 1) f.sessions.push(f.pane('newcomer')); return result; };
  const result = await f.run(); assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.sessions.map(item => item.id), ['newcomer']); assert.equal(f.effects.length, 2);
  assert.match(result.text, /2 of 2 original/); assert.match(result.text, /1 new terminal remains open/);
  assert.equal(f.spoken.filter(event => event.completionCue).length, 0);
});

test('failed fresh inventory admission cannot dispatch against a stale cached scope', async t => {
  const f = await fixture(t); await f.app.refresh(); f.inventoryFails = true;
  const result = await f.run(); assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(f.effects.length, 0);
  assert.equal(f.spoken.filter(event => event.completionCue).length, 0);
});

test('legacy model-selected partial ID list is repaired into project scope before any close effect', async t => {
  const f = await fixture(t, { modelIntent: true });
  f.plans.push({ goal: 'Close all project terminals.', executionMode: 'direct', actions: [{ kind: 'close', targetIds: ['pane-0', 'pane-1', 'pane-2', 'pane-3'], selection: 'all' }] });
  f.plans.push(body => { assert.match(body.messages[0].content, /Validation failure/); assert.equal(f.effects.length, 0); return f.plan; });
  const result = await f.run(); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.intentBodies.length, 2);
  assert.equal(f.effects.length, 8); assert.equal(f.sessions.length, 0);
});

test('inactive cleanup rejects the reported running/unknown three-pane proposal before any close', async t => {
  const f = await fixture(t, { count: 4, modelIntent: true }); f.condition = 'inactive'; f.expectedCount = 3;
  Object.assign(f.sessions[0], { status: 'running', turnState: 'running', pendingInput: 'submit' });
  Object.assign(f.sessions[1], { status: 'unknown', observation: 'unavailable', turnState: 'unknown' });
  Object.assign(f.sessions[2], { status: 'unknown', observation: 'unavailable', turnState: 'unknown' });
  f.plans.push({ goal: 'Close the three inactive panes', actions: [{ kind: 'close', scope: { type: 'explicit', targetIds: ['pane-0', 'pane-1', 'pane-2'] } }] });
  const result = await f.run('No, close the three that are inactive.');
  assert.equal(f.reviews.length, 1); assert.equal(f.effects.length, 0); assert.equal(f.sessions.length, 4);
  assert.match(result.text, /cannot reliably identify/i); assert.notEqual(result.text, 'done');
});

test('verified inactive selection closes only its exact panes and keeps the condition on dispatched actions', async t => {
  const f = await fixture(t, { count: 4, modelIntent: true }); f.condition = 'inactive'; f.expectedCount = 2;
  f.plans.push({ goal: 'Close two inactive panes', actions: [{ kind: 'close', scope: { type: 'explicit', targetIds: ['pane-0', 'pane-1'] } }] });
  const result = await f.run('Close the two inactive terminals.');
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 2);
  assert(f.effects.every(action => action.closeScope.condition === 'inactive'));
  assert.deepEqual(f.sessions.map(session => session.id), ['pane-2', 'pane-3']);
});

test('explicit unconditional project close still closes busy panes after user-scope review', async t => {
  const f = await fixture(t, { count: 2, modelIntent: true });
  Object.assign(f.sessions[0], { status: 'running', pendingInput: 'submit', turnState: 'running' });
  f.plans.push(f.plan); const result = await f.run();
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 2); assert.equal(f.reviews.length, 1);
});

test('requested count mismatch and inconclusive close review both preserve every pane', async t => {
  for (const malformed of [false, true]) {
    const f = await fixture(t, { count: 2, modelIntent: true }); f.condition = 'inactive'; f.expectedCount = 3;
    if (malformed) f.reviewResponse = 'unconditional';
    f.plans.push(f.plan); const result = await f.run('Close three inactive terminals.');
    assert.equal(f.reviews.length, 1); assert.equal(f.effects.length, 0); assert.equal(f.sessions.length, 2); assert.match(result.text, /cannot reliably identify/);
  }
});

test('inactive condition is checked again if a remaining pane starts work during closure', async t => {
  const f = await fixture(t, { count: 2, modelIntent: true }); f.condition = 'inactive';
  f.plans.push(f.plan);
  f.close = action => { const result = f.closed(action); if (f.sessions[0]) Object.assign(f.sessions[0], { status: 'running', turnState: 'running' }); return result; };
  const result = await f.run('Close the inactive project terminals.');
  assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(f.effects.length, 1); assert.equal(f.sessions.length, 1);
  assert.notEqual(result.text, 'done'); assert.equal(f.spoken.filter(event => event.completionCue).length, 0);
});

test('close review network failure does not close any pane', async t => {
  const f = await fixture(t, { count: 2, modelIntent: true }); f.reviewError = Error('Fixture network unavailable');
  f.plans.push(f.plan); const result = await f.run();
  assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(f.effects.length, 0);
});

test('ordinary error question uses the conversation planning tool with no terminal effects', async t => {
  const f = await fixture(t, { count: 2, modelIntent: true }); f.planningTool = 'plan_conversation';
  f.plans.push({ goal: 'Explain the earlier interpretation error using available history.' });
  const result = await f.run('What was that error?');
  assert.equal(result.ok, true, JSON.stringify(result)); assert.match(result.text, /interpretation/);
  assert.equal(f.effects.length, 0); assert.equal(f.reviews.length, 0); assert.equal(f.intentBodies.length, 1);
});
