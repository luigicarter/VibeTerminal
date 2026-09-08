'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');

for (const shutdown of ['dispose', 'cancel']) test(`late creation acknowledgment after ${shutdown} respects the persistence lifetime`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-late-create-'));
  let enter, release, emissions = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const acknowledgment = new Promise(resolve => { release = resolve; });
  const sessions = [];
  const app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [root] }), getSessions: () => sessions,
    getLaunchers: () => [{ kind: 'codex', available: true, configured: true }], onChange: () => { emissions++; },
    interpretIntent: () => ({ goal: 'Fix the project.', actions: [{ kind: 'delegate_task', cwd: root, text: 'Fix the project.' }] }),
    routeTask: () => ({ kind: 'choose', decision: 'create', kindOfSession: 'codex', reason: 'Independent task.' }),
    dispatchAction: async action => {
      assert.equal(action.kind, 'create_session', 'Cancellation must prevent all prompt delivery');
      sessions.push({ id: 'created', generation: 'g1', launchToken: 1, kind: 'codex', provider: 'codex', cwd: root,
        conversationId: 'native', processState: 'running', agentProcessState: 'running', agentPid: 123, observation: 'observed', turnState: 'idle' });
      enter(); await acknowledgment;
      return { ok: true, status: 'created', id: 'created', launchToken: 1, processState: 'running', target: { id: 'created', generation: 'g1', launchToken: 1 } };
    },
    fetch: async url => new Response(JSON.stringify(url.endsWith('/key') ? { data: {} }
      : { data: [{ id: 'fixture', supported_parameters: ['tools'], context_length: 128000 }] }))
  });
  t.after(async () => { release(); await app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await app.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true }); await app.setEnabled(true);
  const pending = app.send({ text: 'Fix the project.', origin: 'text' });
  await entered;
  // Inventory can observe the created pane before its startup receipt arrives.
  await app.refresh();
  if (shutdown === 'dispose') await app.dispose(); else await app.cancel();
  assert.equal((await pending).status, 'cancelled');
  const file = path.join(root, 'orchestrator-work-items.json');
  const before = shutdown === 'dispose' ? fs.readFileSync(file, 'utf8') : undefined;
  const beforeReceipts = app.getState().receipts.length, beforeEmissions = emissions;
  release();
  // Drain the resolved adapter and inventory promise continuations, then flush
  // any writes they incorrectly scheduled after the original disposal flush.
  await new Promise(resolve => setImmediate(resolve));
  await app.dispose();
  const after = fs.readFileSync(file, 'utf8');
  if (shutdown === 'dispose') {
    assert.equal(after, before, 'The disposed instance cannot rewrite its final persisted snapshot');
    assert.equal(app.getState().receipts.length, beforeReceipts);
    assert.equal(emissions, beforeEmissions);
  } else {
    assert.equal(JSON.parse(after).items[0].binding.nativeIdentity.id, 'native', 'A live cancelled request retains its acknowledged pane');
    assert(app.getState().receipts.length > beforeReceipts);
  }
});

for (const cancellation of ['global', 'request', 'disable']) test(`${cancellation} cancellation fences pending workspace resolution and later continuity`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cancel-routing-'));
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const contexts = [], effects = [];
  const sessions = ['a', 'b'].map(id => ({ id, generation: `g-${id}`, kind: 'codex', cwd: root }));
  const app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => sessions, getRoots: () => ({ documents: root, projects: [root] }),
    resolveWorkspaceIdentity: async () => { enter(); return barrier; },
    interpretIntent: context => {
      contexts.push(context);
      return context.instruction === 'hello' ? { goal: 'Greet the user.', actions: [] }
        : { goal: 'Focus the requested terminal.', executionMode: 'direct', actions: [{ kind: 'focus_session', targetIds: [context.instruction.endsWith('b') ? 'b' : 'a'] }] };
    },
    dispatchAction: action => { effects.push(action); return { ok: true, status: 'focused' }; },
    fetch: async url => new Response(JSON.stringify(url.endsWith('/key') ? { data: {} }
      : url.endsWith('/models') ? { data: [{ id: 'fixture', supported_parameters: ['tools'], context_length: 128000 }] }
        : { choices: [{ message: { content: 'Hello.' } }] }))
  });
  t.after(async () => { release(root); await app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await app.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true });
  await app.setEnabled(true);
  const pending = app.send({ text: 'Focus a', origin: 'text' });
  await entered;
  const requestId = app.getState().tasks.at(-1).requestId;
  if (cancellation === 'disable') await app.setEnabled(false);
  else await app.cancel(cancellation === 'request' ? { requestId } : undefined);
  release(root);
  assert.equal((await pending).status, 'cancelled');
  assert.equal(app.getState().tasks.find(task => task.requestId === requestId).status, 'cancelled');
  assert.equal(effects.length, 0);
  if (cancellation === 'disable') await app.setEnabled(true);
  assert.equal((await app.send({ text: 'hello', origin: 'text' })).ok, true);
  assert.equal(contexts.at(-1).conversationTarget, null);
  assert.equal((await app.send({ text: 'Focus b', origin: 'text' })).ok, true);
  assert.deepEqual(effects.map(action => action.targetId), ['b']);
});
