'use strict';

// Preparing a pane rewrites shared per-pane files. Retire obsolete launches
// immediately, but let their writes/cleanup finish before the next preparation.
function createChatLaunchPreparation() {
  const pending = new Map();
  const cancelled = () => ({ ok: false, cancelled: true, status: 'cancelled' });
  function enqueue(id, operation, cleanup = false) {
    const previous = pending.get(id);
    if (previous) previous.cancelled = true;
    const entry = { cancelled: cleanup, promise: undefined };
    const isCurrent = () => !entry.cancelled && pending.get(id) === entry;
    entry.promise = Promise.resolve(previous?.promise).catch(() => {}).then(async () => {
      if (cleanup) return operation();
      if (!isCurrent()) return cancelled();
      try {
        const result = await operation(isCurrent);
        return isCurrent() ? result : cancelled();
      } catch (error) {
        if (!isCurrent()) return cancelled();
        throw error;
      }
    }).finally(() => { if (pending.get(id) === entry) pending.delete(id); });
    pending.set(id, entry);
    return entry.promise;
  }
  return {
    run: (id, operation) => enqueue(id, operation),
    cancel: (id, cleanup) => enqueue(id, cleanup, true),
    cancelAll() { for (const entry of pending.values()) entry.cancelled = true; }
  };
}

module.exports = { createChatLaunchPreparation };
