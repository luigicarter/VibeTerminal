const { Terminal } = require('@xterm/headless');

// Screen samples are evidence of what was displayed, not a reconstructed transcript.
// Keep the parser alive from launch; replaying clipped ANSI tails cannot recover a TUI.
// `scrollback` is how many lines above the viewport each decoder keeps. One is
// the default because a screen sample only ever reads the viewport; the mobile
// bridge asks for more because it ships the lines above it to a phone.
function createTerminalObservation({ maxHistoryBytes = 1024 * 1024, globalHistoryBytes = 32 * 1024 * 1024, scrollback = 1 } = {}) {
  const panes = new Map();
  let bytes = 0;
  let order = 0;
  maxHistoryBytes = Math.max(0, Math.min(1024 * 1024, Number(maxHistoryBytes) || 0));
  globalHistoryBytes = Math.max(0, Math.min(32 * 1024 * 1024, Number(globalHistoryBytes) || 0));
  scrollback = Math.max(1, Math.min(5000, Number(scrollback) || 1));
  function forget(id, generation) {
    if (id && typeof id === 'object') ({ id, generation } = id);
    const pane = panes.get(id);
    if (!pane || (generation !== undefined && pane.generation !== generation)) return;
    panes.delete(id);
    bytes -= pane.bytes;
    pane.disposed = true;
    for (const resolve of pane.waiters) resolve();
    pane.waiters.clear();
    pane.queue.length = 0;
    pane.batch = null;
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
  function drain(pane) {
    if (pane.disposed || pane.writing) return;
    const operation = pane.queue.shift();
    if (!operation) return;
    if (pane.batch === operation) pane.batch = null;
    const finish = () => {
      pane.writing = false;
      pane.waiters.delete(operation.resolve);
      operation.resolve();
      // Let readers of this barrier inspect its screen before xterm can parse
      // another write synchronously inside its current callback loop.
      void Promise.resolve().then(() => drain(pane));
    };
    if (operation.type === 'resize') {
      pane.terminal.resize(operation.cols, operation.rows);
      finish();
      return;
    }
    pane.writing = true;
    const data = operation.chunks.join('');
    operation.chunks.length = 0;
    pane.terminal.write(data, () => {
      if (!pane.disposed) {
        pane.sequence = operation.sequence;
        pane.outputAt = operation.at;
        // Where the caret stood the last time no frame was open. Three numbers,
        // captured per parse batch; the rows around it are still read live,
        // because only decoration cells move inside a frame.
        if (!pane.frameOpen) {
          const buffer = pane.terminal.buffer.active;
          pane.settledCaret = { x: buffer.cursorX, y: buffer.cursorY, visible: pane.cursorVisible };
        }
        retain(pane, screen(pane), operation.at);
      }
      finish();
    });
  }
  function enqueue(pane, operation) {
    operation.promise = new Promise(resolve => { operation.resolve = resolve; });
    pane.waiters.add(operation.resolve);
    pane.queue.push(operation);
    pane.pending = operation.promise;
    // One microtask per operation, not one timer/write/screen copy per chunk.
    // Adjacent output shares a batch; resize and explicit reads seal that batch.
    void Promise.resolve().then(() => drain(pane));
    return operation;
  }
  function ingest(event) {
    if (!event || !event.id || event.generation === undefined) return Promise.resolve();
    let pane = panes.get(event.id);
    if (event.type === 'created') {
      if (pane && pane.generation === event.generation) return pane.pending;
      forget(event.id);
      // xterm 5.5 can advance ybase past its line capacity when a wrapped screen
      // narrows with zero scrollback. A later grow/redraw then crashes lineFeed.
      // One spare row satisfies that reflow invariant; reads still expose only
      // the visible screen and the separately bounded display-sample history.
      pane = { generation: event.generation, terminal: new Terminal({ ...dimensions(event), scrollback, allowProposedApi: true }), pending: Promise.resolve(), waiters: new Set(), queue: [], sequence: 0, acceptedSequence: 0, history: [], bytes: 0, truncated: false, outputAt: null, metadataAt: event.at || Date.now(), fromLaunch: true };
      // Observe the same decoded stream as xterm, including split sequences.
      // Return false so mode changes/reset still reach xterm's own handlers.
      // A displayed prompt marker with a hidden cursor can be a disabled TUI.
      pane.cursorVisible = true;
      // Mode 2026 is synchronized output: a TUI opens it, repaints, and closes
      // it, so a consumer never renders a half-drawn frame. Codex 0.154 wraps
      // every sparkle frame in one, and during that frame it parks the cursor
      // out on a decoration row. A read that lands inside an open frame would
      // therefore report a caret that is nothing to do with the input, so the
      // caret from the last CLOSED frame is retained and reported instead.
      for (const [final, set] of [['h', true], ['l', false]]) {
        pane.terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
          if (params.includes(25)) pane.cursorVisible = set;
          if (params.includes(2026)) pane.frameOpen = set;
          return false;
        });
      }
      const resetCursor = () => { pane.cursorVisible = true; return false; };
      pane.terminal.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, resetCursor);
      pane.terminal.parser.registerEscHandler({ final: 'c' }, resetCursor);
      panes.set(event.id, pane);
    }
    if (!pane || pane.generation !== event.generation) return Promise.resolve();
    pane.metadataAt = event.at || Date.now();
    if (['created', 'snapshot', 'input-state'].includes(event.type) && Number.isSafeInteger(event.inputRevision) && event.inputRevision >= (pane.inputRevision ?? 0)) {
      pane.inputRevision = event.inputRevision;
      pane.manualInputPending = event.manualInputPending === true;
      pane.interactionInputPending = event.interactionInputPending === true;
      pane.ownerRequestId = typeof event.ownerRequestId === 'string' ? event.ownerRequestId : undefined;
    }
    if (event.type !== 'data') pane.batch = null;
    if (event.type === 'snapshot') return pane.pending; // UI replay never counts as new output.
    if (event.type === 'exit') pane.exited = true;
    if (event.type === 'resize') {
      enqueue(pane, { type: 'resize', ...dimensions(event) });
    }
    if (event.type === 'data' && typeof event.data === 'string') {
      if (Number.isFinite(event.sequence) && event.sequence <= pane.acceptedSequence) return pane.pending;
      pane.acceptedSequence = Number.isFinite(event.sequence) ? event.sequence : pane.acceptedSequence + 1;
      const batch = pane.batch || (pane.batch = enqueue(pane, { type: 'data', chunks: [], size: 0 }));
      batch.chunks.push(event.data);
      batch.size += event.data.length;
      batch.sequence = pane.acceptedSequence;
      batch.at = event.outputAt || event.at || Date.now();
      // Bound individual parse jobs so other panes and IPC get execution time.
      if (batch.size >= 65536) pane.batch = null;
    }
    return pane.pending;
  }
  async function read({ id, generation, maxChars = 20000, since, beforeSequence } = {}) {
    const pane = panes.get(id);
    if (!pane || (generation !== undefined && generation !== pane.generation)) return { ok: false, status: 'unavailable', source: 'terminal-screen', error: 'No live decoder for this generation.' };
    pane.batch = null;
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
        contextNote: 'These are retained terminal display samples, not a full conversation transcript. Adjacent output is batched, repeated unchanged displays are sampled once, and older samples may have been evicted.' };
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
    // Inside an open synchronized frame the TUI has parked the caret wherever it
    // is painting, so the caret from the last closed frame is what the input
    // surface is. The rows are still read live: only decoration cells move
    // inside a frame, and the composer recognizers normalise those away.
    const caret = pane.frameOpen && pane.settledCaret
      ? { x: Math.min(pane.settledCaret.x, pane.terminal.cols - 1), y: Math.min(pane.settledCaret.y, pane.terminal.rows - 1), visible: pane.settledCaret.visible }
      : { x: buffer.cursorX, y: buffer.cursorY, visible: pane.cursorVisible };
    const cursorRow = buffer.baseY + caret.y;
    let inputLineStart = cursorRow;
    while (inputLineStart > buffer.viewportY && buffer.getLine(inputLineStart)?.isWrapped) inputLineStart--;
    let inputLinePrefix = '';
    for (let row = inputLineStart; row < cursorRow; row++) inputLinePrefix += buffer.getLine(row)?.translateToString(false, 0, pane.terminal.cols) || '';
    const inputLine = buffer.getLine(cursorRow);
    const cursorLine = { text: inputLinePrefix + (inputLine?.translateToString(true) || ''),
      beforeCursor: inputLinePrefix + (inputLine?.translateToString(false, 0, caret.x) || ''), startRow: inputLineStart - buffer.viewportY };
    // The rows a composer recognizer indexes, taken before `maxChars` clips the
    // screen text: a clipped read drops leading rows, which would silently move
    // every row a check reads by cursor position. The window reaches two rows
    // above the cursor (a rule or box top) and six below (a rail's closing row).
    const contextStart = Math.max(0, caret.y - 2);
    const contextEnd = Math.min(pane.terminal.rows - 1, caret.y + 6);
    const contextRows = [];
    for (let y = contextStart; y <= contextEnd; y++) contextRows.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) || '');
    const cursorContext = { startRow: contextStart, rows: contextRows };
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
    return { ok: true, source: 'terminal-screen', historySource: 'display-samples', id, generation: pane.generation, text, history, sequence: pane.sequence, outputAt: pane.outputAt, metadataAt: pane.metadataAt, readAt: Date.now(), cursor: { x: caret.x, y: caret.y }, cursorVisible: caret.visible, alternateScreen: buffer.type === 'alternate', cols: pane.terminal.cols, rows: pane.terminal.rows, fromLaunch: true, exited: !!pane.exited, truncated: pane.truncated || historyClipped || text.length < full.length || (since !== undefined && pane.history.length > 0 && since < pane.history[0].sequence - 1), historyBytes: pane.bytes,
      nextBeforeSequence: pane.history.length > 1 ? pane.history.at(-1).sequence : null,
      screenTruncated: text.length < full.length, frameOpen: Boolean(pane.frameOpen),
      cursorLine, cursorContext,
      inputRevision: pane.inputRevision, manualInputPending: pane.manualInputPending, interactionInputPending: pane.interactionInputPending, ownerRequestId: pane.ownerRequestId,
      hasEarlier: pane.history.length > 1, historyUnavailable: Boolean(pane.evictedThroughSequence) };
  }
  function inputState({ id, generation }) {
    const pane = panes.get(id);
    if (!pane || pane.disposed || pane.generation !== generation || !Number.isSafeInteger(pane.inputRevision)) return { ok: false };
    return { ok: true, id, generation, inputRevision: pane.inputRevision,
      manualInputPending: pane.manualInputPending, interactionInputPending: pane.interactionInputPending };
  }
  // Read-only handle on a live decoder, for a caller that needs the buffer
  // itself rather than a text sample — the mobile bridge renders changed rows
  // straight off `terminal.buffer.active`. Nothing here writes: the returned
  // terminal is the decoder this module already owns and disposes.
  function inspect(target) {
    const { id, generation } = (target && typeof target === 'object') ? target : { id: target };
    const pane = panes.get(id);
    if (!pane || pane.disposed || (generation !== undefined && pane.generation !== generation)) return null;
    return { id, generation: pane.generation, terminal: pane.terminal, cols: pane.terminal.cols,
      rows: pane.terminal.rows, cursorVisible: pane.cursorVisible !== false, exited: Boolean(pane.exited),
      alternateScreen: pane.terminal.buffer.active.type === 'alternate', sequence: pane.sequence,
      settled: () => pane.pending };
  }
  return { ingest, read, inputState, inspect, forget, dispose() { for (const id of panes.keys()) forget(id); } };
}
module.exports = { createTerminalObservation };
