'use strict';

const { isCloseEvidence, summarizeCloseOutcomes } = require('./orchestratorCloseOutcome.cjs');
// One source for pane and project wording, shared with the failure sentences.
const { PROVIDER_LABELS, displayLabel, projectLabel, sentence } = require('./orchestratorFailureText.cjs');

// `launched` is what the request asked to open — the launcher's own label. A
// progress line published the moment a creation is acknowledged runs ahead of
// the inventory, so without it the pane would be announced as "the terminal".
function creationDescription(outcome, sessions, launched) {
  // A pane id survives restart. Only the acknowledged launch can supply any
  // metadata missing from the receipt; neither grant arguments nor titles prove cwd.
  const identity = outcome.target;
  const session = identity?.id && identity.generation !== undefined
    ? sessions.find(item => item.id === identity.id && item.generation === identity.generation &&
      (identity.launchToken === undefined || item.launchToken === identity.launchToken)) : undefined;
  const name = displayLabel(outcome.name) || displayLabel(session?.name) ||
    displayLabel(session?.conversationTitle) || PROVIDER_LABELS[session?.kind] || displayLabel(launched) || 'the terminal';
  const project = projectLabel(outcome.cwd ?? session?.cwd);
  return `${name}${project && project !== name ? ` in ${project}` : ''}`;
}

const VIEWS = Object.freeze({ settings: 'Settings', history: 'History', orchestrator: 'Orchestrator', multi: 'the workspace', project: 'the project' });

// Direct execution has no model-written reply, so every sentence here comes
// from the shared catalogue: what Lina did with the pane, then what is next.
function outcomeSentence(outcome, sessions = [], grants = []) {
  const grant = grants.find(item => item.id === outcome.grantId);
  const id = outcome.targetId || outcome.id;
  const target = sessions.find(item => item.id === id) || grant?.targets?.find(item => item.id === id);
  const name = outcome.kind === 'create_session' ? displayLabel(outcome.name) || PROVIDER_LABELS[grant?.args?.kindOfSession] || 'the terminal'
    : target?.name || target?.conversationTitle || 'the terminal';
  const status = outcome.status;
  const say = (key, context = {}) => sentence(key, { pane: name, ...context });
  if (outcome.kind === 'watch_terminal') {
    if (status === 'watching') return say(grant?.args?.watchUntil === 'ready' ? 'watching-ready' : 'watching');
    if (status === 'ready') return say('ready');
    if (status === 'already-completed') return say('watch-already-ended');
    return say('watch-failed', { reason: outcome.error || outcome.reason });
  }
  if (['unknown', 'unconfirmed'].includes(status)) return say('delivery-unknown');
  if (outcome.ok === false || ['blocked', 'rejected', 'cancelled'].includes(status)) {
    return say('blocked', { pane: id ? name : 'that pane', reason: outcome.error || outcome.reason });
  }
  if (outcome.kind === 'remove_project') return say('project-removed');
  if (outcome.kind === 'add_project') return say('project-added');
  if (outcome.kind === 'open_folder') return say('folder-opened');
  if (outcome.kind === 'stage_draft' || status === 'staged') {
    return outcome.reason ? { text: say('staged', { reason: outcome.reason }).text, speech: say('staged').speech } : say('staged');
  }
  if (status === 'queued') return say('queued');
  if (outcome.kind === 'send_prompt') {
    return say(['written', 'submitted', 'delivered', 'sent', 'acknowledged'].includes(status) ? 'sent' : 'accepted');
  }
  if (outcome.kind === 'create_session') {
    return outcome.status === 'created' && outcome.processState === 'running'
      ? say(outcome.draftStaged ? 'created-draft' : 'created', { pane: creationDescription(outcome, sessions) })
      : say('creation-unconfirmed');
  }
  if (outcome.kind === 'interrupt') return say(status === 'stopped' ? 'stopped' : 'stop-requested');
  if (outcome.kind === 'focus_session') return say('focused');
  if (outcome.kind === 'navigate') return say('navigated', { view: VIEWS[grant?.args?.view] || 'the requested view' });
  return say('accepted-request');
}

function formatDirectOutcomes(outcomes, sessions = [], grants = []) {
  const closure = summarizeCloseOutcomes({ outcomes, sessions, grants });
  return [closure.text, ...outcomes.filter(outcome => !isCloseEvidence(outcome, grants))
    .map(outcome => outcomeSentence(outcome, sessions, grants)?.text)].filter(Boolean).join(' ');
}

module.exports = { formatDirectOutcomes, outcomeSentence, creationDescription };
