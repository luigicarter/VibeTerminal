'use strict';
const { randomUUID } = require('node:crypto');
const copy = value => structuredClone(value);
const paneKey = target => typeof target?.id === 'string' && target.id && (typeof target.generation === 'number' && Number.isFinite(target.generation) || typeof target.generation === 'string' && target.generation && !target.generation.startsWith('paused:')) ? JSON.stringify([target.id, target.generation]) : null;
const workspaceKey = value => { const windows = process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(value); const normalized = (windows ? require('node:path').win32 : require('node:path').posix).normalize(value).replace(/\\/g, '/').replace(/\/$/, ''); return windows ? normalized.toLowerCase() : normalized; };
const nativeKey = identity => ['provider', 'home', 'workspace', 'id'].every(k => typeof identity?.[k] === 'string' && identity[k]) ? JSON.stringify([identity.provider, identity.home, workspaceKey(identity.workspace), identity.id]) : null;
function sessionNativeIdentity(session) {
  const native = session.conversation || session.threadRef;
  const fusion = session.fusion || session.kind === 'fusion', openFusion = session.openFusion || session.kind === 'openfusion';
  const engineProvider = fusion ? session.plannerProvider || session.fusionPlannerFamily || (['claude', 'codex'].includes(native?.provider) ? native.provider : undefined)
    : openFusion ? 'opencode' : session.provider || (session.kind === 'claude-custom' ? 'claude' : session.kind);
  return { provider: session.provider || session.kind, home: session.providerProfileId ? `custom:${session.providerProfileId}` : session.home || (openFusion ? 'openfusion' : 'global'), workspace: session.cwd, id: session.conversationId || native?.id,
    selectionRevision: session.selection?.revision || 0,
    ...(engineProvider && { engineProvider }) };
}
function matchesBinding(binding, session) {
  if (!paneKey(binding?.target) || paneKey(binding.target) !== paneKey(session)) return false;
  if (binding.target.launchToken !== undefined && binding.target.launchToken !== session.launchToken) return false;
  if (binding.nativeIdentity?.selectionRevision !== undefined && binding.nativeIdentity.selectionRevision !== (session.selection?.revision || 0)) return false;
  // A bound conversation must still be the same conversation, even if the PTY
  // generation survived a native /new command. Missing identity is not proof.
  const expected = nativeKey(binding.nativeIdentity);
  return expected !== null && expected === nativeKey(sessionNativeIdentity(session));
}
function createRoutingRegistry({ now = Date.now, maxAssignments = 100 } = {}) {
  const assignments = new Map();
  return {
    reserve(input = {}) {
      if (!input.requestId || !input.workItemId || !['create', 'reuse', 'resume', 'new', 'continue'].includes(input.decision)) return { ok: false, status: 'invalid-reservation' };
      const same = [...assignments.values()].find(a => a.workItemId === input.workItemId);
      if (same && (input.cwd && same.cwd && workspaceKey(input.cwd) !== workspaceKey(same.cwd) || input.kindOfSession && same.kindOfSession && input.kindOfSession !== same.kindOfSession || input.target && (!paneKey(input.target) || !same.target || paneKey(input.target) !== paneKey(same.target) || input.target.launchToken !== undefined && same.target.launchToken !== undefined && input.target.launchToken !== same.target.launchToken) || input.nativeIdentity && nativeKey(input.nativeIdentity) !== nativeKey(same.nativeIdentity))) return { ok: false, status: 'reservation-conflict', reservationId: same.id };
      if (same) return { ...copy(same), ok: true, reused: true, reservation: copy(same), reservationId: same.id };
      if (assignments.size >= maxAssignments) return { ok: false, status: 'capacity' };
      const key = paneKey(input.target), native = nativeKey(input.nativeIdentity);
      if (input.target && !key) return { ok: false, status: 'invalid-target' };
      if ([...assignments.values()].some(a => key && key === paneKey(a.target) || native && native === nativeKey(a.nativeIdentity))) return { ok: false, status: 'owned-by-other-work' };
      const reservation = { id: randomUUID(), requestId: input.requestId, workItemId: input.workItemId, cwd: input.cwd, kindOfSession: input.kindOfSession, decision: input.decision, target: input.target && copy(input.target), nativeIdentity: input.nativeIdentity && copy(input.nativeIdentity), state: 'reserved', status: 'reserved', at: now() };
      assignments.set(reservation.id, reservation);
      return { ...copy(reservation), ok: true, reused: false, reservationId: reservation.id, reservation: copy(reservation) };
    },
    bind(id, { target, nativeIdentity } = {}) {
      const item = assignments.get(id); if (!item || !paneKey(target)) return { ok: false, status: 'invalid-target' };
      if (item.target && (paneKey(item.target) !== paneKey(target) || nativeKey(item.nativeIdentity) && nativeKey(item.nativeIdentity) !== nativeKey(nativeIdentity))) return { ok: false, status: 'binding-changed' };
      if ([...assignments.values()].some(a => a.id !== id && (paneKey(a.target) === paneKey(target) || nativeKey(nativeIdentity) && nativeKey(a.nativeIdentity) === nativeKey(nativeIdentity)))) return { ok: false, status: 'owned-by-other-work' };
      Object.assign(item, { target: copy(target), nativeIdentity: nativeIdentity && copy(nativeIdentity), state: 'bound', status: 'bound' });
      return { ...copy(item), ok: true, reservation: copy(item), reservationId: id };
    },
    recordCreation(id, receipt = {}) {
      const item = assignments.get(id);
      const boundedId = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
      if (!item || !['create', 'new', 'resume'].includes(item.decision) || !boundedId(receipt.id) || !boundedId(receipt.actionId) || !Number.isFinite(receipt.launchToken)) return { ok: false, status: 'invalid-creation-receipt' };
      const rawTarget = receipt.target || (receipt.generation !== undefined ? { id: receipt.id, generation: receipt.generation, launchToken: receipt.launchToken } : undefined);
      if (rawTarget && (!paneKey(rawTarget) || rawTarget.id !== receipt.id || typeof rawTarget.generation === 'string' && rawTarget.generation.length > 512 || rawTarget.launchToken !== undefined && rawTarget.launchToken !== receipt.launchToken)) return { ok: false, status: 'invalid-creation-receipt' };
      const creation = { id: receipt.id, launchToken: receipt.launchToken, actionId: receipt.actionId,
        status: typeof receipt.status === 'string' ? receipt.status.slice(0, 80) : 'unknown',
        ...(rawTarget ? { target: { id: receipt.id, generation: rawTarget.generation, launchToken: receipt.launchToken } } : {}) };
      if (item.creation) {
        const old = item.creation;
        if (old.id !== creation.id || old.launchToken !== creation.launchToken || old.actionId !== creation.actionId || old.target?.generation !== creation.target?.generation) return { ok: false, status: 'creation-changed' };
        return { ok: true, reused: true, status: item.status, reservationId: id, reservation: copy(item) };
      }
      if (item.target) return { ok: false, status: 'already-bound' };
      item.creation = creation;
      return { ok: true, status: item.status, reservationId: id, reservation: copy(item) };
    },
    recoverCreation(id, session) {
      const item = assignments.get(id), creation = item?.creation;
      if (!creation || !paneKey(session)) return { ok: false, status: 'invalid-creation-recovery' };
      if (session.id !== creation.id || session.launchToken !== creation.launchToken || creation.target && session.generation !== creation.target.generation) return { ok: false, status: 'creation-changed' };
      if (item.creationRecovered) {
        if (paneKey(item.target) !== paneKey(session) || nativeKey(item.nativeIdentity) && nativeKey(item.nativeIdentity) !== nativeKey(sessionNativeIdentity(session))) return { ok: false, status: 'creation-changed' };
        return { ok: true, reused: true, status: item.status, reservationId: id, reservation: copy(item) };
      }
      // Recovery establishes ownership only. Readiness is the caller's evidence;
      // no receipt here authorizes input or changes a submitted delivery outcome.
      if (item.target || ['queued', 'submitted', 'completed'].includes(item.status)) return { ok: false, status: 'already-bound' };
      const target = { id: session.id, generation: session.generation, launchToken: session.launchToken }, nativeIdentity = sessionNativeIdentity(session);
      if ([...assignments.values()].some(a => a.id !== id && (paneKey(a.target) === paneKey(target) || nativeKey(nativeIdentity) && nativeKey(a.nativeIdentity) === nativeKey(nativeIdentity)))) return { ok: false, status: 'owned-by-other-work' };
      Object.assign(item, { target, nativeIdentity, creationRecovered: true, state: 'bound', status: 'bound' });
      return { ok: true, status: 'bound', reservationId: id, reservation: copy(item) };
    },
    get: id => assignments.has(id) ? copy(assignments.get(id)) : null,
    findByWorkItem: workItemId => { const item = [...assignments.values()].find(a => a.workItemId === workItemId); return item ? copy(item) : null; },
    mark(id, status) { const item = assignments.get(id); if (!item || !['reserved', 'creating', 'bound', 'queued', 'submitted', 'unknown', 'uncertain', 'unconfirmed', 'completed', 'cancelled', 'not-dispatched'].includes(status)) return null; item.status = status; item.state = status; return copy(item); },
    release(id, { status } = {}) {
      const item = assignments.get(id); if (!item) return false;
      const unknown = ['unknown', 'uncertain', 'unconfirmed'];
      // Cancelling a waiter cannot prove that its dispatched effect stopped.
      // A later completed/not-dispatched observation can resolve uncertainty.
      if (unknown.includes(status) || unknown.includes(item.status) && !['completed', 'not-dispatched'].includes(status) || status === 'cancelled' && ['queued', 'submitted', 'creating'].includes(item.status)) {
        item.state = 'uncertain'; item.status = 'uncertain'; return false;
      }
      assignments.delete(id); return true;
    },
    reconcile(sessions = []) {
      const updates = [];
      for (const [id, item] of assignments) if (item.target) {
        const current = sessions.find(s => paneKey(s) === paneKey(item.target));
        const expectedNative = nativeKey(item.nativeIdentity), currentNative = current && nativeKey(sessionNativeIdentity(current));
        if (current && expectedNative && !currentNative) { item.state = 'uncertain'; item.status = 'uncertain'; updates.push(copy(item)); }
        else if (!current || expectedNative && expectedNative !== currentNative) { assignments.delete(id); updates.push({ ...copy(item), status: 'invalidated' }); }
      }
      return updates;
    },
    snapshot: () => copy([...assignments.values()])
  };
}
function proposeRoutingCandidates({ sessions = [], workItem, requestId, replyToRequestId, store, registry } = {}) {
  const item = workItem || store?.findByRequest(replyToRequestId || requestId);
  const owners = registry?.snapshot() || [];
  const candidates = item ? sessions.filter(s => matchesBinding(item.binding, s) && s.observation === 'observed' && !['failed', 'exited'].includes(s.processState) && !owners.some(a => a.workItemId !== item.id && (paneKey(a.target) === paneKey(s) || nativeKey(a.nativeIdentity) && nativeKey(a.nativeIdentity) === nativeKey(sessionNativeIdentity(s))))).slice(0, 20).map(s => ({ id: s.id, generation: s.generation, launchToken: s.launchToken, cwd: s.cwd, kind: s.kind, turnState: s.turnState, pendingInput: Boolean(s.pendingInput), nativeIdentity: sessionNativeIdentity(s), evidence: 'exact-task-conversation-binding', requiresRevalidation: Boolean(item.requiresRevalidation) })) : [];
  return { workItemId: item?.id, candidates, reservations: owners.slice(0, 20).map(a => ({ id: a.id, workItemId: a.workItemId, requestId: a.requestId, target: a.target, status: a.status, decision: a.decision })), requiresNew: !item, reason: candidates.length ? 'verified-task-affinity' : item ? 'task-binding-needs-discovery' : 'no-explicit-task-affinity' };
}
module.exports = { createRoutingRegistry, proposeRoutingCandidates, sessionIdentity: sessionNativeIdentity, sessionNativeIdentity, matchesBinding, paneKey, nativeKey };
