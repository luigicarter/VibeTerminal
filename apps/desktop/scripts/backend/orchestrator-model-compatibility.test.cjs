'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../../backend/orchestrator.cjs');

const answer = text => ({ choices: [{ finish_reason: 'stop', message: { content: text } }] });
const intent = plan => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [
  { id: 'interpret-1', type: 'function', function: { name: 'interpret_workspace', arguments: JSON.stringify(plan) } },
] } }] });
const noEffects = () => intent({ goal: 'Answer without effects.', actions: [] });
const json = data => new Response(JSON.stringify(data));

async function fixture(t, metadata = {}, extraModels = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-model-compatibility-'));
  const model = { id: 'compat-brain', context_length: 128000, supported_parameters: ['tools', 'tool_choice', 'temperature'], ...metadata };
  const calls = [], effects = [], responses = [];
  const instance = createOrchestrator({ userDataPath: root,
    getRoots: () => ({ documents: root, projects: [{ name: 'Fixture', path: root }] }),
    getSessions: () => [{ id: 'a', name: 'Codex fixture', kind: 'codex', generation: 1, cwd: root, status: 'idle' }],
    dispatchAction: async action => { effects.push(action); return { ok: true, status: 'focused' }; },
    fetch: async (url, options) => {
      if (url.endsWith('/key')) return json({ data: {} });
      if (url.endsWith('/models')) return json({ data: [model, ...extraModels] });
      assert.ok(url.endsWith('/chat/completions'));
      const body = JSON.parse(options.body); calls.push(body);
      assert.ok(responses.length, 'Unexpected completion request');
      const next = responses.shift();
      return typeof next === 'function' ? next(body) : json(next);
    },
  });
  t.after(async () => {
    await instance.dispose();
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.join(os.tmpdir(), 'vibe-model-compatibility-')));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  assert.equal((await instance.configure({ apiKey: 'fixture-private-key', sessionOnly: true, model: model.id })).ok, true);
  return { instance, calls, effects, responses,
    enable: async () => assert.equal((await instance.setEnabled(true)).ok, true),
    logs: async () => {
      await instance.flushDiagnostics();
      const filename = path.join(root, 'logs', 'orchestrator-errors.jsonl');
      return fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').trim().split('\n').map(JSON.parse) : [];
    },
  };
}

