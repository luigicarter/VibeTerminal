'use strict';
// Fidelity of a request to a plan, measured on the saved utterance corpus.
//
// Two readers of the same 128 sentences are scored against the same expected
// plans: the deterministic compiler, which costs nothing and may decline, and
// the configured Brain, which always answers and costs money. The compiler's
// number that matters is precision - of the rows it accepted, how many it read
// correctly - because a wrong compilation types a task into the wrong pane.
// The Brain's number is accuracy over every row it was given.
//
// Offline (--compiler-only) runs the compiler alone in plain node: no network,
// no credentials, no model call. Live (the default) re-spawns under Electron
// for the installed key and runs the real interpretation path for the selected
// rows, inside a hard spend cap.
//
//   node scripts/qa/orchestrator-fidelity-live.cjs --compiler-only
//   node scripts/qa/orchestrator-fidelity-live.cjs --rows 1-20
//
// Boundary: the roster and projects are a fixture built from each row's own
// project and provider labels, not a live workspace, and no terminal is opened
// or written to. Selector agreement is only scored for the corpus selectors
// that have a resolver equivalent; the rest are reported as unscored.
const fs = require('node:fs');
const path = require('node:path');
const { compileCommand } = require('../../backend/orchestratorCommandCompiler.cjs');
const { normalizeInstruction } = require('../../backend/orchestratorVocabulary.cjs');
const { identifyProject } = require('../../backend/orchestratorPolicy.cjs');
const { extractSelector } = require('../../backend/orchestratorResolver.cjs');

const CORPUS = require('../backend/fixtures/orchestrator-utterances.json');
const REPORT_ROOT = path.resolve(__dirname, '../../.tmp/orchestrator-fidelity');
// The projects the corpus was spoken into. "Lunar Terminal" stays unregistered:
// one row asks for a project that does not exist, and that is the right answer.
const PROJECTS = ['vibeTerminal', 'Ternary model dev', 'lina web app', 'lina mobile']
  .map(name => ({ name, path: path.win32.join('C:/Projects', name.replace(/\s+/g, '-')) }));
const LAUNCHERS = [['codex', 'Codex'], ['claude', 'Claude Code'], ['codex-web', 'Codex Web'],
  ['open-codex', 'Open Codex'], ['gemini', 'Gemini']].map(([kind, label]) => ({ kind, label, available: true, configured: true }));
const VERB_OF_SHAPE = { open: 'open', start: 'start', follow_up: 'follow_up', status: 'status', results: 'results' };
// Corpus selectors written in the resolver's own vocabulary. Everything else -
// last_action, last_target, done, needs_me, all, last_error - names something
// the resolver does not select on, and is counted as unscored rather than wrong.
const SELECTOR_EQUIVALENTS = { new: ['new'], idle: ['idle'], empty: ['idle'], idle_or_new: ['idle', 'new'],
  just_opened: ['just_opened'], title: ['title'], topic: ['title'], working: ['title'], provider: ['provider'],
  none: ['none', 'new', 'provider'] };

function parseArgs(argv) {
  const options = { compilerOnly: argv.includes('--compiler-only'), json: argv.includes('--json'), rows: null };
  const rows = argv[argv.indexOf('--rows') + 1];
  if (argv.includes('--rows') && rows && !rows.startsWith('--')) {
    const selected = new Set();
    for (const part of rows.split(',')) {
      const range = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!range) throw new Error(`Unreadable --rows selector: ${part}`);
      for (let n = Number(range[1]); n <= Number(range[2] ?? range[1]); n++) selected.add(n);
    }
    options.rows = selected;
  }
  return options;
}
const selectedRows = options => CORPUS.filter(row => !options.rows || options.rows.has(row.n));

