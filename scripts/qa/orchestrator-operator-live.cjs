'use strict';
// Actual configured model + default interpreter; only disposable in-memory panes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { validateTerminalControls } = require('../../shared/terminalControls.cjs');

function createPane(id, kind, cwd, mode = 'prompt') {
  const pane = { session: { id, name: id, title: id, kind, provider: kind, cwd, generation: 'fixture-1', status: 'running', turnState: 'idle' }, sequence: 1, inputRevision: 0, reads: [], actions: [], mode, selected: 0, phase: 0, done: false };
  pane.screen = () => pane.done ? (mode === 'prompt' ? 'Review complete. No defects found in the fixture. Requested review finished.' : 'Settings saved: Compact layout; Unit and Smoke checks enabled.') : mode === 'prompt' ? 'Codex ready. Empty prompt. No task running.' : pane.phase === 0 ? `Settings > Layout\n${pane.selected === 0 ? '>' : ' '} Spacious\n${pane.selected === 1 ? '>' : ' '} Compact\nArrow keys move; Enter chooses.` : 'Settings > Checks\nAvailable: Unit, Smoke, Integration. Type check names separated by commas and press Enter to save.';
  pane.read = () => { pane.reads.push({ sequence: pane.sequence, inputRevision: pane.inputRevision, afterActions: pane.actions.length }); return { ok: true, id, generation: pane.session.generation, sequence: pane.sequence, observationSequence: pane.sequence, inputRevision: pane.inputRevision, text: pane.screen(), inputState: { kind: 'empty', hasText: false }, ...(pane.done && pane.mode === 'prompt' ? { completedResult: { text: pane.screen(), turnId: pane.session.turnId, actionId: pane.session.actionId } } : {}) }; };
  pane.dispatch = action => {
    assert.equal(action.targetId, id, 'Effect escaped scenario target');
    assert.equal(action.generation, pane.session.generation, 'Generation mismatch');
    assert.ok(['send_prompt', 'terminal_interact', 'answer_question', 'focus_session'].includes(action.kind), `Unexpected fixture effect ${action.kind}`);
    if (action.kind === 'focus_session') return { ok: true, status: 'focused' };
    assert.ok(pane.reads.some(read => read.afterActions === pane.actions.length), 'An effect requires a fresh adapter observation');
    if (['send_prompt', 'terminal_interact'].includes(action.kind)) {
      assert.equal(action.observationSequence, pane.sequence, 'Stale output sequence');
      assert.equal(action.inputRevision, pane.inputRevision, 'Stale input revision');
      assert.equal(action.operator, true, 'Native delivery must use operator mode');
      if (action.kind === 'terminal_interact') assert.equal(validateTerminalControls(action).ok, true, 'Invalid native keys');
    }
    pane.actions.push({ kind: action.kind, targetId: id, text: action.text, keys: action.keys, submit: action.submit, answers: action.answers, requestId: action.requestId, revision: action.revision, actionId: action.actionId });
    if (mode === 'prompt') {
      assert.ok(action.kind === 'send_prompt' || action.kind === 'terminal_interact', 'Expected native task delivery');
      assert.match(action.text || '', /review/i, 'The task must actually request a review');
      assert.ok(action.kind === 'send_prompt' || action.submit || action.keys?.includes('enter'), 'Review must be submitted');
      pane.done = true; Object.assign(pane.session, { turnId: `turn-${pane.actions.length}`, actionId: action.actionId, turnState: 'completed', completedTurnId: `turn-${pane.actions.length}`, completedActionId: action.actionId, turnEndedAt: Date.now() });
    } else if (mode === 'menu') {
      assert.equal(action.kind, 'terminal_interact', 'Use native controls for a native menu');
      if (pane.phase === 0) {
        for (const key of action.keys || []) {
          if (key === 'down' || key === 'up') pane.selected = 1 - pane.selected;
          else if (key === 'enter') { assert.equal(pane.selected, 1, 'The requested Compact layout was not selected'); pane.phase = 1; }
          else throw Error(`Unexpected layout navigation key ${key}`);
        }
        if (action.submit) { assert.equal(pane.selected, 1); pane.phase = 1; }
      } else {
        assert.match(action.text || '', /unit/i); assert.match(action.text || '', /smoke/i); assert.doesNotMatch(action.text || '', /integration/i);
        assert.ok(action.submit || action.keys?.includes('enter'), 'Checks must be submitted'); pane.done = true;
      }
    } else {
      assert.equal(action.kind, 'answer_question'); assert.equal(action.requestId, `${id}-setup`); assert.equal(action.revision, 3);
      assert.deepEqual(action.answers, { database: 'PostgreSQL', checks: ['Unit', 'Smoke'] }); pane.done = true;
    }
    pane.sequence++; pane.inputRevision++;
    return { ok: true, status: action.kind === 'answer_question' ? 'answered' : 'written', ...(pane.session.turnId && { turnId: pane.session.turnId }) };
  };
  return pane;
}

