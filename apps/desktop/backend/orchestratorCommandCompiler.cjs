'use strict';

// Deterministic command compiler.
//
// Most of what the user says is one of a handful of sentence shapes: open a
// pane in a project, start a task in a project, follow up with the agent working
// on something. Sending those to the brain costs a model call and about two
// seconds for a decision the application can already make from its own facts.
// This module parses the normalized sentence with a strict slot grammar and
// returns the same planner tool calls the brain would have returned, so
// decodePlannerCalls, canonicalizeInterpretation and normalizeIntent stay the
// only authority over what a plan may contain.
//
// It is a compiler, not an interpreter: it declines everything it cannot prove.
// A declined request reaches the brain exactly as it does today, so the cost of
// being wrong about a shape is one ordinary interpretation, while the cost of
// accepting a shape wrongly is a task typed into the wrong pane. The grammar is
// therefore anchored at both ends, every slot must resolve against registered
// facts (exactly one project, an available launcher, exactly one pane), and a
// sentence mentioning closing, stopping, answering, every terminal, or a pane
// that is working is never compiled at all.
//
// Pure: no I/O, no model call, no store or terminal access.
const path = require('node:path');
const { plannerTools, decodePlannerCalls } = require('./orchestratorPlannerTools.cjs');
const { canonicalizeInterpretation } = require('./orchestratorInterpretationSchema.cjs');
const { identifyProject } = require('./orchestratorPolicy.cjs');
const { resolveReference, terminalsOf, providerFamily, RESOLVER_STOPWORDS } = require('./orchestratorReference.cjs');
const { sameFolder } = require('./orchestratorTerminalModel.cjs');
const { PROVIDER_VOCABULARY } = require('./orchestratorVocabulary.cjs');

// Every reason a compilation can be refused. The set is closed so the
// diagnostics record stays countable, and no reason carries sentence text.
const COMPILER_REASONS = Object.freeze(['no-match', 'unknown-project', 'ambiguous-project', 'unknown-provider',
  'short-task', 'long-task', 'second-command', 'ambiguous-pane', 'blocked-verb', 'context-dependent', 'too-many',
  'low-confidence', 'decode-failed']);
const SHAPES = Object.freeze(['open', 'start', 'follow_up', 'status', 'results', 'stop', 'close']);
// A compilation is accepted only above this floor. Each slot the sentence left
// implicit, or spelled the way speech commonly garbles it, costs a little
// certainty; two such slots in one sentence is a request for the brain.
const CONFIDENCE_FLOOR = 0.9;
const MAX_PANES = 5;
const MAX_TASK_CHARS = 8000;
const MIN_TASK_WORDS = 3;
const MIN_DISTINCTIVE_TASK_WORDS = 2;

