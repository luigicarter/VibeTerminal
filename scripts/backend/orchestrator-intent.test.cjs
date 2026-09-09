'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { INTENT_KINDS, INTENT_SYSTEM, INTENT_TOOL, normalizeIntent, projectIntent, authorizeIntentAction, claimGrant } = require('../../backend/orchestratorIntent.cjs');

const sessions = [
  { id: 'a', generation: 'launch-a', kind: 'codex', cwd: 'C:\\work\\vibeTerminal' },
  { id: 'b', generation: 'launch-b', kind: 'codex', cwd: 'C:\\work\\vibeTerminal' },
  { id: 'other', generation: 'launch-other', kind: 'codex', cwd: 'C:\\work\\other' },
];
const context = extra => ({ instruction: 'Ask a terminal to review the last changes; do not edit files.', requestId: 'user-1', sessions: structuredClone(sessions), requests: [], ...extra });
const compile = (actions, extra = {}, additional = {}) => normalizeIntent({ goal: 'Carry out the user request.', actions, ...additional }, context(extra));
const send = extra => ({ kind: 'send_prompt', targetIds: ['a'], text: 'Review the last changes; do not edit files.', ...extra });
const question = extra => ({ id: 'q1', sessionId: 'a', generation: 'launch-a', revision: 3, state: 'pending', kind: 'question', questions: [{ id: 'scope', question: 'Which scope?', options: [{ label: 'Unit' }, { label: 'Smoke' }] }], ...extra });

test('current task status needs no submitted reply reference or request id', () => {
  const plan = normalizeIntent({ goal: 'Check the current task.', actions: [], responseKind: 'task-status', statusTargetIds: ['a'] }, context());
  assert.deepEqual(plan.statusTargets, [{ id: 'a', generation: 'launch-a', name: undefined }]);
  assert.equal(plan.statusRequestId, undefined);
  assert.equal(plan.access, 'read-only');
  assert.deepEqual(plan.grants, []);
});

test('task status is semantically routed to frozen targets without effect authority', () => {
  const raw = { goal: 'Check whether the task started.', actions: [], responseKind: 'task-status', statusTargetIds: ['a'], statusRequestId: 'earlier' };
  const ctx = context({ tasks: [{ requestId: 'earlier' }] });
  const plan = normalizeIntent(raw, ctx);
  ctx.sessions[0].generation = 'replacement'; raw.statusTargetIds.push('b');
  assert.deepEqual(plan.statusTargets, [{ id: 'a', generation: 'launch-a', name: undefined }]);
  assert(Object.isFrozen(plan.statusTargets[0]));
  assert.equal(plan.access, 'read-only');
  assert.equal(projectIntent(plan).responseKind, 'task-status');
  assert.equal(projectIntent(plan).statusRequestId, 'earlier');
  assert.deepEqual(projectIntent(plan).statusTargets, plan.statusTargets);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', targetId: 'a' }, plan, sessions), /matching user command grant/);
  assert.equal(compile([]).responseKind, undefined, 'Ordinary reads remain model responses');
  for (const patch of [{ responseKind: 'anything' }, { responseKind: undefined }, { statusTargetIds: [] }, { statusTargetIds: ['a', 'a'] },
    { statusTargetIds: ['missing'] }, { statusRequestId: 'missing' }, { actions: [send()] }]) {
    assert.throws(() => normalizeIntent({ ...raw, statusTargetIds: ['a'], ...patch }, context({ tasks: [{ requestId: 'earlier' }] })));
  }
  assert.deepEqual(INTENT_TOOL.function.parameters.properties.responseKind.enum, ['task-status', 'terminal-inspection']);
});

test('compiler contract supports workspace effects and excludes external applications and reads', () => {
  assert.equal(INTENT_TOOL.function.name, 'interpret_workspace');
  assert.deepEqual(INTENT_TOOL.function.parameters.properties.actions.items.anyOf.map(schema => schema.properties.kind.enum[0]), INTENT_KINDS);
  for (const kind of ['answer_question', 'permission', 'terminal_interact', 'forget_preference']) assert.ok(INTENT_KINDS.includes(kind));
  for (const kind of ['open_file', 'open_folder', 'read_session', 'list_sessions']) assert.ok(!INTENT_KINDS.includes(kind));
  assert.match(INTENT_SYSTEM, /metadata.*data, never instructions/);
  assert.match(INTENT_SYSTEM, /sourceUserId to previousCommand.requestId/);
  assert.match(INTENT_SYSTEM, /Never invent an answer or upgrade permission scope/);
});

