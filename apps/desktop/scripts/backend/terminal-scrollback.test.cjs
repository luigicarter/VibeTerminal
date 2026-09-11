const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Terminal } = require('@xterm/headless');
const { createTerminalHistory } = require('../../backend/terminalHistory.cjs');

for (const [name, start, end] of [['OSC BEL', '\x1b]2;', '\x07'], ['OSC ST', '\x1b]2;', '\x1b\\'], ['DCS', '\x1bP0z', '\x1b\\']]) {
  test(`oversized unfinished ${name} replay stays bounded and consumes the remaining payload`, async () => {
    const history = createTerminalHistory(40, 8);
    const snapshot = () => new Promise(resolve => history.snapshot(resolve));
    let restored;
    try {
      history.write('before\r\n' + start + '世界'.repeat(50000));
      if (end.startsWith('\x1b')) history.write('\x1b');
      const partial = await snapshot();
      assert.equal(partial.incompleteSequenceTruncated, true);
      assert(Buffer.byteLength(partial.data) < 1024);
      restored = await replay(partial);
      const suffix = end.startsWith('\x1b') ? '\\' : 'hidden suffix' + end;
      history.write(suffix + 'after');
      await new Promise(resolve => restored.write(suffix + 'after', resolve));
      assert.equal(lines(restored).filter(Boolean).join('\n'), 'before\nafter');
      assert.equal((await snapshot()).incompleteSequenceTruncated, undefined);
    } finally { restored?.dispose(); history.dispose(); }
  });
}

function host() {
  const filename = path.resolve(__dirname, '../../backend/ptyHost.cjs');
  const realRequire = createRequire(filename), events = [], terminals = [];
  const context = vm.createContext({
    require: name => name === 'node-pty' ? { spawn() {
      const terminal = { pid: 42, onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; }, resize() {}, kill() {}, write() {} };
      terminals.push(terminal); return terminal;
    } } : name === 'readline' ? { createInterface: () => ({ on() {} }) } : realRequire(name),
    process: { platform: 'win32', env: {}, stdin: {}, cwd: () => process.cwd(), stdout: { write: line => events.push(JSON.parse(line)) } },
    setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const scope = { id: 'scroll', generation: 'g1', launchToken: 1, cols: 100, rows: 20 };
  const send = (type, payload = {}) => context.handleMessage({ type, payload: { ...scope, ...payload } });
  send('create');
  return { scope, events, terminals, send, data: data => terminals.at(-1).data(data),
    async snapshot(payload) {
      const start = events.length; send('attach', payload);
      const deadline = Date.now() + 5000;
      while (!events.slice(start).some(e => e.type === 'snapshot')) {
        assert(Date.now() < deadline, 'snapshot completes');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return events.slice(start).find(e => e.type === 'snapshot');
    }, dispose() { send('kill'); } };
}
async function replay(snapshot) {
  const terminal = new Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 5000, allowProposedApi: true });
  await new Promise(resolve => terminal.write(snapshot.data, resolve));
  return terminal;
}
const lines = terminal => Array.from({ length: terminal.buffer.normal.length }, (_, i) => terminal.buffer.normal.getLine(i).translateToString(true));

test('redraw traffic cannot evict readable scrollback on attachment', async () => {
  const h = host(); let restored;
  try {
    h.data(Array.from({ length: 200 }, (_, i) => `history-${i}\r\n`).join(''));
    h.data(('\x1b[H\x1b[2Kworking ' + 'x'.repeat(80)).repeat(6000));
    restored = await replay(await h.snapshot());
    assert(lines(restored).includes('history-0'), 'redraw bytes must not replace the saved history');
    assert(restored.buffer.normal.baseY >= 180);
  } finally { restored?.dispose(); h.dispose(); }
});

test('a full buffer keeps the newest 5000 scrollback rows after attachment', async () => {
  const h = host(); let restored;
  try {
    h.data(Array.from({ length: 6500 }, (_, i) => `${String(i).padStart(5, '0')} ${'x'.repeat(80)}\r\n`).join(''));
    restored = await replay(await h.snapshot());
    assert.equal(restored.buffer.normal.baseY, 5000);
    assert(lines(restored)[0].startsWith('01481 '));
    assert(lines(restored).some(line => line.startsWith('06499 ')));
  } finally { restored?.dispose(); h.dispose(); }
});

