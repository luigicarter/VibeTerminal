'use strict';
// Every failure the user reads names the pane and the cause, and a request that
// fails after opening a pane says that the pane is still there. This replays the
// September 12 chain end to end: a refused send, a provider 400 on the fallback,
// and the orphaned pane it left behind.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { assertTranscriptShape } = require('../../backend/orchestratorExecutionHarness.cjs');
const { paneLabel, failureSentence, providerSentence, brainRejectionSentence } = require('../../backend/orchestratorFailureText.cjs');
const { observeWorkItemCommits } = require('./orchestrator-work-item-persistence-fixture.cjs');
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });
const REJECTION = 'Tool-call assistant message produced no valid function calls but is followed by tool result messages. The conversation transcript is malformed.';

test('pane names fall back from title to provider and folder', () => {
  assert.equal(paneLabel({ name: 'Open Claude Code 11' }), 'Open Claude Code 11');
  assert.equal(paneLabel({ provider: 'claude-custom', cwd: 'C:\\work\\vibeTerminal' }), 'Claude in vibeTerminal');
  assert.equal(paneLabel({ provider: 'codex' }), 'Codex');
  assert.equal(paneLabel({}), 'The terminal');
});

test('each delivery failure maps to one sentence naming the pane and the next step', () => {
  const pane = 'Open Claude Code 11';
  assert.equal(failureSentence('input-surface-unverified', { pane }), "Open Claude Code 11 was still on its startup screen, so nothing was typed. The pane is still open; say 'try again' when it's ready.");
  assert.equal(failureSentence('launch-timeout', { pane, seconds: 60 }), "Open Claude Code 11 didn't become ready within 60 seconds, so nothing was typed. The pane is still open; say 'try again' when it's ready.");
  assert.equal(failureSentence('stale-observation', { pane }), 'Open Claude Code 11 changed while I was about to type, so I held off. Nothing was sent.');
  assert.equal(failureSentence('generation-changed', { pane }), 'Open Claude Code 11 was restarted before I could confirm its result; check the pane.');
  assert.equal(failureSentence('some-other-status', { pane }), undefined, 'an unmapped status keeps its existing wording');
});

// The application retries a prompt whose only obstacle was the screen moving
// under it, so when it does give up the user hears how many times it looked.
test('a retried send reports its attempt count, and an unretried one reads exactly as before', () => {
  const { collectTaskReports } = require('../../backend/orchestratorTaskReports.cjs');
  const pane = 'Codex 2';
  assert.equal(failureSentence('stale-observation', { pane, attempts: 3 }),
    'Codex 2 kept changing each of the 3 times I was about to type, so I held off. Nothing was sent.');
  assert.equal(failureSentence('stale-observation', { pane, attempts: 1 }), failureSentence('stale-observation', { pane }));
  const target = { id: 'a', generation: 'g', name: pane };
  const report = attempts => collectTaskReports({ executionDone: true, task: { status: 'failed', targets: [target] }, controller: new AbortController(),
    waits: [{ targetId: 'a', generation: 'g', done: true, failed: true, delivered: false, deliveryStatus: 'stale-observation',
      ...(attempts && { deliveryAttempts: attempts }) }] }, [target])[0].text;
  assert.equal(report(3), 'Codex 2 kept changing each of the 3 times I was about to type, so I held off. Nothing was sent.');
  assert.equal(report(), 'Codex 2 changed while I was about to type, so I held off. Nothing was sent.');
});

