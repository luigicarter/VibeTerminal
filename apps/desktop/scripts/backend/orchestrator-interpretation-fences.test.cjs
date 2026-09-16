'use strict';
// The interpretation-side fences, and what replaced them. Every utterance here
// is a row the completion ladder actually ran on 2026-09-14 (run
// .tmp/orchestrator-ladder/2026-09-14T20-16-04-721Z-25440 and its tier-1
// sibling), where each one settled as "failed" without a prompt reaching any
// pane. The fence was always the same shape: a fact the application already
// held was turned into a repair sentence for the model, which answered with the
// same plan, and the request died on the second round. Each test below asserts
// the deterministic answer and the model call that is no longer spent.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { reviewExistingTargets, repairUnselectedTargets, eligibleExistingTargets } = require('../../backend/orchestratorTargetReview.cjs');
const { normalizeIntent } = require('../../backend/orchestratorIntent.cjs');
const { plannerTools, decodePlannerCalls } = require('../../backend/orchestratorPlannerTools.cjs');
const { createIntentInterpreter } = require('../../backend/orchestratorInterpreter.cjs');
const { interpretationFailureText, missingInformationSentence } = require('../../backend/orchestratorFailureText.cjs');

const CWD = 'C:/work/vibeTerminal';
const OTHER = 'C:/work/lina web app';
const LAUNCHERS = [{ kind: 'codex', label: 'Codex', available: true, configured: true },
  { kind: 'claude', label: 'Claude', available: true, configured: true }];
// Rows from the ladder corpus, verbatim.
const SAID = {
  idleGroup: 'Can you use one of the empty Vibe terminal codex terminals to investigate? why the orchestrator is reading out loud the, the, the result of the agent i would like it to just summarize some of the things give me a tldr Yeah. Yeah, prompt with that. *laughter*',
  idleClaude: 'Can you use one of the empty cloud code terminals in the vibe terminal project? I to make it... kind of investigate the performance of the orchestrator.',
  notWorking: "Bye. Don't put it in a new terminal. Just put it in a terminal that's not currently working.",
  justOpened: 'that new terminal that you just opened. Can you prompt it to fix a bug that when I tell the orchestrator to open a terminal, It replies with a random C drive type of path. It\u2019s really weird.',
  busyCodex: 'Let the Codex terminal that\u2019s currently working in Vibe terminal project that I, uh, when I asked you to clear the terminal, you literally quit at the codex terminal. which basically closed the codex session. Please let that terminal know that while it\u2019s currently working. That was one of the issues I reported. to continue its work that it\u2019s currently doing.',
  waitingCodex: 'The codex terminal in lina web app is waiting on something. Tell it to continue.',
  bothDone: 'Yes. on both terminals that are currently done. Please push them to push the fixes. tested. and basically resolved both the issues.',
  startCodex: 'Hey, bye. can you start a codex terminal and have it investigate performance issues.',
  openCodex: 'Can you open a codex terminal for me?',
  openCodexProject: 'Can you open a new Codex terminal and Vibe terminal project?',
  stopLast: 'can you stop that last terminal you worked on?',
  otherOne: 'Prompt the other one as well.',
};
// The exact value the brain invented for workItemId on tier-1 row 91.
const FABRICATED_WORK_ITEM = 'C:\\Users\\ahmed\\Documents\\vibeTerminal::investigate-performance-issues';

const pane = (id, extra = {}) => ({ id, generation: `g-${id}`, name: id, cwd: CWD, kind: 'codex', provider: 'codex',
  started: true, status: 'idle', processState: 'running', agentProcessState: 'running', agentPid: 10,
  turnState: 'idle', observation: 'observed', conversationId: `conversation-${id}`, ...extra });
const working = (id, extra = {}) => pane(id, { status: 'running', turnState: 'running', turnId: `turn-${id}`,
  turnStartedAt: 1000, ...extra });
const target = session => ({ id: session.id, generation: session.generation });
const operation = (targets, text = 'Do the work.', extra = {}) => ({ id: `grant-${targets[0].id}`, kind: 'operate_terminal',
  sourceUserId: 'r', targets, text, args: {}, ...extra });
