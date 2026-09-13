'use strict';
// An idle pane that no work item owns is what the user means by "one of the
// empty terminals". It takes new work deterministically: no routing model, no
// ownership reviewer, no additional pane, and a question instead of a silent
// creation when the instruction asked for an idle pane and none is free.
// No routing adapter is injected here: these requests reach the actual
// deterministic resolver, and the fetch stub fails on any model round at all.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const jsonResponse = body => new Response(JSON.stringify(body));
let sequence = 0;

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-idle-reuse-'));
  const f = { root, sessions: [], effects: [], plans: [], reads: [],
    launchers: [{ kind: 'codex', label: 'Codex', available: true, configured: true },
      { kind: 'claude', label: 'Claude Code', available: true, configured: true }] };
  f.session = (id, overrides = {}) => {
    const session = { id, name: `Codex ${id}`, kind: 'codex', provider: 'codex', cwd: root, generation: `generation-${id}`,
      launchToken: ++sequence, conversationId: `conversation-${id}`, started: true, status: 'idle', observation: 'observed',
      processState: 'running', agentProcessState: 'running', agentPid: 100 + sequence, turnState: 'idle', revision: 1,
      lastActivityAt: 1000, ...overrides };
    f.sessions.push(session);
    return session;
  };
  f.relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [{ name: path.basename(root), path: root }] }),
    getSessions: () => f.sessions, getLaunchers: async () => f.launchers,
    interpretIntent: async context => {
      const plan = f.plans.shift();
      assert.ok(plan, 'Every request has one explicitly scripted interpretation');
      return { goal: context.instruction, actions: [plan] };
    },
    readSession: async target => {
      f.reads.push(target.id);
      const session = f.sessions.find(item => item.id === target.id);
      if (!session) return { ok: false, status: 'stale-generation' };
      return { ok: true, id: session.id, generation: session.generation, text: 'Task workspace ready.', sequence: 10, inputRevision: 2 };
    },
    dispatchAction: async action => {
      f.effects.push(action);
      if (action.kind !== 'create_session') return { ok: true, status: 'written' };
      const created = f.session(`created-${f.sessions.length + 1}`, { cwd: action.cwd, kind: action.kindOfSession, provider: action.kindOfSession });
      return { ok: true, status: 'created', id: created.id, launchToken: created.launchToken, processState: 'running',
        target: { id: created.id, generation: created.generation, launchToken: created.launchToken } };
    },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return jsonResponse({ data: {} });
      if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'scripted', context_length: 128000, supported_parameters: ['tools', 'tool_choice'] }] });
      const body = JSON.parse(options.body);
      assert.fail(`No model round is expected for a deterministic idle assignment: ${JSON.stringify(body.messages.at(0)).slice(0, 120)}`);
    } });
  t.after(async () => { await f.relay.cancel(); await f.relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await f.relay.configure({ apiKey: 'test-key', model: 'scripted', sessionOnly: true });
  assert.equal((await f.relay.setEnabled(true)).ok, true);
  f.run = async (text, extra = {}, input = {}) => { f.plans.push({ kind: 'delegate_task', text, cwd: root, ...extra }); return f.relay.send({ text, origin: 'text', ...input }); };
  f.task = result => f.relay.getState().tasks.find(task => task.requestId === result.requestId);
  // Release the project lane so a following independent request is admitted.
  f.settle = async () => {
    const send = f.effects.filter(effect => effect.kind === 'send_prompt').at(-1);
    const session = f.sessions.find(item => item.id === send.targetId);
    const time = Date.now();
    Object.assign(session, { turnId: `turn-${send.actionId}`, actionId: send.actionId, turnState: 'completed', status: 'completed', turnStartedAt: time, turnEndedAt: time });
    await f.relay.refresh();
  };
  f.diagnostics = async stage => {
    await f.relay.flushDiagnostics();
    const file = path.join(root, 'logs', 'orchestrator-errors.jsonl');
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    return lines.filter(entry => entry.stage === stage);
  };
  return f;
}

test('an idle pane no work item owns is assigned without an ownership review', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  const idle = f.session('idle-pane');
  const result = await f.run('Investigate the performance of the orchestrator.');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt']);
  assert.equal(f.effects[0].targetId, idle.id);
  const stages = await f.diagnostics('resolver');
  assert.deepEqual(stages.map(entry => entry.decision), ['reuse']);
  assert.equal(stages[0].targetId, idle.id);
  assert.equal(stages[0].selectorKind, 'none');
  assert.equal(f.task(result).assignment.reason, 'Idle pane with no task owner; assigned to this new task.');
});

