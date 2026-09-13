'use strict';
const { paneLabel, failureSentence, sentence } = require('./orchestratorFailureText.cjs');

// Runtime-only bookkeeping: report text never includes terminal output or prompts.
// Attribution is owned by the scheduler; current session state alone is not proof.
const reported = new WeakMap();
const ended = new Set(['completed', 'complete', 'finished', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const waitingStates = new Set(['waiting', 'waiting-for-input', 'needs-answer', 'awaiting-input']);
const runningStates = new Set(['running', 'busy', 'starting']);
const turnKey = wait => !wait.attributionAmbiguous && wait.turnId && wait.targetId && wait.generation != null
  ? JSON.stringify([wait.targetId, wait.generation, wait.turnId]) : null;
function collectTaskReports(job, sessions = [], { now = Date.now, recordDiagnostic = () => {}, suppressed = () => false } = {}) {
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
    // One pane label for every sentence in this report, so a row reads as a
    // statement about the pane the user can see rather than a status line.
    const pane = paneLabel(target, name);
    const say = (key, context = {}) => sentence(key, { pane, ...context })?.text;
    const add = (key, status, text) => {
      const attributed = turnKey(wait);
      const shared = attributed && ['running', 'waiting', 'ended'].includes(key) ? state.turns.get(attributed) : null;
      // Delivery failures with different explanations remain independently visible.
      const event = key === 'ended' ? `${key}:${status}:${text}` : key === 'running' && wait.source === 'watch' ? 'watch-running' : key;
      if (shared) {
        if (shared.has(event)) return;
        shared.add(event);
      } else if (seen.has(key)) return;
      // The progress lines published as each event happened are the same facts.
      // Whichever said it first owns it; the user never reads it twice.
      if (suppressed({ kind: key, targetId: wait.targetId, generation: wait.generation, source: wait.source })) { seen.add(key); return; }
      seen.add(key);
      reports.push({ text, status, targetId: wait.targetId, generation: wait.generation,
        ...(wait.turnId && { turnId: wait.turnId }), ...(wait.actionId && { actionId: wait.actionId }), ...(wait.inputDisposition && { inputDisposition: wait.inputDisposition }), ...(wait.source === 'watch' && { source: 'watch' }) });
    };
    if (wait.done) {
      if (wait.failed) {
        const changed = !sessions.some(session => session.id === wait.targetId && session.generation === wait.generation);
        const reason = wait.error ? String(wait.error).replace(/[\r\n\t]+/g, ' ').slice(0, 240) : '';
        // A delivery that never happened has an exact cause. Say it in one
        // sentence that names the pane, instead of generic prose.
        const mapped = changed ? failureSentence('generation-changed', { pane })
          : !wait.delivered && failureSentence(wait.deliveryStatus, { pane, ...(Number.isFinite(wait.timeoutMs) && { seconds: wait.timeoutMs / 1000 }) });
        if (mapped) { add('ended', 'failed', mapped); continue; }
        add('ended', 'failed', say(wait.observedState === 'interrupted' || wait.observedState === 'cancelled' ? 'turn-interrupted'
          : ended.has(wait.observedState) ? 'turn-error' : 'turn-unconfirmed', { reason }));
      } else if (wait.source === 'watch' && wait.observedState === 'ready') {
        add('ended', 'ready', say('ready'));
      } else if (ended.has(wait.observedState)) {
        add('ended', 'completed', say('turn-ended'));
      }
      continue;
    }
    if (wait.staged) { add('staged', 'paused', say('staged')); continue; }
    if (wait.source !== 'watch' && (wait.deliveryStatus === 'queued' || !wait.delivered)) {
      add('queued', 'queued', say('queued')); continue;
    }
    const uncertain = ['unknown', 'unconfirmed', 'uncertain'].includes(wait.deliveryStatus);
    if (wait.nativeShell) {
      add('shell', 'unverified', say(wait.source === 'watch' ? 'watching' : uncertain ? 'delivery-unknown' : 'native-shell')); continue;
    }
    if (wait.inputDisposition === 'submitted-while-running' && !wait.observedState && !uncertain) {
      add('submitted-while-running', 'unverified', say('delivered-while-running'));
      continue;
    }
    if (wait.attributionAmbiguous) {
      add('ambiguous', 'unverified', say('attribution-ambiguous'));
      continue;
    }
    if (wait.source !== 'watch' && uncertain && !wait.observedState) {
      add('unknown', 'unverified', say('delivery-unknown'));
      continue;
    }
    // Composer evidence that the prompt was taken. It replaces the delayed
    // unconfirmed-start report; it never claims the task started or finished.
    if (wait.source !== 'watch' && wait.observedState === 'submitted-observed') {
      add('submitted-observed', 'delivered', say('accepted'));
      continue;
    }
    if (wait.source !== 'watch' && wait.inputDisposition !== 'submitted-while-running' && !wait.observedState && Number.isFinite(wait.submittedAt) && now() - wait.submittedAt >= 60000) {
      const seenBefore = seen.has('unconfirmed-start');
      add('unconfirmed-start', 'unverified', say('delivered-unconfirmed'));
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
      add('running', 'running', say(wait.source === 'watch' ? 'running' : 'started'));
    } else if (waiting) {
      add('waiting', 'needs-answer', say('needs-input'));
    } else if (seen.has('queued')) {
      add('sent', 'delivered', say('typed'));
    }
  }
  const waits = job.waits || [];
  const distinctTurns = new Set(waits.map(wait => turnKey(wait) || wait));
  if (!state.final && distinctTurns.size > 1 && waits.every(wait => wait.done && ended.has(wait.observedState))) {
    const last = reports.at(-1);
    if (last) { last.text += ` ${sentence('all-turns-ended').text}`; state.final = true; }
  }
  return reports;
}
module.exports = { collectTaskReports };
