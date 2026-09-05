const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const host = require('./agentThreadHost.cjs');
const { createConversationReader } = require('./conversationReader.cjs');
const { locateCodexRollout, parseCodexSessionMeta } = require('./agentThreads.cjs');

const PROVIDERS = new Set(['codex', 'claude', 'cursor', 'gemini', 'kimi', 'kimi-custom', 'qwen', 'opencode', 'openfusion', 'fusion', 'claude-custom']);
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
const MAX_BYTES = 2 * 1024 * 1024;
function rootThread(thread) { return thread && !thread.parentID && !thread.parentId && !thread.parent_id && !thread.parentSessionId && !thread.parent_session_id && !thread.parent_thread_id && !thread.isSidechain && thread.kind !== 'subagent'; }
function bounded(value, fallback, max) { return Number.isFinite(Number(value)) ? Math.max(1, Math.min(max, Math.floor(Number(value)))) : fallback; }
function inside(file, root) {
  try {
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch { return false; }
}
function readBounded(file, tail = true) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = tail ? Math.max(0, size - MAX_BYTES) : 0;
    const buffer = Buffer.alloc(Math.min(size, MAX_BYTES));
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8', 0, read);
    if (start) text = text.slice(text.indexOf('\n') + 1);
    return { text, truncated: size > MAX_BYTES };
  } finally { fs.closeSync(fd); }
}
function records(text) { return text.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (value?.synthetic || (value?.type && !['text', 'input_text', 'output_text'].includes(value.type))) return '';
  return typeof value?.text === 'string' ? value.text : '';
}
function messagesFrom(records, provider) {
  const messages = [];
  for (const record of records) {
    if (!record || record.isSidechain || record.parentSessionId || record.parent_session_id || record.kind === 'subagent' || record.parentID || record.parentId || record.parent_id || record.parent_thread_id) continue;
    if (provider === 'gemini' && (record.messages || record.$set?.messages)) {
      messages.push(...messagesFrom(record.messages || record.$set.messages, provider));
      continue;
    }
    const value = record.message || record.payload || record;
    let role = value.role || record.role || record.type;
    if (provider === 'codex') {
      // response_item is canonical; event_msg user_message would duplicate it.
      if (record.type !== 'response_item' || value.type !== 'message') continue;
      role = value.role;
    }
    if (role === 'gemini' || role === 'model') role = 'assistant';
    if (!['user', 'assistant'].includes(role)) continue;
    const text = contentText(value.content || value.parts || value.text || record.content);
    if (text.trim()) messages.push({ role, text });
  }
  return messages;
}

