'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { INTENT_SYSTEM, INTENT_TOOL, normalizeIntent, projectIntent, authorizeIntentAction, claimGrant, releaseGrantStep } = require('../../backend/orchestratorIntent.cjs');

const sessions = [{ id: 'a', generation: 'g', kind: 'codex' }, { id: 'b', generation: 'gb', kind: 'claude' }];
const instruction = 'Review the changes without editing files, navigate its menus, and choose suitable answers. You may approve once or reject needed operations.';
function plan(command = {}, context = {}) {
  return normalizeIntent({ goal: 'Review changes without editing files.', executionMode: 'direct', actions: [{ kind: 'operate_terminal', text: instruction, targetIds: ['a'], ...command }] }, { requestId: 'user1', instruction, sessions, ...context });
}
function action(p, fields = {}, options = {}) {
  return authorizeIntentAction({ kind: 'terminal_interact', grantId: p.grants[0].id, stepId: 'step1', observationSequence: 7, inputRevision: 0, keys: ['down'], ...fields }, p, sessions, options);
}
function interactionOptions(kind = 'question', extra = {}) {
  const request = { id: 'q', sessionId: 'a', generation: 'g', revision: 2, state: 'pending', kind, questions: [{ id: 'scope', options: [{ label: 'Unit tests' }, { label: 'Smoke tests' }] }], ...extra };
  return { requests: [request], observedInteractions: [{ requestId: request.id, sessionId: request.sessionId, generation: request.generation, revision: request.revision, questions: structuredClone(request.questions) }] };
}
const answer = (p, fields = {}, options = interactionOptions()) => authorizeIntentAction({ kind: 'answer_question', grantId: p.grants[0].id, stepId: 'answer1', requestId: 'q', revision: 2, answerText: 'Unit tests', ...fields }, p, sessions, options);

test('operator compiler exposes frozen complete objective and defaults without changing legacy schema', () => {
  const p = plan(), projected = projectIntent(p).grants[0];
  assert.equal(p.executionMode, 'reason');
  assert.equal(projected.text, instruction);
  assert.equal(projected.promptMode, 'compose');
  assert.equal(projected.answerMode, 'delegated');
  assert.equal(projected.permissionMode, 'none');
  assert.deepEqual(projected.progress, [{ targetId: 'a', steps: 0, remainingSteps: 128 }]);
  assert.ok(Object.isFrozen(p.grants[0].targets[0]));
  assert.ok(INTENT_TOOL.function.parameters.properties.actions.items.anyOf.some(schema => schema.properties.kind.enum[0] === 'operate_terminal'));
  assert.match(INTENT_SYSTEM, /permissionMode defaults to 'none'/);
  assert.match(INTENT_SYSTEM, /stage_draft is only for an explicit request/);
  assert.match(INTENT_SYSTEM, /operate_terminal for task delivery and general interactive actions/);
  assert.match(INTENT_SYSTEM, /native informational lookups use inspect_terminal/);
  assert.match(INTENT_SYSTEM, /watch_terminal.*observation only/s);
  assert.match(INTENT_SYSTEM, /do not select them for new terminal actions, including exact one-shot relays/);
  assert.deepEqual(INTENT_TOOL.function.parameters.properties.actions.items.anyOf.find(schema => schema.properties.kind.enum[0] === 'operate_terminal').properties.promptMode.enum, ['compose', 'literal']);
});
test('application step fallback fills only absent IDs and optional counters remain observer-owned', () => {
  const p=plan(), raw={kind:'terminal_interact',keys:['down']};
  const authorized=authorizeIntentAction(raw,p,sessions,{fallbackStepId:'tool-call-hash'});
  assert.equal(authorized.stepId,'tool-call-hash');assert.equal(Object.hasOwn(raw,'stepId'),false);
  assert.equal(Object.hasOwn(authorized,'observationSequence'),false);assert.equal(Object.hasOwn(authorized,'inputRevision'),false);
  for(const stepId of [undefined,null,'']) assert.throws(()=>authorizeIntentAction({...raw,stepId},p,sessions,{fallbackStepId:'tool-call-hash'}),/step ID/);
  for(const field of ['observationSequence','inputRevision']) for(const value of [undefined,-1,'7']) assert.throws(()=>authorizeIntentAction({...raw,[field]:value},p,sessions,{fallbackStepId:'tool-call-hash'}),/Invalid terminal/);
});

