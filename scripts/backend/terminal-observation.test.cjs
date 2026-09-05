const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createTerminalObservation } = require('../../backend/terminalObservation.cjs');

test('older display samples paginate by generation and skip unchanged displays without changing UI history', async () => {
  const observation = createTerminalObservation();
  try {
    await observation.ingest({ type: 'created', id: 'p', generation: 'g', cols: 30, rows: 4 });
    for (const [sequence, text] of [[1, 'first'], [2, 'second'], [3, 'second'], [4, 'third'], [5, 'third']]) {
      await observation.ingest({ type: 'data', id: 'p', generation: 'g', sequence, outputAt: sequence * 100, data: '\x1b[2J\x1b[H' + text });
    }
    await observation.ingest({ type: 'snapshot', id: 'p', generation: 'g', data: 'UI replay' });
    const current = await observation.read({ id: 'p', generation: 'g' });
    assert.equal(current.text, 'third');
    assert.equal(current.sequence, 5);
    assert.equal(current.nextBeforeSequence, 4);
    assert.equal(current.hasEarlier, true);
    assert.deepEqual(current.history.map(sample => sample.sequence), [1, 2, 4]);
    const second = await observation.read({ id: 'p', generation: 'g', beforeSequence: current.nextBeforeSequence });
    assert.equal(second.text, 'second');
    assert.equal(second.sequence, 2);
    assert.equal(second.observedAt, 200);
    assert.equal(second.nextBeforeSequence, 2);
    assert.equal(second.history, undefined);
    const first = await observation.read({ id: 'p', generation: 'g', beforeSequence: second.nextBeforeSequence });
    assert.equal(first.text, 'first');
    assert.equal(first.nextBeforeSequence, null);
    assert.equal(first.hasEarlier, false);
    assert.equal(first.historyUnavailable, false);
    const end = await observation.read({ id: 'p', generation: 'g', beforeSequence: 1 });
    assert.equal(end.status, 'history-end');
    assert.equal(end.text, '');
    assert.equal(end.complete, true);
    assert.equal(end.completenessScope, 'retained-display-samples');
    assert.deepEqual((await observation.read({ id: 'p', generation: 'g' })).history, current.history);
    for (const cursor of [0, -1, 1.5, 6, '4', null]) assert.equal((await observation.read({ id: 'p', generation: 'g', beforeSequence: cursor })).status, 'invalid-cursor');
    assert.equal((await observation.read({ id: 'p', beforeSequence: 4 })).status, 'invalid-cursor');
    assert.equal((await observation.read({ id: 'p', generation: 'old', beforeSequence: 4 })).ok, false);
  } finally { observation.dispose(); }
});

test('sample pagination keeps Unicode valid and explicitly reports retained-history eviction gaps', async () => {
  const observation = createTerminalObservation({ maxHistoryBytes: 32 });
  try {
    await observation.ingest({ type: 'created', id: 'p', generation: 'g', cols: 30, rows: 4 });
    for (const [sequence, text] of [[1, 'one'.repeat(5)], [2, '漢😀older'], [3, 'newest']]) {
      await observation.ingest({ type: 'data', id: 'p', generation: 'g', sequence, data: '\x1b[2J\x1b[H' + text });
    }
    const current = await observation.read({ id: 'p', generation: 'g' });
    assert.equal(current.historyUnavailable, true);
    const page = await observation.read({ id: 'p', generation: 'g', beforeSequence: current.nextBeforeSequence, maxChars: 6 });
    assert.equal(page.text, '😀older');
    assert.equal(Array.from(page.text).length, 6);
    assert.equal(page.excerptTruncated, true);
    assert.equal(page.historyUnavailable, true);
    assert.equal(page.truncated, true);
    assert.equal(page.hasEarlier, false);
    assert.equal(page.nextBeforeSequence, null);
    const empty = await observation.read({ id: 'p', generation: 'g', beforeSequence: 2 });
    assert.equal(empty.status, 'history-end');
    assert.equal(empty.historyUnavailable, true);
    assert.equal(empty.truncated, true);
    assert.equal((await observation.read({ id: 'p', generation: 'g', beforeSequence: 3, maxChars: 0 })).text, '');
    await observation.ingest({ type: 'created', id: 'p', generation: 'replacement' });
    assert.equal((await observation.read({ id: 'p', generation: 'g', beforeSequence: 3 })).ok, false);
  } finally { observation.dispose(); }
});