const action = (targetIds, text = 'Do the work.', extra = {}) => ({ kind: 'operate_terminal', sourceUserId: 'r',
  targetIds, text, operationMode: 'task', promptMode: 'compose', ...extra });
const planContext = (instruction, sessions, extra = {}) => ({ requestId: 'r', instruction, sessions,
  projectContext: { path: CWD, name: 'vibeTerminal' }, launchers: LAUNCHERS, projects: [{ path: CWD }, { path: OTHER }],
  roots: { projects: [CWD, OTHER] }, ...extra });
const repair = (instruction, sessions, actions, extra = {}) => {
  const context = planContext(instruction, sessions, extra);
  const grants = actions.map((item, index) => operation((item.targetIds || []).map(id => target(sessions.find(session => session.id === id))),
    item.text, { id: `grant-${index}`, ...(item.targetAvailability && { targetAvailability: item.targetAvailability }) }));
  const review = reviewExistingTargets({ grants }, context);
  return { context, review, repaired: review && repairUnselectedTargets({ goal: instruction, actions }, review, context) };
};

// ---------------------------------------------------------------------------
// 1. The target-review veto (T2.3, T2.4b, T3.1b, T3.2a, T3.3a/b, T4.1, T4.5, T4.9)
// ---------------------------------------------------------------------------