test('operator supports navigation, composed prompts and repeated submissions until explicit finish', () => {
  const p = plan();
  claimGrant(action(p), p);
  const first = action(p, { stepId: 'step2', keys: ['escape'], text: 'Review the diff; do not edit files.', submit: true });
  claimGrant(first, p);
  claimGrant(action(p, { stepId: 'step3', keys: ['ctrl-a', 'delete'], text: 'Focus the review on the failing tests.', submit: true }), p);
  assert.deepEqual(projectIntent(p).grants[0].availableTargetIds, ['a']);
  assert.equal(projectIntent(p).grants[0].progress[0].steps, 3);
  assert.equal(projectIntent(p).grants[0].dispatched, false);
  const done = authorizeIntentAction({ kind: 'finish_terminal', stepId: 'finish', text: 'Observed the terminal review report.', outcome: 'completed' }, p, sessions);
  assert.equal(claimGrant(done, p).consumed, true);
  assert.equal(projectIntent(p).grants[0].progress[0].outcome, 'completed');
  assert.equal(projectIntent(p).grants[0].progress[0].steps, 3);
  assert.throws(() => action(p, { stepId: 'after-finish' }), /already dispatched/);
});

test('operator send_prompt can default to objective or compose scoped intermediate text', () => {
  const p = plan();
  const initial = authorizeIntentAction({ kind: 'send_prompt', stepId: 'initial', observationSequence: 0, inputRevision: 0 }, p, sessions);
  assert.equal(initial.text, instruction);
  claimGrant(initial, p);
  const followup = authorizeIntentAction({ kind: 'send_prompt', stepId: 'followup', text: 'Explain the first finding without edits.' }, p, sessions);
  claimGrant(followup, p);
  assert.equal(projectIntent(p).grants[0].progress[0].steps, 2);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', stepId: 'bad', text: 'bad\x1btext' }, p, sessions), /bounded literal/);
});

test('operator grant cannot extend targets, generations, operation kinds or command fields', () => {
  const p = plan();
  assert.throws(() => action(p, { targetId: 'b' }), /outside/);
  assert.throws(() => action(p, { generation: 'old' }), /Stale/);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', stepId: '1' }, p, [{ id: 'a', generation: 'new' }]), /changed or restarted/);
  for (const kind of ['close', 'restart', 'create_session', 'stage_draft', 'operate_terminal']) assert.throws(() => authorizeIntentAction({ kind, grantId: p.grants[0].id, stepId: '1' }, p, sessions), /matching|Unsupported/);
  assert.throws(() => action(p, { answerMode: 'supplied' }), /unexpected/);
  assert.throws(() => action(p, { target: Object.assign(Object.create({ id: 'a' }), { generation: 'g' }) }), /unexpected/);
});

test('each operator step has immutable payload, dispatch-once identity and explicit not-written retirement', () => {
  const p = plan(), first = action(p);
  assert.throws(() => action(p, { keys: ['up'] }), /different input/);
  assert.throws(() => claimGrant({ ...first, keys: ['up'] }, p), /changed before dispatch/);
  claimGrant(first, p);
  assert.deepEqual(action(p, {}, { allowConsumed: true }), first);
  assert.throws(() => claimGrant(first, p), /already dispatched/);
  assert.equal(releaseGrantStep(first, p).released, true);
  assert.throws(() => action(p, {}, { allowConsumed: true }), /already dispatched/);
  assert.throws(() => claimGrant(first, p), /already dispatched/);
  claimGrant(action(p, { stepId: 'retry-after-new-read', observationSequence: 8 }), p);
  assert.equal(projectIntent(p).grants[0].progress[0].steps, 2);
});

test('operator has bounded per-target step budget and permits final verification at exhaustion', () => {
  const p = plan({ targetIds: ['a', 'b'], selection: 'all' });
  for (let i = 0; i < 128; i++) claimGrant(action(p, { targetId: 'a', stepId: `s${i}` }), p);
  assert.throws(() => action(p, { targetId: 'a', stepId: 'overflow' }), /limit/);
  claimGrant(action(p, { targetId: 'b', stepId: 'independent' }), p);
  const finish = authorizeIntentAction({ kind: 'finish_terminal', targetId: 'a', stepId: 'finish', text: 'Terminal blocked on unavailable credentials.', outcome: 'blocked' }, p, sessions);
  claimGrant(finish, p);
  assert.deepEqual(projectIntent(p).grants[0].availableTargetIds, ['a', 'b']);
  assert.deepEqual(projectIntent(p).grants[0].blockedTargetIds, ['a']);
  assert.throws(() => action(p, { targetId: 'a', stepId: 'after-blocked' }), /limit/);
  assert.equal(projectIntent(p).grants[0].progress[0].outcome, 'blocked');
});

