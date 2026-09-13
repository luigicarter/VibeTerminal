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
    // A nameless call cannot be executed and cannot be replayed as history
    // either. Refuse the batch here, while the cause is still the model's.
    if (typeof call.function?.name !== 'string' || !call.function.name) {
      throw new Error('The model returned a tool call without a function name. No action from this batch was dispatched.');
    }
    ids.add(call.id);
  }
  // Replayed history is ours once we write it: a provider that omitted the
  // OpenAI-compatible call type must not leave the next request malformed.
  conversation.push({ role: 'assistant', content: reply.content || null,
    tool_calls: calls.map(call => call.type === 'function' ? call : { ...call, type: 'function' }),
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

// Every assistant turn is now the model's own: the application performs its
// handoff and its direct grants in code and reports back in user-role messages.
// The replay above is still ours to get right, though — Google rejects a
// transcript whose assistant tool calls omit `type: "function"`, or whose tool
// result answers no preceding call, with HTTP 400 "The conversation transcript
// is malformed", losing the whole request and telling the user to check their
// model and settings for what is an application bug. Refuse such a transcript
// here instead, with an error that names itself as ours.
function assertTranscriptShape(messages) {
  const bug = detail => new Error(`Lina Terminal bug: model transcript is malformed. ${detail}`);
  if (!Array.isArray(messages)) throw bug('The request carries no message list.');
  const called = new Set();
  messages.forEach((message, index) => {
    if (!message || typeof message !== 'object') throw bug(`Message ${index} is not a message object.`);
    if (message.role === 'assistant' && message.tool_calls != null) {
      if (!Array.isArray(message.tool_calls)) throw bug(`Assistant message ${index} has a non-list tool_calls field.`);
      for (const call of message.tool_calls) {
        if (typeof call?.id !== 'string' || !call.id) throw bug(`Assistant message ${index} has a tool call without an id.`);
        if (call.type !== 'function') throw bug(`Tool call ${call.id} has no type "function".`);
        if (typeof call.function?.name !== 'string' || !call.function.name) throw bug(`Tool call ${call.id} has no function name.`);
        called.add(call.id);
      }
    }
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) throw bug(`Tool message ${index} has no tool_call_id.`);
      if (!called.has(message.tool_call_id)) throw bug(`Tool message ${index} answers no preceding tool call (${message.tool_call_id}).`);
    }
  });
  return messages;
}

// Diagnostics for a rejected request: roles and tool-call identities only, so a
// 4xx can be read back without ever retaining instruction or terminal content.
function describeTranscript(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(0, 60).map(message => ({ role: typeof message?.role === 'string' ? message.role : 'unknown',
    ...(Array.isArray(message?.tool_calls) && { toolCalls: message.tool_calls.slice(0, 8).map(call => ({ id: typeof call?.id === 'string' ? call.id.slice(0, 120) : null,
      type: typeof call?.type === 'string' ? call.type : null, name: typeof call?.function?.name === 'string' ? call.function.name.slice(0, 80) : null })) }),
    ...(typeof message?.tool_call_id === 'string' && { toolCallId: message.tool_call_id.slice(0, 120) }) }));
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

module.exports = { executeToolBatch, createHarnessProgress, assertTranscriptShape, describeTranscript };
