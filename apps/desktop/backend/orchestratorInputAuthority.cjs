'use strict';

// Input authority changes when the recipient, interaction, or terminal geometry
// changes. Metadata refreshes are not new permission to act, nor a reason to
// discard an otherwise current read. Keep this projection separate from the
// runtime's publication revision, which includes titles and telemetry heartbeats.
const REQUEST_METADATA = new Set(['createdAt', 'updatedAt', 'observedAt', 'receivedAt', 'timestamp', 'sessionName', 'sessionTitle']);
function canonical(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(canonical));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(
    Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])
  ));
  return value;
}
function projectInputAuthority(session, requests = session?.pendingInteractions || []) {
  const s = session || {};
  const shell = s.kind === 'terminal' || s.provider === 'terminal';
  const attention = s.attention;
  const waitingAttention = attention && (attention.state === 'waiting' || ['approval', 'question'].includes(attention.reason));
  return canonical({
    id: s.id, generation: s.generation, launchToken: s.launchToken,
    kind: s.kind, provider: s.provider, rootPid: shell ? s.pid || s.terminalPid : s.agentPid,
    started: s.started, status: s.status, lifecycle: s.lifecycle, launchState: s.launchState,
    processState: s.processState, agentProcessState: s.agentProcessState,
    turnId: s.turnId, turnStartedAt: s.turnStartedAt, turnState: s.turnState,
    pendingInput: s.pendingInput, childActivity: Boolean(s.childActivity),
    pendingInteraction: Boolean(s.pendingInteraction || requests.length),
    manualInputPending: Boolean(s.manualInputPending), interactionInputPending: Boolean(s.interactionInputPending),
    heldMouseButton: s.heldMouseButton, ownerRequestId: s.ownerRequestId,
    bindingStatus: s.binding?.status,
    selectionRevision: s.selection?.revision || 0,
    conversation: { provider: s.conversation?.provider, id: s.conversation?.id },
    observation: s.observation, telemetryHealth: s.telemetryHealth,
    attention: waitingAttention ? { state: attention.state, reason: attention.reason } : null,
    pendingInteractions: requests.map(request => canonical(Object.fromEntries(
      Object.entries(request).filter(([key]) => !REQUEST_METADATA.has(key))
    ))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    cols: s.cols, rows: s.rows
  });
}
function sameInputAuthority(expected, actual) {
  return JSON.stringify(expected) === JSON.stringify(actual);
}
module.exports = { projectInputAuthority, sameInputAuthority };
