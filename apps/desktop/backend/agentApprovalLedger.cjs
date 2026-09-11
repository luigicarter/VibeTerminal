'use strict';
const { randomUUID } = require('node:crypto');

// One runtime generation owns this ledger. Native attempt IDs are the only
// normal resolution key. An unidentified approval remains explicit until a
// trustworthy attempt correlation or the owning lifecycle ends.
function createApprovalLedger() {
  const scopes = new Map();
  function state(scope) {
    if (!scopes.has(scope)) scopes.set(scope, { active: new Map(), pending: new Map(), settled: new Set() });
    return scopes.get(scope);
  }
  return {
    observe(scope, event, at) {
      if (!(event.type === 'agent-activity' && event.toolId || event.type === 'agent-running' && event.phase === 'stop' && event.toolId ||
          event.type === 'agent-attention' && event.attention?.state === 'waiting' && event.attention.reason === 'approval')) return;
      const s = state(scope), toolId = typeof event.toolId === 'string' && event.toolId ? event.toolId : undefined;
      if (event.type === 'agent-activity' && toolId) {
        if (event.phase === 'start' && !s.settled.has(toolId)) {
          if (s.active.size < 1024) s.active.set(toolId, { name: event.toolName, at });
          else s.activeIncomplete = true;
        }
        if (event.phase === 'stop') {
          s.active.delete(toolId); s.pending.delete(`tool:${toolId}`); s.settled.add(toolId);
          if (s.settled.size > 1024) s.settled.delete(s.settled.values().next().value);
        }
      }
      if (event.type === 'agent-running' && event.phase === 'stop' && toolId) {
        s.active.delete(toolId); s.pending.delete(`tool:${toolId}`); s.settled.add(toolId);
        if (s.settled.size > 1024) s.settled.delete(s.settled.values().next().value);
      }
      if (event.type !== 'agent-attention' || event.attention?.state !== 'waiting' || event.attention.reason !== 'approval') return;
      let attempt = toolId;
      // A unique currently active native attempt, in this exact scope and
      // preceding this event, supplies more evidence than a tool name alone.
      if (!attempt && !s.activeIncomplete && s.active.size === 1 && event.toolName) {
        const [candidate, active] = [...s.active][0];
        if (active.name === event.toolName && active.at <= at) attempt = candidate;
      }
      if (attempt && s.settled.has(attempt)) return;
      const key = attempt ? `tool:${attempt}` : `unidentified:${String(event.toolName || 'unknown').slice(0, 120)}`;
      if (s.pending.has(key)) return;
      if (s.pending.size >= 128) {
        if (!s.pending.has('overflow')) s.pending.set('overflow', { id: randomUUID(), state: 'waiting', reason: 'approval', identity: 'unverified-overflow', updatedAt: at });
        return;
      }
      s.pending.set(key, { id: randomUUID(), state: 'waiting', reason: 'approval', toolId: attempt,
        identity: attempt ? 'native-tool-attempt' : 'unidentified', updatedAt: at });
    },
    waiting(scope) { return structuredClone([...(scopes.get(scope)?.pending.values() || [])]); },
    clear(scope) { scopes.delete(scope); },
    retainChildren(ids) { for (const scope of scopes.keys()) if (scope.startsWith('child:') && !ids.has(scope.slice(6))) scopes.delete(scope); },
    dispose() { scopes.clear(); }
  };
}
module.exports = { createApprovalLedger };
