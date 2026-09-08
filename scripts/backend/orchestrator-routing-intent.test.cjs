'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { INTENT_SYSTEM, INTENT_TOOL, normalizeIntent, projectIntent, authorizeIntentAction, claimGrant,
  bindDelegatedTask, claimDelegatedTaskCreation } = require('../../backend/orchestratorIntent.cjs');
const { scopedWorkspaceTool } = require('../../backend/orchestratorToolSchema.cjs');

const cwd = 'C:\\work\\app';
const objective = 'Review authentication without editing files.';
const sessions = [
  { id: 'a', generation: 'ga', launchToken: 1, kind: 'codex', cwd, conversationId: 'thread-a', processState: 'running' },
  { id: 'b', generation: 'gb', launchToken: 1, kind: 'codex', cwd, conversationId: 'thread-b', processState: 'running' },
];
const context = extra => ({ requestId: 'user-1', instruction: `${objective} Then fix the findings. Approve once.`,
  sessions: structuredClone(sessions), projects: [{ path: cwd }], workItems: [{ id: 'w1', cwd, requestIds: ['old-user'] }], ...extra });
function compile(command = {}, extra = {}, plan = {}) {
  return normalizeIntent({ goal: objective, actions: [{ kind: 'delegate_task', cwd, text: objective, ...command }], ...plan }, context(extra));
}
function bind(plan, session = sessions[0], options = {}) {
  return bindDelegatedTask(plan, plan.grants.find(grant => grant.kind === 'delegate_task').id, session,
    { sessions, expectedTarget: { id: session.id, generation: session.generation }, ...options });
}
function send(plan, fields = {}, live = sessions) {
  return authorizeIntentAction({ kind: 'send_prompt', grantId: plan.grants.find(grant => grant.kind === 'operate_terminal').id,
    targetId: 'a', stepId: 'send', ...fields }, plan, live);
}
function receipt(action, session = sessions[0]) {
  return { ok: true, status: 'created', processState: 'running', actionId: action.actionId, id: session.id,
    launchToken: session.launchToken, target: { id: session.id, generation: session.generation, launchToken: session.launchToken } };
}

test('delegated task preserves the complete objective and operator modes without choosing a terminal', () => {
  const plan = compile({}, {}, { executionMode: 'direct', access: 'read-only', afterResults: { instruction: 'fix the findings' } });
  const grant = projectIntent(plan).grants[0];
  assert.equal(plan.executionMode, 'reason');
  assert.equal(plan.access, 'read-only');
  assert.equal(grant.text, objective);
  assert.deepEqual(grant.targets, []);
  assert.deepEqual(grant.args, { cwd, assignmentMode: 'auto' });
  assert.equal(grant.promptMode, 'compose');
  assert.equal(grant.answerMode, 'delegated');
  assert.equal(grant.permissionMode, 'none');
  assert.equal(grant.lifecycleMode, 'preserve');
  assert.equal(grant.dispatched, false);
  assert.ok(Object.isFrozen(plan.grants[0].args));
  assert.match(INTENT_SYSTEM, /Do not ask which terminal merely because no terminal was named/);
  const schema = INTENT_TOOL.function.parameters.properties.actions.items.anyOf.find(item => item.properties.kind.enum[0] === 'delegate_task');
  assert.equal(schema.properties.targetIds, undefined);
  assert.deepEqual(schema.properties.assignmentMode.enum, ['auto', 'new']);
});

test('delegated scope rejects missing, relative, unknown and traversed projects and unsupported launchers', () => {
  for (const invalid of [{ cwd: undefined }, { cwd: '.' }, { cwd: 'C:\\unrelated' }, { cwd: cwd + '\\..\\other' },
    { kindOfSession: 'made-up' }, { assignmentMode: 'anywhere' }, { targetIds: ['a'] }, { selection: 'all' },
    { workItemId: 'missing' }, { text: undefined }]) assert.throws(() => compile(invalid));
  assert.throws(() => compile({ workItemId: 'w1' }, { workItems: [{ id: 'w1', cwd: 'C:\\other' }] }), /another project/);
  assert.doesNotThrow(() => compile({ cwd: 'c:/WORK/app/' }));
  assert.doesNotThrow(() => compile({}, { projects: [], roots: { projects: [cwd] }, sessions: [] }));
});

