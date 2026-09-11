'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { interpretationTool } = require('../../backend/orchestratorInterpretationSchema.cjs');
const { INTENT_TOOL } = require('../../backend/orchestratorIntent.cjs');
test('compact interpretation retains operation field boundaries with one shared definition', () => {
  const compact = interpretationTool({ pendingCommands: [{}] }).function.parameters.properties.actions.items;
  const original = INTENT_TOOL.function.parameters.properties.actions.items.anyOf;
  for (const branch of compact.anyOf) {
    const kind = branch.properties.kind.enum[0], source = original.find(item => item.properties.kind.enum[0] === kind);
    assert.deepEqual(Object.keys(branch.properties), Object.keys(source.properties));
    assert.equal(branch.additionalProperties, false);
    for (const [field, definition] of Object.entries(source.properties)) {
      if (field === 'kind') continue;
      const effective = { ...compact.properties[field], ...branch.properties[field] };
      if (definition.enum && effective.maxLength && definition.maxLength === undefined) {
        assert.ok(definition.enum.every(value => typeof value === 'string' && value.length <= effective.maxLength));
        delete effective.maxLength;
      }
      if (definition.enum && effective.minLength && definition.minLength === undefined) {
        assert.ok(definition.enum.every(value => typeof value === 'string' && value.length >= effective.minLength));
        delete effective.minLength;
      }
      assert.deepEqual(effective, definition);
    }
  }
  assert.ok(JSON.stringify(interpretationTool({})).length < JSON.stringify(INTENT_TOOL).length * 0.75);
});

test('misplaced access is relocated without dropping constraints or unknown fields', () => {
  const { canonicalizeInterpretation } = require('../../backend/orchestratorInterpretationSchema.cjs');
  const raw = { goal: 'Inspect', actions: [{ kind: 'operate_terminal', text: 'Read only.', access: 'read-only', unknown: true }] };
  const saved = structuredClone(raw), result = canonicalizeInterpretation(raw);
  assert.equal(result.access, 'read-only'); assert.equal(result.actions[0].unknown, true);
  assert.equal(result.actions[0].text, raw.actions[0].text); assert.equal(result.actions[0].access, undefined);
  assert.deepEqual(raw, saved);
  assert.throws(() => canonicalizeInterpretation({ ...raw, access: 'mutation' }), /Conflicting/);
  assert.throws(() => canonicalizeInterpretation({ ...raw, actions: [...raw.actions, { kind: 'delegate_task', access: 'mutation' }] }), /Conflicting/);
});
test('fresh tasks require their payload and cannot discover fake continuation or legacy input fields', () => {
  const tool = interpretationTool({}), schema = tool.function.parameters, items = schema.properties.actions.items;
  assert.equal(schema.properties.continuationOf, undefined);
  assert.equal(items.properties.sourceUserId, undefined);
  assert.equal(items.properties.kind.enum.includes('send_prompt'), false);
  assert.deepEqual(items.anyOf.find(branch => branch.properties.kind.enum[0] === 'delegate_task').required, ['kind', 'cwd', 'text']);
  assert.ok(INTENT_TOOL.function.parameters.properties.continuationOf, 'Shared protocol is never mutated');
});
