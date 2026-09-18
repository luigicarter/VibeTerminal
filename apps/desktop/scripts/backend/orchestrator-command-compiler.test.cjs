'use strict';
// The compiler's contract, measured against the saved utterance corpus.
//
// Precision is the only hard number: every row the compiler accepts must
// produce the plan the corpus says that sentence means, and must be a row a
// strict compiler was expected to take. Recall is reported rather than chased -
// the corpus is raw speech, and most of it genuinely needs the brain - but it
// may not fall below half of the rows marked compilable.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { compileCommand, createCommandInterpreter, COMPILER_REASONS, SHAPES } = require('../../backend/orchestratorCommandCompiler.cjs');
const { plannerTools, decodePlannerCalls } = require('../../backend/orchestratorPlannerTools.cjs');
// Whether the work wants a fresh pane is read off the sentence when the call is
// decoded, for a compiled call exactly as for one the Brain returns.
const decoded = (context, compiled) => decodePlannerCalls(compiled.calls, plannerTools(context), context.instruction, context);
const { createIntentInterpreter } = require('../../backend/orchestratorInterpreter.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { normalizeInstruction } = require('../../backend/orchestratorVocabulary.cjs');
const { identifyProject } = require('../../backend/orchestratorPolicy.cjs');

const CORPUS = require('./fixtures/orchestrator-utterances.json');
// The projects and launchers the saved corpus was spoken into. "Lunar Terminal"
// is deliberately absent: row 115 asks for a project that was never registered.
const PROJECTS = ['vibeTerminal', 'Ternary model dev', 'lina web app', 'lina mobile']
  .map(name => ({ name, path: path.win32.join('C:/Projects', name.replace(/\s+/g, '-')) }));
const LAUNCHERS = [['codex', 'Codex'], ['claude', 'Claude Code'], ['codex-web', 'Codex Web'],
  ['open-codex', 'Open Codex'], ['gemini', 'Gemini']].map(([kind, label]) => ({ kind, label, available: true, configured: true }));
// The compiled shape, in the corpus's own verb vocabulary.
const VERB_OF_SHAPE = { open: 'open', start: 'start', follow_up: 'follow_up', status: 'status', results: 'results', stop: 'interrupt', close: 'close' };

// The project view a request can be submitted from. It is deliberately not the
// project most corpus rows name, so a named project winning over the addressed
// workspace is visible in the result rather than assumed.
const WORKSPACE = PROJECTS[3];
function corpusContext(row, extra = {}) {
  const instruction = normalizeInstruction(row.text, { projects: PROJECTS, launchers: LAUNCHERS }).text;
  return { instruction, requestId: `corpus-${row.n}`, sessions: [], projects: PROJECTS, roots: { projects: PROJECTS },
    launchers: LAUNCHERS, projectContext: identifyProject(instruction, PROJECTS, null), ...extra };
}
const inWorkspace = { workspaceContext: { ok: true, view: 'project', cwd: WORKSPACE.path } };
const compiledFor = (row, extra) => compileCommand(corpusContext(row, extra));

test('every corpus row carries an expected plan and a stated reason', () => {
  assert.equal(CORPUS.length, 131);
  assert.deepEqual(Object.keys(VERB_OF_SHAPE), [...SHAPES], 'every compiled shape has a corpus verb');
  for (const row of CORPUS) {
    assert.ok(row.expected, `row ${row.n} has no expected plan`);
    for (const key of ['verb', 'project', 'selector', 'provider', 'promptPresent', 'compilable']) {
      assert.ok(Object.hasOwn(row.expected, key), `row ${row.n} expected.${key}`);
    }
    assert.equal(typeof row.expected.compilable, 'boolean');
    assert.equal(typeof row.expected.compilableInWorkspace, 'boolean');
    assert.equal(typeof row.expected.promptPresent, 'boolean');
    assert.ok(String(row.expected.reason || '').length >= 8, `row ${row.n} states why`);
    assert.ok(!row.expected.compilable || row.expected.compilableInWorkspace,
      `row ${row.n} cannot be compilable without a workspace and not with one`);
  }
});

// Precision in both modes: a request submitted with no project view, and the
// same request submitted from a project. `expected.project` is what the
// sentence itself names; a sentence that names none takes the addressed
// workspace, which is what `compilableInWorkspace` marks.
function precision(mode, extra, field) {
  const accepted = [];
  for (const row of CORPUS) {
    const result = compiledFor(row, extra);
    if (!result.accepted) {
      assert.ok(COMPILER_REASONS.includes(result.reason), `row ${row.n} declined with an unlisted reason ${result.reason}`);
      continue;
    }
    accepted.push(row.n);
    assert.equal(row.expected[field], true, `${mode}: row ${row.n} was accepted but is not a compilable sentence: ${row.text}`);
    assert.equal(VERB_OF_SHAPE[result.shape], row.expected.verb, `${mode}: row ${row.n} verb`);
    assert.equal(result.project, row.expected.project ?? (extra ? WORKSPACE.name : null), `${mode}: row ${row.n} project`);
    assert.equal(result.provider, row.expected.provider, `${mode}: row ${row.n} provider`);
    assert.equal(result.promptPresent, row.expected.promptPresent, `${mode}: row ${row.n} prompt presence`);
    assert.ok(result.confidence >= 0.9, `${mode}: row ${row.n} confidence ${result.confidence}`);
  }
  return accepted;
}

test('precision: every accepted row compiles to the plan the corpus says it means', () => {
  const accepted = precision('no workspace', undefined, 'compilable');
  console.log(`compiler precision: ${accepted.length} of ${accepted.length} accepted rows match the corpus (rows ${accepted.join(', ')})`);
});

test('precision holds when the request is submitted from a project view', () => {
  const accepted = precision('workspace', inWorkspace, 'compilableInWorkspace');
  console.log(`compiler precision in a ${WORKSPACE.name} workspace: ${accepted.length} of ${accepted.length} accepted rows match (rows ${accepted.join(', ')})`);
});

test('recall: at least half the compilable rows are compiled, and the misses are named', () => {
  for (const [mode, extra, field] of [['no workspace', undefined, 'compilable'], ['workspace', inWorkspace, 'compilableInWorkspace']]) {
    const compilable = CORPUS.filter(row => row.expected[field]);
    const missed = compilable.filter(row => !compiledFor(row, extra).accepted)
      .map(row => `${row.n} (${compiledFor(row, extra).reason})`);
    const recall = (compilable.length - missed.length) / compilable.length;
    console.log(`compiler recall (${mode}): ${(recall * 100).toFixed(1)}% of ${compilable.length} compilable rows${missed.length ? `; missed ${missed.join(', ')}` : '; no misses'}`);
    assert.ok(recall >= 0.5, `${mode}: recall ${recall} is below half`);
  }
});

// ---------------------------------------------------------------------------
// The refusals. Each of these is a sentence whose cost of being wrong is higher
// than one ordinary interpretation, so the brain takes it.
// ---------------------------------------------------------------------------
const PANES = [
  { id: 'pane-checkout', generation: 'g1', launchToken: 1, name: 'Fix checkout validation', conversationTitle: 'Fix checkout validation',
    kind: 'codex', provider: 'codex', cwd: PROJECTS[0].path, started: true, status: 'idle', observation: 'observed',
    processState: 'running', agentProcessState: 'running', agentPid: 4242, turnState: 'idle', revision: 1, lastActivityAt: 2000 },
  { id: 'pane-docs', generation: 'g1', launchToken: 1, name: 'Update deployment documentation', conversationTitle: 'Update deployment documentation',
    kind: 'codex', provider: 'codex', cwd: PROJECTS[0].path, started: true, status: 'idle', observation: 'observed',
    processState: 'running', agentProcessState: 'running', agentPid: 4243, turnState: 'idle', revision: 1, lastActivityAt: 1000 },
];
const sentenceContext = (instruction, extra = {}) => ({ instruction, requestId: 'unit', sessions: PANES, projects: PROJECTS,
  roots: { projects: PROJECTS }, launchers: LAUNCHERS, projectContext: PROJECTS[0], ...extra });

test('destructive, ambiguous and incomplete sentences are declined with a stated reason', () => {
  const cases = [
    // Two Codex panes: "the Codex terminal" points at neither, so nothing is
    // stopped or closed; a group close, a cancellation and an answer stay the
    // Brain's whatever the roster holds.
    ['close the Codex terminal in vibeTerminal', 'ambiguous-pane'],
    ['interrupt the Codex terminal in vibeTerminal', 'ambiguous-pane'],
    ['answer yes in the Codex terminal in vibeTerminal', 'blocked-verb'],
    ['close all the terminals in vibeTerminal', 'blocked-verb'],
    ['close the terminals in vibeTerminal that are not working', 'blocked-verb'],
    ['never mind, close the Codex terminal', 'blocked-verb'],
    ['tell the Codex terminal that is currently working in vibeTerminal to fix the login page', 'ambiguous-pane'],
    ['open a new Codex terminal in vibeTerminal and then close it', 'second-command'],
    ['open a new Codex terminal in Lunar Terminal', 'unknown-project'],
    ['open a new Codex terminal in vibeTerminal and in lina mobile', 'ambiguous-project'],
    ['open a new Qwen terminal in vibeTerminal', 'unknown-provider'],
    ['prompt a Codex terminal in vibeTerminal to fix it', 'short-task'],
    ['open seven Codex terminals in vibeTerminal', 'too-many'],
    ['tell the agent working on the checkout to continue the work', 'ambiguous-pane'],
  ];
  for (const [instruction, reason] of cases) {
    const result = compileCommand(sentenceContext(instruction));
    assert.equal(result.accepted, false, `${instruction} must not compile`);
    assert.equal(result.reason, reason, instruction);
  }
});

// Stopping, closing and following up on the one pane a sentence points at
// exactly used to be blocked outright, so every "stop that last terminal" and
// "tell it to…" took a model round. The reference resolver names the pane or
// the sentence is declined; nothing here lets a model choose which pane to stop.
test('stop, close and follow-up compile over an exact reference and are declined without one', () => {
  const working = { ...PANES[0], id: 'pane-busy', name: 'Investigate ram growth', conversationTitle: 'Investigate ram growth', status: 'running', turnState: 'running', turnId: 't-busy', turnStartedAt: 3000, lastActivityAt: 3000 };
  const sessions = [PANES[0], PANES[1], working];
  const ledgerRows = [{ requestId: 'r1', at: 100, verb: 'start', outcome: 'delivered-started', pane: { id: 'pane-docs' } }];
  const withPanes = (instruction, extra = {}) => compileCommand(sentenceContext(instruction, { sessions, ledgerRows, ...extra }));
  const args = result => JSON.parse(result.calls[0].function.arguments);
  // Handles are transient in a directly built context: pane-checkout T1, pane-docs T2, pane-busy T3.
  const stopLast = withPanes('can you stop that last terminal you worked on?');
  assert.deepEqual([stopLast.accepted, stopLast.shape, stopLast.selector, stopLast.calls[0].function.name, args(stopLast)], [true, 'stop', 'last_target', 'plan_interrupt', { handles: ['T2'] }], JSON.stringify(stopLast));
  const stopHandle = withPanes('stop T3');
  assert.deepEqual([stopHandle.shape, args(stopHandle).handles, stopHandle.targetIds], ['stop', ['T3'], ['pane-busy']]);
  const stopWorking = withPanes("interrupt the terminal that's currently working");
  assert.deepEqual([stopWorking.shape, args(stopWorking).handles], ['stop', ['T3']]);
  const closeOther = withPanes('close the other one');
  assert.equal(closeOther.accepted, false, 'two panes are other than the last one: a question, not a close');
  const closeHandle = withPanes('close T1');
  assert.deepEqual([closeHandle.shape, args(closeHandle)], ['close', { scope: { type: 'explicit', handles: ['T1'] } }]);
  const followHandle = withPanes('tell T3 to also cover the heap profile');
  assert.deepEqual([followHandle.shape, followHandle.selector, followHandle.calls[0].function.name, args(followHandle)],
    ['follow_up', 'handle', 'plan_operate_terminal', { handles: ['T3'], text: 'Also cover the heap profile.', operationMode: 'task', promptMode: 'compose' }]);
  const followIt = withPanes('tell it to write that up in the docs folder');
  assert.deepEqual([followIt.shape, followIt.selector, args(followIt).handles], ['follow_up', 'none', ['T2']], '"it" is the pane Lina last typed into');
  const followWorking = withPanes("ask the terminal that's currently working to summarise its findings so far");
  assert.deepEqual([followWorking.shape, args(followWorking).handles], ['follow_up', ['T3']]);
  // Without the facts the reference needs, none of these compile.
  for (const [instruction, reason] of [['stop that last terminal you worked on', 'ambiguous-pane'], ['tell it to write that up in the docs folder', 'ambiguous-pane'],
    ['stop T9', 'ambiguous-pane'], ['stop both terminals that are working', 'ambiguous-pane']]) {
    assert.equal(compileCommand(sentenceContext(instruction, { sessions: [PANES[0], PANES[1]] })).reason, reason, instruction);
  }
  // A fan-out stop over one state names every pane in it.
  const stopBoth = withPanes('stop both terminals that are working', { sessions: [PANES[0], working, { ...working, id: 'pane-busy-2', turnId: 't-2' }] });
  assert.deepEqual(args(stopBoth).handles, ['T2', 'T3']);
});

test('a sentence whose authority is somewhere other than its own words is never compiled', () => {
  const instruction = 'open a new Codex terminal in vibeTerminal';
  assert.equal(compileCommand(sentenceContext(instruction)).accepted, true);
  for (const extra of [{ targetId: 'pane-checkout' }, { replyWorkItem: { id: 'work-1' } },
    { interactionContext: { id: 'request-1' } }, { dependencyResults: [{ requestId: 'earlier' }] },
    { authorizedRelay: { target: { id: 'pane-checkout' } } }, { originalInstruction: 'the sentence before' },
    { replyContext: { question: { id: 'q1', text: 'Which one?' } } }]) {
    assert.deepEqual(compileCommand(sentenceContext(instruction, extra)), { accepted: false, reason: 'context-dependent' }, JSON.stringify(extra));
  }
});

// The September 14 completion ladder declined 33 of 35 turns `context-dependent`
// because one unfinished command from any earlier request stopped every later
// sentence compiling. A pending command now stops only the sentences that point
// back at it.
const AFTER_A_PRIOR_REQUEST = [{ previousCommand: { requestId: 'earlier', instruction: 'open a Codex terminal', grants: [] } },
  { pendingCommands: [{ requestId: 'earlier', grants: [] }] },
  { previousCommand: { requestId: 'earlier', grants: [] }, pendingCommands: [{ requestId: 'earlier', grants: [] }] }];

test('an unfinished command from an earlier request no longer stops a fresh sentence compiling', () => {
  const instruction = 'open a new Codex terminal in vibeTerminal';
  for (const extra of AFTER_A_PRIOR_REQUEST) {
    const result = compileCommand(sentenceContext(instruction, extra));
    assert.equal(result.accepted, true, `${JSON.stringify(extra)} declined ${result.reason}`);
    assert.equal(result.provider, 'codex');
  }
});

test('a sentence that points back at the previous turn is still declined while a command is pending', () => {
  for (const instruction of ['tell the other terminal to review the release notes',
    'tell the same terminal to review the release notes',
    'tell the previous agent to review the release notes']) {
    assert.deepEqual(compileCommand(sentenceContext(instruction, AFTER_A_PRIOR_REQUEST[0])),
      { accepted: false, reason: 'context-dependent' }, instruction);
    // With nothing pending the same sentence is refused for its own reason, so
    // the pending command is what this rule is reading, not the words alone.
    assert.equal(compileCommand(sentenceContext(instruction)).reason, 'ambiguous-pane', instruction);
  }
  // A pane named by its work still compiles while a command is pending.
  const named = compileCommand(sentenceContext('tell the checkout validation terminal to review the release notes', AFTER_A_PRIOR_REQUEST[0]));
  assert.equal(named.accepted, true, named.reason);
  assert.equal(named.targetId, 'pane-checkout');
});

// The rows the corpus marks compilable, replayed as the SECOND turn of a
// session: the compiler must reach the same plan it reaches on the first.
test('every compilable corpus row still compiles as a later turn of a session', () => {
  for (const [mode, extra, field] of [['no workspace', undefined, 'compilable'], ['workspace', inWorkspace, 'compilableInWorkspace']]) {
    for (const row of CORPUS.filter(item => item.expected[field])) {
      const first = compiledFor(row, extra);
      if (!first.accepted) continue;
      for (const pending of AFTER_A_PRIOR_REQUEST) {
        const later = compiledFor(row, { ...extra, ...pending });
        assert.equal(later.accepted, true, `${mode}: row ${row.n} declined ${later.reason} as a later turn`);
        assert.deepEqual({ shape: later.shape, project: later.project, provider: later.provider, promptPresent: later.promptPresent },
          { shape: first.shape, project: first.project, provider: first.provider, promptPresent: first.promptPresent },
          `${mode}: row ${row.n} compiled differently as a later turn`);
      }
    }
  }
});

test('the supported shapes compile to the planner calls the brain would have returned', () => {
  const open = compileCommand(sentenceContext('open a new Codex terminal in vibeTerminal'));
  assert.deepEqual(open.calls.map(item => item.function.name), ['interpret_workspace', 'plan_open_blank_terminal']);
  assert.deepEqual(JSON.parse(open.calls[1].function.arguments), { cwd: PROJECTS[0].path, kindOfSession: 'codex' });
  assert.equal(JSON.parse(open.calls[0].function.arguments).executionMode, 'direct');

  const several = compileCommand(sentenceContext('open three Codex terminals in vibeTerminal'));
  assert.equal(several.calls.filter(item => item.function.name === 'plan_open_blank_terminal').length, 3);

  const start = compileCommand(sentenceContext('have a Codex terminal in vibeTerminal fix the login page that is not working right'));
  assert.deepEqual(start.calls.map(item => item.function.name), ['plan_delegate_task']);
  assert.deepEqual(JSON.parse(start.calls[0].function.arguments),
    { cwd: PROJECTS[0].path, kindOfSession: 'codex', text: 'Fix the login page that is not working right.' });

  const freshContext = sentenceContext('open another Codex terminal in vibeTerminal and have it review the release notes');
  const fresh = compileCommand(freshContext);
  assert.equal(JSON.parse(fresh.calls[0].function.arguments).assignmentMode, undefined, 'the compiled call carries no assignment mode');
  assert.equal(decoded(freshContext, fresh).actions[0].assignmentMode, 'new');

  const follow = compileCommand(sentenceContext('tell the agent working on the checkout validation to also cover expired coupons'));
  assert.deepEqual(follow.calls.map(item => item.function.name), ['plan_continue_task']);
  assert.equal(follow.targetId, 'pane-checkout');
  assert.deepEqual(JSON.parse(follow.calls[0].function.arguments), { cwd: PROJECTS[0].path, text: 'Also cover expired coupons.' });

  const status = compileCommand(sentenceContext('what is the checkout validation agent doing'));
  assert.deepEqual(status.calls.map(item => item.function.name), ['plan_conversation']);
});

test('a sentence that names no project takes the project view it was submitted from', () => {
  for (const instruction of ['can you start a Codex terminal and have it investigate the performance issues',
    'Can you open a Codex terminal for me?', 'Can you open a new Codex terminal?']) {
    // With no project view and nothing identified, there is no project to use.
    assert.deepEqual(compileCommand(sentenceContext(instruction, { projectContext: null })),
      { accepted: false, reason: 'unknown-project' }, instruction);
    const result = compileCommand(sentenceContext(instruction, { projectContext: null,
      workspaceContext: { ok: true, view: 'project', cwd: PROJECTS[3].path } }));
    assert.equal(result.accepted, true, instruction);
    assert.equal(result.project, PROJECTS[3].name, instruction);
    assert.equal(result.confidence, 0.92, instruction);
  }
  // A project named outside the slot is never silently replaced by the view.
  assert.deepEqual(compileCommand(sentenceContext('open a Codex terminal and have it look at the vibeTerminal docs',
    { projectContext: null, workspaceContext: { ok: true, view: 'project', cwd: PROJECTS[3].path } })),
    { accepted: false, reason: 'unknown-project' });
  // A view that is not a project, or one that is not a registered project.
  for (const workspaceContext of [{ ok: true, view: 'dashboard', cwd: PROJECTS[3].path }, { ok: true, view: 'project', cwd: 'C:/elsewhere' }]) {
    assert.deepEqual(compileCommand(sentenceContext('Can you open a new Codex terminal?', { projectContext: null, workspaceContext })),
      { accepted: false, reason: 'unknown-project' }, JSON.stringify(workspaceContext));
  }
  // One implicit slot is affordable; an implicit project and an implicit
  // provider in the same sentence is not.
  assert.deepEqual(compileCommand(sentenceContext('Can you open a new terminal?', { projectContext: null,
    workspaceContext: { ok: true, view: 'project', cwd: PROJECTS[3].path },
    memory: { project: { project: 'lina mobile', defaultProvider: 'codex' } } })), { accepted: false, reason: 'low-confidence' });
});

test('the put-in idiom is a start, and pointing at an earlier turn is not', () => {
  for (const instruction of ['put in another Codex terminal in vibeTerminal to identify a bug in the wake phrase',
    'put in a Codex terminal in vibeTerminal and have it identify a bug in the wake phrase',
    'put a Codex terminal in vibeTerminal and prompt it to identify a bug in the wake phrase']) {
    const result = compileCommand(sentenceContext(instruction));
    assert.equal(result.accepted, true, instruction);
    assert.equal(result.shape, 'start', instruction);
    assert.equal(JSON.parse(result.calls[0].function.arguments).text, 'Identify a bug in the wake phrase.', instruction);
  }
  const anotherContext = sentenceContext('put in another Codex terminal in vibeTerminal to identify a bug in the wake phrase');
  assert.equal(decoded(anotherContext, compileCommand(anotherContext)).actions[0].assignmentMode, 'new');
  // The object named from an earlier turn, and work named from one, are both
  // memory or redo requests: the words to send are not in this sentence.
  for (const [instruction, reason] of [
    ['put in that prompt in the Codex terminal in vibeTerminal', 'unknown-provider'],
    ['put it in a Codex terminal in vibeTerminal to review the release notes', 'unknown-provider'],
    ['put a Codex terminal in vibeTerminal to make this change', 'short-task'],
    ['prompt a Codex terminal in vibeTerminal to do that again', 'short-task'],
    ['prompt a Codex terminal in vibeTerminal to that checkout validation follow-up', 'context-dependent'],
  ]) {
    const result = compileCommand(sentenceContext(instruction));
    assert.equal(result.accepted, false, instruction);
    assert.equal(result.reason, reason, instruction);
  }
});

test('the project the user points at is the one the request path already identified', () => {
  for (const instruction of ['open a new Codex terminal in this project', 'open a Codex terminal here',
    'prompt a Codex terminal in this project to review the release notes']) {
    const result = compileCommand(sentenceContext(instruction));
    assert.equal(result.accepted, true, instruction);
    assert.equal(result.project, 'vibeTerminal', instruction);
  }
  // With nothing identified and no workspace, "here" names nothing.
  assert.deepEqual(compileCommand(sentenceContext('open a Codex terminal here', { projectContext: null })),
    { accepted: false, reason: 'unknown-project' });
  assert.equal(compileCommand(sentenceContext('open a Codex terminal here',
    { projectContext: null, workspaceContext: { cwd: PROJECTS[0].path } })).project, 'vibeTerminal');
});

// The spoken-launcher rule, read once in orchestratorReference.cjs and no
// longer second-guessed here: bare "open codex" is the verb plus the provider
// Codex; a determiner in front of the launcher's own name selects the launcher.
// The compiler used to decline every one of these `unknown-provider` through an
// ambiguity table of its own (corpus row 77).
test('a bare "Open Codex terminal" compiles to Codex, and a determiner selects the Open Codex launcher', () => {
  for (const [instruction, provider] of [
    ['Open Codex terminal in vibeTerminal', 'codex'],
    ['open a codex terminal in vibeTerminal', 'codex'],
    ['open an Open Codex terminal in vibeTerminal', 'open-codex'],
    ['open another Open Codex terminal in vibeTerminal', 'open-codex'],
    // The verb slot is already spent, so the second "open" is the launcher's
    // own first word. Corpus row 77 has no verb before it and stays Codex.
    ['open open codex terminal in vibeTerminal', 'open-codex'],
  ]) {
    const result = compileCommand(sentenceContext(instruction));
    assert.equal(result.accepted, true, `${instruction} declined ${result.reason}`);
    assert.equal(result.shape, 'open', instruction);
    assert.equal(result.provider, provider, instruction);
    assert.equal(JSON.parse(result.calls.at(-1).function.arguments).kindOfSession, provider, instruction);
  }
});

test('an unnamed provider falls back to what the project has been using, and to nothing else', () => {
  const instruction = 'open a new terminal in vibeTerminal';
  assert.deepEqual(compileCommand(sentenceContext(instruction)), { accepted: false, reason: 'unknown-provider' });
  const remembered = compileCommand(sentenceContext(instruction, { memory: { project: { project: 'vibeTerminal', defaultProvider: 'codex' } } }));
  assert.equal(remembered.accepted, true);
  assert.equal(remembered.provider, 'codex');
  // One implicit slot is affordable. A second one - "and" heard for "in" - is
  // not, and the request goes to the brain.
  assert.deepEqual(compileCommand(sentenceContext('open a new terminal and vibeTerminal',
    { memory: { project: { project: 'vibeTerminal', defaultProvider: 'codex' } } })), { accepted: false, reason: 'low-confidence' });
});

// ---------------------------------------------------------------------------
// The seam.
// ---------------------------------------------------------------------------
function seamInterpreter(interpretIntent, complete) {
  return createIntentInterpreter({ interpretIntent, complete, getTask: () => undefined,
    redact: value => value, cleanError: error => String(error?.message || error),
    recordDiagnostic: () => {}, diagnosticError: () => {} });
}
const MODEL = { id: 'test-brain', contextLength: 128000, supportedParameters: ['tools'] };
const conversationReply = {
  choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call-1', type: 'function',
    function: { name: 'plan_conversation', arguments: JSON.stringify({ goal: 'Answer the question.' }) } }] } }],
};

