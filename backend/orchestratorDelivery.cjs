"use strict";

// In-memory command delivery only. Readiness is observed, never inferred from
// silence or terminal output. Transport acceptance does not prove consumption.
function createOrchestratorDelivery({ getSession, write, stage, reserveInput = () => {}, onUpdate = () => {}, now = Date.now, maxWaitMs = 120000, maxQueued = 50 } = {}) {
  const queued = new Map(), results = new Map(), locks = new Map();
  let disposed = false, pumping = false;
  const key = s => JSON.stringify([s.id, s.generation]);
  const stamp = s => JSON.stringify([s.turnId, s.turnStartedAt, s.turnEndedAt]);
  const receipt = (a, status, ok, extra = {}) => ({ actionId: a.actionId, id: a.target?.id || a.id || a.targetId, generation: a.target?.generation || a.generation, ok, status, ...extra });
  function classify(s, a) {
    if (!s || s.generation !== (a.target?.generation || a.generation)) return "stale-generation";
    if (s.started === false || ["exited", "failed"].includes(s.processState) || s.status === "paused" || String(s.generation).startsWith("paused:")) return "not-running";
    if (s.provider === "terminal") return s.processState === "running" ? "ready" : "not-running";
    if (["exited", "failed"].includes(s.agentProcessState)) return "not-running";
    if (s.turnState === "waiting" || s.status === "waiting" || s.pendingInteraction) return "waiting";
    if (s.processState !== "running" || s.agentProcessState !== "running" || !Number.isSafeInteger(Number(s.agentPid)) || Number(s.agentPid) <= 0 || s.binding?.status === "ambiguous") return "unverified";
    if (s.childActivity || s.pendingInput || s.turnState === "running") return "busy";
    return ["idle", "completed", "response", "interrupted"].includes(s.turnState) ? "ready" : "unverified";
  }
  function blocked(s) {
    const lock = locks.get(key(s));
    if (!lock) return false;
    if (s.turnState === "running" || s.childActivity) lock.sawBusy = true;
    if (!lock.inFlight && (stamp(s) !== lock.stamp || (lock.sawBusy && ["idle", "completed", "response", "interrupted"].includes(s.turnState)))) { locks.delete(key(s)); return false; }
    return true;
  }
  async function staged(a, reason) {
    if (disposed || a.signal?.aborted) return receipt(a, "cancelled", false);
    try {
      const result = await stage(a, reason);
      return receipt(a, result?.ok ? "staged" : result?.status || "failed", Boolean(result?.ok), { ...result, reason });
    } catch (error) { return receipt(a, "failed", false, { error: String(error?.message || error), reason }); }
  }
  async function deliver(a, s, entry) {
    if (disposed || a.signal?.aborted) return receipt(a, "cancelled", false);
    const latest = getSession(s.id);
    if (classify(latest, a) !== "ready" || blocked(latest)) return null;
    const agent = latest.provider !== "terminal";
    const lock = { stamp: stamp(latest), sawBusy: false, inFlight: true };
    if (agent) locks.set(key(latest), lock);
    let rollback;
    try {
      rollback = reserveInput({ id: latest.id, generation: latest.generation, data: a.text + "\r" });
      if (disposed || a.signal?.aborted || (entry && queued.get(a.actionId) !== entry)) {
        locks.delete(key(latest));
        if (typeof rollback === "function") rollback();
        return receipt(a, "cancelled", false);
      }
      // From this boundary cancellation cannot retract the transport call.
      // Keep the entry until its actual acknowledgment (or unknown) arrives.
      if (entry) entry.dispatched = true;
      const result = await write({ id: latest.id, generation: latest.generation, actionId: a.actionId, kind: "input", data: a.text + "\r", promptText: a.text,
        ...(agent ? { expectedAgentPid: latest.agentPid, recipientEvidence: { generation: latest.generation, pid: latest.agentPid, state: "idle", observedAt: now() } } : {}) });
      lock.inFlight = false;
      if (result?.ok === false && result.status && result.status !== "unknown") {
        locks.delete(key(latest));
        if (typeof rollback === "function") rollback();
        if (!entry?.cancelRequested && ["needs-staging", "input-buffer-occupied", "input-surface-unverified", "recipient-unavailable"].includes(result?.status)) return staged(a, result.error || result.status);
      }
      return receipt(a, result?.status || "unknown", Boolean(result?.ok), result || {});
    } catch (error) { lock.inFlight = false; return receipt(a, "unknown", false, { error: String(error?.message || error) }); }
  }
  function enqueue(a) {
    if (disposed || a.signal?.aborted) return receipt(a, "cancelled", false);
    if (queued.size >= maxQueued) return staged(a, "Delivery queue is full.");
    const entry = { action: a, expiresAt: now() + maxWaitMs };
    entry.abort = () => { entry.cancelRequested = true; if (!entry.dispatched) finish(entry, receipt(a, "cancelled", false)); };
    queued.set(a.actionId, entry); a.signal?.addEventListener("abort", entry.abort, { once: true });
    return receipt(a, "queued", true, { text: "Prompt is waiting for this agent to become ready." });
  }
  function finish(entry, result) {
    if (queued.get(entry.action.actionId) !== entry) return;
    queued.delete(entry.action.actionId); entry.action.signal?.removeEventListener("abort", entry.abort);
    results.set(entry.action.actionId, Promise.resolve(result));
    try { Promise.resolve(onUpdate(result)).catch(() => {}); } catch { /* Receipt publication cannot retry a write. */ }
  }
  function submit(a) {
    if (!a.actionId) return Promise.resolve(receipt(a, "invalid-action", false, { error: "An action ID is required." }));
    if (results.has(a.actionId)) return results.get(a.actionId);
    const work = Promise.resolve().then(async () => {
      if (disposed || a.signal?.aborted) return receipt(a, "cancelled", false);
      if (typeof a.text !== "string" || !a.text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(a.text)) return receipt(a, "invalid-action", false, { error: "Prompt contains unsupported control characters or is empty." });
      const s = getSession(a.target?.id || a.id || a.targetId), state = classify(s, a);
      if (["stale-generation", "not-running"].includes(state)) return receipt(a, state, false);
      if (["waiting", "unverified"].includes(state)) return staged(a, state === "waiting" ? "Answer the pending request before sending." : "Agent input readiness is not observed.");
      const earlier = [...queued.values()].some(e => (e.action.target?.id || e.action.id || e.action.targetId) === s.id && (e.action.target?.generation || e.action.generation) === s.generation);
      if (state === "busy" || blocked(s) || earlier) return enqueue(a);
      return await deliver(a, s) || enqueue(a);
    });
    results.set(a.actionId, work);
    if (results.size > 500) for (const id of results.keys()) { if (!queued.has(id) && id !== a.actionId) { results.delete(id); break; } }
    return work;
  }
  async function pump() {
    if (pumping || disposed) return;
    pumping = true;
    try {
      for (const entry of [...queued.values()]) {
        const a = entry.action;
        if (!queued.has(a.actionId)) continue;
        const s = getSession(a.target?.id || a.id || a.targetId), state = classify(s, a);
        if (a.signal?.aborted || ["stale-generation", "not-running"].includes(state)) { finish(entry, receipt(a, a.signal?.aborted ? "cancelled" : state, false)); continue; }
        if (now() >= entry.expiresAt || ["waiting", "unverified"].includes(state)) { finish(entry, await staged(a, "Delivery readiness was not confirmed; prompt preserved as a draft.")); continue; }
        if (state === "busy") { blocked(s); continue; }
        if (blocked(s)) continue;
        const result = await deliver(a, s, entry);
        if (result) finish(entry, result);
      }
    } finally { pumping = false; }
  }
  function cancel(reason = "Cancelled before delivery.") { for (const entry of [...queued.values()]) { entry.cancelRequested = true; if (!entry.dispatched) finish(entry, receipt(entry.action, "cancelled", false, { error: reason })); } }
  function forget(id, generation) { for (const entry of [...queued.values()]) if (!entry.dispatched && (entry.action.target?.id || entry.action.id || entry.action.targetId) === id && (entry.action.target?.generation || entry.action.generation) === generation) finish(entry, receipt(entry.action, "stale-generation", false)); locks.delete(key({ id, generation })); }
  return { submit, pump, observe: pump, cancel, forget, dispose() { disposed = true; cancel("Application closed."); for (const entry of [...queued.values()]) finish(entry, receipt(entry.action, "unknown", false, { error: "Application closed before delivery acknowledgment." })); locks.clear(); results.clear(); } };
}
module.exports = { createOrchestratorDelivery };
