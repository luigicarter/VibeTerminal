'use strict';
// The one reference resolver, read against the terminal model: one case per
// kind the corpus uses, and the rules the four deleted readers (the resolver's
// selector, the review's bases, the intent normalizer's last-worked lookup and
// the receipt-scanning action history) each kept a copy of.
// docs/orchestrator-terminal-model-overhaul-2026-09-15.md, section 4.2.
const test = require('node:test'), assert = require('node:assert/strict');
const { readReference, resolveReference, terminalsOf } = require('../../backend/orchestratorReference.cjs');
const { buildTerminalModel, createTerminalHandles } = require('../../backend/orchestratorTerminalModel.cjs');

const VIBE = 'C:/repo/vibeTerminal', WEB = 'C:/repo/lina-web-app';
const launchers = [{ kind: 'codex', label: 'Codex', available: true, configured: true },
  { kind: 'claude', label: 'Claude Code', available: true, configured: true }];
const live = (id, name, extra = {}) => ({ id, name, kind: 'codex', provider: 'codex', cwd: VIBE, generation: `g-${id}`, started: true,
  status: 'idle', observation: 'observed', processState: 'running', agentProcessState: 'running', agentPid: 100, turnState: 'idle', lastActivityAt: 1000, ...extra });
const working = (id, name, extra = {}) => live(id, name, { status: 'running', turnState: 'running', turnId: `t-${id}`, turnStartedAt: 900, ...extra });
const done = (id, name, extra = {}) => live(id, name, { turnState: 'completed', turnId: `t-${id}`, turnStartedAt: 500, turnEndedAt: 2000, ...extra });
const row = (id, at, extra = {}) => ({ requestId: `r-${at}`, at, verb: 'start', outcome: 'delivered-started', pane: { id }, ...extra });
const model = (sessions, extra = {}) => buildTerminalModel({ sessions, handles: createTerminalHandles(), ...extra });
const ids = list => list.map(terminal => terminal.id);

test('the grammar reads one kind per sentence, handles first, and states the facts the rules need', () => {
  for (const [text, kind] of [
    ['put that prompt in T3', 'handle'], ['tell t-2 to continue', 'handle'],
    ['that new terminal you just opened, prompt it to fix the bug', 'just_opened'],
    ['use one of the empty codex terminals to investigate', 'idle'],
    ['open a new codex terminal and have it check the tests', 'new'],
    ["let the codex terminal that's currently working know", 'working'],
    ['on both terminals that are currently done, push the fixes', 'done'],
    ['can you stop that last terminal you worked on?', 'last_target'],
    ['prompt the other one as well', 'other'],
    ['tell the agent working on the chat section to continue', 'title'],
    ['have a codex terminal fix the login page that is not working', 'provider'],
    ['run the unit tests and report back', 'none'],
  ]) assert.equal(readReference(text, { launchers }).kind, kind, text);
  assert.equal(readReference('put that prompt in T3').handle, 'T3');
  const title = readReference('tell the agent working on the chat section to continue');
  assert.deepEqual([title.words, title.working], [['chat', 'section'], true]);
  const fan = readReference('on both terminals that are currently done, push the fixes');
  assert.deepEqual([fan.fanOut, fan.all], [true, true]);
  assert.equal(readReference('prompt one of the existing codex terminals to check the height').indefinite, true);
  assert.equal(readReference('use one of the open terminals to investigate').group, true);
  assert.equal(readReference('tell it to also add regression coverage').deictic, true);
  assert.equal(readReference('and tell it to write that up').pronoun, true);
  assert.equal(readReference('tell the codex terminal in vibeTerminal to run the tests').definiteProvider, true);
});

test('a handle names its pane anywhere; the pane Lina just opened is the newest live creation in the project', () => {
  const terminals = model([live('a', 'A'), live('b', 'B', { cwd: WEB })],
    { receipts: [{ kind: 'create_session', status: 'created', targetId: 'a', at: 100 }, { kind: 'create_session', status: 'created', targetId: 'b', at: 200 }] });
  assert.deepEqual(ids(resolveReference('tell T2 to continue', terminals, { cwd: VIBE }).terminals), ['b'], 'a handle reaches across projects');
  assert.equal(resolveReference('tell T9 to continue', terminals).exact, false, 'a handle nobody carries names nothing');
  const opened = resolveReference('that new terminal you just opened, prompt it', terminals, { cwd: VIBE, now: 1000 });
  assert.deepEqual([opened.basis, ids(opened.terminals)], ['opened', ['a']], 'the newest creation in the addressed project, not the newer one elsewhere');
  assert.equal(resolveReference('that new terminal you just opened, prompt it', terminals, { cwd: VIBE, now: 100 + 31 * 60 * 1000 }).exact, false, 'half an hour later it is not "just" opened');
});

