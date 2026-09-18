'use strict';
// The deterministic assignment resolver, scored against the 131 real utterances
// saved from the September 7-12 sessions. Two layers: the selector the resolver
// reads out of a normalized instruction, and the decision it reaches against a
// fixed pane roster. The last group runs the whole relay to show what the
// decision costs: one interpretation call, and no routing or affinity round.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { resolveAssignment, idlePaneCandidate } = require('../../backend/orchestratorResolver.cjs');
const { readReference, resolveReference } = require('../../backend/orchestratorReference.cjs');
const { buildTerminalModel } = require('../../backend/orchestratorTerminalModel.cjs');
const { neverPrompted } = require('../../backend/orchestratorPaneReadiness.cjs');
const { normalizeInstruction } = require('../../backend/orchestratorVocabulary.cjs');
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
const ids = list => list.map(terminal => terminal.id);
const utterance = n => normalized(row(n).text);

// The roster from the September 12 profile: two panes about the chat section,
// one about performance, and three panes nobody owns.
const pane = (id, name, kind, extra = {}) => ({ id, name, kind, provider: kind, cwd: VIBE, generation: `g-${id}`,
  launchToken: 1, conversationId: `c-${id}`, started: true, status: 'idle', observation: 'observed',
  // Inventory always carries the pane's own agent process; reuse needs an
  // identified recipient exactly as delivery and idle-target selection do.
  processState: 'running', agentProcessState: 'running', agentPid: 4000 + id.length, turnState: 'idle', lastActivityAt: 1000, ...extra });
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
// The terminal model the resolver reads, built the way the app builds it: the
// pane Lina opened is a creation receipt, the pane she last typed into is the
// newest delivered ledger row.
function terminalsFor(options = {}) {
  const sessions = options.sessions || roster();
  const receipts = options.created ? [{ kind: 'create_session', status: 'created', targetId: options.created.id, at: 9000 }] : [];
  const ledgerRows = options.ledgerRows || (options.lastTarget
    ? [{ requestId: 'last', at: 9000, verb: 'start', outcome: 'delivered-started', pane: { id: options.lastTarget.id } }] : []);
  return buildTerminalModel({ sessions, workItems: options.workItems || (options.sessions ? [] : rosterWork()), ledgerRows, receipts });
}
function decide(instruction, options = {}) {
  return resolveAssignment({ instruction, grant: { args: { cwd: options.cwd || VIBE, assignmentMode: options.assignmentMode || 'auto', ...(options.kindOfSession && { kindOfSession: options.kindOfSession }) } },
    terminals: terminalsFor(options), launchers: options.launchers || launchers, now: 10000,
    cwd: options.cwd || VIBE, projectName: options.projectName || 'vibeTerminal',
    ...(options.answer && { answer: options.answer }),
    ...(options.defaultProvider && { defaultProvider: options.defaultProvider }) });
}

// Codex, Open Codex and Codex Web run the same CLI but are three different
// products with three different conversations and sign-ins. They are one `tui`
// in the provider lexicon and three `family` values, so a pane of one is never
// offered for a request that named another - which is the substitution the
// September 16 session complained about.
test('an Open Codex pane is never the answer to a request that said Codex', () => {
  // The build the September 16 session was running: Open Codex is offered, so
  // both names are in play in one sentence.
  const catalog = [...launchers, { kind: 'open-codex', label: 'Open Codex', available: true, configured: true }];
  const sessions = [pane('p3', '✳ Claude Code', 'claude', { lastActivityAt: 4000 }),
    pane('p9', 'Open Codex 3', 'open-codex', { lastActivityAt: 8000 })];
  const ask = (text) => decide(text, { sessions, workItems: [], launchers: catalog });
  // Idle, unowned, and in the same project: still not a Codex pane.
  const started = ask('Can you prompt a Codex terminal in vibeTerminal to fix the full screen issue?');
  assert.deepEqual([started.decision, started.kindOfSession], ['create', 'codex'], JSON.stringify(started));
  // And a definite reference asks rather than selecting it.
  const asked = ask('Can you get the Codex terminal in vibeTerminal to fix the full screen issue?');
  assert.deepEqual([asked.decision, asked.question, asked.answerKind, asked.kindOfSession],
    ['ask', 'No Codex pane is open in vibeTerminal. Open a new one?', 'open-new', 'codex'], JSON.stringify(asked));
  // The same sentence naming Open Codex does take it, and its leading "Open" is
  // the launcher's name there, not a request to open anything.
  const named = ask('Can you get the Open Codex terminal in vibeTerminal to fix the full screen issue?');
  assert.deepEqual([named.decision, named.targetId], ['reuse', 'p9'], JSON.stringify(named));
});