test('the repair sentence and the work-item rejection are gone from production', () => {
  const source = name => fs.readFileSync(path.join(__dirname, '..', '..', 'backend', name), 'utf8');
  const interpreter = source('orchestratorInterpreter.cjs');
  assert.equal(interpreter.includes('did not select the proposed existing conversation'), false,
    'the selection veto no longer asks the model to re-derive a fact the application holds');
  assert.equal(interpreter.includes('WORK_ITEM_REFERENCE_REJECTION'), false);
  assert.equal(interpreter.includes('workItemReferenceStands'), false);
  for (const name of ['orchestratorPlannerTools.cjs', 'orchestratorInterpreter.cjs']) {
    assert.equal(/enum: \[context\.replyWorkItem/.test(source(name)), false, `${name} offers no workItemId`);
  }
});

for (const [label, said, sessions, chosen] of [
  ['one of the empty codex terminals', SAID.idleGroup, ['free', 'free-2'], 'free-2'],
  ['one of the empty cloud code terminals', SAID.idleClaude, ['free-claude', 'free-codex'], 'free-claude'],
  ['a terminal that is not currently working', SAID.notWorking, ['free', 'busy'], 'free'],
  ['the terminal you just opened', SAID.justOpened, ['older', 'fresh'], 'fresh'],
]) test(`a worker asked for by kind reaches assignment, not a repair round: ${label}`, () => {
  const panes = sessions.map(id => id === 'busy' ? working(id) : pane(id, id.includes('claude') ? { kind: 'claude', provider: 'claude' } : {}));
  const { review, repaired } = repair(said, panes, [action([chosen], 'Investigate the orchestrator.')]);
  assert.equal(review.decision, 'ASSIGN', JSON.stringify(review));
  assert.ok(repaired, 'the unselected operation is repaired in code');
  const [only] = repaired.actions;
  assert.equal(only.kind, 'delegate_task');
  assert.equal(only.cwd, CWD);
  assert.equal(only.assignmentMode, 'auto');
  assert.equal(only.text, 'Investigate the orchestrator.');
  assert.equal(only.targetIds, undefined);
  assert.equal(only.kindOfSession, said === SAID.idleClaude ? 'claude' : 'codex');
});

// A pane described by what it is doing is checked against what it is doing: the
// one working pane, or every done pane, is confirmed from the roster; a fan-out
// the roster cannot confirm keeps the panes the plan named rather than being
// replaced with one free pane.
const finished = id => pane(id, { turnState: 'completed', turnId: `turn-${id}`, turnStartedAt: 1000, turnEndedAt: 2000 });
const awaiting = id => pane(id, { status: 'waiting', turnState: 'waiting', turnId: `turn-${id}`, turnStartedAt: 1000, attention: { reason: 'question' } });
for (const [label, said, sessions, chosen, expected] of [
  ['the Codex terminal that is currently working', SAID.busyCodex, ['busy', 'free'], ['busy'], 'DIRECT'],
  // "is waiting on something" names the pane by its state; the roster confirms
  // the one waiting pane (phase-4 ladder, T4.5) and a roster with none asks.
  ['the codex terminal in lina web app', SAID.waitingCodex, ['pdf-viewer:waiting', 'web-spare'], ['pdf-viewer'], 'DIRECT'],
  ['both terminals that are currently done', SAID.bothDone, ['full-screen:done', 'pairing:done', 'spare'], ['full-screen', 'pairing'], 'DIRECT'],
  ['both terminals that are currently done, when the roster shows none', SAID.bothDone, ['full-screen', 'pairing', 'spare'], ['full-screen', 'pairing'], 'ASSIGN'],
]) test(`a pane the sentence points at keeps the panes the plan named: ${label}`, () => {
  const panes = sessions.map(id => id === 'busy' ? working(id) : id.endsWith(':done') ? finished(id.slice(0, -5)) : id.endsWith(':waiting') ? awaiting(id.slice(0, -8)) : pane(id));
  const { review, repaired } = repair(said, panes, [action(chosen, 'Continue.')]);
  assert.equal(review.decision, expected, expected === 'DIRECT' ? 'the roster confirms the pane the sentence describes' : 'the reviewer still cannot confirm the selection');
  assert.equal(repaired, undefined, 'and the panes the plan named are kept rather than replaced with a free one');
});

test('a pane outside the addressed project is still sent to assignment', () => {
  const elsewhere = pane('gamma', { cwd: OTHER });
  const { repaired } = repair('Get a Codex terminal in vibeTerminal to fix the header.', [pane('free'), elsewhere],
    [action(['gamma'], 'Fix the header.')]);
  assert.equal(repaired.actions[0].kind, 'delegate_task');
  assert.equal(repaired.actions[0].cwd, CWD);
});

// ---------------------------------------------------------------------------
// 2. The fabricated workItemId (T1.2, T1.3, T2.2, T2.4a, T2.5, T3.5, T4.12)
// ---------------------------------------------------------------------------

test('no planning tool offers workItemId, and one supplied anyway is dropped', () => {
  const context = planContext(SAID.startCodex, [pane('free')]);
  const tools = plannerTools(context);
  for (const tool of tools) {
    assert.equal(Object.hasOwn(tool.function.parameters.properties || {}, 'workItemId'), false,
      `${tool.function.name} must not offer workItemId`);
  }
  const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
  const decoded = decodePlannerCalls([call('plan_delegate_task', { cwd: CWD, kindOfSession: 'codex', assignmentMode: 'new',
    workItemId: FABRICATED_WORK_ITEM, text: 'Investigate performance issues.' })], tools, SAID.startCodex, context);
  assert.equal(Object.hasOwn(decoded.actions[0], 'workItemId'), false, 'a guessed work item never reaches validation');
  assert.equal(decoded.actions[0].kind, 'delegate_task');
});

test('a continuation carries the work item the application itself names', () => {
  const context = planContext('Also cover expired coupons.', [pane('free')],
    { replyWorkItem: { id: 'work-1', cwd: CWD, title: 'Checkout' } });
  const tools = plannerTools(context);
  const decoded = decodePlannerCalls([{ function: { name: 'plan_continue_task',
    arguments: JSON.stringify({ cwd: CWD, text: 'Also cover expired coupons.', workItemId: FABRICATED_WORK_ITEM }) } }],
  tools, 'Also cover expired coupons.', context);
  assert.equal(decoded.actions[0].workItemId, 'work-1');
});

test('a cwd that is not a registered project falls back to the request project', () => {
  const context = planContext(SAID.startCodex, [pane('free')]);
  const plan = normalizeIntent({ goal: SAID.startCodex, actions: [{ kind: 'delegate_task', sourceUserId: 'r',
    cwd: 'C:/Users/ahmed/AppData/Local/lina-terminal-harness/profile', kindOfSession: 'codex',
    text: 'Investigate performance issues.' }] }, context);
  assert.equal(plan.grants[0].args.cwd, CWD, 'the addressed project is used rather than refusing the request');
});

test('with no project at all the request asks which project, by name', () => {
  const context = { requestId: 'r', instruction: SAID.startCodex, sessions: [], launchers: LAUNCHERS, projects: [], roots: { projects: [] } };
  assert.throws(() => normalizeIntent({ goal: SAID.startCodex, actions: [{ kind: 'delegate_task', sourceUserId: 'r',
    cwd: 'C:/nowhere', kindOfSession: 'codex', text: 'Investigate performance issues.' }] }, context),
  error => error.code === 'ORCHESTRATOR_UNKNOWN_PROJECT' && error.clarification === 'Which project should I run this in?');
});

// ---------------------------------------------------------------------------
// 4. An idle requirement with no free candidate (T2.1)
// ---------------------------------------------------------------------------

test('an availability requirement goes to assignment instead of an empty plan', () => {
  const panes = [working('busy'), working('busy-2')];
  const { repaired } = repair(SAID.idleGroup, panes, [action(['busy', 'busy-2'], 'Investigate.', { targetAvailability: 'idle', selection: 'all' })]);
  assert.equal(repaired.actions[0].kind, 'delegate_task');
  assert.equal(repaired.actions[0].targetAvailability, undefined);
});

test('the interpretation-time availability blanking is gone: the request asks instead of doing nothing', () => {
  const panes = [working('busy')];
  const context = planContext(SAID.notWorking, panes);
  assert.throws(() => normalizeIntent({ goal: SAID.notWorking, actions: [action(['busy'], 'Investigate.', { targetAvailability: 'idle' })] }, context),
    error => error.code === 'ORCHESTRATOR_LAST_TARGET_SELECTION' && /no selected terminal is currently free/i.test(error.clarification),
    'an idle requirement with nothing free is a question, never a plan with no grants in it');
});

// ---------------------------------------------------------------------------
// 5. The harmful interrupt (T4.8)
// ---------------------------------------------------------------------------

const ledgerRow = (paneId, at, outcome = 'delivered-started') => ({ requestId: `req-${paneId}`, at, verb: 'start',
  project: 'vibeTerminal', pane: { id: paneId, name: paneId, provider: 'codex' }, outcome, typedText: 'Do the work.', error: null });

test('stopping the last terminal worked on resolves to the ledger pane, not the model\u2019s', () => {
  const panes = [working('chat-section'), pane('full-screen')];
  const context = planContext(SAID.stopLast, panes,
    { ledger: [ledgerRow('full-screen', 100), ledgerRow('chat-section', 200)] });
  const plan = normalizeIntent({ goal: SAID.stopLast, actions: [{ kind: 'interrupt', sourceUserId: 'r', targetIds: ['full-screen'], selection: 'one' }] }, context);
  assert.deepEqual(plan.grants[0].targets.map(item => item.id), ['chat-section']);
});

test('two panes worked on in the same moment is a question, never both interrupts', () => {
  const panes = [working('chat-section'), pane('full-screen')];
  const context = planContext(SAID.stopLast, panes,
    { ledger: [ledgerRow('full-screen', 200), ledgerRow('chat-section', 200)] });
  assert.throws(() => normalizeIntent({ goal: SAID.stopLast, actions: [{ kind: 'interrupt', sourceUserId: 'r', targetIds: ['full-screen'], selection: 'one' }] }, context),
    error => error.code === 'ORCHESTRATOR_LAST_TARGET_SELECTION' && /which terminal should i stop/i.test(error.clarification));
});

test('a stop request that names no group cannot fan out across panes', () => {
  const panes = [working('chat-section'), working('full-screen')];
  const context = planContext('Can you stop the terminal?', panes, { ledger: [] });
  assert.throws(() => normalizeIntent({ goal: 'stop', actions: [{ kind: 'interrupt', sourceUserId: 'r',
    targetIds: ['chat-section', 'full-screen'], selection: 'all' }] }, context),
  error => error.code === 'ORCHESTRATOR_LAST_TARGET_SELECTION');
  const both = normalizeIntent({ goal: 'stop', actions: [{ kind: 'interrupt', sourceUserId: 'r',
    targetIds: ['chat-section', 'full-screen'], selection: 'all' }] }, planContext('Stop both terminals.', panes, { ledger: [] }));
  assert.deepEqual(both.grants[0].targets.map(item => item.id), ['chat-section', 'full-screen']);
});

// ---------------------------------------------------------------------------
// The whole compiler, counted. Every request below used to cost a second
// interpretation round (and T1.5 a third call of its own); each one now costs
// exactly one, and settles as an effect rather than a refusal.
// ---------------------------------------------------------------------------

const MODEL = { id: 'brain', contextLength: 128000, supportedParameters: ['tools', 'tool_choice'], maxCompletionTokens: 8000 };
const toolReply = (...calls) => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: calls.map((item, index) =>
  ({ id: `call-${index}`, type: 'function', function: { name: item[0], arguments: JSON.stringify(item[1]) } })) } }] });
