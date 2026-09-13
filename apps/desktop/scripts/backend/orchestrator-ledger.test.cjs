'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLedger, planningLedger, deriveLedgerEntry, ledgerVerb, ledgerOutcome, LEDGER_LIMIT } = require('../../backend/orchestratorLedger.cjs');
const { createConversationStore } = require('../../backend/orchestratorConversationStore.cjs');
const { createPlanningInput } = require('../../backend/orchestratorInterpreter.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async (check, limit = 400) => { for (let i = 0; i < limit; i++) { if (check()) return true; await tick(); } return check(); };

// The verb comes from the compiled plan, never from model prose. Every row here
// is one real plan shape the interpreter can produce.
test('every plan shape derives its ledger verb from its own grants and response kind', () => {
  const rows = [
    ['start', { grants: [{ kind: 'delegate_task', args: { assignmentMode: 'auto' }, text: 'Review the patch.' }] }, {}],
    ['follow_up', { grants: [{ kind: 'delegate_task', args: { assignmentMode: 'existing' }, text: 'Also cover X.' }] }, {}],
    ['follow_up', { continuationOf: 'earlier', grants: [{ kind: 'send_prompt', args: {}, text: 'Keep going.' }] }, {}],
    ['start', { grants: [{ kind: 'operate_terminal', args: {}, text: 'Do the work.' }] }, {}],
    ['open', { grants: [{ kind: 'create_session', args: {} }] }, {}],
    ['close', { grants: [{ kind: 'close', args: {} }] }, {}],
    ['answer', { grants: [{ kind: 'answer_question', args: {} }] }, {}],
    ['answer', { grants: [{ kind: 'permission', args: {} }] }, {}],
    ['status', { responseKind: 'task-status', grants: [] }, {}],
    ['inspect', { responseKind: 'terminal-inspection', grants: [] }, {}],
    ['inspect', { grants: [{ kind: 'inspect_terminal', args: {} }] }, {}],
    ['ask', { grants: [] }, {}],
    ['cancel', { grants: [{ kind: 'delegate_task', args: {}, text: 'x' }] }, { status: 'cancelled' }],
    ['failed', null, {}],
  ];
  for (const [expected, plan, extra] of rows) {
    assert.equal(ledgerVerb({ plan, ...extra }), expected, `${expected}: ${JSON.stringify(plan)}`);
  }
  // A close grant outranks a work grant in the same plan, because closing a pane
  // is the effect the user will notice and ask about.
  assert.equal(ledgerVerb({ plan: { grants: [{ kind: 'delegate_task', args: {} }, { kind: 'close', args: {} }] } }), 'close');
});

// The outcome comes from the delivery substrate's own waits and this request's
// receipts. It is the single place the enum is decided.
test('every settled request shape derives its ledger outcome from waits and receipts', () => {
  const rows = [
    ['delivered-started', { waits: [{ delivered: true, observedState: 'running' }] }, null],
    ['delivered-started', { waits: [{ delivered: true, observedState: 'submitted-observed' }] }, null],
    // The turn the prompt started has since ended: finished work is not
    // "unconfirmed" merely because the pane is no longer mid-run.
    ['delivered-started', { waits: [{ delivered: true, observedState: 'completed', done: true, turnId: 'turn-1' }] }, null],
    ['delivered-unconfirmed', { waits: [{ delivered: true }] }, null],
    ['delivered-unconfirmed', { waits: [{ delivered: true, observedState: 'completed', done: true }] }, null],
    ['refused', { waits: [{ failed: true, error: 'The composer was not reachable.' }] }, 'The composer was not reachable.'],
    ['answered', { status: 'needs-answer' }, null],
    ['closed', { receipts: [{ kind: 'close', status: 'closed' }] }, null],
    ['created-only', { receipts: [{ kind: 'create_session', status: 'created' }] }, null],
    ['failed', { status: 'failed' }, null],
    ['failed', { failed: true }, null],
    ['cancelled', { status: 'cancelled', waits: [{ delivered: true, observedState: 'running' }] }, null],
    ['replied', {}, null],
  ];
  for (const [outcome, input, error] of rows) {
    assert.deepEqual(ledgerOutcome(input), { outcome, error }, outcome);
  }
  // A watch is observation, not submission: it never reports delivery.
  assert.equal(ledgerOutcome({ waits: [{ source: 'watch', delivered: true, observedState: 'running' }] }).outcome, 'replied');
  // A rejected close or creation receipt is a refusal, not an accomplished effect.
  assert.equal(ledgerOutcome({ receipts: [{ kind: 'close', status: 'rejected' }], status: 'failed' }).outcome, 'failed');
  assert.equal(ledgerOutcome({ receipts: [{ kind: 'create_session', status: 'rejected' }], status: 'failed' }).outcome, 'failed');
});

test('a created pane whose send was refused is one created-only line that still carries the typed prompt', () => {
  const entry = deriveLedgerEntry({ requestId: 'r1', at: 1757000000000,
    plan: { grants: [{ kind: 'delegate_task', args: { assignmentMode: 'new' }, text: 'Investigate the orchestrator performance.' }] },
    status: 'failed', waits: [], receipts: [{ kind: 'create_session', status: 'created', targetId: 'pane-new' }],
    sessions: [{ id: 'pane-new', name: 'Codex 2', conversationTitle: 'Orchestrator performance', kind: 'codex' }],
    project: 'vibeTerminal', cwd: 'C:/projects/vibeTerminal', failed: true, error: 'The pane was not ready in time.' });
  assert.deepEqual(entry, { requestId: 'r1', at: 1757000000000, verb: 'start', project: 'vibeTerminal',
    pane: { id: 'pane-new', name: 'Orchestrator performance', provider: 'codex' },
    typedText: 'Investigate the orchestrator performance.', outcome: 'created-only',
    error: 'The pane was not ready in time.', cwd: 'C:/projects/vibeTerminal' });
});

test('ledger rows are typed, capped, replaced by request and evicted oldest first', () => {
  const ledger = createLedger({ now: () => 1757000000000, limit: 4 });
  assert.equal(ledger.record({ requestId: 'r', verb: 'nonsense', outcome: 'replied' }), null, 'An unknown verb is not a ledger row.');
  assert.equal(ledger.record({ verb: 'ask', outcome: 'replied' }), null, 'A row needs its request identity.');
  const first = ledger.record({ requestId: 'r1', at: 10, verb: 'start', outcome: 'delivered-unconfirmed',
    project: 'p'.repeat(200), typedText: 't'.repeat(500), error: 'e'.repeat(500), pane: { id: 'a', name: 'n'.repeat(200), provider: 'codex' }, cwd: 'C:/p' });
  assert.equal(first.project.length, 120); assert.equal(first.typedText.length, 300); assert.equal(first.error.length, 200); assert.equal(first.pane.name.length, 120);
  // The same request is one line: a later resolved wait updates it in place and
  // keeps the time the action actually happened.
  ledger.record({ requestId: 'r1', at: 99, verb: 'start', outcome: 'delivered-started' });
  assert.equal(ledger.size, 1);
  assert.deepEqual(ledger.last(), { requestId: 'r1', at: 10, verb: 'start', project: null, pane: null, typedText: null, outcome: 'delivered-started', error: null });
  for (const id of ['r2', 'r3', 'r4', 'r5']) ledger.record({ requestId: id, at: 20, verb: 'ask', outcome: 'replied', cwd: 'C:/other' });
  assert.deepEqual(ledger.snapshot().map(entry => entry.requestId), ['r2', 'r3', 'r4', 'r5']);
  assert.deepEqual(ledger.list({ cwd: 'c:\\other\\' }).map(entry => entry.requestId), ['r2', 'r3', 'r4', 'r5'], 'Folder identity ignores case and trailing separators.');
  assert.deepEqual(ledger.list({ limit: 2 }).map(entry => entry.requestId), ['r4', 'r5']);
  ledger.clear();
  assert.equal(ledger.last(), null);
  assert.equal(ledger.restore([{ requestId: 'ok', at: 1, verb: 'ask', outcome: 'replied' }, { requestId: 'bad', at: 1, verb: 'ask', outcome: 'invented' }, null]), 1);
});

test('the planning projection keeps the newest actions inside a fixed byte budget and hides folder paths', () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({ requestId: `r${index}`, at: index, verb: 'start', project: 'vibeTerminal',
    pane: { id: `pane-${index}`, name: `Release checklist review ${index}`, provider: 'codex' },
    typedText: 'Review the release checklist and report what is still missing.'.repeat(2).slice(0, 300),
    outcome: 'delivered-started', error: null, cwd: 'C:/projects/vibeTerminal' }));
  const rows = planningLedger(entries, { limit: 8, maxBytes: 2048 });
  assert.ok(rows.length >= 1 && rows.length < 8, 'The budget, not the count, decides how many rows fit.');
  assert.ok(Buffer.byteLength(JSON.stringify(rows), 'utf8') <= 2048);
  assert.equal(rows.at(-1).requestId, 'r11', 'The most recent action always survives.');
  assert.ok(rows.every(row => row.cwd === undefined));
  // A single row larger than the whole budget is shortened rather than dropped:
  // the newest action is the one every "that one" reference means.
  const huge = planningLedger([{ ...entries[0], error: 'x'.repeat(200) }], { limit: 8, maxBytes: 120 });
  assert.equal(huge.length, 1);
  assert.equal(huge[0].typedText.length, 120);
});

