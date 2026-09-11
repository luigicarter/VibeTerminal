'use strict';
// Actual configured model + default interpreter; only disposable in-memory panes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createPane, providerScenarios } = require('./orchestrator-terminal-inspection-fixture.cjs');
const scenarios = [
  { name: 'codex-local-usage', kind: 'codex', mode: 'usage', text: 'How much Codex usage do I have left?' },
  { name: 'claude-local-usage', kind: 'claude', mode: 'usage', text: 'What are my Claude Code usage limits and reset times?' },
  { name: 'passive-review-result', kind: 'codex', mode: 'passive', text: 'Read Atlas and tell me its existing review result.' },
  { name: 'gemini-local-usage', kind: 'gemini', mode: 'usage', optional: true, requiredFacts: ['83', '14'], text: 'How much Gemini CLI usage and quota do I have left?' },
  { name: 'kimi-local-usage', kind: 'kimi', mode: 'usage', optional: true, text: 'What are my Kimi CLI usage and remaining limits?' },
  { name: 'grok-session-status', kind: 'grok', mode: 'usage', optional: true, requiredFacts: ['grok-code-fast-1', '6800'], text: 'What model and context usage does my Grok Build session have?' },
  { name: 'grok-usage-menu', kind: 'grok', mode: 'credits-menu', optional: true, requiredFacts: ['64', '22:45'], text: 'How much Grok Build usage do I have left, and when does it reset?' },
  { name: 'qwen-session-stats', kind: 'qwen', mode: 'usage', optional: true, text: 'What is my Qwen Code usage, and can you see my plan quota?' },
  { name: 'cursor-activity', kind: 'cursor', mode: 'usage', optional: true, text: 'What usage does Cursor Agent show, and does it include my remaining quota?' },
  { name: 'opencode-status', kind: 'opencode', mode: 'usage', optional: true, text: 'What does OpenCode status show, and is my plan quota visible there?' }
];
const caseIndex = process.argv.indexOf('--case');
const caseName = caseIndex >= 0 ? process.argv[caseIndex + 1] : undefined;
if (caseIndex >= 0 && !scenarios.some(scenario => scenario.name === caseName)) {
  console.error(`Unknown or missing --case. Choose: ${scenarios.map(scenario => scenario.name).join(', ')}`); process.exit(1);
}
// Additional providers are individually opt-in so the default run retains its
// original three-case cost envelope. The USD cap applies across selected cases.
const selectedScenarios = caseName ? scenarios.filter(scenario => scenario.name === caseName) : process.argv.includes('--all') ? scenarios : scenarios.filter(scenario => !scenario.optional);
if (process.argv.includes('--self-test')) {
  for (const kind of Object.keys(providerScenarios)) {
    const sample = createPane('Atlas', kind, 'fixture'); const observed = sample.read();
    sample.dispatch({ kind: 'terminal_interact', targetId: 'Atlas', generation: 'fixture-1', operator: true, observationSequence: observed.sequence, inputRevision: observed.inputRevision, text: sample.command, submit: true });
    assert.equal(sample.read().text.includes(sample.facts), true); assert.equal(sample.observedUsage, true);
  }
  const pane = createPane('Atlas', 'claude', 'fixture', 'menu');
  for (const controls of [{ text: '/usage', submit: true }, { keys: ['right'] }, { keys: ['escape'] }]) {
    const observed = pane.read();
    pane.dispatch({ kind: 'terminal_interact', targetId: 'Atlas', generation: 'fixture-1', operator: true, observationSequence: observed.sequence, inputRevision: observed.inputRevision, ...controls });
  }
  pane.read(); assert.equal(pane.done, true); assert.equal(pane.session.turnState, 'idle');
  assert.throws(() => pane.dispatch({ kind: 'send_prompt', targetId: 'Atlas', generation: 'fixture-1' }));
  console.log('Inspection fixture self-test passed; no Electron, credentials, or network used.'); process.exit(0);
}
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename, '--live-child', ...(caseName ? ['--case', caseName] : []), ...(process.argv.includes('--all') ? ['--all'] : [])], { env, windowsHide: true, stdio: 'inherit', timeout: 420000 });
  process.exit(child.status ?? 1);
}
const { app, safeStorage } = require('electron');
const run = path.resolve(__dirname, '../../.tmp/orchestrator-terminal-inspection-live', `${Date.now()}-${process.pid}`);
app.setPath('userData', path.join(run, 'electron'));
const installedRoot = path.join(process.env.APPDATA, 'vibe-terminal');
const localState = path.join(installedRoot, 'Local State');
if (fs.existsSync(localState)) {
  const { os_crypt } = JSON.parse(fs.readFileSync(localState, 'utf8'));
  if (os_crypt) { fs.mkdirSync(path.join(run, 'electron'), { recursive: true }); fs.writeFileSync(path.join(run, 'electron', 'Local State'), JSON.stringify({ os_crypt })); }
}
const requestedBudget = Number(process.env.VIBE_LIVE_BUDGET || 0.25);
const budget = Number.isFinite(requestedBudget) && requestedBudget > 0 ? Math.min(requestedBudget, 0.25) : 0.25;
const report = { boundary: 'Actual configured Brain/default interpreter; disposable in-memory adapters and explicitly synthetic provider screens only. Does not verify physical CLI rendering. No real terminals or account changes.', spendingLimit: budget, selectedCases: selectedScenarios.map(scenario => scenario.name), cases: [], calls: [], startedAt: new Date().toISOString() };
let relay, secret = '', spent = 0, pricing, model, scenarioSignal;
const clean = value => String(value || '').split(secret || '\0').join('[REDACTED]');
async function request(url, options) {
  const body = options?.body ? JSON.parse(options.body) : undefined;
  const isModel = url.endsWith('/chat/completions');
  let reservation = 0;
  if (isModel) {
    assert.ok(pricing, 'Selected model pricing unavailable; refusing unbudgeted live request');
    const inputUpper = Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools }), 'utf8') + 4096;
    const reserve = inputUpper * pricing.prompt + Number(body.max_tokens || body.max_completion_tokens || 16384) * pricing.completion + pricing.request;
    assert.ok(spent + reserve <= budget, `Remaining budget cannot cover conservative next-request reservation (${reserve.toFixed(6)} USD)`);
    reservation = reserve; spent += reservation;
  }
  const start = Date.now();
  const signal = scenarioSignal && options.signal ? AbortSignal.any([scenarioSignal, options.signal]) : scenarioSignal || options.signal;
  const response = await fetch(url, { ...options, ...(signal && { signal }) });
  const data = await response.clone().json();
  if (url.endsWith('/models')) {
    const selected = data.data?.find(item => item.id === model);
    if (selected?.pricing) {
      const prompt = Number(selected.pricing.prompt), completion = Number(selected.pricing.completion), perRequest = Number(selected.pricing.request || 0);
      if ([prompt, completion, perRequest].every(value => Number.isFinite(value) && value >= 0)) pricing = { prompt, completion, request: perRequest };
    }
  }
  if (isModel) {
    const cost = Number(data.usage?.cost);
    const reportedCost = Number.isFinite(cost) && cost >= 0;
    // The conservative maximum was reserved before dispatch. When upstream
    // omits accounting, retain that entire reservation and still inspect its
    // response; missing cost data is not a terminal/navigation failure.
    if (reportedCost) spent += cost - reservation;
    report.calls.push({ stage: body.tools?.[0]?.function?.name === 'interpret_workspace' ? 'interpretation' : 'operation', model: data.model || body.model, status: response.status, elapsedMs: Date.now() - start, cost: reportedCost ? cost : undefined, ...(!reportedCost && { reservedCost: reservation, costUnreported: true }),
      choices: data.choices?.map(choice => ({ finishReason: choice.finish_reason, text: clean(choice.message?.content).slice(0, 2000), tools: choice.message?.tool_calls?.map(tool => { try { const args = JSON.parse(tool.function.arguments); return { tool: tool.function.name, kind: args.kind, responseKind: args.responseKind, goal: args.goal, actions: args.actions?.map(action => ({ kind: action.kind, fields: Object.keys(action).filter(field => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field)), targetIds: action.targetIds, answerMode: action.answerMode })), targetId: args.targetId, text: clean(args.text).slice(0, 1200), keys: args.keys, outcome: args.outcome }; } catch { return { tool: tool.function.name, malformedArguments: true }; } }) })), ...(!response.ok && { error: clean(data.error?.message).slice(0, 1000) }) });
  }
  return response;
}

