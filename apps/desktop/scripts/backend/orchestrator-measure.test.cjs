'use strict';
// Every expectation below is hand-computed from the synthetic profile in
// fixtures/orchestrator-measure: 12 requests over three UTC days (5, 4, 3) with
// two five-minute repeats, one verification ask, six rejected receipts, and a
// diagnostics log covering four of the twelve requests plus voice-telemetry noise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const measureScript = require('../diag/orchestrator-measure.cjs');
const { loadProfile, measure, normalizeErrorText, parseArgs, percentile, renderTable, significantWords } = measureScript;

const scriptPath = path.join(__dirname, '..', 'diag', 'orchestrator-measure.cjs');
const fixtureProfile = path.join(__dirname, 'fixtures', 'orchestrator-measure');
const report = (argv = []) => measure(loadProfile(fixtureProfile), parseArgs(argv));

test('the whole fixture window reproduces the per-day, status and non-completion counts', () => {
  const result = report();
  assert.equal(result.window.requests, 12);
  assert.equal(result.window.firstRequest, '2026-03-01T10:00:00.000Z');
  assert.equal(result.window.lastRequest, '2026-03-03T08:40:00.000Z');
  assert.deepEqual(result.requests.perDay, { '2026-03-01': 5, '2026-03-02': 4, '2026-03-03': 3 });
  assert.deepEqual(result.window.days, [
    { date: '2026-03-01', requests: 5 }, { date: '2026-03-02', requests: 4 }, { date: '2026-03-03', requests: 3 }
  ]);
  assert.deepEqual(result.requests.status, { finished: 6, paused: 3, cancelled: 2, failed: 1 });
  assert.deepEqual(result.requests.nonCompletion, { statuses: ['paused', 'failed', 'cancelled'], count: 6, total: 12, rate: 0.5 });
  assert.equal(result.requests.nonCompletionRecent.lastN, 50);
  assert.deepEqual([result.requests.nonCompletionRecent.count, result.requests.nonCompletionRecent.total, result.requests.nonCompletionRecent.rate], [6, 12, 0.5]);
});

test('the rolling window covers only the most recent requests', () => {
  const result = report(['--last', '5']);
  assert.equal(result.requests.nonCompletion.rate, 0.5, 'The overall rate still covers all twelve requests.');
  assert.deepEqual([result.requests.nonCompletionRecent.count, result.requests.nonCompletionRecent.total, result.requests.nonCompletionRecent.rate], [4, 5, 0.8]);
});

test('repeats and verification asks use the deep-dive heuristics', () => {
  const result = report();
  assert.equal(result.requests.repeats.count, 2);
  assert.deepEqual(result.requests.repeats.examples.map(entry => entry.requestId), ['r2', 'r5']);
  assert.deepEqual([result.requests.repeats.windowMinutes, result.requests.repeats.minSharedWords, result.requests.repeats.minWordLength], [5, 3, 5]);
  assert.equal(result.requests.repeats.examples[0].gapMs, 60000);
  assert(result.requests.repeats.examples[0].shared.length >= 3);
  assert.equal(result.requests.verificationAsks.count, 1);
  assert.deepEqual(result.requests.verificationAsks.examples.map(entry => entry.requestId), ['r3']);
  assert.deepEqual(significantWords('Close the inactive panes please, now.'), new Set(['close', 'inactive', 'panes', 'please']));
  assert.equal(significantWords('open a pane').size, 0, 'Words shorter than five letters are not significant.');
  assert.equal(measureScript.VERIFICATION_ASK.test('Hey, you didn\'t put in the prompt.'), true);
  assert.equal(measureScript.VERIFICATION_ASK.test('Open a Codex terminal.'), false);
});

test('write rejections are counted per day and per status', () => {
  const result = report();
  assert.equal(result.writeRejections.total, 6);
  assert.equal(result.writeRejections.receipts, 8, 'The two non-rejection receipts stay in the window total but not in the rejection count.');
  assert.deepEqual(result.writeRejections.perDay, { '2026-03-01': 3, '2026-03-02': 2, '2026-03-03': 1 });
  assert.deepEqual(result.writeRejections.byStatus, { rejected: 2, blocked: 1, 'input-surface-unverified': 1, 'launch-timeout': 1, 'stale-observation': 1 });
});

test('model calls per request come from model_started rows, split by category', () => {
  const result = report();
  assert.equal(result.modelCalls.requests, 4);
  assert.equal(result.modelCalls.calls, 10, 'Two, four, one and three calls for r1, r2, r6 and r10.');
  assert.deepEqual([result.modelCalls.p50, result.modelCalls.p90, result.modelCalls.max], [2, 4, 4]);
  assert.deepEqual(result.modelCalls.byCategory, { execution: 4, interpretation: 4, 'affinity-review': 1, 'goal-review': 1 });
});

