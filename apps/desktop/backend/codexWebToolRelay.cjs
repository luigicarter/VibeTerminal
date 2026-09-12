'use strict';
// Converts the Web model's structured answer into native Codex tool events.
// This module never executes tools or owns a conversation/approval loop.
const { createHash } = require('node:crypto');
const { accountSelection } = require('./codexWebModelDiscovery.cjs');
const nameOf = tool => tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function roundToken(parsed) {
  return createHash('sha256').update(JSON.stringify([parsed.modelId, parsed._rawBody?.input || parsed.context.messages, parsed.context.tools, parsed.options.toolChoice])).digest('hex').slice(0, 24);
}
function availableTools(parsed) {
  const choice = parsed.options.toolChoice;
  if (choice === 'none' || parsed._compactionRequest) return [];
  return (parsed.context.tools || []).filter(tool => {
    const name = nameOf(tool);
    if (object(choice) && typeof choice.name === 'string') return choice.name === name || choice.name === tool.name;
    if (object(choice) && Array.isArray(choice.allowedTools)) return choice.allowedTools.includes(name) || choice.allowedTools.includes(tool.name);
    return true;
  });
}
function toolContract(parsed) {
  const tools = availableTools(parsed), imageTool = tools.find(tool => tool.name === 'generate_image' && /lina_images/.test(nameOf(tool)));
  const selection = accountSelection(parsed.modelId, parsed.options.reasoning);
  const modelGuidance = selection ? [
    '<lina_model_selection>',
    JSON.stringify(selection),
    '</lina_model_selection>',
    'This metadata identifies the model and reasoning effort selected for the current native Codex request. For a model-identity question, report this current selection in plain language, for example: "This session is set to <name> (<reasoning_effort> reasoning)." Do not infer the current selection from an earlier assistant reply, an old model name in the task history, or a remembered default identity.',
    'The bridge requires the outgoing ChatGPT request to match this selection. This verifies the requested model, not the identity of the server that generated the answer. Do not claim independent backend verification or a fallback to another model without evidence. If asked to verify the actual backend model, explain that limitation. Mention model-selection metadata only when relevant to the user\'s question.',
  ] : [];
  const editingGuidance = tools.some(tool => tool.name === 'apply_patch') ? [
    'For an existing file, use apply_patch Update File hunks with enough matching context. Do not delete a file just to recreate it in a later call. After a rejected patch, correct its format or context without first deleting the file. Preserve unrelated edits.',
    'File edits belong in native tool calls. Let Codex display their native diffs; do not repeat whole files, patches, tool arguments, or tool results as chat prose unless the user asks to see them. Keep progress and completion messages concise and distinguish static checks from successful browser or runtime verification.',
  ] : [];
  const imageGuidance = imageTool ? [`Image generation and reference-image editing are available through the native tool ${nameOf(imageTool)}. For a picture request, call that tool using the protocol below. It opens its own regular ChatGPT image chat and saves the image locally, even though this conversation uses Temporary Chat. Do not tell the user to switch chats or supply only an image prompt instead of using this available tool.`]
    : tools.some(tool => tool.name === 'tool_search') ? ['Some native tools are discoverable with tool_search. Search for generate_image before deciding image generation is unavailable. Temporary Chat limitations apply to its built-in tools, not to the external native tool inventory.'] : [];
  if (parsed._linaResume) return [
    'Continue the same native Codex task. Only new messages/results follow; earlier instructions and the tool inventory remain in this conversation.',
    ...modelGuidance,
    'Answer normally in Markdown. For local tool calls, start with LINA-TOOL-CALL: ' + roundToken(parsed) + ' and then a fenced JSON block {"codex_web":1,"round":"' + roundToken(parsed) + '","calls":[{"name":"exact_inventory_name","arguments":{}}],"answer":null}.',
    'Use the actual native tool results as evidence, respect permission denials, and finish the task before giving its final answer.',
    'A native browser security-policy rejection is not a connection error. Never rehost the blocked page, switch browser surfaces, or use shell/CDP to perform the rejected browser action. Explain the blocked verification and continue only with independent allowed work.',
    ...imageGuidance,
    ...editingGuidance,
  ];
  return [
    'The native Codex CLI on the user\'s computer is connected to this response. It executes local tools, enforces its configured permissions and returns tool results in the next request.',
    ...modelGuidance,
    'For local work, select tools from the exact inventory below. Return tool requests using this JSON response protocol; do not use a ChatGPT connector or claim that local access is unavailable.',
    'For an ordinary final reply, answer directly in Markdown or the requested output format. Do not wrap ordinary replies in transport JSON.',
    'Only when requesting local tools, start with LINA-TOOL-CALL: ' + roundToken(parsed) + ' on its own line, then one fenced ```json code block containing {"codex_web":1,"round":"' + roundToken(parsed) + '","calls":[{"name":"exact_inventory_name","arguments":{}}],"answer":null}.',
    'A tool response must contain one or more calls and answer:null, with no other prose. The code fence preserves literal JSON. Escape quotes, backslashes and newlines inside JSON strings, including HTML attributes and patch input.',
    'Use only declared tool names and their schemas. For a freeform tool such as apply_patch, put its complete literal input in arguments.input. Never invent tool results or claim completion before the native tool results confirm it.',
    'The native CLI will invoke another model round with the results. Continue the task from those results until it is complete. A denied call is a real permission decision and must not be bypassed.',
    'A native browser security-policy rejection is not a connection error. Never rehost the blocked page, switch browser surfaces, or use shell/CDP to perform the rejected browser action. Explain the blocked verification and continue only with independent allowed work.',
    'Keep transport fields out of user-facing replies. Use ChatGPT-native capabilities when appropriate; local actions use the declared native inventory.',
    ...imageGuidance,
    ...editingGuidance,
    '<native_codex_tool_inventory>',
    JSON.stringify(tools.map(tool => ({ name: nameOf(tool), description: tool.description, parameters: tool.parameters, ...(tool.freeform ? { freeform: true, ...(tool.format ? { format: tool.format } : {}) } : {}) }))),
    '</native_codex_tool_inventory>',
  ];
}
function nativeBrowserPolicyDenied(parsed) {
  const messages = parsed.context.messages || [];
  const lastUser = messages.findLastIndex(message => message.role === 'user');
  return messages.slice(lastUser + 1).some(message => {
    if (message.role !== 'toolResult' || message.toolNamespace !== 'mcp__cua_repl' || message.toolName !== 'js') return false;
    const blocks = typeof message.content === 'string' ? [message.content] : (message.content || []).filter(part => part.type === 'text').map(part => part.text);
    return blocks.some(text => /^(?:Wall time:[^\n]*\nOutput:\s*)?Browser Use rejected this action due to browser security policy\./.test(text.trim()));
  });
}
function decodeAnswer(text, parsed, validateFinal) {
  let value;
  const marker = /^\s*LINA-TOOL-CALL:\s*([^\s]+)\s*\n/.exec(text);
  if (marker) { if (marker[1] !== roundToken(parsed)) throw new Error('invalid_tool_response'); text = text.slice(marker[0].length); }
  // ChatGPT's rendered code block can expose its language label as a separate
  // "JSON" heading. Accept only that exact wrapper, never arbitrary prose.
  const trimmed = text.trim(), fenced = /^(?:json\s*\n+)?```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  try { value = JSON.parse(fenced ? fenced[1] : trimmed); } catch { throw new Error('tool_response_not_json'); }
  if (!object(value) || value.codex_web !== 1 || value.round !== roundToken(parsed) || !Array.isArray(value.calls) || value.calls.length > 16) throw new Error('invalid_tool_response');
  if (!value.calls.length) {
    if (typeof value.answer !== 'string') throw new Error('invalid_tool_response');
    const choice = parsed.options.toolChoice;
    if (choice === 'required' || (object(choice) && (choice.name || choice.mode === 'required'))) throw new Error('required_tool_missing');
    validateFinal?.(value.answer);
    return [{ type: 'text_delta', text: value.answer, phase: 'final_answer' }];
  }
  if (value.answer !== null) throw new Error('invalid_tool_response');
  const tools = new Map(availableTools(parsed).map(tool => [nameOf(tool), tool]));
  // Validate the complete batch before returning any executable event.
  for (const call of value.calls) {
    const tool = object(call) && tools.get(call.name);
    if (!tool || !object(call.arguments) || (tool.freeform && typeof call.arguments.input !== 'string')) throw new Error('invalid_tool_response');
  }
  return value.calls.flatMap((call, index) => [
    { type: 'tool_call_start', id: `call_lina_${roundToken(parsed)}_${index}`, name: call.name },
    { type: 'tool_call_delta', arguments: JSON.stringify(call.arguments) },
    { type: 'tool_call_end' },
  ]);
}
function responseKind(text) {
  const start = text.trimStart();
  if (!start || 'LINA-TOOL-CALL:'.startsWith(start)) return 'pending';
  if (start.startsWith('LINA-TOOL-CALL:')) return 'tools';
  // Retain compatibility with previously prompted JSON envelopes, without
  // delaying normal prose or code after its first token is distinguishable.
  let raw = start;
  if ('```'.startsWith(raw) || /^JSON\s*$/i.test(raw)) return 'pending';
  if (/^(?:JSON\s*\n+)?```/i.test(raw) || 'JSON'.startsWith(raw)) {
    const fence = /^(?:JSON\s*\n+)?```([^\n]*)\n/i.exec(raw);
    if (!fence) return 'pending';
    if (fence[1].trim() && fence[1].trim().toLowerCase() !== 'json') return 'text';
    raw = raw.slice(fence[0].length).trimStart();
  }
  if (raw.startsWith('{')) {
    const firstKey = /^\{\s*"([^"]*)"\s*:/.exec(raw);
    if (!firstKey) return raw.length < 128 ? 'pending' : 'text';
    return firstKey[1] === 'codex_web' ? 'tools' : 'text';
  }
  return 'text';
}
function recordTiming(parsed, fields) {
  if (!process.env.CODEX_CHATGPT_WEB_HOME) return;
  try {
    const fs = require('node:fs'), path = require('node:path');
    const directory = path.join(process.env.CODEX_CHATGPT_WEB_HOME, 'logs'), file = path.join(directory, 'lina-response-timing.jsonl');
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1048576) { if (fs.existsSync(file + '.1')) fs.unlinkSync(file + '.1'); fs.renameSync(file, file + '.1'); }
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), round: roundToken(parsed), model: parsed.modelId, inputChars: JSON.stringify(parsed._rawBody?.input || []).length, ...fields }) + '\n', { mode: 0o600 });
  } catch { /* Diagnostics must not alter a completed response. */ }
}
function createToolRelay(adapter, createFinalValidator) {
  if (!process.env.LINA_CODEX_WEB_HOST_MODULE) return adapter;
  return { name: adapter.name, async runTurn(parsed, incoming, emit) {
    if (parsed._compactionRequest) return adapter.runTurn(parsed, incoming, emit);
    if (nativeBrowserPolicyDenied(parsed)) {
      emit({ type: 'error', message: 'Browser Use blocked this action under its URL security policy. This turn has stopped; the blocked browser action must not be retried through rehosting or another browser surface. You can continue with static checks or a supported target. Files already written and local history are kept.', status: 400, errorType: 'invalid_request_error', code: 'native_browser_policy_denied', retryable: false });
      return;
    }
    const lastUser = parsed.context.messages.findLast(message => message.role === 'user');
    if (Array.isArray(lastUser?.content) && lastUser.content.filter(part => part.type === 'image').length > 10) {
      emit({ type: 'error', message: 'Codex Web can attach at most 10 images to a Web request. Remove images from this prompt and retry, or split them into smaller requests. No Web request was sent.', status: 400, errorType: 'invalid_request_error', code: 'image_input_limit', retryable: false });
      return;
    }
    let answer = '', failed = false, kind = 'pending', emitted = 0, firstTextMs;
    const began = Date.now();
    const validateFinal = createFinalValidator?.(parsed.options.outputFormat);
    const choice = parsed.options.toolChoice, toolRequired = choice === 'required' || (object(choice) && (choice.name || choice.mode === 'required'));
    const streamText = () => {
      if (validateFinal || toolRequired || answer.length === emitted || incoming.abortSignal?.aborted) return;
      firstTextMs ??= Date.now() - began;
      emit({ type: 'text_delta', text: answer.slice(emitted), phase: 'final_answer' }); emitted = answer.length;
    };
    await adapter.runTurn(parsed, incoming, event => {
      if (failed) return;
      if (event.type === 'text_delta' && event.phase !== 'commentary') {
        answer += event.text; if (kind === 'pending') kind = responseKind(answer);
        if (kind === 'text') streamText(); return;
      }
      if (event.type === 'done') {
        if (incoming.abortSignal?.aborted) return;
        try {
          const decoded = kind === 'tools' ? decodeAnswer(answer, parsed, validateFinal) : null;
          if (decoded) for (const output of decoded) emit(output);
          else {
            const choice = parsed.options.toolChoice;
            if (choice === 'required' || (object(choice) && (choice.name || choice.mode === 'required'))) throw new Error('required_tool_missing');
            validateFinal?.(answer);
            if (validateFinal) { firstTextMs ??= Date.now() - began; emit({ type: 'text_delta', text: answer, phase: 'final_answer' }); } else streamText();
          }
          const count = decoded?.filter(output => output.type === 'tool_call_start').length || 0, tools = count > 0;
          recordTiming(parsed, { firstTextMs: firstTextMs ?? null, totalMs: Date.now() - began, toolCalls: count, outputChars: answer.length });
          emit({ ...event, stopReason: tools ? 'tool_use' : 'stop', endTurn: !tools });
        } catch {
          failed = true;
          emit({ type: 'error', message: 'ChatGPT did not return a valid native tool response. No tool from that response was run. Retry the turn.', status: 400, errorType: 'invalid_request_error', code: 'invalid_tool_response', retryable: false });
        }
        return;
      }
      if (event.type === 'error' || event.type === 'incomplete') failed = true;
      emit(event);
    });
  } };
}
module.exports = { roundToken, availableTools, toolContract, decodeAnswer, createToolRelay, responseKind, nativeBrowserPolicyDenied };
