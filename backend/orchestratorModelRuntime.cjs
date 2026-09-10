'use strict';
const { randomUUID } = require('node:crypto');
const { OpenRouterError } = require('./openRouterErrors.cjs');
const usageCost = response => Number.isFinite(response?.usage?.cost) && response.usage.cost > 0 ? response.usage.cost : 0;

// Owns transport recovery, cost accounting and model-call diagnostics for every
// harness stage. Callers never charge the same response a second time.
function createModelRuntime({ request, getContext, assertBudget, recordUsage, recordDiagnostic, now = Date.now }) {
  // A provider that rejects the reasoning parameter must not fail the whole request.
  async function completionWithFallback(body, signal, options = {}) {
    if (signal?.aborted) throw new Error('Cancelled.');
    assertBudget();
    let current = body, optionRepair = false, transportRetry = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) throw new Error('Cancelled.');
      assertBudget();
      const startedAt = now(), modelCallId = randomUUID(), job = getContext();
      const timing = { event: 'request_stage', requestId: job?.task.requestId, origin: job?.input.origin,
        modelCallId, model: current.model, attempt: attempt + 1, deadlineMs: 45000, toolChoice: typeof current.tool_choice === 'string' ? current.tool_choice : 'default',
        category: options.category || (current.tools?.[0]?.function?.name === 'interpret_workspace' ? 'interpretation' : current.tools?.length ? 'execution' : 'summary') };
      recordDiagnostic({ ...timing, stage: 'model_started', elapsedMs: 0 });
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
        if (!(error instanceof OpenRouterError)) throw error;
        if (!optionRepair && [400, 422].includes(error.status) && current.reasoning) {
          optionRepair = true; const { reasoning, ...plain } = current; current = plain; continue;
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

module.exports = { createModelRuntime };
