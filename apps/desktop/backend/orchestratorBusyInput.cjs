'use strict';
function purePrompt(action) {
  return action?.operator === true && action.promptSubmission === true && typeof action.text === 'string' && Boolean(action.text.trim()) && action.submit === true && !action.keys?.length && !action.mouse && !action.editInput;
}
// A busy pane is healthy when it is the addressed pane and the one pane-state
// predicate says its recipient is identified and nothing is waiting on a human.
// Being busy is the point here, so a 'busy' reason is exactly what is wanted.
function healthy(session, action) {
  if (!session || session.generation !== (action.target?.generation ?? action.generation) || session.id !== (action.target?.id ?? action.targetId)) return false;
  const readiness = require('./orchestratorPaneReadiness.cjs').paneReadiness(session);
  return readiness.form === 'native' && readiness.composerVerified && readiness.reason !== 'waiting';
}
function isObservedBusyPrompt(action, session) {
  return Boolean(purePrompt(action) && healthy(session,action) && !['terminal','shell','fusion','openfusion'].includes(session.kind) && session.observation === 'observed' && ['running','busy'].includes(session.turnState) && session.turnId && !session.pendingInput && !session.manualInputPending && !session.interactionInputPending && !session.heldMouseButton);
}
function isBusyPromptSubmission(action, session) {
  return action?.targetAvailability !== 'idle' && isObservedBusyPrompt(action, session) && (session.provider || session.kind) === 'codex';
}
function canQueueBusyPrompt(action, session, result) {
  return Boolean(action?.targetAvailability !== 'idle' && purePrompt(action) && healthy(session,action) && result?.delivery === 'not-dispatched' && result.reason !== 'input-revision-changed' && ['recipient-unavailable','stale-observation','interaction-busy','busy'].includes(result.status) && (['running','busy'].includes(session.turnState) || session.childActivity || session.pendingInput));
}
module.exports = { isObservedBusyPrompt, isBusyPromptSubmission, canQueueBusyPrompt };
