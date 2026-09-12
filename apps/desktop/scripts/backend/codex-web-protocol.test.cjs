const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const TOML = require('@iarna/toml');
const { nativeArgs, privateNativeEnv } = require('../../backend/codexWebNative.cjs');
const { roundToken, toolContract, decodeAnswer, createToolRelay, responseKind } = require('../../backend/codexWebToolRelay.cjs');
const { guardedConversationKey, resumeRequest } = require('../../backend/codexWebConversation.cjs');
const { imageSourceAllowed, validImage, imageToolResult, readImageReferences, clipboardImagePath, generatedCandidate } = require('../../backend/codexWebImages.cjs');
test('image downloads find generated widgets and exclude uploaded references and their alternate previews', () => {
  const images = [
    { src: 'https://chatgpt.com/backend-api/estuary/content?id=file-input&width=100', reference: true },
    { src: 'https://chatgpt.com/backend-api/estuary/content?id=file-output', reference: false },
    { src: 'https://chatgpt.com/backend-api/estuary/content?id=file-input&width=500', reference: false },
  ];
  assert.equal(generatedCandidate(images), images[1]); assert.equal(generatedCandidate(images, new Set(['file-output'])), undefined);
  assert.equal(generatedCandidate([{ src: 'file:///private.png', reference: false }]), undefined);
});
const fs = require('node:fs'), os = require('node:os');
test('native image cancellation watches only its owning turn and skips large image payload records', async t => {
  const { watchNativeAbort, nativeIdentity } = require('../../backend/codexWebNativeCancellation.cjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-native-abort-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const threadId = '01a090e8-b451-7fa3-97ee-203c4524f782', turnId = 'turn-owned', directory = path.join(home, 'sessions/2026/09/11'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'rollout-2026-09-11T10-00-00-' + threadId + '.jsonl'); fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: threadId } }) + '\n');
  const meta = { threadId, 'x-codex-turn-metadata': { thread_id: threadId, turn_id: turnId } }, controller = new AbortController();
  const stop = await watchNativeAbort(home, meta, controller); t.after(stop);
  assert.deepEqual(nativeIdentity(meta), { threadId, turnId }); assert.throws(() => nativeIdentity({ ...meta, threadId: 'another-thread' }), { code: 'image_cancellation_unavailable' });
  fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'another-turn' } }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(controller.signal.aborted, false);
  fs.appendFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'image bytes '.repeat(40000) } }) + '\n');
  const event = JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turnId } }); fs.appendFileSync(file, event.slice(0, 30));
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(controller.signal.aborted, false);
  fs.appendFileSync(file, event.slice(30) + '\n');
  await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Native abort not observed')), 2000); controller.signal.addEventListener('abort', () => { clearTimeout(timeout); resolve(); }, { once: true }); });
});
test('MCP cancellation suppresses a late image result and leaves the server ready for another call', async () => {
  const { PassThrough } = require('node:stream'), { runImageToolServer } = require('../../backend/codexWebImages.cjs');
  const input = new PassThrough(), output = new PassThrough(); let resolveFirst, capturedSignal, calls = 0, text = '';
  output.on('data', chunk => { text += chunk; });
  const picture = { file: path.resolve('image-0123456789abcdef0123.png'), width: 512, height: 512 };
  const server = runImageToolServer({}, { input, output, generate: async (_api, _prompt, signal) => { calls++; capturedSignal = signal; return calls === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : picture; } });
  const send = message => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  send({ id: 1, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 'first picture' } } });
  await new Promise(resolve => setImmediate(resolve));
  send({ method: 'notifications/cancelled', params: { requestId: 1 } }); assert.equal(capturedSignal.aborted, true);
  resolveFirst(picture); await new Promise(resolve => setImmediate(resolve));
  send({ id: 2, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 'second picture' } } });
  await new Promise(resolve => setImmediate(resolve)); input.end(); await server;
  const replies = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies[0].result.isError, true); assert.equal(replies[0].result.content[0].text, 'Image generation cancelled.');
  assert.equal(replies[1].result.isError, undefined); assert.match(replies[1].result.content[0].text, /Saved image:/);
});
test('image references retain order and validate formats and combined limits before upload', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-image-input-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = path.join(directory, 'one.png'), second = path.join(directory, 'two.gif');
  fs.writeFileSync(first, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(20)])); fs.writeFileSync(second, 'GIF89a000000');
  const inputs = readImageReferences([first, second]); assert.deepEqual(inputs.map(item => item.name), ['reference-1.png', 'reference-2.gif']); assert.equal(inputs[0].mimeType, 'image/png');
  assert.throws(() => readImageReferences([first, 'https://example.com/image.png']), { code: 'image_input_invalid' });
  assert.throws(() => readImageReferences(Array(11).fill(first)), { code: 'image_input_limit' });
  fs.truncateSync(first, 20000001); assert.throws(() => readImageReferences([first]), { code: 'image_input_limit' });
});
test('clipboard images are stored locally without changing the clipboard or generating requests', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-image-clipboard-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(20)]), clipboard = { readImage: () => ({ isEmpty: () => false, toPNG: () => bytes }) };
  const [file] = clipboardImagePath(directory, clipboard); assert.deepEqual(fs.readFileSync(file), bytes); assert.deepEqual(clipboardImagePath(directory, clipboard), [file]);
  assert.deepEqual(clipboardImagePath(directory, { readImage: () => ({ isEmpty: () => true }) }), []);
});
test('a delayed image paste cannot attach to a restarted pane and a rejected batch pastes nothing', async () => {
  const source = require('typescript').transpileModule(fs.readFileSync(path.join(__dirname, '../../frontend/terminalImages.ts'), 'utf8'), { compilerOptions: { module: 1, target: 9 } }).outputText;
  const exports = {}; new Function('exports', source)(exports);
  let resolve, current = true; const pasted = [], errors = [], options = { pane: { id: 'pane', launchToken: 1 }, paths: ['image.png'], action: () => new Promise(done => { resolve = done; }), isCurrent: () => current, paste: text => pasted.push(text), onError: message => errors.push(message) };
  const pending = exports.attachTerminalImages(options); current = false; resolve({ ok: true, attachmentPaths: ['C:\\image.png'] }); await pending; assert.deepEqual(pasted, []);
  current = true; await exports.attachTerminalImages({ ...options, action: async () => ({ ok: false, error: { message: 'Too many images' } }) }); assert.deepEqual(pasted, []); assert.deepEqual(errors, ['Too many images']);
  await exports.attachTerminalImages({ ...options, action: async () => ({ ok: true, attachmentPaths: ['C:\\two words.png', 'C:\\other.png'] }) }); assert.deepEqual(pasted, ['"C:\\two words.png"', '"C:\\other.png"']);
});
test('image tool results keep image bytes out of the native transcript and next model request', () => {
  const name = 'image-0123456789abcdef0123.png', result = imageToolResult({ file: path.resolve(name), width: 1536, height: 1024, data: 'PRIVATE_IMAGE_BYTES'.repeat(100000) });
  assert.deepEqual(result.content.map(block => block.type), ['text']);
  const serialized = JSON.stringify(result);
  assert.ok(serialized.length < 1000); assert.ok(!serialized.includes('PRIVATE_IMAGE_BYTES'));
  assert.ok(result.content[0].text.includes('\n' + name + '\n')); assert.ok(result.content[0].text.includes('1536 x 1024'));
});
function toolRequest() { return { modelId: 'fixture', options: {}, _rawBody: { input: [{ role: 'user', content: 'Create the file.' }] }, context: { messages: [], tools: [{ name: 'apply_patch', freeform: true, parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } }, { namespace: 'functions', name: 'exec_command', parameters: { type: 'object' } }] } }; }
test('native freeform grammar reaches the Web model without duplicating edits as answer text', async () => {
  const parsed = toolRequest();
  const format = { type: 'grammar', syntax: 'lark', definition: 'start: "*** Update File: " filename' };
  parsed.context.tools[0].format = format;
  const contract = toolContract(parsed);
  const inventory = JSON.parse(contract[contract.indexOf('<native_codex_tool_inventory>') + 1]);
  assert.deepEqual(inventory[0].format, format);
  const previous = process.env.LINA_CODEX_WEB_HOST_MODULE; process.env.LINA_CODEX_WEB_HOST_MODULE = 'fixture';
  try {
    const patch = '*** Begin Patch\n*** Update File: index.html\n@@\n-old\n+new\n*** End Patch';
    const answer = 'LINA-TOOL-CALL: ' + roundToken(parsed) + '\n```json\n' + JSON.stringify({ codex_web: 1, round: roundToken(parsed), calls: [{ name: 'apply_patch', arguments: { input: patch } }], answer: null }) + '\n```';
    const events = [];
    await createToolRelay({ name: 'fixture', async runTurn(_p, _i, emit) {
      for (const char of answer) emit({ type: 'text_delta', text: char, phase: 'final_answer' });
      emit({ type: 'done' });
    } }).runTurn(parsed, {}, event => events.push(event));
    assert.equal(events.filter(event => event.type === 'text_delta').length, 0);
    assert.equal(events.filter(event => event.type === 'tool_call_start').length, 1);
    assert.equal(JSON.parse(events.find(event => event.type === 'tool_call_delta').arguments).input, patch);
  } finally { if (previous === undefined) delete process.env.LINA_CODEX_WEB_HOST_MODULE; else process.env.LINA_CODEX_WEB_HOST_MODULE = previous; }
});
test('a native browser policy denial stops the current Web turn before another model or tool action', async () => {
  const { nativeBrowserPolicyDenied } = require('../../backend/codexWebToolRelay.cjs');
  const parsed = toolRequest(), denial = 'Browser Use rejected this action due to browser security policy. Reason: The browser URL policy blocks this action.';
  parsed.context.messages = [{ role: 'user', content: 'Verify the webpage.' }, { role: 'toolResult', toolNamespace: 'mcp__cua_repl', toolName: 'js', content: 'Wall time: 0.1 seconds\nOutput:\n' + denial }];
  assert.equal(nativeBrowserPolicyDenied(parsed), true);
  const previous = process.env.LINA_CODEX_WEB_HOST_MODULE; process.env.LINA_CODEX_WEB_HOST_MODULE = 'fixture';
  try {
    const events = [];
    await createToolRelay({ name: 'fixture', runTurn: () => assert.fail('The blocked action must not reach another Web model round.') }).runTurn(parsed, {}, event => events.push(event));
    assert.equal(events[0].code, 'native_browser_policy_denied'); assert.equal(events[0].retryable, false);
    parsed.context.messages.push({ role: 'user', content: 'Continue with static checks only.' });
    assert.equal(nativeBrowserPolicyDenied(parsed), false, 'An independent new request can continue.');
    parsed.context.messages.push({ role: 'toolResult', toolName: 'exec_command', content: denial });
    assert.equal(nativeBrowserPolicyDenied(parsed), false, 'Quoted text from unrelated tools is not a browser policy decision.');
  } finally { if (previous === undefined) delete process.env.LINA_CODEX_WEB_HOST_MODULE; else process.env.LINA_CODEX_WEB_HOST_MODULE = previous; }
});