// September 16: "can you get codex in Vibre Terminal to investigate ..." with no
// Codex pane open at all answered "Which existing Codex pane did you mean in
// vibeTerminal?" - a question about a pane that was not there, and one the user
// could not answer. Two rules changed. A bare "codex in vibeTerminal" names a
// kind of agent and a project, not a conversation, so it reuses an idle Codex
// pane or opens one; and a definite reference with nothing to point at asks the
// one thing left to decide, carrying the launcher so the reply needs no model.
test('a provider named with a project opens or reuses, and a definite one with no pane asks to open it', () => {
  const noCodex = [pane('p3', '✳ Claude Code', 'claude', { lastActivityAt: 4000 })];
  const bare = decide('Can you get codex in vibeTerminal to investigate the release notes?', { sessions: noCodex, workItems: [] });
  assert.deepEqual([bare.decision, bare.kindOfSession], ['create', 'codex'], JSON.stringify(bare));
  const idle = [...noCodex, pane('p8', 'Codex 8', 'codex', { lastActivityAt: 2000 })];
  const reused = decide('Can you get codex in vibeTerminal to investigate the release notes?', { sessions: idle, workItems: [] });
  assert.deepEqual([reused.decision, reused.targetId], ['reuse', 'p8']);

  const asked = decide('Can you get the Codex terminal in vibeTerminal to investigate the release notes?', { sessions: noCodex, workItems: [] });
  assert.deepEqual([asked.decision, asked.question, asked.answerKind, asked.kindOfSession],
    ['ask', 'No Codex pane is open in vibeTerminal. Open a new one?', 'open-new', 'codex'], JSON.stringify(asked));
  const answered = decide('A brand new one.', { sessions: noCodex, workItems: [],
    answer: { text: 'A brand new one.', kind: 'open-new', kindOfSession: 'codex', candidates: [] } });
  assert.deepEqual([answered.decision, answered.kindOfSession], ['create', 'codex'], JSON.stringify(answered));
});

// Which launcher a new pane gets: the answer, the user's own word, the Brain's
// plan, what this project usually starts, the rank order - in that order.
test('the spoken launcher wins over the planned one, and the project default over the rank order', () => {
  const unnamed = 'Open a new terminal in vibeTerminal.';
  assert.deepEqual([decide(unnamed, { sessions: [] }).decision, decide(unnamed, { sessions: [] }).kindOfSession], ['create', 'codex'],
    'no launcher anywhere: the rank order');
  const remembered = decide(unnamed, { sessions: [], defaultProvider: 'claude' });
  assert.deepEqual([remembered.decision, remembered.kindOfSession], ['create', 'claude'], 'what this project usually starts');
  const planned = decide(unnamed, { sessions: [], kindOfSession: 'claude', defaultProvider: 'codex' });
  assert.deepEqual([planned.decision, planned.kindOfSession], ['create', 'claude'], 'the Brain names one and the sentence does not');
  const spoken = decide('Open a new Codex terminal in vibeTerminal.', { sessions: [], kindOfSession: 'codex-web', defaultProvider: 'claude' });
  assert.deepEqual([spoken.decision, spoken.kindOfSession], ['create', 'codex'], 'the launcher the user said');
});

