'use strict';
// Unit coverage for the read-only mobile bridge: the settings store, the pure
// state assembly, and every route of API contract v1 against injected fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');

const { createMobileBridgeSettings, generateCode, canonicalCode, formatCode, ALPHABET, MAX_DEVICES } = require('../../backend/mobileBridgeSettings.cjs');
const { buildState, fingerprint, normalizeStatus, sessionTitle, snippetFrom, detectNeedsInput, needsAttention } = require('../../backend/mobileBridgeState.cjs');
const { createMobileBridge, lanAddresses, MAX_STREAMS, STREAM_PROTOCOL, SCROLLBACK_LINES } = require('../../backend/mobileBridge.cjs');
const { serializeRow, hashRow, renderScreen, renderScrollback, diffRows, createFramePump,
  FRAME_INTERVAL_MS } = require('../../backend/mobileBridgeFrames.cjs');
const { createTerminalObservation } = require('../../backend/terminalObservation.cjs');
const { Terminal } = require('@xterm/headless');

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lina-mobile-bridge-'));
const CODE = 'ABCD-EFGH-JKMN-PQRS';

// ------------------------------------------------------------------ store ---

test('pairing codes use unambiguous Crockford characters in four groups of four', () => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const code = generateCode();
    assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    for (const character of code.replace(/-/g, '')) assert(ALPHABET.includes(character), `${character} is ambiguous`);
    assert(!/[01OILU]/.test(code));
  }
  assert.equal(canonicalCode('abcd efgh-jkmn pqrs'), 'ABCDEFGHJKMNPQRS');
  assert.equal(canonicalCode('too-short'), '');
  assert.equal(formatCode('ABCDEFGHJKMNPQRS'), CODE);
});

test('settings persist at 0600 through an atomic rename and survive a reload', async () => {
  const directory = temporary();
  const store = createMobileBridgeSettings({ userDataPath: directory, env: {} });
  const initial = store.get();
  assert.equal(initial.enabled, false);
  assert.equal(initial.port, 47831);
  assert.equal(initial.host, '0.0.0.0');
  await store.setEnabled(true);
  const file = path.join(directory, 'mobile-bridge.json');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.enabled, true);
  assert.equal(written.code, initial.code);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), ['mobile-bridge.json'], 'no temporary file is left behind');

  const reloaded = createMobileBridgeSettings({ userDataPath: directory, env: {} });
  assert.equal(reloaded.get().enabled, true);
  assert.equal(reloaded.get().code, initial.code);
  const rotated = await reloaded.regenerateCode();
  assert.notEqual(rotated.code, initial.code);
  assert.equal(createMobileBridgeSettings({ userDataPath: directory, env: {} }).get().code, rotated.code);
});

test('environment overrides win for fixtures without reaching disk', async () => {
  const directory = temporary();
  const env = { LINA_MOBILE_BRIDGE_ENABLED: '1', LINA_MOBILE_BRIDGE_PORT: '47999', LINA_MOBILE_BRIDGE_CODE: CODE, LINA_MOBILE_BRIDGE_HOST: '127.0.0.1' };
  const store = createMobileBridgeSettings({ userDataPath: directory, env });
  const state = store.get();
  assert.deepEqual({ enabled: state.enabled, port: state.port, code: state.code, host: state.host },
    { enabled: true, port: 47999, code: CODE, host: '127.0.0.1' });
  assert.deepEqual(state.overridden.sort(), ['code', 'enabled', 'host', 'port']);
  await store.setEnabled(false);
  assert.equal(store.stored().enabled, false, 'the stored preference is the real one');
  assert.equal(store.get().enabled, true, 'the override still governs this run');
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(directory, 'mobile-bridge.json'), 'utf8')).code, CODE);
});

// ------------------------------------------------------------------ state ---

test('status normalization maps every documented provider string', () => {
  for (const [raw, expected] of [['running', 'working'], ['interrupt requested', 'working'], ['waiting', 'waiting'],
    ['needs input', 'waiting'], ['done', 'done'], ['completed', 'done'], ['failed', 'failed'], ['exited', 'exited'],
    ['interrupted', 'exited'], ['starting', 'starting'], ['awaiting activity', 'starting'], ['idle', 'idle'],
    ['paused', 'idle'], ['', 'idle'], [undefined, 'idle'], ['RUNNING', 'working']]) {
    assert.equal(normalizeStatus(raw), expected, `${raw} -> ${expected}`);
  }
});

test('titles prefer the conversation name and fall back to a readable kind', () => {
  assert.equal(sessionTitle({ conversationTitle: 'Ship it', terminalTitle: 'pwsh', name: 'n', kind: 'codex' }), 'Ship it');
  assert.equal(sessionTitle({ conversation: { title: 'Nested' }, terminalTitle: 'pwsh', kind: 'codex' }), 'Nested');
  assert.equal(sessionTitle({ terminalTitle: 'pwsh', name: 'n', kind: 'codex' }), 'pwsh');
  assert.equal(sessionTitle({ name: 'Pane 2', kind: 'codex' }), 'Pane 2');
  assert.equal(sessionTitle({ kind: 'open-codex' }), 'Open Codex');
  assert.equal(sessionTitle({ kind: 'terminal' }), 'Terminal');
  assert.equal(sessionTitle({}), 'Session');
  assert.equal(snippetFrom('first\nlast line   \n\n   \n'), 'last line');
  assert.equal(snippetFrom('x'.repeat(300)).length, 80, 'a phone-width line, not a screen-width one');
  assert.equal(snippetFrom(''), '');
});

test('state assembly counts per project, keeps raw labels and ignores clock drift', () => {
  const records = [
    // The attention shape a real directory record carries: the runtime's
    // object, not a boolean.
    { id: 'a', generation: 'g1', projectId: 'p1', kind: 'codex', provider: 'codex', status: 'running', cwd: 'C:/p1', conversationTitle: 'Fix login', lastActivityAt: 5,
      attention: { id: 'att-1', state: 'waiting', reason: 'approval', toolId: 'tool-1', updatedAt: 5 } },
    { id: 'b', generation: 'g2', projectId: 'p1', kind: 'terminal', provider: 'terminal', status: 'awaiting activity', cwd: 'C:/p1', terminalTitle: 'pwsh' },
    { id: 'c', generation: 'g3', projectId: 'p2', kind: 'fusion', provider: 'fusion', status: 'failed', cwd: 'C:/p2', name: 'Fusion' },
    { id: 'd', generation: 'g4', projectId: null, kind: 'claude', provider: 'claude', status: 'needs input', cwd: 'C:/loose' }
  ];
  const projects = [{ id: 'p1', name: 'One', path: 'C:/p1' }, { id: 'p2', name: 'Two', path: 'C:/p2' }];
  const orchestrator = { enabled: true, ready: true, activeTargets: ['a', 'c'], messages: [{ at: 1 }, { at: 9 }] };
  const state = buildState({ records, projects, orchestrator, screens: { a: 'boot\n$ npm test\n' }, now: 1234 });

  assert.equal(state.at, 1234);
  assert.deepEqual(state.projects.map(project => [project.id, project.counts]),
    [['p1', { working: 1, waiting: 0, done: 0, failed: 0 }], ['p2', { working: 0, waiting: 0, done: 0, failed: 1 }]]);
  assert.deepEqual(state.sessions.map(session => [session.id, session.status, session.statusLabel, session.isChat, session.projectName]), [
    ['a', 'working', 'running', false, 'One'],
    ['b', 'starting', 'awaiting activity', false, 'One'],
    // `failed` normalizes to itself, so the raw label is redundant and dropped.
    ['c', 'failed', undefined, true, 'Two'],
    ['d', 'waiting', 'needs input', false, '']
  ]);
  assert.equal('statusLabel' in state.sessions[2], false, 'a redundant label is absent, not empty');
  // A cwd that is simply the project's path is the phone's to infer.
  assert.deepEqual(state.sessions.map(session => session.cwd), [undefined, undefined, undefined, 'C:/loose']);
  assert.equal('cwd' in state.sessions[0], false);
  assert.equal(state.sessions[0].title, 'Fix login');
  assert.equal(state.sessions[0].snippet, '$ npm test');
  assert.equal(state.sessions[0].attention, true);
  assert.equal(state.sessions[1].attention, false);
  assert.deepEqual(state.orchestrator, { enabled: true, ready: true, activeCount: 2, lastMessageAt: 9 });

  // A finished turn is not something a person has to answer; `status` says that.
  const settled = buildState({ records: [{ ...records[0], attention: { id: 'att-1', state: 'completed', reason: 'response', updatedAt: 9 } }, ...records.slice(1)],
    projects, orchestrator, screens: {}, now: 1234 });
  assert.equal(settled.sessions[0].attention, false);

  const later = buildState({ records, projects, orchestrator, screens: { a: 'boot\n$ npm test\n' }, now: 999999 });
  assert.equal(fingerprint(state), fingerprint(later), 'the wall clock alone must not burn a long poll');
  const moved = buildState({ records: [{ ...records[0], status: 'completed' }, ...records.slice(1)], projects, orchestrator, screens: {}, now: 1234 });
  assert.notEqual(fingerprint(state), fingerprint(moved));
});

// ------------------------------------------------------------- needsInput ---
// Real prompt screens, byte for byte as the provider draws them, so a change in
// either parser or contract has to be argued against what is actually on screen.

