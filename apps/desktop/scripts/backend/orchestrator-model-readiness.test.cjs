'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');
const { createIntentInterpreter, createPlanningInput } = require('../../backend/orchestratorInterpreter.cjs');
const { fitMessages } = require('../../backend/orchestratorBudget.cjs');
const { outputTokensFor } = require('../../backend/orchestratorModelOptions.cjs');

test('readiness and production interpretation share the current planning envelope', async () => {
  const context = { instruction: 'Hi', requestId: 'probe', sessions: [] };
  const { planningTools, messages } = createPlanningInput(context);
  let calls = 0;
  const interpret = createIntentInterpreter({ getTask: () => undefined, redact: value => value, cleanError: error => error.message,
    recordDiagnostic() {}, diagnosticError() {}, complete: async body => {
      calls++;
      assert.deepEqual(body.tools, planningTools);
      assert.deepEqual(body.messages, fitMessages({ messages, tools: planningTools, contextLength: 128000, outputTokens: 4000 }));
      assert(body.tools.some(tool => tool.function.name === 'plan_conversation'));
      assert.equal(body.tools.find(tool => tool.function.name === 'interpret_workspace').function.parameters.properties.actions, undefined);
      return { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'hello', function: { name: 'plan_conversation', arguments: '{"goal":"Say hello."}' } }] } }] };
    } });
  const plan = await interpret(context, { id: 'fixture', contextLength: 128000 }, 4000, new AbortController().signal, {});
  assert.equal(calls, 1); assert.equal(plan.grants.length, 0);
});

for (const [contextLength, expected] of [[16384, false], [24064, true], [128000, true]]) {
  test(`model readiness uses the current minimum planner at ${contextLength} context`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-planner-readiness-'));
    const app = createOrchestrator({ userDataPath: root, fetch: async url => {
      if (url.endsWith('/key')) return new Response(JSON.stringify({ data: {} }));
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture', context_length: contextLength, supported_parameters: ['tools'] }] }));
      assert.fail('Readiness must not spend a model turn.');
    } });
    t.after(async () => { await app.dispose(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
    const { planningTools, messages } = createPlanningInput({ instruction: 'Hi', sessions: [] });
    const fits = () => fitMessages({ messages, tools: planningTools, contextLength, outputTokens: outputTokensFor({ contextLength }, 4000) });
    if (expected) assert.doesNotThrow(fits); else assert.throws(fits, /Local context limit/);
    await app.configure({ apiKey: 'test-only-key', sessionOnly: true, model: 'fixture' });
    const result = await app.setEnabled(true);
    assert.equal(result.ok, expected, JSON.stringify(result));
    assert.equal(app.getState().ready, expected);
  });
}
