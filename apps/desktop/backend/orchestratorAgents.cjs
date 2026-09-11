'use strict';
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { VERSION, LIMITS, text, id, runRef, sameRun } = require('../shared/orchestratorAgentContract.cjs');
const definitions = require('../shared/providerCapabilities.json');
const { sessionIdentity, nativeKey, matchesBinding } = require('./orchestratorRouting.cjs');
const { isIdleTarget } = require('./orchestratorTargetAvailability.cjs');
const { isInactiveCloseTarget } = require('./orchestratorCloseSafety.cjs');

const structured = s => Boolean(s?.fusion || s?.openFusion || ['fusion', 'openfusion'].includes(s?.kind));
const kindOf = s => s?.openFusion ? 'openfusion' : s?.fusion ? 'fusion' : s?.kind || s?.provider;
const shell = s => ['terminal', 'shell'].includes(kindOf(s));
const live = s => runRef(s) && !s.closed && !['exited', 'failed', 'paused', 'closed'].includes(s.status) && !['exited', 'failed'].includes(s.processState);
const copy = value => value === undefined ? undefined : structuredClone(value);
const native = s => {
  const value = sessionIdentity(s);
  return { provider: value.engineProvider || (kindOf(s) === 'fusion' ? undefined : value.provider), home: value.home, workspace: value.workspace, id: value.id };
};
function rootConversationKey(s) {
  return nativeKey(native(s));
}
function currentRequests(s, requests = []) {
  return requests.filter(r => r.sessionId === s.id && r.state === 'pending' &&
    (r.generation === undefined || r.generation === s.generation));
}

