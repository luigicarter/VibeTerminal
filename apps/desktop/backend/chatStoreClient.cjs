'use strict';
const path = require('node:path');
const { fork } = require('node:child_process');
function createChatStoreClient({ directory, onError = () => {}, fork: spawn = fork }) {
  let child, sequence = 0, closed = false;
  const pending = new Map();
  function fail(error) { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); onError(error.message); }
  function start() {
    if (closed) throw new Error('Chat storage is closed.');
    if (child) return child;
    const target = path.join(__dirname, 'chatStoreWorker.cjs').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    const instance = spawn(target, [], { execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child = instance;
    instance.on('message', response => { const item = pending.get(response.id); if (!item) return; clearTimeout(item.timer); pending.delete(response.id); if (response.error) { onError(response.error); item.reject(new Error(response.error)); } else item.resolve(response.result); });
    instance.on('error', error => { if (child === instance) { child = null; fail(error); } });
    instance.on('exit', () => { if (child === instance) { child = null; fail(new Error('Chat storage stopped. Restart Lina to recover saved chats.')); } });
    return child;
  }
  return { call(method, input) { return new Promise((resolve, reject) => { try {
    const target = start(), id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); const error = new Error('Chat storage timed out. Changes may not have been saved.'); onError(error.message); reject(error); }, 15000);
    pending.set(id, { resolve, reject, timer });
    target.send({ id, method, input, directory }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
  } catch (error) { reject(error); } }); }, close() { closed = true; const previous = child; child = null; previous?.disconnect(); fail(new Error('Chat storage closed.')); } };
}
module.exports = { createChatStoreClient };
