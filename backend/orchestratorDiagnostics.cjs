'use strict';
const fs = require('node:fs');
const path = require('node:path');
const namedControls = new Set(require('../shared/terminalControls.cjs').TERMINAL_KEYS);

// Private diagnostics, never a transcript. Only bounded operational metadata.
function createDiagnostics({ userDataPath, getSecrets = () => [], now = Date.now, maxFileBytes = 1024 * 1024, maxQueuedRecords = 100, fsImpl = fs.promises } = {}) {
  const filename = path.join(userDataPath, 'logs', 'orchestrator-errors.jsonl');
  const fileLimit = Number.isSafeInteger(maxFileBytes) && maxFileBytes >= 256 ? maxFileBytes : 1024 * 1024;
  const queueLimit = Number.isSafeInteger(maxQueuedRecords) && maxQueuedRecords > 0 ? maxQueuedRecords : 100;
  let pending = 0, tail = Promise.resolve();
  function sanitize(input) {
    // Failure to retrieve secrets drops the record rather than risking disclosure.
    const secrets = getSecrets();
    if (!Array.isArray(secrets)) throw new Error('Invalid secrets');
    const redact = (value, limit) => {
      if (typeof value !== 'string' && typeof value !== 'number') return undefined;
      let text = String(value);
      for (const secret of secrets.filter(s => typeof s === 'string' && s.length).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
      text = text.replace(/\bBearer\s+[^\s,"';}]+/gi, 'Bearer [REDACTED]')
        .replace(/\b(?:sk|pk)-(?:[a-z0-9]+-)*[a-z0-9_-]{8,}/gi, '[REDACTED]')
        .replace(/((?:api[_ -]?key|access[_ -]?token|authorization)\s*["']?\s*[:=]\s*["']?)([^\s,"';}]+)/gi, '$1[REDACTED]');
      return text.slice(0, limit);
    };
    const result = { time: new Date(now()).toISOString() };
    for (const key of ['event', 'stage', 'requestId', 'workItemId', 'decision', 'modelCallId', 'toolCallId', 'receiptId', 'replyId', 'actionId', 'origin', 'model', 'actionKind', 'targetId', 'generation', 'status', 'category', 'reason', 'endpoint', 'provider', 'generationId', 'toolChoice']) {
      const value = redact(input?.[key], 256); if (value !== undefined) result[key] = value;
    }
    if (Number.isFinite(input?.generation)) result.generation = input.generation;
    if (['headers', 'body'].includes(input?.requestPhase)) result.requestPhase = input.requestPhase;
    if (Array.isArray(input?.nativeKeys) && input.nativeKeys.length <= 16 && input.nativeKeys.every(key => typeof key === 'string' && namedControls.has(key))) result.nativeKeys = [...input.nativeKeys];
    if (['preserve', 'interrupt', 'exit'].includes(input?.lifecycleMode)) result.lifecycleMode = input.lifecycleMode;
    if (typeof input?.editInput === 'boolean') result.editInput = input.editInput;
    for (const key of ['processState', 'agentProcessState']) if (['starting', 'running', 'exited', 'failed', 'unknown'].includes(input?.[key])) result[key] = input[key];
    // Keep voice and model timing evidence without recording their content. Unknown
    // fields still stay out of the log, and every numeric metric is bounded.
    for (const key of ['processingMs', 'queuedSamples', 'droppedSamples', 'totalMs', 'preprocessingMs', 'inferenceMs', 'elapsedMs', 'inputBytes', 'silenceMs', 'voicedMs', 'recordingId', 'captureToken', 'headersMs', 'bodyMs', 'deadlineMs', 'attempt', 'promptTokens', 'completionTokens', 'reasoningTokens']) {
      if (Number.isFinite(input?.[key]) && input[key] >= 0) result[key] = Math.min(input[key], 1e9);
    }
    if (Number.isFinite(input?.probability) && input.probability >= 0 && input.probability <= 1) result.probability = input.probability;
    if (['wake', 'answer', 'ptt'].includes(input?.recordingSource)) result.recordingSource = input.recordingSource;
    if (['keyword', 'completion'].includes(input?.helper)) result.helper = input.helper;
    if (Number.isInteger(input?.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599) result.httpStatus = input.httpStatus;
    const error = typeof input?.error === 'string' ? { message: input.error } : input?.error;
    if (error && typeof error === 'object') {
      result.error = {};
      for (const [key, limit] of [['name', 128], ['message', 2048], ['code', 128], ['stack', 4096]]) {
        const value = redact(error[key], limit); if (value !== undefined) result.error[key] = value;
      }
    }
    // Even the first record must fit. JSON escaping and UTF-8 can expand strings.
    let line = JSON.stringify(result) + '\n';
    while (Buffer.byteLength(line) > fileLimit) {
      const entries = [...Object.keys(result).filter(k => k !== 'time' && typeof result[k] === 'string').map(k => [result, k]), ...Object.keys(result.error || {}).map(k => [result.error, k])];
      entries.sort((a, b) => b[0][b[1]].length - a[0][a[1]].length);
      const largest = entries[0];
      if (!largest) return JSON.stringify({ time: result.time, event: 'diagnostic-truncated' }) + '\n';
      const [owner, key] = largest;
      if (owner[key].length > 16) owner[key] = owner[key].slice(0, Math.floor(owner[key].length / 2));
      else delete owner[key];
      line = JSON.stringify(result) + '\n';
    }
    return line;
  }
  async function ignoreMissing(operation) { try { await operation(); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
  async function append(line) {
    await fsImpl.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    let size = 0;
    try { size = (await fsImpl.stat(filename)).size; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (size + Buffer.byteLength(line) > fileLimit) {
      await ignoreMissing(() => fsImpl.unlink(`${filename}.2`));
      await ignoreMissing(() => fsImpl.rename(`${filename}.1`, `${filename}.2`));
      // A preexisting oversized file is discarded, not retained beyond the bound.
      if (size > fileLimit) await ignoreMissing(() => fsImpl.unlink(filename));
      else await ignoreMissing(() => fsImpl.rename(filename, `${filename}.1`));
    }
    await fsImpl.appendFile(filename, line, { encoding: 'utf8', mode: 0o600 });
  }
  function record(event) {
    try {
      if (pending >= queueLimit) return;
      const line = sanitize(event);
      pending++;
      tail = tail.then(() => append(line)).catch(() => {}).finally(() => { pending--; });
    } catch { /* Diagnostics must never interrupt application behavior. */ }
  }
  return { record, flush: () => tail };
}
module.exports = { createDiagnostics };
