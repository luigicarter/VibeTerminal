'use strict';
const { isBusyPromptSubmission } = require('./orchestratorBusyInput.cjs');
const { validateTerminalControls } = require('../shared/terminalControls.cjs');
const { projectInputAuthority, sameInputAuthority } = require('./orchestratorInputAuthority.cjs');
function createTerminalInput({ getSession, readSession, write, onBeforeWrite = () => {}, now = Date.now }) {
  const results = new Map(), locks = new Set();
  let disposed = false;
  function handle(action) {
    const id = action?.target?.id, generation = action?.target?.generation;
    const result = (status, error) => ({ ok: false, status, error, id, generation, actionId: action?.actionId, ...(status !== 'unknown' ? { delivery: 'not-dispatched' } : {}) });
    if (disposed) return Promise.resolve(result('cancelled', 'Terminal interaction transport is closed.'));
    if (!id || generation == null || !action?.actionId) return Promise.resolve(result('invalid-action', 'Target, generation and action ID are required.'));
    const key = JSON.stringify([id, generation, action.actionId]);
    if (results.has(key)) { const cached = results.get(key); if (cached.done) { results.delete(key); results.set(key, cached); } return cached.promise; }
    // The caller mints action IDs and consumes submission grants. Retain bounded
    // recent dedup evidence without ever evicting a transport still in flight.
    if (results.size >= 1000) {
      const oldest = [...results].find(([, entry]) => entry.done);
      if (!oldest) return Promise.resolve(result('interaction-busy', 'Too many terminal interactions are in flight.'));
      results.delete(oldest[0]);
    }
    const work = Promise.resolve().then(async () => {
      const controls = validateTerminalControls(action);
      if (!controls.ok) return result('invalid-action', controls.error);
      const nativeInterrupt = action.operator === true && !action.text && !action.mouse && !action.submit && action.keys?.length === 1 && action.keys[0] === 'ctrl-c';
      if (!Number.isSafeInteger(action.observationSequence) || action.observationSequence < 0 ||
          ((action.operator || action.editInput || action.inputRevision !== undefined) && (!Number.isSafeInteger(action.inputRevision) || action.inputRevision < 0)) ||
          (action.operator && (typeof action.requestId !== 'string' || !action.requestId))) return result('invalid-action', 'Observed screen and input revisions and a request owner are required for operator controls.');
      if (disposed || action.signal?.aborted) return result('cancelled', 'Cancelled.');
      if (locks.has(id)) return result('interaction-busy', 'Another terminal interaction is in flight.');
      locks.add(id);
      try {
        const before = getSession(id);
        const shell = before?.provider === 'terminal' || before?.kind === 'terminal';
        const pid = shell ? before?.pid || before?.terminalPid : before?.agentPid;
        if (!before || before.generation !== generation) return result('stale-generation', 'The terminal generation changed.');
        if (before.launchState === 'pending') return result('launch-pending', 'Wait for the terminal launcher before interacting.');
        if (['fusion', 'openfusion'].includes(before.kind) || before.processState !== 'running' || (!shell && before.agentProcessState !== 'running')) return result('not-running', 'A live native terminal is required.');
        const busyPrompt = isBusyPromptSubmission(action, before);
        const authority = projectInputAuthority(before);
        if (!busyPrompt && action.inputAuthority && !sameInputAuthority(action.inputAuthority, authority)) return result('stale-observation', 'The terminal input authority changed after the last observation.');
        const matchesPromptObservation = session => !action.promptObservation || ['agentPid', 'turnId', 'turnStartedAt'].every(field => action.promptObservation[field] === session[field]);
        if (busyPrompt && !matchesPromptObservation(before)) return result('recipient-unavailable', 'The originally observed busy root composer changed before submission.');
        if (action.promptSubmission && (before.turnState === 'waiting' || before.pendingInteraction || ['approval', 'question'].includes(before.attention?.reason))) return result('blocked', 'Answer the pending terminal request before submitting a new prompt.');
        if (action.promptSubmission && (['running', 'busy'].includes(before.turnState) || before.childActivity || before.pendingInput) && !busyPrompt) return result('recipient-unavailable', 'Busy prompt submission is not supported by the observed root composer.');
        if (!Number.isSafeInteger(pid) || pid <= 0 || before.binding?.status === 'ambiguous' || (before.childActivity && !nativeInterrupt && !busyPrompt)) return result('recipient-unavailable', 'The native root input recipient is not verified.');
        const busyTurnId = before.turnId;
        const busyTurnStartedAt = before.turnStartedAt;
        const observation = await readSession({ id, generation });
        const latest = getSession(id);
        if (disposed || action.signal?.aborted) return result('cancelled', 'Cancelled.');
        if (!latest || latest.generation !== generation || (!busyPrompt && !sameInputAuthority(authority, projectInputAuthority(latest))) || (shell ? latest.pid || latest.terminalPid : latest.agentPid) !== pid || latest.processState !== 'running' || (!shell && latest.agentProcessState !== 'running') || (latest.childActivity && !nativeInterrupt && !busyPrompt) || latest.binding?.status === 'ambiguous') return result('stale-generation', 'The terminal runtime changed while observing input.');
        if (busyPrompt && (!isBusyPromptSubmission(action, latest) || !matchesPromptObservation(latest) || latest.turnId !== busyTurnId || latest.turnStartedAt !== busyTurnStartedAt)) return result('recipient-unavailable', 'The busy root composer changed while observing input.');
        if (!observation?.ok || observation.generation !== generation || observation.id !== id || observation.exited || (!busyPrompt && observation.sequence !== action.observationSequence)) return result('stale-observation', 'Read the current terminal screen before interacting.');
        if (busyPrompt && (!Number.isSafeInteger(observation.sequence) || observation.sequence < 0)) return result('stale-observation', 'The current terminal screen sequence is invalid.');
        if (action.inputRevision !== undefined && observation.inputRevision !== action.inputRevision) return { ...result('stale-observation', 'Read the current terminal input state before interacting.'), reason: 'input-revision-changed' };
        if (!Number.isSafeInteger(observation.cols) || observation.cols <= 0 || !Number.isSafeInteger(observation.rows) || observation.rows <= 0 ||
            (latest.cols !== undefined && latest.cols !== observation.cols) || (latest.rows !== undefined && latest.rows !== observation.rows)) return result('stale-observation', 'Read the current terminal geometry before interacting.');
        const deliveryBaseline = action.promptSubmission === true ? { submittedAt: now(), kind: latest.kind || latest.provider, turnId: latest.turnId, turnState: latest.turnState } : undefined;
        const deliveryMetadata = deliveryBaseline ? { deliveryBaseline, inputDisposition: busyPrompt ? 'submitted-while-running' : 'submitted-when-ready' } : {};
        if (deliveryBaseline) onBeforeWrite({ actionId: action.actionId, id, generation, status: 'unconfirmed', ok: true, ...deliveryMetadata });
        if (disposed || action.signal?.aborted) return result('cancelled', 'Cancelled before terminal input.');
        try {
          let response = await write({ kind: 'interaction', id, generation, actionId: action.actionId, signal: action.signal,
            text: controls.text, keys: action.keys, submit: action.submit, mouse: action.mouse, expectedAgentPid: pid,
            requestId: action.requestId, operator: action.operator, editInput: action.editInput,
            interactionEvidence: { id, generation, pid, sequence: observation.sequence, revision: latest.revision, observedAt: now(), shell,
              cols: observation.cols, rows: observation.rows,
              ...(action.inputRevision !== undefined ? { inputRevision: action.inputRevision } : {}) } });
          if (response?.ok === false && response.delivery !== 'not-dispatched' && ['write-failed', 'unconfirmed', 'uncertain'].includes(response.status)) response = { ...response, status: 'unknown' };
          return response && typeof response.ok === 'boolean' ? { ...response, id, generation, actionId: action.actionId, ...(response.delivery !== 'not-dispatched' && (response.ok || response.status === 'unknown') ? deliveryMetadata : {}) } : { ...result('unknown', 'No terminal transport acknowledgment.'), ...deliveryMetadata };
        } catch (error) { return { ...result('unknown', String(error?.message || error)), ...deliveryMetadata }; }
      } catch (error) { return result('rejected', String(error?.message || error)); }
      finally { locks.delete(id); }
    });
    const entry = { promise: work, done: false }; results.set(key, entry);
    void work.then(() => { entry.done = true; }, () => { entry.done = true; });
    return work;
  }
  return { handle, dispose() { disposed = true; results.clear(); } };
}
module.exports = { createTerminalInput };
