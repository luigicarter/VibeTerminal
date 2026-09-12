'use strict';
// Read only service-supplied response metadata. Prompt text, model self-reports,
// requested/default model names and other browser topics are not evidence.
const validSlug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,100}$/i.test(value);
const requestKey = text => typeof text === 'string' && text.length <= 2000000 ? require('node:crypto').createHash('sha256').update(text).digest('hex') : null;
function streamEvents(text) {
  if (typeof text !== 'string' || text.length > 8000000) return [];
  return text.split('\n').flatMap(line => {
    if (!line.startsWith('data:')) return [];
    try { return [JSON.parse(line.slice(5))]; } catch { return []; }
  });
}
function responseEvidence(events) {
  const resolved = new Set(), reported = new Set();
  const metadata = value => {
    if (!value || typeof value !== 'object') return;
    if (validSlug(value.resolved_model_slug)) resolved.add(value.resolved_model_slug);
    if (validSlug(value.model_slug)) reported.add(value.model_slug);
  };
  function visit(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 12) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    if (value.message?.author?.role === 'assistant') metadata(value.message.metadata);
    if (value.type === 'conversation_detail_metadata') metadata(value.metadata);
    const pointer = value.p ?? value.path;
    if (pointer === '/message/metadata') metadata(value.v ?? value.value);
    if (/^\/message\/metadata\/(?:resolved_model_slug|model_slug)$/.test(pointer || '') && validSlug(value.v ?? value.value)) (pointer.endsWith('/resolved_model_slug') ? resolved : reported).add(value.v ?? value.value);
    // Protocol wrappers only. Never inspect text inside a message or tool result.
    visit(value.v, depth + 1);
  }
  visit(events); return { resolvedModels: [...resolved], reportedModels: [...reported] };
}
function responseModels(events) { const evidence = responseEvidence(events); return evidence.resolvedModels.length ? evidence.resolvedModels : evidence.reportedModels; }
function topicModels(frame) {
  if (typeof frame !== 'string' || frame.length > 8000000) return [];
  let decoded; try { decoded = JSON.parse(frame); } catch { return []; }
  const result = [];
  for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
    const messages = message?.reply?.type === 'subscribe' && Array.isArray(message.reply.catchups) ? message.reply.catchups : [message];
    for (const item of messages) {
      if (item?.type !== 'message' || typeof item.topic_id !== 'string' || item.topic_id.length > 300 || item.payload?.type !== 'conversation-turn-stream') continue;
      const evidence = responseEvidence(streamEvents(item.payload.payload?.encoded_item));
      if (evidence.resolvedModels.length || evidence.reportedModels.length) result.push({ topic: item.topic_id, ...evidence });
    }
  }
  return result;
}
async function createResponseVerifier(page) {
  // A Work response is commonly handed off from HTTP SSE to an already-open
  // WebSocket. A page websocket listener alone can miss that existing socket.
  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable', { maxPostDataSize: 2000000 });
  let current;
  const topics = new Map(), requests = new Map(), streams = new Map();
  const publish = state => {
    if (state !== current) return;
    // Preliminary model_slug values can be routing aliases (for example
    // gpt-5-6-auto-thinking). A supplied resolved_model_slug takes precedence.
    state.models = state.resolvedModels.size ? state.resolvedModels : state.reportedModels;
    state.error = [...state.models].some(model => !state.accepts(model)) ? 'model_response_mismatch' : null;
    const settled = state.complete || state.resolvedModels.size > 0;
    state.onEvidence({ responseModels: [...state.models], responseReportedModels: [...state.reportedModels], responseVerified: Boolean(settled && state.models.size > 0 && !state.error), responseError: settled ? state.error : null });
    if (state.models.size) state.resolve();
  };
  const merge = (state, evidence) => {
    if (state !== current) return;
    const before = state.resolvedModels.size + state.reportedModels.size;
    for (const key of ['resolvedModels', 'reportedModels']) for (const model of evidence[key] || []) if (state[key].size < 16) state[key].add(model);
    if (state.resolvedModels.size + state.reportedModels.size !== before) publish(state);
  };
  const consume = (state, events) => {
      if (state !== current) return;
      for (const event of events) {
        if (event?.type !== 'stream_handoff') continue;
        if (typeof event.conversation_id === 'string' && /^(?:WEB:)?[a-f0-9-]{36}$/i.test(event.conversation_id) && state.conversationId !== event.conversation_id) {
          state.conversationId = event.conversation_id;
          state.onEvidence({ conversationId: state.conversationId });
        }
        for (const option of event.options || []) {
          if (option?.type !== 'subscribe_ws_topic' || typeof option.topic_id !== 'string' || option.topic_id.length > 300) continue;
          state.topics.add(option.topic_id);
          merge(state, topics.get(option.topic_id) || {});
        }
      }
      merge(state, responseEvidence(events));
  };
  const response = incoming => {
    const state = current;
    if (!state || incoming.request() !== state.request) return;
    void incoming.text().then(text => consume(state, streamEvents(text))).catch(() => {});
  };
  page.on('response', response);
  // Some HTTP SSE connections remain open after the visible answer finishes.
  // Read their chunks as they arrive instead of waiting for response.text().
  // Bind the CDP request to the routed request body hash, never just its URL.
  session.on('Network.requestWillBeSent', event => {
    const request = event.request;
    if (request?.method !== 'POST' || !/^https:\/\/chatgpt\.com\/backend-api\/(?:f\/)?conversation$/.test(request.url || '')) return;
    const key = requestKey(request.postData);
    if (!key) return;
    const slot = { key, state: null };
    if (current?.key === key && !current.networkId) { slot.state = current; current.networkId = event.requestId; }
    requests.set(event.requestId, slot);
    while (requests.size > 16) requests.delete(requests.keys().next().value);
  });
  const chunk = (stream, data) => {
    if (stream.state !== current || stream.disabled) return;
    stream.pending += stream.decoder.decode(Buffer.from(data || '', 'base64'), { stream: true });
    if (stream.pending.length > 2000000) { stream.pending = ''; stream.disabled = true; return; }
    const end = stream.pending.lastIndexOf('\n');
    if (end >= 0) { consume(stream.state, streamEvents(stream.pending.slice(0, end + 1))); stream.pending = stream.pending.slice(end + 1); }
  };
  session.on('Network.responseReceived', event => {
    const state = requests.get(event.requestId)?.state;
    if (!state || state !== current) return;
    const stream = { state, decoder: new TextDecoder(), pending: '', queued: [], queuedSize: 0, ready: false, disabled: false };
    streams.set(event.requestId, stream);
    while (streams.size > 16) streams.delete(streams.keys().next().value);
    void session.send('Network.streamResourceContent', { requestId: event.requestId }).then(result => {
      chunk(stream, result.bufferedData);
      stream.ready = true;
      for (const data of stream.queued) chunk(stream, data);
      stream.queued.length = 0;
    }).catch(() => { streams.delete(event.requestId); });
  });
  session.on('Network.dataReceived', event => {
    const stream = streams.get(event.requestId);
    if (!stream || !event.data) return;
    if (stream.ready) chunk(stream, event.data);
    else if ((stream.queuedSize += event.data.length) <= 2000000) stream.queued.push(event.data);
    else { stream.disabled = true; stream.queued.length = 0; }
  });
  session.on('Network.webSocketFrameReceived', event => {
    for (const { topic, ...evidence } of topicModels(event.response?.payloadData)) {
      const values = topics.get(topic) || { resolvedModels: new Set(), reportedModels: new Set() };
      for (const key of ['resolvedModels', 'reportedModels']) for (const model of evidence[key]) if (values[key].size < 16) values[key].add(model);
      topics.delete(topic); topics.set(topic, values);
      while (topics.size > 16) topics.delete(topics.keys().next().value);
      if (current?.topics.has(topic)) merge(current, values);
    }
  });
  page.once('close', () => { void session.detach().catch(() => {}); });
  return {
    begin(request, accepts, onEvidence) {
      current?.resolve();
      let resolve;
      const evidence = new Promise(done => { resolve = done; });
      current = { request, key: requestKey(request.postData?.()), accepts, onEvidence, resolve, evidence, models: new Set(), resolvedModels: new Set(), reportedModels: new Set(), topics: new Set(), error: null, complete: false };
      for (const [id, slot] of [...requests].reverse()) if (current.key && slot.key === current.key && !slot.state) { slot.state = current; current.networkId = id; break; }
      return current;
    },
    isVerified() {
      if (!current || !current.complete && !current.resolvedModels.size) return false;
      if (current.error) throw new Error(current.error);
      return Boolean(current.models.size);
    },
    async verify(timeoutMs = 3500) {
      const state = current;
      if (!state) throw new Error('model_response_unverified');
      if (!state.models.size) {
        let timer;
        try { await Promise.race([state.evidence, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
        finally { clearTimeout(timer); }
      }
      if (state !== current || !state.models.size) throw new Error('model_response_unverified');
      state.complete = true; publish(state);
      if (state.error) throw new Error(state.error);
    },
  };
}
module.exports = { streamEvents, responseModels, responseEvidence, topicModels, createResponseVerifier };