function compiler(responses) {
  const bodies = [];
  const complete = async body => { bodies.push(body); const next = responses.shift();
    assert.ok(next, `unscripted model call: ${JSON.stringify(String(body.messages[0].content).slice(0, 80))}`); return next; };
  const interpret = createIntentInterpreter({ complete, redact: value => value, getTask: () => undefined,
    cleanError: error => String(error?.message ?? error), recordDiagnostic() {}, diagnosticError() {} });
  return { bodies, run: context => interpret(context, MODEL, 2000, new AbortController().signal, {}) };
}

test('an idle-group request compiles to assignment in one model call (T2.1)', async () => {
  const panes = [pane('free'), working('busy'), pane('free-2')];
  // The panes reach the Brain by handle: free, busy, free-2 are T1, T2, T3.
  const compile = compiler([toolReply(['plan_operate_terminal', { sourceUserId: 'r', handles: ['T3'],
    text: 'Investigate the read-aloud behaviour.', operationMode: 'task', promptMode: 'compose' }])]);
  const plan = await compile.run(planContext(SAID.idleGroup, panes));
  assert.equal(compile.bodies.length, 1, 'no repair round and no review call');
  assert.deepEqual(plan.grants.map(grant => grant.kind), ['delegate_task']);
  assert.equal(plan.grants[0].args.assignmentMode, 'auto');
  assert.equal(plan.clarification, undefined);
});