test('unbound task exposes only reads and conversation and cannot authorize or claim model effects', () => {
  const plan = compile();
  const kinds = ['list_sessions', 'read_session', 'respond', 'ask_user', 'create_session', 'send_prompt', 'delegate_task'];
  const tool = { type: 'function', function: { name: 'workspace', description: '', parameters: { anyOf: kinds.map(kind => ({
    required: ['kind'], properties: { kind: { enum: [kind] } }, additionalProperties: false,
  })) } } };
  const available = scopedWorkspaceTool(tool, plan.grants).function.parameters.properties.kind.enum;
  assert.deepEqual(available, kinds.slice(0, 4));
  for (const kind of ['delegate_task', 'send_prompt', 'create_session']) {
    assert.throws(() => authorizeIntentAction({ kind, grantId: plan.grants[0].id, targetId: 'a' }, plan, sessions));
    assert.throws(() => claimGrant({ kind, grantId: plan.grants[0].id }, plan));
  }
});

test('binding retains literal text, user source, answers, constraints and deferred clause', () => {
  const original = compile({ promptMode: 'literal', answerMode: 'supplied', permissionMode: 'supplied', answerText: 'Approve once.', workItemId: 'w1' },
    {}, { afterResults: { instruction: 'fix the findings' }, access: 'read-only' });
  const before = original.grants[0];
  const plan = bind(original, sessions[0], { workItemId: 'w1' });
  const grant = plan.grants[0];
  for (const key of ['id', 'sourceUserId', 'text', 'promptMode', 'answerMode', 'permissionMode', 'answerText', 'lifecycleMode']) assert.deepEqual(grant[key], before[key]);
  assert.deepEqual(plan.afterResults, { instruction: 'fix the findings' });
  assert.equal(plan.access, 'read-only');
  assert.deepEqual(grant.args, {});
  assert.equal(grant.routing.workItemId, 'w1');
  assert.deepEqual(grant.targets, [{ id: 'a', generation: 'ga' }]);
  assert.equal(send(plan).text, objective);
  assert.throws(() => send(plan, { text: 'Edit everything.' }), /Literal/);
  assert.equal(projectIntent(plan).grants[0].routing.binding.conversationId, 'thread-a');
});

test('binding requires genuine plan, current directory, exact expected identity and bounded scope', () => {
  const plan = compile({ kindOfSession: 'codex', workItemId: 'w1' });
  assert.throws(() => bind(structuredClone(plan)), /Unknown application command plan/);
  assert.throws(() => bindDelegatedTask(plan, 'invented', sessions[0], {}), /unbound delegated/);
  for (const options of [
    { sessions: [] }, { sessions: [sessions[0], sessions[0]] }, { expectedTarget: { id: 'a', generation: 'old' } },
    { expectedTarget: { id: 'a', generation: 'ga', conversationId: 'different' } },
    { expectedTarget: { id: 'a', generation: 'ga', launchToken: 2 } }, { workItemId: 'other' },
    { sessions: [{ ...sessions[0], cwd: 'C:\\other' }] }, { sessions: [{ ...sessions[0], kind: 'claude' }] },
    { sessions: [{ ...sessions[0], generation: 'new' }] }, { sessions: [{ ...sessions[0], conversationId: 'new-thread' }] },
  ]) {
    assert.throws(() => bind(plan, sessions[0], options));
    assert.equal(projectIntent(plan).grants[0].dispatched, false, 'failed binding leaves the original plan usable');
  }
  assert.doesNotThrow(() => bind(plan));
});

test('successful binding retires the old plan and denies any second assignment before or after uncertain dispatch', () => {
  const original = compile();
  const id = original.grants[0].id;
  const plan = bind(original);
  assert.throws(() => bindDelegatedTask(original, id, sessions[1], { sessions, expectedTarget: sessions[1] }), /Unknown application command plan/);
  assert.throws(() => bindDelegatedTask(plan, id, sessions[1], { sessions, expectedTarget: sessions[1] }), /unbound delegated/);
  const action = send(plan);
  claimGrant(action, plan); // An uncertain transport result does not release this claim.
  assert.throws(() => claimGrant(action, plan), /already dispatched/);
  assert.throws(() => claimDelegatedTaskCreation(plan, id, { kindOfSession: 'codex' }), /unbound delegated/);
});

test('bound operation rejects conversation, workspace, launcher and generation changes on every action', () => {
  const plan = bind(compile());
  for (const changed of [{ conversationId: 'different' }, { cwd: 'C:\\other' }, { kind: 'claude' },
    { generation: 'new' }, { launchToken: 2 }]) assert.throws(() => send(plan, {}, [{ ...sessions[0], ...changed }]));
  assert.doesNotThrow(() => send(plan));
});

test('app-owned work item association requires exact project and originating user source', () => {
  const plan = compile();
  for (const workItem of [undefined, { id: 'new', cwd, requestIds: [] },
    { id: 'other', cwd, requestIds: ['user-1'] }, { id: 'new', cwd: 'C:\\elsewhere', requestIds: ['user-1'] }]) {
    assert.throws(() => bind(plan, sessions[0], { workItemId: 'new', workItem }), /source evidence/);
  }
  const bound = bind(plan, sessions[0], { workItemId: 'new', workItem: { id: 'new', cwd, requestIds: ['user-1'] } });
  assert.equal(projectIntent(bound).grants[0].routing.workItemId, 'new');
});

