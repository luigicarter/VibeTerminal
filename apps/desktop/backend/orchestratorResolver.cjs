'use strict';

// Deterministic assignment resolver.
//
// Which pane a task goes to is a question about facts the application already
// holds: what each pane is called, what it runs, whether it is free, who owns
// it, and what Lina herself did a moment ago. Up to eight routing model rounds
// plus an ownership reviewer used to re-derive those facts and, in the
// September 12 failure, overrode the user's own words with app policy. This
// module answers the question in code: reuse, create, or one question naming
// the candidates. The sentence is read once, by the reference resolver
// (orchestratorReference.cjs), against the terminal model; what is left here
// is the dialogue: which reading leads to which decision, and what to ask.
//
// Pure: no model call, no store writes, no terminal effects. The caller still
// reads the chosen pane, verifies its native identity, and enforces one work
// item per pane before any task reaches it.
const { scoreCandidates, RUNNER_UP_MARGIN } = require('./orchestratorOwnerMatch.cjs');
const { deterministicNewTaskRoute } = require('./orchestratorRoutePlanner.cjs');
const { resolveReference, providerFamily, RESOLVER_STOPWORDS } = require('./orchestratorReference.cjs');
const { paneReadiness, paneDisplayName } = require('./orchestratorPaneReadiness.cjs');

// ---------------------------------------------------------------------------
// Pane facts read by the assignment stage in orchestrator.cjs. Everything here
// is already in the session registry; no model may re-derive it.
// ---------------------------------------------------------------------------
const IDLE_REUSE_REASON = 'Idle pane with no task owner; assigned to this new task.';
// A pane free for new work, as the one readiness predicate defines it.
const idlePaneCandidate = session => paneReadiness(session).free;
// Work items that still own their pane. A cancelled or failed item never
// delivered its prompt, so keeping it as an owner reserved an empty pane for
// work that will not arrive and forced a new pane beside it. Finished items keep
// their pane: that is the conversation their result lives in.
const RELEASED_STATUSES = new Set(['cancelled', 'failed']);
const ownsPaneForReuse = item => Boolean(item) && !RELEASED_STATUSES.has(item.status);
// Which panes are spoken for, asked once. Three callers used to spell this
// filter-map-compare by hand, and a pane counted as owned or free depending on
// which copy ran. `paneKey` is imported lazily: this module is required by the
// routing module it would otherwise cycle with.
const reuseOwnedPaneKeys = items => new Set((items || []).filter(ownsPaneForReuse)
  .map(item => require('./orchestratorRouting.cjs').paneKey(item.binding?.target)).filter(Boolean));
const paneReuseOwner = (items, session, exceptItemId) => {
  const { paneKey } = require('./orchestratorRouting.cjs');
  const key = paneKey(session);
  return key ? (items || []).find(item => item.id !== exceptItemId && ownsPaneForReuse(item) && paneKey(item.binding?.target) === key) : undefined;
};
const paneRecency = session => Math.max(Number(session?.lastActivityAt) || 0, Number(session?.turnEndedAt) || 0, Number(session?.turnStartedAt) || 0);
const paneLabel = session => paneDisplayName(session).slice(0, 80) || String(session?.id || 'that terminal');