if (process.argv.includes('--self-test')) {
  const pane = createPane('test', 'codex', 'fixture', 'menu'); pane.read();
  pane.dispatch({ kind: 'terminal_interact', targetId: 'test', generation: 'fixture-1', operator: true, observationSequence: 1, inputRevision: 0, keys: ['down', 'enter'] }); pane.read();
  pane.dispatch({ kind: 'terminal_interact', targetId: 'test', generation: 'fixture-1', operator: true, observationSequence: 2, inputRevision: 1, text: 'Unit, Smoke', submit: true });
  assert.equal(pane.done, true); assert.equal(pane.sequence, 3);
  console.log('Fixture self-test passed; no Electron, credentials, or network used.'); process.exit(0);
}
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename, '--live-child'], { env, windowsHide: true, stdio: 'inherit', timeout: 420000 });
  process.exit(child.status ?? 1);
}
const { app, safeStorage } = require('electron');
const run = path.resolve(__dirname, '../../.tmp/orchestrator-operator-live', `${Date.now()}-${process.pid}`);
app.setPath('userData', path.join(run, 'electron'));
const installedRoot = path.join(process.env.APPDATA, 'vibe-terminal');
const localState = path.join(installedRoot, 'Local State');
if (fs.existsSync(localState)) {
  const { os_crypt } = JSON.parse(fs.readFileSync(localState, 'utf8'));
  if (os_crypt) { fs.mkdirSync(path.join(run, 'electron'), { recursive: true }); fs.writeFileSync(path.join(run, 'electron', 'Local State'), JSON.stringify({ os_crypt })); }
}
const requestedBudget = Number(process.env.VIBE_LIVE_BUDGET || 0.25);
const budget = Number.isFinite(requestedBudget) && requestedBudget > 0 ? Math.min(requestedBudget, 0.25) : 0.25;
const report = { boundary: 'Actual configured Brain/default interpreter; disposable in-memory native and structured adapters only. No real terminals, account changes, or application state writes.', spendingLimit: budget, cases: [], calls: [], startedAt: new Date().toISOString() };
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
    if (response.ok && !Number.isFinite(cost)) { spent = budget; throw Error('Provider omitted live usage cost; stopping to protect budget'); }
    if (Number.isFinite(cost)) spent += cost - reservation;
    report.calls.push({ stage: body.tools?.[0]?.function?.name === 'interpret_workspace' ? 'interpretation' : 'operation', model: data.model || body.model, status: response.status, elapsedMs: Date.now() - start, cost: Number.isFinite(cost) ? cost : undefined,
      choices: data.choices?.map(choice => ({ finishReason: choice.finish_reason, text: clean(choice.message?.content).slice(0, 2000), tools: choice.message?.tool_calls?.map(tool => { try { const args = JSON.parse(tool.function.arguments); return { tool: tool.function.name, kind: args.kind, goal: args.goal, actions: args.actions?.map(action => ({ kind: action.kind, targetIds: action.targetIds, answerMode: action.answerMode })), targetId: args.targetId, text: clean(args.text).slice(0, 1200), keys: args.keys, outcome: args.outcome }; } catch { return { tool: tool.function.name, malformedArguments: true }; } }) })), ...(!response.ok && { error: clean(data.error?.message).slice(0, 1000) }) });
  }
  return response;
}

