'use strict';
const fs = require('node:fs/promises');
const { createChatStoreClient } = require('./chatStoreClient.cjs');
const { createOrchestratorHistoryProcess } = require('./orchestratorHistoryProcess.cjs');
const { key, folder } = require('../shared/chatIdentity.cjs');
function createChatService({ directory, getHistoryConfig, confirm, notify = () => {}, store: injectedStore }) {
  let error = '', revision = 0, notifyTimer, closed = false, workspace, scopes = [], refreshQueue = Promise.resolve();
  const publish = () => { if (!notifyTimer && !closed) notifyTimer = setTimeout(() => { notifyTimer = null; notify({ revision: ++revision, error }); }, 100); };
  const store = injectedStore || createChatStoreClient({ directory, onError: message => { if (!closed) { error = message; publish(); } } });
  const history = createOrchestratorHistoryProcess({ getConfig: () => ({ ...getHistoryConfig(), scopes }) });
  const observedSignatures = new Map();
  const call = async (method, input) => { try { const result = await store.call(method, input); error = ''; return result; } catch (failure) { error = failure.message; publish(); throw failure; } };
  const schedule = fn => { const result = refreshQueue.then(fn); refreshQueue = result.catch(() => {}); return result; };
  async function read(chatId) {
    const chat = await call('get', chatId);
    if (!chat?.conversation) throw new Error('This chat has no saved transcript yet.');
    try {
      scopes = [{ ...chat.conversation, ownedThreadIds: [chat.conversation.id] }];
      const listed = await history.list({ cwd: chat.conversation.cwd, query: chat.conversation.id, limit: 200 });
      const item = listed.conversations?.find(value => key(value) === chat.nativeKey);
      if (!listed.ok || !item) throw new Error('Native history is unavailable.');
      const page = await history.read({ reference: item.reference, maxChars: 64000, maxBytes: 256000 });
      if (!page.ok || !Array.isArray(page.messages)) throw new Error(page.error || 'Native transcript is unavailable.');
      const value = { title: chat.titleOverride ? chat.title : chat.conversation.title || chat.title,
        messages: page.messages.map(message => ({ role: message.role, text: message.text })), capturedAt: Date.now(), sourceVersion: page.sourceVersion,
        limited: Boolean(page.hasMore || page.limited || page.truncated), recoveryCopy: false };
      await call('saveCopy', { chatId, value });
      return value;
    } catch (failure) {
      const copy = await call('readCopy', chatId);
      if (copy) return { ...copy, recoveryCopy: true, note: 'Native history is unavailable. This is the last local recovery copy; it cannot restore the agent’s execution context.' };
      throw failure;
    }
  }
  async function refresh(input = {}) {
    const owned = await call('scopes');
    const folders = [...new Map([...(workspace?.workspaces.map(p => p.path) || []), ...(workspace?.multiSessions.map(p => p.cwd) || []), ...owned.map(s => s.cwd)].filter(Boolean).map(cwd => [folder(cwd), cwd])).values()].filter(cwd => !input.cwd || folder(cwd) === folder(input.cwd));
    const warnings = [];
    for (const cwd of folders) {
      if (closed) break;
      scopes = [...owned.filter(s => folder(s.cwd) === folder(cwd)), ...['codex', 'open-codex', 'codex-web', 'claude', 'claude-custom', 'cursor', 'gemini', 'kimi', 'qwen', 'grok', 'opencode', 'openfusion', 'fusion'].map(provider => ({ provider, cwd }))];
      let offset = 0;
      do {
        const result = await history.list({ cwd, offset, limit: 200 });
        if (!result.ok) { warnings.push('Some saved chats could not be read. Try Refresh.'); break; }
        await call('importConversations', result.conversations || []);
        if (result.warnings?.length || result.omittedScopes) warnings.push('Some provider history is unavailable or incomplete.');
        offset = result.nextOffset;
      } while (offset !== null && offset !== undefined && offset < 10000);
      publish();
    }
    return { warnings: [...new Set(warnings)] };
  }
  return {
    async bootstrap(legacy) { const result = await call('bootstrap', legacy); workspace = result.workspace; void call('backupIfDue').catch(() => {}); return result; },
    async checkpoint(input) { const result = await call('checkpoint', input); workspace = input.workspace; publish(); return result; },
    async list() { return { chats: await call('list'), error }; },
    refresh(input) { return schedule(() => refresh(input)); },
    read(chatId) { return schedule(() => read(chatId)); },
    async update(input) { const result = await call('update', input); publish(); return result; },
    async open(chatId) {
      const chat = await call('get', chatId);
      if (!chat?.conversation) throw new Error('This chat has no saved native conversation yet. Open its existing terminal or start a new chat.');
      const value = chat.conversation;
      if (value.providerProfileId === 'default-custom') throw new Error('This older chat did not save its original provider profile. Configure a terminal for that provider and resume the exact chat there.');
      if (!(await fs.stat(value.cwd).catch(() => null))?.isDirectory()) throw new Error('This chat’s folder is unavailable. Reconnect the drive or restore the original folder, then retry.');
      const result = await confirm({ provider: value.provider, cwd: value.cwd, confirmId: value.id, claudeHome: value.claudeHome, openFusion: value.openFusion, fusion: value.fusion });
      if (result?.status !== 'found' || result.threadRef?.id !== value.id || result.rootVerified === false) throw new Error(result?.status === 'missing' ? 'This chat’s native history is missing. Its saved entry has been kept; no new conversation was started.' : result?.message || 'The exact saved chat could not be verified. Retry when its original provider store is available.');
      if (chat.pending) { await call('confirmed', chat.chatId); publish(); }
      void schedule(() => read(chatId)).catch(() => {});
      return { ...value, reference: chat.chatId, title: chat.titleOverride ? chat.title : value.title || chat.title };
    },
    draft: input => call('draft', input),
    observe(snapshot) {
      const signature = JSON.stringify([snapshot.launchToken, snapshot.selection, snapshot.conversation]);
      if (closed || observedSignatures.get(snapshot.id) === signature) return;
      observedSignatures.set(snapshot.id, signature);
      void call('observe', snapshot).then(changed => { if (changed) publish(); else observedSignatures.delete(snapshot.id); }).catch(() => observedSignatures.delete(snapshot.id));
    },
    observeChat(event) { if (!closed && event.type === 'session' && !event.replay) void call('observeChat', event).then(changed => { if (changed) publish(); }).catch(() => {}); },
    async shutdown(reason) { await call('shutdown', { reason }); },
    async finish(clean = true, incomplete = []) { await call('finish', { clean, incomplete }); },
    backup: () => call('backup'),
    close() { closed = true; clearTimeout(notifyTimer); history.dispose(); store.close(); },
    get error() { return error; }
  };
}
module.exports = { createChatService };
