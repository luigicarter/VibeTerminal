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

module.exports = { launcherCatalog, routingBindingMatches, sessionReady, waitForRoutingReady };
