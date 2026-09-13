'use strict';
// Read-only Orchestrator measurement. Opens the installed profile's conversation
// store and diagnostics log for reading only: no network, no PTY, no model call,
// and nothing under the profile is written. Prints the real-world numbers every
// overhaul phase is compared against.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG_FILES = ['orchestrator-errors.jsonl', 'orchestrator-errors.jsonl.1', 'orchestrator-errors.jsonl.2'];
// Only request-pipeline events are measured; older builds wrote voice telemetry
// (voice_inference, voice_recording) into the same file and it is ignored.
const PIPELINE_EVENTS = new Set(['request_stage', 'routing_progress', 'orchestrator_error', 'action_error']);
const NON_COMPLETION_STATUSES = ['paused', 'failed', 'cancelled'];
const REJECTED_RECEIPT_STATUSES = ['rejected', 'stale-observation', 'launch-timeout', 'input-surface-unverified', 'blocked'];
const VERIFICATION_ASK = /\b(you didn'?t|did you (enter|send|put)|what was the last prompt|put (in|it in) that prompt|hasn'?t been entered)\b/i;
const REPEAT_WINDOW_MS = 5 * 60 * 1000;
const REPEAT_MIN_WORD_LENGTH = 5;
const REPEAT_MIN_SHARED_WORDS = 3;
const TOP_LIST_SIZE = 10;
const USAGE = `Usage: node scripts/diag/orchestrator-measure.cjs [options]

  --profile <dir>   Profile directory to read (default: the installed user data directory)
  --last <n>        Rolling window for the recent non-completion rate (default: 50)
  --since <ISO>     Ignore requests, receipts and diagnostics before this instant
  --json            Print the report as JSON instead of a table
  --help            Print this message`;

function defaultProfileDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'vibe-terminal');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'vibe-terminal');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'vibe-terminal');
}

function parseArgs(argv) {
  const options = { profile: null, last: 50, since: null, sinceMs: null, json: false, help: false };
  const value = (name, raw) => { if (raw === undefined) throw new Error(`${name} needs a value`); return raw; };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--profile') options.profile = value('--profile', argv[++i]);
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length);
    else if (arg === '--last') options.last = Number(value('--last', argv[++i]));
    else if (arg.startsWith('--last=')) options.last = Number(arg.slice('--last='.length));
    else if (arg === '--since') options.since = value('--since', argv[++i]);
    else if (arg.startsWith('--since=')) options.since = arg.slice('--since='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.profile) options.profile = defaultProfileDir();
  if (!Number.isInteger(options.last) || options.last < 1) throw new Error('--last needs a positive whole number');
  if (options.since !== null) {
    const parsed = Date.parse(options.since);
    if (!Number.isFinite(parsed)) throw new Error(`--since needs an ISO date, received ${options.since}`);
    options.sinceMs = parsed;
  }
  return options;
}

function loadProfile(directory) {
  const conversationFile = path.join(directory, 'orchestrator-conversation.json');
  const conversation = { messages: [], receipts: [], tasks: [] };
  let conversationPresent = false;
  if (fs.existsSync(conversationFile)) {
    const parsed = JSON.parse(fs.readFileSync(conversationFile, 'utf8'));
    for (const key of ['messages', 'receipts', 'tasks']) if (Array.isArray(parsed[key])) conversation[key] = parsed[key];
    conversationPresent = true;
  }
  const logs = [];
  const rows = [];
  for (const name of LOG_FILES) {
    const file = path.join(directory, 'logs', name);
    const label = `logs/${name}`;
    if (!fs.existsSync(file)) { logs.push({ file: label, present: false, lines: 0, unparsed: 0 }); continue; }
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim());
    let unparsed = 0;
    for (const line of lines) { try { rows.push(JSON.parse(line)); } catch { unparsed++; } }
    logs.push({ file: label, present: true, lines: lines.length, unparsed });
  }
  return { directory, conversationFile, conversationPresent, conversation, logs, rows };
}

// Nearest-rank percentile: the smallest value at or above the requested share.
function percentile(values, share) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((share / 100) * sorted.length)));
  return sorted[rank - 1];
}

function summarize(values) {
  return { samples: values.length, p50: percentile(values, 50), p90: percentile(values, 90), max: values.length ? Math.max(...values) : null };
}

