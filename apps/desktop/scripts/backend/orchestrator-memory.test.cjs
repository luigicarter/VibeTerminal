'use strict';
// Memory is a store with deterministic retrieval, not a window. These tests hold
// the three properties that makes it: what is written is typed and bounded, what
// is retrieved is ranked by topic overlap and recency, and the questions the user
// asks most about Lina's own actions are answered without a model call.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createMemoryStore, boundedMemory, memoryQuestion, answerMemoryQuestion, topicsFrom, dayKey,
  FILE, LIMITS } = require('../../backend/orchestratorMemory.cjs');
const { RESOLVER_STOPWORDS } = require('../../backend/orchestratorReference.cjs');
const { createPlanningInput } = require('../../backend/orchestratorInterpreter.cjs');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const utterances = require('./fixtures/orchestrator-utterances.json');

const DAY = 86400000;
const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async (check, limit = 600) => { for (let i = 0; i < limit; i++) { if (check()) return true; await new Promise(resolve => setTimeout(resolve, 5)); } return check(); };

function storeIn(t, { now, prefix = 'vibe-memory-' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  return { root, store: createMemoryStore({ userDataPath: root, now, getSecrets: () => ['sk-fixture-secret-value'] }) };
}

test('episodes are indexed by pane, project, day and topic, and recall ranks overlap against recency', async t => {
  let clock = Date.parse('2026-09-12T12:00:00Z');
  const { root, store } = storeIn(t, { now: () => clock });
  const episode = (requestId, at, project, pane, typedText, instruction) =>
    store.recordEpisode({ requestId, at, verb: 'start', outcome: 'delivered-started', project,
      cwd: `C:/projects/${project}`, pane, typedText, instruction });
  episode('old-match', clock - 3 * DAY, 'vibeTerminal', { id: 'p1', name: 'review recent orchestrator messages', provider: 'codex' },
    'Review the recent orchestrator messages.', 'review the recent orchestrator messages');
  episode('recent-other', clock - 60000, 'vibeTerminal', { id: 'p2', name: 'full screen issue', provider: 'codex' },
    'Fix the full screen terminal issue.', 'fix the full screen terminal issue');
  episode('elsewhere', clock - 120000, 'lina-web-app', { id: 'p3', name: 'documentation page', provider: 'claude' },
    'Review the documentation page.', 'review the documentation page');

  // Score is token overlap times a seven-day-half-life decay. Four tokens three
  // days old (4 x 0.74) outrank one token two minutes old (1 x 1.0)...
  assert.deepEqual(store.recall({ query: 'review recent orchestrator messages' }).map(row => row.requestId), ['old-match', 'elsewhere']);
  assert.deepEqual(store.recall({ query: 'review the documentation page' }).map(row => row.requestId), ['elsewhere', 'old-match']);
  // ...and at three weeks the same four tokens (4 x 0.125) no longer do.
  const stale = storeIn(t, { now: () => clock, prefix: 'vibe-memory-decay-' }).store;
  stale.recordEpisode({ requestId: 'stale-match', at: clock - 21 * DAY, verb: 'start', outcome: 'delivered-started',
    pane: { id: 'p1', name: 'review recent orchestrator messages', provider: 'codex' }, instruction: 'review the recent orchestrator messages' });
  stale.recordEpisode({ requestId: 'fresh-token', at: clock - 60000, verb: 'start', outcome: 'delivered-started',
    pane: { id: 'p2', name: 'documentation review', provider: 'codex' }, instruction: 'review the documentation page' });
  assert.deepEqual(stale.recall({ query: 'review recent orchestrator messages' }).map(row => row.requestId), ['fresh-token', 'stale-match']);
  // A query no episode shares a topic with retrieves nothing rather than guessing.
  assert.deepEqual(store.recall({ query: 'kubernetes helm chart' }), []);
  // No query at all is pure recency.
  assert.deepEqual(store.recall({ limit: 3 }).map(row => row.requestId), ['recent-other', 'elsewhere', 'old-match']);
  // Each index narrows the same ranked set.
  assert.deepEqual(store.recall({ pane: 'p3' }).map(row => row.requestId), ['elsewhere']);
  assert.deepEqual(store.recall({ project: 'VIBETERMINAL' }).map(row => row.requestId), ['recent-other', 'old-match']);
  assert.deepEqual(store.recall({ since: clock - 90000 }).map(row => row.requestId), ['recent-other']);

  // A result summary joins the episode it belongs to, extends its topics, and is
  // what the citation carries back.
  assert.equal(store.appendResult('old-match', 'Found two stale handlers in the message pipeline.'), true);
  assert.equal(store.appendResult('old-match', 'Found two stale handlers in the message pipeline.'), false, 'The same summary is filed once.');
  assert.deepEqual(store.recall({ query: 'stale handlers pipeline' }).map(row => row.requestId), ['old-match']);
  assert.equal(store.recall({ pane: 'p1' })[0].resultExcerpt, 'Found two stale handlers in the message pipeline.');

  // Project facts are recomputed from the project's own episodes.
  const project = store.recallProject('vibeTerminal');
  assert.equal(project.project.defaultProvider, 'codex');
  assert.deepEqual(project.project.lastActivePane, { id: 'p2', name: 'full screen issue' });
  assert.deepEqual(project.episodes.map(row => row.requestId), ['recent-other', 'old-match']);
  assert.equal(store.recallPane('p1').pane, null, 'A pane with no recorded fact still has its episodes.');
  assert.deepEqual(store.recallPane('p1').episodes.map(row => row.requestId), ['old-match']);

  // One row per request: a later settle refreshes it and keeps the original time.
  clock += 1000;
  const refreshed = store.recordEpisode({ requestId: 'recent-other', at: clock, verb: 'start', outcome: 'delivered-started',
    project: 'vibeTerminal', pane: { id: 'p2', name: 'full screen issue', provider: 'codex' }, typedText: 'Fix the full screen terminal issue.' });
  assert.equal(refreshed.at, Date.parse('2026-09-12T12:00:00Z') - 60000, 'The time the action happened survives its own update.');
  assert.equal(store.snapshot().episodes.length, 3);

  // Secrets are redacted at write, and the file survives a reopen.
  store.recordEpisode({ requestId: 'secret', at: clock, verb: 'ask', outcome: 'replied',
    project: 'vibeTerminal', typedText: 'The key is sk-fixture-secret-value, use it.' });
  await store.flush();
  const reopened = createMemoryStore({ userDataPath: root, now: () => clock, getSecrets: () => [] });
  assert.equal(reopened.wasEmpty(), false);
  assert.equal(reopened.recall({ pane: null, limit: 10 }).find(row => row.requestId === 'secret').typedText,
    'The key is [redacted], use it.');
  assert.equal(reopened.snapshot().version, 1);
});

test('episodes retire by age and count, and only after their day has a summary line', async t => {
  let clock = Date.parse('2026-09-12T12:00:00Z');
  const { store } = storeIn(t, { now: () => clock });
  const ancient = clock - 120 * DAY;
  store.recordEpisode({ requestId: 'ancient', at: ancient, verb: 'start', outcome: 'delivered-started',
    project: 'vibeTerminal', pane: { id: 'p1', name: 'old work', provider: 'codex' }, typedText: 'Old work.' });
  // The write itself retires the ninety-day-old row, after writing its day line.
  assert.equal(store.snapshot().episodes.length, 0);
  const summaries = store.recallProject('vibeTerminal').summaries;
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].day, dayKey(ancient));
  assert.deepEqual(summaries[0].counts, { start: 1 });
  assert.match(summaries[0].text, /vibeTerminal: 1 request \(start 1\); panes: old work/);

  // An explicit rollover writes one line per project per day from that day's rows.
  for (const [index, project] of ['vibeTerminal', 'vibeTerminal', 'lina-web-app'].entries()) {
    store.recordEpisode({ requestId: `today-${index}`, at: clock - index * 1000, verb: index === 2 ? 'open' : 'start',
      outcome: 'delivered-started', project, pane: { id: `p${index}`, name: `pane ${index}`, provider: 'codex' }, typedText: `Task ${index}.` });
  }
  const written = store.rollover(dayKey(clock));
  assert.deepEqual(written.map(item => [item.project, item.counts]).sort(), [['lina-web-app', { open: 1 }], ['vibeTerminal', { start: 2 }]]);
  assert.equal(store.rollover('not-a-day').length, 0);
  assert.equal(store.snapshot().episodes.length, 3, 'A rollover summarizes; it does not evict.');
  assert.equal(store.latestDay(), dayKey(clock));
  await store.flush();
});

