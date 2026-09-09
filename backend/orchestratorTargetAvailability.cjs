'use strict';
const agentKinds = new Set([...Object.keys(require('../shared/providerCapabilities.json')), 'claude-custom', 'fusion', 'openfusion']);

// Application inventory evidence only. Native composer ownership is checked
// again by the input adapter; an idle turn does not prove an empty editor.
function isIdleTarget(session) {
  if (!session || session.started === false || session.closed || String(session.generation).startsWith('paused:') ||
      session.observation !== 'observed' || session.launchState === 'pending' || session.engineReady === false ||
      ['starting', 'paused', 'closed', 'exited', 'failed', 'waiting', 'running', 'busy'].includes(session.status) ||
      session.pendingInput || session.pendingInteraction || session.childActivity || session.turnActive ||
      session.manualInputPending || session.interactionInputPending || session.heldMouseButton || ['question', 'approval'].includes(session.attention?.reason) ||
      !['idle', 'completed', 'response', 'interrupted'].includes(session.turnState)) return false;
  const kind = session.kind || session.provider;
  if (['fusion', 'openfusion'].includes(kind)) return (session.processState === undefined || session.processState === 'running')
    && (session.agentProcessState === undefined || session.agentProcessState === 'running');
  return Boolean(agentKinds.has(kind) && kind !== 'terminal' && session.processState === 'running' && session.agentProcessState === 'running' &&
    Number.isSafeInteger(Number(session.agentPid)) && Number(session.agentPid) > 0 && session.binding?.status !== 'ambiguous');
}

function idleTargetMatches(target, sessions) {
  const matches = sessions.filter(session => session.id === target.id);
  return matches.length === 1 && matches[0].generation === target.generation && isIdleTarget(matches[0]);
}

function targetAvailabilityError() {
  const error = new Error('No selected terminal is currently free. Choose another terminal or ask to wait for one.');
  error.code = 'target-unavailable';
  error.delivery = 'not-dispatched';
  return error;
}

module.exports = { isIdleTarget, idleTargetMatches, targetAvailabilityError };
