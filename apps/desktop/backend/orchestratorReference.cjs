'use strict';

// The one reader of "which pane" in a sentence.
//
// "The empty one", "that new terminal you just opened", "the Codex terminal
// that's currently working", "both that are done", "the one you just prompted",
// "the other one", "the agent working on the chat section", "T3": every such
// reference is read here, once, against the terminal model
// (orchestratorTerminalModel.cjs), and the answer travels with the request.
// Assignment, the target review, the command compiler and the intent normalizer
// each used to extract a selector of their own and re-derive the pane from
// sessions, receipts and the ledger; where the four readings disagreed a
// request asked a question it did not need or typed into the wrong pane.
// docs/orchestrator-terminal-model-overhaul-2026-09-15.md, section 4.2.
//
// Two layers. readReference(text) is the grammar: what kind of reference the
// sentence makes and the facts it states (provider, title words, a fan-out, a
// worker asked for by category). resolveReference(text, terminals) applies the
// reading to the model and says which panes it means: `terminals` when the
// sentence is exact against the model, `candidates` when it is not, `named`
// for the panes whose own words the sentence carries. Pure: no model call, no
// store, no terminal.
const { scoreCandidates, STOPWORDS, MIN_SCORE, MIN_MATCHED_TOKENS, RUNNER_UP_MARGIN } = require('./orchestratorOwnerMatch.cjs');
const { buildTerminalModel, createTerminalHandles, sameFolder } = require('./orchestratorTerminalModel.cjs');

// ---------------------------------------------------------------------------
// Grammar. Deterministic, over the normalized instruction (wave 1 has already
// turned "cloud code" into "Claude Code" and "codec" into "Codex").
// ---------------------------------------------------------------------------

const PANE_NOUN = String.raw`(?:terminals?|panes?|agents?|sessions?|workers?)`;
const PROVIDER_WORD = String.raw`(?:codex|claude|gemini|qwen|kimi|cursor|grok|opencode|open ?fusion|fusion|open ?codex)`;

// "Use one of the empty terminals" is an instruction, not a hint. Two tiers,
// scored against the saved utterances. Strong is an explicit request for an
// idle pane: honour it, and ask rather than silently opening another one. Weak
// only mentions availability near a pane noun ("a terminal that's free" inside
// a longer sentence): prefer an idle pane if one exists, else create as usual.
// A relative clause counts only when it hangs off a pane noun, so "fix the
// login page that is not working" stays a task description, and bare "free"
// ("when the hands free is unavailable") selects nothing at all.
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

