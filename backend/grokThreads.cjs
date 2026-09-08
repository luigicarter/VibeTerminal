const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { normalizeThreadTitle } = require('./agentThreads.cjs');

// Native schema: xai-org/grok-build, session/persistence.rs Summary and
// xai-grok-config/src/paths.rs (URL-encoded cwd, or .cwd for long-path hashes).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
function grokHome(options = {}) { return options.home || process.env.GROK_HOME || path.join(os.homedir(), '.grok'); }
async function safePath(root, file, directory) {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Outside Grok store');
  let current = root;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (current !== file || directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Unsafe Grok store path');
  }
  if (!samePath(await fs.realpath(file), file)) throw new Error('Relocated Grok store path');
}
async function readBounded(root, file, max = 262144) {
  await safePath(root, file, false);
  const initial = await fs.lstat(file);
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (initial.isSymbolicLink() || !before.isFile() || initial.dev !== before.dev || initial.ino !== before.ino) throw new Error('Grok metadata path changed');
    await safePath(root, file, false);
    if (before.size > max) throw new Error('Grok metadata exceeds limit');
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (length > max || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Grok metadata changed');
    await safePath(root, file, false);
    const final = await fs.lstat(file);
    if (final.dev !== before.dev || final.ino !== before.ino || final.mtimeMs !== before.mtimeMs || final.size !== before.size) throw new Error('Grok metadata path changed');
    return buffer.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}
async function directoryEntries(root, directory, limit) {
  await safePath(root, directory, true);
  const result = [];
  const handle = await fs.opendir(directory);
  try { for await (const entry of handle) { if (result.length >= limit) throw new Error('Grok discovery limit'); result.push(entry); } }
  finally { await handle.close().catch(() => {}); }
  return result;
}
function rootSummary(summary) {
  const kind = summary.session_kind;
  if (summary.hidden === true || (typeof kind === 'string' && kind.startsWith('subagent'))) return false;
  // User-requested forks have a parent too. Only explicitly native user kinds
  // can establish independent ownership when parent metadata is present.
  return !summary.parent_session_id || ['fork', 'worktree'].includes(kind);
}
function nativeSummaryShape(summary) {
  // These non-defaulted fields are required by native Summary deserialization
  // (verified against installed Grok 1.0.13 as well as the public source).
  const timestamp = value => {
    const parts = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
    if (!parts || !Number.isFinite(Date.parse(value))) return false;
    // Date.parse normalizes impossible dates and 24:00 into another day;
    // Grok's native Summary parser rejects those rather than resuming them.
    const [year, month, day, hour] = parts.slice(1).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour < 24;
  };
  return summary && typeof summary === 'object' && !Array.isArray(summary) &&
    summary.info && typeof summary.info.id === 'string' && typeof summary.info.cwd === 'string' &&
    typeof summary.session_summary === 'string' && typeof summary.current_model_id === 'string' &&
    Number.isSafeInteger(summary.num_messages) && summary.num_messages >= 0 &&
    timestamp(summary.created_at) && timestamp(summary.updated_at) &&
    ['generated_title', 'parent_session_id', 'session_kind'].every(key => summary[key] == null || typeof summary[key] === 'string') &&
    (summary.hidden == null || typeof summary.hidden === 'boolean') &&
    (summary.title_is_manual === undefined || typeof summary.title_is_manual === 'boolean');
}
async function collectGrokThreads(payload = {}, options = {}) {
  const home = path.resolve(grokHome(options));
  const sessions = path.join(home, 'sessions');
  const threads = [];
  const candidateCounts = new Map();
  let complete = true, identityEnumerationComplete = true;
  let cwdDirs;
  try { cwdDirs = await directoryEntries(home, sessions, 10000); }
  catch (error) { return { threads, complete: error.code === 'ENOENT' }; }
  const excluded = new Set(payload.excludeIds || []);
  let visited = 0;
  for (const dir of cwdDirs) {
    if (!dir.isDirectory()) continue;
    const cwdDir = path.join(sessions, dir.name);
    let decoded;
    try { decoded = decodeURIComponent(dir.name); } catch { /* hashed path */ }
    if (!decoded || !path.isAbsolute(decoded)) {
      try { decoded = (await readBounded(home, path.join(cwdDir, '.cwd'), 16384)).trim(); }
      catch (error) {
        if (error.code !== 'ENOENT') complete = false;
        decoded = undefined;
      }
      if (decoded !== undefined && !path.isAbsolute(decoded)) { complete = false; decoded = undefined; }
    }
    // A known foreign workspace is isolated. An unreadable/invalid cwd marker
    // proves no such isolation: its UUID names can still conflict with this ID.
    if (decoded !== undefined && !samePath(decoded, payload.cwd)) continue;
    let entries;
    try { entries = await directoryEntries(home, cwdDir, 10000); }
    catch { complete = false; identityEnumerationComplete = false; continue; }
    for (const entry of entries) {
      if (!UUID.test(entry.name)) continue;
      // Unseen names may include a second copy of any already-read identity.
      if (++visited > 10000) return { threads: [], complete: false };
      if (decoded === undefined) complete = false;
      if (payload.confirmId && entry.name !== payload.confirmId) continue;
      if (payload.sessionId && entry.name !== payload.sessionId) continue;
      // A relocation copy still competes for this native identity while its
      // summary is absent or malformed. Count before accepting its metadata.
      candidateCounts.set(entry.name, (candidateCounts.get(entry.name) || 0) + 1);
      if (decoded === undefined) continue;
      const sessionDir = path.join(cwdDir, entry.name);
      try {
        const summary = JSON.parse(await readBounded(home, path.join(sessionDir, 'summary.json')));
        if (!nativeSummaryShape(summary) || summary.info.id !== entry.name) { complete = false; continue; }
        if (!samePath(summary.info.cwd, payload.cwd) || !rootSummary(summary)) continue;
        const createdAt = Date.parse(summary.created_at);
        const updatedAt = Date.parse(summary.updated_at);
        if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) { complete = false; continue; }
        if (createdAt < Number(payload.after || 0) || excluded.has(entry.name)) continue;
        const named = normalizeThreadTitle(summary.generated_title);
        threads.push({ provider: 'grok', id: entry.name, title: named || normalizeThreadTitle(summary.session_summary),
          titleSource: named ? summary.title_is_manual === true ? 'named' : 'generated' : 'preview', createdAt, updatedAt, sessionDir });
      } catch {
        // A discovered session can precede its summary during native creation
        // or relocation. Missing metadata cannot eliminate that candidate or
        // establish that the conversation was deleted.
        complete = false;
      }
    }
  }
  // Duplicate identities can arise during relocation. Never choose by recency.
  if ([...candidateCounts.values()].some(count => count > 1)) complete = false;
  return { threads: threads.filter(thread => identityEnumerationComplete && candidateCounts.get(thread.id) === 1).sort((a, b) => b.updatedAt - a.updatedAt), complete };
}
async function lookupGrokThread(payload = {}, options = {}) {
  if (!payload.cwd || !path.isAbsolute(payload.cwd)) return { status: 'failed', message: 'A working directory is required.' };
  const target = payload.confirmId || payload.sessionId;
  if (target && !UUID.test(target)) return { status: 'missing', rootVerified: false };
  const result = await collectGrokThreads(payload, options);
  if (payload.list) return { status: 'found', ...result };
  if (target) {
    const threadRef = result.threads.find(thread => thread.id === target);
    return threadRef ? { status: 'found', rootVerified: true, threadRef } : { status: result.complete && payload.confirmId ? 'missing' : 'pending', rootVerified: false };
  }
  if (!result.complete) return { status: 'pending', message: 'Grok discovery is incomplete.' };
  if (result.threads.length > 1) return { status: 'ambiguous', candidates: result.threads, message: 'Multiple Grok sessions match; ownership requires a native ID.' };
  return result.threads.length ? { status: 'found', rootVerified: true, threadRef: result.threads[0] } : { status: 'pending' };
}
function grokChatMessages(records) {
  return records.flatMap(record => {
    if (!record || record.synthetic_reason || record.synthetic) return [];
    const role = record.type || record.role;
    if (!['user', 'assistant'].includes(role)) return [];
    const text = typeof record.content === 'string' ? record.content : Array.isArray(record.content) ?
      record.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : '';
    return text.trim() ? [{ role, text }] : [];
  });
}
function replayGrokUpdates(text, sessionId) {
  const survivors = [], starts = [], seen = new Map();
  let inUser = false, currentIndex = null, seenMarker = false;
  const reset = () => { inUser = false; currentIndex = null; };
  let lineCount = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (++lineCount > 100000) throw new Error('Grok history exceeds the supported record limit.');
    const record = JSON.parse(line);
    const params = record.method ? record.params : record;
    if (!params || params.sessionId !== sessionId || !params.update || typeof params.update.sessionUpdate !== 'string') throw new Error('Unsupported Grok history identity or format.');
    if (record.method && !['session/update', '_x.ai/session/update'].includes(record.method)) throw new Error('Unsupported Grok history envelope.');
    const eventId = params._meta?.eventId;
    if (eventId !== undefined) {
      if (typeof eventId !== 'string') throw new Error('Invalid Grok event identity.');
      const signature = JSON.stringify(params);
      if (seen.has(eventId)) {
        if (seen.get(eventId) !== signature) throw new Error('Conflicting Grok event identity.');
        continue;
      }
      seen.set(eventId, signature);
    }
    const update = params.update;
    const kind = update.sessionUpdate;
    if (record.method === '_x.ai/session/update' && kind === 'rewind_marker') {
      const target = update.target_prompt_index;
      if (!Number.isSafeInteger(target) || target < 0) throw new Error('Invalid Grok rewind marker.');
      survivors.length = starts[target] ?? survivors.length;
      starts.length = Math.min(target, starts.length);
      reset();
      continue;
    }
    const hostTurn = update._meta?.hostTurn === true;
    let newRun = false;
    if (record.method !== '_x.ai/session/update' && kind === 'user_message_chunk' && !hostTurn) {
      const index = update._meta?.promptIndex ?? null;
      if (index !== null && (!Number.isSafeInteger(index) || index < 0)) throw new Error('Invalid Grok prompt index.');
      if (index !== null) seenMarker = true;
      newRun = !inUser || (seenMarker && index !== currentIndex);
      if (newRun && (!seenMarker || index !== null)) starts.push(survivors.length);
      inUser = true;
      currentIndex = index;
    } else reset();
    const role = record.method !== '_x.ai/session/update' && !hostTurn ?
      kind === 'user_message_chunk' ? 'user' : kind === 'agent_message_chunk' ? 'assistant' : null : null;
    let content = role && update.content?.type === 'text' && typeof update.content.text === 'string' ? update.content.text : '';
    if (role === 'user') for (const tag of ['fork-context', 'resume-context']) content = content.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'g'), '');
    // Keep boundaries even for non-text events: they participate in rewinds and
    // stop adjacent chunks from different turns being silently concatenated.
    survivors.push({ role, text: content, newRun, eventId });
  }
  const messages = [];
  let previousRole = null;
  for (const event of survivors) {
    if (!event.role) { previousRole = null; continue; }
    if (!event.text) continue;
    if (previousRole === event.role && !event.newRun && messages.length) messages[messages.length - 1].text += event.text;
    else messages.push({ role: event.role, text: event.text });
    previousRole = event.role;
  }
  return messages.filter(message => message.text.trim());
}
async function readGrokConversation(identity, options = {}) {
  const confirmed = await lookupGrokThread({ cwd: identity.cwd, confirmId: identity.id }, options);
  if (!confirmed.rootVerified) throw new Error('Grok conversation is no longer verified in this folder.');
  const home = path.resolve(grokHome(options));
  const directory = confirmed.threadRef.sessionDir;
  try {
    const raw = await readBounded(home, path.join(directory, 'updates.jsonl'), 8 * 1024 * 1024);
    return { messages: replayGrokUpdates(raw, identity.id), source: 'grok-updates', limited: false, version: require('node:crypto').createHash('sha256').update(raw).digest('hex') };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Only genuine absence permits the legacy/current-context fallback. An
  // unreadable or corrupt authoritative log must never masquerade as complete.
  const raw = await readBounded(home, path.join(directory, 'chat_history.jsonl'), 8 * 1024 * 1024);
  return { messages: grokChatMessages(raw.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))), source: 'grok-chat-context', limited: true,
    version: require('node:crypto').createHash('sha256').update(raw).digest('hex') };
}
module.exports = { grokHome, collectGrokThreads, lookupGrokThread, safePath, readBounded, replayGrokUpdates, grokChatMessages, readGrokConversation };
