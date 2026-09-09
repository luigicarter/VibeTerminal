'use strict';
const kinds = new Set([...Object.keys(require('../shared/providerCapabilities.json')), 'claude-custom', 'fusion', 'openfusion']);
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
  return ['provider', 'home', 'workspace', 'id'].every(field => !expected[field] || (field === 'workspace'
    ? typeof actual.workspace === 'string' && nativeKey({ provider: '_', home: '_', id: '_', workspace: expected.workspace }) === nativeKey({ provider: '_', home: '_', id: '_', workspace: actual.workspace })
    : expected[field] === actual[field]));
}
function sessionReady(session) {
  if (!require('./orchestratorRouting.cjs').paneKey(session) || session.started === false) return false;
  if (['fusion', 'openfusion'].includes(session.kind)) return session.engineReady === true && !['failed', 'exited', 'starting'].includes(session.status);
  return session.processState === 'running' && session.launchState !== 'pending' && (session.provider === 'terminal' || session.agentProcessState === 'running' && Number(session.agentPid) > 0 && session.observation === 'observed' && ['idle', 'completed', 'response', 'interrupted'].includes(session.turnState) && !session.pendingInput && session.binding?.status !== 'ambiguous');
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
        const processReady = valid && !['fusion', 'openfusion', 'terminal'].includes(session.kind) && session.processState === 'running' && session.launchState !== 'pending' && session.agentProcessState === 'running' && Number(session.agentPid) > 0 && session.observation === 'observed' && session.binding?.status !== 'ambiguous';
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

function supportsNativePromptReadiness(session) {
  return ['codex', 'claude', 'claude-custom', 'terminal'].includes(session?.provider || session?.kind);
}

// A running process is enough to inspect onboarding, but not to paste a task.
// Wait on decoded composer evidence without sending anything or changing the
// request's target. Output may advance; human input and recipient changes may not.
function waitForNativePromptReady({ action, getSession, readSession, signal, timeoutMs = 20000, pollMs = 100 }) {
  const { sessionIdentity } = require('./orchestratorRouting.cjs');
  const { assessNativePromptReadiness } = require('./orchestratorPromptReadiness.cjs');
  const initial = getSession(action.target.id);
  const target = { ...action.target, launchToken: initial?.launchToken };
  const identity = initial ? sessionIdentity(initial) : {};
  const shell = (initial?.kind || initial?.provider) === 'terminal';
  const rootPid = session => shell ? session?.pid || session?.terminalPid : session?.agentPid;
  let pid = rootPid(initial), inputRevision = action.inputRevision;
  return new Promise(resolve => {
    let settled = false, polling;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(polling);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const fail = (status, error, reason) => finish({ ok: false, status, error, ...(reason && { reason }), delivery: 'not-dispatched' });
    const abort = () => fail('cancelled', 'Cancelled while waiting for the native input composer. No prompt was sent.');
    const deadline = setTimeout(() => fail('launch-timeout', 'The native input composer was not ready before the startup deadline. No prompt was sent.'), timeoutMs);
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
          if (observation.inputRevision !== inputRevision) return fail('stale-observation', 'Terminal input changed during startup; the prompt was not sent.', 'input-revision-changed');
        }
        const readiness = assessNativePromptReadiness(session, observation);
        if (['blocked', 'unsupported'].includes(readiness.status)) return fail('input-surface-unverified', readiness.reason);
        if (readiness.ready && session.launchState !== 'pending' && session.processState === 'running' &&
            (shell || session.agentProcessState === 'running') && Number.isSafeInteger(pid) && pid > 0 && session.binding?.status !== 'ambiguous') {
          return finish({ ok: true, session, observation, inputRevision, routingBinding: { target, nativeIdentity: { ...identity } } });
        }
      } catch (error) { return fail('launch-unconfirmed', String(error?.message || error)); }
      if (!settled) polling = setTimeout(check, pollMs);
    }
    void check();
  });
}

module.exports = { launcherCatalog, routingBindingMatches, sessionReady, waitForRoutingReady, isInitialNativePrompt, supportsNativePromptReadiness, waitForNativePromptReady };