test('free panes, and working or done panes, alone or fanned out across projects', () => {
  const terminals = model([live('free', 'Codex 1'), working('busy', 'Codex 2'), done('fin', 'Codex 3'), done('fin-web', 'Codex 4', { cwd: WEB }), live('owned', 'Codex 5')],
    { workItems: [{ id: 'w', status: 'active', objective: 'Fix it', binding: { target: { id: 'owned' } } }] });
  const idle = resolveReference('use one of the empty codex terminals to investigate', terminals, { cwd: VIBE, launchers });
  assert.deepEqual([idle.kind, idle.basis, ids(idle.candidates)], ['idle', 'free', ['fin', 'free']],
    'free is idle and nobody\'s: a finished pane nobody owns counts, most recently active first; an owned one does not');
  const one = resolveReference("let the codex terminal that's currently working know", terminals, { cwd: VIBE, launchers });
  assert.deepEqual([one.exact, ids(one.terminals)], [true, ['busy']]);
  const both = resolveReference('on both terminals that are currently done, push the fixes', terminals, { cwd: VIBE, launchers });
  assert.deepEqual([both.stateFanOut, ids(both.terminals)], [true, ['fin', 'fin-web']], 'a fan-out over states reaches across projects');
  const none = resolveReference('the terminal that is done, push it', model([live('free', 'Codex 1')]), { cwd: VIBE });
  assert.deepEqual([none.kind, none.exact, none.candidates], ['done', false, []], 'no pane in that state is a question, never a guess');
});

test('the pane Lina last typed into anchors "the last one" and "the other one", only while its delivery is the latest thing', () => {
  const sessions = [live('a', 'A'), live('b', 'B'), live('c', 'C', { cwd: WEB })];
  const last = resolveReference('stop that last terminal you worked on', model(sessions, { ledgerRows: [row('a', 100), row('b', 200)] }));
  assert.deepEqual([last.basis, ids(last.terminals)], ['last-target', ['b']]);
  const other = resolveReference('prompt the other one as well', model(sessions, { ledgerRows: [row('a', 100), row('b', 200)] }), { cwd: VIBE });
  assert.deepEqual([other.fresh, ids(other.terminals)], [true, ['a']], 'the one pane in the project other than the last delivery');
  const stale = resolveReference('prompt the other one as well', model(sessions, { ledgerRows: [row('b', 200), { requestId: 'q', at: 300, verb: 'ask', outcome: 'answered' }] }), { cwd: VIBE });
  assert.deepEqual([stale.fresh, stale.exact, ids(stale.candidates)], [false, false, ['a']], 'after a question there is no "one" to be other than: a question');
  const tied = resolveReference('the last one you worked on', model(sessions, { ledgerRows: [row('a', 300), row('b', 300)] }));
  assert.deepEqual([tied.exact, ids(tied.candidates)], [false, ['a', 'b']], 'two panes delivered in the same moment are a question');
  const gone = resolveReference('the last one you worked on', model(sessions, { ledgerRows: [row('a', 100), row('closed', 200)] }));
  assert.deepEqual([gone.exact, gone.candidates], [false, []], 'a delivery to a pane that has closed is never answered with the next best pane');
});