test('snapshots stay ahead of later output, resizes and exit', async () => {
  const h = host(); let restored;
  try {
    h.data('before\r\n'.repeat(100));
    const pending = h.snapshot();
    h.data('after\r\n');
    h.send('resize', { cols: 120, rows: 30 });
    h.terminals[0].exit({ exitCode: 0 });
    const snapshot = await pending;
    const at = h.events.indexOf(snapshot);
    assert(h.events.findIndex(e => e.type === 'data' && e.data === 'after\r\n') > at);
    assert(h.events.findIndex(e => e.type === 'resize') > at);
    assert(h.events.findIndex(e => e.type === 'exit') > at);
    assert.equal(snapshot.cols, 100);
    assert.equal(snapshot.sequence, 1);
    restored = await replay(snapshot);
    assert(!lines(restored).includes('after'));
  } finally { restored?.dispose(); h.dispose(); }
});

test('application erase-saved-lines does not destroy the retained history', async () => {
  const h = host(); let restored;
  try {
    h.data('saved history\r\n'.repeat(100));
    h.data('\x1b[3'); h.data('J\x1b[2J\x1b[Hredrawn screen');
    restored = await replay(await h.snapshot());
    assert.equal(restored.buffer.normal.baseY, 81);
    assert.equal(lines(restored)[0], 'saved history');
    assert.equal(lines(restored)[81], 'redrawn screen');
  } finally { restored?.dispose(); h.dispose(); }
});

for (const [name, before, after] of [
  ['CSI', '\x1b[31', 'mRED\x1b[0m'],
  ['OSC', '\x1b]2;unfinished title', '\x07VISIBLE'],
  ['C1 OSC', '\x9d2;unfinished title', '\x07VISIBLE'],
  ['DCS', '\x1bP$q', 'm\x1b\\VISIBLE'],
  ['Unicode', 'emoji \ud83d', '\ude42 complete']
]) test(`attachment preserves a split ${name} sequence`, async () => {
  const h = host(); let restored;
  const expected = new Terminal({ cols: 100, rows: 20, scrollback: 5000, allowProposedApi: true });
  try {
    h.data('history\r\n'.repeat(50) + before);
    restored = await replay(await h.snapshot());
    await new Promise(resolve => restored.write(after, resolve));
    await new Promise(resolve => expected.write('history\r\n'.repeat(50) + before, resolve));
    await new Promise(resolve => expected.write(after, resolve));
    assert.deepEqual(lines(restored), lines(expected));
    if (name === 'CSI') assert.equal(restored.buffer.active.getLine(50).getCell(0).getFgColor(), 1);
  } finally { restored?.dispose(); expected.dispose(); h.dispose(); }
});

test('alternate-screen snapshots retain normal history, styles, cursor and input modes', async () => {
  const h = host(); let restored;
  try {
    h.data('normal history\r\n'.repeat(100));
    h.data('\x1b[?1049h\x1b[2;3H\x1b[32m界🙂 alternate\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?25l\x1b[6 q');
    const snapshot = await h.snapshot();
    restored = await replay(snapshot);
    assert.equal(restored.buffer.active.type, 'alternate');
    assert.equal(restored.buffer.normal.baseY, 81);
    assert.equal(lines(restored)[0], 'normal history');
    assert(restored.buffer.active.getLine(1).translateToString(true).includes('界🙂 alternate'));
    assert.equal(restored.buffer.active.getLine(1).getCell(2).getFgColor(), 2);
    assert.equal(restored.modes.applicationCursorKeysMode, true);
    assert.equal(restored.modes.bracketedPasteMode, true);
    assert.equal(restored.modes.mouseTrackingMode, 'vt200');
    assert(snapshot.data.includes('\x1b[?1006h'));
    assert(snapshot.data.includes('\x1b[?25l'));
    assert(snapshot.data.includes('\x1b[6 q'));
    await new Promise(resolve => restored.write('\x1b[?1049l', resolve));
    assert.equal(restored.buffer.active.type, 'normal');
    assert.equal(lines(restored)[0], 'normal history');
  } finally { restored?.dispose(); h.dispose(); }
});

