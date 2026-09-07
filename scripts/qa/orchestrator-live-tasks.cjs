'use strict';
// Live model evaluation; adapters are isolated in-memory terminals, never user's panes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename, '--live-child'], { env, windowsHide: true, stdio: 'inherit', timeout: 900000 });
  process.exit(child.status ?? 1);
}
const { app, safeStorage } = require('electron');
const run = path.resolve(__dirname, '../../.tmp/orchestrator-live-tasks', `${Date.now()}-${process.pid}`);
app.setPath('userData', path.join(run, 'electron'));
// Windows OSCrypt requires the installed encrypted master key, not just DPAPI.
// Copy only its encrypted Local State section into disposable Electron storage.
const installedLocalState = path.join(process.env.APPDATA, 'vibe-terminal', 'Local State');
if (fs.existsSync(installedLocalState)) {
  const { os_crypt } = JSON.parse(fs.readFileSync(installedLocalState, 'utf8'));
  if (os_crypt) { fs.mkdirSync(path.join(run, 'electron'), { recursive: true }); fs.writeFileSync(path.join(run, 'electron', 'Local State'), JSON.stringify({ os_crypt })); }
}
const report = { boundary: 'Live configured Brain/default interpreter; in-memory disposable terminal adapters, no real PTY or user terminal access.', cases: [], calls: [], actions: [], startedAt: new Date().toISOString() };
let relay, secret = '';
const clean = value => String(value || '').split(secret || '\0').join('[REDACTED]');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  await app.whenReady();
  const { createSettings } = require('../../backend/orchestratorSettings.cjs');
  const { createOrchestrator } = require('../../backend/orchestrator.cjs');
  const installed = createSettings({ userDataPath: path.join(process.env.APPDATA, 'vibe-terminal'), secureStorage: safeStorage });
  secret = installed.getKey(); const model = installed.getSettings().model;
  assert(secret && model, 'Installed model/key unavailable through safeStorage');
  report.model = model; report.spendingLimit = Number(process.env.VIBE_LIVE_BUDGET || .5);
  fs.mkdirSync(run, { recursive: true });
  const sessions = ['Atlas', 'Beacon', 'Cedar', 'Delta', 'Ember'].map((name, i) => {
    const cwd = path.join(run, ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'][i]); fs.mkdirSync(cwd);
    return { id: `fixture-${name.toLowerCase()}`, name, title: name, cwd, generation: 1, kind: 'codex', status: 'running', turnState: 'idle', lastActivityAt: Date.now() };
  });
  if (process.env.VIBE_LIVE_PROBE === '1') {
    const { INTENT_SYSTEM, INTENT_TOOL } = require('../../backend/orchestratorIntent.cjs');
    const legacy = structuredClone(INTENT_TOOL);
    for (const key of ['afterResults', 'access', 'executionMode', 'dependsOnRequestIds']) delete legacy.function.parameters.properties[key];
    const simple = { type: 'function', function: { name: 'interpret_workspace', description: 'Interpret instruction.', parameters: { type: 'object', properties: { goal: { type: 'string' }, actions: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' } } } } }, required: ['goal', 'actions'] } } };
    const messages = [{ role: 'system', content: INTENT_SYSTEM }, { role: 'user', content: JSON.stringify({ instruction: 'Tell Atlas to inspect fixture marker PROBE.', sessions, roots: { documents: run }, tasks: [] }) }];
    const forced = { type: 'function', function: { name: 'interpret_workspace' } };
    let cost = 0;
    for (const [name, tool, toolChoice] of [['full-forced', INTENT_TOOL, forced], ['legacy-forced', legacy, forced], ['minimal-forced', simple, forced], ['full-auto', INTENT_TOOL, 'auto'], ['minimal-auto', simple, 'auto']]) {
      if (cost >= report.spendingLimit) throw Error('Probe spending cap reached');
      const start = Date.now();
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000), body: JSON.stringify({ model, messages, tools: [tool], tool_choice: toolChoice, temperature: 0, max_tokens: 1024 }) });
      const data = await response.json(); cost += data.usage?.cost || 0;
      const item = { name, status: response.status, elapsedMs: Date.now() - start, cost: data.usage?.cost || 0, finishReason: data.choices?.[0]?.finish_reason, toolCalls: data.choices?.[0]?.message?.tool_calls?.length, ...(!response.ok && { providerError: clean([data.error?.message, data.error?.metadata?.raw].filter(Boolean).join(': ')).slice(0, 1500) }) };
      report.calls.push(item); console.log(JSON.stringify(item));
    }
    report.ok = report.calls.every(item => item.status === 200); report.usage = { brain: cost }; return;
  }
  const outputs = new Map(), actions = report.actions, readEvents = [], dependencyEvidence = [], timers = new Set();
  const request = async (url, options) => {
    if (url.endsWith('/chat/completions') && options?.body) {
      const body = JSON.parse(options.body);
      if (body.tools?.some(tool => tool.function?.name === 'interpret_workspace')) for (const message of body.messages || []) {
        if (message.role !== 'user') continue;
        try { const context = JSON.parse(message.content); if (context.dependencyResults?.length) dependencyEvidence.push({ at: Date.now(), instruction: context.instruction, dependencyResults: context.dependencyResults }); } catch {}
      }
    }
    const start = Date.now(), stage = url.endsWith('/chat/completions') ? 'model' : url.endsWith('/models') ? 'models' : 'credentials';
    try {
      const response = await fetch(url, options);
      const row = { stage, elapsedMs: Date.now() - start, status: response.status };
      if (stage === 'model') { const data = await response.clone().json(); row.cost = data.usage?.cost || 0; row.tokens = data.usage?.total_tokens; if (!response.ok) row.providerError = clean([data.error?.message, data.error?.metadata?.raw].filter(Boolean).join(': ')).slice(0, 1500); }
      report.calls.push(row); return response;
    } catch (error) { report.calls.push({ stage, elapsedMs: Date.now() - start, error: clean(error.message) }); throw error; }
  };
  relay = createOrchestrator({ userDataPath: path.join(run, 'userData'), fetch: request,
    getRoots: () => ({ documents: run, projects: sessions.map(s => ({ name: path.basename(s.cwd), path: s.cwd })) }),
    getSessions: () => sessions.map(s => ({ ...s })),
    readSession: async input => {
      assert(sessions.some(s => s.id === input.id), 'Read escaped fixture sessions');
      const result = outputs.get(input.id) || { text: 'Fixture is ready and idle.' };
      readEvents.push({ targetId: input.id, at: Date.now(), completedTurnId: result.completedResult?.turnId });
      return { ok: true, ...result };
    },
    dispatchAction: async action => {
      assert.equal(action.kind, 'send_prompt', 'Only send_prompt fixture effects are allowed');
      const session = sessions.find(s => s.id === action.targetId); assert(session, 'Action escaped fixture sessions');
      assert.equal(action.generation, session.generation, 'Generation mismatch');
      const turnId = `fixture-turn-${actions.length + 1}`;
      const row = { targetId: session.id, prompt: action.text, actionId: action.actionId, turnId, at: Date.now() };
      actions.push(row);
      Object.assign(session, { turnId, turnState: 'running', turnStartedAt: Date.now(), actionId: action.actionId });
      const timer = setTimeout(async () => {
        timers.delete(timer);
        const text = /review/i.test(action.text) ? 'Review complete: fixture bug ALPHA-17. Fix the missing empty-input guard.' : 'Fixture task complete.';
        Object.assign(session, { turnState: 'completed', completedActionId: action.actionId, completedTurnId: turnId, lastActivityAt: Date.now() });
        outputs.set(session.id, { text, completedResult: { turnId, text, actionId: action.actionId } });
        row.completedAt = Date.now(); await relay.refresh();
      }, /review/i.test(action.text) ? 1200 : 150);
      timers.add(timer);
      return { ok: true, status: 'delivered', turnId };
    },
  });
  const configured = await relay.configure({ apiKey: secret, sessionOnly: true, model, spendingLimit: report.spendingLimit });
  assert.equal(configured.ok, true, 'Fixture configure failed'); assert.equal((await relay.setEnabled(true)).ok, true, 'Fixture enable failed');
  const submit = text => { const start = performance.now(); const ack = relay.enqueue({ text, origin: 'text' }); assert(ack.ok, clean(ack.error)); assert(performance.now() - start < 250, 'Acceptance exceeded250ms'); return ack; };
  const wait = async id => {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const task = relay.getState().tasks.find(t => t.requestId === id);
      if (task && ['finished', 'failed', 'paused', 'needs-answer', 'cancelled'].includes(task.status)) return task;
      await delay(100);
    }
    throw Error('Live task exceeded180-second evaluation deadline');
  };
  const scenario = async (name, fn) => { const start = Date.now(); try { await fn(); report.cases.push({ name, ok: true, elapsedMs: Date.now() - start }); } catch (error) { report.cases.push({ name, ok: false, elapsedMs: Date.now() - start, error: clean(error.message) }); } console.log(JSON.stringify(report.cases.at(-1))); };
  await scenario('five-rapid-distinct-targets', async () => {
    const start = actions.length;
    const acks = sessions.map(s => submit(`Tell ${s.name} in the ${path.basename(s.cwd)} project to inspect fixture marker CHECK-${s.name.toUpperCase()} and report its result.`));
    assert.equal(new Set(acks.map(a => a.requestId)).size, 5);
    const tasks = await Promise.all(acks.map(a => wait(a.requestId)));
    assert(tasks.every(t => t.status === 'finished'), `Task statuses: ${tasks.map(t => t.status).join(',')}`);
    const sent = actions.slice(start); assert.equal(sent.length, 5);
    sessions.forEach(s => { const matched = sent.filter(a => a.targetId === s.id); assert.equal(matched.length, 1); assert(matched[0].prompt.includes(`CHECK-${s.name.toUpperCase()}`)); });
  });
  if (report.calls.some(c => c.stage === 'model') && report.calls.filter(c => c.stage === 'model').every(c => c.status >= 400)) throw Error('All live model requests rejected; remaining scenarios blocked by provider failure.');
  await scenario('same-target-review-then-fix-observed-findings', async () => {
    const start = actions.length;
    const review = submit('Tell Atlas in Alpha to review the fixture for bugs and report findings.');
    const fix = submit('After that review finishes, tell Atlas to fix the findings from that review without changing public APIs.');
    assert.equal((await wait(review.requestId)).status, 'finished'); assert.equal((await wait(fix.requestId)).status, 'finished');
    const sent = actions.slice(start); assert.equal(sent.length, 2); assert(sent.every(a => a.targetId === sessions[0].id));
    assert(sent[1].at >= sent[0].completedAt, 'Fix dispatched before observed review completion');
    assert(readEvents.some(r => r.completedTurnId === sent[0].turnId && r.at <= sent[1].at), 'Review completion was never read before fix');
    assert(dependencyEvidence.some(e => e.at <= sent[1].at && e.dependencyResults.some(r => r.result?.turnId === sent[0].turnId && /ALPHA-17/.test(r.result?.text))), 'Exact review result did not reach dependency interpreter');
    assert.match(sent[1].prompt, /without changing public APIs|preserve.*public APIs|do not change.*public APIs/i, 'Original API constraint was lost');
  });
  await scenario('explicit-beta-to-alpha-status-switch-and-pronoun', async () => {
    assert.equal((await wait(submit('Tell Beacon in Beta to inspect SWITCH-BETA.').requestId)).status, 'finished');
    const start = actions.length;
    assert.equal((await wait(submit('What is Atlas in Alpha doing right now?').requestId)).status, 'finished');
    assert.equal((await wait(submit('Tell it to inspect SWITCH-ALPHA.').requestId)).status, 'finished');
    const sent = actions.slice(start); assert.equal(sent.length, 1); assert.equal(sent[0].targetId, sessions[0].id); assert.match(sent[0].prompt, /SWITCH-ALPHA/);
  });
  await scenario('ambiguous-new-worker-clarification-and-scoped-answer', async () => {
    const start = actions.length;
    const ack = submit('A different worker should inspect marker CHOOSE-WORKER. I have not chosen which terminal yet; ask me which terminal before sending it.');
    const task = await wait(ack.requestId); assert.equal(task.status, 'needs-answer'); assert(task.question?.id);
    assert.equal(actions.length, start, 'Ambiguous task dispatched before answer');
    const answer = relay.enqueue({ text: 'Cedar in Gamma.', origin: 'text', replyToRequestId: ack.requestId, questionId: task.question.id }); assert(answer.ok);
    assert.equal((await wait(answer.requestId)).status, 'finished');
    const sent = actions.slice(start); assert.equal(sent.length, 1); assert.equal(sent[0].targetId, sessions[2].id); assert.match(sent[0].prompt, /CHOOSE-WORKER/);
  });
  report.dependencyEvidence = dependencyEvidence; report.actions = actions; report.usage = relay.getState().usage; report.tasks = relay.getState().tasks.map(({ requestId, status, targetIds, dependsOn, error }) => ({ requestId, status, targetIds, dependsOn, error }));
  for (const timer of timers) clearTimeout(timer);
  report.ok = report.cases.every(c => c.ok);
}
main().catch(error => { report.ok = false; report.error = clean(error.message); }).finally(async () => {
  if (relay) { const state = relay.getState(); report.usage = state.usage; report.tasks = state.tasks.map(({ requestId, status, targetIds, dependsOn, error }) => ({ requestId, status, targetIds, dependsOn, error })); }
  try { await relay?.dispose(); } catch {}
  fs.mkdirSync(run, { recursive: true });
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, model: report.model, report: path.join(run, 'report.json'), error: report.error, calls: report.calls.length, usage: report.usage }));
  app.exit(report.ok ? 0 : 1);
});
