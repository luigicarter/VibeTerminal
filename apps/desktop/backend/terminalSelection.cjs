'use strict';

// A session ID establishes existence, not selection. Only the owning native
// invocation's dedicated start/clear/resume hook can propose a replacement.
function selectedConversationEvent(record, event) {
  if (!['claude', 'codex', 'open-codex'].includes(record.snapshot.provider) ||
      event.type !== 'agent-session' || event.phase !== 'start' ||
      !['startup', 'clear', 'resume'].includes(event.source) ||
      !event.invocationId || event.invocationId !== record.rootProcessId ||
      !event.providerThreadId || event.parentThreadId || event.transcriptKind === 'subagent' ||
      event.rootVerified === false || !Number.isFinite(event.observedAt) ||
      ['exited', 'failed'].includes(record.snapshot.agentProcessState)) return false;
  const previous = record.snapshot.selection;
  if (event.observedAt < (record.selectionObservedAt || 0)) return false;
  // Late startup/clear events for a retired ID cannot switch back. An explicit
  // native resume can, with a new occurrence and a fresh metadata confirmation.
  if (event.source !== 'resume' && record.retiredConversations?.has(event.providerThreadId)) return false;
  if (event.observedAt === record.selectionObservedAt &&
      (previous?.threadRef?.id || record.snapshot.conversation?.id) !== event.providerThreadId) return 'unordered';
  return true;
}

module.exports = { selectedConversationEvent };
