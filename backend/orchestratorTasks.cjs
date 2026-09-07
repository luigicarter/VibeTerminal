'use strict';
const { randomUUID } = require('node:crypto');

// FIFO capacity limits. Aborted waiters leave the queue without taking a slot.
function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  function drain() {
    while (active < limit && queue.length) {
      const item = queue.shift();
      item.signal?.removeEventListener('abort', item.abort);
      if (item.signal?.aborted) { item.reject(new Error('Cancelled.')); continue; }
      active++;
      let released = false;
      item.resolve(() => { if (!released) { released = true; active--; drain(); } });
    }
  }
  return { acquire(signal) { return new Promise((resolve, reject) => {
    const item = { signal, resolve, reject, abort: () => { const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1); reject(new Error('Cancelled.')); } };
    if (signal?.aborted) return reject(new Error('Cancelled.'));
    signal?.addEventListener('abort', item.abort, { once: true }); queue.push(item); drain();
  }); }, async run(signal, fn) { const release = await this.acquire(signal); try { return await fn(); } finally { release(); } } };
}

const terminalStates = new Set(['finished', 'failed', 'cancelled', 'paused']);
const completedStates = new Set(['completed', 'complete', 'finished', 'succeeded']);
const failedStates = new Set(['failed', 'cancelled', 'interrupted']);
function createTaskScheduler({ now = Date.now, onChange = () => {}, restored = [] } = {}) {
  const jobs = new Map();
  let sequence = 0, currentSessions = [];
  const listeners = new Set();
  function changed() { onChange(); for (const listener of [...listeners]) listener(); }
  function project(job) { return structuredClone(job.task); }
  for (const old of restored.slice(-200)) {
    if (!old?.requestId) continue;
    const task = { ...old, status: terminalStates.has(old.status) ? old.status : 'paused' };
    sequence = Math.max(sequence, Number(task.sequence) || 0);
    jobs.set(task.requestId, { task, restored: true, waits: [], lanes: [] });
  }
  function update(job, patch) { Object.assign(job.task, patch, { updatedAt: now() }); changed(); }
  const evictable = job => terminalStates.has(job.task.status) && !job.waits.some(wait => !wait.done && wait.delivered && !wait.nativeShell) && ![...jobs.values()].some(other => other.task.dependsOn.includes(job.task.requestId));
  function hasCapacity() { return jobs.size < 200 || [...jobs.values()].some(evictable); }
  function create(input) {
    const id = randomUUID();
    const task = { id, requestId: id, sequence: ++sequence, text: input.text, origin: input.origin, status: 'queued', label: input.text.slice(0, 100), targetIds: [], targets: [], dependsOn: [], ...(input.replyToRequestId && { replyToRequestId: input.replyToRequestId }), createdAt: now(), updatedAt: now() };
    const job = { input: structuredClone(input), task, controller: new AbortController(), waits: [], lanes: [], context: null, result: null };
    jobs.set(id, job);
    while (jobs.size > 200) { const oldest = [...jobs.values()].find(evictable); if (!oldest) break; jobs.delete(oldest.task.requestId); }
    changed(); return job;
  }
  // Plain shells provide ordered transport, not a managed task lifecycle. Their
  // unknown result still blocks explicit dependencies, but cannot lease the
  // entire project forever after an echo or other completed shell command.
  function occupiedLanes(job) { return job.executionDone ? job.lanes.filter(lane => job.waits.some(wait => !wait.done && wait.delivered && !wait.nativeShell && (!lane.targetIds || lane.targetIds.includes(wait.targetId)))) : job.lanes; }
  // Operators serialize their control loops, but must be able to answer or
  // interrupt work a previous loop already dispatched. Result dependencies
  // remain a separate prerequisite below; ordinary sends retain their leases.
  function conflict(a, b) { if (b.executionDone && b.waits.length && b.waits.every(wait => wait.nativeShell) && a.task.targetIds.length === 1 && b.task.targetIds.length === 1 && a.task.targetIds[0] === b.task.targetIds[0]) return false; return a.lanes.some(lane => !(lane.operator && lane.key.startsWith('terminal:') && b.executionDone) && occupiedLanes(b).some(other => lane.key === other.key && !(lane.readOnly && other.readOnly))); }
  async function ready(job) {
    const signal = job.controller.signal;
    await new Promise((resolve, reject) => {
      const finish = error => { listeners.delete(check); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const abort = () => finish(new Error('Cancelled.'));
      const check = () => {
        if (signal.aborted) return abort();
        for (const id of job.task.dependsOn) {
          const prior = jobs.get(id);
          if (!prior || ['failed', 'cancelled', 'paused'].includes(prior.task.status)) { finish(new Error('A prerequisite did not finish successfully.')); update(job, { status: 'paused', error: 'A prerequisite did not finish successfully. Submit a new instruction to continue.' }); return; }
          if (prior.task.status !== 'finished') return;
        }
        for (const lane of job.lanes.filter(lane => lane.key.startsWith('terminal:') && !lane.operator)) { const session = currentSessions.find(session => lane.targetIds?.includes(session.id)); if (session && ['running', 'busy', 'starting'].includes(session.turnState) && session.kind !== 'terminal') return; }
        for (const prior of jobs.values()) if (prior.task.sequence < job.task.sequence && ((!terminalStates.has(prior.task.status) && prior.task.status !== 'needs-answer') || prior.waits.some(wait => !wait.done && wait.delivered)) && conflict(job, prior)) return;
        finish();
      };
      listeners.add(check); signal.addEventListener('abort', abort, { once: true }); check();
    });
  }
  function track(job, action, result, baseline) {
    const nativeTask = action.operator === true && action.kind === 'terminal_interact' && action.inputPurpose === 'task' && (action.submit === true || action.keys?.some(key => ['enter', 'ctrl-m', 'ctrl-j'].includes(key)) || ['click', 'up'].includes(action.mouse?.action));
    if (!(action.kind === 'send_prompt' || nativeTask || (action.kind === 'create_session' && action.prompt))) return;
    let wait = job.waits.find(wait => wait.actionId === action.actionId);
    // A scoped operator may recover a pre-write rejection after reading again.
    // Such an attempt has no terminal result to await or failed turn to retain.
    if (action.operator && result.delivery === 'not-dispatched') {
      if (wait) job.waits.splice(job.waits.indexOf(wait), 1);
      return;
    }
    const rejected = result.delivery === 'not-dispatched' || ['cancelled', 'rejected', 'stale', 'stale-generation', 'not-running'].includes(result.status) || (result.ok === false && !result.status);
    if (!wait && rejected) return;
    if (!wait) {
      wait = { actionId: action.actionId, operator: action.operator === true, targetId: action.targetId || result.target?.id || result.id, generation: action.generation || result.target?.generation || result.generation, submittedAt: baseline?.submittedAt ?? now(), nativeShell: baseline?.kind === 'terminal', baselineTurnId: baseline?.turnId, baselineIdle: !['running', 'busy', 'starting'].includes(baseline?.turnState), done: false };
      job.waits.push(wait);
    }
    wait.targetId ||= result.target?.id || result.id; wait.generation ||= result.target?.generation || result.generation;
    wait.turnId ||= result.turnId; wait.staged = result.status === 'staged'; wait.delivered = !['queued', 'staged'].includes(result.status);
    if (rejected) { wait.done = true; wait.failed = true; wait.delivered = false; wait.error = result.error || result.reason; }
  }
  function reconcile(sessions) {
    currentSessions = sessions;
    let dirty = false;
    for (const job of jobs.values()) {
      if (job.restored) continue;
      for (const wait of job.waits.filter(wait => !wait.done)) {
        if (!wait.targetId) continue;
        const session = sessions.find(session => session.id === wait.targetId);
        if (!session || session.generation !== wait.generation) { wait.done = true; wait.failed = true; wait.error = 'The terminal changed before its result could be verified.'; dirty = true; continue; }
        if (!wait.delivered || wait.nativeShell) continue;
        const exactAction = Boolean(wait.actionId) && (session.completedActionId === wait.actionId || session.actionId === wait.actionId);
        if (session.completionAttribution === 'ambiguous') continue;
        if (!wait.turnId && wait.delivered && (exactAction || (wait.baselineIdle && session.turnId && session.turnId !== wait.baselineTurnId && Number(session.turnStartedAt) >= wait.submittedAt))) wait.turnId = session.completedTurnId || session.turnId;
        const exactTurn = wait.turnId && (session.completedTurnId === wait.turnId || session.turnId === wait.turnId);
        if ((exactTurn || exactAction) && (completedStates.has(session.turnState) || failedStates.has(session.turnState))) { wait.done = true; wait.failed = failedStates.has(session.turnState); dirty = true; }
      }
      if (job.executionDone && job.waits.length && job.waits.every(wait => wait.done) && job.task.status === 'waiting-results') {
        const failed = job.waits.find(wait => wait.failed);
        Object.assign(job.task, { status: failed ? 'failed' : 'finished', updatedAt: now(), ...(failed && { error: failed.error || 'The terminal task did not finish successfully.' }) }); dirty = true;
      }
      if (job.executionDone && (job.task.status === 'waiting-results' || job.stagedPause)) {
        const outstanding = job.waits.filter(wait => !wait.done);
        const stagedOnly = outstanding.length > 0 && outstanding.every(wait => wait.staged);
        const waitingReason = stagedOnly ? 'Prompt saved as a draft, not sent. Open the terminal to review and send it.'
          : outstanding.some(wait => wait.staged) ? 'Some prompts were saved as drafts, not sent. Waiting for the other terminal results.'
            : outstanding.length ? 'Waiting for a verified terminal result.' : undefined;
        const status = stagedOnly ? 'paused' : outstanding.length ? 'waiting-results' : job.waits.some(wait => wait.failed) ? 'failed' : 'finished';
        job.stagedPause = stagedOnly;
        if (job.task.status !== status || job.task.waitingReason !== waitingReason) {
          Object.assign(job.task, { status, waitingReason, updatedAt: now() }); dirty = true;
        }
      }
    }
    if (dirty) changed(); else for (const listener of [...listeners]) listener();
  }
  function delivery(result) {
    for (const job of jobs.values()) {
      const wait = job.waits.find(wait => wait.actionId === result.actionId);
      if (!wait) continue;
      if (wait.operator && result.delivery === 'not-dispatched') { job.waits.splice(job.waits.indexOf(wait), 1); continue; }
      if (result.delivery === 'not-dispatched' || ['cancelled', 'rejected', 'stale', 'stale-generation', 'not-running'].includes(result.status) || (result.ok === false && !result.status)) { wait.done = true; wait.failed = true; wait.delivered = false; wait.error = result.error || result.reason; }
      else { wait.staged = result.status === 'staged'; wait.delivered = !['queued', 'staged'].includes(result.status); if (result.turnId) wait.turnId = result.turnId; }
    }
  }
  function cancel(requestId) {
    const selected = requestId ? [jobs.get(requestId)].filter(Boolean) : [...jobs.values()];
    for (const job of selected) if (!terminalStates.has(job.task.status)) { job.controller?.abort(); Object.assign(job.task, { status: 'cancelled', updatedAt: now(), waitingReason: job.waits.some(wait => !wait.done && wait.delivered) ? 'Request cancelled; previously sent terminal work may still be running.' : undefined }); }
    changed(); return { ok: selected.length > 0 || !requestId, status: 'cancelled' };
  }
  return { create, hasCapacity, update, ready, track, reconcile, delivery, cancel, jobs, get: id => jobs.get(id), snapshot: () => [...jobs.values()].map(project), busy: () => [...jobs.values()].some(job => ['queued', 'routing', 'running'].includes(job.task.status)), clear() { for (const [id, job] of jobs) if (terminalStates.has(job.task.status) && !job.waits.some(wait => !wait.done && wait.delivered && !wait.nativeShell)) jobs.delete(id); changed(); } };
}
module.exports = { createTaskScheduler, createSemaphore };