test('live decoder handles split ANSI, Unicode, alternate screen, resize and replay', async () => {
  const observation = createTerminalObservation();
  try {
    await observation.ingest({ type: 'created', id: 'p', generation: 'g', cols: 30, rows: 6 });
    await observation.ingest({ type: 'data', id: 'p', generation: 'g', sequence: 1, outputAt: 100, data: 'hello 世界\x1b[' });
    await observation.ingest({ type: 'data', id: 'p', generation: 'g', sequence: 2, outputAt: 200, data: '2J\x1b[Hmain 😀' });
    let view = await observation.read({ id: 'p', generation: 'g' });
    assert.equal(view.text, 'main 😀');
    await observation.ingest({ type: 'snapshot', id: 'p', generation: 'g', data: 'DUPLICATE', at: 300 });
    view = await observation.read({ id: 'p' });
    assert.equal(view.sequence, 2);
    assert.equal(view.outputAt, 200);
    assert.equal(view.metadataAt, 300);
    await observation.ingest({ type: 'data', id: 'p', generation: 'g', sequence: 3, data: '\x1b[?1049h\x1b[HTUI' });
    view = await observation.read({ id: 'p' });
    assert.equal(view.alternateScreen, true);
    assert.equal(view.text, 'TUI');
    await observation.ingest({ type: 'data', id: 'p', generation: 'g', sequence: 4, data: '\x1b[?1049l' });
    await observation.ingest({ type: 'resize', id: 'p', generation: 'g', cols: 40, rows: 8 });
    view = await observation.read({ id: 'p' });
    assert.equal(view.text, 'main 😀');
    assert.equal(view.cols, 40);
    assert.equal((await observation.read({ id: 'p', generation: 'old' })).ok, false);
    await observation.ingest({ type: 'data', id: 'p', generation: 'old', data: 'STALE' });
    assert.equal((await observation.read({ id: 'p' })).text, 'main 😀');
    assert.equal((await observation.read({ id: 'p', maxChars: 0 })).text, '');
    observation.forget('p', 'g');
    assert.equal((await observation.read({ id: 'p' })).ok, false);
  } finally { observation.dispose(); }
});

test('history respects per-pane and global UTF-8 byte limits', async () => {
  const observation = createTerminalObservation({ maxHistoryBytes: 24, globalHistoryBytes: 30 });
  try {
    for (const id of ['a', 'b']) {
      await observation.ingest({ type: 'created', id, generation: 'g' });
      await observation.ingest({ type: 'data', id, generation: 'g', data: '世界世界世界世界世界世界世界世界世界' });
    }
    const a = await observation.read({ id: 'a' }), b = await observation.read({ id: 'b' });
    assert(a.historyBytes <= 24 && b.historyBytes <= 24);
    assert(a.historyBytes + b.historyBytes <= 30);
    assert(a.truncated && b.truncated);
    assert(!JSON.stringify(b.history).includes('�'));
  } finally { observation.dispose(); }
});

test('forget during a pending parser write resolves outstanding readers', { timeout: 2000 }, async () => {
  const observation = createTerminalObservation();
  await observation.ingest({ type: 'created', id: 'p', generation: 'g' });
  const writing = observation.ingest({ type: 'data', id: 'p', generation: 'g', data: 'pending' });
  await Promise.resolve();
  const reading = observation.read({ id: 'p' });
  observation.forget('p');
  await writing;
  assert.equal((await reading).status, 'stale-generation');
  observation.dispose();
});

test('PTY action channel rejects stale and unproven recipients and reports write errors', () => {
  const events = [], terminals = [];
  const context = vm.createContext({ require: name => name === 'node-pty' ? { spawn() {
    const terminal = { writes: [], pid: 42, onData(fn) { this.data = fn; }, onExit() {}, resize() {}, kill() { this.killed = true; }, write(data) { if (data === 'FAIL') throw new Error('fixture failure'); this.writes.push(data); } };
    terminals.push(terminal); return terminal;
  } } : name === 'readline' ? { createInterface: () => ({ on() {} }) } : require(name), process: { platform: 'win32', env: {}, stdin: {}, cwd: () => process.cwd(), stdout: { write: line => events.push(JSON.parse(line)) }, kill(pid) { if (pid === 99) throw new Error('dead'); } }, setTimeout() {} });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../backend/ptyHost.cjs'), 'utf8'), context);
  context.handleMessage({ type: 'create', payload: { id: 'p', generation: 'g', launchToken: 1 } });
  let actionSequence = 0;
  const action = payload => { context.handleMessage({ type: 'action', payload: { id: 'p', generation: 'g', actionId: `a${++actionSequence}`, kind: 'input', data: 'hello', ...payload } }); return events.at(-1); };
  assert.equal(action({ generation: undefined }).status, 'invalid-action');
  assert.equal(action({ generation: 'old' }).status, 'stale-generation');
  assert.equal(action({ expectedAgentPid: 99 }).status, 'recipient-unavailable');
  assert.equal(action({ expectedAgentPid: 42 }).status, 'input-surface-unverified');
  const evidence = { generation: 'g', pid: 42, state: 'idle', observedAt: Date.now() };
  for (const change of [{ pid: 41 }, { generation: 'old' }, { state: 'busy' }, { observedAt: Date.now() - 6000 }, { observedAt: Date.now() + 10000 }]) {
    assert.equal(action({ expectedAgentPid: 42, recipientEvidence: { ...evidence, ...change } }).status, 'input-surface-unverified');
  }
  assert.equal(action({ expectedAgentPid: 99, recipientEvidence: { ...evidence, pid: 99 } }).status, 'recipient-unavailable');
  assert.equal(terminals[0].writes.length, 0);
  assert.equal(action({ expectedAgentPid: 42, recipientEvidence: evidence }).delivery, 'pty-transport-only');
  assert.equal(action({ kind: 'interrupt' }).status, 'written');
  assert.deepEqual(terminals[0].writes, ['hello', '\x03']);
  assert.equal(action({ data: 'FAIL' }).ok, false);
  assert.equal(action({ kind: 'kill' }).status, 'kill-requested');
  assert.equal(action({}).ok, false);
});
