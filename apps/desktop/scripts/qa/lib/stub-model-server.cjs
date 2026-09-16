'use strict';
// One local model server for the provider panes a QA harness opens, so a pane
// turn costs nothing and behaves the same way every run.
//
// It speaks the three wire formats the panes this repo can launch actually use:
//   POST /v1/responses          OpenAI Responses SSE   (stock `codex`, `codex` TUI)
//   POST /v1/chat/completions   OpenAI chat SSE        (`open-codex` upstream, generic)
//   POST /v1/messages           Anthropic Messages SSE (stock `claude`, `claude-custom`)
// plus the small read endpoints those CLIs probe (`/v1/models`,
// `/v1/messages/count_tokens`).
//
// The behaviour of a turn is chosen from the prompt the pane was given, never
// from a clock or a request counter, so a scenario states what it wants where
// it types it:
//   [stub:reply:MARKER]  finish at once; MARKER is printed in the reply text
//   [stub:slow:SECONDS]  hold the turn open; the pane reads as working
//   [stub:ask]           call a shell/Bash tool, so the pane parks on its own
//                        approval prompt and reads as needing input
// A prompt with no tag takes the default behaviour (a fast reply). Rules may
// also be registered for prompts whose wording the harness does not control.
//
// Boundary: this is a fixture, not a model. It never reaches the network, it
// holds no credentials, and every frame it writes is listed in `requests`.
const http = require('node:http');
const crypto = require('node:crypto');

const TAG = /\[stub:([a-z]+)(?::([^\]]*))?\]/gi;
const ASK_LIMIT = 4;
const ASK_AUTO_RESOLUTION_MS = 1800000;
const DEFAULT_REPLY = 'Stub provider turn complete.';
const uid = prefix => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const sse = response => (event, value) =>
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);

// Every user-authored string in a request, whatever the wire format calls it.
function promptText(body) {
  const parts = [];
  const push = value => { if (typeof value === 'string' && value.trim()) parts.push(value); };
  const content = value => {
    if (typeof value === 'string') return push(value);
    for (const part of Array.isArray(value) ? value : []) push(part?.text ?? part?.input_text);
  };
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (item?.role === 'user' || item?.type === 'message' && item?.role === 'user') content(item.content);
    else if (typeof item?.text === 'string' && item?.role === 'user') push(item.text);
  }
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role === 'user') content(message.content);
  }
  return parts.join('\n');
}

// The LAST tag in the transcript wins. Every native CLI resends its whole
// conversation each turn, so an earlier turn's tag is still in the payload; only
// the newest user message describes the turn being asked for now.
function parseBehaviour(text, { rules, fallback }) {
  const tag = [...String(text || '').matchAll(TAG)].at(-1);
  if (tag) {
    const kind = tag[1].toLowerCase(), argument = (tag[2] || '').trim();
    if (kind === 'slow') return { kind: 'slow', seconds: Number(argument) > 0 ? Number(argument) : 60 };
    if (kind === 'ask') return { kind: 'ask', command: argument || 'git status' };
    if (kind === 'reply') return { kind: 'reply', marker: argument || '' };
  }
  for (const rule of rules) {
    const matched = rule.match instanceof RegExp ? rule.match.test(text || '') : String(text || '').includes(rule.match);
    if (matched) return rule.behaviour;
  }
  return fallback;
}

// The side call a CLI makes to name its own conversation is what gives a pane
// its title, and a pane's title is how a person refers to it ("the agent working
// on the chat section"). Answering every one of them with the same sentence
// would leave a workspace of identically named panes, so the answer is the last
// thing the user actually asked for, minus the harness's own tag.
function sideAnswer(prompt) {
  const last = String(prompt || '').split('\n').filter(line => line.trim()).at(-1) || '';
  const cleaned = last.replace(TAG, '').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.split(' ').slice(0, 8).join(' ').replace(/[.,;:]+$/, '') : 'Stub side call';
}

