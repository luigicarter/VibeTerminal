'use strict';
const { randomUUID } = require('node:crypto');
const { isObservedBusyPrompt } = require('./orchestratorBusyInput.cjs');
const { projectInputAuthority, sameInputAuthority } = require('./orchestratorInputAuthority.cjs');

// Observation authority belongs to one live request. Screen content is evidence,
// never an instruction or a capability. Even unchanged screens need a new token
// after each action because navigation does not necessarily produce PTY output.
function createOperatorObservations({ now = Date.now } = {}) {
  const tokens = new Map(), lastActions = new Map(), reads = new Map(), latestReads = new Map();
  let serial = 0;
  const key = target => JSON.stringify([target.id, target.generation]);
  function invalidate(targetId) {
    const scoped = typeof targetId === 'string' && Boolean(targetId.trim());
    for (const targetKey of new Set([...reads.keys(), ...latestReads.keys()])) {
      if (scoped && JSON.parse(targetKey)[0] !== targetId) continue;
      reads.delete(targetKey); latestReads.delete(targetKey);
    }
  }
  function beginRead(target, modelRound) {
    const targetKey = key(target);
    latestReads.delete(targetKey);
    reads.delete(targetKey);
    // Routing can read before an executor round exists. Such reads remain
    // usable explicitly, but cannot seed an executor's implicit capability.
    if (modelRound === undefined) return;
    if (!Number.isSafeInteger(modelRound) || modelRound < 0) throw new Error('An implicit observation read requires its execution round.');
    const readId = randomUUID();
    reads.set(targetKey, { readId, modelRound });
    while (reads.size > 128) {
      const oldest = reads.keys().next().value;
      reads.delete(oldest); latestReads.delete(oldest);
    }
    return readId;
  }
  function observe(target, observation, requests = [], metadata = {}) {
    const targetKey = key(target), attempt = reads.get(targetKey);
    const currentRead = metadata.readId !== undefined && attempt?.readId === metadata.readId && attempt.modelRound === metadata.modelRound;
    // Legacy explicit reads cannot leave an older implicit read eligible. An
    // obsolete asynchronous read, however, cannot invalidate its replacement.
    if (currentRead || metadata.readId === undefined) latestReads.delete(targetKey);
    if (observation?.ok === false || observation?.exited || (observation?.id !== undefined && observation.id !== target.id) || (observation?.generation !== undefined && observation.generation !== target.generation)) return;
    const token = randomUUID();
    const record = { token, targetId: target.id, generation: target.generation, revision: target.revision,
      sequence: observation?.sequence, inputRevision: observation?.inputRevision, serial: ++serial, at: now(),
      runtime: Object.fromEntries(['id', 'generation', 'kind', 'provider', 'observation', 'started', 'launchState', 'processState', 'agentProcessState', 'agentPid', 'turnId', 'turnStartedAt', 'turnState', 'status', 'pendingInput', 'pendingInteraction', 'manualInputPending', 'interactionInputPending', 'heldMouseButton', 'binding', 'attention'].map(field => [field, structuredClone(target[field])])),
      authority: projectInputAuthority(target, requests), requests: structuredClone(requests), used: false };
    tokens.set(token, record);
    if (currentRead) latestReads.set(targetKey, { token, modelRound: attempt.modelRound });
    while (tokens.size > 128) tokens.delete(tokens.keys().next().value);
    return token;
  }
  function latest(target, modelRound) {
    const read = latestReads.get(key(target)), record = read && tokens.get(read.token);
    if (!Number.isSafeInteger(modelRound) || !read || !Number.isSafeInteger(read.modelRound) || read.modelRound >= modelRound || !record || record.used ||
        now() - record.at > 30000 || record.targetId !== target.id || record.generation !== target.generation) return;
    const previous = lastActions.get(key(target));
    if (previous && record.serial <= previous.serial) return;
    // This selects evidence, not authorization. authorize still checks current
    // input ownership, interaction revisions and action-specific constraints.
    return record.token;
  }
  function authorize(token, target, action, requests = target.pendingInteractions || []) {
    const record = tokens.get(token);
    if (!record || record.used || record.targetId !== target.id || record.generation !== target.generation || now() - record.at > 30000)
      throw new Error('Read this terminal again before acting; the observation token is missing, used, or stale.');
    // Finishing records evidence without input. Native controls compare the
    // frozen input authority rather than unrelated publication/metadata churn.
    // Chat panes retain their existing broad revision boundary.
    const prompt = { ...action, operator: true, promptSubmission: true, submit: true };
    const busyPrompt = action.kind === 'send_prompt' && !record.requests.length && !requests.length
      && isObservedBusyPrompt(prompt, record.runtime) && isObservedBusyPrompt(prompt, target)
      && record.runtime.agentPid === target.agentPid && record.runtime.turnId === target.turnId
      && record.runtime.turnStartedAt === target.turnStartedAt;
    // Pure prompt submission rechecks live input ownership in the native adapter;
    // unsupported busy composers queue for a fresh readiness check before writing.
    const chat = ['fusion', 'openfusion'].includes(target.kind || target.provider);
    if (action.kind !== 'finish_terminal' && !busyPrompt && (chat
      ? target.revision !== undefined && record.revision !== target.revision
      : !sameInputAuthority(record.authority, projectInputAuthority(target, requests))))
      throw new Error('The terminal changed after the last observation. Read it again.');
    const previous = lastActions.get(key(target));
    if (previous && record.serial <= previous.serial) throw new Error('Read the terminal after the last action before taking another step.');
    if (['send_prompt', 'terminal_interact', 'interrupt'].includes(action.kind) && !['fusion', 'openfusion'].includes(target.kind || target.provider)) {
      // Native operators may omit redundant model copies of counters already bound
      // by this request's token. The dispatcher derives those fields only in its
      // post-claim transport envelope, leaving the frozen step payload unchanged.
      if (!Number.isSafeInteger(record.sequence) || record.sequence < 0 || !Number.isSafeInteger(record.inputRevision) || record.inputRevision < 0 ||
          (action.observationSequence !== record.sequence && action.observationSequence !== undefined) ||
          (action.inputRevision !== record.inputRevision && action.inputRevision !== undefined))
        throw new Error('Native input requires the screen sequence and input revision from this observation.');
    }
    return record;
  }
  function consume(record, target, action) {
    record.used = true;
    if (action.kind !== 'finish_terminal') lastActions.set(key(target), { serial: ++serial, kind: action.kind });
  }
  return { invalidate, beginRead, observe, latest, authorize, consume };
}
module.exports = { createOperatorObservations };