async function main() {
  await app.whenReady(); fs.mkdirSync(run, { recursive: true });
  const { createSettings } = require('../../backend/orchestratorSettings.cjs');
  const { createOrchestrator } = require('../../backend/orchestrator.cjs');
  const installed = createSettings({ userDataPath: installedRoot, secureStorage: safeStorage });
  secret = installed.getKey(); model = installed.getSettings().model;
  assert.ok(secret && model, 'Installed key/model unavailable through safeStorage'); report.model = model;
  for (const scenario of [
    { name: 'fresh-native-review', kind: 'codex', mode: 'prompt', text: 'Operate Atlas to review the latest changes and report defects. Inspect the terminal first; deliver the review task and verify its outcome.' },
    { name: 'native-menu-and-delegated-answer', kind: 'codex', mode: 'menu', text: 'Operate Atlas settings: change its layout to Compact. Handle the following check-selection question for me: choose the two lightweight checks and leave Integration disabled. Complete and verify the settings.' },
    ...['fusion', 'openfusion'].map(kind => ({ name: `${kind}-delegated-custom-multi`, kind, mode: 'structured', text: 'Complete Atlas setup for me. Choose the database best suited to our existing PostgreSQL deployment, and select both lightweight checks while leaving Integration disabled. You may choose and submit the answers; verify completion.' }))
  ]) {
    if (spent >= budget) throw Error('Live budget exhausted');
    const started = Date.now(), pane = createPane('Atlas', scenario.kind, path.join(run, scenario.name), scenario.mode);
    if (scenario.mode === 'structured') pane.screen = () => pane.done ? 'Setup completed: PostgreSQL; Unit and Smoke checks.' : 'Setup is waiting for the structured database and checks questions.';
    const row = { name: scenario.name, kind: scenario.kind, actions: pane.actions, reads: pane.reads };
    const controller = new AbortController(); scenarioSignal = controller.signal;
    const timer = setTimeout(() => { controller.abort(); relay?.cancel(); }, 90000);
    try {
      relay = createOrchestrator({ userDataPath: path.join(run, scenario.name, 'userData'), fetch: request,
        getRoots: () => ({ documents: run, projects: [{ name: 'Fixture', path: pane.session.cwd }] }), getSessions: () => [{ ...pane.session }],
        readSession: async input => { assert.equal(input.id, pane.session.id); return pane.read(); },
        dispatchAction: async action => { const result = pane.dispatch(action); if (action.kind === 'answer_question') relay.resolveInteraction({ id: 'Atlas-setup', sessionId: 'Atlas', generation: pane.session.generation, revision: 3 }); return result; } });
      assert.equal((await relay.configure({ apiKey: secret, sessionOnly: true, model, spendingLimit: budget - spent })).ok, true);
      assert.equal((await relay.setEnabled(true)).ok, true);
      if (scenario.mode === 'structured') relay.ingestInteraction({ id: 'Atlas-setup', sessionId: 'Atlas', generation: pane.session.generation, revision: 3, kind: 'question', questions: [
        { id: 'database', question: 'Database?', custom: true, options: [{ label: 'SQLite' }] },
        { id: 'checks', question: 'Checks? Unit and Smoke are lightweight. Integration is expensive.', multiple: true, options: [{ label: 'Unit' }, { label: 'Smoke' }, { label: 'Integration' }] }
      ] });
      const result = await relay.send({ text: scenario.text, origin: 'text' });
      row.result = { ok: result.ok, text: clean(result.text), error: clean(result.error), status: result.status };
      assert.equal(result.ok, true, clean(result.error || result.text));
      assert.equal(pane.done, true, 'No verified operation occurred; prose/echo is insufficient');
      assert.ok(pane.actions.length > 0); assert.ok(pane.reads.some(read => read.afterActions === pane.actions.length), 'No post-action verification read');
      assert.ok(pane.actions.every(action => action.kind !== 'stage_draft' && action.targetId === 'Atlas'));
      row.ok = true;
    } catch (error) { row.ok = false; row.error = clean(error.message); }
    finally { clearTimeout(timer); scenarioSignal = undefined; await relay?.dispose(); relay = undefined; }
    row.elapsedMs = Date.now() - started; report.cases.push(row); console.log(JSON.stringify({ name: row.name, ok: row.ok, error: row.error, elapsedMs: row.elapsedMs, actions: row.actions.length }));
  }
  report.ok = report.cases.length === 4 && report.cases.every(row => row.ok);
}
main().catch(error => { report.ok = false; report.error = clean(error.message); }).finally(async () => {
  await relay?.dispose(); report.spent = spent; report.finishedAt = new Date().toISOString();
  fs.mkdirSync(run, { recursive: true }); fs.writeFileSync(path.join(run, 'report.json'), clean(JSON.stringify(report, null, 2)));
  console.log(JSON.stringify({ ok: report.ok, model: report.model, spent, report: path.join(run, 'report.json'), error: report.error })); app.exit(report.ok ? 0 : 1);
});
