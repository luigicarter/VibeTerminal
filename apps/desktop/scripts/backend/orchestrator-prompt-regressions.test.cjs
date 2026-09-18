'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { compileCommand, createCommandInterpreter } = require('../../backend/orchestratorCommandCompiler.cjs');
const { readReference, resolveReference } = require('../../backend/orchestratorReference.cjs');
const { resolveAssignment, resolveAnswer } = require('../../backend/orchestratorResolver.cjs');
const { plannerTools, decodePlannerCalls } = require('../../backend/orchestratorPlannerTools.cjs');
const { normalizeIntent, authorizeIntentAction } = require('../../backend/orchestratorIntent.cjs');
const { createIntentInterpreter } = require('../../backend/orchestratorInterpreter.cjs');
const { routingBindingMatches } = require('../../backend/orchestratorLaunchers.cjs');
const { sessionIdentity, initialConversationBinding } = require('../../backend/orchestratorRouting.cjs');
const projects = [{ name: 'Alpha', path: 'C:/Alpha' }, { name: 'Beta', path: 'C:/Beta' }];
const launchers = [['codex', 'Codex'], ['codex-web', 'Codex Web'], ['open-codex', 'Open Codex']]
  .map(([kind, label]) => ({ kind, label, available: true, configured: true }));
const terminals = [{ id: 'a', handle: 'T1', cwd: 'C:/Alpha', provider: 'codex', state: 'working', free: false },
  { id: 'b', handle: 'T2', cwd: 'C:/Beta', provider: 'codex', state: 'working', free: false }];
const context = instruction => ({ instruction, requestId: 'review', projects, launchers, terminals,
  sessions: terminals.map(pane => ({ ...pane, kind: pane.provider, generation: 'g1', launchToken: 1, visiblePane: true, started: true,
    status: 'running', turnState: 'running', processState: 'running', agentProcessState: 'running', agentPid: 1, observation: 'observed' })), projectContext: projects[0] });
