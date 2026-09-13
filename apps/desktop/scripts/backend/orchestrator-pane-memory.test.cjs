'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPaneMemory, sanitizePaneMemory, boundedRoster, PANE_MEMORY_LIMITS } = require('../../backend/orchestratorPaneMemory.cjs');
const { createAgentStore } = require('../../backend/orchestratorAgentStore.cjs');
const { VERSION } = require('../../shared/orchestratorAgentContract.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
// Pane memory is persisted through the agent store's real file writes, so this
// waits on timer turns rather than microtasks. A whole suite run competes for
// the machine, so the budget is generous and a timeout says what it waited for
// instead of failing later on an undefined record.
const until = async (check, label, limit = 1000) => {
  for (let i = 0; i < limit; i++) { if (check()) return true; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`Timed out waiting for ${label}.`);
};

function memoryStore(initial = {}) {
  const state = { value: { ...initial }, writes: 0 };
  return { state, paneMemory: () => structuredClone(state.value), savePaneMemory: async value => { state.writes++; state.value = structuredClone(value); return { ok: true }; } };
}

test('pane records are bounded per field and a malformed record is dropped on its own', () => {
  const cleaned = sanitizePaneMemory({
    good: { objective: 'o'.repeat(500), title: 't'.repeat(300), lastPromptText: 'p'.repeat(500), lastResultSummary: 'r'.repeat(900), status: 's'.repeat(90), lastPromptAt: 5, updatedAt: 9 },
    'bad id/../escape': { objective: 'ignored', updatedAt: 1 },
    noTime: { objective: 'ignored' },
    empty: { updatedAt: 3 },
    wrongType: 'not an object',
    negativeTime: { objective: 'kept', updatedAt: 4, lastPromptAt: -2 },
  });
  assert.deepEqual(Object.keys(cleaned).sort(), ['good', 'negativeTime']);
  assert.equal(cleaned.good.objective.length, 300);
  assert.equal(cleaned.good.title.length, 120);
  assert.equal(cleaned.good.lastPromptText.length, 200);
  assert.equal(cleaned.good.lastResultSummary.length, 400);
  assert.equal(cleaned.good.status.length, 40);
  assert.equal(cleaned.negativeTime.lastPromptAt, undefined, 'A nonsense timestamp is dropped, not stored.');
  const many = Object.fromEntries(Array.from({ length: PANE_MEMORY_LIMITS.entries + 20 }, (_, index) => [`agent-${index}`, { objective: 'o', updatedAt: index + 1 }]));
  assert.equal(Object.keys(sanitizePaneMemory(many)).length, PANE_MEMORY_LIMITS.entries);
});

test('a malformed pane record never blocks the agent store that carries it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pane-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = { agentId: 'agent-1', nativeIdentity: { provider: 'codex', home: 'C:/home', workspace: 'C:/projects/vibeTerminal' }, name: 'Codex 1', kind: 'codex' };
  fs.writeFileSync(path.join(root, 'orchestrator-agents-v1.json'), JSON.stringify({ version: VERSION, revision: 3, identities: [identity], notes: [],
    paneMemory: { 'agent-1': { objective: 'Review the release checklist.', updatedAt: 10 }, 'agent-2': { objective: 'broken' }, 'agent-3': 'nonsense' } }));
  const store = createAgentStore({ userDataPath: root, getSecrets: () => [] });
  assert.deepEqual(store.status(), { status: 'loaded', writable: true, revision: 3 });
  assert.deepEqual(store.identities(), [identity], 'Identities survive a bad pane record.');
  assert.deepEqual(store.paneMemory(), { 'agent-1': { objective: 'Review the release checklist.', updatedAt: 10 } });
  await store.savePaneMemory({ 'agent-1': { objective: 'Review the release checklist.', lastPromptText: 'Key sk-secret-value-abcdefgh please', updatedAt: 20 } });
  const reopened = createAgentStore({ userDataPath: root, getSecrets: () => ['sk-secret-value-abcdefgh'] });
  assert.equal(reopened.paneMemory()['agent-1'].lastPromptText, 'Key [redacted] please', 'Remembered text is redacted like every other stored record.');
});

