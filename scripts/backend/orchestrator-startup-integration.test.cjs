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
  const f = { sent: [], runtime };
  main.webContents.send = (channel, action) => {
    if (channel !== 'orchestrator:ui-action') return;
    if (action.kind === 'create_session') {
      queueMicrotask(() => ipc.emit('orchestrator:ui-result', { sender: main.webContents }, { id: action.id, result: { ok: true, id: 'p', launchToken: 1 } }));
      return;
    }
    assert.equal(action.kind, 'inventory');
    queueMicrotask(() => ipc.emit('orchestrator:ui-result', { sender: main.webContents }, { id: action.id, result: { ok: true,
      sessions: [{ id: 'p', kind: 'codex', cwd: root, started: true, launchToken: 1 }], projectPaths: [root] } }));
  };
  const integration = f.integration = installOrchestrator({ app, ipcMain: ipc, BrowserWindow: { getAllWindows: () => [main] },
    screen: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => false }, getMainWindow: () => main,
    getRuntime: () => ({ listSnapshots: () => [runtime] }), getTelemetry: () => ({}), getChanges: () => ({}),
    sendFusion: () => false, sendOpenFusion: () => false, launchTimeoutMs: 1000, startupPollMs: 1,
    sendPty: message => { f.sent.push(message); queueMicrotask(() => f.event({ type: 'action-result', actionId: message.payload.actionId, ok: true, status: 'written' })); return true; } });
  f.event = event => integration.incoming('terminal', { id: 'p', generation: 'g', ...event });
  f.invoke = payload => ipc.handlers.get('orchestrator:dispatch')({ sender: main.webContents }, payload);
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
