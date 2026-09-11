'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { createSessionDirectory } = require('../../backend/orchestratorIntegration.cjs');
const file = path.resolve(__dirname, '../../frontend/terminalRuntime.ts');
const mod = new Module(file, module);
mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { runtimeActiveChildCount, runtimeSessionStatus, runtimeStatusLabel } = mod.exports;
const canonical = value => ({ working: 'running', done: 'completed', 'needs input': 'waiting', 'agent failed': 'failed', 'agent exited': 'exited', 'response available': 'response', observing: 'unknown' })[value] || value;
const base = { id: 'native', generation: 'g', processState: 'running', agentProcessState: 'running', turnState: 'idle', observation: 'observed', telemetryHealth: 'available', children: [], activeTools: [], childActivity: false };

test('runtime native child traces retain uncertainty through frontend and directory projection', t => {
  const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
  const capabilities = require('../../shared/providerCapabilities.json');
  for (const taskId of ['child', undefined]) {
    const runtime = createTerminalRuntime({ capabilities: provider => capabilities[provider] });
    t.after(() => runtime.dispose());
    const launch = runtime.beginLaunch({ id: 'pane', provider: 'qwen', launchToken: 1, cwd: process.cwd(), threadRef: { provider: 'qwen', id: 'root' } });
    const event = (type, extra = {}) => runtime.ingest({ id: 'pane', generation: launch.generation, type, ...extra });
    event('created');
    const directory = createSessionDirectory({ getRuntime: () => runtime });
    const assertDisplay = (label, status) => {
      const snapshot = runtime.getSnapshot('pane');
      assert.equal(runtimeStatusLabel(snapshot), label);
      assert.equal(runtimeSessionStatus(snapshot), status);
      assert.equal(canonical(directory.get('pane').status), canonical(label));
      assert.equal(snapshot.childActivity, true);
    };
    event('agent-subagent', { phase: 'start', taskId, lifecycle: 'native', providerThreadId: 'root' });
    assertDisplay('working', 'running');
    event('agent-subagent', { phase: 'stop', taskId, lifecycle: 'native', provisional: true, providerThreadId: 'root' });
    assertDisplay('activity unverified', 'idle');
    event('agent-subagent', { phase: 'start', taskId, lifecycle: 'native', providerThreadId: 'root' });
    assertDisplay('working', 'running');
  }
});