// Added 2026-09-15: "prompt the other one as well" right after a question was
// answered by a guess (ladder T4.7). A delivery anchors "the other one" only
// while it is the latest thing in the ledger.
test('"the other one" is the pane beside the last delivery, and a question once anything came after that delivery', () => {
  const delivered = { requestId: 'd', at: 200, verb: 'start', outcome: 'delivered-started', project: 'vibeTerminal', pane: { id: 'p1', name: 'Chat section', provider: 'codex' } };
  const fresh = decide('Prompt the other one as well.', { lastTarget: { id: 'p1' }, ledgerRows: [delivered] });
  assert.equal(fresh.decision, fresh.candidateCount > 2 ? 'ask' : 'reuse', JSON.stringify(fresh));
  const stale = decide('Prompt the other one as well.', { lastTarget: { id: 'p1' }, ledgerRows: [delivered, { requestId: 'q', at: 300, verb: 'ask', outcome: 'answered', project: 'vibeTerminal' }] });
  assert.equal(stale.decision, 'ask', JSON.stringify(stale));
  assert.ok(stale.candidates.length >= 1, 'the question names the panes it could mean');
});

// --- Selector extraction ---------------------------------------------------
// Every row below is a real utterance, read after wave 1 normalization.
const SELECTORS = [
  [1, 'provider'], [5, 'provider'], [18, 'provider'], [22, 'new'], [33, 'idle'], [45, 'new'], [47, 'idle'],
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
    const found = readReference(utterance(n), { launchers }).kind;
    if (found !== expected) wrong.push({ n, expected, found, text: utterance(n).slice(0, 80) });
  }
  assert.deepEqual(wrong, [], `selector mismatches: ${JSON.stringify(wrong, null, 1)}`);
  assert.ok(SELECTORS.length >= 30, 'the table covers at least thirty real utterances');
});

