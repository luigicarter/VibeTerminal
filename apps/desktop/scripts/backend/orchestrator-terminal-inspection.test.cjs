'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { createPane, providerScenarios } = require('../qa/orchestrator-terminal-inspection-fixture.cjs');
let serial = 0;
const call = (action, name = 'workspace') => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `inspection-${++serial}`, type: 'function', function: { name, arguments: JSON.stringify(action) } }] } }] });
const reply = content => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
const meta = body => JSON.parse(body.messages.find(message => message.role === 'user').content);
const latest = body => JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
const read = () => call({ kind: 'read_session', targetId: 'Atlas' });
function operate(body, kind, extra = {}) {
  const grant = meta(body).authorizedCommands.grants.find(grant => grant.kind === 'operate_terminal');
  assert.ok(grant); const observed = latest(body); assert.ok(observed.observationToken);
  return call({ kind, targetId: 'Atlas', grantId: grant.id, stepId: `step-${++serial}`, observationToken: observed.observationToken,
    ...(kind === 'terminal_interact' && { observationSequence: observed.observation.sequence, inputRevision: observed.observation.inputRevision }), ...extra });
}
async function fixture(t, kind, mode = 'usage') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-inspection-'));
  const pane = createPane('Atlas', kind, root, mode), bodies = [], steps = [], spoken = [];
  let scriptError, interpretation;
  const relay = createOrchestrator({ autoInspectionCompletion: false, userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    onSpeak: event => { spoken.push(event); return { ok: true }; },
    getRoots: () => ({ documents: root, projects: [{ name: 'Fixture', path: root }] }), getSessions: () => [{ ...pane.session }], readSession: async () => pane.read(), dispatchAction: async action => pane.dispatch(action),
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'scripted', context_length: 128000, supported_parameters: ['tools', 'tool_choice'] }] }));
      const body = JSON.parse(options.body);
      if (body.messages[0].content === require('../../backend/orchestratorGoalReview.cjs').INSPECTION_GOAL_REVIEW) {
        const evidence = JSON.parse(body.messages[1].content).evidence;
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decision: 'complete', evidenceIds: [evidence.at(-1).id] }) } }] }));
      }

      if (body.tools?.[0]?.function?.name === 'interpret_workspace') { interpretation = body; return new Response(JSON.stringify(call(mode === 'passive' ? { goal: 'Read existing task output.', access: 'read-only', actions: [] } : { goal: 'Inspect local terminal usage.', responseKind: 'terminal-inspection', actions: [{ kind: 'operate_terminal', targetIds: ['Atlas'], text: 'Inspect local usage and report the observed limits.', permissionMode: 'none' }] }, 'interpret_workspace'))); }
      bodies.push(body);
      try { assert.ok(steps.length, 'Unexpected model call: ' + JSON.stringify(body.messages.at(-1))); const step = steps.shift(); return new Response(JSON.stringify(typeof step === 'function' ? step(body) : step)); }
      catch (error) { scriptError = error; throw error; }
    } });
  t.after(async () => { await relay.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await relay.configure({ apiKey: 'test-key', model: 'scripted', sessionOnly: true }); await relay.setEnabled(true);
  return { pane, bodies, spoken, state: () => relay.getState(), async run(script, origin = 'text') { steps.push(...script); const result = await relay.send({ text: mode === 'passive' ? 'Read Atlas and tell me the review result.' : 'Check Atlas usage and remaining limits directly in its terminal.', origin }); if (scriptError) throw scriptError; assert.equal(steps.length, 0, JSON.stringify(result)); assert.match(JSON.stringify(interpretation), /terminal-inspection/); return result; } };
}
for (const kind of Object.keys(providerScenarios)) test(`${kind}: native usage inspection returns facts without starting a task`, async t => {
  const f = await fixture(t, kind);
  const result = await f.run([read(), body => {
    assert.ok(latest(body).terminalNavigationGuide.includes(f.pane.command), 'The actual read result must teach the provider command before input');
    return operate(body, 'terminal_interact', { text: f.pane.command, submit: true });
  }, read(), body => {
    assert.ok(JSON.stringify(latest(body)).includes(f.pane.facts), 'Facts must be exposed by the post-command read');
    return operate(body, 'finish_terminal', { text: f.pane.facts, outcome: 'completed' });
  }]);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.text, f.pane.facts); assert.notEqual(result.text, 'done');
  assert.equal(f.pane.actions.length, 1); assert.equal(f.pane.reads.length, 2); assert.equal(f.pane.session.turnState, 'idle');
  assert.match(JSON.stringify(f.bodies[0]), /terminalNavigationGuide/);
  assert.equal(f.pane.observedUsage, true);
  const task = f.state().tasks.find(task => task.requestId === result.requestId);
  assert.equal(task.status, 'finished', 'Information navigation must not wait for coding task completion');
  assert.equal(task.waitingReason, undefined);
  if (f.pane.quotaUnavailable) assert.match(result.text, /quota.*(?:unavailable|not|reset)|(?:not|unavailable).*quota/i);
});

