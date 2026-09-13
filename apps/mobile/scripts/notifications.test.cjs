'use strict';

/**
 * The notification rule, on the Node test runner.
 *
 * Everything about *what* is worth a notification is one pure comparison of two
 * snapshots, which is what makes it testable at all: the foreground long poll
 * and the fifteen-minute background wake run this same function, so anything
 * proved here is true of both. Nothing in this file touches a native module.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CHANNEL_ID,
  CHANNEL_NAME,
  MAX_ITEMS,
  compactSnapshot,
  diffNotifications,
  expandSnapshot,
  snapshotFromState,
} = require('../src/state/notifications.js');

/** A `/api/state` body with the fields the rule reads. */
function state(sessions, orchestrator) {
  return {
    ok: true,
    revision: 1,
    at: 0,
    projects: [],
    sessions: sessions.map(session => ({
      generation: 1,
      projectId: 'p',
      projectName: 'vibeTerminal',
      kind: 'claude',
      provider: 'claude',
      isChat: false,
      attention: false,
      lastActivityAt: 0,
      snippet: '',
      needsInput: null,
      ...session,
    })),
    orchestrator: {
      enabled: true,
      ready: true,
      activeCount: 0,
      lastMessageAt: null,
      ...(orchestrator || {}),
    },
  };
}

const PROMPT = {
  kind: 'yesno',
  prompt: 'Edit apps/desktop/frontend/components/StatusPill.tsx?\nIt has unsaved changes.',
  options: [{ key: '1', label: 'Yes' }],
};

test('the first sight of a desktop is a baseline, not news', () => {
  const now = snapshotFromState(
    state([{ id: 's1', title: 'Claude', status: 'waiting', needsInput: PROMPT }]),
    { now: 1 }
  );
  assert.deepEqual(diffNotifications(null, now), []);
});

test('a terminal that starts asking something notifies, with the prompt line', () => {
  const before = snapshotFromState(state([{ id: 's1', title: 'Claude', status: 'working' }]), { now: 1 });
  const after = snapshotFromState(
    state([{ id: 's1', title: 'Claude', status: 'working', needsInput: PROMPT }]),
    { now: 2 }
  );
  const items = diffNotifications(before, after);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'needs-input');
  assert.equal(items[0].title, 'Claude needs you');
  // The first line of the prompt, not the whole of it.
  assert.equal(items[0].body, 'Edit apps/desktop/frontend/components/StatusPill.tsx?');
  assert.equal(items[0].sessionId, 's1');
});

test('a terminal that stops working finishes, fails, or exits', () => {
  const before = snapshotFromState(
    state([
      { id: 'a', title: 'Codex', status: 'working' },
      { id: 'b', title: 'Gemini', status: 'working' },
      { id: 'c', title: 'Shell', status: 'working' },
    ]),
    { now: 1 }
  );
  const after = snapshotFromState(
    state([
      { id: 'a', title: 'Codex', status: 'done', snippet: 'All 60 tests passed.' },
      { id: 'b', title: 'Gemini', status: 'failed', snippet: 'tsc exited 2' },
      { id: 'c', title: 'Shell', status: 'exited' },
    ]),
    { now: 2 }
  );
  const items = diffNotifications(before, after);
  assert.deepEqual(
    items.map(item => [item.kind, item.title, item.body]),
    [
      ['finished', 'Codex finished', 'All 60 tests passed.'],
      ['failed', 'Gemini failed', 'tsc exited 2'],
      ['finished', 'Shell finished', 'The terminal has stopped working.'],
    ]
  );
});

test('a terminal that was not working cannot finish', () => {
  // A terminal the phone first sees as `done`, and one that goes idle -> done,
  // are both the desktop's business, not a notification.
  const before = snapshotFromState(state([{ id: 'a', title: 'Codex', status: 'idle' }]), { now: 1 });
  const after = snapshotFromState(
    state([
      { id: 'a', title: 'Codex', status: 'done' },
      { id: 'new', title: 'Fresh', status: 'done' },
    ]),
    { now: 2 }
  );
  assert.deepEqual(diffNotifications(before, after), []);
});

test('the Orchestrator answering is one notification', () => {
  const before = snapshotFromState(state([], { lastMessageAt: 1000 }), { now: 1 });
  const after = snapshotFromState(state([], { lastMessageAt: 2000 }), {
    now: 2,
    orchestratorSnippet: 'Queued the release checks on vibeTerminal.',
  });
  const items = diffNotifications(before, after);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'replied');
  assert.equal(items[0].title, 'Lina replied');
  assert.equal(items[0].body, 'Queued the release checks on vibeTerminal.');
  assert.equal(items[0].sessionId, null);
  // With no text to hand — the background wake reads only `/api/state` — it
  // still says something true.
  const quiet = diffNotifications(before, snapshotFromState(state([], { lastMessageAt: 3000 }), { now: 3 }));
  assert.equal(quiet[0].body, 'The Orchestrator has answered.');
});

