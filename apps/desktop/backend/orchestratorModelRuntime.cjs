'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { OpenRouterError } = require('./openRouterErrors.cjs');
const { completionOptions } = require('./orchestratorModelOptions.cjs');
const { assertTranscriptShape, describeTranscript } = require('./orchestratorExecutionHarness.cjs');
const usageCost = response => Number.isFinite(response?.usage?.cost) && response.usage.cost > 0 ? response.usage.cost : 0;

// One table owns every model deadline, so a stage that only decides where a
// sentence goes cannot hold a spoken request for the full execution budget. The
// per-attempt signal is built here and handed to the transport, which keeps its
// own defensive cap for the catalog and key calls that have no category.
// Interpretation gets 40 s: the cheaper reasoning Brains (deepseek-v4-flash,
// qwen3.7-flash) took 25 to 35 s to plan a long spoken sentence on the ladder
// and were cut off with "took too long", which is worse than a slow plan.
const MODEL_DEADLINES = Object.freeze({
  interpretation: 40000,
  'close-review': 20000,
  'goal-review': 20000,
  execution: 45000,
  default: 45000,
});
const modelDeadlineMs = category => MODEL_DEADLINES[category] ?? MODEL_DEADLINES.default;

// Diagnostics only, and off unless LINA_MODEL_DEBUG_DIR names a directory: no
// body is retained and no file is written without it. When it is set, the exact
// request body of a model call the provider rejects with HTTP 4xx is written to
// <dir>/<modelCallId>-<attempt>.json, together with the few immediately earlier
// bodies of the same request (…-prev<n>.json) so a rejected replayed history can
// be compared with the one the provider accepted. A completion body carries no
// API key; any key-shaped string is redacted anyway.
// LINA_MODEL_DEBUG_ALL widens the same capture to every call, accepted and
// rejected alike, so a plan the provider returned with HTTP 200 but that the
// application then refused can be read exactly as the model wrote it. It still
// writes nothing without LINA_MODEL_DEBUG_DIR, and it is never on by default.
const DEBUG_HISTORY = 8, DEBUG_PREVIOUS = 3;
const modelDebugDir = () => { const dir = process.env.LINA_MODEL_DEBUG_DIR; return typeof dir === 'string' && dir.trim() ? dir.trim() : ''; };
const modelDebugAll = () => ['1', 'true', 'yes', 'on'].includes(String(process.env.LINA_MODEL_DEBUG_ALL ?? '').trim().toLowerCase());
const redactKeys = text => text.replace(/sk-[A-Za-z0-9._-]{8,}/g, '[REDACTED]');
function writeModelDebug(dir, name, payload) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${name}.json`), redactKeys(JSON.stringify(payload, null, 2))); }
  catch { /* A diagnostic write must never fail or alter a model call. */ }
}

// Opaque provider reasoning is replayed with the assistant turn that produced
// it (Gemini's thought signatures arrive this way through OpenRouter's
// reasoning_details). Such a signature is only valid for a history the model
// itself authored: the application also owns assistant turns it cannot sign —
// its own observation after a handoff, an automatically proposed action, the
// reply it synthesizes for a continuation — and a history that mixes signed and
// application-authored assistant turns is rejected outright with HTTP 400
// "Corrupted thought signature.", losing the whole request. Replay signatures
// only while every assistant turn in the history carries its own; otherwise send
// the same history with none. Nothing else about the request changes: messages,
// order, tools and every authorization stay exactly as the caller built them.
const signedReplay = message => message?.role === 'assistant' && Boolean(message.reasoning_details);
function alignReasoningReplay(messages) {
  if (!Array.isArray(messages)) return messages;
  const assistants = messages.filter(message => message?.role === 'assistant');
  if (!assistants.some(signedReplay) || assistants.every(signedReplay)) return messages;
  return stripReasoningReplay(messages);
}
function stripReasoningReplay(messages) {
  return messages.map(message => { if (!signedReplay(message)) return message; const { reasoning_details, ...rest } = message; return rest; });
}
const CORRUPTED_SIGNATURE = /thought signature/i;

// A fallback brain is a different model, usually a different provider: another
// provider's opaque reasoning is not replayable there, and the options the
// primary advertised are not the ones it supports. Rebuild the body from the
// fallback's own capabilities instead of resending the primary's.
function withFallbackModel(body, fallback) {
  const { reasoning, temperature, response_format, ...rest } = body;
  const next = { ...rest, model: fallback.id, ...completionOptions(fallback) };
  if (Array.isArray(next.messages) && next.messages.some(signedReplay)) next.messages = stripReasoningReplay(next.messages);
  if (response_format && fallback.supportedParameters?.includes('structured_outputs')) next.response_format = response_format;
  const ceiling = Number(fallback.maxCompletionTokens);
  if (Number.isFinite(next.max_tokens) && Number.isFinite(ceiling) && ceiling > 0 && ceiling < next.max_tokens) next.max_tokens = ceiling;
  return next;
}

// Owns transport recovery, cost accounting and model-call diagnostics for every
// harness stage. Callers never charge the same response a second time.
function createModelRuntime({ request, getContext, assertBudget, recordUsage, recordDiagnostic, getFallbackModel = () => undefined, now = Date.now }) {
  const debugBodies = [];
  // A provider that rejects the reasoning parameter must not fail the whole request.
  async function completionWithFallback(body, signal, options = {}) {
    if (signal?.aborted) throw new Error('Cancelled.');
    assertBudget();
    const aligned = alignReasoningReplay(body?.messages);
    let current = aligned === body?.messages ? body : { ...body, messages: aligned },
      optionRepair = false, formatRepair = false, transportRetry = false, signatureRepair = false, repairedOption, fallbackFrom;
    const reasoningReplay = current === body ? undefined : 'aligned';
    // A repair that leaves the wire body byte-identical after a 4xx would only
    // buy a second identical rejection. Refuse to spend it. A 5xx transport
    // retry deliberately repeats its body and is never recorded here.
    const rejectedBodies = new Map();
    // One attempt plus every single-shot repair below: three rejections in a row
    // must not exhaust the loop before the fully repaired request is ever sent,
    // and the one fallback-brain attempt still has to fit after the last of them.
    for (let attempt = 0; attempt < 6; attempt++) {
      if (signal?.aborted) throw new Error('Cancelled.');
      assertBudget();
      // An application-authored assistant turn is validated exactly like a
      // model-authored one, before any provider can reject the whole request.
      assertTranscriptShape(current?.messages);
      const serialized = JSON.stringify(current);
      if (rejectedBodies.has(serialized)) throw rejectedBodies.get(serialized);
      const startedAt = now(), modelCallId = randomUUID(), job = getContext();
      const category = options.category || (current.tools?.[0]?.function?.name === 'interpret_workspace' ? 'interpretation' : current.tools?.length ? 'execution' : 'summary');
      const deadlineMs = modelDeadlineMs(category);
      const timing = { event: 'request_stage', requestId: job?.task.requestId, origin: job?.input.origin,
        modelCallId, model: current.model, attempt: attempt + 1, deadlineMs, toolChoice: typeof current.tool_choice === 'string' ? current.tool_choice : 'default',
        ...(repairedOption && { optionRepair: repairedOption }), ...(reasoningReplay && { reasoningReplay }),
        ...(fallbackFrom && { modelFallback: true, fallbackFrom }), category };
      recordDiagnostic({ ...timing, stage: 'model_started', elapsedMs: 0 });
      const debugDir = modelDebugDir();
      if (debugDir) { debugBodies.push({ requestId: timing.requestId, modelCallId, attempt: attempt + 1, body: current }); while (debugBodies.length > DEBUG_HISTORY) debugBodies.shift(); }
      // Each attempt gets its own full deadline: a retry after a timeout must not
      // inherit the exhausted budget of the attempt that timed out. The transport
      // combines it with the caller's signal and keeps the two distinguishable,
      // so a deadline still classifies as a timeout and never as a cancellation.
      const deadlineSignal = AbortSignal.timeout(deadlineMs);
      try {
        const result = await request('/chat/completions', { method: 'POST', body: JSON.stringify(current), deadlineSignal }, signal, timing);
        recordDiagnostic({ ...timing, stage: 'model_complete', status: 'complete', elapsedMs: now() - startedAt,
          provider: result.provider, generationId: result.id, promptTokens: result.usage?.prompt_tokens, completionTokens: result.usage?.completion_tokens, reasoningTokens: result.usage?.completion_tokens_details?.reasoning_tokens,
          ...(job && { totalMs: now() - job.task.createdAt }) });
        recordUsage(usageCost(result));
        if (debugDir && modelDebugAll()) writeModelDebug(debugDir, `${modelCallId}-${attempt + 1}-ok`,
          { requestId: timing.requestId, modelCallId, attempt: attempt + 1, status: 200, category: timing.category, model: current.model, body: current, response: result });
        return result;
      }
      catch (error) {
        recordDiagnostic({ ...timing, stage: 'model_complete', status: signal?.aborted ? 'cancelled' : 'failed', elapsedMs: now() - startedAt, httpStatus: error?.status, reason: error?.reason, requestPhase: error?.requestPhase });
        if (debugDir && (modelDebugAll() || (error?.status >= 400 && error.status < 500))) {
          const name = `${modelCallId}-${attempt + 1}`;
          writeModelDebug(debugDir, name, { requestId: timing.requestId, modelCallId, attempt: attempt + 1, status: error.status, reason: error.reason, category: timing.category, model: current.model, body: current });
          const earlier = debugBodies.filter(entry => entry.requestId === timing.requestId && entry.modelCallId !== modelCallId).slice(-DEBUG_PREVIOUS);
          earlier.forEach((entry, index) => writeModelDebug(debugDir, `${name}-prev${earlier.length - index}`, entry));
        }
        if (!(error instanceof OpenRouterError)) throw error;
        // The rejected body's shape is the only fact that explains a 4xx after
        // the fact. Roles and tool-call identities only; never any content.
        if (error.status >= 400 && error.status < 500) error.transcriptShape ??= describeTranscript(current?.messages);
        if ([400, 422].includes(error.status)) rejectedBodies.set(serialized, error);
        // A signature the provider can no longer validate — a different serving
        // endpoint, or an opaque payload it refuses — rejects the whole request
        // before any generation. Retry that one case once without replayed
        // reasoning, exactly as a history the model never reasoned over would be
        // sent. No tool response from the rejected call reached the executor,
        // and the messages, tools and authorizations are otherwise untouched.
        if (!signatureRepair && [400, 422].includes(error.status) && CORRUPTED_SIGNATURE.test(String(error.providerMessage || '')) && current.messages?.some(signedReplay)) {
          signatureRepair = true; repairedOption = 'reasoning_details';
          current = { ...current, messages: stripReasoningReplay(current.messages) }; continue;
        }
        if (!optionRepair && [400, 422].includes(error.status) && current.reasoning) {
          optionRepair = true; const { reasoning, ...plain } = current; current = plain; continue;
        }
        // A provider that rejects the strict reviewer schema must not fail the
        // request: the reply then arrives as prose and parseModelJson reads it.
        if (!formatRepair && [400, 422].includes(error.status) && current.response_format) {
          formatRepair = true; repairedOption = 'response_format'; const { response_format, ...plain } = current; current = plain; continue;
        }
        // No tool response from this model call has reached the executor. Retry
        // only a transient HTTP server failure, never a terminal action/write.
        if (!transportRetry && [502, 503, 504].includes(error.status)) {
          transportRetry = true;
          await new Promise((resolve, reject) => {
            const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Cancelled.')); };
            const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 400);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
          });
          continue;
        }
        // The primary brain is unreachable within its own deadline, or the
        // server failure survived the retry above. Nothing this request asked
        // for is wrong, so the same work is offered once to the configured
        // fallback brain. A 4xx is the request's own fault and never changes
        // model: another model would reject the same body for the same reason.
        const clientError = error.status >= 400 && error.status < 500;
        if (!fallbackFrom && !clientError && (error.category === 'timeout' || (error.status >= 500 && error.status <= 599))) {
          const fallback = getFallbackModel(current.model);
          if (fallback?.id && fallback.id !== current.model) {
            fallbackFrom = current.model;
            current = withFallbackModel(current, fallback);
            continue;
          }
        }
        throw error;
      }
    }
    throw new Error('The model rejected its supported request options.');
  }
  return { complete: completionWithFallback };
}

// A reviewer reply wrapped in a markdown code fence must parse exactly like the
// bare JSON it contains. Nothing else about a reply is loosened: prose around
// JSON, an unlabelled body or any other shape still fails as before.
function parseModelJson(content) {
  if (typeof content !== 'string') return JSON.parse(content);
  let text = content.trim();
  if (text.startsWith('```')) {
    const opening = text.match(/^```[A-Za-z0-9_+-]*[ \t]*\r?\n/);
    if (opening) text = text.slice(opening[0].length).replace(/```[\s]*$/, '').trim();
  }
  return JSON.parse(text);
}

module.exports = { createModelRuntime, parseModelJson, MODEL_DEADLINES, modelDeadlineMs };