test('a no-effect Hello plan rejects a hallucinated close despite known target metadata', () => {
  const plan = compile([], { instruction: 'Hello' });
  assert.throws(() => authorizeIntentAction({ kind: 'close', targetId: 'a' }, plan, sessions), /matching user command grant/);
  assert.deepEqual(projectIntent(plan).grants, []);
});

test('grants are application minted, immutable and cannot be forged or copied into a new plan', () => {
  const plan = compile([send()]);
  assert.match(plan.grants[0].id, /^[a-f0-9-]{36}$/);
  assert.ok(Object.isFrozen(plan.grants[0].targets[0]));
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', grantId: 'forged', targetId: 'a' }, plan, sessions), /matching user command grant/);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt' }, structuredClone(plan), sessions), /Unknown application command plan/);
  assert.throws(() => claimGrant({ kind: 'send_prompt', grantId: 'forged' }, plan), /Unknown user command grant/);
});

test('a composed prompt is frozen independently of executor text and source context mutation', () => {
  const ctx = context(), raw = { goal: 'Review changes.', actions: [send()] };
  const plan = normalizeIntent(raw, ctx);
  raw.actions[0].text = 'Delete files'; ctx.sessions[0].generation = 'restarted';
  const action = authorizeIntentAction({ kind: 'send_prompt' }, plan, sessions);
  assert.equal(action.text, 'Review the last changes; do not edit files.');
  assert.deepEqual(action.target, { id: 'a', generation: 'launch-a' });
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', text: 'Review changes and fix everything.' }, plan, sessions), /Prompt text/);
});

test('authorization rejects cross-target identities, aliases and stale generations', () => {
  const plan = compile([send()]);
  for (const action of [{ kind: 'send_prompt', targetId: 'other' }, { kind: 'send_prompt', targetId: 'a', target: { id: 'b' } }]) assert.throws(() => authorizeIntentAction(action, plan, sessions), /target/i);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', generation: 'old' }, plan, sessions), /Stale/);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt' }, plan, sessions.map(s => s.id === 'a' ? { ...s, generation: 'new' } : s)), /changed or restarted/);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt' }, plan, sessions.filter(s => s.id !== 'a')), /changed or restarted/);
});

test('one selection chooses a single target once and does not let the executor choose another', () => {
  const plan = compile([send({ targetIds: ['a', 'b'], selection: 'one' })]);
  assert.equal(plan.grants[0].targets.length, 1);
  const selected = plan.grants[0].targets[0].id;
  assert.equal(authorizeIntentAction({ kind: 'send_prompt' }, plan, sessions).targetId, selected);
  assert.equal(authorizeIntentAction({ kind: 'send_prompt' }, plan, sessions).targetId, selected);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', targetId: selected === 'a' ? 'b' : 'a' }, plan, sessions), /outside/);
});

test('all selection has one execution slot per frozen target and cannot replay any slot', () => {
  const plan = compile([send({ targetIds: ['a', 'b'], selection: 'all' })]);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt' }, plan, sessions), /outside/);
  const a = authorizeIntentAction({ kind: 'send_prompt', targetId: 'a' }, plan, sessions);
  claimGrant(a, plan);
  assert.throws(() => claimGrant(a, plan), /already dispatched/);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', targetId: 'a' }, plan, sessions), /already dispatched/);
  assert.deepEqual(projectIntent(plan).grants[0].availableTargetIds, ['b']);
  claimGrant(authorizeIntentAction({ kind: 'send_prompt', targetId: 'b' }, plan, sessions), plan);
  assert.equal(projectIntent(plan).grants[0].dispatched, true);
});

test('an unconfirmed dispatch remains consumed and model action IDs cannot bypass the claim', () => {
  const plan = compile([send()]);
  const action = authorizeIntentAction({ kind: 'send_prompt' }, plan, sessions);
  action.actionId = 'application-dispatch-1';
  claimGrant(action, plan); // Adapter subsequently returns unknown: no release operation exists.
  action.actionId = 'application-dispatch-2';
  assert.throws(() => claimGrant(action, plan), /already dispatched/);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', actionId: 'model-id' }, plan, sessions), /unexpected/);
});