test('under context pressure the memory tiers shrink newest-first, and only after everything else', () => {
  const { fitMessages, modelInputBudget } = require('../../backend/orchestratorBudget.cjs');
  const ledger = Array.from({ length: 8 }, (_, index) => ({ requestId: `r${index}`, at: index, verb: 'start', project: 'vibeTerminal',
    pane: { id: `pane-${index}`, name: `Release checklist review ${index}`, provider: 'codex' },
    typedText: 'Review the release checklist and report what is still missing.', outcome: 'delivered-started', error: null }));
  const roster = Array.from({ length: 24 }, (_, index) => ({ id: `pane-${index}`, name: `Codex ${index}`, cwd: 'D:/runner/' + 'long-path/'.repeat(20),
    status: 'idle', turnState: 'idle', objective: 'Investigate the orchestrator interpretation payload and report the measured size.' }));
  const messages = [{ role: 'system', content: 'POLICY' },
    { role: 'user', content: JSON.stringify({ instruction: 'Put in that prompt.', ledger, roster, replyContext: { requestId: 'r7', instruction: 'Put in that prompt.' }, lastFailure: { reason: 'Kept.' } }) }];
  const fitted = fitMessages({ messages, contextLength: 4096 });
  const payload = JSON.parse(fitted[1].content);
  assert.ok(Buffer.byteLength(JSON.stringify({ messages: fitted, tools: [] }), 'utf8') <= modelInputBudget(4096));
  assert.ok(payload.roster.length < roster.length);
  assert.deepEqual(payload.roster.map(row => row.id), roster.slice(0, payload.roster.length).map(row => row.id), 'The least recently touched panes go first.');
  assert.ok(payload.ledger.length >= 1);
  assert.equal(payload.ledger.at(-1).requestId, 'r7', 'The newest action is never the row that is dropped.');
  assert.equal(payload.instruction, 'Put in that prompt.');
  assert.deepEqual(payload.lastFailure, { reason: 'Kept.' });
  assert.deepEqual(payload.replyContext, { requestId: 'r7', instruction: 'Put in that prompt.' });
});

