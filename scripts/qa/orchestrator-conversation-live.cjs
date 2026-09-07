'use strict';
// Live model regression: all workspace/history effects are disposable fixtures.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
function fixture(cwd) {
  const pane = { id: 'Atlas', name: 'Atlas', provider: 'codex', kind: 'codex', cwd, generation: 'fixture-1', revision: 1, status: 'running', turnState: 'idle' };
  const actions = [], reads = [], history = Array.from({ length: 10 }, (_, i) => ({ id: `saved-${i}`, reference: `fixture-history-${i}`, title: i === 0 ? 'Mix 21 last attempt' : `Fixture conversation ${i}`, provider: 'codex', cwd, updatedAt: Date.now() - i * 1000 }));
  let sequence = 1, inputRevision = 0, done = false;
  return { pane, actions, reads, history,
    sessions() { if (done) pane.revision++; return [{ ...pane }]; },
    read(input) {
      assert.equal(input.id, pane.id); reads.push({ sequence, inputRevision, afterActions: actions.length });
      return { ok: true, id: pane.id, generation: pane.generation, sequence, observationSequence: sequence, inputRevision, inputState: { kind: 'empty', hasText: false }, text: done ? 'Review complete: the last commit has no defects in this fixture. No files changed.' : 'Codex idle. Empty task prompt. Ready to receive a task.' };
    },
    dispatch(action) {
      if (action.kind === 'list_conversations') return { ok: true, conversations: history.filter(item => !action.query || item.title.toLowerCase().includes(action.query.toLowerCase())), total: history.length, nextOffset: null };
      if (['read_conversation', 'search_conversation'].includes(action.kind)) { const identity = history.find(item => item.reference === action.reference); assert.ok(identity); return { ok: true, identity, messages: [{ role: 'user', text: 'Review the Mix 21 implementation.' }], hasMore: false }; }
      if (action.kind === 'resume_conversation') { assert.equal(action.reference, history[0].reference); actions.push({ kind: action.kind, reference: action.reference }); return { ok: true, status: 'resumed', id: pane.id, target: { id: pane.id, generation: pane.generation } }; }
      assert.equal(action.targetId, pane.id); assert.equal(action.generation, pane.generation);
      assert.ok(['send_prompt', 'terminal_interact', 'focus_session'].includes(action.kind), `Unexpected effect ${action.kind}`);
      if (action.kind !== 'focus_session') {
        assert.equal(action.operator, true); assert.ok(action.stepId); assert.equal(action.observationSequence, sequence); assert.equal(action.inputRevision, inputRevision);
        assert.ok(reads.some(item => item.afterActions === actions.length)); assert.match(action.text || '', /review/i);
        assert.ok(!(action.submit && action.keys?.includes('enter')), 'Duplicate submit control');
        assert.ok(action.kind === 'send_prompt' || action.submit || action.keys?.includes('enter'));
        done = true; Object.assign(pane, { turnId: 'fixture-review', actionId: action.actionId, turnState: 'completed', completedTurnId: 'fixture-review', completedActionId: action.actionId, turnStartedAt: Date.now() - 1, turnEndedAt: Date.now() }); sequence++; inputRevision++;
      }
      actions.push({ kind: action.kind, stepId: action.stepId, text: action.text, keys: action.keys, submit: action.submit });
      return { ok: true, status: action.kind === 'focus_session' ? 'focused' : 'written' };
    },
    get done() { return done; }
  };
}
if (process.argv.includes('--self-test')) {
  const f = fixture('fixture'); assert.equal(f.dispatch({ kind: 'list_conversations' }).conversations.length, 10);
  f.read({ id: 'Atlas' }); f.dispatch({ kind: 'send_prompt', targetId: 'Atlas', generation: 'fixture-1', operator: true, stepId: 's1', observationSequence: 1, inputRevision: 0, text: 'Review the last commit.' });
  assert.equal(f.done, true); assert.ok(f.sessions()[0].revision > 1);
  console.log('Fixture self-test passed; no credentials or network used.'); process.exit(0);
}
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename, '--live-child'], { env, windowsHide: true, stdio: 'inherit', timeout: 420000 });
  process.exit(child.status ?? 1);
}
const { app, safeStorage } = require('electron');
const run = path.resolve(__dirname, '../../.tmp/orchestrator-conversation-live', `${Date.now()}-${process.pid}`);
app.setPath('userData', path.join(run, 'electron'));
const installedRoot = path.join(process.env.APPDATA, 'vibe-terminal');
const localState = path.join(installedRoot, 'Local State');
if (fs.existsSync(localState)) {
  const { os_crypt } = JSON.parse(fs.readFileSync(localState, 'utf8'));
  if (os_crypt) { fs.mkdirSync(path.join(run, 'electron'), { recursive: true }); fs.writeFileSync(path.join(run, 'electron', 'Local State'), JSON.stringify({ os_crypt })); }
}
const requestedBudget = Number(process.env.VIBE_LIVE_BUDGET || 0.25);
const budget = Number.isFinite(requestedBudget) && requestedBudget > 0 ? Math.min(requestedBudget, 0.25) : 0.25;
const report = { boundary: 'Actual configured Brain/default interpreter; disposable in-memory native/history adapters only. Installed credentials are read-only; fixture state is written only under .tmp. No real terminals or installed profile mutations.', spendingLimit: budget, cases: [], calls: [], startedAt: new Date().toISOString() };
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
      choices: data.choices?.map(choice => ({ finishReason: choice.finish_reason, text: clean(choice.message?.content).slice(0, 2000), tools: choice.message?.tool_calls?.map(tool => { try { const args = JSON.parse(tool.function.arguments); return { tool: tool.function.name, kind: args.kind, goal: args.goal, actions: args.actions?.map(action => ({ kind: action.kind, targetIds: action.targetIds, answerMode: action.answerMode })), targetId: args.targetId, text: clean(args.text).slice(0, 1200), keys: args.keys, outcome: args.outcome, responseTurn: args.responseTurn, stepId: args.stepId }; } catch { return { tool: tool.function.name, malformedArguments: true }; } }) })), ...(!response.ok && { error: clean(data.error?.message).slice(0, 1000), providerReason: clean(data.error?.metadata?.raw).slice(0, 1500) }) });
  }
  return response;
}

