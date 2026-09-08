'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createTerminalInput } = require('../../backend/orchestratorTerminalInput.cjs');
function fixture(overrides = {}) {
  const session = { id: 'p', generation: 'g', revision: 1, provider: 'codex', kind: 'codex', processState: 'running', agentProcessState: 'running', agentPid: 42, turnState: 'waiting' };
  const observation = { ok: true, id: 'p', generation: 'g', sequence: 7, cols: 100, rows: 28 }; const writes = [];
  const input = createTerminalInput({ getSession: () => session, readSession: async () => observation, write: async payload => { writes.push(payload); return { ok: true, status: 'written', delivery: 'pty-transport-only' }; }, now: () => 1000, ...overrides });
  return { input, session, observation, writes, action: (actionId, rest = {}) => ({ target: { id: 'p', generation: 'g' }, actionId, observationSequence: 7, keys: ['down'], ...rest }) };
}
test('waiting native menus allow bounded navigation, preserve evidence and deduplicate', async () => {
  const h = fixture(); const a = h.action('one');
  const result = await h.input.handle(a); assert.equal(result.status, 'written'); assert.equal(result.delivery, 'pty-transport-only');
  assert.deepEqual(await h.input.handle(a), result); assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].kind, 'interaction'); assert.deepEqual(h.writes[0].interactionEvidence, { id: 'p', generation: 'g', pid: 42, sequence: 7, revision: 1, observedAt: 1000, shell: false, cols: 100, rows: 28 });
  assert.equal((await h.input.handle(h.action('two', { text: 'literal answer', keys: [], submit: true }))).status, 'written');
});
test('stale screen, wrong generation, stopped/rootless/chat panes and runtime changes reject before writes', async () => {
  for (const patch of [{ generation: 'new' }, { processState: 'exited' }, { agentPid: undefined }, { agentProcessState: 'unknown' }, { kind: 'fusion' }, { binding: { status: 'ambiguous' } }, { childActivity: true }]) {
    const h = fixture(); Object.assign(h.session, patch); assert.equal((await h.input.handle(h.action('one'))).ok, false); assert.equal(h.writes.length, 0);
  }
  const h = fixture(); h.observation.sequence++; assert.equal((await h.input.handle(h.action('stale'))).status, 'stale-observation');
  const changed = fixture({ readSession: async () => { changed.session.turnId = 'replacement'; return changed.observation; } });
  assert.equal((await changed.input.handle(changed.action('changed'))).ok, false); assert.equal(changed.writes.length, 0);
});
test('literal inputs reject controls, excess bytes and unknown or excessive keys', async () => {
  const h = fixture();
  for (const [i, patch] of [{ text: 'x\x1b[A' }, { text: '😀'.repeat(25001) }, { keys: ['ctrl-unknown'] }, { keys: Array(17).fill('up') }, { submit: 'yes' }, { observationSequence: -1 }].entries()) assert.equal((await h.input.handle(h.action(String(i), patch))).status, 'invalid-action');
  assert.equal(h.writes.length, 0);
});
test('helper rejects duplicate or nonfinal submission keys without writing', async () => {
  const h = fixture();
  for (const [index, patch] of [{ keys: ['enter'], submit: true }, { keys: ['enter', 'enter'] }, { keys: ['enter', 'down'] }].entries()) {
    const result = await h.input.handle(h.action(String(index), patch)); assert.equal(result.status, 'invalid-action'); assert.match(result.error, /Enter once as the final key/);
  }
  assert.equal(h.writes.length, 0);
});
test('unknown writes never replay, concurrent pane writes reject, and plain shell roots work', async () => {
  let release; const h = fixture({ write: () => new Promise(resolve => { release = resolve; }) });
  const pending = h.input.handle(h.action('one')); await new Promise(setImmediate);
  assert.equal((await h.input.handle(h.action('two'))).status, 'interaction-busy'); release(undefined);
  assert.equal((await pending).status, 'unknown'); assert.equal((await h.input.handle(h.action('one'))).status, 'unknown');
  const shell = fixture(); Object.assign(shell.session, { provider: 'terminal', kind: 'terminal', pid: 43, agentPid: undefined, agentProcessState: 'unknown' });
  assert.equal((await shell.input.handle(shell.action('shell'))).ok, true); assert.equal(shell.writes[0].expectedAgentPid, 43);
});
test('completed dedup history stays bounded without a lifetime action limit; disposal blocks writes', async () => {
  const h = fixture();
  for (let index = 0; index < 1002; index++) assert.equal((await h.input.handle(h.action(String(index)))).ok, true);
  assert.equal(h.writes.length, 1002); await h.input.handle(h.action('1001')); assert.equal(h.writes.length, 1002);
  h.input.dispose(); assert.equal((await h.input.handle(h.action('closed'))).status, 'cancelled'); assert.equal(h.writes.length, 1002);
});
function host() {
  const events = [], terminals = []; let dead = false;
  const context = vm.createContext({ require: name => name === 'node-pty' ? { spawn() { const terminal = { pid: 42, writes: [], onData(fn) { this.data = fn; }, onExit() {}, resize() {}, kill() {}, write(data) { this.writes.push(data); if (this.fail) throw Error('transport uncertain'); } }; terminals.push(terminal); return terminal; } } : name === 'readline' ? { createInterface: () => ({ on() {} }) } : name === '../shared/terminalControls.cjs' ? require('../../shared/terminalControls.cjs') : require(name), process: { platform: 'win32', env: {}, stdin: {}, cwd: () => process.cwd(), stdout: { write: line => events.push(JSON.parse(line)) }, kill() { if (dead) throw Error('gone'); } }, setTimeout() {} });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../backend/ptyHost.cjs'), 'utf8'), context);
  context.handleMessage({ type: 'create', payload: { id: 'p', generation: 'g', launchToken: 1 } });
  const send = (actionId, fields = {}) => {
    const geometry = events.filter(e => e.cols && e.rows).at(-1);
    const payload = { kind: 'interaction', id: 'p', generation: 'g', actionId, expectedAgentPid: 42, interactionEvidence: { id: 'p', generation: 'g', pid: 42, sequence: events.filter(e => e.type === 'data').at(-1)?.sequence || 0, observedAt: Date.now() }, keys: ['down'], ...fields };
    if (payload.interactionEvidence) payload.interactionEvidence = { cols: geometry.cols, rows: geometry.rows, ...payload.interactionEvidence };
    context.handleMessage({ type: 'action', payload }); return events.at(-1);
  };
  return { send, context, terminal: terminals[0], events, dead: () => { dead = true; }, manual: data => context.handleMessage({ type: 'input', payload: { id: 'p', generation: 'g', data } }) };
}
test('PTY encodes named keys, bracketed literal text and requested submission only', () => {
  const h = host(); assert.equal(h.send('one').status, 'written'); assert.equal(h.terminal.writes.at(-1), '\x1b[B');
  h.terminal.data('\x1b[?1h\x1b[?2004h'); assert.equal(h.send('two', { text: 'answer', keys: ['up', 'enter'] }).status, 'written'); assert.equal(h.terminal.writes.at(-1), '\x1b[200~answer\x1b[201~\x1bOA\r');
  assert.equal(h.send('three', { text: 'draft', keys: [] }).status, 'written'); assert.equal(h.terminal.writes.at(-1), '\x1b[200~draft\x1b[201~');
  assert.equal(h.send('four', { keys: [], submit: true }).status, 'written'); assert.equal(h.terminal.writes.at(-1), '\r');
});
test('PTY rejects stale/dead roots, unsafe input and user drafts without editing them', () => {
  const h = host(); const evidence = { id: 'p', generation: 'g', pid: 42, sequence: 0, observedAt: Date.now() };
  assert.equal(h.send('expired', { interactionEvidence: { ...evidence, observedAt: Date.now() - 6000 } }).status, 'stale-observation');
  assert.equal(h.send('missing', { interactionEvidence: undefined }).status, 'stale-observation');
  assert.equal(h.send('generation', { generation: 'replacement' }).status, 'stale-generation');
  assert.equal(h.send('shell-pid', { expectedAgentPid: 99, interactionEvidence: { ...evidence, pid: 99, shell: true } }).status, 'stale-observation');
  h.terminal.data('Question?'); assert.equal(h.send('stale', { interactionEvidence: evidence }).status, 'stale-observation');
  assert.equal(h.send('control', { text: 'bad\x03' }).status, 'invalid-action'); assert.equal(h.send('key', { keys: ['constructor'] }).status, 'invalid-action');
  assert.equal(h.send('oversized', { text: '😀'.repeat(25001) }).status, 'invalid-action');
  h.manual('user draft'); const count = h.terminal.writes.length; assert.equal(h.send('draft').status, 'input-buffer-occupied'); assert.equal(h.terminal.writes.length, count);
  h.manual('\r'); h.dead(); assert.equal(h.send('dead').status, 'recipient-unavailable');
});
test('PTY rejects duplicate and nonfinal submission keys independently of helper', () => {
  const h = host();
  for (const [index, fields] of [{ keys: ['enter'], submit: true }, { keys: ['enter', 'enter'] }, { keys: ['enter', 'down'] }].entries()) {
    const result = h.send(String(index), fields); assert.equal(result.status, 'invalid-action'); assert.match(result.error, /Enter once as the final key/);
  }
  assert.equal(h.terminal.writes.length, 0);
});
test('cancellation before input or during observation never writes', async () => {
  const controller = new AbortController(); const h = fixture(); controller.abort();
  assert.equal((await h.input.handle(h.action('before', { signal: controller.signal }))).status, 'cancelled'); assert.equal(h.writes.length, 0);
  const during = new AbortController(); const changed = fixture({ readSession: async () => { during.abort(); return changed.observation; } });
  assert.equal((await changed.input.handle(changed.action('during', { signal: during.signal }))).status, 'cancelled'); assert.equal(changed.writes.length, 0);
});
test('PTY uncertain writes deduplicate and assistant drafts block unrelated prompt injection', () => {
  const h = host(); h.terminal.fail = true; assert.equal(h.send('one', { text: 'answer' }).status, 'unknown'); assert.equal(h.send('one', { text: 'answer' }).status, 'unknown'); assert.equal(h.terminal.writes.length, 1);
  h.terminal.fail = false;
  h.context.handleMessage({ type: 'action', payload: { kind: 'input', id: 'p', generation: 'g', actionId: 'prompt', data: 'new\r', promptText: 'new' } });
  assert.equal(h.events.at(-1).status, 'input-buffer-occupied');
});