// A handle the user says back: "T3", "t-3". Handles are the model's own names
// for panes and the most explicit reference there is, so they are read first.
const HANDLE = /\b[Tt]-?(\d{1,6})\b/;
// Words supplied to the worker describe its task, not which pane Lina should
// create. Keep the target clause separate from that payload.
function referenceText(instruction) {
  const text = String(instruction ?? '');
  const boundary = /(?:^|[.!?]\s*)(?:(?:can|could|would|will) you\s+|please\s+|and\s+)?(?:tell|ask|prompt|have|get|remind|use)\s+(?:the\s+|that\s+|this\s+)?(?:it\b|[Tt]-?\d{1,6}\b|[^.!?]*?\b(?:terminal|pane|agent|session|worker)\b)[^.!?]*?\s+to\s+/i.exec(text);
  return boundary ? text.slice(0, boundary.index + boundary[0].length - 4) : text;
}
const NO_CREATION = /\b(?:do\s+not|don['’]?t|never)\s+(?:open|create|spawn|launch|start)\b[^.!?]{0,40}\b(?:terminals?|panes?|agents?|sessions?|workers?|ones?)\b/i;
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
const CLAUSE = String.raw`(?<!\b(?:i|we|they|it|he|she|when|while|if|where|because|after|before|since|that|which|who|whenever|until|to)\s)`;
// A bare "another codex terminal" only asks for a pane when it sits in the
// request itself, near the start of its sentence or right after "can you".
const REQUEST_HEAD = String.raw`(?:^|[.?!]\s*|\b(?:can you|could you|would you|please|want you to|go ahead and)\s+)`;
// "Another", "a fresh one", "a separate agent": the user asking for a worker of
// their own rather than whatever is free.
const FRESH = String.raw`(?:new|another|fresh|separate|independent|one more)`;
const NEW_PANE = new RegExp([
  String.raw`${CLAUSE}\b(?:open|start|spawn|create|launch|make)\b[^.?!]{0,30}\b${FRESH}\b[^.?!]{0,30}\b${PANE_NOUN}\b`,
  String.raw`${CLAUSE}\b(?:open|start|spawn|create|launch|make)\s+(?:an?\s+|the\s+)?(?:\w+\s+){0,2}${PANE_NOUN}\b`,
  String.raw`${REQUEST_HEAD}[^.?!]{0,40}?\b${FRESH}\s+(?:\w+\s+){0,2}${PANE_NOUN}\b`,
].join('|'), 'i');
const REUSE_ANOTHER = new RegExp(String.raw`\b(?:use|(?:put|send)\s+(?:it|that)\s+(?:in|into|to))\s+another\s+(?:\w+\s+){0,2}${PANE_NOUN}\b`, 'i');
// Panes described by what they are doing rather than by a title. "The terminal
// working on X" is a title, which is why the working word may not be followed
// by "on"; and "you couldn't prompt a terminal while it's currently working"
// describes a bug, which is why the pane must be definite ("the", "that",
// "both") and the clause a relative one.
const STATE_CLAUSE = String.raw`(?:that['’]?s|that is|that['’]?re|that are|which is|which are|who is|who are)`;
const DEFINITE_PANE = String.raw`\b(?:the|that|this|both|all|every|each|my|our|your)\s+(?:\w+\s+){0,2}(?:${PANE_NOUN}|ones?)\b`;
const WORKING_PANE = new RegExp([
  String.raw`${DEFINITE_PANE}[^.?!]{0,16}\b${STATE_CLAUSE}\s+(?:(?:currently|still|now)\s+)?(?!not\b)(?:working|busy|running|active)\b(?!\s+on\b)`,
  String.raw`\b(?:the|that|this)\s+(?:\w+\s+){0,2}(?:busy|working|active|running)\b(?!\s+on\b)\s+(?:\w+\s+){0,2}(?:${PANE_NOUN}|one)\b`,
  // "The codex terminal in lina web app is waiting on something": a pane whose
  // turn is not free, described in a main clause. Waiting is working's state
  // for every reader here (the turn is still that pane's), and "on something"
  // is what it waits on, not a title.
  String.raw`${DEFINITE_PANE}[^.?!]{0,24}\b(?:is|${STATE_CLAUSE})\s+(?:(?:currently|still|now)\s+)?(?:waiting|stuck|blocked)\b`,
].join('|'), 'i');
const DONE_PANE = new RegExp([
  String.raw`${DEFINITE_PANE}[^.?!]{0,16}\b${STATE_CLAUSE}\s+(?:(?:currently|already|now)\s+)?(?:done|finished|completed|complete)\b`,
  String.raw`\b(?:the|that|this|both|all)\s+(?:\w+\s+){0,2}(?:done|finished|completed)\s+(?:\w+\s+){0,2}(?:${PANE_NOUN}|ones?)\b`,
].join('|'), 'i');
// The pane Lina last typed into.
const LAST_TARGET_PHRASE = new RegExp([
  String.raw`\b(?:that|the)\s+last\s+(?:\w+\s+){0,3}(?:terminals?|panes?|agents?|sessions?|ones?)\b`,
  String.raw`\bthe\s+last\s+one\b`,
  String.raw`\b(?:you|we)\s+(?:just\s+)?(?:worked|were\s+working)\s+on\b`,
  String.raw`\bthe\s+one\s+you\s+just\s+(?:prompted|worked\s+on|used|sent)\b`,
].join('|'), 'i');
const OTHER_PANE = new RegExp(String.raw`\bthe other (?:\w+ ){0,2}(?:${PANE_NOUN}|one)\b`, 'i');
// A follow-up whose only pane reference is "it": "and tell it to…", "have it
// also…", "ask it whether…". Read with the pane Lina last typed into.
// Speech leaves filler and false starts before the verb ("voices, voices, can
// you prompt it…"), so the verb is looked for anywhere ahead of which no pane
// noun has been said: "open a terminal and have it…" names the new pane, not
// the last one.
const PRONOUN_CONTINUATION = /^(?:(?!\b(?:terminals?|panes?|agents?|sessions?|workers?)\b).)*?\b(?:tell|ask|have|get|let|make|prompt|remind)\s+it\b/is;
// A sentence that means more than one pane says so: a group word, or the plural
// pronoun that stands for the group it just named.
const FAN_OUT = /\b(?:all|both|every|each|everything|them|those|these)\b/i;
// "Have every Codex in Alpha review the last changes" selects a whole group.
const ALL_MATCHING = new RegExp(String.raw`\b(?:all|every|each|both)\s+(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:\w+\s+){0,3}(?:${PANE_NOUN}|${PROVIDER_WORD}|them|those|these)\b`, 'iu');
// A reference back to a pane already in play: the previous exchange's pane is
// an implicit target, so it only carries a follow-up that actually points at it.
const DEICTIC = new RegExp([
  String.raw`\b(?:it|its|there|them|they)\b`,
  String.raw`\b(?:that|this|those|these|the same)\s+(?:\w+\s+){0,2}(?:${PANE_NOUN}|one|ones|conversations?|chats?|thing)\b`,
  String.raw`\b(?:tell|ask|prompt|have|let|remind|send)\s+(?:that|this|them|those|him|her)\b`,
].join('|'), 'iu');
// "Prompt a Codex terminal in Alpha to fix Y" names a provider and a project,
// never a conversation, even when exactly one Codex is open: the article is the
// difference between the pane that exists and any pane of that kind. A sentence
// asking for a worker by category is assignment's question, not a selection.
const INDEFINITE_WORKER = new RegExp(String.raw`\b(?:a|an|another|some|any)\s+(?:\w+\s+){0,2}(?:${PANE_NOUN}|${PROVIDER_WORD})\b`, 'iu');
const INDEFINITE_PROVIDER = new RegExp(String.raw`\b(?:a|an|another|some|any)\s+(?:\w+\s+){0,2}${PROVIDER_WORD}\b`, 'iu');
const GROUP_PHRASE = new RegExp(String.raw`\b(?:one|any|either|each|all)\s+of\s+(?:the\s+|your\s+|my\s+)?(?:\w+\s+){0,3}(?:${PANE_NOUN}|them|those|these)\b`, 'iu');
const CATEGORY_PANE = new RegExp(String.raw`\b(?:random|idle|free|available|spare|new|fresh)\s+(?:\w+\s+){0,2}${PANE_NOUN}\b`, 'iu');
// A group of existing panes the sentence reaches into ("one of the open
// terminals", "any of the idle agents", "all the Codex terminals"): every pane
// in every project is then eligible for the Brain's roster, behind the
// addressed project's own. An eligibility anchor, never a task-intent parser.
const GROUP_REFERENCE = new RegExp(String.raw`\b(?:one of|any of|either of|all|every|random|idle|available|free|existing|(?:the|currently) open)\s+(?:(?:[\w-]+)\s+){0,3}(?:${PANE_NOUN}|${PROVIDER_WORD}|them|those|these)\b`, 'iu');
// "The Codex terminal in Alpha" points at a pane; "my Codex session usage" and
// "a Codex" do not. Only a definite pane reference may select the single pane
// of that family.
const DEFINITE_PROVIDER = new RegExp([
  String.raw`\b(?:the|that|this)\s+(?:\w+\s+){0,2}${PROVIDER_WORD}\b`,
  String.raw`\b${PROVIDER_WORD}\s+in\s+`,
].join('|'), 'iu');

const STATE_KINDS = new Set(['working', 'done']);
const WORKING_STATES = new Set(['working', 'waiting']);
const DONE_STATES = new Set(['done']);
// The kinds whose sentence may still carry a pane's own words.
const NAMEABLE_KINDS = new Set(['title', 'provider', 'none', 'last_target', 'other']);
// "That new terminal you just opened" reaches back this far.
const OPENED_WINDOW_MS = 30 * 60 * 1000;

// Titles. Speech repeats itself ("There's a chat about... There's an agent
// working on... chat section"), so every occurrence of each pattern is
// considered, strongest pattern first, and the first phrase carrying two
// distinctive words wins.
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

function titlePhrase(text) {
  for (const [pattern, guard] of [[QUOTED, false], [NAMED_TOPIC, false], [THE_TITLED_PANE, true], [ABOUT_TOPIC, false]]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const phrase = String(match[1] || '').trim();
      // A span crossing a subordinate clause is a sentence, not a title.
      if (guard && CLAUSE_WORD.test(phrase)) continue;
      const words = meaningful(phrase);
      // "working on X" says two things: the title, and that the pane is working.
      if (words.length >= MIN_MATCHED_TOKENS) return { words, text: phrase, ...(/^\s*work/i.test(match[0]) && { working: true }) };
    }
  }
  return undefined;
}

// Providers the user can name. Values are launcher kinds; the caller supplies
// the live launcher catalog so a configured custom launcher is named too.
const PROVIDER_PATTERNS = [
  [/\bcodex web\b/i, 'codex-web'], [/\bopen codex\b/i, 'open-codex'], [/\bcodex\b/i, 'codex'],
  [/\bclaude code\b|\bclaude\b/i, 'claude'], [/\bgemini\b/i, 'gemini'], [/\bqwen\b/i, 'qwen'],
  [/\bkimi\b/i, 'kimi'], [/\bcursor\b/i, 'cursor'], [/\bgrok\b/i, 'grok'],
  [/\bopen ?fusion\b/i, 'openfusion'], [/\bfusion\b/i, 'fusion'], [/\bopencode\b/i, 'opencode'],
];
const PROVIDER_FAMILY = { 'claude-custom': 'claude', 'kimi-custom': 'kimi' };
const providerFamily = kind => PROVIDER_FAMILY[kind] || kind;
// The plain shell launcher is labelled with the pane noun every sentence about
// panes already uses ("the Codex terminal", "one of the empty terminals"), so
// its own label can never select it. The shell is chosen by the words a user
// says for a shell, and by nothing else.
const SHELL_KINDS = new Set(['terminal', 'shell']);
const NOUN_LABEL = /^(?:terminals?|shells?|panes?|agents?|sessions?)$/i;
const SHELL_WORDS = new RegExp([
  String.raw`\bpower\s?shell\b`, String.raw`\bpwsh\b`, String.raw`\bcommand prompt\b`,
  String.raw`\bcmd(?:\.exe)?\b`, String.raw`\bbash\b`, String.raw`\bzsh\b`, String.raw`\bshell\b`,
  String.raw`\b(?:plain|regular|normal|basic|ordinary|standard|empty plain)\s+(?:terminal|shell)s?\b`,
].join('|'), 'i');
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function namedProvider(instruction, launchers = []) {
  let shell;
  for (const launcher of [...launchers].sort((a, b) => String(b?.label || '').length - String(a?.label || '').length)) {
    const label = String(launcher?.label ?? '').trim();
    if (SHELL_KINDS.has(launcher?.kind) || NOUN_LABEL.test(label)) { shell ??= launcher?.kind; continue; }
    if (label.length >= 4 && new RegExp(`\\b${escapeRegExp(label)}\\b`, 'i').test(instruction)) return launcher.kind;
  }
  for (const [pattern, kind] of PROVIDER_PATTERNS) if (pattern.test(instruction)) return kind;
  if (shell && SHELL_WORDS.test(instruction)) return shell;
  return undefined;
}

// The reading: { kind, words, provider?, text?, working?, handle?, fanOut, all,
// group, indefinite, indefiniteProvider, definiteProvider, deictic, pronoun }. `kind`
// is one of 'handle' | 'new' | 'idle' | 'just_opened' | 'working' | 'done' |
// 'last_target' | 'other' | 'title' | 'provider' | 'none'.
function readReference(instruction, { launchers = [] } = {}) {
  const text = referenceText(instruction);
  const provider = namedProvider(text, launchers);
  const facts = { words: [], ...(NO_CREATION.test(String(instruction ?? '')) && { creationForbidden: true }), ...(provider && { provider }), fanOut: FAN_OUT.test(text), all: ALL_MATCHING.test(text), group: GROUP_REFERENCE.test(text),
    indefinite: INDEFINITE_WORKER.test(text) || GROUP_PHRASE.test(text) || CATEGORY_PANE.test(text),
    indefiniteProvider: INDEFINITE_PROVIDER.test(text) || GROUP_PHRASE.test(text) || CATEGORY_PANE.test(text),
    definiteProvider: DEFINITE_PROVIDER.test(text), deictic: DEICTIC.test(text), pronoun: PRONOUN_CONTINUATION.test(text) };
  const handles = [...new Set([...text.matchAll(new RegExp(HANDLE.source, 'g'))].map(match => `T${Number(match[1])}`))];
  if (handles.length) return { kind: 'handle', handle: handles[0], handles, ...facts };
  if (JUST_OPENED.test(text)) return { kind: 'just_opened', ...facts };
  if (idlePaneRequest(text) === 'strong') return { kind: 'idle', ...facts };
  if (REUSE_ANOTHER.test(text)) return { kind: 'other', ...facts };
  if (!facts.creationForbidden && NEW_PANE.test(text)) return { kind: 'new', ...facts };
  if (WORKING_PANE.test(text)) return { kind: 'working', ...facts };
  if (DONE_PANE.test(text)) return { kind: 'done', ...facts };
  if (LAST_TARGET_PHRASE.test(text)) return { kind: 'last_target', ...facts };
  if (OTHER_PANE.test(text)) return { kind: 'other', ...facts };
  const title = titlePhrase(text);
  if (title) return { kind: 'title', ...facts, words: title.words, text: title.text, ...(title.working && { working: true }) };
  if (provider) return { kind: 'provider', ...facts };
  return { kind: 'none', ...facts };
}

// ---------------------------------------------------------------------------
// Resolution against the model.
// ---------------------------------------------------------------------------

// A label the user said word for word. The scorer reads a spoken, partial or
// reordered reference; this reads the exact display name, which is how a pane
// with a short generic-looking label ("Codex 1") is still identified by name.
// A name that is only the provider's, the pane noun's, or the project's (an
// untitled pane is called after its folder, and "the vibeTerminal project"
// names the project) names nothing.
const GENERIC_LABELS = new Set(['terminal', 'agent', 'session', 'pane', 'conversation', 'chat', 'shell']);
const mentionsLabel = (text, label) => typeof label === 'string' && label.trim().length >= 3 &&
  new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(label)}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(text);