// The reviewer that used to judge continuity here is retired. An idle pane
// another work item owns is simply not free, so independent work opens its own
// conversation; the one-owner rule still protects the owned pane.
test('an idle pane another work item owns is never adopted for independent work', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  const first = await f.run('Fix checkout validation.');
  assert.equal(first.ok, true, JSON.stringify(first));
  const owned = f.sessions.at(-1);
  assert.deepEqual(f.effects.map(effect => effect.kind), ['create_session', 'send_prompt']);
  await f.settle();
  const second = await f.run('Update the deployment documentation.');
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(f.effects.map(effect => effect.kind), ['create_session', 'send_prompt', 'create_session', 'send_prompt']);
  assert.notEqual(f.effects[3].targetId, owned.id);
  assert.notEqual(f.task(second).workItemId, f.task(first).workItemId);
});

test('a create route yields to an idle unowned pane when the instruction asked for one', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  f.session('older-pane', { lastActivityAt: 500 });
  const recent = f.session('recent-pane', { lastActivityAt: 5000 });
  f.session('busy-pane', { lastActivityAt: 9000, turnState: 'running', status: 'running', turnId: 'other-turn' });
  f.session('claude-pane', { lastActivityAt: 9000, kind: 'claude', provider: 'claude' });
  const result = await f.run('Use one of the empty codex terminals to investigate performance.');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt'], 'no additional pane is opened');
  assert.equal(f.effects[0].targetId, recent.id, 'the most recently active idle unowned pane of the requested provider');
  assert.equal(f.task(result).assignment.reason, 'Idle pane with no task owner; assigned to this new task.');
});

test('an instruction that asked for an idle pane asks before opening another one', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  f.session('busy-pane', { turnState: 'running', status: 'running', turnId: 'other-turn' });
  const result = await f.run('Use one of the empty Codex terminals to investigate performance.');
  const task = f.task(result);
  assert.equal(task.status, 'needs-answer', JSON.stringify(result));
  assert.equal(task.question.text, `No idle Codex pane is free in ${path.basename(f.root)}. Open a new one?`);
  assert.deepEqual(f.effects, [], 'nothing is created and nothing is typed');
});

// Scored against the saved utterances: an explicit idle-pane request asks
// rather than opening another pane, while "free"/"not working" used about the
// work itself must never turn an ordinary request into a question.
for (const [name, text, idle, expected] of [
  ['a passing "hands free" mention', 'put in another codex terminal within vibeTerminal to identify a bug when the hands free is unavailable', false, 'create'],
  ['a broken page, not a free pane', 'have a codex terminal fix the login page that is not working', false, 'create'],
  ['an explicit new pane', 'open a new codex terminal in vibeTerminal and have it investigate', false, 'create'],
  ['a pane that is not currently working', "Just put it in a terminal that's not currently working.", true, 'reuse'],
  ['a pane that is not currently working with none free', "Just put it in a terminal that's not currently working.", false, 'question'],
  ['one that is not busy', "pick one that's not busy right now and have it review the changes", true, 'reuse'],
  ['one of the empty terminals', 'use one of the empty codex terminals in the vibe terminal project', true, 'reuse'],
]) test(`idle-pane selection for ${name}`, { timeout: 2000 }, async t => {
  const f = await fixture(t);
  const pane = idle ? f.session('idle-pane') : f.session('busy-pane', { turnState: 'running', status: 'running', turnId: 'other-turn' });
  const result = await f.run(text);
  if (expected === 'question') {
    assert.equal(f.task(result).status, 'needs-answer', JSON.stringify(result));
    assert.deepEqual(f.effects, []);
    return;
  }
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.task(result).status !== 'needs-answer', true, 'an ordinary request is never answered with a question');
  if (expected === 'reuse') {
    assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt']);
    assert.equal(f.effects[0].targetId, pane.id);
  } else {
    assert.deepEqual(f.effects.map(effect => effect.kind), ['create_session', 'send_prompt']);
    assert.notEqual(f.effects[1].targetId, pane.id);
  }
});

// The product decision behind the resolver: an idle pane nobody owns is
// reusable for new work, so an ordinary request takes it instead of opening a
// second empty pane beside it. Only a project with no free pane creates one.
test('an ordinary instruction takes the free pane, and creates one only when none is free', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  const idle = f.session('idle-pane');
  const first = await f.run('Investigate the performance of the orchestrator.');
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt']);
  assert.equal(f.effects[0].targetId, idle.id);
  await f.settle();
  const second = await f.run('Update the deployment documentation.');
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt', 'create_session', 'send_prompt']);
  assert.notEqual(f.effects[2].targetId, idle.id);
});

for (const mode of ['new', 'existing']) test(`assignmentMode ${mode} keeps its own semantics for an idle-pane instruction`, { timeout: 2000 }, async t => {
  const f = await fixture(t);
  const idle = f.session('idle-pane');
  const result = await f.run('Use one of the empty codex terminals to investigate performance.', { assignmentMode: mode });
  if (mode === 'new') {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(f.effects.map(effect => effect.kind), ['create_session', 'send_prompt']);
  } else {
    assert.equal(f.task(result).status, 'needs-answer', JSON.stringify(result));
    assert.deepEqual(f.effects, []);
    assert.equal(f.sessions.length, 1);
    assert.equal(f.sessions[0].id, idle.id);
  }
});