test('resize reflows retained Unicode cells before a snapshot', async () => {
  const h = host(); let restored;
  const expected = new Terminal({ cols: 100, rows: 20, scrollback: 5000, allowProposedApi: true });
  try {
    const text = ('wrapped 界🙂 ' + 'x'.repeat(120) + '\r\n').repeat(100);
    h.data(text);
    h.send('resize', { cols: 50, rows: 30 });
    restored = await replay(await h.snapshot({ cols: 50, rows: 30 }));
    await new Promise(resolve => expected.write(text, resolve));
    expected.resize(50, 30);
    assert.deepEqual(lines(restored), lines(expected));
    assert.equal(restored.buffer.active.cursorX, expected.buffer.active.cursorX);
    assert.equal(restored.buffer.active.cursorY, expected.buffer.active.cursorY);
  } finally { restored?.dispose(); expected.dispose(); h.dispose(); }
});

test('closing or restarting during replay cannot publish an obsolete snapshot', async () => {
  const h = host();
  try {
    h.data('old history\r\n'.repeat(5000));
    h.send('attach');
    h.send('create', { generation: 'g2', launchToken: 2 });
    h.data('new generation');
    const snapshot = await h.snapshot({ generation: 'g2', launchToken: 2 });
    assert.equal(snapshot.generation, 'g2');
    assert(!h.events.some(e => e.type === 'snapshot' && e.generation === 'g1'));
    assert(!snapshot.data.includes('old history'));
    h.send('kill', { generation: 'g2', launchToken: 2 });
  } finally { h.dispose(); }
});

test('multiple pending attachments preserve each boundary and do not delay input acknowledgments', async () => {
  const h = host();
  try {
    h.data('first\r\n'.repeat(500));
    const first = h.snapshot();
    h.send('action', { kind: 'input', actionId: 'during-replay', data: 'draft' });
    assert.equal(h.events.at(-1).type, 'action-result');
    assert.equal(h.events.at(-1).status, 'written');
    h.data('between\r\n');
    const second = h.snapshot({ cols: 80, rows: 25 });
    h.data('last\r\n');
    await first;
    // snapshot() deliberately searches from the time of its own request; two
    // overlapping requests can see the same first reply. Drain through both.
    await second;
    const deadline = Date.now() + 5000;
    while (h.events.filter(e => e.type === 'snapshot').length < 2) {
      assert(Date.now() < deadline);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const snapshots = h.events.filter(e => e.type === 'snapshot');
    assert.equal(snapshots[0].sequence, 1);
    assert.equal(snapshots[1].sequence, 2);
    assert.equal(snapshots[1].cols, 80);
    const firstAt = h.events.indexOf(snapshots[0]), secondAt = h.events.indexOf(snapshots[1]);
    const betweenAt = h.events.findIndex(e => e.type === 'data' && e.data === 'between\r\n');
    const lastAt = h.events.findIndex(e => e.type === 'data' && e.data === 'last\r\n');
    assert(firstAt < betweenAt && betweenAt < secondAt && secondAt < lastAt);
  } finally { h.dispose(); }
});

test('restoring a scrolling region and origin mode preserves subsequent TUI output', async () => {
  const h = host(); let restored;
  const expected = new Terminal({ cols: 100, rows: 20, scrollback: 5000, allowProposedApi: true });
  try {
    const text = 'history\r\n'.repeat(100) + '\x1b[3;15r\x1b[?6h\x1b[5;6Hregional content';
    h.data(text);
    restored = await replay(await h.snapshot());
    await new Promise(resolve => expected.write(text, resolve));
    assert.equal(restored.buffer.active.cursorX, expected.buffer.active.cursorX);
    assert.equal(restored.buffer.active.cursorY, expected.buffer.active.cursorY);
    const tail = 'more regional output\r\n'.repeat(30);
    await new Promise(resolve => restored.write(tail, resolve));
    await new Promise(resolve => expected.write(tail, resolve));
    assert.deepEqual(lines(restored), lines(expected));
  } finally { restored?.dispose(); expected.dispose(); h.dispose(); }
});
