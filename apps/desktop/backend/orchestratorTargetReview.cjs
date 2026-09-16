'use strict';
const { resolveReference, terminalsOf, providerFamily, STATE_KINDS, SHELL_KINDS } = require('./orchestratorReference.cjs');
const { sameFolder } = require('./orchestratorTerminalModel.cjs');

// A valid pane ID proves existence, not that the user selected that conversation.
// Whether the user selected it is decided here, in code, before any input is
// sent. Everything the question needs is already held by the application: the
// sentence itself, the pane the user clicked, the pane the previous exchange
// used, the terminal question being answered, and what every pane is called. A
// separate model call used to re-derive all of that and cost a named-pane
// request 2.4 s of its own. The sentence is read once, by the reference
// resolver, against the same terminal model assignment reads, so selection and
// assignment can never disagree about what a sentence points at.

// One request can address two panes ("continue X in Atlas and get a Codex to
// fix Y"). Each proposed operation is then checked against the part of the
// sentence its own composed text came from, so a named sibling keeps its pane
// while the unselected half goes to assignment.
const CLAUSE_SPLIT = /\s+(?:and(?:\s+then)?|then|also|plus)\s+|\s*;\s*|(?<=[.!?])\s+/i;
const folderName = value => String(value ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';

function proposedOperations(plan, context) {
  // The grant index is the action index: normalization maps actions to grants
  // one for one, so a reviewed operation can name the action it came from and
  // the caller can rewrite exactly that action.
  return (plan?.grants || []).map((grant, grantIndex) => ({ grant, grantIndex }))
    .filter(({ grant }) => grant && grant.sourceUserId === context.requestId
      && !grant.inspection && ['operate_terminal', 'send_prompt'].includes(grant.kind));
}

// Returns { decision: 'DIRECT' | 'ASSIGN', operations: [{ index, decision, basis, reference }] }
// for a plan that proposes existing targets, or null when it proposes none.
// DIRECT means send as planned. ASSIGN means the user left the conversation
// open: the caller repairs the plan into delegate_task and the deterministic
// resolver picks the pane or asks. There is no unresolved outcome.
function reviewExistingTargets(plan, context = {}) {
  const proposed = proposedOperations(plan, context);
  if (!proposed.length) return null;
  const operations = proposed.map(item => item.grant);
  const instruction = String(context.normalizedText ?? context.instruction ?? '');
  const terminals = terminalsOf(context);
  const addressedFolder = context.projectContext?.path || context.projectContext?.cwd || context.workspaceContext?.cwd;
  // A pane in another project than the one the sentence addresses is not the
  // pane the user meant, however well its title scores.
  const inFolder = terminal => !addressedFolder || sameFolder(terminal.cwd, addressedFolder);
  const projectName = context.projectContext?.name || folderName(addressedFolder);
  const replyTargets = [context.replyContext?.conversationTarget, ...(context.replyContext?.submittedTask?.targets || [])].filter(Boolean);
  const interaction = context.interactionContext;
  const selected = target => target.id === context.targetId ||
    Boolean(interaction) && target.id === interaction.sessionId && target.generation === interaction.generation;
  const continued = target => replyTargets.some(reply => reply.id === target.id && reply.generation === target.generation);

  const decideTargets = (operation, text) => {
    const reference = resolveReference(text, terminals, { launchers: context.launchers || [], cwd: addressedFolder, projectName });
    const decided = (decision, basis, extra = {}) => ({ decision, basis, reference, ...extra });
    const targets = (Array.isArray(operation.targets) ? operation.targets : []).filter(Boolean);
    if (!targets.length) return decided('ASSIGN', 'no-target');
    const ids = new Set(targets.map(target => target.id));
    const matches = list => list.length === ids.size && list.every(terminal => ids.has(terminal.id));
    // "Both terminals that are done" reaches across projects when it fans out;
    // a single working or done pane is still looked for where the sentence is
    // spoken.
    const pool = reference.stateFanOut ? reference.pool : terminals.filter(inFolder);
    if (!targets.every(target => pool.some(pane => pane.id === target.id))) return decided('ASSIGN', 'outside-addressed-project');
    // A pane picked for what it is doing is checked against what it is doing:
    // the plan may keep the one working pane, or every done pane when the
    // sentence asks for all of them. Anything else is assignment's question. A
    // fan-out the roster cannot confirm keeps the panes the plan named: one
    // free pane would not be "both terminals" either.
    if (STATE_KINDS.has(reference.kind)) {
      if (reference.exact && matches(reference.terminals)) return decided('DIRECT', 'state-matching');
      return decided('ASSIGN', `selector-${reference.kind}`, reference.stateFanOut ? { fanOut: true } : {});
    }
    // The literal Send <id>: form is also part of the UI/API command contract.
    // Only the recipient position counts: an ID inside task text cannot grant
    // input to that pane, and a different model-selected recipient is refused.
    const explicit = text.match(/^\s*(?:please\s+)?(?:send(?:\s+to)?|tell|ask|prompt|write\s+to|type\s+into)\s+(?:(?:the\s+)?(?:terminal|pane|session|agent)\s+)?([a-zA-Z0-9_.-]+)\s*(?::|,|\bto\b)/i);
    if (explicit && pool.some(pane => pane.id === explicit[1])) {
      return targets.length === 1 && targets[0].id === explicit[1] ? decided('DIRECT', 'explicit-pane-id') : decided('ASSIGN', 'explicit-pane-id-mismatch');
    }
    // A handle, a title, a provider, a bare sentence, or a reference back to the
    // pane Lina last used can select an existing conversation; 'new', 'idle'
    // and 'just_opened' are assignment's own selections.
    if (['new', 'idle', 'just_opened'].includes(reference.kind)) return decided('ASSIGN', `selector-${reference.kind}`);
    if (reference.kind === 'handle') return reference.exact && matches(reference.terminals) ? decided('DIRECT', 'handle') : decided('ASSIGN', 'selector-handle');
    if (reference.kind === 'last_target' && reference.exact && matches(reference.terminals)) return decided('DIRECT', 'last-target');
    // "The other one" is the pane other than the one Lina last used, when
    // exactly one such pane exists; otherwise it is assignment's question. The
    // plan's own guess is not accepted here: on the ladder the guess went into
    // an idle pane, queued behind that project's work for the whole request,
    // and the pane it then woke was counted as "done" three turns later.
    if (reference.kind === 'other') return reference.exact && matches(reference.terminals) ? decided('DIRECT', 'other') : decided('ASSIGN', 'selector-other');
    // Which panes this part of the sentence names: every pane whose own
    // distinctive words the user said, so a competing name can veto a target
    // the user only implied.
    if (reference.named.length && matches(reference.named)) return decided('DIRECT', 'named');
    const family = reference.provider && providerFamily(reference.provider);
    const ofFamily = pool.filter(pane => inFolder(pane) && (!family || providerFamily(pane.provider) === family));
    if (reference.all && ofFamily.length && matches(ofFamily)) return decided('DIRECT', 'all-matching');
    if (!reference.indefinite && !reference.named.length && !reference.eligible.some(id => !ids.has(id))) {
      if (targets.every(selected)) return decided('DIRECT', 'user-selected');
      if (targets.every(target => selected(target) || continued(target)) && reference.deictic) return decided('DIRECT', 'continuation');
    }
    if (reference.kind === 'provider' && reference.exact && matches(reference.terminals)) return decided('DIRECT', 'provider-project');
    return decided('ASSIGN', 'unselected');
  };

  const clauses = operations.length > 1 ? instruction.split(CLAUSE_SPLIT).map(part => String(part || '').trim()).filter(part => part.length > 2) : [];
  const clauseFor = operation => {
    if (clauses.length < 2) return instruction;
    const { scoreCandidates } = require('./orchestratorOwnerMatch.cjs');
    const { RESOLVER_STOPWORDS } = require('./orchestratorReference.cjs');
    const [best] = scoreCandidates({ instruction: String(operation.text ?? ''), stopwords: RESOLVER_STOPWORDS,
      projectName, candidates: clauses.map((clause, index) => ({ id: index, texts: [clause] })) });
    return best && best.matched >= 1 ? clauses[best.id] : instruction;
  };
  const reviewed = operations.map((operation, index) => {
    const text = clauseFor(operation);
    return { index, grantIndex: proposed[index].grantIndex, text, ...decideTargets(operation, text) };
  });
  return { decision: reviewed.every(item => item.decision === 'DIRECT') ? 'DIRECT' : 'ASSIGN', operations: reviewed };
}

// ---------------------------------------------------------------------------
// The repair. An unselected operation used to be sent back to the model as a
// sentence telling it the user had chosen no conversation, which asked it to
// re-derive facts this process already holds and, on nine of thirty-five saved
// requests, ended the request instead. Nothing is asked of a model here.
//
// There are exactly two answers. A sentence that asks for a worker by kind -
// "one of the empty Codex terminals", "a terminal that's not currently
// working", "the terminal you just opened", a task title - is assignment's
// question, so the operation becomes delegate_task and the one deterministic
// resolver picks the pane (it holds what this stage does not: the pane Lina
// opened a moment ago, live work items, fresh inventory). A sentence that
// points at a conversation the reviewer merely could not confirm - "the Codex
// terminal that's currently working", "the codex terminal in lina web app",
// "both terminals that are currently done" - keeps the panes the plan named:
// they came off the same roster this stage is reading, and replacing them with
// a free pane would be the guess, not the check.
// ---------------------------------------------------------------------------

// Reference kinds assignment resolves by a rule of its own. Any other kind -
// including one added later - leaves a pointed-at pane alone.
const ASSIGNMENT_KINDS = new Set(['new', 'idle', 'just_opened', 'title', 'working', 'done', 'last_target', 'other', 'handle']);
const CARRIED_FIELDS = ['text', 'promptMode', 'permissionMode', 'answerMode', 'lifecycleMode', 'answerText', 'answerTexts'];

function delegatedAction(action, operation, context) {
  const sessions = Array.isArray(context.sessions) ? context.sessions : [];
  const addressedFolder = context.projectContext?.path || context.projectContext?.cwd || context.workspaceContext?.cwd;
  const proposed = sessions.find(session => session.id === (action.targetIds || [])[0]);
  const cwd = addressedFolder || proposed?.cwd;
  if (typeof cwd !== 'string' || !cwd) return undefined;
  const launchers = Array.isArray(context.launchers) ? context.launchers : [];
  const available = kind => Boolean(kind) && launchers.some(launcher => launcher?.kind === kind && launcher.available !== false);
  const kindOfSession = [action.kindOfSession, operation.reference?.provider, proposed?.kind, proposed?.provider].find(available);
  return { kind: 'delegate_task', ...(action.sourceUserId !== undefined && { sourceUserId: action.sourceUserId }),
    cwd, assignmentMode: 'auto', operationMode: 'task', ...(kindOfSession && { kindOfSession }),
    ...Object.fromEntries(CARRIED_FIELDS.filter(field => action[field] !== undefined).map(field => [field, action[field]])) };
}

// Returns { actions } when at least one operation was repaired, or undefined
// when the plan already says what the application would have said.
function repairUnselectedTargets(raw, review, context = {}) {
  if (!review || review.decision === 'DIRECT' || !Array.isArray(raw?.actions)) return undefined;
  const actions = [...raw.actions];
  let changed = false;
  for (const operation of review.operations) {
    if (operation.decision === 'DIRECT' || operation.fanOut) continue;
    const action = actions[operation.grantIndex];
    if (!action || typeof action !== 'object') continue;
    // Stopping or quitting a pane is never rewritten into a task for one.
    if (['interrupt', 'exit'].includes(action.lifecycleMode)) continue;
    const assignment = ['no-target', 'outside-addressed-project', 'explicit-pane-id-mismatch'].includes(operation.basis)
      || operation.reference?.indefinite === true || ASSIGNMENT_KINDS.has(operation.reference?.kind) || action.targetAvailability === 'idle';
    if (!assignment) continue;
    const delegated = delegatedAction(action, operation, context);
    if (!delegated) continue;
    actions[operation.grantIndex] = delegated;
    changed = true;
  }
  return changed ? { ...raw, actions } : undefined;
}

// Panes outside the addressed project the Brain should still see: the ones
// the sentence names by their exact label, every pane when it reaches into a
// group of existing panes ("one of the open terminals"), and every pane in the
// state a fan-out describes ("both terminals that are currently done" reaches
// into other projects, so the Brain can see them and name them).
function eligibleExistingTargets(context = {}) {
  const text = String(context.normalizedText ?? context.instruction ?? '');
  const terminals = terminalsOf(context);
  const reference = resolveReference(text, terminals, { launchers: context.launchers || [],
    cwd: context.projectContext?.path, projectName: context.projectContext?.name || '' });
  const eligible = [...reference.mentioned, ...(reference.exact ? reference.terminals : []),
    ...(reference.group ? reference.stateFanOut ? reference.pool : terminals.filter(pane => !SHELL_KINDS.has(pane.provider)) : []),
    ...(reference.stateFanOut ? reference.candidates : [])];
  return [...new Set(eligible.map(terminal => terminal.id))];
}
module.exports = { reviewExistingTargets, eligibleExistingTargets, repairUnselectedTargets };
