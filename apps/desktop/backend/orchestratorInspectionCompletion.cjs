'use strict';
const { randomUUID } = require('node:crypto');
const reviewedTokens = new WeakMap();

// Coordinates observation -> goal review -> validated finish for one request.
// A bare initial prompt cannot trigger automatic completion. Existing output may
// complete without input only after the executor actually proposes an answer.
async function completeInspections({ intent, progress, getSessions, getRequests, getOperation, review, execute, onOutcome,
  modelRound, model, signal, diagnosticContext, proposedText, checkActive }) {
  if (intent.commandPlan.clarification || intent.question && intent.question.id !== intent.responseQuestionId) return [];
  if (!reviewedTokens.has(intent)) reviewedTokens.set(intent, new Set());
  const reviewed = reviewedTokens.get(intent), gaps = [];
  for (const grant of intent.commandPlan.grants.filter(item => item.inspection)) for (const target of grant.targets) {
    if (!progress.grants.find(item => item.id === grant.id)?.availableTargetIds.includes(target.id)) continue;
    const session = getSessions().find(item => item.id === target.id && item.generation === target.generation), operation = getOperation(grant, target.id);
    if (!session || operation.uncertain || session.pendingInput || session.manualInputPending || session.interactionInputPending || session.heldMouseButton ||
        getRequests().some(request => request.sessionId === target.id && request.state === 'pending')) continue;
    const proposed = proposedText !== undefined || Boolean(intent.response);
    if (!operation.steps && !proposed) continue;
    const observationToken = intent.operatorObservations?.latest(session, modelRound), key = `${observationToken}:${proposed}`;
    if (!observationToken || reviewed.has(key)) continue;
    reviewed.add(key);
    const result = await review({ owner: intent, goal: grant.text, evidence: intent.inspectionEvidence?.pages(session) || [],
      model, target: session, signal, diagnosticContext }); checkActive();
    if (result.decision !== 'complete') { gaps.push(target.id); continue; }
    const finish = { kind: 'finish_terminal', targetId: target.id, grantId: grant.id, observationToken,
      stepId: `inspection-${randomUUID()}`, outcome: 'completed', text: proposedText || intent.response?.text || 'Report the verified inspection evidence.' };
    onOutcome({ kind: finish.kind, grantId: grant.id, targetId: target.id, ...await execute(finish) });
    checkActive();
  }
  return gaps;
}
module.exports = { completeInspections };