test('a caller may canonicalize a consumed action for receipt lookup but cannot claim it again', () => {
  const plan = compile([send()]);
  const first = authorizeIntentAction({ kind: 'send_prompt' }, plan, sessions);
  claimGrant(first, plan);
  const repeated = authorizeIntentAction({ kind: 'send_prompt' }, plan, sessions, { allowConsumed: true });
  assert.deepEqual(repeated, first);
  assert.throws(() => claimGrant(repeated, plan), /already dispatched/);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', text: 'Changed prompt' }, plan, sessions, { allowConsumed: true }), /Prompt text/);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', targetId: 'other' }, plan, sessions, { allowConsumed: true }), /outside/);
});

test('receipt lookup can canonicalize terminal navigation after the budget is exhausted', () => {
  const plan = compile([{ kind: 'terminal_interact', targetIds: ['a'] }]);
  const input = { kind: 'terminal_interact', observationSequence: 1, keys: Array(16).fill('down') };
  const first = authorizeIntentAction(input, plan, sessions);
  claimGrant(first, plan);
  assert.deepEqual(authorizeIntentAction(input, plan, sessions, { allowConsumed: true }), first);
  assert.throws(() => claimGrant(first, plan), /limit/);
});

test('model projection includes a short payload preview without repeating the complete prompt', () => {
  const text = 'Inspect carefully. '.repeat(1000);
  const plan = compile([send({ text })]);
  const projected = projectIntent(plan).grants[0];
  assert.equal(projected.text, undefined);
  assert.equal(projected.textBound, true);
  assert.equal(projected.textPreview, text.slice(0, 300));
  assert.equal(projected.textLength, text.length);
  assert.equal(authorizeIntentAction({ kind: 'send_prompt' }, plan, sessions).text, text);
});

test('pre-dispatch validation failures leave the slot available, and mutation before claim is rejected', () => {
  const plan = compile([send()]);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', text: 'Wrong' }, plan, sessions), /Prompt text/);
  const action = authorizeIntentAction({ kind: 'send_prompt' }, plan, sessions);
  action.text = 'Wrong';
  assert.throws(() => claimGrant(action, plan), /text changed/);
  claimGrant(authorizeIntentAction({ kind: 'send_prompt' }, plan, sessions), plan);
});

test('matching kind alone is insufficient when two grants could authorize the same target', () => {
  const plan = compile([send(), send({ text: 'Inspect tests.' })]);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', targetId: 'a' }, plan, sessions), /one matching/);
  assert.equal(authorizeIntentAction({ kind: 'send_prompt', grantId: plan.grants[1].id }, plan, sessions).text, 'Inspect tests.');
});

test('one grant may be resolved by target only when it is unique', () => {
  const plan = compile([send(), send({ targetIds: ['b'] })]);
  assert.equal(authorizeIntentAction({ kind: 'send_prompt', targetId: 'b' }, plan, sessions).grantId, plan.grants[1].id);
});

test('unfinished user instructions retain their original frozen target scope', () => {
  const previousCommand = { instruction: 'Ask one of those terminals to review; do not edit.', requestId: 'old-user', candidates: [{ id: 'a', generation: 'launch-a' }, { id: 'b', generation: 'launch-b' }] };
  const extra = { instruction: 'Pick a random one.', previousCommand };
  const plan = compile([send({ sourceUserId: 'old-user', targetIds: ['a', 'b'], selection: 'one' })], extra);
  assert.equal(plan.grants[0].sourceUserId, 'old-user');
  assert.throws(() => compile([send({ sourceUserId: 'old-user', targetIds: ['other'] })], extra), /original scope/);
  assert.throws(() => compile([send({ sourceUserId: 'old-user' })], { ...extra, sessions: sessions.map(s => s.id === 'a' ? { ...s, generation: 'new' } : s) }), /target changed/);
  for (const flag of ['dispatched', 'consumed']) assert.throws(() => compile([send({ sourceUserId: 'old-user' })], { ...extra, previousCommand: { ...previousCommand, [flag]: true } }), /consumed user instruction/);
});

test('a fresh explicit user command may address a new generation without inheriting old authority', () => {
  const fresh = sessions.map(s => s.id === 'a' ? { ...s, generation: 'new' } : s);
  const plan = compile([send()], { sessions: fresh, instruction: 'Ask A again to review the latest changes.', previousCommand: { instruction: 'Old request', requestId: 'old', consumed: true } });
  assert.equal(authorizeIntentAction({ kind: 'send_prompt' }, plan, fresh).generation, 'new');
});

