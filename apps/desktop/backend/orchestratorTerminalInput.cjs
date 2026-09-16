'use strict';
const { isBusyPromptSubmission } = require('./orchestratorBusyInput.cjs');
const { validateTerminalControls } = require('../shared/terminalControls.cjs');
const { projectInputAuthority, sameInputAuthority } = require('./orchestratorInputAuthority.cjs');
const { projectInputSurface, sameInputSurface, validInputSurface, changedSurfaceFields, surfaceEvidence } = require('./orchestratorInputSurface.cjs');
const { HIDDEN_CURSOR_FORMS } = require('./orchestratorPromptReadiness.cjs');
const { routingBindingMatches, isInitialNativePrompt, supportsNativePromptReadiness, waitForNativePromptReady } = require('./orchestratorLaunchers.cjs');
const { paneLabel } = require('./orchestratorFailureText.cjs');

// One case, and only one, admits a baseline that does not match the pane's
// current input surface: the read landed part-way through a redraw, so the
// baseline carries a cursor the terminal had briefly hidden or misplaced. A
// PROMPT SUBMISSION into a composer that is now recognizably empty, at the same
// geometry, screen and input revision, is still the same act. Keys and mouse
// never supersede: menu navigation means whatever the screen under it means, and
// a provider that animates its composer stops doing so while a popup is open.
function supersedesInputSurface(action, expected, fresh) {
  return action.promptSubmission === true && !action.editInput && !action.keys?.length && !action.mouse &&
    fresh.composer.empty === true && fresh.interactionInputPending !== true &&
    ['id', 'generation', 'cols', 'rows', 'alternateScreen', 'inputRevision']
      .every(field => JSON.stringify(expected?.[field]) === JSON.stringify(fresh[field])) &&
    (fresh.cursorVisible === true || HIDDEN_CURSOR_FORMS.has(fresh.composer.form));
}
function createTerminalInput({ getSession, readSession, write, onBeforeWrite = () => {}, onStartupScreen, isRegisteredProject,
  now = Date.now, startupTimeoutMs = 20000, startupPollMs = 100 }) {
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
  const startupScreenReport = screen => `${paneLabel(screen.session)} is showing a startup screen: ${screen.detail || 'startup onboarding'}.`;
  // The folder trust prompt of a registered Lina project is answered with the
  // affirmative default the screen already highlights, through the same guarded
  // transport as any other terminal control: the pane, generation, recipient and
  // the exact observed screen and input revision all fence the write. Every
  // other startup screen — sandbox, sign-in, hooks, theme, model, permission —
  // is only reported and waited on, never answered.
  function startupTrustAnswer(action, id, generation) {
    if (typeof isRegisteredProject !== 'function') return undefined;
    let attempted = false;
    return async ({ session, observation }) => {
      if (attempted || disposed || action.signal?.aborted) return { ok: false };
      attempted = true;
      const pid = rootPid(session);
      if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: false };
      const response = await write({ kind: 'interaction', id, generation, actionId: `${action.actionId}:startup-trust`,
        signal: AbortSignal.any([lifetime.signal, ...(action.signal ? [action.signal] : [])]),
        keys: ['enter'], submit: false, requestId: action.requestId, expectedAgentPid: pid,
        interactionEvidence: { id, generation, pid, sequence: observation.sequence, revision: session.revision, observedAt: now(),
          shell: false, cols: observation.cols, rows: observation.rows, inputRevision: observation.inputRevision,
          // A trust screen is not a composer, so this evidence carries
          // composerEmpty:false and can never clear a keystroke latch. It is
          // supplied so the host fences this write on the input surface too,
          // rather than on an output counter a repainting screen keeps moving.
          surface: surfaceEvidence(projectInputSurface(session, observation), observation.sequence) } });
      return { ok: response?.ok === true && response.delivery !== 'not-dispatched' };
    };
  }
  function handle(action) {
    const id = action?.target?.id, generation = action?.target?.generation;
    // A failure carries the surface this attempt was fenced on, so a retry of
    // the same prompt keeps the baseline the first attempt established instead
    // of re-taking one that a keystroke could have moved in between.
    const result = (status, error) => ({ ok: false, status, error, id, generation, actionId: action?.actionId,
      ...(action?.inputSurface ? { inputSurface: action.inputSurface } : {}),
      ...(status !== 'unknown' ? { delivery: 'not-dispatched' } : {}) });
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
      // One freshness contract: the input surface the application captured at
      // its own last read of this pane. A startup send is the single action
      // allowed to arrive without one, because the pane has not painted a
      // composer yet; the startup wait below captures it before anything is
      // written. Nothing here is a byte counter, and nothing here came from the
      // model.
      const deferredStartupRead = !action.inputSurface &&
        !action.editInput && (action.promptSubmission || action.inputPurpose === 'task') && needsStartupReadiness(getSession(id));
      if ((!deferredStartupRead && !validInputSurface(action.inputSurface)) ||
          (action.operator && (typeof action.requestId !== 'string' || !action.requestId))) return result('invalid-action', 'A captured terminal input surface and a request owner are required for terminal input.');
      if (disposed || action.signal?.aborted) return result('cancelled', 'Cancelled.');
      if (locks.has(id)) return result('interaction-busy', 'Another terminal interaction is in flight.');
      locks.add(id);
      try {
        let startupBinding, startupObservation, startupAnswered;
        const initial = getSession(id);
        if (!action.editInput && (action.promptSubmission || action.inputPurpose === 'task') && needsStartupReadiness(initial)) {
          if (startupLaunches.get(id)?.pid && startupLaunches.get(id).pid !== rootPid(initial)) return result('recipient-unavailable', 'The tracked startup recipient changed before input.');
          if (action.inputAuthority && !sameInputAuthority(action.inputAuthority, projectInputAuthority(initial))) return result('stale-observation', 'The terminal input authority changed before the startup wait.');
          const startup = await waitForNativePromptReady({ action, getSession, readSession,
            signal: AbortSignal.any([lifetime.signal, ...(action.signal ? [action.signal] : [])]), timeoutMs: startupTimeoutMs, pollMs: startupPollMs,
            // A startup screen is published as soon as it is seen, so the user
            // hears why nothing has been typed yet instead of silence.
            onTransient: screen => onStartupScreen?.({ id, generation, actionId: action.actionId, requestId: action.requestId,
              prompt: screen.prompt, text: startupScreenReport(screen) }),
            isRegisteredProject, answerStartupPrompt: startupTrustAnswer(action, id, generation),
          });
          startupAnswered = startup.startupAnswered;
          if (!startup.ok) return { ...result(startup.status, startup.error), ...startup };
          // The wait retained the original input revision and recipient. Only
          // read-only output changes may refresh the request's screen evidence.
          action = { ...action, inputAuthority: projectInputAuthority(startup.session),
            inputSurface: startup.surface, routingBinding: startup.routingBinding };
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
        if (before.selection && before.selection.status !== 'confirmed') return result('recipient-unavailable', 'Wait for the selected chat to be verified.');
        if (['fusion', 'openfusion'].includes(before.kind) || before.processState !== 'running' || (!shell && before.agentProcessState !== 'running')) return result('not-running', 'A live native terminal is required.');
        const busyPrompt = isBusyPromptSubmission(action, before);
        const authority = projectInputAuthority(before);
        if (!busyPrompt && action.inputAuthority && !sameInputAuthority(action.inputAuthority, authority)) return result('stale-observation', 'The terminal input authority changed after the last observation.');
        const matchesPromptObservation = session => !action.promptObservation || ['agentPid', 'turnId', 'turnStartedAt'].every(field => action.promptObservation[field] === session[field]);
        if (busyPrompt && !matchesPromptObservation(before)) return result('recipient-unavailable', 'The originally observed busy root composer changed before submission.');
        if (action.promptSubmission && (before.turnState === 'waiting' || before.pendingInteraction || ['approval', 'question'].includes(before.attention?.reason))) return result('blocked', 'it is waiting on an answer before it can continue');
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
        // The PTY output counter is not a freshness fact: it counts bytes, and an
        // animated composer bumps it several times a second while nothing about
        // the input moves. It travels to the host as diagnostics, never a gate.
        if (!observation?.ok || observation.generation !== generation || observation.id !== id || observation.exited ||
            !Number.isSafeInteger(observation.sequence) || observation.sequence < 0) return result('stale-observation', 'Read the current terminal screen before interacting.');
        if (observation.inputRevision !== action.inputSurface.inputRevision) return { ...result('stale-observation', 'Read the current terminal input state before interacting.'), reason: 'input-revision-changed' };
        if (!Number.isSafeInteger(observation.cols) || observation.cols <= 0 || !Number.isSafeInteger(observation.rows) || observation.rows <= 0 ||
            (latest.cols !== undefined && latest.cols !== observation.cols) || (latest.rows !== undefined && latest.rows !== observation.rows)) return result('stale-observation', 'Read the current terminal geometry before interacting.');
        // The input surface: where the caret is, what stands to its left, which
        // composer is painted, and who owns the pending input. This is what the
        // sequence counter was standing in for, and unlike the counter it does
        // not move when a pane merely repaints itself. The diagnostic names the
        // fields that moved and never a fragment of the screen.
        const surface = projectInputSurface(latest, observation);
        if (!sameInputSurface(action.inputSurface, surface) && !supersedesInputSurface(action, action.inputSurface, surface))
          return { ...result('stale-observation', 'Read the current terminal screen before interacting.'),
            reason: 'surface-changed', changed: changedSurfaceFields(action.inputSurface, surface) };
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
              inputRevision: surface.inputRevision, surface: surfaceEvidence(surface, observation.sequence) } });
          if (response?.ok === false && response.delivery !== 'not-dispatched' && ['write-failed', 'unconfirmed', 'uncertain'].includes(response.status)) response = { ...response, status: 'unknown' };
          if (startupBinding && response?.ok === true && response.delivery !== 'not-dispatched') {
            startupReady.set(id, startupBinding);
            if (startupReady.size > 1000) startupReady.delete(startupReady.keys().next().value);
          }
          // An answered trust prompt is part of what happened to this pane, so
          // the receipt the user reads says so beside the delivery itself.
          const answered = startupAnswered ? { startupAnswered, message: 'Answered the folder trust prompt.' } : {};
          // A refused write carries the surface it was fenced on, so a retry of
          // the same prompt keeps this baseline rather than re-taking one.
          const fenced = action.inputSurface && response?.ok === false ? { inputSurface: action.inputSurface } : {};
          return response && typeof response.ok === 'boolean' ? { ...response, id, generation, actionId: action.actionId, ...answered, ...fenced, ...(response.delivery !== 'not-dispatched' && (response.ok || response.status === 'unknown') ? deliveryMetadata : {}) } : { ...result('unknown', 'No terminal transport acknowledgment.'), ...answered, ...deliveryMetadata };
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
