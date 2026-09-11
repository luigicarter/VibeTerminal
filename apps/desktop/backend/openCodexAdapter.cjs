"use strict";

const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const MAX_BYTES = 32 * 1024 * 1024;
const REASONING_PREFIX = 'lina_chat_v1:';
const uid = prefix => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
class AdapterError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function contentText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return JSON.stringify(value ?? '');
  return value.map(part => {
    if (['input_text', 'output_text', 'text'].includes(part.type)) return part.text || '';
    if (part.type === 'refusal') return part.refusal || '';
    throw new AdapterError(`The Chat Completions adapter cannot represent ${part.type} in a tool result.`);
  }).join('\n');
}
function chatContent(value) {
  if (typeof value === 'string') return value;
  return (value || []).map(part => {
    if (['input_text', 'output_text', 'text'].includes(part.type)) return { type: 'text', text: part.text || '' };
    if (part.type === 'input_image') return { type: 'image_url', image_url: { url: part.image_url, ...(part.detail && part.detail !== 'original' ? { detail: part.detail } : {}) } };
    if (part.type === 'refusal') return { type: 'text', text: part.refusal || '' };
    throw new AdapterError(`This Chat Completions provider cannot receive ${part.type}.`);
  });
}
function toolDefinitions(tools = []) {
  const definitions = [], names = new Map(), originalNames = new Map();
  function add(tool, namespace = '') {
    if (tool.type === 'namespace') { for (const inner of tool.tools || []) add(inner, `${tool.name}.`); return; }
    if (!['function', 'custom'].includes(tool.type)) throw new AdapterError(`The Chat Completions adapter does not support the ${tool.type} hosted tool.`);
    const original = namespace + tool.name;
    const name = /^[A-Za-z0-9_-]{1,64}$/.test(original) ? original : `tool_${crypto.createHash('sha256').update(original).digest('hex').slice(0,32)}`;
    if (names.has(name)) throw new AdapterError('Duplicate tool name.');
    names.set(name, { name: tool.name, namespace: namespace.slice(0,-1) || undefined, type: tool.type });
    originalNames.set(original, name);
    definitions.push({ type: 'function', function: { name, description: tool.description || '',
      parameters: tool.type === 'custom' ? { type: 'object', properties: { input: { type: 'string', description: 'The complete input to the tool.' } }, required: ['input'], additionalProperties: false }
        : tool.parameters || { type: 'object', properties: {} } } });
  }
  for (const tool of tools) add(tool);
  return { definitions, names, originalNames };
}
function toChatRequest(body, route) {
  if (body.previous_response_id || body.conversation) throw new AdapterError('Open Codex requires complete conversation history in each request.');
  const tools = toolDefinitions(body.tools);
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  let reasoning = {};
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input || [];
  for (const item of input) {
    if (item.type === 'reasoning') {
      if (typeof item.encrypted_content === 'string' && item.encrypted_content.startsWith(REASONING_PREFIX)) {
        try { reasoning = JSON.parse(Buffer.from(item.encrypted_content.slice(REASONING_PREFIX.length), 'base64url').toString()); }
        catch { throw new AdapterError('Saved provider reasoning could not be decoded.'); }
      }
      continue;
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const key = item.namespace ? `${item.namespace}.${item.name}` : item.name;
      const toolName = tools.originalNames.get(key) || key;
      const call = { id: item.call_id, type: 'function', function: { name: toolName,
        arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : item.arguments || '{}' } };
      let assistant = messages.at(-1);
      if (assistant?.role !== 'assistant') { assistant = { role: 'assistant', content: null, ...reasoning }; messages.push(assistant); reasoning = {}; }
      (assistant.tool_calls ||= []).push(call);
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: contentText(item.output) });
    } else if (item.type === 'message' || item.role) {
      if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) throw new AdapterError('Unknown conversation role.');
      const role = item.role === 'developer' ? 'system' : item.role;
      const content = chatContent(item.content);
      messages.push({ role, content: role === 'assistant' ? contentText(item.content) : content, ...(role === 'assistant' ? reasoning : {}) });
      if (role === 'assistant') reasoning = {};
    } else throw new AdapterError(`The Chat Completions adapter cannot represent ${item.type}.`);
  }
  const request = { model: route.id, messages, stream: true, stream_options: { include_usage: true } };
  if (tools.definitions.length) request.tools = tools.definitions;
  if (body.tool_choice) {
    request.tool_choice = typeof body.tool_choice === 'string' ? body.tool_choice :
      { type: 'function', function: { name: tools.originalNames.get(body.tool_choice.name) || body.tool_choice.name } };
  }
  if (route.reasoning && body.reasoning?.effort && body.reasoning.effort !== 'none') request.reasoning_effort = body.reasoning.effort;
  if (body.max_output_tokens != null) request.max_tokens = body.max_output_tokens;
  if (body.temperature != null) request.temperature = body.temperature;
  if (body.top_p != null) request.top_p = body.top_p;
  if (body.text?.format?.type === 'json_schema') {
    const { name, schema, strict } = body.text.format;
    request.response_format = { type: 'json_schema', json_schema: { name, schema, ...(strict == null ? {} : { strict }) } };
  }
  return { request, tools };
}
async function* sseData(body) {
  const decoder = new TextDecoder();
  let pending = '', data = [], bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BYTES) throw new AdapterError('Provider response exceeded the supported size.', 502);
    pending += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
      if (!line) { if (data.length) { yield data.join('\n'); data = []; } }
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  pending += decoder.decode();
  if (pending.startsWith('data:')) data.push(pending.slice(5).trimStart());
  if (data.length) yield data.join('\n');
}
async function write(response, data) {
  if (response.destroyed) throw new AdapterError('The Codex client disconnected.', 499);
  if (!response.write(data)) {
    await new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); }, closed = () => { cleanup(); reject(new AdapterError('The Codex client disconnected.', 499)); };
      const cleanup = () => { response.off('drain', done); response.off('close', closed); response.off('error', closed); };
      response.once('drain', done); response.once('close', closed); response.once('error', closed);
    });
  }
}
async function streamChat(upstream, response, body, tools) {
  const id = uid('resp'), created_at = Math.floor(Date.now()/1000);
  let sequence = 0, assistant = null, reasonItem = null, finishReason = null, usage = null;
  const output = [], calls = new Map(), details = new Map();
  let reasonText = '', reasonField = 'reasoning';
  const emit = async (type, value = {}) => write(response, `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`);
  const snapshot = (status = 'in_progress') => ({ id, object: 'response', created_at, status, model: body.model, output, error: null, incomplete_details: null });
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  await emit('response.created', { response: snapshot() });
  await emit('response.in_progress', { response: snapshot() });
  async function addItem(item) {
    const index = output.length; output.push(item);
    await emit('response.output_item.added', { output_index: index, item: { ...item } });
    return index;
  }
  async function chunk(value) {
    if (value.error) throw new AdapterError('The provider returned a streaming error.', 502);
    if (value.usage) usage = value.usage;
    const choice = value.choices?.find(row => (row.index ?? 0) === 0);
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || choice.message || {};
    const reasoning = delta.reasoning_content || delta.reasoning;
    if (delta.reasoning_content) reasonField = 'reasoning_content';
    if (reasoning || delta.reasoning_details?.length) {
      if (!reasonItem) {
        reasonItem = { type: 'reasoning', id: uid('rs'), summary: [] };
        reasonItem.index = await addItem(reasonItem);
        await emit('response.reasoning_summary_part.added', { item_id: reasonItem.id, output_index: reasonItem.index, summary_index: 0, part: { type: 'summary_text', text: '' } });
      }
      if (reasoning) {
        reasonText += reasoning;
        await emit('response.reasoning_summary_text.delta', { item_id: reasonItem.id, output_index: reasonItem.index, summary_index: 0, delta: reasoning });
      }
      for (const detail of delta.reasoning_details || []) {
        const key = detail.index ?? detail.id ?? details.size, previous = details.get(key) || {};
        const merged = { ...previous, ...detail };
        for (const field of ['text', 'data', 'signature', 'summary']) if (typeof previous[field] === 'string' && typeof detail[field] === 'string') merged[field] = previous[field] + detail[field];
        details.set(key, merged);
      }
    }
    const text = delta.content || delta.refusal;
    if (typeof text === 'string' && text) {
      if (!assistant) {
        assistant = { type: 'message', id: uid('msg'), status: 'in_progress', role: 'assistant', content: [] };
        assistant.index = await addItem(assistant);
        const part = { type: 'output_text', text: '', annotations: [] }; assistant.content.push(part);
        await emit('response.content_part.added', { item_id: assistant.id, output_index: assistant.index, content_index: 0, part });
      }
      assistant.content[0].text += text;
      await emit('response.output_text.delta', { item_id: assistant.id, output_index: assistant.index, content_index: 0, delta: text });
    }
    for (const call of delta.tool_calls || []) {
      const index = call.index ?? calls.size;
      let state = calls.get(index);
      if (!state) { state = { id: call.id || uid('call'), name: '', arguments: '' }; calls.set(index, state); }
      if (call.id) state.id = call.id;
      if (call.function?.name) state.name += call.function.name;
      if (call.function?.arguments) state.arguments += call.function.arguments;
    }
  }
  try {
    if (upstream.headers.get('content-type')?.includes('application/json')) {
      const raw = await upstream.text();
      if (raw.length > MAX_BYTES) throw new AdapterError('Provider response exceeded the supported size.', 502);
      await chunk(JSON.parse(raw));
    } else {
      for await (const data of sseData(upstream.body)) {
        if (data.trim() === '[DONE]') break;
        let value;
        try { value = JSON.parse(data); } catch { throw new AdapterError('The provider sent an invalid streaming response.', 502); }
        await chunk(value);
      }
    }
    if (!finishReason) throw new AdapterError('The provider stream ended before completing the response.', 502);
    if (!['stop', 'tool_calls', 'length', 'content_filter'].includes(finishReason)) throw new AdapterError('The provider returned an unsupported completion status.', 502);
    if (calls.size && ['length', 'content_filter'].includes(finishReason)) throw new AdapterError('The provider stopped before safely completing its tool calls.', 502);
    if (reasonItem) {
      reasonItem.summary = reasonText ? [{ type: 'summary_text', text: reasonText }] : [];
      reasonItem.encrypted_content = REASONING_PREFIX + Buffer.from(JSON.stringify({
        ...(reasonText ? { [reasonField]: reasonText } : {}),
        ...(details.size ? { reasoning_details: [...details.values()] } : {})
      })).toString('base64url');
      await emit('response.reasoning_summary_text.done', { item_id: reasonItem.id, output_index: reasonItem.index, summary_index: 0, text: reasonText });
    }
    if (assistant) {
      assistant.status = 'completed';
      await emit('response.output_text.done', { item_id: assistant.id, output_index: assistant.index, content_index: 0, text: assistant.content[0].text });
      await emit('response.content_part.done', { item_id: assistant.id, output_index: assistant.index, content_index: 0, part: assistant.content[0] });
    }
    // Hold fragmented names/arguments until complete: no partial tool can be
    // executed if a provider disconnects halfway through an argument string.
    for (const state of calls.values()) {
      const definition = tools.names.get(state.name);
      if (!definition) throw new AdapterError('The provider called a tool that was not offered.', 502);
      let args;
      try { args = JSON.parse(state.arguments || '{}'); } catch { throw new AdapterError('The provider returned incomplete tool arguments.', 502); }
      const item = definition.type === 'custom'
        ? { type: 'custom_tool_call', id: uid('ct'), call_id: state.id, name: definition.name, input: args.input, status: 'completed' }
        : { type: 'function_call', id: uid('fc'), call_id: state.id, name: definition.name, arguments: state.arguments || '{}', status: 'completed' };
      if (definition.namespace) item.namespace = definition.namespace;
      const index = await addItem({ ...item, status: 'in_progress', ...(definition.type === 'custom' ? { input: '' } : { arguments: '' }) });
      output[index] = item;
      const field = definition.type === 'custom' ? 'custom_tool_call_input' : 'function_call_arguments';
      const value = definition.type === 'custom' ? item.input : item.arguments;
      await emit(`response.${field}.delta`, { item_id: item.id, output_index: index, delta: value });
      await emit(`response.${field}.done`, { item_id: item.id, output_index: index, [definition.type === 'custom' ? 'input' : 'arguments']: value });
    }
    for (const [index, item] of output.entries()) { delete item.index; await emit('response.output_item.done', { output_index: index, item }); }
    const incomplete = ['length', 'content_filter'].includes(finishReason);
    const result = { ...snapshot(incomplete ? 'incomplete' : 'completed'),
      incomplete_details: incomplete ? { reason: finishReason === 'length' ? 'max_output_tokens' : 'content_filter' } : null,
      usage: usage ? { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0 },
        output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0 } } : null };
    await emit(incomplete ? 'response.incomplete' : 'response.completed', { response: result });
  } catch (error) {
    if (!response.destroyed) await emit('response.failed', { response: { ...snapshot('failed'), error: { code: 'provider_error', message: error instanceof AdapterError ? error.message : 'Provider stream failed.' } } });
  }
  response.end();
}
async function readBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > MAX_BYTES) throw new AdapterError('Request is too large.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AdapterError('Invalid request JSON.'); }
}
function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data));
}
async function createAdapter({ resolveModel, listModels, fetchImpl = fetch, token = crypto.randomBytes(32).toString('base64url') }) {
  const active = new Set(), protocol = new Map();
  const server = http.createServer(async (request, response) => {
    const auth = Buffer.from(request.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
    if (request.headers.origin || auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) return sendJson(response, 401, { error: { message: 'Unauthorized Open Codex client.' } });
    const controller = new AbortController(); active.add(controller);
    const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000); timer.unref?.();
    response.once('close', () => controller.abort());
    request.once('aborted', () => controller.abort());
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && pathname === '/v1/models') return sendJson(response, 200, { object: 'list', data: listModels().map(row => ({ id: row.key, object: 'model', owned_by: row.providerName })) });
      if (request.method !== 'POST' || pathname !== '/v1/responses') throw new AdapterError('Unknown Open Codex API route.', 404);
      const body = await readBody(request);
      const route = resolveModel(body.model);
      const headers = { 'Content-Type': 'application/json', ...(route.apiKey ? { Authorization: `Bearer ${route.apiKey}` } : {}) };
      const options = { method: 'POST', headers, redirect: 'error', signal: controller.signal };
      const cacheKey = `${route.baseUrl}:${route.apiMode}`;
      let mode = route.apiMode === 'auto' ? protocol.get(cacheKey) || 'responses' : route.apiMode;
      let upstream;
      if (mode === 'responses') {
        // Codex owns the history; never rely on a provider-side conversation.
        const direct = { ...body, model: route.id, store: false };
        delete direct.service_tier;
        if (!route.reasoning) delete direct.reasoning;
        upstream = await fetchImpl(`${route.baseUrl}/responses`, { ...options, body: JSON.stringify(direct) });
        if (route.apiMode === 'auto' && [404, 405, 501].includes(upstream.status)) {
          await upstream.body?.cancel(); mode = 'chat-completions'; protocol.set(cacheKey, mode);
        }
      }
      if (mode === 'chat-completions' || mode === 'anthropic') {
        const translated = toChatRequest(body, route);
        upstream = mode === 'anthropic'
          ? await require('./anthropicProtocol.cjs').fetchAnthropicAsChat(translated.request,route,options,fetchImpl)
          : await fetchImpl(`${route.baseUrl}/chat/completions`, { ...options, body: JSON.stringify(translated.request) });
        if (!upstream.ok) { await upstream.body?.cancel(); throw new AdapterError(`The provider returned HTTP ${upstream.status}. Check its URL, key, model, and API format in Models & providers settings.`, upstream.status); }
        await streamChat(upstream, response, body, translated.tools);
      } else {
        if (!upstream.ok) { await upstream.body?.cancel(); throw new AdapterError(`The provider returned HTTP ${upstream.status}. Check its URL, key, model, and API format in Models & providers settings.`, upstream.status); }
        response.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-cache' });
        let size = 0;
        for await (const chunk of upstream.body) { size += chunk.byteLength; if (size > MAX_BYTES) throw new AdapterError('Provider response exceeded the supported size.', 502); await write(response, chunk); }
        response.end();
      }
    } catch (error) {
      if (!response.destroyed && !response.headersSent) sendJson(response, error.status || 502, { error: { type: 'open_codex_error', message: error instanceof AdapterError || /^This model is no longer|^The saved key/.test(error.message) ? error.message : 'Open Codex could not reach the configured provider.' } });
      else if (!response.destroyed) response.destroy();
    } finally { clearTimeout(timer); active.delete(controller); }
  });
  server.requestTimeout = 600000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, token,
    close: () => { for (const controller of active) controller.abort(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createAdapter, toChatRequest, toolDefinitions, sseData, AdapterError };