test('clearing episodes keeps pane and project facts, and forgetting a project removes only its own', async t => {
  let clock = Date.parse('2026-09-12T12:00:00Z');
  const { store } = storeIn(t, { now: () => clock });
  for (const [index, project] of ['vibeTerminal', 'lina-web-app'].entries()) {
    store.recordEpisode({ requestId: `r${index}`, at: clock - index * 1000, verb: 'start', outcome: 'delivered-started',
      project, cwd: `C:/projects/${project}`, pane: { id: `p${index}`, name: `pane ${index}`, provider: 'codex' }, typedText: `Task ${index}.` });
    store.upsertPaneFact({ paneId: `p${index}`, project, provider: 'codex', title: `pane ${index}`,
      objective: `Objective ${index}`, createdBy: 'lina' });
  }
  store.rollover(dayKey(clock));
  assert.equal(store.clearEpisodes(), true);
  assert.deepEqual(store.snapshot().episodes, []);
  assert.deepEqual(store.snapshot().summaries, []);
  assert.equal(store.snapshot().paneFacts.length, 2, 'What a pane is for is ownership, not history.');
  assert.equal(store.snapshot().projectFacts.length, 2);
  assert.equal(store.recallPane('p0').pane.objective, 'Objective 0');
  assert.equal(store.clearEpisodes(), false, 'Clearing twice changes nothing.');

  store.recordEpisode({ requestId: 'again', at: clock, verb: 'start', outcome: 'delivered-started', project: 'lina-web-app',
    pane: { id: 'p1', name: 'pane 1', provider: 'codex' }, typedText: 'More work.' });
  assert.equal(store.forgetProject('LINA-WEB-APP'), true, 'Forgetting is case-insensitive about the project name.');
  assert.deepEqual(store.snapshot().episodes, []);
  assert.deepEqual(store.snapshot().paneFacts.map(fact => fact.paneId), ['p0']);
  assert.deepEqual(store.snapshot().projectFacts.map(fact => fact.project), ['vibeTerminal']);
  assert.equal(store.forgetProject(''), false);
  await store.flush();
});