test('time to first effect is measured from the request start and from the end of speech', () => {
  const result = report();
  assert.deepEqual(result.timeToFirstEffect.fromRequestStart, { samples: 4, p50: 4000, p90: 12000, max: 12000 });
  assert.deepEqual(result.timeToFirstEffect.fromSpeechEnd, { samples: 3, p50: 6000, p90: 14000, max: 14000 },
    'The typed request r6 has no stt_complete row, so it contributes no speech-end sample.');
});

test('prompt tokens per interpretation ignore the other model categories', () => {
  assert.deepEqual(report().interpretationPromptTokens, { samples: 4, p50: 12000, p90: 20000, max: 20000 });
});

test('request error texts are normalized and ranked', () => {
  const result = report();
  assert.deepEqual(result.topTaskErrors, [
    { text: 'I could not interpret that request. Please try again.', count: 2 },
    { text: 'OpenRouter could not accept this request. Check the selected model and settings. (HTTP N)', count: 1 },
    { text: 'Session S changed before its result could be verified.', count: 1 }
  ]);
  assert.equal(normalizeErrorText('Pane session_t8v0ahl_mtq4m7x0 failed after 42 seconds.'), 'Pane S failed after N seconds.');
  assert.equal(normalizeErrorText('Request aade1c24-8281-477c-846c-4f361c1dc529 failed.'), 'Request S failed.');
});

test('diagnostics error reasons and provider 4xx coverage are reported', () => {
  const result = report();
  assert.deepEqual(result.topDiagnosticReasons, [
    { text: 'orchestrator_error request/invalid-request HTTP 400', count: 2 },
    { text: 'action_error send_prompt/input-surface-unverified', count: 1 }
  ]);
  assert.deepEqual(result.provider4xx, { rows: 4, withProviderMessage: 1, withoutProviderMessage: 3 });
});

test('coverage names the log files, ignores voice telemetry, and states how many requests it explains', () => {
  const result = report();
  assert.equal(result.coverage.conversationPresent, true);
  assert.equal(result.coverage.undatedRequests, 0);
  assert.equal(result.coverage.diagnosticRowsIgnored, 6, 'Five voice_inference rows and one voice_recording row are not request pipeline rows.');
  assert.equal(result.window.diagnosticRows, 28);
  assert.deepEqual(result.coverage.logs.map(log => [log.file, log.present, log.lines, log.unparsed]), [
    ['logs/orchestrator-errors.jsonl', true, 34, 0],
    ['logs/orchestrator-errors.jsonl.1', false, 0, 0],
    ['logs/orchestrator-errors.jsonl.2', false, 0, 0]
  ]);
  assert.equal(result.coverage.requestsWithDiagnostics, 4);
  assert.equal(result.coverage.requestsTotal, 12);
  assert.equal(result.coverage.diagnosticRequestsNotInStore, 0);
});

test('--since narrows the requests, receipts and diagnostics together', () => {
  const result = report(['--since', '2026-03-02']);
  assert.equal(result.window.since, '2026-03-02');
  assert.equal(result.requests.total, 7);
  assert.deepEqual(result.requests.perDay, { '2026-03-02': 4, '2026-03-03': 3 });
  assert.deepEqual(result.requests.status, { finished: 3, cancelled: 2, failed: 1, paused: 1 });
  assert.equal(result.requests.nonCompletion.count, 4);
  assert.equal(result.requests.repeats.count, 0, 'Both repeats are on the first day.');
  assert.equal(result.requests.verificationAsks.count, 0);
  assert.equal(result.writeRejections.total, 3);
  assert.equal(result.coverage.requestsWithDiagnostics, 2, 'Only r6 and r10 have diagnostics after the cut.');
  assert.deepEqual([result.modelCalls.requests, result.modelCalls.calls], [2, 4]);
  assert.deepEqual(result.provider4xx, { rows: 2, withProviderMessage: 0, withoutProviderMessage: 2 });
});