test('pane memory merges patches, writes only on real change, and clears only the brain-facing parts', async () => {
  let clock = 100;
  const backing = memoryStore();
  const memory = createPaneMemory({ store: backing, now: () => clock });
  memory.remember('agent-1', { objective: 'Investigate the orchestrator performance.', title: 'Orchestrator performance' });
  clock = 200;
  memory.remember('agent-1', { lastPromptText: 'Also cover the voice overlay.', lastPromptAt: 190 });
  clock = 300;
  memory.remember('agent-1', { lastResultSummary: 'Two findings; the composer is idle.', lastResultAt: 290, status: 'completed' });
  await tick();
  assert.deepEqual(memory.get('agent-1'), { objective: 'Investigate the orchestrator performance.', title: 'Orchestrator performance',
    lastPromptText: 'Also cover the voice overlay.', lastPromptAt: 190, lastResultSummary: 'Two findings; the composer is idle.',
    lastResultAt: 290, status: 'completed', updatedAt: 300 });
  const writes = backing.state.writes;
  clock = 400;
  memory.remember('agent-1', { status: 'completed' });
  await tick();
  assert.equal(backing.state.writes, writes, 'A repeated observation is not a write.');
  assert.equal(memory.get('agent-1').updatedAt, 300);
  assert.equal(memory.clearTransient(), true);
  assert.deepEqual(memory.get('agent-1'), { objective: 'Investigate the orchestrator performance.', title: 'Orchestrator performance', status: 'completed', updatedAt: 300 });
  assert.equal(memory.clearTransient(), false, 'Clearing twice changes nothing.');
});

