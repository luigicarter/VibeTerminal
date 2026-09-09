'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { createTerminalRuntime } = require('../../backend/terminalRuntime.cjs');
const { createSessionDirectory } = require('../../backend/orchestratorIntegration.cjs');
const { validateResultEvidence } = require('../../backend/orchestratorResultReports.cjs');
const file = path.resolve(__dirname, '../../frontend/terminalRuntime.ts');
const mod = new Module(file, module);
mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, file);
const { runtimeSessionStatus, runtimeStatusLabel, runtimeElapsed } = mod.exports;

function fixture(t) {
  let time = 10000;
  const runtime = createTerminalRuntime({ now: () => time, capabilities: () => ({ finalCompletion: 'authoritative' }) });
  t.after(() => runtime.dispose());
  const { generation } = runtime.beginLaunch({ id: 'p', provider: 'codex', cwd: '.', launchToken: 1 });
  const event = (type, extra = {}) => runtime.ingest({ id: 'p', generation, type, rootVerified: true,
    providerThreadId: 'root', providerTurnId: 'old', observedAt: time, ...extra });
  const input = data => runtime.recordInput({ id: 'p', generation, data });
  const state = () => runtime.getSnapshot('p');
  const directory = createSessionDirectory({ getRuntime: () => runtime });
  event('created'); event('agent-running', { turnStart: true });
  event('agent-activity', { phase: 'start', kind: 'tool', toolId: 'pre-input', toolName: 'Read' });
  time = 20000; input('\x1b'); time = 21000; input('\r');
  const display = (label, status) => {
    assert.equal(runtimeStatusLabel(state()), label);
    assert.equal(runtimeSessionStatus(state()), status);
    assert.equal(directory.get('p').status, status === 'idle' ? label : status);
    assert.equal(state().pendingInput, 'submit');
    assert.equal(state().pendingInputAt, 21000);
    assert.equal(state().turnId, 'old');
    assert.equal(state().turnStartedAt, 10000);
    assert.equal(state().observation, 'provisional', 'display cannot promote result evidence');
    assert.equal(validateResultEvidence(directory.get('p'), { source: 'terminal-screen', text: 'old result',
      turnId: 'old', status: 'completed', at: 30000 }), undefined);
  };
  return { runtime, event, input, state, display, at: value => { time = value; } };
}

test('Escape/Enter retains pending input while fresh same-turn work remains visible through thinking and completion', t => {
  const p = fixture(t);
  p.display('awaiting activity', 'idle');
  p.at(22000); p.event('agent-activity', { phase: 'start', kind: 'tool', toolId: 'fresh', toolName: 'Read' });
  p.display('working', 'running');
  assert.equal(runtimeElapsed(p.state(), 25000), '15s');
  p.at(23000); p.event('agent-activity', { phase: 'stop', kind: 'tool', toolId: 'fresh' });
  p.at(24000); p.event('agent-running', { turnStart: false, phase: 'stop', toolId: 'fresh' });
  p.display('working', 'running');
  p.at(30000); p.event('agent-attention', { attention: { state: 'completed' } });
  p.display('awaiting activity', 'idle');
  assert.equal(runtimeElapsed(p.state(), 31000), undefined);
  p.at(31000); p.event('agent-activity', { phase: 'start', toolId: 'late' });
  p.display('awaiting activity', 'idle');
  p.input('\x1b'); p.input('\r');
  p.at(31500); p.event('agent-running', { turnStart: false });
  assert.equal(p.state().pendingTurnActivity, undefined, 'new input cannot revive an ended old turn');
  p.at(32000); p.event('agent-running', { providerTurnId: 'new', turnStart: true });
  assert.equal(p.state().pendingInput, undefined);
  assert.equal(p.state().pendingTurnActivity, undefined);
  assert.equal(p.state().turnId, 'new');
  assert.equal(runtimeStatusLabel(p.state()), 'working');
});

test('old, duplicate, unidentified and out-of-order callbacks cannot manufacture continued work', t => {
  const p = fixture(t);
  for (const extra of [
    { observedAt: 20500, toolId: 'delayed' }, { toolId: 'pre-input' },
    { toolId: 'untimed', observedAt: undefined }, { phase: 'stop', toolId: 'return-only' },
  ]) {
    p.at(22000); p.event('agent-activity', { phase: 'start', kind: 'tool', ...extra });
    p.display('awaiting activity', 'idle');
  }
  p.event('agent-running', { turnStart: true });
  p.display('awaiting activity', 'idle');
  p.at(23000); p.event('agent-running', { turnStart: false });
  p.display('working', 'running');
  p.event('agent-attention', { observedAt: 22000, attention: { state: 'completed' } });
  p.display('working', 'running');
});

test('fresh approval stays visible until its own tool resumes, without accepting later input', t => {
  const p = fixture(t);
  p.at(22000); p.event('agent-attention', { toolId: 'approval', attention: { state: 'waiting', reason: 'approval' } });
  p.display('needs input', 'waiting');
  const id = p.state().pendingTurnActivity.attention.id;
  p.at(23000); p.event('agent-attention', { toolId: 'approval', attention: { state: 'waiting', reason: 'approval' } });
  assert.equal(p.state().pendingTurnActivity.attention.id, id);
  p.at(24000); p.event('agent-activity', { phase: 'start', toolId: 'parallel' });
  p.display('needs input', 'waiting');
  p.at(25000); p.event('agent-activity', { phase: 'stop', toolId: 'approval' });
  p.display('working', 'running');
});

test('child work and child questions remain separate from a pending root and its end', t => {
  const p = fixture(t);
  const child = { providerThreadId: 'child', providerTurnId: 'child-turn', parentThreadId: 'root', taskId: 'child' };
  p.at(22000); p.event('agent-running', child);
  p.display('working', 'running');
  p.at(23000); p.event('agent-attention', { attention: { state: 'completed' } });
  p.display('working', 'running');
  p.at(24000); p.event('agent-attention', { ...child, attention: { state: 'waiting', reason: 'question' } });
  p.display('needs input', 'waiting');
});

test('process exit, restart, identity conflict and new input clear continued display evidence', t => {
  for (const reason of ['exit', 'agent-exit', 'restart', 'conflict', 'input']) {
    const p = fixture(t);
    p.at(22000); p.event('agent-running', { turnStart: false });
    p.display('working', 'running');
    if (reason === 'exit') p.event('exit');
    if (reason === 'agent-exit') {
      p.event('agent-process', { phase: 'start', processId: 'owner' });
      p.event('agent-process', { phase: 'stop', processId: 'owner' });
    }
    if (reason === 'restart') p.runtime.beginLaunch({ id: 'p', provider: 'codex', cwd: '.', launchToken: 2 });
    if (reason === 'conflict') p.event('agent-running', { providerThreadId: 'different-root', turnStart: false });
    if (reason === 'input') p.input('\x1b');
    assert.equal(p.state().pendingTurnActivity, undefined, reason);
  }
});