test('a saved conversation store seeds memory once, and a malformed row is dropped on its own', async t => {
  const saved = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'orchestrator-measure', 'orchestrator-conversation.json'), 'utf8'));
  const latest = Math.max(...saved.tasks.map(task => task.updatedAt));
  const clock = latest + 1000;
  const { root, store } = storeIn(t, { now: () => clock });
  assert.equal(store.wasEmpty(), true, 'Seeding runs on the first load with no memory file.');
  const added = store.seedFromConversationStore(saved);
  assert.equal(added, saved.tasks.length);
  assert.equal(store.seedFromConversationStore(saved), 0, 'Seeding is idempotent by request id.');
  const seeded = store.snapshot().episodes;
  assert.deepEqual(seeded.find(row => row.requestId === 'r1').verb, 'start', 'A send_prompt receipt makes the request a start.');
  assert.equal(seeded.find(row => row.requestId === 'r1').outcome, 'refused', 'A rejected send is a refusal, not a reply.');
  assert.equal(seeded.find(row => row.requestId === 'r4').outcome, 'failed');
  assert.equal(seeded.find(row => row.requestId === 'r9').outcome, 'cancelled');
  assert.ok(store.recall({ query: 'codex terminal project' }).length, 'Seeded episodes are retrievable by topic.');
  await store.flush();

  // One malformed record costs that record and nothing else: the file stays
  // readable and every valid row around it survives.
  const file = path.join(root, FILE);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.episodes.splice(1, 0, { requestId: 'broken', at: clock, verb: 'shout', outcome: 'replied' },
    { requestId: 'no-time', verb: 'ask', outcome: 'replied' }, null, 'not an object');
  raw.paneFacts.push({ objective: 'no pane id' });
  raw.projectFacts.push({ defaultProvider: 'codex' });
  raw.summaries.push({ day: 'whenever', text: 'nonsense' });
  fs.writeFileSync(file, JSON.stringify(raw));
  const reopened = createMemoryStore({ userDataPath: root, now: () => clock, getSecrets: () => [] });
  assert.equal(reopened.snapshot().episodes.length, saved.tasks.length);
  assert.ok(!reopened.snapshot().episodes.some(row => ['broken', 'no-time'].includes(row.requestId)));
  assert.deepEqual(reopened.snapshot().summaries, []);
  assert.equal(fs.existsSync(file), true);

  // A file this build cannot read is not memory it may half-interpret.
  fs.writeFileSync(file, JSON.stringify({ version: 99, episodes: raw.episodes }));
  assert.equal(createMemoryStore({ userDataPath: root, now: () => clock, getSecrets: () => [] }).snapshot().episodes.length, 0);
});