test('provisional-only children retain uncertainty without claiming running or root completion', () => {
  const child = { id: 'child', observation: 'provisional', startedAt: 1 };
  const retained = { ...base, provider: 'codex', turnState: 'completed', activityObserved: true, children: [child], childActivity: true };
  assert.equal(runtimeActiveChildCount(retained), undefined);
  assert.equal(runtimeActiveChildCount({ ...retained, children: [], coarseChildObservation: 'provisional', turnState: 'running' }), undefined);
  assert.equal(runtimeActiveChildCount({ ...retained, coarseChildObservation: 'observed' }), 1);
  assert.equal(runtimeActiveChildCount({ ...retained, children: [child, { id: 'live', observation: 'observed' }] }), 1);
  for (const [patch, label, status] of [
    [{}, 'activity unverified', 'idle'],
    [{ turnState: 'response', observation: 'provisional' }, 'activity unverified', 'idle'],
    [{ turnState: 'unknown', observation: 'unavailable' }, 'activity unverified', 'idle'],
    [{ turnState: 'running' }, 'working', 'running'],
    [{ turnState: 'waiting' }, 'needs input', 'waiting'],
    [{ activeTools: [{ id: 'foreground' }] }, 'working', 'running'],
    [{ children: [child, { id: 'other', observation: 'observed' }] }, 'working', 'running'],
    [{ children: [{ ...child, observation: 'observed' }] }, 'working', 'running'],
    [{ children: [child, { id: 'other', observation: 'observed', attention: { id: 'q', state: 'waiting', updatedAt: 2 } }] }, 'needs input', 'waiting'],
    [{ children: [child, { id: 'background:old' }], backgroundObservation: { availability: 'unavailable' } }, 'activity unverified', 'idle'],
    [{ children: [], coarseChildObservation: 'provisional' }, 'activity unverified', 'idle'],
    [{ children: [], coarseChildObservation: 'observed' }, 'working', 'running'],
    [{ coarseChildObservation: 'observed' }, 'working', 'running'],
    [{ children: [{ id: 'other', observation: 'observed' }], coarseChildObservation: 'provisional' }, 'working', 'running'],
    [{ children: [], coarseChildObservation: 'provisional', turnState: 'running' }, 'working', 'running'],
    [{ children: [], coarseChildObservation: 'provisional', activeTools: [{ id: 'foreground' }] }, 'working', 'running'],
    [{ pendingInput: 'submit' }, 'awaiting activity', 'idle'],
    [{ processState: 'exited' }, 'exited', 'idle'],
    [{ agentProcessState: 'failed' }, 'agent failed', 'failed'],
    [{ children: [], childActivity: false }, 'done', 'done'],
  ]) {
    const snapshot = { ...retained, ...patch };
    const directory = createSessionDirectory({ getRuntime: () => ({ listSnapshots: () => [snapshot] }) });
    const projected = directory.get(snapshot.id);
    assert.equal(runtimeSessionStatus(snapshot), status, JSON.stringify(patch));
    assert.equal(runtimeStatusLabel(snapshot), label, JSON.stringify(patch));
    assert.equal(canonical(projected.status), canonical(label), JSON.stringify(patch));
    assert.equal(projected.turnState, snapshot.turnState, 'display must preserve root evidence');
    assert.equal(snapshot.childActivity, patch.childActivity ?? true, 'display must not clear unresolved child safety');
  }
});

for (const provider of [...Object.keys(require('../../shared/providerCapabilities.json')), 'claude-custom']) {
  test(`${provider}: native pane and Orchestrator display the same lifecycle evidence`, () => {
    const cases = [
      {}, { turnState: 'running' }, { turnState: 'waiting' }, { turnState: 'completed' },
      { turnState: 'completed', observation: 'provisional' }, { turnState: 'failed' },
      { turnState: 'running', processState: 'exited' }, { turnState: 'waiting', agentProcessState: 'exited' },
      { turnState: 'completed', processState: 'failed' }, { turnState: 'running', agentProcessState: 'failed' },
      { turnState: 'completed', observation: 'unavailable' }, { turnState: 'waiting', telemetryHealth: 'unavailable' },
      { turnState: 'completed', launchState: 'pending' }, { turnState: 'completed', pendingInput: 'submit' },
      { turnState: 'running', pendingInput: 'interrupt' }, { turnState: 'completed', children: [{ id: 'child' }] },
      { turnState: 'completed', childActivity: true },
      { turnState: 'unknown', observation: 'unavailable', activityObserved: true, children: [{ id: 'child' }] },
      { turnState: 'unknown', observation: 'unavailable', activityObserved: true, activeTools: [{ id: 'tool' }] },
      { turnState: 'unknown', observation: 'provisional', activityObserved: true, activeTools: [{ id: 'tool' }] },
      { turnState: 'idle', activityObserved: true, pendingInput: 'submit', children: [{ id: 'child', attention: { id: 'q', state: 'waiting', updatedAt: 1 } }] }
    ];
    for (const extra of cases) {
      const snapshot = { ...base, provider, ...extra };
      const directory = createSessionDirectory({ getRuntime: () => ({ listSnapshots: () => [snapshot] }) });
      const projected = directory.get(snapshot.id);
      assert.equal(canonical(projected.status), canonical(runtimeStatusLabel(snapshot)), JSON.stringify({ provider, extra }));
      assert.equal(projected.turnState, snapshot.turnState, 'display projection preserves raw root turn proof');
    }
  });
}

