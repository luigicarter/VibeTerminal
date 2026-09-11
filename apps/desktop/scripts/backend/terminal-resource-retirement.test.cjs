'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHostStopObserver } = require('../../backend/observedStop.cjs');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
const { createSessionDirectory } = require('../../backend/orchestratorIntegration.cjs');

test('late creation and output cannot recreate observations after runtime retirement', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.resolve(__dirname, '../../backend/orchestratorIntegration.cjs'), 'utf8');
  const begin = source.indexOf('  function incoming(kind, event) {');
  const end = source.indexOf('  function forgetTerminal(', begin);
  assert(begin > 0 && end > begin);
  const runtime = createTerminalRuntime(), directory = createSessionDirectory({ getRuntime: () => runtime });
  let ingested = 0, acknowledged = 0;
  const context = vm.createContext({ disposed: false, directory, getRuntime: () => runtime, pendingHost: new Map(),
    queuedInputAttempts: { correlate: event => event }, observations: { ingest() { ingested++; return Promise.resolve(); } },
    observationPublications: new Set(), completions: { capture: async () => undefined },
    relay: { observeWork() {} }, publishSoon() {}, delivery: { observe: async () => {} } });
  vm.runInContext(source.slice(begin, end), context);
  try {
    const launch = runtime.beginLaunch({ id: 'p', launchToken: 1 });
    const event = { id: 'p', generation: launch.generation, type: 'created' };
    assert.equal(context.incoming('terminal', event), true);
    await Promise.resolve();
    runtime.stop({ id: 'p', generation: launch.generation });
    directory.forget('p', launch.generation);
    assert.equal(context.incoming('terminal', event), false);
    assert.equal(context.incoming('terminal', { ...event, type: 'data', data: 'late output' }), false);
    assert.equal(ingested, 1);
    context.pendingHost.set('action', { engine: 'terminal', id: 'p', generation: launch.generation, finish: () => acknowledged++ });
    context.incoming('terminal', { ...event, type: 'action-result', actionId: 'action', ok: true });
    assert.equal(acknowledged, 1, 'The exact outstanding transport receipt still settles.');
    const replacement = runtime.beginLaunch({ id: 'p', launchToken: 2 });
    assert.equal(context.incoming('terminal', { ...event, generation: replacement.generation }), true);
    assert.equal(ingested, 2);
  } finally { runtime.dispose(); }
});