test('operator native controls require current sequence/input revision and use shared safe key validation', () => {
  const p = plan();
  for (const fields of [{ stepId: undefined }, { observationSequence: undefined }, { inputRevision: undefined }, { inputRevision: -1 }, { keys: ['raw-escape'] }, { text: '\x1b[H' }, { keys: ['enter'], submit: true }, { editInput: 'yes' }]) assert.throws(() => action(p, fields));
  const valid = action(p, { keys: ['ctrl-a', 'f2', 'pagedown'], text: 'line one\nline two\titem', editInput: true });
  assert.equal(valid.editInput, true);
  assert.equal(valid.text, 'line one\nline two\titem');
});

test('supplied mode pins native and structured answer values to user-source literals', () => {
  const p = plan({ answerMode: 'supplied', answerText: 'Smoke tests' }, { instruction: 'Choose Smoke tests in terminal a.' });
  assert.throws(() => action(p, { text: 'Unit tests' }), /user-supplied/);
  assert.equal(action(p, { text: 'Smoke tests' }).text, 'Smoke tests');
  assert.throws(() => answer(p), /user-supplied/);
  assert.equal(answer(p, { answerText: undefined }).answerText, 'Smoke tests');
  assert.throws(() => plan({ answerMode: 'supplied' }), /literal user answers/);
  assert.throws(() => plan({ answerMode: 'supplied', answerText: 'invented' }), /literal text supplied/);
});

test('delegated question answers require an exact fresh current request snapshot', () => {
  const p = plan(), options = interactionOptions();
  assert.equal(answer(p, {}, options).answerText, 'Unit tests');
  assert.throws(() => answer(p, { stepId: 'no-read' }, { requests: options.requests }), /Read the current/);
  for (const field of ['generation', 'revision', 'sessionId']) {
    const changed = structuredClone(options); changed.requests[0][field] = field === 'revision' ? 3 : 'changed';
    assert.throws(() => answer(p, { stepId: field }, changed), /Read the current/);
  }
  const mutated = structuredClone(options); mutated.requests[0].questions[0].options = [{ label: 'New choice' }];
  assert.throws(() => answer(p, { stepId: 'changed-options' }, mutated), /questions changed/);
  assert.throws(() => answer(p, { revision: undefined }), /revision/);
});

test('delegated multi-question answers require every exact current question ID', () => {
  const p = plan(), options = interactionOptions('question', { questions: [{ id: 'scope' }, { id: 'depth' }] });
  assert.throws(() => answer(p, {}, options), /every current question/);
  assert.throws(() => answer(p, { answerText: undefined, answerTexts: { scope: 'Unit' } }, options), /every current question/);
  const complete = answer(p, { answerText: undefined, answerTexts: { scope: 'Unit', depth: 'Full' } }, options);
  const mapped = { ...complete, answers: { scope: 'Unit', depth: 'Full' }, actionId: 'app-owned-action' };
  claimGrant(mapped, p);
  assert.equal(projectIntent(p).grants[0].progress[0].steps, 1);
});

test('permission authority defaults to none and delegated approvals cannot become persistent', () => {
  const options = interactionOptions('permission');
  assert.throws(() => answer(plan(), { kind: 'permission', answerText: 'approve' }, options), /does not authorize/);
  const p = plan({ permissionMode: 'delegated' });
  assert.throws(() => answer(p, { kind: 'permission', decision: 'always', answerText: undefined }, options), /persistent approval/);
  const once = answer(p, { kind: 'permission', decision: 'once', answerText: undefined }, options);
  claimGrant(once, p);
  const semantic = answer(p, { kind: 'permission', stepId: 'semantic', answerText: 'approve this operation' }, options);
  assert.throws(() => claimGrant({ ...semantic, decision: 'always' }, p), /persistent approval/);
  claimGrant({ ...semantic, decision: 'once', reply: 'once' }, p);
});

test('explicit supplied permission preserves literal scope and permits parent canonical mapping', () => {
  const p = plan({ permissionMode: 'supplied', answerText: 'always allow' }, { instruction: 'For this terminal, always allow.' });
  const permission = answer(p, { kind: 'permission', answerText: undefined }, interactionOptions('permission'));
  assert.equal(permission.answerText, 'always allow');
  claimGrant({ ...permission, decision: 'always', reply: 'always' }, p);
  assert.throws(() => plan({ permissionMode: 'supplied' }), /literal user answers/);
  assert.throws(() => plan({ permissionMode: 'unlimited' }), /Invalid terminal decision authority/);
});

