'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const response = content => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
let callId = 0;
const calls = (...actions) => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: actions.map(action => ({ id: `fast-${++callId}`, type: 'function', function: { name: 'workspace', arguments: JSON.stringify(action) } })) } }] });

async function fixture(t, { lateStatus, explicitListen = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-fast-integration-'));
  const effects = [], executor = [];
  const sessions = [{ id: 'pane', generation: 'g1', name: 'Fixture', kind: 'codex', provider: 'codex', cwd: root, status: 'running' }];
  let app, injected = false;
  const finalText = lateStatus === 'unknown' ? 'Delivery is unconfirmed. I have not sent it again.' : 'Delivery was rejected. The review was not sent.';
  app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => sessions, getRoots: () => ({ documents: root, projects: [root] }),
    interpretIntent: async () => ({ goal: 'Review changes in Fixture.', actions: [{ kind: 'operate_terminal', targetIds: ['pane'], text: 'Review changes.', answerMode: 'delegated', permissionMode: 'none' }] }),
    readSession: async () => ({ ok: true, id: 'pane', generation: 'g1', text: 'Input is ready.', sequence: 10, inputRevision: 2 }),
    dispatchAction: async action => { effects.push(action); return { ok: true, status: lateStatus ? 'queued' : 'written' }; },
    onChange: state => {
      if (lateStatus && !injected && state.receipts.some(receipt => receipt.kind === 'finish_terminal' && receipt.status === 'interaction-complete')) {
        injected = true;
        app.recordDelivery({ actionId: effects[0].actionId, id: 'pane', generation: 'g1', ok: false, status: lateStatus,
          ...(lateStatus === 'rejected' ? { delivery: 'not-dispatched' } : {}), error: `Fixture late ${lateStatus}` });
      }
    },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture', context_length: 128000, supported_parameters: ['tools'] }] }));
      assert(url.endsWith('/chat/completions'), 'No unhandled network requests');
      const body = JSON.parse(options.body); executor.push(body);
      const round = executor.length;
      if (round === 1 || round === 3) return new Response(JSON.stringify(calls({ kind: 'read_session', targetId: 'pane' })));
      if (round === 2 || round === 4) {
        const grant = JSON.parse(body.messages.find(message => message.role === 'user').content).authorizedCommands.grants[0];
        const observed = JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
        assert(observed.observationToken);
        const action = { kind: round === 2 ? 'send_prompt' : 'finish_terminal', grantId: grant.id, targetId: 'pane', stepId: `step-${round}`, observationToken: observed.observationToken,
          ...(round === 2 ? { text: 'Review changes.', observationSequence: observed.observation.sequence, inputRevision: observed.observation.inputRevision } : { outcome: 'completed', text: lateStatus ? 'The review is queued.' : 'The review was submitted.' }) };
        return new Response(JSON.stringify(round === 4 && explicitListen ? calls(action, { kind: 'respond', text: 'Which project should I inspect next?', responseTurn: 'listen' }) : calls(action)));
      }
      assert.equal(round, 5, 'No redundant final calls or retries');
      assert(lateStatus, 'Clean completed work must not call the final model');
      const update = body.messages.find(message => message.role === 'system' && message.content.startsWith('Application delivery receipts changed.'));
      assert(update, 'Final model must receive latest application delivery evidence');
      assert(update.content.includes(`Fixture late ${lateStatus}`));
      assert(update.content.includes(effects[0].actionId));
      return new Response(JSON.stringify(response(finalText)));
    }
  });
  t.after(async () => {
    await app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal((await app.configure({ apiKey: 'fixture-only', model: 'fixture', sessionOnly: true })).ok, true);
  assert.equal((await app.setEnabled(true)).ok, true);
  return { app, executor, effects, finalText, injected: () => injected };
}

for (const lateStatus of ['rejected', 'unknown']) test(`late queued delivery ${lateStatus} prevents finish elision and reaches final executor without replay`, async t => {
  const f = await fixture(t, { lateStatus });
  const result = await f.app.send({ text: 'Use Fixture to review changes.', origin: 'text' });
  assert(f.injected(), 'Late receipt must occur after validated finish and before finalization');
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.text, f.finalText);
  assert.equal(f.executor.length, 5);
  assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt']);
  assert.equal(f.app.getState().receipts.filter(receipt => receipt.status === lateStatus).length, 1);
});

test('clean completed operation preserves observed result without a final model round', async t => {
  const f = await fixture(t);
  const result = await f.app.send({ text: 'Use Fixture to review changes.', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert(result.text.includes('The review was submitted.'));
  assert.equal(f.executor.length, 4);
  assert.deepEqual(f.effects.map(effect => effect.kind), ['send_prompt']);
});

test('same-batch explicit respond listen takes precedence over completed-operation synthesis', async t => {
  const f = await fixture(t, { explicitListen: true });
  const result = await f.app.send({ text: 'Use Fixture to review changes.', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, 'Which project should I inspect next?');
  assert.equal(result.responseTurn, 'listen');
  assert.equal(f.app.getState().tasks.find(task => task.requestId === result.requestId).status, 'needs-answer');
  assert.equal(f.executor.length, 4);
  assert.equal(f.effects.length, 1);
});
