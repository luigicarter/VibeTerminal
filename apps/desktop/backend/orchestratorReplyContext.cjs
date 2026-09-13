'use strict';
const { submittedPromptReferences } = require('./orchestratorIntent.cjs');

const sameFolder = (left, right) => {
  const identity = value => String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return typeof left === 'string' && typeof right === 'string' && Boolean(left) && identity(left) === identity(right);
};
const labelWords = value => String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
// A multi-word pane label spoken in the sentence names that pane. One generic
// word ("codex", "terminal") names a kind, not a conversation, so it never
// re-points a reply on its own.
function namesSession(instruction, session) {
  const haystack = ` ${labelWords(instruction).join(' ')} `;
  for (const label of [session.conversationTitle, session.name, ...(session.aliases || [])]) {
    const tokens = labelWords(label);
    if (tokens.length < 2) continue;
    if (haystack.includes(` ${tokens.join(' ')} `)) return true;
  }
  return false;
}
// A sentence that addresses a different registered project, or names another
// pane, is new business. The latest exchange stops being the implicit reply
// target so its task cannot silently absorb the new instruction. An explicit
// replyToRequestId or questionId still binds, because the user chose it.
function addressesOtherSubject({ instruction, projectContext, previous, sessions }) {
  if (!previous || !instruction) return false;
  const previousPath = previous.task?.projectPath || previous.input?.projectPath || previous.context?.projectContext?.path;
  if (projectContext?.path && previousPath && !sameFolder(projectContext.path, previousPath)) return true;
  const owned = new Set([...(previous.task?.targets || []).map(target => target?.id),
    ...(previous.waits || []).map(wait => wait.targetId), previous.context?.conversationTarget?.id].filter(Boolean));
  return sessions.some(session => session && !owned.has(session.id) && namesSession(instruction, session));
}

// Explicit reply identity preserves the relevant exchange when unrelated work
// pushes it out of the shared recent-message window. This is reference data;
// grants and pending-command ownership remain the only continuation authority.
function buildReplyContext({ input, currentSequence, previous, messages = [], sessions = [], jobs = [], instruction: addressedText, projectContext }) {
  // Only the latest conversational exchange is an implicit candidate. Never
  // search past an unrelated exchange to silently choose an older task.
  if (!input?.replyToRequestId && !input?.questionId) {
    const latest = messages.filter(message => ['user', 'assistant'].includes(message.role) && message.origin !== 'monitor')
      .filter(message => { const owner = jobs.find(job => job.task.requestId === message.requestId); return !owner || owner.task.sequence < currentSequence; }).at(-1);
    previous = latest && jobs.find(job => job.task.requestId === latest.requestId && job.task.sequence < currentSequence);
    if (addressesOtherSubject({ instruction: addressedText ?? input?.text, projectContext, previous, sessions })) previous = undefined;
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
    // The exchange being replied to needs its last turn, not its transcript:
    // everything older is already a ledger line.
    .slice(-2).map(({ role, text }) => ({ role, text: text.slice(0, 600), ...(text.length > 600 && { truncated: true }) }));
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
    deliveryEvidence: waits.slice(-4).map(wait => Object.fromEntries(['targetId', 'generation', 'deliveryStatus', 'delivered', 'staged', 'turnId', 'observedState', 'done', 'failed', 'attributionAmbiguous', 'inputDisposition'].filter(key => wait[key] !== undefined).map(key => [key, wait[key]]))) };
}

module.exports = { buildReplyContext, addressesOtherSubject };
