'use strict';
// Real OpenRouter/default interpreter; every terminal adapter is synthetic.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const DEFAULT_MODELS = ['google/gemini-3.8-flash', 'inception/mercury-2.5', 'z-ai/glm-5.3-flash', 'nvidia/nemotron-3.5-lightning'];
const SCENARIOS = [{ name: 'greeting', text: 'Say hello in one sentence.' }, { name: 'focus', text: 'Focus the terminal named Atlas.' }];
function parseArgs(args) {
  const config = { models: [], budget: 0.25, live: false, selfTest: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--live') config.live = true;
    else if (arg === '--self-test') config.selfTest = true;
    else if (arg === '--model') { const model = args[++i]; if (!model || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(model)) throw Error('Invalid --model'); config.models.push(model); }
    else if (arg === '--budget') { const value = args[++i]; config.budget = Number(value); if (!value || !Number.isFinite(config.budget) || config.budget <= 0 || config.budget > 0.25) throw Error('--budget must be greater than zero and at most 0.25 USD'); }
    else throw Error('Unknown argument');
  }
  if (config.live === config.selfTest) throw Error('Specify exactly one of --live or --self-test');
  config.models = [...new Set(config.models.length ? config.models : DEFAULT_MODELS)];
  if (config.models.length > 12) throw Error('At most 12 models per run');
  return config;
}
function createBudget(limit) {
  let reserved = 0;
  return {
    get reserved() { return reserved; },
    reserve(body, pricing) {
      if (!pricing || ![pricing.prompt, pricing.completion, pricing.request].every(value => Number.isFinite(value) && value >= 0)) throw Error('Model pricing unavailable');
      const tokens = Number(body.max_tokens ?? body.max_completion_tokens);
      if (!Number.isFinite(tokens) || tokens <= 0) throw Error('Bounded output token limit required');
      const estimate = 4 * ((Buffer.byteLength(JSON.stringify(body), 'utf8') + 4096) * pricing.prompt + tokens * pricing.completion + pricing.request);
      if (!Number.isFinite(estimate) || reserved + estimate > limit) throw Error('Budget cannot cover the next conservative reservation');
      reserved += estimate; return estimate;
    },
    settle(reservation, cost) { if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) reserved = Math.max(0, reserved + cost - reservation); },
  };
}
function createFixture(cwd) {
  const actions = [];
  const session = { id: 'atlas', name: 'Atlas', title: 'Atlas', kind: 'codex', provider: 'codex', generation: 1, cwd, status: 'running', turnState: 'idle' };
  return {
    session, actions,
    readSession: async () => ({ ok: true, id: 'atlas', generation: 1, text: 'Synthetic Atlas terminal is idle.', sequence: 1, inputRevision: 0, inputState: { kind: 'empty', hasText: false } }),
    dispatchAction: async action => {
      // Record attempts before validation, including forbidden effects.
      actions.push({ kind: action.kind, targetId: action.targetId || action.target?.id, generation: action.generation ?? action.target?.generation });
      assert.equal(action.kind, 'focus_session', 'Only synthetic focus is permitted');
      assert.equal(actions.at(-1).targetId, 'atlas'); assert.equal(actions.at(-1).generation, 1);
      return { ok: true, status: 'focused', id: 'atlas', generation: 1 };
    },
  };
}
function verifyCase(name, result, actions) {
  assert.equal(result.ok, true, 'Orchestrator request failed');
  if (name === 'greeting') { assert.ok(typeof result.text === 'string' && result.text.trim(), 'Greeting reply is empty'); assert.equal(actions.length, 0); }
  else { assert.equal(actions.length, 1); assert.deepEqual(actions[0], { kind: 'focus_session', targetId: 'atlas', generation: 1 }); }
}
async function selfTest() {
  assert.throws(() => parseArgs([])); assert.throws(() => parseArgs(['--live', '--self-test']));
  for (const value of ['0', '-1', '0.251', 'NaN', 'Infinity']) assert.throws(() => parseArgs(['--live', '--budget', value]));
  assert.throws(() => parseArgs(['--live', '--model'])); assert.throws(() => parseArgs(['--live', '--unknown']));
  assert.deepEqual(parseArgs(['--live', '--model', 'a/b', '--model', 'c/d', '--budget', '0.1']).models, ['a/b', 'c/d']);
  const guard = createBudget(0.25), body = { messages: [], max_tokens: 10 }, pricing = { prompt: 0.000001, completion: 0.000002, request: 0 };
  const reserved = guard.reserve(body, pricing); assert.ok(reserved > 0); guard.settle(reserved, undefined); assert.equal(guard.reserved, reserved);
  guard.settle(reserved, null); assert.equal(guard.reserved, reserved); guard.settle(reserved, 0.001); assert.ok(Math.abs(guard.reserved - 0.001) < 1e-12);
  assert.throws(() => guard.reserve(body, { ...pricing, request: 1 })); assert.throws(() => guard.reserve(body)); assert.throws(() => guard.reserve({ messages: [] }, pricing));
  const fixture = createFixture('synthetic'); verifyCase('greeting', { ok: true, text: 'Hello.' }, fixture.actions);
  assert.equal((await fixture.readSession()).id, 'atlas'); await fixture.dispatchAction({ kind: 'focus_session', targetId: 'atlas', target: { generation: 1 } });
  verifyCase('focus', { ok: true }, fixture.actions);
  await assert.rejects(fixture.dispatchAction({ kind: 'send_prompt', targetId: 'atlas', generation: 1 }));
  assert.throws(() => verifyCase('greeting', { ok: true, text: 'Hello.' }, fixture.actions));
  const tempBase = path.resolve(require('node:os').tmpdir());
  const testHome = fs.mkdtempSync(path.join(tempBase, 'vibe-model-compatibility-selftest-'));
  const coreFixture = createFixture(testHome), { createOrchestrator } = require('../../backend/orchestrator.cjs');
  let chatCalls = 0;
  const core = createOrchestrator({ userDataPath: testHome, getSessions: async () => [coreFixture.session], getRoots: async () => ({ documents: testHome, projects: [] }), readSession: coreFixture.readSession, dispatchAction: coreFixture.dispatchAction,
    fetch: async (url, options) => {
      let data;
      if (url.endsWith('/key')) data = { data: {} };
      else if (url.endsWith('/models')) data = { data: [{ id: 'fixture/model', context_length: 128000, supported_parameters: ['tools', 'tool_choice'] }] };
      else {
        assert.ok(url.endsWith('/chat/completions')); chatCalls++;
        const body = JSON.parse(options.body); assert.equal(body.tools?.[0]?.function?.name, 'interpret_workspace');
        assert.equal(body.tool_choice, 'auto');
        data = { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'fixture-intent', type: 'function', function: { name: 'interpret_workspace', arguments: JSON.stringify({ goal: 'Focus Atlas.', executionMode: 'direct', actions: [{ kind: 'focus_session', targetIds: ['atlas'] }] }) } }] } }] };
      }
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  try {
    await core.configure({ apiKey: 'synthetic-test-key', sessionOnly: true, model: 'fixture/model' });
    assert.equal((await core.setEnabled(true)).ok, true);
    verifyCase('focus', await core.send({ text: SCENARIOS[1].text, origin: 'text' }), coreFixture.actions); assert.equal(chatCalls, 1);
  } finally {
    await core.dispose();
    const resolved = path.resolve(testHome); assert.ok(resolved.startsWith(tempBase + path.sep) && path.basename(resolved).startsWith('vibe-model-compatibility-selftest-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  console.log('Compatibility harness self-test passed; no Electron, credentials, or network used.');
}
async function live(config) {
  const { app, safeStorage } = require('electron');
  const root = path.resolve(__dirname, '../..');
  const run = path.join(root, '.tmp', 'orchestrator-model-compatibility-live', `${Date.now()}-${process.pid}`);
  const electronHome = path.join(run, 'electron'); app.setPath('userData', electronHome);
  if (!process.env.APPDATA) throw Error('APPDATA unavailable');
  const installedRoot = path.join(process.env.APPDATA, 'vibe-terminal');
  const localState = path.join(installedRoot, 'Local State');
  if (fs.existsSync(localState)) {
    const { os_crypt } = JSON.parse(fs.readFileSync(localState, 'utf8'));
    if (os_crypt) { fs.mkdirSync(electronHome, { recursive: true }); fs.writeFileSync(path.join(electronHome, 'Local State'), JSON.stringify({ os_crypt })); }
  }
  const version = require('../../package.json').version;
  const sourceSha256 = createHash('sha256').update(fs.readFileSync(path.join(root, 'backend/orchestrator.cjs'))).digest('hex');
  const report = { boundary: 'Current source/default interpreter and real OpenRouter; synthetic Atlas session/adapters only. No real terminal effects or installed preferences writes. Does not verify installed build behavior.', version, sourceSha256, budgetUsd: config.budget, reservationHeadroom: 4, accountingBoundary: 'Catalog pricing with 4x headroom is an estimate, not a provider-enforced billing cap; missing cost retains the reservation.', timingBoundary: 'calls.headersMs measures actual fetch headers; case diagnostic headersMs includes wrapper JSON accounting time.', selectedModels: config.models, startedAt: new Date().toISOString(), cases: [], calls: [] };
  const budget = createBudget(config.budget), catalog = new Map();
  let secret = '', relay, controller, currentRow, stopped = false;
  const safeString = value => typeof value === 'string' ? value.split(secret || '\0').join('[REDACTED]').replace(/\bBearer\s+[^\s,"';}]+/gi, 'Bearer [REDACTED]').replace(/\b(?:sk|pk)-(?:[a-z0-9]+-)*[a-z0-9_-]{8,}/gi, '[REDACTED]').slice(0, 256) : undefined;
  const { classifyTransportError, classifyOpenRouterError } = require('../../backend/openRouterErrors.cjs');
  const request = async (url, options = {}) => {
    assert.ok(url.startsWith('https://openrouter.ai/api/v1/'), 'Unexpected live endpoint');
    const isChat = url.endsWith('/chat/completions'), body = options.body ? JSON.parse(options.body) : undefined;
    let reservation = 0;
    if (isChat) {
      try { reservation = budget.reserve(body, catalog.get(body.model)); }
      catch { stopped = true; currentRow.category = 'budget-or-pricing'; throw Error('Live budget/pricing guard stopped the request'); }
    }
    const started = Date.now(), signal = controller?.signal && options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller?.signal || options.signal;
    const call = isChat ? { case: currentRow.name, requestedModel: safeString(body.model), reservationUsd: reservation, toolChoice: typeof body.tool_choice === 'string' ? safeString(body.tool_choice) : body.tool_choice ? 'named' : 'omitted', reasoningRequested: Boolean(body.reasoning), stream: body.stream === true, maxTokens: body.max_tokens ?? body.max_completion_tokens } : null;
    try {
      const response = await fetch(url, { ...options, signal });
      if (call) { call.headersMs = Date.now() - started; call.httpStatus = response.status; }
      const data = await response.clone().json();
      if (url.endsWith('/models') && Array.isArray(data.data)) for (const item of data.data) {
        const pricing = item.pricing; if (pricing) catalog.set(item.id, { prompt: Number(pricing.prompt), completion: Number(pricing.completion), request: Number(pricing.request || 0) });
      }
      if (call) {
        budget.settle(reservation, data.usage?.cost);
        if (typeof data.usage?.cost === 'number' && Number.isFinite(data.usage.cost) && data.usage.cost >= 0) call.costUsd = data.usage.cost;
        else call.costUnreported = true;
        call.model = safeString(data.model); call.provider = safeString(data.provider); call.generationId = safeString(data.id || response.headers.get('x-generation-id'));
        for (const [name, value] of Object.entries({ promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens, reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens })) if (typeof value === 'number' && Number.isFinite(value) && value >= 0) call[name] = Math.min(value, 1e9);
        if (!response.ok || data.error) { const error = classifyOpenRouterError(response.status, data); call.category = error.category; call.reason = error.reason; }
        else call.category = 'success';
      }
      return response;
    } catch (error) {
      if (call) { const typed = classifyTransportError(error instanceof SyntaxError && call.httpStatus ? classifyOpenRouterError(call.httpStatus, null) : error, { signal: controller?.signal, timeoutSignal: options.signal?.reason?.name === 'TimeoutError' ? options.signal : undefined }); call.category = typed.name === 'AbortError' ? 'cancelled' : typed.category; call.reason = typed.reason; }
      throw error;
    } finally { if (call) { call.elapsedMs = Date.now() - started; report.calls.push(call); } }
  };
  try {
    await app.whenReady();
    const { createSettings } = require('../../backend/orchestratorSettings.cjs');
    const { createOrchestrator } = require('../../backend/orchestrator.cjs');
    secret = createSettings({ userDataPath: installedRoot, secureStorage: safeStorage }).getKey();
    assert.ok(secret, 'Installed key unavailable through safeStorage');
    for (const model of config.models) for (const scenario of SCENARIOS) {
      const row = { model, name: scenario.name, ok: false }; report.cases.push(row); currentRow = row;
      if (stopped || budget.reserved >= config.budget) { stopped = true; row.category = 'skipped-budget'; continue; }
      const started = Date.now(), userDataPath = path.join(run, `case-${report.cases.length}`), fixture = createFixture(run);
      controller = new AbortController();
      const timer = setTimeout(() => { row.category = 'case-timeout'; controller.abort(); void relay?.cancel(); }, 90000);
      try {
        relay = createOrchestrator({ userDataPath, fetch: request, getSessions: async () => [{ ...fixture.session }], getRoots: async () => ({ documents: run, projects: [] }), readSession: fixture.readSession, dispatchAction: fixture.dispatchAction });
        assert.equal((await relay.configure({ apiKey: secret, sessionOnly: true, model, spendingLimit: Math.max(0, config.budget - budget.reserved) })).ok, true);
        const enabled = await relay.setEnabled(true);
        if (!enabled.ok) row.category ||= enabled.upstreamError?.category || 'model-setup';
        assert.equal(enabled.ok, true, 'Model setup failed');
        const result = await relay.send({ text: scenario.text, origin: 'text' });
        row.category ||= result.upstreamError?.category || (result.ok ? 'success' : result.status || 'orchestration');
        row.replyNonempty = Boolean(typeof result.text === 'string' && result.text.trim());
        if (result.ok) row.category = 'validation';
        verifyCase(scenario.name, result, fixture.actions); row.ok = true; row.category = 'success';
      } catch { row.category ||= 'validation-or-setup'; }
      finally {
        clearTimeout(timer); await relay?.dispose(); relay = undefined; controller = undefined;
        row.elapsedMs = Date.now() - started; row.actions = fixture.actions;
        const logs = path.join(userDataPath, 'logs', 'orchestrator-errors.jsonl');
        row.timings = fs.existsSync(logs) ? fs.readFileSync(logs, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => ['model_started', 'model_headers', 'model_complete'].includes(event.stage)).map(event => Object.fromEntries(Object.entries(event).filter(([key]) => ['stage', 'modelCallId', 'model', 'status', 'category', 'reason', 'elapsedMs', 'headersMs', 'bodyMs', 'deadlineMs', 'attempt', 'toolChoice', 'requestPhase', 'provider', 'generationId', 'promptTokens', 'completionTokens', 'reasoningTokens', 'httpStatus'].includes(key)))) : [];
        console.log(JSON.stringify({ model, case: row.name, ok: row.ok, category: row.category, elapsedMs: row.elapsedMs }));
      }
    }
    report.ok = report.cases.every(row => row.ok);
  } catch { report.ok = false; report.category = 'harness-setup'; }
  finally {
    await relay?.dispose(); report.reservedCostUsd = budget.reserved; report.budgetStopped = stopped; report.finishedAt = new Date().toISOString();
    fs.mkdirSync(run, { recursive: true }); const filename = path.join(run, 'report.json');
    fs.writeFileSync(filename, JSON.stringify(report, null, 2).split(secret || '\0').join('[REDACTED]'));
    console.log(JSON.stringify({ ok: report.ok, reservedCostUsd: budget.reserved, report: filename })); app.exit(report.ok ? 0 : 1);
  }
}
async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.selfTest) return selfTest();
  if (!process.versions.electron) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit', timeout: config.models.length * SCENARIOS.length * 95000 + 30000 });
    process.exitCode = child.status ?? 1; return;
  }
  await live(config);
}
main().catch(error => { if (process.argv.includes('--self-test') && !process.argv.includes('--live')) console.error(error.stack); console.error('Compatibility harness failed: check arguments, Electron, and local setup. Live mode requires --live; offline checks use --self-test.'); process.exitCode = 1; if (process.versions.electron) require('electron').app.exit(1); });
