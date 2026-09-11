'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { installOrchestrator } = require('../../backend/orchestratorIntegration.cjs');
const tick = () => new Promise(setImmediate);

async function fixture(t, busy) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-native-cancel-'));
  const ipc = new EventEmitter(); ipc.handlers = new Map(); ipc.handle = (name, fn) => ipc.handlers.set(name, fn);
  const app = new EventEmitter(); app.getPath = () => root;
  const main = { isDestroyed: () => false, webContents: new EventEmitter() };
  const snapshot = { id: 'p', generation: 'g', launchToken: 1, provider: 'codex', kind: 'codex', name: 'Worker', cwd: root,
    observation: 'observed', processState: 'running', agentProcessState: 'running', agentPid: 42,
    turnId: 'turn', turnStartedAt: Date.now() - 1000, turnState: busy ? 'running' : 'idle', revision: 1, childActivity: busy };
  const sent = [];
  main.webContents.send = (channel, request) => {
    if (channel === 'orchestrator:ui-action' && request.kind === 'inventory') queueMicrotask(() => ipc.emit('orchestrator:ui-result', { sender: main.webContents }, { id: request.id,
      result: { ok: true, sessions: [{ id: 'p', kind: 'codex', name: 'Worker', cwd: root, started: true, launchToken: 1 }], projectPaths: [root] } }));
  };
  const integration = installOrchestrator({ app, ipcMain: ipc, BrowserWindow: { getAllWindows: () => [main] }, screen: {},
    shell: {}, safeStorage: { isEncryptionAvailable: () => false }, getMainWindow: () => main, getRuntime: () => ({ listSnapshots: () => [snapshot] }),
    getTelemetry: () => ({}), getChanges: () => ({}), sendFusion: () => false, sendOpenFusion: () => false,
    sendPty: message => { sent.push(message); return true; } });
  const invoke = (name, payload = {}) => ipc.handlers.get(`orchestrator:${name}`)({ sender: main.webContents }, payload);
  await integration.refreshInventory();
  for (const event of [{ type: 'created', cols: 80, rows: 24, inputRevision: 0 }, { type: 'agent-process', phase: 'start', pid: 42 }, { type: 'data', sequence: 1, data: '> ' }]) integration.incoming('terminal', { id: 'p', generation: 'g', ...event });
  await invoke('dispatch', { kind: 'read_session', target: { id: 'p', generation: 'g' } });
  t.after(async () => { await integration.dispose(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('vibe-native-cancel-')); fs.rmSync(root, { recursive: true, force: true }); });
  return { integration, sent, invoke };
}

for (const busy of [false, true]) for (const mode of ['cancel', 'dispose', 'timeout']) {
  test(`${mode} cancels only the pending ${busy ? 'interaction' : 'delivery'} host action`, async t => {
    const h = await fixture(t, busy);
    if (mode === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = h.invoke('dispatch', { kind: 'send_prompt', target: { id: 'p', generation: 'g' }, text: 'New task', ...(busy ? { operator: true, requestId: 'owner', observationSequence: 1, inputRevision: 0 } : {}) });
    for (let i = 0; i < 100 && !h.sent.length; i++) { if (mode === 'timeout') t.mock.timers.tick(100); await tick(); }
    assert.equal(h.sent.length, 1); const original = h.sent[0];
    assert.equal(original.type, 'action'); assert.equal(original.payload.kind, busy ? 'interaction' : 'input');
    assert.ok(Number.isFinite(original.payload.deadlineAt)); assert.equal(original.payload.signal, undefined);
    if (mode === 'cancel') await h.invoke('cancel'); else if (mode === 'dispose') await h.integration.dispose(); else t.mock.timers.tick(15000);
    const result = await pending; assert.equal(result.status, 'unknown');
    assert.equal(h.sent.length, 2); assert.deepEqual(h.sent[1], { type: 'action-cancel', payload: { id: 'p', generation: 'g', actionId: original.payload.actionId } });
    // A late acknowledgment cannot cause another write or resolve another action.
    h.integration.incoming('terminal', { type: 'action-result', id: 'p', generation: 'g', actionId: original.payload.actionId, ok: true, status: 'written' });
    await tick(); assert.equal(h.sent.length, 2);
  });
}
