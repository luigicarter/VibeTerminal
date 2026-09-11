'use strict';

const completed = new Set(['completed', 'complete', 'finished', 'succeeded']);
const uncertain = new Set(['unknown', 'unconfirmed', 'uncertain', 'write-failed']);

// Waits are owned by the scheduler: turn identity is attributed to this input,
// not inferred from a live process, terminal prose, or a model's finish summary.
function formatTaskWait(wait, session, name = session?.name || session?.conversationTitle || 'the terminal') {
  if (!session || session.generation !== wait.generation) return `The terminal for ${name} changed; this task's status is unverified.`;
  if (wait.failed) return `The task in ${name} could not be verified as complete.${wait.error ? ` ${wait.error}` : ''}`;
  if (wait.nativeIdentity && !require('./orchestratorLaunchers.cjs').routingBindingMatches({ target: { id: wait.targetId, generation: wait.generation }, nativeIdentity: wait.nativeIdentity }, session)) {
    return wait.done && completed.has(wait.observedState || wait.resultStatus)
      ? "The recorded agent turn for this task ended; the pane's current conversation no longer matches it. Its work has not been independently verified."
      : "The pane's current conversation no longer matches this task; its progress and result are unverified.";
  }
  if (wait.staged || wait.deliveryStatus === 'staged') return `The prompt in ${name} is saved as a draft; it has not been sent.${wait.deliveryReason ? ` ${wait.deliveryReason}` : ''} Open the terminal to review and send it.`;
  if (wait.deliveryStatus === 'queued' && !wait.delivered) return `The prompt for ${name} is queued and has not been sent yet.`;
  if (wait.attributionAmbiguous) return `I can't reliably attribute the agent's work in ${name} to this ${wait.source === 'watch' ? 'watch' : 'request'} yet.`;
  if (wait.source === 'watch' && wait.watchUntil === 'ready') {
    return wait.done && wait.observedState === 'ready' ? `${name} is ready.` : `I'm watching ${name}; readiness has not been confirmed yet.`;
  }
  if (wait.nativeShell) return uncertain.has(wait.deliveryStatus)
    ? `I couldn't confirm whether ${name} received the prompt. I haven't sent it again.`
    : `Input was sent to ${name}; task completion cannot be verified automatically.`;
  const attributedTurn = wait.turnId && (wait.inputDisposition !== 'submitted-while-running'
    || wait.baselineTurnId && wait.turnId !== wait.baselineTurnId);
  if (attributedTurn && wait.done && completed.has(wait.observedState || wait.resultStatus)) return `The agent turn for this task in ${name} ended. Its work has not been independently verified.`;
  const currentTurn = attributedTurn && session.turnId === wait.turnId && session.completionAttribution !== 'ambiguous'
    && !['exited', 'failed'].includes(session.processState) && !['exited', 'failed'].includes(session.agentProcessState);
  if (currentTurn && wait.observedState === 'waiting' && session.turnState === 'waiting') return `The task in ${name} needs input before it can continue. The agent result is still pending.`;
  if (currentTurn && ['running', 'busy'].includes(wait.observedState) && ['running', 'busy'].includes(session.turnState)) return `The task is running in ${name}. The agent result is still pending.`;
  if (wait.source === 'watch') return `I'm watching the task in ${name}, but its current progress and result are unverified.`;
  if (uncertain.has(wait.deliveryStatus)) return `I couldn't confirm whether ${name} received the prompt. I haven't sent it again.`;
  if (attributedTurn) return `The task started in ${name}, but its current progress and result are unverified.`;
  if (wait.inputDisposition === 'submitted-while-running') return `Input was sent to ${name} while the agent was working; I haven't confirmed that it started this request.`;
  return `Input was sent to ${name}; I haven't confirmed that the task started. The agent result is still pending.`;
}

function formatTaskStatus({ targets, jobs, sessions, requestId }) {
  return targets.map(target => {
    const session = sessions.find(item => item.id === target.id && item.generation === target.generation);
    const name = session?.name || target.name || 'the terminal';
    // Follow explicit status replies back to their task. An implicitly selected
    // task is frozen by that status exchange's sequence, so newer work cannot
    // silently change the subject when the user replies to an older answer.
    let linkedRequestId = requestId, beforeSequence = Infinity;
    const visited = new Set();
    while (linkedRequestId && !visited.has(linkedRequestId)) {
      visited.add(linkedRequestId);
      const linked = jobs.find(job => job.task.requestId === linkedRequestId);
      if (linked?.intent?.commandPlan?.responseKind !== 'task-status') break;
      beforeSequence = Math.min(beforeSequence, linked.task.sequence);
      linkedRequestId = linked.intent.commandPlan.statusRequestId || linked.input?.replyToRequestId;
    }
    const pendingTarget = job => job.task.status === 'queued'
      && job.task.targets?.some(item => item.id === target.id && item.generation === target.generation);
    const candidates = jobs.filter(job => job.task.sequence < beforeSequence && (!linkedRequestId || job.task.requestId === linkedRequestId))
      .filter(job => job.waits?.some(wait => wait.targetId === target.id && wait.generation === target.generation) || pendingTarget(job))
      .sort((a, b) => b.task.sequence - a.task.sequence);
    // A later watch can refer to an old turn. It cannot certify that a newer
    // submitted prompt has started; prefer submission evidence unless linked.
    const submission = candidates.find(job => pendingTarget(job) || job.waits?.some(wait => wait.targetId === target.id && wait.generation === target.generation && wait.source !== 'watch'));
    const outstandingSubmission = submission && (pendingTarget(submission) || submission.waits?.some(wait => wait.targetId === target.id && wait.generation === target.generation && wait.source !== 'watch' && !wait.done));
    const chosen = !linkedRequestId && outstandingSubmission ? submission : candidates[0];
    const matching = chosen?.waits?.filter(wait => wait.targetId === target.id && wait.generation === target.generation) || [];
    const wait = matching.filter(wait => wait.source !== 'watch').at(-1) || matching.at(-1);
    if (!wait && chosen && pendingTarget(chosen)) {
      if (!session) return `The terminal for ${name} changed; the queued request's delivery is unverified.`;
      return `The request for ${name} is queued; no prompt delivery has been recorded.${chosen.task.waitingReason ? ` ${chosen.task.waitingReason}` : ''}`;
    }
    return wait ? formatTaskWait(wait, session, name) : `I don't have a tracked task for ${name}${requestId ? ' in that request' : ''}; its task status is unverified.`;
  }).join('\n\n');
}

module.exports = { formatTaskWait, formatTaskStatus };
