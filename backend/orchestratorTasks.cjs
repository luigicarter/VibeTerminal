'use strict';
const { randomUUID } = require('node:crypto');
const { sessionIdentity } = require('./orchestratorRouting.cjs');
const { routingBindingMatches } = require('./orchestratorLaunchers.cjs');
const { resultDependencyBlocker, transferredStatus } = require('./orchestratorContinuation.cjs');

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

const terminalStates = new Set(['finished', 'failed', 'cancelled', 'paused', 'continued']);
const completedStates = new Set(['completed', 'complete', 'finished', 'succeeded']);
const failedStates = new Set(['failed', 'cancelled', 'interrupted']);
// Result completion and workspace occupancy are separate: a failed foreground
// turn may leave observed detached workers editing the same workspace.
function hasWorkspaceOccupancy(wait, { includeQueued = false } = {}) {
  return !wait.nativeShell && !wait.staged && (wait.backgroundPending === true || !wait.done && (wait.delivered || includeQueued));
}
function createTaskScheduler({ now = Date.now, onChange = () => {}, restored = [] } = {}) {
  const jobs = new Map();
  let sequence = 0, currentSessions = [];
  const listeners = new Set();
  let batchDepth = 0, batchDirty = false;
  function changed() { if (batchDepth) { batchDirty = true; return; } onChange(); for (const listener of [...listeners]) listener(); }
  function batch(fn) {
    batchDepth++;
    try { const result = fn(); if (result && typeof result.then === 'function') throw new Error('Scheduler batches must be synchronous.'); batchDirty = true; return result; }
    finally { if (!--batchDepth && batchDirty) { batchDirty = false; changed(); } }
  }
  function project(job) { return structuredClone(job.task); }
  for (const old of restored.slice(-200)) {
    if (!old?.requestId) continue;
    const task = { ...old, status: terminalStates.has(old.status) ? old.status : 'paused' };
    sequence = Math.max(sequence, Number(task.sequence) || 0);
    jobs.set(task.requestId, { task, restored: true, waits: [], lanes: [] });
  }
  function update(job, patch) {
    Object.assign(job.task, patch, { updatedAt: now() });
    if (!patch.controlDisposition && job.task.controlDisposition !== 'transferred' && patch.status) {
      job.task.controlDisposition = patch.status === 'finished' ? 'completed' : patch.status === 'failed' ? 'failed' : patch.status === 'needs-answer' ? 'needs-answer' : 'active';
    }
    changed();
  }
  function deliveryEvidence(wait, result) {
    const baseline = result.deliveryBaseline;
    if (baseline) {
      wait.submittedAt = baseline.submittedAt;
      wait.baselineTurnId = baseline.turnId;
      wait.baselineIdle = !['running', 'busy', 'starting'].includes(baseline.turnState);
      wait.nativeShell = baseline.kind === 'terminal';
    } else if (wait.deliveryStatus === 'queued' && !['queued', 'staged'].includes(result.status)) {
      // The original observation predates the queued write. Only explicit
      // action/turn evidence can attribute a result without a fresh baseline.
      wait.baselineIdle = false;
    }
    wait.deliveryStatus = result.status || (result.ok ? 'acknowledged' : 'unknown');
    if (result.status === 'staged' && typeof result.reason === 'string') wait.deliveryReason = result.reason;
    else delete wait.deliveryReason;
    if (['queued', 'staged'].includes(result.status) || result.delivery === 'not-dispatched') {
      delete wait.inputDisposition;
    } else if (['submitted-while-running', 'submitted-when-ready'].includes(result.inputDisposition)) {
      wait.inputDisposition = result.inputDisposition;
      if (result.inputDisposition === 'submitted-while-running') {
        wait.baselineIdle = false;
        if (wait.turnId === wait.baselineTurnId) wait.turnId = undefined;
      }
    }
  }
  const eligibleResultTurn = (wait, turnId) => wait.inputDisposition !== 'submitted-while-running'
    || Boolean(wait.baselineTurnId && turnId && turnId !== wait.baselineTurnId);
  function liveRequestOwners() {
    // Retain live execution state and prerequisite evidence through clearing or
    // eviction. Historical dependency chains alone must not pin the full store.
    const protectedIds = new Set(), pending = [];
    const sources = job => [job.context?.pendingCommand?.requestId, job.task.continuedFromRequestId, ...(job.task.dependsOn || []),
      ...(job.intent?.commandPlan?.grants || []).map(grant => grant.sourceUserId)];
    for (const job of jobs.values()) {
      if (job.restored || job.controller?.signal.aborted || job.task.status === 'cancelled') continue;
      if (job.context?.pendingCommand || !terminalStates.has(job.task.status)) pending.push(job.task.requestId, ...sources(job));
    }
    while (pending.length) {
      const id = pending.pop(), owner = jobs.get(id);
      if (!id || !owner || owner.restored || protectedIds.has(id)) continue;
      protectedIds.add(id); pending.push(...sources(owner));
    }
    return protectedIds;
  }
  const evictable = (job, protectedIds) => terminalStates.has(job.task.status) && !protectedIds.has(job.task.requestId)
    && !job.waits.some(wait => hasWorkspaceOccupancy(wait));
  function hasCapacity() { const protectedIds = liveRequestOwners(); return jobs.size < 200 || [...jobs.values()].some(job => evictable(job, protectedIds)); }
  function create(input) {
    const id = randomUUID();
    const task = { id, requestId: id, sequence: ++sequence, text: input.text, origin: input.origin, status: 'queued', label: input.text.slice(0, 100), targetIds: [], targets: [], dependsOn: [], ...(input.replyToRequestId && { replyToRequestId: input.replyToRequestId }), createdAt: now(), updatedAt: now() };
    const job = { input: structuredClone(input), task, controller: new AbortController(), waits: [], lanes: [], context: null, result: null };
    jobs.set(id, job);
    const protectedIds = liveRequestOwners();
    while (jobs.size > 200) { const oldest = [...jobs.values()].find(job => evictable(job, protectedIds)); if (!oldest) break; jobs.delete(oldest.task.requestId); }
    changed(); return job;
  }
  // Plain shells provide ordered transport, not a managed task lifecycle. Their
  // unknown result still blocks explicit dependencies, but cannot lease the
  // entire project forever after an echo or other completed shell command.
  function occupiedLanes(job) {
    if (job.parkedForSubmission) return job.lanes.filter(lane => lane.key.startsWith('workspace:') && job.waits.some(wait =>
      hasWorkspaceOccupancy(wait, { includeQueued: !job.controller?.signal.aborted })
      && (!lane.targetIds || lane.targetIds.includes(wait.targetId))));
    if (job.executionDone) return job.lanes.filter(lane => job.waits.some(wait =>
      hasWorkspaceOccupancy(wait, { includeQueued: Boolean(lane.workItemId) && !job.controller?.signal.aborted })
      && (!lane.targetIds || lane.targetIds.includes(wait.targetId))));
    // An automatic job waiting on workspace ownership has not acquired the
    // terminal's control lane. Answers and interrupts must remain admissible.
    return job.lanes.filter(lane => !(lane.workItemId && lane.key.startsWith('terminal:') && !job.admitted));
  }
  function ownsWorkspace(workItemId, key) {
    return [...jobs.values()].some(owner => owner.lanes.some(lane => lane.key === key && lane.workItemId === workItemId
      && owner.waits.some(wait => hasWorkspaceOccupancy(wait) && (!lane.targetIds || lane.targetIds.includes(wait.targetId)))));
  }
  // Operators serialize their control loops, but must be able to answer or
  // interrupt work a previous loop already dispatched. Result dependencies
  // remain a separate prerequisite below; ordinary sends retain their leases.
  function conflictingLane(a, b) {
    if (b.executionDone && b.waits.length && b.waits.every(wait => wait.nativeShell) && a.task.targetIds.length === 1 && b.task.targetIds.length === 1 && a.task.targetIds[0] === b.task.targetIds[0]) return false;
    return a.lanes.find(lane => !(lane.operator && lane.key.startsWith('terminal:') && b.executionDone) && occupiedLanes(b).some(other => {
      if (lane.key !== other.key || (lane.readOnly && other.readOnly)) return false;
      if (lane.workItemId && lane.key.startsWith('workspace:')) {
        if (lane.workItemId === other.workItemId && (b.executionDone || b.parkedForSubmission)) return false;
        // Let the incumbent receive a compatible continuation even when an
        // unrelated mutation is queued behind it. Active loops never bypass.
        if (other.workItemId && !b.admitted && ownsWorkspace(lane.workItemId, lane.key)) return false;
      }
      return true;
    }));
  }
  const requestName = job => `request "${job.task.label || job.task.text || 'Earlier work'}"`;
  function targetName(id, owner) {
    const target = currentSessions.find(session => session.id === id) || owner?.task.targets?.find(target => target.id === id);
    return target?.name || id;
  }
  function ownerReason(owner, lane) {
    const occupied = occupiedLanes(owner).filter(other => other.key === lane.key);
    const ids = [...new Set(occupied.flatMap(other => other.targetIds || owner.task.targetIds))];
    const waits = owner.waits.filter(wait => ids.includes(wait.targetId) && hasWorkspaceOccupancy(wait, { includeQueued: true }));
    const location = lane.key.startsWith('workspace:') ? `workspace ${lane.key.slice('workspace:'.length)}` : 'terminal control';
    const targets = ids.length ? ` on ${ids.map(id => targetName(id, owner)).join(', ')}` : '';
    const state = waits.some(wait => wait.backgroundPending) ? 'background work is still active'
      : waits.some(wait => !wait.delivered) ? 'its prompt is still awaiting delivery'
        : waits.some(wait => wait.attributionAmbiguous) ? 'its result cannot yet be attributed to that request'
          : waits.some(wait => ['running', 'busy', 'starting'].includes(currentSessions.find(session => session.id === wait.targetId)?.turnState)) ? 'work is still active'
            : waits.length ? 'its result remains unverified'
              : owner.admitted ? 'its control loop is still active' : 'it is ahead in the queue';
    return `Waiting for ${requestName(owner)}${targets} in ${location}: ${state}.`;
  }
  function blockingReason(job, { dependenciesOnly = false } = {}) {
    for (const id of job.task.dependsOn) {
      const prior = jobs.get(id);
      if (!prior || prior.task.status !== 'finished') return prior
        ? `Waiting for prerequisite ${requestName(prior)}: ${prior.task.status === 'waiting-results' ? 'its result remains unverified' : prior.task.status}.`
        : 'Waiting for a prerequisite request: its result is unavailable.';
    }
    if (dependenciesOnly) return undefined;
    // Prefer the owning request over a generic busy-target message when both
    // gates apply. Neither gate's admission semantics change.
    for (const prior of jobs.values()) {
      if (prior === job || !(prior.task.sequence < job.task.sequence || prior.admitted)
        || !((!terminalStates.has(prior.task.status) && prior.task.status !== 'needs-answer') || prior.waits.some(wait => hasWorkspaceOccupancy(wait)))) continue;
      const lane = conflictingLane(job, prior);
      if (lane) return ownerReason(prior, lane);
    }
    for (const lane of job.lanes.filter(lane => lane.key.startsWith('terminal:') && !lane.operator)) {
      const session = currentSessions.find(session => lane.targetIds?.includes(session.id));
      if (session && (['running', 'busy', 'starting'].includes(session.turnState) || session.turnActive === true || session.childActivity) && session.kind !== 'terminal')
        return `Waiting for ${targetName(session.id, job)}: ${session.childActivity ? 'background work is still active' : 'the terminal is still active'}.`;
    }
    return undefined;
  }
  function setWaitingReason(job, waitingReason) {
    if (job.task.waitingReason !== waitingReason) update(job, { waitingReason });
  }
  async function ready(job, { dependenciesOnly = false, resumeSubmission = false } = {}) {
    const signal = job.controller.signal;
    await new Promise((resolve, reject) => {
      let settled = false, checking = false, recheckScheduled = false;
      const finish = error => { settled = true; listeners.delete(check); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const abort = () => finish(new Error('Cancelled.'));
      const check = () => {
        if (settled) return;
        if (checking) {
          // Publishing a blocker can synchronously publish its completion.
          // Coalesce nested notifications without losing that wakeup or
          // recursively re-entering admission while this check is unfinished.
          if (!recheckScheduled) {
            recheckScheduled = true;
            queueMicrotask(() => { recheckScheduled = false; check(); });
          }
          return;
        }
        checking = true;
        try {
        if (signal.aborted) return abort();
        for (const id of job.task.dependsOn) {
          const prior = jobs.get(id);
          const blocked = prior?.task.resultScopeTransferred || prior?.task.status === 'continued' ? resultDependencyBlocker(prior) : undefined;
          if (blocked) { finish(new Error(blocked)); update(job, { status: 'paused', error: blocked }); return; }
          if (!prior || ['failed', 'cancelled', 'paused'].includes(prior.task.status)) { finish(new Error('A prerequisite did not finish successfully.')); update(job, { status: 'paused', error: 'A prerequisite did not finish successfully. Submit a new instruction to continue.' }); return; }
          if (prior.task.status !== 'finished') { setWaitingReason(job, blockingReason(job, { dependenciesOnly })); return; }
        }
        // Routing may need to wait before creating a worker. This prerequisite
        // gate must not acquire execution lanes or mark the job admitted.
        if (dependenciesOnly) { finish(); setWaitingReason(job, undefined); return; }
        // A later control request may have passed this job while it waited for
        // workspace ownership. Its active loop still owns the terminal lane.
        const reason = blockingReason(job);
        if (reason) { setWaitingReason(job, reason); return; }
        if (resumeSubmission) job.parkedForSubmission = false;
        job.admitted = true;
        finish();
        setWaitingReason(job, undefined);
        } finally { checking = false; }
      };
      listeners.add(check); signal.addEventListener('abort', abort, { once: true }); check();
    });
  }
  async function waitForAssignmentSubmission(job, { targetId, workItemId, workspaceKey, readOnly = false }) {
    const lanes = job.lanes.filter(lane => lane.key.startsWith('workspace:') && lane.workItemId === workItemId && lane.targetIds?.includes(targetId));
    // An explicit target may not own a work item until its first authorized
    // submission. Compare its prospective workspace without minting ownership.
    if (!lanes.length && workspaceKey) lanes.push({ key: workspaceKey, workItemId, readOnly, targetIds: [targetId] });
    const conflicts = () => job.lanes.find(other => lanes.some(lane => other.key === lane.key && other.workItemId && other.workItemId !== workItemId
      && !(lane.readOnly && other.readOnly) && job.waits.some(wait => hasWorkspaceOccupancy(wait, { includeQueued: true })
        && other.targetIds?.includes(wait.targetId))));
    if (!lanes.length || !conflicts()) return false;
    const signal = job.controller.signal;
    job.parkedForSubmission = true;
    update(job, { status: 'queued', waitingReason: ownerReason({ ...job, lanes: [conflicts()] }, conflicts()) });
    try {
      await new Promise((resolve, reject) => {
        const finish = error => { listeners.delete(check); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
        const abort = () => finish(new Error('Cancelled.'));
        const check = () => {
          if (signal.aborted) { abort(); return; }
          const lane = conflicts();
          if (!lane) finish();
          else setWaitingReason(job, ownerReason({ ...job, lanes: [lane] }, lane));
        };
        listeners.add(check); signal.addEventListener('abort', abort, { once: true }); check();
      });
      // Controls admitted while parked keep their lanes until their own loop
      // finishes. Restore our control occupancy atomically with readmission.
      await ready(job, { resumeSubmission: true });
      update(job, { status: 'running', waitingReason: undefined });
      return true;
    } finally { job.parkedForSubmission = false; }
  }
  function track(job, action, result, baseline) {
    // Pane creation (including an explicitly saved initial draft) never submits
    // agent work. Retire provisional creation tracking rather than allowing a
    // later unrelated turn to satisfy it. A real send has its own action ID.
    if (action.kind === 'create_session') {
      job.waits = job.waits.filter(wait => wait.actionId !== action.actionId);
      return;
    }
    if (!require('./orchestratorSubmission.cjs').isTaskSubmission(action)) return;
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
      wait = { actionId: action.actionId, operator: action.operator === true, targetId: action.targetId || result.target?.id || result.id, generation: action.generation ?? result.target?.generation ?? result.generation, submittedAt: baseline?.submittedAt ?? now(), nativeShell: baseline?.kind === 'terminal', baselineTurnId: baseline?.turnId, baselineIdle: !['running', 'busy', 'starting'].includes(baseline?.turnState), nativeIdentity: sessionIdentity(baseline || {}), done: false };
      job.waits.push(wait);
    }
    wait.targetId ||= result.target?.id || result.id; wait.generation ??= result.target?.generation ?? result.generation;
    deliveryEvidence(wait, result);
    if (eligibleResultTurn(wait, result.turnId)) wait.turnId ||= result.turnId;
    wait.staged = result.status === 'staged'; wait.delivered = !['queued', 'staged'].includes(result.status);
    if (rejected) { wait.done = true; wait.failed = true; wait.delivered = false; wait.error = result.error || result.reason; }
  }
  function watch(job, action, session) {
    const target = action.watchTarget;
    const reject = (status, error) => ({ ok: false, status, error });
    if (!target || !session || session.id !== target.id || session.generation !== target.generation) return reject('blocked', 'The watched terminal changed. Identify it again.');
    const mode = action.watchUntil || 'completion';
    if (!['completion', 'ready'].includes(mode)) return reject('blocked', 'Invalid watch condition.');
    if (mode === 'completion' && (['terminal', 'shell'].includes(session.kind) || session.provider === 'terminal')) return reject('unverified', 'Shell task completion cannot be verified automatically.');
    if (mode === 'completion' && session.observation !== 'observed') return reject('unverified', 'The current task is not reliably observed.');
    if (mode === 'completion' && (!target.turnId || target.turnId !== session.turnId || (target.turnStartedAt !== undefined && target.turnStartedAt !== session.turnStartedAt))) return reject('unverified', 'The original task is no longer the observed current turn. Inspect its result.');
    if (mode === 'completion' && !['running', 'busy', 'waiting', 'completed', 'complete', 'finished', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(session.turnState)) return reject('unverified', 'No observable current task is available to watch.');
    if (mode === 'completion' && session.completionAttribution === 'ambiguous') return reject('unverified', 'The current task cannot be attributed reliably. Inspect the terminal.');
    const existing = job.waits.find(wait => wait.source === 'watch' && wait.actionId === action.actionId);
    if (existing) return { ok: true, status: existing.done ? existing.failed ? 'blocked' : mode === 'ready' ? 'ready' : 'already-completed' : 'watching' };
    const wait = { source: 'watch', watchUntil: mode, actionId: action.actionId, targetId: target.id, generation: target.generation, turnId: mode === 'completion' ? target.turnId : undefined, nativeIdentity: sessionIdentity(session), submittedAt: now(), baselineIdle: false, nativeShell: false, delivered: true, deliveryStatus: 'watching', done: false };
    job.waits.push(wait);
    reconcile([session], { partial: true });
    return { ok: !wait.failed, status: wait.done ? wait.failed ? 'blocked' : mode === 'ready' ? 'ready' : 'already-completed' : 'watching', targetId: target.id, generation: target.generation, turnId: wait.turnId, ...(wait.error && { error: wait.error }) };
  }
  function reconcile(sessions, { partial = false } = {}) {
    if (!partial) currentSessions = sessions;
    let dirty = false;
    for (const job of jobs.values()) {
      if (job.restored) continue;
      for (const wait of job.waits.filter(wait => !wait.done || wait.backgroundPending)) {
        if (!wait.targetId) continue;
        const session = sessions.find(session => session.id === wait.targetId);
        // Event snapshots preserve a short-lived turn end without replacing
        // the full readiness inventory or implying unrelated panes vanished.
        if (partial && (!session || session.generation !== wait.generation)) continue;
        if (!session || session.generation !== wait.generation) {
          if (!wait.done) { wait.done = true; wait.failed = true; wait.error = 'The terminal changed before its result could be verified.'; }
          wait.backgroundPending = false; dirty = true; continue;
        }
        if (!wait.delivered || wait.nativeShell) continue;
        const stopped = ['exited', 'failed'].includes(session.processState) || ['exited', 'failed'].includes(session.agentProcessState) || ['closed', 'exited'].includes(session.status);
        const failStopped = () => {
          if (!stopped || wait.done) return;
          wait.done = true; wait.failed = true;
          wait.error = 'The agent stopped before this task result could be verified. Completion remains unverified.';
          dirty = true;
        };
        // A native /new or headless host session switch can keep the pane and
        // generation alive. Its next turn cannot complete the old conversation's
        // task. Missing identity stays uncertain; it does not authorize rebinding.
        const native = sessionIdentity(session), expected = wait.nativeIdentity || {};
        const known = Object.fromEntries(Object.entries(expected).filter(([key, value]) => value && native[key]));
        if (!routingBindingMatches({ target: { id: wait.targetId, generation: wait.generation }, nativeIdentity: known }, session)) {
          wait.done = true; wait.failed = true; wait.error = 'The native conversation changed before this task result could be verified.'; dirty = true; continue;
        }
        const identityMissing = Object.entries(expected).some(([key, value]) => value && !native[key]);
        if (identityMissing) {
          if (!wait.attributionAmbiguous) { wait.attributionAmbiguous = true; dirty = true; }
          failStopped(); continue;
        }
        if (!expected.id && native.id) { wait.nativeIdentity = { ...expected, ...native }; dirty = true; }
        const backgroundPending = wait.source !== 'watch' && (Boolean(session.childActivity)
          || Boolean(wait.backgroundPending) && (session.observation !== 'observed' || session.binding?.status === 'ambiguous'));
        if (wait.backgroundPending !== backgroundPending) { wait.backgroundPending = backgroundPending; dirty = true; }
        // A completed failure stays a failure. Only its independent occupancy
        // latch remains live until the same source reports no detached work.
        if (wait.done) continue;
        // Readiness is observable even when overlapping input prevents us from
        // attributing the completed work to one request.
        const readinessWatch = wait.source === 'watch' && wait.watchUntil === 'ready';
        const ambiguous = !readinessWatch && (session.completionAttribution === 'ambiguous' || (wait.source === 'watch' && wait.watchUntil === 'completion' && Boolean(session.turnId) && session.turnId !== wait.turnId));
        if (wait.attributionAmbiguous !== ambiguous) { wait.attributionAmbiguous = ambiguous; dirty = true; }
        if (ambiguous) { failStopped(); continue; }
        if (readinessWatch) {
          if (wait.observedState !== session.turnState) { wait.observedState = session.turnState; dirty = true; }
          const shell = ['terminal', 'shell'].includes(session.kind) || session.provider === 'terminal';
          const stopped = session.started === false || ['exited', 'failed'].includes(session.processState) || !shell && ['exited', 'failed'].includes(session.agentProcessState) || ['paused', 'closed', 'exited', 'failed'].includes(session.status);
          // Session metadata can announce an idle composer before the launch
          // acknowledgment arrives. Contradictory startup evidence still wins.
          const processUnready = session.processState !== undefined && session.processState !== 'running'
            || !shell && session.agentProcessState !== undefined && session.agentProcessState !== 'running';
          const starting = session.launchState === 'pending' || session.status === 'starting' || session.engineReady === false;
          // Interaction evidence can outlive or arrive separately from the
          // foreground turn state. An idle/completed turn cannot clear it.
          const needsInput = session.status === 'waiting' || session.pendingInteraction || ['question', 'approval'].includes(session.attention?.reason);
          const ready = !stopped && !starting && !processUnready && !needsInput && session.observation === 'observed' && ['idle', 'completed', 'complete', 'finished', 'succeeded'].includes(session.turnState) && !session.pendingInput && !session.childActivity && session.turnActive !== true;
          if (ready || stopped || failedStates.has(session.turnState)) {
            wait.done = true; wait.failed = !ready;
            if (ready) {
              wait.observedState = 'ready';
              if (completedStates.has(session.turnState) && session.completionAttribution !== 'ambiguous') {
                wait.turnId = session.turnId; wait.resultStatus = session.turnState;
                if (Number.isFinite(session.turnEndedAt)) wait.turnEndedAt = session.turnEndedAt;
              }
            }
            if (wait.failed) wait.error = stopped ? 'The terminal stopped before becoming ready.' : `The terminal ${session.turnState} before becoming ready.`;
            dirty = true;
          }
          continue;
        }
        if (wait.source === 'watch' && session.observation !== 'observed') { failStopped(); continue; }
        // Completed identity can remain cached while a newer turn runs. Its
        // current state must never be assigned to that older completed task.
        const completedIsCurrent = !session.turnId || session.completedTurnId === session.turnId;
        const exactCompletedAction = Boolean(wait.actionId) && session.completedActionId === wait.actionId && completedIsCurrent && eligibleResultTurn(wait, session.completedTurnId || session.turnId);
        const exactAction = Boolean(wait.actionId) && (exactCompletedAction || session.actionId === wait.actionId && eligibleResultTurn(wait, session.turnId));
        if (!wait.turnId && session.completedActionId === wait.actionId && session.completedTurnId && eligibleResultTurn(wait, session.completedTurnId)) wait.turnId = session.completedTurnId;
        if (!wait.turnId && wait.delivered && (exactAction || (wait.baselineIdle && session.turnId && session.turnId !== wait.baselineTurnId && Number(session.turnStartedAt) >= wait.submittedAt))) wait.turnId = exactCompletedAction ? session.completedTurnId || session.turnId : session.turnId;
        const exactTurn = wait.turnId && eligibleResultTurn(wait, wait.turnId) && ((completedIsCurrent && session.completedTurnId === wait.turnId) || session.turnId === wait.turnId);
        if (exactTurn || exactAction) {
          if (wait.observedState !== session.turnState) { wait.observedState = session.turnState; dirty = true; }
          if (completedStates.has(session.turnState) && !session.childActivity && !wait.backgroundPending || failedStates.has(session.turnState)) {
            wait.done = true; wait.failed = failedStates.has(session.turnState);
            if (Number.isFinite(session.turnEndedAt)) wait.turnEndedAt = session.turnEndedAt;
            if (wait.failed) wait.error = session.error || `The terminal task ${session.turnState}.`;
            dirty = true;
          }
        }
        // A native CLI may exit while its outer PTY/generation stays alive.
        // Prefer an exact ending above; process exit alone never proves success.
        failStopped();
      }
      if (job.executionDone && job.waits.length && job.waits.every(wait => wait.done) && job.task.status === 'waiting-results') {
        const failed = job.waits.find(wait => wait.failed);
        Object.assign(job.task, { status: failed ? 'failed' : job.task.resultScopeTransferred ? transferredStatus(job, true) : 'finished', waitingReason: undefined, updatedAt: now(), ...(failed && { error: failed.error || 'The terminal task did not finish successfully.' }) }); dirty = true;
      }
      if (job.executionDone && (job.task.status === 'waiting-results' || job.stagedPause)) {
        const outstanding = job.waits.filter(wait => !wait.done);
        const stagedOnly = outstanding.length > 0 && outstanding.every(wait => wait.staged);
        const waitingReason = stagedOnly ? 'Prompt saved as a draft, not sent. Open the terminal to review and send it.'
          : outstanding.some(wait => wait.staged) ? 'Some prompts were saved as drafts, not sent. Waiting for the other terminal results.'
            : outstanding.some(wait => wait.attributionAmbiguous) ? 'The terminal result cannot be attributed to this request. Inspect the terminal before continuing.'
            : outstanding.some(wait => wait.backgroundPending) ? 'Waiting for background work to settle before confirming the task result.'
            : outstanding.some(wait => wait.observedState === 'waiting') ? 'The terminal needs input before its task can continue.'
              : outstanding.some(wait => !wait.observedState && ['unknown', 'unconfirmed', 'uncertain'].includes(wait.deliveryStatus)) ? 'Delivery is uncertain; waiting for evidence. The prompt will not be resent automatically.'
                : outstanding.some(wait => wait.deliveryStatus === 'queued') ? 'Prompt queued until the terminal is ready.'
                  : outstanding.some(wait => wait.nativeShell) ? 'Shell input was sent; task completion cannot be verified automatically.'
                    : outstanding.some(wait => wait.inputDisposition === 'submitted-while-running' && !wait.observedState) ? 'Prompt submitted while the agent was working; incorporation into its result remains unverified.'
                      : outstanding.length ? 'Waiting for a verified terminal result.' : undefined;
        const status = stagedOnly ? 'paused' : outstanding.length ? 'waiting-results' : job.waits.some(wait => wait.failed) ? 'failed' : job.task.resultScopeTransferred ? transferredStatus(job, true) : 'finished';
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
      deliveryEvidence(wait, result);
      if (wait.operator && result.delivery === 'not-dispatched') { job.waits.splice(job.waits.indexOf(wait), 1); continue; }
      if (result.delivery === 'not-dispatched' || ['cancelled', 'rejected', 'stale', 'stale-generation', 'not-running'].includes(result.status) || (result.ok === false && !result.status)) { wait.done = true; wait.failed = true; wait.delivered = false; wait.error = result.error || result.reason; }
      else { wait.staged = result.status === 'staged'; wait.delivered = !['queued', 'staged'].includes(result.status); if (result.turnId && eligibleResultTurn(wait, result.turnId)) wait.turnId = result.turnId; }
    }
  }
  function cancel(requestId) {
    const selected = requestId ? [jobs.get(requestId)].filter(Boolean) : [...jobs.values()];
    for (const job of selected) if (!terminalStates.has(job.task.status)) { job.controller?.abort(); for (const wait of job.waits) if (wait.source === 'watch') { wait.done = true; wait.delivered = false; } Object.assign(job.task, { status: 'cancelled', updatedAt: now(), waitingReason: job.waits.some(wait => !wait.done && wait.delivered) ? 'Request cancelled; previously sent terminal work may still be running.' : undefined }); }
    changed(); return { ok: selected.length > 0 || !requestId, status: 'cancelled' };
  }
  return { create, hasCapacity, update, batch, blockingReason, ready, waitForDependencies: job => ready(job, { dependenciesOnly: true }), waitForAssignmentSubmission, track, watch, reconcile, delivery, cancel, jobs, get: id => jobs.get(id), snapshot: () => [...jobs.values()].map(project), busy: () => [...jobs.values()].some(job => ['queued', 'routing', 'running'].includes(job.task.status)), clear() { const protectedIds = liveRequestOwners(); for (const [id, job] of jobs) if (terminalStates.has(job.task.status) && !protectedIds.has(id) && !job.waits.some(wait => hasWorkspaceOccupancy(wait))) jobs.delete(id); changed(); } };
}
module.exports = { createTaskScheduler, createSemaphore, hasWorkspaceOccupancy };