const namesTerminal = (text, terminal) => {
  const label = String(terminal.name ?? '').trim().toLowerCase();
  return Boolean(label) && !GENERIC_LABELS.has(label) && label !== String(terminal.provider ?? '').toLowerCase()
    && label !== String(terminal.providerLabel ?? '').toLowerCase() && label !== String(terminal.project ?? '').toLowerCase()
    && mentionsLabel(text, terminal.name);
};
// What a pane can be named by: its display name, and the task it carries.
const paneTexts = terminal => [terminal.name, terminal.on, terminal.task?.title, terminal.task?.objective];
const byRecency = list => [...list].sort((left, right) => (right.activeAt || 0) - (left.activeAt || 0));

// The model the caller holds, or one built from what its context carries: the
// sessions, the recent ledger, the work items and the roster the Brain reads.
// A context without the app's persistent handles gets transient ones (T1, T2,
// in session order), so every reader of one context names the same panes.
function terminalsOf(context = {}) {
  if (Array.isArray(context.terminals)) return context.terminals;
  const roster = Array.isArray(context.roster) ? context.roster : [];
  const records = Object.fromEntries(roster.filter(row => row?.id).map(row => [row.id,
    { title: row.title, objective: row.on ?? row.objective, lastResultSummary: row.result }]));
  return buildTerminalModel({ sessions: context.sessions, handles: createTerminalHandles(), records, workItems: context.workItems,
    ledgerRows: Array.isArray(context.ledgerRows) ? context.ledgerRows : context.ledger, receipts: context.receipts });
}

