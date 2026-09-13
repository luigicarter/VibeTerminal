'use strict';

// Deterministic assignment resolver.
//
// Which pane a task goes to is a question about facts the application already
// holds: pane titles, provider, idle/busy, who owns which work item, and what
// Lina herself did a moment ago. Up to eight routing model rounds plus an
// ownership reviewer used to re-derive those facts and, in the September 12
// failure, overrode the user's own words with app policy. This module answers
// the question in code: reuse, create, or one question naming the candidates.
//
// Pure apart from the readers handed in: no model call, no store writes, no
// terminal effects. The caller still reads the chosen pane, verifies its native
// identity, and enforces one work item per pane before any task reaches it.
const { scoreCandidates, STOPWORDS, MIN_SCORE, MIN_MATCHED_TOKENS, RUNNER_UP_MARGIN } = require('./orchestratorOwnerMatch.cjs');
const { deterministicNewTaskRoute } = require('./orchestratorRoutePlanner.cjs');

// ---------------------------------------------------------------------------
// Pane facts. Everything here is already in the session registry; no model may
// re-derive it.
// ---------------------------------------------------------------------------

// "Use one of the empty terminals" is an instruction, not a hint. An idle pane
// that no work item owns is exactly what the user means by empty, so it takes
// new work: deterministically, with no reviewer call and no additional pane.
// Two tiers, scored against the saved utterances. Strong is an explicit request
// for an idle pane: honour it, and ask rather than silently opening another one.
// Weak only mentions availability near a pane noun ("a terminal that's free"
// inside a longer sentence): prefer an idle pane if one exists, else create as
// usual. A relative clause counts only when it hangs off a pane noun, so "fix
// the login page that is not working" stays a task description, and bare "free"
// ("when the hands free is unavailable") selects nothing at all.
const PANE_NOUN = String.raw`(?:terminals?|panes?|agents?|sessions?)`;
const IDLE_PANE_STRONG = new RegExp([
  String.raw`\b(?:empty|idle|unused|not busy|not doing anything|clearly free)\b`,
  // The relative clause may sit in the next sentence: speech punctuates "put it
  // in the Codex terminal. That's not working." exactly like one sentence.
  String.raw`\b(?:one|${PANE_NOUN})\b[^?!]{0,12}\b(?:that['’]?s|that is|which is) (?:free|not (?:currently )?working)\b`,
].join('|'), 'i');
const IDLE_PANE_WEAK = new RegExp([
  String.raw`\b(?:not (?:currently )?working|free|available)\b[^.?!]{0,25}\b${PANE_NOUN}\b`,
  String.raw`\b${PANE_NOUN}\b[^.?!]{0,25}\b(?:not (?:currently )?working|free|available)\b`,
  // "one of the Codex terminals" means any of them, idle preferred: a hint, not
  // the explicit idle request that asks before opening another pane.
  String.raw`\bone of the (?:\w+ ){0,3}${PANE_NOUN}\b`,
].join('|'), 'i');
const idlePaneRequest = text => IDLE_PANE_STRONG.test(text) ? 'strong' : IDLE_PANE_WEAK.test(text) ? 'weak' : undefined;
const IDLE_REUSE_REASON = 'Idle pane with no task owner; assigned to this new task.';
const PROVIDER_FAMILY = { 'claude-custom': 'claude', 'kimi-custom': 'kimi' };
const providerFamily = kind => PROVIDER_FAMILY[kind] || kind;
function idlePaneCandidate(session) {
  return Boolean(session) && session.observation === 'observed' && session.started !== false &&
    ['idle', 'completed'].includes(session.turnState) && session.processState === 'running' &&
    !session.pendingInteraction && !session.pendingInput && !session.manualInputPending && !session.interactionInputPending;
}
const paneRecency = session => Math.max(Number(session?.lastActivityAt) || 0, Number(session?.turnEndedAt) || 0, Number(session?.turnStartedAt) || 0);