test('continuing an unfinished operator preserves objective, targets and decision policies', () => {
  const p = plan({ answerMode: 'supplied', permissionMode: 'none', answerText: 'Smoke tests' }, { instruction: 'Choose Smoke tests in terminal a.' });
  const previousCommand = { requestId: 'user1', instruction: 'Choose Smoke tests in terminal a.', grants: p.grants };
  const continued = normalizeIntent({ goal: 'Continue the pending objective.', actions: [{ kind: 'operate_terminal', sourceUserId: 'user1' }] }, { requestId: 'user2', instruction: 'Continue.', previousCommand, sessions });
  assert.equal(continued.grants[0].answerMode, 'supplied');
  assert.equal(continued.grants[0].permissionMode, 'none');
  assert.equal(continued.grants[0].text, p.grants[0].text);
  assert.throws(() => normalizeIntent({ goal: 'Continue.', actions: [{ kind: 'operate_terminal', sourceUserId: 'user1', permissionMode: 'delegated' }] }, { requestId: 'user2', instruction: 'Continue.', previousCommand, sessions }), /match one unfinished/);
});

test('literal prompt mode requires exact source text and retains the observed operator workflow', () => {
  const literal = 'Review the diff; do not edit.\nKeep this second line.';
  const p = plan({ promptMode: 'literal', text: literal }, { instruction: `Send exactly "${literal}" to terminal a.` });
  assert.equal(p.executionMode, 'reason');
  assert.equal(projectIntent(p).grants[0].promptMode, 'literal');
  const initial = authorizeIntentAction({ kind: 'send_prompt', stepId: 'literal1', observationSequence: 0, inputRevision: 0 }, p, sessions);
  assert.equal(initial.text, literal);
  claimGrant(initial, p);
  assert.deepEqual(projectIntent(p).grants[0].availableTargetIds, ['a']);
  assert.equal(authorizeIntentAction({ kind: 'send_prompt', stepId: 'literal2', text: literal }, p, sessions).text, literal);
  assert.throws(() => plan({ promptMode: 'literal', text: 'Summarize and fix everything.' }), /literal text supplied/);
  assert.throws(() => plan({ promptMode: 'literal', text: 'Review the diff; do not edit.' }, { instruction: 'Send review the diff; do not edit. to terminal a.' }), /literal text supplied/);
  assert.throws(() => plan({ promptMode: 'automatic' }), /Invalid terminal prompt mode/);
});

test('literal mode rejects changed task payloads and controls that would alter exact pasted text', () => {
  const literal = 'Review only; do not edit.';
  const p = plan({ promptMode: 'literal', text: literal }, { instruction: `Send exactly "${literal}" to terminal a.` });
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', stepId: 'rewrite', text: 'Review and fix.' }, p, sessions), /Literal prompt text/);
  assert.throws(() => authorizeIntentAction({ kind: 'send_prompt', stepId: 'append', text: literal, editInput: true }, p, sessions), /Literal prompt text/);
  assert.throws(() => action(p, { inputPurpose: 'task', text: 'Review and fix.', keys: ['enter'] }), /Literal task input/);
  assert.throws(() => action(p, { inputPurpose: 'task', keys: ['enter'] }), /Literal task input/);
  assert.throws(() => action(p, { inputPurpose: 'task', text: literal, keys: ['backspace', 'enter'] }), /editing controls/);
  const native = action(p, { inputPurpose: 'task', text: literal, keys: ['ctrl-m'] });
  assert.equal(native.text, literal);
  claimGrant(native, p);
});

test('literal task mode preserves delegated and supplied answers independently of the task prompt', () => {
  const literal = 'Review only; do not edit.';
  const p = plan({ promptMode: 'literal', text: literal, answerMode: 'supplied', answerText: 'Unit tests' }, { instruction: `Send exactly "${literal}" to terminal a. Answer Unit tests.` });
  const native = action(p, { inputPurpose: 'task', text: literal, keys: ['enter'] });
  assert.equal(native.text, literal);
  const supplied = action(p, { stepId: 'answer', inputPurpose: 'interaction', text: 'Unit tests', keys: ['enter'] });
  assert.equal(supplied.text, 'Unit tests');
  assert.throws(() => action(p, { stepId: 'wrong-answer', inputPurpose: 'interaction', text: 'Smoke tests', keys: ['enter'] }), /user-supplied answer/);
  const delegated = plan({ promptMode: 'literal', text: literal }, { instruction: `Send exactly "${literal}" and answer setup questions as needed.` });
  assert.equal(action(delegated, { inputPurpose: 'interaction', text: 'Use the existing configuration.', keys: ['enter'] }).text, 'Use the existing configuration.');
});