test('a declining interpreter falls through to the model; an accepting one makes no model call', async () => {
  const context = sentenceContext('tell me about yourself');
  let calls = 0;
  const complete = async () => { calls++; return conversationReply; };
  const declining = seamInterpreter(() => undefined, complete);
  const plan = await declining(context, MODEL, 512, new AbortController().signal, {});
  assert.equal(calls, 1, 'the model path runs exactly once for a declined sentence');
  assert.equal(plan.goal, 'Answer the question.');

  calls = 0;
  const compiler = createCommandInterpreter({});
  const accepting = seamInterpreter(compiler, complete);
  const compiled = await accepting(sentenceContext('open a new Codex terminal in vibeTerminal'), MODEL, 512, new AbortController().signal, {});
  assert.equal(calls, 0, 'a compiled sentence costs no model call');
  assert.deepEqual(compiled.grants.map(grant => grant.kind), ['create_session']);
  assert.equal(compiled.grants[0].args.kindOfSession, 'codex');
  assert.equal(compiled.executionMode, 'direct');
});

test('the compiled stage is recorded with its status and reason, and no sentence text', () => {
  const rows = [];
  const compiler = createCommandInterpreter({ recordDiagnostic: entry => rows.push(entry), now: () => 1000 });
  compiler(sentenceContext('open a new Codex terminal in vibeTerminal'));
  compiler(sentenceContext('close all the terminals in vibeTerminal'));
  assert.deepEqual(rows.map(row => [row.event, row.stage, row.status, row.reason ?? row.shape]),
    [['request_stage', 'compiled', 'accepted', 'open'], ['request_stage', 'compiled', 'declined', 'blocked-verb']]);
  for (const row of rows) {
    assert.equal(typeof row.requestId, 'string');
    assert.equal(typeof row.elapsedMs, 'number');
    assert.doesNotMatch(JSON.stringify(row), /terminal in vibeTerminal/);
  }
});

