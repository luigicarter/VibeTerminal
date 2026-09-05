const path = require('path');
const { fork } = require('child_process');

function createOrchestratorHistoryProcess({ getConfig = () => ({}), timeoutMs = 60000, fork: spawn = fork } = {}) {
  let child = null; let disposed = false; let sequence = 0; let chain = Promise.resolve(); let pending = null;
  function fail(message) {
    const previous = child; child = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(message)); pending = null; }
    if (previous && previous.exitCode == null) previous.kill();
  }
  function ensure() {
    if (disposed) throw new Error('Conversation history service is disposed.');
    if (child) return child;
    const helperPath = path.join(__dirname, 'orchestratorHistoryHost.cjs').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    const instance = spawn(helperPath, [], { execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child = instance;
    instance.on('error', () => { if (child === instance) fail('Conversation history helper failed. List history again; references have expired.'); });
    instance.on('exit', () => { if (child === instance) fail('Conversation history helper exited. List history again; references have expired.'); });
    instance.on('message', message => {
      if (child !== instance || !pending || message?.id !== pending.id) return;
      const task = pending; pending = null; clearTimeout(task.timer);
      if (message.error) task.reject(new Error(message.error)); else task.resolve(message.result);
    });
    return instance;
  }
  function request(method, input) {
    const operation = chain.then(async () => {
      const config = await getConfig(); const instance = ensure();
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => fail('Conversation history lookup timed out. Narrow the provider or folder and list again; references have expired.'), timeoutMs);
        timer.unref?.(); pending = { id, timer, resolve, reject };
        instance.send({ id, method, input, config }, error => { if (error && child === instance) fail('Conversation history helper is unavailable. List history again.'); });
      });
    });
    chain = operation.catch(() => {});
    return operation;
  }
  return { list: input => request('list', input), read: input => request('read', input), search: input => request('search', input), resolve: reference => request('resolve', reference), dispose() { disposed = true; fail('Conversation history service was disposed.'); } };
}
module.exports = { createOrchestratorHistoryProcess };