test('a plain open runs no purpose review and asks the user nothing (T1.5)', async () => {
  const compile = compiler([toolReply(['plan_open_blank_terminal', { cwd: CWD, kindOfSession: 'codex' }])]);
  const plan = await compile.run(planContext(SAID.openCodex, [pane('free')]));
  assert.equal(compile.bodies.length, 1, 'the creation purpose is decided in code');
  assert.deepEqual(plan.grants.map(grant => grant.kind), ['create_session']);
  assert.equal(plan.clarification, undefined, 'the sentence already said the pane holds no task');
});

// The one genuinely ambiguous case keeps its review: a draft that carries text
// may be meant to stay unsent, and only the sentence can say which.
test('a draft that carries text is still reviewed before it is left unsent', async () => {
  const said = "Open a codex terminal and put a draft in it to investigate performance issues, but don't send it.";
  const compile = compiler([toolReply(['plan_prepare_terminal_draft', { cwd: CWD, kindOfSession: 'codex', text: 'Investigate performance issues.' }]),
    { choices: [{ finish_reason: 'stop', message: { content: 'DRAFT' } }] }]);
  const plan = await compile.run(planContext(said, [pane('free')]));
  assert.equal(compile.bodies.length, 2, 'the draft review is the one purpose call that remains');
  assert.deepEqual(plan.grants.map(grant => grant.kind), ['create_session']);
  assert.equal(plan.grants[0].text, 'Investigate performance issues.');
});

test('an open that hands the pane work is executed, not drafted (T1.2)', async () => {
  const compile = compiler([toolReply(['plan_delegate_task', { sourceUserId: 'r', cwd: CWD, kindOfSession: 'codex',
    assignmentMode: 'new', text: 'Investigate performance issues.' }])]);
  const plan = await compile.run(planContext(SAID.startCodex, [pane('free')]));
  assert.equal(compile.bodies.length, 1);
  assert.deepEqual(plan.grants.map(grant => grant.kind), ['delegate_task']);
});