async function main() {
  await app.whenReady(); fs.mkdirSync(run, { recursive: true });
  const installed = require('../../backend/orchestratorSettings.cjs').createSettings({ userDataPath: installedRoot, secureStorage: safeStorage });
  secret = installed.getKey(); model = installed.getSettings().model;
  assert.ok(secret && model, 'Installed key/model unavailable through safeStorage'); report.model = model;
  const f = fixture(path.join(run, 'project'));
  relay = require('../../backend/orchestrator.cjs').createOrchestrator({ userDataPath: path.join(run, 'fixture-profile'), fetch: request,
    getRoots: () => ({ documents: run, projects: [{ name: 'Fixture', path: f.pane.cwd }] }), getSessions: () => f.sessions(), readSession: input => f.read(input), dispatchAction: action => f.dispatch(action) });
  assert.equal((await relay.configure({ apiKey: secret, sessionOnly: true, model, spendingLimit: budget })).ok, true);
  assert.equal((await relay.setEnabled(true)).ok, true);
  let beforeSpokenResume = 0, spokenQuestion;
  const scenarios = [
    { name: 'greeting', text: 'Hey Vibe, how are you?', check: result => { assert.ok(result.text.length < 400); assert.doesNotMatch(result.text, /you (?:want|asked)|authorizedCommands|grantId/i); assert.equal(f.actions.length, 0); } },
    { name: 'history-shortlist', text: 'What recent saved conversations do I have?', check: result => { assert.match(result.text, /Mix 21/i); assert.ok(result.text.length < 1100, 'Voice history is too long'); assert.ok((result.text.match(/Fixture conversation/g) || []).length <= 2, 'Voice history dumped the directory'); } },
    { name: 'exact-history-resume', text: 'Resume conversation "Mix 21 last attempt"', check: () => assert.equal(f.actions.filter(action => action.kind === 'resume_conversation').length, 1) },
    { name: 'commit-review-revision-churn', text: 'Tell Atlas to review the last commit for bugs without editing anything.', check: result => { assert.equal(f.done, true); assert.equal(f.actions.filter(action => ['send_prompt', 'terminal_interact'].includes(action.kind)).length, 1); assert.ok(f.reads.some(read => read.afterActions === f.actions.length), 'Missing post-action verification'); assert.doesNotMatch(result.text, /^You (?:want|asked)/i); } },
    { name: 'spoken-history-candidate', text: 'Can you resume the mix to one last attempt conversation?', input: () => { beforeSpokenResume = f.actions.filter(action => action.kind === 'resume_conversation').length; return { text: 'Can you resume the mix to one last attempt conversation?', origin: 'voice' }; }, check: result => { assert.equal(result.responseTurn, 'listen'); assert.equal(f.actions.filter(action => action.kind === 'resume_conversation').length, beforeSpokenResume); spokenQuestion = relay.getState().tasks.find(task => task.requestId === result.requestId)?.question; assert.ok(spokenQuestion?.id); assert.match(spokenQuestion.text, /Mix 21 last attempt/); } },
    { name: 'spoken-history-confirmation', text: 'Yes, that is the one.', input: () => { assert.ok(spokenQuestion?.id); return { text: 'Yes', origin: 'voice', replyToRequestId: spokenQuestion.requestId, questionId: spokenQuestion.id }; }, check: () => assert.equal(f.actions.filter(action => action.kind === 'resume_conversation').length, beforeSpokenResume + 1) },
    { name: 'conversational-question', text: 'Ask me one quick question about what I want to work on next.', check: result => { assert.equal(result.responseTurn, 'listen'); assert.ok(result.text.trim().endsWith('?')); } }
  ];
  const selectedCases = process.env.VIBE_LIVE_CASES?.split(',');
  for (const scenario of scenarios.filter(item => !selectedCases || selectedCases.includes(item.name))) {
    const row = { name: scenario.name, input: scenario.text }, firstCall = report.calls.length, started = Date.now();
    const controller = new AbortController(); scenarioSignal = controller.signal;
    const timer = setTimeout(() => { controller.abort(); relay.cancel(); }, 90000);
    try {
      const result = await relay.send(scenario.input ? scenario.input() : { text: scenario.text, origin: 'voice' });
      row.result = { ok: result.ok, text: clean(result.text), error: clean(result.error), status: result.status, responseTurn: result.responseTurn };
      assert.equal(result.ok, true, clean(result.error || result.text)); scenario.check(result); row.ok = true;
    } catch (error) { row.ok = false; row.error = clean(error.message); }
    finally { clearTimeout(timer); scenarioSignal = undefined; }
    row.receipts = relay.getState().receipts.map(({ kind, status, text }) => ({ kind, status, text: clean(text) }));
    row.elapsedMs = Date.now() - started; row.callCount = report.calls.length - firstCall; report.cases.push(row);
    console.log(JSON.stringify({ name: row.name, ok: row.ok, error: row.error, calls: row.callCount, elapsedMs: row.elapsedMs }));
    fs.writeFileSync(path.join(run, 'report.json'), clean(JSON.stringify(report, null, 2)));
  }
  report.actions = f.actions; report.reads = f.reads; report.ok = report.cases.every(row => row.ok);
}
main().catch(error => { report.ok = false; report.error = clean(error.message); }).finally(async () => {
  await relay?.dispose(); report.spent = spent; report.finishedAt = new Date().toISOString();
  fs.mkdirSync(run, { recursive: true }); fs.writeFileSync(path.join(run, 'report.json'), clean(JSON.stringify(report, null, 2)));
  console.log(JSON.stringify({ ok: report.ok, model: report.model, calls: report.calls.length, spent, report: path.join(run, 'report.json'), error: report.error })); app.exit(report.ok ? 0 : 1);
});
