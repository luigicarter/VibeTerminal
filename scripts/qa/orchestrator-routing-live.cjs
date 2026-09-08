'use strict';
// Actual configured Brain; only in-memory routing evidence. No terminal effects.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { planTaskRoute } = require('../../backend/orchestratorRoutePlanner.cjs');
const { fitMessages } = require('../../backend/orchestratorBudget.cjs');
const endToEnd = process.argv.includes('--end-to-end');
const cwd = 'C:/DisposableRoutingFixture';
const pane = (id, objective, patch = {}) => ({ id, generation: `generation-${id}`, launchToken: 1, provider: 'codex', kind: 'codex', cwd, conversationId: `thread-${id}`, name: objective, observation: 'observed', processState: 'running', turnState: 'completed', ...patch });
const owner = pane('task-a-owner', 'Repair billing invoices');
const other = pane('task-b-owner', 'Update documentation');
const work = (id, objective, target) => ({ id, objective, cwd, requestIds: [`request-${id}`], requiresRevalidation: false, binding: { target: { id: target.id, generation: target.generation, launchToken: 1 }, nativeIdentity: { provider: 'codex', home: 'global', workspace: cwd, id: target.conversationId } } });
const workA = work('work-a', 'Repair billing invoices', owner), workB = work('work-b', 'Update documentation', other);
function fixture(name) {
  const cases = {
    'new-task': { instruction: 'Fix invoice rounding in this project.', sessions: [], workItems: [], expected: 'create' },
    'reply-a-after-b': { instruction: 'Continue that billing fix by adding regression tests.', sessions: [other, owner], workItems: [workB, workA], replyWorkItem: workA, expected: 'reuse', target: owner.id },
    'idle-unrelated': { instruction: 'Implement invoice rounding validation.', sessions: [other], workItems: [workB], expected: 'create' },
    'busy-same-task': { instruction: 'Also cover negative invoice totals in the billing fix.', sessions: [{ ...owner, turnState: 'running', pendingInput: true }], workItems: [workA], replyWorkItem: workA, expected: 'reuse', target: owner.id },
    'explicit-fresh': { instruction: 'Start a fresh independent agent to review invoice rounding.', sessions: [owner], workItems: [workA], assignmentMode: 'new', expected: 'create' },
    'paged-owner': { instruction: 'Continue the invoice rounding repair already in progress; add its regression tests.', sessions: [...Array.from({ length: 220 }, (_, i) => pane(`unrelated-${i}`, `Unrelated archived task ${i}`)), owner], workItems: [], expected: 'reuse', target: owner.id, requireRead: true }
  };
  const selected = cases[name]; assert.ok(selected, `Unknown fixture ${name}`);
  const reads = [];
  const context = { instruction: selected.instruction, scope: { cwd, assignmentMode: selected.assignmentMode || 'auto' }, sessions: selected.sessions.slice(0, 20), workItems: selected.workItems, replyWorkItem: selected.replyWorkItem,
    sessionDirectory: { total: selected.sessions.length, truncated: selected.sessions.length > 20 }, reservations: [],
    launchers: [{ kind: 'codex', available: true, configured: true, launchReady: true, default: true }] };
  const page = (values, args) => { const query = String(args.query || '').toLowerCase(); const filtered = values.filter(v => !query || JSON.stringify(v).toLowerCase().includes(query)); const offset = args.offset || 0, limit = args.limit || 20; return { values: filtered.slice(offset, offset + limit), total: filtered.length, nextOffset: offset + limit < filtered.length ? offset + limit : null }; };
  return { context, reads,
    async read(args) {
      reads.push({ ...args });
      if (args.kind === 'list_sessions') { const p = page(selected.sessions, args); return { ok: true, sessions: p.values, total: p.total, nextOffset: p.nextOffset, truncated: p.nextOffset !== null }; }
      if (args.kind === 'list_work_items') { const p = page(selected.workItems, args); return { ok: true, items: p.values, total: p.total, nextOffset: p.nextOffset }; }
      if (args.kind === 'read_session') { const target = selected.sessions.find(s => s.id === args.targetId); assert.ok(target, 'Unknown disposable terminal'); return { ok: true, observation: { id: target.id, generation: target.generation, sequence: 1, text: target.id === owner.id ? 'User task: Repair invoice rounding in the billing module. Agent: I have fixed rounding and am adding regression coverage. This conversation is exclusively working on that billing fix.' : 'This conversation contains an unrelated documentation task and is not an unused composer.' } }; }
      if (args.kind === 'list_work') return { ok: true, items: [], nextOffset: null };
      if (args.kind === 'list_conversations') return { ok: true, conversations: [], nextOffset: null };
      if (args.kind === 'read_conversation') return { ok: false, error: 'No saved fixture reference was listed.' };
      assert.fail(`Effect or unsupported fixture operation: ${args.kind}`);
    },
    check(result) { assert.equal(result.decision, selected.expected); if (selected.target) assert.equal(result.targetId, selected.target); if (selected.expected === 'create') assert.equal(result.kindOfSession, 'codex'); if (selected.requireRead) { assert.ok(reads.some(r => r.kind === 'list_sessions')); assert.ok(reads.some(r => r.kind === 'read_session' && r.targetId === selected.target)); } }
  };
}
if (process.argv.includes('--self-test')) {
  (async () => { for (const name of ['new-task', 'reply-a-after-b', 'idle-unrelated', 'busy-same-task', 'explicit-fresh', 'paged-owner']) { const f = fixture(name); assert.ok(f.context.scope.cwd); if (name === 'paged-owner') { const p = await f.read({ kind: 'list_sessions', offset: 200, limit: 40 }); assert.ok(p.sessions.some(s => s.id === owner.id)); await f.read({ kind: 'read_session', targetId: owner.id }); f.check({ decision: 'reuse', targetId: owner.id }); } } console.log('Routing fixture self-test passed; no network or credentials.'); })().catch(error => { console.error(error.message); process.exitCode = 1; });
} else if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename, '--live-child', ...(endToEnd ? ['--end-to-end'] : [])], { env, windowsHide: true, stdio: 'inherit', timeout: 300000 }); process.exitCode = child.status ?? 1;
} else {
  const { app, safeStorage } = require('electron');
  const run = path.resolve(__dirname, '../../.tmp/orchestrator-routing-live', `${Date.now()}-${process.pid}`);
  app.setPath('userData', path.join(run, 'electron'));
  const installedRoot = path.join(process.env.APPDATA, 'vibe-terminal');
  const statePath = path.join(installedRoot, 'Local State');
  if (fs.existsSync(statePath)) { const { os_crypt } = JSON.parse(fs.readFileSync(statePath, 'utf8')); if (os_crypt) { fs.mkdirSync(path.join(run, 'electron'), { recursive: true }); fs.writeFileSync(path.join(run, 'electron', 'Local State'), JSON.stringify({ os_crypt })); } }
  const budget = Math.min(endToEnd ? 0.08 : 0.25, Math.max(0.01, Number(process.env.VIBE_LIVE_BUDGET) || (endToEnd ? 0.08 : 0.15)));
  const report = { boundary: 'Configured Brain and actual read-only route planner; in-memory disposable terminal/history evidence only. No intent-compiler, terminal creation, prompt delivery or native terminal UI validation. Ambiguous project resolution belongs upstream and is outside this harness.', budget, calls: [], cases: [] };
  if (endToEnd) report.boundary = 'Actual configured Brain through default intent compiler, route planner and operator; only disposable in-memory native terminal adapters and .tmp profile/project folders. No interpretation/routing injection, real terminal process, or installed profile mutation.';
  let secret = '', spent = 0, relay;
  const clean = value => String(value || '').split(secret || '\0').join('[REDACTED]');
  async function main() {
    await app.whenReady();
    const settings = require('../../backend/orchestratorSettings.cjs').createSettings({ userDataPath: installedRoot, secureStorage: safeStorage });
    secret = settings.getKey(); const modelId = settings.getSettings().model;
    assert.ok(secret && modelId, 'Installed Brain key/model unavailable; no account was configured.'); report.model = modelId;
    const modelResponse = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20000) });
    assert.ok(modelResponse.ok, 'Model catalog unavailable'); const catalog = await modelResponse.json(); const model = catalog.data?.find(m => m.id === modelId); assert.ok(model, 'Configured model missing from catalog');
    const prices = [model.pricing?.prompt, model.pricing?.completion, model.pricing?.request || 0].map(Number); assert.ok(prices.every(p => Number.isFinite(p) && p >= 0), 'Pricing unavailable; no unbudgeted request');
    if (endToEnd) {
      const project = path.join(run, 'checkout-project'), independent = path.join(run, 'docs-project');
      fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(independent, { recursive: true });
      const sessions = [], effects = [], reads = [];
      let scenarioSignal, scenarioName;
      const request = async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        const isModel = url.endsWith('/chat/completions'); let reserve = 0;
        if (isModel) { assert.equal(body.model, modelId, 'Unexpected model outside configured Brain pricing'); reserve = (Buffer.byteLength(JSON.stringify(body)) + 4096) * prices[0] + Number(body.max_tokens || body.max_completion_tokens || 16384) * prices[1] + prices[2]; if (spent + reserve > budget) { report.budgetBlock = { stage: body.tools?.[0]?.function?.name || 'text', accountedSpend: spent, nextReservation: reserve, budget }; throw Error('Conservative next-call reservation exceeds remaining end-to-end budget'); } spent += reserve; }
        const signal = scenarioSignal && options.signal ? AbortSignal.any([scenarioSignal, options.signal]) : scenarioSignal || options.signal;
        const response = await fetch(url, { ...options, ...(signal && { signal }) });
        if (isModel) {
          const data = await response.clone().json(); const cost = Number(data.usage?.cost);
          report.calls.push({ name: scenarioName, stage: body.tools?.[0]?.function?.name || 'text', model: data.model || body.model, status: response.status, cost: Number.isFinite(cost) ? cost : undefined, reservedCost: reserve, choices: data.choices?.map(c => ({ finishReason: c.finish_reason, text: clean(c.message?.content).slice(0, 1200), tools: c.message?.tool_calls?.map(t => ({ name: t.function?.name, arguments: clean(t.function?.arguments).slice(0, 9000) })) })), ...(!response.ok && { error: clean(data.error?.message).slice(0, 1000), providerReason: clean(data.error?.metadata?.raw).slice(0, 2500) }) });
          if (response.ok && !Number.isFinite(cost)) { spent = budget; throw Error('Provider omitted usage cost; stopped to protect budget'); }
          if (Number.isFinite(cost)) spent += cost - reserve;
          else if (response.status === 400) { spent -= reserve; Object.assign(report.calls.at(-1), { validationRejected: true, confirmedCost: 0, reservationReleased: true }); }
        }
        return response;
      };
      relay = require('../../backend/orchestrator.cjs').createOrchestrator({ userDataPath: path.join(run, 'fixture-profile'), fetch: request,
        getRoots: () => ({ documents: run, projects: [{ name: 'CheckoutFixture', path: project }, { name: 'DocsFixture', path: independent }] }),
        getSessions: () => sessions.map(s => ({ ...s })), getLaunchers: () => [{ kind: 'codex', label: 'Codex', available: true, configured: true }],
        readSession: async target => {
          const s = sessions.find(item => item.id === target.id && item.generation === target.generation); assert.ok(s, 'Unknown fixture target'); reads.push({ id: s.id, sequence: s.sequence, afterEffects: effects.length });
          return { ok: true, id: s.id, generation: s.generation, turnId: s.turnId, turnState: s.turnState, sequence: s.sequence, observationSequence: s.sequence, inputRevision: s.inputRevision,
            inputState: { kind: 'empty', hasText: false }, text: s.turnState === 'running' ? `Codex is actively working on the submitted task: ${s.lastPrompt}. Input was accepted. Empty root task composer can accept a follow-up while tools continue. No permission or question is pending. Task execution is still in progress.` : 'Codex is idle at an empty root task composer. No task has been submitted. Ready to receive a task.' };
        },
        dispatchAction: async action => {
          if (action.kind === 'create_session') {
            assert.equal(action.waitForReady, true); assert.equal(action.prompt, undefined); assert.equal(action.text, undefined);
            assert.ok([project, independent].some(root => path.resolve(root).toLowerCase() === path.resolve(action.cwd).toLowerCase()), 'Creation escaped the disposable project scope');
            const id = `fixture-worker-${sessions.length + 1}`;
            const s = { id, name: id, cwd: action.cwd, kind: 'codex', provider: 'codex', generation: `generation-${id}`, launchToken: 1, conversationId: `conversation-${id}`, started: true, status: 'idle', observation: 'observed', processState: 'running', agentProcessState: 'running', agentPid: 9000 + sessions.length, turnState: 'idle', revision: 1, sequence: 1, inputRevision: 0 };
            sessions.push(s); effects.push({ kind: action.kind, id, cwd: action.cwd, prompt: action.prompt, text: action.text });
            return { ok: true, status: 'created', id, launchToken: 1, processState: 'running', target: { id, generation: s.generation, launchToken: 1 } };
          }
          assert.equal(action.kind, 'send_prompt', `Unexpected disposable effect ${action.kind}`);
          const s = sessions.find(item => item.id === action.targetId && item.generation === action.generation); assert.ok(s, 'Submission identity changed');
          assert.equal(action.operator, true); assert.equal(action.observationSequence, s.sequence); assert.equal(action.inputRevision, s.inputRevision);
          assert.ok(!action.editInput); const wasBusy = s.turnState === 'running';
          effects.push({ kind: action.kind, targetId: s.id, text: action.text, actionId: action.actionId, wasBusy });
          Object.assign(s, { lastPrompt: action.text, actionId: action.actionId, turnId: `turn-${effects.length}`, turnStartedAt: Date.now(), turnState: 'running', status: 'running', pendingInput: false, sequence: s.sequence + 1, inputRevision: s.inputRevision + 1, revision: s.revision + 1 });
          return { ok: true, status: 'written', ...(wasBusy && { inputDisposition: 'submitted-while-running' }) };
        }
      });
      assert.equal((await relay.configure({ apiKey: secret, sessionOnly: true, model: modelId, spendingLimit: budget })).ok, true);
      assert.equal((await relay.setEnabled(true)).ok, true);
      let first;
      const cases = [
        { name: 'e2e-targetless-create', input: () => ({ text: `Fix checkout validation in ${project}.`, origin: 'text' }), check: result => { first = result; assert.deepEqual(effects.map(e => e.kind), ['create_session', 'send_prompt']); assert.ok(relay.getState().tasks.find(t => t.requestId === result.requestId)?.workItemId); } },
        { name: 'e2e-related-busy-followup', input: () => ({ text: 'Also cover expired coupons in that checkout validation fix.', replyToRequestId: first.requestId, origin: 'text' }), check: result => { assert.equal(effects.filter(e => e.kind === 'create_session').length, 1); const sends = effects.filter(e => e.kind === 'send_prompt'); assert.equal(sends.length, 2); assert.equal(sends[1].targetId, sends[0].targetId); assert.equal(sends[1].wasBusy, true); assert.equal(relay.getState().tasks.find(t => t.requestId === result.requestId)?.workItemId, relay.getState().tasks.find(t => t.requestId === first.requestId)?.workItemId); } },
        { name: 'e2e-independent-project', input: () => ({ text: `Update deployment documentation in ${independent}.`, origin: 'text' }), check: () => { assert.equal(effects.filter(e => e.kind === 'create_session').length, 2); const sends = effects.filter(e => e.kind === 'send_prompt'); assert.equal(sends.length, 3); assert.notEqual(sends[2].targetId, sends[0].targetId); } }
      ];
      const selectedEndToEnd = process.env.VIBE_LIVE_CASES ? cases.filter(scenario => process.env.VIBE_LIVE_CASES.split(',').includes(scenario.name)) : cases.slice(0, 2);
      assert.ok(selectedEndToEnd.length && selectedEndToEnd[0].name === 'e2e-targetless-create', 'End-to-end cases must start with targetless creation to establish the reply fixture.');
      for (const scenario of selectedEndToEnd) {
        scenarioName = scenario.name; const row = { name: scenario.name }, started = Date.now(); const controller = new AbortController(); scenarioSignal = controller.signal;
        const timer = setTimeout(() => { controller.abort(); void relay.cancel(); }, 70000);
        try { const result = await relay.send(scenario.input()); row.result = result; assert.equal(result.ok, true, clean(result.error || result.text)); scenario.check(result); row.ok = true; }
        catch (error) { row.ok = false; row.error = clean(error.message); if (report.budgetBlock) { row.skipped = true; row.runtimeError = row.error; row.error = 'Local QA budget stopped further model requests; this is not evidence of a provider/network or routing failure.'; } }
        finally { clearTimeout(timer); scenarioSignal = undefined; }
        row.elapsedMs = Date.now() - started; row.effects = structuredClone(effects); row.tasks = relay.getState().tasks.map(({ requestId, status, workItemId }) => ({ requestId, status, workItemId })); report.cases.push(row);
        console.log(JSON.stringify({ name: row.name, ok: row.ok, effects: effects.map(e => e.kind), error: row.error }));
        if (!row.ok) break;
      }
      report.reads = reads; report.confirmedUsageCost = report.calls.reduce((sum, call) => sum + (call.cost || 0), 0); report.ok = report.cases.length === selectedEndToEnd.length && report.cases.every(c => c.ok); return;
    }
    const selected = (process.env.VIBE_LIVE_CASES || 'new-task,reply-a-after-b,busy-same-task').split(',');
    for (const name of selected) {
      const f = fixture(name), row = { name }, started = Date.now(), signal = AbortSignal.timeout(70000);
      try {
        row.result = await planTaskRoute({ context: f.context, read: f.read, maxRounds: 8, check: () => signal.throwIfAborted(), complete: async (messages, tools) => {
          const outputTokens = 2200; const fitted = fitMessages({ messages, tools, contextLength: model.context_length, outputTokens });
          const body = { model: modelId, messages: fitted, tools, max_tokens: outputTokens, temperature: 0, ...(model.supported_parameters?.includes('reasoning') && { reasoning: { effort: 'low' } }) };
          const reservation = (Buffer.byteLength(JSON.stringify(body)) + 4096) * prices[0] + outputTokens * prices[1] + prices[2];
          assert.ok(spent + reservation <= budget, 'Conservative next-call reservation exceeds remaining live budget'); spent += reservation;
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
          const data = await response.json(); const cost = Number(data.usage?.cost);
          if (!response.ok) throw Error(`Provider response ${response.status}: ${clean(data.error?.message).slice(0, 300)}`);
          if (!Number.isFinite(cost)) { spent = budget; throw Error('Provider omitted usage cost; stopped to protect budget'); }
          spent += cost - reservation;
          report.calls.push({ name, model: data.model || modelId, cost, finishReason: data.choices?.[0]?.finish_reason }); return data;
        } });
        f.check(row.result); row.ok = true;
      } catch (error) { row.ok = false; row.error = clean(error.message); }
      row.reads = f.reads; row.elapsedMs = Date.now() - started; report.cases.push(row);
      console.log(JSON.stringify({ name, ok: row.ok, decision: row.result?.decision, reads: row.reads.length, error: row.error }));
      if (spent >= budget) break;
    }
    report.ok = report.cases.length === selected.length && report.cases.every(c => c.ok);
  }
  main().catch(error => { report.ok = false; report.error = clean(error.message); }).finally(async () => {
    await relay?.dispose();
    report.spent = spent; fs.mkdirSync(run, { recursive: true }); const file = path.join(run, 'report.json'); fs.writeFileSync(file, clean(JSON.stringify(report, null, 2)));
    console.log(JSON.stringify({ ok: report.ok, model: report.model, cases: report.cases.length, calls: report.calls.length, spent, report: file, error: report.error })); app.exit(report.ok ? 0 : 1);
  });
}