test('a fabricated work item costs no repair round (T1.2, T2.2, T2.5)', async () => {
  const compile = compiler([toolReply(['plan_delegate_task', { sourceUserId: 'r', cwd: CWD, kindOfSession: 'codex',
    assignmentMode: 'new', workItemId: FABRICATED_WORK_ITEM, text: 'Investigate performance issues.' }])]);
  const plan = await compile.run(planContext(SAID.startCodex, [pane('free')]));
  assert.equal(compile.bodies.length, 1);
  assert.equal(plan.grants[0].args.workItemId, undefined);
  assert.equal(plan.grants[0].args.assignmentMode, 'new');
});

test('a pronoun follow-up with a blank continuation is a new request, not a failure (T4.7)', async () => {
  const compile = compiler([toolReply(['interpret_workspace', { responseKind: 'task-status', statusHandles: [],
    statusRequestId: 'r', afterResults: { instruction: '' }, dependsOnRequestIds: [], access: 'mutation',
    executionMode: 'reason', goal: 'Clarify which terminal the user means.',
    clarification: 'Which terminal do you mean by the other one, and what should I send it?', continuationOf: '' }])]);
  const plan = await compile.run(planContext(SAID.otherOne, [pane('free'), pane('free-2')]));
  assert.equal(compile.bodies.length, 1, 'an empty continuation claim is dropped rather than repaired');
  assert.equal(plan.continuationOf, undefined);
  assert.equal(plan.responseKind, undefined);
  assert.match(plan.clarification, /the other one/);
});

// ---------------------------------------------------------------------------
// 7. What the user reads when interpretation still fails
// ---------------------------------------------------------------------------

test('a failure says what was missing in catalogue words', () => {
  assert.equal(missingInformationSentence('Task routing requires one identified known project.'),
    "I couldn't tell which project this belongs to, so nothing was started. Tell me the project and I'll run it there.");
  assert.equal(missingInformationSentence('Identify one available native terminal.'),
    "I couldn't tell which terminal you meant, so nothing was typed. Name it or select its pane.");
  assert.equal(missingInformationSentence('The user must supply the answer.'),
    "I don't have the answer that terminal is waiting for, so nothing was typed. Tell me what to say and I'll pass it on.");
  const text = interpretationFailureText('I could not interpret that request. Please try again.',
    'Task routing requires one identified known project.');
  assert.equal(text.includes('Reason:'), false, 'the validator sentence stays in the diagnostics record');
  assert.ok(text.includes('Tell me the project'));
});

// ---------------------------------------------------------------------------
// 8. A Brain that answers in prose, and two roster facts (T3.4, T4.4, T4.8, T4.9, T4.13, T4.14)
// ---------------------------------------------------------------------------

test('prose that tells the user something is the reply; prose that asks is a clarification', async () => {
  const statement = compiler([{ choices: [{ finish_reason: 'stop', message: { content: 'No problem.' } }] }]);
  const plan = await statement.run(planContext('Hey, bye. Never mind.', [pane('free')]));
  assert.equal(statement.bodies.length, 1, 'no repair round');
  assert.equal(plan.reply, 'No problem.'); assert.equal(plan.clarification, undefined); assert.equal(plan.grants.length, 0);
  const question = compiler([{ choices: [{ finish_reason: 'stop', message: { content: 'The project has five inactive terminals. Which three do you mean?' } }] }]);
  const asked = await question.run(planContext('No, close the three that are inactive.', [pane('free')]));
  assert.match(asked.clarification, /which three/i); assert.equal(asked.reply, undefined);
});

test('the last terminal worked on is read from the full recent ledger, not the planning window', () => {
  const panes = [working('chat-section'), pane('full-screen')];
  const context = planContext(SAID.stopLast, panes, { ledger: [], ledgerRows: [ledgerRow('full-screen', 100), ledgerRow('chat-section', 200)] });
  const plan = normalizeIntent({ goal: SAID.stopLast, actions: [{ kind: 'interrupt', sourceUserId: 'r', targetIds: ['full-screen'], selection: 'one' }] }, context);
  assert.deepEqual(plan.grants[0].targets.map(item => item.id), ['chat-section']);
});

