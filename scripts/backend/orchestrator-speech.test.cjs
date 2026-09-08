'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSpeech, prepareSpeech, SPEECH_FALLBACK } = require('../../backend/orchestratorSpeech.cjs');
const long = 'Implementation details and commands. '.repeat(70) + 'Tests failed; deployment is blocked.';
test('missing speech uses outcome summary; explicit speech, app reports and questions skip generation', async () => {
  let calls = 0;
  const summarize = async messages => { calls++; assert.equal(JSON.parse(messages[1].content).response, long); return 'The agent reports changes, but tests failed and deployment is blocked.'; };
  assert.equal(await prepareSpeech({ text: long, summarize }), 'The agent reports changes, but tests failed and deployment is blocked.');
  assert.equal(calls, 1);
  assert.equal(await prepareSpeech({ text: 'Ready.', speechText: 'Ready.', summarize }), 'Ready.');
  assert.equal(await prepareSpeech({ text: 'Ready.', generatedDirect: true, summarize }), 'Ready.');
  assert.equal(await prepareSpeech({ text: long, responseTurn: 'listen', summarize }), long);
  assert.equal(await prepareSpeech({ text: long, responseTurn: 'dismiss', summarize }), long);
  assert.equal(await prepareSpeech({ text: long, question: { id: 'permission' }, summarize }), long);
  assert.equal(calls, 1);
});
test('model chooses summary length without word, sentence, or character rejection', async () => {
  for (const summary of [long.repeat(3), 'x'.repeat(601), 'One. Two. Three.', 'word '.repeat(61)]) {
    assert.equal(await prepareSpeech({ text: 'Original details.', speechText: summary, summarize: async () => assert.fail('no redundant generation') }), summary.trim());
    assert.equal(await prepareSpeech({ text: 'Original details.', summarize: async () => summary }), summary.trim());
  }
});
test('malformed and failed summaries never fall back to source excerpts', async () => {
  for (const result of ['', ' ', undefined, { text: 'bad' }]) {
    assert.equal(await prepareSpeech({ text: long, summarize: async () => result }), SPEECH_FALLBACK);
  }
  assert.equal(await prepareSpeech({ text: long, summarize: async () => { throw new Error('offline'); } }), SPEECH_FALLBACK);
  assert.equal(normalizeSpeech(null), undefined);
});
test('cancellation during generation suppresses summary and fallback', async () => {
  const controller = new AbortController();
  await assert.rejects(prepareSpeech({ text: long, signal: controller.signal, summarize: async () => { controller.abort(); return 'Done.'; } }), { name: 'AbortError' });
  await assert.rejects(prepareSpeech({ text: 'Ready.', signal: controller.signal, summarize: async () => assert.fail('must not generate') }), { name: 'AbortError' });
});