// ---------------------------------------------------------------------------
// End to end through the relay: the effect must reach the terminal with no
// model call at all.
// ---------------------------------------------------------------------------
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function remove(root) {
  for (let attempt = 0; ; attempt++) {
    try { return fs.rmSync(root, { recursive: true, force: true }); }
    catch (error) { if (attempt >= 20) throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
  }
}
async function relayFixture(t, { sessions = [], brain } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-compiler-'));
  const project = path.join(root, 'vibeTerminal');
  fs.mkdirSync(project, { recursive: true });
  const f = { root, project, sessions: sessions.map(session => ({ ...session, cwd: project })), effects: [], modelCalls: [] };
  f.relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [{ name: 'vibeTerminal', path: project }] }),
    getSessions: () => f.sessions.map(session => ({ ...session })),
    getLaunchers: async () => [{ kind: 'codex', label: 'Codex', available: true, configured: true }],
    readSession: async target => {
      const session = f.sessions.find(item => item.id === target.id && item.generation === target.generation);
      return session ? { ok: true, id: session.id, generation: session.generation, turnId: session.turnId, turnState: session.turnState,
        sequence: session.sequence, inputRevision: 0, cols: 100, rows: 28, cursor: { x: 2, y: 0 }, cursorVisible: true, alternateScreen: false,
        cursorLine: { startRow: 0, text: 'Codex is idle at an empty root task composer. Ready to receive a task.', beforeCursor: 'Co' }, 
        inputState: { kind: 'empty', hasText: false }, text: 'Codex is idle at an empty root task composer. Ready to receive a task.' }
        : { ok: false, status: 'stale-generation' };
    },
    dispatchAction: async action => {
      f.effects.push({ kind: action.kind, targetId: action.targetId, cwd: action.cwd, text: action.text });
      if (action.kind === 'create_session') {
        const id = `pane-${f.sessions.length + 1}`;
        const session = { id, name: `Codex ${f.sessions.length + 1}`, kind: 'codex', provider: 'codex', cwd: action.cwd,
          generation: `generation-${id}`, launchToken: 1, conversationId: `conversation-${id}`, started: true, status: 'idle',
          observation: 'observed', processState: 'running', agentProcessState: 'running', agentPid: 5000 + f.sessions.length,
          turnState: 'idle', revision: 1, sequence: 1, inputRevision: 0 };
        f.sessions.push(session);
        return { ok: true, status: 'created', id, launchToken: 1, processState: 'running', cwd: action.cwd,
          target: { id, generation: session.generation, launchToken: 1 } };
      }
      const session = f.sessions.find(item => item.id === action.targetId);
      if (!session) return { ok: false, status: 'stale-generation' };
      Object.assign(session, { turnState: 'running', status: 'running', turnId: action.actionId, actionId: action.actionId,
        turnStartedAt: Date.now(), sequence: session.sequence + 1, inputRevision: session.inputRevision + 1, revision: session.revision + 1 });
      return { ok: true, status: 'written', turnId: session.turnId };
    },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return jsonResponse({ data: {} });
      if (url.includes('/models')) return jsonResponse({ data: [{ id: 'test-brain', context_length: 128000, supported_parameters: ['tools', 'tool_choice'] }] });
      const body = JSON.parse(options.body);
      f.modelCalls.push((body.tools || []).map(tool => tool.function.name));
      return brain ? brain(body) : jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Acknowledged.' } }] });
    } });
  t.after(async () => { await f.relay.cancel(); await f.relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); await remove(root); });
  await f.relay.configure({ apiKey: 'test-key', model: 'test-brain', sessionOnly: true });
  assert.equal((await f.relay.setEnabled(true)).ok, true);
  return f;
}

