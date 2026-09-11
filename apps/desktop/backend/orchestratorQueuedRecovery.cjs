'use strict';
const { projectIntent } = require('./orchestratorIntent.cjs');

// Only scheduler admission waits are transferable. Delivery queues, unknown
// writes, partly executed operators and restored history retain their owner.
function captureQueuedCommand(job, now = Date.now()) {
  if (!job || job.restored || job.controller?.signal.aborted || job.admitted || job.executionDone ||
      job.task?.status !== 'queued' || job.waits?.length || !job.intent?.commandPlan) return undefined;
  const plan = job.intent.commandPlan;
  if (!plan.grants.length || plan.grants.some(grant => grant.kind !== 'operate_terminal' || !grant.targets.length)) return undefined;
  const progress = projectIntent(plan);
  if (progress.grants.some(grant => grant.dispatched || grant.blockedTargetIds?.length ||
      grant.availableTargetIds.length !== grant.targets.length || grant.progress?.some(target => target.steps > 0))) return undefined;
  const grants = plan.grants.map(({ id, sourceUserId, ...grant }) => structuredClone(grant));
  return { queued: true, requestId: job.task.requestId, instruction: job.queueRecoveryInstruction || job.input.text,
    grants, candidates: grants.flatMap(grant => grant.targets), access: plan.access,
    dependsOnRequestIds: [...new Set([...(job.task.dependsOn || []), ...(job.input.internalDependencies || []), ...plan.dependsOnRequestIds])], ...(plan.afterResults && { afterResults: structuredClone(plan.afterResults) }),
    expiresAt: now + 300000 };
}

function signature(grant) {
  const fields = ['kind', 'args', 'text', 'answerText', 'answerTexts', 'operationMode', 'taskBindings', 'projectSelection', 'folderAccess', 'promptMode', 'answerMode', 'permissionMode', 'lifecycleMode', 'inspection', 'routing'];
  return JSON.stringify({ ...Object.fromEntries(fields.filter(key => grant[key] !== undefined).map(key => [key, grant[key]])),
    targetAvailability: grant.targetAvailability || 'any',
    targets: grant.targets.map(({ id, generation }) => ({ id, generation })).sort((a, b) => a.id.localeCompare(b.id)) });
}

function assertQueuedTransfer(owner, pending, plan) {
  const current = captureQueuedCommand(owner);
  if (!pending?.queued || owner?.context?.pendingCommand !== pending || !current ||
      current.requestId !== pending.requestId || plan.grants.some(grant => grant.sourceUserId !== pending.requestId)) {
    throw new Error('The original queued request has already started or changed. Inspect its delivery instead of sending it again.');
  }
  const original = current.grants.map(signature).sort(), replacement = plan.grants.map(signature).sort();
  if (JSON.stringify(original) !== JSON.stringify(replacement) || plan.access !== current.access ||
      current.dependsOnRequestIds.some(id => !plan.dependsOnRequestIds.includes(id)) ||
      JSON.stringify(plan.afterResults) !== JSON.stringify(current.afterResults)) {
    throw new Error('Continue the complete original queued task with its targets, constraints and dependencies. A partial or changed task cannot replace its pending delivery.');
  }
  return current;
}

module.exports = { captureQueuedCommand, assertQueuedTransfer };