const CLAUDE_EDIT_PROMPT = [
  '╭──────────────────────────────────────────────────────────╮',
  '│ Edit file                                                │',
  '│                                                          │',
  '│ src/server.ts                                            │',
  '│    42    const port = 3000;                              │',
  '│    43  + const host = "0.0.0.0";                         │',
  '│                                                          │',
  '│ Do you want to make this edit to server.ts?              │',
  '│ ❯ 1. Yes                                                 │',
  "│   2. Yes, and don't ask again this session               │",
  '│   3. No, tell Claude what to do differently (esc)        │',
  '╰──────────────────────────────────────────────────────────╯',
  ''
].join('\n');

const CODEX_APPROVAL_PROMPT = [
  '  Codex wants to run a command',
  '',
  '  $ npm run build',
  '',
  '  Allow this command?',
  '› 1. Yes, run it',
  '  2. Yes, and do not ask again this session',
  '  3. No, and tell Codex what to do instead',
  ''
].join('\n');

test('needsInput reads the menu a provider actually drew, or says nothing', () => {
  assert.deepEqual(detectNeedsInput(CLAUDE_EDIT_PROMPT), {
    kind: 'menu',
    prompt: 'Do you want to make this edit to server.ts?',
    options: [{ key: '1', label: 'Yes' }, { key: '2', label: "Yes, and don't ask again this session" },
      { key: '3', label: 'No, tell Claude what to do differently (esc)' }]
  });
  assert.deepEqual(detectNeedsInput(CODEX_APPROVAL_PROMPT), {
    kind: 'menu',
    prompt: 'Allow this command?',
    options: [{ key: '1', label: 'Yes, run it' }, { key: '2', label: 'Yes, and do not ask again this session' },
      { key: '3', label: 'No, and tell Codex what to do instead' }]
  });

  assert.deepEqual(detectNeedsInput('Delete build/ and continue? (y/N)'),
    { kind: 'yesno', prompt: 'Delete build/ and continue? (y/N)', options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }] });
  assert.deepEqual(detectNeedsInput('Overwrite readme.txt?  (yes/no)').kind, 'yesno');

  // Nothing on screen is being waited on.
  assert.equal(detectNeedsInput('PS C:\\work\\app> '), null);
  assert.equal(detectNeedsInput(''), null);
  assert.equal(detectNeedsInput(undefined), null);
  assert.equal(detectNeedsInput('1. only one option'), null, 'a single numbered line is not a menu');
  assert.equal(detectNeedsInput('1. one\n1. one again'), null, 'repeated keys are a listing, not choices');
  assert.equal(detectNeedsInput(Array.from({ length: 10 }, (_, index) => `${index}. item`).join('\n')), null,
    'ten consecutive numbered lines are a listing, not a menu');
  // A (y/n) that has scrolled off the last line is not what the pane is asking.
  assert.equal(detectNeedsInput('Continue? (y/n)\nyes\ndone.'), null);

  // Runtime approval evidence, for a screen this parser cannot read.
  assert.deepEqual(detectNeedsInput('⏵⏵ working…', { approvals: [{ id: 'a1', state: 'waiting', reason: 'approval' }] }),
    { kind: 'approval', prompt: '⏵⏵ working…', options: [] });
  assert.deepEqual(detectNeedsInput('', { attention: { state: 'waiting', reason: 'approval' } }),
    { kind: 'approval', prompt: 'Waiting for approval', options: [] });
  assert.equal(detectNeedsInput('idle', { attention: { state: 'completed', reason: 'approval' } }), null);
  // A drawn menu outranks the runtime's bare approval flag: it has the chips.
  assert.equal(detectNeedsInput(CLAUDE_EDIT_PROMPT, { approvals: [{ id: 'a1', state: 'waiting', reason: 'approval' }] }).kind, 'menu');
});

test('needsInput rides the state shape and moves the revision', () => {
  const records = [{ id: 'a', generation: 'g', projectId: 'p1', kind: 'claude', provider: 'claude', status: 'waiting', cwd: 'C:/p1' }];
  const projects = [{ id: 'p1', name: 'One', path: 'C:/p1' }];
  const idle = buildState({ records, projects, screens: { a: 'PS C:\\p1> ' }, now: 1 });
  assert.equal(idle.sessions[0].needsInput, null);
  const asking = buildState({ records, projects, screens: { a: CLAUDE_EDIT_PROMPT }, now: 1 });
  assert.equal(asking.sessions[0].needsInput.kind, 'menu');
  assert.equal(asking.sessions[0].needsInput.options.length, 3);
  assert.notEqual(fingerprint(idle), fingerprint(asking), 'a phone must repaint when a pane starts asking');
});

// --------------------------------------------------------- frame protocol ---
// Row serialization, hashing and the frame cap, against a real headless
// terminal rather than a hand-built buffer: what a phone draws has to be what
// this exact xterm build decoded.

const headless = (cols, rows, data, options = {}) => new Promise(resolve => {
  const terminal = new Terminal({ cols, rows, scrollback: options.scrollback ?? 300, allowProposedApi: true });
  terminal.write(data, () => resolve(terminal));
});

