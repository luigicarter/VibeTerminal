'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const { key, identity, fromSession, cleanWorkspace, CONFIG_FIELDS } = require('../shared/chatIdentity.cjs');
const parse = value => value ? JSON.parse(value) : null;
function createChatStore({ directory, now = Date.now }) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'chat-workspace.sqlite');
  const db = new DatabaseSync(file);
  try {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) throw new Error('Chat storage was created by a newer Lina version. Install that version to recover it.');
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Chat storage validation failed. The original database has been kept.');
  db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chats(chatId TEXT PRIMARY KEY, nativeKey TEXT UNIQUE, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS drafts(owner TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS copies(chatId TEXT PRIMARY KEY, value TEXT NOT NULL, capturedAt INTEGER NOT NULL);
    PRAGMA user_version=1;`);
  const readMeta = name => parse(db.prepare('SELECT value FROM meta WHERE key=?').get(name)?.value);
  const writeMeta = (name, value) => db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value));
  const previousRun = readMeta('run');
  const bootId = randomUUID();
  // Only an exit that never reached the app's shutdown routine pauses panes. A
  // shutdown that started and then missed one of its deadlines is still a
  // shutdown. Records written before the marker existed carry no request, so
  // their own clean flag decides once, as it did then.
  const recoveryNeeded = Boolean(previousRun && !previousRun.clean && !previousRun.shutdownRequestedAt);
  let closed = false, bootstrapped = false, lastSequence = 0, lastClient = null;
  const retiredClients = new Set();
  const observations = new Map();
  const get = id => parse(db.prepare('SELECT value FROM chats WHERE chatId=?').get(id)?.value);
  const byKey = nativeKey => nativeKey && parse(db.prepare('SELECT value FROM chats WHERE nativeKey=?').get(nativeKey)?.value);
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  function put(chat) { db.prepare('INSERT INTO chats VALUES(?,?,?) ON CONFLICT(chatId) DO UPDATE SET nativeKey=excluded.nativeKey,value=excluded.value').run(chat.chatId, chat.nativeKey || null, JSON.stringify(chat)); return chat; }
  function upsert(conversation, extra = {}) {
    const nativeKey = key(conversation);
    const existing = byKey(nativeKey) || (extra.chatId && get(extra.chatId));
    const createdAt = existing?.createdAt || now();
    const next = { ...existing, ...extra, chatId: existing?.chatId || extra.chatId || randomUUID(), nativeKey,
      conversation: conversation ? { ...existing?.conversation, ...Object.fromEntries(Object.entries(conversation).filter(([, value]) => value !== undefined)) } : existing?.conversation,
      // A pane without a saved timestamp still sorts by when it appeared, not to the bottom.
      createdAt, updatedAt: Math.max(existing?.updatedAt || 0, Number(conversation?.updatedAt) || 0) || createdAt, revision: (existing?.revision || 0) + 1 };
    // Provenance only ever rises: a pane that once opened as a chat stays one.
    next.origin = extra.origin || existing?.origin || 'terminal';
    next.title = existing?.titleOverride ? existing.title : conversation?.title || existing?.title || extra.title || 'New chat';
    return put(next);
  }
  function paneEntries(workspace) { return [...workspace.multiSessions.map(pane => ({ pane, projectId: null })), ...workspace.workspaces.flatMap(project => project.sessions.map(pane => ({ pane, projectId: project.id })))]; }
  function applyObservation(pane) {
    const seen = observations.get(pane.id);
    if (!seen || pane.launchToken !== seen.launchToken) return pane;
    if (seen.unavailable) return { ...pane, threadRef: undefined, threadSelectionPending: true };
    return { ...pane, threadRef: seen.threadRef, threadSelectionPending: seen.pending || undefined };
  }
  function indexWorkspace(workspace) {
    const previous = readMeta('workspace');
    const oldBindings = readMeta('bindings') || {};
    const bindings = {};
    for (const { pane: raw, projectId } of paneEntries(workspace)) {
      const pane = applyObservation(raw);
      Object.assign(raw, pane);
      if (pane.kind === 'terminal') continue;
      // Only a pane started from the Chats section is a chat; every other pane is a terminal.
      const origin = pane.chat === true ? { origin: 'chat' } : {};
      // Retain earlier chats independently from the current pane binding.
      if (pane.resumeRef?.id) { const prior = fromSession(pane, pane.resumeRef); if (prior) upsert(prior, { projectId, ...origin }); }
      const conversation = fromSession(pane, pane.threadRef?.id ? pane.threadRef : !pane.started ? pane.resumeRef : undefined);
      let chat = conversation && byKey(key(conversation));
      const provisional = oldBindings[pane.id] && get(oldBindings[pane.id]);
      if (!chat && provisional && !provisional.nativeKey) chat = provisional;
      const extra = { chatId: chat?.chatId, ...origin, projectId, paneId: pane.id, title: pane.name, kind: pane.kind,
        pending: Boolean(pane.threadSelectionPending), provisional: !conversation, lastRunState: pane.status, cwd: pane.cwd };
      chat = upsert(conversation, extra);
      bindings[pane.id] = chat.chatId;
      if (conversation && provisional && !provisional.nativeKey && provisional.chatId !== chat.chatId) db.prepare('DELETE FROM chats WHERE chatId=?').run(provisional.chatId);
      // A draft from a pane without an ID follows its first verified conversation.
      if (chat.nativeKey) {
        const draft = db.prepare('SELECT * FROM drafts WHERE owner=?').get('pane:' + pane.id + ':' + pane.launchToken) || db.prepare('SELECT * FROM drafts WHERE owner=?').get('pane:' + pane.id);
        if (draft && !db.prepare('SELECT owner FROM drafts WHERE owner=?').get('native:' + chat.nativeKey)) {
          db.prepare('INSERT INTO drafts VALUES(?,?,?)').run('native:' + chat.nativeKey, draft.text, draft.revision);
          db.prepare('DELETE FROM drafts WHERE owner=?').run(draft.owner);
        }
      }
    }
    writeMeta('bindings', bindings);
    writeMeta('workspace', workspace);
    return previous;
  }
  // The next diagnosis reads one record: how this run ended, whether its exit
  // was requested, and which shutdown steps missed their deadline. Only the
  // named fields of the run before this one are carried, so the record never
  // grows a chain of its own history.
  const pickRun = run => run && { bootId: run.bootId, startedAt: run.startedAt, shutdownRequestedAt: run.shutdownRequestedAt,
    shutdownReason: run.shutdownReason, clean: run.clean, finishedAt: run.finishedAt, incomplete: run.incomplete };
  const mergeRun = extra => transaction(() => { const run = readMeta('run'); writeMeta('run', { ...(run?.bootId === bootId ? run : { bootId }), ...extra }); });
  transaction(() => writeMeta('run', { bootId, startedAt: now(), clean: false, recovery: recoveryNeeded, previousRun: pickRun(previousRun) }));
  function bootstrap(input) {
    const wrapped = input && Object.hasOwn(input, 'legacy');
    const legacy = wrapped ? input.legacy : input;
    const clientId = wrapped ? input.clientId : undefined;
    if (clientId !== undefined && (typeof clientId !== 'string' || !clientId || clientId.length > 200)) throw new Error('Invalid workspace client identity.');
    let workspace = readMeta('workspace');
    if (!workspace && legacy) transaction(() => { workspace = cleanWorkspace(legacy); indexWorkspace(workspace); writeMeta('migration', { importedAt: now(), version: 1 }); });
    workspace = workspace && JSON.parse(JSON.stringify(workspace));
    if (workspace && recoveryNeeded && !bootstrapped) for (const { pane } of paneEntries(workspace)) {
      if (pane.kind !== 'terminal') pane.started = false;
    }
    // Claim this renderer before its first save. A newer acknowledged writer
    // must be able to retire an initial renderer that has not checkpointed yet.
    if (clientId && clientId !== lastClient) {
      if (retiredClients.has(clientId)) throw new Error('This workspace client was replaced. Reload the view.');
      if (lastClient) retiredClients.add(lastClient);
      lastClient = clientId; lastSequence = 0;
    }
    bootstrapped = true;
    return { bootId, recoveryNeeded, workspace, drafts: Object.fromEntries(db.prepare('SELECT * FROM drafts').all().map(d => [d.owner, { text: d.text, revision: d.revision }])), migrated: Boolean(readMeta('migration')) };
  }
  function checkpoint({ workspace, sequence, clientId }) {
    if (typeof clientId !== 'string' || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid checkpoint revision.');
    if (retiredClients.has(clientId)) return { saved: false, stale: true, sequence: lastSequence };
    if (lastClient === clientId && sequence <= lastSequence) return { saved: true, sequence: lastSequence };
    const clean = cleanWorkspace(workspace);
    transaction(() => indexWorkspace(clean));
    if (lastClient && lastClient !== clientId) retiredClients.add(lastClient);
    lastClient = clientId; lastSequence = sequence;
    return { saved: true, sequence };
  }
  function observe(snapshot) {
    const workspace = readMeta('workspace');
    const pane = workspace && paneEntries(workspace).find(item => item.pane.id === snapshot.id)?.pane;
    if (!pane || pane.launchToken !== snapshot.launchToken || pane.started !== true) return false;
    const selection = snapshot.selection;
    const ref = selection?.status === 'pending' ? selection.threadRef : snapshot.conversation;
    if (!ref?.id && selection?.status !== 'unavailable') return false;
    const seen = { launchToken: snapshot.launchToken, threadRef: ref, pending: selection?.status === 'pending', unavailable: selection?.status === 'unavailable', revision: snapshot.revision || 0 };
    const previous = observations.get(pane.id);
    if (previous?.launchToken === seen.launchToken && previous.revision > seen.revision) return false;
    if (previous && JSON.stringify({ ...previous, revision: 0 }) === JSON.stringify({ ...seen, revision: 0 })) return false;
    observations.set(pane.id, seen);
    try { transaction(() => indexWorkspace(workspace)); } catch (error) { if (previous) observations.set(pane.id, previous); else observations.delete(pane.id); throw error; }
    return true;
  }
  function observeChat(event) {
    if (event.type !== 'session' || event.replay || !event.sessionId) return false;
    const workspace = readMeta('workspace');
    const pane = workspace && paneEntries(workspace).find(item => item.pane.id === event.id)?.pane;
    if (!pane || !pane.started || event.launchToken !== undefined && event.launchToken !== pane.launchToken) return false;
    const provider = pane.openFusion ? 'opencode' : pane.fusionPlannerFamily || 'claude';
    return observe({ id: pane.id, launchToken: pane.launchToken, revision: event.revision || now(), conversation: { provider, id: event.sessionId, createdAt: pane.createdAt, updatedAt: now() } });
  }
  function list(input = {}) {
    const bindings = readMeta('bindings') || {};
    const workspace = readMeta('workspace');
    const panes = workspace ? paneEntries(workspace).map(item => item.pane) : [];
    return db.prepare('SELECT value FROM chats').all().map(row => {
      const chat = parse(row.value), pane = panes.find(pane => bindings[pane.id] === chat.chatId);
      return { ...chat, paneId: pane?.id, started: Boolean(pane?.started) };
    // The sidebar lists only chats started from the Chats section; every other row stays in the catalog.
    }).filter(chat => input.all || chat.origin === 'chat' && Boolean(chat.nativeKey || chat.paneId))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.chatId.localeCompare(b.chatId));
  }
  function importConversations(items) {
    if (!Array.isArray(items) || items.length > 200) throw new Error('Invalid history page.');
    return transaction(() => items.flatMap(item => {
      const value = identity(item); if (!value) return [];
      const existing = byKey(key(value));
      // An external scan cannot overwrite a recipe proven by a Lina pane.
      const clean = { provider: value.provider, id: value.id, cwd: value.cwd, title: String(value.title || '').slice(0, 200), updatedAt: Number(value.updatedAt) || 0, createdAt: Number(value.createdAt) || 0, claudeHome: value.claudeHome, fusion: value.fusion, openFusion: value.openFusion, plannerProvider: value.plannerProvider };
      if (!existing) for (const field of CONFIG_FIELDS) if (value[field] !== undefined) clean[field] = value[field];
      return [upsert(clean, existing ? {} : { origin: 'discovered' })];
    }));
  }
  function update({ chatId, revision, title, archived }) {
    return transaction(() => { const chat = get(chatId); if (!chat) throw new Error('Chat no longer exists.'); if (revision !== chat.revision) throw new Error('Chat changed. Try again.');
      if (title !== undefined) { if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('Enter a title of 1–200 characters.'); chat.title = title.trim(); chat.titleOverride = true; }
      if (archived !== undefined) { if (typeof archived !== 'boolean') throw new Error('Invalid archive state.'); chat.archived = archived; }
      chat.revision++; return put(chat); });
  }
  function confirmed(chatId) {
    return transaction(() => { const chat = get(chatId); if (!chat?.conversation) throw new Error('Chat identity is unavailable.');
      chat.pending = false; chat.revision++; put(chat);
      const workspace = readMeta('workspace');
      if (workspace) for (const { pane } of paneEntries(workspace)) if (key(fromSession(pane)) === chat.nativeKey) pane.threadSelectionPending = undefined;
      if (workspace) writeMeta('workspace', workspace);
      return chat;
    });
  }
  function saveCopy({ chatId, value }) {
    if (!get(chatId) || !value || !Array.isArray(value.messages)) throw new Error('Invalid recovery copy.');
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new Error('Recovery copy exceeds its size limit.');
    return transaction(() => {
      db.prepare('INSERT INTO copies VALUES(?,?,?) ON CONFLICT(chatId) DO UPDATE SET value=excluded.value,capturedAt=excluded.capturedAt').run(chatId, serialized, now());
      while (db.prepare('SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes FROM copies').get().bytes > 200 * 1024 * 1024) db.prepare('DELETE FROM copies WHERE chatId=(SELECT chatId FROM copies ORDER BY capturedAt LIMIT 1)').run();
      return { saved: true };
    });
  }
  function draft({ owner, text, revision }) {
    if (typeof owner !== 'string' || owner.length > 8192 || !/^(native:|pane:)/.test(owner) || typeof text !== 'string' || text.length > 1000000 || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid draft.');
    const current = db.prepare('SELECT * FROM drafts WHERE owner=?').get(owner);
    if (current && current.revision > revision) return { saved: false, revision: current.revision };
    if (current && current.revision === revision && current.text !== text) throw new Error('Draft changed in another view.');
    db.prepare('INSERT INTO drafts VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET text=excluded.text,revision=excluded.revision').run(owner, text, revision);
    return { saved: true, revision };
  }
  async function makeBackup() {
    const destination = path.join(directory, 'chat-workspace.backup.sqlite');
    const temporary = destination + '.tmp';
    await backup(db, temporary);
    const check = new DatabaseSync(temporary, { readOnly: true });
    try { if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Chat backup validation failed.'); } finally { check.close(); }
    for (let index = 2; index >= 1; index--) {
      const previous = index === 1 ? destination : destination + '.' + (index - 1);
      if (fs.existsSync(previous)) fs.copyFileSync(previous, destination + '.' + index);
    }
    fs.renameSync(temporary, destination);
    writeMeta('backupAt', now());
    return { saved: true };
  }
  return { bootstrap, checkpoint, observe, observeChat, list, get, importConversations, update, confirmed, draft, backup: makeBackup,
    backupIfDue: () => !readMeta('backupAt') || now() - readMeta('backupAt') > 24 * 60 * 60 * 1000 ? makeBackup() : { saved: true },
    saveCopy, readCopy: chatId => parse(db.prepare('SELECT value FROM copies WHERE chatId=?').get(chatId)?.value),
    scopes: () => {
      const grouped = new Map();
      for (const chat of list({ all: true }).filter(c => c.conversation)) {
        const value = chat.conversation;
        const scopeKey = JSON.stringify([value.provider, value.cwd, value.claudeHome, value.openFusion, value.fusion, value.providerProfileId]);
        if (!grouped.has(scopeKey)) grouped.set(scopeKey, { ...value, ownedThreadIds: [] });
        grouped.get(scopeKey).ownedThreadIds.push(value.id);
      }
      return [...grouped.values()];
    },
    // Recorded before anything else a shutdown does, so a run that is killed
    // part way through one is still distinguishable from a crash.
    shutdown: ({ reason } = {}) => { mergeRun({ shutdownRequestedAt: now(), shutdownReason: reason ? String(reason).slice(0, 40) : undefined }); return { saved: true }; },
    finish: ({ clean = true, incomplete = [] } = {}) => { mergeRun({ clean, finishedAt: now(),
      incomplete: (Array.isArray(incomplete) ? incomplete : []).slice(0, 20).map(step => String(step).slice(0, 40)) }); return { saved: true }; },
    close: () => { if (!closed) { closed = true; db.close(); } } };
  } catch (error) { try { db.close(); } catch {} throw error; }
}
module.exports = { createChatStore };
