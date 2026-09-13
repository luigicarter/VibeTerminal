'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { assertTranscriptShape, describeTranscript, executeToolBatch } = require('../../backend/orchestratorExecutionHarness.cjs');
const { createModelRuntime } = require('../../backend/orchestratorModelRuntime.cjs');
const { OpenRouterError } = require('../../backend/openRouterErrors.cjs');

const valid = () => [
  { role: 'system', content: 'rules' },
  { role: 'user', content: 'go' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'workspace', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'call-1', content: '{}' },
  { role: 'assistant', content: 'Sent.' },
];

test('a well-formed transcript with an application-authored turn is accepted', () => {
  const messages = valid();
  assert.equal(assertTranscriptShape(messages), messages);
  assert.throws(() => assertTranscriptShape(undefined), error => assert.match(error.message, /^Lina Terminal bug: model transcript is malformed\./) ?? true);
});

test('an assistant tool call without the function type is refused as an application bug', () => {
  const messages = valid();
  delete messages[2].tool_calls[0].type;
  assert.throws(() => assertTranscriptShape(messages), error => {
    assert.match(error.message, /^Lina Terminal bug: model transcript is malformed\./);
    assert.equal(error instanceof OpenRouterError, false, 'an application bug must never read as a provider or settings failure');
    assert.equal(error.name, 'Error');
    return true;
  });
});

test('a tool result answering no preceding call is refused as an application bug', () => {
  const orphan = [...valid().slice(0, 2), { role: 'tool', tool_call_id: 'call-9', content: '{}' }];
  assert.throws(() => assertTranscriptShape(orphan), error => {
    assert.match(error.message, /^Lina Terminal bug: model transcript is malformed\./);
    assert.match(error.message, /call-9/); return true;
  });
  const nameless = valid();
  delete nameless[2].tool_calls[0].function.name;
  assert.throws(() => assertTranscriptShape(nameless), error => assert.match(error.message, /^Lina Terminal bug: model transcript is malformed\./) ?? true);
  const idless = valid();
  delete idless[2].tool_calls[0].id;
  assert.throws(() => assertTranscriptShape(idless), error => assert.match(error.message, /^Lina Terminal bug: model transcript is malformed\./) ?? true);
});

// The application-authored handoff turns that produced the September 12 400 are
// gone: the delivery runs in application code and reports back as a plain user
// message, so an application note never has to pass a tool-call shape check.
// orchestrator-dispatcher.test.cjs owns that contract end to end.
test('an application delivery report is an ordinary user message, never an assistant turn', () => {
  const report = { role: 'user', content: JSON.stringify({ deliveryReport: [{ grantId: 'g1', targetId: 'pane', status: 'rejected', reason: 'Delivery was refused.' }] }) };
  const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'go' }, report];
  assert.equal(assertTranscriptShape(messages), messages);
  assert.equal(messages.some(message => message.role === 'assistant'), false);
});

test('a provider reply that omits the call type is replayed as valid history', async () => {
  const conversation = [];
  await executeToolBatch({ reply: { tool_calls: [{ id: 'untyped', function: { name: 'workspace', arguments: '{"kind":"list_sessions"}' } }] },
    conversation, execute: async () => ({ ok: true }), onResult() {}, checkActive() {}, canContinue: () => true, formatResult: JSON.stringify });
  assert.deepEqual(conversation[0].tool_calls, [{ id: 'untyped', type: 'function', function: { name: 'workspace', arguments: '{"kind":"list_sessions"}' } }]);
  assertTranscriptShape(conversation);
});

test('a nameless tool call is refused as a model batch failure, never as an application bug', async () => {
  const conversation = [];
  await assert.rejects(() => executeToolBatch({ reply: { tool_calls: [{ id: 'nameless', type: 'function', function: { arguments: '{}' } }] },
    conversation, execute: async () => ({ ok: true }), onResult() {}, checkActive() {}, canContinue: () => true, formatResult: JSON.stringify }),
    /The model returned a tool call without a function name/);
  assert.deepEqual(conversation, []);
});

function runtimeFixture(sequence) {
  const calls = [], events = [];
  const runtime = createModelRuntime({ request: async (_url, options) => { calls.push(JSON.parse(options.body)); const next = sequence.shift(); if (next instanceof Error) throw next; return next; },
    getContext: () => undefined, assertBudget() {}, recordUsage() {}, recordDiagnostic: event => events.push(event) });
  return { runtime, calls, events };
}

test('a malformed transcript never reaches the provider', async () => {
  const f = runtimeFixture([{ choices: [] }]);
  const messages = valid(); delete messages[2].tool_calls[0].type;
  await assert.rejects(() => f.runtime.complete({ model: 'fixture', messages }), error => {
    assert.match(error.message, /^Lina Terminal bug: model transcript is malformed\./);
    assert.equal(error instanceof OpenRouterError, false); return true;
  });
  assert.equal(f.calls.length, 0, 'no request may be spent on a transcript the application malformed');
});

test('a 4xx records the rejected transcript shape without any message content', async () => {
  const rejection = new OpenRouterError('request', 400);
  rejection.providerMessage = 'Tool-call assistant message produced no valid function calls.';
  const f = runtimeFixture([rejection]);
  await assert.rejects(() => f.runtime.complete({ model: 'fixture', messages: valid() }), error => {
    assert.deepEqual(error.transcriptShape, [
      { role: 'system' }, { role: 'user' },
      { role: 'assistant', toolCalls: [{ id: 'call-1', type: 'function', name: 'workspace' }] },
      { role: 'tool', toolCallId: 'call-1' },
      { role: 'assistant' }]);
    assert.equal(JSON.stringify(error.transcriptShape).includes('go'), false);
    return true;
  });
});

test('an identical request body is never sent again after a 4xx rejection', async () => {
  // The repair ladder strips one request option per rejection. A repair that
  // leaves the wire body byte-identical (a value JSON never serialized) would
  // only buy a second identical rejection, so the first one is final.
  const f = runtimeFixture([new OpenRouterError('request', 400), { choices: [] }]);
  await assert.rejects(() => f.runtime.complete({ model: 'fixture', messages: [], response_format: () => {} }), { status: 400 });
  assert.equal(f.calls.length, 1);
  // A transient server failure still repeats its body exactly once, as before.
  const transient = runtimeFixture([new OpenRouterError('upstream', 503), { choices: [] }]);
  assert.ok(await transient.runtime.complete({ model: 'fixture', messages: [] }));
  assert.equal(transient.calls.length, 2);
});

test('describeTranscript keeps identities and drops content', () => {
  assert.deepEqual(describeTranscript([{ role: 'user', content: 'private instruction' }]), [{ role: 'user' }]);
  assert.deepEqual(describeTranscript('not a list'), []);
});
