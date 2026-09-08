'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { installOrchestrator } = require('../../backend/orchestratorIntegration.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');

test('automatic native task crosses real creation, binding, observation and operator transport adapters', { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cohesion-'));
  const ipc = new EventEmitter(); ipc.handlers = new Map(); ipc.handle = (name, fn) => ipc.handlers.set(name, fn);
  const app = new EventEmitter(); app.getPath = () => root;
  const main = { isDestroyed: () => false, webContents: new EventEmitter() };
  const sessions = [], snapshots = [], uiActions = [], hostActions = [], dispatched = [], adapterReceipts = [];
  const launchers = [{ kind: 'codex', available: true, configured: true, label: 'Codex' }];
  const target = { id: 'created-pane', generation: 'actual-native-generation', launchToken: 1 };
  const instruction = 'Fix checkout validation without changing the public API.';
  let integration, relay, phase = 0;
  const invoke = action => ipc.handlers.get('orchestrator:dispatch')({ sender: main.webContents }, action);
  main.webContents.send = (channel, action) => {
    if (channel !== 'orchestrator:ui-action') return;
    uiActions.push(action);
    let result;
    if (action.kind === 'inventory') result = { ok: true, sessions, projectPaths: [root], launchers };
    else {
      assert.equal(action.kind, 'create_session'); assert.equal(action.payload.kind, 'codex');
      assert.equal(action.payload.prompt, undefined); assert.equal(action.payload.text, undefined);
      sessions.push({ id: target.id, launchToken: 1, started: true, kind: 'codex', name: 'New Codex', cwd: root });
      snapshots.push({ ...target, provider: 'codex', cwd: root, processState: 'running', launchState: 'ready',
        agentProcessState: 'running', observation: 'observed', turnState: 'idle', revision: 1, cols: 80, rows: 24 });
      for (const event of [{ type: 'created', pid: 41, cols: 80, rows: 24, inputRevision: 0 },
        { type: 'agent-process', phase: 'start', pid: 42 }, { type: 'data', sequence: 1, data: '> ' }]) {
        integration.incoming('terminal', { id: target.id, generation: target.generation, ...event });
      }
      // Match the renderer receipt: no processState, native generation or target.
      result = { ok: true, id: target.id, launchToken: 1, status: 'created', draftStaged: false };
    }
    queueMicrotask(() => ipc.emit('orchestrator:ui-result', { sender: main.webContents }, { id: action.id, result }));
  };
  integration = installOrchestrator({ app, ipcMain: ipc, BrowserWindow: { getAllWindows: () => [main] }, screen: {}, shell: {},
    safeStorage: { isEncryptionAvailable: () => false }, getMainWindow: () => main, getRuntime: () => ({ listSnapshots: () => snapshots }),
    getTelemetry: () => ({}), getChanges: () => ({}), sendFusion: () => false, sendOpenFusion: () => false,
    sendPty: message => {
      hostActions.push(message);
      assert.equal(message.type, 'action');
      const payload = message.payload;
      assert.equal(payload.kind, 'interaction'); assert.equal(payload.submit, true);
      queueMicrotask(() => {
        integration.incoming('terminal', { id: payload.id, generation: payload.generation, type: 'input-state', inputRevision: 1,
          manualInputPending: false, interactionInputPending: false, ownerRequestId: null });
        integration.incoming('terminal', { id: payload.id, generation: payload.generation, type: 'action-result',
          actionId: payload.actionId, ok: true, status: 'written', delivery: 'pty-transport-only' });
      });
      return true;
    } });
  t.after(async () => {
    await relay?.dispose(); await integration.dispose();
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('vibe-cohesion-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await integration.refreshInventory();
  relay = createOrchestrator({ userDataPath: path.join(root, 'relay'), secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [root] }), getSessions: () => integration.directory.list(),
    getLaunchers: () => integration.directory.launchers(),
    interpretIntent: () => ({ goal: instruction, actions: [{ kind: 'delegate_task', cwd: root, text: instruction }] }),
    routeTask: () => ({ kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'This project needs a new worker.' }),
    readSession: async target => {
      const result = await invoke({ kind: 'read_session', target });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.observation;
    },
    dispatchAction: async action => {
      dispatched.push(action);
      if (action.kind === 'create_session') assert.equal(action.waitForReady, true);
      const receipt = await invoke(action); adapterReceipts.push({ kind: action.kind, ...receipt }); return receipt;
    },
    fetch: async (url, options) => {
      const response = value => new Response(JSON.stringify(value));
      if (url.endsWith('/key')) return response({ data: {} });
      if (url.endsWith('/models')) return response({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] });
      assert.ok(url.endsWith('/chat/completions'));
      const body = JSON.parse(options.body), context = JSON.parse(body.messages.find(message => message.role === 'user').content);
      const grant = context.authorizedCommands.grants.find(item => item.kind === 'operate_terminal');
      assert.ok(grant, 'The actual launch adapter receipt must bind before the operator runs');
      const targetId = grant.targets[0].id;
      let action;
      if (phase === 0 || phase === 2) action = { kind: 'read_session', targetId };
      else {
        const observed = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
        const base = { targetId, grantId: grant.id, stepId: `step-${phase}`, observationToken: observed.observationToken };
        action = phase === 1 ? { ...base, kind: 'send_prompt', text: grant.text, observationSequence: observed.observation.sequence, inputRevision: observed.observation.inputRevision }
          : { ...base, kind: 'finish_terminal', outcome: 'completed', text: 'Submission inspected.' };
      }
      assert.ok(phase < 4, 'The normal observe/send/observe/finish operator path must converge');
      return response({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `tool-${phase++}`, type: 'function',
        function: { name: 'workspace', arguments: JSON.stringify(action) } }] } }] });
    } });
  assert.equal((await relay.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true })).ok, true);
  assert.equal((await relay.setEnabled(true)).ok, true);
  const result = await relay.send({ text: instruction, origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(uiActions.filter(action => action.kind === 'create_session').length, 1);
  assert.deepEqual(dispatched.map(action => action.kind), ['create_session', 'send_prompt']);
  assert.equal(hostActions.length, 1);
  const payload = hostActions[0].payload;
  assert.equal(payload.text, instruction); assert.equal(payload.id, target.id); assert.equal(payload.generation, target.generation);
  assert.equal(payload.expectedAgentPid, 42); assert.equal(payload.actionId, dispatched[1].actionId);
  assert.ok(payload.requestId); assert.equal(payload.operator, true);
  const state = relay.getState(), task = state.tasks.find(item => item.requestId === result.requestId);
  assert.ok(task.workItemId); assert.equal(task.status, 'waiting-results', 'Transport acknowledgment cannot complete the worker task');
  const creation = adapterReceipts.find(item => item.kind === 'create_session');
  assert.equal(creation.processState, 'running'); assert.equal(creation.cwd, root); assert.equal(creation.target.generation, target.generation);
  assert.equal(state.receipts.filter(item => item.kind === 'send_prompt').length, 1);
});
