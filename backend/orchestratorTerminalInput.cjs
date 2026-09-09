'use strict';
const { isBusyPromptSubmission } = require('./orchestratorBusyInput.cjs');
const { validateTerminalControls } = require('../shared/terminalControls.cjs');
const { projectInputAuthority, sameInputAuthority } = require('./orchestratorInputAuthority.cjs');
const { routingBindingMatches, isInitialNativePrompt, supportsNativePromptReadiness, waitForNativePromptReady } = require('./orchestratorLaunchers.cjs');
function createTerminalInput({ getSession, readSession, write, onBeforeWrite = () => {}, now = Date.now, startupTimeoutMs = 20000, startupPollMs = 100 }) {
  const results = new Map(), locks = new Set(), startupReady = new Map(), startupLaunches = new Map();
  let disposed = false;
  const lifetime = new AbortController();
  const rootPid = session => (session?.kind || session?.provider) === 'terminal' ? session?.pid || session?.terminalPid : session?.agentPid;
  function trackStartup(target) {
    if (!target?.id || (target.launchToken === undefined && target.generation === undefined)) return;
    const retained = startupLaunches.get(target.id);
    if (retained && retained.launchToken === target.launchToken && (target.generation === undefined || retained.generation === target.generation)) return;
    startupLaunches.set(target.id, { ...target }); startupReady.delete(target.id);
    if (startupLaunches.size > 1000) startupLaunches.delete(startupLaunches.keys().next().value);
  }
  function needsStartupReadiness(session) {
    const tracked = startupLaunches.get(session?.id);
    if (!tracked || !supportsNativePromptReadiness(session) ||
        tracked.launchToken !== session.launchToken || tracked.generation !== undefined && tracked.generation !== session.generation ||
        session.generation == null || String(session.generation).startsWith('paused:')) return false;
    tracked.generation ??= session.generation;
    if (Number.isSafeInteger(rootPid(session)) && rootPid(session) > 0) tracked.pid ??= rootPid(session);
    const retained = startupReady.get(session?.id);
    return isInitialNativePrompt(session) && !(retained && routingBindingMatches(retained.binding, session) && retained.pid === rootPid(session));
  }
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
      const deferredStartupRead = action.operator !== true && action.observationSequence === undefined &&
        !action.editInput && (action.promptSubmission || action.inputPurpose === 'task') && needsStartupReadiness(getSession(id));
      if ((!deferredStartupRead && (!Number.isSafeInteger(action.observationSequence) || action.observationSequence < 0)) ||
          ((action.operator || action.editInput || action.inputRevision !== undefined) && (!Number.isSafeInteger(action.inputRevision) || action.inputRevision < 0)) ||
          (action.operator && (typeof action.requestId !== 'string' || !action.requestId))) return result('invalid-action', 'Observed screen and input revisions and a request owner are required for operator controls.');
      if (disposed || action.signal?.aborted) return result('cancelled', 'Cancelled.');
      if (locks.has(id)) return result('interaction-busy', 'Another terminal interaction is in flight.');
      locks.add(id);
      try {
        let startupBinding, startupObservation;
        const initial = getSession(id);
        if (!action.editInput && (action.promptSubmission || action.inputPurpose === 'task') && needsStartupReadiness(initial)) {
          if (startupLaunches.get(id)?.pid && startupLaunches.get(id).pid !== rootPid(initial)) return result('recipient-unavailable', 'The tracked startup recipient changed before input.');
          if (action.inputAuthority && !sameInputAuthority(action.inputAuthority, projectInputAuthority(initial))) return result('stale-observation', 'The terminal input authority changed before the startup wait.');
          const startup = await waitForNativePromptReady({ action, getSession, readSession,
            signal: AbortSignal.any([lifetime.signal, ...(action.signal ? [action.signal] : [])]), timeoutMs: startupTimeoutMs, pollMs: startupPollMs });
          if (!startup.ok) return { ...result(startup.status, startup.error), ...startup };
          // The wait retained the original input revision and recipient. Only
          // read-only output changes may refresh the request's screen evidence.
          action = { ...action, observationSequence: startup.observation.sequence, inputRevision: startup.inputRevision,
            inputAuthority: projectInputAuthority(startup.session), routingBinding: startup.routingBinding };
          startupBinding = { binding: startup.routingBinding, pid: rootPid(startup.session) };
          startupLaunches.get(id).pid ??= startupBinding.pid;
          startupObservation = startup.observation;
        }
        const before = getSession(id);
        const shell = before?.provider === 'terminal' || before?.kind === 'terminal';
        const pid = shell ? before?.pid || before?.terminalPid : before?.agentPid;
        if (!before || before.generation !== generation) return result('stale-generation', 'The terminal generation changed.');
        if (action.target.launchToken !== undefined && action.target.launchToken !== before.launchToken) return result('stale-generation', 'The requested terminal launch changed.');
        if (!routingBindingMatches(action.routingBinding, before)) return result('conversation-changed', 'The assigned conversation changed before input.');
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
        // Startup already obtained an abortable, bounded decoded observation.
        // Reuse it instead of taking an unbounded second read; the PTY still
        // fences its exact sequence/input revision immediately before writing.
        const observation = startupObservation || await readSession({ id, generation });
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
        if (!routingBindingMatches(action.routingBinding, getSession(id))) return result('conversation-changed', 'The assigned conversation changed while observing input.');
        if (startupBinding && rootPid(getSession(id)) !== startupBinding.pid) return result('recipient-unavailable', 'The startup input recipient changed before dispatch.');
        try {
          let response = await write({ kind: 'interaction', id, generation, actionId: action.actionId, signal: AbortSignal.any([lifetime.signal, ...(action.signal ? [action.signal] : [])]),
            text: controls.text, keys: action.keys, submit: action.submit, mouse: action.mouse, expectedAgentPid: pid,
            requestId: action.requestId, operator: action.operator, editInput: action.editInput,
            interactionEvidence: { id, generation, pid, sequence: observation.sequence, revision: latest.revision, observedAt: now(), shell,
              cols: observation.cols, rows: observation.rows,
              ...(action.inputRevision !== undefined ? { inputRevision: action.inputRevision } : {}) } });
          if (response?.ok === false && response.delivery !== 'not-dispatched' && ['write-failed', 'unconfirmed', 'uncertain'].includes(response.status)) response = { ...response, status: 'unknown' };
          if (startupBinding && response?.ok === true && response.delivery !== 'not-dispatched') {
            startupReady.set(id, startupBinding);
            if (startupReady.size > 1000) startupReady.delete(startupReady.keys().next().value);
          }
          return response && typeof response.ok === 'boolean' ? { ...response, id, generation, actionId: action.actionId, ...(response.delivery !== 'not-dispatched' && (response.ok || response.status === 'unknown') ? deliveryMetadata : {}) } : { ...result('unknown', 'No terminal transport acknowledgment.'), ...deliveryMetadata };
        } catch (error) { return { ...result('unknown', String(error?.message || error)), ...deliveryMetadata }; }
      } catch (error) { return result('rejected', String(error?.message || error)); }
      finally { locks.delete(id); }
    });
    const entry = { promise: work, done: false }; results.set(key, entry);
    void work.then(() => { entry.done = true; }, () => { entry.done = true; });
    return work;
  }
  return { handle, trackStartup, needsStartupReadiness, dispose() { disposed = true; lifetime.abort(); results.clear(); startupReady.clear(); startupLaunches.clear(); } };
}
module.exports = { createTerminalInput };