test('a row serializes to self-contained ANSI: attributes, wide glyphs, trimmed tail', async () => {
  const terminal = await headless(30, 4, '\x1b[1;31mred\x1b[0m plain\r\n\x1b[48;5;22mbg\x1b[0m\r\n\x1b[38;2;10;20;30mrgb\x1b[0m\r\nwide:漢X');
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  const row = index => serializeRow(buffer.getLine(index), terminal.cols, cell);

  assert.equal(row(0), '\x1b[1;31mred\x1b[0m plain\x1b[0m', 'bold + palette fg, then a reset back to default');
  assert.equal(row(1), '\x1b[48;5;22mbg\x1b[0m', '256-colour background');
  assert.equal(row(2), '\x1b[38;2;10;20;30mrgb\x1b[0m', 'truecolour foreground');
  // A wide character occupies two cells; only the first carries the glyph.
  assert.equal(row(3), 'wide:漢X\x1b[0m');
  assert.equal((row(3).match(/漢/g) || []).length, 1, 'a wide glyph is emitted once');
  // Trailing blanks are never shipped: the phone clears the rest of the line.
  assert(!/ +\x1b\[0m$/.test(row(0)), `trailing blanks survived: ${JSON.stringify(row(0))}`);
  assert.equal(serializeRow(buffer.getLine(20), terminal.cols, cell), '\x1b[0m', 'an absent line is an empty, reset row');
  for (const value of [row(0), row(1), row(2), row(3)]) assert(value.endsWith('\x1b[0m'), `${JSON.stringify(value)} must end reset`);
  terminal.dispose();
});

test('rows are hashed so an unchanged row never ships', async () => {
  const terminal = await headless(20, 3, 'alpha\r\nbeta\r\n');
  const first = renderScreen(terminal, { cursorVisible: true });
  assert.deepEqual(first.lines.map(line => line.replace(/\x1b\[0m/g, '')), ['alpha', 'beta', '']);
  assert.equal(first.hashes.length, 3);
  assert.equal(hashRow('alpha\x1b[0m'), hashRow('alpha\x1b[0m'));
  assert.notEqual(hashRow('alpha\x1b[0m'), hashRow('\x1b[31malpha\x1b[0m'), 'attributes are part of the hash');

  await new Promise(resolve => terminal.write('\x1b[2;1Hbeta!', resolve));
  const second = renderScreen(terminal, { cursorVisible: true });
  const changed = diffRows(first.hashes, second);
  assert.deepEqual(changed.map(entry => entry[0]), [1], 'only the row that changed');
  assert.equal(changed[0][1], 'beta!\x1b[0m');
  assert.deepEqual(diffRows(second.hashes, second), [], 'a settled screen ships nothing');
  // No prior table, or a different geometry, means the whole screen.
  assert.equal(diffRows(null, second).length, 3);
  assert.equal(diffRows([1, 2], second).length, 3);
  terminal.dispose();
});

test('scrollback is bounded to the lines above the viewport', async () => {
  const terminal = await headless(20, 4, Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\r\n') + '\r\n');
  const lines = renderScrollback(terminal, 10);
  assert.equal(lines.length, 10, 'never more than asked for');
  // Forty lines plus the blank one the cursor sits on: the viewport holds the
  // last four, so line 36 is the newest thing above it.
  assert.equal(lines.at(-1), 'line 36\x1b[0m', 'the newest scrollback line sits just above the viewport');
  assert(renderScrollback(terminal, SCROLLBACK_LINES).length <= SCROLLBACK_LINES);
  const short = await headless(20, 4, 'one\r\n');
  assert.deepEqual(renderScrollback(short, 300), [], 'nothing above the viewport is an empty list');
  terminal.dispose(); short.dispose();
});

test('the rows a phone is sent redraw the pane exactly, screen then diff', async () => {
  // A screen with everything the row format has to survive: palette and
  // truecolour runs, stacked attributes, a painted blank, a wide glyph and a
  // box rule.
  const painted = '\x1b[1;33mheader\x1b[0m \x1b[4;36munder\x1b[0m\r\n'
    + '\x1b[41m   \x1b[0m\x1b[38;2;200;30;90mrgb\x1b[7minv\x1b[0m tail\r\n'
    + '┌──┐ 漢字 ok\r\n\x1b[2;3;9mdim italic struck\x1b[0m';
  const source = await headless(30, 6, painted);
  const rendered = renderScreen(source, { cursorVisible: true });

  // Exactly what mobileBridgeTerminalPage.cjs writes for a `screen` event.
  const draw = rows => '\x1b[?25l' + rows.map(([index, row]) => `\x1b[${index + 1};1H${row}\x1b[K`).join('')
    + `\x1b[${rendered.cursor.y + 1};${rendered.cursor.x + 1}H`;
  const phone = new Terminal({ cols: 30, rows: 6, scrollback: 10, allowProposedApi: true });
  await new Promise(resolve => phone.write(draw(rendered.lines.map((row, index) => [index, row])), resolve));

  const text = (terminal, y, top = 0) => terminal.buffer.active.getLine(top + y)?.translateToString(true) ?? '';
  for (let y = 0; y < 6; y++) {
    assert.equal(text(phone, y), text(source, y, source.buffer.active.viewportY), `row ${y} text`);
  }
  // Re-serializing the phone's own screen must produce the identical rows,
  // which is the attributes surviving the round trip, not just the glyphs.
  assert.deepEqual(renderScreen(phone, { cursorVisible: true }).lines, rendered.lines);
  assert.deepEqual([phone.buffer.active.cursorX, phone.buffer.active.cursorY], [rendered.cursor.x, rendered.cursor.y]);

  // And a diff applied on top lands on the same screen as a full redraw.
  await new Promise(resolve => source.write('\x1b[2;1H\x1b[45mrepainted row\x1b[0m', resolve));
  const next = renderScreen(source, { cursorVisible: true });
  const changed = diffRows(rendered.hashes, next);
  assert.deepEqual(changed.map(entry => entry[0]), [1], 'one row moved');
  await new Promise(resolve => phone.write(draw(changed), resolve));
  assert.deepEqual(renderScreen(phone, { cursorVisible: true }).lines, next.lines, 'the diff is enough');
  source.dispose(); phone.dispose();
});

test('the frame pump coalesces to twelve frames a second on a fake clock', () => {
  let clock = 1000;
  const timers = [];
  const pump = createFramePump({ now: () => clock,
    setTimer: (fn, ms) => { const timer = { at: clock + ms, fn }; timers.push(timer); return timer; },
    clearTimer: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); } });
  const advance = ms => { clock += ms; for (const timer of [...timers]) if (timer.at <= clock) { timers.splice(timers.indexOf(timer), 1); timer.fn(); } };

  let frames = 0;
  const ask = () => pump.request('a', () => { frames++; });
  ask();
  assert.equal(frames, 1, 'the first repaint goes out at once');
  // A pane repainting every 5 ms for a second must not become 200 frames.
  for (let tick = 0; tick < 200; tick++) { advance(5); ask(); }
  assert.equal(clock - 1000, 1000, 'one simulated second');
  assert(frames <= 12, `at most twelve frames a second, got ${frames}`);
  assert(frames >= 11, `and it did keep up, got ${frames}`);
  assert.equal(FRAME_INTERVAL_MS, 84);

  // Only one frame is ever in flight per pane, and forget drops the schedule.
  ask(); ask(); ask();
  assert.equal(pump.pendingCount(), 1);
  pump.forget('a');
  assert.equal(pump.pendingCount(), 0);
  const after = frames;
  advance(1000);
  assert.equal(frames, after, 'a forgotten pane emits nothing');
});

test('attention reads the runtime object, not a boolean that is never set', () => {
  // The shapes terminalRuntime actually publishes: the head of the approval
  // ledger, and the latest agent-attention event.
  assert.equal(needsAttention({ id: 'a1', state: 'waiting', reason: 'approval', identity: 'native-tool-attempt', updatedAt: 7 }), true);
  assert.equal(needsAttention({ id: 'a2', state: 'waiting', reason: 'question', toolId: 't1', updatedAt: 7 }), true);
  assert.equal(needsAttention({ id: 'a3', state: 'completed', reason: 'response', updatedAt: 7 }), false);
  assert.equal(needsAttention({ id: 'a4', state: 'failed', reason: 'error', updatedAt: 7 }), false);
  assert.equal(needsAttention(undefined), false);
  assert.equal(needsAttention(null), false);
  assert.equal(needsAttention({}), false);
  assert.equal(needsAttention(true), true, 'a legacy boolean record still reads');
  assert.equal(needsAttention(false), false);

  // End to end through the published shape, and it must move the revision.
  const record = { id: 'a', generation: 'g', projectId: 'p1', kind: 'claude', provider: 'claude', status: 'waiting', cwd: 'C:/p1' };
  const projects = [{ id: 'p1', name: 'One', path: 'C:/p1' }];
  const quiet = buildState({ records: [record], projects, now: 1 });
  const waiting = buildState({ records: [{ ...record, attention: { id: 'a1', state: 'waiting', reason: 'approval', updatedAt: 7 } }], projects, now: 1 });
  assert.equal(quiet.sessions[0].attention, false);
  assert.equal(waiting.sessions[0].attention, true);
  assert.notEqual(fingerprint(quiet), fingerprint(waiting));
});

test('LAN addresses drop loopback, IPv6 and link-local candidates', () => {
  assert.deepEqual(lanAddresses({
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    eth: [{ family: 'IPv4', address: '192.168.1.20', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    apipa: [{ family: 'IPv4', address: '169.254.7.7', internal: false }],
    dup: [{ family: 4, address: '192.168.1.20', internal: false }]
  }), ['192.168.1.20']);
});

// ----------------------------------------------------------------- server ---

function fakeDirectory(records, projects, chat) {
  return {
    list: () => records,
    projects: () => projects,
    projectPaths: () => projects.map(project => project.path),
    readChat: target => {
      const entry = chat?.[target.id];
      if (!entry) throw new Error('This session has changed. Select it again.');
      return entry;
    }
  };
}
async function harness(overrides = {}) {
  const { env: envExtra, ...rest } = overrides;
  const directory = temporary();
  const settings = createMobileBridgeSettings({ userDataPath: directory,
    env: { LINA_MOBILE_BRIDGE_ENABLED: '1', LINA_MOBILE_BRIDGE_PORT: '0', LINA_MOBILE_BRIDGE_HOST: '127.0.0.1', LINA_MOBILE_BRIDGE_CODE: CODE, ...envExtra } });
  // The bridge's own decoder keeps scrollback, because the frame protocol
  // ships the lines above the viewport when a phone attaches.
  const observation = createTerminalObservation({ scrollback: SCROLLBACK_LINES });
  const pairEvents = [];
  const bridge = createMobileBridge({ settings, observation, version: '9.9.9', hostname: () => 'test-host',
    networkInterfaces: () => ({ eth: [{ family: 'IPv4', address: '10.0.0.5', internal: false }] }),
    onPairRequest: event => pairEvents.push(event),
    log: () => {}, ...rest });
  const status = await bridge.start();
  assert.equal(status.listening, true, status.error);
  const base = `http://${status.host}:${status.port}`;
  const call = (route, init = {}) => fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${canonicalCode(CODE)}` }, ...init });
  const open = (route, init = {}) => fetch(`${base}${route}`, init);
  const pair = (body = { deviceName: "Ahmed's iPhone", platform: 'ios' }) =>
    open('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(response => response.json());
  return { bridge, settings, observation, status, base, call, open, pair, pairEvents, directory,
    async done() { await bridge.close(); try { observation.dispose(); } catch {} } };
}

test('hello reports the read-only build and requires the pairing code', async () => {
  const kit = await harness({ getDirectory: () => fakeDirectory([], []) });
  try {
    const hello = await kit.call('/api/hello');
    assert.equal(hello.status, 200);
    assert.equal(hello.headers.get('x-lina-bridge'), '1');
    assert.equal(hello.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await hello.json(), { ok: true, app: 'lina-terminal', version: '9.9.9', host: 'test-host', bridge: 1, readOnly: true });

    for (const headers of [{}, { Authorization: 'Bearer WRONGCODEWRONGCO' }, { Authorization: 'Basic x' }, { Authorization: `Bearer ${canonicalCode(CODE).toLowerCase()}x` }]) {
      const refused = await fetch(`${kit.base}/api/hello`, { headers });
      assert.equal(refused.status, 401);
      assert.equal(refused.headers.get('x-lina-bridge'), '1');
      assert.deepEqual(await refused.json(), { ok: false, error: 'unauthorized' });
    }
    // The code is case- and separator-insensitive on the wire.
    assert.equal((await fetch(`${kit.base}/api/hello`, { headers: { Authorization: `Bearer ${CODE.toLowerCase()}` } })).status, 200);
  } finally { await kit.done(); }
});

test('ten failures from one address earn a 429 that also covers a correct code', async () => {
  const kit = await harness({ getDirectory: () => fakeDirectory([], []) });
  try {
    for (let attempt = 1; attempt <= 9; attempt++) {
      assert.equal((await fetch(`${kit.base}/api/hello`, { headers: { Authorization: 'Bearer NOPENOPENOPENOPE' } })).status, 401, `attempt ${attempt}`);
    }
    assert.equal((await kit.call('/api/hello')).status, 200, 'still open before the limit');
    assert.equal((await fetch(`${kit.base}/api/hello`, { headers: { Authorization: 'Bearer NOPENOPENOPENOPE' } })).status, 401);
    const blocked = await kit.call('/api/hello');
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { ok: false, error: 'too many attempts' });
  } finally { await kit.done(); }
});

test('OPTIONS is answered without a code and every write verb is 404', async () => {
  const kit = await harness({ getDirectory: () => fakeDirectory([{ id: 'a', generation: 'g', kind: 'terminal', status: 'idle', cwd: 'C:/p' }], []) });
  try {
    const preflight = await fetch(`${kit.base}/api/state`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
    assert.equal(preflight.headers.get('x-lina-bridge'), '1');

    for (const route of ['/api/sessions/a/input', '/api/sessions/a/interrupt', '/api/orchestrator/request', '/api/state']) {
      const refused = await kit.call(route, { method: 'POST', body: '{"text":"rm -rf /"}', headers: { Authorization: `Bearer ${canonicalCode(CODE)}`, 'Content-Type': 'application/json' } });
      assert.equal(refused.status, 404, route);
      assert.deepEqual(await refused.json(), { ok: false, error: 'not found' });
    }
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      assert.equal((await kit.call('/api/state', { method })).status, 404, method);
    }
    assert.equal((await kit.call('/api/nope')).status, 404);
    assert.equal((await kit.call('/api/sessions/a/screen/extra')).status, 404);
  } finally { await kit.done(); }
});

test('state returns the phone view and long-polls until a terminal event or the deadline', async () => {
  const records = [{ id: 'a', generation: 'g', projectId: 'p1', kind: 'terminal', provider: 'terminal', status: 'running', cwd: 'C:/p1', terminalTitle: 'pwsh' }];
  let observation;
  const kit = await harness({
    getDirectory: () => fakeDirectory(records, [{ id: 'p1', name: 'One', path: 'C:/p1' }]),
    getOrchestratorState: () => ({ enabled: true, ready: false, activeTargets: [], messages: [{ at: 3 }], publicationRevision: 1 })
  });
  observation = kit.observation;
  try {
    await observation.ingest({ type: 'created', id: 'a', generation: 'g', cols: 40, rows: 6 });
    await observation.ingest({ type: 'data', id: 'a', generation: 'g', sequence: 1, data: 'hello world\r\n' });

    const first = await (await kit.call('/api/state')).json();
    assert.equal(first.ok, true);
    assert(Number.isInteger(first.revision) && first.revision > 0);
    assert.deepEqual(first.projects, [{ id: 'p1', name: 'One', path: 'C:/p1', counts: { working: 1, waiting: 0, done: 0, failed: 0 } }]);
    assert.equal(first.sessions.length, 1);
    assert.deepEqual([first.sessions[0].id, first.sessions[0].title, first.sessions[0].status, first.sessions[0].statusLabel, first.sessions[0].snippet],
      ['a', 'pwsh', 'working', 'running', 'hello world']);
    assert.deepEqual(first.orchestrator, { enabled: true, ready: false, activeCount: 0, lastMessageAt: 3 });

    // Unchanged workspace: the poll is held for its full deadline.
    const startedAt = Date.now();
    const held = await (await kit.call(`/api/state?revision=${first.revision}&wait=400`)).json();
    assert(Date.now() - startedAt >= 350, 'held the poll');
    assert.equal(held.revision, first.revision);

    // A pane writing wakes the waiter well before its deadline.
    const waiting = kit.call(`/api/state?revision=${first.revision}&wait=10000`);
    await new Promise(resolve => setTimeout(resolve, 250));
    const wokeAt = Date.now();
    await observation.ingest({ type: 'data', id: 'a', generation: 'g', sequence: 2, data: 'second line\r\n' });
    kit.bridge.ingest({ type: 'data', id: 'a', generation: 'g', sequence: 3, data: '' });
    const woken = await (await waiting).json();
    assert(Date.now() - wokeAt < 9000, 'woke on the change, not on the timeout');
    assert(woken.revision > first.revision);
    assert.equal(woken.sessions[0].snippet, 'second line');

    // A stale client revision is answered at once with the current state.
    const immediate = await (await kit.call('/api/state?revision=1&wait=10000')).json();
    assert.equal(immediate.revision, woken.revision);
  } finally { await kit.done(); }
});

test('screen serves ANSI-stripped text and 404s an unknown session', async () => {
  const records = [{ id: 'a', generation: 'g', kind: 'terminal', status: 'idle', cwd: 'C:/p' }];
  const kit = await harness({ getDirectory: () => fakeDirectory(records, []) });
  try {
    await kit.observation.ingest({ type: 'created', id: 'a', generation: 'g', cols: 40, rows: 4 });
    await kit.observation.ingest({ type: 'data', id: 'a', generation: 'g', sequence: 1, outputAt: 4242, data: '\x1b[31mred\x1b[0m\r\nplain' });
    const screen = await (await kit.call('/api/sessions/a/screen')).json();
    assert.equal(screen.ok, true);
    assert.equal(screen.text, 'red\nplain');
    assert(!screen.text.includes('\x1b'));
    assert.equal(screen.exited, false);
    assert.equal(screen.updatedAt, 4242);
    assert.equal((await (await kit.call('/api/sessions/a/screen?maxChars=4')).json()).text, 'lain');

    await kit.observation.ingest({ type: 'exit', id: 'a', generation: 'g' });
    assert.equal((await (await kit.call('/api/sessions/a/screen')).json()).exited, true);
    assert.equal((await kit.call('/api/sessions/missing/screen')).status, 404);
  } finally { await kit.done(); }
});

test('transcripts come from saved history, chat panes and nothing at all', async () => {
  const records = [
    { id: 'agent', generation: 'g', kind: 'codex', status: 'idle', cwd: 'C:/p', threadRef: { id: 'thread-1' } },
    { id: 'shell', generation: 'g', kind: 'terminal', status: 'idle', cwd: 'C:/p' },
    { id: 'chat', generation: 'g', kind: 'openfusion', status: 'idle', cwd: 'C:/p' },
    { id: 'gone', generation: 'g', kind: 'claude', status: 'idle', cwd: 'C:/p', threadRef: { id: 'absent' } },
    { id: 'broken', generation: 'g', kind: 'cursor', status: 'idle', cwd: 'C:/p', threadRef: { id: 'thread-1' } },
    { id: 'orphan', generation: 'g', kind: 'gemini', status: 'idle', cwd: 'C:/p' },
    { id: 'stale-chat', generation: 'g', kind: 'fusion', status: 'idle', cwd: 'C:/p' }
  ];
  const history = {
    list: async ({ provider }) => {
      if (provider === 'cursor') throw new Error('store locked');
      return { conversations: provider === 'claude' ? [] : [{ id: 'thread-1', reference: 'ref-1' }] };
    },
    read: async ({ reference }) => reference === 'ref-1'
      ? { ok: true, status: 'found', messages: [{ role: 'user', text: 'do it' }, { role: 'assistant', text: 'done' }, { role: 'system', bad: true }] }
      : { ok: false, status: 'unavailable' },
    dispose() {}
  };
  const kit = await harness({ history, getDirectory: () => fakeDirectory(records, [], { chat: { text: 'planner output' } }) });
  try {
    assert.deepEqual(await (await kit.call('/api/sessions/agent/transcript')).json(),
      { ok: true, status: 'found', total: 2, nextBefore: null,
        messages: [{ role: 'user', text: 'do it' }, { role: 'assistant', text: 'done' }] });
    assert.deepEqual(await (await kit.call('/api/sessions/shell/transcript')).json(),
      { ok: true, status: 'unsupported', messages: [], total: 0, nextBefore: null });
    assert.deepEqual(await (await kit.call('/api/sessions/chat/transcript')).json(),
      { ok: true, status: 'found', total: 1, nextBefore: null, messages: [{ role: 'assistant', text: 'planner output' }] });
    for (const id of ['gone', 'broken', 'orphan', 'stale-chat']) {
      assert.deepEqual(await (await kit.call(`/api/sessions/${id}/transcript`)).json(),
        { ok: true, status: 'unavailable', messages: [], total: 0, nextBefore: null }, id);
    }
    assert.equal((await kit.call('/api/sessions/missing/transcript')).status, 404);
  } finally { await kit.done(); }
});

test('transcripts paginate newest-last so a phone never pulls a whole conversation', async () => {
  const records = [{ id: 'agent', generation: 'g', kind: 'codex', status: 'idle', cwd: 'C:/p', threadRef: { id: 'thread-1' } }];
  const messages = Array.from({ length: 130 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `m${index}` }));
  const history = { list: async () => ({ conversations: [{ id: 'thread-1', reference: 'ref-1' }] }),
    read: async () => ({ ok: true, status: 'found', messages }), dispose() {} };
  const kit = await harness({ history, getDirectory: () => fakeDirectory(records, []) });
  try {
    // No parameters: the last fifty, and the count of everything behind them.
    const tail = await (await kit.call('/api/sessions/agent/transcript')).json();
    assert.equal(tail.total, 130);
    assert.equal(tail.messages.length, 50);
    assert.deepEqual([tail.messages[0].text, tail.messages.at(-1).text], ['m80', 'm129']);
    assert.equal(tail.nextBefore, 80);

    const page = await (await kit.call(`/api/sessions/agent/transcript?before=${tail.nextBefore}&limit=30`)).json();
    assert.deepEqual([page.messages[0].text, page.messages.at(-1).text], ['m50', 'm79']);
    assert.equal(page.nextBefore, 50);

    // Walking off the front stops rather than wrapping.
    const first = await (await kit.call('/api/sessions/agent/transcript?before=20&limit=50')).json();
    assert.deepEqual([first.messages[0].text, first.messages.length, first.nextBefore], ['m0', 20, null]);
    assert.deepEqual((await (await kit.call('/api/sessions/agent/transcript?before=0')).json()).messages, []);
    // The cap is the server's, not the caller's.
    assert.equal((await (await kit.call('/api/sessions/agent/transcript?limit=99999')).json()).messages.length, 130);
  } finally { await kit.done(); }
});

test('orchestrator history returns the newest messages in order with its tasks', async () => {
  const messages = Array.from({ length: 5 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? 'assistant' : 'user',
    text: `message ${index}`, at: index, requestId: 'r1', taskId: 't1', status: 'sent', targetId: 'a', secret: 'never' }));
  const kit = await harness({
    getDirectory: () => fakeDirectory([], []),
    getOrchestratorState: () => ({ enabled: true, ready: true, messages, publicationRevision: 2,
      tasks: [{ id: 't1', requestId: 'r1', text: 'run tests', status: 'finished', terminalId: 'a', projectId: 'p1',
        cwd: 'C:/p1', createdAt: 1, updatedAt: 2, result: 'green', error: null, summary: 'ok', internal: 'never' }] })
  });
  try {
    const all = await (await kit.call('/api/orchestrator/history')).json();
    assert.equal(all.ok, true);
    assert.deepEqual([all.enabled, all.ready], [true, true]);
    assert.deepEqual(all.messages.map(message => message.id), ['m0', 'm1', 'm2', 'm3', 'm4']);
    assert.deepEqual(Object.keys(all.messages[0]).sort(), ['at', 'id', 'requestId', 'role', 'status', 'targetId', 'taskId', 'text']);
    assert.deepEqual(Object.keys(all.tasks[0]).sort(),
      ['createdAt', 'cwd', 'error', 'id', 'projectId', 'requestId', 'result', 'status', 'summary', 'terminalId', 'text', 'updatedAt']);

    const limited = await (await kit.call('/api/orchestrator/history?limit=2')).json();
    assert.deepEqual(limited.messages.map(message => message.id), ['m3', 'm4'], 'the last N, chronological');
  } finally { await kit.done(); }
});

test('a disabled bridge listens on nothing and a listen failure is reported, not thrown', async () => {
  const directory = temporary();
  const settings = createMobileBridgeSettings({ userDataPath: directory, env: {} });
  const bridge = createMobileBridge({ settings, observation: createTerminalObservation(), log: () => {} });
  try {
    const off = await bridge.start();
    assert.deepEqual([off.enabled, off.listening, off.error], [false, false, '']);
    assert.match(off.code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);

    const busy = createMobileBridgeSettings({ userDataPath: temporary(),
      env: { LINA_MOBILE_BRIDGE_ENABLED: '1', LINA_MOBILE_BRIDGE_HOST: '127.0.0.1', LINA_MOBILE_BRIDGE_PORT: '0', LINA_MOBILE_BRIDGE_CODE: CODE } });
    const first = createMobileBridge({ settings: busy, observation: createTerminalObservation(), log: () => {} });
    const listening = await first.start();
    const collide = createMobileBridgeSettings({ userDataPath: temporary(),
      env: { LINA_MOBILE_BRIDGE_ENABLED: '1', LINA_MOBILE_BRIDGE_HOST: '127.0.0.1', LINA_MOBILE_BRIDGE_PORT: String(listening.port), LINA_MOBILE_BRIDGE_CODE: CODE } });
    const second = createMobileBridge({ settings: collide, observation: createTerminalObservation(), log: () => {} });
    const failed = await second.start();
    assert.equal(failed.listening, false);
    assert.match(failed.error, /already in use/);
    await second.close();
    await first.close();
  } finally { await bridge.close(); }
});

test('terminal output is only observed while the bridge is enabled', async () => {
  const records = [{ id: 'a', generation: 'g', kind: 'terminal', status: 'idle', cwd: 'C:/p' }];
  const off = createMobileBridge({ settings: createMobileBridgeSettings({ userDataPath: temporary(), env: {} }),
    observation: createTerminalObservation(), getDirectory: () => fakeDirectory(records, []), log: () => {} });
  try {
    await off.start();
    off.ingest({ type: 'created', id: 'a', generation: 'g', cols: 20, rows: 3 });
    off.ingest({ type: 'data', id: 'a', generation: 'g', sequence: 1, data: 'secret' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const view = await off.state();
    assert.equal(view.sessions[0].snippet, '', 'a disabled bridge keeps no screen text');
  } finally { await off.close(); }

  const kit = await harness({ getDirectory: () => fakeDirectory(records, []) });
  try {
    kit.bridge.ingest({ type: 'created', id: 'a', generation: 'g', cols: 20, rows: 3 });
    kit.bridge.ingest({ type: 'data', id: 'a', generation: 'g', sequence: 1, data: 'live' });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await (await kit.call('/api/sessions/a/screen')).json()).text, 'live');
    kit.bridge.forget('a', 'g');
    assert.equal((await (await kit.call('/api/sessions/a/screen')).json()).text, '', 'a removed pane releases its decoder');
  } finally { await kit.done(); }
});

// ---------------------------------------------------------------- pairing ---

test('discover answers without a code and leaks no workspace data', async () => {
  const records = [{ id: 'secret-pane', generation: 'g', projectId: 'p1', kind: 'codex', status: 'running',
    cwd: 'C:/very/private/path', conversationTitle: 'Merger due diligence' }];
  const kit = await harness({ getDirectory: () => fakeDirectory(records, [{ id: 'p1', name: 'Secret', path: 'C:/very/private/path' }]) });
  try {
    const response = await kit.open('/api/discover');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-lina-bridge'), '1');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['app', 'bridge', 'desktopId', 'host', 'ok', 'readOnly', 'version']);
    assert.deepEqual([body.ok, body.app, body.host, body.version, body.bridge, body.readOnly],
      [true, 'lina-terminal', 'test-host', '9.9.9', 1, true]);
    assert.match(body.desktopId, /^[0-9a-f]{16}$/);
    const serialized = JSON.stringify(body);
    for (const leak of ['secret-pane', 'private', 'Merger', 'Secret', 'codex']) assert(!serialized.includes(leak), `discover leaked ${leak}`);
    // Stable across reads and persisted, so a phone recognises the same desktop.
    assert.equal((await (await kit.open('/api/discover')).json()).desktopId, body.desktopId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(kit.directory, 'mobile-bridge.json'), 'utf8')).desktopId, body.desktopId);
    assert.equal((await kit.open('/api/discover', { method: 'POST' })).status, 404);
  } finally { await kit.done(); }
});

test('a pair request is offered to the desktop, capped at three, and never self-approves', async () => {
  const kit = await harness({ getDirectory: () => fakeDirectory([], []) });
  try {
    const created = await kit.pair();
    assert.equal(created.ok, true);
    assert(created.requestId, 'a request id is issued');
    assert(created.expiresAt > Date.now() && created.expiresAt <= Date.now() + 121000, 'expires about two minutes out');
    assert.deepEqual(Object.keys(created).sort(), ['expiresAt', 'ok', 'requestId']);
    assert.equal(kit.pairEvents.length, 1, 'the desktop was told');
    assert.deepEqual([kit.pairEvents[0].requestId, kit.pairEvents[0].deviceName, kit.pairEvents[0].platform],
      [created.requestId, "Ahmed's iPhone", 'ios']);
    assert(kit.pairEvents[0].remoteAddress, 'the prompt can say where it came from');
    assert.equal(kit.bridge.getStatus().pending.length, 1);

    // Pending, and emphatically not carrying the code.
    const polled = await (await kit.open(`/api/pair/${created.requestId}`)).json();
    assert.deepEqual(polled, { ok: true, status: 'pending' });
    assert.equal(polled.code, undefined, 'a pending request must never carry the code');

    await kit.pair({ deviceName: 'Pixel', platform: 'android' });
    await kit.pair({ deviceName: 'Browser', platform: 'web' });
    const fourth = await kit.open('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceName: 'One too many', platform: 'ios' }) });
    assert.equal(fourth.status, 429);
    assert.deepEqual(await fourth.json(), { ok: false, error: 'too many pending requests' });
    assert.equal(kit.bridge.getStatus().pending.length, 3);

    const nameless = await kit.open('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'ios' }) });
    assert.equal(nameless.status, 400);
    const malformed = await kit.open('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
    assert.equal(malformed.status, 400);
    assert.equal((await kit.open('/api/pair')).status, 404, 'GET on the offer route is not a route');
    assert.equal((await kit.open('/api/pair/does-not-exist')).status, 404);
  } finally { await kit.done(); }
});

test('approval delivers the code exactly once and records the device; denial records nothing', async () => {
  const kit = await harness({ getDirectory: () => fakeDirectory([], []) });
  try {
    const created = await kit.pair();
    const waiting = kit.open(`/api/pair/${created.requestId}?wait=10000`).then(response => response.json());
    await new Promise(resolve => setTimeout(resolve, 200));
    const wokeAt = Date.now();
    await kit.bridge.respondPair(created.requestId, true);
    const approved = await waiting;
    assert(Date.now() - wokeAt < 9000, 'the poll woke on approval, not the deadline');
    assert.equal(approved.status, 'approved');
    assert.equal(canonicalCode(approved.code), canonicalCode(CODE));
    assert.match(approved.code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/, 'the code is delivered grouped');

    // Spent on delivery: the offer is gone, so a replayed id learns nothing.
    assert.equal((await kit.open(`/api/pair/${created.requestId}`)).status, 404);
    assert.equal(kit.bridge.getStatus().pending.length, 0);
    assert.deepEqual(kit.bridge.getStatus().devices.map(device => [device.deviceName, device.platform]), [["Ahmed's iPhone", 'ios']]);
    assert(Number.isFinite(kit.bridge.getStatus().devices[0].approvedAt));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(kit.directory, 'mobile-bridge.json'), 'utf8')).devices.map(d => d.deviceName), ["Ahmed's iPhone"]);
    // The delivered code is the real one.
    assert.equal((await fetch(`${kit.base}/api/hello`, { headers: { Authorization: `Bearer ${canonicalCode(approved.code)}` } })).status, 200);

    const denied = await kit.pair({ deviceName: 'Not mine', platform: 'android' });
    await kit.bridge.respondPair(denied.requestId, false);
    const refused = await (await kit.open(`/api/pair/${denied.requestId}?wait=5000`)).json();
    assert.deepEqual(refused, { ok: true, status: 'denied' });
    assert.deepEqual(kit.bridge.getStatus().devices.map(device => device.deviceName), ["Ahmed's iPhone"], 'a denial records nothing');
    assert.deepEqual(await kit.bridge.respondPair(denied.requestId, true), { ok: false, error: 'already denied' });
    assert.deepEqual(await kit.bridge.respondPair('nonsense', true), { ok: false, error: 'not found' });
  } finally { await kit.done(); }
});

test('an unanswered request expires rather than waiting forever', async () => {
  let clock = Date.now();
  const kit = await harness({ getDirectory: () => fakeDirectory([], []), now: () => clock });
  try {
    const created = await kit.pair();
    assert.equal((await (await kit.open(`/api/pair/${created.requestId}`)).json()).status, 'pending');
    clock += 121000;
    const expired = await (await kit.open(`/api/pair/${created.requestId}?wait=3000`)).json();
    assert.deepEqual(expired, { ok: true, status: 'expired' });
    assert.equal(expired.code, undefined);
    assert.equal(kit.bridge.getStatus().pending.length, 0, 'an expired offer frees its slot');
    assert.deepEqual(await kit.bridge.respondPair(created.requestId, true), { ok: false, error: 'already expired' });
    assert.deepEqual(kit.bridge.getStatus().devices, []);
  } finally { await kit.done(); }
});

test('the fixture auto-approve override pairs without a human and says so loudly', async () => {
  const logged = [];
  const kit = await harness({ getDirectory: () => fakeDirectory([], []), log: message => logged.push(message),
    env: { LINA_MOBILE_BRIDGE_AUTO_APPROVE: '1' } });
  try {
    assert.equal(kit.bridge.getStatus().autoApprove, true);
    const created = await kit.pair({ deviceName: 'Fixture', platform: 'web' });
    const approved = await (await kit.open(`/api/pair/${created.requestId}?wait=10000`)).json();
    assert.equal(approved.status, 'approved');
    assert.equal(canonicalCode(approved.code), canonicalCode(CODE));
    assert(logged.some(message => /AUTO_APPROVE/.test(message) && /FIXTURE USE ONLY/.test(message)), `no loud warning in ${JSON.stringify(logged)}`);
  } finally { await kit.done(); }
});

test('the public routes carry their own budget and do not spend the auth limiter', async () => {
  const kit = await harness({ getDirectory: () => fakeDirectory([], []) });
  try {
    for (let attempt = 1; attempt <= 30; attempt++) {
      assert.equal((await kit.open('/api/discover')).status, 200, `discover ${attempt}`);
    }
    const blocked = await kit.open('/api/discover');
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { ok: false, error: 'too many requests' });
    // A paired phone is unaffected: this is a separate budget from the auth one.
    assert.equal((await kit.call('/api/hello')).status, 200);
  } finally { await kit.done(); }
});

test('rotating the code clears the paired devices, because they are all signed out', async () => {
  const directory = temporary();
  const settings = createMobileBridgeSettings({ userDataPath: directory,
    env: { LINA_MOBILE_BRIDGE_ENABLED: '1', LINA_MOBILE_BRIDGE_HOST: '127.0.0.1', LINA_MOBILE_BRIDGE_PORT: '0' } });
  const bridge = createMobileBridge({ settings, observation: createTerminalObservation(),
    getDirectory: () => fakeDirectory([], []), log: () => {} });
  try {
    const status = await bridge.start();
    const created = await (await fetch(`http://127.0.0.1:${status.port}/api/pair`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceName: 'iPhone', platform: 'ios' }) })).json();
    await bridge.respondPair(created.requestId, true);
    const paired = await (await fetch(`http://127.0.0.1:${status.port}/api/pair/${created.requestId}`)).json();
    assert.equal(paired.status, 'approved');
    assert.equal(bridge.getStatus().devices.length, 1);

    const rotated = await bridge.regenerateCode();
    assert.deepEqual(rotated.devices, [], 'a rotated code leaves no phone listed as paired');
    assert.equal((await fetch(`http://127.0.0.1:${status.port}/api/hello`, { headers: { Authorization: `Bearer ${canonicalCode(paired.code)}` } })).status, 401);
    assert.equal(bridge.getStatus().desktopId, status.desktopId, 'the desktop identity survives a rotation');
  } finally { await bridge.close(); }
});

test('the device list is capped and a re-pair refreshes rather than duplicates', async () => {
  const store = createMobileBridgeSettings({ userDataPath: temporary(), env: {} });
  for (let index = 0; index < MAX_DEVICES + 5; index++) await store.rememberDevice({ deviceName: `Phone ${index}`, platform: 'ios' });
  assert.equal(store.devices().length, MAX_DEVICES);
  assert.equal(store.devices()[0].deviceName, `Phone 5`, 'the oldest pairings fall off');
  await store.rememberDevice({ deviceName: 'Phone 10', platform: 'ios', approvedAt: 999 });
  assert.equal(store.devices().filter(device => device.deviceName === 'Phone 10').length, 1, 're-pairing does not duplicate');
  assert.equal(store.devices().at(-1).deviceName, 'Phone 10', 're-pairing moves it to newest');
  await store.rememberDevice({ deviceName: '  ', platform: 'ios' });
  assert.equal(store.devices().length, MAX_DEVICES, 'a blank name records nothing');
  await store.rememberDevice({ deviceName: 'Bad\u0007Name'.padEnd(200, 'x'), platform: 'i/o s!' });
  assert.equal(store.devices().at(-1).deviceName.length, 64, 'names are bounded');
  assert(!/[\u0000-\u001f]/.test(store.devices().at(-1).deviceName), 'control characters are stripped');
  assert.equal(store.devices().at(-1).platform, 'ios', 'platforms are reduced to safe characters');
});

// ------------------------------------------------- streaming a terminal ---

// Reads a live text/event-stream into frames as they arrive, so ordering and
// keepalives can be asserted rather than inferred.
function collect(response, controller) {
  const state = { events: [], comments: 0, done: false, controller };
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (frame.startsWith(':')) { state.comments++; continue; }
        const type = /^event: (.+)$/m.exec(frame);
        const data = /^data: (.*)$/m.exec(frame);
        if (type) state.events.push({ type: type[1], data: data ? JSON.parse(data[1]) : null });
      }
    }
  })().catch(() => {}).finally(() => { state.done = true; });
  return state;
}
async function until(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}
// Row text without the reset every row ends in, so an assertion reads as the
// screen a person would see.
const plain = row => String(row).replace(/\x1b\[[0-9;]*m/g, '');
const rowsOf = event => (event.data.rows || []).map(([index, text]) => [index, plain(text)]);
const typeOf = (stream, type) => stream.events.filter(event => event.type === type);

test('the stream opens on a whole screen, then ships only the rows that changed', async () => {
  const records = [{ id: 'a', generation: 'g', kind: 'terminal', status: 'running', cwd: 'C:/p', cols: 120, rows: 40 }];
  const kit = await harness({ getDirectory: () => fakeDirectory(records, []), keepaliveMs: 120 });
  const open = [];
  try {
    kit.bridge.ingest({ type: 'created', id: 'a', generation: 'g', cols: 20, rows: 4 });
    kit.bridge.ingest({ type: 'data', id: 'a', generation: 'g', sequence: 1, data: 'first\r\n' });
    kit.bridge.ingest({ type: 'data', id: 'a', generation: 'g', sequence: 2, data: 'second\r\n' });
    await new Promise(resolve => setTimeout(resolve, 60));

    const controller = new AbortController();
    const response = await kit.call('/api/sessions/a/stream', { signal: controller.signal });
    open.push(controller);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-lina-bridge'), '1');
    const stream = collect(response, controller);

    await until(() => stream.events.length >= 3, 'hello, scrollback and screen');
    assert.deepEqual(stream.events[0], { type: 'hello',
      data: { protocol: STREAM_PROTOCOL, cols: 20, rows: 4, seq: 0, exited: false, control: false } });
    assert.deepEqual(stream.events[1], { type: 'scrollback', data: { lines: [] } }, 'nothing has scrolled off yet');
    assert.equal(stream.events[2].type, 'screen');
    assert.deepEqual(rowsOf(stream.events[2]), [[0, 'first'], [1, 'second'], [2, ''], [3, '']],
      'every row of the viewport, once');
    assert.deepEqual(stream.events[2].data.cursor, { x: 0, y: 2, visible: true });

    // One line printed: one row ships, not a screen.
    kit.bridge.ingest({ type: 'data', id: 'a', generation: 'g', sequence: 3, data: 'third\r\n' });
    await until(() => typeOf(stream, 'frame').length >= 1, 'a live frame');
    const frame = typeOf(stream, 'frame')[0];
    assert.deepEqual(rowsOf(frame), [[2, 'third']], 'only the row that changed');
    assert.deepEqual(frame.data.cursor, { x: 0, y: 3, visible: true });
    assert(frame.data.seq > stream.events[2].data.seq, 'frames carry a rising state number');
    assert.equal(typeOf(stream, 'screen').length, 1, 'a live change is never a whole screen');

    // Rewriting a row in place ships that row and nothing else.
    kit.bridge.ingest({ type: 'data', id: 'a', generation: 'g', sequence: 4, data: '\x1b[1;1Hfirst!' });
    await until(() => typeOf(stream, 'frame').length >= 2, 'the rewritten row');
    assert.deepEqual(rowsOf(typeOf(stream, 'frame')[1]), [[0, 'first!']]);

    // A resize is announced and then answered with a whole screen.
    kit.bridge.ingest({ type: 'resize', id: 'a', generation: 'g', cols: 24, rows: 5 });
    await until(() => typeOf(stream, 'resize').length >= 1, 'resize');
    assert.deepEqual(typeOf(stream, 'resize')[0].data, { cols: 24, rows: 5 });
    await until(() => typeOf(stream, 'screen').length >= 2, 'the screen that follows a resize');
    assert.equal(typeOf(stream, 'screen')[1].data.rows.length, 5, 'all five rows of the new geometry');

    // The connection is held open with comments rather than being closed.
    await until(() => stream.comments >= 1, 'keepalive');
    assert.equal(stream.done, false, 'the stream is still open');

    kit.bridge.ingest({ type: 'exit', id: 'a', generation: 'g' });
    await until(() => stream.events.some(event => event.type === 'exit'), 'exit');

    // A second viewer gets its own whole screen, not this one's diff.
    const laterController = new AbortController();
    const later = collect(await kit.call('/api/sessions/a/stream', { signal: laterController.signal }), laterController);
    open.push(laterController);
    await until(() => later.events.some(event => event.type === 'screen'), 'the second viewer screen');
    assert.equal(later.events[0].data.exited, true, 'hello reports the pane is gone');
    assert.deepEqual(rowsOf(later.events.find(event => event.type === 'screen'))[0], [0, 'first!']);

    assert.equal((await kit.call('/api/sessions/missing/stream')).status, 404);
  } finally {
    for (const controller of open) controller.abort();
    await kit.done();
  }
});

test('the stream carries the scrollback above the viewport, bounded', async () => {
  const records = [{ id: 'a', generation: 'g', kind: 'terminal', status: 'running', cwd: 'C:/p' }];
  const kit = await harness({ getDirectory: () => fakeDirectory(records, []) });
  const open = [];
  try {
    kit.bridge.ingest({ type: 'created', id: 'a', generation: 'g', cols: 20, rows: 3 });
    kit.bridge.ingest({ type: 'data', id: 'a', generation: 'g', sequence: 1,
      data: Array.from({ length: 400 }, (_, index) => `line ${index}`).join('\r\n') + '\r\n' });
    await new Promise(resolve => setTimeout(resolve, 200));

    const controller = new AbortController();
    open.push(controller);
    const stream = collect(await kit.call('/api/sessions/a/stream', { signal: controller.signal }), controller);
    const scrollback = await until(() => stream.events.find(event => event.type === 'scrollback'), 'scrollback');
    assert.equal(scrollback.data.lines.length, SCROLLBACK_LINES, 'capped at three hundred lines');
    assert.equal(plain(scrollback.data.lines.at(-1)), 'line 397', 'the newest line above the viewport');
    const screen = await until(() => stream.events.find(event => event.type === 'screen'), 'screen');
    assert.deepEqual(rowsOf(screen).map(entry => entry[1]), ['line 398', 'line 399', '']);
  } finally {
    for (const controller of open) controller.abort();
    await kit.done();
  }
});

// A raw socket, because undici transparently inflates `Content-Encoding` and
// would hide exactly the bytes this measures.
function rawStream(base, route, headers = {}) {
  const state = { events: [], comments: 0, compressed: 0, plainBytes: 0, done: false, request: null };
  state.request = http.request(`${base}${route}`, { headers });
  state.opened = new Promise((resolve, reject) => {
    state.request.on('error', reject);
    state.request.on('response', response => {
      state.status = response.statusCode;
      state.headers = response.headers;
      response.on('data', chunk => { state.compressed += chunk.length; });
      const sink = response.headers['content-encoding'] === 'gzip' ? zlib.createGunzip() : response;
      if (sink !== response) response.pipe(sink);
      let buffer = '';
      sink.on('data', chunk => {
        state.plainBytes += chunk.length;
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (frame.startsWith(':')) { state.comments++; continue; }
          const type = /^event: (.+)$/m.exec(frame);
          const data = /^data: (.*)$/m.exec(frame);
          if (type) state.events.push({ type: type[1], data: data ? JSON.parse(data[1]) : null });
        }
      });
      sink.on('end', () => { state.done = true; });
      resolve(state);
    });
    state.request.end();
  });
  return state;
}

