'use strict';

// This owner only reads an already registered process-stop operation. It never
// replays a close, admits a launch, or creates a replacement stop operation.
function createCloseReconciliation({ observe, publish, getSessions, now = Date.now, intervalMs = 1000, ttlMs = 600000, limit = 500, batchSize = 8 }) {
  const pending = new Map();
  let flight, disposed = false;
  function track(receipt, request, closeScope) {
    if (disposed || typeof observe !== 'function' || !receipt.close?.operationId ||
        !['removed', 'already-absent'].includes(receipt.close.pane) || receipt.ok || request.operationId !== receipt.close.operationId) return;
    const target = receipt.close.target;
    if (!target || request.id !== target.id || request.generation !== target.generation || request.launchToken !== target.launchToken) return;
    if (pending.has(request.operationId)) return;
    pending.set(request.operationId, { receipt: structuredClone(receipt), request: structuredClone(request), closeScope: closeScope && structuredClone(closeScope), expiresAt: now() + ttlMs, nextAt: now() });
    while (pending.size > limit) pending.delete(pending.keys().next().value);
  }
  function refresh() {
    if (disposed || typeof observe !== 'function') return Promise.resolve();
    if (flight) return flight;
    const due = [];
    for (const [id, entry] of pending) {
      if (entry.expiresAt <= now()) { pending.delete(id); continue; }
      if (entry.nextAt <= now() && due.length < batchSize) { entry.nextAt = now() + intervalMs; due.push(entry); }
    }
    if (!due.length) return Promise.resolve();
    // Rotate inspected entries so a permanently unknown operation cannot starve
    // newer receipts when more than one batch remains unresolved.
    for (const entry of due) { pending.delete(entry.request.operationId); pending.set(entry.request.operationId, entry); }
    flight = Promise.all(due.map(async entry => {
      let proof;
      try { proof = await observe({ ...entry.request, observeOnly: true }); } catch { return; }
      if (disposed || pending.get(entry.request.operationId) !== entry || proof?.operationId !== entry.request.operationId ||
          !proof.ok || !['stopped', 'already-absent'].includes(proof.process) || proof.launchSettled !== true) return;
      const sessions = getSessions();
      const originalStillVisible = sessions.some(session => session.visiblePane === true && session.id === entry.request.id && session.launchToken === entry.request.launchToken);
      if (originalStillVisible) return;
      const receipt = structuredClone(entry.receipt);
      receipt.ok = true; receipt.status = 'closed'; delete receipt.error;
      Object.assign(receipt.close, { process: proof.process, launchSettled: true, verifiedAt: now(),
        inventoryRevision: Math.max(0, ...sessions.map(session => session.inventoryRevision || 0)) });
      if (entry.closeScope) Object.assign(receipt.close, require('./orchestratorCloseScope.cjs').remainingCloseScope(entry.closeScope, sessions));
      try {
        const published = await publish({ ...receipt, operationId: entry.request.operationId });
        if (published?.ok !== false && pending.get(entry.request.operationId) === entry) pending.delete(entry.request.operationId);
      } catch { /* Retain original operation for observation-only publication retry. */ }
    })).finally(() => { flight = undefined; });
    return flight;
  }
  return { track, refresh, dispose() { disposed = true; pending.clear(); }, size: () => pending.size };
}

module.exports = { createCloseReconciliation };
