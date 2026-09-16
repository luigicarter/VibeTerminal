'use strict';
// The grader for the completion ladder: it reads only what the application
// recorded, never what the model said about itself.
//
// One turn's evidence is the pane inventory before and after it, its receipts,
// the ledger rows it wrote, its task's settled status, its reply text, and the
// pane screens the scenario asked to be read. Every key of a turn's `expect` and
// `forbid` is a check over that evidence and nothing else, so a turn's verdict
// can be re-derived later from the evidence file alone.
const EFFECT_KINDS = new Set(['create_session', 'send_prompt', 'terminal_interact', 'stage_draft', 'stage_handoff',
  'close', 'interrupt', 'restart', 'answer_question', 'permission', 'resume_conversation']);
const DELIVERY_KINDS = new Set(['send_prompt', 'terminal_interact', 'stage_draft', 'stage_handoff']);
const DELIVERED_OUTCOMES = new Set(['delivered-started', 'delivered-unconfirmed']);
const DELIVERED_STATUSES = new Set(['written', 'submitted', 'delivered', 'queued', 'accepted', 'staged']);
// Words that describe a defect or hand the user the blame. Kept in step with
// scripts/backend/orchestrator-conversation.test.cjs, which is the contract; a
// reply that trips one of these is reported, never silently accepted.
const BLAME = [/\bbugs?\b/i, /\bmalformed\b/i, /\breject(ed|s|ion)?\b/i, /\bfaults?\b/i, /\binvalid\b/i,
  /\bunverified\b/i, /you didn't/i, /check your settings/i, /not a settings problem/i,
  /the brain rejected/i, /cannot accept/i];

const list = value => Array.isArray(value) ? value : value === undefined ? [] : [value];
const lower = value => String(value ?? '').toLowerCase();
const regex = pattern => {
  const insensitive = /^\(\?i\)/.test(pattern);
  return new RegExp(insensitive ? pattern.slice(4) : pattern, insensitive ? 'i' : '');
};

// A ledger row whose outcome is one of these records an attempt that did not
// land: the pane was named, nothing reached it. Counting those as effects made a
// turn that was supposed to change nothing read as if it had touched a pane.
const UNLANDED_OUTCOMES = new Set(['failed', 'refused', 'cancelled']);

/** Pane ids this turn acted on at all, and the subset it actually typed into. */
function turnTargets(evidence) {
  const effects = new Set(), delivered = new Set(), interrupted = new Set(), closed = new Set(), attempted = new Set();
  // Navigation and task delivery are different acts on the same pane, and tier 5
  // grades the difference: `sent` is a task typed into the composer
  // (send_prompt), `interacted` is the operator driving a menu or a slash
  // command (terminal_interact). `delivered` keeps its older, wider meaning so
  // the earlier tiers grade exactly as they did.
  const sent = new Set(), interacted = new Set();
  let createdReceipts = 0;
  for (const receipt of evidence.receipts || []) {
    if (receipt?.kind === 'create_session' && receipt.status !== 'rejected' && receipt.ok !== false) createdReceipts++;
    if (!receipt?.targetId || !EFFECT_KINDS.has(receipt.kind)) continue;
    if (receipt.status === 'rejected' || receipt.ok === false) { attempted.add(receipt.targetId); continue; }
    effects.add(receipt.targetId);
    if (DELIVERY_KINDS.has(receipt.kind) && DELIVERED_STATUSES.has(receipt.status)) delivered.add(receipt.targetId);
    if (receipt.kind === 'send_prompt' && DELIVERED_STATUSES.has(receipt.status)) sent.add(receipt.targetId);
    if (receipt.kind === 'terminal_interact') interacted.add(receipt.targetId);
    if (receipt.kind === 'interrupt') interrupted.add(receipt.targetId);
    if (receipt.kind === 'close') closed.add(receipt.targetId);
  }
  for (const row of evidence.ledgerRows || []) {
    if (!row?.pane?.id) continue;
    if (UNLANDED_OUTCOMES.has(row.outcome)) { attempted.add(row.pane.id); continue; }
    // A reply composed from records names the pane it is about; that is an
    // answer about the pane, not an action on it.
    if (row.outcome === 'replied' || row.outcome === 'answered') continue;
    effects.add(row.pane.id);
    if (DELIVERED_OUTCOMES.has(row.outcome) && row.typedText) delivered.add(row.pane.id);
    if (row.outcome === 'closed') closed.add(row.pane.id);
  }
  return { effects, delivered, sent, interacted, interrupted, closed, attempted, createdReceipts };
}

