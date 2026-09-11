'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { installOrchestrator } = require('../../backend/orchestratorIntegration.cjs');
const tick = () => new Promise(setImmediate);
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-startup-integration-'));
  const ipc = new EventEmitter(); ipc.handlers = new Map(); ipc.handle = (name, fn) => ipc.handlers.set(name, fn);
  const app = new EventEmitter(); app.getPath = () => root;
  const main = { isDestroyed: () => false, webContents: new EventEmitter() };
  const runtime = { id: 'p', generation: 'g', launchToken: 1, provider: 'codex', cwd: root, observation: 'observed',
    processState: 'running', launchState: 'ready', agentProcessState: 'running', turnState: 'unknown', revision: 1 };
  const f = { sent: [], runtime, uiToken: 1 };
  main.webContents.send = (channel, action) => {
    if (channel !== 'orchestrator:ui-action') return;
    if (action.kind === 'create_session') {
      queueMicrotask(() => ipc.emit('orchestrator:ui-result', { sender: main.webContents }, { id: action.id, result: { ok: true, id: 'p', launchToken: 1 } }));
      return;
    }
    assert.equal(action.kind, 'inventory');
    queueMicrotask(() => ipc.emit('orchestrator:ui-result', { sender: main.webContents }, { id: action.id, result: { ok: true,
      sessions: [{ id: 'p', kind: 'codex', cwd: root, started: true, launchToken: f.uiToken }], projectPaths: [root] } }));
  };
  const integration = f.integration = installOrchestrator({ app, ipcMain: ipc, BrowserWindow: { getAllWindows: () => [main] },
    screen: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => false }, getMainWindow: () => main,
    getRuntime: () => ({ listSnapshots: () => [runtime] }), getTelemetry: () => ({}), getChanges: () => ({}),
    sendFusion: () => false, sendOpenFusion: () => false, launchTimeoutMs: 1000, startupPollMs: 1,
    sendPty: message => { f.sent.push(message); queueMicrotask(() => f.event({ type: 'action-result', actionId: message.payload.actionId, ...(f.ack ? f.ack(message) : { ok: true, status: 'written' }) })); return true; } });
  f.event = event => integration.incoming('terminal', { id: 'p', generation: 'g', ...event });
  f.invoke = payload => ipc.handlers.get('orchestrator:dispatch')({ sender: main.webContents }, payload);
  f.cancel = () => ipc.handlers.get('orchestrator:cancel')({ sender: main.webContents });
  f.ready = () => f.event({ type: 'data', sequence: 2, data: '\x1b[2J\x1b[HOpenAI Codex\r\nmodel: gpt-5.6\r\n› \x1b[?25h' });
  await integration.refreshInventory();
  f.event({ type: 'created', pid: 99, cols: 80, rows: 24, inputRevision: 0 });
  f.event({ type: 'agent-process', phase: 'start', pid: 42 });
  assert.equal((await f.invoke({ kind: 'create_session', kindOfSession: 'codex', cwd: root })).ok, true);
  t.after(async () => {
    await integration.dispose();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('vibe-startup-integration-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}

test('restart creation arrives before renderer inventory without losing the new PID or accepting old events', async t => {
  const f = await fixture(t);
  f.integration.forgetTerminal('p', 'g');
  f.runtime.generation = 'replacement'; f.runtime.launchToken = 2;
  assert.equal(f.integration.directory.get('p').generation, 'paused:p:1');
  assert.equal(f.event({ generation: 'replacement', type: 'created', pid: 199, cols: 80, rows: 24 }), true);
  f.event({ generation: 'replacement', type: 'agent-process', phase: 'start', pid: 142 });
  f.uiToken = 2; await f.integration.refreshInventory();
  assert.equal(f.integration.directory.get('p').terminalPid, 199);
  assert.equal(f.integration.directory.get('p').agentPid, 142);
  assert.equal(f.event({ type: 'created', pid: 99 }), false);
  assert.equal(f.event({ type: 'agent-process', phase: 'exit', pid: 42 }), false);
  assert.equal(f.integration.directory.get('p').terminalPid, 199);
  assert.equal(f.integration.directory.get('p').agentPid, 142);
});

for (const mode of ['operator', 'nonoperator', 'task-staging']) test(`${mode} initial prompt crosses real directory, decoder and transport only after ready`, async t => {
  const f = await fixture(t);
  const action = { kind: mode === 'task-staging' ? 'terminal_interact' : 'send_prompt', actionId: 'first', target: { id: 'p', generation: 'g' },
    text: 'Keep this exact task', ...(mode !== 'nonoperator' && { operator: true, requestId: 'owner', observationSequence: 0, inputRevision: 0 }),
    ...(mode === 'task-staging' && { inputPurpose: 'task', submit: false }) };
  let settled = false;
  const pending = f.invoke(action).then(result => { settled = true; return result; });
  await tick(); await tick(); assert.equal(settled, false); assert.equal(f.sent.length, 0);
  f.event({ type: 'data', sequence: 1, data: 'OpenAI Codex\r\nmodel: loading\r\n› \x1b[?25l' });
  await tick(); await tick(); assert.equal(settled, false); assert.equal(f.sent.length, 0);
  f.ready();
  const result = await pending;
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].payload.kind, 'interaction'); assert.equal(f.sent[0].payload.text, action.text);
  assert.equal(f.sent[0].payload.submit, mode !== 'task-staging');
  assert.equal(f.sent[0].payload.interactionEvidence.sequence, 2);
  assert.equal((await f.invoke(action)).ok, true); assert.equal(f.sent.length, 1);
});

test('real input revision advance during startup cancels pending prompt without touching the PTY', async t => {
  const f = await fixture(t);
  const pending = f.invoke({ kind: 'send_prompt', target: { id: 'p', generation: 'g' }, actionId: 'first', text: 'Task',
    operator: true, requestId: 'owner', observationSequence: 0, inputRevision: 0 });
  await tick(); await tick();
  f.event({ type: 'input-state', inputRevision: 1, manualInputPending: true });
  f.ready();
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.delivery, 'not-dispatched'); assert.equal(result.reason, 'input-revision-changed');
  assert.equal(f.sent.length, 0);
});