// One planning context per row: the sentence as the brain would read it, the
// registered projects, and a roster of panes in the project the row addresses.
function rowContext(row) {
  const instruction = normalizeInstruction(row.text, { projects: PROJECTS, launchers: LAUNCHERS }).text;
  const project = PROJECTS.find(item => item.name === row.project) || PROJECTS[0];
  const provider = row.provider && LAUNCHERS.some(item => item.kind === row.provider) ? row.provider : 'codex';
  const pane = (id, name, kind, extra = {}) => ({ id, name, conversationTitle: name, kind, provider: kind,
    cwd: project.path, generation: `generation-${id}`, launchToken: 1, conversationId: `conversation-${id}`,
    started: true, status: 'idle', observation: 'observed', processState: 'running', agentProcessState: 'running',
    agentPid: 7000, turnState: 'idle', revision: 1, sequence: 1, inputRevision: 0, lastActivityAt: 1000, ...extra });
  const sessions = [
    pane('fixture-idle-1', `${provider === 'claude' ? 'Claude' : 'Codex'} 1`, provider, { lastActivityAt: 3000 }),
    pane('fixture-idle-2', `${provider === 'claude' ? 'Claude' : 'Codex'} 2`, provider, { lastActivityAt: 2000 }),
    pane('fixture-owner', 'Investigate the orchestrator performance', provider, { turnState: 'running', status: 'running', lastActivityAt: 4000 }),
  ];
  return { instruction, requestId: `fidelity-${row.n}`, sessions, projects: PROJECTS, roots: { projects: PROJECTS, documents: 'C:/Projects' },
    launchers: LAUNCHERS, projectContext: identifyProject(instruction, PROJECTS, null), requests: [], workItems: [], recentUserMessages: [] };
}

// What a normalized plan means, in the corpus's own vocabulary.
function readPlan(plan, context) {
  const grants = plan?.grants || [];
  const first = grants.find(grant => ['delegate_task', 'create_session', 'operate_terminal'].includes(grant.kind));
  // A plan that names an existing pane says which project it is in by saying
  // which pane it is; only a creation has to carry the folder itself.
  const target = context.sessions.find(session => first?.targets?.some(item => item.id === session.id));
  const cwd = first?.args?.cwd || first?.targets?.[0]?.cwd || target?.cwd;
  const project = PROJECTS.find(item => String(item.path).toLowerCase() === String(cwd || '').toLowerCase());
  const provider = first?.args?.kindOfSession || target?.kind;
  const verb = plan?.clarification ? 'clarify'
    : first?.kind === 'create_session' ? (first.text ? 'start' : 'open')
    : first?.kind === 'delegate_task' ? (first.args?.assignmentMode === 'existing' ? 'follow_up' : 'start')
    : first?.kind === 'operate_terminal' ? (first.inspection ? 'inspect' : 'start')
    : plan?.responseKind === 'task-status' ? 'status'
    : grants.some(grant => grant.kind === 'close') ? 'close'
    : grants.some(grant => grant.kind === 'interrupt') ? 'interrupt'
    : grants.some(grant => grant.kind === 'watch_terminal') ? 'watch'
    : grants.length ? grants[0].kind : 'conversation';
  return { verb, project: project?.name ?? null, provider: provider ?? null,
    selector: extractSelector(context.instruction, { launchers: LAUNCHERS }).kind };
}

function score(reading, expected) {
  const equivalents = SELECTOR_EQUIVALENTS[expected.selector];
  return {
    verb: reading.verb === expected.verb,
    project: (reading.project ?? null) === (expected.project ?? null),
    provider: (reading.provider ?? null) === (expected.provider ?? null),
    selector: equivalents ? equivalents.includes(reading.selector) : null,
  };
}
const share = (part, total) => total ? Number(((part / total) * 100).toFixed(1)) : null;

function compilerReport(rows, { workspace } = {}) {
  const cases = [];
  for (const row of rows) {
    const context = { ...rowContext(row), ...(workspace && { workspaceContext: { ok: true, view: 'project', cwd: workspace.path } }) };
    const result = compileCommand(context);
    const reading = result.accepted
      ? { verb: VERB_OF_SHAPE[result.shape], project: result.project ?? null, provider: result.provider ?? null, selector: result.selector }
      : null;
    // A sentence that names no project takes the workspace it was submitted
    // from, so the expected project in that mode is the addressed workspace.
    const expected = { ...row.expected, project: row.expected.project ?? (workspace ? workspace.name : null) };
    cases.push({ n: row.n, accepted: Boolean(result.accepted), reason: result.reason,
      compilable: workspace ? row.expected.compilableInWorkspace : row.expected.compilable,
      ...(reading && { reading, correct: score(reading, expected) }) });
  }
  const accepted = cases.filter(item => item.accepted);
  const exact = accepted.filter(item => item.compilable && item.correct.verb && item.correct.project && item.correct.provider);
  const compilable = cases.filter(item => item.compilable);
  return { rows: cases.length, ...(workspace && { workspace: workspace.name }), accepted: accepted.length, exact: exact.length,
    precision: share(exact.length, accepted.length), compilable: compilable.length,
    recall: share(compilable.filter(item => item.accepted).length, compilable.length),
    misses: compilable.filter(item => !item.accepted).map(item => ({ n: item.n, reason: item.reason })),
    wrong: accepted.filter(item => !exact.includes(item)).map(item => ({ n: item.n, reading: item.reading })), cases };
}

