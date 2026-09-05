const { Terminal } = require('@xterm/headless');

// Screen samples are evidence of what was displayed, not a reconstructed transcript.
// Keep the parser alive from launch; replaying clipped ANSI tails cannot recover a TUI.
function createTerminalObservation({ maxHistoryBytes = 1024 * 1024, globalHistoryBytes = 32 * 1024 * 1024 } = {}) {
  const panes = new Map();
  let bytes = 0;
  let order = 0;
  maxHistoryBytes = Math.max(0, Math.min(1024 * 1024, Number(maxHistoryBytes) || 0));
  globalHistoryBytes = Math.max(0, Math.min(32 * 1024 * 1024, Number(globalHistoryBytes) || 0));
  function forget(id, generation) {
    if (id && typeof id === 'object') ({ id, generation } = id);
    const pane = panes.get(id);
    if (!pane || (generation !== undefined && pane.generation !== generation)) return;
    panes.delete(id);
    bytes -= pane.bytes;
    pane.disposed = true;
    for (const resolve of pane.waiters) resolve();
    pane.waiters.clear();
    pane.terminal.dispose();
  }
  function dimensions(event) {
    return { cols: Math.max(2, Math.min(500, Number(event.cols) || 100)), rows: Math.max(1, Math.min(200, Number(event.rows) || 28)) };
  }
  function screen(pane) {
    const buffer = pane.terminal.buffer.active;
    const lines = [];
    for (let y = 0; y < pane.terminal.rows; y++) lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) || '');
    return lines.join('\n').trimEnd();
  }
  function evict(pane) {
    const sample = pane.history.shift();
    if (!sample) return;
    pane.bytes -= sample.bytes;
    bytes -= sample.bytes;
    pane.truncated = true;
    pane.evictedThroughSequence = Math.max(pane.evictedThroughSequence || 0, sample.sequence);
  }
  function retain(pane, text, at) {
    if (pane.lastText === text) return;
    pane.lastText = text;
    let size = Buffer.byteLength(text, 'utf8');
    let sampleTruncated = false;
    const budget = Math.min(maxHistoryBytes, globalHistoryBytes);
    if (size > budget) {
      // Slice by code point so a clipped sample remains valid Unicode.
      const chars = Array.from(text);
      let start = 0;
      while (start < chars.length && size > budget) size -= Buffer.byteLength(chars[start++], 'utf8');
      text = chars.slice(start).join('');
      pane.truncated = true;
      sampleTruncated = true;
    }
    pane.history.push({ sequence: pane.sequence, at, text, bytes: size, order: ++order, truncated: sampleTruncated });
    pane.bytes += size;
    bytes += size;
    while (pane.bytes > maxHistoryBytes) evict(pane);
    while (bytes > globalHistoryBytes) {
      let oldest;
      for (const candidate of panes.values()) if (candidate.history.length && (!oldest || candidate.history[0].order < oldest.history[0].order)) oldest = candidate;
      if (!oldest) break;
      evict(oldest);
    }
    // Empty/unchanged screens must not accumulate unbounded sample metadata.
    while (pane.history.length > 1024) evict(pane);
  }
  function ingest(event) {
    if (!event || !event.id || event.generation === undefined) return Promise.resolve();
    let pane = panes.get(event.id);
    if (event.type === 'created') {
      if (pane && pane.generation === event.generation) return pane.pending;
      forget(event.id);
      pane = { generation: event.generation, terminal: new Terminal({ ...dimensions(event), scrollback: 0, allowProposedApi: true }), pending: Promise.resolve(), waiters: new Set(), sequence: 0, history: [], bytes: 0, truncated: false, outputAt: null, metadataAt: event.at || Date.now(), fromLaunch: true };
      panes.set(event.id, pane);
    }
    if (!pane || pane.generation !== event.generation) return Promise.resolve();
    pane.metadataAt = event.at || Date.now();
    if (event.type === 'snapshot') return pane.pending; // UI replay never counts as new output.
    if (event.type === 'exit') pane.exited = true;
    if (event.type === 'resize') {
      pane.pending = pane.pending.then(() => { if (!pane.disposed) pane.terminal.resize(...Object.values(dimensions(event))); });
    }
    if (event.type === 'data' && typeof event.data === 'string') {
      const at = event.outputAt || event.at || Date.now();
      pane.pending = pane.pending.then(() => new Promise(resolve => {
        if (pane.disposed) return resolve();
        if (Number.isFinite(event.sequence) && event.sequence <= pane.sequence) return resolve();
        pane.waiters.add(resolve);
        pane.terminal.write(event.data, () => {
          pane.waiters.delete(resolve);
          if (!pane.disposed) {
            pane.sequence = Number.isFinite(event.sequence) ? event.sequence : pane.sequence + 1;
            pane.outputAt = at;
            retain(pane, screen(pane), at);
          }
          resolve();
        });
      }));
    }
    return pane.pending;
  }
  async function read({ id, generation, maxChars = 20000, since, beforeSequence } = {}) {
    const pane = panes.get(id);
    if (!pane || (generation !== undefined && generation !== pane.generation)) return { ok: false, status: 'unavailable', source: 'terminal-screen', error: 'No live decoder for this generation.' };
    await pane.pending;
    if (pane.disposed || panes.get(id) !== pane) return { ok: false, status: 'stale-generation' };
    maxChars = Math.max(0, Math.min(1024 * 1024, Number(maxChars) || 0));
    if (beforeSequence !== undefined) {
      if (generation === undefined || !Number.isSafeInteger(beforeSequence) || beforeSequence <= 0 || beforeSequence > pane.sequence) {
        return { ok: false, status: 'invalid-cursor', source: 'terminal-screen', id, generation: pane.generation, error: 'Use a positive beforeSequence returned for this generation, no greater than its current output sequence.' };
      }
      const sampleIndex = pane.history.findLastIndex(sample => sample.sequence < beforeSequence);
      const sample = pane.history[sampleIndex];
      const historyUnavailable = Boolean(pane.evictedThroughSequence);
      const common = { ok: true, source: 'terminal-screen', historySource: 'display-samples', id, generation: pane.generation,
        currentSequence: pane.sequence, beforeSequence, readAt: Date.now(), historyUnavailable,
        contextNote: 'These are retained terminal display samples, not a full conversation transcript. Repeated unchanged displays are sampled once; older samples may have been evicted.' };
      if (!sample) return { ...common, status: 'history-end', text: '', sequence: null, nextBeforeSequence: null, hasEarlier: false,
        complete: true, completenessScope: 'retained-display-samples', truncated: historyUnavailable };
      const characters = Array.from(sample.text);
      const text = maxChars ? characters.slice(-maxChars).join('') : '';
      const hasEarlier = sampleIndex > 0;
      return { ...common, status: 'found', text, sequence: sample.sequence, observedAt: sample.at, outputAt: sample.at,
        nextBeforeSequence: hasEarlier ? sample.sequence : null, hasEarlier, complete: !hasEarlier,
        completenessScope: 'retained-display-samples', sampleTruncated: Boolean(sample.truncated),
        excerptTruncated: characters.length > maxChars,
        truncated: historyUnavailable || Boolean(sample.truncated) || characters.length > maxChars };
    }
    const full = screen(pane);
    const text = maxChars ? Array.from(full).slice(-maxChars).join('') : '';
    const buffer = pane.terminal.buffer.active;
    let remaining = maxChars;
    let historyClipped = false;
    const history = [];
    for (const sample of [...pane.history].reverse()) {
      if (since !== undefined && sample.sequence <= since) continue;
      if (!remaining) { historyClipped = true; break; }
      if (Array.from(sample.text).length > remaining) historyClipped = true;
      const value = Array.from(sample.text).slice(-remaining).join('');
      remaining -= Array.from(value).length;
      history.unshift({ sequence: sample.sequence, at: sample.at, text: value });
    }
    return { ok: true, source: 'terminal-screen', historySource: 'display-samples', id, generation: pane.generation, text, history, sequence: pane.sequence, outputAt: pane.outputAt, metadataAt: pane.metadataAt, readAt: Date.now(), cursor: { x: buffer.cursorX, y: buffer.cursorY }, alternateScreen: buffer.type === 'alternate', cols: pane.terminal.cols, rows: pane.terminal.rows, fromLaunch: true, exited: !!pane.exited, truncated: pane.truncated || historyClipped || text.length < full.length || (since !== undefined && pane.history.length > 0 && since < pane.history[0].sequence - 1), historyBytes: pane.bytes,
      nextBeforeSequence: pane.history.length > 1 ? pane.history.at(-1).sequence : null,
      hasEarlier: pane.history.length > 1, historyUnavailable: Boolean(pane.evictedThroughSequence) };
  }
  return { ingest, read, forget, dispose() { for (const id of panes.keys()) forget(id); } };
}
module.exports = { createTerminalObservation };
