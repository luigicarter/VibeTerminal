'use strict';

// UTF-8 bytes are a deliberately conservative input bound, not a token estimate.
// Reserve advertised tokens for output and protocol overhead, then allow at most
// one serialized input byte per remaining token, with an application ceiling.
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
function modelInputBudget(contextLength, outputTokens = 1200) {
  const context = Number.isFinite(Number(contextLength)) && Number(contextLength) > 0 ? Math.floor(Number(contextLength)) : 16384;
  return Math.max(0, Math.min(48000, context - Math.max(0, Number(outputTokens) || 0) - 1024));
}
function boundedString(value, maxBytes, tail = false) {
  const chars = Array.from(String(value || ''));
  let low = 0, high = chars.length;
  // Count JSON encoding too: quotes, backslashes and control characters have a
  // cost even when their unescaped UTF-8 representation is small.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = (tail ? chars.slice(chars.length - mid) : chars.slice(0, mid)).join('');
    if (bytes(JSON.stringify(candidate)) - 2 <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return (tail ? chars.slice(chars.length - low) : chars.slice(0, low)).join('');
}

const BODY_KEYS = new Set(['text', 'output', 'excerpt', 'content', 'snippet']);
const RAW_KEYS = new Set(['history', 'rawHistory', 'raw', 'screen', 'screenText', 'snapshot', 'transcript', 'messages', 'screens', 'scrollback']);
function createReadBudget({ maxBytes = 12000, perReadBytes = 4000 } = {}) {
  let remaining = Math.max(0, maxBytes);
  const seen = new Set();
  return {
    get remainingBytes() { return remaining; },
    reset() { remaining = Math.max(0, maxBytes); seen.clear(); },
    projectRead(value, { tail = true } = {}) {
      const source = value && typeof value === 'object' ? value : { text: String(value || '') };
      const observation = source.observation && typeof source.observation === 'object' ? source.observation : source;
      const id = source.id ?? observation.id ?? source.reference ?? observation.reference;
      const generation = source.generation ?? observation.generation;
      const sequence = source.sequence ?? observation.sequence ?? source.outputSequence ?? observation.outputSequence ?? source.sourceVersion ?? observation.sourceVersion;
      const page = source.range ?? observation.range ?? source.cursor ?? observation.cursor ?? source.nextCursor ?? observation.nextCursor ?? null;
      const key = id != null && sequence != null ? JSON.stringify([id, generation ?? null, sequence, tail ? null : page]) : null;
      const unchanged = key !== null && seen.has(key);
      if (key !== null) seen.add(key);
      let allowance = unchanged ? 0 : Math.min(remaining, Math.max(0, perReadBytes));
      let used = 0, shortened = unchanged, bodyClipped = false;
      function project(item, depth = 0) {
        if (depth > 10) { shortened = true; return null; }
        if (Array.isArray(item)) return item.map(v => project(v, depth + 1));
        if (!item || typeof item !== 'object') return item;
        const result = {};
        for (const [name, entry] of Object.entries(item)) {
          if (RAW_KEYS.has(name)) { shortened = true; continue; }
          if (BODY_KEYS.has(name) && typeof entry === 'string') {
            const text = boundedString(entry, allowance, tail);
            const cost = bytes(JSON.stringify(text)) - 2;
            used += cost; allowance -= cost;
            if (text !== entry) { shortened = true; bodyClipped = !unchanged; }
            if (text) result[name] = text;
          } else result[name] = project(entry, depth + 1);
        }
        return result;
      }
      const result = project(source);
      remaining -= used;
      if (!tail && bodyClipped && key !== null) seen.delete(key);
      return { ...result, unchanged, truncated: !!result.truncated || shortened,
        contextTrimmed: shortened,
        ...(!tail && bodyClipped ? { retrySamePage: true, contextWarning: 'This model-context page was clipped. Re-read the same source cursor with a smaller page before advancing nextCursor; omitted text remains available at the source.' } : {}),
        readBudgetRemainingBytes: remaining,
        contextNote: unchanged ? 'Output sequence and page unchanged within this batch; prior excerpt already supplied.' : remaining === 0 ? 'This tool batch excerpt allowance is exhausted. Continue source reads in the next model round; source access is not capped.' : 'Only bounded excerpts are supplied to model context. Source data is unchanged and omitted history is not evidence of absence.' };
    }
  };
}

const CONTEXT_KEYS = new Set(['recentConversation', 'roots', 'sessions', 'preferences', 'observations', 'observedReads', 'sessionDirectory', 'readBookmarks']);
function compactTool(content) {
  let value;
  try { value = JSON.parse(content); } catch { return JSON.stringify({ truncated: true, contextNote: 'Earlier tool output omitted for context. Never repeat an effect because its receipt was shortened.' }); }
  function metadata(item, depth = 0) {
    if (depth > 8) return null;
    if (Array.isArray(item)) return item.map(v => metadata(v, depth + 1));
    if (!item || typeof item !== 'object') return item;
    // Keep arbitrary status/identity/receipt metadata, including adapter-specific
    // fields. Only known body fields are disposable, not unknown receipt fields.
    return Object.fromEntries(Object.entries(item).filter(([key]) => !RAW_KEYS.has(key) && !BODY_KEYS.has(key)).map(([key, entry]) => [key, metadata(entry, depth + 1)]));
  }
  return JSON.stringify({ ...metadata(value), truncated: true, contextTrimmed: true, contextNote: 'Earlier tool body omitted only from model context; source data, identity, status and receipts remain. Continue with source cursors; never repeat an effect because details were shortened.' });
}

function fitMessages({ messages, tools = [], contextLength, outputTokens = 1200, maxBytes } = {}) {
  const budget = Math.min(modelInputBudget(contextLength, outputTokens), maxBytes === undefined ? Infinity : Math.max(0, maxBytes));
  const result = structuredClone(messages || []);
  const size = () => bytes({ messages: result, tools });
  if (size() <= budget) return result;
  // Older complete turns can be removed as units; never orphan tool responses.
  let currentUser = result.findLastIndex(message => message.role === 'user');
  if (currentUser > 0) {
    for (let i = currentUser - 1; i >= 0; i--) if (result[i].role !== 'system') result.splice(i, 1);
  }
  if (size() <= budget) return result;
  // Preserve the latest batch of new tool bodies until older bodies and initial
  // directory context have been reduced. Calls and responses remain paired.
  const latestAssistant = result.findLastIndex(message => message.role === 'assistant' && message.tool_calls?.length);
  for (let i = 0; i < result.length; i++) {
    const message = result[i];
    if (message.role === 'tool' && i < latestAssistant) message.content = compactTool(message.content);
    if (size() <= budget) return result;
  }
  currentUser = result.findLastIndex(message => message.role === 'user');
  let payload;
  try { payload = JSON.parse(result[currentUser]?.content); } catch { /* Plain user instructions are immutable. */ }
  if (payload && !Array.isArray(payload) && typeof payload === 'object' && typeof payload.instruction === 'string') {
    // Only explicitly recognized context fields may shrink. Instruction and all
    // target/provenance fields remain byte-for-byte equivalent after parsing.
    for (const key of CONTEXT_KEYS) {
      if (!Object.hasOwn(payload, key)) continue;
      const original = payload[key];
      if (Array.isArray(original)) {
        while (payload[key].length && size() > budget) {
          payload[key] = key === 'recentConversation' ? payload[key].slice(1) : payload[key].slice(0, Math.floor(payload[key].length / 2));
          payload.contextNote = 'Workspace context shortened to fit this model. Use bounded directory or status reads for omitted context.';
          result[currentUser].content = JSON.stringify(payload);
        }
      } else {
        payload[key] = { truncated: true };
        payload.contextNote = 'Workspace context shortened to fit this model. Use bounded directory or status reads for omitted context.';
        result[currentUser].content = JSON.stringify(payload);
      }
      if (size() <= budget) return result;
    }
  }
  // Long scans must be able to continue indefinitely. Retire whole old read-only
  // exchanges after their excerpts are consumed, but never retire effect receipts
  // or the newest batch. Unknown tools and malformed groups fail closed below.
  const readKinds = new Set(['read_session', 'read_conversation', 'search_conversation', 'list_sessions', 'list_conversations', 'search_files', 'list_setups', 'read_setup', 'list_preferences']);
  let retiredReads = false;
  for (let i = 0; i < result.length && size() + 300 > budget;) {
    const assistant = result[i];
    const latest = result.findLastIndex(message => message.role === 'assistant' && message.tool_calls?.length);
    const calls = assistant.tool_calls;
    let readonly = assistant.role === 'assistant' && i < latest && calls?.length > 0;
    if (readonly) {
      try { readonly = calls.every(call => call.function?.name === 'workspace' && readKinds.has(JSON.parse(call.function.arguments).kind)); } catch { readonly = false; }
    }
    const responses = readonly ? result.slice(i + 1, i + 1 + calls.length) : [];
    if (readonly && responses.length === calls.length && responses.every(message => message.role === 'tool') && new Set(responses.map(message => message.tool_call_id)).size === calls.length && calls.every(call => responses.some(message => message.tool_call_id === call.id))) {
      result.splice(i, calls.length + 1);
      retiredReads = true;
    } else i++;
  }
  if (retiredReads) {
    const tool = result.findLast(message => message.role === 'tool');
    if (tool) {
      try { const value = JSON.parse(tool.content); tool.content = JSON.stringify({ ...value, priorReadContextOmitted: true, priorReadContextNote: 'Earlier read-only exchanges were retired from model context. Source content is unchanged; continue the current page cursor or re-read earlier pages if needed.' }); } catch { /* Preserve non-JSON content. */ }
    }
  }
  if (size() <= budget) return result;
  // If the newest page alone cannot fit, reject locally rather than silently
  // consume its cursor without showing the model its body. The caller can ask
  // for a smaller source page or choose a larger context model.
  const error = new Error(`Local context limit: protected instructions, tool schemas, receipts and the newest source page require ${size()} UTF-8 bytes; this model allows ${budget}. Choose a model with a larger context window or request a smaller source page. The original user instruction is unchanged.`);
  error.code = 'LOCAL_CONTEXT_LIMIT';
  throw error;
}

module.exports = { modelInputBudget, fitMessages, createReadBudget, boundedString };
