'use strict';
// The deterministic assignment resolver, scored against the 128 real utterances
// saved from the September 7-12 sessions. Two layers: the selector the resolver
// reads out of a normalized instruction, and the decision it reaches against a
// fixed pane roster. The last group runs the whole relay to show what the
// decision costs: one interpretation call, and no routing or affinity round.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { extractSelector, resolveAssignment, idlePaneCandidate, neverPrompted } = require('../../backend/orchestratorResolver.cjs');
const { normalizeInstruction } = require('../../backend/orchestratorVocabulary.cjs');
const { createActionHistory } = require('../../backend/orchestratorActionHistory.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const corpus = require('./fixtures/orchestrator-utterances.json');

const VIBE = 'C:/repo/vibeTerminal', WEB = 'C:/repo/lina-web-app';
const projects = [{ name: 'vibeTerminal', path: VIBE }, { name: 'lina web app', path: WEB },
  { name: 'lina mobile', path: 'C:/repo/lina-mobile' }, { name: 'Ternary model dev', path: 'C:/repo/ternary' }];
const launchers = [{ kind: 'codex', label: 'Codex', available: true, configured: true },
  { kind: 'claude', label: 'Claude Code', available: true, configured: true },
  { kind: 'codex-web', label: 'Codex Web', available: true, configured: true }];
const sameCwd = (a, b) => Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase());
const normalized = text => normalizeInstruction(text, { projects, launchers }).text;
const row = n => corpus.find(item => item.n === n);
const utterance = n => normalized(row(n).text);

// The roster from the September 12 profile: two panes about the chat section,
// one about performance, and three panes nobody owns.
const pane = (id, name, kind, extra = {}) => ({ id, name, kind, provider: kind, cwd: VIBE, generation: `g-${id}`,
  launchToken: 1, conversationId: `c-${id}`, started: true, status: 'idle', observation: 'observed',
  processState: 'running', turnState: 'idle', lastActivityAt: 1000, ...extra });
const roster = () => [
  pane('p1', 'Add project chat section', 'codex', { status: 'running', turnState: 'running', turnId: 'busy-turn', lastActivityAt: 6000 }),
  pane('p2', 'Investigate chat section integration', 'codex', { lastActivityAt: 5000 }),
  pane('p3', '✳ Claude Code', 'claude', { lastActivityAt: 4000 }),
  pane('p4', 'Investigate terminal performance', 'codex', { lastActivityAt: 3000 }),
  pane('p5', 'Codex Web 9', 'codex-web', { lastActivityAt: 2000 }),
  pane('p6', '✳ Claude Code', 'claude-custom', { lastActivityAt: 1500 }),
];
const rosterWork = () => [
  { id: 'w1', cwd: VIBE, title: 'Add project chat section', objective: 'Add the project chat section to the sidebar dock.', binding: { target: { id: 'p1', generation: 'g-p1' } } },
  { id: 'w2', cwd: VIBE, title: 'Investigate chat section integration', objective: 'Investigate how the chat section integrates with the composer.', binding: { target: { id: 'p2', generation: 'g-p2' } } },
  { id: 'w4', cwd: VIBE, title: 'Investigate terminal performance', objective: 'Investigate terminal performance and RAM growth.', binding: { target: { id: 'p4', generation: 'g-p4' } } },
];
function decide(instruction, options = {}) {
  const sessions = options.sessions || roster();
  return resolveAssignment({ instruction, grant: { args: { cwd: options.cwd || VIBE, assignmentMode: options.assignmentMode || 'auto', ...(options.kindOfSession && { kindOfSession: options.kindOfSession }) } },
    sessions, workItems: options.workItems || (options.sessions ? [] : rosterWork()), launchers, sameCwd,
    cwd: options.cwd || VIBE, projectName: options.projectName || 'vibeTerminal',
    history: options.history || { lastCreatedPane: () => options.created, lastTargetPane: () => options.lastTarget, recentPanes: () => [] },
    ...(options.answer && { answer: options.answer }) });
}

