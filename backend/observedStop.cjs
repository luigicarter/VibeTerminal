'use strict';

const { execFileSync } = require('node:child_process');

const identity = value => ({ id: value.id, launchToken: Number(value.launchToken), ...(value.generation !== undefined && { generation: value.generation }) });
const matches = (actual, expected) => actual.id === expected.id && actual.launchToken === Number(expected.launchToken)
  && (expected.generation === undefined || actual.generation === expected.generation);
const result = (payload, process, error, extra = {}) => ({ operationId: payload.operationId, id: payload.id,
  launchToken: payload.launchToken, generation: payload.generation, ok: ['stopped', 'already-absent'].includes(process), process,
  ...(error && { error }), ...extra });
const valid = p => p && typeof p.operationId === 'string' && p.operationId.length > 0 && p.operationId.length <= 200
  && typeof p.id === 'string' && p.id.length > 0 && p.id.length <= 500 && Number.isSafeInteger(p.launchToken) && p.launchToken >= 0
  && (p.generation === undefined || typeof p.generation === 'string' && p.generation.length > 0 && p.generation.length <= 500
    || Number.isSafeInteger(p.generation) && p.generation >= 0);

// A kill acknowledgment is never exit evidence. On Windows, require the tree
// kill to succeed as well as observing the original root's exit event.
function killObservedProcess(child) {
  if (!child) throw new Error('The original process handle is unavailable.');
  if (process.platform === 'win32') {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('The original process identity is unavailable.');
    execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    return true;
  }
  if (child.kill() === false) throw new Error('The process rejected termination.');
  throw new Error('The root was signalled, but process-tree exit proof is unavailable on this platform.');
}

// The registry owns resource references independently of the UI/session maps.
// Call track at spawn, before ordinary listeners can discard a closed session.
function createHostStopObserver({ lookup, kill = killObservedProcess, emit, timeoutMs = 10000 }) {
  const records = new Set(), operations = new Map(), resources = new WeakMap();
  function track(scope, resource, subscribe) {
    if (!resource || resources.has(resource)) return;
    const record = { scope: identity(scope), resource, exited: false, listeners: new Set(), killRequested: false, treeStopAcknowledged: false };
    resources.set(resource, record); records.add(record);
    const exited = () => { record.exited = true; for (const notify of record.listeners) notify(); };
    if (subscribe) subscribe(exited);
    else {
      resource.once('exit', exited);
      // Node spawn failure has close but no exit, and no process ever existed.
      resource.once('close', () => { if (!resource.pid) { record.neverSpawned = true; exited(); } });
      if (resource.exitCode != null || resource.signalCode != null) exited();
    }
    // Never evict unresolved process evidence.
    if (records.size > 1000) for (const old of records) {
      if (old.exited && (old.treeStopAcknowledged || old.neverSpawned) && !old.listeners.size) records.delete(old);
      if (records.size <= 800) break;
    }
    return record;
  }
  function stop(payload, retire = () => {}) {
    if (!valid(payload)) return Promise.resolve(result(payload || {}, 'failed', 'Invalid observed-stop identity.'));
    const signature = JSON.stringify(identity(payload));
    const old = operations.get(payload.operationId);
    if (payload.observeOnly === true) {
      let value;
      if (!old || old.signature !== signature) value = result(payload, 'unknown', 'No matching observed-stop operation is retained.');
      else if (old.records?.length && old.records.every(record => record.exited && (record.treeStopAcknowledged || record.neverSpawned) && !record.killError)) value = result(payload, 'stopped');
      else value = old.lastResult || result(payload, 'unknown', 'The original process stop is still pending.');
      emit?.({ type: 'stop-observed-result', ...value });
      return Promise.resolve(value);
    }
    if (old) return old.signature === signature ? old.promise : Promise.resolve(result(payload, 'failed', 'Stop operation identity changed.'));
    const operation = { signature };
    // Install before callbacks/exit handlers can re-enter.
    operation.promise = Promise.resolve().then(async () => {
      const current = lookup(payload.id);
      if (current && !matches(identity(current), payload)) return result(payload, 'superseded', 'The pane process has been replaced.');
      const selected = [...records].filter(record => matches(record.scope, payload));
      operation.records = selected;
      if (current && !selected.length) return result(payload, 'unknown', 'The current process has no retained exit evidence.');
      if (!selected.length) return result(payload, 'already-absent');
      const failedKill = selected.find(record => record.killError);
      if (failedKill) return result(payload, 'failed', failedKill.killError);
      const unverifiedPastTree = selected.some(record => record.exited && !record.treeStopAcknowledged && !record.neverSpawned);
      const active = selected.filter(record => !record.exited);
      if (!active.length) { retire(); return result(payload, unverifiedPastTree ? 'unknown' : 'already-absent', unverifiedPastTree ? 'The root process exited before its owned process tree could be verified.' : undefined); }
      let settle;
      const finished = new Promise(resolve => { settle = resolve; });
      const check = () => { if (active.every(record => record.exited)) settle('stopped'); };
      for (const record of active) record.listeners.add(check);
      const timer = setTimeout(() => settle('unknown'), timeoutMs);
      try {
        for (const record of active) if (!record.killRequested) {
          // A possibly dispatched failed kill is not replayed on a later read.
          record.killRequested = true;
          try { if (kill(record.resource) === false) throw new Error('The process rejected termination.'); record.treeStopAcknowledged = true; }
          catch (error) { record.killError = String(error?.message || error).slice(0, 500); }
        }
        retire(); check();
        const failed = active.find(record => record.killError);
        if (failed) return result(payload, 'failed', failed.killError);
        const state = await finished;
        if (unverifiedPastTree) return result(payload, 'unknown', 'An earlier root exited before its owned process tree could be verified.');
        return result(payload, state, state === 'unknown' ? 'Process exit was not observed before the deadline.' : undefined);
      } finally { clearTimeout(timer); for (const record of active) record.listeners.delete(check); }
    }).catch(error => result(payload, 'unknown', String(error?.message || error).slice(0, 500))).then(value => {
      operation.done = true;
      operation.lastResult = value;
      emit?.({ type: 'stop-observed-result', ...value });
      if (operations.size > 500) for (const [key, prior] of operations) {
        if (prior.done && key !== payload.operationId) operations.delete(key);
        if (operations.size <= 400) break;
      }
      return value;
    });
    operations.set(payload.operationId, operation);
    return operation.promise;
  }
  return { track, stop };
}

