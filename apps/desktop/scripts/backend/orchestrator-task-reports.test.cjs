'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectTaskReports } = require('../../backend/orchestratorTaskReports.cjs');
function fixture(count = 1) {
  const sessions = Array.from({ length: count }, (_, i) => ({ id: `s${i}`, generation: 'g', name: `Pane ${i}`, turnState: 'completed' }));
  const job = { executionDone: true, task: { status: 'waiting-results', targets: sessions }, controller: new AbortController(), waits: sessions.map(session => ({ targetId: session.id, generation: 'g', delivered: true, deliveryStatus: 'sent', done: false })) };
  return { job, sessions, collect: () => collectTaskReports(job, sessions) };
}
test('initial acknowledgement and unrelated session completion produce no outcome claim', () => {
  const f = fixture();
  assert.deepEqual(f.collect(), []);
  f.job.waits[0].observedState = 'running';
  assert.match(f.collect()[0].text, /working/);
  assert.deepEqual(f.collect(), []);
  f.job.waits[0].observedState = 'waiting';
  assert.equal(f.collect()[0].status, 'needs-answer');
  assert.deepEqual(f.collect(), []);
});
test('per-target completion is prompt and final target ends multi-target request once', () => {
  const f = fixture(2);
  Object.assign(f.job.waits[0], { done: true, observedState: 'completed' });
  let reports = f.collect();
  assert.equal(reports.length, 1);
  assert.match(reports[0].text, /Pane 0: the agent turn completed.*not independently verified/);
  assert.doesNotMatch(reports[0].text, /All requested/);
  Object.assign(f.job.waits[1], { done: true, failed: true, observedState: 'failed' });
  f.job.task.status = 'failed';
  reports = f.collect();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'failed');
  assert.match(reports[0].text, /ended with an error.*All requested terminal turns have ended/);
  assert.deepEqual(f.collect(), []);
});
test('failed relay retains reports for live terminal work; cancelled and restored never report', () => {
  const f = fixture();
  f.job.task.status = 'failed';
  f.job.waits[0].observedState = 'running';
  assert.equal(f.collect().length, 1);
  Object.assign(f.job.waits[0], { done: true, observedState: 'completed' });
  f.job.task.status = 'cancelled';
  assert.deepEqual(f.collect(), []);
  f.job.task.status = 'finished'; f.job.restored = true;
  assert.deepEqual(f.collect(), []);
  f.job.restored = false; f.job.controller.abort();
  assert.deepEqual(f.collect(), []);
});
test('queued delivery reports dispatch transition without duplicated acknowledgement', () => {
  const f = fixture();
  Object.assign(f.job.waits[0], { delivered: false, deliveryStatus: 'queued' });
  assert.equal(f.collect()[0].status, 'queued');
  assert.deepEqual(f.collect(), []);
  Object.assign(f.job.waits[0], { delivered: true, deliveryStatus: 'sent' });
  assert.match(f.collect()[0].text, /queued prompt was sent/);
  assert.deepEqual(f.collect(), []);
});
test('shell and uncertain delivery explicitly preserve uncertainty, without output or prompt text', () => {
  const f = fixture(2);
  f.job.task.text = 'PRIVATE PROMPT'; f.sessions[0].output = 'PRIVATE OUTPUT';
  f.job.waits[0].nativeShell = true;
  f.job.waits[1].deliveryStatus = 'unknown';
  const reports = f.collect();
  assert.equal(reports.length, 2);
  assert.match(reports[0].text, /plain shell.*Completion is unverified/);
  assert.match(reports[1].text, /delivery is unconfirmed/);
  assert.doesNotMatch(JSON.stringify(reports), /PRIVATE/);
  assert.deepEqual(f.collect(), []);
});
test('changed generation, interruptions, and drafts retain distinct explanations', () => {
  const f = fixture(3);
  Object.assign(f.job.waits[0], { done: true, failed: true });
  f.sessions[0] = { ...f.sessions[0], generation: 'new' };
  Object.assign(f.job.waits[1], { done: true, failed: true, observedState: 'interrupted' });
  f.job.waits[2].staged = true;
  const reports = f.collect();
  assert.match(reports[0].text, /terminal changed.*Completion is unverified/);
  assert.match(reports[1].text, /interrupted/);
  assert.match(reports[2].text, /draft.*not been sent/);
  assert.doesNotMatch(JSON.stringify(reports), /All requested/);
});
test('reports wait until relay execution ends', () => {
  const f = fixture();
  f.job.executionDone = false;
  Object.assign(f.job.waits[0], { done: true, observedState: 'completed' });
  assert.deepEqual(f.collect(), []);
  f.job.executionDone = true;
  assert.equal(f.collect().length, 1);
});
test('each new input blockage reports once, without repeating running updates', () => {
  const f = fixture();
  f.job.waits[0].observedState = 'running'; f.collect();
  f.job.waits[0].observedState = 'waiting';
  assert.equal(f.collect()[0].status, 'needs-answer');
  assert.deepEqual(f.collect(), []);
  f.job.waits[0].observedState = 'running';
  assert.deepEqual(f.collect(), []);
  f.job.waits[0].observedState = 'waiting';
  assert.equal(f.collect()[0].status, 'needs-answer');
});
test('attributed activity supersedes uncertain delivery and uncertain shells do not claim dispatch', () => {
  const f = fixture(2);
  Object.assign(f.job.waits[0], { deliveryStatus: 'uncertain', observedState: 'waiting' });
  Object.assign(f.job.waits[1], { deliveryStatus: 'unknown', nativeShell: true });
  const reports = f.collect();
  assert.equal(reports[0].status, 'needs-answer');
  assert.doesNotMatch(reports[0].text, /unconfirmed/);
  assert.match(reports[1].text, /delivery.*unconfirmed.*cannot verify automatically/);
  assert.doesNotMatch(reports[1].text, /was sent/);
});
test('queued delivery failures explain the bounded obstacle', () => {
  const f = fixture();
  Object.assign(f.job.waits[0], { done: true, failed: true, delivered: false, error: 'Queue expired.\n' + 'x'.repeat(400) });
  const report = f.collect()[0];
  assert.match(report.text, /Queue expired/);
  assert.doesNotMatch(report.text, /\n/);
  assert.ok(report.text.length < 350);
});
test('missing start attribution warns once at 60 seconds and later completion still reports', () => {
  const f = fixture();
  f.job.waits[0].submittedAt = 1000;
  const before = structuredClone(f.job.waits[0]);
  assert.deepEqual(collectTaskReports(f.job, f.sessions, { now: () => 60999 }), []);
  const reports = collectTaskReports(f.job, f.sessions, { now: () => 61000 });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'unverified');
  assert.match(reports[0].text, /input was sent.*could not confirm.*started.*Completion remains unverified/);
  assert.deepEqual(f.job.waits[0], before, 'Warning must not fail, release, or replay the wait');
  assert.deepEqual(collectTaskReports(f.job, f.sessions, { now: () => 121000 }), []);
  Object.assign(f.job.waits[0], { done: true, observedState: 'completed' });
  assert.equal(collectTaskReports(f.job, f.sessions, { now: () => 122000 })[0].status, 'completed');
});
test('no-start warning excludes missing timestamps and known or undelivered work', () => {
  const patches = [{}, { submittedAt: NaN }, { submittedAt: 0, observedState: 'running' },
    { submittedAt: 0, delivered: false, deliveryStatus: 'queued' }, { submittedAt: 0, staged: true },
    { submittedAt: 0, nativeShell: true }, { submittedAt: 0, done: true, observedState: 'completed' }];
  for (const patch of patches) {
    const f = fixture(); Object.assign(f.job.waits[0], patch);
    const reports = collectTaskReports(f.job, f.sessions, { now: () => 60000 });
    assert.doesNotMatch(JSON.stringify(reports), /could not confirm that the agent started/);
  }
  const f = fixture(); Object.assign(f.job.waits[0], { submittedAt: 0, deliveryStatus: 'unknown' });
  const reports = collectTaskReports(f.job, f.sessions, { now: () => 60000 });
  assert.match(reports[0].text, /delivery is unconfirmed/);
  assert.doesNotMatch(reports[0].text, /was sent/);
});
test('ambiguous attribution warns once even after running then permits a verified result', () => {
  const f = fixture(); Object.assign(f.job.waits[0], { observedState: 'running', submittedAt: 0 });
  f.collect();
  f.job.waits[0].attributionAmbiguous = true;
  const reports = f.collect();
  assert.equal(reports.length, 1);
  assert.match(reports[0].text, /could not reliably match.*Completion remains unverified/);
  assert.deepEqual(f.collect(), []);
  Object.assign(f.job.waits[0], { attributionAmbiguous: false, observedState: 'completed', done: true });
  assert.equal(f.collect()[0].status, 'completed');
});
test('watch reports never imply prompt delivery and ready is not task completion', () => {
  const f = fixture(); Object.assign(f.job.waits[0], { source: 'watch', deliveryStatus: 'watching', delivered: false, submittedAt: 0 });
  assert.deepEqual(collectTaskReports(f.job, f.sessions, { now: () => 120000 }), []);
  Object.assign(f.job.waits[0], { observedState: 'running', turnId: 'watched', actionId: 'a' });
  const running = f.collect()[0];
  assert.match(running.text, /watched turn/);
  assert.equal(running.source, 'watch'); assert.equal(running.turnId, 'watched'); assert.equal(running.actionId, 'a');
  Object.assign(f.job.waits[0], { done: true, observedState: 'ready' });
  const ready = f.collect()[0];
  assert.equal(ready.status, 'ready');
  assert.match(ready.text, /does not establish that any task was completed/);
  assert.doesNotMatch(ready.text, /was sent|agent turn completed/);
  assert.deepEqual(f.collect(), []);
});
test('watched shell uncertainty never claims input was sent', () => {
  const f = fixture(); Object.assign(f.job.waits[0], { source: 'watch', deliveryStatus: 'watching', nativeShell: true });
  const report = f.collect()[0];
  assert.match(report.text, /watching this plain shell/);
  assert.doesNotMatch(report.text, /was sent/);
});

