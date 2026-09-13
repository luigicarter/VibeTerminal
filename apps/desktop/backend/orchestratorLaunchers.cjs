'use strict';
const kinds = new Set([...Object.keys(require('../shared/providerCapabilities.json')), 'claude-custom', 'fusion', 'openfusion']);
// Fusion and Open Fusion are structured chat panes: they have no PTY and no
// terminal composer to observe. Every other launcher kind runs a real CLI.
const STRUCTURED_KINDS = new Set(['fusion', 'openfusion']);
const { paneLabel, failureSentence } = require('./orchestratorFailureText.cjs');
const bounded = value => typeof value === 'string' ? value.slice(0, 240) : undefined;
function launcherCatalog(items = []) {
  return (Array.isArray(items) ? items : []).filter(item => kinds.has(item?.kind)).slice(0, 40).map(item => {
    const structured = ['fusion', 'openfusion'].includes(item.kind);
    const configured = item.kind === 'openfusion' && !(item.plannerModel && item.executorModel) ? false : [true, false].includes(item.configured) ? item.configured : 'unknown';
    return { kind: item.kind, label: bounded(item.label) || item.kind, available: [true, false].includes(item.available) ? item.available : 'unknown', configured,
      ...(item.available === true && configured === true && item.kind !== 'terminal' ? { defaultRank: ['codex', 'claude', 'fusion', 'openfusion', 'cursor', 'gemini', 'opencode', 'kimi', 'qwen', 'claude-custom', 'kimi-custom', 'grok'].indexOf(item.kind) + 1 } : {}),
      reason: bounded(item.reason), model: bounded(item.model), plannerModel: bounded(item.plannerModel), executorModel: bounded(item.executorModel),
      capabilities: { native: !structured, structured, codingAgent: item.kind !== 'terminal' } };
  });
}
function routingBindingMatches(binding, session) {
  if (!binding) return true;
  const { sessionIdentity, paneKey, nativeKey } = require('./orchestratorRouting.cjs');
  if (!session || !paneKey(binding.target) || paneKey(binding.target) !== paneKey(session)) return false;
  if (binding.target.launchToken !== undefined && binding.target.launchToken !== session.launchToken) return false;
  const expected = binding.nativeIdentity || {}, actual = sessionIdentity(session);
  if (expected.selectionRevision !== undefined && expected.selectionRevision !== actual.selectionRevision) return false;
  return ['provider', 'home', 'workspace', 'id', 'engineProvider'].every(field => !expected[field] || (field === 'workspace'
    ? typeof actual.workspace === 'string' && nativeKey({ provider: '_', home: '_', id: '_', workspace: expected.workspace }) === nativeKey({ provider: '_', home: '_', id: '_', workspace: actual.workspace })
    : expected[field] === actual[field]));
}
// A pane whose native identity is still provisional but which has never taken a
// turn is a finished launch, not an unfinished one: its CLI reported its own
// session start and nothing is in flight. Waiting for confirmed identity would
// mean waiting for the first prompt, which is what this readiness gates.
const provisionalFreshPane = session => session.observation === 'provisional' &&
  require('./orchestratorResolver.cjs').neverPrompted(session) && session.turnState === 'idle';
