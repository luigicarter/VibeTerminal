'use strict';
const { createHash } = require('node:crypto');

// Owns model/tool protocol, not action authority. execute must go through the
// application's grant, identity, observation and receipt validators.
async function executeToolBatch({ reply, conversation, execute, onResult, canContinue,
  checkActive, formatResult, maxCalls = 6, now = Date.now, toolAliases }) {
  const calls = reply.tool_calls;
  if (!Array.isArray(calls) || !calls.length || calls.length > maxCalls) throw new Error('Too many actions requested.');
  const ids = new Set();
  for (const call of calls) {
    if (typeof call?.id !== 'string' || !call.id || call.id.length > 256 || ids.has(call.id)) {
      throw new Error('The model returned missing or duplicate tool-call identities. No action from this batch was dispatched.');
    }
    ids.add(call.id);
  }
  conversation.push({ role: 'assistant', content: reply.content || null, tool_calls: calls,
    ...(reply.reasoning_details && { reasoning_details: structuredClone(reply.reasoning_details) }) });
  const results = [];
  for (const call of calls) {
    checkActive();
    if (!canContinue()) {
      conversation.push({ role: 'tool', tool_call_id: call.id, content: formatResult({ ok: false,
        status: 'skipped', delivery: 'not-dispatched',
        error: 'Not executed because an earlier call ended this batch with a response or clarification. Request it again only if still authorized after continuation.' }) });
      continue;
    }
    const startedAt = now();
    let args, result, error;
    try {
      const name = call.function?.name;
      const aliased = toolAliases && Object.hasOwn(toolAliases, name) ? toolAliases[name] : undefined;
      if (name !== 'workspace' && !aliased) throw new Error('Unknown tool.');
      try { args = JSON.parse(call.function.arguments); }
      catch { throw new SyntaxError('Invalid workspace tool arguments JSON.'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Workspace tool arguments must be an object.');
      if (aliased) {
        if (args.kind !== undefined && args.kind !== aliased) throw new Error('The tool name and operation disagree.');
        args = { ...args, kind: aliased };
      }
      result = await execute(args, call);
    } catch (failure) {
      checkActive();
      error = failure;
      result = { ok: false, status: 'rejected', validationFailure: true, error: String(failure?.message || 'Tool execution failed.').slice(0, 1000) };
    }
    checkActive();
    await onResult({ args, result, error, call, startedAt, elapsedMs: now() - startedAt });
    results.push({ args, result });
    conversation.push({ role: 'tool', tool_call_id: call.id, content: formatResult(result) });
  }
  return results;
}

const volatile = new Set(['observationToken', 'stepId', 'actionId', 'requestId', 'toolCallId', 'grantId',
  'at', 'timestamp', 'lastActivityAt', 'observedAt', 'updatedAt', 'sequence', 'observationSequence', 'inputRevision',
  'steps', 'remainingSteps', 'readBudgetRemainingBytes']);
function stableEvidence(value) {
  if (Array.isArray(value)) return value.map(stableEvidence);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => !volatile.has(key)).map(key => [key, stableEvidence(value[key])]));
}
function createHarnessProgress({ maxStagnantRounds = 6 } = {}) {
  const seen = new Set();
  let stagnantRounds = 0;
  return {
    observe(results, progress) {
      let changed = false;
      for (const item of [...results, { progress }]) {
        const digest = createHash('sha256').update(JSON.stringify(stableEvidence(item))).digest('hex');
        if (!seen.has(digest)) { changed = true; seen.add(digest); }
      }
      while (seen.size > 512) seen.delete(seen.values().next().value);
      stagnantRounds = changed ? 0 : stagnantRounds + 1;
      return { changed, stagnantRounds, warn: stagnantRounds === 3, blocked: stagnantRounds >= maxStagnantRounds };
    },
  };
}

module.exports = { executeToolBatch, createHarnessProgress };
