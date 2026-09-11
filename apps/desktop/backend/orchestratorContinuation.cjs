'use strict';

// Control ownership is separate from the native waits retained by their producer.
function resultDependencyBlocker(job) {
  if (!job || job.restored) return 'The prerequisite has no live verified task result available.';
  if (job.task.resultScopeTransferred) return 'Part of the prerequisite continues in another request; its whole task result is unavailable.';
  if (job.task.status === 'continued') return 'The prerequisite continued in another request without producing a task result.';
  if (!(job.waits || []).length && ['failed', 'finished', 'cancelled', 'paused', 'needs-answer'].includes(job.task.status)) return 'The prerequisite has not produced a terminal task result.';
  return undefined;
}

function transferredStatus(owner, requiredResultsTransferred) {
  const waits = owner.waits || [];
  if (waits.some(wait => !wait.done)) return 'waiting-results';
  if (owner.task.status === 'failed' || waits.some(wait => wait.failed)) return 'failed';
  if (waits.length && !requiredResultsTransferred && !owner.task.resultScopeTransferred) return 'finished';
  return 'continued';
}

function prepareContinuation({ owner, successor, pendingCommand = owner?.context?.pendingCommand,
  successorPendingCommand = pendingCommand, requiredResultsTransferred, validate = () => {}, now = Date.now }) {
  if (typeof requiredResultsTransferred !== 'boolean') throw new Error('Continuation requires an explicit original result-scope decision.');
  const revision = owner?.task?.controlRevision || 0;
  const successorRevision = successor?.task?.controlRevision || 0;
  let committed = false;
  function check() {
    if (committed || !owner || !successor || owner === successor || owner.restored || successor.restored ||
        owner.controller?.signal.aborted || successor.controller?.signal.aborted ||
        !pendingCommand || owner.context?.pendingCommand !== pendingCommand ||
        (owner.task.controlRevision || 0) !== revision || (successor.task.controlRevision || 0) !== successorRevision ||
        !successor.context || successor.context.pendingCommand || owner.task.controlDisposition === 'transferred') {
      throw new Error('The unfinished request changed before its continuation could take ownership.');
    }
    validate();
  }
  check();
  // Snapshot preparation is fallible and happens before either owner changes.
  const inherited = structuredClone(successorPendingCommand);
  if (!inherited || typeof inherited.instruction !== 'string' || !inherited.requestId) throw new Error('The continuation has no preserved user objective.');
  return { commit(batch = fn => fn()) {
    check();
    return batch(() => {
      check();
      successor.context.pendingCommand = inherited;
      owner.context.pendingCommand = null;
      Object.assign(owner.task, { controlDisposition: 'transferred', continuedByRequestId: successor.task.requestId,
        controlRevision: revision + 1, updatedAt: now(), status: transferredStatus(owner, requiredResultsTransferred), question: undefined,
        waitingReason: (owner.waits || []).some(wait => !wait.done) ? 'Waiting for the original terminal result.' : undefined,
        ...(requiredResultsTransferred && { resultScopeTransferred: true }) });
      Object.assign(successor.task, { controlDisposition: 'active', continuedFromRequestId: owner.task.requestId,
        controlRevision: successorRevision + 1, updatedAt: now() });
      committed = true;
      return { owner, successor, pendingCommand: inherited };
    });
  } };
}

function commitContinuation(ticket, { batch } = {}) { return ticket.commit(batch); }

module.exports = { prepareContinuation, commitContinuation, resultDependencyBlocker, transferredStatus };