// The retrieval evaluation. Episodes are the corpus's own action requests, with
// the title a pane doing that work would carry. Each results/verify question is
// then asked of the store exactly as the application asks it: the pane words a
// template captured, else the sentence's subject words with the resolver's own
// selection vocabulary removed, else recency.
const CORPUS_EPISODES = [
  ['row-1', 'review the last commit', 'Do a deep dive and review what the last commit changed.'],
  ['row-12', 'is the application still paused', 'Ask whether the application is still paused.', 'The application is paused; the supervisor has to restart it.'],
  ['row-22', 'investigate the terminal statuses', 'Investigate the terminal statuses.'],
  ['row-52', 'review recent orchestrator messages', 'Look at the conversation I had with the orchestrator and review its recent messages.',
    'Two orchestrator messages were duplicated by a stale handler.'],
  ['row-59', 'orchestrator reads errors out loud', 'Investigate why the orchestrator reads errors out loud.'],
  ['row-86', 'queued prompts keep piling up', 'Report the issue where prompts keep being queued.'],
  ['row-109', 'change the application name to Lina Terminal', 'Change the application name to Lina Terminal and the wake phrase to Hey Lina.',
    'Renamed the application to Lina Terminal; the wake phrase is untouched.'],
  ['row-112', 'fix the full screen issue', 'Fix the full screen terminal issue.'],
  ['row-114', 'performance and escalating RAM usage', 'Investigate the performance issues and the escalating RAM usage.'],
  ['row-122', 'adding a chat section', 'Continue adding the chat section and do a deep dive on it.'],
  ['row-127', 'review the documentation page', 'Review the documentation page on the website.'],
  ['row-128', 'wake word detection quality', 'Investigate how the wake word detection can be better detected.',
    'The wake word model needs more training data.'],
];
// What each recorded question is about, by corpus row number. "recent" means the
// sentence names nothing: the newest episode is the only correct answer.
const EXPECTED = {
  2: 'recent', 3: 'recent', 4: 'row-1', 16: 'row-12', 23: 'recent', 27: 'recent', 30: 'recent', 31: 'recent',
  43: 'recent', 46: 'row-86', 50: 'recent', 51: 'recent', 64: 'recent', 66: 'row-52', 71: 'recent', 75: 'recent',
  80: 'recent', 81: 'recent', 89: 'recent', 95: 'row-109', 108: 'recent', 110: 'recent',
};
// A question's subject words are its topics minus the vocabulary that describes
// how a pane is chosen rather than what it is working on - the same set the
// assignment resolver scores titles with.
const subjectWords = text => topicsFrom([text]).filter(word => !RESOLVER_STOPWORDS.has(word)).join(' ');

test('retrieval over the corpus finds the episode each recorded question is about', async t => {
  const clock = Date.parse('2026-09-12T12:00:00Z');
  const { store } = storeIn(t, { now: () => clock, prefix: 'vibe-memory-corpus-' });
  CORPUS_EPISODES.forEach(([requestId, title, typedText, result], index) => {
    store.recordEpisode({ requestId, at: clock - (CORPUS_EPISODES.length - index) * 3600000, verb: 'start',
      outcome: 'delivered-started', project: 'vibeTerminal', cwd: 'C:/projects/vibeTerminal',
      pane: { id: `pane-${index}`, name: title, provider: 'codex' }, typedText, instruction: typedText });
    if (result) store.appendResult(requestId, result);
  });
  const newest = CORPUS_EPISODES.at(-1)[0];
  const rows = utterances.filter(row => ['results', 'verify'].includes(row.verb));
  assert.equal(rows.length, Object.keys(EXPECTED).length, 'Every recorded results/verify question is evaluated.');
  const misses = [];
  for (const row of rows) {
    const match = memoryQuestion(row.text);
    const answered = match && answerMemoryQuestion(store, match, { project: 'vibeTerminal', at: clock });
    const query = match?.paneWords ?? subjectWords(row.text);
    // recall never guesses: a query whose words no episode shares retrieves
    // nothing, and a sentence that names nothing the store knows is about the
    // most recent action - which is what the fast path already does.
    const top = answered?.episode ?? store.recall({ query, limit: 5 })[0] ?? store.recall({ limit: 1 })[0];
    const expected = EXPECTED[row.n] === 'recent' ? newest : EXPECTED[row.n];
    if (top?.requestId !== expected) misses.push(`${row.n} ${row.verb}: expected ${expected}, got ${top?.requestId ?? 'nothing'} — ${row.text.slice(0, 70)}`);
  }
  const precision = (rows.length - misses.length) / rows.length;
  console.log(`retrieval precision ${rows.length - misses.length}/${rows.length} = ${precision.toFixed(3)}${misses.length ? `\n  ${misses.join('\n  ')}` : ''}`);
  // Row 66 is the worked example: the pane the sentence names must rank first.
  assert.equal(store.recall({ query: memoryQuestion(utterances.find(row => row.n === 66).text).paneWords })[0].requestId, 'row-52');
  assert.ok(precision >= 0.9, `retrieval precision is ${precision.toFixed(3)}; the floor is 0.9`);
  await store.flush();
});

