#!/usr/bin/env node
'use strict';
// Run the graded utterance corpus through the REAL app, on a scratch profile,
// against real provider panes whose model calls go to a local stub — and score
// the Brain under test on what the application recorded.
//
//   npm run smoke:orchestrator:ladder -- --tiers 1-4 --budget 2
//   npm run smoke:orchestrator:ladder -- --models openai/gpt-5.6-luna,google/gemini-3.8-flash
//   npm run smoke:orchestrator:ladder -- --scenario T2.1 --visible
//
// What costs money: the Brain, and only the Brain. Every pane turn is answered
// by scripts/qa/lib/stub-model-server.cjs, so a run's whole bill is the
// interpretation and reply calls the Orchestrator makes, capped per model by the
// app's own `spendingLimit` and re-checked here after every turn.
//
// What this exits non-zero for: harness failures only — a profile that would not
// launch, a pane that never reached its composer, a scenario that could not be
// set up. A Brain that fails every turn is a finished run with a bad scoreboard,
// which is the result, not an error.
const fs = require('node:fs');
const path = require('node:path');
const { createAppHarness, wait, defaultProfileRoot } = require('./lib/app-harness.cjs');
const { createStubModelServer } = require('./lib/stub-model-server.cjs');
const { gradeTurn } = require('./lib/ladder-grader.cjs');
const { loadLadderCorpus } = require('./lib/ladder-corpus.cjs');

const REPO = path.resolve(__dirname, '../..');
const REPORT_ROOT = path.join(REPO, '.tmp', 'orchestrator-ladder');
const DEFAULT_MODEL = 'openai/gpt-5.6-luna';
// The environment variable the relay reads for its API base. backend/orchestrator.cjs
// currently hardcodes `const API = 'https://openrouter.ai/api/v1'` (:71); with a
// one-line override reading this name, `--local-brain` points the Brain at a
// server on this machine and nothing else in the app changes.
const BRAIN_BASE_ENV = 'LINA_ORCHESTRATOR_API_BASE';
// A local server needs no credential, but the relay refuses to enable without
// one, so a session-only placeholder is configured instead of the installed key.
const LOCAL_BRAIN_KEY = 'local-brain';
// A pane the harness opens is dragged to this size before anything is typed into
// it; see app-harness.resizePane for why the board's own default is too small.
const PANE_SIZE = { cols: 100, rows: 28 };
// How long a held stub turn keeps a "working" pane busy: longer than any run.
const WORKING_SECONDS = 3600;

function parseArgs(argv) {
  const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };
  const tiers = new Set();
  for (const part of String(value('--tiers') || '1-4').split(',')) {
    const range = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!range) throw new Error(`Unreadable --tiers selector: ${part}`);
    for (let tier = Number(range[1]); tier <= Number(range[2] ?? range[1]); tier++) tiers.add(tier);
  }
  return {
    models: String(value('--models') || DEFAULT_MODEL).split(',').map(item => item.trim()).filter(Boolean),
    tiers,
    budget: Number(value('--budget') || 2),
    // A second, usually faster Brain for the interpretation stage only (the
    // app's optional interpretationModel setting); the models above execute.
    interpretationModel: value('--interpretation-model') || null,
    scenario: value('--scenario') || null,
    visible: argv.includes('--visible'),
    keepProfile: argv.includes('--keep-profile'),
    // Scenarios that need something this machine may not provide are opted into.
    environments: argv.includes('--include-claude') ? ['claude-pane'] : [],
    catalog: argv.includes('--catalog'),
    // An OpenAI-compatible server on this machine, used instead of OpenRouter as
    // the Brain. Needs the one-line API-base override described in the header.
    localBrain: value('--local-brain') || null,
    turnTimeoutMs: Number(value('--turn-timeout') || 240000),
  };
}

const slug = value => String(value).replace(/[^\w.-]+/g, '-');
const projectOf = (cwd, projects) => projects.find(project => sameFolder(project.path, cwd))?.name || null;
const sameFolder = (left, right) => String(left || '').replace(/[\\/]+$/, '').toLowerCase()
  === String(right || '').replace(/[\\/]+$/, '').toLowerCase();