test('prompt and Enter waits attributed to one turn report once across polls', () => {
  const f = fixture();
  const first = f.job.waits[0];
  Object.assign(first, { turnId: 'turn', observedState: 'running', actionId: 'prompt' });
  f.job.waits.push({ ...first, actionId: 'enter' });
  assert.equal(f.collect().length, 1);
  assert.deepEqual(f.collect(), []);
  f.job.waits.push({ ...first, actionId: 'late-enter' });
  assert.deepEqual(f.collect(), []);
  for (const wait of f.job.waits) Object.assign(wait, { done: true, observedState: 'completed' });
  const reports = f.collect();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'completed');
  assert.doesNotMatch(reports[0].text, /All requested/);
  assert.deepEqual(f.collect(), []);
});

test('turn report identities preserve distinct requests, generations, terminals and turns', () => {
  const f = fixture();
  Object.assign(f.job.waits[0], { turnId: 'turn', observedState: 'running' });
  for (const patch of [{ turnId: 'next' }, { generation: 'next' }, { targetId: 'other' }]) {
    f.job.waits.push({ ...f.job.waits[0], ...patch });
  }
  assert.equal(f.collect().length, 4);
  assert.deepEqual(f.collect(), []);
  assert.equal(collectTaskReports({ ...f.job }, f.sessions).length, 4);
});