test('the roster joins live pane identity with what Lina remembers, newest pane first', () => {
  const memory = createPaneMemory({ store: memoryStore({
    'agent-a': { objective: 'Investigate the orchestrator performance.', title: 'Orchestrator performance', lastPromptAt: 500, lastResultSummary: 'x'.repeat(400), updatedAt: 500 },
  }), now: () => 1000, resolveAgentId: id => ({ a: 'agent-a' }[id] || null) });
  const sessions = [
    { id: 'a', name: 'Claude Code 1', conversationTitle: 'Stale title', kind: 'claude', cwd: 'C:/projects/vibeTerminal', status: 'idle', turnState: 'idle', lastActivityAt: 100 },
    { id: 'b', name: 'Codex 2', kind: 'codex', cwd: 'C:/projects/vibeTerminal', status: 'waiting', turnState: 'running', pendingInput: true, lastActivityAt: 900 },
    { id: 'c', name: 'Codex 3', kind: 'codex', cwd: 'C:/projects/other', status: 'idle', turnState: 'idle', lastActivityAt: 950 },
    { id: 'd', name: 'Closed', kind: 'codex', cwd: 'C:/projects/vibeTerminal', status: 'closed', turnState: 'idle', lastActivityAt: 999 },
  ];
  const roster = memory.roster({ cwd: 'c:/projects/vibeterminal/', sessions });
  assert.deepEqual(roster.map(row => row.id), ['b', 'a'], 'Another project and a closed pane are not in this roster.');
  // One derived state per pane: status, turnState and readiness were three names
  // for the same fact and could contradict each other inside one row.
  assert.deepEqual(roster[1], { id: 'a', name: 'Claude Code 1', title: 'Orchestrator performance', provider: 'claude', state: 'free',
    objective: 'Investigate the orchestrator performance.', lastPromptAt: 500, lastResultSummary: 'x'.repeat(200) });
  assert.equal(roster[0].state, 'needs-input');
  assert.equal(roster[0].status, undefined);
  assert.equal(roster[0].turnState, undefined);
  assert.equal(roster[0].objective, undefined, 'A pane with no memory carries only its live identity.');
  assert.deepEqual(memory.roster({ sessions }).map(row => row.id), ['c', 'b', 'a'], 'Without a project every live pane is offered.');
  // The budget drops the least recently touched rows and keeps the newest.
  const bounded = boundedRoster(memory.roster({ sessions }), { maxBytes: 120 });
  assert.equal(bounded.length, 1);
  assert.equal(bounded[0].id, 'c');
});

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pane-memory-'));
  const f = { root, contexts: [], effects: [], summaries: [],
    sessions: [{ id: 's0', generation: 'g0', launchToken: 1, name: 'Codex 1', conversationTitle: 'Release checklist review', kind: 'codex', provider: 'codex',
      cwd: root, turnState: 'idle', status: 'idle', observation: 'observed', processState: 'running', agentProcessState: 'running',
      agentPid: 7, started: true, binding: { status: 'found' }, conversation: { provider: 'codex', id: 'conv-s0' },
      home: 'C:/home', children: [], activeTools: [], childActivity: false }] };
  f.plan = context => ({ goal: context.instruction, executionMode: 'direct', actions: [{ kind: 'send_prompt', targetIds: ['s0'], text: context.instruction }] });
  f.app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false }, getSessions: () => f.sessions,
    getRoots: () => ({ documents: root, projects: [{ id: 'project', name: path.basename(root), path: root }] }),
    readSession: async ({ id, completedTurnId }) => { const session = f.sessions.find(item => item.id === id);
      return { ok: true, completedResult: { turnId: completedTurnId || session.turnId, targetId: session.id, generation: session.generation,
        status: session.turnState, at: session.turnEndedAt, source: 'chat-events', text: 'Reported two findings.' } }; },
    interpretIntent: async context => { f.contexts.push(context); return f.plan(context); },
    dispatchAction: async action => { f.effects.push(action); const session = f.sessions.find(item => item.id === action.targetId); if (session && action.kind === 'send_prompt') Object.assign(session, { turnId: `turn-${f.effects.length}`, turnState: 'running', turnStartedAt: Date.now(), actionId: action.actionId }); return { ok: true, status: 'written', turnId: session?.turnId }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'model', context_length: 128000, supported_parameters: ['tools'] }] }));
      const body = JSON.parse(options.body);
      if (!body.tools?.length) { f.summaries.push(body); return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Two findings; the pane is idle again.' } }] })); }
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', type: 'function', function: { name: 'workspace', arguments: JSON.stringify({ kind: 'respond', text: 'Done.', responseTurn: 'complete' }) } }] } }] }));
    } });
  await f.app.configure({ apiKey: 'fixture', sessionOnly: true, model: 'model' }); await f.app.setEnabled(true);
  t.after(async () => { await f.app.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return f;
}

// Pane memory is addressed by durable agent identity, and a store can hold more
// than one record. Resolve s0's own record through the native conversation it is
// bound to rather than reading whichever record happens to be first.
function paneRecord(root) {
  const store = createAgentStore({ userDataPath: root, getSecrets: () => [] });
  const identity = store.identities().find(item => item.nativeIdentity?.id === 'conv-s0');
  return identity ? store.paneMemory()[identity.agentId] : undefined;
}

test('a sent prompt and the result summary it produced are remembered on the pane itself', async t => {
  const f = await fixture(t);
  const typed = 'Review the release checklist and report what is missing.';
  const first = await f.app.send({ text: typed, origin: 'text' });
  assert.equal(first.ok, true);
  await until(() => paneRecord(f.root)?.lastPromptText === typed, "pane s0's record to remember the prompt Lina typed");
  const session = f.sessions[0];
  Object.assign(session, { turnState: 'completed', completedTurnId: session.turnId, completedActionId: session.actionId, turnEndedAt: Date.now() });
  await f.app.refresh();
  await until(() => Boolean(paneRecord(f.root)?.lastResultSummary), "pane s0's record to remember its result summary");
  const record = paneRecord(f.root);
  assert.equal(record.lastPromptText, typed);
  assert.ok(Number.isFinite(record.lastPromptAt));
  assert.match(record.lastResultSummary, /Two findings/);
  assert.ok(Number.isFinite(record.lastResultAt));
  assert.equal(record.title, 'Release checklist review');

  // The brain reads it as roster context for the addressed project, never as a
  // screen read. "what's the result?" itself is now answered by the memory fast
  // path with no model call, so the roster assertion uses a sentence that still
  // reaches the brain.
  f.plan = () => ({ goal: 'Answer from what is already known.', actions: [] });
  await f.app.send({ text: 'how is that pane doing?', origin: 'text' });
  const row = f.contexts.at(-1).roster.find(item => item.id === 's0');
  assert.equal(row.title, 'Release checklist review');
  assert.match(row.lastResultSummary, /Two findings/);
  assert.ok(Number.isFinite(row.lastPromptAt));

  // Clearing history drops what Lina said and heard and keeps the pane's title.
  await f.app.clearHistory();
  await until(() => { const current = paneRecord(f.root); return Boolean(current) && current.lastPromptText === undefined; },
    "pane s0's record to lose the prompt text that clearing history removes");
  const cleared = paneRecord(f.root);
  assert.equal(cleared.lastPromptText, undefined);
  assert.equal(cleared.lastResultSummary, undefined);
  assert.equal(cleared.lastPromptAt, undefined);
  assert.equal(cleared.lastResultAt, undefined);
  assert.equal(cleared.title, 'Release checklist review', 'What a pane is stays; what was said about it goes.');
});