// resolveReference(text, terminals, { launchers, cwd, projectName, now, strict })
//   -> { ...reading, panes, pool, stateFanOut, exact, basis, terminals,
//        candidates, scored, mentioned, named, eligible, score, fresh }
// `panes` are the addressed project's agent panes (every agent pane when no
// project is addressed); `pool` is what the kind was resolved against, which
// is every pane for a fan-out over states ("both terminals that are done"
// reaches across projects). `strict` drops the sole-candidate allowance a
// title enjoys: a compiled plan cannot ask, so it needs a real score.
function resolveReference(instruction, terminals, { launchers = [], cwd, projectName = '', now = Date.now(), strict = false } = {}) {
  const text = referenceText(instruction);
  const reading = readReference(instruction, { launchers });
  const all = (Array.isArray(terminals) ? terminals : []).filter(terminal => terminal && typeof terminal.id === 'string');
  const agents = all.filter(terminal => !SHELL_KINDS.has(terminal.provider));
  const panes = cwd ? agents.filter(terminal => sameFolder(terminal.cwd, cwd)) : agents;
  const family = providerFamily(reading.provider);
  const ofFamily = list => family ? list.filter(terminal => providerFamily(terminal.provider) === family) : list;
  const stateFanOut = STATE_KINDS.has(reading.kind) && reading.fanOut;
  // An explicitly named project bounds a fan-out. A project merely visible
  // in the UI is still the default scope for a singular reference only.
  const projectNamed = cwd && projectName && new RegExp(`\\b${escapeRegExp(projectName).replace(/\s+/g, '\\s+')}\\b`, 'i').test(text);
  const pool = stateFanOut && !projectNamed ? agents : panes;
  const result = { ...reading, panes, pool, stateFanOut, exact: false, basis: null, terminals: [], candidates: [],
    scored: [], strong: [], mentioned: [], named: [], eligible: [], score: undefined, fresh: false };
  const exact = (list, basis) => Object.assign(result, { exact: true, basis, terminals: list });
  // The pane(s) of the newest delivery in the ledger, while still open: "the
  // one you just prompted", and the anchor "the other one" is other than. Only
  // a delivery that is the latest thing in the ledger anchors; right after a
  // question or an answer there is no "one" to be other than.
  const anchors = all.filter(terminal => terminal.lastWorked);
  result.fresh = anchors.length === 1 && anchors[0].lastWorked.fresh === true;

  switch (reading.kind) {
    case 'handle': {
      result.candidates = reading.handles.map(handle => all.find(item => item.handle === handle)).filter(Boolean);
      if (result.candidates.length === reading.handles.length) exact(result.candidates, 'handle');
      break;
    }
    case 'just_opened': {
      const opened = ofFamily(panes).filter(terminal => terminal.opened?.by === 'lina' && now - terminal.opened.at <= OPENED_WINDOW_MS)
        .sort((left, right) => right.opened.at - left.opened.at);
      result.candidates = opened;
      if (opened.length) exact([opened[0]], 'opened');
      break;
    }
    case 'idle': {
      const free = byRecency(ofFamily(panes).filter(terminal => terminal.free));
      result.candidates = free;
      if (free.length) exact([free[0]], 'free');
      break;
    }
    case 'working': case 'done': {
      const wanted = reading.kind === 'working' ? WORKING_STATES : DONE_STATES;
      const group = byRecency(ofFamily(pool).filter(terminal => wanted.has(terminal.state)));
      result.candidates = group;
      if (stateFanOut ? group.length : group.length === 1) exact(group, 'state');
      break;
    }
    case 'last_target': {
      const live = anchors.filter(terminal => pool.includes(terminal));
      result.candidates = live;
      if (live.length === 1) exact(live, 'last-target');
      break;
    }
    case 'other': {
      const others = byRecency(ofFamily(pool).filter(terminal => !terminal.lastWorked));
      result.candidates = others;
      if (result.fresh && others.length === 1) exact(others, 'other');
      break;
    }
    default: break;
  }
  // "Tell it to…", "ask it whether…": a sentence whose only pane reference is
  // "it" means the pane Lina last typed into, when that pane is still here.
  if (reading.kind === 'none' && reading.pronoun) {
    const live = anchors.filter(terminal => pool.includes(terminal));
    result.candidates = live;
    if (live.length === 1) exact(live, 'pronoun');
  }

  // A label said word for word names its pane whatever else the sentence asks
  // for ("tell Cedar ... but only while it is idle"), so the Brain is offered
  // that pane; the scorer below reads only the sentences that can carry a
  // spoken, partial or reordered title.
  result.mentioned = byRecency(pool.filter(terminal => namesTerminal(text, terminal)));
  result.named = result.mentioned;
  if (NAMEABLE_KINDS.has(reading.kind)) {
    // A title names the pane by the words the sentence gave it; any other
    // sentence is scored whole. Busy panes are eligible: a follow-up to a
    // working agent queues behind it. Ask only when two named candidates
    // actually remain: a sole pane whose title carries the words the user said
    // is the answer even when a longer title keeps its score under the
    // threshold; a second close title is not, and neither is the sole pane when
    // the sentence also asks for a worker by category.
    const byId = new Map(pool.map(terminal => [terminal.id, terminal]));
    const scored = scoreCandidates({ instruction: reading.kind === 'title' ? reading.words : text, projectName,
      stopwords: RESOLVER_STOPWORDS, perText: true, candidates: pool.map(terminal => ({ id: terminal.id, texts: paneTexts(terminal) })) });
    const eligible = scored.filter(item => item.matched >= MIN_MATCHED_TOKENS);
    result.eligible = eligible.map(item => item.id);
    result.score = eligible[0]?.score;
    const contenders = eligible.length ? byRecency(eligible.filter(item => item.score > eligible[0].score - RUNNER_UP_MARGIN).map(item => byId.get(item.id))) : [];
    result.strong = eligible.length && eligible[0].score >= MIN_SCORE ? contenders : [];
    result.scored = result.strong.length || (!strict && eligible.length === 1) ? contenders : [];
    // A pane is named by its words. When the sentence also asks for a worker by
    // category ("have a agent working on X…"), a weak overlap with the one open
    // pane is not the user naming it, though it is still the pane assignment
    // reads the title against.
    result.named = byRecency([...new Set([...(reading.indefinite ? result.strong : result.scored), ...result.mentioned])]);
    if (reading.kind === 'title') {
      result.candidates = result.scored;
      if (result.scored.length === 1) exact(result.scored, 'title');
      // "The agent working on the chat section" names a pane that was started by
      // hand and carries no title. What the sentence still says is that the pane
      // is working, and when exactly one pane is, that is the pane.
      if (reading.working && !eligible.length) {
        result.candidates = byRecency(ofFamily(pool).filter(terminal => WORKING_STATES.has(terminal.state)));
        if (result.candidates.length === 1) exact(result.candidates, 'working');
      }
    } else if (reading.kind === 'provider') {
      result.candidates = byRecency(ofFamily(panes));
      if (reading.definiteProvider && !reading.indefiniteProvider && result.candidates.length === 1) exact(result.candidates, 'provider');
    }
  }
  return result;
}

module.exports = { readReference, resolveReference, terminalsOf, idlePaneRequest, providerFamily, meaningful,
  RESOLVER_STOPWORDS, STATE_KINDS, SHELL_KINDS, OPENED_WINDOW_MS };