test('an unchanged state notifies nothing, however often it is polled', () => {
  const sessions = [
    { id: 'a', title: 'Codex', status: 'working', snippet: 'running tests' },
    { id: 'b', title: 'Claude', status: 'waiting', needsInput: PROMPT },
    { id: 'c', title: 'Shell', status: 'done' },
  ];
  const first = snapshotFromState(state(sessions, { lastMessageAt: 1000 }), { now: 1 });
  const second = snapshotFromState(state(sessions, { lastMessageAt: 1000 }), { now: 2 });
  const third = snapshotFromState(state(sessions, { lastMessageAt: 1000 }), { now: 3 });
  assert.deepEqual(diffNotifications(first, second), []);
  assert.deepEqual(diffNotifications(second, third), []);
});

test('a terminal that keeps asking does not ask twice', () => {
  const before = snapshotFromState(state([{ id: 'a', title: 'Claude', status: 'working' }]), { now: 1 });
  const asking = snapshotFromState(
    state([{ id: 'a', title: 'Claude', status: 'working', needsInput: PROMPT }]),
    { now: 2 }
  );
  const stillAsking = snapshotFromState(
    state([{ id: 'a', title: 'Claude', status: 'waiting', needsInput: PROMPT }]),
    { now: 3 }
  );
  assert.equal(diffNotifications(before, asking).length, 1);
  assert.deepEqual(diffNotifications(asking, stillAsking), []);
});

test('an answered prompt that comes back is news again', () => {
  const asking = snapshotFromState(
    state([{ id: 'a', title: 'Claude', status: 'working', needsInput: PROMPT }]),
    { now: 1 }
  );
  const answered = snapshotFromState(state([{ id: 'a', title: 'Claude', status: 'working' }]), { now: 2 });
  const askingAgain = snapshotFromState(
    state([{ id: 'a', title: 'Claude', status: 'working', needsInput: PROMPT }]),
    { now: 3 }
  );
  assert.deepEqual(diffNotifications(asking, answered), []);
  assert.equal(diffNotifications(answered, askingAgain).length, 1);
});

test('a `needsInput` with nothing in it is not a prompt', () => {
  const before = snapshotFromState(state([{ id: 'a', title: 'Claude', status: 'working' }]), { now: 1 });
  const after = snapshotFromState(
    state([{ id: 'a', title: 'Claude', status: 'working', needsInput: { kind: 'menu', options: [] } }]),
    { now: 2 }
  );
  assert.deepEqual(diffNotifications(before, after), []);
});

test('a wall of changes collapses into a countable number of them', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const before = snapshotFromState(
    state(ids.map(id => ({ id, title: id.toUpperCase(), status: 'working' }))),
    { now: 1 }
  );
  const after = snapshotFromState(
    state(ids.map(id => ({ id, title: id.toUpperCase(), status: 'done' }))),
    { now: 2 }
  );
  const items = diffNotifications(before, after);
  assert.equal(items.length, MAX_ITEMS + 1);
  assert.equal(items[items.length - 1].kind, 'more');
  assert.equal(items[items.length - 1].body, `and ${ids.length - MAX_ITEMS} more updates`);
});

test('a snapshot survives being stored and read back', () => {
  const snapshot = snapshotFromState(
    state(
      [
        { id: 'a', title: 'Codex', status: 'working', snippet: 'running tests' },
        { id: 'b', title: 'Claude', status: 'waiting', needsInput: PROMPT },
      ],
      { lastMessageAt: 4000 }
    ),
    { now: 7 }
  );
  const restored = expandSnapshot(JSON.parse(JSON.stringify(compactSnapshot(snapshot))));
  assert.ok(restored);
  // Only what a comparison reads survives; the words always come from the new
  // side, so the stored copy stays small.
  assert.deepEqual(
    restored.sessions.map(session => [session.id, session.status, session.needs]),
    [
      ['a', 'working', false],
      ['b', 'waiting', true],
    ]
  );
  assert.equal(restored.orchestrator.lastMessageAt, 4000);
  // And it is the same baseline: the restored copy notifies about the same
  // change the live one would have.
  const next = snapshotFromState(
    state(
      [
        { id: 'a', title: 'Codex', status: 'done', snippet: 'done' },
        { id: 'b', title: 'Claude', status: 'waiting', needsInput: PROMPT },
      ],
      { lastMessageAt: 4000 }
    ),
    { now: 8 }
  );
  assert.deepEqual(
    diffNotifications(restored, next).map(item => item.kind),
    diffNotifications(snapshot, next).map(item => item.kind)
  );
  assert.deepEqual(diffNotifications(restored, next).map(item => item.kind), ['finished']);
  // A stored value from another version, or nonsense, is no baseline at all.
  assert.equal(expandSnapshot({ v: 99 }), null);
  assert.equal(expandSnapshot(null), null);
});

test('the channel the app posts on is named once, and shared', () => {
  assert.equal(CHANNEL_ID, 'terminals');
  assert.equal(CHANNEL_NAME, 'Terminals');
});