test('a compiled open reaches create_session with no model call', { timeout: 10000 }, async t => {
  const f = await relayFixture(t);
  const result = await f.relay.send({ text: 'Open a new Codex terminal in vibeTerminal.', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.effects.map(effect => effect.kind), ['create_session']);
  assert.equal(f.effects[0].cwd, f.project);
  assert.deepEqual(f.modelCalls, []);
});

test('a compiled start reaches create_session and send_prompt with no model call, typing the compiled task', { timeout: 10000 }, async t => {
  const f = await relayFixture(t);
  const result = await f.relay.send({ text: 'Have a Codex terminal in vibeTerminal fix the login page that is not working right.', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  await f.relay.refresh(); await tick();
  assert.deepEqual(f.effects.map(effect => effect.kind), ['create_session', 'send_prompt']);
  assert.equal(f.effects[1].text, 'Fix the login page that is not working right.');
  assert.deepEqual(f.modelCalls, []);
});

const owner = (id, title, extra = {}) => ({ id, name: title, conversationTitle: title, kind: 'codex', provider: 'codex',
  generation: `generation-${id}`, launchToken: 1, conversationId: `conversation-${id}`, started: true, status: 'idle',
  observation: 'observed', processState: 'running', agentProcessState: 'running', agentPid: 6000, turnState: 'idle',
  revision: 1, sequence: 1, inputRevision: 0, lastActivityAt: 3000, ...extra });

test('a compiled follow-up reaches the one pane whose title the user named, with no model call', { timeout: 10000 }, async t => {
  const f = await relayFixture(t, { sessions: [owner('pane-checkout', 'Fix checkout validation'), owner('pane-docs', 'Update deployment documentation', { lastActivityAt: 1000 })] });
  const result = await f.relay.send({ text: 'Tell the agent working on the checkout validation to also cover expired coupons.', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  await f.relay.refresh(); await tick();
  assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt']);
  assert.equal(f.effects[0].targetId, 'pane-checkout');
  assert.equal(f.effects[0].text, 'Also cover expired coupons.');
  assert.deepEqual(f.modelCalls, []);
});

test('two panes with the same named work is the brain\'s question to ask, not the compiler\'s', { timeout: 10000 }, async t => {
  const clarification = 'Which one: Fix checkout validation or Fix checkout validation tests?';
  const f = await relayFixture(t, {
    sessions: [owner('pane-checkout', 'Fix checkout validation'), owner('pane-checkout-tests', 'Fix checkout validation tests', { lastActivityAt: 2000 })],
    brain: body => jsonResponse({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'call-1', type: 'function',
      function: { name: (body.tools || []).some(tool => tool.function.name === 'plan_delegate_task') ? 'interpret_workspace' : 'workspace',
        arguments: JSON.stringify({ goal: 'Ask which agent the user meant.', clarification }) } }] } }] }) });
  const result = await f.relay.send({ text: 'Tell the agent working on the checkout validation to also cover expired coupons.', origin: 'text' });
  assert.equal(f.modelCalls.length >= 1, true, 'the ambiguous follow-up reached the brain');
  assert.deepEqual(f.effects, [], 'nothing was typed while the recipient was ambiguous');
  assert.match(String(result.text || result.error), /Which one/);
});

