'use strict';

const { normalizeIntent } = require('./orchestratorIntent.cjs');
const { createHash } = require('node:crypto');

// Last-resort repair for a validator-rejected attempt to replay a submitted
// task. Called only after normal interpretation/repair fails. This narrows the
// attempted effect into observation; it never restores a consumed grant.
function recoverSubmittedTaskIntent(raw, context) {
  const reference = context?.replyContext?.submittedTask;
  if (!reference || !Array.isArray(reference.targets) || !reference.targets.length || reference.targets.some(target => !target || typeof target.id !== 'string') ||
      typeof reference.instruction !== 'string' || typeof context.instruction !== 'string' || !Array.isArray(raw?.actions) || raw.actions.length > 24 ||
      raw.afterResults !== undefined || raw.dependsOnRequestIds !== undefined) return undefined;
  const actions = raw.actions;
  const originalText = action => typeof action.text === 'string' && action.text.trim() && (reference.instruction.includes(action.text) ||
    Array.isArray(reference.promptReferences) && reference.promptReferences.some(item => item && item.length === action.text.length &&
      item.sha256 === createHash('sha256').update(action.text).digest('hex') &&
      (!action.targetIds || action.targetIds.every(id => reference.promptReferences.some(other => other?.sha256 === item.sha256 && other.targetId === id && reference.targets.some(target => target.id === id && target.generation === other.generation))))));
  const fields = new Set(['kind', 'sourceUserId', 'targetIds', 'selection', 'text', 'promptMode']);
  if (actions.some(action => !['operate_terminal', 'send_prompt'].includes(action?.kind) || Object.keys(action).some(key => !fields.has(key)) ||
      action.targetIds !== undefined && (!Array.isArray(action.targetIds) || !action.targetIds.length || action.targetIds.some(id => typeof id !== 'string')) ||
      action.text !== undefined && !originalText(action))) return undefined;
  const ids = [...new Set(actions.flatMap(action => action.targetIds || []))];
  if (ids.some(id => !reference.targets.some(target => target.id === id))) return undefined;
  const explicitlyLinked = raw.continuationOf === reference.requestId || actions.length && actions.every(action => action.sourceUserId === reference.requestId);
  const exactOldLiteral = actions.length && actions.every(action => action.kind === 'operate_terminal' && action.promptMode === 'literal' &&
    (!action.sourceUserId || action.sourceUserId === context.requestId) && originalText(action) && !context.instruction.includes(action.text));
  if (!explicitlyLinked && !exactOldLiteral) return undefined;
  // Never convert a mixture of an old continuation and newly authorized work.
  if (!exactOldLiteral && actions.some(action => action.sourceUserId && action.sourceUserId !== reference.requestId)) return undefined;
  const targetIds = ids.length ? ids : reference.targets.length === 1 ? [reference.targets[0].id] : [];
  try { return normalizeIntent(targetIds.length ? {
    goal: 'Inspect delivery evidence for the original submitted task without sending it again.',
    actions: [], responseKind: 'task-status', statusRequestId: reference.requestId, statusTargetIds: targetIds,
  } : { goal: 'Identify which original terminal delivery needs inspection.', actions: [],
    clarification: 'Which terminal’s prompt delivery should I check?' }, context); }
  catch { return undefined; } // Invalid reference data must not mask the original validation failure.
}

module.exports = { recoverSubmittedTaskIntent };