// Pure metadata projection: do not enumerate/clone the source session. Chat bodies,
// scrollback and credentials can be large and have no place in this record.
function projectAgent(session, identity, { workItems = [], requests = [] } = {}) {
  if (!session || shell(session) || !identity?.agentId) return null;
  const kind = kindOf(session), chat = structured(session), nativeIdentity = native(session);
  const pending = currentRequests(session, requests);
  const children = (Array.isArray(session.children) ? session.children : []).map(child => ({
    id: id(child.id), label: text(child.label), observation: child.observation === 'provisional' ||
      session.backgroundObservation?.availability === 'unavailable' && String(child.id).startsWith('background:') ? 'provisional' :
      child.observation === 'observed' || session.activityObserved || session.observation === 'observed' ? 'observed' : 'unavailable',
    ...(Number.isFinite(child.startedAt) && { startedAt: child.startedAt })
  }));
  const attention = [];
  const addAttention = (value, scope, childId, observation = session.observation) => {
    if (value?.state !== 'waiting') return;
    attention.push({ id: id(value.id), scope, ...(childId && { childId }), reason: text(value.reason, 80) || 'unknown',
      ...(id(value.toolId) && { toolId: value.toolId }), observation: observation || 'unavailable',
      ...(Number.isFinite(value.updatedAt) && { observedAt: value.updatedAt }) });
  };
  const rootAttention = [...(session.approvals || [])];
  if (session.attention && !rootAttention.some(a => a.id === session.attention.id)) rootAttention.push(session.attention);
  for (const value of rootAttention) addAttention(value, 'root');
  for (let i = 0; i < children.length; i++) {
    const source = session.children[i], values = [...(source.approvals || [])];
    if (source.attention && !values.some(a => a.id === source.attention.id)) values.push(source.attention);
    for (const value of values) addAttention(value, 'child', children[i].id, children[i].observation);
  }
  for (const r of pending) attention.push({ id: r.id, scope: 'interaction', reason: r.kind || r.type || 'question', revision: r.revision,
    observation: 'observed', ...(id(r.childId) && { childId: r.childId }) });
  const waiting = attention.length > 0 || session.status === 'waiting' || session.turnState === 'waiting' || session.pendingInteraction === true;
  const detached = [...new Set((session.detachedTaskIds || []).filter(value => id(value)))];
  const childWork = Boolean(session.childActivity || children.length || detached.length || session.backgroundActivity?.active);
  const unverified = session.observation !== 'observed' || session.telemetryHealth === 'unavailable' || identity.state === 'ambiguous';
  const inputOccupied = Boolean(session.manualInputPending || session.interactionInputPending || session.heldMouseButton || session.composer?.dirty || session.composer?.reserved);
  const effective = { ...Object.fromEntries(['id', 'generation', 'launchToken', 'kind', 'provider', 'started', 'closed', 'status', 'turnState', 'turnActive',
    'processState', 'agentProcessState', 'agentPid', 'engineReady', 'launchState', 'observation', 'telemetryHealth', 'binding', 'pendingInput',
    'manualInputPending', 'interactionInputPending', 'heldMouseButton', 'attention', 'activeTools', 'composer'].map(key => [key, session[key]])),
    pendingInteraction: waiting, childActivity: childWork, children, detachedTaskIds: detached, backgroundActivity: session.backgroundActivity };
  const idle = identity.state !== 'ambiguous' && isIdleTarget(effective);
  const inactive = identity.state !== 'ambiguous' && isInactiveCloseTarget(effective);
  const blocker = identity.state === 'ambiguous' ? 'conversation-ambiguous' : waiting ? 'needs-input' : inputOccupied ? 'input-occupied'
    : childWork ? 'child-work' : ['running', 'busy', 'starting'].includes(session.status) ? 'working'
    : !live(session) ? 'not-running' : unverified ? 'observation-unavailable' : 'requires-current-observation';
  const describe = (eligible, blocked = false, reason = blocker) => ({ eligibility: eligible ? 'eligible' : blocked ? 'blocked' : 'unverified',
    reason: eligible ? 'current-policy-evidence' : reason, requiresLiveRecheck: true });
  const provider = definitions[session.provider || session.kind] || {};
  const participants = chat ? [
    { role: 'planner', provider: text(session.plannerProvider || session.fusionPlannerFamily), configuredModel: text(session.plannerModel || session.model || session.fusionPlannerModel || session.openFusionPlannerModel) },
    { role: 'executor', provider: text(session.executorProvider || session.fusionExecutorFamily), configuredModel: text(session.executorModel || session.fusionExecutorModel || session.openFusionExecutorModel) }
  ] : [];
  const actualNativeKey = nativeKey(nativeIdentity);
  const historicalKey = binding => {
    if (!binding) return null;
    const provider = binding.engineProvider || (binding.provider === 'openfusion' ? 'opencode' : binding.provider === 'fusion' ? undefined : binding.provider);
    return nativeKey({ ...binding, provider });
  };
  const owned = workItems.filter(w => w.binding && (matchesBinding(w.binding, session) ||
    actualNativeKey && historicalKey(w.binding.nativeIdentity) === actualNativeKey)).map(w => ({ id: w.id, title: text(w.title),
    status: text(w.status, 80), requestIds: (w.requestIds || []).slice(-12),
    requiresRevalidation: w.requiresRevalidation !== false || !matchesBinding(w.binding, session) }));
  return { version: VERSION, agentId: identity.agentId, revision: identity.revision || 1,
    identity: { state: identity.state, name: text(session.conversationTitle || session.conversation?.title || session.name || kind), kind,
      native: nativeIdentity, run: runRef(session), surfaceId: session.id, projectId: id(session.projectId), projectName: text(session.projectName),
      cwd: session.cwd, visiblePane: session.visiblePane, composition: chat ? 'composite' : 'standalone', participants },
    work: { items: owned, ownership: owned.some(w => !w.requiresRevalidation) ? 'recorded' : owned.length ? 'historical' : 'not-recorded' },
    activity: { status: text(session.status, 80) || 'unknown', observation: unverified ? 'unavailable' : 'observed',
      foreground: { state: text(session.turnState, 80) || 'unknown', turnId: id(session.turnId),
        startedAt: session.turnStartedAt, endedAt: session.turnEndedAt },
      children, childWork, coarseChildObservation: session.coarseChildObservation || 'unknown', detachedTaskIds: detached,
      reportedBackgroundCount: Number.isSafeInteger(session.backgroundActivity?.count) ? session.backgroundActivity.count : null,
      tools: (session.activeTools || []).map(tool => ({ id: id(tool.id), name: text(tool.name), startedAt: tool.startedAt })),
      lastTool: session.lastTool && { id: id(session.lastTool.id), name: text(session.lastTool.name) },
      pendingInput: session.pendingInput || null, processState: session.processState || 'unknown',
      agentProcessState: session.agentProcessState || (chat && session.engineReady ? 'running' : 'unknown') },
    attention: { required: waiting, items: attention, coverage: waiting && !attention.length ? 'reason-unavailable' : 'observed-items' },
    capabilities: { transport: chat ? 'structured' : 'native', configuredModel: text(session.model),
      observedModel: text(session.observedModel), lifecycle: chat ? 'structured' : provider.lifecycle || 'unknown',
      turnCompletion: chat ? 'structured' : provider.finalCompletion || 'unknown', childTracking: chat ? 'structured' : provider.childTracking || 'unknown',
      operations: { idleTask: describe(idle, waiting || childWork || inputOccupied),
        closeInactive: describe(inactive, waiting || childWork || inputOccupied, chat && !inactive && blocker === 'requires-current-observation' ? 'structured-lifecycle-evidence-unavailable' : blocker),
        sendPrompt: describe(false, waiting || inputOccupied || identity.state === 'ambiguous'),
        resume: { support: chat || provider.threaded ? 'supported' : 'unknown', eligibility: 'unverified', requiresLiveRecheck: true } } },
    results: { verification: 'not-established-by-session-status', turnId: id(session.turnId), state: text(session.turnState, 80) || 'unknown' },
    history: { provider: nativeIdentity.provider, conversationId: nativeIdentity.id, coverage: nativeIdentity.id ? 'fetch-on-demand' : 'identity-unavailable' } };
}