// All paths/env and scope provenance originate in trusted application code.
// Model-facing calls can only select returned opaque references, never files.
function createOrchestratorHistory(options = {}) {
  const lookup = options.lookupThreads || host.findLatestAgentThread;
  const references = new Map();
  const reader = createConversationReader();
  const homes = options.homes || {};
  const home = os.homedir();
  function normalizedScope(value) {
    if (!value || !PROVIDERS.has(value.provider) || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)) return null;
    const scope = { provider: value.provider, cwd: path.resolve(value.cwd) };
    for (const key of ['claudeHome', 'providerProfileId', 'plannerProvider']) if (typeof value[key] === 'string') scope[key] = value[key];
    if (Array.isArray(value.ownedThreadIds)) scope.ownedThreadIds = value.ownedThreadIds.filter(id => typeof id === 'string' && SAFE_ID.test(id)).slice(0, 1000);
    if (value.fusion) scope.fusion = true;
    if (value.openFusion) scope.openFusion = true;
    return scope;
  }
  function payload(scope) {
    let provider = scope.provider;
    if (provider === 'fusion') provider = scope.plannerProvider === 'codex' ? 'codex' : 'claude';
    if (provider === 'claude-custom') provider = 'claude';
    if (provider === 'openfusion') provider = 'opencode';
    return { ...scope, provider, list: true, fusion: scope.provider === 'fusion' || Boolean(scope.fusion),
      openFusion: scope.provider === 'openfusion' || Boolean(scope.openFusion),
      claudeHome: scope.provider === 'claude-custom' || scope.claudeHome === 'custom' ? 'custom' : 'global' };
  }
  async function discover(scope) {
    const request = payload(scope);
    if (request.claudeHome === 'custom' && !homes.claudeCustom && !process.env.VIBE_CLAUDE_CUSTOM_HOME && !options.lookupThreads) return { status: 'unsupported', message: 'Custom Claude home is unavailable.' };
    // The app broker supplies isolated XDG env and migration cutoff. Never
    // silently fall back to the global CLI when an app-owned scope was asked.
    if (request.openFusion && !options.lookupThreads) return { status: 'unsupported', message: 'Open Fusion history requires the app-owned discovery broker.' };
    return lookup(request);
  }
  function remember(identity) {
    const key = JSON.stringify(identity);
    for (const [reference, saved] of references) if (JSON.stringify(saved) === key) return reference;
    const reference = crypto.randomBytes(18).toString('base64url');
    references.set(reference, identity);
    if (references.size > 2000) references.delete(references.keys().next().value);
    return reference;
  }
  function selectionScope(scope, selection) {
    if (!selection) return true;
    const provider = selection.provider;
    if (provider && !(scope.provider === provider || provider === 'claude' && scope.provider === 'claude-custom')) return false;
    if (selection.claudeHome && payload(scope).claudeHome !== selection.claudeHome) return false;
    if (selection.cwd && !(path.isAbsolute(selection.cwd) ? host.isSamePath(scope.cwd, selection.cwd) : path.basename(scope.cwd).toLowerCase() === selection.cwd.toLowerCase())) return false;
    return true;
  }
  function nativeIdentity(identity) {
    const request = payload(identity);
    return JSON.stringify([request.provider === 'kimi-custom' ? 'kimi' : request.provider, request.claudeHome, request.openFusion, process.platform === 'win32' ? identity.cwd.toLowerCase() : identity.cwd, identity.id]);
  }
  async function list(input = {}, selection) {
    if (input.provider && !PROVIDERS.has(input.provider)) return { status: 'unsupported', conversations: [], message: 'This terminal has no native resumable conversation history.' };
    const scopes = (await options.getKnownScopes?.() || []).map(normalizedScope).filter(Boolean);
    const matchingScopes = [...new Map(scopes.filter(scope => (!input.provider || scope.provider === input.provider) && (!input.cwd || host.isSamePath(scope.cwd, input.cwd)) && selectionScope(scope, selection)).map(scope => [JSON.stringify(scope), scope])).values()];
    // Proven owned identities win over a generic scope in the same native
    // store. Claude Fusion discovery itself filters sdk-cli launches.
    const selected = matchingScopes.slice(0, 64).sort((a, b) => Number(Boolean(b.ownedThreadIds?.length)) - Number(Boolean(a.ownedThreadIds?.length)) || Number(b.provider === 'fusion' && b.plannerProvider !== 'codex') - Number(a.provider === 'fusion' && a.plannerProvider !== 'codex'));
    const conversations = [];
    const warnings = [];
    let successfulScopes = 0;
    let candidatesTruncated = false;
    const seen = new Set();
    const query = String(input.query || '').slice(0, 500).toLowerCase();
    for (const scope of selected) {
      try {
        const result = await discover(scope);
        if (result.status !== 'found') { warnings.push({ provider: scope.provider, cwd: scope.cwd, message: String(result.message || result.status).slice(0, 300) }); continue; }
        successfulScopes++;
        if (result.complete === false) warnings.push({ provider: scope.provider, cwd: scope.cwd, message: 'Native discovery was incomplete.' });
        if ((result.threads || []).length > 5000) candidatesTruncated = true;
        for (const thread of (result.threads || []).slice(0, 5000)) {
          if (!SAFE_ID.test(thread.id || '') || !rootThread(thread)) continue;
          // Codex's shared native store has no Fusion marker. Only an owned
          // root ID can be attributed to a Codex-planner Fusion pane.
          if ((scope.provider === 'fusion' || scope.fusion) && payload(scope).provider === 'codex' && !scope.ownedThreadIds?.includes(thread.id)) continue;
          if (selection && String(thread[selection.kind] || '').toLowerCase() !== selection.value.toLowerCase()) continue;
          const title = String(thread.title || '').slice(0, 200);
          if (query && !`${title} ${thread.id} ${scope.cwd}`.toLowerCase().includes(query)) continue;
          const { ownedThreadIds, providerProfileId, ...publicScope } = scope;
          const identity = { ...publicScope, id: thread.id, title };
          const provenProfiles = new Set(matchingScopes.filter(candidate => candidate.providerProfileId && candidate.ownedThreadIds?.includes(thread.id) &&
            host.isSamePath(candidate.cwd, scope.cwd) && payload(candidate).provider === payload(scope).provider &&
            payload(candidate).claudeHome === payload(scope).claudeHome && payload(candidate).openFusion === payload(scope).openFusion).map(candidate => candidate.providerProfileId));
          if (provenProfiles.size === 1) identity.providerProfileId = [...provenProfiles][0];
          const ownership = nativeIdentity(identity);
          if (seen.has(ownership)) continue;
          seen.add(ownership);
          conversations.push({ ...identity, title, updatedAt: Number(thread.updatedAt) || 0, createdAt: Number(thread.createdAt) || 0 });
        }
        if (conversations.length > 10000) { conversations.sort((a, b) => b.updatedAt - a.updatedAt); conversations.length = 10000; candidatesTruncated = true; }
      } catch { warnings.push({ provider: scope.provider, cwd: scope.cwd, message: 'Native history discovery failed.' }); }
    }
    conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    if (selection) return { conversations, complete: successfulScopes > 0 && !candidatesTruncated && matchingScopes.length <= 64 && warnings.length === 0, warnings };
    const limit = bounded(input.limit, 50, 200);
    const offset = Math.max(0, Math.min(10000, Math.floor(Number(input.offset) || 0)));
    return { status: selected.length && !successfulScopes ? 'failed' : 'found', conversations: conversations.slice(offset, offset + limit).map(identity => ({ ...identity, reference: remember(identity) })), nextOffset: conversations.length > offset + limit ? offset + limit : null, truncated: candidatesTruncated || conversations.length > offset + limit || matchingScopes.length > 64, omittedScopes: Math.max(0, matchingScopes.length - selected.length), warnings,
      searchScope: 'Titles and session identities in known workspace folders' };
  }
  async function resolve(input) {
    const reference = typeof input === 'string' ? input : input?.reference;
    const selection = typeof input === 'object' ? input?.selection : undefined;
    const identity = references.get(reference);
    if (!identity) throw new Error('Unknown or expired conversation reference. List history again.');
    const result = await discover(identity);
    const thread = result.threads?.find(value => value.id === identity.id);
    if (result.status !== 'found' || !rootThread(thread)) throw new Error('Conversation is no longer available in its original store.');
    const current = { ...identity, title: String(thread.title || '').slice(0, 200), updatedAt: Number(thread.updatedAt) || identity.updatedAt, createdAt: Number(thread.createdAt) || identity.createdAt };
    if (selection) {
      if (!['id', 'title'].includes(selection.kind) || typeof selection.value !== 'string' || !selection.value.trim() || (selection.provider && !PROVIDERS.has(selection.provider)) || (selection.cwd !== undefined && typeof selection.cwd !== 'string') || (selection.claudeHome && !['global', 'custom'].includes(selection.claudeHome))) throw new Error('Invalid conversation selection. Identify the conversation again.');
      if (String(thread[selection.kind] || '').toLowerCase() !== selection.value.toLowerCase()) throw new Error(`The selected conversation has changed; its current title is "${current.title}". Identify it again.`);
      const fresh = await list({}, selection);
      if (!fresh.complete) throw new Error('Native history search is incomplete. Narrow the provider and folder, or select the conversation directly in History.');
      if (fresh.conversations.length !== 1) throw new Error('The saved conversation is ambiguous. Specify its native ID, provider, home, and folder as needed.');
      if (nativeIdentity(fresh.conversations[0]) !== nativeIdentity(identity)) throw new Error('The selected conversation no longer matches the user selection. List history again.');
    }
    return current;
  }
  async function nativeFile(identity) {
    const request = payload(identity);
    const provider = request.provider;
    let root; let file;
    if (provider === 'codex') {
      root = path.join(homes.codex || process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
      file = locateCodexRollout(root, identity.id).path;
      const metadata = file && parseCodexSessionMeta(file);
      if (!metadata || metadata.id !== identity.id || !host.isSamePath(metadata.cwd, identity.cwd)) return null;
    } else if (provider === 'claude') {
      root = path.join(request.claudeHome === 'custom' ? homes.claudeCustom || process.env.VIBE_CLAUDE_CUSTOM_HOME || '__unavailable__' : homes.claude || process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
      file = host.collectJsonlFiles(root).find(candidate => path.basename(candidate) === `${identity.id}.jsonl` && host.parseClaudeTranscript(candidate, identity.cwd)?.id === identity.id);
    } else if (provider === 'cursor') {
      root = homes.cursor || process.env.CURSOR_CONFIG_DIR || path.join(home, '.cursor');
      const projects = path.join(root, 'projects');
      const projectName = fs.readdirSync(projects).find(name => name.toLowerCase() === host.encodeCursorProjectDir(identity.cwd).toLowerCase());
      if (projectName) file = path.join(projects, projectName, 'agent-transcripts', identity.id, `${identity.id}.jsonl`);
    } else if (provider === 'qwen') {
      root = homes.qwen || process.env.QWEN_HOME || path.join(home, '.qwen');
      file = path.join(host.qwenChatsDir(identity.cwd, root), `${identity.id}.jsonl`);
    } else if (provider === 'gemini') {
      root = homes.gemini || path.join(process.env.GEMINI_CLI_HOME || home, '.gemini');
      const result = await discover(identity);
      file = result.threads?.find(thread => thread.id === identity.id)?.transcriptPath;
    } else if (provider === 'kimi' || provider === 'kimi-custom') {
      root = homes.kimi || process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code');
      const index = path.join(root, 'session_index.jsonl');
      if (!inside(index, root)) return null;
      const entry = records(readBounded(index).text).reverse().find(record => record.sessionId === identity.id && host.isSamePath(record.workDir, identity.cwd));
      if (entry) {
        const rootWire = path.join(entry.sessionDir, 'agents', 'main', 'wire.jsonl');
        file = fs.existsSync(rootWire) ? rootWire : path.join(entry.sessionDir, 'context.jsonl');
      }
    }
    return file && root && inside(file, root) ? file : null;
  }
  async function transcript(input = {}, operation = 'read') {
    const identity = await resolve(input.reference);
    const provider = payload(identity).provider;
    const source = { binding: JSON.stringify([identity, payload(identity), homes, options.getStoreBinding?.()]), decode: values => messagesFrom(values, provider) };
    if (provider === 'opencode') {
      if (!options.readOpenCodeTranscript) return { status: 'unsupported', identity, message: 'Transcript reading is unavailable for this OpenCode store; the conversation can still be reopened.' };
      const result = await options.readOpenCodeTranscript(identity);
      if (!result || result.status === 'unsupported') return { status: 'unsupported', identity, message: result?.message || 'Transcript unavailable.' };
      if (result.truncated) return { status: 'unsupported', identity, message: 'This transcript export is incomplete; full conversation access is unavailable.' };
      source.messages = (result.messages || []).filter(m => ['user', 'assistant'].includes(m.role) && typeof m.text === 'string');
    } else {
      try { source.file = await nativeFile(identity); } catch { /* inaccessible store */ }
      if (!source.file) return { status: 'unavailable', identity, message: 'Native transcript is unavailable; no transcript archive is kept.' };
    }
    return { status: 'found', identity, ...reader[operation](input, source), untrustedContent: true };
  }
  const read = input => transcript(input, 'read');
  const search = input => transcript(input, 'search');
  async function result(fn, input) {
    const value = await fn(input);
    return { ...value, ok: value.status === 'found', ...(value.status !== 'found' && value.message ? { error: value.message } : {}), ...(value.messages ? { text: value.messages.map(message => `${message.role}: ${message.text}`).join('\n\n') } : {}) };
  }
  return { list: input => result(list, input), read: input => result(read, input), search: input => result(search, input), resolve };
}
module.exports = { createOrchestratorHistory };