// --- Selector extraction ---------------------------------------------------
// Every row below is a real utterance, read after wave 1 normalization.
const SELECTORS = [
  [1, 'provider'], [5, 'provider'], [18, 'new'], [22, 'new'], [33, 'idle'], [45, 'new'], [47, 'idle'],
  [48, 'idle'], [49, 'provider'], [58, 'idle'], [59, 'idle'], [60, 'idle'], [61, 'idle'], [62, 'new'],
  [63, 'just_opened'], [70, 'new'], [74, 'new'], [78, 'idle'], [82, 'just_opened'], [83, 'idle'],
  [85, 'idle'], [86, 'idle'], [87, 'idle'], [90, 'idle'], [91, 'new'], [93, 'new'], [94, 'just_opened'],
  [96, 'new'], [97, 'new'], [98, 'new'], [103, 'new'], [106, 'new'], [109, 'provider'], [111, 'new'],
  [112, 'provider'], [113, 'provider'], [114, 'provider'], [122, 'title'], [123, 'title'],
  [125, 'new'], [127, 'provider'], [128, 'idle'],
];
test('selector extraction over the real utterances', () => {
  const wrong = [];
  for (const [n, expected] of SELECTORS) {
    const found = extractSelector(utterance(n), { launchers }).kind;
    if (found !== expected) wrong.push({ n, expected, found, text: utterance(n).slice(0, 80) });
  }
  assert.deepEqual(wrong, [], `selector mismatches: ${JSON.stringify(wrong, null, 1)}`);
  assert.ok(SELECTORS.length >= 30, 'the table covers at least thirty real utterances');
});

test('the named task, not the pane vocabulary, becomes the title words', () => {
  assert.deepEqual(extractSelector(utterance(122), { launchers }).words, ['chat', 'section']);
  assert.deepEqual(extractSelector(utterance(121), { launchers }).words, ['chat', 'section']);
  assert.deepEqual(extractSelector('Ask the terminal working on "invoice rounding" to continue.').words, ['invoice', 'rounding']);
  // A creation verb owned by a subject describes the bug, not the request.
  assert.equal(extractSelector('have a Codex terminal fix the login page that is not working').kind, 'provider');
  assert.equal(extractSelector(utterance(126), { launchers }).provider, 'codex');
});

// --- Decisions against the roster ------------------------------------------
test('two panes about the chat section are named in one question', () => {
  for (const n of [121, 122, 123]) {
    const result = decide(utterance(n));
    assert.equal(result.decision, 'ask', `#${n}: ${JSON.stringify(result)}`);
    assert.equal(result.question, 'Which one: Add project chat section or Investigate chat section integration?');
    assert.deepEqual(result.candidates.map(item => item.targetId), ['p1', 'p2'], 'most recent first');
  }
});

test('an empty Claude Code pane nobody owns takes the work it was asked for', () => {
  const result = decide(utterance(128));
  assert.equal(result.decision, 'reuse');
  assert.equal(result.targetId, 'p3');
  assert.equal(result.selector, 'idle');
});

test('the pane Lina just opened is the one the follow-up reaches', () => {
  const created = roster()[4];
  for (const n of [63, 82, 94]) {
    const result = decide(utterance(n), { created });
    assert.deepEqual([result.decision, result.targetId, result.selector], ['reuse', 'p5', 'just_opened'], `#${n}`);
  }
  // A pane another task owns, and no retry pending, is not adopted by "the one
  // you just opened"; the request falls through to the ordinary rules.
  assert.notEqual(decide(utterance(63), { created: roster()[0] }).targetId, 'p1');
  assert.equal(decide(utterance(63), { created: { ...roster()[0], id: 'p1' }, workItems: [{ ...rosterWork()[0], retriable: true }] }).targetId, 'p1');
});

test('an explicit new pane is created with the requested launcher', () => {
  for (const n of [62, 93, 97]) {
    const result = decide(utterance(n));
    assert.deepEqual([result.decision, result.kindOfSession, result.selector], ['create', 'codex', 'new'], `#${n}`);
  }
});