test('Web model names follow Codex conventions while old selections still route to exact account models', t => {
  const { presentAccountCatalog, refreshNativeModelNames, buildNativeCatalog, accountModel, resolveAccountRoute } = require('../../backend/codexWebModelDiscovery.cjs');
  const { webModels, preferredWebModel } = require('../../backend/codexWebSupport.cjs');
  const catalog = { version: 1, models: [
    ['gpt-5-6-thinking', 'GPT-5.6 Sol', false, 'reasoning'],
    ['gpt-6-astra-wm', 'GPT-6 Astra', true, 'reasoning'],
    ['gpt-5.6-sol-wm', 'GPT-5.6 Sol', true, 'reasoning'],
    ['gpt-5-6-t-mini', 'GPT-5.6 Luna', false, 'reasoning'],
    ['gpt-6-pro', 'GPT-6 Pro', false, 'pro'],
  ].map(([slug, title, workMode, reasoningType]) => ({ slug, title, workMode, reasoningType, maxTokens: 100000, defaultEffort: 'medium', efforts: [{ effort: 'medium', description: 'Standard' }, { effort: 'high', description: 'Extended' }] })) };
  const display = presentAccountCatalog(catalog);
  assert.deepEqual(display.models.map(model => model.id), ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-sol-thinking', 'gpt-5.6-luna-chat', 'gpt-6-pro']);
  assert.deepEqual(presentAccountCatalog(display), display, 'Reading an existing normalized cache must preserve IDs.');
  const rows = buildNativeCatalog({}, catalog).models, models = webModels(rows, { includePickerHidden: true });
  assert.equal(models.length, 5); assert.equal(webModels([{ slug: 'gpt-native' }]).length, 0);
  assert.equal(webModels(rows).length, 5);
  assert.equal(preferredWebModel(models, 'chatgpt-web/gpt-5-6-thinking').id, 'gpt-5.6-sol-thinking');
  const oldRows = rows.map(row => ({ ...row, slug: row._lina_web_aliases[0], display_name: catalog.models.find(model => model.slug === row._lina_web_slug).title }));
  const migrated = refreshNativeModelNames(oldRows);
  assert.deepEqual(migrated.map(row => row.slug), rows.map(row => row.slug));
  assert.deepEqual(migrated.map(row => row.supported_reasoning_levels), rows.map(row => row.supported_reasoning_levels));
  assert.equal(refreshNativeModelNames(migrated), migrated);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-web-model-alias-'));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME; process.env.CODEX_CHATGPT_WEB_HOME = directory;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(directory, 'lina-account-models.json'), JSON.stringify(catalog));
  assert.equal(accountModel('gpt-5.6-sol-thinking').slug, 'gpt-5-6-thinking');
  assert.equal(resolveAccountRoute('chatgpt-web/gpt-5-6-thinking').backendModel, 'chatgpt-account/gpt-5-6-thinking');
  assert.equal(resolveAccountRoute('gpt-6-astra').backendModel, 'chatgpt-account/gpt-6-astra-wm');
  assert.equal(resolveAccountRoute('gpt-not-on-web'), undefined);
});

function identityCatalog(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-web-identity-'));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const models = [
    ['gpt-6-astra-wm', 'GPT-6 Astra', true],
    ['gpt-5.6-sol-wm', 'GPT-5.6 Sol', true],
    ['gpt-5-6-thinking', 'GPT-5.6 Sol', false],
  ].map(([slug, title, workMode]) => ({ slug, title, workMode, reasoningType: 'reasoning', maxTokens: 100000, defaultEffort: 'medium', efforts: [{ effort: 'medium' }, { effort: 'high' }] }));
  fs.writeFileSync(path.join(directory, 'lina-account-models.json'), JSON.stringify({ version: 1, models }));
  return directory;
}