test('observed child activity and questions survive pending root input without promoting root proof', () => {
  const child = { id: 'child', startedAt: 1 };
  const snapshot = { ...base, provider: 'claude', turnState: 'unknown', observation: 'unavailable', activityObserved: true, pendingInput: 'submit', children: [child] };
  assert.equal(runtimeSessionStatus(snapshot), 'running');
  assert.equal(runtimeStatusLabel(snapshot), 'working');
  child.attention = { id: 'question', state: 'waiting', updatedAt: 2 };
  assert.equal(runtimeSessionStatus(snapshot), 'waiting');
  assert.equal(runtimeStatusLabel(snapshot), 'needs input');
  assert.equal(snapshot.turnState, 'unknown');
  assert.equal(runtimeSessionStatus({ ...snapshot, processState: 'exited' }), 'idle');
  assert.equal(runtimeSessionStatus({ ...snapshot, agentProcessState: 'failed' }), 'failed');
});

test('tool-only evidence reports work across observation grades without inventing a root turn', () => {
  for (const observation of ['observed', 'provisional', 'unavailable']) for (const turnState of ['unknown', 'idle', 'response']) {
    const snapshot = { ...base, provider: 'gemini', observation, turnState, activityObserved: true, activeTools: [{ id: 'tool' }] };
    const directory = createSessionDirectory({ getRuntime: () => ({ listSnapshots: () => [snapshot] }) });
    assert.equal(runtimeSessionStatus(snapshot), 'running');
    assert.equal(runtimeStatusLabel(snapshot), 'working');
    assert.equal(directory.get(snapshot.id).status, 'running');
    assert.equal(directory.get(snapshot.id).turnState, turnState);
    assert.equal(runtimeSessionStatus({ ...snapshot, pendingInput: 'submit' }), 'idle', 'tool activity alone does not override pending root submission');
    if (observation !== 'unavailable') assert.equal(runtimeSessionStatus({ ...snapshot, turnState: 'waiting' }), 'waiting');
  }
});

test('unavailable retained background metadata cannot claim work or completion', () => {
  const retained = { ...base, provider: 'kimi', turnState: 'completed', activityObserved: true,
    children: [{ id: 'background:task-1' }], childActivity: true,
    backgroundObservation: { source: 'kimi-task-metadata', availability: 'unavailable', observedAt: 5 } };
  const cases = [
    [{}, 'activity unverified', 'idle'],
    [{ observation: 'unavailable' }, 'activity unverified', 'idle'],
    [{ turnState: 'running', observation: 'unavailable' }, 'activity unverified', 'idle'],
    [{ turnState: 'idle' }, 'activity unverified', 'idle'],
    [{ turnState: 'running' }, 'working', 'running'],
    [{ turnState: 'waiting' }, 'needs input', 'waiting'],
    [{ activeTools: [{ id: 'foreground' }] }, 'working', 'running'],
    [{ children: [...retained.children, { id: 'native-child' }] }, 'working', 'running'],
    [{ backgroundObservation: { ...retained.backgroundObservation, availability: 'available' } }, 'working', 'running'],
    [{ pendingInput: 'submit' }, 'awaiting activity', 'idle'],
    [{ turnState: 'running', pendingInput: 'interrupt' }, 'interrupt requested', 'idle'],
    [{ processState: 'exited' }, 'exited', 'idle'],
    [{ agentProcessState: 'failed' }, 'agent failed', 'failed'],
    [{ launchState: 'pending' }, 'starting', 'starting']
  ];
  for (const [patch, label, status] of cases) {
    const snapshot = { ...retained, ...patch };
    const directory = createSessionDirectory({ getRuntime: () => ({ listSnapshots: () => [snapshot] }) });
    assert.equal(runtimeStatusLabel(snapshot), label, JSON.stringify(patch));
    assert.equal(runtimeSessionStatus(snapshot), status, JSON.stringify(patch));
    assert.equal(canonical(directory.get(snapshot.id).status), canonical(label));
    assert.equal(directory.get(snapshot.id).turnState, snapshot.turnState);
    assert.deepEqual(directory.get(snapshot.id).children, snapshot.children, 'retain diagnostic children');
  }
});

