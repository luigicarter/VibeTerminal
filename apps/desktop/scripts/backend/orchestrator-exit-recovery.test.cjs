'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const response = content => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
const meta = body => JSON.parse(body.messages.find(message => message.role === 'user').content);
const latest = body => JSON.parse(body.messages.findLast(message => message.role === 'tool').content);
const tool = args => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'tool', function: { name: 'workspace', arguments: JSON.stringify(args) } }] } }] });
const read = () => tool({ kind: 'read_session', targetId: 'a' });
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-exit-recovery-'));
  const f = { steps: [], effects: [], contexts: [], sequence: 1, keyRevision: 1, step: 0, session: { id: 'a', generation: 'g', kind: 'codex', provider: 'codex', name: 'Codex', cwd: root, processState: 'running', agentProcessState: 'running', agentPid: 42, observation: 'observed', turnState: 'idle' } };
  f.plan = context => ({ goal: context.instruction, actions: [{ kind: 'operate_terminal', targetIds: ['a'], text: context.instruction }] });
  // The fixture controls only model replies; all grant, token and lifecycle checks run.
  const options = { userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => [f.session], getRoots: () => ({ documents: root, projects: [] }),
    interpretIntent: context => { f.contexts.push(context); return f.plan(context); },
    readSession: async () => ({ ok: true, id: 'a', generation: 'g', sequence: f.sequence, inputRevision: f.keyRevision, text: f.screen || 'Codex composer with draft text', exited: false }),
    dispatchAction: async action => { f.effects.push(action); f.sequence++; f.keyRevision++; return f.dispatch ? f.dispatch(action) : { ok: true, status: 'written' }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] }));
      const body = JSON.parse(options.body); assert.ok(f.steps.length, 'Unexpected model round');
      const step = f.steps.shift();
      try { return new Response(JSON.stringify(typeof step === 'function' ? step(body) : step)); }
      catch (error) { f.scriptError = error; throw error; }
    } };
  f.app = createOrchestrator(options);
  await f.app.configure({ apiKey: 'fixture-secret', sessionOnly: true, model: 'fixture' }); await f.app.setEnabled(true);
  f.act = (body, kind, extra = {}) => { const observed = latest(body); return tool({ kind, grantId: meta(body).authorizedCommands.grants[0].id, targetId: 'a', stepId: `step-${++f.step}`, observationToken: observed.observationToken, ...(['terminal_interact', 'send_prompt', 'interrupt'].includes(kind) && { observationSequence: observed.observation.sequence, inputRevision: observed.observation.inputRevision }), ...extra }); };
  f.run = async (text, steps, input = {}) => {
    f.steps.push(...steps); const value = await f.app.send({ text, origin: 'text', ...input });
    if (f.scriptError) throw f.scriptError;
    // A verified finish can now supply the final acknowledgement locally,
    // without spending a model round on the scripted closing sentence.
    if (value.ok && value.actions?.some(action => action.kind === 'finish_terminal' && action.status === 'interaction-complete')
      && f.steps.length === 1 && typeof f.steps[0]?.choices?.[0]?.message?.content === 'string') f.steps.shift();
    assert.equal(f.steps.length, 0, JSON.stringify(value)); return value;
  };
  t.after(async () => { await f.app.dispose(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('vibe-exit-recovery-')); fs.rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('clearing cannot use quit shortcuts and accepted editing controls have private diagnostic evidence', async t => {
  const f = await fixture(t);
  const result = await f.run('Clear the unsent text without exiting Codex.', [read(), body => f.act(body, 'terminal_interact', { keys: ['Ctrl-C'], editInput: true }),
    body => { assert.match(latest(body).error, /lifecycle|interrupt|exit|preserv/i); return read(); },
    body => f.act(body, 'terminal_interact', { keys: ['Ctrl-D'], editInput: true }),
    body => { assert.match(latest(body).error, /lifecycle|interrupt|exit|preserv/i); return read(); },
    body => f.act(body, 'terminal_interact', { keys: ['Ctrl-E', 'Ctrl-U'], editInput: true }), read(),
    body => f.act(body, 'finish_terminal', { outcome: 'completed', text: 'The draft was cleared and Codex remains open.' }), response('The draft was cleared and Codex remains open.')]);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1);
  assert.deepEqual(f.effects[0].keys, ['ctrl-e', 'ctrl-u']);
  await f.app.flushDiagnostics();
  const records = fs.readFileSync(path.join(rootOf(f), 'logs/orchestrator-errors.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const control = records.find(record => record.event === 'terminal_control'); assert.deepEqual(control.nativeKeys, ['ctrl-e', 'ctrl-u']); assert.equal(control.lifecycleMode, 'preserve');
});

function rootOf(f) { return f.session.cwd; }

test('a shell prompt after the agent exits cannot establish successful input clearing', async t => {
  const f = await fixture(t);
  f.dispatch = () => { f.session.agentProcessState = 'exited'; f.session.agentPid = undefined; f.screen = 'PS C:\\project>'; return { ok: true, status: 'written' }; };
  const result = await f.run('Clear the unsent draft.', [read(), body => f.act(body, 'terminal_interact', { keys: ['ctrl-u'], editInput: true }), read(),
    body => f.act(body, 'finish_terminal', { outcome: 'completed', text: 'Cleared.' }),
    body => { assert.match(latest(body).error, /coding agent exited/); return read(); },
    body => f.act(body, 'finish_terminal', { outcome: 'blocked', text: 'Codex exited; clearing was not verified.' }), response('Codex exited; clearing was not verified.')]);
  assert.equal(result.ok, false); assert.equal(f.session.processState, 'running');
  assert.ok(!result.actions.some(item => item.status === 'interaction-complete'));
  const retry = f.app.retry({ requestId: result.requestId });
  assert.equal(retry.ok, true, 'The blocked objective remains available for explicit recovery');
  await f.app.cancel({ requestId: retry.requestId });
});

test('interruption cannot arm idle quit or send repeated Ctrl-C for the same running turn', async t => {
  const f = await fixture(t); f.plan = context => ({ goal: context.instruction, actions: [{ kind: 'operate_terminal', targetIds: ['a'], text: context.instruction, lifecycleMode: 'interrupt' }] });
  const result = await f.run('Interrupt the running task, keeping Codex open.', [read(), body => f.act(body, 'interrupt'),
    body => { assert.match(latest(body).error, /No active agent turn/); Object.assign(f.session, { turnState: 'running', turnId: 'turn-1', turnStartedAt: Date.now() }); return read(); },
    body => f.act(body, 'interrupt'), read(), body => f.act(body, 'interrupt'),
    body => { assert.match(latest(body).error, /already sent/); return read(); },
    body => f.act(body, 'finish_terminal', { outcome: 'blocked', text: 'Interrupt sent; waiting for the agent to stop.' }), response('Interrupt sent; waiting for the agent to stop.')]);
  assert.equal(result.ok, false); assert.equal(f.effects.length, 1); assert.equal(f.effects[0].kind, 'interrupt');
});

test('a blocked send retains its original goal and an authorized clear follow-up can finish delivery', async t => {
  const f = await fixture(t); let occupied = true;
  f.dispatch = action => action.kind === 'send_prompt' && occupied ? { ok: false, status: 'input-buffer-occupied', delivery: 'not-dispatched', error: 'Unsent draft blocks delivery.' }
    : (action.kind === 'terminal_interact' ? (occupied = false, { ok: true, status: 'written' }) : { ok: true, status: 'written' });
  const original = 'Review the changes and run the tests.';
  const first = await f.run(original, [read(), body => f.act(body, 'send_prompt', { text: original }), read(),
    body => f.act(body, 'finish_terminal', { outcome: 'blocked', text: 'Unsent draft blocks delivery.' }), response('The unsent draft blocks delivery.')]);
  assert.equal(first.ok, false);
  f.plan = context => {
    assert.equal(context.previousCommand.instruction, original);
    assert.equal(context.previousCommand.grants[0].lifecycleMode, 'preserve');
    return { goal: original, continuationOf: context.previousCommand.requestId, actions: [{ kind: 'operate_terminal', sourceUserId: context.previousCommand.requestId, targetIds: ['a'] }] };
  };
  const result = await f.run('Clear the draft and continue that request.', [read(), body => f.act(body, 'terminal_interact', { keys: ['ctrl-e', 'ctrl-u'], editInput: true }), read(),
    body => f.act(body, 'send_prompt', { text: original }), read(), body => f.act(body, 'finish_terminal', { outcome: 'completed', text: 'The original review prompt is now submitted.' }), response('The original review prompt is now submitted.')], { replyToRequestId: first.requestId });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.effects.map(item => item.kind), ['send_prompt', 'terminal_interact', 'send_prompt']);
  assert.equal(f.effects.at(-1).requestId, first.requestId, 'Continuation retains original source accounting');
});

test('a different native agent in the same PTY cannot verify the earlier edit', async t => {
  const f = await fixture(t);
  f.dispatch = () => { f.session.agentPid = 43; return { ok: true, status: 'written' }; };
  const result = await f.run('Clear the unsent draft.', [read(), body => f.act(body, 'terminal_interact', { keys: ['ctrl-u'], editInput: true }), read(),
    body => f.act(body, 'finish_terminal', { outcome: 'completed', text: 'Cleared.' }),
    body => { assert.match(latest(body).error, /agent changed|liveness is unverified/); return read(); },
    body => f.act(body, 'finish_terminal', { outcome: 'blocked', text: 'The original agent changed before verification.' }), response('The original agent changed before verification.')]);
  assert.equal(result.ok, false); assert.equal(f.effects.length, 1);
});

test('explicit exit authority can report the requested agent exit', async t => {
  const f = await fixture(t);
  f.plan = context => ({ goal: context.instruction, actions: [{ kind: 'operate_terminal', targetIds: ['a'], text: context.instruction, lifecycleMode: 'exit' }] });
  f.dispatch = () => { f.session.agentProcessState = 'exited'; f.session.agentPid = undefined; return { ok: true, status: 'written' }; };
  const result = await f.run('Exit Codex in this terminal.', [read(), body => f.act(body, 'terminal_interact', { keys: ['ctrl-d'] }), read(),
    body => f.act(body, 'finish_terminal', { outcome: 'completed', text: 'Codex has exited as requested.' }), response('Codex has exited as requested.')]);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.effects.length, 1);
});

test('a proven unsent interrupt permits a fresh retry without resetting unknown-write protection', async t => {
  const f = await fixture(t); let attempts = 0;
  Object.assign(f.session, { turnState: 'running', turnId: 'running-turn' });
  f.plan = context => ({ goal: context.instruction, actions: [{ kind: 'operate_terminal', targetIds: ['a'], text: context.instruction, lifecycleMode: 'interrupt' }] });
  f.dispatch = () => ++attempts === 1 ? { ok: false, status: 'stale-observation', delivery: 'not-dispatched', error: 'Nothing written.' } : { ok: true, status: 'written' };
  const result = await f.run('Interrupt the current task.', [read(), body => f.act(body, 'interrupt'), read(), body => f.act(body, 'interrupt'), read(),
    body => f.act(body, 'finish_terminal', { outcome: 'completed', text: 'The requested interrupt was delivered.' }), response('The requested interrupt was delivered.')]);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(attempts, 2);
});

test('key-name casing changes cannot replay an already accepted native control step', async t => {
  const f = await fixture(t); let original;
  const result = await f.run('Clear the draft without exiting.', [read(), body => {
    const call = f.act(body, 'terminal_interact', { keys: ['Ctrl-E', 'Ctrl-U'], editInput: true }); original = JSON.parse(call.choices[0].message.tool_calls[0].function.arguments); return call;
  }, body => { assert.equal(latest(body).ok, true); return tool({ ...original, keys: ['ctrl-e', 'ctrl-u'] }); },
  body => { assert.equal(latest(body).ok, true); return read(); }, body => f.act(body, 'finish_terminal', { outcome: 'completed', text: 'Cleared with the agent still open.' }), response('Cleared with the agent still open.')]);
  assert.equal(result.ok, true); assert.equal(f.effects.length, 1);
});