// ---------------------------------------------------------------------------
// Selector extraction. Deterministic, over the normalized instruction (wave 1
// has already turned "cloud code" into "Claude Code" and "codec" into "Codex").
// ---------------------------------------------------------------------------

// A pane the user is pointing at ("that new terminal you just opened") is never
// a request to open another one, so this is tested before the creation pattern:
// the definite article separates "the new codex terminal" (the one from a moment
// ago) from "a new codex terminal" (open one).
const JUST_OPENED = new RegExp([
  String.raw`\b(?:you )?just (?:opened|created|made|started|spawned|launched)\b`,
  String.raw`\bthat new (?:\w+ ){0,2}${PANE_NOUN}\b`,
  String.raw`\bthe new (?:\w+ ){0,2}${PANE_NOUN}\b`,
].join('|'), 'i');
// Creation verbs only count in the request itself. "when I spawn a new terminal"
// and "the terminal actually only opens once I go in the pane" describe the bug
// being reported, so a verb owned by a subject or a subordinate clause is not a
// request to create anything.
const CLAUSE = String.raw`(?<!\b(?:i|we|they|it|he|she|when|while|if|where|because|after|before|since|that|which|who|whenever|until)\s)`;
// A bare "another codex terminal" only asks for a pane when it sits in the
// request itself, near the start of its sentence or right after "can you".
const REQUEST_HEAD = String.raw`(?:^|[.?!]\s*|\b(?:can you|could you|would you|please|want you to|go ahead and)\s+)`;
const NEW_PANE = new RegExp([
  String.raw`${CLAUSE}\b(?:open|start|spawn|create|launch|make)\b[^.?!]{0,30}\b(?:new|another)\b[^.?!]{0,30}\b${PANE_NOUN}\b`,
  String.raw`${CLAUSE}\b(?:open|start|spawn|create|launch|make)\s+(?:an?\s+|the\s+)?(?:\w+\s+){0,2}${PANE_NOUN}\b`,
  String.raw`${REQUEST_HEAD}[^.?!]{0,40}?\b(?:new|another)\s+(?:\w+\s+){0,2}${PANE_NOUN}\b`,
].join('|'), 'i');