test('the conversation store persists ledger rows, drops malformed ones and keeps the newest two hundred', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-ledger-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const store = createConversationStore({ userDataPath: root, getSecrets: () => ['sk-secret-value-1234'], now: () => now });
  const rows = Array.from({ length: LEDGER_LIMIT + 50 }, (_, index) => ({ requestId: `r${index}`, at: now - 1000 + index, verb: 'start',
    project: 'vibeTerminal', cwd: 'C:/projects/vibeTerminal', pane: { id: `pane-${index}`, name: 'Codex 2', provider: 'codex' },
    typedText: `Task ${index}`, outcome: 'delivered-started', error: null }));
  await store.save({ messages: [], receipts: [], tasks: [], ledger: [
    ...rows,
    { requestId: 'bad-verb', at: now, verb: 'shout', outcome: 'replied' },
    { requestId: 'bad-outcome', at: now, verb: 'ask', outcome: 'invented' },
    { requestId: 'no-time', verb: 'ask', outcome: 'replied' },
    { requestId: 'ancient', at: now - 40 * 24 * 60 * 60 * 1000, verb: 'ask', outcome: 'replied' },
    { requestId: 'secret', at: now, verb: 'start', outcome: 'refused', error: 'Rejected sk-secret-value-1234 upstream.', pane: { id: 'p', name: 'n' } },
  ] });
  await store.flush();
  const loaded = store.load();
  assert.equal(loaded.ledger.length, LEDGER_LIMIT);
  assert.equal(loaded.ledger.at(-1).requestId, 'secret');
  assert.equal(loaded.ledger.at(-1).error, 'Rejected [redacted] upstream.');
  assert.deepEqual(loaded.ledger.at(-1).pane, { id: 'p', name: 'n', provider: null });
  assert.ok(!loaded.ledger.some(entry => ['bad-verb', 'bad-outcome', 'no-time', 'ancient'].includes(entry.requestId)));
  assert.ok(!loaded.ledger.some(entry => entry.requestId === 'r0'), 'The oldest rows retire first.');
  assert.deepEqual(Object.keys(loaded.ledger[0]).sort(), ['at', 'cwd', 'error', 'outcome', 'pane', 'project', 'requestId', 'typedText', 'verb']);
});

