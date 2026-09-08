'use strict';

// Runtime-only bookkeeping: report text never includes terminal output or prompts.
// Attribution is owned by the scheduler; current session state alone is not proof.
const reported = new WeakMap();
const ended = new Set(['completed', 'complete', 'finished', 'succeeded', 'failed', 'cancelled', 'interrupted']);
function collectTaskReports(job, sessions = [], { now = Date.now } = {}) {
  if (!job || (!job.executionDone && !job.reportingReady) || job.restored || job.task?.status === 'cancelled' || job.controller?.signal.aborted) return [];
  let state = reported.get(job);
  if (!state) { state = { waits: new WeakMap(), final: false }; reported.set(job, state); }
  const reports = [];
  for (const wait of job.waits || []) {
    let seen = state.waits.get(wait);
    if (!seen) { seen = new Set(); state.waits.set(wait, seen); }
    const waiting = ['waiting', 'waiting-for-input', 'needs-answer', 'awaiting-input'].includes(wait.observedState);
    if (!waiting) seen.delete('waiting');
    if (wait.source === 'watch' && !['running', 'busy', 'starting'].includes(wait.observedState)) seen.delete('running');
    const target = job.task?.targets?.find(target => target.id === wait.targetId && target.generation === wait.generation)
      || sessions.find(session => session.id === wait.targetId && session.generation === wait.generation);
    const name = String(target?.name || 'Terminal').replace(/[\r\n\t]+/g, ' ').slice(0, 120);
    const add = (key, status, text) => {
      if (seen.has(key)) return;
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
    if (wait.source !== 'watch' && wait.inputDisposition !== 'submitted-while-running' && !wait.observedState && Number.isFinite(wait.submittedAt) && now() - wait.submittedAt >= 60000) {
      add('unconfirmed-start', 'unverified', 'input was sent, but I could not confirm that the agent started this task. Completion remains unverified.');
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
  if (!state.final && waits.length > 1 && waits.every(wait => wait.done && ended.has(wait.observedState))) {
    const last = reports.at(-1);
    if (last) { last.text += ' All requested terminal turns have ended.'; state.final = true; }
  }
  return reports;
}
module.exports = { collectTaskReports };
