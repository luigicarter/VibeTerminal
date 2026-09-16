'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { createTaskScheduler } = require('../../backend/orchestratorTasks.cjs');
const tick = () => new Promise(setImmediate);
async function until(predicate) { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) throw Error('Multi-work-item fixture did not settle'); await tick(); } }

async function fixture(t, { separate = false, readOnly = false, explicitOrder, secondControls, controlsOnly = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-multi-work-'));
  const secondRoot = separate ? path.join(root, 'other-project') : root;
  if (separate) fs.mkdirSync(secondRoot);
  const f = { root, effects: [], plans: [], sessions: [], phases: new Map(), toolSequence: 0, recovered: 0, lastAction: new Map(), reported: new Set() };
  const nativeSession = (id, cwd) => ({ id, generation: `generation-${id}`, launchToken: 1, cwd, kind: 'codex', provider: 'codex',
    conversationId: `conversation-${id}`, name: id, started: true, observation: 'observed', processState: 'running',
    agentProcessState: 'running', agentPid: 42, turnState: 'idle', revision: 1 });
  if (explicitOrder) f.sessions.push(nativeSession('explicit-worker', explicitOrder === 'first' ? root : secondRoot));
  f.relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [...new Set([root, secondRoot])] }), getSessions: () => f.sessions,
    getLaunchers: () => [{ kind: 'codex', available: true, configured: true }],
    interpretIntent: () => { const plan = f.plans.shift(); assert.ok(plan); return plan; },
    routeTask: () => ({ kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'Separate work needs a separate conversation.' }),
    readSession: async target => ({ ok: true, id: target.id, generation: target.generation, sequence: 1, inputRevision: 0, text: '> ' }),
    dispatchAction: action => {
      f.effects.push(action);
      if (action.kind === 'create_session') {
        const id = `worker-${f.sessions.length + 1}`;
        const session = nativeSession(id, action.cwd);
        f.sessions.push(session);
        return { ok: true, id, launchToken: 1, status: 'created', processState: 'running', target: { id, generation: session.generation, launchToken: 1 } };
      }
      if (action.kind === 'interrupt') return new Promise(resolve => { f.releaseControl = () => resolve({ ok: true, status: 'written' }); });
      assert.ok(['send_prompt', 'terminal_interact'].includes(action.kind));
      if (action.kind === 'terminal_interact' && action.inputPurpose === 'interaction') return { ok: true, status: 'written' };
      Object.assign(f.sessions.find(session => session.id === action.target.id), { turnId: action.actionId, turnState: 'running', turnStartedAt: Date.now() });
      return { ok: true, status: 'written', turnId: action.actionId };
    },
    fetch: async (url, options) => {
      const response = value => new Response(JSON.stringify(value));
      if (url.endsWith('/key')) return response({ data: {} });
      if (url.endsWith('/models')) return response({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] });
      const body = JSON.parse(options.body);
      const users = body.messages.filter(message => message.role === 'user');
      const context = JSON.parse(users[0].content);
      // The application never authors an assistant turn. A delivery it could not
      // complete arrives here as one plain user-role report instead.
      assert.equal(body.messages.some(message => message.role === 'assistant' && message.tool_calls?.some(call => /^(?:agent-handoff|dispatch)-/.test(String(call.id)))), false);
      const reports = users.slice(1).flatMap(message => { try { return JSON.parse(message.content).deliveryReport || []; } catch { return []; } });
      const tools = body.messages.filter(message => message.role === 'tool'), last = tools.length ? JSON.parse(tools.at(-1).content) : null;
      const previous = f.lastAction.get(context.instruction);
      // A stale observation is refused whether the model or the application's own
      // bound handoff issued the write; either way the next attempt must reread.
      const fresh = reports.filter(entry => !f.reported.has(JSON.stringify(entry)));
      for (const entry of fresh) f.reported.add(JSON.stringify(entry));
      if ((last?.validationFailure && (previous?.kind === 'send_prompt' || /Read it again/.test(String(last.error || '')))) ||
          fresh.some(entry => /Read it again/.test(String(entry.reason || '')))) {
        assert.equal(++f.recovered, 1, 'Only the deliberately stale token requires recovery');
        if (previous?.kind === 'send_prompt') f.phases.set(previous.grantId, 0);
      }
      // The application delivers bound task handoffs itself; this model only owns
      // the grants it has not already submitted through its own handoff steps.
      const handled = new Set(f.effects.filter(action => String(action.stepId || '').startsWith('dispatch-')).map(action => action.grantId));
      const pending = context.authorizedCommands.grants.filter(grant => !handled.has(grant.id));
      const grant = pending.find(grant => (f.phases.get(grant.id) || 0) < 4);
      if (!grant) { assert.deepEqual(pending, [], 'All granted operators must converge'); return response({ choices: [{ finish_reason: 'stop', message: { content: 'The authorized work is submitted.' } }] }); }
      const phase = f.phases.get(grant.id) || 0; f.phases.set(grant.id, phase + 1);
      const targetId = grant.targets[0].id;
      let action;
      if (phase === 0 || phase === 2) action = { kind: 'read_session', targetId };
      else {
        const base = { targetId, grantId: grant.id, stepId: `step-${++f.toolSequence}`, observationToken: last.observationToken };
        action = phase === 1 ? context.instruction === 'Interrupt first worker.' ? { ...base, kind: 'interrupt' }
          : { ...base, kind: 'send_prompt', text: grant.text}
          : { ...base, kind: 'finish_terminal', outcome: 'completed', text: 'Submission inspected.' };
        if (phase === 1 && grant.id === context.authorizedCommands.grants[1]?.id && (secondControls || controlsOnly)) {
          action = { ...base, kind: 'terminal_interact', 
            inputPurpose: controlsOnly ? 'interaction' : 'task', ...(secondControls || { keys: ['down'] }) };
        }
      }
      f.lastAction.set(context.instruction, action);
      return response({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `tool-${++f.toolSequence}`, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(action) } }] } }] });
    } });
  t.after(async () => { f.releaseControl?.(); await f.relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('vibe-multi-work-')); fs.rmSync(root, { recursive: true, force: true }); });
  await f.relay.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true }); assert.equal((await f.relay.setEnabled(true)).ok, true);
  const first = { kind: 'delegate_task', cwd: root, text: readOnly ? 'Review checkout without editing.' : 'Fix checkout.' };
  const second = { kind: 'delegate_task', cwd: secondRoot, text: controlsOnly ? 'Select the menu entry.' : readOnly ? 'Review search without editing.' : 'Fix search.' };
  const explicit = grant => ({ kind: 'operate_terminal', targetIds: ['explicit-worker'], text: grant.text });
  f.plans.push({ goal: 'Work on checkout and search separately.', access: readOnly ? 'read-only' : 'mutation', actions: [
    explicitOrder === 'first' ? explicit(first) : first, explicitOrder === 'second' ? explicit(second) : second] });
  f.pending = f.relay.send({ text: 'Work on checkout and search separately.', origin: 'text' });
  f.sent = () => f.effects.filter(action => action.kind === 'send_prompt' || action.kind === 'terminal_interact' && action.inputPurpose === 'task');
  f.finishFirst = async () => { Object.assign(f.sessions.find(session => session.id === f.sent()[0].target.id), { turnState: 'completed', turnEndedAt: Date.now() }); await f.relay.refresh(); };
  return f;
}