const { encodeTerminalControls, TERMINAL_KEYS } = require('../../shared/terminalControls.cjs');
test('shared controls encode modifiers, function keys and safe multiline paste', () => {
  for (const key of TERMINAL_KEYS) assert.equal(encodeTerminalControls({ keys: [key] }).ok, true, key);
  assert.equal(encodeTerminalControls({ keys: ['ctrl-a', 'alt-z', 'ctrl-shift-left', 'f12'] }).data, '\x01\x1bz\x1b[1;6D\x1b[24~');
  assert.equal(encodeTerminalControls({ text: 'one\r\ntwo\t\u{1f600}' }).ok, false);
  assert.equal(encodeTerminalControls({ text: 'one\r\ntwo\t\u{1f600}' }, { bracketedPaste: true }).data, '\x1b[200~one\ntwo\t\u{1f600}\x1b[201~');
});
test('operator helper requires exact input revision and owner while readiness is unknown', async () => {
  const h = fixture(); h.session.turnState = 'unknown'; h.observation.inputRevision = 2;
  assert.equal((await h.input.handle(h.action('missing', { operator: true, requestId: 'r' }))).status, 'invalid-action');
  assert.equal((await h.input.handle(h.action('stale', { operator: true, requestId: 'r', inputRevision: 1 }))).status, 'stale-observation');
  assert.equal((await h.input.handle(h.action('fresh', { operator: true, requestId: 'r', inputRevision: 2 }))).ok, true);
  assert.equal(h.writes[0].interactionEvidence.inputRevision, 2); assert.equal(h.writes[0].requestId, 'r');
});
test('PTY input revisions fence manual races, repeat navigation, ownership and explicit edits', () => {
  const h = host();
  const evidence = inputRevision => ({ id: 'p', generation: 'g', pid: 42, sequence: 0, observedAt: Date.now(), inputRevision });
  const send = (id, revision, fields = {}) => h.send(id, { operator: true, requestId: 'r1', interactionEvidence: evidence(revision), ...fields });
  assert.equal(send('first', 0, { text: 'draft', keys: [] }).ok, true);
  assert.equal(send('repeat-old', 0).status, 'stale-observation');
  assert.equal(send('other', 1, { requestId: 'r2', keys: ['enter'] }).status, 'input-buffer-occupied');
  h.manual('x');
  assert.equal(send('manual-race', 1).status, 'stale-observation');
  assert.equal(send('preserve', 2).status, 'input-buffer-occupied');
  assert.equal(send('edit', 2, { requestId: 'r2', editInput: true, keys: ['ctrl-a', 'backspace'] }).ok, true);
  assert.equal(send('submit-other', 3, { keys: ['enter'] }).status, 'input-buffer-occupied');
  assert.equal(send('submit-owner', 3, { requestId: 'r2', keys: ['enter'] }).ok, true);
  const state = h.events.filter(e => e.type === 'input-state').at(-1);
  assert.equal(state.inputRevision, 4); assert.equal(state.ownerRequestId, null);
});
test('PTY multiline needs paste mode; uncertain actions consume revision and never replay', () => {
  const h = host(); assert.equal(h.send('unsafe', { text: 'one\ntwo', keys: [] }).status, 'invalid-action');
  h.terminal.data('\x1b[?2004h');
  assert.equal(h.send('safe', { text: 'one\r\ntwo\t\u{1f600}', keys: [], submit: true }).ok, true);
  assert.equal(h.terminal.writes.at(-1), '\x1b[200~one\ntwo\t\u{1f600}\x1b[201~\r');
  h.terminal.fail = true;
  const fields = { operator: true, requestId: 'r', text: 'draft', keys: [], interactionEvidence: { id: 'p', generation: 'g', pid: 42, sequence: 1, observedAt: Date.now(), inputRevision: 1 } };
  assert.equal(h.send('uncertain', fields).status, 'unknown');
  const count = h.terminal.writes.length; assert.equal(h.send('uncertain', fields).status, 'unknown'); assert.equal(h.terminal.writes.length, count);
  assert.equal(h.send('retry-new-id', fields).status, 'stale-observation');
});