async function main() {
  await app.whenReady(); fs.mkdirSync(run, { recursive: true });
  const { createSettings } = require('../../backend/orchestratorSettings.cjs');
  const { createOrchestrator } = require('../../backend/orchestrator.cjs');
  const installed = createSettings({ userDataPath: installedRoot, secureStorage: safeStorage });
  secret = installed.getKey(); report.configuredModel = installed.getSettings().model;
  model = process.env.VIBE_LIVE_MODEL || report.configuredModel;
  assert.ok(secret && model, 'Installed key/model unavailable through safeStorage'); report.model = model;
  for (const scenario of selectedScenarios) {
    if (spent >= budget) throw Error('Live budget exhausted');
    const started = Date.now(), pane = createPane('Atlas', scenario.kind, path.join(run, scenario.name), scenario.mode);
    const row = { name: scenario.name, kind: scenario.kind, syntheticCommand: pane.command, syntheticFacts: pane.facts, actions: pane.actions, reads: pane.reads };
    const controller = new AbortController(); scenarioSignal = controller.signal;
    const timer = setTimeout(() => { controller.abort(); relay?.cancel(); }, 90000);
    try {
      relay = createOrchestrator({ userDataPath: path.join(run, scenario.name, 'userData'), fetch: request,
        getRoots: () => ({ documents: run, projects: [{ name: 'Fixture', path: pane.session.cwd }] }), getSessions: () => [{ ...pane.session }],
        readSession: async input => { assert.equal(input.id, pane.session.id); return pane.read(); },
        dispatchAction: async action => pane.dispatch(action) });
      assert.equal((await relay.configure({ apiKey: secret, sessionOnly: true, model, spendingLimit: budget - spent })).ok, true);
      assert.equal((await relay.setEnabled(true)).ok, true);
      const result = await relay.send({ text: scenario.text, origin: 'text' });
      row.result = { ok: result.ok, text: clean(result.text), error: clean(result.error), status: result.status };
      assert.equal(result.ok, true, clean(result.error || result.text));
      assert.notEqual(result.text, 'done', 'Inspection must retain the observed facts');
      assert.equal(pane.session.turnState, 'idle', 'Inspection must not create a task lifecycle');
      assert.ok(pane.reads.length > 0, 'Must read the terminal');
      if (scenario.mode === 'passive') {
        assert.equal(pane.actions.length, 0); assert.match(result.text, /2|two/i); assert.match(result.text, /defect/i);
      } else {
        assert.equal(pane.done, true, 'No usage screen was reached');
        assert.equal(pane.observedUsage, true, 'Usage figures were never read from the usage screen');
        assert.ok(pane.actions.length > 0); assert.ok(pane.reads.some(read => read.afterActions === pane.actions.length), 'No post-action verification read');
        const comparableText = result.text.replace(/(?<=\d),(?=\d{3}\b)/g, '');
        for (const value of scenario.requiredFacts || pane.requiredFacts) assert.ok(comparableText.includes(value), `Missing observed usage fact ${value}`);
        if (pane.quotaUnavailable) assert.match(result.text, /(?:quota|limit|balance|reset).*(?:unavailable|not|unknown|missing|cannot|couldn't)|(?:unavailable|not|unknown|missing|cannot|couldn't).*(?:quota|limit|balance|reset)/i, 'Do not turn session statistics into account quota');
        assert.ok(pane.actions.every(action => action.kind === 'terminal_interact'));
      }
      row.ok = true;
    } catch (error) { row.ok = false; row.error = clean(error.message); }
    finally { clearTimeout(timer); scenarioSignal = undefined; await relay?.dispose(); relay = undefined; }
    row.elapsedMs = Date.now() - started; report.cases.push(row); console.log(JSON.stringify({ name: row.name, ok: row.ok, error: row.error, elapsedMs: row.elapsedMs, actions: row.actions.length }));
  }
  report.ok = report.cases.length === selectedScenarios.length && report.cases.every(row => row.ok);
}
main().catch(error => { report.ok = false; report.error = clean(error.message); }).finally(async () => {
  await relay?.dispose(); report.spent = spent; report.finishedAt = new Date().toISOString();
  fs.mkdirSync(run, { recursive: true }); fs.writeFileSync(path.join(run, 'report.json'), clean(JSON.stringify(report, null, 2)));
  console.log(JSON.stringify({ ok: report.ok, model: report.model, spent, report: path.join(run, 'report.json'), error: report.error })); app.exit(report.ok ? 0 : 1);
});
