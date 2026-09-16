'use strict';
// The terminal model: one object per pane, the facts a sentence can point at,
// computed once (docs/orchestrator-terminal-model-overhaul-2026-09-15.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalHandles, buildTerminalModel, rosterRows, spokenName } = require('../../backend/orchestratorTerminalModel.cjs');

// Live panes as the inventory publishes them; the pane-state predicate needs
// the process facts to call a pane idle, working, waiting or done.
const live = patch => ({ kind: 'codex', provider: 'codex', started: true, processState: 'running', agentProcessState: 'running', agentPid: 7,
  launchState: 'ready', observation: 'observed', generation: 'g', cwd: 'C:\\Projects\\vibeTerminal', ...patch });
const sessions = () => [
  live({ id: 's1', name: 'vibeTerminal', status: 'running', turnState: 'running', turnId: 't1', turnStartedAt: 1000 }),
  live({ id: 's2', name: 'Fix the full screen bug', kind: 'claude', provider: 'claude', status: 'completed', turnState: 'completed', turnId: 't2', turnStartedAt: 500, turnEndedAt: 2000 }),
  live({ id: 's3', name: 'vibeTerminal', status: 'unknown', turnState: 'unknown' }),
  live({ id: 's4', name: 'lina web app', cwd: 'C:\\Projects\\lina web app', status: 'waiting', turnState: 'waiting', turnId: 't4', turnStartedAt: 1500, attention: { reason: 'question' } }),
];

test('handles are assigned once per pane, in inventory order, never reused, and restored from a snapshot', () => {
  const saved = [];
  const handles = createTerminalHandles({ save: snapshot => saved.push(snapshot) });
  assert.equal(handles.assign(sessions()), true);
  assert.deepEqual(sessions().map(s => handles.of(s.id)), ['T1', 'T2', 'T3', 'T4']);
  assert.equal(handles.assign(sessions()), false, 'nothing new, nothing saved');
  handles.assign([live({ id: 's9' })]);
  assert.equal(handles.of('s9'), 'T5', 'a later pane never takes a closed pane\'s handle');
  const restored = createTerminalHandles({ load: () => saved.at(-1) });
  assert.equal(restored.of('s2'), 'T2'); assert.equal(restored.of('s9'), 'T5');
  restored.assign([live({ id: 's10' })]);
  assert.equal(restored.of('s10'), 'T6', 'the counter is restored too');
  const junk = createTerminalHandles({ load: () => ({ next: 'x', byId: { a: 'nope', b: 'T7' } }) });
  assert.deepEqual(junk.snapshot(), { next: 1, byId: { b: 'T7' } }, 'malformed handles are dropped, the rest kept');
});

test('every fact a sentence can point at is a field, computed from the session and the records', () => {
  const handles = createTerminalHandles();
  const model = buildTerminalModel({
    sessions: sessions(), handles,
    records: { s2: { lastResultSummary: 'Fixed the parser.  Three tests passed.' }, s4: { lastPromptText: 'Do a deep dive on the PDF viewer.' } },
    workItems: [{ id: 'w1', status: 'active', objective: 'Add a chat section to the app', binding: { target: { id: 's1' } } },
      { id: 'w2', status: 'cancelled', objective: 'old', binding: { target: { id: 's3' } } }],
    ledgerRows: [
      { requestId: 'r1', at: 100, verb: 'start', outcome: 'delivered-started', pane: { id: 's1' } },
      { requestId: 'r2', at: 200, verb: 'ask', outcome: 'answered', pane: { id: 's2' } },
    ],
  });
  const by = Object.fromEntries(model.map(t => [t.id, t]));
  assert.deepEqual(model.map(t => t.handle), ['T1', 'T2', 'T3', 'T4']);
  assert.equal(by.s1.state, 'working'); assert.equal(by.s1.on, 'Add a chat section to the app'); assert.equal(by.s1.owner, 'lina');
  assert.deepEqual(by.s1.lastTouched, { by: 'lina', at: 100, what: 'prompt', delivered: true });
  assert.deepEqual(by.s1.lastWorked, { at: 100, fresh: false }, 'the newest delivery, but a later row exists, so it is not the latest thing');
  assert.equal(by.s2.state, 'done'); assert.equal(by.s2.providerLabel, 'Claude Code');
  assert.equal(by.s2.result, 'Fixed the parser. Three tests passed.'); assert.equal(by.s2.endedAt, 2000);
  assert.deepEqual(by.s2.lastTouched, { by: 'lina', at: 200, what: 'question', delivered: false }); assert.equal(by.s2.lastWorked, null);
  assert.equal(by.s3.state, 'idle'); assert.equal(by.s3.owner, null, 'a cancelled work item no longer owns its pane'); assert.equal(by.s3.on, null); assert.equal(by.s3.lastTouched, null);
  assert.equal(by.s4.state, 'waiting'); assert.equal(by.s4.needs, 'answer'); assert.equal(by.s4.project, 'lina web app');
  assert.equal(by.s4.on, 'Do a deep dive on the PDF viewer.'); assert.equal(by.s4.owner, 'user', 'a pane the user prompted by hand');
  assert.deepEqual(by.s4.lastTouched, { by: 'user', at: 1500, what: 'prompt', delivered: true });
  assert.deepEqual([by.s1.free, by.s2.free, by.s3.free, by.s4.free], [false, true, true, false], 'a working pane and a pane the user is answering are not free; a finished pane nobody owns and an idle one are');
  assert.deepEqual(by.s3.task, { id: 'w2', status: 'cancelled', title: null, objective: 'old' }, 'a released item is still the task the user can name');
  assert.equal(by.s1.task.id, 'w1'); assert.equal(by.s2.activeAt, 2000); assert.equal(by.s1.activeAt, 1000);
  assert.equal(spokenName(by.s4), 'T4'); assert.equal(spokenName({ providerLabel: 'Codex' }), 'Codex terminal');
});