const call = (name, args) => ({ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('the production compiler seam decodes handles without falling back to the Brain', () => {
  for (const instruction of ['Stop T1', 'Tell T1 to review the regression tests', 'Close T1']) {
    const events = [];
    const result = createCommandInterpreter({ recordDiagnostic: event => events.push(event) })(context(instruction));
    assert.ok(result, instruction); assert.equal(events.at(-1).status, 'accepted');
    assert.deepEqual(result.actions[0].targetIds || result.actions[0].scope.targetIds, ['a']);
  }
});

test('multi-handle stops retain every target and compound commands are not truncated', () => {
  const compiled = createCommandInterpreter()(context('Stop T1 and T2'));
  assert.deepEqual(compiled.actions[0].targetIds, ['a', 'b']);
  for (const instruction of ['Close T1 and open a new Codex terminal', 'Stop T1 when it finishes', 'Stop T1 and T99']) {
    assert.equal(compileCommand(context(instruction)).accepted, false, instruction);
  }
});

test('explicit project scope bounds a state fan-out', () => {
  const selected = resolveReference('Stop all the terminals that are working in Alpha', terminals, { cwd: 'C:/Alpha', projectName: 'Alpha' });
  assert.deepEqual(selected.terminals.map(pane => pane.id), ['a']);
  const global = resolveReference('Stop all the terminals that are working', terminals, { cwd: 'C:/Alpha', projectName: 'Alpha' });
  assert.deepEqual(global.terminals.map(pane => pane.id), ['a', 'b']);
});

test('an explicitly named busy provider pane is reused instead of creating beside it', () => {
  const instruction = 'Prompt the Codex terminal in Alpha to review the regression tests';
  const raw = createCommandInterpreter()(context(instruction));
  assert.equal(raw.actions[0].kind, 'delegate_task');
  const routed = resolveAssignment({ instruction, grant: { args: raw.actions[0] }, terminals, launchers, cwd: 'C:/Alpha' });
  assert.equal(routed.decision, 'reuse'); assert.equal(routed.targetId, 'a');
  assert.equal(resolveAssignment({ instruction: 'Tell T99 to investigate', terminals, launchers, cwd: 'C:/Alpha' }).decision, 'ask');
});

test('worker payload and negative answers never authorize a new terminal', () => {
  const instruction = 'Prompt the Codex terminal in Alpha to investigate why users cannot open a new terminal';
  assert.equal(readReference(instruction, { launchers }).kind, 'provider');
  assert.equal(resolveAssignment({ instruction, terminals, launchers, cwd: 'C:/Alpha' }).decision, 'reuse');
  for (const text of ['No, do not open a new one', "Yes, but don't open another terminal"]) {
    assert.equal(resolveAnswer({ kind: 'open-new', text }), undefined);
  }
  assert.equal(resolveAssignment({ instruction: 'Investigate this. Do not open any additional terminals.', terminals: [], launchers, cwd: 'C:/Alpha' }).decision, 'ask');
});

test('the named launcher and the explicitly supplied greeting survive model composition', () => {
  const ctx = context('Open a new Codex terminal in Alpha and prompt it with Hi.');
  const tools = plannerTools(ctx);
  // A launcher from another family is the plan being wrong about the request,
  // and is refused rather than substituted.
  assert.throws(() => decodePlannerCalls([call('plan_delegate_task', { cwd: 'C:/Alpha', kindOfSession: 'claude', text: 'Open a worker and say hi.' })], tools, ctx.instruction, ctx), /planned launcher differs/);
  // Open Codex is the same product family as the Codex the user said, so the
  // plan stands and the spoken launcher replaces the planned one, on the
  // record. September 16: this plan opened an Open Codex pane.
  const sameFamily = decodePlannerCalls([call('plan_delegate_task', { cwd: 'C:/Alpha', kindOfSession: 'open-codex', text: 'Open a worker and say hi.' })], tools, ctx.instruction, ctx);
  const corrected = normalizeIntent({ goal: 'Open one terminal', actions: sameFamily.actions }, ctx);
  assert.equal(corrected.grants[0].args.kindOfSession, 'codex');
  assert.deepEqual(corrected.grants[0].launcherOverride, { from: 'open-codex', to: 'codex' });
  // Two launchers in one sentence: there is no single spoken launcher to
  // correct towards, so the plan is left exactly as the Brain wrote it.
  const two = context('Open a Codex terminal and a Codex Web terminal in Alpha.');
  const planned = normalizeIntent({ goal: 'Open two terminals',
    actions: [{ kind: 'create_session', cwd: 'C:/Alpha', kindOfSession: 'open-codex' }] }, two);
  assert.equal(planned.grants[0].args.kindOfSession, 'open-codex');
  assert.equal(planned.grants[0].launcherOverride, undefined);
  const decoded = decodePlannerCalls([call('plan_delegate_task', { cwd: 'C:/Alpha', kindOfSession: 'codex', text: 'Open a worker and say hi.' })], tools, ctx.instruction, ctx);
  assert.equal(decoded.actions[0].text, 'Hi'); assert.equal(decoded.actions[0].promptMode, 'literal');
  assert.equal(readReference('Use the Codex Web terminal', { launchers }).provider, 'codex-web');
});

test('blank opening accepts serialized empty text but rejects an unauthorized draft', () => {
  const plan = normalizeIntent({ goal: 'Open one terminal', actions: [{ kind: 'create_session', cwd: 'C:/Alpha', kindOfSession: 'codex' }] }, context('Open a Codex terminal in Alpha'));
  const action = { kind: 'create_session', grantId: plan.grants[0].id };
  assert.deepEqual(authorizeIntentAction({ ...action, text: '' }, plan), authorizeIntentAction(action, plan));
  assert.throws(() => authorizeIntentAction({ ...action, text: 'Delete files' }, plan), /workspace action/);
});

test('first startup identity can enrich a binding; clear, resume, restart and later selections cannot', () => {
  const pane = { id: 'a', generation: 'g1', launchToken: 1, kind: 'codex', provider: 'codex', cwd: 'C:/Alpha' };
  const binding = { target: { id: 'a', generation: 'g1', launchToken: 1 }, nativeIdentity: sessionIdentity(pane) };
  const observed = { ...pane, conversationId: 'native-a', selection: { status: 'confirmed', revision: 1, source: 'startup' } };
  assert.equal(initialConversationBinding(binding, observed), true);
  assert.equal(routingBindingMatches(binding, observed), true);
  for (const changed of [
    { ...observed, generation: 'g2' }, { ...observed, launchToken: 2 }, { ...observed, cwd: 'C:/Beta' },
    ...['clear', 'resume'].map(source => ({ ...observed, selection: { ...observed.selection, source } })),
    { ...observed, selection: { ...observed.selection, revision: 2 } },
    { ...observed, selection: { ...observed.selection, status: 'pending' } },
  ]) assert.equal(routingBindingMatches(binding, changed), false, JSON.stringify(changed));
  assert.equal(routingBindingMatches({ ...binding, nativeIdentity: { ...binding.nativeIdentity, id: 'other' } }, observed), false);
});

test('a close-only interpretation cannot mark a close/open/prompt request complete', async () => {
  const ctx = context('Can you close the terminals in Alpha and open a new Codex one and just prompt it and say hi?');
  const interpret = createIntentInterpreter({ interpretIntent: () => ({ goal: ctx.instruction, actions: [{ kind: 'close', scope: { type: 'explicit', targetIds: ['a'] } }] }), getTask: () => undefined });
  await assert.rejects(interpret(ctx), /also asks to open a terminal/);
});
