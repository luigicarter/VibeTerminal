'use strict';
const { handoffTargets } = require('./orchestratorHandoff.cjs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { formatTaskWait } = require('./orchestratorTaskStatus.cjs');
const { routingBindingMatches } = require('./orchestratorLaunchers.cjs');
const launchers = new Set([...Object.keys(require('../shared/providerCapabilities.json')), 'claude-custom']);
const directKinds = new Set(['send_prompt', 'stage_draft', 'focus_session', 'navigate', 'interrupt', 'watch_terminal', 'add_project', 'remove_project', 'open_folder']);

function canExecuteDirect(plan) {
  return plan.executionMode === 'direct' && !plan.clarification &&
    !plan.dependsOnRequestIds.length && plan.grants.length > 0 && plan.grants.every(grant =>
      directKinds.has(grant.kind) || grant.kind === 'close' && Boolean(grant.closeScope) || grant.kind === 'create_session' && !plan.afterResults && grant.text === undefined &&
      launchers.has(grant.args.kindOfSession) && typeof grant.args.cwd === 'string' && path.isAbsolute(grant.args.cwd));
}

// A routed task's control phase delivers its objective to the assigned worker.
// Once that delivery has been observed, a model-written finish is redundant.
// Return only proposals: the ordinary dispatcher still validates and consumes
// their exact grant, step and post-action observation before recording success.
function delegatedSubmissionFinishes({ plan, outcomes = [], waits = [], sessions = [], observations, modelRound,
  getOperation, pendingRequests = [] } = {}) {
  if (!plan || plan.clarification || plan.responseKind === 'terminal-inspection' ||
      !observations?.latest || !observations?.authorize || typeof getOperation !== 'function') return [];
  const delivered = new Set(['written', 'submitted', 'delivered', 'sent', 'acknowledged']);
  const actions = [];
  for (const grant of plan.grants || []) for (const handoff of handoffTargets(grant)) {
    if (typeof handoff.cwd !== 'string' || !handoff.cwd) continue;
    const { target, binding } = handoff;
    const matches = sessions.filter(session => session.id === target.id);
    const session = matches.length === 1 ? matches[0] : undefined;
    const kind = session?.kind || session?.provider;
    if (!session || session.generation !== target.generation || binding.id !== target.id || binding.generation !== target.generation ||
        kind !== handoff.kindOfSession || ['terminal', 'shell'].includes(kind) ||
        !routingBindingMatches({ target: binding, nativeIdentity: { workspace: handoff.cwd, id: binding.conversationId } }, session)) continue;
    const chat = ['fusion', 'openfusion'].includes(kind);
    if (session.started === false || ['failed', 'exited'].includes(session.processState) || (chat ? session.engineReady !== true : session.processState !== 'running' ||
        session.agentProcessState !== 'running' || !(Number(session.agentPid) > 0) || session.observation !== 'observed') ||
        ['failed', 'exited', 'closed', 'paused', 'starting', 'waiting'].includes(session.status) || session.turnState === 'waiting' ||
        session.pendingInput || session.pendingInteraction || session.manualInputPending || session.interactionInputPending || session.heldMouseButton ||
        session.pendingInteractions?.length || ['question', 'approval'].includes(session.attention?.reason) ||
        pendingRequests.some(request => request.sessionId === target.id && (request.generation === undefined || request.generation === target.generation) && request.state === 'pending')) continue;
    const operation = getOperation(grant, target.id);
    if (!operation || operation.uncertain || operation.nativeRecipient && (session.agentProcessState !== 'running' || session.agentPid !== operation.nativeRecipient.pid)) continue;
    if (outcomes.some(outcome => outcome.kind === 'finish_terminal' && outcome.grantId === grant.id &&
        (outcome.targetId || outcome.target?.id || outcome.id) === target.id && !outcome.validationFailure)) continue;
    const targetWaits = waits.filter(wait => wait.source !== 'watch' && wait.targetId === target.id && wait.generation === target.generation);
    // Multiple task submissions require the ordinary operator to account for
    // their separate meanings; this repair certifies one delegated delivery.
    if (targetWaits.length !== 1) continue;
    const wait = targetWaits[0];
    if (!wait.actionId || wait.delivered !== true || !delivered.has(wait.deliveryStatus) || wait.staged || wait.failed ||
        wait.attributionAmbiguous || wait.nativeShell || wait.observedState === 'waiting' || !wait.nativeIdentity ||
        !routingBindingMatches({ target: binding, nativeIdentity: wait.nativeIdentity }, session)) continue;
    const receipt = outcomes.filter(outcome => outcome.grantId === grant.id && outcome.actionId === wait.actionId &&
      ['send_prompt', 'terminal_interact'].includes(outcome.kind)).at(-1);
    const receiptId = receipt?.targetId || receipt?.target?.id || receipt?.id;
    const receiptGeneration = receipt?.generation ?? receipt?.target?.generation;
    if (!receipt || receipt.ok !== true || receipt.delivery === 'not-dispatched' ||
        !delivered.has(receipt.status) && receipt.status !== 'queued' || receiptId !== undefined && receiptId !== target.id ||
        receiptGeneration !== undefined && receiptGeneration !== target.generation) continue;
    const observationToken = observations.latest(session, modelRound);
    if (!observationToken) continue;
    try { observations.authorize(observationToken, session, { kind: 'finish_terminal' }, pendingRequests.filter(request =>
      request.sessionId === target.id && (request.generation === undefined || request.generation === target.generation) && request.state === 'pending')); }
    catch { continue; }
    const text = formatTaskWait(wait, session);
    const stepId = 'delegated-finish-' + createHash('sha256').update(JSON.stringify([grant.id, target, wait.actionId, observationToken, text])).digest('hex');
    actions.push({ kind: 'finish_terminal', grantId: grant.id, targetId: target.id, stepId, observationToken, outcome: 'completed', text });
  }
  return actions;
}

// Use only consumed, validated finish receipts. This is the final response of
// an observed interaction, never evidence that a delegated agent task finished.
function completedOperatorResponse({ plan, progress, outcomes, sessions, getOperation, pendingRequests = [], pendingResultTargets = [], deliveryWaits = [], deliveryUpdates = [] }) {
  if (plan.clarification || plan.afterResults || !plan.grants.length ||
      plan.grants.some(grant => grant.kind !== 'operate_terminal' || !grant.targets.length)) return;
  const uncertain = new Set(['unknown', 'unconfirmed', 'uncertain', 'write-failed']);
  if (deliveryWaits.some(wait => wait.failed || uncertain.has(wait.deliveryStatus)) ||
      deliveryUpdates.some(update => update.ok === false || uncertain.has(update.status))) return;
  const summaries = [];
  const completed = new Set();
  for (const grant of plan.grants) {
    if (!progress.grants.find(item => item.id === grant.id)?.dispatched) return;
    for (const target of grant.targets) {
      const session = sessions.find(item => item.id === target.id && item.generation === target.generation);
      if (!session || getOperation(grant, target.id)?.uncertain || pendingRequests.some(request =>
        request.sessionId === target.id && (request.generation === undefined || request.generation === target.generation) && request.state === 'pending')) return;
      const finish = outcomes.filter(item => item.kind === 'finish_terminal' && item.grantId === grant.id && item.targetId === target.id).at(-1);
      if (!finish?.ok || finish.status !== 'interaction-complete' || !finish.text?.trim()) return;
      completed.add(JSON.stringify([grant.id, target.id]));
      // Keep stale-generation evidence in the response: dropping it would let
      // an untrusted finish summary certify work in a replacement terminal.
      const waits = deliveryWaits.filter(wait => wait.targetId === target.id);
      // Finishing the control loop does not prove the delegated task started.
      // Preserve free-form summaries only for operations with no submitted task.
      let text = waits.length ? [...new Set(waits.map(wait => formatTaskWait(wait, session)))].join(' ') : finish.text.trim();
      const queued = deliveryWaits.some(wait => wait.targetId === target.id && wait.deliveryStatus === 'queued' && !wait.delivered && !wait.done);
      if (!waits.length && queued) text += ' The prompt is queued and has not been sent yet.';
      else if (!waits.length && pendingResultTargets.includes(target.id)) text += ' The agent result is still pending.';
      summaries.push({ name: session.name || session.conversationTitle || target.id, text });
    }
  }
  if (outcomes.some(item => item.ok === false && !completed.has(JSON.stringify([item.grantId, item.targetId])))) return;
  return summaries.map(item => summaries.length > 1 ? `${item.name}: ${item.text}` : item.text).join('\n\n');
}

module.exports = { canExecuteDirect, completedOperatorResponse, delegatedSubmissionFinishes };