async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-ledger-'));
  const f = { root, contexts: [], effects: [], sessions: [{ id: 's0', generation: 'g0', name: 'Codex 1', conversationTitle: 'Release checklist review', kind: 'codex', provider: 'codex', cwd: root, turnState: 'idle', status: 'idle', observation: 'observed', processState: 'running' }] };
  f.plan = context => ({ goal: context.instruction, executionMode: 'direct', actions: [{ kind: 'send_prompt', targetIds: ['s0'], text: context.instruction }] });
  f.app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false }, getSessions: () => f.sessions,
    getRoots: () => ({ documents: root, projects: [{ id: 'project', name: path.basename(root), path: root }] }),
    interpretIntent: async context => { f.contexts.push(context); return f.plan(context); },
    dispatchAction: async action => { f.effects.push(action); if (f.dispatch) return f.dispatch(action); const session = f.sessions.find(item => item.id === action.targetId); if (session && action.kind === 'send_prompt') Object.assign(session, { turnId: `turn-${f.effects.length}`, turnState: 'running', turnStartedAt: Date.now(), actionId: action.actionId }); return { ok: true, status: 'written', turnId: session?.turnId }; },
    fetch: async url => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'model', context_length: 128000, supported_parameters: ['tools'] }] }));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', type: 'function', function: { name: 'workspace', arguments: JSON.stringify({ kind: 'respond', text: 'Done.', responseTurn: 'complete' }) } }] } }] }));
    }, ...overrides });
  await f.app.configure({ apiKey: 'fixture', sessionOnly: true, model: 'model' }); await f.app.setEnabled(true);
  t.after(async () => { await f.app.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('"put in that prompt" resolves from the ledger line the refused send left behind', async t => {
  const f = await fixture(t);
  f.dispatch = () => ({ ok: false, status: 'rejected', error: 'Adapter refused input: the composer is not reachable.' });
  const typed = 'Investigate the orchestrator performance and report what you find.';
  const first = await f.app.send({ text: typed, origin: 'text' });
  assert.equal(first.ok, false);
  await until(() => f.app.getState().tasks.some(task => task.requestId === first.requestId && ['failed', 'finished'].includes(task.status)));

  f.plan = () => ({ goal: 'Answer from the recorded actions.', actions: [] });
  await f.app.send({ text: 'put in that prompt', origin: 'text' });
  const context = f.contexts.at(-1);
  const entry = context.ledger.at(-1);
  assert.equal(entry.requestId, first.requestId);
  assert.equal(entry.verb, 'start');
  assert.equal(entry.typedText, typed, 'The prompt Lina tried to type is recorded, not the reply about it.');
  assert.equal(entry.pane.id, 's0');
  assert.equal(entry.pane.name, 'Release checklist review');
  assert.match(entry.error, /composer is not reachable/);
  // The same facts reach the brain: the planning payload carries this episode
  // and no prose from the request that failed. Migrated from the retired ledger
  // key, which the memory block replaced.
  const payload = JSON.parse(createPlanningInput(context).messages[1].content);
  assert.equal(payload.ledger, undefined);
  assert.equal(payload.memory.episodes.at(-1).typedText, typed);
  assert.equal(payload.memory.episodes.at(-1).pane.id, 's0');
  assert.equal(payload.memory.episodes.at(-1).outcome, 'refused');
  assert.equal(payload.recentConversation, undefined);
  assert.equal(payload.tasks, undefined);
  assert.ok(!JSON.stringify(payload).includes('Adapter refused input: the composer is not reachable. '), 'The failed request contributes one typed line, not its reply text.');
});

test('a delivered request records the pane it started, and a later observation updates the same line', async t => {
  const f = await fixture(t);
  const first = await f.app.send({ text: 'Review the release checklist.', origin: 'text' });
  assert.equal(first.ok, true);
  await until(() => f.app.getState().tasks.some(task => task.requestId === first.requestId && task.status === 'waiting-results'));
  f.plan = () => ({ goal: 'Answer from the recorded actions.', actions: [] });
  // Not a memory-template question: this asserts what the brain is handed, and
  // the templated phrasings are covered by the fast-path tests instead.
  await f.app.send({ text: 'how are things looking?', origin: 'text' });
  const started = f.contexts.at(-1).ledger.at(-1);
  assert.equal(started.outcome, 'delivered-started');
  assert.equal(started.typedText, 'Review the release checklist.');
  assert.equal(started.pane.provider, 'codex');
  assert.equal(started.project, path.basename(f.root), 'The registered project name is how the user refers to it.');
  const at = started.at;
  // The pane finishes its turn: the same request keeps one line, with its
  // original time, rather than gaining a second one.
  const session = f.sessions[0];
  Object.assign(session, { turnState: 'completed', completedTurnId: session.turnId, completedActionId: session.actionId, turnEndedAt: Date.now() });
  await f.app.refresh(); await tick(); await tick();
  await f.app.send({ text: 'and now?', origin: 'text' });
  const rows = f.contexts.at(-1).ledger.filter(entry => entry.requestId === first.requestId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].at, at);
});

// The ledger is only memory if it survives the process. The last write of a
// session is the one dispose makes, and it rebuilds the whole file from the view
// it is handed: a tier missing from that view is erased on shutdown.
test('two settled delegations keep their ledger lines in the saved store, through the final write of the session', async t => {
  const f = await fixture(t);
  f.sessions.push({ id: 's1', generation: 'g1', name: 'Codex 2', conversationTitle: 'Checkout validation', kind: 'codex',
    provider: 'codex', cwd: f.root, turnState: 'idle', status: 'idle', observation: 'observed', processState: 'running' });
  f.plan = context => ({ goal: context.instruction, executionMode: 'direct',
    actions: [{ kind: 'send_prompt', targetIds: [/checkout/i.test(context.instruction) ? 's1' : 's0'], text: context.instruction }] });
  const requests = [];
  for (const [text, id] of [['Review the release checklist.', 's0'], ['Fix the checkout validation.', 's1']]) {
    const result = await f.app.send({ text, origin: 'text' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(await until(() => f.app.getState().tasks.some(task => task.requestId === result.requestId && task.status === 'waiting-results')));
    const session = f.sessions.find(item => item.id === id);
    Object.assign(session, { turnState: 'completed', completedTurnId: session.turnId, completedActionId: session.actionId, turnEndedAt: Date.now() });
    await f.app.refresh(); await tick(); await tick();
    assert.equal(f.app.getState().tasks.find(task => task.requestId === result.requestId).status, 'finished');
    requests.push(result.requestId);
  }
  await f.app.dispose();
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'orchestrator-conversation.json'), 'utf8'));
  assert.equal(saved.ledger.length, 2);
  assert.deepEqual(saved.ledger.map(entry => entry.requestId), requests);
  assert.deepEqual(saved.ledger.map(entry => [entry.verb, entry.outcome, entry.pane.name, entry.pane.provider, entry.typedText]), [
    ['start', 'delivered-started', 'Release checklist review', 'codex', 'Review the release checklist.'],
    ['start', 'delivered-started', 'Checkout validation', 'codex', 'Fix the checkout validation.']]);
});