test('a brain failure says what it meant for the request and keeps the provider wording private', () => {
  const error = Object.assign(new Error('x'), { status: 400, providerMessage: `Provider returned error: {"error":{"code":400,"message":"${REJECTION}","status":"INVALID_ARGUMENT"}}` });
  // The provider's own sentence still travels to the receipt and the log.
  assert.equal(providerSentence(error.providerMessage), 'Tool-call assistant message produced no valid function calls but is followed by tool result messages.');
  const text = brainRejectionSentence(error);
  assert.equal(text, "I couldn't get a plan from the brain for that one, so nothing was typed.");
  assert.doesNotMatch(text, /settings|rejected|malformed|HTTP|Check the selected model/i);
  assert.equal(brainRejectionSentence({ status: 0 }), text);
});

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-failure-text-'));
  const f = { root, sessions: [], effects: [], plans: [], bodies: [] };
  f.commits = observeWorkItemCommits(t, path.join(root, 'orchestrator-work-items.json'), () => f.relay?.getState().tasks);
  f.relay = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getRoots: () => ({ documents: root, projects: [{ name: path.basename(root), path: root }] }),
    getSessions: () => f.sessions, getLaunchers: async () => [{ kind: 'claude-custom', label: 'Open Claude Code', available: true, configured: true }],
    interpretIntent: async context => ({ goal: context.instruction, actions: [f.plans.shift()] }),
    routeTask: async () => ({ kind: 'choose', decision: 'create', kindOfSession: 'claude-custom', reason: 'Independent task needs its own conversation.' }),
    readSession: async target => {
      const session = f.sessions.find(item => item.id === target.id);
      return session ? { ok: true, id: session.id, generation: session.generation, text: 'Do you trust the files in this folder?', sequence: 10, inputRevision: 2 }
        : { ok: false, status: 'stale-generation' };
    },
    dispatchAction: async action => {
      f.effects.push(action);
      if (action.kind === 'create_session') {
        const session = { id: 'pane-1', name: 'Open Claude Code 11', kind: 'claude-custom', provider: 'claude-custom', cwd: action.cwd,
          generation: 'generation-1', launchToken: 1, started: true, status: 'idle', observation: 'observed', processState: 'running',
          agentProcessState: 'running', agentPid: 4242, turnState: 'idle', revision: 1 };
        f.sessions.push(session);
        return { ok: true, status: 'created', id: session.id, launchToken: 1, processState: 'running', cwd: action.cwd, name: session.name,
          target: { id: session.id, generation: session.generation, launchToken: 1 } };
      }
      // The pane is showing its trust screen, exactly as on September 12.
      return { ok: false, status: 'input-surface-unverified', delivery: 'not-dispatched',
        error: `${failureSentence('input-surface-unverified', { pane: 'Open Claude Code 11' })} The terminal is showing a startup screen: it is asking whether to trust the files in this folder.` };
    },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return jsonResponse({ data: {} });
      if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'scripted', context_length: 128000, supported_parameters: ['tools', 'tool_choice'] }] });
      f.bodies.push(JSON.parse(options.body));
      return jsonResponse({ error: { code: 400, message: `Provider returned error: {"error":{"code":400,"message":"${REJECTION}","status":"INVALID_ARGUMENT"}}`,
        metadata: { provider_name: 'Google' } } }, 400);
    } });
  t.after(async () => { await f.relay.cancel(); await f.relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await f.relay.configure({ apiKey: 'test-key', model: 'scripted', sessionOnly: true });
  assert.equal((await f.relay.setEnabled(true)).ok, true);
  f.run = async text => { f.plans.push({ kind: 'delegate_task', text, cwd: root }); return f.relay.send({ text, origin: 'text' }); };
  f.diagnostics = async () => {
    await f.relay.flushDiagnostics();
    const file = path.join(root, 'logs', 'orchestrator-errors.jsonl');
    return (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  };
  return f;
}

test('a request that fails after opening a pane names the pane, the cause, and the pane it left open', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  const result = await f.run('Investigate the performance of the orchestrator.');
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.deepEqual(f.effects.map(effect => effect.kind), ['create_session', 'send_prompt']);
  // What it meant for the request, plus the pane it left behind; not "check
  // the selected model and settings", and no provider vocabulary.
  assert.match(result.error, /^I couldn't get a plan from the brain for that one, so nothing was typed\./);
  assert.match(result.error, /Open Claude Code 11 in .+ is still open\.$/);
  assert.doesNotMatch(result.error, /rejected|malformed|settings|HTTP/i);
  assert.equal(f.sessions.length, 1, 'no second pane is opened for the same objective');

  // The work item stays bound to that pane and is marked retriable, not just failed.
  const item = await f.commits.waitFor(item => item.retriable === true, 'a retriable work item');
  assert.equal(item.binding?.target?.id, 'pane-1');
  assert.equal(item.objective, 'Investigate the performance of the orchestrator.');

  // The rejected request is explained: the provider's sentence and the shape of
  // the transcript it refused, with no message content.
  const failures = (await f.diagnostics()).filter(entry => entry.event === 'orchestrator_error' && entry.httpStatus === 400);
  assert.ok(failures.length >= 1, JSON.stringify(await f.diagnostics()));
  assert.match(failures.at(-1).providerMessage, /The conversation transcript is malformed/);
  // The transcript the application handed the provider now holds no turn the
  // model did not write: the refused handoff is a user-role delivery report.
  assert.equal(failures.at(-1).transcriptShape.some(entry => entry.role === 'assistant'), false);
  assert.ok(failures.at(-1).transcriptShape.every(entry => (entry.toolCalls || []).every(call => call.type === 'function')));
  assert.equal(JSON.stringify(failures.at(-1).transcriptShape).includes('Investigate the performance'), false);

  assert.ok(f.bodies.length >= 1);
  for (const body of f.bodies) {
    assertTranscriptShape(body.messages);
    assert.equal(body.messages.some(message => message.role === 'assistant'), false, 'the application authors no assistant turn');
    const reports = body.messages.filter(message => message.role === 'user' && String(message.content).includes('deliveryReport'));
    assert.equal(reports.length, 1, 'the refused delivery is reported once, as a user message');
    const [entry, ...rest] = JSON.parse(reports[0].content).deliveryReport;
    assert.deepEqual(rest, []);
    assert.equal(entry.targetId, 'pane-1');
    assert.match(entry.reason, /it is asking whether to trust the files in this folder/);
    assert.match(entry.screen, /Do you trust the files in this folder\?/);
  }
});

test('a startup screen is published as a lifecycle line for the pane that is showing it', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  f.sessions.push({ id: 'pane-1', generation: 'generation-1', name: 'Open Claude Code 11', kind: 'claude-custom', provider: 'claude-custom' });
  await f.relay.refresh();
  assert.deepEqual(f.relay.recordStartupScreen({ id: 'pane-1', generation: 'generation-1', actionId: 'a1', prompt: 'folder-trust',
    text: 'Open Claude Code 11 is showing a startup screen: it is asking whether to trust the files in this folder.' }), { ok: true });
  // The row names the pane, the screen, and what happens next.
  assert.equal(f.relay.getState().messages.at(-1).text,
    "Open Claude Code 11 is still on its startup screen (trust prompt); I'll answer it and keep trying for 20 seconds.");
  assert.equal(f.relay.getState().messages.at(-1).role, 'system');
  assert.equal(f.relay.getState().messages.at(-1).reportKind, 'lifecycle');
  assert.deepEqual(f.relay.recordStartupScreen({ id: 'pane-1', text: '  ' }), { ok: false }, 'an empty report publishes nothing');
});