// Added 2026-09-15: on two ladder runs the Brain planned "stop that last
// terminal you worked on" as a typed "Stop this terminal." into the pane most
// recently talked about, and as a close of three panes. Either way the sentence
// is an interrupt, and the ledger names the pane.
test('a stop of the last worked pane is an interrupt of the ledger pane, however the plan was shaped (T4.8)', () => {
  const panes = [working('chat-section'), pane('full-screen'), pane('spare')];
  const context = planContext(SAID.stopLast, panes, { ledger: [], ledgerRows: [ledgerRow('full-screen', 100), ledgerRow('chat-section', 200)] });
  const typed = normalizeIntent({ goal: SAID.stopLast, actions: [{ kind: 'operate_terminal', sourceUserId: 'r', targetIds: ['full-screen'],
    text: 'Stop this terminal.', operationMode: 'interaction', lifecycleMode: 'interrupt' }] }, context);
  assert.equal(typed.grants[0].kind, 'interrupt'); assert.deepEqual(typed.grants[0].targets.map(item => item.id), ['chat-section']);
  const closed = normalizeIntent({ goal: SAID.stopLast, actions: [{ kind: 'close', sourceUserId: 'r', scope: { type: 'explicit', targetIds: ['full-screen', 'spare', 'chat-section'] } }] }, context);
  assert.equal(closed.grants[0].kind, 'interrupt'); assert.deepEqual(closed.grants[0].targets.map(item => item.id), ['chat-section']);
  // A sentence that closes, quits or kills is not an interrupt.
  const kept = normalizeIntent({ goal: 'kill the last terminal you worked on', actions: [{ kind: 'operate_terminal', sourceUserId: 'r', targetIds: ['chat-section'],
    text: 'Stop.', operationMode: 'interaction', lifecycleMode: 'exit' }] }, planContext('kill the last terminal you worked on', panes, { ledger: [], ledgerRows: [ledgerRow('chat-section', 200)] }));
  assert.equal(kept.grants[0].kind, 'operate_terminal');
});

// Added 2026-09-15: "prompt the other one as well" is the pane other than the
// one Lina last used when exactly one such pane exists; with several, the
// plan's guess is not accepted — it went into an idle pane, queued behind the
// project's work for the whole request, and skewed the next three turns.
test('"the other one" is direct only when exactly one other pane exists; a guess among several is assignment\'s question (T4.7)', () => {
  const ledger = { ledger: [], ledgerRows: [ledgerRow('chat-section', 200)] };
  const one = repair('Prompt the other one as well.', [working('chat-section'), pane('spare')], [{ targetIds: ['spare'], text: 'Continue.' }], ledger);
  assert.equal(one.review.operations[0].decision, 'DIRECT'); assert.equal(one.review.operations[0].basis, 'other');
  const guess = repair('Prompt the other one as well.', [working('chat-section'), pane('spare'), pane('spare-2')], [{ targetIds: ['spare'], text: 'Continue.' }], ledger);
  assert.equal(guess.review.operations[0].decision, 'ASSIGN'); assert.equal(guess.review.operations[0].basis, 'selector-other');
  assert.ok(guess.repaired, 'the guess is handed to assignment, which asks');
  // Right after a question or an answer the delivery is no longer the latest
  // thing in the ledger, so there is no "one" to be other than: a question.
  const stale = { ledger: [], ledgerRows: [ledgerRow('chat-section', 200), { requestId: 'q', at: 300, verb: 'ask', outcome: 'answered', project: 'vibeTerminal' }] };
  const after = repair('Prompt the other one as well.', [working('chat-section'), pane('spare')], [{ targetIds: ['spare'], text: 'Continue.' }], stale);
  assert.equal(after.review.operations[0].decision, 'ASSIGN'); assert.equal(after.review.operations[0].basis, 'selector-other');
});

test('a fan-out over done panes makes done panes in other projects eligible for the roster (T4.9)', () => {
  const done = (id, cwd) => pane(id, { cwd, turnState: 'completed', turnId: `turn-${id}`, turnStartedAt: 1000, turnEndedAt: 2000 });
  const sessions = [done('full-screen', CWD), done('pairing', OTHER), pane('spare')];
  const eligible = eligibleExistingTargets(planContext(SAID.bothDone, sessions));
  assert.ok(eligible.includes('pairing') && eligible.includes('full-screen') && !eligible.includes('spare'), JSON.stringify(eligible));
});