test('history and stdout pressure pause the producer independently and resume after both drain', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const filename = path.resolve(__dirname, '../../backend/ptyHost.cjs');
  const realRequire = require('node:module').createRequire(filename);
  const { EventEmitter2 } = realRequire('node-pty/lib/eventEmitter2');
  const data = new EventEmitter2(), exit = new EventEmitter2();
  const child = { pid: 42, onData: data.event, onExit: exit.event, pause: () => pauses++, resume: () => resumes++, kill() {}, write() {}, resize() {} };
  const stdout = new EventEmitter(), events = [];
  let blocked = false, pauses = 0, resumes = 0;
  stdout.write = line => { events.push(JSON.parse(line)); return !blocked; };
  const context = vm.createContext({ require: name => name === 'node-pty' ? { spawn: () => child } : name === 'readline' ? { createInterface: () => ({ on() {} }) } : realRequire(name),
    process: { platform: 'win32', env: {}, stdin: {}, stdout, cwd: () => process.cwd() }, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const scope = { id: 'flow', generation: 'g', launchToken: 1, cols: 40, rows: 8 };
  const send = type => context.handleMessage({ type, payload: scope });
  try {
    send('create');
    blocked = true;
    data.fire('\x1b]2;' + 'x'.repeat(1024 * 1024));
    assert.equal(pauses, 1);
    data.fire('\x07after'); // Already-in-flight data must remain ordered.
    assert.equal(events.filter(event => event.type === 'data').length, 1);
    const history = vm.runInContext("sessions.get('flow').history", context);
    assert(history.pressure().queuedBytes >= 1024 * 1024);
    await new Promise(resolve => history.snapshot(resolve));
    assert.deepEqual(history.pressure(), { queuedBytes: 0, backpressured: false });
    assert.equal(resumes, 0, 'History drain alone must not resume a blocked transport.');
    blocked = false; stdout.emit('drain');
    assert.equal(resumes, 1);
    assert.deepEqual(events.filter(event => event.type === 'data').map(event => event.sequence), [1, 2]);
    send('kill');
    assert.equal(data._listeners.length, 0, 'Retirement detaches the listener that owns terminal history.');
    assert.equal(exit._listeners.length, 1, 'Only the stop observer retains unresolved exit evidence.');
    exit.fire({ exitCode: 0 }); assert.equal(exit._listeners.length, 0);
  } finally { send('kill'); exit.fire({ exitCode: 0 }); }
});

test('natural exit releases heavy handles and subscriptions while keeping unknown tree evidence', async () => {
  const observer = createHostStopObserver({ lookup: () => null, kill: () => assert.fail('An exited PID must never be killed again.') });
  for (let i = 0; i < 12; i++) {
    const scope = { id: `p${i}`, generation: 'g', launchToken: 1 };
    const child = new EventEmitter(); child.pid = i + 1;
    const record = observer.track(scope, child);
    child.emit('exit');
    assert.equal(record.resource, null);
    assert.equal(child.listenerCount('exit'), 0); assert.equal(child.listenerCount('close'), 0);
    assert.equal((await observer.stop({ ...scope, operationId: `stop${i}` })).process, 'unknown');
  }
});

test('PTY subscriptions retire on exit and synchronous exit during subscribe is handled', () => {
  const observer = createHostStopObserver({ lookup: () => null });
  let released = 0, exit;
  const record = observer.track({ id: 'pty', generation: 'g', launchToken: 1 }, { pid: 42 }, fn => {
    exit = fn; return { dispose: () => released++ };
  });
  exit(); assert.equal(released, 1); assert.equal(record.resource, null);
  const synchronous = observer.track({ id: 'sync', generation: 'g', launchToken: 1 }, {}, fn => {
    fn(); return { dispose: () => released++ };
  });
  assert.equal(released, 2); assert.equal(synchronous.resource, null);
});

test('closed runtime retains a compact launch fence and waits for pending preparation', async () => {
  let finish;
  const runtime = createTerminalRuntime();
  try {
    const admission = runtime.beginLaunch({ id: 'p', provider: 'claude', launchToken: 4, cwd: process.cwd() });
    admission.record.pendingEvents.push({ text: 'old transcript' });
    admission.record.createPromise = new Promise(resolve => { finish = resolve; });
    const final = runtime.stop({ id: 'p', generation: admission.generation, launchToken: 4 });
    assert.equal(final.processState, 'exited');
    const tombstone = runtime.getRecord('p');
    assert.equal(tombstone.pendingEvents, undefined); assert.equal(tombstone.identityHints, undefined);
    assert.equal(tombstone.snapshot.children, undefined); assert.equal(tombstone.snapshot.conversation, undefined);
    assert.equal(tombstone.createPromise, admission.record.createPromise);
    assert.equal(runtime.getSnapshot('p'), null); assert.deepEqual(runtime.listSnapshots(), []);
    assert.equal(runtime.isCurrent('p', admission.generation), false);
    for (const launchToken of [3, 4]) assert.equal(runtime.beginLaunch({ id: 'p', launchToken }).disposition, 'stale');
    finish(); await admission.record.createPromise; await Promise.resolve();
    assert.equal(tombstone.createPromise, null);
    const replacement = runtime.beginLaunch({ id: 'p', launchToken: 5 });
    assert.equal(replacement.disposition, 'new'); assert.notEqual(replacement.generation, admission.generation);
    assert.equal(runtime.stop({ id: 'p', generation: admission.generation, launchToken: 4 }), null);
    assert.equal(runtime.getSnapshot('p').generation, replacement.generation);
  } finally { finish?.(); runtime.dispose(); }
});

test('single-pane directory reads match list projection without copying all runtime snapshots', () => {
  const runtime = createTerminalRuntime();
  try {
    for (let i = 0; i < 24; i++) runtime.beginLaunch({ id: `p${i}`, launchToken: 1, provider: 'terminal', cwd: process.cwd() });
    const directory = createSessionDirectory({ getRuntime: () => runtime });
    directory.updateUi([{ id: 'p0', launchToken: 1, name: 'My terminal', kind: 'terminal' }, { id: 'paused', launchToken: 2 }]);
    directory.ingest('terminal', { id: 'p0', generation: runtime.getSnapshot('p0').generation, type: 'data', outputAt: 123 });
    const expected = directory.list();
    const original = runtime.listSnapshots;
    runtime.listSnapshots = () => assert.fail('A per-ID read must not enumerate all panes.');
    for (const row of expected) assert.deepEqual(directory.get(row.id), row);
    assert.equal(directory.get('absent'), undefined);
    const read = directory.get('p0'); read.children.push({ id: 'cannot-mutate' });
    assert.deepEqual(runtime.getSnapshot('p0').children, []);
    runtime.listSnapshots = original;
    directory.updateUi([{ id: 'p0', launchToken: 2, name: 'Replacement preparing' }]);
    assert.deepEqual(directory.get('p0'), directory.list().find(s => s.id === 'p0'));
    assert.equal(directory.get('p0').status, 'paused');
  } finally { runtime.dispose(); }
});

test('unchanged metadata reads do not publish new revisions and exited roots are not polled', async () => {
  let now = 0, reads = 0;
  const events = [];
  const runtime = createTerminalRuntime({ now: () => now, emit: value => events.push(value), lookup: async () => { reads++; return { status: 'not-found', threads: [] }; } });
  try {
    const { record } = runtime.beginLaunch({ id: 'p', provider: 'claude', launchToken: 1, cwd: process.cwd() });
    await runtime.refresh();
    const count = events.length;
    now += 9000; await runtime.refresh();
    assert.equal(reads, 2); assert.equal(events.length, count);
    record.snapshot.processState = 'exited';
    now += 9000; await runtime.refresh(); assert.equal(reads, 2);
  } finally { runtime.dispose(); }
});