test('identity context follows the resolved request through aliases, model changes and resumed history', t => {
  identityCatalog(t);
  const { accountSelection, resolveAccountRoute } = require('../../backend/codexWebModelDiscovery.cjs');
  const parsed = toolRequest();
  parsed.options = { reasoning: 'high', toolChoice: 'none' };
  parsed.context.messages = [{ role: 'assistant', content: 'I am GPT-5.6 Sol.' }, { role: 'user', content: 'which model are you ?' }];
  const history = structuredClone(parsed.context.messages);
  for (const [id, model, name, mode] of [
    ['gpt-6-astra', 'gpt-6-astra', 'GPT-6 Astra', 'Work'],
    ['chatgpt-web/gpt-6-astra-wm', 'gpt-6-astra', 'GPT-6 Astra', 'Work'],
    ['gpt-5.6-sol', 'gpt-5.6-sol', 'GPT-5.6 Sol', 'Work'],
    ['gpt-5.6-sol-thinking', 'gpt-5.6-sol-thinking', 'GPT-5.6 Sol', 'Thinking'],
  ]) {
    parsed.modelId = resolveAccountRoute(id).backendModel;
    for (const request of [parsed, resumeRequest(parsed)]) {
      const contract = toolContract(request), marker = contract.indexOf('<lina_model_selection>');
      assert.ok(marker >= 0);
      assert.deepEqual(JSON.parse(contract[marker + 1]), { model, name, mode, reasoning_effort: 'high' });
      assert.match(contract.join('\n'), /not the identity of the server/);
      assert.doesNotMatch(contract.join('\n'), /You are GPT/);
    }
  }
  assert.deepEqual(parsed.context.messages, history, 'Historical replies are preserved, not silently rewritten.');
  assert.equal(accountSelection('chatgpt-account/gpt-6-astra-wm').reasoning_effort, 'medium');
  assert.throws(() => accountSelection('chatgpt-account/gpt-6-astra-wm', 'ultra'), /model_effort_unavailable/);
  assert.throws(() => accountSelection('chatgpt-account/missing-model'), /model_unavailable/);
  assert.equal(accountSelection('gpt-native', 'high'), null, 'Native models outside this bridge are unchanged.');
});