test('a named provider takes a free pane of that family, and otherwise opens one', () => {
  for (const n of [112, 113, 114, 126, 127]) {
    const result = decide(utterance(n));
    assert.deepEqual([result.decision, result.kindOfSession], ['create', 'codex'],
      `#${n} has no idle unowned Codex pane in the roster: ${JSON.stringify(result)}`);
  }
  const free = [...roster(), pane('p7', 'Codex 7', 'codex', { lastActivityAt: 7000 })];
  const reused = decide(utterance(112), { sessions: free, workItems: rosterWork() });
  assert.deepEqual([reused.decision, reused.targetId], ['reuse', 'p7']);
});

test('a project with no panes at all creates one', () => {
  for (const n of [124, 125]) {
    const result = decide(utterance(n), { sessions: [], cwd: WEB, projectName: 'lina web app' });
    assert.deepEqual([result.decision, result.kindOfSession], ['create', 'codex'], `#${n}`);
  }
});

test('an idle request with nothing free asks before opening another pane', () => {
  const busy = [pane('only', 'Codex only', 'codex', { status: 'running', turnState: 'running', turnId: 'busy' })];
  const result = decide(utterance(59), { sessions: busy });
  assert.equal(result.decision, 'ask');
  assert.equal(result.question, 'No idle Codex pane is free in vibeTerminal. Open a new one?');
  assert.equal(result.answerKind, 'open-new');
});

// --- Panes that have never taken a prompt, and owners that never delivered one -
// Two reasons the September 13 profile kept opening a second pane beside an
// empty one. A freshly opened Claude pane cannot prove its native identity until
// the provider writes a transcript, which for Claude only happens after the
// first prompt, so its observation stays provisional; and a work item whose
// prompt was cancelled or failed kept its binding, reserving the pane for work
// that never arrived.
const fresh = (id, kind) => pane(id, '✳ Claude Code', kind, { observation: 'provisional', agentProcessState: 'running',
  turnState: 'idle', conversationId: undefined, lastActivityAt: 900 });

test('a never-prompted pane whose identity is still provisional is reusable', () => {
  const sessions = [fresh('p8', 'claude')];
  assert.deepEqual([idlePaneCandidate(sessions[0]), neverPrompted(sessions[0])], [true, true]);
  const result = decide('Use Claude Code to investigate the voice cutoff.', { sessions, workItems: [] });
  assert.deepEqual([result.decision, result.targetId], ['reuse', 'p8'], JSON.stringify(result));
  // Once it has taken a turn, reuse means joining a conversation we must be able
  // to name, so unconfirmed identity is no longer enough.
  const used = [{ ...sessions[0], turnId: 't1', turnStartedAt: 2000, turnEndedAt: 3000, turnState: 'completed' }];
  assert.equal(idlePaneCandidate(used[0]), false);
  assert.equal(decide('Use Claude Code to investigate the voice cutoff.', { sessions: used, workItems: [] }).decision, 'create');
  // A contested identity is never quietly adopted, however fresh the pane is.
  assert.equal(idlePaneCandidate({ ...sessions[0], binding: { status: 'ambiguous' } }), false);
  // Nor is a pane that has not reported its own agent process yet.
  assert.equal(idlePaneCandidate({ ...sessions[0], agentProcessState: undefined }), false);
});

test('an owner whose prompt was cancelled or failed releases its pane; a finished one keeps it', () => {
  const sessions = [pane('p9', 'Codex 9', 'codex', { lastActivityAt: 900 })];
  const owner = status => [{ id: 'w9', cwd: VIBE, status, title: 'Investigate the voice detection cutoff',
    objective: 'Investigate the voice detection cutoff.', binding: { target: { id: 'p9', generation: 'g-p9' } } }];
  for (const status of ['cancelled', 'failed']) {
    const result = decide('Start a Codex task on the chat section.', { sessions, workItems: owner(status) });
    assert.deepEqual([result.decision, result.targetId], ['reuse', 'p9'], status);
  }
  for (const status of ['finished', 'running', undefined]) {
    const result = decide('Start a Codex task on the chat section.', { sessions, workItems: owner(status) });
    assert.equal(result.decision, 'create', `a ${status} item still owns its pane`);
  }
  // A released item is still the owner the user can name when continuing it:
  // the title rule reads every item, whatever its status.
  const named = decide('Go back to the agent working on the voice detection cutoff, and also check the microphone.',
    { sessions, workItems: owner('cancelled') });
  assert.deepEqual([named.decision, named.targetId, named.workItemId], ['reuse', 'p9', 'w9'], JSON.stringify(named));
});

