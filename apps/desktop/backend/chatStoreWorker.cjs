'use strict';
let store;
let chain = Promise.resolve();
process.on('message', message => {
  chain = chain.then(async () => {
    try {
      if (!store) store = require('./chatStore.cjs').createChatStore({ directory: message.directory });
      if (!['bootstrap', 'checkpoint', 'observe', 'observeChat', 'list', 'get', 'importConversations', 'update', 'confirmed', 'draft', 'backup', 'backupIfDue', 'shutdown', 'finish', 'scopes', 'saveCopy', 'readCopy'].includes(message.method)) throw new Error('Unknown chat operation.');
      const result = await store[message.method](message.input);
      process.send?.({ id: message.id, result });
    } catch (error) { process.send?.({ id: message.id, error: error.message }); }
  });
});
process.on('disconnect', () => { void chain.finally(() => { store?.close(); process.exit(0); }); });