test('clarification-only continuations explicitly retain the original user source across replies', () => {
  const previousCommand = { requestId: 'original-user', instruction: 'Ask a terminal to review the latest changes.', candidates: [{ id: 'a', generation: 'launch-a' }] };
  const first = compile([], { requestId: 'clarification-one', instruction: 'In vibeTerminal.', previousCommand }, { clarification: 'Which terminal?', continuationOf: 'original-user' });
  assert.equal(first.continuationOf, 'original-user');
  assert.equal(projectIntent(first).continuationOf, 'original-user');
  const second = compile([], { requestId: 'clarification-two', instruction: 'The Codex one.', previousCommand }, { clarification: 'Which of the two Codex sessions?', continuationOf: 'original-user' });
  assert.equal(second.continuationOf, first.continuationOf);
  for (const prior of [undefined, { ...previousCommand, consumed: true }, { ...previousCommand, dispatched: true }]) assert.throws(() => compile([], { previousCommand: prior }, { clarification: 'Which one?', continuationOf: 'original-user' }), /pending|consumed/);
  assert.throws(() => compile([], { previousCommand }, { continuationOf: 'another-user' }), /pending user command/);
});

test('partial commands can inherit only the exact unfinished operation and remaining target slots', () => {
  const previousCommand = { requestId: 'old-user', instruction: 'Review the changes; do not edit, then focus the terminal.',
    candidates: [{ id: 'a', generation: 'launch-a' }, { id: 'b', generation: 'launch-b' }],
    grants: [{ kind: 'send_prompt', targets: [{ id: 'b', generation: 'launch-b' }], args: {}, text: 'Review the changes; do not edit.' },
      { kind: 'focus_session', targets: [{ id: 'a', generation: 'launch-a' }], args: {} }] };
  const extra = { instruction: 'Continue.', requestId: 'new-user', previousCommand };
  const plan = compile([{ kind: 'send_prompt', sourceUserId: 'old-user' }], extra);
  const action = authorizeIntentAction({ kind: 'send_prompt' }, plan, sessions);
  assert.equal(action.targetId, 'b'); assert.equal(action.text, 'Review the changes; do not edit.');
  assert.throws(() => compile([{ kind: 'send_prompt', sourceUserId: 'old-user', targetIds: ['a'] }], extra), /unfinished operation/);
  assert.throws(() => compile([{ kind: 'close', sourceUserId: 'old-user', targetIds: ['a'] }], extra), /unfinished operation/);
  assert.throws(() => compile([{ kind: 'send_prompt', sourceUserId: 'old-user', text: 'Review and edit.' }], extra), /bound payload/);
  assert.throws(() => compile([{ kind: 'send_prompt', sourceUserId: 'old-user' }], { ...extra, sessions: sessions.map(s => s.id === 'b' ? { ...s, generation: 'new-b' } : s) }), /target changed/);
});

test('continued all-target grants may narrow but cannot reintroduce completed or out-of-scope targets', () => {
  const previousCommand = { requestId: 'old-user', instruction: 'Ask both terminals to review.', grants: [{ kind: 'send_prompt', targets: [{ id: 'a', generation: 'launch-a' }, { id: 'b', generation: 'launch-b' }], args: {}, text: 'Review.' }] };
  const extra = { requestId: 'new-user', instruction: 'Just do one of those now.', previousCommand };
  const plan = compile([{ kind: 'send_prompt', sourceUserId: 'old-user', selection: 'one' }], extra);
  assert.equal(plan.grants[0].targets.length, 1);
  assert.throws(() => compile([{ kind: 'send_prompt', sourceUserId: 'old-user', targetIds: ['a', 'other'], selection: 'all' }], extra), /unfinished operation/);
  const all = compile([{ kind: 'send_prompt', sourceUserId: 'old-user' }], { ...extra, instruction: 'Continue with both.' });
  assert.deepEqual(all.grants[0].targets.map(target => target.id), ['a', 'b']);
});

test('the same unfinished slot cannot mint two new continuation grants', () => {
  const previousCommand = { requestId: 'old-user', instruction: 'Ask A to review.', grants: [{ kind: 'send_prompt', targets: [{ id: 'a', generation: 'launch-a' }], args: {}, text: 'Review.' }] };
  const action = { kind: 'send_prompt', sourceUserId: 'old-user' };
  assert.throws(() => compile([action, action], { requestId: 'new-user', instruction: 'Continue.', previousCommand }), /cannot be duplicated/);
});