test('startup repaint rejection retries one exact prompt with fresh transport identity and original task ownership', async t => {
  const f = await fixture(t); f.ready();
  f.ack = () => {
    if (f.sent.length === 1) {
      f.event({ type: 'data', sequence: 3, data: '\x1b[?25h' });
      return { ok: false, status: 'stale-observation', delivery: 'not-dispatched' };
    }
    return { ok: true, status: 'written', delivery: 'pty-transport-only' };
  };
  const action = { kind: 'send_prompt', target: { id: 'p', generation: 'g' }, actionId: 'original', text: 'One exact task',
    operator: true, requestId: 'owner', observationSequence: 2, inputRevision: 0 };
  const result = await f.invoke(action);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.actionId, 'original');
  assert.equal(f.sent.length, 2);
  const [first, retry] = f.sent.map(message => message.payload);
  assert.notEqual(first.actionId, retry.actionId); assert.equal(retry.text, first.text);
  assert.equal(retry.requestId, 'owner'); assert.equal(retry.expectedAgentPid, first.expectedAgentPid);
  assert.equal(retry.interactionEvidence.inputRevision, 0); assert.equal(retry.interactionEvidence.sequence, 3);
  assert.equal(f.integration.directory.get('p').generation, 'g');
  assert.deepEqual(await f.invoke(action), result, 'The original action deduplicates the entire recovery');
  assert.equal(f.sent.length, 2, 'A repeated original action cannot create another transport attempt');
});

for (const mode of ['unknown', 'input-change', 'repeated-repaint', 'recipient-change', 'cancel']) test(`startup recovery remains bounded and respects ${mode}`, async t => {
  const f = await fixture(t); f.ready();
  f.ack = () => {
    if (mode === 'unknown') return { ok: false, status: 'unknown' };
    if (mode === 'input-change') f.event({ type: 'input-state', inputRevision: 1 });
    if (mode === 'recipient-change') f.event({ type: 'agent-process', phase: 'start', pid: 43 });
    if (mode === 'cancel') void f.cancel();
    return { ok: false, status: 'stale-observation', delivery: 'not-dispatched' };
  };
  const result = await f.invoke({ kind: 'send_prompt', target: { id: 'p', generation: 'g' }, actionId: 'original', text: 'One task',
    operator: true, requestId: 'owner', observationSequence: 2, inputRevision: 0 });
  assert.equal(result.ok, false);
  assert.equal(f.sent.filter(message => message.payload.kind === 'interaction').length, mode === 'repeated-repaint' ? 3 : 1);
  if (mode === 'input-change') assert.equal(result.reason, 'input-revision-changed');
});
