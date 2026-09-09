"use strict";

// In-memory command delivery only. Readiness is observed, never inferred from
// silence or terminal output. Transport acceptance does not prove consumption.
function createOrchestratorDelivery({ getSession, write, writeBusyPrompt, reserveInput = () => {}, onBeforeWrite = () => {}, onUpdate = () => {}, now = Date.now, maxWaitMs = 120000, maxQueued = 50, maxConcurrentDeliveries = 4 } = {}) {
  const queued = new Map(), results = new Map(), locks = new Map();
  const inFlight = new Set(), pendingSubmissions = new Set(), activeWrites = new Set();
  const configuredCapacity = Number(maxConcurrentDeliveries);
  const capacity = Number.isFinite(configuredCapacity) ? Math.max(1, Math.floor(configuredCapacity) || 4) : 4;
  let disposed = false, scanning = false;
  const schedulePump = () => { if (!disposed) queueMicrotask(() => { void pump().catch(() => {}); }); };
  const key = s => JSON.stringify([s.id, s.generation]);
  const stamp = s => JSON.stringify([s.turnId, s.turnStartedAt, s.turnEndedAt]);
  const receipt = (a, status, ok, extra = {}) => ({ actionId: a.actionId, id: a.target?.id || a.id || a.targetId, generation: a.target?.generation ?? a.generation, ok, status, ...extra });
  function classify(s, a) {
    if (!s || s.generation !== (a.target?.generation ?? a.generation)) return "stale-generation";
    if (!require("./orchestratorLaunchers.cjs").routingBindingMatches(a.routingBinding, s)) return "conversation-changed";
    if (s.started === false || ["exited", "failed"].includes(s.processState) || s.status === "paused" || String(s.generation).startsWith("paused:")) return "not-running";
    if (s.launchState === "pending") return "unverified";
    if (s.provider === "terminal") return s.processState === "running" ? "ready" : "not-running";
    if (["exited", "failed"].includes(s.agentProcessState)) return "not-running";
    if (s.turnState === "waiting" || s.status === "waiting" || s.pendingInteraction) return "waiting";
    if (s.processState !== "running" || s.agentProcessState !== "running" || !Number.isSafeInteger(Number(s.agentPid)) || Number(s.agentPid) <= 0 || s.binding?.status === "ambiguous") return "unverified";
    if (s.childActivity || s.pendingInput || ["running", "busy"].includes(s.turnState)) return "busy";
    return ["idle", "completed", "response", "interrupted"].includes(s.turnState) ? "ready" : "unverified";
  }
  function blocked(s) {
    const lock = locks.get(key(s));
    if (!lock) return false;
    if (["running", "busy"].includes(s.turnState) || s.childActivity) lock.sawBusy = true;
    if (!lock.inFlight && (stamp(s) !== lock.stamp || (lock.sawBusy && ["idle", "completed", "response", "interrupted"].includes(s.turnState)))) { locks.delete(key(s)); return false; }
    return true;
  }
  function blockedDelivery(a, reason) {
    return receipt(a, "blocked", false, { reason, error: reason, delivery: "not-dispatched" });
  }
  function busyEligible(a, s) {
    return typeof writeBusyPrompt === 'function' && a.targetAvailability !== 'idle' &&
      require('./orchestratorBusyInput.cjs').isBusyPromptSubmission({ ...a, submit: true, promptSubmission: true }, s);
  }
  async function deliver(a, s, entry) {
    if (disposed || a.signal?.aborted) return receipt(a, "cancelled", false);
    const latest = getSession(s.id);
    if (classify(latest, a) === "conversation-changed") return blockedDelivery(a, "conversation-changed");
    const state = classify(latest, a);
    const busy = Boolean(entry && state === 'busy' && busyEligible(a, latest));
    if ((state !== 'ready' && !busy) || blocked(latest) || inFlight.has(key(latest)) || inFlight.size >= capacity) return null;
    const targetKey = key(latest);
    inFlight.add(targetKey);
    const agent = latest.provider !== "terminal";
    const lock = { stamp: stamp(latest), sawBusy: false, inFlight: true };
    if (agent) locks.set(key(latest), lock);
    let rollback, attempted = false;
    const transport = new AbortController();
    activeWrites.add(transport);
    const deliveryBaseline = { submittedAt: now(), kind: latest.provider === "terminal" ? "terminal" : latest.provider, turnId: latest.turnId, turnState: latest.turnState };
    try {
      if (busy) {
        // The native adapter owns observation, input leases and dispatch
        // attribution. Never use the idle writer or reserve its raw input.
        if (entry) entry.dispatched = true;
        attempted = true;
        let result = await writeBusyPrompt({ ...a, signal: AbortSignal.any([transport.signal, ...(a.signal ? [a.signal] : [])]) });
        if (!result || result.delivery !== 'not-dispatched' && ['write-failed', 'unconfirmed', 'uncertain'].includes(result.status)) result = { ...result, ok: false, status: 'unknown' };
        lock.inFlight = false;
        if (result.delivery === 'not-dispatched') locks.delete(targetKey);
        // Even a proven-unsent rejection ends this promotion. A later read or
        // turn completion must not silently retry a rejected/uncertain attempt.
        return receipt(a, result.status || 'unknown', Boolean(result.ok), { ...result, actionId: a.actionId });
      }
      rollback = reserveInput({ id: latest.id, generation: latest.generation, data: a.text + "\r" });
      if (disposed || a.signal?.aborted || (entry && queued.get(a.actionId) !== entry)) {
        locks.delete(key(latest));
        if (typeof rollback === "function") rollback();
        return receipt(a, "cancelled", false);
      }
      // Install actual dispatch attribution synchronously, before an immediate
      // provider event can arrive. This is preparation, not a delivery receipt.
      onBeforeWrite(receipt(a, 'unconfirmed', true, { deliveryBaseline, inputDisposition: 'submitted-when-ready' }));
      if (disposed || a.signal?.aborted || (entry && queued.get(a.actionId) !== entry)) {
        locks.delete(key(latest));
        if (typeof rollback === 'function') rollback();
        return receipt(a, 'cancelled', false, { delivery: 'not-dispatched' });
      }
      if (!require("./orchestratorLaunchers.cjs").routingBindingMatches(a.routingBinding, getSession(latest.id))) {
        locks.delete(key(latest));
        if (typeof rollback === "function") rollback();
        return blockedDelivery(a, "conversation-changed");
      }
      // From this boundary cancellation cannot retract the transport call.
      // Keep the entry until its actual acknowledgment (or unknown) arrives.
      if (entry) entry.dispatched = true;
      attempted = true;
      let result = await write({ id: latest.id, generation: latest.generation, actionId: a.actionId, requestId: a.requestId, signal: AbortSignal.any([transport.signal, ...(a.signal ? [a.signal] : [])]), kind: "input", data: a.text + "\r", promptText: a.text,
        ...(agent ? { expectedAgentPid: latest.agentPid, recipientEvidence: { generation: latest.generation, pid: latest.agentPid, state: "idle", observedAt: now() } } : {}) });
      // A failed write acknowledgment cannot prove that zero bytes reached the
      // PTY. Preserve the reservation and dedup lock unless transport says so.
      if (result?.delivery !== 'not-dispatched' && ['write-failed', 'unconfirmed', 'uncertain'].includes(result?.status)) result = { ...result, ok: false, status: 'unknown' };
      lock.inFlight = false;
      if (result?.ok === false && result.status && result.status !== "unknown") {
        locks.delete(key(latest));
        if (typeof rollback === "function") rollback();
        if (["needs-staging", "input-buffer-occupied", "input-surface-unverified", "recipient-unavailable"].includes(result?.status)) {
          if (!entry?.cancelRequested) return blockedDelivery(a, result.error || result.status);
          return receipt(a, result.status, false, { ...result, delivery: "not-dispatched" });
        }
      }
      const submitted = result?.delivery !== 'not-dispatched' && (result?.ok || !result?.status || ['unknown', 'unconfirmed', 'uncertain'].includes(result.status));
      return receipt(a, result?.status || "unknown", Boolean(result?.ok), { ...result, deliveryBaseline, ...(submitted && { inputDisposition: 'submitted-when-ready' }) });
    } catch (error) {
      lock.inFlight = false;
      if (!attempted) {
        locks.delete(key(latest));
        try { if (typeof rollback === 'function') rollback(); } catch { /* No transport was attempted. */ }
        return receipt(a, 'rejected', false, { error: String(error?.message || error), delivery: 'not-dispatched' });
      }
      return receipt(a, "unknown", false, { error: String(error?.message || error), deliveryBaseline, inputDisposition: busy ? 'submitted-while-running' : 'submitted-when-ready' });
    } finally {
      activeWrites.delete(transport);
      inFlight.delete(targetKey);
      schedulePump();
    }
  }
  function enqueue(a) {
    if (disposed || a.signal?.aborted) return receipt(a, "cancelled", false);
    if (a.targetAvailability === 'idle') return blockedDelivery(a, 'The selected terminal is no longer available for immediate input. Select an idle terminal again.');
    if (queued.size >= maxQueued) return blockedDelivery(a, "Delivery queue is full. Wait for pending work, then try again.");
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
    pendingSubmissions.add(a.actionId);
    const work = Promise.resolve().then(async () => {
      if (disposed || a.signal?.aborted) return receipt(a, "cancelled", false);
      if (typeof a.text !== "string" || !a.text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(a.text)) return receipt(a, "invalid-action", false, { error: "Prompt contains unsupported control characters or is empty." });
      const s = getSession(a.target?.id || a.id || a.targetId), state = classify(s, a);
      if (["stale-generation", "not-running", "conversation-changed"].includes(state)) return receipt(a, state, false, { delivery: "not-dispatched" });
      if (["waiting", "unverified"].includes(state)) return blockedDelivery(a, state === "waiting" ? "Answer the pending request before sending." : "Agent input readiness is not observed. Read the terminal before operating its current screen.");
      const earlier = [...queued.values()].some(e => (e.action.target?.id || e.action.id || e.action.targetId) === s.id && (e.action.target?.generation ?? e.action.generation) === s.generation);
      if (state === "busy" || blocked(s) || earlier || inFlight.has(key(s)) || inFlight.size >= capacity) return enqueue(a);
      return await deliver(a, s) || enqueue(a);
    }).finally(() => pendingSubmissions.delete(a.actionId));
    results.set(a.actionId, work);
    if (results.size > 500) for (const id of results.keys()) { if (!queued.has(id) && !pendingSubmissions.has(id) && id !== a.actionId) { results.delete(id); break; } }
    return work;
  }
  async function pump() {
    if (scanning || disposed) return;
    scanning = true;
    const admitted = [], preceding = new Set();
    try {
      for (const entry of [...queued.values()]) {
        const a = entry.action;
        if (!queued.has(a.actionId)) continue;
        const targetKey = key({ id: a.target?.id || a.id || a.targetId, generation: a.target?.generation ?? a.generation });
        const earlier = preceding.has(targetKey);
        preceding.add(targetKey);
        // In-flight work owns its actual acknowledgment even after abort,
        // expiry or a generation change; never classify it as an unsent entry.
        if (entry.inFlight) continue;
        const s = getSession(a.target?.id || a.id || a.targetId), state = classify(s, a);
        if (a.signal?.aborted || ["stale-generation", "not-running", "conversation-changed"].includes(state)) { finish(entry, receipt(a, a.signal?.aborted ? "cancelled" : state, false, { delivery: "not-dispatched" })); continue; }
        // Observed long-running work is a valid reason to keep an accepted
        // prompt queued. Bound lost readiness, not the duration of agent work.
        if (state === "busy" && s.observation === "observed" && (['running', 'busy', 'starting'].includes(s.turnState) || s.childActivity)) entry.expiresAt = now() + maxWaitMs;
        const observedReady = state === 'ready' && s.observation === 'observed' && !blocked(s);
        if ((now() >= entry.expiresAt && !observedReady) || ["waiting", "unverified"].includes(state)) { finish(entry, blockedDelivery(a, "Delivery readiness was not confirmed. Read the terminal before trying again.")); continue; }
        if (state === "busy" && !busyEligible(a, s)) { blocked(s); continue; }
        if (earlier || blocked(s) || inFlight.has(targetKey) || inFlight.size >= capacity) continue;
        entry.inFlight = true;
        const work = deliver(a, s, entry).then(result => { if (result) finish(entry, result); }).finally(() => {
          entry.inFlight = false;
          schedulePump();
        });
        admitted.push(work);
      }
    } finally { scanning = false; }
    // Await this scan's admitted batch, not a global pump lock. Other scans
    // can start newly eligible targets while any acknowledgment is pending.
    await Promise.all(admitted);
  }
  function cancel(reason = "Cancelled before delivery.") { for (const transport of activeWrites) transport.abort(); for (const entry of [...queued.values()]) { entry.cancelRequested = true; if (!entry.dispatched) finish(entry, receipt(entry.action, "cancelled", false, { error: reason })); } }
  function forget(id, generation) { for (const entry of [...queued.values()]) if (!entry.dispatched && (entry.action.target?.id || entry.action.id || entry.action.targetId) === id && (entry.action.target?.generation ?? entry.action.generation) === generation) finish(entry, receipt(entry.action, "stale-generation", false)); locks.delete(key({ id, generation })); }
  return { submit, pump, observe: pump, cancel, forget, dispose() { disposed = true; cancel("Application closed."); for (const entry of [...queued.values()]) finish(entry, receipt(entry.action, "unknown", false, { error: "Application closed before delivery acknowledgment." })); locks.clear(); results.clear(); } };
}
module.exports = { createOrchestratorDelivery };