function chat(kind) {
  let time = 100;
  const directory = createSessionDirectory({ now: () => ++time });
  const generation = directory.outgoing(kind, { type: 'start', payload: { id: kind, cwd: '.' } }).payload.generation;
  const emit = (type, extra = {}) => directory.ingest(kind, { id: kind, generation, type, ...extra });
  return { directory, emit, current: () => directory.get(kind), read: () => directory.readChat({ id: kind, generation }) };
}
for (const kind of ['fusion', 'openfusion']) {
  test(`${kind}: resolution clears stale waiting, and error/restoration/interruption cannot become success`, () => {
    const { emit, current, read } = chat(kind);
    emit('result', { subtype: 'restored' });
    assert.equal(current().status, 'idle');
    assert.equal(read().completedResult, undefined);
    emit('turn-start');
    emit('permission', { requestId: 'p' });
    emit('permission-resolved', { requestId: 'p' });
    assert.equal(current().status, 'idle');
    assert.equal(current().turnState, 'idle');
    emit('assistant-text', { delta: 'Active' });
    assert.equal(current().status, 'running');
    emit('result', { isError: true, subtype: 'error_during_execution' });
    assert.equal(current().status, 'failed');
    assert.equal(read().completedResult.status, 'failed');
    emit('turn-start');
    emit('interrupted');
    const endedAt = current().turnEndedAt;
    emit('result', { gate: { passed: true } });
    assert.equal(current().status, 'interrupted');
    assert.equal(current().turnEndedAt, endedAt);
    assert.equal(read().completedResult.status, 'interrupted');
    assert.equal(current().checkEvidence, undefined);
    emit('result', { isError: true, subtype: 'error_during_execution' });
    assert.equal(current().status, kind === 'openfusion' ? 'interrupted' : 'failed', 'match each pane interrupt/result contract');
    emit('turn-start');
    emit('result');
    assert.equal(current().status, 'completed');
  });

  test(`${kind}: detached work remains active across root results and is generation scoped`, () => {
    const { directory, emit, current, read } = chat(kind);
    emit('turn-start');
    emit('background-task', { phase: 'started', taskId: 'a' });
    emit('background-task', { phase: 'started', taskId: 'a' });
    emit('result');
    assert.equal(current().status, 'running');
    assert.equal(read().status, 'running');
    assert.equal(read().childActivity, true);
    assert.equal(current().turnState, 'completed');
    assert.deepEqual(current().detachedTaskIds, ['a']);
    emit('background-task', { phase: 'settled', taskId: 'a', generation: 'stale' });
    assert.equal(current().status, 'running');
    emit('background-task', { phase: 'progress', taskId: 'unknown' });
    emit('permission', { requestId: 'p' });
    assert.equal(current().status, 'waiting');
    emit('permission-resolved', { requestId: 'p' });
    assert.equal(current().status, 'running');
    emit('background-task', { phase: 'settled', taskId: 'a' });
    assert.equal(current().childActivity, false);
    assert.equal(read().status, current().status);
    emit('background-activity', { backgroundActivity: { active: true, items: [{ id: 'b' }] } });
    assert.equal(current().status, 'running');
    emit('background-activity', { backgroundActivity: { active: false, items: [] } });
    assert.equal(current().childActivity, false);
    directory.outgoing(kind, { type: 'stop', payload: { id: kind } });
    directory.outgoing(kind, { type: 'start', payload: { id: kind, cwd: '.' } });
    assert.equal(current().status, 'starting');
    assert.equal(current().childActivity, false);
  });
}