test('the outgoing Web request guard rejects a different model and isolates simultaneous pane selections', async t => {
  const directory = identityCatalog(t);
  const { bindAccountSelection, assertAccountSelection } = require('../../backend/codexWebModelDiscovery.cjs');
  function pageFor(slug) {
    let handler;
    const page = { on() {}, once() {}, context: () => ({ newCDPSession: async () => ({ send: async () => {}, on() {} }) }), route: async (_pattern, callback) => { handler = callback; }, setViewportSize: async () => {}, url: () => 'https://chatgpt.com/?model=' + slug };
    return { page, async send(model, pathname = '/backend-api/f/conversation', extra = {}) {
      let result;
      await handler({ request: () => ({ method: () => 'POST', url: () => 'https://chatgpt.com' + pathname, postDataJSON: () => ({ model, ...extra }) }),
        continue: async () => { result = 'sent'; }, abort: async () => { result = 'blocked'; } });
      return result;
    } };
  }
  const astra = pageFor('gpt-6-astra-wm'), sol = pageFor('gpt-5.6-sol-wm');
  await bindAccountSelection(astra.page, 'chatgpt-account/gpt-6-astra-wm', 'high');
  await bindAccountSelection(sol.page, 'chatgpt-account/gpt-5.6-sol-wm', 'medium');
  assert.equal(await astra.send('gpt-5.6-sol-wm'), 'blocked');
  assert.throws(() => assertAccountSelection(astra.page), /model_selection_failed/);
  assert.equal(await sol.send('gpt-5.6-sol-wm'), 'sent');
  assert.doesNotThrow(() => assertAccountSelection(sol.page));
  await bindAccountSelection(astra.page, 'chatgpt-account/gpt-6-astra-wm', 'high');
  assert.equal(await astra.send('gpt-6-astra-wm', '/backend-api/conversation'), 'sent');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'lina-last-model-request.json'), 'utf8')).model, 'gpt-6-astra-wm');
  assert.doesNotThrow(() => assertAccountSelection(astra.page));
  assert.equal(await astra.send(undefined), 'blocked');
  await bindAccountSelection(astra.page, 'chatgpt-account/gpt-6-astra-wm', 'high');
  assert.equal(await astra.send('gpt-6-astra-wm', undefined, { history_and_training_disabled: true }), 'blocked');
  assert.throws(() => assertAccountSelection(astra.page), /model_surface_mismatch/);
  const catalogFile = path.join(directory, 'lina-account-models.json'), catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  catalog.models[0].efforts[1].webEffort = 'extended'; fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  await bindAccountSelection(astra.page, 'chatgpt-account/gpt-6-astra-wm', 'high');
  assert.equal(await astra.send('gpt-6-astra-wm', undefined, { thinking_effort: 'standard' }), 'blocked');
  assert.throws(() => assertAccountSelection(astra.page), /model_effort_unavailable/);
  await bindAccountSelection(astra.page, 'chatgpt-account/gpt-6-astra-wm', 'high');
  assert.equal(await astra.send('gpt-6-astra-wm', undefined, { thinking_effort: 'extended' }), 'sent');
});

test('retained browser context cannot carry a previous model or reasoning selection into a new request', () => {
  const parsed = toolRequest(); parsed.modelId = 'chatgpt-account/gpt-5-6-thinking'; parsed.options.reasoning = 'medium';
  const first = guardedConversationKey(parsed, 'identity-thread');
  assert.equal(guardedConversationKey(parsed, 'identity-thread'), first);
  parsed.options.reasoning = 'high';
  const higher = guardedConversationKey(parsed, 'identity-thread');
  assert.notEqual(higher, first);
  parsed.modelId = 'chatgpt-account/gpt-6-pro';
  assert.notEqual(guardedConversationKey(parsed, 'identity-thread'), higher);
});