test('separate unattributed queued and uncertain deliveries retain their own reports', () => {
  for (const patch of [{ delivered: false, deliveryStatus: 'queued' }, { deliveryStatus: 'unknown' }]) {
    const f = fixture();
    Object.assign(f.job.waits[0], patch);
    f.job.waits.push({ ...f.job.waits[0] });
    assert.equal(f.collect().length, 2);
    assert.deepEqual(f.collect(), []);
    for (const wait of f.job.waits) Object.assign(wait, { delivered: true, turnId: 'turn', observedState: 'running' });
    for (const wait of f.job.waits) wait.deliveryStatus = 'sent';
    assert.equal(f.collect().length, 1);
  }
});

test('duplicate attributed waits retain new blocker episodes and watcher resumptions', () => {
  for (const source of [undefined, 'watch']) {
    const f = fixture();
    Object.assign(f.job.waits[0], { source, turnId: 'turn', observedState: 'running' });
    f.job.waits.push({ ...f.job.waits[0] });
    assert.equal(f.collect().length, 1);
    f.job.waits[0].observedState = 'waiting';
    assert.equal(f.collect()[0].status, 'needs-answer');
    assert.deepEqual(f.collect(), [], 'stale running sibling must not reset waiting episode');
    f.job.waits[1].observedState = 'waiting';
    assert.deepEqual(f.collect(), []);
    for (const wait of f.job.waits) wait.observedState = 'running';
    assert.equal(f.collect().length, source === 'watch' ? 1 : 0);
    for (const wait of f.job.waits) wait.observedState = 'waiting';
    assert.equal(f.collect().length, 1);
    assert.deepEqual(f.collect(), []);
  }
});