test('an existing-agent continuation with no title match names the agents it can see', () => {
  const result = decide('Tell it to continue.', { assignmentMode: 'existing' });
  assert.equal(result.decision, 'ask');
  assert.match(result.question, /^Which agent should continue\? In vibeTerminal I see: /);
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(result.candidates.map(item => item.targetId), ['p1', 'p2', 'p3']);
  assert.equal(result.question.includes('unique live owner'), false);
});

test('answers to the resolver own question are resolved without a model', () => {
  const candidates = [{ targetId: 'p1', label: 'Add project chat section' }, { targetId: 'p2', label: 'Investigate chat section integration' }];
  const answer = text => decide(text, { answer: { text, kind: 'candidates', candidates } });
  assert.deepEqual([answer('the second one').decision, answer('the second one').targetId], ['reuse', 'p2']);
  assert.deepEqual([answer('the first one').decision, answer('the first one').targetId], ['reuse', 'p1']);
  assert.deepEqual([answer('the chat section integration one').decision, answer('the chat section integration one').targetId], ['reuse', 'p2']);
  assert.equal(answer('both').decision, 'ask');
  assert.match(answer('both').question, /only give this task to one agent/);
  const opening = decide('open a new one', { answer: { text: 'open a new one', kind: 'open-new' } });
  assert.deepEqual([opening.decision, opening.kindOfSession], ['create', 'codex']);
  // A reply that answers nothing falls through to the ordinary rules.
  assert.equal(decide('no, never mind that', { answer: { text: 'no, never mind that', kind: 'open-new' } }).decision, 'reuse');
});

// --- Corpus sweep ----------------------------------------------------------
// Labelled selectors the resolver is responsible for. last_target, last_action,
// done, working and all are reply-context and ledger questions answered
// elsewhere in the harness, so they are reported but not scored here.
const EXPECTED = { new: ['create'], just_opened: ['reuse'], title: ['reuse', 'ask'], topic: ['reuse', 'ask'],
  empty: ['reuse', 'ask'], idle: ['reuse', 'ask'], provider: ['reuse', 'create'], none: ['reuse', 'create'] };
const SWEPT_VERBS = new Set(['start', 'follow_up', 'redo', 'redirect']);
test('corpus sweep: at least nine in ten requests reach the decision their selector implies', () => {
  const misses = [];
  let total = 0, skipped = 0;
  for (const item of corpus) {
    if (!SWEPT_VERBS.has(item.verb)) continue;
    if (!EXPECTED[item.selector]) { skipped++; continue; }
    const cwd = item.project === 'lina web app' ? WEB : VIBE;
    const result = decide(normalized(item.text), { cwd, projectName: item.project || 'vibeTerminal',
      created: roster()[4], sessions: cwd === WEB ? [] : undefined, workItems: cwd === WEB ? [] : undefined });
    total++;
    if (!EXPECTED[item.selector].includes(result.decision)) {
      misses.push({ n: item.n, labelled: item.selector, selector: result.selector, decision: result.decision, text: normalized(item.text).slice(0, 80) });
    }
  }
  const fraction = (total - misses.length) / total;
  console.log(`resolver corpus sweep: ${total - misses.length}/${total} = ${fraction.toFixed(3)} (${skipped} rows carry a selector the resolver does not own)`);
  for (const miss of misses) console.log(`  miss #${miss.n} labelled ${miss.labelled}, read as ${miss.selector} -> ${miss.decision}: ${miss.text}`);
  assert.ok(fraction >= 0.9, `corpus sweep ${fraction.toFixed(3)} below 0.9`);
});