test('literal mode remains frozen across continuation while default composed prompts can evolve', () => {
  const literal = 'Review only; do not edit.';
  const p = plan({ promptMode: 'literal', text: literal }, { instruction: `Send exactly "${literal}" to terminal a.` });
  const previousCommand = { requestId: 'user1', instruction: `Send exactly "${literal}" to terminal a.`, grants: p.grants };
  const ctx = { requestId: 'user2', instruction: 'Continue.', previousCommand, sessions };
  const continued = normalizeIntent({ goal: 'Continue the exact relay.', actions: [{ kind: 'operate_terminal', sourceUserId: 'user1' }] }, ctx);
  assert.equal(continued.grants[0].promptMode, 'literal');
  assert.equal(authorizeIntentAction({ kind: 'send_prompt', stepId: 'continued' }, continued, sessions).text, literal);
  assert.throws(() => normalizeIntent({ goal: 'Continue.', actions: [{ kind: 'operate_terminal', sourceUserId: 'user1', promptMode: 'compose' }] }, ctx), /match one unfinished/);
  const composed = plan();
  assert.equal(composed.grants[0].promptMode, 'compose');
  assert.equal(authorizeIntentAction({ kind: 'send_prompt', stepId: 'composed', text: 'Explain the first review finding without edits.' }, composed, sessions).text, 'Explain the first review finding without edits.');
});
test('lifecycle defaults preserve agent and clearing input cannot use interrupt or exit controls', () => {
 const p=plan({text:'Clear the unsent text without sending it.'});
 assert.equal(projectIntent(p).grants[0].lifecycleMode,'preserve');
 for(const key of ['ctrl-c','ctrl-d','ctrl-backslash','ctrl-z']) assert.throws(()=>action(p,{keys:[key],editInput:true}),/preserve/);
 assert.throws(()=>authorizeIntentAction({kind:'interrupt',grantId:p.grants[0].id,stepId:'stop'},p,sessions),/preserve/);
 assert.equal(action(p,{keys:['end','ctrl-u'],editInput:true}).editInput,true);
 assert.throws(()=>action(p,{lifecycleMode:'exit'}));
});
test('explicit lifecycle authority bounds interrupt and exit controls without changing legacy interrupts', () => {
 const interrupt=plan({text:'Interrupt current work',lifecycleMode:'interrupt'});
 assert.deepEqual(action(interrupt,{keys:['ctrl-c']}).keys,['ctrl-c']);
 assert.equal(authorizeIntentAction({kind:'interrupt',grantId:interrupt.grants[0].id,stepId:'stop'},interrupt,sessions).kind,'interrupt');
 for(const key of ['ctrl-d','ctrl-backslash','ctrl-z']) assert.throws(()=>action(interrupt,{keys:[key]}),/exiting or suspending/);
 const exit=plan({text:'Exit the terminal agent',lifecycleMode:'exit'});
 for(const key of ['ctrl-c','ctrl-d','ctrl-backslash','ctrl-z']) assert.deepEqual(action(exit,{keys:[key],stepId:key}).keys,[key]);
 const legacy=normalizeIntent({goal:'Interrupt',actions:[{kind:'interrupt',targetIds:['a']}]},{instruction:'Interrupt',requestId:'legacy',sessions});
 assert.equal(authorizeIntentAction({kind:'interrupt',targetId:'a'},legacy,sessions).kind,'interrupt');
});
test('continuation retains lifecycle authority and refuses upgrade through supplied command fields', () => {
 const original=plan();
 const previousCommand={requestId:'user1',instruction,grants:original.grants,candidates:original.grants[0].targets,expiresAt:Date.now()+10000};
 const compile=extra=>normalizeIntent({goal:'Continue',actions:[{kind:'operate_terminal',sourceUserId:'user1',targetIds:['a'],...extra}]},{instruction:'Continue',requestId:'next',sessions,previousCommand});
 assert.equal(compile({}).grants[0].lifecycleMode,'preserve');
 assert.throws(()=>compile({lifecycleMode:'exit'}),/match one unfinished/);
 assert.throws(()=>plan({lifecycleMode:'whatever'}),/lifecycle/);
});