// A finished turn reads like one: the marker the harness looks for, then one
// line saying what was done. A reply that is only a marker made the Brain's
// own finish judgement call the work "blocked" for lack of any evidence.
const replyText = behaviour => behaviour.marker
  ? DEFAULT_REPLY + ' ' + behaviour.marker + (behaviour.done ? '\nDone: ' + behaviour.done : '')
  : behaviour.text || DEFAULT_REPLY;
function taskSummary(prompt) {
  const last = String(prompt || '').replace(TAG, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || '';
  return last.split(/(?<=[.!?])\s/)[0].slice(0, 160);
}

// A held turn ends on its own deadline, when the harness releases it, or when
// the pane disconnects. Nothing here may outlive the server.
function hold(record, seconds) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { record.release(); }, Math.max(0, seconds) * 1000);
    record.release = () => { clearTimeout(timer); record.release = () => {}; resolve(); };
  });
}

function toolNamed(tools, pattern) {
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = tool?.name || tool?.function?.name;
    if (typeof name === 'string' && pattern.test(name)) return { ...tool, name };
  }
  return null;
}

// What an `ask` turn calls, chosen from what the pane actually offered.
//
// Codex 0.154 answers a shell call by running it and coming straight back for
// another one, so a shell call is an infinite loop, not a question: its own
// `request_user_input` tool is the thing that parks the pane on a prompt the
// user has to answer. Claude has no such tool on its default surface, but its
// permission gate on `Bash` parks the pane the same way. Anything else offering
// only a shell falls back to a command that asks to escalate out of its sandbox.
function askCall(tools, behaviour) {
  const ask = toolNamed(tools, /^(?:request_user_input|AskUserQuestion)$/i);
  // Codex resolves a question by itself once `autoResolutionMs` elapses (and at
  // once when the field is absent), so a pane that must stay parked has to name
  // a deadline longer than the scenario.
  if (ask) return { name: ask.name, arguments: JSON.stringify({ autoResolutionMs: ASK_AUTO_RESOLUTION_MS,
    questions: [{ id: 'stub_confirm', header: 'Confirm',
      question: behaviour.question || 'Should I go ahead with this?', multiSelect: false,
      options: [{ label: 'Yes', description: 'Continue.' }, { label: 'No', description: 'Stop here.' }] }] }) };
  const bash = toolNamed(tools, /^bash$/i);
  if (bash) return { name: bash.name, arguments: JSON.stringify({ command: behaviour.command, description: 'Stub approval fixture' }) };
  const shell = toolNamed(tools, /^(?:shell|local_shell|exec_command)$/i);
  if (shell) return { name: shell.name, arguments: JSON.stringify({ command: ['bash', '-lc', behaviour.command],
    cmd: behaviour.command, with_escalated_permissions: true, justification: 'Stub approval fixture' }) };
  return null;
}