test('new assignment claims one creation with no task or draft and requires its verified native launch receipt', () => {
  const original = compile({ assignmentMode: 'new', kindOfSession: 'codex' }, {}, { afterResults: { instruction: 'fix the findings' } });
  assert.throws(() => bind(original), /claimed creation receipt/);
  const id = original.grants[0].id;
  const action = claimDelegatedTaskCreation(original, id);
  assert.deepEqual(Object.keys(action).sort(), ['actionId', 'cwd', 'grantId', 'kind', 'kindOfSession']);
  assert.equal(action.kind, 'create_session');
  assert.ok(Object.isFrozen(action));
  assert.equal(projectIntent(original).grants[0].dispatched, true, 'creation cannot be replayed through pending authority');
  assert.throws(() => claimDelegatedTaskCreation(original, id), /already claimed/);
  for (const change of [{ actionId: 'forged' }, { ok: false }, { status: 'unknown' }, { processState: 'starting' },
    { launchToken: 2 }, { target: { id: 'b', generation: 'gb' } }]) {
    assert.throws(() => bind(original, sessions[0], { creationReceipt: { ...receipt(action), ...change } }), /confirmed launch receipt/);
  }
  const plan = bind(original, sessions[0], { creationReceipt: receipt(action) });
  assert.equal(plan.grants[0].routing.creationActionId, action.actionId);
  assert.equal(projectIntent(plan).grants[0].dispatched, false);
  assert.equal(plan.afterResults.instruction, 'fix the findings');
  claimGrant(send(plan), plan);
  assert.equal(projectIntent(plan).grants[0].progress[0].steps, 1);
});

test('uncertain creation cannot switch to an existing terminal or create another pane', () => {
  const plan = compile();
  const id = plan.grants[0].id;
  assert.throws(() => claimDelegatedTaskCreation(plan, id, { kindOfSession: 'codex', text: objective }), /unexpected/);
  assert.throws(() => claimDelegatedTaskCreation(plan, id, { kindOfSession: 'invented' }), /supported launcher/);
  claimDelegatedTaskCreation(plan, id, { kindOfSession: 'codex' });
  assert.throws(() => bind(plan), /confirmed launch receipt/);
  assert.throws(() => claimDelegatedTaskCreation(plan, id, { kindOfSession: 'claude' }), /already claimed/);
});

test('binding one delegated task retains consumed state of unrelated grants', () => {
  const original = normalizeIntent({ goal: objective, actions: [
    { kind: 'focus_session', targetIds: ['b'] }, { kind: 'delegate_task', cwd, text: objective },
  ] }, context());
  const focus = authorizeIntentAction({ kind: 'focus_session', targetId: 'b' }, original, sessions);
  claimGrant(focus, original);
  const plan = bind(original);
  assert.equal(projectIntent(plan).grants.find(grant => grant.kind === 'focus_session').dispatched, true);
  assert.throws(() => claimGrant(focus, plan), /already dispatched/);
  assert.doesNotThrow(() => send(plan));
});

test('routed operator clarification retains app-owned work and native identity constraints', () => {
  const plan = bind(compile({ workItemId: 'w1' }));
  const previousCommand = { requestId: 'user-1', instruction: objective, grants: structuredClone(plan.grants) };
  const raw = { goal: 'Continue the same review.', actions: [{ kind: 'operate_terminal', sourceUserId: 'user-1' }] };
  const next = normalizeIntent(raw, context({ requestId: 'answer', instruction: 'Continue.', previousCommand }));
  assert.deepEqual(next.grants[0].routing, plan.grants[0].routing);
  assert.throws(() => normalizeIntent(raw, context({ requestId: 'answer', instruction: 'Continue.', previousCommand,
    sessions: [{ ...sessions[0], conversationId: 'replaced' }] })), /conversation or launch identity/);
  assert.throws(() => compile({ routing: plan.grants[0].routing }), /unexpected/);
});

test('named one/random/all still mint frozen target slots with no delegated authority', () => {
  for (const selection of ['one', 'all']) {
    const plan = normalizeIntent({ goal: objective, actions: [{ kind: 'operate_terminal', targetIds: ['a', 'b'], selection, text: objective }] }, context());
    assert.equal(plan.grants[0].targets.length, selection === 'one' ? 1 : 2);
    assert.equal(plan.grants[0].routing, undefined);
    assert.throws(() => claimDelegatedTaskCreation(plan, plan.grants[0].id, { kindOfSession: 'codex' }), /unbound delegated/);
  }
});

