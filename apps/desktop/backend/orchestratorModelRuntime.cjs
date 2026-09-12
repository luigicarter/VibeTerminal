'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { OpenRouterError } = require('./openRouterErrors.cjs');
const usageCost = response => Number.isFinite(response?.usage?.cost) && response.usage.cost > 0 ? response.usage.cost : 0;

// Diagnostics only, and off unless LINA_MODEL_DEBUG_DIR names a directory: no
// body is retained and no file is written without it. When it is set, the exact
// request body of a model call the provider rejects with HTTP 4xx is written to
// <dir>/<modelCallId>-<attempt>.json, together with the few immediately earlier
// bodies of the same request (…-prev<n>.json) so a rejected replayed history can
// be compared with the one the provider accepted. A completion body carries no
// API key; any key-shaped string is redacted anyway.
const DEBUG_HISTORY = 8, DEBUG_PREVIOUS = 3;
const modelDebugDir = () => { const dir = process.env.LINA_MODEL_DEBUG_DIR; return typeof dir === 'string' && dir.trim() ? dir.trim() : ''; };
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

// Owns transport recovery, cost accounting and model-call diagnostics for every
// harness stage. Callers never charge the same response a second time.
function createModelRuntime({ request, getContext, assertBudget, recordUsage, recordDiagnostic, now = Date.now }) {
  const debugBodies = [];
  // A provider that rejects the reasoning parameter must not fail the whole request.
  async function completionWithFallback(body, signal, options = {}) {
    if (signal?.aborted) throw new Error('Cancelled.');
    assertBudget();
    const aligned = alignReasoningReplay(body?.messages);
    let current = aligned === body?.messages ? body : { ...body, messages: aligned },
      optionRepair = false, formatRepair = false, transportRetry = false, signatureRepair = false, repairedOption;
    const reasoningReplay = current === body ? undefined : 'aligned';
    // One attempt plus every single-shot repair below: three rejections in a row
    // must not exhaust the loop before the fully repaired request is ever sent.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (signal?.aborted) throw new Error('Cancelled.');
      assertBudget();
      const startedAt = now(), modelCallId = randomUUID(), job = getContext();
      const timing = { event: 'request_stage', requestId: job?.task.requestId, origin: job?.input.origin,
        modelCallId, model: current.model, attempt: attempt + 1, deadlineMs: 45000, toolChoice: typeof current.tool_choice === 'string' ? current.tool_choice : 'default',
        ...(repairedOption && { optionRepair: repairedOption }), ...(reasoningReplay && { reasoningReplay }),
        category: options.category || (current.tools?.[0]?.function?.name === 'interpret_workspace' ? 'interpretation' : current.tools?.length ? 'execution' : 'summary') };
      recordDiagnostic({ ...timing, stage: 'model_started', elapsedMs: 0 });
      const debugDir = modelDebugDir();
      if (debugDir) { debugBodies.push({ requestId: timing.requestId, modelCallId, attempt: attempt + 1, body: current }); while (debugBodies.length > DEBUG_HISTORY) debugBodies.shift(); }
      try {
        const result = await request('/chat/completions', { method: 'POST', body: JSON.stringify(current) }, signal, timing);
        recordDiagnostic({ ...timing, stage: 'model_complete', status: 'complete', elapsedMs: now() - startedAt,
          provider: result.provider, generationId: result.id, promptTokens: result.usage?.prompt_tokens, completionTokens: result.usage?.completion_tokens, reasoningTokens: result.usage?.completion_tokens_details?.reasoning_tokens,
          ...(job && { totalMs: now() - job.task.createdAt }) });
        recordUsage(usageCost(result));
        return result;
      }
      catch (error) {
        recordDiagnostic({ ...timing, stage: 'model_complete', status: signal?.aborted ? 'cancelled' : 'failed', elapsedMs: now() - startedAt, httpStatus: error?.status, reason: error?.reason, requestPhase: error?.requestPhase });
        if (debugDir && error?.status >= 400 && error.status < 500) {
          const name = `${modelCallId}-${attempt + 1}`;
          writeModelDebug(debugDir, name, { requestId: timing.requestId, modelCallId, attempt: attempt + 1, status: error.status, reason: error.reason, category: timing.category, model: current.model, body: current });
          const earlier = debugBodies.filter(entry => entry.requestId === timing.requestId && entry.modelCallId !== modelCallId).slice(-DEBUG_PREVIOUS);
          earlier.forEach((entry, index) => writeModelDebug(debugDir, `${name}-prev${earlier.length - index}`, entry));
        }
        if (!(error instanceof OpenRouterError)) throw error;
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

module.exports = { createModelRuntime, parseModelJson };