test('continued non-target operations inherit frozen arguments and reject changed names or paths', () => {
  const previousCommand = { requestId: 'old-user', instruction: 'Create project Demo in Documents.', grants: [{ kind: 'create_project', targets: [], args: { name: 'Demo', parent: 'C:\\Documents' } }] };
  const extra = { requestId: 'new-user', instruction: 'Continue.', previousCommand };
  const plan = compile([{ kind: 'create_project', sourceUserId: 'old-user' }], extra);
  assert.deepEqual(plan.grants[0].args, { name: 'Demo', parent: 'C:\\Documents' });
  assert.throws(() => compile([{ kind: 'create_project', sourceUserId: 'old-user', parent: 'C:\\Other' }], extra), /unfinished operation/);
  assert.throws(() => compile([{ kind: 'create_project', sourceUserId: 'old-user', name: 'Changed' }], extra), /unfinished operation/);
});

test('unfinished structured answers preserve the exact prior request snapshot and user answer', () => {
  const old = compile([{ kind: 'answer_question', targetIds: ['a'], answerText: 'Unit' }], { requestId: 'old-user', instruction: 'Answer Unit.', requests: [question()] });
  const previousCommand = { requestId: 'old-user', instruction: 'Answer Unit.', grants: structuredClone(old.grants) };
  const action = { kind: 'answer_question', sourceUserId: 'old-user' }, extra = { requestId: 'new-user', instruction: 'Continue.', previousCommand, requests: [question()] };
  const plan = compile([action], extra);
  assert.equal(plan.grants[0].answerText, 'Unit');
  assert.equal(authorizeIntentAction({ kind: 'answer_question' }, plan, sessions).requestId, 'q1');
  assert.throws(() => compile([{ ...action, answerText: 'Smoke' }], extra), /unfinished operation/);
  assert.throws(() => compile([{ ...action, requestId: 'q2' }], extra), /unfinished operation/);
  assert.throws(() => compile([action], { ...extra, requests: [question({ revision: 4 })] }), /options have changed/);
  assert.throws(() => compile([action], { ...extra, requests: [question({ questions: [{ id: 'scope', options: [{ label: 'Delete' }] }] })] }), /options have changed/);
});

test('ambiguous remaining payloads require identifying one old task rather than guessing its content', () => {
  const previousCommand = { requestId: 'old-user', instruction: 'Ask A to review code and later review tests.', grants: [
    { kind: 'send_prompt', targets: [{ id: 'a', generation: 'launch-a' }], args: {}, text: 'Review code.' },
    { kind: 'send_prompt', targets: [{ id: 'a', generation: 'launch-a' }], args: {}, text: 'Review tests.' },
  ] };
  const extra = { requestId: 'new-user', instruction: 'Continue.', previousCommand };
  assert.throws(() => compile([{ kind: 'send_prompt', sourceUserId: 'old-user' }], extra), /one unfinished/);
  assert.equal(compile([{ kind: 'send_prompt', sourceUserId: 'old-user', text: 'Review tests.' }], extra).grants[0].text, 'Review tests.');
});

test('source answers must be literal user text and cannot borrow an unrelated prior turn', () => {
  const action = { kind: 'answer_question', targetIds: ['a'], answerText: 'Unit' };
  const plan = compile([action], { instruction: 'Answer Unit please.', requests: [question()] });
  assert.equal(authorizeIntentAction({ kind: 'answer_question' }, plan, sessions).answerText, 'Unit');
  assert.throws(() => compile([{ ...action, answerText: 'Smoke' }], { instruction: 'Answer Unit please.', requests: [question()] }), /literal text/);
  assert.throws(() => compile([action], { instruction: 'Okay', previousCommand: { requestId: 'old', instruction: 'Unit', candidates: [{ id: 'a', generation: 'launch-a' }] }, requests: [question()] }), /literal text/);
  const prior = compile([{ ...action, sourceUserId: 'old' }], { instruction: 'Use that answer.', previousCommand: { requestId: 'old', instruction: 'Unit', candidates: [{ id: 'a', generation: 'launch-a' }] }, requests: [question()] });
  assert.equal(prior.grants[0].answerText, 'Unit');
});