test('the named task, not the pane vocabulary, becomes the title words', () => {
  assert.deepEqual(readReference(utterance(122), { launchers }).words, ['chat', 'section']);
  assert.deepEqual(readReference(utterance(121), { launchers }).words, ['chat', 'section']);
  assert.deepEqual(readReference('Ask the terminal working on "invoice rounding" to continue.').words, ['invoice', 'rounding']);
  // A creation verb owned by a subject describes the bug, not the request.
  assert.equal(readReference('have a Codex terminal fix the login page that is not working').kind, 'provider');
  assert.equal(readReference(utterance(126), { launchers }).provider, 'codex');
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
    // Row 82 explicitly says Codex; a Codex Web pane is a different launcher.
    const sessions = roster();
    if ([82, 94].includes(n)) Object.assign(sessions[4], { provider: 'codex', kind: 'codex' });
    const result = decide(utterance(n), { created, sessions, workItems: rosterWork() });
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

// Added 2026-09-15: "and tell it to write that up in the docs folder" right
// after "prompt the empty codex terminal to summarize the repo" asked which
// agent to continue (ladder T4.12). "It" is the pane Lina last typed into.
test('an existing-agent continuation that says "it" goes to the pane Lina last typed into', () => {
  const result = decide('And tell it to write that up in the docs folder.', { assignmentMode: 'existing', lastTarget: { id: 'p2' } });
  assert.deepEqual([result.decision, result.targetId], ['reuse', 'p2'], JSON.stringify(result));
  const elsewhere = decide('And tell it to write that up in the docs folder.', { assignmentMode: 'existing', lastTarget: { id: 'gone' } });
  assert.equal(elsewhere.decision, 'ask', 'a pane no longer in the project is not "it"');
  const named = decide('Tell the pairing terminal to write that up.', { assignmentMode: 'existing', lastTarget: { id: 'p2' } });
  assert.notEqual(named.targetId, 'p2', 'a named pane is not read as "it"');
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
    const reading = readReference(normalized(item.text), { launchers });
    const explicitExisting = reading.kind === 'provider' && reading.definiteProvider && !reading.indefiniteProvider;
    const expected = explicitExisting ? ['reuse', 'ask'] : [82, 94].includes(item.n) ? ['ask'] : EXPECTED[item.selector];
    if (!expected.includes(result.decision)) {
      misses.push({ n: item.n, labelled: item.selector, selector: result.selector, decision: result.decision, text: normalized(item.text).slice(0, 80) });
    }
  }
  const fraction = (total - misses.length) / total;
  console.log(`resolver corpus sweep: ${total - misses.length}/${total} = ${fraction.toFixed(3)} (${skipped} rows carry a selector the resolver does not own)`);
  for (const miss of misses) console.log(`  miss #${miss.n} labelled ${miss.labelled}, read as ${miss.selector} -> ${miss.decision}: ${miss.text}`);
  assert.ok(fraction >= 0.9, `corpus sweep ${fraction.toFixed(3)} below 0.9`);
});

// --- Lina's own actions, read off the model ---------------------------------
// "That new terminal you just opened" and "the one you just prompted" are
// answered from creation receipts and the ledger, never offering a pane that
// has since closed. The action-history module that scanned receipts for this
// is gone; the model carries `opened` and `lastWorked` instead.
test('what Lina opened and last typed into is read off the model, and a closed pane is never offered', () => {
  const sessions = [pane('open', 'Codex open', 'codex'), pane('sent', 'Codex sent', 'codex')];
  const receipts = [
    { kind: 'create_session', targetId: 'closed', status: 'created', cwd: VIBE, at: 1000 },
    { kind: 'create_session', targetId: 'open', status: 'created', cwd: VIBE, at: 2000 },
  ];
  const row = (id, at, outcome = 'delivered-started') => ({ requestId: `r-${at}`, at, verb: 'start', outcome, pane: { id } });
  const terminals = (ledgerRows, extra = {}) => buildTerminalModel({ sessions, receipts, ledgerRows, ...extra });
  const opened = resolveReference('put that prompt in the terminal you just opened', terminals([]), { cwd: VIBE, now: 5000 });
  assert.deepEqual([opened.kind, opened.terminals.map(t => t.id)], ['just_opened', ['open']], 'the newest live creation, not the closed one');
  assert.equal(resolveReference('the terminal you just opened', terminals([]), { cwd: VIBE, now: 2000 + 31 * 60 * 1000 }).exact, false, 'outside the window');
  const last = resolveReference('stop that last terminal you worked on', terminals([row('sent', 3000), row('open', 4000, 'refused')]), { cwd: VIBE });
  assert.deepEqual([last.kind, last.terminals.map(t => t.id)], ['last_target', ['sent']], 'a refused write is not a pane Lina used');
  const gone = resolveReference('the last one you worked on', terminals([row('sent', 3000), row('closed', 4000)]), { cwd: VIBE });
  assert.deepEqual([gone.exact, gone.candidates], [false, []], 'the newest delivery went to a pane that has closed: a question, never the next best');
  const both = resolveReference('stop them both', terminals([row('sent', 3000), row('open', 3000)]), { cwd: VIBE });
  assert.equal(both.fanOut, true);
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

test('answering a routing question with its exact title preserves the task without a model call', async t => {
  const f = await relayFixture(t);
  f.session('review-a', 'Review orchestrator issues');
  f.session('review-b', 'Review orchestrator performance');
  f.plans.push({ name: 'plan_continue_task', args: { cwd: f.root, text: 'Investigate the messages and implement the fixes.' } });
  const asked = await f.relay.send({ text: 'Continue the orchestrator review.', origin: 'text' });
  const question = f.task(asked).question;
  assert.ok(question?.routingCandidates?.length);
  const answered = await f.relay.send({ text: 'Review Orchestrator issues.', origin: 'text', replyToRequestId: asked.requestId, questionId: question.id });
  assert.equal(answered.ok, true, JSON.stringify(answered));
  assert.deepEqual(f.calls, ['interpretation']);
  assert.deepEqual(f.effects.map(action => [action.kind, action.targetId, action.text]),
    [['send_prompt', 'review-a', 'Investigate the messages and implement the fixes.']]);
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

  const answered = await f.relay.send({ text: 'the second one', origin: 'text', replyToRequestId: asked.requestId, questionId: question.id });
  assert.equal(answered.ok, true, JSON.stringify(answered));
  assert.deepEqual(f.effects.map(effect => [effect.kind, effect.targetId]), [['send_prompt', 'chat-b']]);
  assert.deepEqual(f.calls, ['interpretation'], 'a routing answer does not need reinterpretation');
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

// "The agent working on adding a chat section" names a pane started by hand,
// which carries no title. The sentence still says the pane is working, and when
// one pane is, that is the pane; two are a question.
test('a working-on title with no titled pane resolves to the one working pane', () => {
  const said = 'Have a agent working on adding a chat section in the vibeTerminal project can you prompt it to do a deep dive on that';
  const sessions = [pane('w1', 'vibeTerminal', 'codex', { status: 'running', turnState: 'running', turnId: 'busy', lastActivityAt: 6000 }),
    pane('w2', 'vibeTerminal', 'codex', { lastActivityAt: 5000 })];
  const one = decide(said, { sessions, workItems: [] });
  assert.equal(one.decision, 'reuse'); assert.equal(one.targetId, 'w1');
  const two = decide(said, { sessions: [...sessions, pane('w3', 'vibeTerminal', 'codex', { status: 'running', turnState: 'running', turnId: 'busy-2', lastActivityAt: 7000 })], workItems: [] });
  assert.equal(two.decision, 'ask');
});

// Added 2026-09-15 evening (phase-2 ladder, T4.1): "Have a agent working on
// adding a chat section ... can you prompt it" names the pane by its task even
// though the words overlap weakly ("adding" is not "add") and the sentence also
// says "a agent". The one pane whose task carries the words is the pane; the
// weak overlap only stops the review from calling it named outright.
test('a weak sole title match still reuses the pane whose task the sentence names, even beside "a agent"', () => {
  const said = 'Have a agent working on adding a chat section in the vibeTerminal project can you prompt it to do a deep dive on that';
  const sessions = [pane('cs', 'vibeTerminal', 'codex', { status: 'running', turnState: 'running', turnId: 'busy', lastActivityAt: 6000 }),
    pane('fs', 'vibeTerminal', 'claude', { turnState: 'completed', turnId: 'done', turnEndedAt: 5000, lastActivityAt: 5000 }), pane('spare', 'vibeTerminal', 'codex', { lastActivityAt: 4000 })];
  const workItems = [{ id: 'w-cs', cwd: VIBE, status: 'active', objective: 'Add a chat section to the app. [stub:slow:3600]', binding: { target: { id: 'cs', generation: 'g-cs' } } },
    { id: 'w-fs', cwd: VIBE, status: 'finished', objective: 'Fix the full screen bug.', binding: { target: { id: 'fs', generation: 'g-fs' } } }];
  const result = decide(said, { sessions, workItems });
  assert.deepEqual([result.decision, result.targetId, result.selector], ['reuse', 'cs', 'title'], JSON.stringify(result));
  const reference = resolveReference(said, terminalsFor({ sessions, workItems }), { cwd: VIBE, launchers });
  assert.deepEqual([reference.indefinite, ids(reference.scored), ids(reference.named)], [true, ['cs'], []], 'named for the review, scored for assignment');
});

// Added 2026-09-15 (phase-5 ladder, T3.3b): "prompt it" after the delivery it
// leaned on had failed went into the spare pane. With nothing on record to be
// "it", the answer is a question, never a free pane.
test('"prompt it" with no delivery on record asks instead of taking a free pane', () => {
  const result = decide('Can you prompt it and ask it if the application is still paused?', { sessions: [pane('busy', 'vibeTerminal', 'codex', { status: 'running', turnState: 'running', turnId: 't' }), pane('spare', 'vibeTerminal', 'codex')], workItems: [] });
  assert.deepEqual([result.decision, result.targetId], ['ask', undefined], JSON.stringify(result));
  const anchored = decide('Can you prompt it and ask it if the application is still paused?', { sessions: [pane('busy', 'vibeTerminal', 'codex', { status: 'running', turnState: 'running', turnId: 't' }), pane('spare', 'vibeTerminal', 'codex')], workItems: [], lastTarget: { id: 'busy' } });
  assert.deepEqual([anchored.decision, anchored.targetId], ['reuse', 'busy'], 'with a delivery on record "it" is that pane, busy or not');
});
