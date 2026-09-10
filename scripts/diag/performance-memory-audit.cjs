'use strict';

// Offline diagnostics only: synthetic output, mocked PTYs, no model/network calls
// and no access to the installed app's profile or running processes.
// Each probe runs in a fresh Node process so GC measurements do not overlap.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '../..');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function collect() { for (let i = 0; i < 4; i++) { await tick(); global.gc(); } }
const memory = () => Object.fromEntries(['rss', 'heapUsed', 'external', 'arrayBuffers'].map(key => [key, process.memoryUsage()[key]]));
const snapshot = history => new Promise(resolve => history.snapshot(resolve));

const probes = {
  async 'exited-process-references'() {
    const { createHostStopObserver } = require('../../backend/observedStop.cjs');
    const observer = createHostStopObserver({ lookup: () => undefined });
    const refs = [];
    for (let i = 0; i < 1200; i++) {
      const resource = new EventEmitter(); resource.pid = i + 100;
      observer.track({ id: `pane-${i}`, generation: `g-${i}`, launchToken: 1 }, resource);
      refs.push(new WeakRef(resource)); resource.emit('exit', 0);
    }
    await collect();
    const retainedResources = refs.filter(ref => ref.deref()).length;
    // Keep the production owner alive across GC, as a running host would.
    const evidence = await observer.stop({ id: 'pane-0', generation: 'g-0', launchToken: 1, operationId: 'audit' });
    return { createdAndNaturallyExited: refs.length, retainedResources, firstExitEvidence: evidence.process,
      boundary: 'Real stop registry, mock process handles; no OS processes spawned.' };
  },

  async 'closed-pty-history'(trackResources = true) {
    const filename = path.join(root, 'backend/ptyHost.cjs');
    const realRequire = createRequire(filename);
    const { EventEmitter2 } = require('node-pty/lib/eventEmitter2');
    let latest;
    const context = vm.createContext({
      require: name => name === 'node-pty' ? { spawn() {
        const data = new EventEmitter2(), exit = new EventEmitter2();
        latest = { pid: 42, onData: data.event, onExit: exit.event, data, exit,
          resize() {}, write() {}, kill() { exit.fire({ exitCode: 0 }); } };
        return latest;
      } } : name === 'readline' ? { createInterface: () => ({ on() {} }) }
        : name === './observedStop.cjs' && !trackResources ? { createHostStopObserver: () => ({ track() {} }) }
        : realRequire(name),
      process: { platform: 'win32', env: {}, stdin: {}, cwd: () => root, stdout: { write() { return true; } } },
      setTimeout, clearTimeout
    });
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    await collect(); const baseline = memory(), refs = [];
    const text = Array.from({ length: 5500 }, (_, i) => `${String(i).padStart(5, '0')} ${'x'.repeat(148)}\r\n`).join('');
    for (let i = 0; i < 8; i++) {
      const scope = { id: `pane-${i}`, generation: `g-${i}`, launchToken: 1, cols: 160, rows: 28 };
      context.handleMessage({ type: 'create', payload: scope });
      refs.push(new WeakRef(latest));
      latest.data.fire(text);
      await snapshot(vm.runInContext(`sessions.get('pane-${i}').history`, context));
      latest.exit.fire({ exitCode: 0 });
      context.handleMessage({ type: 'kill', payload: scope });
      latest = null;
    }
    await collect(); const afterClosed = memory();
    return { panes: refs.length, columns: 160, scrollbackRows: 5000, stopObserverEnabled: trackResources,
      remainingSessions: vm.runInContext('sessions.size', context),
      retainedPtyObjects: refs.filter(ref => ref.deref()).length, baseline, afterClosed,
      boundary: 'Unmodified production PTY host and real xterm history; mocked native PTY using node-pty EventEmitter2.' };
  },

  async 'closed-pty-history-control'() {
    return probes['closed-pty-history'](false);
  },

  async 'unterminated-control-string'() {
    const { createTerminalHistory } = require('../../backend/terminalHistory.cjs');
    const history = createTerminalHistory(100, 28), results = [];
    try {
      history.write('\x1b]2;');
      for (let i = 1; i <= 4; i++) {
        history.write('a'.repeat(256 * 1024));
        const result = await snapshot(history);
        results.push({ payloadBytes: i * 256 * 1024, replayBytes: Buffer.byteLength(result.data),
          retainedUnfinishedSuffix: result.data.endsWith('\x1b]2;' + 'a'.repeat(i * 256 * 1024)) });
      }
      history.write('\x07');
      return { results, replayBytesAfterTerminator: Buffer.byteLength((await snapshot(history)).data),
        boundary: 'Real xterm history, non-rendering synthetic OSC string. Ordinary terminated output does not trigger this.' };
    } finally { history.dispose(); }
  },

  async 'observation-chunk-backlog'() {
    const { createTerminalObservation } = require('../../backend/terminalObservation.cjs');
    const { createTerminalHistory } = require('../../backend/terminalHistory.cjs');
    const results = [];
    for (const count of [500, 2000]) {
      const observer = createTerminalObservation(), history = createTerminalHistory(100, 28);
      const chunks = Array.from({ length: count }, (_, i) => `\x1b[Hframe-${i} ${'x'.repeat(72)}`);
      try {
        await observer.ingest({ type: 'created', id: 'pane', generation: 'g', cols: 100, rows: 28 });
        await collect(); const before = memory();
        const started = performance.now(); let pending;
        for (let i = 0; i < chunks.length; i++) pending = observer.ingest({ type: 'data', id: 'pane', generation: 'g', data: chunks[i], sequence: i + 1 });
        const enqueueMs = performance.now() - started, afterEnqueue = memory();
        await pending; const observationDrainMs = performance.now() - started;
        const observed = await observer.read({ id: 'pane', generation: 'g', maxChars: 100 });
        const historyStart = performance.now();
        for (const chunk of chunks) history.write(chunk);
        await snapshot(history);
        results.push({ chunks: count, bytes: Buffer.byteLength(chunks.join('')), enqueueMs, observationDrainMs,
          coalescingHistoryDrainMs: performance.now() - historyStart, finalSequence: observed.sequence,
          retainedSampleTextBytes: observed.historyBytes, before, afterEnqueue });
      } finally { observer.dispose(); history.dispose(); }
    }
    return { results, boundary: 'Same synthetic redraw bytes in both production decoders. Observation retains intermediate screens; history coalesces writes. No renderer/IPC timing.' };
  },

  async 'directory-lookup-scaling'() {
    const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
    const { createSessionDirectory } = require('../../backend/orchestratorIntegration.cjs');
    const results = [];
    for (const panes of [1, 12, 24, 48]) {
      const runtime = createTerminalRuntime();
      for (let i = 0; i < panes; i++) runtime.beginLaunch({ id: `pane-${i}`, provider: 'terminal', launchToken: 1, cwd: root });
      let listCalls = 0;
      const directory = createSessionDirectory({ getRuntime: () => ({ getSnapshot: id => runtime.getSnapshot(id), listSnapshots() { listCalls++; return runtime.listSnapshots(); } }) });
      for (let i = 0; i < 100; i++) directory.get('pane-0');
      listCalls = 0;
      const iterations = 2000, started = performance.now();
      for (let i = 0; i < iterations; i++) directory.get('pane-0');
      const lookupMs = performance.now() - started, targetedStart = performance.now();
      for (let i = 0; i < iterations; i++) runtime.getSnapshot('pane-0');
      results.push({ panes, iterations, lookupMs, fullInventoryCopies: listCalls, targetedSnapshotMs: performance.now() - targetedStart });
      runtime.dispose();
    }
    return { results, boundary: 'Getter microbenchmark; target-only runtime snapshot omits UI merge. Not an end-to-end speedup claim.' };
  },

  async 'closed-runtime-records'() {
    const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
    let publications = 0;
    const runtime = createTerminalRuntime({ emit: () => publications++ });
    for (let i = 0; i < 1200; i++) {
      const scope = { id: `pane-${i}`, launchToken: 1, provider: 'terminal', cwd: root };
      runtime.beginLaunch(scope); runtime.stop(scope);
    }
    return { closedPanes: 1200, visibleSnapshots: runtime.listSnapshots().length,
      retainedRecords: Array.from({ length: 1200 }, (_, i) => runtime.getRecord(`pane-${i}`)).filter(Boolean).length,
      retainedFullRecords: Array.from({ length: 1200 }, (_, i) => runtime.getRecord(`pane-${i}`)).filter(record => record?.pendingEvents).length,
      publications, boundary: 'Public runtime API; compact launch tombstones remain required to reject stale launch tokens.' };
  },

  async 'output-history-publications'() {
    const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
    const { createSessionDirectory } = require('../../backend/orchestratorIntegration.cjs');
    const { createOrchestrator } = require('../../backend/orchestrator.cjs');
    const userDataPath = path.join(root, '.tmp/performance-memory-audit', `history-fixture-${Date.now()}-${process.pid}`);
    fs.mkdirSync(userDataPath, { recursive: true });
    const messages = Array.from({ length: 1500 }, (_, i) => ({ id: `m-${i}`, role: i % 2 ? 'assistant' : 'user', text: 'Synthetic retained conversation. '.repeat(64), at: Date.now() }));
    const history = JSON.stringify({ messages, receipts: [], tasks: [] });
    fs.writeFileSync(path.join(userDataPath, 'orchestrator-conversation.json'), history);
    const runtime = createTerminalRuntime();
    for (let i = 0; i < 24; i++) runtime.beginLaunch({ id: `pane-${i}`, provider: 'terminal', launchToken: 1, cwd: userDataPath });
    const directory = createSessionDirectory({ getRuntime: () => runtime });
    let publications = 0, publishedMessages = 0, activityPublications = 0;
    const relay = createOrchestrator({ userDataPath, getSessions: () => directory.list(),
      onChange: state => { publications++; publishedMessages += state.messages.length; },
      onActivity: () => { activityPublications++; },
      fetch: () => { throw new Error('No network in this fixture.'); } });
    try {
      await relay.refresh(); publications = 0; publishedMessages = 0; activityPublications = 0;
      for (let i = 0; i < 20; i++) await relay.refresh();
      const unchangedPublications = publications, started = performance.now();
      for (let i = 0; i < 20; i++) {
        directory.ingest('terminal', { id: 'pane-0', generation: runtime.getSnapshot('pane-0').generation, type: 'data', data: 'x', outputAt: Date.now() + i });
        await relay.refresh();
      }
      return { historyBytes: Buffer.byteLength(history), panes: 24, refreshesPerScenario: 20,
        unchangedPublications, changedOutputPublications: publications - unchangedPublications,
        publishedMessages, activityPublications, changedRefreshMs: performance.now() - started,
        boundary: 'Real directory and coordinator; output timestamps change, history content does not. No Electron IPC or rendered UI.' };
    } finally { await relay.dispose(); runtime.dispose(); }
  }
};

(async () => {
  const probe = process.argv[2];
  if (probe) {
    if (!global.gc || !probes[probe]) throw new Error('Use --expose-gc and a supported probe name.');
    console.log(JSON.stringify(await probes[probe]()));
    return;
  }
  const report = { at: new Date().toISOString(), node: process.version, platform: process.platform, probes: {} };
  for (const name of Object.keys(probes)) {
    const child = spawnSync(process.execPath, ['--expose-gc', __filename, name], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(`${name}: ${child.error || child.stderr || child.stdout}`);
    report.probes[name] = JSON.parse(child.stdout);
    console.error(`Completed ${name}`);
  }
  const output = path.join(root, '.tmp/performance-memory-audit', `${Date.now()}-${process.pid}`);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