test('question answers freeze request identity, revision, options and separate user values', () => {
  const request = question({ questions: [{ id: 'scope', question: 'Which scope?', options: [{ label: 'Small' }] }, { id: 'tests', question: 'Which tests?', options: [{ label: 'Unit' }, { label: 'Smoke' }], multiple: true }] });
  const plan = compile([{ kind: 'answer_question', targetIds: ['a'], answerTexts: { scope: 'Small', tests: 'Unit and Smoke' } }], { instruction: 'Use Small scope and Unit and Smoke tests.', requests: [request] });
  request.questions[0].options[0].label = 'Delete'; request.revision++;
  const action = authorizeIntentAction({ kind: 'answer_question' }, plan, sessions);
  assert.equal(action.requestId, 'q1'); assert.equal(action.revision, 3);
  assert.deepEqual(action.answerTexts, { scope: 'Small', tests: 'Unit and Smoke' });
  assert.equal(plan.grants[0].interactions.a.questions[0].options[0].label, 'Small');
  assert.throws(() => authorizeIntentAction({ kind: 'answer_question', revision: 4 }, plan, sessions), /revision/);
  assert.throws(() => authorizeIntentAction({ kind: 'answer_question', requestId: 'different' }, plan, sessions), /interaction/);
  assert.throws(() => authorizeIntentAction({ kind: 'answer_question', answers: { scope: ['Delete'] } }, plan, sessions), /unexpected/);
  assert.throws(() => authorizeIntentAction({ kind: 'answer_question', answerTexts: { scope: 'Small', tests: 'Smoke' } }, plan, sessions), /user-supplied/);
  claimGrant(action, plan);
});

test('multi-question answers must cover exact IDs and cannot duplicate one inferred answer', () => {
  const requests = [question({ questions: [{ id: 'one' }, { id: 'two' }] })];
  const extra = { instruction: 'Use Unit and Smoke.', requests };
  for (const answer of [{ answerText: 'Unit' }, { answerTexts: { one: 'Unit' } }, { answerTexts: { one: 'Unit', other: 'Smoke' } }]) assert.throws(() => compile([{ kind: 'answer_question', targetIds: ['a'], ...answer }], extra), /distinct|every question/);
});

test('ambiguous, stale, missing and resolved requests cannot supply answer authority', () => {
  const action = { kind: 'answer_question', targetIds: ['a'], answerText: 'Unit' }, extra = { instruction: 'Unit' };
  for (const requests of [[], [question(), question({ id: 'q2' })], [question({ state: 'resolved' })], [question({ generation: 'old' })], [question({ generation: undefined })], [question({ revision: undefined })]]) assert.throws(() => compile([action], { ...extra, requests }), /interaction|revision/);
  const plan = compile([{ ...action, requestId: 'q2' }], { ...extra, requests: [question(), question({ id: 'q2' })] });
  assert.equal(plan.grants[0].interactions.a.requestId, 'q2');
});

test('permission values remain literal user sources and executor cannot expand decision scope', () => {
  const plan = compile([{ kind: 'permission', targetIds: ['a'], answerText: 'allow once' }], { instruction: 'Please allow once.', requests: [question({ kind: 'permission' })] });
  const action = authorizeIntentAction({ kind: 'permission' }, plan, sessions);
  assert.equal(action.answerText, 'allow once');
  for (const payload of [{ decision: 'always' }, { reply: 'always' }, { answerText: 'allow always' }]) assert.throws(() => authorizeIntentAction({ kind: 'permission', ...payload }, plan, sessions), /unexpected|user-supplied/);
  action.reply = 'once'; // Application mapping is transport data, not new model authority.
  claimGrant(action, plan);
});

test('terminal navigation retains literal input and consumes only on submission', () => {
  const plan = compile([{ kind: 'terminal_interact', targetIds: ['a'], answerText: 'my answer' }], { instruction: 'Type my answer into that terminal.' });
  const nav = authorizeIntentAction({ kind: 'terminal_interact', observationSequence: 1, keys: ['down', 'tab'] }, plan, sessions);
  assert.equal(nav.text, undefined);
  assert.equal(claimGrant(nav, plan).consumed, false);
  const typed = authorizeIntentAction({ kind: 'terminal_interact', observationSequence: 2, text: 'my answer' }, plan, sessions);
  assert.equal(claimGrant(typed, plan).consumed, false);
  const submit = authorizeIntentAction({ kind: 'terminal_interact', observationSequence: 3, keys: ['enter'] }, plan, sessions);
  assert.equal(claimGrant(submit, plan).consumed, true);
  assert.throws(() => authorizeIntentAction({ kind: 'terminal_interact', observationSequence: 4, keys: ['enter'] }, plan, sessions), /already dispatched/);
});