test('the injected memory block stays inside three kilobytes and carries no raw prior prose', async t => {
  const clock = Date.parse('2026-09-12T12:00:00Z');
  const { store } = storeIn(t, { now: () => clock, prefix: 'vibe-memory-block-' });
  for (let index = 0; index < 40; index++) {
    const project = index % 3 === 0 ? 'lina-web-app' : 'vibeTerminal';
    store.recordEpisode({ requestId: `r${index}`, at: clock - (40 - index) * 60000, verb: 'start',
      outcome: 'delivered-started', project, cwd: `C:/projects/${project}`,
      pane: { id: `pane-${index}`, name: `Release checklist review ${index}`, provider: 'codex' },
      typedText: `Review the release checklist and report what is still missing before publishing, pass ${index}.`,
      instruction: 'review the release checklist' });
    store.appendResult(`r${index}`, `Reported two findings and left the pane idle at the composer, pass ${index}.`);
  }
  const block = store.planningMemory({ project: 'vibeTerminal', at: clock });
  assert.equal(block.episodes.length, 5);
  assert.ok(block.episodes.every(row => /vibeTerminal/.test(JSON.stringify(row)) === false), 'Episodes carry no folder path.');
  assert.match(block.elsewhere, /^1 other project active today: lina-web-app$/);
  assert.equal(block.project.defaultProvider, 'codex');
  const bounded = boundedMemory(block);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= 3072, `memory block is ${Buffer.byteLength(JSON.stringify(bounded), 'utf8')} bytes`);
  // With no project addressed the block is the last five overall.
  assert.deepEqual(store.planningMemory({ at: clock }).episodes.map(row => row.requestId), ['r35', 'r36', 'r37', 'r38', 'r39']);
  // A block larger than the budget loses its oldest episodes first, then its
  // surrounding context, never the newest action a follow-up refers to.
  const squeezed = boundedMemory(block, { maxBytes: 420 });
  assert.equal(squeezed.episodes.at(-1).requestId, block.episodes.at(-1).requestId);
  assert.ok(Buffer.byteLength(JSON.stringify(squeezed), 'utf8') <= 420 || squeezed.episodes.length === 1);
  assert.equal(boundedMemory(undefined), undefined);
  assert.equal(boundedMemory({}), undefined);

  // The planning payload carries the block and nothing raw beside it.
  const payload = JSON.parse(createPlanningInput({ instruction: 'Put in that prompt.', requestId: 'current',
    sessions: [], requests: [], memory: block, roster: [] }).messages[1].content);
  assert.equal(payload.ledger, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(payload.memory), 'utf8') <= 3072);
  assert.equal(payload.recentConversation, undefined);
  assert.equal(payload.tasks, undefined);
  await store.flush();
});

