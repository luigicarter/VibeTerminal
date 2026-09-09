'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const call = (name, args) => new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'fixture', function: { name, arguments: JSON.stringify(args) } }] } }] }));

for (const explicit of [false, true]) for (const composed of [false, true]) test(`submitted correction survives literal then consumed-source rejection (${explicit ? 'explicit voice' : 'implicit text'}, ${composed ? 'composed' : 'literal'})`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-correction-submitted-'));
  const session = { id: 'pane', generation: 'g1', name: 'Codex', kind: 'codex', provider: 'codex', cwd: root, status: 'running',
    started: true, processState: 'running', agentProcessState: 'running', agentPid: 4321, observation: 'observed', turnState: 'idle' };
  const effects = [], interpretations = [], executions = [];
  let mode = 'submit', executionRound = 0, correctionAttempt = 0, sentId;
  const app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false }, now: () => 1000,
    getSessions: () => [session], getRoots: () => ({ documents: root, projects: [root] }),
    readSession: async () => ({ ok: true, id: 'pane', generation: 'g1', text: 'Fix bubble labels. [draft still visible]', sequence: 10, inputRevision: 2 }),
    dispatchAction: async action => { effects.push(action); return { ok: true, status: 'written' }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] }));
      const body = JSON.parse(options.body), context = JSON.parse(body.messages.find(message => message.role === 'user').content);
      // These transport fixtures script user-selected targets; semantic veto cases have a separate suite.
      if (body.messages[0].content === require('../../backend/orchestratorTargetReview.cjs').TARGET_REVIEW_SYSTEM) return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decision: 'DIRECT', evidenceIds: JSON.parse(body.messages[1].content).selectionEvidence.map(item => item.id) }) } }] }));
      if (body.tools[0].function.name === 'interpret_workspace') {
        interpretations.push({ mode, context, system: body.messages[0].content });
        if (mode === 'submit') return call('interpret_workspace', { goal: 'Send the requested task.', actions: [{ kind: 'operate_terminal', targetIds: ['pane'], text: composed ? 'Investigate the bubble issue carefully.' : 'Fix bubble labels.', promptMode: composed ? 'compose' : 'literal' }] });
        if (mode === 'correction') {
          correctionAttempt++;
          assert.equal(context.replyContext.submittedTask.requestId, sentId);
          assert.equal(context.replyContext.submittedTask.deliveryEvidence[0].deliveryStatus, 'written');
          return call('interpret_workspace', { goal: 'Paste that prompt.', actions: [{ kind: 'operate_terminal', targetIds: ['pane'], text: 'Fix bubble labels.', promptMode: 'literal', sourceUserId: correctionAttempt === 1 ? context.requestId : sentId }] });
        }
        if (mode === 'followup') return call('interpret_workspace', { goal: 'Check that original prompt.', actions: [], responseKind: 'task-status', statusTargetIds: ['pane'] });
        return call('interpret_workspace', { goal: 'Respond to greeting.', actions: [] });
      }
      executions.push({ mode, context });
      if (mode !== 'submit') return call('workspace', { kind: 'respond', text: mode === 'unrelated' ? 'Hello.' : 'Accepted and working.', responseTurn: 'complete' });
      executionRound++;
      if (executionRound === 1 || executionRound === 3) return call('workspace', { kind: 'read_session', targetId: 'pane' });
      const grant = context.authorizedCommands.grants[0];
      const observed = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
      return call('workspace', { kind: executionRound === 2 ? 'send_prompt' : 'finish_terminal', grantId: grant.id, targetId: 'pane', stepId: `step-${executionRound}`, observationToken: observed.observationToken,
        ...(executionRound === 2 ? { text: 'Fix bubble labels.' } : { outcome: 'completed', text: 'Accepted and working.' }) });
    },
  });
  t.after(async () => { await app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await app.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true }); await app.setEnabled(true);
  const sent = await app.send({ text: composed ? 'Tell Codex to repair the names shown on the bubbles.' : 'Send exactly "Fix bubble labels." to Codex.', origin: 'text', targetId: 'pane' });
  assert.equal(sent.ok, true, JSON.stringify(sent)); sentId = sent.requestId;
  mode = 'correction';
  const corrected = await app.send({ text: "You didn't paste that prompt.", origin: explicit ? 'voice' : 'text', ...(explicit && { replyToRequestId: sentId }) });
  assert.equal(corrected.ok, true, JSON.stringify(corrected)); assert.equal(correctionAttempt, 2);
  assert.match(interpretations.at(-1).system, /Validation failure:.*literal text supplied/);
  assert.match(corrected.text, /haven't confirmed that the task started/);
  assert.doesNotMatch(corrected.text, /Accepted|working|could not interpret/i);
  assert.equal(executions.at(-1).context.authorizedCommands.statusRequestId, sentId);
  assert.deepEqual(executions.at(-1).context.authorizedCommands.grants, []);
  mode = 'followup';
  const followed = await app.send({ text: 'That prompt.', origin: explicit ? 'voice' : 'text', ...(explicit && { replyToRequestId: corrected.requestId }) });
  assert.equal(followed.ok, true, JSON.stringify(followed)); assert.match(followed.text, /haven't confirmed that the task started/);
  assert.equal(executions.at(-1).context.authorizedCommands.statusRequestId, sentId);
  assert.equal(effects.length, 1, 'Corrections must not replay written input');
  mode = 'unrelated';
  const greeting = await app.send({ text: 'Hello', origin: 'text' });
  assert.equal(greeting.text, 'Hello.'); assert.equal(executions.at(-1).context.authorizedCommands.responseKind, undefined);
});
