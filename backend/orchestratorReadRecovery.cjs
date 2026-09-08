'use strict';

const reads = new Set(['list_sessions', 'read_session', 'list_conversations', 'read_conversation', 'search_conversation']);
const contentReads = new Set(['read_session', 'read_conversation', 'search_conversation']);
const unavailable = new Set(['read-step-limit', 'unavailable', 'unsupported', 'stale-generation', 'invalid-cursor', 'failed']);
const path = require('node:path');
function readSource(identity, session = false) {
  if (!identity) return undefined;
  const native = session ? identity.conversation || identity.threadRef : undefined;
  const id = session ? identity.conversationId || native?.id : identity.id;
  const provider = identity.provider || (session ? identity.kind : undefined);
  const fusion = identity.fusion === true || provider === 'fusion' || identity.kind === 'fusion';
  const cwd = identity.cwd;
  const source = session && identity.id && identity.generation !== undefined
    ? { targetId: identity.id, generation: identity.generation } : {};
  if (typeof id !== 'string' || !id || typeof provider !== 'string' || !provider || typeof cwd !== 'string' || !cwd) return Object.keys(source).length ? source : undefined;
  const windows = process.platform === 'win32' || /^[a-z]:[\\/]/i.test(cwd);
  const normalized = (windows ? path.win32 : path.posix).normalize(cwd).replace(/\\/g, '/').replace(/\/$/, '');
  return { ...source, native: { id, provider, cwd: windows ? normalized.toLowerCase() : normalized,
    home: identity.home || (identity.openFusion || provider === 'openfusion' ? 'openfusion' : identity.claudeHome || (provider === 'claude-custom' || provider === 'claude' && identity.providerProfileId ? 'custom' : 'global')),
    providerProfileId: identity.providerProfileId || null, openFusion: Boolean(identity.openFusion || provider === 'openfusion'),
    plannerProvider: fusion ? identity.plannerProvider || identity.fusionPlannerFamily || native?.provider || 'claude' : null } };
}
function sameSource(prior, action, result) {
  const before = prior.source, after = result.readSource;
  if (before?.targetId) return after?.targetId === before.targetId && after.generation === before.generation
    && (!before.native || JSON.stringify(before.native) === JSON.stringify(after.native));
  if (before?.native) return after?.native && JSON.stringify(before.native) === JSON.stringify(after.native);
  // Opaque references name a source; an unknown reference cannot be replaced
  // by a different reference or a guessed live terminal.
  return prior.action?.reference && prior.action.reference === action.reference && action.kind !== 'read_session';
}
function hasContent(action, result) {
  if (result?.ok !== true || !contentReads.has(action?.kind) || unavailable.has(result.status) || result.retrySamePage) return false;
  if (action.kind === 'read_session') {
    const observed = result.observation;
    return observed?.ok !== false && !unavailable.has(observed?.status) && observed?.id === action.targetId
      && result.readSource?.targetId === observed.id && result.readSource.generation === observed.generation && typeof observed?.text === 'string';
  }
  return action.kind === 'read_conversation' ? typeof result.text === 'string'
    : result.matches?.some(item => typeof item.snippet === 'string');
}

// A read-only explanation may recover a stale history reference by inspecting
// the live terminal instead. Keep every failed attempt in receipts/outcomes, but
// do not label the completed explanation as a failed workspace action. Effect
// failures and reads that fail after the last successful excerpt remain failures.
function createReadRecovery() {
  const pending = new Map(), recovered = new WeakSet();
  return {
    observe(action, result, outcome, readOnly) {
      if (!readOnly) return;
      if (result?.ok === false) {
        if (outcome && reads.has(action?.kind)) pending.set(outcome, { action, source: result.readSource });
        return;
      }
      if (!hasContent(action, result)) return;
      for (const [failure, prior] of pending) {
        // A successful read of B cannot satisfy a failed request to read A.
        if (!sameSource(prior, action, result)) continue;
        recovered.add(failure); pending.delete(failure);
      }
    },
    recovered: outcome => recovered.has(outcome),
  };
}

module.exports = { createReadRecovery, readSource };