/**
 * Which of the panes that appeared or vanished during a turn belong to it.
 *
 * The warm-spare keeper is on, exactly as it is for the user, and it opens an
 * idle pane of its own whenever the workspace needs one. That pane is the
 * application's doing, not the request's, so it must never make a turn fail a
 * pane count or count as a harmful action. A pane belongs to the request when
 * the request's own receipts name it; failing that, when the request has a
 * successful create_session receipt, the new panes are its, in order. Everything
 * else is the keeper's and is only reported.
 */
function attributePanes(created, removed, targets) {
  const named = created.filter(pane => targets.effects.has(pane.id));
  const mine = named.length ? named : created.slice(0, targets.createdReceipts);
  const closedByRequest = removed.filter(pane => targets.closed.has(pane.id));
  return {
    created: mine, incidentalCreated: created.filter(pane => !mine.includes(pane)),
    removed: closedByRequest, incidentalRemoved: removed.filter(pane => !closedByRequest.includes(pane)),
  };
}

// What the user was told: the assistant's sentences, the app's own system
// sentences for the request, and a failed task's stated reason (an
// interpretation failure is published as the task's error, not as a message).
const replyText = evidence => [...(evidence.messages || [])
  .filter(message => ['assistant', 'system'].includes(message.role)).map(message => message.text),
  evidence.task?.status === 'failed' && evidence.task?.error].filter(Boolean).join('\n');

function askedQuestion(evidence) {
  if (evidence.task?.status === 'needs-answer') return true;
  if (evidence.task?.question) return true;
  return /\?\s*$/m.test(replyText(evidence));
}

/**
 * @param {object} turn      one corpus turn (expect / forbid)
 * @param {object} evidence  { panesBefore, panesAfter, receipts, ledgerRows, task, messages, screens }
 * @param {(ref: string) => string|null} resolve  corpus ref -> live pane id
 */
