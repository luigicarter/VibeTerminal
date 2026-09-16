'use strict';

// One registry for everything an in-flight terminal input attempt needs, keyed
// by the transport action ID it was dispatched under.
//
// Transport attempts need fresh IDs after proven-unsent failures, while task
// ownership must remain attached to the original queued action. Keep completed
// aliases for late events without evicting any in-flight correlation.
//
// It also holds the two facts the write callback has to recheck at dispatch: the
// conversation this attempt was routed to, and whether the request asked for an
// idle pane. Those lived in a separate Map and a separate Set, written and
// deleted beside this one at four call sites; an attempt registered in one and
// missed in another was a silently unfenced write.
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
    remember(id, action) { attempts.set(id, { actionId: action.actionId, requestId: action.requestId, ...action.target,
      routingBinding: action.routingBinding, idle: action.targetAvailability === 'idle', done: false }); },
    complete(id) { const attempt = attempts.get(id); if (attempt) attempt.done = true; prune(); },
    routingBinding(id) { return attempts.get(id)?.routingBinding; },
    idle(id) { return attempts.get(id)?.idle === true; },
    correlate,
    forget(id, generation) { for (const [key, attempt] of attempts) if (attempt.id === id && attempt.generation === generation) attempts.delete(key); },
    clear() { attempts.clear(); }
  };
}
module.exports = { createQueuedInputAttempts };