function sessionReady(session) {
  if (!require('./orchestratorRouting.cjs').paneKey(session) || session.started === false) return false;
  if (['fusion', 'openfusion'].includes(session.kind)) return session.engineReady === true && !['failed', 'exited', 'starting'].includes(session.status);
  return session.processState === 'running' && session.launchState !== 'pending' && (session.provider === 'terminal' || session.agentProcessState === 'running' && Number(session.agentPid) > 0 && (session.observation === 'observed' || provisionalFreshPane(session)) && ['idle', 'completed', 'response', 'interrupted'].includes(session.turnState) && !session.pendingInput && session.binding?.status !== 'ambiguous');
}
function waitForRoutingReady({ result, getSession, refresh = async () => {}, signal, timeoutMs = 20000, pollMs = 100 }) {
  const { paneKey } = require('./orchestratorRouting.cjs');
  const { target: _provisionalTarget, cwd: _provisionalCwd, name: _provisionalName, processState: _provisionalProcessState, ...created } = result;
  return new Promise(resolve => {
    let settled = false, polling, generation = paneKey(result.target) ? result.target.generation : undefined;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(polling);
      signal?.removeEventListener('abort', abort);
      resolve({ ...created, sessionCreated: true, ...value });
    };
    const fail = (status, error) => finish({ ok: false, target: undefined, status, error, delivery: 'not-dispatched' });
    const abort = () => fail('cancelled', 'Startup wait cancelled; the pane was created and no prompt was sent.');
    const deadline = setTimeout(() => fail('launch-timeout', 'The pane was created but input readiness was not observed; no prompt was sent.'), timeoutMs);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    async function check() {
      if (settled) return;
      try {
        await refresh();
        if (settled) return;
        const session = getSession(result.id), valid = Boolean(paneKey(session));
        if (session?.launchToken > result.launchToken) return fail('superseded', 'The created session changed before readiness.');
        // Inventory may still describe the previous launch. Its generation and
        // stopped state are not evidence about the acknowledged replacement.
        if (result.launchToken !== undefined && session?.launchToken !== result.launchToken) {
          if (!settled) polling = setTimeout(check, pollMs);
          return;
        }
        if (generation !== undefined && session && session.generation !== generation) return fail('superseded', 'The created session changed before readiness.');
        if (valid) generation ??= session.generation;
        if (session?.started === false || ['failed', 'exited'].includes(session?.status) || ['failed', 'exited'].includes(session?.processState)) return fail('launch-failed', 'The created session stopped before readiness.');
        // This receipt permits observing/onboarding the new native process.
        // Initial task text is separately held for decoded composer readiness.
        const processReady = valid && !['fusion', 'openfusion', 'terminal'].includes(session.kind) && session.processState === 'running' && session.launchState !== 'pending' && session.agentProcessState === 'running' && Number(session.agentPid) > 0 && (session.observation === 'observed' || provisionalFreshPane(session)) && session.binding?.status !== 'ambiguous';
        if (valid && (result.launchToken === undefined || session.launchToken === result.launchToken) && (sessionReady(session) || processReady)) return finish({ ok: true, status: 'created', readiness: sessionReady(session) ? 'ready' : 'process-ready',
          ...(session.processState !== undefined ? { processState: session.processState } : {}),
          ...(typeof session.cwd === 'string' && session.cwd.trim() ? { cwd: session.cwd } : {}),
          ...(typeof session.name === 'string' && session.name.trim() ? { name: session.name } : {}),
          target: { id: session.id, generation: session.generation, launchToken: session.launchToken } });
      } catch (error) {
        return fail('launch-unconfirmed', `The pane was created but startup could not be confirmed: ${String(error?.message || error)}`);
      }
      if (!settled) polling = setTimeout(check, pollMs);
    }
    void check();
  });
}

function isInitialNativePrompt(session) {
  return Boolean(session && !['fusion', 'openfusion'].includes(session.kind || session.provider) &&
    !session.turnId && !session.turnStartedAt && !session.turnEndedAt);
}

// Every PTY kind waits for its own composer before a prompt is typed. Kinds
// whose composer has a verified recognizer reach 'ready'; the rest still get the
// startup-screen guard and the transient report, and are typed into once the
// process is running and painting something (see waitForNativePromptReady).
function supportsNativePromptReadiness(session) {
  const kind = session?.provider || session?.kind;
  return Boolean(kind) && kinds.has(kind) && !STRUCTURED_KINDS.has(kind);
}