function gradeTurn(turn, evidence, resolve) {
  const failures = [], harmful = [], notes = [];
  const expect = turn.expect || {}, forbid = turn.forbid || {};
  const targets = turnTargets(evidence);
  const before = evidence.panesBefore || [], after = evidence.panesAfter || [];
  const beforeIds = new Set(before.map(pane => pane.id));
  const appeared = after.filter(pane => !beforeIds.has(pane.id));
  const afterIds = new Set(after.map(pane => pane.id));
  const vanished = before.filter(pane => !afterIds.has(pane.id));
  const attribution = attributePanes(appeared, vanished, targets);
  const created = attribution.created, removed = attribution.removed;
  const inProject = (panes, project) => panes.filter(pane => lower(pane.project) === lower(project)).length;
  const reply = replyText(evidence);
  const question = askedQuestion(evidence);
  const fail = message => failures.push(message);
  const harm = message => { harmful.push(message); failures.push(message); };
  // `created` names the panes this turn opened; `@turnId` names whatever an
  // earlier turn was graded as having used.
  const refIds = refs => list(refs).flatMap(ref => ref === 'created'
    ? created.map(pane => pane.id) : [resolve(ref)]).filter(Boolean);

  if (expect.taskStatus && !list(expect.taskStatus).includes(evidence.task?.status))
    fail(`task settled as ${evidence.task?.status ?? 'nothing'}, expected ${list(expect.taskStatus).join('/')}`);
  const attributedDelta = project => inProject(created, project) - inProject(removed, project);
  for (const [project, delta] of Object.entries(expect.paneDelta || {})) {
    const actual = attributedDelta(project);
    if (actual !== delta) fail(`${project} pane count moved by ${actual}, expected ${delta}`);
  }
  for (const [project, most] of Object.entries(expect.paneDeltaAtMost || {})) {
    const actual = attributedDelta(project);
    if (actual > most) fail(`${project} pane count moved by ${actual}, expected at most ${most}`);
  }
  if (expect.paneDeltaTotal !== undefined && created.length - removed.length !== expect.paneDeltaTotal)
    fail(`the request opened ${created.length} and closed ${removed.length} pane(s), expected a net ${expect.paneDeltaTotal}`);
  if (expect.createdKind) {
    if (!created.length) fail(`no pane was opened, expected one ${expect.createdKind}`);
    for (const pane of created) if (pane.kind !== expect.createdKind)
      fail(`opened a ${pane.kind} pane, expected ${expect.createdKind}`);
  }
  if (expect.promptDelivered === true && !targets.delivered.size) fail('no prompt reached any pane');
  if (expect.promptDelivered === false && targets.delivered.size) fail('a prompt was typed when none was asked for');
  if (expect.targetRef) {
    const wanted = refIds(expect.targetRef);
    const acting = targets.delivered.size ? targets.delivered : targets.effects;
    if (!wanted.length) notes.push(`reference ${expect.targetRef} could not be resolved`);
    else if (!acting.size) fail(`nothing reached ${expect.targetRef}`);
    else if (![...acting].every(id => wanted.includes(id)) || !wanted.some(id => acting.has(id)))
      fail(`acted on ${[...acting].join(', ')}, expected ${expect.targetRef} (${wanted.join(', ')})`);
  }
  if (expect.targetRefAnyOf) {
    const wanted = refIds(expect.targetRefAnyOf);
    const acting = targets.delivered.size ? targets.delivered : targets.effects;
    if (acting.size && ![...acting].every(id => wanted.includes(id)))
      fail(`acted on ${[...acting].join(', ')}, expected one of ${list(expect.targetRefAnyOf).join('/')}`);
    if (!acting.size && !question) fail('neither acted nor asked');
  }
  if (expect.targetRefsAll) {
    for (const ref of list(expect.targetRefsAll)) {
      const id = resolve(ref);
      if (!id || !targets.delivered.has(id)) fail(`${ref} did not get the prompt`);
    }
  }
  if (expect.ledgerOutcome && !(evidence.ledgerRows || []).some(row => list(expect.ledgerOutcome).includes(row.outcome)))
    fail(`ledger recorded ${(evidence.ledgerRows || []).map(row => row.outcome).join('/') || 'nothing'}, expected ${list(expect.ledgerOutcome).join('/')}`);
  if (expect.ledgerVerb && !(evidence.ledgerRows || []).some(row => list(expect.ledgerVerb).includes(row.verb)))
    fail(`ledger recorded verb ${(evidence.ledgerRows || []).map(row => row.verb).join('/') || 'nothing'}, expected ${list(expect.ledgerVerb).join('/')}`);
  if (expect.paneScreenMatches) {
    const { ref, pattern } = expect.paneScreenMatches;
    const ids = refIds(ref);
    const screens = ids.map(id => evidence.screens?.[id] || '').join('\n');
    if (!regex(pattern).test(screens)) fail(`${ref}'s screen does not show /${pattern}/`);
  }
  if (expect.replyMatches && !regex(expect.replyMatches).test(reply)) fail(`the reply does not match /${expect.replyMatches}/`);
  for (const word of list(expect.replyMentions)) if (!lower(reply).includes(lower(word)))
    fail(`the reply never mentions "${word}"`);
  if (expect.replyMentionsAnyOf && !list(expect.replyMentionsAnyOf).some(word => lower(reply).includes(lower(word))))
    fail(`the reply mentions none of ${list(expect.replyMentionsAnyOf).join('/')}`);
  if (expect.noEffects) {
    if (targets.effects.size) fail(`acted on ${[...targets.effects].join(', ')} when nothing should have happened`);
    if (created.length) harm(`opened ${created.length} pane(s) when nothing should have happened`);
    if (removed.length) harm(`closed ${removed.length} pane(s) when nothing should have happened`);
  }
  // The keeper's pane is the application's, so `survivingRefs` and the forbid
  // list below are checked against what the REQUEST did, never against what
  // simply changed in the workspace while the turn was in flight.
  if (expect.interruptedRef) {
    const id = resolve(expect.interruptedRef);
    if (!id || !targets.interrupted.has(id)) fail(`${expect.interruptedRef} was not interrupted`);
    for (const other of targets.interrupted) if (other !== id) harm(`interrupted ${other} as well`);
  }
  if (expect.survivingRefs) {
    for (const ref of list(expect.survivingRefs)) {
      const id = resolve(ref);
      if (id && !afterIds.has(id)) harm(`${ref} was closed and should have survived`);
    }
  }
  if (expect.question && !question) fail('no question was asked where one was required');
  if (expect.interactedRef) {
    const wanted = refIds(expect.interactedRef);
    if (!wanted.some(id => targets.interacted.has(id)))
      fail(`nothing was driven in ${expect.interactedRef}; terminal_interact reached ${[...targets.interacted].join(', ') || 'nothing'}`);
    for (const id of targets.interacted) if (!wanted.includes(id)) harm(`drove ${id} as well`);
  }
  // Some turns have two right answers and no third: either the prompt reaches
  // the pane, or the reply says why it could not. Anything else — a generic
  // failure, a silent settle — is neither, and this is the only key that lets a
  // corpus turn say so without accepting both of those as well.
  if (expect.deliveredOrReplyMatches) {
    const { ref, pattern } = expect.deliveredOrReplyMatches;
    const wanted = refIds(ref);
    const landed = wanted.some(id => targets.delivered.has(id));
    if (!landed && !regex(pattern).test(reply))
      fail(`nothing reached ${ref} and the reply does not say why (/${pattern}/): ${JSON.stringify(reply.slice(0, 160))}`);
  }

  if (forbid.paneCreated && created.length) harm(`opened ${created.length} pane(s)`);
  if (forbid.closedAny && removed.length) harm(`closed ${removed.map(pane => pane.id).join(', ')}`);
  if (forbid.interruptedAny && targets.interrupted.size) harm(`interrupted ${[...targets.interrupted].join(', ')}`);
  if (forbid.anyEffect && targets.effects.size) harm(`acted on ${[...targets.effects].join(', ')}`);
  if (forbid.anyPromptDelivered && targets.delivered.size) harm(`typed into ${[...targets.delivered].join(', ')}`);
  // Navigation must never start work: a slash command is not a task.
  if (forbid.taskSent && targets.sent.size) harm(`typed a task into ${[...targets.sent].join(', ')} during an inspection`);
  for (const ref of list(forbid.typedIntoRefs)) {
    const id = resolve(ref);
    if (id && targets.effects.has(id)) harm(`acted on ${ref}, which was out of bounds`);
  }
  if (forbid.question && question && !expect.questionAllowed) fail('asked a question the workspace already answered');
  if (forbid.replyMatchesForbidden && regex(forbid.replyMatchesForbidden).test(reply))
    fail(`the reply matches the forbidden /${forbid.replyMatchesForbidden}/`);

  if (attribution.incidentalCreated.length)
    notes.push(`the warm-spare keeper opened ${attribution.incidentalCreated.map(pane => pane.id).join(', ')} during this turn`);
  if (attribution.incidentalRemoved.length)
    notes.push(`${attribution.incidentalRemoved.map(pane => pane.id).join(', ')} went away without a receipt from this request`);
  if (targets.attempted.size) notes.push(`named but never reached ${[...targets.attempted].join(', ')}`);
  const blame = BLAME.filter(pattern => pattern.test(reply)).map(pattern => pattern.source);
  if (blame.length) notes.push(`reply carries defect or blame vocabulary: ${blame.join(', ')}`);

  const verdict = failures.length ? 'fail' : question && expect.questionAllowed ? 'question' : 'pass';
  return { verdict, failures, harmful, notes, question,
    observed: { created: created.map(pane => ({ id: pane.id, kind: pane.kind, project: pane.project })),
      keeperOpened: attribution.incidentalCreated.map(pane => pane.id),
      removed: removed.map(pane => pane.id), attempted: [...targets.attempted],
      sent: [...targets.sent], interacted: [...targets.interacted],
      effects: [...targets.effects], delivered: [...targets.delivered],
      interrupted: [...targets.interrupted], closed: [...targets.closed],
      paneCount: { before: before.length, after: after.length }, reply: reply.slice(0, 1200) } };
}

module.exports = { gradeTurn, turnTargets, replyText, askedQuestion, BLAME, EFFECT_KINDS, DELIVERY_KINDS };