test('duplicate attributed failures deduplicate but different failure reasons remain visible', () => {
  const f = fixture();
  Object.assign(f.job.waits[0], { turnId: 'turn', observedState: 'failed', done: true, failed: true, error: 'Provider failed' });
  f.job.waits.push({ ...f.job.waits[0] });
  assert.equal(f.collect().length, 1);
  f.job.waits.push({ ...f.job.waits[0], error: 'Delivery failed' });
  assert.equal(f.collect().length, 1);
  assert.deepEqual(f.collect(), []);
});

test('completed turn stays silent through replacement and late waits while a new turn reports', () => {
  const f = fixture();
  Object.assign(f.job.waits[0], { turnId: 'finished-turn', observedState: 'completed', done: true });
  const first = f.collect();
  assert.equal(first.length, 1);
  assert.match(first[0].text, /requested outcome is not independently verified/);

  f.job.waits = f.job.waits.map(wait => ({ ...wait }));
  f.job.waits.push({ ...f.job.waits[0], source: 'watch', actionId: 'late-watch' });
  assert.deepEqual(f.collect(), []);
  assert.deepEqual(f.collect(), []);

  f.job.waits.push({ ...f.job.waits[0], turnId: 'next-turn', actionId: 'new-prompt' });
  const next = f.collect();
  assert.equal(next.length, 1);
  assert.equal(next[0].turnId, 'next-turn');
  assert.match(next[0].text, /requested outcome is not independently verified/);
  assert.deepEqual(f.collect(), []);
});

test('composer-observed acceptance replaces the unconfirmed-start warning and hooks still win', () => {
  const f = fixture();
  Object.assign(f.job.waits[0], { submittedAt: 1000, observedState: 'submitted-observed', observedAt: 2000 });
  const accepted = collectTaskReports(f.job, f.sessions, { now: () => 5000 });
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].status, 'delivered');
  assert.match(accepted[0].text, /^Pane 0: the prompt was accepted; the result is pending\.$/);
  assert.deepEqual(collectTaskReports(f.job, f.sessions, { now: () => 5001 }), [], 'Reported once');
  const diagnostics = [];
  assert.deepEqual(collectTaskReports(f.job, f.sessions, { now: () => 620000, recordDiagnostic: entry => diagnostics.push(entry) }), []);
  assert.deepEqual(diagnostics, [], 'The delayed unconfirmed-start path never fires for an accepted prompt');
  Object.assign(f.job.waits[0], { done: true, observedState: 'completed' });
  assert.equal(collectTaskReports(f.job, f.sessions, { now: () => 621000 })[0].status, 'completed');
});

test('an unconfirmed start records bounded private startup telemetry once and no text', () => {
  const f = fixture();
  f.job.task.requestId = 'request-1';
  f.sessions[0] = { ...f.sessions[0], provider: 'codex', turnState: 'idle', turnStartedAt: 400, telemetryHealth: 'healthy' };
  Object.assign(f.job.waits[0], { submittedAt: 1000 });
  const diagnostics = [];
  const recordDiagnostic = entry => diagnostics.push(entry);
  const reports = collectTaskReports(f.job, f.sessions, { now: () => 61000, recordDiagnostic });
  assert.equal(reports.length, 1);
  assert.deepEqual(diagnostics, [{ event: 'request_stage', stage: 'unconfirmed_start', requestId: 'request-1',
    targetId: 's0', generation: 'g', actionKind: 'send_prompt', provider: 'codex', turnState: 'idle', hasTurnId: false,
    telemetryHealth: 'healthy', turnStartedOffsetMs: -600 }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /Pane 0|input was sent|could not confirm/);
  collectTaskReports(f.job, f.sessions, { now: () => 122000, recordDiagnostic });
  assert.equal(diagnostics.length, 1, 'The record follows the single warning, not every collection');
});