test('production interpreter honors catalog reasoning effort, output maximum and temperature capability', async t => {
  const config = { mandatory: true, default_enabled: true, supported_efforts: ['high', 'medium'], default_effort: 'high' };
  const f = await fixture(t, { supported_parameters: ['tools', 'tool_choice', 'reasoning'], reasoning: config, top_provider: { max_completion_tokens: 512 } });
  const [model] = await f.instance.models();
  assert.deepEqual(model.reasoningConfig, config);
  assert.equal(model.maxCompletionTokens, 512);
  await f.enable(); f.responses.push(noEffects(), answer('Hello.'));
  const result = await f.instance.send({ text: 'Hello', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.calls.length, 2);
  for (const body of f.calls) {
    assert.equal(body.max_tokens, 512);
    assert.deepEqual(body.reasoning, { effort: 'medium' });
    assert.equal(Object.hasOwn(body, 'temperature'), false);
  }
  assert.equal(f.calls[0].tool_choice, 'auto');
  assert.equal(f.effects.length, 0);
});

// The minimum planner call is now about 11,500 bytes, so the smallest usable
// window moved down with it: a 16,384 model is accepted where it once was not.
for (const contextLength of [8192, 12288]) test(`known ${contextLength} context rejects readiness locally without paid completion`, async t => {
  const f = await fixture(t, { context_length: contextLength });
  for (const result of [await f.instance.testConnection(), await f.instance.setEnabled(true)]) {
    assert.equal(result.ok, false);
    assert.match(result.error, /Local context limit/);
    assert.equal(result.upstreamError, undefined);
  }
  assert.equal(f.instance.getState().ready, false);
  assert.equal(f.calls.length, 0);
  assert.ok((await f.logs()).some(entry => entry.error?.code === 'LOCAL_CONTEXT_LIMIT'));
});

for (const contextLength of [32768, 65536]) test(`${contextLength} context passes compact planning readiness and omits unadvertised tool choice`, async t => {
  const f = await fixture(t, { context_length: contextLength, supported_parameters: ['tools', 'temperature'] });
  assert.equal((await f.instance.testConnection()).ready, true);
  assert.equal(f.calls.length, 0);
  await f.enable(); f.responses.push(noEffects(), answer('Ready.'));
  const result = await f.instance.send({ text: 'Hello', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(Object.hasOwn(f.calls[0], 'tool_choice'), false);
  assert.equal(f.calls[0].temperature, 0);
});

test('execution exhaustion at the advertised maximum never repeats the same output cap', async t => {
  const f = await fixture(t, { supported_parameters: ['tools', 'tool_choice', 'reasoning'], top_provider: { max_completion_tokens: 512 } });
  await f.enable();
  f.responses.push(noEffects(), { choices: [{ finish_reason: 'length', message: { content: '', reasoning: 'PRIVATE_REASONING' } }] });
  const result = await f.instance.send({ text: 'Hello', origin: 'text' });
  assert.equal(result.ok, false);
  assert.match(result.error, /ran out of reply budget/);
  assert.equal(f.calls.length, 2, 'One interpretation and one executor call, without a same-cap retry');
  assert.ok(f.calls.every(body => body.max_tokens === 512));
  assert.equal(f.effects.length, 0);
});

test('auto tool choice preserves one valid effect and rejects plain or malformed interpretation', async t => {
  const f = await fixture(t); await f.enable();
  f.responses.push(intent({ goal: 'Focus terminal a.', executionMode: 'direct', actions: [{ kind: 'focus_session', targetIds: ['a'] }] }));
  const result = await f.instance.send({ text: 'Focus terminal a', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.effects.length, 1);
  assert.equal(f.effects[0].kind, 'focus_session');
  assert.equal(f.calls[0].tool_choice, 'auto');
  for (const invalid of [answer('I focused it.'), intent({ goal: 'Invent an operation.', actions: [{ kind: 'invented' }] })]) {
    f.responses.push(invalid, invalid);
    const rejected = await f.instance.send({ text: 'Focus terminal a', origin: 'text' });
    assert.equal(rejected.ok, false);
    assert.equal(f.effects.length, 1, 'Invalid interpretation cannot add an effect');
  }
});

test('incomplete interpretation finish reasons cannot authorize complete-looking tool arguments', async t => {
  const f = await fixture(t); await f.enable();
  for (const finishReason of ['content_filter', 'error', 'cancelled', 'future-incomplete']) {
    const response = intent({ goal: 'Focus terminal a.', executionMode: 'direct', actions: [{ kind: 'focus_session', targetIds: ['a'] }] });
    response.choices[0].finish_reason = finishReason;
    f.responses.push(response, response);
    const result = await f.instance.send({ text: 'Focus terminal a', origin: 'text' });
    assert.equal(result.ok, false, finishReason);
    assert.equal(f.effects.length, 0, `${finishReason} must not authorize input`);
  }
});

test('model timing correlates headers and full body while excluding unknown provider content', async t => {
  const f = await fixture(t); await f.enable();
  f.responses.push({ ...noEffects(), provider: 'Fixture provider', id: 'gen-fixture',
    usage: { prompt_tokens: 12, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 2 } },
    unrecognized_private_field: 'PRIVATE_PROVIDER_CONTENT',
  }, answer('PRIVATE_ANSWER_CONTENT'));
  assert.equal((await f.instance.send({ text: 'PRIVATE_USER_CONTENT', origin: 'text' })).ok, true);
  const entries = await f.logs();
  const started = entries.filter(entry => entry.stage === 'model_started');
  assert.equal(started.length, 2);
  for (const event of started) {
    const headers = entries.find(entry => entry.stage === 'model_headers' && entry.modelCallId === event.modelCallId);
    const complete = entries.find(entry => entry.stage === 'model_complete' && entry.modelCallId === event.modelCallId);
    assert.ok(headers); assert.ok(complete);
    assert.equal(headers.httpStatus, 200);
    assert.equal(complete.status, 'complete');
    assert.equal(complete.headersMs, headers.headersMs);
    assert.ok(complete.bodyMs >= 0);
    // Each stage records the deadline of its own category, not a single global one.
    assert.equal(complete.deadlineMs, complete.category === 'interpretation' ? 25000 : 45000);
  }
  const compiler = entries.find(entry => entry.stage === 'model_complete' && entry.category === 'interpretation');
  assert.equal(compiler.provider, 'Fixture provider');
  assert.equal(compiler.generationId, 'gen-fixture');
  assert.equal(compiler.reasoningTokens, 2);
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_|fixture-private-key/);
});

test('body failure reports its phase without persisting the provider error body', async t => {
  const f = await fixture(t); await f.enable();
  f.responses.push(() => new Response('PRIVATE_PROVIDER_FAILURE', { status: 503 }));
  const result = await f.instance.send({ text: 'Hello', origin: 'text' });
  assert.equal(result.ok, false);
  const entries = await f.logs();
  const complete = entries.find(entry => entry.stage === 'model_complete');
  assert.equal(complete.requestPhase, 'body');
  assert.equal(complete.httpStatus, 503);
  assert.ok(complete.bodyMs >= 0);
  assert.ok(entries.some(entry => entry.stage === 'model_headers' && entry.modelCallId === complete.modelCallId));
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_PROVIDER_FAILURE/);
});

// The optional second brain. It is held to the same tool-capable catalog
// requirement as the primary when settings are saved, and it is used once, for
// the one failure class the primary cannot recover from on its own.
const standby = { id: 'standby-brain', context_length: 128000, supported_parameters: ['tools', 'tool_choice', 'temperature'] };
const clientDeadline = () => { const error = new Error('The operation was aborted due to timeout'); error.name = 'TimeoutError'; throw error; };

test('a fallback brain the catalog does not offer fails the connection test like a missing brain', async t => {
  const f = await fixture(t, {}, [standby]);
  assert.equal((await f.instance.configure({ fallbackModel: 'standby-brain' })).ok, true);
  assert.equal((await f.instance.testConnection()).ready, true);
  assert.equal((await f.instance.configure({ fallbackModel: 'not-in-catalog' })).ok, true);
  for (const result of [await f.instance.testConnection(), await f.instance.setEnabled(true)]) {
    assert.equal(result.ok, false);
    assert.match(result.error, /fallback Brain model is unavailable or does not support tools/);
  }
  assert.equal(f.calls.length, 0);
});

test('a brain that misses its deadline hands the same work to the configured fallback once', async t => {
  const f = await fixture(t, {}, [standby]);
  assert.equal((await f.instance.configure({ fallbackModel: 'standby-brain' })).ok, true);
  await f.enable();
  f.responses.push(clientDeadline, noEffects(), answer('Ready.'));
  const result = await f.instance.send({ text: 'Hello', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  // Interpretation moves to the fallback; the next model call starts over on the primary.
  assert.deepEqual(f.calls.map(body => body.model), ['compat-brain', 'standby-brain', 'compat-brain']);
  assert.equal(f.effects.length, 0);
  const entries = await f.logs();
  const started = entries.filter(entry => entry.stage === 'model_started');
  assert.deepEqual(started.map(entry => entry.deadlineMs), [25000, 25000, 45000]);
  const fallback = started.filter(entry => entry.modelFallback === true);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].model, 'standby-brain');
  assert.equal(fallback[0].fallbackFrom, 'compat-brain');
  assert.ok(entries.some(entry => entry.stage === 'model_complete' && entry.modelFallback === true && entry.status === 'complete'));
});

// The optional faster interpreter. It runs the one call every request makes and
// nothing else: prose, results and every review stay on the configured brain.
const quick = { id: 'quick-interpreter', context_length: 128000, supported_parameters: ['tools', 'tool_choice', 'temperature'] };

test('an interpretation model the catalog does not offer fails the connection test like a missing brain', async t => {
  const f = await fixture(t, {}, [quick]);
  assert.equal((await f.instance.configure({ interpretationModel: 'quick-interpreter' })).ok, true);
  assert.equal((await f.instance.testConnection()).ready, true);
  assert.equal((await f.instance.configure({ interpretationModel: 'not-in-catalog' })).ok, true);
  for (const result of [await f.instance.testConnection(), await f.instance.setEnabled(true)]) {
    assert.equal(result.ok, false);
    assert.match(result.error, /interpretation model is unavailable or does not support tools/);
  }
  assert.equal(f.calls.length, 0);
});

test('the configured interpretation model runs only the interpretation call', async t => {
  const f = await fixture(t, {}, [quick]);
  assert.equal((await f.instance.configure({ interpretationModel: 'quick-interpreter' })).ok, true);
  await f.enable(); f.responses.push(noEffects(), answer('Ready.'));
  const result = await f.instance.send({ text: 'Hello', origin: 'text' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.calls.map(body => body.model), ['quick-interpreter', 'compat-brain']);
  const started = (await f.logs()).filter(entry => entry.stage === 'model_started');
  assert.deepEqual(started.map(entry => [entry.category, entry.model]), [['interpretation', 'quick-interpreter'], ['execution', 'compat-brain']]);
});

test('no interpretation model leaves every call on the brain', async t => {
  const f = await fixture(t, {}, [quick]);
  await f.enable(); f.responses.push(noEffects(), answer('Ready.'));
  assert.equal((await f.instance.send({ text: 'Hello', origin: 'text' })).ok, true);
  assert.deepEqual(f.calls.map(body => body.model), ['compat-brain', 'compat-brain']);
});

test('an interpretation model equal to the brain is not treated as a second model', async t => {
  const f = await fixture(t, {}, [quick]);
  assert.equal((await f.instance.configure({ interpretationModel: 'compat-brain' })).ok, true);
  assert.equal((await f.instance.testConnection()).ready, true);
  await f.enable(); f.responses.push(noEffects(), answer('Ready.'));
  assert.equal((await f.instance.send({ text: 'Hello', origin: 'text' })).ok, true);
  assert.deepEqual(f.calls.map(body => body.model), ['compat-brain', 'compat-brain']);
});

test('an interpretation model that misses its deadline falls back to the configured fallback, else the brain', async t => {
  const f = await fixture(t, {}, [quick, standby]);
  assert.equal((await f.instance.configure({ interpretationModel: 'quick-interpreter' })).ok, true);
  await f.enable(); f.responses.push(clientDeadline, noEffects(), answer('Ready.'));
  assert.equal((await f.instance.send({ text: 'Hello', origin: 'text' })).ok, true);
  // No second brain is configured, so the brain itself absorbs the failure.
  assert.deepEqual(f.calls.map(body => body.model), ['quick-interpreter', 'compat-brain', 'compat-brain']);
  assert.equal((await f.instance.configure({ fallbackModel: 'standby-brain' })).ok, true);
  f.calls.length = 0; f.responses.push(clientDeadline, noEffects(), answer('Ready again.'));
  assert.equal((await f.instance.send({ text: 'Hello again', origin: 'text' })).ok, true);
  assert.deepEqual(f.calls.map(body => body.model), ['quick-interpreter', 'standby-brain', 'compat-brain']);
  const fallback = (await f.logs()).filter(entry => entry.stage === 'model_started' && entry.modelFallback === true);
  assert.deepEqual(fallback.map(entry => [entry.fallbackFrom, entry.model]), [['quick-interpreter', 'compat-brain'], ['quick-interpreter', 'standby-brain']]);
});
