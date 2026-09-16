'use strict';

const { sentence } = require('./orchestratorFailureText.cjs');

const completed = new Set(['completed', 'complete', 'finished', 'succeeded', 'response']);
const uncertain = new Set(['unknown', 'unconfirmed', 'uncertain', 'write-failed']);

// Waits are owned by the scheduler: turn identity is attributed to this input,
// not inferred from a live process, terminal prose, or a model's finish summary.
// Every branch answers the same two questions in the user's words: what Lina did
// with this pane, and what she is waiting on next.
function taskWaitSentence(wait, session, name = session?.name || session?.conversationTitle || 'the terminal') {
  const say = (key, context = {}) => sentence(key, { pane: name, ...context });
  if (!session || session.generation !== wait.generation) return say('pane-changed');
  if (wait.failed) return wait.error ? { text: String(wait.error), speech: String(wait.error) } : say('turn-unconfirmed');
  if (wait.nativeIdentity && !require('./orchestratorLaunchers.cjs').routingBindingMatches({ target: { id: wait.targetId, generation: wait.generation }, nativeIdentity: wait.nativeIdentity }, session)) {
    return say(wait.done && completed.has(wait.observedState || wait.resultStatus) ? 'turn-ended-elsewhere' : 'conversation-moved');
  }
  if (wait.staged || wait.deliveryStatus === 'staged') {
    return wait.deliveryReason ? { text: say('staged', { reason: wait.deliveryReason }).text, speech: say('staged').speech } : say('staged');
  }
  if (wait.deliveryStatus === 'queued' && !wait.delivered) return say('queued');
  if (wait.attributionAmbiguous) return say('attribution-ambiguous');
  if (wait.source === 'watch' && wait.watchUntil === 'ready') return say(wait.done && wait.observedState === 'ready' ? 'ready' : 'watching-ready');
  if (wait.nativeShell) return say(uncertain.has(wait.deliveryStatus) ? 'delivery-unknown' : 'native-shell');
  const attributedTurn = wait.turnId && (wait.inputDisposition !== 'submitted-while-running'
    || wait.baselineTurnId && wait.turnId !== wait.baselineTurnId);
  if (attributedTurn && wait.done && completed.has(wait.observedState || wait.resultStatus)) return say('turn-ended');
  const currentTurn = attributedTurn && session.turnId === wait.turnId && session.completionAttribution !== 'ambiguous'
    && !['exited', 'failed'].includes(session.processState) && !['exited', 'failed'].includes(session.agentProcessState);
  if (currentTurn && wait.observedState === 'waiting' && session.turnState === 'waiting') return say('needs-input');
  if (currentTurn && ['running', 'busy'].includes(wait.observedState) && ['running', 'busy'].includes(session.turnState)) return say('running');
  if (wait.source === 'watch') return say('watching');
  if (uncertain.has(wait.deliveryStatus)) return say('delivery-unknown');
  if (attributedTurn) return say('turn-started-unknown');
  if (wait.inputDisposition === 'submitted-while-running') return say('delivered-while-running');
  return say('delivered-unconfirmed');
}
function formatTaskWait(wait, session, name) { return taskWaitSentence(wait, session, name).text; }

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
      if (!session) return sentence('pane-changed', { pane: name }).text;
      return `${sentence('queued', { pane: name }).text}${chosen.task.waitingReason ? ` ${chosen.task.waitingReason}` : ''}`;
    }
    return wait ? formatTaskWait(wait, session, name)
      : `${sentence('no-tracked-task', { pane: name }).text}${requestId ? ' Nothing in that request reached it.' : ''}`;
  }).join('\n\n');
}

module.exports = { taskWaitSentence, formatTaskWait, formatTaskStatus };