// The relay fixture: an injected interpreter stands in for the brain, so every
// interpretation is observable and a fast-path answer is provably free of one.
async function relay(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-memory-relay-'));
  const f = { root, contexts: [], completions: [], effects: [], sessions: [{ id: 's0', generation: 'g0', launchToken: 1,
    name: 'Codex 1', conversationTitle: 'Release checklist review', kind: 'codex', provider: 'codex', cwd: root,
    turnState: 'idle', status: 'idle', observation: 'observed', processState: 'running', agentProcessState: 'running',
    agentPid: 7, started: true, conversation: { provider: 'codex', id: 'conv-s0' }, home: 'C:/home', children: [], activeTools: [] }] };
  f.plan = context => ({ goal: context.instruction, executionMode: 'direct', actions: [{ kind: 'send_prompt', targetIds: ['s0'], text: context.instruction }] });
  f.app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false }, getSessions: () => f.sessions,
    getRoots: () => ({ documents: root, projects: [{ id: 'project', name: path.basename(root), path: root }] }),
    readSession: async ({ id, completedTurnId }) => { const session = f.sessions.find(item => item.id === id);
      return { ok: true, completedResult: { turnId: completedTurnId || session.turnId, targetId: session.id, generation: session.generation,
        status: session.turnState, at: session.turnEndedAt, source: 'chat-events', text: 'Reported two findings.' } }; },
    interpretIntent: async context => { f.contexts.push(context); return f.plan(context); },
    dispatchAction: async action => { f.effects.push(action); if (f.dispatch) return f.dispatch(action);
      const session = f.sessions.find(item => item.id === action.targetId);
      if (session && action.kind === 'send_prompt') Object.assign(session, { turnId: `turn-${f.effects.length}`, turnState: 'running', turnStartedAt: Date.now(), actionId: action.actionId });
      return { ok: true, status: 'written', turnId: session?.turnId }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'model', context_length: 128000, supported_parameters: ['tools'] }] }));
      f.completions.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Two findings; the pane is idle again.' } }] }));
    }, ...overrides });
  await f.app.configure({ apiKey: 'fixture', sessionOnly: true, model: 'model' }); await f.app.setEnabled(true);
  t.after(async () => { await f.app.dispose(); try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  f.calls = () => f.contexts.length + f.completions.length;
  return f;
}

test('"what was the last prompt I asked you to put in?" is answered from memory with no model call', async t => {
  const f = await relay(t);
  const typed = 'Review the release checklist and report what is missing.';
  assert.equal((await f.app.send({ text: typed, origin: 'text' })).ok, true);
  const before = f.calls();
  const answered = await f.app.send({ text: 'what was the last prompt I asked you to put in?', origin: 'text' });
  assert.equal(answered.ok, true, JSON.stringify(answered));
  assert.equal(f.calls(), before, 'A memory answer costs no interpretation and no completion.');
  assert.match(answered.text, /The last prompt I put in was “Review the release checklist and report what is missing\.”, in Release checklist review\./);
  const view = f.app.getState();
  assert.equal(view.messages.at(-1).text, answered.text);
  assert.equal(view.tasks.find(task => task.requestId === answered.requestId).status, 'finished');
});

test('"what was that error?" answers from the refusal memory recorded for that request', async t => {
  const f = await relay(t);
  f.dispatch = () => ({ ok: false, status: 'rejected', error: 'Adapter refused input: the composer is not reachable.' });
  const failed = await f.app.send({ text: 'Investigate the orchestrator performance.', origin: 'text' });
  assert.equal(failed.ok, false);
  assert.ok(await until(() => f.app.getState().tasks.some(task => task.requestId === failed.requestId && ['failed', 'finished'].includes(task.status))));
  const before = f.calls();
  const answered = await f.app.send({ text: 'what was that error?', origin: 'text' });
  assert.equal(answered.ok, true, JSON.stringify(answered));
  assert.equal(f.calls(), before);
  assert.match(answered.text, /The last thing that went wrong was in Release checklist review: .*composer is not reachable\./);
});

test('"what did <pane> come back with?" answers from the stored result summary', async t => {
  const f = await relay(t);
  assert.equal((await f.app.send({ text: 'Review the release checklist.', origin: 'text' })).ok, true);
  const session = f.sessions[0];
  Object.assign(session, { turnState: 'completed', completedTurnId: session.turnId, completedActionId: session.actionId, turnEndedAt: Date.now() });
  await f.app.refresh();
  assert.ok(await until(() => f.app.getState().messages.some(message => message.reportKind === 'result')));
  const before = f.calls();
  const answered = await f.app.send({ text: 'what did the release checklist review terminal come back with?', origin: 'text' });
  assert.equal(answered.ok, true, JSON.stringify(answered));
  assert.equal(f.calls(), before);
  assert.match(answered.text, /Release checklist review came back with: .*findings/);
});

test('a question the templates do not cover, or the store cannot answer, still reaches the brain', async t => {
  const f = await relay(t);
  // No episode yet: the template matches, the store has no answer, the brain runs.
  f.plan = () => ({ goal: 'Answer from what is known.', actions: [] });
  const before = f.calls();
  assert.equal((await f.app.send({ text: 'what was the last prompt you did?', origin: 'text' })).ok, true);
  assert.ok(f.calls() > before, 'An unanswerable memory question falls through to the brain.');
  // And a sentence no template covers always does.
  const next = f.calls();
  assert.equal((await f.app.send({ text: 'which project am I in right now?', origin: 'text' })).ok, true);
  assert.ok(f.calls() > next);
});

test('the brain can retrieve older memory through recall, recall_pane and recall_project', async t => {
  const f = await relay(t);
  assert.equal((await f.app.send({ text: 'Investigate the orchestrator performance.', origin: 'text' })).ok, true);
  const recalled = await f.app.dispatch({ kind: 'recall', query: 'orchestrator performance' });
  assert.equal(recalled.ok, true, JSON.stringify(recalled));
  assert.equal(recalled.episodes.length, 1);
  assert.equal(recalled.episodes[0].pane.id, 's0');
  assert.equal(recalled.episodes[0].typedText, 'Investigate the orchestrator performance.');
  assert.ok(Buffer.byteLength(JSON.stringify(recalled), 'utf8') <= 4096);

  const pane = await f.app.dispatch({ kind: 'recall_pane', targetId: 's0' });
  assert.equal(pane.ok, true);
  assert.equal(pane.pane.title, 'Release checklist review');
  assert.deepEqual(pane.episodes.map(row => row.pane.id), ['s0']);

  const project = await f.app.dispatch({ kind: 'recall_project', name: path.basename(f.root) });
  assert.equal(project.ok, true);
  assert.equal(project.project.defaultProvider, 'codex');
  assert.deepEqual(project.episodes.map(row => row.typedText), ['Investigate the orchestrator performance.']);
  assert.deepEqual(await f.app.dispatch({ kind: 'recall_pane', targetId: 'nobody' }), { ok: true, pane: null, episodes: [] });
});

test('clearing history removes the episodes and keeps the pane and project facts', async t => {
  const f = await relay(t);
  assert.equal((await f.app.send({ text: 'Review the release checklist.', origin: 'text' })).ok, true);
  await until(() => fs.existsSync(path.join(f.root, FILE)));
  assert.ok((await f.app.dispatch({ kind: 'recall', query: 'release checklist' })).episodes.length);
  await f.app.clearHistory();
  await tick();
  assert.deepEqual((await f.app.dispatch({ kind: 'recall', query: 'release checklist' })).episodes, []);
  const pane = await f.app.dispatch({ kind: 'recall_pane', targetId: 's0' });
  assert.equal(pane.pane.title, 'Release checklist review', 'What a pane is stays; what was said about it goes.');
  assert.deepEqual(pane.episodes, []);
  assert.equal((await f.app.dispatch({ kind: 'recall_project', name: path.basename(f.root) })).project.project, path.basename(f.root));
});

test('the store is bounded: five thousand episodes, five hundred pane facts, one hundred projects', async t => {
  assert.deepEqual([LIMITS.episodes, LIMITS.paneFacts, LIMITS.projectFacts, LIMITS.episodeAgeMs],
    [5000, 500, 100, 90 * DAY]);
  const clock = Date.parse('2026-09-12T12:00:00Z');
  const { store } = storeIn(t, { now: () => clock, prefix: 'vibe-memory-bounds-' });
  for (let index = 0; index < 120; index++) store.upsertPaneFact({ paneId: `p${index}`, project: `project-${index}`, title: `Pane ${index}` });
  assert.equal(store.snapshot().paneFacts.length, 120);
  assert.equal(store.snapshot().projectFacts.length, LIMITS.projectFacts, 'Project facts are bounded, oldest first.');
  assert.equal(store.snapshot().projectFacts.at(-1).project, 'project-119');
  await store.flush();
});

// ---------------------------------------------------------------------------
// Roster-backed answers: the questions the completion ladder showed reaching the
// brain (and flailing there) although the app already held the answer.
// ---------------------------------------------------------------------------
test('status, needs-me, last-done and gave-to questions are answered from the roster and the ledger', () => {
  const { sentence } = require('../../backend/orchestratorFailureText.cjs');
  // Live panes as the inventory publishes them: the roster reads the same
  // pane-state predicate assignment does, so the process facts must be there.
  const live = s => ({ kind: s.provider, started: true, processState: 'running', agentProcessState: 'running', agentPid: 7,
    launchState: 'ready', observation: 'observed', ...s });
  const sessions = [
    { id: 's1', name: '⠼ Chat section', projectName: 'vibeTerminal', provider: 'codex', status: 'running', turnState: 'running', turnId: 't1' },
    { id: 's2', name: 'Full screen bug', projectName: 'vibeTerminal', provider: 'claude', turnState: 'completed', status: 'completed', turnId: 't2', turnEndedAt: 2000 },
    { id: 's3', name: 'Pairing screen', projectName: 'lina mobile', provider: 'claude', turnState: 'completed', status: 'completed', turnId: 't3', turnEndedAt: 1000 },
    { id: 's4', name: 'PDF viewer deep dive', projectName: 'lina web app', provider: 'codex', status: 'waiting', turnState: 'waiting', turnId: 't4' },
    { id: 's5', name: 'Codex 3', projectName: 'vibeTerminal', provider: 'codex', turnState: 'unknown', status: 'unknown' },
  ].map(live);
  // The answers read the terminal model (handles T1..T5 in inventory order),
  // never the raw sessions: the same objects the Brain's roster and the
  // renderer read.
  const { createTerminalHandles, buildTerminalModel } = require('../../backend/orchestratorTerminalModel.cjs');
  const terminalsOf = (list, records = {}) => buildTerminalModel({ sessions: list, records,
    handles: createTerminalHandles({ load: () => ({ next: 6, byId: { s1: 'T1', s2: 'T2', s3: 'T3', s4: 'T4', s5: 'T5' } }) }) });
  const terminals = terminalsOf(sessions);
  const store = { recall: ({ query } = {}) => /full screen/i.test(query || '')
    ? [{ requestId: 'r1', verb: 'start', outcome: 'delivered-started', project: 'vibeTerminal',
      pane: { id: 's2', name: 'Full screen bug', provider: 'claude' }, typedText: 'Fix the full screen bug when a pane is maximized.' }]
    : [] };
  const ask = (text, options = {}) => {
    const match = memoryQuestion(text);
    assert.ok(match, `no template matched: ${text}`);
    return answerMemoryQuestion(store, match, { terminals, ...options });
  };
  const rendered = answer => sentence(answer.key, answer.context).text;

  const status = ask("Can you tell me what's going on in the Vibe terminals and tell me the progress?", { project: 'vibeTerminal' });
  assert.equal(status.key, 'status-all');
  assert.match(rendered(status), /T1 \(Codex terminal\) is working; T2 \(Claude Code terminal\) is done; T5 \(Codex terminal\) is idle/);
  assert.doesNotMatch(rendered(status), /T3/, 'a project-scoped report lists only that project');

  const needs = ask("There's a terminal that needs me. Which one is it?");
  assert.equal(needs.key, 'needs-me');
  assert.equal(rendered(needs), 'T4 in lina web app is waiting on you.');
  // A working pane may be asking a question its provider never reported, so
  // with one still working the brain reads the panes; with nothing working,
  // nothing is waiting.
  assert.equal(answerMemoryQuestion(store, memoryQuestion("There's a terminal that needs me. Which one is it?"),
    { terminals: terminalsOf(sessions.filter(s => s.id !== 's4')) }), null);
  const nobody = answerMemoryQuestion(store, memoryQuestion("There's a terminal that needs me. Which one is it?"),
    { terminals: terminalsOf(sessions.filter(s => s.id !== 's4' && s.id !== 's1')) });
  assert.equal(nobody.key, 'needs-me-none');
  // "Did you enter that prompt?" is answered first, then the record; a result
  // question with two finished panes and no recorded result names them both.
  const entered = answerMemoryQuestion(store, memoryQuestion('did you enter that prompt?'), { terminals, project: 'vibeTerminal' });
  assert.equal(entered, null, 'no typed prompt is recorded in this store');
  const typed = { recall: () => [{ requestId: 'r2', verb: 'start', outcome: 'delivered-started', project: 'vibeTerminal',
    pane: { id: 's5', name: 'Codex 3', provider: 'codex' }, typedText: 'Summarize the repo.' }] };
  const confirmed = answerMemoryQuestion(typed, memoryQuestion('did you enter that prompt?'), { terminals, project: 'vibeTerminal' });
  assert.equal(confirmed.key, 'last-prompt-confirmed');
  assert.equal(rendered(confirmed), 'Yes, I put “Summarize the repo.” in Codex 3. It started working on it.');
  const several = answerMemoryQuestion({ recall: () => [] }, memoryQuestion("There's a terminal that's done. What's the result?"), { terminals });
  assert.equal(several.key, 'pane-result-several');
  assert.equal(rendered(several), 'More than one has finished: T2, T3. Which one do you mean?');
  // With pane memory in hand the answers carry what each pane is on: the
  // waiting pane's task (the user asked "which one", not "what is it called"),
  // and every finished pane's recorded result instead of a question.
  const paneRecords = { s4: { lastPromptText: 'Do a deep dive on the PDF viewer.' }, s2: { lastResultSummary: 'RESULT-FS-42' }, s3: { lastResultSummary: 'RESULT-PAIR-9' } };
  const needsTask = answerMemoryQuestion(store, memoryQuestion("There's a terminal that needs me. Which one is it?"), { terminals: terminalsOf(sessions, paneRecords) });
  assert.equal(rendered(needsTask), 'T4 in lina web app, on “Do a deep dive on the PDF viewer.”, is waiting on you.');
  const both = answerMemoryQuestion({ recall: () => [] }, memoryQuestion("There's a terminal that's done. What's the result?"), { terminals: terminalsOf(sessions, paneRecords) });
  assert.equal(both.key, 'pane-results');
  assert.equal(rendered(both), 'T2 came back with: RESULT-FS-42. T3 came back with: RESULT-PAIR-9.');
  const one = answerMemoryQuestion({ recall: () => [] }, memoryQuestion("There's a terminal that's done. What's the result?"), { terminals: terminalsOf(sessions.filter(s => s.id !== 's3'), paneRecords) });
  assert.equal(one.key, 'pane-result');
  assert.equal(rendered(one), 'T2 came back with: RESULT-FS-42');

  const lastDone = ask('Thank you. Hey, what was the last terminal that was done?');
  assert.equal(lastDone.key, 'last-done');
  assert.equal(rendered(lastDone), 'The last one to finish was T2 in vibeTerminal.');
  assert.equal(ask("Hey, bye. There's a terminal that's done. Can you see that terminal?").key, 'last-done');

  const gave = ask('Which terminal did you give the full screen bug to?');
  assert.equal(gave.key, 'gave-to');
  assert.match(rendered(gave), /I put the full screen bug work in Full screen bug: “Fix the full screen bug/);

  // No ledger row, but a pane titled by the task's words: answered from the roster.
  const titled = answerMemoryQuestion({ recall: () => [] }, memoryQuestion('Which terminal did you give the full screen bug to?'), { terminals });
  assert.equal(titled.key, 'gave-to-pane');
  assert.equal(rendered(titled), 'The full screen bug work is in T2 in vibeTerminal.');

  // Nothing recorded → the brain still gets the question, exactly as before.
  assert.equal(answerMemoryQuestion({ recall: () => [] }, memoryQuestion('Which terminal did you give the login bug to?'), { terminals }), null);
  assert.equal(answerMemoryQuestion(store, memoryQuestion('what was the last terminal that was done?'), { sessions: [] }), null);
});