test('roster rows carry identity, state, task, owner, touch and result, nothing about the board or the process', () => {
  const handles = createTerminalHandles();
  const rows = rosterRows(buildTerminalModel({ sessions: sessions(), handles, records: { s2: { lastResultSummary: 'x'.repeat(300) } },
    ledgerRows: [{ requestId: 'r', at: 5, verb: 'start', outcome: 'delivered-started', pane: { id: 's3' } }] }), { cwd: 'c:/projects/vibeterminal/' });
  // s1 was prompted at 1000 and s2 at 500 by the user; Lina's row on s3 is older.
  assert.deepEqual(rows.map(row => row.handle), ['T1', 'T2', 'T3'], 'the addressed project only, most recently touched first');
  assert.deepEqual(Object.keys(rows[1]).sort(), ['handle', 'id', 'name', 'owner', 'project', 'provider', 'result', 'state'].sort(),
    'recency is the row order and a verified observation goes unsaid');
  assert.equal(rows[1].result.length, 200, 'results are shortened for the Brain');
  assert.equal(rows[2].result, undefined, 'no result on record, no field');
  assert.equal(rosterRows(buildTerminalModel({ sessions: sessions(), handles })).length, 4, 'no project: every pane');
  assert.equal(rosterRows(buildTerminalModel({ sessions: sessions(), handles }), { limit: 2 }).length, 2);
});

test('what Lina opened and what she last delivered to, from her receipts and the ledger', () => {
  const two = [live({ id: 'a', name: 'A', status: 'unknown', turnState: 'unknown' }), live({ id: 'b', name: 'B', status: 'unknown', turnState: 'unknown' })];
  const model = (ledgerRows, receipts) => Object.fromEntries(buildTerminalModel({ sessions: two, ledgerRows, receipts }).map(t => [t.id, t]));
  const opened = model([], [{ kind: 'create_session', status: 'created', targetId: 'a', at: 50 }, { kind: 'create_session', status: 'rejected', targetId: 'b', at: 60 }]);
  assert.deepEqual([opened.a.opened, opened.b.opened], [{ by: 'lina', at: 50 }, null], 'only an acknowledged creation counts');
  const row = (id, at, extra = {}) => ({ requestId: `r-${at}`, at, verb: 'start', outcome: 'delivered-started', pane: { id }, ...extra });
  const fresh = model([row('a', 100), row('b', 200)], []);
  assert.deepEqual([fresh.a.lastWorked, fresh.b.lastWorked], [null, { at: 200, fresh: true }]);
  const tied = model([row('a', 300), row('b', 300)], []);
  assert.deepEqual([tied.a.lastWorked, tied.b.lastWorked], [{ at: 300, fresh: true }, { at: 300, fresh: true }], 'two panes delivered in the same moment tie');
  const stale = model([row('b', 200), { requestId: 'q', at: 300, verb: 'ask', outcome: 'answered' }], []);
  assert.deepEqual(stale.b.lastWorked, { at: 200, fresh: false }, 'a question after the delivery means there is no "one" to be other than');
  const same = model([row('b', 200), { requestId: 'r-200', at: 250, verb: 'status', outcome: 'replied', pane: { id: 'b' } }], []);
  assert.equal(same.b.lastWorked.fresh, true, 'a later row of the same request does not age the delivery');
});