function summaryLine(report) {
  const { compiler, workspaceCompiler, brain } = report;
  const parts = [`compiler precision ${compiler.precision ?? 'n/a'}% (${compiler.exact}/${compiler.accepted} accepted of ${compiler.rows} rows)`,
    `recall ${compiler.recall ?? 'n/a'}% of ${compiler.compilable} compilable`];
  if (workspaceCompiler) {
    parts.push(`in a ${workspaceCompiler.workspace} workspace precision ${workspaceCompiler.precision ?? 'n/a'}% (${workspaceCompiler.exact}/${workspaceCompiler.accepted}), recall ${workspaceCompiler.recall ?? 'n/a'}% of ${workspaceCompiler.compilable}`);
  }
  // A live run that stopped says so here: a failed sweep must never read as a
  // deliberate compiler-only one.
  parts.push(report.error ? `brain run FAILED: ${report.error}`
    : brain ? `brain verb ${brain.verb}%, project ${brain.project}%, provider ${brain.provider}% over ${brain.scored} of ${brain.rows} rows ($${brain.spent.toFixed(4)})${report.stopped ? `, stopped early (${report.stopped})` : ''}`
    : report.mode === 'live' ? 'brain run produced no scored rows' : 'brain not run (compiler-only)');
  return `Orchestrator fidelity ${report.at}: ${parts.join('; ')}.`;
}