// ---------------------------------------------------------------------------
// Answer handling. A routing question stored the candidates it named; the reply
// is resolved here before any other rule, so "the second one" never needs a
// model round of its own.
// ---------------------------------------------------------------------------
const ORDINALS = [[/\b(?:first|1st|number one|top)\b/i, 0], [/\b(?:second|2nd|number two)\b/i, 1], [/\b(?:third|3rd|number three)\b/i, 2]];
const AFFIRMATIVE = /\b(?:yes|yeah|yep|yup|sure|ok|okay|please do|go ahead|do it|do that|open (?:a )?new|a new one|new one|another one|create (?:a )?new|fresh one)\b/i;
const NEGATIVE = /\b(?:no|nope|don'?t|do not|never ?mind|cancel|stop|forget it)\b/i;
const BOTH = /\b(?:both|all of them|either|each of them|all three)\b/i;

// answer: { text, kind: 'candidates' | 'open-new', candidates: [{ targetId, label }],
//           kindOfSession } - the launcher the question was about, so "a brand
// new one" opens the Codex pane the question named and needs no model round.
function resolveAnswer(answer) {
  if (!answer || typeof answer.text !== 'string') return undefined;
  const text = answer.text;
  if (answer.kind === 'open-new') {
    if (NEGATIVE.test(text)) return undefined;
    if (AFFIRMATIVE.test(text)) return { decision: 'create', ...(answer.kindOfSession && { kindOfSession: answer.kindOfSession }),
      reason: 'You asked me to open a new pane for this task.' };
    return undefined;
  }
  const candidates = Array.isArray(answer.candidates) ? answer.candidates.filter(item => item && item.targetId) : [];
  if (!candidates.length) return undefined;
  if (BOTH.test(text)) return { decision: 'ask', candidates,
    question: `I can only give this task to one agent. ${candidateQuestion(candidates)}` };
  for (const [pattern, index] of ORDINALS) {
    if (pattern.test(text) && candidates[index]) return { decision: 'reuse', targetId: candidates[index].targetId, reason: 'You picked this agent from the two I named.' };
  }
  // Answering "the chat section integration one" distinguishes the candidates by
  // the extra word it carries, so the count of named words decides first and the
  // score only breaks a tie.
  const named = scoreCandidates({ instruction: text, stopwords: RESOLVER_STOPWORDS,
    candidates: candidates.map(candidate => ({ id: candidate.targetId, texts: [candidate.label] })) })
    .filter(item => item.matched >= 1).sort((left, right) => right.matched - left.matched || right.score - left.score);
  if (named.length === 1 || named.length > 1 && (named[0].matched > named[1].matched || named[0].score - named[1].score >= RUNNER_UP_MARGIN)) {
    return { decision: 'reuse', targetId: named[0].id, reason: 'You named this agent when I asked which one.', score: named[0].score };
  }
  return undefined;
}

const candidateQuestion = candidates => candidates.length === 2
  ? `Which one: ${candidates[0].label} or ${candidates[1].label}?`
  : `Which one: ${candidates.slice(0, -1).map(item => item.label).join(', ')}, or ${candidates.at(-1).label}?`;

// ---------------------------------------------------------------------------
// The resolver itself, over the terminal model.
// ---------------------------------------------------------------------------

// Returns { decision: 'reuse' | 'create' | 'ask', selector, candidateCount, ... }.
function resolveAssignment({ instruction, grant = {}, terminals = [], launchers = [], cwd, projectName, answer, defaultProvider, now } = {}) {
  const text = String(instruction ?? '');
  const scope = grant.args || {};
  const reference = resolveReference(text, terminals, { launchers, cwd, projectName: projectName || '', ...(now !== undefined && { now }) });
  const panes = reference.panes;
  const label = kind => launchers.find(item => item.kind === kind)?.label || 'coding agent';
  const project = projectName || cwd || 'this project';
  const byRecency = list => [...list].sort((left, right) => (right.activeAt || 0) - (left.activeAt || 0));
  const done = (decision, extra = {}) => ({ decision, selector: reference.kind, candidateCount: panes.length, ...extra });
  const reuse = (terminal, extra = {}) => done('reuse', { targetId: terminal.id, ...(terminal.task?.id && { workItemId: terminal.task.id }), ...extra });
  // Which launcher a new pane gets, in one order: the answer to Lina's own
  // question, then the launcher the user said, then the one the Brain planned,
  // then what this project usually starts, then the rank order. The Brain's
  // kindOfSession used to come first, which is how "can you open a new Codex
  // terminal in vibeTerminal" opened an Open Codex pane on September 16.
  const create = (reason, answeredKind) => {
    if (reference.creationForbidden) return done('ask', { question: 'You asked me not to open another terminal. Which existing terminal should I use?' });
    const kindOfSession = answeredKind || reference.provider || scope.kindOfSession;
    const route = deterministicNewTaskRoute({ scope: { ...scope, assignmentMode: 'new', ...(kindOfSession && { kindOfSession }) },
      launchers, automaticProvider: true, preferredKind: defaultProvider });
    if (!route || route.decision !== 'create') {
      return done('ask', { question: route?.text || 'Which configured coding agent should I use for this project?' });
    }
    return done('create', { kindOfSession: route.kindOfSession, reason });
  };
  // Two untitled panes in one project carry the same label; a question that
  // says "vibeTerminal or vibeTerminal?" cannot be answered, so a repeated label
  // is told apart by its provider and what it is doing.
  const namedCandidates = list => {
    const labels = list.map(terminal => String(terminal.name || '').slice(0, 80) || String(terminal.id));
    return list.map((terminal, index) => ({ targetId: terminal.id,
      label: labels.filter(item => item === labels[index]).length > 1 ? `${labels[index]} (${terminal.provider}, ${terminal.state})` : labels[index] }));
  };
  // The launcher the user said, then the one the Brain planned: the same order
  // create() uses, so the pane word and the family filter name what they open.
  const wanted = reference.provider || scope.kindOfSession;
  const family = providerFamily(wanted);
  const ofFamily = list => family ? list.filter(terminal => providerFamily(terminal.provider) === family) : list;
  const paneWord = () => wanted ? `${label(wanted)} pane` : 'pane';
  // One matching pane is the answer; several are a question naming them; none
  // is a question too, because the sentence described a pane that is not there.
  const pick = (list, reason, none) => {
    if (list.length === 1) return reuse(list[0], { reason });
    if (list.length > 1) { const named = namedCandidates(byRecency(list).slice(0, 3)); return done('ask', { question: candidateQuestion(named), candidates: named }); }
    return done('ask', { question: none, candidates: [] });
  };
  const inProject = list => list.filter(terminal => panes.includes(terminal));
  const free = () => byRecency(ofFamily(panes).filter(terminal => terminal.free));

  // 0. A reply to the question this resolver asked is resolved from the stored
  //    candidates, never re-interpreted.
  const answered = resolveAnswer(answer);
  if (answered) {
    if (answered.decision === 'create') return create(answered.reason, answered.kindOfSession);
    if (answered.decision === 'ask') return done('ask', { question: answered.question, candidates: answered.candidates });
    const terminal = panes.find(item => item.id === answered.targetId);
    if (terminal) return reuse(terminal, { reason: answered.reason, ...(answered.score !== undefined && { score: answered.score }) });
  }

  // (a) The interpreter already resolved this to a fresh conversation.
  if (scope.assignmentMode === 'new') return create('The user asked for a new conversation.');

  // (b) An explicit request to open one.
  if (reference.kind === 'new') return create('The user asked me to open a new pane for this task.');

  // (c) A handle the user said back, or the pane Lina opened a moment ago. A
  //     pane another task owns, and no retry pending, is not adopted by "the
  //     one you just opened": the request falls through to the ordinary rules.
  if (reference.kind === 'handle') {
    return pick(inProject(reference.terminals), 'The pane you named by its handle.', 'That terminal is not available in this project. Which existing terminal did you mean?');
  }
  if (reference.kind === 'just_opened' && reference.exact) {
    const created = reference.terminals[0];
    if (!created.task || created.task.retriable === true) return reuse(created, { reason: 'The pane I opened for you a moment ago.' });
  }
  if (reference.kind === 'just_opened' && !reference.exact) return done('ask', { question: `I cannot find the ${paneWord()} you said I just opened. Which existing terminal did you mean?` });

  // (c2) A pane described by what it is doing. Working includes waiting on the
  //      user: the turn is still that pane's, and a follow-up queues behind it.
  if (reference.kind === 'working' || reference.kind === 'done') {
    return pick(inProject(reference.candidates),
      reference.kind === 'working' ? 'The pane that is working right now.' : 'The pane that finished its last task.',
      reference.kind === 'working' ? `No ${paneWord()} is working in ${project} right now. Which one did you mean?`
        : `No ${paneWord()} has finished a task in ${project}. Which one did you mean?`);
  }
  // (c3) The pane Lina last typed into, and the one that is not it.
  if (reference.kind === 'last_target') {
    if (reference.exact) return reuse(reference.terminals[0], { reason: 'The pane I last typed into.' });
    return done('ask', { question: `I have not typed into a pane in ${project} yet. Which one did you mean?`, candidates: [] });
  }
  if (reference.kind === 'other') {
    // Only a delivery that is the latest thing in the ledger anchors "the
    // other one"; after a question or an answer it is a guess, so it asks.
    if (!reference.fresh) {
      const named = namedCandidates(byRecency(ofFamily(panes)).slice(0, 3));
      return done('ask', { question: candidateQuestion(named), candidates: named });
    }
    return pick(inProject(reference.candidates), 'The pane other than the one I last used.',
      `I only see one ${paneWord()} in ${project}. Which one did you mean?`);
  }

  // A definite provider reference names an existing conversation, even while
  // it is busy or already owns work. It must never fall through to creation.
  // With no pane of that kind open at all, the sentence describes a pane that is
  // not there: "Which existing Codex pane did you mean?" has no answer, so the
  // question asks the one thing left to decide and carries the launcher with it.
  if (reference.kind === 'provider' && reference.definiteProvider && !reference.indefiniteProvider && !reference.named.length) {
    if (!reference.candidates.length) {
      return done('ask', { question: `No ${paneWord()} is open in ${project}. Open a new one?`, candidates: [],
        answerKind: 'open-new', ...(wanted && { kindOfSession: wanted }) });
    }
    return pick(reference.candidates, 'The existing terminal you named.', `Which existing ${paneWord()} did you mean in ${project}?`);
  }

  // (d) A pane the user named by its task, or a continuation the interpreter
  //     marked as belonging to an existing agent.
  if (reference.kind === 'title' || scope.assignmentMode === 'existing') {
    // Busy panes are eligible: a follow-up to a working agent queues behind it.
    // Ask only when two named candidates actually remain.
    const titled = reference.kind === 'title' && reference.basis !== 'working' ? reference.candidates : reference.scored;
    if (titled.length === 1) return reuse(titled[0], { score: reference.score, reason: `Its title matches the task you named in ${project}.` });
    if (titled.length > 1) { const named = namedCandidates(byRecency(titled).slice(0, 3)); return done('ask', { question: candidateQuestion(named), candidates: named, score: reference.score }); }
    // "The agent working on the chat section" names a pane that was started by
    // hand and carries no title. What the sentence still says is that the pane
    // is working, and when exactly one pane is, that is the pane; two are a
    // question, and none is new work as before.
    if (reference.kind === 'title' && reference.working && !reference.eligible.length) {
      const working = inProject(reference.candidates);
      if (working.length === 1) return reuse(working[0], { reason: 'The one pane working right now; its title does not say what on.' });
      if (working.length > 1) { const named = namedCandidates(byRecency(working).slice(0, 3)); return done('ask', { question: candidateQuestion(named), candidates: named }); }
    }
    if (scope.assignmentMode === 'existing') {
      // "Prompt the codex terminal that's not doing anything" planned as a
      // continuation still names an idle pane; a free one is the answer, not
      // a question about which agent to continue.
      if (reference.kind === 'idle' && free().length) return reuse(free()[0], { reason: IDLE_REUSE_REASON });
      // "And tell it to write that up" right after a prompt went somewhere:
      // "it" is the pane Lina last typed into here, not a question.
      const last = reference.pronoun && panes.find(terminal => terminal.lastWorked);
      if (last) return reuse(last, { continuation: true, reason: 'The pane I last typed into; the sentence says "it".' });
      const recent = byRecency(panes).slice(0, 3);
      if (!recent.length) return done('ask', { question: `I do not see an agent in ${project} to continue. Should I open one?`, candidates: [], answerKind: 'open-new' });
      const named = namedCandidates(recent);
      return done('ask', { question: `Which agent should continue? In ${project} I see: ${named.map(item => item.label).join(', ')}.`, candidates: named });
    }
  }

  // (d2) "Prompt it…": the pane Lina last typed into, busy or not (a follow-up
  //      queues behind its turn). With no delivery on record to be "it", a
  //      question, never a free pane: on the ladder that guess went into the
  //      spare pane.
  if (reference.kind === 'none' && reference.pronoun) {
    if (reference.exact) return reuse(reference.terminals[0], { continuation: true, reason: 'The pane I last typed into; the sentence says "it".' });
    return done('ask', { question: `I have not typed into a pane in ${project} yet. Which one did you mean?`, candidates: [] });
  }

  // (e) An explicit request for an idle pane.
  if (reference.kind === 'idle') {
    if (free().length) return reuse(free()[0], { reason: IDLE_REUSE_REASON });
    return done('ask', { question: `No idle ${label(wanted)} pane is free in ${project}. Open a new one?`, answerKind: 'open-new', ...(wanted && { kindOfSession: wanted }) });
  }

  // (f) A provider, or nothing at all. An unowned idle pane is reusable for new
  //     work; opening a second pane beside an empty one is the failure this
  //     resolver exists to stop.
  if (free().length) return reuse(free()[0], { reason: IDLE_REUSE_REASON });
  return create(reference.provider ? `No idle ${label(wanted)} pane is free in ${project}.` : `No idle pane is free in ${project}.`);
}

module.exports = { resolveAssignment, resolveAnswer, paneLabel, candidateQuestion,
  idlePaneCandidate, ownsPaneForReuse, reuseOwnedPaneKeys, paneReuseOwner, paneRecency, IDLE_REUSE_REASON };
