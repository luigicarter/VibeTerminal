'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReplyContext } = require('../../backend/orchestratorReplyContext.cjs');
const { normalizeIntent } = require('../../backend/orchestratorIntent.cjs');

function fixture() {
  const grant = { kind: 'operate_terminal', targets: [{ id: 'pane', generation: 'g1' }], args: {}, text: 'Review changes; do not edit.', promptMode: 'compose', answerMode: 'delegated', permissionMode: 'none', lifecycleMode: 'preserve' };
  const pending = { requestId: 'original', instruction: 'Review changes in Work; do not edit.', grants: [grant] };
  const previous = { input: { text: pending.instruction }, task: { requestId: 'original', sequence: 1, status: 'failed' }, context: { pendingCommand: pending } };
  const context = { requestId: 'correction', instruction: "You didn't put in that prompt.", sessions: [{ id: 'pane', generation: 'g1', kind: 'codex', status: 'running' }], pendingCommands: [pending] };
  return { pending, previous, context, reference: { input: {}, currentSequence: 2, previous, jobs: [previous], messages: [{ role: 'user', requestId: 'original', text: pending.instruction }], sessions: context.sessions } };
}

test('failed pending operator remains referenceable and correction preserves its bound objective', () => {
  const f = fixture();
  const reference = buildReplyContext(f.reference);
  assert.equal(reference.requestId, 'original');
  assert.equal(reference.instruction, f.pending.instruction);
  assert.equal(Object.hasOwn(reference, 'grants'), false);
  const plan = normalizeIntent({ goal: 'Complete the original delivery.', continuationOf: 'original', actions: [{ kind: 'operate_terminal', sourceUserId: 'original', targetIds: ['pane'] }] }, { ...f.context, replyContext: reference });
  assert.equal(plan.grants[0].sourceUserId, 'original');
  assert.equal(plan.grants[0].text, 'Review changes; do not edit.');
  assert.deepEqual(plan.grants[0].targets.map(({ id, generation }) => ({ id, generation })), [{ id: 'pane', generation: 'g1' }]);
});

test('failed consumed, cancelled, paused and restored work cannot regain continuation authority', () => {
  for (const status of ['cancelled', 'paused']) {
    const f = fixture(); f.previous.task.status = status;
    assert.equal(buildReplyContext(f.reference), undefined);
  }
  const f = fixture(); delete f.previous.context.pendingCommand;
  assert.equal(buildReplyContext(f.reference), undefined);
  assert.throws(() => normalizeIntent({ goal: 'Retry', continuationOf: 'original', actions: [{ kind: 'operate_terminal', sourceUserId: 'original', targetIds: ['pane'] }] }, { ...f.context, pendingCommands: [] }), /unavailable/);
  const restored = fixture(); restored.previous.restored = true;
  assert.equal(buildReplyContext(restored.reference), undefined);
});

test('correction cannot replace inherited constraints with an assistant-authored payload', () => {
  const f = fixture();
  assert.throws(() => normalizeIntent({ goal: 'Continue', continuationOf: 'original', actions: [{ kind: 'operate_terminal', sourceUserId: 'original', targetIds: ['pane'], text: 'Delete files instead.' }] }, f.context), /match one unfinished/);
});

test('spoken correction resumes a blocked objective with the original owner and only one delivery', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createOrchestrator } = require('../../backend/orchestrator.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-correction-'));
  const effects = [], contexts = []; let original, phase = 0, step = 0;
  const tool = (name, args) => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: `call-${++step}`, function: { name, arguments: JSON.stringify(args) } }] } }] });
  const app = createOrchestrator({ userDataPath: root, secureStorage: { isEncryptionAvailable: () => false },
    getSessions: () => [{ id: 'pane', generation: 'g1', name: 'Work', kind: 'codex', provider: 'codex', status: 'running', cwd: root }],
    getRoots: () => ({ documents: root, projects: [] }),
    readSession: async () => ({ ok: true, id: 'pane', generation: 'g1', text: 'Ready for input', sequence: 10, observationSequence: 10, inputRevision: 2 }),
    dispatchAction: async action => { effects.push(action); return { ok: true, status: 'written' }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'scripted', supported_parameters: ['tools', 'tool_choice'], context_length: 128000 }] }));
      const body = JSON.parse(options.body), meta = JSON.parse(body.messages.find(message => message.role === 'user').content);
      if (body.tools[0].function.name === 'interpret_workspace') {
        contexts.push(meta);
        return new Response(JSON.stringify(tool('interpret_workspace', original
          ? { goal: 'Complete the original delivery.', continuationOf: original, actions: [{ kind: 'operate_terminal', sourceUserId: original, targetIds: ['pane'] }] }
          : { goal: 'Review changes without editing.', actions: [{ kind: 'operate_terminal', targetIds: ['pane'], text: 'Review changes; do not edit.' }] })));
      }
      const grant = meta.authorizedCommands.grants[0];
      const observed = () => JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);
      const action = (kind, extra) => tool('workspace', { kind, grantId: grant.id, targetId: 'pane', observationToken: observed().observationToken, stepId: `step-${step}`, ...extra });
      let response;
      switch (phase++) {
        case 0: case 3: case 5: response = tool('workspace', { kind: 'read_session', targetId: 'pane' }); break;
        case 1: response = action('finish_terminal', { outcome: 'blocked', text: 'Delivery has not been attempted.' }); break;
        case 2: response = { choices: [{ message: { content: 'Delivery has not been attempted.' }, finish_reason: 'stop' }] }; break;
        case 4:
          assert.equal(grant.sourceUserId, original);
          assert.equal(grant.text, 'Review changes; do not edit.');
          response = action('send_prompt', { text: grant.text }); break;
        case 6: response = action('finish_terminal', { outcome: 'completed', text: 'Input written; result pending.' }); break;
        default: throw new Error(`Unexpected model phase ${phase}`);
      }
      return new Response(JSON.stringify(response));
    } });
  t.after(async () => { await app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await app.configure({ apiKey: 'test-key', model: 'scripted', sessionOnly: true }); await app.setEnabled(true);
  const first = await app.send({ text: 'Review changes in Work; do not edit.', origin: 'text' });
  original = first.requestId;
  assert.equal(effects.length, 0);
  const corrected = await app.send({ text: "You didn't put in that prompt.", origin: 'voice' });
  assert.equal(corrected.ok, true, JSON.stringify(corrected));
  assert.equal(contexts.at(-1).replyContext.requestId, original);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].requestId, original);
  assert.equal(effects[0].text, 'Review changes; do not edit.');
});