test('titles: the words the sentence gave, one contender or a question, a sole candidate only when nothing else was asked for', () => {
  const sessions = [live('p1', 'Add project chat section'), live('p2', 'Investigate chat section integration'), live('p3', 'Investigate ram growth and leaks')];
  const two = resolveReference('tell the agent working on the chat section to continue', model(sessions), { cwd: VIBE });
  assert.deepEqual([two.kind, two.exact, ids(two.candidates)], ['title', false, ['p1', 'p2']], 'two panes about the chat section are a question');
  const one = resolveReference('tell the agent working on ram growth to continue', model(sessions), { cwd: VIBE });
  assert.deepEqual([one.exact, one.basis, ids(one.terminals)], [true, 'title', ['p3']]);
  // A longer title keeps its score under the threshold; alone it is still the
  // pane the user named, unless the plan is compiled (no way to ask) or the
  // sentence also asks for a worker by category.
  const sole = 'tell the agent working on the ram growth audit to continue';
  const lenient = resolveReference(sole, model([sessions[2]]), { cwd: VIBE });
  assert.deepEqual([lenient.exact, lenient.score < 0.6], [true, true]);
  assert.equal(resolveReference(sole, model([sessions[2]]), { cwd: VIBE, strict: true }).exact, false, 'a compiled plan needs a real score');
  const category = resolveReference('prompt one of the codex terminals working on the ram growth audit', model([sessions[2]]), { cwd: VIBE });
  assert.deepEqual([category.exact, ids(category.named)], [true, []], 'a worker by category: assignment still reads the title, the review does not call the pane named');
  // "The agent working on X" with no titled pane still says the pane is working.
  const byState = resolveReference('tell the agent working on adding a chat section to do a deep dive', model([working('w1', 'vibeTerminal'), live('w2', 'vibeTerminal')]), { cwd: VIBE });
  assert.deepEqual([byState.basis, ids(byState.terminals)], ['working', ['w1']]);
});

test('a provider phrase is a kind of pane, unless it is definite and one pane of that family exists', () => {
  const sessions = [live('c1', 'Codex 1'), live('k1', 'Claude 1', { kind: 'claude', provider: 'claude' })];
  const definite = resolveReference('tell the codex terminal in vibeTerminal to run the tests', model(sessions), { cwd: VIBE, launchers });
  assert.deepEqual([definite.kind, definite.exact, ids(definite.terminals)], ['provider', true, ['c1']]);
  const indefinite = resolveReference('prompt a codex terminal in vibeTerminal to fix the header', model(sessions), { cwd: VIBE, launchers });
  assert.deepEqual([indefinite.kind, indefinite.exact, indefinite.indefinite], ['provider', false, true]);
  assert.equal(resolveReference('tell the codex terminal to run the tests', model([...sessions, live('c2', 'Codex 2')]), { cwd: VIBE, launchers }).exact, false, 'two of that family are a question');
});

test('a pane named word for word is named whatever else the sentence asks for; a pane named by its task words only when the sentence can carry a title', () => {
  const sessions = [live('atlas', 'Atlas', { conversationTitle: 'Atlas memory store rewrite' }), live('beta', 'Beta', { conversationTitle: 'Beta invoice rounding fix' }),
    live('cc', 'Claude Code', { kind: 'claude', provider: 'claude' })];
  const scored = resolveReference('Tell Atlas in the alpha project to inspect the memory store', model(sessions), { cwd: VIBE });
  assert.deepEqual([scored.kind, ids(scored.named)], ['none', ['atlas']]);
  const exact = resolveReference('use the empty terminal Beta invoice rounding fix to check the totals', model(sessions), { cwd: VIBE });
  assert.deepEqual([exact.kind, ids(exact.mentioned)], ['idle', ['beta']], 'an exact label is a mention whatever the sentence asks for');
  assert.deepEqual(ids(resolveReference('prompt the Claude Code terminal to review the tests', model(sessions), { cwd: VIBE, launchers }).mentioned), [], 'a provider label names no pane');
  assert.deepEqual(ids(resolveReference('Have Beta invoice rounding look at the totals', model(sessions), { cwd: VIBE }).named), ['beta']);
});

test('a context without a model gets one built from its sessions, roster, ledger and work items', () => {
  const context = { sessions: [live('p1', 'vibeTerminal')], roster: [{ id: 'p1', on: 'Fix the parser', result: 'Done.' }], ledgerRows: [row('p1', 100)] };
  const [terminal] = terminalsOf(context);
  assert.deepEqual([terminal.on, terminal.result, terminal.lastWorked?.at], ['Fix the parser', 'Done.', 100]);
  assert.equal(terminalsOf({ terminals: [] }).length, 0, 'a supplied model is used as it is');
  assert.equal(terminalsOf({}).length, 0);
});