test('clearing history removes the ledger', async t => {
  const f = await fixture(t);
  await f.app.send({ text: 'Review the release checklist.', origin: 'text' });
  f.plan = () => ({ goal: 'Answer.', actions: [] });
  // "what did you do?" is now answered by the memory fast path with no model
  // call, so the brain-facing assertion uses a sentence that still reaches it.
  await f.app.send({ text: 'anything else worth knowing?', origin: 'text' });
  assert.ok(f.contexts.at(-1).ledger.length >= 1);
  await f.app.clearHistory();
  await f.app.send({ text: 'anything else worth knowing?', origin: 'text' });
  assert.deepEqual(f.contexts.at(-1).ledger, []);
  assert.equal(f.contexts.at(-1).memory, undefined, 'Clearing history empties the memory block too.');
});

test('a cancelled question leaves no pending answer and no implicit reply target', async t => {
  const f = await fixture(t);
  f.plan = context => ({ goal: context.instruction, clarification: 'Which terminal?', actions: [] });
  const asked = await f.app.send({ text: 'Review one', origin: 'text' });
  const pending = f.app.getState().tasks.find(task => task.requestId === asked.requestId);
  assert.equal(pending.status, 'needs-answer');
  await f.app.cancel();
  assert.equal(f.app.getState().tasks.find(task => task.requestId === asked.requestId).status, 'cancelled');
  f.plan = () => ({ goal: 'Never mind.', actions: [] });
  await f.app.send({ text: 'never mind', origin: 'text' });
  assert.equal(f.contexts.at(-1).replyContext, undefined, 'A cancelled exchange is not an implicit reply target.');
  // The consumed question can no longer be answered either.
  assert.equal(f.app.enqueue({ text: 'the first one', origin: 'text', replyToRequestId: asked.requestId, questionId: pending.question.id }).ok, false);
});

test('a spoken project variant that resolved to its project is learned once as a preference alias', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-ledger-alias-'));
  const project = path.join(root, 'vibeTerminal');
  fs.mkdirSync(project, { recursive: true });
  const contexts = [];
  const app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => [], getRoots: () => ({ documents: root, projects: [{ id: 'p', name: 'vibeTerminal', path: project }] }),
    interpretIntent: async context => { contexts.push(context); return { goal: context.instruction, actions: [] }; },
    dispatchAction: async () => ({ ok: true }),
    fetch: async url => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'model', context_length: 128000, supported_parameters: ['tools'] }] }));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Done.' } }] }));
    } });
  t.after(async () => { await app.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  await app.configure({ apiKey: 'fixture', sessionOnly: true, model: 'model' }); await app.setEnabled(true);
  for (let index = 0; index < 2; index++) await app.send({ text: 'what is happening in vibe terminal?', origin: 'voice' });
  const aliases = app.getState().preferences.filter(preference => preference.text.startsWith('alias: '));
  assert.deepEqual(aliases.map(preference => preference.text), ['alias: vibe terminal → vibeTerminal'],
    'The learned alias is stored once, not on every repetition.');
});
