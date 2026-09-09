'use strict';

// Chat belongs to each request. Automatic speech describes a terminal event,
// which overlapping requests may observe together.
function createTaskSpeech(onSpeak) {
  const spoken = new Map();
  return async function speak({ job, report, event, epoch, isActive }) {
    if (!onSpeak || !isActive() || event.signal?.aborted) return;
    // A terminal can finish while its request still has queued work or a
    // followup. Keep routine completion reports and result recaps in chat even
    // before the whole-command acknowledgment is eligible. That separate path
    // owns the single ding and "done"; failures still use this speech queue.
    if (['completed', 'ready'].includes(report.status)) return { ok: true, status: 'silent' };
    const wait = job.waits?.find(item => item.targetId === report.targetId && item.generation === report.generation
      && item.turnId === report.turnId && (!report.actionId || item.actionId === report.actionId));
    const attributed = wait?.done && !wait.attributionAmbiguous && report.targetId && report.generation != null && report.turnId;
    const shared = attributed && (event.kind === 'task-result' || ['completed', 'failed'].includes(report.status));
    // Keep distinct failure explanations visible; completion wording and
    // terminal labels may differ between requests for the same turn.
    const key = shared ? JSON.stringify([epoch, report.targetId, report.generation, report.turnId, event.kind,
      event.kind === 'task-result' ? null : report.status, report.status === 'failed' && event.kind !== 'task-result' ? report.text : null]) : null;
    if (!key) return onSpeak(event);
    while (spoken.has(key)) {
      const pending = spoken.get(key).result;
      let onAbort;
      const cancellation = event.signal && new Promise(resolve => {
        onAbort = () => resolve(false);
        event.signal.addEventListener('abort', onAbort, { once: true });
        if (event.signal.aborted) onAbort();
      });
      let delivered;
      try { delivered = await (cancellation ? Promise.race([pending, cancellation]) : pending); }
      finally { if (onAbort) event.signal.removeEventListener('abort', onAbort); }
      if (!isActive() || event.signal?.aborted) return;
      if (delivered) return { ok: true, status: 'duplicate' };
    }
    let finish;
    const entry = { done: false, result: new Promise(resolve => { finish = resolve; }) };
    spoken.set(key, entry);
    let delivered = false;
    try {
      const result = await onSpeak(event);
      delivered = result?.ok !== false && !['cancelled', 'silent'].includes(result?.status);
      return result;
    } finally {
      entry.done = true;
      if (!delivered) spoken.delete(key);
      finish(delivered);
      while (spoken.size > 500) {
        const old = [...spoken].find(([, value]) => value.done);
        if (!old) break;
        spoken.delete(old[0]);
      }
    }
  };
}

module.exports = { createTaskSpeech };
