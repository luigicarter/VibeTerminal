'use strict';

// Transport attempts need fresh IDs after proven-unsent failures, while task
// ownership must remain attached to the original queued action. Keep completed
// aliases for late events without evicting any in-flight correlation.
function createQueuedInputAttempts({ maxCompleted = 1000 } = {}) {
  const attempts = new Map();
  function prune() {
    let completed = [...attempts.values()].filter(attempt => attempt.done).length;
    for (const [id, attempt] of attempts) {
      if (completed <= maxCompleted) break;
      if (attempt.done) { attempts.delete(id); completed--; }
    }
  }
  function matches(attempt, event) {
    return attempt && attempt.id === event.id && attempt.generation === event.generation &&
      (event.requestId === undefined || event.requestId === attempt.requestId);
  }
  function correlate(event) {
    let result = event;
    for (const field of ['actionId', 'activeActionId', 'pendingActionId', 'completedActionId']) {
      const attempt = attempts.get(event?.[field]);
      if (matches(attempt, event)) result = { ...result, [field]: attempt.actionId,
        ...(field === 'actionId' && { deliveryAttemptId: event.actionId }) };
    }
    return result;
  }
  return {
    remember(id, action) { attempts.set(id, { actionId: action.actionId, requestId: action.requestId, ...action.target, done: false }); },
    complete(id) { const attempt = attempts.get(id); if (attempt) attempt.done = true; prune(); },
    correlate,
    forget(id, generation) { for (const [key, attempt] of attempts) if (attempt.id === id && attempt.generation === generation) attempts.delete(key); },
    clear() { attempts.clear(); }
  };
}
module.exports = { createQueuedInputAttempts };