function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) { const k = key(item); counts.set(k, (counts.get(k) || 0) + 1); }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
}

// Significant words for the repeat heuristic: letters only, five or more of them.
function significantWords(text) {
  const words = String(text || '').toLowerCase().match(/[a-z]+/g) || [];
  return new Set(words.filter(word => word.length >= REPEAT_MIN_WORD_LENGTH));
}

// Session ids and digits are the only varying parts of most Orchestrator error
// sentences; collapsing them groups the same failure written for two panes.
function normalizeErrorText(text) {
  return String(text || '')
    .replace(/session_[a-z0-9]+(?:_[a-z0-9]+)*/gi, 'S')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'S')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

function topList(counts) {
  return Object.entries(counts).slice(0, TOP_LIST_SIZE).map(([text, count]) => ({ text, count }));
}

function providerMessageOf(row) {
  const candidate = row.providerMessage ?? row.error?.providerMessage ?? row.upstream?.providerMessage ?? row.upstreamErrorInfo?.providerMessage;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

function diagnosticErrorLabel(row) {
  const scope = row.category || row.actionKind || row.stage || null;
  const reason = row.reason || row.status || row.error?.name || 'unknown';
  const status = Number.isFinite(row.httpStatus) ? ` HTTP ${row.httpStatus}` : '';
  return `${row.event} ${[scope, reason].filter(Boolean).join('/')}${status}`;
}

function measure(profile, options) {
  const sinceMs = options.sinceMs ?? null;
  const allTasks = profile.conversation.tasks;
  const dated = allTasks.filter(task => Number.isFinite(task.createdAt));
  const tasks = dated.filter(task => sinceMs === null || task.createdAt >= sinceMs).slice().sort((a, b) => a.createdAt - b.createdAt);
  const total = tasks.length;

  const perDay = countBy(tasks, task => utcDay(task.createdAt));
  const days = Object.keys(perDay).sort().map(date => ({ date, requests: perDay[date] }));
  const status = countBy(tasks, task => task.status || 'unknown');
  const nonCompletionCount = tasks.filter(task => NON_COMPLETION_STATUSES.includes(task.status)).length;
  const recent = tasks.slice(-options.last);
  const recentNonCompletion = recent.filter(task => NON_COMPLETION_STATUSES.includes(task.status)).length;

  const repeats = [];
  for (let i = 1; i < tasks.length; i++) {
    const previous = tasks[i - 1], current = tasks[i];
    if (current.createdAt - previous.createdAt > REPEAT_WINDOW_MS) continue;
    const before = significantWords(previous.text);
    const shared = [...significantWords(current.text)].filter(word => before.has(word));
    if (shared.length >= REPEAT_MIN_SHARED_WORDS) {
      repeats.push({ requestId: current.requestId || current.id || null, at: new Date(current.createdAt).toISOString(), gapMs: current.createdAt - previous.createdAt, shared, text: String(current.text || '') });
    }
  }
  const verificationAsks = tasks.filter(task => VERIFICATION_ASK.test(String(task.text || '')))
    .map(task => ({ requestId: task.requestId || task.id || null, at: new Date(task.createdAt).toISOString(), text: String(task.text || '') }));

  const receipts = profile.conversation.receipts.filter(receipt => Number.isFinite(receipt.at) && (sinceMs === null || receipt.at >= sinceMs));
  const rejections = receipts.filter(receipt => REJECTED_RECEIPT_STATUSES.includes(receipt.status));
  const rejectionsPerDay = countBy(rejections, receipt => utcDay(receipt.at));

  const pipelineRows = profile.rows.filter(row => row && PIPELINE_EVENTS.has(row.event));
  const ignoredRows = profile.rows.length - pipelineRows.length;
  const rows = pipelineRows.filter(row => { if (sinceMs === null) return true; const at = Date.parse(row.time); return Number.isFinite(at) && at >= sinceMs; });
  const stageRows = name => rows.filter(row => row.event === 'request_stage' && row.stage === name);

  const diagnosticRequestIds = new Set(rows.map(row => row.requestId).filter(Boolean));
  const storeRequestIds = new Set(tasks.map(task => task.requestId || task.id).filter(Boolean));
  const requestsWithDiagnostics = [...storeRequestIds].filter(id => diagnosticRequestIds.has(id)).length;

  const started = stageRows('model_started');
  const callsPerRequest = new Map();
  for (const row of started) { const id = row.requestId || 'unknown'; callsPerRequest.set(id, (callsPerRequest.get(id) || 0) + 1); }
  const modelCalls = { ...summarize([...callsPerRequest.values()]), requests: callsPerRequest.size, calls: started.length, byCategory: countBy(started, row => row.category || 'uncategorised') };

  const sttTimes = new Map();
  for (const row of stageRows('stt_complete')) {
    const at = Date.parse(row.time);
    if (!row.requestId || !Number.isFinite(at)) continue;
    if (!sttTimes.has(row.requestId) || at < sttTimes.get(row.requestId)) sttTimes.set(row.requestId, at);
  }
  const firstEffects = stageRows('first_effect');
  const fromRequestStart = firstEffects.map(row => row.elapsedMs).filter(Number.isFinite);
  const fromSpeechEnd = [];
  for (const row of firstEffects) {
    const at = Date.parse(row.time), spoken = sttTimes.get(row.requestId);
    if (Number.isFinite(at) && Number.isFinite(spoken) && at >= spoken) fromSpeechEnd.push(at - spoken);
  }
  const timeToFirstEffect = { fromRequestStart: summarize(fromRequestStart), fromSpeechEnd: summarize(fromSpeechEnd) };

  const interpretationPromptTokens = summarize(stageRows('model_complete').filter(row => row.category === 'interpretation' && Number.isFinite(row.promptTokens)).map(row => row.promptTokens));

  const failedTasks = tasks.filter(task => typeof task.error === 'string' && task.error.trim());
  const topTaskErrors = topList(countBy(failedTasks, task => normalizeErrorText(task.error)));

  const errorRows = rows.filter(row => row.event === 'orchestrator_error' || row.event === 'action_error');
  const topDiagnosticReasons = topList(countBy(errorRows, diagnosticErrorLabel));

  const fourxx = rows.filter(row => Number.isFinite(row.httpStatus) && row.httpStatus >= 400 && row.httpStatus < 500);
  const withProviderMessage = fourxx.filter(row => providerMessageOf(row) !== null).length;

  return {
    generatedAt: new Date().toISOString(),
    profile: profile.directory,
    window: {
      since: options.since || null,
      lastN: options.last,
      requests: total,
      firstRequest: total ? new Date(tasks[0].createdAt).toISOString() : null,
      lastRequest: total ? new Date(tasks[total - 1].createdAt).toISOString() : null,
      days,
      receipts: receipts.length,
      diagnosticRows: rows.length
    },
    coverage: {
      conversationFile: profile.conversationFile,
      conversationPresent: profile.conversationPresent,
      undatedRequests: allTasks.length - dated.length,
      logs: profile.logs,
      diagnosticRowsIgnored: ignoredRows,
      requestsWithDiagnostics,
      requestsTotal: total,
      diagnosticRequestsNotInStore: [...diagnosticRequestIds].filter(id => !storeRequestIds.has(id)).length,
      note: 'The diagnostics log rotates and the conversation store does not, so coverage is normally far below the request count.'
    },
    requests: {
      total,
      perDay,
      status,
      nonCompletion: { statuses: NON_COMPLETION_STATUSES, count: nonCompletionCount, total, rate: total ? nonCompletionCount / total : null },
      nonCompletionRecent: { lastN: options.last, count: recentNonCompletion, total: recent.length, rate: recent.length ? recentNonCompletion / recent.length : null },
      repeats: { count: repeats.length, windowMinutes: REPEAT_WINDOW_MS / 60000, minSharedWords: REPEAT_MIN_SHARED_WORDS, minWordLength: REPEAT_MIN_WORD_LENGTH, examples: repeats },
      verificationAsks: { count: verificationAsks.length, pattern: VERIFICATION_ASK.source, examples: verificationAsks }
    },
    writeRejections: { statuses: REJECTED_RECEIPT_STATUSES, total: rejections.length, receipts: receipts.length, perDay: rejectionsPerDay, byStatus: countBy(rejections, receipt => receipt.status) },
    modelCalls,
    timeToFirstEffect,
    interpretationPromptTokens,
    topTaskErrors,
    topDiagnosticReasons,
    provider4xx: { rows: fourxx.length, withProviderMessage, withoutProviderMessage: fourxx.length - withProviderMessage },
    fidelity: latestFidelity()
  };
}

// The last fidelity sweep, if one has been run in this working tree. It is a
// measurement of the compiler and the Brain against the saved corpus, not of
// the installed profile, so it is reported verbatim as its own one-line result.
const FIDELITY_ROOT = path.resolve(__dirname, '../../.tmp/orchestrator-fidelity');
function latestFidelity() {
  try {
    const runs = fs.readdirSync(FIDELITY_ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => path.join(FIDELITY_ROOT, entry.name, 'report.json'))
      .filter(file => fs.existsSync(file))
      .map(file => ({ file, at: fs.statSync(file).mtimeMs })).sort((left, right) => right.at - left.at);
    if (!runs.length) return null;
    const report = JSON.parse(fs.readFileSync(runs[0].file, 'utf8'));
    return typeof report.summary === 'string' ? { file: runs[0].file, summary: report.summary } : null;
  } catch { return null; }
}

function share(count, total) { return total ? `${((count / total) * 100).toFixed(1)}%` : 'n/a'; }
function number(value, suffix = '') { return value === null || value === undefined ? 'n/a' : `${value}${suffix}`; }
function clip(text, width) { return text.length > width ? `${text.slice(0, width - 1)}…` : text; }

function renderTable(report) {
  const out = [];
  const line = (label, ...cells) => out.push(`  ${String(label).padEnd(28)}  ${cells.join('  ')}`.trimEnd());
  const window = report.window;
  const span = window.requests ? `${window.firstRequest} to ${window.lastRequest}` : 'no requests';

  out.push(`Orchestrator measurement  ${report.generatedAt}`);
  out.push(`Profile ${report.profile}`);
  out.push('');
  out.push('Window');
  line('Requests', `${window.requests} (${span})`);
  line('--since', window.since || 'none (whole store)');
  line('--last', `${window.lastN} most recent requests`);
  if (!report.coverage.conversationPresent) line('Conversation store', `NOT FOUND at ${report.coverage.conversationFile}`);
  if (report.coverage.undatedRequests) line('Requests without a date', `${report.coverage.undatedRequests} (excluded)`);

  out.push('');
  out.push(`Requests per day, UTC (${window.requests} requests in window)`);
  if (!window.days.length) line('none', '');
  for (const day of window.days) line(day.date, String(day.requests).padStart(4));

  out.push('');
  out.push(`Status distribution (${report.requests.total} requests in window)`);
  for (const [name, count] of Object.entries(report.requests.status)) line(name, String(count).padStart(4), share(count, report.requests.total).padStart(7));

  out.push('');
  out.push('Non-completion (paused + failed + cancelled)');
  line(`All ${report.requests.nonCompletion.total} requests`, String(report.requests.nonCompletion.count).padStart(4), share(report.requests.nonCompletion.count, report.requests.nonCompletion.total).padStart(7));
  line(`Last ${report.requests.nonCompletionRecent.total} requests`, String(report.requests.nonCompletionRecent.count).padStart(4), share(report.requests.nonCompletionRecent.count, report.requests.nonCompletionRecent.total).padStart(7));

  out.push('');
  out.push(`Repeats and verification asks (${report.requests.total} requests in window)`);
  line('Likely repeats', String(report.requests.repeats.count).padStart(4), `consecutive requests <= ${report.requests.repeats.windowMinutes} min apart sharing >= ${report.requests.repeats.minSharedWords} words of >= ${report.requests.repeats.minWordLength} letters`);
  line('"Did you put it in" asks', String(report.requests.verificationAsks.count).padStart(4), 'request text matching the verification pattern');

  out.push('');
  out.push(`Write rejections (${report.writeRejections.total} of ${report.writeRejections.receipts} receipts in window; ${report.writeRejections.statuses.join(', ')})`);
  for (const [date, count] of Object.entries(report.writeRejections.perDay).sort((a, b) => a[0].localeCompare(b[0]))) line(date, String(count).padStart(4));
  for (const [name, count] of Object.entries(report.writeRejections.byStatus)) line(`  ${name}`, String(count).padStart(4));

  out.push('');
  out.push('Diagnostics coverage');
  for (const log of report.coverage.logs) line(log.file, log.present ? `${log.lines} lines${log.unparsed ? `, ${log.unparsed} unparsed` : ''}` : 'missing');
  line('Pipeline rows in window', `${window.diagnosticRows} (${report.coverage.diagnosticRowsIgnored} voice telemetry rows ignored)`);
  line('Requests with diagnostics', `${report.coverage.requestsWithDiagnostics} of ${report.coverage.requestsTotal} (${share(report.coverage.requestsWithDiagnostics, report.coverage.requestsTotal)})`);
  line('Diagnostics outside the store', String(report.coverage.diagnosticRequestsNotInStore));
  out.push(`  ${report.coverage.note}`);

  out.push('');
  out.push(`Model calls per request (requests with diagnostics: ${report.modelCalls.requests}; model calls: ${report.modelCalls.calls})`);
  line('p50 / p90 / max', `${number(report.modelCalls.p50)} / ${number(report.modelCalls.p90)} / ${number(report.modelCalls.max)}`);
  for (const [category, count] of Object.entries(report.modelCalls.byCategory)) line(`  ${category}`, String(count).padStart(4));

  out.push('');
  out.push('Time to first effect');
  line(`From request start (${report.timeToFirstEffect.fromRequestStart.samples})`, `p50 ${number(report.timeToFirstEffect.fromRequestStart.p50, ' ms')}`, `p90 ${number(report.timeToFirstEffect.fromRequestStart.p90, ' ms')}`, `max ${number(report.timeToFirstEffect.fromRequestStart.max, ' ms')}`);
  line(`From speech end (${report.timeToFirstEffect.fromSpeechEnd.samples})`, `p50 ${number(report.timeToFirstEffect.fromSpeechEnd.p50, ' ms')}`, `p90 ${number(report.timeToFirstEffect.fromSpeechEnd.p90, ' ms')}`, `max ${number(report.timeToFirstEffect.fromSpeechEnd.max, ' ms')}`);

  out.push('');
  out.push(`Prompt tokens per interpretation (interpretation calls with diagnostics: ${report.interpretationPromptTokens.samples})`);
  line('p50 / p90 / max', `${number(report.interpretationPromptTokens.p50)} / ${number(report.interpretationPromptTokens.p90)} / ${number(report.interpretationPromptTokens.max)}`);

  out.push('');
  out.push(`Top request errors (${report.topTaskErrors.reduce((sum, entry) => sum + entry.count, 0)} of ${report.requests.total} requests carry one; session ids to S, digits to N)`);
  if (!report.topTaskErrors.length) out.push('  none');
  for (const entry of report.topTaskErrors) out.push(`  ${String(entry.count).padStart(4)}  ${clip(entry.text, 100)}`);

  out.push('');
  out.push(`Top diagnostics error reasons (${report.topDiagnosticReasons.reduce((sum, entry) => sum + entry.count, 0)} rows in window)`);
  if (!report.topDiagnosticReasons.length) out.push('  none');
  for (const entry of report.topDiagnosticReasons) out.push(`  ${String(entry.count).padStart(4)}  ${clip(entry.text, 100)}`);

  out.push('');
  out.push(`Provider 4xx responses (${report.provider4xx.rows} rows in window)`);
  line('With providerMessage', String(report.provider4xx.withProviderMessage).padStart(4));
  line('Without providerMessage', String(report.provider4xx.withoutProviderMessage).padStart(4));

  if (report.fidelity) {
    out.push('');
    out.push('Command fidelity, last sweep');
    out.push(`  ${report.fidelity.summary}`);
  }
  return out.join('\n');
}

function main(argv) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(`${error.message}\n\n${USAGE}`); return 2; }
  if (options.help) { console.log(USAGE); return 0; }
  const profile = loadProfile(options.profile);
  const report = measure(profile, options);
  console.log(options.json ? JSON.stringify(report, null, 2) : renderTable(report));
  return profile.conversationPresent ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { defaultProfileDir, loadProfile, main, measure, normalizeErrorText, parseArgs, percentile, renderTable, significantWords, VERIFICATION_ASK };
