'use strict';

// Explicit reply identity preserves the relevant exchange when unrelated work
// pushes it out of the shared recent-message window. This is reference data;
// grants and pending-command ownership remain the only continuation authority.
function buildReplyContext({ input, currentSequence, previous, messages = [], sessions = [] }) {
  const task = previous?.task;
  if (!input?.replyToRequestId || task?.requestId !== input.replyToRequestId ||
      !Number.isInteger(currentSequence) || !Number.isInteger(task.sequence) || task.sequence >= currentSequence ||
      ['cancelled', 'failed', 'paused'].includes(task.status)) return undefined;
  const question = input.questionId && task.status === 'needs-answer' && task.question?.id === input.questionId
    && task.question.requestId === task.requestId ? task.question : undefined;
  if (input.questionId && !question) return undefined;
  const bound = previous.context?.conversationTarget;
  const target = bound && sessions.find(session => session.id === bound.id && session.generation === bound.generation);
  const recentMessages = messages.filter(message => message.requestId === task.requestId &&
    ['user', 'assistant'].includes(message.role) && message.origin !== 'monitor' && typeof message.text === 'string')
    .slice(-4).map(({ role, text }) => ({ role, text: text.slice(0, 2000), ...(text.length > 2000 && { truncated: true }) }));
  const instruction = String(previous.input?.text ?? task.text ?? '');
  return { requestId: task.requestId, status: task.status, instruction: instruction.slice(0, 4000),
    ...(instruction.length > 4000 && { instructionTruncated: true }),
    ...(question && { question: { id: question.id, requestId: question.requestId, text: question.text.slice(0, 2000) } }),
    ...(target && { conversationTarget: { id: target.id, generation: target.generation } }), recentMessages };
}

module.exports = { buildReplyContext };
