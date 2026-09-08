'use strict';
const path = require('node:path');
const launchers = new Set([...Object.keys(require('../shared/providerCapabilities.json')), 'claude-custom']);
const directKinds = new Set(['send_prompt', 'stage_draft', 'focus_session', 'navigate', 'interrupt', 'watch_terminal']);

function canExecuteDirect(plan) {
  return plan.executionMode === 'direct' && !plan.clarification &&
    !plan.dependsOnRequestIds.length && plan.grants.length > 0 && plan.grants.every(grant =>
      directKinds.has(grant.kind) || grant.kind === 'create_session' && !plan.afterResults && grant.text === undefined &&
      launchers.has(grant.args.kindOfSession) && typeof grant.args.cwd === 'string' && path.isAbsolute(grant.args.cwd));
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
      let text = finish.text.trim();
      const queued = deliveryWaits.some(wait => wait.targetId === target.id && wait.deliveryStatus === 'queued' && !wait.delivered && !wait.done);
      if (queued) text += ' The prompt is queued and has not been sent yet.';
      else if (pendingResultTargets.includes(target.id)) text += ' The agent result is still pending.';
      summaries.push({ name: session.name || session.conversationTitle || target.id, text });
    }
  }
  if (outcomes.some(item => item.ok === false && !completed.has(JSON.stringify([item.grantId, item.targetId])))) return;
  return summaries.map(item => summaries.length > 1 ? `${item.name}: ${item.text}` : item.text).join('\n\n');
}

module.exports = { canExecuteDirect, completedOperatorResponse };