const QUOTED = /["“”]([^"“”]{3,80})["“”]/g;
const TOPIC_PHRASE = String.raw`[\s.,:;-]*([^.?!]{3,90}?)(?=\s*(?:,|\.|\?|!|\bto\b|\band\b|$))`;
const NAMED_TOPIC = new RegExp(String.raw`\b(?:working on|worked on|titled|called|named)\b${TOPIC_PHRASE}`, 'gi');
const THE_TITLED_PANE = new RegExp(String.raw`\bthe\s+((?:[\p{L}\p{N}]+\s+){1,4}?)${PANE_NOUN}\b`, 'giu');
// "about" is the weakest marker ("There's a chat about..."), so it is consulted
// only after the explicit ones have found nothing.
const ABOUT_TOPIC = new RegExp(String.raw`\babout\b${TOPIC_PHRASE}`, 'gi');
const CLAUSE_WORD = /\b(?:when|where|while|because|which|who|but|so|that|if)\b/i;

// Vocabulary that describes how a pane should be chosen rather than what it is
// working on. Kept out of the title words so "the new codex terminal" and "put
// in that prompt" cannot score against a task title.
const SELECTION_WORDS = ['new', 'newer', 'newest', 'empty', 'idle', 'free', 'busy', 'open', 'opened', 'opens', 'opening',
  'create', 'created', 'creates', 'creating', 'start', 'started', 'starts', 'starting', 'spawn', 'spawned', 'spawning',
  'launch', 'launched', 'make', 'makes', 'made', 'put', 'puts', 'putting', 'send', 'sends', 'sent', 'prompt', 'prompts',
  'prompted', 'prompting', 'currently', 'right', 'please', 'okay', 'yeah', 'yes', 'thank', 'thanks', 'hey', 'able',
  'really', 'like', 'look', 'looks', 'see', 'seen', 'say', 'says', 'said', 'give', 'gives', 'given', 'was', 'were',
  'last', 'next', 'first', 'second', 'third', 'currently', 'actually', 'something', 'anything', 'everything'];
const RESOLVER_STOPWORDS = new Set([...STOPWORDS, ...SELECTION_WORDS]);

const tokenize = value => (String(value ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(word => word.length >= 3);
const meaningful = text => tokenize(text).filter(word => !RESOLVER_STOPWORDS.has(word));

// Providers the user can name. Values are launcher kinds; the caller supplies
// the live launcher catalog so a configured custom launcher is named too.
const PROVIDER_PATTERNS = [
  [/\bcodex web\b/i, 'codex-web'], [/\bopen codex\b/i, 'open-codex'], [/\bcodex\b/i, 'codex'],
  [/\bclaude code\b|\bclaude\b/i, 'claude'], [/\bgemini\b/i, 'gemini'], [/\bqwen\b/i, 'qwen'],
  [/\bkimi\b/i, 'kimi'], [/\bcursor\b/i, 'cursor'], [/\bgrok\b/i, 'grok'],
  [/\bopen ?fusion\b/i, 'openfusion'], [/\bfusion\b/i, 'fusion'], [/\bopencode\b/i, 'opencode'],
];

function namedProvider(instruction, launchers = []) {
  for (const launcher of launchers) {
    const label = String(launcher?.label ?? '').trim();
    if (label.length >= 4 && new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(instruction)) return launcher.kind;
  }
  for (const [pattern, kind] of PROVIDER_PATTERNS) if (pattern.test(instruction)) return kind;
  return undefined;
}

// Returns { kind, words, provider?, text? }. `kind` is one of
// 'new' | 'idle' | 'just_opened' | 'title' | 'provider' | 'none'.
function extractSelector(instruction, { launchers = [] } = {}) {
  const text = String(instruction ?? '');
  const provider = namedProvider(text, launchers);
  const base = provider ? { provider } : {};
  if (JUST_OPENED.test(text)) return { kind: 'just_opened', words: [], ...base };
  if (idlePaneRequest(text) === 'strong') return { kind: 'idle', words: [], ...base };
  if (NEW_PANE.test(text)) return { kind: 'new', words: [], ...base };
  const title = titlePhrase(text);
  if (title) return { kind: 'title', words: title.words, text: title.text, ...base };
  if (provider) return { kind: 'provider', words: [], provider };
  return { kind: 'none', words: [] };
}

// Speech repeats itself ("There's a chat about... There's an agent working on...
// chat section"), so every occurrence of each pattern is considered, strongest
// pattern first, and the first phrase carrying two distinctive words wins.
function titlePhrase(text) {
  for (const [pattern, guard] of [[QUOTED, false], [NAMED_TOPIC, false], [THE_TITLED_PANE, true], [ABOUT_TOPIC, false]]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const phrase = String(match[1] || '').trim();
      // A span crossing a subordinate clause is a sentence, not a title.
      if (guard && CLAUSE_WORD.test(phrase)) continue;
      const words = meaningful(phrase);
      if (words.length >= MIN_MATCHED_TOKENS) return { words, text: phrase };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Answer handling. A routing question stored the candidates it named; the reply
// is resolved here before any other rule, so "the second one" never needs a
// model round of its own.
// ---------------------------------------------------------------------------
const ORDINALS = [[/\b(?:first|1st|number one|top)\b/i, 0], [/\b(?:second|2nd|number two)\b/i, 1], [/\b(?:third|3rd|number three)\b/i, 2]];
const AFFIRMATIVE = /\b(?:yes|yeah|yep|yup|sure|ok|okay|please do|go ahead|do it|do that|open (?:a )?new|a new one|new one|another one|create (?:a )?new|fresh one)\b/i;
const NEGATIVE = /\b(?:no|nope|don'?t|do not|never ?mind|cancel|stop|forget it)\b/i;
const BOTH = /\b(?:both|all of them|either|each of them|all three)\b/i;

// answer: { text, kind: 'candidates' | 'open-new', candidates: [{ targetId, label }] }
function resolveAnswer(answer) {
  if (!answer || typeof answer.text !== 'string') return undefined;
  const text = answer.text;
  if (answer.kind === 'open-new') {
    if (NEGATIVE.test(text) && !AFFIRMATIVE.test(text)) return undefined;
    if (AFFIRMATIVE.test(text)) return { decision: 'create', reason: 'You asked me to open a new pane for this task.' };
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

const paneLabel = session => {
  const name = String(session?.conversationTitle || session?.conversation?.title || session?.name || session?.id || '').trim();
  return name.replace(/\s+/g, ' ').slice(0, 80) || String(session?.id || 'that terminal');
};
const candidateQuestion = candidates => candidates.length === 2
  ? `Which one: ${candidates[0].label} or ${candidates[1].label}?`
  : `Which one: ${candidates.slice(0, -1).map(item => item.label).join(', ')}, or ${candidates.at(-1).label}?`;

// ---------------------------------------------------------------------------
// The resolver itself.
// ---------------------------------------------------------------------------

function paneTexts(session, workItem) {
  return [session?.conversationTitle, session?.conversation?.title, session?.name,
    ...(Array.isArray(session?.aliases) ? session.aliases : []),
    (workItem?.title || '').slice(0, 200), (workItem?.objective || workItem?.text || '').slice(0, 200)];
}

function resolveAssignment({ instruction, grant = {}, sessions = [], workItems = [], history, launchers = [],
  cwd, projectName, answer, sameCwd } = {}) {
  const text = String(instruction ?? '');
  const scope = grant.args || {};
  const same = typeof sameCwd === 'function' ? sameCwd : (a, b) => Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase());
  const panes = (Array.isArray(sessions) ? sessions : []).filter(session => session && same(session.cwd, cwd) &&
    (session.provider || session.kind) !== 'terminal' && (session.provider || session.kind) !== 'shell');
  const items = Array.isArray(workItems) ? workItems.filter(Boolean) : [];
  const ownerOf = new Map();
  for (const item of items) { const id = item.binding?.target?.id; if (id && !ownerOf.has(id)) ownerOf.set(id, item); }
  const selector = extractSelector(text, { launchers });
  const label = kind => launchers.find(item => item.kind === kind)?.label || 'coding agent';
  const project = projectName || cwd || 'this project';
  const byRecency = list => [...list].sort((left, right) => paneRecency(right) - paneRecency(left));
  const done = (decision, extra = {}) => ({ decision, selector: selector.kind, candidateCount: panes.length, ...extra });
  const create = reason => {
    const route = deterministicNewTaskRoute({ scope: { ...scope, assignmentMode: 'new', ...(selector.provider && !scope.kindOfSession && { kindOfSession: selector.provider }) },
      launchers, automaticProvider: true });
    if (!route || route.decision !== 'create') {
      return done('ask', { question: route?.text || 'Which configured coding agent should I use for this project?' });
    }
    return done('create', { kindOfSession: route.kindOfSession, reason });
  };
  const namedCandidates = list => list.map(session => ({ targetId: session.id, label: paneLabel(session) }));
  const idleUnowned = family => byRecency(panes.filter(session => idlePaneCandidate(session) && !ownerOf.has(session.id) &&
    (!family || providerFamily(session.provider || session.kind) === family)));

  // 0. A reply to the question this resolver asked is resolved from the stored
  //    candidates, never re-interpreted.
  const answered = resolveAnswer(answer);
  if (answered) {
    if (answered.decision === 'create') return create(answered.reason);
    if (answered.decision === 'ask') return done('ask', { question: answered.question, candidates: answered.candidates });
    const session = panes.find(item => item.id === answered.targetId);
    if (session) return done('reuse', { targetId: session.id, workItemId: ownerOf.get(session.id)?.id, reason: answered.reason, ...(answered.score !== undefined && { score: answered.score }) });
  }

  // (a) The interpreter already resolved this to a fresh conversation.
  if (scope.assignmentMode === 'new') return create('The user asked for a new conversation.');

  // (b) An explicit request to open one.
  if (selector.kind === 'new') return create('The user asked me to open a new pane for this task.');

  // (c) The pane Lina opened a moment ago.
  if (selector.kind === 'just_opened') {
    const created = history?.lastCreatedPane?.({ cwd });
    const owner = created && ownerOf.get(created.id);
    if (created && (!owner || owner.retriable === true)) {
      return done('reuse', { targetId: created.id, workItemId: owner?.id, reason: 'The pane I opened for you a moment ago.' });
    }
  }

  // (d) A pane the user named by its task, or a continuation the interpreter
  //     marked as belonging to an existing agent.
  if (selector.kind === 'title' || scope.assignmentMode === 'existing') {
    // Busy panes are eligible: a follow-up to a working agent queues behind it.
    const scored = scoreCandidates({ instruction: selector.words.length ? selector.words : text, projectName: project,
      stopwords: RESOLVER_STOPWORDS, perText: true,
      candidates: panes.map(session => ({ id: session.id, texts: paneTexts(session, ownerOf.get(session.id)) })) });
    const eligible = scored.filter(item => item.matched >= MIN_MATCHED_TOKENS);
    // Ask only when two named candidates actually remain. A sole pane whose
    // title carries the words the user said is the answer even when a longer
    // title keeps its score under the threshold; a second close title is not.
    if (eligible.length && (eligible[0].score >= MIN_SCORE || eligible.length === 1)) {
      const best = eligible[0];
      const contenders = eligible.filter(item => item.score > best.score - RUNNER_UP_MARGIN);
      if (contenders.length === 1) {
        const session = panes.find(item => item.id === best.id);
        return done('reuse', { targetId: session.id, workItemId: ownerOf.get(session.id)?.id, score: best.score,
          reason: `Its title matches the task you named in ${project}.` });
      }
      const named = namedCandidates(byRecency(contenders.map(item => panes.find(pane => pane.id === item.id)).filter(Boolean)).slice(0, 3));
      return done('ask', { question: candidateQuestion(named), candidates: named, score: best.score });
    }
    if (scope.assignmentMode === 'existing') {
      const recent = byRecency(panes).slice(0, 3);
      if (!recent.length) return done('ask', { question: `I do not see an agent in ${project} to continue. Should I open one?`, candidates: [], answerKind: 'open-new' });
      const named = namedCandidates(recent);
      return done('ask', { question: `Which agent should continue? In ${project} I see: ${named.map(item => item.label).join(', ')}.`, candidates: named });
    }
  }

  // (e) An explicit request for an idle pane.
  if (selector.kind === 'idle') {
    const family = providerFamily(scope.kindOfSession || selector.provider);
    const free = idleUnowned(family);
    if (free.length) return done('reuse', { targetId: free[0].id, reason: IDLE_REUSE_REASON });
    return done('ask', { question: `No idle ${label(scope.kindOfSession || selector.provider)} pane is free in ${project}. Open a new one?`, answerKind: 'open-new' });
  }

  // (f) A provider, or nothing at all. An unowned idle pane is reusable for new
  //     work; opening a second pane beside an empty one is the failure this
  //     resolver exists to stop.
  const family = providerFamily(scope.kindOfSession || selector.provider);
  const free = idleUnowned(family);
  if (free.length) return done('reuse', { targetId: free[0].id, reason: IDLE_REUSE_REASON });
  return create(selector.provider ? `No idle ${label(scope.kindOfSession || selector.provider)} pane is free in ${project}.`
    : `No idle pane is free in ${project}.`);
}

module.exports = { extractSelector, resolveAssignment, resolveAnswer, paneLabel, candidateQuestion,
  idlePaneRequest, idlePaneCandidate, paneRecency, providerFamily, IDLE_REUSE_REASON, RESOLVER_STOPWORDS };
