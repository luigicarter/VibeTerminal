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
    if (target.revision !== undefined && record.revision !== target.revision)
      throw new Error('The terminal changed after the last observation. Read it again.');
    const previous = lastActions.get(key(target));
    if (previous && record.serial <= previous.serial) throw new Error('Read the terminal after the last action before taking another step.');
    if (['send_prompt', 'terminal_interact', 'interrupt'].includes(action.kind) && !['fusion', 'openfusion'].includes(target.kind || target.provider)) {
      if (!Number.isSafeInteger(record.sequence) || action.observationSequence !== record.sequence || !Number.isSafeInteger(record.inputRevision) || action.inputRevision !== record.inputRevision)
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
