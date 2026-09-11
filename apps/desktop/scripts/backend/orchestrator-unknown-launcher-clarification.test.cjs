'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');

async function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-unknown-launcher-')));
  const f = { root, plans: [], calls: [], effects: [], sessions: [], spoken: [] };
  f.app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [{ id: 'qa', name: 'Recovery QA', path: root }] }),
    getSessions: () => f.sessions,
    getLaunchers: () => [{ kind: 'codex', label: 'Codex', available: true, configured: true }],
    dispatchAction: async action => {
      f.effects.push(action);
      assert.equal(action.kind, 'create_session'); assert.equal(action.kindOfSession, 'codex'); assert.equal(action.cwd, root);
      const target = { id: 'created-codex', generation: 'g1', launchToken: 1 };
      f.sessions.push({ ...target, kind: 'codex', provider: 'codex', name: 'Codex', cwd: root, processState: 'running', turnState: 'idle', started: true });
      return { ok: true, status: 'created', processState: 'running', id: target.id, launchToken: target.launchToken, target };
    },
    onSpeak: event => { f.spoken.push(event); return { ok: true }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture-brain', supported_parameters: ['tools'], context_length: 128000 }] }));
      assert(url.endsWith('/chat/completions'));
      const body = JSON.parse(options.body);
      if (body.messages[0].content.startsWith('Check the purpose of proposed new-terminal drafts')) return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'OPEN' } }] }));
      f.calls.push(body);
      assert.equal(body.tools?.[0]?.function?.name, 'interpret_workspace', 'clarification and direct creation require no executor');
      assert(f.plans.length, 'unexpected extra interpretation call');
      const plan = f.plans.shift(), context = JSON.parse(body.messages.find(message => message.role === 'user').content);
      const args = typeof plan === 'function' ? plan(context) : plan;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `intent-${f.calls.length}`, type: 'function',
        function: { name: 'interpret_workspace', arguments: JSON.stringify(args) } }] } }] }));
    }
  });
  t.after(async () => { await f.app.dispose(); assert(path.resolve(root).startsWith(path.dirname(root) + path.sep + 'vibe-unknown-launcher-')); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal((await f.app.configure({ apiKey: 'fixture-key', sessionOnly: true, model: 'fixture-brain' })).ok, true);
  assert.equal((await f.app.setEnabled(true)).ok, true);
  f.multiple = kind => ({ goal: 'Open both requested terminal types in Recovery QA.', executionMode: 'direct', actions: [
    { kind: 'create_session', cwd: root, kindOfSession: 'codex' }, { kind: 'create_session', cwd: root, kindOfSession: kind }
  ] });
  return f;
}

test('unsupported web launcher immediately becomes a focused clarification with the complete original request preserved', async t => {
  const f = await fixture(t), original = 'Open a new Codex terminal and a web terminal in Recovery QA. Keep both terminals separate.';
  f.plans.push(f.multiple('web'));
  const result = await f.app.send({ text: original, origin: 'voice' });
  assert.equal(f.calls.length, 1); assert.equal(f.plans.length, 0); assert.equal(f.effects.length, 0);
  assert.match(result.text, /What did you mean.*web.*terminal/); assert.equal(result.responseTurn, 'listen');
  assert.notEqual(result.text, 'done');
  const state = f.app.getState(), task = state.tasks.find(item => item.requestId === result.requestId);
  assert.equal(task.status, 'needs-answer'); assert.equal(task.text, original); assert.equal(task.question.text, result.text);
  assert.equal(state.receipts.length, 0); assert.equal(f.sessions.length, 0, 'supported Codex is not created before the other clause is resolved');
  assert(f.spoken.length > 0); assert(f.spoken.every(event => event.responseTurn === 'listen' && !event.completionCue));
  assert(f.spoken.every(event => /web/.test(event.text)));
  f.plans.push(context => {
    assert.equal(context.previousCommand.requestId, result.requestId); assert.equal(context.previousCommand.instruction, original);
    return { goal: 'Clarify the same original request.', continuationOf: result.requestId, actions: [], clarification: 'Which terminal type did you mean?' };
  });
  await f.app.send({ text: 'I still mean both terminals.', replyToRequestId: result.requestId, origin: 'text' });
  assert.equal(f.effects.length, 0); assert.equal(f.plans.length, 0);
});

test('a malformed creation interpretation can still repair into its supported launcher', async t => {
  const f = await fixture(t);
  f.plans.push({ goal: 'Open the requested Codex terminal.', actions: [{ kind: 'create_session', cwd: f.root }] }, { goal: 'Open the requested Codex terminal.', executionMode: 'direct', actions: [{ kind: 'create_session', cwd: f.root, kindOfSession: 'codex' }] });
  const result = await f.app.send({ text: 'Open one new Codex terminal in Recovery QA.', origin: 'text' });
  assert.equal(f.calls.length, 2); assert.equal(f.plans.length, 0); assert.equal(result.ok, true);
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].kindOfSession, 'codex'); assert.equal(f.sessions.length, 1);
  assert.equal(f.app.getState().tasks.find(item => item.requestId === result.requestId).question, undefined);
  assert.doesNotMatch(result.text, /web|What.*terminal/);
});

test('unsafe unknown launcher names use generic clarification without echoing model arguments', async t => {
  const f = await fixture(t), unsafe = 'C:\\PRIVATE_UNSAFE_LAUNCHER\\evil.exe';
  f.plans.push(f.multiple(unsafe));
  const result = await f.app.send({ text: 'Open Codex and a web terminal in Recovery QA.', origin: 'voice' });
  assert.equal(f.calls.length, 1); assert.equal(f.effects.length, 0); assert.equal(result.responseTurn, 'listen');
  assert.equal(result.text, 'What kind of terminal did you mean?');
  assert.equal(f.app.getState().tasks.find(item => item.requestId === result.requestId).status, 'needs-answer');
  assert.doesNotMatch(JSON.stringify({ result, messages: f.app.getState().messages, spoken: f.spoken }), /PRIVATE_UNSAFE|evil\.exe/);
  assert(f.spoken.every(event => !event.completionCue));
});


test('catalog-missing supported launcher clarifies before creating any sibling', async t => {
  const f = await fixture(t);
  f.plans.push(f.multiple('fusion'));
  const result = await f.app.send({ text: 'Open both requested terminal types.', origin: 'text' });
  assert.equal(result.ok, true); assert.equal(result.responseTurn, 'listen');
  assert.equal(result.text, 'Which available terminal did you mean?');
  assert.equal(f.calls.length, 1); assert.equal(f.effects.length, 0);
  assert.equal(f.app.getState().tasks.find(item => item.requestId === result.requestId).status, 'needs-answer');
});
