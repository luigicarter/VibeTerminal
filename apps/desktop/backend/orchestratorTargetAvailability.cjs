'use strict';
const agentKinds = new Set([...Object.keys(require('../shared/providerCapabilities.json')), 'claude-custom', 'fusion', 'openfusion']);

// Application inventory evidence only. Native composer ownership is checked
// again by the input adapter; an idle turn does not prove an empty editor, and
// the conservative keystroke latch is a hint the decoder overrules there, which
// is why it does not make a pane unavailable here.
function isIdleTarget(session) {
  const kind = session?.kind || session?.provider;
  if (!agentKinds.has(kind) || kind === 'terminal') return false;
  return require('./orchestratorPaneReadiness.cjs').paneReadiness(session).free;
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
