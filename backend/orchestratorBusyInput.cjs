'use strict';
function purePrompt(action) {
  return action?.operator === true && action.promptSubmission === true && typeof action.text === 'string' && Boolean(action.text.trim()) && action.submit === true && !action.keys?.length && !action.mouse && !action.editInput;
}
function healthy(session, action) {
  return session && session.generation === (action.target?.generation ?? action.generation) && session.id === (action.target?.id ?? action.targetId) && session.started !== false && session.launchState !== 'pending' && session.processState === 'running' && session.agentProcessState === 'running' && Number.isSafeInteger(session.agentPid) && session.agentPid > 0 && session.binding?.status !== 'ambiguous' && !session.pendingInteraction && !['waiting','paused','closed','exited','failed'].includes(session.status) && session.turnState !== 'waiting' && !['approval','question'].includes(session.attention?.reason);
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