test('actual host creation feeds revision zero into decoder and enables first observed action', async () => {
  const { createTerminalObservation } = require('../../backend/terminalObservation.cjs');
  const h = host(), observation = createTerminalObservation();
  try {
    h.terminal.data('Ready');
    for (const event of h.events) observation.ingest(event);
    const screen = await observation.read({ id: 'p', generation: 'g' });
    assert.equal(screen.inputRevision, 0); assert.equal(screen.manualInputPending, false);
    const result = h.send('first-observed', { operator: true, requestId: 'r', interactionEvidence: { id: 'p', generation: 'g', pid: 42, sequence: screen.sequence, inputRevision: screen.inputRevision, observedAt: Date.now() } });
    assert.equal(result.status, 'written');
  } finally { observation.dispose(); }
});
test('native SGR mouse requires enabled tracking and current dimensions/revision', () => {
  const h = host(); const mouse = { x: 3, y: 4, button: 'left', action: 'click' };
  const send = (id, fields = {}) => h.send(id, { keys: [], mouse, ...fields });
  assert.equal(send('disabled').status, 'unsupported-control');
  h.terminal.data('\x1b[?1000;1006h');
  assert.equal(send('click').status, 'written'); assert.equal(h.terminal.writes.at(-1), '\x1b[<0;3;4M\x1b[<0;3;4m');
  assert.equal(send('bounds', { mouse: { ...mouse, x: 9999 } }).status, 'invalid-action');
  assert.equal(send('move-disabled', { mouse: { ...mouse, action: 'move' } }).status, 'unsupported-control');
  h.terminal.data('\x1b[?1002h');
  assert.equal(send('move', { mouse: { ...mouse, action: 'move' } }).status, 'written');
  assert.equal(h.terminal.writes.at(-1), '\x1b[<32;3;4M');
  assert.equal(send('wheel', { mouse: { ...mouse, button: 'wheel-down' } }).status, 'written');
  assert.equal(h.terminal.writes.at(-1), '\x1b[<65;3;4M');
  const evidence = { id: 'p', generation: 'g', pid: 42, sequence: 2, inputRevision: 0, observedAt: Date.now() };
  assert.equal(send('stale-input', { operator: true, requestId: 'r', interactionEvidence: evidence }).status, 'stale-observation');
  h.context.handleMessage({ type: 'resize', payload: { id: 'p', generation: 'g', cols: 20, rows: 6 } });
  assert.equal(send('resized', { mouse: { ...mouse, x: 21 } }).status, 'invalid-action');
  h.terminal.data('\x1b[?1006l'); assert.equal(send('sgr-disabled').status, 'unsupported-control');
  h.terminal.data('\x1b[?1006h\x1b[?1002l'); assert.equal(send('tracking-disabled').status, 'unsupported-control');
});
test('submission aliases clear leases and interrupt cannot precede recalled input', () => {
  const h = host();
  for (const keys of [['ctrl-c', 'up'], ['ctrl-j', 'up'], ['ctrl-m', 'enter']]) assert.equal(h.send(keys.join(), { keys }).status, 'invalid-action');
  assert.equal(h.send('draft', { text: 'hello', keys: [], requestId: 'r' }).ok, true);
  assert.equal(h.send('alias', { keys: ['ctrl-m'], requestId: 'r' }).ok, true);
  assert.equal(h.events.filter(e => e.type === 'input-state').at(-1).ownerRequestId, null);
  assert.equal(encodeTerminalControls({ keys: ['alt-1', 'ctrl-space', 'ctrl-backslash'] }).data, '\x1b1\x00\x1c');
});