// Stores identities and projected metadata only. This index cannot send input,
// select task owners, restore a grant, or resolve a native ambiguity.
function createAgentDirectory({ makeId = () => `agent_${randomUUID()}`, maxRecords = LIMITS.identities, restored = [] } = {}) {
  let records = new Map(), nativeOwners = new Map(), runs = new Map();
  let membershipRevision = 0, current = new Map();
  for (const value of restored.slice(0, maxRecords)) {
    if (!id(value.agentId) || records.has(value.agentId) || !value.nativeIdentity) continue;
    const key = nativeKey(value.nativeIdentity);
    if (key && nativeOwners.has(key)) continue;
    records.set(value.agentId, { agentId: value.agentId, nativeKey: key, revision: 0, record: {
      version: VERSION, agentId: value.agentId, revision: 0,
      identity: { state: 'archived', name: text(value.name), kind: text(value.kind), native: copy(value.nativeIdentity), run: null, cwd: value.nativeIdentity.workspace },
      work: { items: [], ownership: 'requires-revalidation' }, activity: { status: 'archived', observation: 'unavailable' },
      attention: { required: false, items: [], coverage: 'historical-only' }, capabilities: { operations: {} },
      results: { verification: 'not-established-by-session-status' }, history: { coverage: 'fetch-on-demand' }
    } });
    if (key) nativeOwners.set(key, value.agentId);
  }
  function reconcile(sessions = [], context = {}) {
    const rollback = { records, nativeOwners, runs, current, membershipRevision };
    records = new Map([...records].map(([key, entry]) => [key, { ...entry }]));
    nativeOwners = new Map(nativeOwners); runs = new Map(runs);
    try {
    const previous = current, next = new Map(), seenNative = new Map();
    const sources = sessions.filter(s => s && id(s.id) && !shell(s));
    for (const s of sources) {
      const key = rootConversationKey(s);
      if (key && live(s)) seenNative.set(key, (seenNative.get(key) || 0) + 1);
    }
    for (const s of sources) {
      const run = runRef(s), runKey = run && JSON.stringify(run), key = nativeKey(native(s));
      const old = runKey && records.get(runs.get(runKey));
      const changed = Boolean(old?.nativeKey && key && old.nativeKey !== key || old?.nativeId && native(s).id && old.nativeId !== native(s).id);
      const ambiguous = s.binding?.status === 'ambiguous' || seenNative.get(rootConversationKey(s)) > 1 || changed && !structured(s);
      let entry = !changed || ambiguous ? old : undefined;
      if (!entry && key && !ambiguous) entry = records.get(nativeOwners.get(key));
      if (!entry && !run) entry = records.get(previous.get(s.id)?.agentId);
      if (!entry) {
        if (records.size >= maxRecords) throw new Error('Agent identity capacity reached; existing records have been retained.');
        const agentId = makeId();
        if (!id(agentId) || records.has(agentId)) throw new Error('Agent identity must be new and valid.');
        entry = { agentId, nativeKey: null, revision: 0, record: null };
        records.set(agentId, entry);
      }
      // First identity can attach to a persisted owner only at a new read binding;
      // this registry does not rewrite pending run-bound task grants.
      if (key && !ambiguous) {
        const existing = nativeOwners.get(key);
        if (existing && existing !== entry.agentId) {
          entry = records.get(existing);
        } else { entry.nativeKey = key; nativeOwners.set(key, entry.agentId); }
      }
      if (runKey) runs.set(runKey, entry.agentId);
      if (!ambiguous && native(s).id) entry.nativeId = native(s).id;
      const state = ambiguous ? 'ambiguous' : !run ? 'paused' : key ? 'bound' : 'provisional';
      const projected = projectAgent(s, { agentId: entry.agentId, state }, context);
      const oldRecord = entry.record;
      if (oldRecord) projected.revision = oldRecord.revision;
      if (!oldRecord || !isDeepStrictEqual(oldRecord, projected)) projected.revision = ++entry.revision;
      entry.record = projected;
      next.set(s.id, { agentId: entry.agentId, run, state });
    }
    const keys = map => JSON.stringify([...map].map(([surface, value]) => [surface, value.agentId, value.state === 'paused']).sort());
    if (keys(previous) !== keys(next)) membershipRevision++;
    current = next;
    const activeAgents = new Set([...current.values()].map(x => x.agentId));
    for (const entry of records.values()) if (!activeAgents.has(entry.agentId) && entry.record && entry.record.identity.state !== 'archived') {
      const old = entry.record;
      entry.record = { ...old, revision: ++entry.revision, identity: { ...old.identity, state: 'archived', run: null },
        activity: { status: 'archived', observation: 'unavailable' },
        attention: { ...old.attention, required: false, coverage: 'historical-only' },
        capabilities: { ...old.capabilities, operations: {} },
        work: { ...old.work, ownership: 'requires-revalidation', items: old.work.items.map(w => ({ ...w, requiresRevalidation: true })) } };
    }
    // A run index is only needed for present sources; historical native affinity
    // lives in the compact identity map, never in retained PTY/host objects.
    const activeRuns = new Set([...current.values()].filter(x => x.run).map(x => JSON.stringify(x.run)));
    for (const key of runs.keys()) if (!activeRuns.has(key)) runs.delete(key);
    return list();
    } catch (error) {
      ({ records, nativeOwners, runs, current, membershipRevision } = rollback);
      throw error;
    }
  }
  function get(agentId) { return copy(records.get(agentId)?.record); }
  function list() { return [...new Set([...current.values()].map(x => x.agentId))].map(get); }
  return { reconcile, get, list, forSurface: surfaceId => get(current.get(surfaceId)?.agentId),
    all: () => [...records.keys()].map(get).filter(Boolean),
    exportIdentities: () => [...records.values()].filter(e => e.nativeKey || ['provider', 'home', 'workspace'].every(k => id(e.record?.identity.native?.[k]))).map(e => ({ agentId: e.agentId,
      nativeIdentity: e.nativeKey ? Object.fromEntries(JSON.parse(e.nativeKey).map((value, index) => [['provider', 'home', 'workspace', 'id'][index], value])) : copy(e.record.identity.native),
      name: e.record?.identity.name, kind: e.record?.identity.kind })),
    membershipRevision: () => membershipRevision,
    forgetArchived() {
      const present = new Set([...current.values()].map(value => value.agentId));
      for (const [agentId, entry] of records) if (!present.has(agentId)) {
        records.delete(agentId);
        if (entry.nativeKey && nativeOwners.get(entry.nativeKey) === agentId) nativeOwners.delete(entry.nativeKey);
      }
      membershipRevision++;
    },
    resolve(agentId, expectedRun) {
      const matches = [...current.values()].filter(x => x.agentId === agentId && x.run);
      if (matches.length !== 1 || matches[0].state === 'ambiguous' || expectedRun && !sameRun(matches[0].run, expectedRun)) return null;
      return copy(matches[0].run);
    },
    clear() { records.clear(); nativeOwners.clear(); runs.clear(); current.clear(); membershipRevision++; } };
}
module.exports = { projectAgent, createAgentDirectory, kindOf, currentRequests, rootConversationKey };