// --- Action history --------------------------------------------------------
test('action history answers from receipts and never offers a pane that has gone', () => {
  const sessions = [pane('open', 'Codex open', 'codex'), pane('sent', 'Codex sent', 'codex')];
  const receipts = [
    { kind: 'create_session', targetId: 'closed', status: 'created', cwd: VIBE, at: 1000 },
    { kind: 'create_session', targetId: 'open', status: 'created', cwd: VIBE, at: 2000 },
    { kind: 'send_prompt', targetId: 'sent', status: 'written', at: 3000, requestId: 'r1' },
    { kind: 'send_prompt', targetId: 'open', status: 'rejected', at: 4000, requestId: 'r2' },
  ];
  const history = createActionHistory({ getReceipts: () => receipts, getSessions: () => sessions,
    getTasks: () => [{ requestId: 'r1', status: 'finished' }], now: () => 5000, sameCwd });
  assert.equal(history.lastCreatedPane({ cwd: VIBE })?.id, 'open');
  assert.equal(history.lastCreatedPane({ cwd: VIBE, withinMs: 1000 }), undefined, 'outside the window');
  assert.equal(history.lastTargetPane({ cwd: VIBE })?.id, 'sent', 'a refused write is not a pane Lina used');
  assert.deepEqual(history.recentPanes({ cwd: VIBE, limit: 5 }).map(item => item.id), ['open', 'sent']);
  const cancelled = createActionHistory({ getReceipts: () => receipts, getSessions: () => sessions,
    getTasks: () => [{ requestId: 'r1', status: 'cancelled' }], now: () => 5000, sameCwd });
  assert.equal(cancelled.lastTargetPane({ cwd: VIBE }), undefined);
});