test('only strict observed Ctrl-C can interrupt a root with active child work', async () => {
  const h = fixture(); h.session.childActivity = true; h.observation.inputRevision = 0;
  const fields = { operator: true, inputRevision: 0, requestId: 'r', keys: ['ctrl-c'] };
  assert.equal((await h.input.handle(h.action('interrupt', fields))).status, 'written');
  assert.equal((await h.input.handle(h.action('navigation', { ...fields, keys: ['up'] }))).status, 'recipient-unavailable');
  assert.equal((await h.input.handle(h.action('legacy', { keys: ['ctrl-c'] }))).status, 'recipient-unavailable');
  assert.equal((await h.input.handle(h.action('stale', { ...fields, inputRevision: 1 }))).status, 'stale-observation');
});
test('held mouse drag is request owned until release or manual input; uncertain release retains lease', () => {
  const h = host(); h.terminal.data('\x1b[?1002;1006h');
  const send = (id, inputRevision, requestId, action, rest = {}) => h.send(id, { keys: [], operator: true, requestId,
    mouse: { x: 2, y: 2, button: 'left', action }, interactionEvidence: { id: 'p', generation: 'g', pid: 42, sequence: 1, observedAt: Date.now(), inputRevision }, ...rest });
  assert.equal(send('down', 0, 'a', 'down').ok, true);
  assert.equal(h.events.filter(e => e.type === 'input-state').at(-1).ownerRequestId, 'a');
  assert.equal(send('other-move', 1, 'b', 'move').status, 'input-buffer-occupied');
  assert.equal(send('other-up', 1, 'b', 'up').status, 'input-buffer-occupied');
  assert.equal(send('takeover', 1, 'b', 'move', { editInput: true }).ok, true);
  h.terminal.fail = true;
  assert.equal(send('uncertain-up', 2, 'b', 'up').status, 'unknown');
  assert.equal(h.events.filter(e => e.type === 'input-state').at(-1).ownerRequestId, 'b');
  h.terminal.fail = false;
  assert.equal(send('blocked-after-uncertain', 3, 'a', 'up').status, 'input-buffer-occupied');
  assert.equal(send('owner-up', 3, 'b', 'up').ok, true);
  assert.equal(h.events.filter(e => e.type === 'input-state').at(-1).ownerRequestId, null);
  assert.equal(send('new-down', 4, 'a', 'down').ok, true);
  h.manual('x');
  assert.equal(h.events.filter(e => e.type === 'input-state').at(-1).ownerRequestId, null);
});

test('PTY rejects a resize with identical output and input revisions before any write', () => {
  const h = host();
  const evidence = { id: 'p', generation: 'g', pid: 42, sequence: 0, inputRevision: 0, cols: 100, rows: 28, observedAt: Date.now() };
  h.context.handleMessage({ type: 'resize', payload: { id: 'p', generation: 'g', cols: 120, rows: 40 } });
  const result = h.send('resized-since-read', { operator: true, requestId: 'owner', interactionEvidence: evidence });
  assert.equal(result.status, 'stale-observation'); assert.match(result.error, /geometry/);
  assert.equal(h.terminal.writes.length, 0);
  assert.equal(h.send('fresh-size', { operator: true, requestId: 'owner', interactionEvidence: { ...evidence, cols: 120, rows: 40 } }).status, 'written');
});