test('identity guidance never replaces or fabricates the model answer', async () => {
  const previous = process.env.LINA_CODEX_WEB_HOST_MODULE; process.env.LINA_CODEX_WEB_HOST_MODULE = 'fixture';
  try {
    const answer = 'I am GPT-5.6 Sol.', events = [];
    await createToolRelay({ name: 'fixture', async runTurn(_request, _input, emit) {
      emit({ type: 'text_delta', text: answer, phase: 'final_answer' }); emit({ type: 'done' });
    } }).runTurn(toolRequest(), {}, event => events.push(event));
    assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.text).join(''), answer);
  } finally { if (previous === undefined) delete process.env.LINA_CODEX_WEB_HOST_MODULE; else process.env.LINA_CODEX_WEB_HOST_MODULE = previous; }
});
test('thinking-only picker keeps distinct reasoning routes and hides only non-reasoning choices', () => {
  const { buildNativeCatalog, filterNativeModelPicker } = require('../../backend/codexWebModelDiscovery.cjs');
  const { webModels, preferredWebModel } = require('../../backend/codexWebSupport.cjs');
  const catalog = { models: [
    ['gpt-6-astra-wm', 'GPT-6 Astra', true, 'reasoning'],
    ['gpt-5.6-sol-wm', 'GPT-5.6 Sol', true, 'reasoning'],
    ['gpt-5.6-luna-wm', 'GPT-5.6 Luna', true, 'reasoning'],
    ['gpt-5-6-thinking', 'GPT-5.6 Sol', false, 'reasoning'],
    ['gpt-5-6-t-mini', 'GPT-5.6 Luna', false, 'reasoning'],
    ['gpt-5-6-instant', 'GPT-5.6 Sol', false, 'none'],
    ['gpt-5-6', 'GPT-5.6 Sol', false, 'auto'],
    ['gpt-6-pro', 'GPT-6 Pro', false, 'pro'],
  ].map(([slug, title, workMode, reasoningType]) => ({ slug, title, workMode, reasoningType, maxTokens: 100000, defaultEffort: reasoningType === 'none' || reasoningType === 'auto' ? 'low' : 'medium', efforts: [{ effort: 'medium' }, { effort: 'high' }] })) };
  const rows = buildNativeCatalog({}, catalog).models;
  assert.deepEqual(webModels(rows).map(model => model.id), ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-sol-thinking', 'gpt-5.6-luna-chat', 'gpt-6-pro']);
  assert.equal(rows.length, 8, 'Hidden choices remain in native metadata for resume and direct selection.');
  assert.equal(filterNativeModelPicker(rows), rows);
  const all = webModels(rows, { includePickerHidden: true });
  assert.equal(preferredWebModel(all, 'chatgpt-web/gpt-5-6-thinking').id, 'gpt-5.6-sol-thinking');
  assert.equal(preferredWebModel(all, 'gpt-5.6-sol-instant').id, 'gpt-5.6-sol-instant');
  const chatOnly = filterNativeModelPicker(rows.filter(row => !row._lina_web_work_mode));
  assert.deepEqual(webModels(chatOnly).map(model => model.id), ['gpt-5.6-sol-thinking', 'gpt-5.6-luna-chat', 'gpt-6-pro'], 'Keep Thinking routes when an account has no corresponding Work model.');
  const unavailable = { ...rows[0], visibility: 'hide', hidden: true };
  assert.deepEqual(webModels(filterNativeModelPicker([unavailable]), { includePickerHidden: true }), [], 'Unavailable upstream rows must never become usable through picker filtering.');
});
test('too many newly attached images fail visibly before a Web request instead of dropping the user input', async () => {
  const prior = process.env.LINA_CODEX_WEB_HOST_MODULE; process.env.LINA_CODEX_WEB_HOST_MODULE = 'fixture';
  try {
    const parsed = toolRequest(), events = []; parsed.context.messages = [{ role: 'user', content: Array.from({ length: 11 }, () => ({ type: 'image', imageUrl: 'fixture' })) }];
    const relay = createToolRelay({ name: 'fixture', runTurn: () => assert.fail('The oversized attachment batch must not reach ChatGPT.') });
    await relay.runTurn(parsed, {}, event => events.push(event)); assert.equal(events[0].code, 'image_input_limit'); assert.equal(events[0].retryable, false);
  } finally { if (prior === undefined) delete process.env.LINA_CODEX_WEB_HOST_MODULE; else process.env.LINA_CODEX_WEB_HOST_MODULE = prior; }
});
test('ordinary replies stream before completion while tool envelopes stay buffered', async () => {
  const prior = process.env.LINA_CODEX_WEB_HOST_MODULE; process.env.LINA_CODEX_WEB_HOST_MODULE = 'fixture';
  try {
    const parsed = toolRequest(), events = []; let release;
    const hold = new Promise(resolve => { release = resolve; });
    const relay = createToolRelay({ name: 'fixture', async runTurn(_parsed, _incoming, emit) { emit({ type: 'text_delta', text: 'A quick answer.\n\n', phase: 'final_answer' }); await hold; emit({ type: 'text_delta', text: 'More detail.', phase: 'final_answer' }); emit({ type: 'done' }); } });
    const run = relay.runTurn(parsed, {}, event => events.push(event));
    assert.equal(events[0].text, 'A quick answer.\n\n'); assert.ok(!events.some(event => event.type === 'done'));
    release(); await run; assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.text).join(''), 'A quick answer.\n\nMore detail.');
    assert.equal(responseKind('LINA-TOOL-'), 'pending'); assert.equal(responseKind('LINA-TOOL-CALL: abc\n'), 'tools');
    assert.equal(responseKind('```javascript\nconst x = 1'), 'text'); assert.equal(responseKind('JSON\n\n```\n{"codex_web":1'), 'tools');
    for (const prefix of ['`', '``', 'JSON\n', 'JSON\n\n', 'JSON\n\n```']) assert.equal(responseKind(prefix), 'pending');
    const marker = 'LINA-TOOL-CALL: ' + roundToken(parsed) + '\n';
    assert.equal(decodeAnswer(marker + '```json\n' + JSON.stringify({ codex_web: 1, round: roundToken(parsed), calls: [{ name: 'apply_patch', arguments: { input: 'patch' } }], answer: null }) + '\n```', parsed)[0].name, 'apply_patch');
  } finally { if (prior === undefined) delete process.env.LINA_CODEX_WEB_HOST_MODULE; else process.env.LINA_CODEX_WEB_HOST_MODULE = prior; }
});
test('browser reuse requires the same native history prefix, model contract and tool inventory', () => {
  const parsed = toolRequest(); parsed.context.systemPrompt = ['system'];
  const first = guardedConversationKey(parsed, 'native-thread-a');
  const work = guardedConversationKey(parsed, 'native-thread-a', true);
  assert.equal(guardedConversationKey(parsed, 'native-thread-a', true), work);
  assert.notEqual(work, first, 'A Work conversation must not reuse a Chat surface.');
  parsed._rawBody.input.push({ type: 'message', role: 'assistant', content: 'Created.' });
  assert.equal(guardedConversationKey(parsed, 'native-thread-a'), first);
  parsed._rawBody.input[0].content = 'A different request';
  assert.notEqual(guardedConversationKey(parsed, 'native-thread-a'), first);
  assert.notEqual(guardedConversationKey(parsed, 'native-thread-b'), first);
  parsed.context.messages = [{ role: 'user', content: 'Request' }, { role: 'assistant', content: [] }, { role: 'toolResult', content: 'result' }];
  const resumed = resumeRequest(parsed); assert.deepEqual(resumed.context.systemPrompt, []); assert.equal(resumed.context.messages.length, 1);
  assert.equal(resumed._rawBody, parsed._rawBody); assert.ok(!toolContract(resumed).join('\n').includes('native_codex_tool_inventory'));
});
test('the image tool is scoped to the private Web home and limits download origins', () => {
  const base = path.resolve('private');
  const args = nativeArgs({ route: 'http://127.0.0.1:1/v1', catalogPath: path.join(base, 'catalog.json'), model: 'web', connection: {}, imageTool: { command: path.join(base, 'bun.exe'), entry: path.join(base, 'cli.js'), home: path.join(base, 'bridge') } });
  const env = TOML.parse(args.find(arg => arg.startsWith('mcp_servers.lina_images.env='))).mcp_servers.lina_images.env;
  assert.equal(env.CODEX_HOME, base); assert.equal(env.CODEX_CHATGPT_WEB_HOME, path.join(base, 'bridge'));
  assert.ok(args.includes('mcp_servers.lina_images.required=true'));
  assert.ok(args.includes('features.code_mode.direct_only_tool_namespaces=["mcp__lina_images"]'));
  assert.equal(imageSourceAllowed('https://chatgpt.com/backend-api/estuary/content?id=fixture'), true);
  assert.equal(imageSourceAllowed('http://127.0.0.1/private'), false); assert.equal(imageSourceAllowed('https://chatgpt.com.evil.example/file'), false);
});
test('image tool availability guidance distinguishes the native tool from Temporary Chat capabilities', () => {
  const parsed = toolRequest(); parsed.context.tools.push({ namespace: 'mcp__lina_images', name: 'generate_image', parameters: {} });
  for (const resume of [false, true]) { parsed._linaResume = resume; const contract = toolContract(parsed).join('\n'); assert.match(contract, /mcp__lina_images__generate_image/); assert.match(contract, /own regular ChatGPT image chat/); }
  parsed.options.toolChoice = 'none'; assert.ok(!toolContract(parsed).join('\n').includes('Image generation and reference-image editing are available'));
});
test('direct image exposure preserves other direct namespaces and the configured code-mode state', () => {
  const base = path.resolve('private'), args = nativeArgs({ route: 'http://127.0.0.1:1/v1', catalogPath: path.join(base, 'catalog.json'), model: 'web', imageTool: { command: path.join(base, 'bun.exe'), entry: path.join(base, 'cli.js'), home: base, codeMode: { enabled: true, direct_only_tool_namespaces: ['mcp__existing'] } } });
  assert.ok(args.includes('features.code_mode.direct_only_tool_namespaces=["mcp__existing","mcp__lina_images"]')); assert.ok(args.includes('features.code_mode.enabled=true'));
});
test('image downloads reject HTML, unsupported formats, oversized bodies and mismatched types', () => {
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(20)]);
  assert.equal(validImage(png, 'image/png'), true);
  assert.equal(validImage(png, 'image/jpeg'), false);
  assert.equal(validImage(Buffer.from('<html>expired session</html>'), 'image/png'), false);
  assert.equal(validImage(Buffer.alloc(20000001), 'image/png'), false);
  assert.equal(validImage(Buffer.from('RIFF1234WEBPdata'), 'image/webp'), true);
});
test('Web tool answers become native freeform and namespaced calls with stable replay IDs', () => {
  const parsed = toolRequest();
  const text = JSON.stringify({ codex_web: 1, round: roundToken(parsed), calls: [{ name: 'apply_patch', arguments: { input: '*** Begin Patch\n*** End Patch' } }, { name: 'functions__exec_command', arguments: { cmd: 'Get-Content canada.html' } }], answer: null });
  const events = decodeAnswer(text, parsed);
  assert.deepEqual(decodeAnswer('```json\n' + text + '\n```', parsed), events);
  assert.deepEqual(decodeAnswer('JSON\n\n```\n' + text + '\n```', parsed), events);
  assert.equal(events.filter(event => event.type === 'tool_call_start').length, 2);
  assert.deepEqual(decodeAnswer(text, parsed), events);
  assert.ok(toolContract(parsed).join('\n').includes('native Codex CLI'));
  parsed._rawBody.input.push({ type: 'custom_tool_call_output', output: 'Created the file.' });
  assert.throws(() => decodeAnswer(text, parsed), /invalid_tool_response/, 'A tool result starts a new model round, not a replay of the prior calls.');
});
test('malformed, unknown, disallowed or mixed tool replies cannot emit partial tool batches', () => {
  const parsed = toolRequest(), valid = { codex_web: 1, round: roundToken(parsed), calls: [{ name: 'apply_patch', arguments: { input: 'patch' } }], answer: null };
  for (const invalid of ['Here is an example:\n```json\n' + JSON.stringify(valid) + '\n```', JSON.stringify({ ...valid, calls: [...valid.calls, { name: 'invented', arguments: {} }] }), JSON.stringify({ ...valid, answer: 'Also done' }), JSON.stringify({ ...valid, calls: [{ name: 'apply_patch', arguments: { input: 1 } }] })]) assert.throws(() => decodeAnswer(invalid, parsed));
  parsed.options.toolChoice = 'none';
  assert.throws(() => decodeAnswer(JSON.stringify({ ...valid, round: roundToken(parsed) }), parsed));
});
test('an interrupted or failed Web response never leaks its buffered tool protocol', async () => {
  const previous = process.env.LINA_CODEX_WEB_HOST_MODULE; process.env.LINA_CODEX_WEB_HOST_MODULE = 'fixture';
  try {
    const parsed = toolRequest(), events = [], controller = new AbortController();
    const relay = createToolRelay({ name: 'fixture', async runTurn(_parsed, _incoming, emit) {
      emit({ type: 'text_delta', text: '{"codex_web":1', phase: 'final_answer' });
      controller.abort(); emit({ type: 'done' });
    } });
    await relay.runTurn(parsed, { abortSignal: controller.signal }, event => events.push(event));
    assert.deepEqual(events, []);
  } finally { if (previous === undefined) delete process.env.LINA_CODEX_WEB_HOST_MODULE; else process.env.LINA_CODEX_WEB_HOST_MODULE = previous; }
});
test('the actual CLI owns terminal commands and uses a private Web provider without native quotas', () => {
  const args = nativeArgs({ route: 'http://127.0.0.1:12345/v1', catalogPath: path.resolve('catalog.json'), model: 'chatgpt-web/gpt-6-astra-wm', effort: 'medium', connection: { full: true, toolsVerified: true } }, ['resume', 'native-thread']);
  assert.ok(!args.includes('--remote')); assert.ok(!args.includes('app-server'));
  assert.deepEqual(args.slice(0, 3), ['--no-alt-screen', 'resume', 'native-thread']);
  const provider = TOML.parse(args.find(arg => arg.startsWith('model_providers.codex_web='))).model_providers.codex_web;
  assert.equal(provider.name, 'OpenAI', 'Native Codex turn IDs require its OpenAI wire identity.');
  assert.equal(provider.requires_openai_auth, false, 'Codex must not require a second login or fetch Codex quota counters.');
  assert.equal(provider.supports_websockets, false);
  assert.ok(args.includes('features.fast_mode=false'));
  assert.ok(args.includes('check_for_update_on_startup=false'));
  assert.ok(args.includes('model="chatgpt-web/gpt-6-astra-wm"'));
});
test('the CLI keeps shared capabilities without receiving terminal-control or global inference credentials', () => {
  assert.deepEqual(privateNativeEnv({ CODEX_HOME: '/private', LINA_CODEX_WEB_CONTROL_KEY: 'SECRET', OPENAI_API_KEY: 'global', PATH: 'normal' }), { CODEX_HOME: '/private', PATH: 'normal' });
});
test('explicit CLI model arguments and the inherited permission policy remain owned by Codex', () => {
  const args = nativeArgs({ route: 'http://127.0.0.1:1/v1', catalogPath: path.resolve('catalog.json'), model: 'default', effort: 'medium', connection: { full: false } }, ['--model', 'chosen']);
  assert.ok(!args.includes('model="default"')); assert.ok(!args.some(arg => arg.startsWith('sandbox_mode=') || arg.startsWith('approval_policy=')));
  assert.deepEqual(args.slice(0, 3), ['--no-alt-screen', '--model', 'chosen']);
});
test('nested native commands keep launcher and user config at the same level before literal input', () => {
  const state = { route: 'http://127.0.0.1:1/v1', catalogPath: path.resolve('catalog.json'), model: 'chatgpt-web/default', connection: {} };
  const args = nativeArgs(state, ['-c', 'model="chatgpt-web/chosen"', 'exec', 'resume', 'thread', '--config=features.apps=false', '--', '-literal prompt']);
  assert.deepEqual(args.slice(0, 4), ['--no-alt-screen', 'exec', 'resume', 'thread']);
  assert.ok(args.indexOf('model="chatgpt-web/chosen"') > args.indexOf('model="chatgpt-web/default"'));
  assert.deepEqual(args.slice(-3), ['--config=features.apps=false', '--', '-literal prompt']);
});
test('the authenticated account catalog includes Work/Astra and enabled ChatGPT models with their real reasoning levels', () => {
  const { normalizeAccountCatalog, neutralInstructions } = require('../../backend/codexWebModelDiscovery.cjs');
  assert.throws(() => normalizeAccountCatalog({ status: 401 }), /authentication_required/);
  const catalog = normalizeAccountCatalog({ status: 200, defaultModel: 'gpt-5-6', models: [
    { id: 'gpt-5-6', title: 'GPT-5.6 Sol', reasoningType: 'auto' },
    { id: 'gpt-6-astra-wm', title: 'GPT-6 Astra', workMode: true, maxTokens: 262144, thinkingEfforts: [{ thinking_effort: 'standard', short_label: 'Standard' }, { thinking_effort: 'max', short_label: 'Heavy' }] },
    { id: 'gpt-6-pro', title: 'GPT-6 Pro', reasoningType: 'pro', thinkingEfforts: [{ thinking_effort: 'standard', short_label: 'Standard' }] },
    { id: 'hidden-fallback', title: 'Internal fallback' }, { id: 'gpt-disabled', title: 'Disabled', workMode: true, enabled: false },
  ], versions: [{ enabled: true, slugs: ['gpt-5-6', 'gpt-6-pro'], intelligence_presets: [] }] });
  assert.deepEqual(catalog.models.map(model => model.slug), ['gpt-6-astra-wm', 'gpt-5-6', 'gpt-6-pro']);
  assert.deepEqual(catalog.models[0].efforts.map(item => item.effort), ['medium', 'xhigh']);
  assert.equal(catalog.models[0].defaultEffort, 'medium');
  const source = { base_instructions: 'You are Codex, an agent based on GPT-5. Keep repository instructions.', model_messages: { instructions_template: 'You are Codex, a coding agent based on GPT-5.6 Sol. Keep approval rules.' } };
  const neutral = neutralInstructions(source);
  assert.ok(!JSON.stringify(neutral).includes('based on GPT'));
  assert.ok(neutral.base_instructions.endsWith('Keep repository instructions.'));
  assert.ok(neutral.model_messages.instructions_template.endsWith('Keep approval rules.'));
  assert.ok(source.base_instructions.includes('based on GPT-5'), 'The native template is not mutated.');
});
test('model response receipts handle complete and delta metadata without extracting response text', () => {
  const { responseModelMetadata } = require('../../backend/codexWebModelDiscovery.cjs');
  const response = [
    { message: { metadata: { model_slug: 'gpt-6-astra-wm' }, content: { parts: ['SECRET response text mentioning model_slug and gpt-other'] } } },
    { v: [{ p: '/message/metadata/model_slug', o: 'replace', v: 'gpt-6-pro' }] },
  ].map(value => 'data: ' + JSON.stringify(value)).join('\n');
  assert.deepEqual(responseModelMetadata(response), ['gpt-6-astra-wm', 'gpt-6-pro']);
});

