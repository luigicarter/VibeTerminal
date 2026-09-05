'use strict';
const MESSAGES = Object.freeze({
  credits: 'OpenRouter credits or the API key spending limit are insufficient. Check your OpenRouter billing and key limit.',
  auth: 'OpenRouter could not authenticate the API key. Check your key in settings.',
  'rate-limit': 'OpenRouter is rate limiting requests. Please try again shortly.',
  upstream: 'OpenRouter or the model provider could not complete the request. Please try again later.',
  network: 'Could not reach OpenRouter. Check your connection and try again.',
  timeout: 'The OpenRouter request timed out. Please try again.',
  request: 'OpenRouter could not accept this request. Check the selected model and settings.',
});
class OpenRouterError extends Error {
  constructor(category, status = 0) { super(MESSAGES[category] || MESSAGES.upstream); this.name = 'OpenRouterError'; this.category = MESSAGES[category] ? category : 'upstream'; this.status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0; if (this.status) this.message += ` (HTTP ${this.status})`; }
}
function classifyOpenRouterError(status, body) {
  const envelope = body?.error;
  const code = Number(envelope?.code);
  const effectiveStatus = status >= 400 ? status : (code >= 400 && code <= 599 ? code : status);
  const metadata = envelope?.metadata || body?.metadata;
  // Provider/BYOK balance or authentication failures are not OpenRouter account failures.
  const provider = Boolean(metadata && (metadata.provider_name || metadata.provider_error_code || metadata.is_byok || metadata.raw));
  let category = 'upstream';
  if (effectiveStatus === 402) category = provider ? 'upstream' : 'credits';
  else if (effectiveStatus === 401) category = provider ? 'upstream' : 'auth';
  else if (effectiveStatus === 408) category = 'timeout';
  else if (effectiveStatus === 429) category = 'rate-limit';
  else if (effectiveStatus >= 400 && effectiveStatus < 500) category = 'request';
  return new OpenRouterError(category, effectiveStatus);
}
const isCancellation = error => error?.name === 'AbortError';
function classifyTransportError(error, { signal, timeoutSignal } = {}) {
  if (signal?.aborted) { const cancelled = new Error('Cancelled.'); cancelled.name = 'AbortError'; return cancelled; }
  if (timeoutSignal?.aborted || error?.name === 'TimeoutError') return new OpenRouterError('timeout');
  if (isCancellation(error) || error instanceof OpenRouterError) return error;
  return new OpenRouterError('network');
}
function upstreamErrorInfo(error) { return error instanceof OpenRouterError ? { category: error.category, status: error.status, message: error.message } : undefined; }
async function readBoundedError(response) {
  const limit = 65536;
  if (response.body?.getReader) {
    const reader = response.body.getReader(); const chunks = []; let length = 0;
    try { while (length < limit) { const { done, value } = await reader.read(); if (done) break; const chunk = Buffer.from(value); chunks.push(chunk.subarray(0, limit - length)); length += chunk.length; } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
  }
  // Compatibility with injected fetch adapters; native fetch uses the bounded stream above.
  try { if (response.text) return JSON.parse((await response.text()).slice(0, limit)); return await response.json(); } catch { return null; }
}
async function readOpenRouterResponse(response) {
  if (!response.ok) throw classifyOpenRouterError(response.status, await readBoundedError(response));
  let data; try { data = await response.json(); } catch (error) { if (isCancellation(error) || error?.name === 'TimeoutError') throw error; throw new OpenRouterError('upstream', response.status); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new OpenRouterError('upstream', response.status);
  if (data.error != null) throw classifyOpenRouterError(response.status, data);
  return data;
}
module.exports = { OpenRouterError, classifyOpenRouterError, classifyTransportError, readOpenRouterResponse, upstreamErrorInfo, isCancellation };