// Synchronous tombstones reject delayed IPC starts for a closed launch token;
// pending operations settle even if their replacement has already been admitted.
function createObservedLaunchFence({ capacity = 4096 } = {}) {
  const entries = new Map();
  // A pane can change providers. Its launch high-water mark must span them;
  // otherwise closing old Fusion could cancel a new Open Fusion preparation.
  const key = (_kind, id) => id;
  function run(kind, payload, operation) {
    if (!payload?.id) return Promise.resolve({ ok: false, error: 'Missing session id.' });
    const k = key(kind, payload.id), token = Number(payload.launchToken || 0), old = entries.get(k);
    if (!old && entries.size >= capacity) return Promise.resolve({ ok: false, error: 'Launch identity history is full. Restart the application before opening more panes.' });
    if (old && (token < old.launchToken || token === old.launchToken && (old.closed || old.kind !== kind))) return Promise.resolve({ ok: false, cancelled: true, status: 'superseded' });
    const entry = old?.launchToken === token ? old : { id: payload.id, kind, launchToken: token, pending: new Set(), closed: false, dispatched: false };
    entries.set(k, entry);
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    entry.pending.add(promise);
    void promise.finally(() => entry.pending.delete(promise)).catch(() => {});
    // Runtime admission must remain synchronous, before a competing close or
    // start can inspect the pane. Install its wait before invoking callbacks.
    try { Promise.resolve(operation(entry)).then(resolve, reject); } catch (error) { reject(error); }
    return promise;
  }
  function outgoing(kind, payload, host) {
    const entry = entries.get(key(kind, payload.id));
    if (!entry || entry.kind !== kind || entry.closed || entry.launchToken !== Number(payload.launchToken || 0)) return false;
    if (payload.generation !== undefined) entry.generation = payload.generation;
    entry.dispatched = true;
    entry.host = host;
    return true;
  }
  function cancel(kind, payload, cleanup = () => {}) {
    const k = key(kind, payload.id), old = entries.get(k);
    if (!old && entries.size >= capacity) return { error: 'Launch identity history is full; absence cannot be certified.' };
    if (old && (old.kind !== kind || old.launchToken !== Number(payload.launchToken) || payload.generation !== undefined && old.generation !== undefined && old.generation !== payload.generation)) return { superseded: true };
    const entry = old || { ...identity(payload), kind, pending: new Set(), dispatched: false };
    entry.closed = true; entries.set(k, entry);
    // Invoke cleanup synchronously to enter the preparation queue before any
    // replacement. Awaiting before this step could cancel the replacement.
    let cleanupResult;
    try { cleanupResult = cleanup(entry); } catch (error) { cleanupResult = Promise.reject(error); }
    return { entry, settled: Promise.allSettled([...entry.pending, cleanupResult]).then(results => {
      const failure = results.find(item => item.status === 'rejected');
      if (failure) entry.cleanupError = String(failure.reason?.message || failure.reason).slice(0, 500);
      return entry;
    }) };
  }
  return { run, outgoing, cancel, canSend: (kind, payload) => {
    const entry = entries.get(key(kind, payload.id));
    return Boolean(entry && entry.kind === kind && !entry.closed && entry.launchToken === Number(payload.launchToken || 0));
  }, get: (kind, id) => entries.get(key(kind, id)) };
}

