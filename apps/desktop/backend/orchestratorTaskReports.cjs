'use strict';

// Runtime-only bookkeeping: report text never includes terminal output or prompts.
// Attribution is owned by the scheduler; current session state alone is not proof.
const reported = new WeakMap();
const ended = new Set(['completed', 'complete', 'finished', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const waitingStates = new Set(['waiting', 'waiting-for-input', 'needs-answer', 'awaiting-input']);
const runningStates = new Set(['running', 'busy', 'starting']);
const turnKey = wait => !wait.attributionAmbiguous && wait.turnId && wait.targetId && wait.generation != null
  ? JSON.stringify([wait.targetId, wait.generation, wait.turnId]) : null;
function collectTaskReports(job, sessions = [], { now = Date.now, recordDiagnostic = () => {} } = {}) {
  if (!job || (!job.executionDone && !job.reportingReady) || job.restored || job.task?.status === 'cancelled' || job.controller?.signal.aborted) return [];
  let state = reported.get(job);
  if (!state) { state = { waits: new WeakMap(), turns: new Map(), final: false }; reported.set(job, state); }
  // Reset episodes once per turn, not per delivery: a stale sibling wait must
  // not clear the notification emitted by another wait in the same collection.
  const active = new Map();
  for (const wait of job.waits || []) {
    const key = turnKey(wait);
    if (!key) continue;
    if (!state.turns.has(key)) state.turns.set(key, new Set());
    if (!active.has(key)) active.set(key, new Set());
    active.get(key).add(wait.observedState);
  }
  for (const [key, states] of active) {
    const seen = state.turns.get(key);
    if (![...states].some(value => waitingStates.has(value))) seen.delete('waiting');
    if (![...states].some(value => runningStates.has(value))) seen.delete('watch-running');
  }
  const reports = [];
  for (const wait of job.waits || []) {
    let seen = state.waits.get(wait);
    if (!seen) { seen = new Set(); state.waits.set(wait, seen); }
    const waiting = waitingStates.has(wait.observedState);
    if (!waiting) seen.delete('waiting');
    if (wait.source === 'watch' && !['running', 'busy', 'starting'].includes(wait.observedState)) seen.delete('running');
    const target = job.task?.targets?.find(target => target.id === wait.targetId && target.generation === wait.generation)
      || sessions.find(session => session.id === wait.targetId && session.generation === wait.generation);
    const name = String(target?.name || 'Terminal').replace(/[\r\n\t]+/g, ' ').slice(0, 120);
    const add = (key, status, text) => {
      const attributed = turnKey(wait);
      const shared = attributed && ['running', 'waiting', 'ended'].includes(key) ? state.turns.get(attributed) : null;
      // Delivery failures with different explanations remain independently visible.
      const event = key === 'ended' ? `${key}:${status}:${text}` : key === 'running' && wait.source === 'watch' ? 'watch-running' : key;
      if (shared) {
        if (shared.has(event)) return;
        shared.add(event);
      } else if (seen.has(key)) return;
      seen.add(key);
      reports.push({ text: `${name}: ${text}`, status, targetId: wait.targetId, generation: wait.generation,
        ...(wait.turnId && { turnId: wait.turnId }), ...(wait.actionId && { actionId: wait.actionId }), ...(wait.inputDisposition && { inputDisposition: wait.inputDisposition }), ...(wait.source === 'watch' && { source: 'watch' }) });
    };
    if (wait.done) {
      if (wait.failed) {
        const changed = !sessions.some(session => session.id === wait.targetId && session.generation === wait.generation);
        const reason = wait.error ? ` ${String(wait.error).replace(/[\r\n\t]+/g, ' ').slice(0, 240)}` : '';
        add('ended', 'failed', changed
          ? 'the terminal changed before its result could be verified. Completion is unverified.'
          : wait.observedState === 'interrupted' || wait.observedState === 'cancelled'
            ? `the agent turn was interrupted.${reason} The requested outcome is not independently verified.`
            : ended.has(wait.observedState)
              ? `the agent turn ended with an error.${reason} The requested outcome is not independently verified.`
              : `the requested work could not be confirmed.${reason} Completion is unverified.`);
      } else if (wait.source === 'watch' && wait.observedState === 'ready') {
        add('ended', 'ready', 'the terminal is ready for input. This does not establish that any task was completed.');
      } else if (ended.has(wait.observedState)) {
        add('ended', 'completed', 'the agent turn completed. The requested outcome is not independently verified.');
      }
      continue;
    }
    if (wait.staged) { add('staged', 'paused', 'the prompt is saved as a draft and has not been sent.'); continue; }
    if (wait.source !== 'watch' && (wait.deliveryStatus === 'queued' || !wait.delivered)) {
      add('queued', 'queued', 'the prompt is queued for delivery.'); continue;
    }
    const uncertain = ['unknown', 'unconfirmed', 'uncertain'].includes(wait.deliveryStatus);
    if (wait.nativeShell) {
      add('shell', 'unverified', `${wait.source === 'watch' ? 'I am watching this plain shell' : uncertain ? 'delivery to a plain shell is unconfirmed' : 'input was sent to a plain shell'}. I cannot verify automatically when this shell command finishes. Completion is unverified.`); continue;
    }
    if (wait.inputDisposition === 'submitted-while-running' && !wait.observedState && !uncertain) {
      add('submitted-while-running', 'unverified', 'the prompt was submitted while the agent was working. Whether it was incorporated into the result remains unverified.');
      continue;
    }
    if (wait.attributionAmbiguous) {
      add('ambiguous', 'unverified', 'I could not reliably match the terminal activity to this task. Completion remains unverified; I am still tracking its result.');
      continue;
    }
    if (wait.source !== 'watch' && uncertain && !wait.observedState) {
      add('unknown', 'unverified', 'delivery is unconfirmed. I am waiting for a confirmed task result and will not resend the prompt automatically.');
      continue;
    }
    // Composer evidence that the prompt was taken. It replaces the delayed
    // unconfirmed-start report; it never claims the task started or finished.
    if (wait.source !== 'watch' && wait.observedState === 'submitted-observed') {
      add('submitted-observed', 'delivered', 'the prompt was accepted; the result is pending.');
      continue;
    }
    if (wait.source !== 'watch' && wait.inputDisposition !== 'submitted-while-running' && !wait.observedState && Number.isFinite(wait.submittedAt) && now() - wait.submittedAt >= 60000) {
      const seenBefore = seen.has('unconfirmed-start');
      add('unconfirmed-start', 'unverified', 'input was sent, but I could not confirm that the agent started this task. Completion remains unverified.');
      // Private startup telemetry for the unexplained gap. No text of any kind.
      if (!seenBefore && seen.has('unconfirmed-start')) {
        const session = sessions.find(item => item.id === wait.targetId && item.generation === wait.generation);
        recordDiagnostic({ event: 'request_stage', stage: 'unconfirmed_start', requestId: job.task?.requestId,
          targetId: wait.targetId, generation: wait.generation, actionKind: 'send_prompt',
          provider: session?.provider || session?.kind, turnState: session?.turnState, hasTurnId: Boolean(session?.turnId),
          ...(typeof session?.telemetryHealth === 'string' && { telemetryHealth: session.telemetryHealth }),
          ...(Number.isFinite(session?.turnStartedAt) && { turnStartedOffsetMs: session.turnStartedAt - wait.submittedAt }) });
      }
      continue;
    }
    if (['running', 'busy', 'starting'].includes(wait.observedState)) {
      add('running', 'running', wait.source === 'watch' ? 'the agent is working on the watched turn.' : 'the agent is working on the requested turn.');
    } else if (waiting) {
      add('waiting', 'needs-answer', 'the agent needs input. Review the terminal to continue.');
    } else if (seen.has('queued')) {
      add('sent', 'delivered', 'the queued prompt was sent. Waiting for a confirmed task result.');
    }
  }
  const waits = job.waits || [];
  const distinctTurns = new Set(waits.map(wait => turnKey(wait) || wait));
  if (!state.final && distinctTurns.size > 1 && waits.every(wait => wait.done && ended.has(wait.observedState))) {
    const last = reports.at(-1);
    if (last) { last.text += ' All requested terminal turns have ended.'; state.final = true; }
  }
  return reports;
}
module.exports = { collectTaskReports };