test('response verification reads resolved server models and ignores requested names and assistant prose', () => {
  const { responseModels } = require('../../backend/codexWebModelVerification.cjs');
  const response = [{ v: { message: { author: { role: 'assistant' }, metadata: { resolved_model_slug: 'gpt-5-6', model_slug: 'gpt-5-6', default_model_slug: 'gpt-6-astra-wm' }, content: { parts: ['I am GPT-6 Astra.', { model_slug: 'gpt-6-astra-wm' }] } } } }];
  assert.deepEqual(responseModels(response), ['gpt-5-6']);
  assert.deepEqual(responseModels([{ default_model_slug: 'gpt-6-astra-wm', intended_default_model_slug: 'gpt-6-astra-wm', model: 'gpt-6-astra-wm' }]), []);
  assert.deepEqual(responseModels([{ message: { author: { role: 'user' }, metadata: { model_slug: 'gpt-user-claim' } } }]), []);
  assert.deepEqual(responseModels([{ v: [{ p: '/message/metadata', v: { resolved_model_slug: 'gpt-5-5-thinking' } }] }]), ['gpt-5-5-thinking']);
  assert.deepEqual(responseModels([{ p: '/message/metadata/model_slug', v: 'gpt-5-6-thinking' }]), ['gpt-5-6-thinking']);
});