// ---------------------------------------------------------------------------
// The plain-shell launcher and "<provider> terminal".
//
// PROJECTS/LAUNCHERS above — the list this suite and the fidelity harness both
// use — leave out the `terminal` kind, and the renderer never does: agentProfiles
// reports it with `available: true` unconditionally (frontend/App.tsx inventory),
// so every real workspace hands the compiler a list that contains it. With it
// present, `extractSelector` used to read the word "terminal" in "Codex terminal"
// as the `terminal` provider while the compiler's own provider slot read "Codex",
// the two readings disagreed, and the cross-check declined `unknown-provider`.
//
// The user speaks this way constantly (rows 33, 59, 61, 62, 91, 96 all say
// "<provider> terminal"), so every one of them took a model round it did not
// need. The shell is now selected by shell words only, never by the pane noun.
function withShellLauncher() {
  return [{ kind: 'terminal', label: 'Terminal', available: true, configured: true },
    ...LAUNCHERS.map(item => ({ ...item }))];
}
function compiledWithShell(text, projects = PROJECTS.slice(0, 1), extra = {}) {
  const withShell = withShellLauncher();
  const instruction = normalizeInstruction(text, { projects, launchers: withShell }).text;
  return compileCommand({ instruction, sessions: [], projects,
    roots: { projects, documents: 'C:/Projects' }, launchers: withShell,
    projectContext: identifyProject(instruction, projects, null),
    requests: [], workItems: [], recentUserMessages: [], ...extra });
}