test('help discovery navigates only observed informational menu and reports missing quota', async t => {
  // Deliberately synthetic help entry: tests fresh-screen navigation, not a claim
  // that Cursor ships this exact menu or any undocumented quota command.
  const f = await fixture(t, 'cursor', 'discovery');
  const result = await f.run([read(), body => operate(body, 'terminal_interact', { text: '/help', submit: true }), read(), body => {
    assert.match(JSON.stringify(latest(body)), /Press Enter to inspect/);
    return operate(body, 'terminal_interact', { keys: ['enter'] });
  }, read(), body => operate(body, 'finish_terminal', { text: f.pane.facts, outcome: 'completed' })]);
  assert.equal(result.ok, true); assert.equal(result.text, f.pane.facts); assert.equal(f.pane.reads.length, 3);
  assert.deepEqual(f.pane.actions.map(action => action.text || action.keys), ['/help', ['enter']]);
  assert.doesNotMatch(result.text, /\d+%|subscription page/);
});
test('native tabs and escape each require fresh observation before factual completion', async t => {
  const f = await fixture(t, 'claude', 'menu');
  const result = await f.run([read(), body => operate(body, 'terminal_interact', { text: '/usage', submit: true }), read(), body => operate(body, 'terminal_interact', { keys: ['right'] }), read(), body => operate(body, 'terminal_interact', { keys: ['escape'] }), read(), body => operate(body, 'finish_terminal', { text: f.pane.facts, outcome: 'completed' })]);
  assert.equal(result.ok, true); assert.equal(result.text, f.pane.facts); assert.equal(f.pane.reads.length, 4);
});

test('Grok usage limit tab is inspected from its visible consumer menu', async t => {
  const f = await fixture(t, 'grok', 'credits-menu');
  const result = await f.run([read(), body => operate(body, 'terminal_interact', { text: '/usage', submit: true }), read(), body => {
    assert.match(JSON.stringify(latest(body)), /Context usage.*Usage limit.*Session info/);
    return operate(body, 'terminal_interact', { keys: ['tab'] });
  }, read(), body => operate(body, 'terminal_interact', { keys: ['escape'] }), read(), body => operate(body, 'finish_terminal', { text: f.pane.facts, outcome: 'completed' })]);
  assert.equal(result.ok, true); assert.equal(result.text, f.pane.facts); assert.equal(f.pane.reads.length, 4);
  assert.equal(f.pane.observedUsage, true);
});
test('unavailable local quota is reported truthfully without invented subscription advice', async t => {
  const f = await fixture(t, 'claude', 'missing'); const facts = 'Usage information is unavailable for this terminal authentication method; remaining quota and reset time could not be verified.';
  const result = await f.run([read(), body => operate(body, 'terminal_interact', { text: '/usage', submit: true }), read(), body => operate(body, 'finish_terminal', { text: facts, outcome: 'completed' })]);
  assert.equal(result.ok, true); assert.equal(result.text, `Observed terminal output:\n${f.pane.screen()}`); assert.doesNotMatch(result.text, /subscription page|\d+%/);
});
test('existing task output remains a passive read with zero terminal effects', async t => {
  const f = await fixture(t, 'codex', 'passive'); const facts = 'Review completed: 2 defects found in parser.js. No changes made.';
  const result = await f.run([read(), reply(facts)]);
  assert.equal(result.ok, true); assert.equal(result.text, facts); assert.equal(f.pane.actions.length, 0);
});
test('inspection rejects stale revisions and task submission before allowing fresh native input', async t => {
  const f = await fixture(t, 'codex');
  const result = await f.run([read(), body => operate(body, 'terminal_interact', { text: '/status', submit: true, inputRevision: 999 }),
    body => { assert.equal(latest(body).ok, false); assert.equal(f.pane.actions.length, 0); return read(); },
    body => operate(body, 'send_prompt', { text: 'Check my usage' }),
    body => { assert.equal(latest(body).ok, false); assert.equal(f.pane.actions.length, 0); return read(); },
    body => operate(body, 'terminal_interact', { text: '/status', submit: true }), read(), body => operate(body, 'finish_terminal', { text: f.pane.facts, outcome: 'completed' })]);
  assert.equal(result.ok, true); assert.equal(f.pane.actions.length, 1); assert.ok(result.text.includes(f.pane.facts));
});
test('inspection cannot finish using its consumed pre-navigation observation', async t => {
  const f = await fixture(t, 'codex'); let oldToken, grantId;
  const result = await f.run([read(), body => {
    oldToken = latest(body).observationToken; grantId = meta(body).authorizedCommands.grants[0].id;
    return operate(body, 'terminal_interact', { text: '/status', submit: true });
  }, () => call({ kind: 'finish_terminal', targetId: 'Atlas', grantId, stepId: 'premature-finish', observationToken: oldToken, text: 'done', outcome: 'completed' }),
  body => { assert.equal(latest(body).ok, false); return read(); }, body => operate(body, 'finish_terminal', { text: f.pane.facts, outcome: 'completed' })]);
  assert.equal(result.ok, true); assert.equal(result.text, f.pane.facts); assert.equal(f.pane.reads.length, 2);
});

test('voice inspection speaks factual usage without a done completion cue', async t => {
  const f = await fixture(t, 'codex');
  const result = await f.run([read(), body => operate(body, 'terminal_interact', { text: '/status', submit: true }), read(), body => operate(body, 'finish_terminal', { text: f.pane.facts, outcome: 'completed' })], 'voice');
  await new Promise(setImmediate);
  assert.equal(result.text, f.pane.facts);
  assert.ok(f.spoken.some(event => (event.speechText || event.text || '').includes('72')));
  assert.equal(f.spoken.some(event => event.completionCue || event.speechText === 'done'), false);
});