// ---------------------------------------------------------------- Responses
// The frame order a Codex TUI turn needs, in the order backend/openCodexAdapter
// emits it for real providers: created, in_progress, the item and its parts,
// then output_item.done and response.completed. Anything short of completed
// leaves the pane's turn open, which is exactly what `slow` wants.
async function respondResponses(request, response, body, behaviour, record, keepAlive) {
  const id = uid('resp'), created_at = Math.floor(Date.now() / 1000);
  let sequence = 0;
  const output = [];
  const emit = (type, value = {}) => sse(response)(type, { type, sequence_number: sequence++, ...value });
  const snapshot = (status = 'in_progress') =>
    ({ id, object: 'response', created_at, status, model: body.model, output, error: null, incomplete_details: null });
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  emit('response.created', { response: snapshot() });
  emit('response.in_progress', { response: snapshot() });
  if (behaviour.kind === 'slow') { await keepAlive(hold(record, behaviour.seconds)); }
  if (behaviour.kind === 'ask') {
    const chosen = askCall(body.tools, behaviour);
    if (chosen) {
      const call = { type: 'function_call', id: uid('fc'), call_id: uid('call'),
        name: chosen.name, arguments: chosen.arguments, status: 'completed' };
      output.push(call);
      emit('response.output_item.added', { output_index: 0, item: { ...call, arguments: '' } });
      emit('response.function_call_arguments.delta', { item_id: call.id, output_index: 0, delta: call.arguments });
      emit('response.function_call_arguments.done', { item_id: call.id, output_index: 0, arguments: call.arguments });
      emit('response.output_item.done', { output_index: 0, item: call });
      emit('response.completed', { response: { ...snapshot('completed'), usage: usageResponses() } });
      response.end();
      return;
    }
  }
  const text = replyText(behaviour);
  const item = { type: 'message', id: uid('msg'), status: 'in_progress', role: 'assistant', content: [] };
  output.push(item);
  emit('response.output_item.added', { output_index: 0, item: { ...item } });
  const part = { type: 'output_text', text: '', annotations: [] };
  item.content.push(part);
  emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part });
  part.text = text;
  emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
  emit('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
  emit('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part });
  item.status = 'completed';
  emit('response.output_item.done', { output_index: 0, item });
  emit('response.completed', { response: { ...snapshot('completed'), usage: usageResponses() } });
  response.end();
}
const usageResponses = () => ({ input_tokens: 12, output_tokens: 8, total_tokens: 20,
  input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });

// -------------------------------------------------------- chat completions
async function respondChat(request, response, body, behaviour, record, keepAlive) {
  const id = uid('chatcmpl'), created = Math.floor(Date.now() / 1000);
  const frame = value => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, ...value })}\n\n`);
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  frame({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  if (behaviour.kind === 'slow') await keepAlive(hold(record, behaviour.seconds));
  if (behaviour.kind === 'ask') {
    const chosen = askCall(body.tools, behaviour);
    if (chosen) {
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: uid('call'), type: 'function',
        function: { name: chosen.name, arguments: chosen.arguments } }] }, finish_reason: null }] });
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: usageChat() });
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }
  }
  frame({ choices: [{ index: 0, delta: { content: replyText(behaviour) }, finish_reason: null }] });
  frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: usageChat() });
  response.write('data: [DONE]\n\n');
  response.end();
}
const usageChat = () => ({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });

// ------------------------------------------------------- Anthropic Messages
async function respondAnthropic(request, response, body, behaviour, record, keepAlive) {
  const emit = sse(response);
  const id = uid('msg');
  const start = { id, type: 'message', role: 'assistant', model: body.model, content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } };
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  emit('message_start', { type: 'message_start', message: start });
  if (behaviour.kind === 'slow') {
    const ping = setInterval(() => emit('ping', { type: 'ping' }), 5000);
    try { await keepAlive(hold(record, behaviour.seconds)); } finally { clearInterval(ping); }
  }
  if (behaviour.kind === 'ask') {
    const chosen = askCall(body.tools, behaviour);
    if (chosen) {
      emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: uid('toolu'), name: chosen.name, input: {} } });
      emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: chosen.arguments } });
      emit('content_block_stop', { type: 'content_block_stop', index: 0 });
      emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } });
      emit('message_stop', { type: 'message_stop' });
      response.end();
      return;
    }
  }
  emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: replyText(behaviour) } });
  emit('content_block_stop', { type: 'content_block_stop', index: 0 });
  emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
  emit('message_stop', { type: 'message_stop' });
  response.end();
}

// A side call may ask for a plain body rather than a stream; answer in the shape
// its own format expects instead of handing it SSE it will not parse.
function respondJson(response, format, body, behaviour) {
  const text = replyText(behaviour);
  const value = format === 'responses'
    ? { id: uid('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: body.model,
        output: [{ type: 'message', id: uid('msg'), status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }] }], error: null, incomplete_details: null, usage: usageResponses() }
    : format === 'chat'
      ? { id: uid('chatcmpl'), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: usageChat() }
      : { id: uid('msg'), type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }],
          stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 8 } };
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/**
 * @param {{ defaultBehaviour?: object, rules?: Array<{match: RegExp|string, behaviour: object}>,
 *           models?: string[], onRequest?: (record: object) => void }} options
 */
async function createStubModelServer(options = {}) {
  const fallback = options.defaultBehaviour || { kind: 'reply', marker: '' };
  const rules = Array.isArray(options.rules) ? [...options.rules] : [];
  const models = options.models || ['stub-standard'];
  const requests = [], held = new Set(), asks = new Map();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && /\/models$/.test(url.pathname)) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: models.map(id => ({ id, object: 'model', owned_by: 'stub' })) }));
      return;
    }
    const body = await readBody(request);
    if (/count_tokens$/.test(url.pathname)) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: 12 }));
      return;
    }
    const format = /\/responses$/.test(url.pathname) ? 'responses'
      : /\/chat\/completions$/.test(url.pathname) ? 'chat'
      : /\/messages$/.test(url.pathname) ? 'anthropic' : null;
    if (!format) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `Stub model server does not serve ${url.pathname}.`, type: 'not_found' } }));
      return;
    }
    const prompt = promptText(body);
    const toolNames = (Array.isArray(body.tools) ? body.tools : []).map(tool => tool?.name || tool?.function?.name).filter(Boolean);
    // Every one of these CLIs also runs small side calls of its own off the same
    // endpoint — Codex's conversation-title call, Claude's summariser. They carry
    // the same transcript but no tools, and they are not the pane's turn, so they
    // always answer at once whatever the turn's own behaviour is. Holding one open
    // would stall a pane that is not actually working.
    const side = toolNames.length === 0;
    let behaviour = side ? { kind: 'reply', text: sideAnswer(prompt) } : parseBehaviour(prompt, { rules, fallback });
    if (behaviour.kind === 'reply' && behaviour.marker) behaviour = { ...behaviour, done: taskSummary(prompt) };
    // A pane that auto-approves the call an `ask` turn makes comes straight back
    // for another one. Nothing here can tell that from a pane that is waiting, so
    // cap it: after ASK_LIMIT identical asks the turn simply ends. A run left
    // unattended must not spin a CLI for hours.
    let loopGuard = false;
    if (behaviour.kind === 'ask') {
      const key = prompt.slice(-400);
      const seen = (asks.get(key) || 0) + 1;
      asks.set(key, seen);
      if (seen > ASK_LIMIT) { behaviour = { kind: 'reply', text: 'Stub stopped asking after repeated auto-approval.' }; loopGuard = true; }
    }
    const record = { at: Date.now(), format, path: url.pathname, model: body.model, prompt: prompt.slice(-2000),
      behaviour: behaviour.kind, marker: behaviour.marker, release: () => {}, side, stream: body.stream !== false, toolNames,
      ...(loopGuard && { loopGuard: true }) };
    requests.push(record);
    try { options.onRequest?.(record); } catch { /* a probe must never fail a turn */ }
    held.add(record);
    // A pane that goes away mid-turn must not leave a held stream running.
    request.on('close', () => { record.release(); });
    const keepAlive = async promise => {
      const ping = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, 5000);
      try { await promise; } finally { clearInterval(ping); }
    };
    try {
      if (body.stream === false) respondJson(response, format, body, behaviour);
      else if (format === 'responses') await respondResponses(request, response, body, behaviour, record, keepAlive);
      else if (format === 'chat') await respondChat(request, response, body, behaviour, record, keepAlive);
      else await respondAnthropic(request, response, body, behaviour, record, keepAlive);
      record.completedAt = Date.now();
    } catch (error) {
      record.error = String(error?.message || error);
      if (!response.headersSent) { response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: record.error } })); }
      else if (!response.destroyed) response.end();
    } finally { held.delete(record); }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    addRule: (match, behaviour) => rules.unshift({ match, behaviour }),
    // End every turn the stub is currently holding open, so a scenario can say
    // "the working pane finishes now" instead of waiting out its deadline.
    releaseHeld() { const count = held.size; for (const record of [...held]) record.release(); return count; },
    async close() {
      for (const record of [...held]) record.release();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { createStubModelServer, promptText, parseBehaviour, TAG };
