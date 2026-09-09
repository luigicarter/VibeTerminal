'use strict';
// Configured-model acceptance against disposable, in-memory adapters only.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename, '--live-child', ...process.argv.slice(2).filter(arg => arg !== '--live-child')], { env, windowsHide: true, stdio: 'inherit', timeout: 900000 });
  process.exit(child.status ?? 1);
}
const { app, safeStorage } = require('electron');
const run = path.resolve(__dirname, '../../.tmp/orchestrator-recovery-live', `${Date.now()}-${process.pid}`);
app.setPath('userData', path.join(run, 'electron'));
const installedPath = path.join(process.env.APPDATA, 'vibe-terminal');
const localState = path.join(installedPath, 'Local State');
if (fs.existsSync(localState)) {
  const { os_crypt } = JSON.parse(fs.readFileSync(localState, 'utf8'));
  if (os_crypt) { fs.mkdirSync(path.join(run, 'electron'), { recursive: true }); fs.writeFileSync(path.join(run, 'electron', 'Local State'), JSON.stringify({ os_crypt })); }
}
const requestedBudget = Number(process.env.VIBE_RECOVERY_LIVE_BUDGET || .20);
const budget = Number.isFinite(requestedBudget) && requestedBudget > 0 ? Math.min(requestedBudget, .25) : .20;
const caseNames = ['project-close-all', 'explicit-close-subset', 'bound-new-codex', 'natural-failed-route-recovery', 'ambiguous-web-terminal-clause', 'creation-purpose-guard', 'ambiguous-creation-purpose-guard', 'feature-description-history', 'feature-followup-history', 'fullscreen-history'];
const caseArgs = process.argv.slice(2).filter(arg => arg.startsWith('--case='));
const selectedCase = caseArgs[0]?.slice('--case='.length);
const report = { boundary: 'Configured live model; synthetic project, pane inventory and effects only. The recovery case scripts only its initial intent and initial routing failure; its retry interpretation, routing and execution use the configured live model. The two purpose-guard cases script only their initial unintended draft proposal; purpose review and subsequent repair/execution use the live model. Other cases use the live model from their initial intent. No installed conversation/history, native terminals or microphone used.', initialFailureScripted: false, initialProposalScripted: false, budget, maxCallsPerCase: 24, selectedCase: selectedCase === undefined ? 'all' : caseNames.includes(selectedCase) ? selectedCase : 'invalid', cases: [], startedAt: new Date().toISOString() };
const recoveryObjective = 'Investigate the partial terminal closure in Recovery QA; do not edit files.';
const purposeTask = 'investigate the partial terminal closure; do not edit files.';
const purposeObjectives = {
  'creation-purpose-guard': `Open a new Codex terminal in Recovery QA to ${purposeTask}`,
  'ambiguous-creation-purpose-guard': `Open a new Codex terminal and a web terminal in Recovery QA to ${purposeTask}`
};
let relay, secret, model, spent = 0, reserved = 0, pricing;
function fail(code) { const error = Error(code); error.qaCode = code; throw error; }
const metadataName = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value) ? value : 'other';
function reasonCode(error) {
  if (error?.qaCode) return metadataName(error.qaCode);
  const message = typeof error === 'string' ? error : error?.message || '';
  for (const [pattern, code] of [
    [/Invalid terminal step ID/i, 'invalid-step-id'], [/fresh observation sequence and input revision/i, 'missing-observation-counters'],
    [/observation.*token|token.*observation/i, 'observation-token-rejected'], [/Invalid action/i, 'invalid-action'],
    [/matching user command grant/i, 'unmatched-grant'], [/Invalid command text/i, 'invalid-command-text'],
    [/Invalid or unexpected intent fields/i, 'invalid-intent-fields'], [/distinct target session IDs/i, 'invalid-target-ids'],
    [/Too many actions requested/i, 'action-limit'], [/case-model-call-limit/i, 'case-model-call-limit'],
    [/budget-reservation-limit/i, 'budget-reservation-limit'], [/synthetic-route-failure/i, 'synthetic-route-failure'],
    [/timed out|timeout/i, 'timeout'], [/abort|cancel/i, 'cancelled']
  ]) if (pattern.test(message)) return code;
  return error?.code === 'ERR_ASSERTION' ? 'acceptance-assertion' : 'request-or-fixture-failure';
}
function toolMetadata(call) {
  const result = { function: metadataName(call.function?.name) };
  let args;
  try { args = JSON.parse(call.function?.arguments); }
  catch { return { ...result, errorReason: 'invalid-tool-json' }; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ...result, errorReason: 'invalid-tool-object' };
  Object.assign(result, { kind: metadataName(args.kind), argumentKeys: Object.keys(args).slice(0, 32).map(metadataName),
    hasStepId: Object.hasOwn(args, 'stepId'), hasObservationToken: Object.hasOwn(args, 'observationToken'),
    hasObservationSequence: Object.hasOwn(args, 'observationSequence'), hasInputRevision: Object.hasOwn(args, 'inputRevision') });
  if (call.function?.name === 'interpret_workspace') result.intent = {
    executionMode: ['direct', 'reason'].includes(args.executionMode) ? args.executionMode : 'omitted-or-invalid',
    actions: Array.isArray(args.actions) ? args.actions.slice(0, 24).map(action => ({ kind: metadataName(action?.kind),
      ...(action?.scope && { scopeType: ['project', 'board', 'workspace', 'explicit'].includes(action.scope.type) ? action.scope.type : 'other' }) })) : [],
    hasClarification: typeof args.clarification === 'string' && Boolean(args.clarification.trim())
  };
  return result;
}
async function main() {
  await app.whenReady();
  if (caseArgs.length > 1 || selectedCase !== undefined && !caseNames.includes(selectedCase)) fail('invalid-case-filter');
  const { createSettings } = require('../../backend/orchestratorSettings.cjs');
  const { createOrchestrator } = require('../../backend/orchestrator.cjs');
  const { planTaskRoute, RoutingError } = require('../../backend/orchestratorRoutePlanner.cjs');
  const installed = createSettings({ userDataPath: installedPath, secureStorage: safeStorage });
  secret = installed.getKey(); model = installed.getSettings().model;
  if (!secret || !model) fail('configured-model-or-key-unavailable'); report.model = model;
  async function scenario(name, initialCount, exercise) {
    if (selectedCase && selectedCase !== name) return;
    const row = { name, calls: [], blockedCalls: [], effects: { close: 0, create: 0, send: 0 }, routeCalls: 0, passed: false };
    report.cases.push(row);
    const root = path.join(run, name), cwd = path.join(root, 'Recovery QA'); fs.mkdirSync(cwd, { recursive: true });
    const sameProject = value => typeof value === 'string' && path.win32.isAbsolute(value)
      && path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase() === path.win32.normalize(cwd).replace(/[\\/]+$/, '').toLowerCase();
    let sessions = [], sequence = 0, induceFailure = false, seededInitialIntent = false; const sends = [], spoken = [], statuses = [], composers = new Map(), submittedActions = new Set();
    const composer = current => {
      if (!composers.has(current.id)) composers.set(current.id, { text: '', cursor: 0, selected: false, sequence: 0, revision: 0 });
      return composers.get(current.id);
    };
    const pane = (id, extra = {}) => ({ id, name: id, generation: `generation-${id}`, launchToken: ++sequence, visiblePane: true,
      board: 'project', projectId: 'recovery-project', inventoryRevision: sequence, cwd, kind: 'codex', provider: 'codex', conversationId: `conversation-${id}`,
      started: true, status: 'idle', processState: 'running', agentProcessState: 'running', agentPid: 100 + sequence,
      observation: 'observed', turnState: 'idle', ...extra });
    sessions = Array.from({ length: initialCount }, (_, i) => pane(`worker-${i + 1}`, i >= initialCount / 2 ? { status: 'paused', started: false, agentProcessState: 'exited', processState: 'exited' } : {}));
    const request = async (url, options = {}) => {
      const completion = url.endsWith('/chat/completions'); let reservation = 0;
      if (completion) {
        const body = JSON.parse(options.body);
        if (Object.hasOwn(purposeObjectives, name) && !seededInitialIntent
            && body.tools?.some(tool => tool.function?.name === 'interpret_workspace')) {
          seededInitialIntent = true; row.initialProposalScripted = true; report.initialProposalScripted = true;
          const call = { id: 'scripted-initial-draft-proposal', type: 'function', function: { name: 'interpret_workspace', arguments: JSON.stringify({
            goal: purposeObjectives[name], access: 'read-only', executionMode: 'reason',
            actions: Array.from({ length: name === 'ambiguous-creation-purpose-guard' ? 2 : 1 }, () => ({ kind: 'create_session', kindOfSession: 'codex', cwd, text: purposeTask }))
          }) } };
          row.scriptedInitialProposal = { status: 'scripted', cost: 0, responseTools: [toolMetadata(call)] };
          return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [call] } }], usage: { cost: 0 } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        // Establish the exact app-owned failed-routing state once. An unrelated
        // live parser failure must not pass as the intended routing failure and
        // leave the one-shot route injection armed for the retry itself.
        if (name === 'natural-failed-route-recovery' && induceFailure && !seededInitialIntent
            && body.tools?.some(tool => tool.function?.name === 'interpret_workspace')) {
          seededInitialIntent = true; row.initialFailureScripted = true; report.initialFailureScripted = true;
          const call = { id: 'scripted-initial-recovery-intent', type: 'function', function: { name: 'interpret_workspace', arguments: JSON.stringify({
            goal: recoveryObjective, access: 'read-only', executionMode: 'reason',
            actions: [{ kind: 'delegate_task', text: recoveryObjective, cwd, kindOfSession: 'codex', assignmentMode: 'auto' }]
          }) } };
          row.scriptedInitialIntent = { status: 'scripted', cost: 0, responseTools: [toolMetadata(call)] };
          return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [call] } }], usage: { cost: 0 } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        const blocked = code => { row.limitReason = code; if (row.blockedCalls.length < 8) row.blockedCalls.push({ stage: metadataName(body.tools?.[0]?.function?.name || 'model'), reason: code }); fail(code); };
        if (row.calls.length >= report.maxCallsPerCase) blocked('case-model-call-limit');
        if (!pricing) fail('pricing-unavailable');
        // UTF-8 byte count is a conservative token upper bound for the supplied
        // request; output is separately bounded by max_tokens. No parallel
        // request can spend an outstanding reservation a second time.
        reservation = Buffer.byteLength(options.body) * pricing.prompt + Number(body.max_tokens || 4096) * pricing.completion;
        if (spent + reserved + reservation > budget) blocked('budget-reservation-limit');
        reserved += reservation;
        const toolErrors = (body.messages || []).filter(message => message.role === 'tool').flatMap(message => {
          try { const value = JSON.parse(message.content); return value?.ok === false ? [reasonCode(value.error || value.reason || '')] : []; } catch { return []; }
        }).slice(-8);
        const purposeReview = body.messages?.some(message => message.role === 'system' && typeof message.content === 'string'
          && message.content.startsWith('Check the purpose of proposed new-terminal drafts before any action.')) === true;
        if (purposeReview) row.purposeReview = true;
        row.calls.push({ stage: metadataName(body.tools?.[0]?.function?.name || 'model'), status: 'started', toolErrors, purposeReview,
          inputBytes: Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools || [] })) });
      }
      const record = completion ? row.calls.at(-1) : null, start = Date.now();
      try {
        const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
        const response = await fetch(url, { ...options, signal });
        if (url.endsWith('/models')) {
          const data = await response.clone().json(), selected = data.data?.find(item => item.id === model);
          const prompt = Number(selected?.pricing?.prompt), completion = Number(selected?.pricing?.completion);
          if (selected?.pricing && Number.isFinite(prompt) && prompt >= 0 && Number.isFinite(completion) && completion >= 0) pricing = { prompt, completion };
        }
        if (record) {
          const data = await response.clone().json();
          const actual = Number(data.usage?.cost);
          record.status = response.status; record.elapsedMs = Date.now() - start;
          record.finishReason = ['stop', 'tool_calls', 'length'].includes(data.choices?.[0]?.finish_reason) ? data.choices[0].finish_reason : 'other';
          record.responseTools = (data.choices?.[0]?.message?.tool_calls || []).slice(0, 24).map(toolMetadata);
          if (!response.ok) record.errorReason = `http-${response.status}`;
          record.cost = Number.isFinite(actual) && actual >= 0 ? actual : reservation;
          spent += record.cost;
        }
        return response;
      } catch (error) { if (record) { record.status = 'transport-failed'; record.errorReason = reasonCode(error); record.elapsedMs = Date.now() - start; spent += reservation; } throw error; }
      finally { reserved -= reservation; }
    };
    if (name.endsWith('-history')) {
      const profile = path.join(root, 'profile'), at = Date.now() - 10000;
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(path.join(profile, 'orchestrator-work-items.json'), JSON.stringify({ version: 1,
        items: Array.from({ length: 20 }, (_, i) => ({ id: `old-work-${i}`, cwd, title: `Historical task ${i}`,
          objective: 'Review an older unrelated layout task. '.repeat(18), summary: 'Historical task result. '.repeat(20),
          createdAt: at, updatedAt: at + i, requestIds: [`old-request-${i}`], status: 'completed' })) }));
      const history = name === 'feature-followup-history' ? [
        ['user', 'Open a new Codex terminal in Recovery QA. I want a different ding when Lina starts listening and the current ding when the task is complete.'],
        ['assistant', 'Do you mean changing audio settings or describing desired behavior for the future?'],
        ['user', 'Desired behavior for the future. The prompt should say: when Hey Lina starts listening, play a distinct listening cue. Keep the existing completion cue.'],
        ['assistant', 'I cannot change those settings myself. Would you like help drafting a feature request?'],
      ] : [];
      fs.writeFileSync(path.join(profile, 'orchestrator-conversation.json'), JSON.stringify({ receipts: [], tasks: [],
        messages: history.map(([role, text], i) => ({ id: `history-${i}`, role, text, at: at + i, requestId: `exchange-${Math.floor(i / 2)}`, origin: 'text' })) }));
    }
    relay = createOrchestrator({ userDataPath: path.join(root, 'profile'), fetch: request,
      getRoots: () => ({ documents: root, projects: [{ id: 'recovery-project', name: 'Recovery QA', path: cwd }] }),
      getSessions: () => structuredClone(sessions), getLaunchers: () => [{ kind: 'codex', label: 'Codex', available: true, configured: true },
        ...(name === 'fullscreen-history' ? [{ kind: 'claude', label: 'Claude Code', available: true, configured: true }] : [])],
      routeTask: async (context, { read }) => {
        row.routeCalls++;
        if (induceFailure) { induceFailure = false; throw new RoutingError('synthetic-route-failure'); }
        return planTaskRoute({ context, read, complete: async (messages, tools) => {
          const response = await request('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages, tools, max_tokens: 1024 }) });
          return response.json();
        } });
      },
      readSession: target => { const current = sessions.find(item => item.id === target.id && item.generation === target.generation); if (!current) fail('read-outside-fixture');
        const input = composer(current); input.sequence++;
        return { ok: true, id: current.id, generation: current.generation, sequence: input.sequence, observationSequence: input.sequence, inputRevision: input.revision,
          text: sends.some(item => item.targetId === current.id) ? 'The submitted synthetic investigation is running.'
            : input.text ? `Codex ready. Unsent input composer:\n> ${input.text}` : 'Codex ready. Empty input composer. >' }; },
      dispatchAction: action => {
        if (action.kind === 'navigate') {
          if (!['settings', 'history', 'orchestrator', 'multi', 'project'].includes(action.view)
              || action.cwd !== undefined && !sameProject(action.cwd) || action.view === 'project' && !sameProject(action.cwd)) fail('navigation-outside-fixture');
          return { ok: true, status: 'navigated' };
        }
        if (action.kind === 'list_setups') return { ok: true, setups: [] };
        if (action.kind === 'list_conversations') {
          if (action.cwd !== undefined && !sameProject(action.cwd)) fail('history-outside-fixture');
          return { ok: true, conversations: [], total: 0, hasMore: false };
        }
        if (action.kind === 'create_session') { assert(sameProject(action.cwd), 'creation must stay within the same known Windows project'); assert.equal(action.kindOfSession, name === 'fullscreen-history' ? 'claude' : 'codex'); assert.equal(action.text, undefined); assert.equal(action.prompt, undefined);
          row.effects.create++; const current = pane(`created-${row.effects.create}`, { kind: action.kindOfSession, provider: action.kindOfSession }); sessions.push(current);
          return { ok: true, status: 'created', id: current.id, launchToken: current.launchToken, processState: 'running', target: { id: current.id, generation: current.generation, launchToken: current.launchToken } }; }
        const current = sessions.find(item => item.id === action.targetId && item.generation === action.generation); if (!current) fail('effect-outside-fixture');
        if (action.kind === 'focus_session') return { ok: true, status: 'focused' };
        if (action.kind === 'close') { row.effects.close++; sessions = sessions.filter(item => item !== current);
          return { ok: true, status: 'closed', close: { operationId: action.actionId, target: { id: current.id, generation: current.generation, launchToken: current.launchToken }, pane: 'removed', process: 'stopped', launchSettled: true } }; }
        const input = composer(current);
        const submit = text => {
          if (typeof text !== 'string' || !text.trim()) fail('empty-fixture-submission');
          if (!action.actionId || submittedActions.has(action.actionId)) fail('duplicate-fixture-submission');
          submittedActions.add(action.actionId); row.effects.send++; sends.push({ targetId: current.id, text });
          input.text = ''; input.cursor = 0; input.selected = false; input.revision++;
          Object.assign(current, { turnId: action.actionId, actionId: action.actionId, turnState: 'running', turnStartedAt: Date.now() });
          return { ok: true, status: 'written', turnId: action.actionId };
        };
        if (action.kind === 'terminal_interact') {
          // Production authorization has already run. The fixture still fences
          // the source and observed composer; it never invents missing tokens,
          // step IDs, counters, or task-purpose fields on the model's behalf.
          if (action.operator !== true || !action.grantId || !action.stepId || !relay.getState().tasks.some(task => task.requestId === action.requestId)) fail('unbound-fixture-interaction');
          if (action.observationSequence !== input.sequence || action.inputRevision !== input.revision) fail('stale-fixture-interaction');
          if (action.mouse) fail('unsupported-fixture-mouse');
          const keys = action.keys || [];
          const allowedKeys = ['enter', 'ctrl-m', 'ctrl-j', 'ctrl-a', 'ctrl-e', 'ctrl-b', 'ctrl-f', 'ctrl-u', 'ctrl-k', 'home', 'end', 'left', 'right', 'shift-enter', 'backspace', 'delete', 'escape', 'tab', 'up', 'down'];
          if (!Array.isArray(keys) || keys.some(key => !allowedKeys.includes(key))) fail('unsupported-fixture-key');
          const submitKeys = keys.filter(key => ['enter', 'ctrl-m', 'ctrl-j'].includes(key));
          if (submitKeys.length > 1 || submitKeys.length && (action.submit === true || !['enter', 'ctrl-m', 'ctrl-j'].includes(keys.at(-1)))) fail('duplicate-or-nonfinal-fixture-enter');
          if ((submitKeys.length || action.submit === true) && action.inputPurpose !== 'task') fail('non-task-fixture-submission');
          const insert = text => {
            if (input.selected) { input.text = ''; input.cursor = 0; input.selected = false; }
            input.text = input.text.slice(0, input.cursor) + text + input.text.slice(input.cursor); input.cursor += text.length;
          };
          if (action.text !== undefined) { if (typeof action.text !== 'string') fail('invalid-fixture-text'); insert(action.text); }
          let enter = false;
          for (const key of keys) {
            if (['enter', 'ctrl-m', 'ctrl-j'].includes(key)) { if (enter) fail('duplicate-fixture-enter'); enter = true; }
            else if (key === 'home' || key === 'ctrl-a') { input.cursor = 0; input.selected = false; }
            else if (key === 'end' || key === 'ctrl-e') { input.cursor = input.text.length; input.selected = false; }
            else if (['left', 'right', 'ctrl-b', 'ctrl-f'].includes(key)) { input.cursor = Math.max(0, Math.min(input.text.length, input.cursor + (['left', 'ctrl-b'].includes(key) ? -1 : 1))); input.selected = false; }
            else if (key === 'ctrl-u') { input.text = input.text.slice(input.cursor); input.cursor = 0; }
            else if (key === 'ctrl-k') input.text = input.text.slice(0, input.cursor);
            else if (key === 'shift-enter') insert('\n');
            else if (key === 'backspace' || key === 'delete') {
              if (input.selected) { input.text = ''; input.cursor = 0; input.selected = false; }
              else if (key === 'backspace' && input.cursor > 0) { input.text = input.text.slice(0, input.cursor - 1) + input.text.slice(input.cursor); input.cursor--; }
              else if (key === 'delete') input.text = input.text.slice(0, input.cursor) + input.text.slice(input.cursor + 1);
            } else if (!['escape', 'tab', 'up', 'down'].includes(key)) fail('unsupported-fixture-key');
          }
          if (enter || action.submit === true) {
            if (action.inputPurpose !== 'task') fail('non-task-fixture-submission');
            return submit(input.text);
          }
          input.revision++;
          return { ok: true, status: 'written' };
        }
        if (action.kind !== 'send_prompt') fail('unsupported-fixture-effect');
        return submit(action.text);
      },
      onSpeak: event => { spoken.push(event); return { ok: true }; },
      onChange: state => { for (const task of state.tasks || []) statuses.push({ requestId: task.requestId, status: task.status }); }
    });
    try {
      assert.equal((await relay.configure({ apiKey: secret, sessionOnly: true, model, spendingLimit: Math.max(.001, budget - spent) })).ok, true);
      assert.equal((await relay.setEnabled(true)).ok, true);
      await exercise({ send: (text, extra = {}) => relay.send({ text, origin: 'text', ...extra }), sessions: () => sessions, sends, spoken, statuses, row,
        failNextRoute: () => { induceFailure = true; }, task: id => relay.getState().tasks.find(item => item.requestId === id) });
      row.passed = true;
    } catch (error) { row.failure = row.limitReason || reasonCode(error); }
    finally { await relay.cancel(); await relay.dispose(); relay = null; }
    console.log(JSON.stringify({ name, passed: row.passed, calls: row.calls.length, effects: row.effects, failure: row.failure }));
  }
  await scenario('project-close-all', 8, async f => {
    const result = await f.send('Close all terminals in the Recovery QA project, including paused terminals.');
    assert.equal(result.ok, true); assert.equal(f.row.effects.close, 8); assert.equal(f.sessions().length, 0);
  });
  await scenario('explicit-close-subset', 8, async f => {
    const result = await f.send('Close only worker-1 and worker-2 in Recovery QA. Leave every other terminal open.');
    assert.equal(result.ok, true); assert.equal(f.row.effects.close, 2);
    assert.deepEqual(f.sessions().map(item => item.id), ['worker-3', 'worker-4', 'worker-5', 'worker-6', 'worker-7', 'worker-8']);
  });
  await scenario('bound-new-codex', 0, async f => {
    const result = await f.send('Open a new Codex terminal in Recovery QA and investigate the partial terminal closure. Do not edit files.');
    assert.equal(result.ok, true); assert.equal(f.row.routeCalls, 0); assert.equal(f.row.effects.create, 1); assert.equal(f.row.effects.send, 1);
    assert.match(f.sends[0].text, /partial|clos/i); assert.match(f.sends[0].text, /do not edit|read.only|without.*edit/i);
  });
  await scenario('natural-failed-route-recovery', 0, async f => {
    f.failNextRoute(); const first = await f.send(recoveryObjective);
    assert.equal(first.ok, false); assert.equal(f.row.effects.create, 0); assert.equal(f.row.effects.send, 0);
    assert.equal(f.row.initialFailureScripted, true); assert.equal(f.row.routeCalls, 1, 'the first request must reach the deliberately failed normal route path');
    const second = await f.send('Look at my last request and action it.', { replyToRequestId: first.requestId });
    assert.equal(second.ok, true); assert.equal(f.row.effects.create, 1); assert.equal(f.row.effects.send, 1);
    assert.ok(!f.statuses.some(item => item.requestId === first.requestId && item.status === 'finished'));
    assert.match(f.sends[0].text, /do not edit|read.only|without.*edit/i);
  });
  await scenario('ambiguous-web-terminal-clause', 0, async f => {
    const result = await f.send('Open a new Codex terminal and a web terminal in Recovery QA to investigate the partial closure; do not edit files.');
    const question = f.task(result.requestId)?.question?.text || '';
    // This fixture advertises no web-terminal launcher. Clarification must
    // retain that unsupported clause, not silently deliver only the Codex task.
    assert.match(question, /web|terminal.*mean|which.*terminal|clarif/i);
    assert.equal(f.row.effects.send, 0); assert.equal(f.row.effects.create, 0);
    f.row.clausePreserved = true;
  });
  await scenario('creation-purpose-guard', 0, async f => {
    const result = await f.send(purposeObjectives['creation-purpose-guard']);
    assert.equal(f.row.initialProposalScripted, true); assert.equal(f.row.purposeReview, true, 'the real model must review the seeded draft purpose');
    assert.equal(result.ok, true); assert.equal(f.row.effects.create, 1); assert.equal(f.row.effects.send, 1);
    assert.match(f.sends[0].text, /partial|clos/i); assert.match(f.sends[0].text, /do not edit|read.only|without.*edit/i);
  });
  await scenario('ambiguous-creation-purpose-guard', 0, async f => {
    const result = await f.send(purposeObjectives['ambiguous-creation-purpose-guard']);
    assert.equal(f.row.initialProposalScripted, true); assert.equal(f.row.purposeReview, true, 'the real model must inspect the substituted terminal proposal');
    const task = f.task(result.requestId), question = task?.question?.text || '';
    assert.match(question, /web|which available terminal|terminal.*mean/i); assert.equal(task.status, 'needs-answer');
    assert.equal(f.row.effects.create, 0); assert.equal(f.row.effects.send, 0); assert.equal(f.row.effects.close, 0);
    f.row.clausePreserved = true;
  });
  for (const name of ['feature-description-history', 'feature-followup-history', 'fullscreen-history']) await scenario(name, 0, async f => {
    const text = name === 'feature-description-history'
      ? 'Open a new Codex terminal in Recovery QA. I want a different ding when Hey Lina starts listening and the current ding when a task is completed. Have Codex implement this behavior.'
      : name === 'feature-followup-history'
        ? 'I know you cannot change it yourself. Put a new Codex terminal in Recovery QA and prompt Codex to make this change.'
        : 'Open a new Claude Code terminal in Recovery QA and have it fix full-screen terminals. They currently fill the pane horizontally but not vertically. Make them fill the entire pane.';
    const result = await f.send(text);
    assert.equal(result.ok, true); assert.equal(f.row.effects.create, 1); assert.equal(f.row.effects.send, 1);
    assert.ok(f.row.calls.every(call => call.inputBytes <= 48000));
    if (name === 'fullscreen-history') { assert.match(f.sends[0].text, /vertical/i); assert.match(f.sends[0].text, /full.?screen|entire pane/i); }
    else { assert.match(f.sends[0].text, /listen/i); assert.match(f.sends[0].text, /complet/i); }
  });
  report.passed = report.cases.every(item => item.passed);
}
main().catch(error => { report.passed = false; report.failure = error.qaCode || 'harness-failure'; }).finally(async () => {
  try { await relay?.dispose(); } catch {}
  report.spent = spent; report.finishedAt = new Date().toISOString();
  fs.mkdirSync(run, { recursive: true }); fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, report: path.join(run, 'report.json'), spent, budget }));
  app.exit(report.passed ? 0 : 1);
});