test('terminal inputs need fresh observations, supported bounded keys and exact single-line user text', () => {
  const plan = compile([{ kind: 'terminal_interact', targetIds: ['a'], text: 'Unit' }], { instruction: 'Type Unit' });
  for (const payload of [{ keys: ['up'] }, { observationSequence: -1, keys: ['up'] }, { observationSequence: Number.MAX_SAFE_INTEGER + 1, keys: ['up'] }, { observationSequence: 1, keys: ['ctrl-c'] }, { observationSequence: 1, keys: ['enter', 'down'] }, { observationSequence: 1, text: 'Smoke' }, { observationSequence: 1, submit: 'yes' }, { observationSequence: 1 }]) assert.throws(() => authorizeIntentAction({ kind: 'terminal_interact', ...payload }, plan, sessions));
  assert.throws(() => compile([{ kind: 'terminal_interact', targetIds: ['a'], text: 'a\nb' }], { instruction: 'Type a\nb' }), /single-line/);
  assert.throws(() => compile([{ kind: 'terminal_interact', targetIds: ['a'], text: 'invented answer' }]), /literal text/);
});

test('a newly observed silent terminal can accept authorized input at sequence zero', () => {
  const plan = compile([{ kind: 'terminal_interact', targetIds: ['a'], text: 'Unit' }], { instruction: 'Type Unit' });
  const action = authorizeIntentAction({ kind: 'terminal_interact', observationSequence: 0, text: 'Unit' }, plan, sessions);
  assert.equal(action.observationSequence, 0);
  assert.equal(claimGrant(action, plan).consumed, false);
});

test('terminal navigation has a total per-target budget rather than a reset on each call', () => {
  const plan = compile([{ kind: 'terminal_interact', targetIds: ['a', 'b'], selection: 'all', answerText: 'Enter' }], { instruction: 'Scroll down and press Enter in both terminals.' });
  const action = authorizeIntentAction({ kind: 'terminal_interact', targetId: 'a', observationSequence: 1, keys: Array(15).fill('down') }, plan, sessions);
  claimGrant(action, plan);
  assert.throws(() => authorizeIntentAction({ kind: 'terminal_interact', targetId: 'a', observationSequence: 2, keys: ['down', 'enter'] }, plan, sessions), /limit/);
  claimGrant(authorizeIntentAction({ kind: 'terminal_interact', targetId: 'a', observationSequence: 2, submit: true }, plan, sessions), plan);
  assert.equal(claimGrant(authorizeIntentAction({ kind: 'terminal_interact', targetId: 'b', observationSequence: 1, keys: ['down'] }, plan, sessions), plan).consumed, false);
});

test('navigation-only grants cannot submit a menu answer and native literal inputs remain complete in context', () => {
  const navigation = compile([{ kind: 'terminal_interact', targetIds: ['a'] }], { instruction: 'Scroll up in this terminal.' });
  assert.throws(() => authorizeIntentAction({ kind: 'terminal_interact', observationSequence: 1, keys: ['enter'] }, navigation, sessions), /user-supplied answer/);
  const text = 'literal value '.repeat(40), input = compile([{ kind: 'terminal_interact', targetIds: ['a'], text }], { instruction: `Type ${text}` });
  assert.equal(projectIntent(input).grants[0].text, text);
  assert.throws(() => authorizeIntentAction({ kind: 'terminal_interact', observationSequence: 1, keys: ['enter'], submit: true }, input, sessions), /once/);
});

test('non-target effect arguments are frozen and can only dispatch once', () => {
  const plan = compile([{ kind: 'navigate', view: 'project', cwd: 'C:\\work\\vibeTerminal' }]);
  assert.throws(() => authorizeIntentAction({ kind: 'navigate', view: 'settings' }, plan, sessions), /cannot change/);
  assert.throws(() => authorizeIntentAction({ kind: 'navigate', targetId: 'a' }, plan, sessions), /does not accept/);
  const action = authorizeIntentAction({ kind: 'navigate' }, plan, sessions);
  assert.equal(action.view, 'project');
  claimGrant(action, plan);
  assert.equal(projectIntent(plan).grants[0].dispatched, true);
  assert.throws(() => authorizeIntentAction({ kind: 'navigate' }, plan, sessions), /already dispatched/);
});

