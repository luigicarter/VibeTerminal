'use strict';
const { randomUUID } = require('node:crypto');

// Observation authority belongs to one live request. Screen content is evidence,
// never an instruction or a capability. Even unchanged screens need a new token
// after each action because navigation does not necessarily produce PTY output.
function createOperatorObservations({ now = Date.now } = {}) {
  const tokens = new Map(), lastActions = new Map();
  let serial = 0;
  const key = target => JSON.stringify([target.id, target.generation]);
  function observe(target, observation, requests = []) {
    if (observation?.ok === false || observation?.exited || (observation?.id !== undefined && observation.id !== target.id) || (observation?.generation !== undefined && observation.generation !== target.generation)) return;
    const token = randomUUID();
    const record = { token, targetId: target.id, generation: target.generation, revision: target.revision,
      sequence: observation?.sequence, inputRevision: observation?.inputRevision, serial: ++serial, at: now(),
      requests: structuredClone(requests), used: false };
    tokens.set(token, record);
    while (tokens.size > 128) tokens.delete(tokens.keys().next().value);
    return token;
  }
  function authorize(token, target, action) {
    const record = tokens.get(token);
    if (!record || record.used || record.targetId !== target.id || record.generation !== target.generation || now() - record.at > 30000)
      throw new Error('Read this terminal again before acting; the observation token is missing, used, or stale.');
    // Runtime revisions include background telemetry and streamed output. A
    // finish records the result supported by the last read, without sending
    // input; requiring a quiet runtime across model latency can prevent it
    // forever. Effects still require matching revisions, and finishing still
    // requires an unexpired, unused token read after the last effect.
    if (action.kind !== 'finish_terminal' && target.revision !== undefined && record.revision !== target.revision)
      throw new Error('The terminal changed after the last observation. Read it again.');
    const previous = lastActions.get(key(target));
    if (previous && record.serial <= previous.serial) throw new Error('Read the terminal after the last action before taking another step.');
    if (['send_prompt', 'terminal_interact', 'interrupt'].includes(action.kind) && !['fusion', 'openfusion'].includes(target.kind || target.provider)) {
      // send/interrupt may omit redundant model copies of counters already bound
      // by this request's token. The dispatcher derives those fields only in its
      // post-claim transport envelope, leaving the frozen step payload unchanged.
      const derived = ['send_prompt', 'interrupt'].includes(action.kind);
      if (!Number.isSafeInteger(record.sequence) || record.sequence < 0 || !Number.isSafeInteger(record.inputRevision) || record.inputRevision < 0 ||
          (action.observationSequence !== record.sequence && !(derived && action.observationSequence === undefined)) ||
          (action.inputRevision !== record.inputRevision && !(derived && action.inputRevision === undefined)))
        throw new Error('Native input requires the screen sequence and input revision from this observation.');
    }
    return record;
  }
  function consume(record, target, action) {
    record.used = true;
    if (action.kind !== 'finish_terminal') lastActions.set(key(target), { serial: ++serial, kind: action.kind });
  }
  return { observe, authorize, consume };
}
module.exports = { createOperatorObservations };