/** Every pane the workspace holds, in the shape the grader reads. */
async function paneInventory(app, projects) {
  const state = await app.state();
  return state.sessions.map(session => ({ id: session.id, kind: session.kind, cwd: session.cwd,
    name: session.name, status: session.status, turnState: session.turnState,
    project: projectOf(session.cwd, projects) }));
}

// ---------------------------------------------------------------- scenario setup
async function buildPane(app, stub, pane, project, report) {
  const started = Date.now();
  const tag = pane.state === 'working' ? `[stub:slow:${WORKING_SECONDS}]`
    : pane.state === 'needs-input' ? '[stub:ask]'
    : `[stub:reply:${pane.marker}]`;
  // A finished pane is seeded the way the user would have started it: through
  // Lina, so it carries a work item, a title and a ledger row exactly as a
  // Lina-started pane does. The sentence is one the command compiler reads
  // deterministically (no Brain call) and it types the objective and tag
  // verbatim. A pane still working or parked on a question is typed into
  // directly instead, as a pane the user started by hand: a Lina-started task
  // holds its project's workspace lane until its turn ends
  // (docs/orchestrator-tasks.md, "may write to the same Git worktree wait for
  // earlier work"), and every later request in that project would queue behind
  // the seed for as long as the stub holds the turn. A pane with nothing to do
  // is simply opened.
  let target;
  if (pane.objective && pane.state === 'done') {
    const sentence = `start a ${pane.kind} terminal in ${project.name} and have it ${pane.objective}. ${tag}`;
    // A working or asking pane keeps its seeding request open for as long as
    // the stub holds the turn; the receipts are what setup needs, and they are
    // written at delivery, so only a finished pane is waited for.
    const seeded = await app.submit({ text: sentence, projectPath: project.path, timeoutMs: pane.state === 'done' ? 120000 : 20000 });
    const created = (seeded.receipts || []).find(receipt => receipt.kind === 'create_session' && receipt.targetId);
    const delivered = (seeded.receipts || []).some(receipt => receipt.kind === 'send_prompt' && ['written', 'submitted', 'accepted'].includes(receipt.status));
    if (created && delivered) {
      const session = await app.state().then(state => state.sessions.find(item => item.id === created.targetId));
      if (!session) throw new Error(`seeded pane ${pane.ref} is not in the inventory`);
      target = { id: session.id, kind: pane.kind, cwd: project.path, generation: session.generation, launchToken: session.launchToken };
      await app.resizePane(target, PANE_SIZE);
      report.push({ ref: pane.ref, id: target.id, state: pane.state, seededBy: 'relay', requestId: seeded.requestId, openedMs: Date.now() - started });
    } else report.push({ ref: pane.ref, seededBy: 'relay-refused', task: seeded.task?.status, error: seeded.task?.error || seeded.error || null });
  }
  if (!target) {
    target = await app.createPane({ cwd: project.path, kind: pane.kind });
    await app.resizePane(target, PANE_SIZE);
    await app.waitForPaneReady(target);
  }
  const openedMs = Date.now() - started;
  if (pane.state === 'idle') { report.push({ ref: pane.ref, id: target.id, state: 'idle', openedMs }); return target; }
  if (report.at(-1)?.seededBy === 'relay') {
    if (pane.state === 'done') await app.waitForPane(target, new RegExp(pane.marker), `${pane.ref} finished`, 180000);
    else if (pane.state === 'needs-input') await app.waitForPane(target,
      /Should I go ahead|Do you want to proceed|(1 unanswered)|Yes, and don't ask again/i, `${pane.ref} waiting on a question`, 180000);
    else await app.waitForPane(target, /esc to interrupt|Working|Esc to interrupt/i, `${pane.ref} working`, 180000);
    report.at(-1).settledMs = Date.now() - started;
    return target;
  }
  const text = `${pane.objective}. ${tag}`;
  // The first write into a pane that has just reached its composer can lose the
  // race with the pane's own startup repaint (the fence then refuses the stale
  // evidence). That is the app being careful, not a scenario failing, so the
  // setup asks again a few times before it gives up.
  let sent;
  for (let attempt = 1; attempt <= 5; attempt++) {
    sent = await app.sendToPane(target, text);
    if (sent?.ok !== false) break;
    await wait(2000);
  }
  if (sent?.ok === false) throw new Error(`setup prompt refused for ${pane.ref}: ${JSON.stringify(sent).slice(0, 400)}`);
  if (pane.state === 'done') await app.waitForPane(target, new RegExp(pane.marker), `${pane.ref} finished`, 180000);
  else if (pane.state === 'needs-input') await app.waitForPane(target,
    /Should I go ahead|Do you want to proceed|\(1 unanswered\)|Yes, and don't ask again/i, `${pane.ref} waiting on a question`, 180000);
  else await app.waitForPane(target, /esc to interrupt|Working|Esc to interrupt/i, `${pane.ref} working`, 180000);
  report.push({ ref: pane.ref, id: target.id, state: pane.state, openedMs, settledMs: Date.now() - started });
  return target;
}

// ---------------------------------------------------------------- one turn
async function runTurn(app, turn, context) {
  const { projects, refs, turnTargetIds, options } = context;
  const panesBefore = await paneInventory(app, projects);
  const from = turn.from ? projects.find(project => project.name === turn.from) : null;
  const started = Date.now();
  // A turn that accepts an unsettled task (a follow-up queued behind a working
  // agent) says how long to wait for it; every other turn waits the run's limit.
  const submitted = await app.submit({ text: turn.text, projectPath: from?.path, timeoutMs: turn.settleMs || options.turnTimeoutMs });
  // Receipts and the ledger are written when the relay publishes; give the
  // publication a moment rather than racing it.
  await wait(1500);
  const panesAfter = await paneInventory(app, projects);
  const resolve = ref => {
    if (!ref) return null;
    if (ref.startsWith('@')) return turnTargetIds.get(ref.slice(1)) || null;
    return refs.get(ref)?.id || null;
  };
  // Read the screen of every pane the turn's checks name, plus anything new.
  const wanted = new Set();
  for (const ref of [turn.expect?.paneScreenMatches?.ref, turn.expect?.targetRef].filter(Boolean)) {
    // Braced on purpose: the else belongs to the ref check, not to the inner
    // pane test, or a named target pane is never read.
    if (ref === 'created') { for (const pane of panesAfter) if (!panesBefore.some(item => item.id === pane.id)) wanted.add(pane.id); }
    else { const id = resolve(ref); if (id) wanted.add(id); }
  }
  for (const pane of panesAfter) if (!panesBefore.some(item => item.id === pane.id)) wanted.add(pane.id);
  const screens = {};
  for (const id of wanted) {
    const pane = panesAfter.find(item => item.id === id);
    if (!pane) continue;
    const state = await app.state();
    const session = state.sessions.find(item => item.id === id);
    const screen = session ? await app.readPane({ id, generation: session.generation }, 4000) : null;
    screens[id] = screen?.ok ? screen.text : '';
  }
  const ledgerRows = app.ledger().filter(row => row.requestId === submitted.requestId);
  // The final sentence and the receipts are published a beat after the task
  // settles (a failed interpretation's "I don't have the answer that terminal
  // is waiting for" was graded as an empty reply); read them again now that
  // the publication has had its moment.
  const settledState = await app.state();
  const ofRequest = items => (items || []).filter(item => item.requestId === submitted.requestId);
  const receipts = ofRequest(settledState.receipts).length ? ofRequest(settledState.receipts) : submitted.receipts || [];
  const messages = ofRequest(settledState.messages).length ? ofRequest(settledState.messages) : submitted.messages || [];
  const evidence = { panesBefore, panesAfter, screens, ledgerRows, receipts, messages, task: submitted.task };
  const graded = gradeTurn(turn, evidence, resolve);
  const metrics = app.requestMetrics(submitted.requestId || '');
  // Remember which pane this turn used, so a later turn can say "@thisTurn".
  const primary = graded.observed.delivered[0] || graded.observed.effects[0] || null;
  if (primary) turnTargetIds.set(turn.id, primary);
  return {
    id: turn.id, row: turn.row ?? null, synthetic: Boolean(turn.synthetic), text: turn.text,
    verdict: graded.verdict, failures: graded.failures, harmful: graded.harmful, notes: graded.notes,
    projectPath: from?.path ?? null,
    elapsedMs: Date.now() - started, acceptanceMs: submitted.acceptanceMs, timedOut: submitted.timedOut,
    taskStatus: submitted.task?.status ?? null, taskError: submitted.task?.error ?? null,
    modelCalls: metrics.modelCalls, modelFailures: metrics.modelFailures, firstEffectMs: metrics.firstEffectMs,
    diagnosticErrors: metrics.errors,
    evidence: { observed: graded.observed, ledgerRows,
      receipts: receipts.map(receipt => ({ kind: receipt.kind, status: receipt.status,
        targetId: receipt.targetId, text: String(receipt.text || '').slice(0, 300) })),
      screens: Object.fromEntries(Object.entries(screens).map(([id, text]) => [id, String(text).slice(-1200)])) },
  };
}

// ---------------------------------------------------------------- one model
async function runModel(model, corpus, options, runDir) {
  const modelDir = path.join(runDir, slug(model));
  fs.mkdirSync(modelDir, { recursive: true });
  const stub = await createStubModelServer({});
  const report = { model, startedAt: new Date().toISOString(), scenarios: [], stub: { requests: 0 } };
  let app;
  try {
    // One profile per run AND per model: a scratch profile that outlived its run
    // still holds the projects this one is about to create.
    // Every model call's request body and response, written beside the run. It
    // is the only way to quote what the Brain actually asked for when the app
    // refuses it (a fabricated work item, a malformed grant), and it holds no
    // credential — the runtime redacts key-shaped strings. Kept out of the
    // scoreboard: these files are large and are read by hand.
    const modelDebugDir = path.join(modelDir, 'model-calls');
    fs.mkdirSync(modelDebugDir, { recursive: true });
    app = await createAppHarness({ runRoot: modelDir, model, budget: options.budget, interpretationModel: options.interpretationModel,
      profileRoot: defaultProfileRoot(`${path.basename(runDir)}-${slug(model)}`),
      stubBaseUrl: stub.baseUrl, hidden: !options.visible,
      ...(options.localBrain && { sessionKey: LOCAL_BRAIN_KEY }),
      extraEnv: { LINA_MODEL_DEBUG_DIR: modelDebugDir, LINA_MODEL_DEBUG_ALL: '1',
        ...(options.localBrain && { [BRAIN_BASE_ENV]: options.localBrain }) } });
    report.brainEndpoint = options.localBrain || 'https://openrouter.ai/api/v1';
    report.modelCallDir = modelDebugDir;
    report.coldStartMs = app.coldStartMs;
    report.profileRoot = app.profileRoot;
    report.seeded = app.seeded;
    await app.enableBrain();
    report.brainReadyMs = Date.now() - new Date(report.startedAt).getTime();

    const projects = [];
    for (const name of corpus.projects) projects.push(await app.createProject(name));
    report.projects = projects.map(project => ({ name: project.name, path: project.path }));
    await app.waitForInventory(projects.map(project => project.path));
    // What this scratch app believes is installed, recorded at the top of every
    // model's report: a run is only comparable with the user's machine if the
    // same launchers are on offer.
    report.installedClis = (await app.installedClis().catch(() => null))?.clis || null;

    for (const scenario of corpus.scenarios) {
      const scenarioStarted = Date.now();
      const entry = { id: scenario.id, tier: scenario.tier, title: scenario.title, setup: [], turns: [] };
      report.scenarios.push(entry);
      try {
        await app.resetWorkspace();
        const refs = new Map();
        for (const pane of scenario.setup.panes || []) {
          const project = projects.find(item => item.name === pane.project);
          if (!project) throw new Error(`scenario ${scenario.id} names an unknown project ${pane.project}`);
          refs.set(pane.ref, await buildPane(app, stub, pane, project, entry.setup));
        }
        entry.setupMs = Date.now() - scenarioStarted;
        const context = { projects, refs, turnTargetIds: new Map(), options };
        for (const turn of scenario.turns) {
          const spend = Object.values(await app.spend()).reduce((total, value) => total + value, 0);
          if (spend >= options.budget) { entry.stopped = `budget reached at $${spend.toFixed(4)}`; break; }
          try { entry.turns.push(await runTurn(app, turn, context)); }
          catch (error) {
            entry.turns.push({ id: turn.id, row: turn.row ?? null, verdict: 'fail', failures: [`harness error: ${error.message}`],
              harmful: [], notes: [], text: turn.text });
          }
        }
      } catch (error) {
        entry.setupError = error.message;
      }
      entry.elapsedMs = Date.now() - scenarioStarted;
      console.log(JSON.stringify({ scenario: entry.id, setupError: entry.setupError,
        turns: entry.turns.map(turn => `${turn.id}:${turn.verdict}`).join(' '), ms: entry.elapsedMs }));
    }
    report.usage = await app.spend();
    report.evidenceFiles = app.collectEvidence(path.join(modelDir, 'profile-evidence'));
  } catch (error) {
    report.error = error.stack || String(error);
    throw Object.assign(error, { report });
  } finally {
    report.stub.requests = stub.requests.length;
    report.stub.behaviours = stub.requests.reduce((counts, request) => {
      counts[request.behaviour] = (counts[request.behaviour] || 0) + 1; return counts; }, {});
    fs.writeFileSync(path.join(modelDir, 'stub-requests.json'), JSON.stringify(stub.requests.map(request =>
      ({ at: request.at, format: request.format, behaviour: request.behaviour, side: request.side,
        prompt: String(request.prompt).slice(-300) })), null, 2));
    await app?.close();
    await stub.close();
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(modelDir, 'report.json'), JSON.stringify(report, null, 2));
  }
  return report;
}

// ---------------------------------------------------------------- scoreboard
function summarize(report) {
  const turns = report.scenarios.flatMap(scenario => scenario.turns);
  const byTier = {};
  for (const scenario of report.scenarios) {
    const tier = byTier[scenario.tier] ||= { pass: 0, fail: 0, question: 0, harmful: 0, setupErrors: 0 };
    if (scenario.setupError) tier.setupErrors++;
    for (const turn of scenario.turns) {
      tier[turn.verdict] = (tier[turn.verdict] || 0) + 1;
      tier.harmful += (turn.harmful || []).length ? 1 : 0;
    }
  }
  const numbers = key => turns.map(turn => turn[key]).filter(value => Number.isFinite(value));
  const mean = values => values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : null;
  const tracking = report.scenarios.filter(scenario => scenario.tier === 4).flatMap(scenario => scenario.turns);
  return {
    model: report.model, turns: turns.length,
    pass: turns.filter(turn => turn.verdict === 'pass').length,
    question: turns.filter(turn => turn.verdict === 'question').length,
    fail: turns.filter(turn => turn.verdict === 'fail').length,
    harmfulActions: turns.reduce((total, turn) => total + (turn.harmful || []).length, 0),
    byTier,
    trackingAccuracy: tracking.length ? Number((tracking.filter(turn => turn.verdict !== 'fail').length / tracking.length * 100).toFixed(1)) : null,
    modelCallsPerTurn: mean(numbers('modelCalls')),
    secondsToFirstEffect: mean(numbers('firstEffectMs').map(value => value / 1000)),
    meanTurnSeconds: mean(numbers('elapsedMs').map(value => value / 1000)),
    meanAcceptanceMs: mean(numbers('acceptanceMs')),
    timedOut: turns.filter(turn => turn.timedOut).length,
    cost: Number((Object.values(report.usage || {}).reduce((a, b) => a + b, 0)).toFixed(4)),
    brainCost: Number((report.usage?.brain || 0).toFixed(4)),
    coldStartMs: report.coldStartMs, stubRequests: report.stub.requests,
    error: report.error ? String(report.error).split('\n')[0] : undefined,
  };
}

function markdown(run, summaries, reports) {
  const lines = [`# Orchestrator completion ladder — ${run.at}`, '',
    `Corpus: \`scripts/backend/fixtures/orchestrator-completion-ladder.json\` (tiers ${[...run.tiers].join(', ')}).`,
    'Pane turns ran against a local stub and cost nothing; the Brain is the real configured OpenRouter model.', '',
    '| model | turns | pass | question | fail | harmful | tracking (T4) | model calls/turn | s to first effect | cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const summary of summaries) {
    lines.push(`| ${summary.model} | ${summary.turns} | ${summary.pass} | ${summary.question} | ${summary.fail} | `
      + `${summary.harmfulActions} | ${summary.trackingAccuracy ?? 'n/a'}% | ${summary.modelCallsPerTurn ?? 'n/a'} | `
      + `${summary.secondsToFirstEffect ?? 'n/a'} | $${summary.cost} |`);
  }
  if (run.skipped?.length) {
    lines.push('', '## Not run', '');
    for (const scenario of run.skipped) lines.push(`- **${scenario.id}** ${scenario.title} — needs \`${scenario.environment}\`; pass \`--include-claude\` to try it anyway.`);
  }
  if (run.deviations?.length) {
    lines.push('', '## Corpus deviations', '');
    for (const note of run.deviations) lines.push(`- ${note}`);
  }
  for (const report of reports) {
    lines.push('', `## ${report.model}`, '');
    lines.push('| turn | row | verdict | task | model calls | s | why |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const scenario of report.scenarios) {
      if (scenario.setupError) lines.push(`| ${scenario.id} | setup | fail | — | — | — | ${scenario.setupError.replace(/\|/g, '/')} |`);
      for (const turn of scenario.turns) {
        lines.push(`| ${turn.id} | ${turn.row ? `#${turn.row}` : 'SYN'} | ${turn.verdict} | ${turn.taskStatus ?? '—'} | `
          + `${turn.modelCalls ?? '—'} | ${turn.elapsedMs ? Math.round(turn.elapsedMs / 1000) : '—'} | `
          + `${(turn.failures || []).join('; ').slice(0, 220).replace(/\|/g, '/') || ''} |`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

// Scratch profiles are kept after a run so their ledger, memory and diagnostics
// can be read, but they are whole Electron profiles and they add up. Anything
// older than the window goes.
function pruneOldProfiles(maxAgeMs) {
  if (!Number.isFinite(maxAgeMs)) return [];
  const root = path.dirname(defaultProfileRoot('x'));
  const removed = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs < maxAgeMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(entry.name);
    } catch { /* a profile still in use stays */ }
  }
  return removed;
}

/**
 * Print the Brain candidates the app itself would offer, cheapest first.
 *
 * One launch, no request, no spend: `models('brain')` is the app's own
 * `brainCatalog()` — the catalog entries that declare tool support — and
 * fetching it is a plain GET. The prices are per token as OpenRouter states
 * them; the per-million figures are what a ladder is actually chosen on.
 */
async function printCatalog(options, runDir) {
  const stub = await createStubModelServer({});
  const modelDir = path.join(runDir, 'catalog');
  fs.mkdirSync(modelDir, { recursive: true });
  let app;
  try {
    app = await createAppHarness({ runRoot: modelDir, model: options.models[0], budget: 0,
      profileRoot: defaultProfileRoot(`${path.basename(runDir)}-catalog`),
      stubBaseUrl: stub.baseUrl, hidden: !options.visible });
    const models = await app.evaluate("window.vibe.orchestrator.models('brain')", 120000);
    const priced = models.map(model => ({ id: model.id, name: model.name,
      promptPerMillion: Number(model.pricing?.prompt || 0) * 1e6,
      completionPerMillion: Number(model.pricing?.completion || 0) * 1e6,
      contextLength: model.contextLength, reasoning: model.reasoning }))
      .sort((left, right) => (left.promptPerMillion + left.completionPerMillion) - (right.promptPerMillion + right.completionPerMillion));
    fs.writeFileSync(path.join(runDir, 'brain-catalog.json'), JSON.stringify(priced, null, 2));
    const anchor = priced.find(model => model.id === DEFAULT_MODEL);
    console.log(`${priced.length} tool-capable Brain models; anchor ${DEFAULT_MODEL} at `
      + `$${anchor ? anchor.promptPerMillion.toFixed(2) : '?'}/$${anchor ? anchor.completionPerMillion.toFixed(2) : '?'} per M in/out`);
    console.log('| model | $/M in | $/M out | context | reasoning |');
    console.log('| --- | --- | --- | --- | --- |');
    for (const model of priced) {
      console.log(`| ${model.id} | ${model.promptPerMillion.toFixed(3)} | ${model.completionPerMillion.toFixed(3)} `
        + `| ${model.contextLength ?? '?'} | ${model.reasoning ? 'yes' : 'no'} |`);
    }
    console.log(`Catalog: ${path.join(runDir, 'brain-catalog.json')}`);
  } finally {
    await app?.close();
    await stub.close();
  }
}

// ---------------------------------------------------------------- main
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.catalog) {
    const runDir = path.join(REPORT_ROOT, `catalog-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(runDir, { recursive: true });
    return printCatalog(options, runDir);
  }
  const corpus = loadLadderCorpus({ tiers: options.tiers, scenario: options.scenario, environments: options.environments });
  if (!corpus.scenarios.length) throw new Error('No scenario matched the selection.');
  const at = new Date().toISOString();
  const runDir = path.join(REPORT_ROOT, `${at.replace(/[:.]/g, '-')}-${process.pid}`);
  fs.mkdirSync(runDir, { recursive: true });
  pruneOldProfiles(options.keepProfile ? Infinity : 2 * 24 * 60 * 60 * 1000);
  console.log(`Ladder run ${runDir}`);
  console.log(`${corpus.scenarios.length} scenario(s), ${corpus.scenarios.reduce((total, scenario) => total + scenario.turns.length, 0)} turn(s), `
    + `models ${options.models.join(', ')}, budget $${options.budget} per model`);
  const reports = [], summaries = [];
  let harnessError = null;
  for (const model of options.models) {
    try {
      const report = await runModel(model, corpus, options, runDir);
      reports.push(report); summaries.push(summarize(report));
    } catch (error) {
      harnessError = error;
      const report = error.report || { model, scenarios: [], stub: { requests: 0 }, error: String(error.message) };
      reports.push(report); summaries.push(summarize(report));
      console.error(`Model ${model} could not be run: ${error.message}`);
    }
  }
  const run = { at, tiers: [...options.tiers], budget: options.budget, models: options.models,
    corpus: 'scripts/backend/fixtures/orchestrator-completion-ladder.json',
    skipped: corpus.skipped, deviations: corpus.deviations, summaries };
  fs.writeFileSync(path.join(runDir, 'scoreboard.json'), JSON.stringify({ ...run, reports }, null, 2));
  fs.writeFileSync(path.join(runDir, 'scoreboard.md'), markdown(run, summaries, reports));
  console.log(markdown(run, summaries, []));
  console.log(`Scoreboard: ${path.join(runDir, 'scoreboard.json')}`);
  // A bad Brain is the finding, not an error; only a harness failure fails.
  if (harnessError) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { parseArgs, summarize, markdown, REPORT_ROOT };