test('a `terminal` launcher in the catalog no longer stops row 62 compiling', () => {
  const row = CORPUS.find(item => item.n === 62);
  const result = compiledWithShell(row.text);
  assert.equal(result.accepted, true, `declined ${result.reason} with the shell launcher present`);
  assert.equal(result.provider, 'codex');
});

test('every "<provider> terminal" corpus row compiles the same with and without the shell launcher', () => {
  const withShell = withShellLauncher();
  for (const row of CORPUS.filter(item => /\b(?:codex|claude code|gemini)\s+terminals?\b/i.test(item.text))) {
    const plain = compiledFor(row, inWorkspace);
    const shelled = compiledWithShell(row.text, PROJECTS, inWorkspace);
    assert.equal(shelled.accepted, plain.accepted, `row ${row.n}: ${shelled.reason || 'accepted'} with the shell, ${plain.reason || 'accepted'} without`);
    if (plain.accepted) assert.equal(shelled.provider, plain.provider, `row ${row.n} provider`);
  }
  assert.ok(withShell.some(item => item.kind === 'terminal'), 'the shell launcher is in the catalog under test');
});

test('the plain shell is still selected by the words a user says for a shell', () => {
  const { readReference } = require('../../backend/orchestratorReference.cjs');
  const launchers = withShellLauncher();
  for (const text of ['open a powershell terminal here', 'open a plain terminal in vibeTerminal',
    'give me a shell in vibeTerminal', 'open the command prompt']) {
    assert.equal(readReference(text, { launchers }).provider, 'terminal', text);
  }
  for (const text of ['open a Codex terminal in vibeTerminal', 'prompt the Claude Code terminal to review the tests']) {
    assert.notEqual(readReference(text, { launchers }).provider, 'terminal', text);
  }
});
