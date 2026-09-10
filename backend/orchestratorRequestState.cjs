'use strict';
const { projectIntent } = require('./orchestratorIntent.cjs');
// Pure projections of request-owned evidence. This layer has no model, terminal,
// scheduler-mutation or persistence interface.
const availabilityForPending = (grant, progress) => grant.targetAvailability ? { targetAvailability: grant.targetAvailability, targetCandidates: grant.targetCandidates, availabilitySatisfiedTargetIds: progress.availabilitySatisfiedTargetIds, availabilitySelectionLocked: Boolean(grant.availabilitySelectionLocked || progress.progress?.some(target => target.steps > 0)) } : {};
function remainingGrantSnapshots(plan, sourceUserId, outcomes = []) {
    const projected = projectIntent(plan);
    return plan.grants.flatMap(grant => {
      if (sourceUserId && grant.sourceUserId !== sourceUserId) return [];
      const progress = projected.grants.find(item => item.id === grant.id);
      // A retained project has an application-owned removal transaction. A later
      // user retry resumes that transaction; its already-issued stops are only
      // observed again by the project controller, never replayed.
      const removal = grant.kind === 'remove_project' && outcomes.filter(outcome => outcome.grantId === grant.id && outcome.kind === 'remove_project' && !outcome.validationFailure).at(-1);
      const retainedProject = removal?.ok === false && removal.status === 'project-retained' && removal.filesDeleted === false;
      if (progress.dispatched && !retainedProject) return [];
      return [{ kind: grant.kind, targets: grant.targets.filter(target => progress.availableTargetIds.includes(target.id)), args: grant.args, ...(grant.projectSelection && { projectSelection: grant.projectSelection }), ...(grant.folderAccess && { folderAccess: grant.folderAccess }), ...(grant.closeScope && { closeScope: grant.closeScope }), ...(grant.watchTargets && { watchTargets: grant.watchTargets }),
        ...(grant.text !== undefined && { text: grant.text }), ...(grant.answerText !== undefined && { answerText: grant.answerText }), ...(grant.answerTexts && { answerTexts: grant.answerTexts }), ...(grant.interactions && { interactions: grant.interactions }), ...(grant.operationMode && { operationMode: grant.operationMode }), ...(grant.taskBindings && { taskBindings: grant.taskBindings }), ...(grant.promptMode && { promptMode: grant.promptMode }), ...(grant.answerMode && { answerMode: grant.answerMode }), ...(grant.permissionMode && { permissionMode: grant.permissionMode }), ...(grant.lifecycleMode && { lifecycleMode: grant.lifecycleMode }), ...(grant.inspection && { inspection: true }), ...availabilityForPending(grant, progress), ...(grant.routing && { routing: grant.routing }) }];
    });
  }

function settledRequestState({ task, result, waits = [], pendingCommand }) {
  if (task.controlDisposition === 'transferred' || ['cancelled', 'paused', 'needs-answer', 'continued'].includes(task.status)) return;
  const pendingResults = waits.some(wait => !wait.done), failedResult = !pendingResults && waits.find(wait => wait.failed);
  return {
    status: result?.ok === false ? 'failed' : pendingCommand ? 'needs-answer' : pendingResults ? 'waiting-results' : failedResult ? 'failed' : 'finished',
    controlDisposition: result?.ok === false ? 'failed' : pendingCommand ? 'needs-answer' : 'completed',
    ...((result?.error || failedResult) && { error: result?.error || failedResult.error || 'The terminal task did not finish successfully.' }),
    waitingReason: waits.some(wait => !wait.done && wait.staged) ? 'Prompt saved as a draft; open the terminal to send it.' : pendingResults ? 'Waiting for a verified terminal result.' : undefined,
  };
}
function requestHasFailures({ unboundCreations, question, clarification, closeState, deliveryUpdates = [], outcomes = [], isRecovered, operatorResults }) {
  return Boolean(unboundCreations > 0 && !question && !clarification || closeState.present && !closeState.ok ||
    deliveryUpdates.some(result => result.ok === false || ['unknown', 'unconfirmed', 'uncertain', 'write-failed'].includes(result.status)) ||
    outcomes.some(result => result.ok === false && !isRecovered(result) && operatorResults?.get(JSON.stringify([result.grantId, result.targetId || result.id])) !== 'completed'));
}
module.exports = { availabilityForPending, remainingGrantSnapshots, settledRequestState, requestHasFailures };
