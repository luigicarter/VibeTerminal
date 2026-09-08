'use strict';
const { submittedPromptReferences } = require('./orchestratorIntent.cjs');

// Explicit reply identity preserves the relevant exchange when unrelated work
// pushes it out of the shared recent-message window. This is reference data;
// grants and pending-command ownership remain the only continuation authority.
function buildReplyContext({ input, currentSequence, previous, messages = [], sessions = [], jobs = [] }) {
  // Only the latest conversational exchange is an implicit candidate. Never
  // search past an unrelated exchange to silently choose an older task.
  if (!input?.replyToRequestId && !input?.questionId) {
    const latest = messages.filter(message => ['user', 'assistant'].includes(message.role) && message.origin !== 'monitor')
      .filter(message => { const owner = jobs.find(job => job.task.requestId === message.requestId); return !owner || owner.task.sequence < currentSequence; }).at(-1);
    previous = latest && jobs.find(job => job.task.requestId === latest.requestId && job.task.sequence < currentSequence);
  }
  const task = previous?.task;
  const submittedTask = task && submittedTaskReference(previous, jobs, sessions);
  if (!task || (input?.replyToRequestId && task.requestId !== input.replyToRequestId) ||
      !Number.isInteger(currentSequence) || !Number.isInteger(task.sequence) || task.sequence >= currentSequence ||
      ['cancelled', 'paused'].includes(task.status) ||
      task.status === 'failed' && (previous.restored || !submittedTask && !previous.context?.pendingCommand?.grants?.some(grant => grant.kind === 'operate_terminal' && grant.targets?.length))) return undefined;
  const question = input.questionId && task.status === 'needs-answer' && task.question?.id === input.questionId
    && task.question.requestId === task.requestId ? task.question : undefined;
  if (input.questionId && !question) return undefined;
  const bound = previous.context?.conversationTarget;
  const target = bound && sessions.find(session => session.id === bound.id && session.generation === bound.generation);
  const recentMessages = messages.filter(message => message.requestId === task.requestId &&
    ['user', 'assistant'].includes(message.role) && message.origin !== 'monitor' && typeof message.text === 'string')
    .slice(-4).map(({ role, text }) => ({ role, text: text.slice(0, 2000), ...(text.length > 2000 && { truncated: true }) }));
  const instruction = String(previous.input?.text ?? task.text ?? '');
  return { requestId: task.requestId, status: task.status, implicit: !input?.replyToRequestId, instruction: instruction.slice(0, 4000),
    ...(instruction.length > 4000 && { instructionTruncated: true }),
    ...(question && { question: { id: question.id, requestId: question.requestId, text: question.text.slice(0, 2000) } }),
    ...(target && { conversationTarget: { id: target.id, generation: target.generation } }), ...(submittedTask && { submittedTask }), recentMessages };
}

function submittedTaskReference(previous, jobs, sessions) {
  const visited = new Set();
  let job = previous;
  while (job && !visited.has(job.task.requestId)) {
    if (job.restored || ['cancelled', 'paused'].includes(job.task.status)) return undefined;
    visited.add(job.task.requestId);
    const plan = job.intent?.commandPlan;
    if (plan?.responseKind !== 'task-status') break;
    const requestId = plan.statusRequestId || job.input?.replyToRequestId;
    if (!requestId) return undefined; // No generation-safe implicit history search.
    const next = jobs.filter(item => item.task.requestId === requestId && item.task.sequence < job.task.sequence);
    if (next.length !== 1) return undefined;
    job = next[0];
  }
  if (!job || visited.has(job.task.requestId) && job.intent?.commandPlan?.responseKind === 'task-status') return undefined;
  const waits = (job.waits || []).filter(wait => wait.source !== 'watch');
  if (!waits.length) return undefined;
  const targets = [];
  for (const wait of waits) {
    if (!wait.targetId || wait.generation === undefined) return undefined;
    if (!targets.some(target => target.id === wait.targetId && target.generation === wait.generation)) targets.push({ id: wait.targetId, generation: wait.generation });
  }
  // One request with two generations of the same pane is ambiguous.
  if (new Set(targets.map(target => target.id)).size !== targets.length || targets.length > 24) return undefined;
  const instruction = String(job.input?.text ?? job.task.text ?? '');
  return { requestId: job.task.requestId, instruction: instruction.slice(0, 4000), ...(instruction.length > 4000 && { instructionTruncated: true }),
    promptReferences: submittedPromptReferences(job.intent?.commandPlan).filter(item => targets.some(target => target.id === item.targetId && target.generation === item.generation)),
    targets: targets.map(target => ({ ...target, available: sessions.some(session => session.id === target.id && session.generation === target.generation) })),
    deliveryEvidence: waits.slice(-24).map(wait => Object.fromEntries(['targetId', 'generation', 'deliveryStatus', 'delivered', 'staged', 'turnId', 'observedState', 'done', 'failed', 'attributionAmbiguous', 'inputDisposition'].filter(key => wait[key] !== undefined).map(key => [key, wait[key]]))) };
}

module.exports = { buildReplyContext };