test('WebSocket verification follows live stream items and subscription catchups without mixing topics', async () => {
  const { EventEmitter } = require('node:events');
  const { createResponseVerifier, topicModels } = require('../../backend/codexWebModelVerification.cjs');
  const page = new EventEmitter(), session = new EventEmitter();
  session.send = async () => {}; session.detach = async () => {};
  page.context = () => ({ newCDPSession: async () => session });
  const verifier = await createResponseVerifier(page), evidence = [];
  const item = (topic, model) => ({ type: 'message', topic_id: topic, payload: { type: 'conversation-turn-stream', payload: { encoded_item: 'data: ' + JSON.stringify({ v: { message: { author: { role: 'assistant' }, metadata: { resolved_model_slug: model, default_model_slug: 'gpt-6-astra-wm' } } } }) + '\n\n' } } });
  const received = value => session.emit('Network.webSocketFrameReceived', { response: { payloadData: JSON.stringify(value) } });
  const handoff = topic => 'data: ' + JSON.stringify({ type: 'stream_handoff', options: [{ type: 'subscribe_ws_topic', topic_id: topic }] });
  const request = {};
  verifier.begin(request, model => model === 'gpt-6-astra-wm', value => evidence.push(value));
  received([item('other-pane', 'gpt-5-6')]);
  assert.equal(verifier.isVerified(), false);
  page.emit('response', { request: () => request, text: async () => handoff('owned') });
  await new Promise(resolve => setImmediate(resolve));
  received([{ type: 'reply', reply: { type: 'subscribe', catchups: [item('owned', 'gpt-5-6')] } }]);
  await assert.rejects(verifier.verify(), /model_response_mismatch/);
  assert.equal(evidence.at(-1).responseVerified, false);
  assert.deepEqual(evidence.at(-1).responseModels, ['gpt-5-6']);
  assert.throws(() => verifier.isVerified(), /model_response_mismatch/);
  assert.deepEqual(topicModels(JSON.stringify([{ type: 'message', topic_id: 'owned', payload: { type: 'conversation-created', payload: { model_slug: 'gpt-6-astra-wm' } } }])), []);
  const next = {};
  verifier.begin(next, model => model === 'gpt-5-6', value => evidence.push(value));
  // A delayed completion belonging to the previous request cannot verify this one.
  page.emit('response', { request: () => request, text: async () => handoff('owned') });
  received([item('owned', 'gpt-6-astra-wm')]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(verifier.isVerified(), false);
  received([item('new-owned', 'gpt-5-6')]);
  page.emit('response', { request: () => next, text: async () => handoff('new-owned') });
  await verifier.verify();
  assert.equal(verifier.isVerified(), true);
  assert.equal(evidence.at(-1).responseVerified, true);
  const aliasRequest = {};
  verifier.begin(aliasRequest, model => model === 'gpt-5-6', value => evidence.push(value));
  page.emit('response', { request: () => aliasRequest, text: async () => handoff('alias-owned') });
  await new Promise(resolve => setImmediate(resolve));
  const preliminary = item('alias-owned', 'gpt-5-6');
  preliminary.payload.payload.encoded_item = 'data: ' + JSON.stringify({ v: { message: { author: { role: 'assistant' }, metadata: { model_slug: 'gpt-5-6-auto-thinking' } } } });
  received([preliminary]);
  assert.equal(verifier.isVerified(), false, 'A preliminary routing alias cannot release response text.');
  received([item('alias-owned', 'gpt-5-6')]);
  await verifier.verify(); assert.equal(verifier.isVerified(), true);
  assert.deepEqual(evidence.at(-1).responseModels, ['gpt-5-6'], 'The resolved backend overrides the preliminary model alias.');
});

test('HTTP SSE verifies a reported model but requested-only and missing metadata fail closed', async () => {
  const { EventEmitter } = require('node:events');
  const { createResponseVerifier } = require('../../backend/codexWebModelVerification.cjs');
  const page = new EventEmitter(), session = new EventEmitter(); session.send = async () => {}; session.detach = async () => {};
  page.context = () => ({ newCDPSession: async () => session });
  const verifier = await createResponseVerifier(page), request = {};
  verifier.begin(request, model => model === 'gpt-5-5-thinking', () => {});
  page.emit('response', { request: () => request, text: async () => 'data: ' + JSON.stringify({ default_model_slug: 'gpt-5-5-thinking' }) });
  await assert.rejects(verifier.verify(5), /model_response_unverified/);
  page.emit('response', { request: () => request, text: async () => 'data: ' + JSON.stringify({ v: { message: { author: { role: 'assistant' }, metadata: { model_slug: 'gpt-5-5-thinking' } } } }) });
  await verifier.verify(); assert.equal(verifier.isVerified(), true);
});

test('Work requires the actual Work model and cannot accept a Chat or Instant fallback', t => {
  const directory = identityCatalog(t);
  const { accountModel, responseModelSlugs } = require('../../backend/codexWebModelDiscovery.cjs');
  const file = path.join(directory, 'lina-account-models.json'), catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  catalog.models.push({ slug: 'gpt-5-6', title: 'GPT-5.6 Sol', reasoningType: 'auto' }, { slug: 'gpt-5-6-instant', title: 'GPT-5.6 Sol', reasoningType: 'none' });
  fs.writeFileSync(file, JSON.stringify(catalog));
  const astra = responseModelSlugs(accountModel('gpt-6-astra')), sol = responseModelSlugs(accountModel('gpt-5.6-sol'));
  assert.equal(astra.has('gpt-5-6'), false); assert.equal(astra.has('gpt-6-astra-wm'), true);
  assert.equal(sol.has('gpt-5-6'), false); assert.equal(sol.has('gpt-5-6-instant'), false);
  assert.equal(astra.has('gpt-5-6-auto-thinking'), false); assert.equal(sol.has('gpt-5-6-auto-thinking'), false);
  assert.equal(responseModelSlugs(accountModel('gpt-5.6-sol-thinking')).has('gpt-5-6-auto-thinking'), true);
});

test('HTTP model metadata is available before SSE closes and CDP chunks stay bound to the exact routed request', async () => {
  const { EventEmitter } = require('node:events');
  const { createResponseVerifier } = require('../../backend/codexWebModelVerification.cjs');
  const page = new EventEmitter(), session = new EventEmitter(); let release;
  session.send = async method => method === 'Network.streamResourceContent' ? new Promise(resolve => { release = resolve; }) : {};
  session.detach = async () => {}; page.context = () => ({ newCDPSession: async () => session });
  const verifier = await createResponseVerifier(page), body = '{"model":"gpt-5-5-thinking","messages":[{"id":"owned"}]}';
  const request = { postData: () => body };
  session.emit('Network.requestWillBeSent', { requestId: 'http-owned', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation', postData: body } });
  verifier.begin(request, slug => slug === 'gpt-5-5-thinking', () => {});
  page.emit('response', { request: () => request, text: () => new Promise(() => {}) });
  session.emit('Network.responseReceived', { requestId: 'http-owned' });
  const event = 'data: ' + JSON.stringify({ v: { message: { author: { role: 'assistant' }, metadata: { model_slug: 'gpt-5-5-thinking' } } } }) + '\n\n';
  // A new chunk may arrive before streamResourceContent returns its old buffer.
  session.emit('Network.dataReceived', { requestId: 'http-owned', data: Buffer.from(event.slice(40)).toString('base64') });
  release({ bufferedData: Buffer.from(event.slice(0, 40)).toString('base64') });
  await verifier.verify(); assert.equal(verifier.isVerified(), true);
  verifier.begin({ postData: () => body.replace('owned', 'next') }, slug => slug === 'gpt-5-5-thinking', () => {});
  session.emit('Network.responseReceived', { requestId: 'http-owned' });
  session.emit('Network.dataReceived', { requestId: 'http-owned', data: Buffer.from(event).toString('base64') });
  await assert.rejects(verifier.verify(5), /model_response_unverified/);
});