test('the stream is gzipped when the client asks, and costs a fraction of the redraws', async () => {
  const records = [{ id: 'a', generation: 'g', kind: 'terminal', status: 'running', cwd: 'C:/p' }];
  const kit = await harness({ getDirectory: () => fakeDirectory(records, []) });
  const code = canonicalCode(CODE);
  let stream;
  try {
    kit.bridge.ingest({ type: 'created', id: 'a', generation: 'g', cols: 40, rows: 12 });
    stream = rawStream(kit.base, `/api/sessions/a/stream?code=${code}`, { 'Accept-Encoding': 'gzip' });
    await stream.opened;
    assert.equal(stream.status, 200);
    assert.equal(stream.headers['content-encoding'], 'gzip');
    assert.equal(stream.headers.vary, 'Accept-Encoding');
    await until(() => stream.events.some(event => event.type === 'screen'), 'the first screen through gzip');

    // Thirty rows rewritten thirty times: the phone must not pay for all of it.
    let raw = 0;
    for (let tick = 0; tick < 30; tick++) {
      let payload = '\x1b[2J\x1b[H';
      for (let line = 1; line <= 30; line++) payload += `line ${line} tick ${tick}\r\n`;
      raw += Buffer.byteLength(payload, 'utf8');
      kit.bridge.ingest({ type: 'data', id: 'a', generation: 'g', sequence: 10 + tick, data: payload });
      await new Promise(resolve => setTimeout(resolve, 33));
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    const frames = stream.events.filter(event => event.type === 'frame' || event.type === 'screen').length;
    assert(frames < 30, `thirty repaints were coalesced into ${frames} frames`);
    assert(stream.compressed * 5 < raw, `raw ${raw} vs compressed ${stream.compressed}`);
    assert(stream.compressed < stream.plainBytes, 'compression actually happened');

    const metrics = await (await kit.call('/api/sessions/a/metrics')).json();
    assert.equal(metrics.ok, true);
    assert(metrics.rawBytes >= raw, `the bridge counted the bytes it took in (${metrics.rawBytes})`);
    assert.equal(metrics.frames, frames);
    assert(metrics.sentBytes > 0 && metrics.sentBytes <= stream.compressed + 64);
    assert.equal(metrics.streams, 1);
    assert.equal((await kit.call('/api/sessions/missing/metrics')).status, 404);

    // Without the header the stream is plain, and still frames.
    const plainStream = rawStream(kit.base, `/api/sessions/a/stream?code=${code}`, { 'Accept-Encoding': 'identity' });
    await plainStream.opened;
    assert.equal(plainStream.headers['content-encoding'], undefined);
    await until(() => plainStream.events.some(event => event.type === 'screen'), 'a plain screen');
    plainStream.request.destroy();
  } finally {
    try { stream?.request.destroy(); } catch {}
    await kit.done();
  }
});

test('JSON answers over half a kilobyte are gzipped, small ones are not', async () => {
  const records = Array.from({ length: 12 }, (_, index) => ({ id: `s${index}`, generation: 'g', projectId: 'p1',
    kind: 'terminal', provider: 'terminal', status: 'running', cwd: `C:/p1/sub${index}`, terminalTitle: `pane ${index}` }));
  const kit = await harness({ getDirectory: () => fakeDirectory(records, [{ id: 'p1', name: 'One', path: 'C:/p1' }]) });
  try {
    const compressed = await fetch(`${kit.base}/api/state`, { headers: { Authorization: `Bearer ${canonicalCode(CODE)}`, 'Accept-Encoding': 'gzip' } });
    assert.equal(compressed.headers.get('content-encoding'), 'gzip');
    assert.equal(compressed.headers.get('vary'), 'Accept-Encoding');
    const bytes = Number(compressed.headers.get('content-length'));
    // undici inflates for us, so the decoded body proves the payload survived.
    const body = await compressed.json();
    assert.equal(body.sessions.length, 12);
    assert(bytes < Buffer.byteLength(JSON.stringify(body)) / 2, `gzip actually shrank it: ${bytes}`);

    const identity = await fetch(`${kit.base}/api/state`, { headers: { Authorization: `Bearer ${canonicalCode(CODE)}`, 'Accept-Encoding': 'identity' } });
    assert.equal(identity.headers.get('content-encoding'), null);
    assert.deepEqual((await identity.json()).sessions.length, 12);

    // A short answer is left alone: a gzip member would cost more than it saves.
    const hello = await fetch(`${kit.base}/api/hello`, { headers: { Authorization: `Bearer ${canonicalCode(CODE)}`, 'Accept-Encoding': 'gzip' } });
    assert.equal(hello.headers.get('content-encoding'), null);
    assert.equal(hello.headers.get('vary'), 'Accept-Encoding');
  } finally { await kit.done(); }
});

test('at most eight streams are served at once', async () => {
  const records = [{ id: 'a', generation: 'g', kind: 'terminal', status: 'running', cwd: 'C:/p' }];
  const kit = await harness({ getDirectory: () => fakeDirectory(records, []) });
  const open = [];
  try {
    for (let index = 0; index < MAX_STREAMS; index++) {
      const controller = new AbortController();
      open.push(controller);
      const response = await kit.call('/api/sessions/a/stream', { signal: controller.signal });
      assert.equal(response.status, 200, `stream ${index + 1}`);
      collect(response, controller);
    }
    const refused = await kit.call('/api/sessions/a/stream');
    assert.equal(refused.status, 503);
    assert.deepEqual(await refused.json(), { ok: false, error: 'too many streams' });

    // Hanging up frees a slot.
    open.pop().abort();
    const freed = await until(async () => {
      const controller = new AbortController();
      const response = await kit.call('/api/sessions/a/stream', { signal: controller.signal });
      if (response.status !== 200) { controller.abort(); return null; }
      open.push(controller);
      return response.status;
    }, 'a freed stream slot').then(value => value);
    assert.equal(freed, 200);
  } finally {
    for (const controller of open) controller.abort();
    await kit.done();
  }
});

test('the terminal page needs the code; its vendor assets are open and unmetered', async () => {
  const records = [{ id: 'a', generation: 'g', kind: 'claude', status: 'running', cwd: 'C:/p', cols: 110, rows: 32, terminalTitle: 'claude' }];
  const kit = await harness({ getDirectory: () => fakeDirectory(records, []) });
  const code = canonicalCode(CODE);
  try {
    const page = await kit.open(`/terminal/a?code=${code}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const html = await page.text();
    const vendor = kit.bridge.vendorUrls();
    // The desktop's own theme, font and geometry, not an approximation.
    for (const value of ['#17181c', '#ededf0', '#2e3138', '#6bd7db', '#ffffff', 'Cascadia Mono', 'View only',
      'scrollback: 5000', 'cursorBlink: false', 'disableStdin: true', '"cols":110', '"rows":32', 'window.linaTerminal',
      'ReactNativeWebView', vendor['xterm.js'], vendor['addon-fit.js'], vendor['xterm.css'], '/api/sessions/', 'EventSource',
      // Frame protocol v2: rows drawn at absolute positions, never raw bytes.
      "addEventListener('scrollback'", "addEventListener('screen'", "addEventListener('frame'",
      // The phone app enables its key bar from this; it is false while the
      // bridge has no route that writes to a terminal.
      '"control":', '{"type":"ready","control":false}']) {
      assert(html.includes(value), `the page is missing ${value}`);
    }
    assert(html.includes('#8fd694'), 'the cursor uses the pane kind\'s desktop accent');
    assert(!/\/api\/sessions\/[^"']*\/(input|interrupt)/.test(html), 'the page must offer no write path');
    assert(!html.includes('&since='), 'protocol v2 has no byte-replay cursor');

    // The page must never scroll sideways at any width: the font is sized so
    // the PTY's columns fit, every overflow is hidden, and a reader who needs a
    // bigger glyph zooms instead.
    for (const rule of ['overflow: hidden; overflow-x: hidden', '#stage { position: relative',
      'overflow: hidden;\n    background: #17181c; touch-action: pan-y', '#stage.zoomed { touch-action: none; }',
      '#zoom { position: absolute; inset: 0; transform-origin: 0 0',
      'overflow-x: hidden !important', 'scrollbar-width: none', '-ms-overflow-style: none',
      '.xterm-viewport::-webkit-scrollbar { display: none', 'body::-webkit-scrollbar',
      '#rail { position: absolute; top: 0; right: 0; bottom: 0; width: 2px', '#rail.on { opacity: 1; }',
      '#rail b { position: absolute; left: 0; width: 2px']) {
      assert(html.includes(rule), `the page is missing the CSS rule ${JSON.stringify(rule)}`);
    }
    assert(!/MIN_FONT\s*=\s*7\b/.test(html), 'the seven-pixel font floor is gone');
    assert(html.includes('var MIN_FONT = 1,'), 'only a sanity floor is left');
    assert(html.includes('var MIN_ZOOM = 0.6, MAX_ZOOM = 3;'), 'pinch zoom is bounded 0.6x to 3x');
    for (const value of ['function fitWidth', 'screenEl.offsetWidth > limit', 'resetZoom', 'function updateRail',
      "addEventListener('touchstart'", "addEventListener('touchmove'", 'zoom: function (delta)',
      'resetZoom: resetZoom', 'scale(' , 'translate(']) {
      assert(html.includes(value), `the page is missing ${value}`);
    }
    // Programmatic zoom anchors on the view, not its centre: the left edge so
    // column 0 never leaves, the bottom edge because a terminal is read from
    // the newest line up. A pinch still anchors on its own midpoint.
    assert(html.includes('if (originX === undefined) { originX = 0; originY = stage.clientHeight; }'),
      'zoom(delta) must anchor top-left/bottom, not on the stage centre');
    assert(!/originX = stage\.clientWidth \/ 2/.test(html), 'the centre anchor is gone');
    assert(html.includes('setScale(pinch.scale * (spread(event.touches) / pinch.distance), pinch.x, pinch.y'),
      'a pinch still passes its own midpoint');
    // The phone app sizes its own chrome from the ready message.
    assert(html.includes('cols: cols, rows: rows'), 'the ready message carries the geometry');
    assert(/post\(\{\s*type: READY\.type, control: READY\.control, id: SESSION\.id, cols: cols, rows: rows \}\)/.test(html),
      'ready is {type, control, id, cols, rows}');
    assert.match(vendor['xterm.js'], /^\/vendor\/[0-9a-f]{16}\/xterm\.js$/, 'the page addresses vendor files by content hash');

    // A <script> cannot send a header, and charging a stale code four failed
    // authorizations per page load would lock a phone out of its own bridge.
    // These files are the desktop's vendored dependency and hold nothing.
    for (const [asset, type] of [['xterm.js', /javascript/], ['xterm.css', /text\/css/], ['addon-fit.js', /javascript/]]) {
      const response = await kit.open(vendor[asset]);
      assert.equal(response.status, 200, `${asset} without any credential`);
      assert.match(response.headers.get('content-type'), type, asset);
      // Content-addressed, so it can be kept for a year and never revalidated.
      assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.match(response.headers.get('etag'), /^"[0-9a-f]{16}"$/, asset);
      assert((await response.text()).length > 500, `${asset} has a body`);

      // A second read with the tag it was given is answered with nothing.
      const revalidated = await kit.open(vendor[asset], { headers: { 'If-None-Match': response.headers.get('etag') } });
      assert.equal(revalidated.status, 304, `${asset} revalidates to 304`);
      // And a phone that says it reads gzip is handed the compressed copy.
      const compressed = await fetch(`${kit.base}${vendor[asset]}`, { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(compressed.headers.get('content-encoding'), 'gzip', asset);
      assert(Number(compressed.headers.get('content-length')) < Buffer.byteLength(await compressed.text()), `${asset} shrank`);
    }
    // The old unhashed path still answers, by pointing at the current hash.
    const legacy = await fetch(`${kit.base}/vendor/xterm.js`, { redirect: 'manual' });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get('location'), vendor['xterm.js']);
    assert.equal((await kit.open('/vendor/xterm.js')).status, 200, 'and following it lands on the asset');
    // A hash that is not the current build is redirected, never served stale.
    assert.equal((await fetch(`${kit.base}/vendor/${'0'.repeat(16)}/xterm.js`, { redirect: 'manual' })).status, 302);
    assert.equal((await kit.open('/vendor/nope.js')).status, 404);
    assert.equal((await kit.open(`/vendor/${'0'.repeat(16)}/nope.js`)).status, 404);
    assert.equal((await kit.open(vendor['xterm.js'], { method: 'POST' })).status, 404, 'still read-only');
    assert(!/\/vendor\/[^"']*\?code=/.test(html), 'the page must not put the code in a vendor URL');

    assert.equal((await kit.open('/terminal/a')).status, 401, 'the page needs the code');
    assert.equal((await kit.open(`/terminal/a?code=WRONGWRONGWRONGW`)).status, 401);
    assert.equal((await kit.open(`/terminal/missing?code=${code}`)).status, 404);
    assert.equal((await kit.open('/api/sessions/a/stream')).status, 401, 'the stream needs the code');
    // The query credential is only for the two viewing surfaces.
    assert.equal((await kit.open(`/api/state?code=${code}`)).status, 401);
    assert.equal((await kit.open(`/api/sessions/a/screen?code=${code}`)).status, 401);

    // Nothing above may have spent the auth limiter on a vendor request: five
    // real failures happened, so a sixth must still be answered 401, not 429,
    // and the code must still work.
    assert.equal((await kit.open('/terminal/a')).status, 401);
    assert.equal((await kit.call('/api/hello')).status, 200, 'the phone is not locked out');
    for (let index = 0; index < 40; index++) assert.equal((await kit.open('/vendor/xterm.css')).status, 200, `vendor read ${index}`);
    assert.equal((await kit.open('/api/discover')).status, 200, 'vendor reads do not spend the public budget either');
  } finally { await kit.done(); }
});

test('rotating the pairing code invalidates the previous one on the same listener', async () => {
  const directory = temporary();
  const settings = createMobileBridgeSettings({ userDataPath: directory,
    env: { LINA_MOBILE_BRIDGE_ENABLED: '1', LINA_MOBILE_BRIDGE_HOST: '127.0.0.1', LINA_MOBILE_BRIDGE_PORT: '0' } });
  const bridge = createMobileBridge({ settings, observation: createTerminalObservation(),
    getDirectory: () => fakeDirectory([], []), log: () => {} });
  try {
    const status = await bridge.start();
    assert.equal(status.listening, true, status.error);
    const hello = code => fetch(`http://127.0.0.1:${status.port}/api/hello`, { headers: { Authorization: `Bearer ${canonicalCode(code)}` } });
    assert.equal((await hello(status.code)).status, 200);

    const rotated = await bridge.regenerateCode();
    assert.notEqual(canonicalCode(rotated.code), canonicalCode(status.code));
    assert.equal(rotated.port, status.port, 'the listener is kept, so the phone only re-pairs');
    assert.equal((await hello(status.code)).status, 401, 'the previous pairing stops working');
    assert.equal((await hello(rotated.code)).status, 200);
  } finally { await bridge.close(); }
});