const decline = reason => ({ accepted: false, reason });
// Tool-call ids are unique the way a provider's are, so two openings of the
// same launcher are two calls rather than one repeated.
let callSequence = 0;
const call = (name, args) => ({ id: `compiled-${name}-${++callSequence}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

// ---------------------------------------------------------------------------
// Vocabulary. Provider and project names are matched as explicit alternations
// built from the live catalogs, never as a free `.+?` slot: a slot that can
// match anything cannot prove anything.
// ---------------------------------------------------------------------------

const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "terminal" and "shell" are the pane noun of the grammar itself, so a launcher
// named after them can never fill the provider slot.
const NOUN_LIKE = /^(?:terminals?|shells?|panes?|agents?|sessions?)$/i;
// The family names the user says for a launcher kind. The canonical spellings
// the vocabulary pass writes are the ones this grammar reads.
const FAMILY_ALIASES = Object.freeze([['Claude Code', 'claude'], ['Open Claude Code', 'claude-custom'],
  ['Codex Web', 'codex-web'], ['Open Codex', 'open-codex'], ['Codex', 'codex']]);

function providerCatalog(launchers) {
  const list = (Array.isArray(launchers) ? launchers : []).filter(item => item && item.kind && !NOUN_LIKE.test(item.kind));
  const usable = new Set(list.filter(item => item.available !== false).map(item => item.kind));
  const entries = new Map();
  const add = (text, kind) => {
    const name = String(text ?? '').trim();
    if (name.length < 3 || NOUN_LIKE.test(name) || !usable.has(kind)) return;
    if (!entries.has(name.toLowerCase())) entries.set(name.toLowerCase(), { text: name, kind });
  };
  for (const launcher of list) { add(launcher.label, launcher.kind); add(launcher.kind, launcher.kind); }
  for (const [label, kind] of FAMILY_ALIASES) add(label, kind);
  for (const entry of PROVIDER_VOCABULARY) add(entry.canonical, entry.kind);
  // Longest first, so "Codex Web" and "Open Codex" are never read as "Codex".
  return [...entries.values()].sort((left, right) => right.text.length - left.text.length);
}

function projectList(context) {
  const raw = Array.isArray(context?.projects) ? context.projects
    : Array.isArray(context?.roots?.projects) ? context.roots.projects
    : Array.isArray(context?.roots) ? context.roots : [];
  return raw.map(project => typeof project === 'string' ? { name: path.basename(project), path: project } : project)
    .filter(project => project && typeof project.path === 'string' && project.path);
}

// The same spelling tolerance identifyProject allows: a registered name may be
// heard with its camel-case words separated ("vibe Terminal" for vibeTerminal).
const nameVariants = project => [project?.name, path.basename(String(project?.path || ''))]
  .filter(label => typeof label === 'string' && label.trim().length >= 3)
  .map(label => escape(label.replace(/([a-z])([A-Z])/g, '$1 $2')).replace(/\s+/g, '\\s*'));

function projectPattern(projects) {
  const parts = [...new Set(projects.flatMap(nameVariants))].sort((left, right) => right.length - left.length);
  return parts.length ? parts.join('|') : null;
}

// ---------------------------------------------------------------------------
// Sentence hygiene. The vocabulary pass has already removed the wake phrase and
// written the registered names; what remains is the pleasantries and nonverbal
// markers a transcript keeps around a command. Affirmatives ("yes", "okay",
// "right") are deliberately absent: an answer must never become a command by
// having its answer word trimmed off.
// ---------------------------------------------------------------------------
const LEADING_FILLER = /^(?:[\s,.!?;:—–…"'-]|\*[^*]{0,24}\*|\b(?:thank you|thanks|so|well|um|uh|er|now|then|hey|hi|hello|bye|anyway|sorry)\b)+/i;
const TRAILING_FILLER = /(?:[\s,.!?;:—–…"'-]|\*[^*]{0,24}\*|\b(?:thank you|thanks|please|amen|um|uh|er)\b)+$/i;

function trimFiller(text) {
  let value = String(text ?? '').replace(/\s+/g, ' ').trim();
  for (let pass = 0; pass < 4; pass++) {
    const next = value.replace(LEADING_FILLER, '').trim();
    if (next === value) break;
    value = next;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Vocabulary that stops a compilation outright, wherever it appears: the
// answers that belong to a question Lina asked, a cancellation, and the
// operations whose selection still needs the close review - clearing,
// restarting or removing panes, and a close of a group or of panes picked by a
// condition. Stopping or closing the one pane a sentence points at exactly is
// a shape of its own below: the reference resolver names the pane or the
// sentence is declined, so no model ever chooses which pane to stop.
// ---------------------------------------------------------------------------
const PANE_NOUN = String.raw`(?:terminals?|panes?|agents?|sessions?)`;
const CLOSE_VERB = String.raw`(?:close|closing|shut|quit|exit|kill)`;
const BLOCKED = [
  new RegExp(String.raw`\b(?:cancel|clear|restart|relaunch|reboot|delete|remove)\b[^.?!]{0,24}\b${PANE_NOUN}\b`, 'i'),
  new RegExp(String.raw`\b${CLOSE_VERB}\b[^.?!]{0,60}\b(?:all|every|each|both|them|those|inactive|idle|done|finished|not\s+working|that\s+are|which\s+are)\b`, 'i'),
  new RegExp(String.raw`\b${PANE_NOUN}\b[^.?!]{0,12}\b(?:closed|stopped|killed|restarted)\b`, 'i'),
  /\bnever\s?mind\b|\bforget\s+it\b/i,
  /\b(?:approve|approval|permission|allow it|deny|reject)\b/i,
  /^(?:yes|no|yeah|yep|nope|nah|sure|correct)\b/i,
  /^(?:answer|reply|respond)\b|\banswer\s+(?:yes|no|it|the\s+(?:prompt|question|trust))\b/i,
];

// ---------------------------------------------------------------------------
// The grammar. Every pattern is anchored at both ends of the trimmed sentence,
// so anything the grammar does not model - a second command, a dangling desire,
// an aside - fails to parse and the request reaches the brain.
// ---------------------------------------------------------------------------
const POLITE = String.raw`(?:(?:can|could|would|will)\s+(?:you|we)|please|i\s+want\s+you\s+to|i(?:'d|\s+would)?\s+like\s+you\s+to|go\s+ahead\s+and|let'?s)`;
const LEAD = String.raw`(?:${POLITE}[\s,]+)*`;
const OPEN_VERB = String.raw`(?:open|start|spawn|create|launch)`;
// "Put in another Codex terminal in vibeTerminal to ..." is how the user asks
// for a start most often after "prompt". Only "put" and "put in" are read as
// that verb: "put it in" and "put that in" name an object from an earlier turn,
// which is a memory or redo request and belongs to the brain.
const ASK_VERB = String.raw`(?:prompt|tell|ask|have|get|give|send|put(?:\s+in)?)`;
const COUNT = String.raw`(?:another|one\s+more|an?|one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})`;
const IDLE_WORD = String.raw`(?:empty|idle|free|unused|spare)`;
const PREP = String.raw`(?:in|for|on|within|inside|into|and)`;
const ARTICLE = String.raw`(?:the\s+|an?\s+|my\s+)?`;
const TASK_LINK = String.raw`(?:and\s+(?:have|tell|ask|get|prompt)\s+it\s+(?:to\s+)?|(?:just\s+)?to\s+|:\s*)`;
// "for me" closes a request; it never opens a project slot.
const TAIL = String.raw`(?:\s+project)?(?:\s+for\s+(?:me|us))?\s*[,.!?]*\s*`;
const COUNTS = Object.freeze({ a: 1, an: 1, another: 1, one: 1, 'one more': 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10 });
// "Have a Codex terminal in vibeTerminal fix the login page" states the work
// with no linking word at all. That reading is only allowed when what follows
// reads as an instruction rather than as a clause still describing the pane.
// It is only an instruction when it opens like one. A clause still describing
// the pane, a pronoun, or a determiner is the sentence continuing, not the work.
const CLAUSE_START = /^(?:that|which|who|when|where|while|because|since|but|so|and|or|if|though|although|with|without|from|for|about|is|are|was|were|has|have|had|will|would|can|could|should|i|we|you|he|she|it|they|the|an?|this|these|those|my|our|his|her|its|their|there|here|what|whose|why|how|of|in|on|at|by|as|um|uh|er|just)\b/i;
// Work named by pointing at an earlier turn ("put in that prompt", "make this
// change") is a memory or redo request: the words the agent must be sent are
// not in this sentence, so the brain reads it with the conversation in hand.
const ANAPHORIC_TASK = /^(?:that|this|those|these|it|them|the\s+same|the\s+last|the\s+previous)\b/i;

function grammar(providers, projectSource) {
  const P = providers.map(entry => escape(entry.text)).join('|');
  const R = projectSource;
  const named = String.raw`(?:one\s+of\s+the\s+)?(?:(?<idle>${IDLE_WORD})\s+)?(?<provider>${P})\s+${PANE_NOUN}`;
  const any = String.raw`(?:one\s+of\s+the\s+)?(?:(?<idle>${IDLE_WORD})\s+)?(?:(?<provider>${P})\s+)?${PANE_NOUN}`;
  // The project is named, pointed at ("in this project"), or the place the user
  // is already looking ("open a Codex terminal here").
  const where = String.raw`(?:(?<prep>${PREP})\s+(?:${ARTICLE}(?<project>${R})|(?<deictic>this|the\s+current|the\s+same)\s+(?:project|repo|repository|folder|workspace))|(?<here>here))`;
  // The project slot may be left out entirely. It is then filled from the
  // project the request path already identified, or the project view the user
  // is looking at - and only when the sentence names no project anywhere, so a
  // project mentioned outside the slot can never be silently replaced.
  const head = String.raw`^${LEAD}(?<verb>${OPEN_VERB})\s+(?:up\s+)?(?:(?<count>${COUNT})\s+)?(?<fresh>new\s+)?${any}(?:\s+${where})?`;
  const patterns = [
    // "Open a Codex terminal in vibeTerminal." - a pane and nothing else.
    { shape: 'open', pattern: new RegExp(`${head}${TAIL}$`, 'i') },
    // The same head carrying the work: "... and have it fix X", "... to fix X".
    { shape: 'start', pattern: new RegExp(`${head}${TAIL}${TASK_LINK}(?<task>.+)$`, 'i') },
    // "Prompt a Codex terminal in vibeTerminal to fix X", and the same sentence
    // with the linking word left out.
    { shape: 'start', linkOptional: true, pattern: new RegExp(String.raw`^${LEAD}(?:use|${ASK_VERB})\s+(?:(?<count>${COUNT})\s+|the\s+)?(?<fresh>new\s+)?${named}(?:\s+${where})?${TAIL}(?<link>${TASK_LINK})?(?<task>.+)$`, 'i') },
    // "Prompt the vibeTerminal Codex terminal to fix X." - the project heard
    // before the provider is the same request with its two slots swapped.
    { shape: 'start', linkOptional: true, pattern: new RegExp(String.raw`^${LEAD}(?:use|${ASK_VERB})\s+(?:one\s+of\s+)?${ARTICLE}(?<project>${R})(?:\s+project)?\s+(?:(?<idle>${IDLE_WORD})\s+)?(?<provider>${P})\s+${PANE_NOUN}\s*[,.!?]*\s*(?<link>${TASK_LINK})?(?<task>.+)$`, 'i') },
    // "Stop that last terminal you worked on", "interrupt T3", "close the other
    // one": the pane is whatever the reference resolver names, exactly.
    { shape: 'stop', pattern: new RegExp(String.raw`^${LEAD}(?:stop|interrupt|pause|halt)\s+(?<ref>.+?)\s*[,.!?]*$`, 'i') },
    { shape: 'close', pattern: new RegExp(String.raw`^${LEAD}${CLOSE_VERB}(?:\s+down)?\s+(?<ref>.+?)\s*[,.!?]*$`, 'i') },
    // "Tell the agent working on the chat section in vibeTerminal to continue."
    { shape: 'follow_up', pattern: new RegExp(String.raw`^${LEAD}${ASK_VERB}\s+(?:the\s+|that\s+)?(?:agent|terminal|pane|session|one)\s+(?:(?:that['’]?s|that\s+is|thats|which\s+is)\s+)?(?:currently\s+)?(?:working|worked)\s+on\s+(?<topic>[^.?!]{3,90}?)(?:\s+in\s+${ARTICLE}(?<project>${R})(?:\s+project)?)?\s*[,.!?]*\s*to\s+(?<task>.+)$`, 'i') },
    // "Tell the chat section agent in vibeTerminal to continue its work."
    { shape: 'follow_up', pattern: new RegExp(String.raw`^${LEAD}(?:tell|ask|prompt)\s+(?:the\s+)?(?<topic>(?:[\w'’-]+\s+){1,5}?)${PANE_NOUN}(?:\s+in\s+${ARTICLE}(?<project>${R})(?:\s+project)?)?\s*[,.!?]*\s*to\s+(?<task>.+)$`, 'i') },
    // "Tell it to…", "tell T3 to…", "ask the other one to…", "tell the codex
    // terminal that's currently working to…": a follow-up to the pane the
    // sentence points at, resolved against the terminal model.
    { shape: 'follow_up', byReference: true, pattern: new RegExp(String.raw`^${LEAD}(?:tell|ask|prompt|have|get|remind)\s+(?<ref>it|[Tt]-?\d{1,6}|(?:the|that|this)\s+(?:[\w'’-]+\s+){0,4}(?:one|${PANE_NOUN})(?:\s+(?:that['’]?s|that\s+is|thats|which\s+is)\s+(?:currently\s+)?(?:working|busy|running|done|finished|waiting(?:\s+on\s+\w+)?))?)\s*,?\s+(?:to\s+)?(?<task>.+)$`, 'i') },
    // Status and results about one named pane. The memory store already answers
    // the questions about Lina's own actions; these ask about the agent.
    { shape: 'status', pattern: new RegExp(String.raw`^${LEAD}what(?:'s|\s+is)\s+(?<topic>[^.?!]{3,90}?)\s+(?:doing|working\s+on)\s*[.?!]*$`, 'i') },
    { shape: 'status', pattern: new RegExp(String.raw`^${LEAD}(?:is|has)\s+(?<topic>[^.?!]{3,90}?)\s+(?:done|finished)\s*[.?!]*$`, 'i') },
    { shape: 'results', pattern: new RegExp(String.raw`^${LEAD}what\s+did\s+(?<topic>[^.?!]{3,90}?)\s+(?:come\s+back\s+with|find|say|report)\s*[.?!]*$`, 'i') },
  ];
  // The same head without its end anchor, used only to explain a refusal: a
  // sentence whose command head parses but whose remainder does not is carrying
  // something this grammar does not model.
  return { patterns, head: new RegExp(head, 'i') };
}

// "Open Codex terminal in vibeTerminal" is two readings at once when the build
// offers an Open Codex launcher: the verb "open" plus Codex, or the launcher
// named Open Codex with no verb at all. Neither reading can be proved, so the
// sentence belongs to the brain. An article settles it ("open a Codex terminal",
// "open an Open Codex terminal") and those still compile.
function ambiguousLauncherHead(text, providers) {
  return providers.some(entry => /^(?:open|start|create|launch|spawn|new)\b/i.test(entry.text) &&
    new RegExp(String.raw`^${LEAD}${escape(entry.text)}\s+${PANE_NOUN}\b`, 'i').test(text));
}

// Loose probes used only to explain a refusal and to catch a second command
// inside a task body. They prove nothing; they never accept anything.
function looseProbes(providers) {
  const P = providers.map(entry => escape(entry.text)).join('|');
  const withProvider = P ? String.raw`(?:(?:${P})\s+)?` : '';
  return {
    command: new RegExp(String.raw`^${LEAD}(?:${OPEN_VERB}|${ASK_VERB}|use)\b`, 'i'),
    second: new RegExp([
      String.raw`\b${OPEN_VERB}\s+(?:${COUNT}\s+)?(?:new\s+)?${withProvider}${PANE_NOUN}\b`,
      String.raw`\b(?:tell|ask|prompt|have|get|use|put(?:\s+in)?)\s+(?:one\s+of\s+the\s+|(?:${COUNT}|the)\s+)(?:new\s+)?(?:${IDLE_WORD}\s+)?${withProvider}${PANE_NOUN}\b`,
    ].join('|'), 'i'),
  };
}

// ---------------------------------------------------------------------------
// Task text. What reaches the agent is the user's own sentence, tidied only of
// the pleasantries a transcript keeps, with a capital and a full stop.
// ---------------------------------------------------------------------------
const taskWords = value => (String(value).match(/[\p{L}\p{N}]+/gu) || []).length;
// The words that carry the work. "Make this change" has one, and an agent
// receiving it cannot know what change: the sentence is leaning on an earlier
// turn, which is the brain's to read. The resolver's stopword set is used so
// naming a task and selecting a pane by it count the same words.
const distinctiveTaskWords = value => new Set((String(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
  .filter(word => word.length >= 3 && !RESOLVER_STOPWORDS.has(word))).size;
function cleanTask(value) {
  let text = trimFiller(value);
  for (let pass = 0; pass < 4; pass++) {
    const next = text.replace(TRAILING_FILLER, '').trim();
    if (next === text) break;
    text = next;
  }
  if (!text) return '';
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (!/[.?!]$/.test(text)) text += '.';
  return text.slice(0, MAX_TASK_CHARS);
}

// ---------------------------------------------------------------------------
// Pane selection for a follow-up, status or results request. The reference
// resolver reads the sentence against the terminal model; the compiler only
// insists that it leaves exactly one titled candidate with a real score,
// because a compiled plan has no way to ask a question.
// ---------------------------------------------------------------------------
function uniquePane(context, project) {
  const reference = resolveReference(context?.instruction, terminalsOf(context),
    { launchers: context?.launchers || [], cwd: project?.path, projectName: project?.name || '', strict: true });
  return reference.exact && reference.terminals.length === 1 && !['new', 'idle', 'just_opened'].includes(reference.kind) ? reference.terminals[0] : undefined;
}

// ---------------------------------------------------------------------------
// The compiler.
// ---------------------------------------------------------------------------
const instructionOf = context => String(context?.normalizedText ?? context?.instruction ?? '');
// A sentence whose authority lives somewhere other than its own words - a reply
// to a question, a retry, a pane the user selected in the UI, an unfinished
// command still holding grants - is never compiled. Those are exactly the cases
// where the brain needs the surrounding context to read the sentence correctly.
// The project a sentence means without saying it: the one the request path
// already identified for this exchange, else the project view the user is
// looking at, resolved to exactly one registered project.
function implicitProject(context, projects) {
  const identified = context?.projectContext;
  if (identified?.path) return projects.find(item => sameFolder(item.path, identified.path)) || identified;
  const workspace = context?.workspaceContext;
  if (!workspace || workspace.view !== 'project' || typeof workspace.cwd !== 'string') return undefined;
  const matches = projects.filter(item => sameFolder(item.path, workspace.cwd));
  return matches.length === 1 ? matches[0] : undefined;
}
// Authority that does not live in the sentence at all, and cannot be read from
// its words: the user picked a pane in the interface, is answering a terminal's
// question or one of Lina's, is retrying an earlier request, or the request is a
// link in a dependency chain. Every one of these is refused outright.
function carriesForeignAuthority(context) {
  return Boolean(context?.targetId || context?.interactionContext || context?.replyWorkItem ||
    context?.authorizedRelay || context?.originalInstruction || context?.replyContext?.question ||
    (Array.isArray(context?.dependencyResults) && context.dependencyResults.length));
}
// An unfinished command left by an earlier request is different: it is context
// the next sentence MAY lean on, not context it always leans on. Refusing every
// sentence while one existed meant the compiler only ever ran on a session's
// first request - the September 14 completion ladder declined 33 of its 35 turns
// `context-dependent`, including plain "open a Codex terminal in vibeTerminal"
// sentences that carry their whole meaning in their own words. A pending command
// now blocks only the sentences that actually point back at it: a pick from a
// question Lina asked, and a request whose pane or project is named by pointing
// at the previous turn rather than said.
//
// These are read over the sentence's HEAD - what it says about which pane and
// which project - never over the task body, which is the user's own words to an
// agent and may say "continue", "again" or "the last one" about anything at all.
const LEANS_ON_PRIOR_TURN = [
  // A pick from the candidates a question named.
  /^(?:the\s+)?(?:first|second|third|1st|2nd|3rd|number\s+(?:one|two|three)|last)\s+(?:one\b|terminals?\b|panes?\b|agents?\b|$)/i,
  /^(?:both|either|neither|all of them|that one|this one|the other|the same)\b/i,
  // A pane named by pointing back: "the other one", "the same terminal".
  new RegExp(String.raw`\b(?:other|same|previous|earlier)\s+(?:one|${PANE_NOUN})\b`, 'i'),
  // The sentence adds to or repeats what the previous turn set up.
  /\b(?:as well|instead|the same thing|one more time)\b/i,
  /^(?:and|also|plus|next)\b/i,
];
const hasPendingCommand = context => Boolean(context?.previousCommand) ||
  (Array.isArray(context?.pendingCommands) && context.pendingCommands.length > 0);
function leansOnPriorTurn(text) {
  return LEANS_ON_PRIOR_TURN.some(pattern => pattern.test(String(text ?? '')));
}

function compileCommand(context) {
  const instruction = instructionOf(context);
  const text = trimFiller(instruction);
  if (!text || text.length > 4000) return decline('no-match');
  if (carriesForeignAuthority(context)) return decline('context-dependent');
  const providers = providerCatalog(context?.launchers);
  if (!providers.length) return decline('unknown-provider');
  const projects = projectList(context);
  const probes = looseProbes(providers);
  if (BLOCKED.some(pattern => pattern.test(text))) return decline('blocked-verb');
  const projectSource = projectPattern(projects);
  if (!projectSource) return probes.command.test(text) ? decline('unknown-project') : decline('no-match');
  const named = new RegExp(String.raw`\b(?:${projectSource})\b`, 'i');
  // Why a sentence that looks like a command did not parse. The label is for the
  // diagnostics record; every branch here refuses.
  const refuse = head => {
    const found = head.exec(text);
    if (found) {
      const rest = text.slice(found[0].length);
      if (probes.second.test(rest) || /\b(?:close|closing|stop|kill|interrupt|quit|exit|restart|delete|remove)\b/i.test(rest)) return decline('second-command');
    }
    if (!probes.command.test(text)) return decline('no-match');
    if (!named.test(text)) return decline('unknown-project');
    return identifyProject(text, projects, null) ? decline('unknown-provider') : decline('ambiguous-project');
  };

  const { patterns, head } = grammar(providers, projectSource);
  let matched;
  for (const { shape, pattern, linkOptional, byReference } of patterns) {
    const found = pattern.exec(text);
    if (!found) continue;
    const groups = found.groups || {};
    // A pattern whose linking word is optional must not read a relative clause
    // about the pane ("... that is not working") as the work to be done.
    if (linkOptional && !groups.link && CLAUSE_START.test(String(groups.task || ''))) continue;
    matched = { shape, groups, byReference };
    break;
  }
  if (!matched) return refuse(head);
  const { shape, groups } = matched;
  // Everything before the task body: what the sentence says about which pane and
  // which project. A pending command from an earlier request only stops the
  // compilation when this part of the sentence points back at that turn.
  const headText = text.slice(0, Math.max(0, text.length - String(groups.task ?? '').length));
  if (hasPendingCommand(context) && leansOnPriorTurn(headText)) return decline('context-dependent');
  if (['open', 'start'].includes(shape) && ambiguousLauncherHead(text, providers)) return decline('unknown-provider');

  // The project slot must name exactly one registered project, resolved by the
  // same function the request path uses. The whole sentence is resolved too: a
  // sentence that also names a second project is ambiguous, whatever its slot
  // says, and ambiguity is the brain's to settle.
  let project;
  if (groups.project) {
    const named = identifyProject(groups.project, projects, null);
    if (!named) return decline('unknown-project');
    const whole = identifyProject(text, projects, null);
    if (!whole || !sameFolder(whole.path, named.path)) return decline('ambiguous-project');
    if (context?.projectContext?.path && !sameFolder(context.projectContext.path, named.path)) return decline('ambiguous-project');
    project = named;
  } else if (groups.deictic || groups.here) {
    // The project the user is pointing at is the one the request path already
    // identified, or the workspace they are looking at, resolved to a
    // registered project. Anything else is a guess.
    const cwd = context?.projectContext?.path || context?.workspaceContext?.cwd;
    project = context?.projectContext || projects.find(item => sameFolder(item.path, cwd));
    if (!project) return decline('unknown-project');
  } else if (['follow_up', 'status', 'results', 'stop', 'close'].includes(shape)) {
    project = context?.projectContext || undefined;
  }

  // "in" heard as "and" is the commonest transcription of this sentence, and it
  // is also how a second, unrelated pane would be joined on. It stays readable
  // and costs certainty rather than being trusted outright.
  let confidence = 1;
  if (groups.prep && /^and$/i.test(groups.prep)) confidence -= 0.05;
  // "Open a Codex terminal and have it look at the tests" names no project. The
  // project the request path already identified, or the project view the user is
  // looking at, is the one they mean - but only when the sentence names no
  // project at all, so a project mentioned outside the slot is never replaced,
  // and only at a confidence that leaves no room for a second implicit slot.
  if (!project && ['open', 'start'].includes(shape)) {
    if (named.test(text)) return decline('unknown-project');
    project = implicitProject(context, projects);
    if (!project) return decline('unknown-project');
    confidence -= 0.08;
  }
  const selector = resolveReference(text, [], { launchers: context?.launchers || [] });
  const referenceOptions = { launchers: context?.launchers || [], cwd: project?.path, projectName: project?.name || '', strict: true };

  // Stopping or closing the pane the sentence points at. A stop may fan out
  // over the panes in one state ("stop both that are working"); a close is one
  // pane, because a group close is the review's.
  if (shape === 'stop' || shape === 'close') {
    // The reference slot is not a second command or a deferred condition.
    // Handles alone must not make "close T1 and open ..." compile as just close.
    if (/\b(?:then|but|before|after|if|unless|when|until)\b|\band\s+(?:open|start|create|launch|spawn|tell|ask|prompt|send|close|stop|interrupt)\b/i.test(groups.ref)) return decline('second-command');
    const reference = resolveReference(text, terminalsOf(context), referenceOptions);
    const panes = reference.exact && !['new', 'idle', 'just_opened'].includes(reference.kind) ? reference.terminals : [];
    if (!panes.length || panes.some(pane => !pane.handle) || shape === 'close' && panes.length > 1) return decline('ambiguous-pane');
    if (confidence < CONFIDENCE_FLOOR) return decline('low-confidence');
    const handles = panes.map(pane => pane.handle);
    return { accepted: true, shape, confidence: Number(confidence.toFixed(2)), selector: reference.kind,
      project: project?.name ?? null, provider: null, promptPresent: false, targetIds: panes.map(pane => pane.id),
      calls: [shape === 'stop' ? call('plan_interrupt', { handles }) : call('plan_close', { scope: { type: 'explicit', handles } })] };
  }

  if (shape === 'status' || shape === 'results') {
    if (!uniquePane(context, project)) return decline('ambiguous-pane');
    if (confidence < CONFIDENCE_FLOOR) return decline('low-confidence');
    return { accepted: true, shape, confidence: Number(confidence.toFixed(2)), selector: selector.kind,
      project: project?.name ?? null, provider: null, promptPresent: false,
      calls: [call('plan_conversation', { goal: instruction.slice(0, 4000) })] };
  }

  if (shape === 'follow_up') {
    // The pane: named by its task (continued through assignment, which binds
    // the work item that owns it), or pointed at exactly (a handle, "it", "the
    // other one", the one working pane), which is typed into directly.
    const pointed = matched.byReference ? resolveReference(text.slice(0, Math.max(0, text.length - String(groups.task ?? '').length)), terminalsOf(context), referenceOptions) : undefined;
    const pane = pointed
      ? (pointed.exact && pointed.terminals.length === 1 && !['new', 'idle', 'just_opened'].includes(pointed.kind) ? pointed.terminals[0] : undefined)
      : selector.kind === 'title' ? uniquePane(context, project) : undefined;
    if (!pane || pointed && !pane.handle) return decline('ambiguous-pane');
    const task = cleanTask(groups.task);
    // "Prompt it and ask it if…": what follows the pane is still about the
    // pane, not the words to send it. The Brain composes that prompt.
    if (ANAPHORIC_TASK.test(task) || /^(?:and|then|plus)\b/i.test(task) || /\b(?:ask|tell|prompt|have|get|let)\s+it\b/i.test(task)) return decline('context-dependent');
    if (taskWords(task) < MIN_TASK_WORDS || distinctiveTaskWords(task) < MIN_DISTINCTIVE_TASK_WORDS) return decline('short-task');
    if (probes.second.test(task)) return decline('second-command');
    const cwd = project?.path || pane.cwd;
    if (typeof cwd !== 'string' || !cwd) return decline('unknown-project');
    if (confidence < CONFIDENCE_FLOOR) return decline('low-confidence');
    return { accepted: true, shape, confidence: Number(confidence.toFixed(2)), selector: pointed ? pointed.kind : 'title',
      project: project?.name ?? null, provider: pane.provider || pane.kind || null, promptPresent: true, targetId: pane.id,
      calls: [pointed ? call('plan_operate_terminal', { handles: [pane.handle], text: task, operationMode: 'task', promptMode: 'compose' })
        : call('plan_continue_task', { cwd, text: task })] };
  }

  // The provider slot. A named launcher must be one this build offers; an
  // unnamed one falls back to what this project has been using.
  let provider = groups.provider && providers.find(entry => entry.text.toLowerCase() === String(groups.provider).toLowerCase())?.kind;
  if (groups.provider && !provider) return decline('unknown-provider');
  if (!provider) {
    const remembered = context?.memory?.project?.defaultProvider;
    provider = remembered && providers.some(entry => entry.kind === remembered) ? remembered : undefined;
    if (!provider) return decline('unknown-provider');
    confidence -= 0.05;
  }
  // The resolver reads the same sentence for the same fact. Two answers about
  // which provider was named is exactly the disagreement that must not compile.
  // One name containing the other ("Open Codex" and "Codex") is the resolver
  // reading a shorter label out of a longer one, not a second provider.
  const labelOf = kind => (providers.find(entry => entry.kind === kind)?.text || String(kind)).toLowerCase();
  if (selector.provider && providerFamily(selector.provider) !== providerFamily(provider)) {
    const chosen = labelOf(provider), read = labelOf(selector.provider);
    if (!chosen.includes(read) && !read.includes(chosen)) return decline('unknown-provider');
  }

  if (shape === 'open') {
    const count = groups.count ? COUNTS[String(groups.count).toLowerCase()] ?? Number(groups.count) : 1;
    if (!Number.isInteger(count) || count < 1) return decline('no-match');
    if (count > MAX_PANES) return decline('too-many');
    if (confidence < CONFIDENCE_FLOOR) return decline('low-confidence');
    return { accepted: true, shape, confidence: Number(confidence.toFixed(2)), selector: selector.kind,
      project: project.name, provider, promptPresent: false, count,
      calls: [call('interpret_workspace', { goal: instruction.slice(0, 4000), executionMode: 'direct' }),
        ...Array.from({ length: count }, () => call('plan_open_blank_terminal', { cwd: project.path, kindOfSession: provider }))] };
  }

  const task = cleanTask(groups.task);
  // A start whose head names the pane by what it is working on is a follow-up
  // wearing a start's clothes; the words being sent to the agent may say
  // anything they like.
  if (/\bworking\s+on\b/i.test(headText)) return decline('blocked-verb');
  if (ANAPHORIC_TASK.test(task)) return decline('context-dependent');
  if (taskWords(task) < MIN_TASK_WORDS || distinctiveTaskWords(task) < MIN_DISTINCTIVE_TASK_WORDS) return decline('short-task');
  if (task.length >= MAX_TASK_CHARS) return decline('long-task');
  // A task body that reads as another command of its own is not a task body.
  if (probes.second.test(task)) return decline('second-command');
  if (confidence < CONFIDENCE_FLOOR) return decline('low-confidence');
  // Whether the user asked for a separate worker is read off the sentence when
  // the call is decoded, exactly as for a plan the Brain returns.
  return { accepted: true, shape: 'start', confidence: Number(confidence.toFixed(2)), selector: selector.kind,
    project: project.name, provider, promptPresent: true,
    calls: [call('plan_delegate_task', { cwd: project.path, kindOfSession: provider, text: task })] };
}

// ---------------------------------------------------------------------------
// The interpreter seam. createIntentInterpreter calls this first; returning
// undefined declines, and the model path then runs exactly as it does without
// a compiler at all.
// ---------------------------------------------------------------------------
function createCommandInterpreter({ recordDiagnostic = () => {}, now = Date.now } = {}) {
  return function compileIntent(context) {
    const startedAt = now();
    const record = (status, extra) => {
      const requestId = context?.requestId;
      if (typeof requestId !== 'string' || !requestId) return;
      try { recordDiagnostic({ event: 'request_stage', stage: 'compiled', requestId, elapsedMs: Math.max(0, now() - startedAt), status, ...extra }); }
      catch { /* a diagnostics failure never fails a request */ }
    };
    let result;
    try { result = compileCommand(context); }
    catch { result = decline('no-match'); }
    if (!result.accepted) { record('declined', { reason: result.reason }); return undefined; }
    try {
      const raw = canonicalizeInterpretation(decodePlannerCalls(result.calls, plannerTools(context), instructionOf(context), context));
      record('accepted', { shape: result.shape });
      return raw;
    } catch { record('declined', { reason: 'decode-failed' }); return undefined; }
  };
}

module.exports = { compileCommand, createCommandInterpreter, COMPILER_REASONS, SHAPES, CONFIDENCE_FLOOR, cleanTask };
