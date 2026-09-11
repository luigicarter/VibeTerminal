const path = require('path');
const { fork } = require('child_process');

function createOrchestratorHistoryProcess({ getConfig = () => ({}), timeoutMs = 60000, fork: spawn = fork } = {}) {
  let child = null; let disposed = false; let sequence = 0; let chain = Promise.resolve(); let pending = null;
  let generation = 0; const references = new Map();
  const failure = (code, message) => Object.assign(new Error(message), { code });
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
    generation++;
    instance.on('error', () => { if (child === instance) fail('Conversation history helper failed. List history again; references have expired.'); });
    instance.on('exit', () => { if (child === instance) fail('Conversation history helper exited. List history again; references have expired.'); });
    instance.on('message', message => {
      if (child !== instance || !pending || message?.id !== pending.id) return;
      const task = pending; pending = null; clearTimeout(task.timer);
      if (message.error) task.reject(failure(message.code, message.error)); else task.resolve(message.result);
    });
    return instance;
  }
  function request(method, input) {
    const operation = chain.then(async () => {
      const config = await getConfig(); const instance = ensure();
      async function call(operation, value) { return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => fail('Conversation history lookup timed out. Narrow the provider or folder and list again; references have expired.'), timeoutMs);
        timer.unref?.(); pending = { id, timer, resolve, reject };
        instance.send({ id, method: operation, input: value, config }, error => { if (error && child === instance) fail('Conversation history helper is unavailable. List history again.'); });
      }); }
      const binding = JSON.stringify([config.homes || {}, config.openFusion || {}]);
      if (method !== 'list') {
        const reference = typeof input === 'string' ? input : input?.reference;
        const saved = references.get(reference);
        if (!saved || saved.binding !== binding) throw failure('HISTORY_NEEDS_LIST', 'Unknown or expired conversation reference. List history again.');
        if (saved.generation !== generation) {
          const refreshed = await call('refresh', saved.identity);
          saved.current = refreshed.reference; saved.generation = generation;
          if (input?.cursor) throw failure('HISTORY_CURSOR_EXPIRED', 'History service restarted. Start reading this conversation again without a cursor.');
        }
        input = typeof input === 'string' ? saved.current : { ...input, reference: saved.current };
      }
      const result = await call(method, input);
      if (method === 'list') for (const entry of result?.conversations || []) {
        const { reference, ...identity } = entry;
        if (!reference) continue;
        references.set(reference, { identity, binding, current: reference, generation });
        if (references.size > 2000) references.delete(references.keys().next().value);
      }
      return result;
    });
    chain = operation.catch(() => {});
    return operation;
  }
  return { list: input => request('list', input), read: input => request('read', input), search: input => request('search', input), resolve: reference => request('resolve', reference), dispose() { disposed = true; fail('Conversation history service was disposed.'); } };
}
module.exports = { createOrchestratorHistoryProcess };