// Two tasks in one repo run side by side: each owns the pane it was given and
// nothing else (2026-09-15). A control on the first worker is still admitted
// while both run.
test('bundled mutations in one repo are both submitted at once, and a control on one worker is admitted beside them', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const result = await f.pending; assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.effects.filter(action => action.kind === 'create_session').length, 2);
  assert.deepEqual(f.sent().map(action => [action.target.id, action.text]), [['worker-1', 'Fix checkout.'], ['worker-2', 'Fix search.']]);
  assert.equal(f.relay.getState().tasks.find(task => task.requestId === result.requestId).status, 'waiting-results');
  f.plans.push({ goal: 'Interrupt first worker.', actions: [{ kind: 'operate_terminal', targetIds: ['worker-1'], text: 'Interrupt first worker.', lifecycleMode: 'interrupt' }] });
  const control = f.relay.send({ text: 'Interrupt first worker.', origin: 'text' });
  await until(() => f.releaseControl);
  f.releaseControl(); assert.equal((await control).ok, true);
});



for (const options of [{ separate: true }, { readOnly: true }]) test(`bundled ${options.separate ? 'separate-project mutations' : 'read-only tasks'} remain independent`, { timeout: 5000 }, async t => {
  const f = await fixture(t, options); const result = await f.pending;
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.sent().length, 2); assert.equal(f.sessions[0].turnState, 'running');
});


for (const explicitOrder of ['first', 'second']) test(`mixed routed/explicit mutations in one repo both run at once, explicit target ${explicitOrder}`, { timeout: 5000 }, async t => {
  const f = await fixture(t, { explicitOrder });
  const result = await f.pending; assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.sent().map(action => action.text), ['Fix checkout.', 'Fix search.']);
  assert.equal(f.sent().filter(action => action.target.id === 'explicit-worker').length, 1);
});

test('mixed routed/explicit tasks in separate workspaces remain independent', { timeout: 5000 }, async t => {
  const f = await fixture(t, { explicitOrder: 'second', separate: true });
  const result = await f.pending; assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.sent().length, 2);
  assert.equal(f.sessions.find(session => session.id === f.sent()[0].target.id).turnState, 'running');
});

test('explicit interaction-only controls remain available beside a running routed sibling', { timeout: 5000 }, async t => {
  const f = await fixture(t, { explicitOrder: 'second', controlsOnly: true });
  const result = await f.pending; assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.sent().length, 1);
  assert.equal(f.effects.filter(action => action.kind === 'terminal_interact' && action.inputPurpose === 'interaction').length, 1);
});