test('deferred history discovery only fills an opaque reference, leaving identity verification to caller', () => {
  const plan = compile([{ kind: 'resume_conversation', provider: 'codex', cwd: 'C:\\work\\vibeTerminal' }]);
  const action = authorizeIntentAction({ kind: 'resume_conversation', reference: 'opaque-discovered-ref' }, plan, sessions);
  assert.equal(action.reference, 'opaque-discovered-ref');
  assert.throws(() => authorizeIntentAction({ kind: 'resume_conversation', reference: 'ref', cwd: 'C:\\other' }, plan, sessions), /cannot change/);
  const exact = compile([{ kind: 'resume_conversation', reference: 'exact' }]);
  assert.throws(() => authorizeIntentAction({ kind: 'resume_conversation', reference: 'different' }, exact, sessions), /cannot change/);
});

test('preference operations retain supplied text and exact stored preference identity', () => {
  const plan = compile([{ kind: 'forget_preference', preferenceId: 'p1', text: 'prefer short replies' }], { instruction: 'Forget prefer short replies.' });
  const action = authorizeIntentAction({ kind: 'forget_preference' }, plan, sessions);
  assert.equal(action.text, 'prefer short replies'); assert.equal(action.preferenceId, 'p1');
  assert.throws(() => authorizeIntentAction({ kind: 'forget_preference', preferenceId: 'p2' }, plan, sessions), /cannot change/);
});

test('malformed plans and inappropriate action fields fail before creating execution grants', () => {
  const invalid = [
    { goal: 'Hi', actions: [], extra: true }, { goal: '', actions: [] }, { goal: 'Hi', actions: null },
    { goal: 'Hi', actions: Array.from({ length: 25 }, () => send()) },
    ...[{ kind: 'open_file' }, { kind: 'send_prompt', targetIds: ['a'] }, send({ targetIds: ['missing'] }), send({ targetIds: ['a', 'a'] }), send({ targetIds: ['a', 'b'] }), send({ selection: 'random' }), send({ decision: 'always' }), { kind: 'close', targetIds: ['a'], text: 'payload' }, { kind: 'navigate', view: 'settings', cwd: 'C:\\work' }, { kind: 'navigate', view: 'project' }, { kind: 'create_session' }, { kind: 'create_project' }, { kind: 'forget_preference', text: 'x' }].map(action => ({ goal: 'Hi', actions: [action] })),
  ];
  for (const raw of invalid) assert.throws(() => normalizeIntent(raw, context()), undefined, JSON.stringify(raw));
});

test('saved resume advertises only its own fields and preserves discovery authority boundaries', () => {
  const variants = INTENT_TOOL.function.parameters.properties.actions.items.anyOf;
  const resume = variants.find(schema => schema.properties.kind.enum[0] === 'resume_conversation');
  assert.equal(resume.additionalProperties, false);
  assert.deepEqual(Object.keys(resume.properties).sort(), ['kind', 'sourceUserId', 'provider', 'cwd', 'reference'].sort());
  for (const field of ['name', 'text', 'targetIds', 'promptMode', 'requestId']) {
    assert.equal(resume.properties[field], undefined);
    assert.throws(() => compile([{ kind: 'resume_conversation', [field]: field === 'targetIds' ? ['a'] : 'Mix 21 last attempt' }]), /Invalid or unexpected resume_conversation command fields/);
  }
  const plan = normalizeIntent({ goal: 'Find and resume Mix 21 last attempt.', actions: [{ kind: 'resume_conversation' }] }, context({ instruction: 'Can you resume the mix to one last attempt conversation?' }));
  assert.deepEqual(plan.grants[0].args, {});
  assert.deepEqual(plan.grants[0].targets, []);
  assert.equal(authorizeIntentAction({ kind: 'resume_conversation', reference: 'discovered-exact-identity' }, plan, sessions).reference, 'discovered-exact-identity');
  assert.throws(() => authorizeIntentAction({ kind: 'resume_conversation', reference: 'discovered-exact-identity', provider: 'codex' }, plan, sessions), /cannot change/);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', targetId: 'a', text: 'Continue' }, plan, sessions), /matching user command grant/);
});
