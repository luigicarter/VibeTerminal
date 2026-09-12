"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createAdapter, toChatRequest, sseData } = require('../../backend/openCodexAdapter.cjs');
const { modelCatalog, createRuntimeManager, resolveCliHost } = require('../../backend/openCodexRuntime.cjs');
const { launchSpec } = require('../../backend/openCodexCli.cjs');
const providers = require('../../backend/openCodexProviders.cjs');
const { findLatestAgentThread } = require('../../backend/agentThreadHost.cjs');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-open-codex-test-'));
const previousStore = process.env.LINA_MODEL_PROVIDERS_FILE;
process.env.LINA_MODEL_PROVIDERS_FILE = path.join(fixtureRoot, 'providers.json');
test.after(() => { if (previousStore === undefined) delete process.env.LINA_MODEL_PROVIDERS_FILE; else process.env.LINA_MODEL_PROVIDERS_FILE = previousStore; });
const models = [{ id: 'vendor/model-a', label: 'Model A', contextWindow: 32768, reasoning: true, imageInput: true }];
const route = { ...models[0], apiMode: 'chat-completions', baseUrl: 'https://fixture.invalid/v1', apiKey: 'upstream-test-secret' };
const body = { model: 'fixture/model-a', instructions: 'Help with code.', input: [{ role: 'user', content: 'Hello' }], stream: true };
const events = values => new Response(values.map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const delta = (value, finish_reason = null) => ({ choices: [{ index: 0, delta: value, finish_reason }] });
async function withAdapter(t, fetchImpl, options = {}) {
  const adapter = await createAdapter({ resolveModel: key => { assert.equal(key, body.model); return { ...route, ...options }; }, listModels: () => [{ key: body.model, providerName: 'Fixture' }], fetchImpl });
  t.after(() => adapter.close()); return adapter;
}
async function request(adapter, value = body) {
  return fetch(`${adapter.baseUrl}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${adapter.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}
async function parsedEvents(response) {
  const rows = []; for await (const value of sseData(response.body)) rows.push(JSON.parse(value)); return rows;
}

test('settings expose only explicitly configured models and never API keys', () => {
  const result = providers.upsertProfile({ name: 'Fixture', baseUrl: 'https://fixture.invalid/v1/', apiKey: 'settings-test-key', models });
  assert.equal(result.ok, true);
  assert.equal(result.profile.apiKey, undefined);
  const list = providers.listProfiles();
  assert.equal(list.models.length, 1); assert.equal(list.models[0].id, 'vendor/model-a');
  assert.ok(!JSON.stringify(list).includes('settings-test-key'));
  assert.equal(providers.resolveModel(list.defaultModel).apiKey, 'settings-test-key');
  assert.throws(() => providers.resolveModel('unconfigured/model'), /no longer configured/);
  assert.equal(providers.setDefaultModel('unconfigured/model').ok, false);
  const update = providers.upsertProfile({ id: result.profile.id, name: 'Renamed', baseUrl: result.profile.baseUrl, models });
  assert.equal(update.ok, true); assert.equal(providers.resolveModel(list.defaultModel).apiKey, 'settings-test-key');
  assert.equal(modelCatalog(list.models).models[0].slug, list.defaultModel);
});
test('invalid endpoint/model edits preserve saved settings; corrupt stores are not overwritten', () => {
  const file = process.env.LINA_MODEL_PROVIDERS_FILE, before = fs.readFileSync(file, 'utf8');
  for (const baseUrl of ['file:///tmp', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=x'])
    assert.equal(providers.upsertProfile({ name: 'bad', baseUrl, models }).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.writeFileSync(file, 'broken');
  assert.equal(providers.upsertProfile({ name: 'valid', baseUrl: route.baseUrl, models }).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken'); fs.writeFileSync(file, before);
});
test('provider discovery does not forward saved credentials to an edited endpoint', async () => {
  const profile = providers.listProfiles().profiles[0]; let called = false;
  const result = await providers.discoverModels({ id: profile.id, baseUrl: 'https://another.invalid/v1' }, async () => { called = true; });
  assert.equal(result.ok, false); assert.equal(called, false);
});
test('Chat Completions translation preserves image input, parallel tool results, and structured output', () => {
  const translated = toChatRequest({ ...body, input: [
    { role: 'user', content: [{ type: 'input_text', text: 'Inspect' }, { type: 'input_image', image_url: 'data:image/png;base64,abc' }] },
    { type: 'function_call', call_id: 'a', name: 'read', arguments: '{"path":"a"}' },
    { type: 'function_call', call_id: 'b', name: 'read', arguments: '{"path":"b"}' },
    { type: 'function_call_output', call_id: 'a', output: 'one' },
    { type: 'function_call_output', call_id: 'b', output: 'two' }
  ], tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
  text: { format: { type: 'json_schema', name: 'result', schema: { type: 'object' }, strict: true } }, reasoning: { effort: 'high' } }, route).request;
  assert.equal(translated.model, route.id);
  assert.equal(translated.messages[1].content[1].type, 'image_url');
  assert.equal(translated.messages[2].tool_calls.length, 2);
  assert.deepEqual(translated.messages.slice(3).map(row => row.tool_call_id), ['a','b']);
  assert.equal(translated.response_format.json_schema.name, 'result'); assert.equal(translated.reasoning_effort, 'high');
});
test('adapter authenticates loopback requests and never forwards local authorization upstream', async t => {
  const adapter = await withAdapter(t, async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer upstream-test-secret');
    assert.equal(init.redirect, 'error');
    return events([delta({ content: 'Hello' }, 'stop'), '[DONE]']);
  });
  assert.equal((await fetch(`${adapter.baseUrl}/models`)).status, 401);
  assert.equal((await fetch(`${adapter.baseUrl}/models`, { headers: { Authorization: `Bearer ${adapter.token}`, Origin: 'http://untrusted.invalid' } })).status, 401);
  const rows = await parsedEvents(await request(adapter));
  assert.equal(rows.at(-1).type, 'response.completed');
  assert.equal(rows.at(-1).response.output[0].content[0].text, 'Hello');
  assert.ok(!JSON.stringify(rows).includes('upstream-test-secret'));
});
test('automatic routing falls back only for an unsupported Responses endpoint and caches the result', async t => {
  const calls = [];
  const adapter = await withAdapter(t, async url => {
    calls.push(url);
    return url.endsWith('/responses') ? new Response('', { status: 404 }) : events([delta({ content: 'OK' }, 'stop'), '[DONE]']);
  }, { apiMode: 'auto' });
  await (await request(adapter)).text(); await (await request(adapter)).text();
  assert.equal(calls.filter(url => url.endsWith('/responses')).length, 1);
  assert.equal(calls.filter(url => url.endsWith('/chat/completions')).length, 2);
});
test('authentication and rate limit failures do not retry through another API', async t => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const adapter = await withAdapter(t, async () => { calls++; return new Response('sensitive upstream error', { status }); }, { apiMode: 'auto' });
    const response = await request(adapter); assert.equal(response.status, status);
    assert.ok(!(await response.text()).includes('sensitive')); assert.equal(calls, 1);
  }
});
test('fragmented tools and opaque reasoning round-trip with their original identities', async t => {
  const tools = [{ type: 'function', name: 'run', parameters: { type: 'object' } }];
  const adapter = await withAdapter(t, async () => events([
    delta({ reasoning: 'Thinking', reasoning_details: [{ index: 0, type: 'reasoning.encrypted', data: 'opaque', format: 'fixture-v1' }] }),
    delta({ tool_calls: [{ index: 0, id: 'call-one', function: { name: 'run', arguments: '{"com' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'mand":"echo ok"}' } }] }, 'tool_calls'),
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }, '[DONE]'
  ]));
  const rows = await parsedEvents(await request(adapter, { ...body, tools }));
  const final = rows.at(-1).response;
  assert.equal(final.usage.total_tokens, 14);
  assert.equal(final.output[1].call_id, 'call-one'); assert.equal(JSON.parse(final.output[1].arguments).command, 'echo ok');
  const next = toChatRequest({ ...body, tools, input: [...final.output, { type: 'function_call_output', call_id: 'call-one', output: 'ok' }] }, route).request;
  assert.equal(next.messages[1].reasoning_details[0].data, 'opaque');
  assert.equal(next.messages[1].tool_calls[0].id, 'call-one');
});
test('truncated provider streams report failure and never emit executable tools', async t => {
  const adapter = await withAdapter(t, async () => events([delta({ tool_calls: [{ index: 0, id: 'unsafe', function: { name: 'run', arguments: '{"command":' } }] })]));
  const rows = await parsedEvents(await request(adapter, { ...body, tools: [{ type: 'function', name: 'run' }] }));
  assert.equal(rows.at(-1).type, 'response.failed');
  assert.ok(!rows.some(row => row.type === 'response.output_item.done'));
});
test('closing the adapter aborts an in-flight provider call', async t => {
  let started, aborted;
  const ready = new Promise(resolve => started = resolve), cancelled = new Promise(resolve => aborted = resolve);
  const adapter = await withAdapter(t, (_url, options) => new Promise((_resolve, reject) => {
    started(); options.signal.addEventListener('abort', () => { aborted(); reject(new Error('aborted')); });
  }));
  const pending = request(adapter).catch(() => null); await ready; await adapter.close(); await cancelled; await pending;
});
test('dedicated CLI requires its own bundle and overrides global Codex auth/config', () => {
  const binary = path.join(fixtureRoot, 'fixture-codex.exe'); fs.writeFileSync(binary, 'fixture');
  const env = { OPENAI_API_KEY: 'personal-key', CODEX_HOME: 'personal-home', LINA_OPEN_CODEX_BIN: binary,
    LINA_OPEN_CODEX_HOME: path.join(fixtureRoot, 'home'), LINA_OPEN_CODEX_CATALOG: path.join(fixtureRoot, 'models.json'),
    LINA_OPEN_CODEX_MODEL: body.model, LINA_OPEN_CODEX_BASE_URL: 'http://127.0.0.1:1/v1', LINA_OPEN_CODEX_TOKEN: 'local-token' };
  const spec = launchSpec(env, ['resume', 'fixture-id']);
  assert.equal(spec.binary, binary); assert.equal(spec.env.CODEX_HOME, env.LINA_OPEN_CODEX_HOME);
  assert.equal(spec.env.OPENAI_API_KEY, undefined);
  assert.ok(!spec.args.join(' ').includes('local-token')); assert.ok(!spec.args.join(' ').includes('personal-key'));
  assert.throws(() => launchSpec({ ...env, LINA_OPEN_CODEX_BIN: undefined }), /missing its bundled/);
});
test('packaged Windows uses the bundled console host and refuses a missing runtime', () => {
  const resourcesPath = path.join(fixtureRoot, 'console host resources');
  const options = { packaged: true, resourcesPath, nodeCommand: 'LinaTerminal.exe', platform: 'win32' };
  assert.throws(() => resolveCliHost(options), /missing its bundled console runtime/);
  const command = path.join(resourcesPath, 'codex-web/runtime/runtime/bun.exe');
  fs.mkdirSync(path.dirname(command), { recursive: true }); fs.writeFileSync(command, 'fixture');
  assert.deepEqual(resolveCliHost(options), { command, env: {} });
  assert.deepEqual(resolveCliHost({ ...options, packaged: false, nodeCommand: 'node' }), { command: 'node', env: {} });
  assert.deepEqual(resolveCliHost({ ...options, platform: 'linux' }), { command: 'LinaTerminal.exe', env: { ELECTRON_RUN_AS_NODE: '1' } });
});

test('Open Codex listing, confirmation, and discovery stay in its separate history', async () => {
  const old = process.env.LINA_OPEN_CODEX_HOME, global = process.env.CODEX_HOME;
  const home = path.join(fixtureRoot, 'separate'), personal = path.join(fixtureRoot, 'personal'), cwd = path.join(fixtureRoot,'workspace');
  const customId = '11111111-1111-4111-8111-111111111111', personalId = '22222222-2222-4222-8222-222222222222';
  for (const [root, id] of [[home,customId],[personal,personalId]]) {
    fs.mkdirSync(path.join(root,'sessions'),{recursive:true});
    fs.writeFileSync(path.join(root,'sessions',`rollout-test-${id}.jsonl`), JSON.stringify({type:'session_meta',timestamp:new Date().toISOString(),payload:{id,cwd,originator:'codex_cli_rs',timestamp:new Date().toISOString()}})+'\n');
  }
  process.env.LINA_OPEN_CODEX_HOME = home; process.env.CODEX_HOME = personal;
  try {
    const list = await findLatestAgentThread({provider:'open-codex',cwd,list:true});
    assert.deepEqual(list.threads.map(row=>row.id),[customId]); assert.equal(list.threads[0].provider,'open-codex');
    assert.equal((await findLatestAgentThread({provider:'open-codex',cwd,confirmId:personalId})).status,'missing');
    assert.equal((await findLatestAgentThread({provider:'open-codex',cwd})).threadRef.id,customId);
    delete process.env.LINA_OPEN_CODEX_HOME;
    assert.equal((await findLatestAgentThread({provider:'open-codex',cwd,list:true})).status,'failed');
  } finally {
    if (old === undefined) delete process.env.LINA_OPEN_CODEX_HOME; else process.env.LINA_OPEN_CODEX_HOME=old;
    if (global === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME=global;
  }
});

test('direct Responses transport keeps conversation and streaming data while routing the saved model', async t => {
  const wire = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[]}}\n\n';
  const adapter = await withAdapter(t, async (url, options) => {
    assert.equal(url, `${route.baseUrl}/responses`);
    const value = JSON.parse(options.body);
    assert.equal(value.model, route.id); assert.equal(value.store, false);
    assert.deepEqual(value.input, body.input); assert.equal(value.service_tier, undefined);
    return new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } });
  }, { apiMode: 'responses' });
  assert.equal(await (await request(adapter, { ...body, store: true, service_tier: 'priority' })).text(), wire);
});
test('cancelled and superseded preparations cannot overwrite a newer pane or leak its adapter', async t => {
  const root = path.join(fixtureRoot, 'bundle-root');
  const binaryDir = path.join(root, 'vendor', 'open-codex', `${process.platform}-${process.arch}`);
  fs.mkdirSync(binaryDir,{recursive:true}); fs.writeFileSync(path.join(binaryDir,process.platform==='win32'?'codex.exe':'codex'),'fixture');
  const manager = createRuntimeManager({ userData: path.join(fixtureRoot,'managed'), binaryOptions: { root }, cliPath: '/fixture/cli.cjs', nodeCommand: process.execPath });
  t.after(()=>manager.close());
  const first = manager.prepare({id:'same-pane',generation:'old'});
  const second = manager.prepare({id:'same-pane',generation:'new'});
  const results = await Promise.allSettled([first,second]);
  assert.equal(results[0].status,'rejected'); assert.equal(results[1].status,'fulfilled');
  const next = results[1].value;
  await manager.release('same-pane','old');
  assert.equal((await fetch(`${next.env.LINA_OPEN_CODEX_BASE_URL}/models`,{headers:{Authorization:`Bearer ${next.env.LINA_OPEN_CODEX_TOKEN}`}})).status,200);
  await manager.release('same-pane','new');
  await assert.rejects(fetch(`${next.env.LINA_OPEN_CODEX_BASE_URL}/models`));
  assert.equal(fs.existsSync(next.env.LINA_OPEN_CODEX_CATALOG),false);
  const pending = manager.prepare({id:'closed-pane',generation:'pending'});
  await manager.release('closed-pane','pending');
  await assert.rejects(pending,/cancelled/);
});

test('nested Codex process exits preserve the owning Open Codex connection', () => {
  const ts = require('typescript'), vm = require('node:vm');
  const main = ts.createSourceFile('main.cjs', fs.readFileSync(path.join(__dirname, '../../backend/main.cjs'), 'utf8'), ts.ScriptTarget.Latest, true);
  const handler = main.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ingestTelemetryEvent');
  assert.ok(handler);
  const runtime = require('../../backend/terminalRuntime.cjs').createTerminalRuntime({});
  const launch = runtime.beginLaunch({ id: 'pane', launchToken: 1, provider: 'open-codex', cwd: fixtureRoot });
  const generation = launch.record.snapshot.generation, released = [];
  const context = {
    terminalRuntime: runtime, openCodexRuntime: { release: (...args) => released.push(args) },
    broadcastTerminalEvent() {}, orchestratorIntegration: null
  };
  vm.runInNewContext(handler.getText(main), context);
  const event = (processId, phase, currentGeneration = generation) => context.ingestTelemetryEvent({
    id: 'pane', generation: currentGeneration, provider: 'codex', type: 'agent-process', processId, phase
  });
  event('owning-cli', 'start');
  event('nested-cli', 'start');
  event('nested-cli', 'exit');
  event(undefined, 'exit');
  event('owning-cli', 'exit', 'retired-generation');
  assert.equal(runtime.getSnapshot('pane').agentProcessState, 'running');
  assert.equal(released.length, 0, 'child, unidentified, and stale exits must leave the provider adapter open');
  event('owning-cli', 'exit');
  assert.equal(runtime.getSnapshot('pane').agentProcessState, 'exited');
  assert.deepEqual(released, [['pane', generation]]);
});
