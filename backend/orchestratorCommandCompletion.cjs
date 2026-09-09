'use strict';

const pending = new Set(['queued', 'unknown', 'unconfirmed', 'uncertain', 'write-failed', 'blocked', 'rejected', 'cancelled', 'failed', 'needs-answer']);
const sent = new Set(['written', 'submitted', 'delivered', 'sent', 'acknowledged']);
const completed = new Set([...sent, 'interaction-complete', 'staged', 'created', 'navigated', 'focused', 'opened', 'added', 'saved', 'launched', 'resumed', 'remembered', 'forgotten', 'stopped', 'ready', 'already-completed']);
const id = value => value.targetId || value.target?.id || value.id;
const generation = value => value.generation ?? value.target?.generation;
const sameAction = (a, b) => a.actionId && a.actionId === b.actionId && id(a) === id(b) && generation(a) === generation(b);

// A command acknowledgment certifies its requested effects, not the work of a
// delegated agent. Only application-owned progress and receipts qualify it.
function commandCompleted({ plan, progress, unfinished = [], failed, question, responseTurn, deferred,
  outcomes = [], waits = [], deliveryUpdates = [], sessions = [] }) {
  if (!plan.grants.length || plan.clarification || ['task-status', 'terminal-inspection'].includes(plan.responseKind) || deferred || failed || question ||
      responseTurn !== 'complete' || unfinished.length || progress.grants.some(grant => !grant.dispatched || grant.blockedTargetIds?.length)) return false;
  for (const wait of waits) {
    const explicitDraft = plan.grants.some(grant => grant.kind === 'stage_draft' && grant.targets.some(target => target.id === wait.targetId && target.generation === wait.generation));
    if (wait.failed || wait.attributionAmbiguous || pending.has(wait.deliveryStatus) && !(wait.deliveryStatus === 'queued' && wait.delivered) ||
        !explicitDraft && (wait.staged || wait.deliveryStatus === 'staged') || wait.observedState === 'waiting' || wait.source === 'watch' && !wait.done) return false;
    const session = sessions.find(session => session.id === wait.targetId && session.generation === wait.generation);
    if (!session || session.pendingInput) return false;
    if (wait.nativeIdentity && !require('./orchestratorLaunchers.cjs').routingBindingMatches({ target: { id: wait.targetId, generation: wait.generation }, nativeIdentity: wait.nativeIdentity }, session)) return false;
  }
  for (const grant of plan.grants) for (const target of grant.targets.length ? grant.targets : [null]) {
    const matching = outcomes.filter(outcome => outcome.grantId === grant.id && (!target || id(outcome) === target.id));
    let receipt = matching.filter(outcome => outcome.kind === (grant.kind === 'operate_terminal' ? 'finish_terminal' : grant.kind)).at(-1);
    if (grant.kind === 'watch_terminal' && receipt?.ok) {
      const wait = waits.find(wait => wait.source === 'watch' && wait.targetId === target?.id && wait.generation === target?.generation);
      if (!wait?.done || wait.failed) return false;
      receipt = { ...receipt, status: wait.watchUntil === 'ready' ? 'ready' : 'already-completed' };
    }
    if (!receipt?.ok || pending.has(receipt.status) && !(receipt.kind === 'send_prompt' && waits.some(wait => sameAction(wait, receipt) && wait.delivered && !wait.failed))) return false;
    if (!completed.has(receipt.status) && !(receipt.status === undefined && ['focus_session', 'add_project', 'create_project', 'save_setup', 'launch_setup'].includes(grant.kind)) &&
        !(receipt.kind === 'send_prompt' && receipt.status === 'queued' && waits.some(wait => sameAction(wait, receipt) && wait.delivered))) return false;
    if (grant.kind === 'interrupt' && receipt.status !== 'stopped') return false;
    if (grant.kind === 'watch_terminal' && !['ready', 'already-completed'].includes(receipt.status)) return false;
    if (grant.kind === 'operate_terminal' && receipt.status !== 'interaction-complete') return false;
    if (grant.kind === 'create_session' && (receipt.status !== 'created' || receipt.processState !== 'running' || receipt.draftStaged)) return false;
    // Every actual submission in an operator loop must have known delivery.
    for (const submission of matching.filter(outcome => outcome.ok && (outcome.kind === 'send_prompt' || outcome.kind === 'terminal_interact' && waits.some(wait => sameAction(wait, outcome))))) {
      const wait = waits.find(wait => sameAction(wait, submission));
      const current = wait ? { status: wait.deliveryStatus, delivered: wait.delivered }
        : { ...submission, ...deliveryUpdates.filter(update => sameAction(update, submission)).at(-1) };
      if (!sent.has(current.status) && !(current.status === 'queued' && current.delivered)) return false;
    }
    if (receipt.status === 'staged' && grant.kind !== 'stage_draft') return false;
  }
  return true;
}

module.exports = { commandCompleted };
