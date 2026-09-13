'use strict';
const { scoreCandidates, MIN_MATCHED_TOKENS, MIN_SCORE, RUNNER_UP_MARGIN } = require('./orchestratorOwnerMatch.cjs');
const { extractSelector, providerFamily, RESOLVER_STOPWORDS } = require('./orchestratorResolver.cjs');

// A valid pane ID proves existence, not that the user selected that conversation.
// Whether the user selected it is decided here, in code, before any input is
// sent. Everything the question needs is already held by the application: the
// sentence itself, the pane the user clicked, the pane the previous exchange
// used, the terminal question being answered, and what every pane is called. A
// separate model call used to re-derive all of that and cost a named-pane
// request 2.4 s of its own; the scorer below is the one the assignment resolver
// uses, with its stopword set, so selection and assignment can never disagree
// about what counts as naming a pane.

// A label the user said word for word. The scorer below reads a spoken, partial
// or reordered reference; this reads the exact display name, which is how a pane
// with a short generic-looking label ("Codex 1") is still identified by name.
const mentionsLabel = (text, label) => typeof label === 'string' && label.trim().length >= 3 &&
  new RegExp(`(?:^|[^\\p{L}\\p{N}_])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(text);
const GENERIC_LABELS = ['terminal', 'agent', 'session', 'pane', 'conversation', 'chat'];
// Ordinary spoken references use labels, not opaque pane IDs. Explicit typed
// ID selectors are checked separately before examining the prompt body.
const namesPane = (session, text) => [session?.name, session?.conversationTitle, session?.conversation?.title, session?.title,
  ...(Array.isArray(session?.aliases) ? session.aliases : [])].some(label => mentionsLabel(text, label) &&
    ![session?.kind, session?.provider, ...GENERIC_LABELS].some(generic => generic && String(label).trim().toLowerCase() === String(generic).toLowerCase()));

function selectionEvidence(operations, context) {
  const evidence = [], instruction = context.instruction || '';
  const add = (operation, basis, source) => evidence.push({ id: `selection-${evidence.length}`, operation, basis, source });
  const mentions = label => mentionsLabel(instruction, label);
  // These are eligibility anchors, never a task-intent parser. The semantic
  // review must still validate the requested group/provider/project and topic.
  const group = instruction.match(/\b(?:one of|any of|either of|all|every|random|idle|available|free|existing|(?:the|currently) open)\s+(?:(?:[\w-]+)\s+){0,3}(?:terminals?|sessions?|agents?|codex|claude|them|those|these)\b/i);
  operations.forEach((operation, index) => {
    const targets = operation.targets;
    const sessions = targets.map(target => context.sessions.find(session => session.id === target.id && session.generation === target.generation));
    const names = sessions.map(session => [session?.id, session?.name, session?.conversationTitle, ...(session?.aliases || [])]
      .find(label => mentions(label) && ![session?.kind, session?.provider, 'terminal', 'agent', 'session'].some(generic => generic && label.toLowerCase() === generic.toLowerCase())));
    if (targets.length && names.every(Boolean)) add(index, 'named', names);
    if (targets.length === 1 && targets[0].id === context.targetId) add(index, 'user-selected-pane', context.targetId);
    if (group) add(index, 'existing-group', group[0]);
    const replyTargets = [context.replyContext?.conversationTarget, ...(context.replyContext?.submittedTask?.targets || [])].filter(Boolean);
    if (targets.length && targets.every(target => replyTargets.some(reply => reply.id === target.id && reply.generation === target.generation))) add(index, 'reply-continuation', context.replyContext.requestId);
    if (targets.length === 1 && targets[0].id === context.interactionContext?.sessionId && targets[0].generation === context.interactionContext.generation) add(index, 'current-interaction', context.interactionContext.id);
  });
  return evidence;
}

// ---------------------------------------------------------------------------
// The deterministic selection check.
// ---------------------------------------------------------------------------

const PANE_NOUN = String.raw`(?:terminals?|panes?|agents?|sessions?|workers?)`;
const PROVIDER_WORD = String.raw`(?:codex|claude|gemini|qwen|kimi|cursor|grok|opencode|open ?fusion|fusion|open ?codex)`;
// "Prompt a Codex terminal in Alpha to fix Y" names a provider and a project,
// never a conversation, even when exactly one Codex is open: the article is the
// difference between the pane that exists and any pane of that kind. A sentence
// asking for a worker by category is assignment's question, not a selection.
const INDEFINITE_WORKER = new RegExp(String.raw`\b(?:a|an|another|some|any)\s+(?:\w+\s+){0,2}(?:${PANE_NOUN}|${PROVIDER_WORD})\b`, 'iu');
const INDEFINITE_PROVIDER = new RegExp(String.raw`\b(?:a|an|another|some|any)\s+(?:\w+\s+){0,2}${PROVIDER_WORD}\b`, 'iu');
const GROUP_PHRASE = new RegExp(String.raw`\b(?:one|any|either|each|all)\s+of\s+(?:the\s+|your\s+|my\s+)?(?:\w+\s+){0,3}(?:${PANE_NOUN}|them|those|these)\b`, 'iu');
const CATEGORY_PANE = new RegExp(String.raw`\b(?:random|idle|free|available|spare|new|fresh)\s+(?:\w+\s+){0,2}${PANE_NOUN}\b`, 'iu');
// Any request for a worker by category overrides an implied target. The provider
// rule looks only at the provider mention, so a sentence that describes the bug
// ("you couldn't prompt a terminal while it's working") can still address "the
// codex terminal" it names.
const anotherWorker = text => INDEFINITE_WORKER.test(text) || GROUP_PHRASE.test(text) || CATEGORY_PANE.test(text);
const anotherProvider = text => INDEFINITE_PROVIDER.test(text) || GROUP_PHRASE.test(text) || CATEGORY_PANE.test(text);
// "The Codex terminal in Alpha" and "the Claude Code terminal in lina web app"
// point at a pane; "my Codex session usage" and "a Codex" do not. Only a
// definite pane reference may select the single pane of that family.
const DEFINITE_PROVIDER = new RegExp([
  String.raw`\b(?:the|that|this)\s+(?:\w+\s+){0,2}${PROVIDER_WORD}\b`,
  String.raw`\b${PROVIDER_WORD}\s+in\s+`,
].join('|'), 'iu');
// "Have every Codex in Alpha review the last changes" selects a whole group, not
// one conversation. It is a selection when the plan addresses that entire group
// and nothing else; a partial fan-out is assignment's question.
const ALL_MATCHING = new RegExp(String.raw`\b(?:all|every|each|both)\s+(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:\w+\s+){0,3}(?:${PANE_NOUN}|${PROVIDER_WORD}|them|those|these)\b`, 'iu');
// A reference back to a pane already in play. The previous exchange's pane is an
// implicit target, so it only carries a follow-up that actually points at it.
const DEICTIC = new RegExp([
  String.raw`\b(?:it|its|there|them|they)\b`,
  String.raw`\b(?:that|this|those|these|the same)\s+(?:\w+\s+){0,2}(?:${PANE_NOUN}|one|ones|conversations?|chats?|thing)\b`,
  String.raw`\b(?:tell|ask|prompt|have|let|remind|send)\s+(?:that|this|them|those|him|her)\b`,
].join('|'), 'iu');
// One request can address two panes ("continue X in Atlas and get a Codex to
// fix Y"). Each proposed operation is then checked against the part of the
// sentence its own composed text came from, so a named sibling keeps its pane
// while the unselected half goes to assignment.
const CLAUSE_SPLIT = /\s+(?:and(?:\s+then)?|then|also|plus)\s+|\s*;\s*|(?<=[.!?])\s+/i;

const sameFolder = (left, right) => {
  const identity = value => String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return typeof left === 'string' && typeof right === 'string' && Boolean(left) && identity(left) === identity(right);
};
const folderName = value => String(value ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
const paneTexts = session => [session?.conversationTitle, session?.conversation?.title, session?.title, session?.name,
  ...(Array.isArray(session?.aliases) ? session.aliases : [])];

function proposedOperations(plan, context) {
  return (plan?.grants || []).filter(grant => grant && grant.sourceUserId === context.requestId
    && !grant.inspection && ['operate_terminal', 'send_prompt'].includes(grant.kind));
}

// Returns { decision: 'DIRECT' | 'ASSIGN', operations: [{ index, decision, basis }] }
// for a plan that proposes existing targets, or null when it proposes none.
// DIRECT means send as planned. ASSIGN means the user left the conversation
// open: the caller repairs the plan into delegate_task and the deterministic
// resolver picks the pane or asks. There is no unresolved outcome.
function reviewExistingTargets(plan, context = {}) {
  const operations = proposedOperations(plan, context);
  if (!operations.length) return null;
  const instruction = String(context.normalizedText ?? context.instruction ?? '');
  const sessions = Array.isArray(context.sessions) ? context.sessions : [];
  const addressedFolder = context.projectContext?.path || context.projectContext?.cwd || context.workspaceContext?.cwd;
  // A pane in another project than the one the sentence addresses is not the
  // pane the user meant, however well its title scores.
  const panes = addressedFolder ? sessions.filter(session => sameFolder(session?.cwd, addressedFolder)) : sessions;
  const projectName = context.projectContext?.name || folderName(addressedFolder);
  const replyTargets = [context.replyContext?.conversationTarget, ...(context.replyContext?.submittedTask?.targets || [])].filter(Boolean);
  const interaction = context.interactionContext;
  const selected = target => target.id === context.targetId ||
    Boolean(interaction) && target.id === interaction.sessionId && target.generation === interaction.generation;
  const continued = target => replyTargets.some(reply => reply.id === target.id && reply.generation === target.generation);

  // Which panes this part of the sentence names. `ids` is the unambiguous
  // answer; `eligible` is every pane whose own distinctive words the user said,
  // so a competing name can veto a target the user only implied.
  // `strict` drops the sole-candidate allowance: when the sentence also asks for
  // a worker by category, a weak overlap with the one open pane's title is not
  // the user naming it.
  const namedPanes = (text, strict) => {
    const scored = scoreCandidates({ instruction: text, projectName, stopwords: RESOLVER_STOPWORDS, perText: true,
      candidates: panes.map(session => ({ id: session.id, texts: paneTexts(session) })) });
    const eligible = scored.filter(item => item.matched >= MIN_MATCHED_TOKENS);
    if (!eligible.length || !(eligible[0].score >= MIN_SCORE || !strict && eligible.length === 1)) return { ids: [], eligible };
    return { ids: eligible.filter(item => item.score > eligible[0].score - RUNNER_UP_MARGIN).map(item => item.id), eligible };
  };

  const decide = (operation, text) => {
    const targets = (Array.isArray(operation.targets) ? operation.targets : []).filter(Boolean);
    if (!targets.length) return { decision: 'ASSIGN', basis: 'no-target' };
    const ids = new Set(targets.map(target => target.id));
    if (!targets.every(target => panes.some(pane => pane.id === target.id))) return { decision: 'ASSIGN', basis: 'outside-addressed-project' };
    // The literal Send <id>: form is also part of the UI/API command contract.
    // Only the recipient position counts: an ID inside task text cannot grant
    // input to that pane, and a different model-selected recipient is refused.
    const explicit = text.match(/^\s*(?:please\s+)?(?:send(?:\s+to)?|tell|ask|prompt|write\s+to|type\s+into)\s+(?:(?:the\s+)?(?:terminal|pane|session|agent)\s+)?([a-zA-Z0-9_.-]+)\s*(?::|,|\bto\b)/i);
    if (explicit && panes.some(pane => pane.id === explicit[1])) {
      return targets.length === 1 && targets[0].id === explicit[1]
        ? { decision: 'DIRECT', basis: 'explicit-pane-id' }
        : { decision: 'ASSIGN', basis: 'explicit-pane-id-mismatch' };
    }
    // 'new', 'idle' and 'just_opened' are the resolver's own selections; only a
    // title, a provider or a bare sentence can select an existing conversation.
    const selector = extractSelector(text, { launchers: context.launchers || [] });
    if (!['none', 'title', 'provider'].includes(selector.kind)) return { decision: 'ASSIGN', basis: `selector-${selector.kind}` };
    const another = anotherWorker(text);
    const scored = namedPanes(text, another);
    const named = new Set([...scored.ids, ...panes.filter(pane => namesPane(pane, text)).map(pane => pane.id)]);
    if (named.size === ids.size && [...named].every(id => ids.has(id))) return { decision: 'DIRECT', basis: 'named' };
    if (ALL_MATCHING.test(text)) {
      const family = selector.provider && providerFamily(selector.provider);
      const group = panes.filter(pane => !family || providerFamily(pane.provider || pane.kind) === family);
      if (group.length && group.length === ids.size && group.every(pane => ids.has(pane.id))) return { decision: 'DIRECT', basis: 'all-matching' };
    }
    if (!another && !named.size && !scored.eligible.some(item => !ids.has(item.id))) {
      if (targets.every(selected)) return { decision: 'DIRECT', basis: 'user-selected' };
      if (targets.every(target => selected(target) || continued(target)) && DEICTIC.test(text)) return { decision: 'DIRECT', basis: 'continuation' };
    }
    if (!anotherProvider(text) && selector.kind === 'provider' && targets.length === 1 && DEFINITE_PROVIDER.test(text)) {
      const family = providerFamily(selector.provider);
      const matching = panes.filter(pane => providerFamily(pane.provider || pane.kind) === family);
      if (matching.length === 1 && matching[0].id === targets[0].id) return { decision: 'DIRECT', basis: 'provider-project' };
    }
    return { decision: 'ASSIGN', basis: 'unselected' };
  };

  const clauses = operations.length > 1 ? instruction.split(CLAUSE_SPLIT).map(part => String(part || '').trim()).filter(part => part.length > 2) : [];
  const clauseFor = operation => {
    if (clauses.length < 2) return instruction;
    const [best] = scoreCandidates({ instruction: String(operation.text ?? ''), stopwords: RESOLVER_STOPWORDS,
      projectName, candidates: clauses.map((clause, index) => ({ id: index, texts: [clause] })) });
    return best && best.matched >= 1 ? clauses[best.id] : instruction;
  };
  const reviewed = operations.map((operation, index) => ({ index, ...decide(operation, clauseFor(operation)) }));
  return { decision: reviewed.every(item => item.decision === 'DIRECT') ? 'DIRECT' : 'ASSIGN', operations: reviewed };
}

function eligibleExistingTargets(context = {}) {
  const sessions = context.sessions || [];
  const operations = sessions.map(session => ({ targets: [{ id: session.id, generation: session.generation }] }));
  return [...new Set(selectionEvidence(operations, { ...context, sessions }).map(item => sessions[item.operation].id))];
}
module.exports = { reviewExistingTargets, eligibleExistingTargets };