// --- Through the relay -----------------------------------------------------
// No interpretIntent and no routeTask adapter: the actual planner tools and the
// actual resolver run, and every model call is counted.
async function relayFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-resolver-'));
  let serial = 0;
  const f = { root, sessions: [], effects: [], calls: [], launchers: [{ kind: 'codex', label: 'Codex', available: true, configured: true }] };
  f.session = (id, name, extra = {}) => {
    const session = { id, name, kind: 'codex', provider: 'codex', cwd: root, generation: `g-${id}`, launchToken: ++serial,
      conversationId: `c-${id}`, started: true, status: 'idle', observation: 'observed', processState: 'running',
      agentProcessState: 'running', agentPid: 200 + serial, turnState: 'idle', revision: 1, lastActivityAt: 1000, ...extra };
    f.sessions.push(session);
    return session;
  };
  const call = (name, args) => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [
    { id: `resolver-${++serial}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
  f.relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [{ name: 'Fixture', path: root }] }),
    getWorkspaceState: async () => ({ ok: true, view: 'project', cwd: root }),
    getSessions: () => f.sessions, getLaunchers: async () => f.launchers,
    readSession: async target => {
      const session = f.sessions.find(item => item.id === target.id);
      if (!session) return { ok: false, status: 'stale-generation' };
      return { ok: true, id: session.id, generation: session.generation, text: session.name, sequence: 10, inputRevision: 2 };
    },
    dispatchAction: async action => {
      f.effects.push(action);
      if (action.kind !== 'create_session') return { ok: true, status: 'written' };
      const created = f.session(`created-${f.sessions.length + 1}`, `Codex ${f.sessions.length + 1}`, { cwd: action.cwd });
      return { ok: true, status: 'created', id: created.id, launchToken: created.launchToken, processState: 'running',
        target: { id: created.id, generation: created.generation, launchToken: created.launchToken } };
    },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'scripted', context_length: 128000, supported_parameters: ['tools', 'tool_choice'] }] }));
      const body = JSON.parse(options.body);
      // The ownership reviewer and the routing rounds are deleted: every
      // completion here is an interpretation or an execution round, and both
      // carry their own tools.
      assert.ok(body.tools?.length, 'no tool-less ownership reviewer');
      assert.equal(body.tools.some(tool => tool.function.name.startsWith('choose_')), false, 'no routing round');
      const planner = body.tools?.find(tool => tool.function.name.startsWith('plan_'));
      f.calls.push(planner ? 'interpretation' : 'execution');
      const scripted = f.plans.shift();
      assert.ok(scripted, `unscripted model call ${planner ? 'interpretation' : 'execution'}`);
      return new Response(JSON.stringify(call(scripted.name, scripted.args)));
    } });
  f.plans = [];
  t.after(async () => { await f.relay.cancel(); await f.relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await f.relay.configure({ apiKey: 'test-key', model: 'scripted', sessionOnly: true });
  assert.equal((await f.relay.setEnabled(true)).ok, true);
  f.task = result => f.relay.getState().tasks.find(task => task.requestId === result.requestId);
  f.diagnostics = async stage => {
    await f.relay.flushDiagnostics();
    const file = path.join(root, 'logs', 'orchestrator-errors.jsonl');
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    return lines.filter(entry => entry.stage === stage);
  };
  return f;
}

test('a start request with an idle unowned pane costs one model call and opens nothing', { timeout: 4000 }, async t => {
  const f = await relayFixture(t);
  const idle = f.session('idle-pane', 'Codex 1');
  f.plans.push({ name: 'plan_delegate_task', args: { cwd: f.root, text: 'Investigate the performance of the orchestrator.' } });
  const result = await f.relay.send({ text: 'Investigate the performance of the orchestrator.', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.calls, ['interpretation'], 'interpretation is the only model call before the effect');
  assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt']);
  assert.equal(f.effects[0].targetId, idle.id);
});

test('two chat-section panes produce one named question, then the answer delivers', { timeout: 4000 }, async t => {
  const f = await relayFixture(t);
  f.session('chat-a', 'Add project chat section', { lastActivityAt: 6000 });
  f.session('chat-b', 'Investigate chat section integration', { lastActivityAt: 5000 });
  const instruction = 'tell the agent working on the project chat section to continue';
  f.plans.push({ name: 'plan_continue_task', args: { cwd: f.root, text: 'Continue the chat section work.' } });
  const asked = await f.relay.send({ text: instruction, origin: 'text' });
  const question = f.task(asked).question;
  assert.equal(f.task(asked).status, 'needs-answer', JSON.stringify(asked));
  assert.equal(question.text, 'Which one: Add project chat section or Investigate chat section integration?');
  assert.deepEqual(question.routingCandidates.map(item => item.targetId), ['chat-a', 'chat-b']);
  assert.deepEqual(f.effects, [], 'nothing is created and nothing is typed while the question stands');
  assert.deepEqual(f.calls, ['interpretation']);
  // Numbers and enums only: the private log never records the words themselves.
  const [logged] = await f.diagnostics('resolver');
  assert.equal(logged.decision, 'ask');
  assert.equal(logged.selectorKind, 'title');
  assert.equal(logged.candidateCount, 2);
  assert.ok(logged.score > 0 && logged.score <= 1, JSON.stringify(logged));
  assert.equal(JSON.stringify(logged).includes('chat section'), false);

  f.plans.push({ name: 'plan_continue_task', args: { cwd: f.root, text: 'Continue the chat section work.' } });
  const answered = await f.relay.send({ text: 'the second one', origin: 'text', replyToRequestId: asked.requestId, questionId: question.id });
  assert.equal(answered.ok, true, JSON.stringify(answered));
  assert.deepEqual(f.effects.map(effect => [effect.kind, effect.targetId]), [['send_prompt', 'chat-b']]);
  assert.deepEqual(f.calls, ['interpretation', 'interpretation']);
});

test('answering the idle question with a new pane opens one', { timeout: 4000 }, async t => {
  const f = await relayFixture(t);
  f.session('busy-pane', 'Codex 1', { status: 'running', turnState: 'running', turnId: 'busy' });
  const instruction = 'Use one of the empty Codex terminals to investigate performance.';
  f.plans.push({ name: 'plan_delegate_task', args: { cwd: f.root, text: 'Investigate performance.' } });
  const asked = await f.relay.send({ text: instruction, origin: 'text' });
  const question = f.task(asked).question;
  assert.equal(question.text, `No idle Codex pane is free in ${path.basename(f.root)}. Open a new one?`);
  assert.equal(question.routingAnswerKind, 'open-new');
  assert.deepEqual(f.effects, []);
  f.plans.push({ name: 'plan_delegate_task', args: { cwd: f.root, text: 'Investigate performance.' } });
  const answered = await f.relay.send({ text: 'yes, open a new one', origin: 'text', replyToRequestId: asked.requestId, questionId: question.id });
  assert.equal(answered.ok, true, JSON.stringify(answered));
  assert.deepEqual(f.effects.map(effect => effect.kind), ['create_session', 'send_prompt']);
});
