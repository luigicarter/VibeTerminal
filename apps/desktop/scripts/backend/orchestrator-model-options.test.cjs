'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { outputTokensFor, completionOptions } = require('../../backend/orchestratorModelOptions.cjs');

test('output reservation preserves context scaling, minimum and caller ceiling', () => {
  assert.equal(outputTokensFor(undefined, 4000), 1200);
  assert.equal(outputTokensFor({ contextLength: 8192 }, 4000), 1200);
  assert.equal(outputTokensFor({ contextLength: 32768 }, 4000), 2048);
  assert.equal(outputTokensFor({ contextLength: 128000 }, 4000), 4000);
  assert.equal(outputTokensFor({ contextLength: 128000 }, 1200), 1200);
});

test('advertised completion maximum caps even the usual minimum and widened ceiling', () => {
  assert.equal(outputTokensFor({ contextLength: 8192, maxCompletionTokens: 512 }, 4000), 512);
  assert.equal(outputTokensFor({ contextLength: 128000, maxCompletionTokens: 3000 }, 4000), 3000);
  assert.equal(outputTokensFor({ contextLength: 128000, maxCompletionTokens: 6000 }, 8000), 6000);
  assert.equal(outputTokensFor({ contextLength: 128000, maxCompletionTokens: '2048' }, 4000), 2048);
  for (const maximum of [undefined, null, 0, -1, Infinity, NaN, 'invalid']) {
    assert.equal(outputTokensFor({ contextLength: 128000, maxCompletionTokens: maximum }, 4000), 4000);
  }
});

test('temperature is sent only when explicitly supported', () => {
  assert.deepEqual(completionOptions(undefined), {});
  assert.deepEqual(completionOptions({ supportedParameters: ['tools'] }), {});
  assert.deepEqual(completionOptions({ supportedParameters: ['tools', 'temperature'] }), { temperature: 0 });
});

test('reasoning requires capability and preserves low effort without effort metadata', () => {
  assert.deepEqual(completionOptions({ reasoning: false, reasoningConfig: { supported_efforts: ['low'] } }), {});
  assert.deepEqual(completionOptions({ reasoning: true }), { reasoning: { effort: 'low' } });
  assert.deepEqual(completionOptions({ reasoning: true, reasoningConfig: { mandatory: true } }), { reasoning: { effort: 'low' } });
});

test('supported low wins over provider default and none never disables reasoning', () => {
  const model = { reasoning: true, supportedParameters: ['temperature'], reasoningConfig: {
    mandatory: false, default_enabled: false, supported_efforts: ['none', 'max', 'high', 'low'], default_effort: 'max',
  } };
  const before = structuredClone(model);
  assert.deepEqual(completionOptions(model), { temperature: 0, reasoning: { effort: 'low' } });
  assert.deepEqual(model, before);
});

test('unavailable low uses an advertised enabled effort in preference order', () => {
  for (const [supported, expected] of [
    [['max', 'high', 'minimal', 'medium'], 'minimal'],
    [['none', 'high', 'medium'], 'medium'],
    [['max', 'xhigh', 'high'], 'high'],
    [['max', 'xhigh'], 'xhigh'],
    [['max'], 'max'],
  ]) {
    assert.deepEqual(completionOptions({ reasoning: true, reasoningConfig: { supported_efforts: supported } }), { reasoning: { effort: expected } });
  }
  for (const supported of [[], ['none'], ['future-effort']]) {
    assert.deepEqual(completionOptions({ reasoning: true, reasoningConfig: { supported_efforts: supported } }), {});
  }
});