function write(report) {
  const run = path.join(REPORT_ROOT, `${report.at.replace(/[:.]/g, '-')}-${process.pid}`);
  fs.mkdirSync(run, { recursive: true });
  const file = path.join(run, 'report.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

const BOUNDARY = 'Fixture roster and registered projects built from the corpus rows; no workspace read, no terminal opened, nothing typed. '
  + 'Compiler precision counts only rows whose expected plan the corpus states. Selector agreement is scored only for corpus selectors with a resolver equivalent. '
  + 'The live pass calls the interpreter directly, so the memory fast path that answers questions about Lina\'s own actions with no model call is bypassed: '
  + 'those rows (verb "verify", "status", "results" with a last_action selector) reach the Brain and score as conversation plans, which understates the live verb number.';

// The workspace a request is submitted from fills the project a sentence left
// out. It is scored as its own pass so the two modes never blur into one number.
const WORKSPACE = PROJECTS[3];

function offline(options) {
  const rows = selectedRows(options);
  const report = { at: new Date().toISOString(), mode: 'compiler-only', boundary: BOUNDARY,
    compiler: compilerReport(rows), workspaceCompiler: compilerReport(rows, { workspace: WORKSPACE }), brain: null };
  report.summary = summaryLine(report);
  report.file = write(report);
  console.log(options.json ? JSON.stringify(report, null, 2) : report.summary);
  if (!options.json && report.compiler.misses.length) {
    console.log(`  recall misses: ${report.compiler.misses.map(item => `${item.n} (${item.reason})`).join(', ')}`);
  }
  return report.compiler.precision === 100 || report.compiler.accepted === 0 ? 0 : 1;
}

let options;
try { options = parseArgs(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 2; }

if (options && options.compilerOnly) {
  process.exitCode = offline(options);
} else if (options && !process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename, '--live-child', ...process.argv.slice(2)],
    { env, windowsHide: true, stdio: 'inherit', timeout: 1800000 });
  process.exitCode = child.status ?? 1;
} else if (options) {
  const { app, safeStorage } = require('electron');
  const assert = require('node:assert/strict');
  const { createIntentInterpreter } = require('../../backend/orchestratorInterpreter.cjs');
  const installedRoot = path.join(process.env.APPDATA || '', 'vibe-terminal');
  const budget = Math.min(0.35, Math.max(0.01, Number(process.env.VIBE_LIVE_BUDGET) || 0.35));
  const rows = selectedRows(options);
  const report = { at: new Date().toISOString(), mode: 'live', boundary: BOUNDARY, budget,
    compiler: compilerReport(rows), workspaceCompiler: compilerReport(rows, { workspace: WORKSPACE }), brain: null };
  let secret = '', spent = 0, stopped = '';
  const clean = value => String(value || '').split(secret || '\0').join('[REDACTED]');
  // The profile path and the DPAPI key material must both be in place before
  // the app is ready: safeStorage takes its os_crypt from the userData folder
  // at startup, so a key copied afterwards cannot be decrypted and the
  // installed account reads as unconfigured.
  const run = path.join(REPORT_ROOT, `${report.at.replace(/[:.]/g, '-')}-${process.pid}`, 'electron');
  app.setPath('userData', run);
  const statePath = path.join(installedRoot, 'Local State');
  if (fs.existsSync(statePath)) {
    const { os_crypt } = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (os_crypt) { fs.mkdirSync(run, { recursive: true }); fs.writeFileSync(path.join(run, 'Local State'), JSON.stringify({ os_crypt })); }
  }
  async function main() {
    await app.whenReady();
    const settings = require('../../backend/orchestratorSettings.cjs').createSettings({ userDataPath: installedRoot, secureStorage: safeStorage });
    secret = settings.getKey(); const modelId = settings.getSettings().model;
    assert.ok(secret && modelId, 'Installed Brain key/model unavailable; no account was configured.');
    report.model = modelId;
    const catalogResponse = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20000) });
    assert.ok(catalogResponse.ok, 'Model catalog unavailable');
    const model = (await catalogResponse.json()).data?.find(item => item.id === modelId);
    assert.ok(model, 'Configured model missing from catalog');
    const prices = [model.pricing?.prompt, model.pricing?.completion, model.pricing?.request || 0].map(Number);
    assert.ok(prices.every(price => Number.isFinite(price) && price >= 0), 'Pricing unavailable; no unbudgeted request');
    const chosen = { id: modelId, contextLength: model.context_length, maxCompletionTokens: model.top_provider?.max_completion_tokens,
      supportedParameters: model.supported_parameters || [], reasoning: (model.supported_parameters || []).includes('reasoning') };
    const complete = async (body, signal) => {
      const reserve = (Buffer.byteLength(JSON.stringify(body)) + 4096) * prices[0] + Number(body.max_tokens || 4096) * prices[1] + prices[2];
      if (spent + reserve > budget) { stopped = 'budget'; throw new Error('Conservative next-call reservation exceeds the remaining budget'); }
      spent += reserve;
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', signal,
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      const cost = Number(data.usage?.cost);
      if (Number.isFinite(cost)) spent += cost - reserve; else if (response.ok) { spent = budget; stopped = 'usage'; throw new Error('Provider omitted usage cost; stopped to protect budget'); }
      if (!response.ok) throw new Error(clean(data.error?.message || `Provider returned ${response.status}`));
      return data;
    };
    const interpret = createIntentInterpreter({ complete, getTask: () => undefined, redact: value => value,
      cleanError: error => clean(String(error?.message || error)), recordDiagnostic: () => {}, diagnosticError: () => {} });
    const cases = [];
    for (const row of rows) {
      if (stopped) break;
      const context = rowContext(row);
      const started = Date.now();
      const item = { n: row.n, expected: row.expected };
      try {
        const plan = await interpret(context, chosen, 4096, new AbortController().signal, {});
        item.reading = readPlan(plan, context);
        item.correct = score(item.reading, row.expected);
      } catch (error) { item.error = clean(error.message); }
      item.elapsedMs = Date.now() - started;
      cases.push(item);
      console.log(JSON.stringify({ n: item.n, verb: item.reading?.verb, ok: item.correct?.verb, error: item.error, spent: Number(spent.toFixed(4)) }));
    }
    const scored = cases.filter(item => item.correct);
    report.brain = { rows: cases.length, scored: scored.length, spent,
      verb: share(scored.filter(item => item.correct.verb).length, scored.length),
      project: share(scored.filter(item => item.correct.project).length, scored.length),
      provider: share(scored.filter(item => item.correct.provider).length, scored.length),
      selector: share(scored.filter(item => item.correct.selector === true).length, scored.filter(item => item.correct.selector !== null).length),
      selectorUnscored: scored.filter(item => item.correct.selector === null).length,
      errors: cases.filter(item => item.error).map(item => ({ n: item.n, error: item.error })), cases };
    if (stopped) report.stopped = stopped;
  }
  main().catch(error => { report.error = clean(error.message); }).finally(() => {
    report.spent = spent;
    report.summary = summaryLine(report);
    report.file = write(report);
    console.log(options.json ? clean(JSON.stringify(report, null, 2)) : report.summary);
    const failed = Boolean(report.error) || !report.brain?.scored ||
      (report.compiler.accepted > 0 && report.compiler.precision !== 100);
    app.exit(failed ? 1 : 0);
  });
}

module.exports = { compilerReport, rowContext, readPlan, score, summaryLine, parseArgs, REPORT_ROOT };