function continueTask(plan, fields = {}, extra = {}, previousPatch = {}) {
  return normalizeIntent({ goal: objective, actions: [{ kind: 'delegate_task', sourceUserId: 'user-1', ...fields }] },
    context({ requestId: 'clarification', instruction: 'Use Codex, continue the authentication work item, and open a fresh terminal.',
      previousCommand: { requestId: 'user-1', instruction: context().instruction, grants: projectIntent(plan).grants, ...previousPatch }, ...extra }));
}

test('launcher clarification narrows an omitted selector while retaining the original source and operator constraints', () => {
  const initial = compile({ promptMode: 'literal', answerMode: 'supplied', permissionMode: 'supplied', answerText: 'Approve once.' });
  const continued = continueTask(initial, { kindOfSession: 'codex' });
  const before = initial.grants[0], after = continued.grants[0];
  assert.equal(continued.sourceUser.id, 'clarification');
  assert.equal(after.sourceUserId, before.sourceUserId);
  assert.equal(after.args.kindOfSession, 'codex');
  assert.equal(after.args.cwd, before.args.cwd);
  for (const key of ['text', 'promptMode', 'answerMode', 'permissionMode', 'answerText', 'lifecycleMode']) assert.deepEqual(after[key], before[key]);
  const action = claimDelegatedTaskCreation(continued, after.id);
  assert.equal(action.kindOfSession, 'codex');
  assert.equal(action.text, undefined);
});

test('clarification can choose a known project work item and narrow auto assignment to a fresh worker', () => {
  const continued = continueTask(compile(), { workItemId: 'w1', assignmentMode: 'new' });
  assert.deepEqual(continued.grants[0].args, { cwd, assignmentMode: 'new', workItemId: 'w1' });
  assert.equal(continued.grants[0].sourceUserId, 'user-1');
  assert.throws(() => bind(continued), /claimed creation receipt/);
  assert.throws(() => continueTask(compile(), { workItemId: 'missing' }), /unavailable/);
  assert.throws(() => continueTask(compile(), { workItemId: 'w1' }, { workItems: [{ id: 'w1', cwd: 'C:\\other' }] }), /another project/);
  assert.throws(() => continueTask(compile(), { kindOfSession: 'invented' }), /unfinished operation/);
});

test('routing clarification cannot change bound selectors, task text, project, or operator decision authority', () => {
  for (const [before, change] of [
    [{ kindOfSession: 'codex' }, { kindOfSession: 'claude' }],
    [{ workItemId: 'w1' }, { workItemId: 'w2' }],
    [{ assignmentMode: 'new' }, { assignmentMode: 'auto' }],
    [{}, { cwd: 'C:\\other', kindOfSession: 'codex' }],
    [{}, { text: 'Edit all files.', kindOfSession: 'codex' }],
    [{}, { permissionMode: 'delegated', kindOfSession: 'codex' }],
    [{}, { lifecycleMode: 'exit', kindOfSession: 'codex' }],
    [{}, { answerMode: 'supplied', answerText: 'Approve once.', kindOfSession: 'codex' }],
  ]) assert.throws(() => continueTask(compile(before), change), /unfinished operation/);
});

test('consumed or uncertain creation cannot be resurrected through a selector clarification', () => {
  const initial = compile();
  const creation = claimDelegatedTaskCreation(initial, initial.grants[0].id, { kindOfSession: 'codex' });
  assert.equal(projectIntent(initial).grants[0].dispatched, true);
  for (const refinement of [{}, { kindOfSession: 'codex' }, { assignmentMode: 'new' }, { workItemId: 'w1' }]) {
    assert.throws(() => continueTask(initial, refinement), /unfinished operation/);
  }
  assert.throws(() => continueTask(compile(), { kindOfSession: 'codex' }, {}, { consumed: true }), /consumed user instruction/);
  assert.throws(() => claimDelegatedTaskCreation(initial, creation.grantId, { kindOfSession: 'codex' }), /already claimed/);
});

test('selector refinement does not widen a bound operator or legacy creation continuation', () => {
  const bound = bind(compile());
  assert.throws(() => continueTask(bound, { kindOfSession: 'codex' }), /unfinished operation/);
  assert.throws(() => normalizeIntent({ goal: objective, actions: [{ kind: 'create_session', sourceUserId: 'user-1', kindOfSession: 'codex' }] },
    context({ requestId: 'clarification', instruction: 'Use Codex.', previousCommand: {
      requestId: 'user-1', instruction: objective, grants: [{ kind: 'create_session', args: { cwd }, targets: [] }],
    } })), /unfinished operation/);
});
