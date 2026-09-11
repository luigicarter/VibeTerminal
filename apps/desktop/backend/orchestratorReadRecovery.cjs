'use strict';

const reads = new Set(['read_file', 'list_sessions', 'read_session', 'list_conversations', 'read_conversation', 'search_conversation']);
const contentReads = new Set(['read_file', 'read_session', 'read_conversation', 'search_conversation']);
const agentTools = require('../shared/orchestratorAgentTools.cjs');
for (const name of agentTools.READS) reads.add(name);
for (const name of agentTools.CONTENT_READS) contentReads.add(name);
const unavailable = new Set(['read-step-limit', 'unavailable', 'unsupported', 'stale-generation', 'invalid-cursor', 'failed']);
const path = require('node:path');
function fileReadSource(requested, resolved) {
  const normalize = value => {
    if (typeof value !== 'string') return;
    const flavor = /^[a-z]:[\\/]|^\\\\/i.test(value) ? path.win32 : path.posix;
    if (!flavor.isAbsolute(value)) return;
    const normalized = flavor.normalize(value).replace(/\\/g, '/');
    return flavor === path.win32 ? normalized.toLowerCase() : normalized;
  };
  const requestedPath = normalize(requested);
  return requestedPath ? { file: { requestedPath, ...(resolved && { path: normalize(resolved) }) } } : undefined;
}
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
  if (before?.workItemId) return after?.workItemId === before.workItemId && after.sourceVersion === before.sourceVersion;
  if (before?.agentId) return after?.agentId === before.agentId && after.generation === before.generation &&
    (!before.native || JSON.stringify(before.native) === JSON.stringify(after.native));
  if (before?.file) return action.kind === 'read_file' && after?.file?.requestedPath === before.file.requestedPath &&
    (!before.file.path || after.file.path === before.file.path);
  if (before?.targetId) return after?.targetId === before.targetId && after.generation === before.generation
    && (!before.native || JSON.stringify(before.native) === JSON.stringify(after.native));
  if (before?.native) return after?.native && JSON.stringify(before.native) === JSON.stringify(after.native);
  // Opaque references name a source; an unknown reference cannot be replaced
  // by a different reference or a guessed live terminal.
  return prior.action?.reference && prior.action.reference === action.reference && action.kind !== 'read_session';
}
function hasContent(action, result) {
  if (result?.ok !== true || !contentReads.has(action?.kind) || unavailable.has(result.status) || result.retrySamePage) return false;
  if (action.kind === 'read_agent') return result.agentId === action.agentId && Boolean(result.sections && result.readSource?.agentId === action.agentId);
  if (action.kind === 'read_work_item') return result.workItem?.id === action.workItemId;
  if (action.kind === 'read_file') return Boolean(result.readSource?.file && typeof result.text === 'string');
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

module.exports = { createReadRecovery, readSource, fileReadSource };