// A running process is enough to inspect onboarding, but not to paste a task.
// Wait on decoded composer evidence without sending anything or changing the
// request's target. Output may advance; human input and recipient changes may not.
function waitForNativePromptReady({ action, getSession, readSession, signal, timeoutMs = 20000, pollMs = 100,
  onTransient, answerStartupPrompt, isRegisteredProject }) {
  const { sessionIdentity } = require('./orchestratorRouting.cjs');
  const { assessNativePromptReadiness } = require('./orchestratorPromptReadiness.cjs');
  const initial = getSession(action.target.id);
  const target = { ...action.target, launchToken: initial?.launchToken };
  const identity = initial ? sessionIdentity(initial) : {};
  const shell = (initial?.kind || initial?.provider) === 'terminal';
  const rootPid = session => shell ? session?.pid || session?.terminalPid : session?.agentPid;
  let pid = rootPid(initial), inputRevision = action.inputRevision;
  return new Promise(resolve => {
    let settled = false, polling, readinessReason, startupScreen, startupAnswered = false, answering = false;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(polling);
      signal?.removeEventListener('abort', abort);
      resolve({ ...value, ...(startupScreen && { startupScreen }), ...(startupAnswered && { startupAnswered: 'folder-trust' }) });
    };
    const fail = (status, error, reason) => finish({ ok: false, status, error, ...(reason && { reason }), delivery: 'not-dispatched' });
    const abort = () => fail('cancelled', 'Cancelled while waiting for the native input composer. No prompt was sent.');
    // Failure text names the pane the user is looking at and what its screen
    // actually showed, so it reads as an account rather than a status code.
    const pane = () => paneLabel(getSession(target.id) || initial);
    const deadline = setTimeout(() => finish({ ok: false, status: 'launch-timeout', delivery: 'not-dispatched', timeoutMs,
      error: `${failureSentence('launch-timeout', { pane: pane(), seconds: timeoutMs / 1000 })}${readinessReason ? ` ${readinessReason}` : ''}` }), timeoutMs);
    if (signal?.aborted) return abort();
    if (action.target.launchToken !== undefined && action.target.launchToken !== initial?.launchToken) return fail('stale-generation', 'The requested launch changed before the startup wait.');
    signal?.addEventListener('abort', abort, { once: true });
    function current() {
      const s = getSession(target.id);
      if (!s || s.generation !== target.generation || s.launchToken !== target.launchToken) { fail('stale-generation', 'The terminal changed while waiting for its input composer.'); return; }
      if (!routingBindingMatches({ target, nativeIdentity: identity }, s) || !routingBindingMatches(action.routingBinding, s)) { fail('conversation-changed', 'The assigned conversation changed during startup.'); return; }
      if (s.started === false || ['failed', 'exited'].includes(s.processState) || !shell && ['failed', 'exited'].includes(s.agentProcessState)) { fail('not-running', 'The terminal stopped before its input composer became ready.'); return; }
      if (pid && rootPid(s) !== pid) { fail('recipient-unavailable', 'The native input recipient changed during startup.'); return; }
      if (Number.isSafeInteger(rootPid(s)) && rootPid(s) > 0) pid ??= rootPid(s);
      const actualIdentity = sessionIdentity(s);
      if (!identity.id && actualIdentity.id) identity.id = actualIdentity.id;
      if (s.turnId || s.turnStartedAt || s.turnEndedAt) { fail('recipient-unavailable', 'Another turn began while waiting for the initial composer.'); return; }
      return s;
    }
    async function check() {
      if (settled) return;
      try {
        if (!current()) return;
        const observation = await readSession(target);
        if (settled) return;
        const session = current(); if (!session) return;
        if (Number.isSafeInteger(observation?.inputRevision)) {
          inputRevision ??= observation.inputRevision;
          if (observation.inputRevision !== inputRevision) return fail('stale-observation', failureSentence('stale-observation', { pane: pane() }), 'input-revision-changed');
        }
        const readiness = assessNativePromptReadiness(session, observation);
        readinessReason = readiness.reason;
        if (readiness.status === 'blocked') return fail('input-surface-unverified',
          `${failureSentence('input-surface-unverified', { pane: pane() })} ${readiness.reason}`);
        // A startup screen is the pane still launching. Report it once, answer
        // only a folder trust prompt for a registered project, and keep polling
        // to the same deadline; nothing is typed until the composer is ready.
        if (readiness.status === 'transient') {
          if (!startupScreen) {
            startupScreen = { prompt: readiness.prompt, reason: readiness.reason, detail: readiness.detail, text: String(observation.text || '').slice(0, 400) };
            try { onTransient?.({ ...startupScreen, session }); } catch { /* a report must never fail a wait */ }
          }
          if (answerStartupPrompt && !startupAnswered && !answering && readiness.prompt === 'folder-trust' &&
              readiness.affirmativeDefault === true && isRegisteredProject?.(session.cwd) === true) {
            answering = true;
            let answered;
            try { answered = await answerStartupPrompt({ session, observation }); } catch { /* keep polling; nothing was typed */ }
            if (settled) return;
            if (!current()) return;
            // The PTY host counts our own answer as an input change. Re-baseline
            // the retained revision from the next read; the composer, draft and
            // recipient guards below still decide whether anything may be typed.
            if (answered?.ok === true) { startupAnswered = true; inputRevision = undefined; }
          }
        }
        // A kind with no verified composer recognizer keeps exactly the behaviour
        // it had before this wait covered it: the prompt is typed as soon as the
        // pane is running and painting something. What it gains is everything
        // above — the pending-decision block, the startup-screen report, and the
        // trust answer — so a pane parked on a login or trust screen is reported
        // and waited on instead of typed into. Its receipt says the composer was
        // not verified.
        const unverifiedComposer = readiness.status === 'unsupported';
        if ((readiness.ready || unverifiedComposer) && session.launchState !== 'pending' && session.processState === 'running' &&
            (shell || session.agentProcessState === 'running') && Number.isSafeInteger(pid) && pid > 0 && session.binding?.status !== 'ambiguous') {
          return finish({ ok: true, session, observation, inputRevision, routingBinding: { target, nativeIdentity: { ...identity } },
            ...(unverifiedComposer && { unverifiedComposer: true }) });
        }
      } catch (error) { return fail('launch-unconfirmed', String(error?.message || error)); }
      if (!settled) polling = setTimeout(check, pollMs);
    }
    void check();
  });
}

module.exports = { launcherCatalog, routingBindingMatches, sessionReady, waitForRoutingReady, isInitialNativePrompt, supportsNativePromptReadiness, waitForNativePromptReady };