test('a missing diagnostics log yields zero coverage instead of a crash', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-measure-'));
  t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true, force: true }); });
  fs.copyFileSync(path.join(fixtureProfile, 'orchestrator-conversation.json'), path.join(directory, 'orchestrator-conversation.json'));
  const result = measure(loadProfile(directory), parseArgs([]));
  assert.equal(result.requests.total, 12, 'The conversation store is still measured without any log.');
  assert.equal(result.window.diagnosticRows, 0);
  assert.equal(result.coverage.requestsWithDiagnostics, 0);
  assert.equal(result.coverage.diagnosticRowsIgnored, 0);
  assert.deepEqual(result.coverage.logs.map(log => log.present), [false, false, false]);
  assert.deepEqual(result.modelCalls, { samples: 0, p50: null, p90: null, max: null, requests: 0, calls: 0, byCategory: {} });
  assert.deepEqual(result.timeToFirstEffect.fromRequestStart, { samples: 0, p50: null, p90: null, max: null });
  assert.deepEqual(result.interpretationPromptTokens, { samples: 0, p50: null, p90: null, max: null });
  assert.deepEqual(result.topDiagnosticReasons, []);
  assert.deepEqual(result.provider4xx, { rows: 0, withProviderMessage: 0, withoutProviderMessage: 0 });
  const table = renderTable(result);
  assert.match(table, /logs\/orchestrator-errors\.jsonl\s+missing/);
  assert.match(table, /Requests with diagnostics\s+0 of 12 \(0\.0%\)/);
  assert.match(table, /p50 n\/a/);
});

test('an empty profile directory reports nothing measured and exits nonzero', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-measure-empty-'));
  t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true, force: true }); });
  const profile = loadProfile(directory);
  assert.equal(profile.conversationPresent, false);
  const result = measure(profile, parseArgs([]));
  assert.equal(result.requests.total, 0);
  assert.equal(result.requests.nonCompletion.rate, null);
  assert.match(renderTable(result), /NOT FOUND/);
  const run = spawnSync(process.execPath, [scriptPath, '--profile', directory], { encoding: 'utf8' });
  assert.equal(run.status, 1, 'A profile with no conversation store is reported as a failed measurement.');
});

test('the table and the JSON report the same numbers from the command line', () => {
  const table = spawnSync(process.execPath, [scriptPath, '--profile', fixtureProfile, '--last', '5'], { encoding: 'utf8' });
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /Requests per day, UTC \(12 requests in window\)/);
  assert.match(table.stdout, /2026-03-01\s+5/);
  assert.match(table.stdout, /Last 5 requests\s+4\s+80\.0%/);
  assert.match(table.stdout, /Likely repeats\s+2/);
  assert.match(table.stdout, /Without providerMessage\s+3/);

  const json = spawnSync(process.execPath, [scriptPath, '--profile', fixtureProfile, '--last', '5', '--json'], { encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  // fidelity is the last command-fidelity sweep of this working tree, or null
  // when none has been run; it is never read from the installed profile.
  assert.deepEqual(Object.keys(parsed), ['generatedAt', 'profile', 'window', 'coverage', 'requests', 'writeRejections', 'modelCalls', 'timeToFirstEffect', 'interpretationPromptTokens', 'topTaskErrors', 'topDiagnosticReasons', 'provider4xx', 'fidelity']);
  assert.ok(parsed.fidelity === null || typeof parsed.fidelity.summary === 'string');
  assert.equal(parsed.profile, fixtureProfile);
  assert.match(parsed.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(parsed.window), ['since', 'lastN', 'requests', 'firstRequest', 'lastRequest', 'days', 'receipts', 'diagnosticRows']);
  assert.deepEqual(Object.keys(parsed.requests), ['total', 'perDay', 'status', 'nonCompletion', 'nonCompletionRecent', 'repeats', 'verificationAsks']);
  assert.equal(parsed.window.lastN, 5);
  assert.equal(parsed.requests.nonCompletionRecent.rate, 0.8);
  assert.equal(parsed.requests.repeats.count, 2);
  assert.equal(parsed.modelCalls.p90, 4);
  assert.equal(parsed.timeToFirstEffect.fromSpeechEnd.p50, 6000);
  assert.equal(parsed.interpretationPromptTokens.p50, 12000);
  assert.equal(parsed.provider4xx.withProviderMessage, 1);
});

test('percentiles use nearest rank and arguments are validated', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 90), 4);
  assert.equal(percentile([4, 3, 2, 1, 10, 9, 8, 7, 6, 5], 90), 9);
  assert.equal(percentile([1, 2, 3], 100), 3);
  assert.equal(parseArgs(['--profile', 'p', '--last', '7', '--since', '2026-03-02', '--json']).last, 7);
  assert.equal(parseArgs(['--profile=p']).profile, 'p');
  assert.equal(parseArgs(['--json']).json, true);
  assert.equal(parseArgs([]).last, 50);
  assert(parseArgs([]).profile.endsWith('vibe-terminal'), 'The installed profile is the default.');
  assert.throws(() => parseArgs(['--last', '0']), /--last needs a positive whole number/);
  assert.throws(() => parseArgs(['--since', 'yesterday']), /--since needs an ISO date/);
  assert.throws(() => parseArgs(['--profile']), /--profile needs a value/);
  assert.throws(() => parseArgs(['--everything']), /Unknown argument: --everything/);
  const bad = spawnSync(process.execPath, [scriptPath, '--everything'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown argument: --everything/);
});