function createObservedStopBroker({ prepare, send, timeoutMs = 12000 }) {
  const operations = new Map();
  async function stop(payload) {
    if (!valid(payload)) return result(payload || {}, 'failed', 'Invalid observed-stop identity.', { launchSettled: false });
    const signature = JSON.stringify([identity(payload), payload.kind]);
    const old = operations.get(payload.operationId);
    if (payload.observeOnly === true) {
      if (!old || old.signature !== signature) return result(payload, 'unknown', 'No matching stop operation is retained.', { launchSettled: false });
      if (old.lastResult && ['stopped', 'already-absent', 'superseded'].includes(old.lastResult.process)) return old.lastResult;
      if (!old.expected) return old.lastResult || result(payload, 'unknown', 'Launch cancellation is still pending.', { launchSettled: old.launchSettled });
      if (old.readPromise) return old.readPromise;
      old.readPromise = new Promise(resolve => {
        old.readFinish = value => { clearTimeout(old.readTimer); old.readFinish = undefined; old.readPromise = undefined; resolve(value); };
        old.readTimer = setTimeout(() => old.readFinish?.(result(payload, 'unknown', 'Stop observation timed out.', { launchSettled: old.launchSettled })), 2000);
      });
      const reading = old.readPromise;
      try { if (!send({ ...old.expected, observeOnly: true })) old.readFinish?.(result(payload, 'unknown', 'The original process host is unavailable.', { launchSettled: old.launchSettled })); }
      catch (error) { old.readFinish?.(result(payload, 'unknown', String(error?.message || error).slice(0, 500), { launchSettled: old.launchSettled })); }
      return reading;
    }
    if (old) return old.signature === signature ? old.promise : result(payload, 'failed', 'Stop operation identity changed.', { launchSettled: false });
    const op = { signature, payload, launchSettled: false };
    op.promise = new Promise(resolve => {
      op.finish = value => { op.lastResult = value; if (op.done) return; op.done = true; clearTimeout(op.timer); resolve(value); };
      op.timer = setTimeout(() => op.finish(result(payload, 'unknown', 'Stop verification timed out.', { launchSettled: op.launchSettled })), timeoutMs);
    });
    operations.set(payload.operationId, op);
    void Promise.resolve().then(() => prepare(payload)).then(prepared => {
      if (op.done) return;
      op.launchSettled = prepared.launchSettled === true;
      op.cleanupError = prepared.cleanupError;
      if (prepared.process) return op.finish(result(payload, prepared.process, prepared.error, { launchSettled: op.launchSettled }));
      if (!op.launchSettled) return op.finish(result(payload, 'unknown', 'Launch cancellation is not yet confirmed.', { launchSettled: false }));
      const scoped = { ...payload, ...(payload.generation === undefined && prepared.generation !== undefined && { generation: prepared.generation }) };
      op.expected = scoped;
      if (!send(scoped)) op.finish(result(payload, op.cleanupError ? 'failed' : prepared.neverDispatched ? 'already-absent' : 'unknown', op.cleanupError || (prepared.neverDispatched ? undefined : 'The process host is unavailable.'), { launchSettled: op.launchSettled }));
    }).catch(error => op.finish(result(payload, 'failed', String(error?.message || error).slice(0, 500), { launchSettled: op.launchSettled })));
    void op.promise.then(() => {
      if (operations.size > 500) for (const [id, prior] of operations) { if (prior.done && id !== payload.operationId) operations.delete(id); if (operations.size <= 400) break; }
    });
    return op.promise;
  }
  function receive(event) {
    const op = operations.get(event?.operationId);
    if (!op || !op.expected || event.type !== 'stop-observed-result' || !matches(identity(event), op.expected)) return false;
    if (!['stopped', 'already-absent', 'failed', 'unknown', 'superseded'].includes(event.process)) return false;
    const value = result(op.payload, op.cleanupError && ['stopped', 'already-absent'].includes(event.process) ? 'failed' : event.process, op.cleanupError || event.error, { launchSettled: op.launchSettled });
    op.finish(value); op.readFinish?.(value);
    return true;
  }
  return { stop, receive };
}

module.exports = { createHostStopObserver, createObservedLaunchFence, createObservedStopBroker, killObservedProcess };
