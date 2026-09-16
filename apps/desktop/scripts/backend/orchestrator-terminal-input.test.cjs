'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createTerminalInput } = require('../../backend/orchestratorTerminalInput.cjs');
const { composerScreen, surfaceOf } = require('./orchestrator-input-fixture.cjs');
function fixture(overrides = {}) {
  const session = { id: 'p', generation: 'g', revision: 1, provider: 'codex', kind: 'codex', processState: 'running', agentProcessState: 'running', agentPid: 42, turnState: 'waiting', turnId: 'established-turn' };
  const observation = composerScreen(); const writes = [];
  // The input surface as it stood when this action was authorized. Moving
  // `h.observation` afterwards is how a test moves the pane under the write —
  // which is the whole fence now, in place of a byte counter.
  let baseline = surfaceOf(session, observation);
  const input = createTerminalInput({ getSession: () => session, readSession: async () => observation, write: async payload => { writes.push(payload); return { ok: true, status: 'written', delivery: 'pty-transport-only' }; }, now: () => 1000, ...overrides });
  return { input, session, observation, writes, surface: () => surfaceOf(session, observation),
    // After reconfiguring the pane (a different provider, a different screen),
    // re-take the baseline: the surface names the composer the pane paints.
    rebase: () => { baseline = surfaceOf(session, observation); },
    get baseline() { return baseline; },
    action: (actionId, rest = {}) => ({ target: { id: 'p', generation: 'g' }, actionId, keys: ['down'], inputSurface: baseline, ...rest }) };
}
test('waiting native menus allow bounded navigation, preserve evidence and deduplicate', async () => {
  const h = fixture(); const a = h.action('one');
  const result = await h.input.handle(a); assert.equal(result.status, 'written'); assert.equal(result.delivery, 'pty-transport-only');
  assert.deepEqual(await h.input.handle(a), result); assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].kind, 'interaction');
  const { surface, ...evidence } = h.writes[0].interactionEvidence;
  assert.deepEqual(evidence, { id: 'p', generation: 'g', pid: 42, sequence: 7, revision: 1, observedAt: 1000, shell: false, cols: 100, rows: 28, inputRevision: 0 });
  assert.equal(surface.verified, true); assert.equal(surface.composerEmpty, true);
  assert.equal((await h.input.handle(h.action('two', { text: 'literal answer', keys: [], submit: true }))).status, 'written');
});
test('stale screen, wrong generation, stopped/rootless/chat panes and runtime changes reject before writes', async () => {
  for (const patch of [{ generation: 'new' }, { processState: 'exited' }, { agentPid: undefined }, { agentProcessState: 'unknown' }, { kind: 'fusion' }, { binding: { status: 'ambiguous' } }, { childActivity: true }]) {
    const h = fixture(); Object.assign(h.session, patch); assert.equal((await h.input.handle(h.action('one'))).ok, false); assert.equal(h.writes.length, 0);
  }
  // Output alone is not staleness any more — an animated composer produces it
  // by the second. A moved caret is, and so is a keystroke.
  const fresh = fixture(); fresh.observation.sequence += 30;
  assert.equal((await fresh.input.handle(fresh.action('repainted'))).status, 'written');
  const h = fixture(); h.observation.cursor = { x: 9, y: h.observation.cursor.y };
  assert.equal((await h.input.handle(h.action('stale'))).status, 'stale-observation');
  const typed = fixture(); typed.observation.inputRevision += 1;
  assert.equal((await typed.input.handle(typed.action('typed'))).reason, 'input-revision-changed');
  const changed = fixture({ readSession: async () => { changed.session.turnId = 'replacement'; return changed.observation; } });
  assert.equal((await changed.input.handle(changed.action('changed'))).ok, false); assert.equal(changed.writes.length, 0);
});
test('literal inputs reject controls, excess bytes and unknown or excessive keys', async () => {
  const h = fixture();
  for (const [i, patch] of [{ text: 'x\x1b[A' }, { text: '😀'.repeat(25001) }, { keys: ['ctrl-unknown'] }, { keys: Array(17).fill('up') }, { submit: 'yes' }, { inputSurface: { id: 'p' } }].entries()) assert.equal((await h.input.handle(h.action(String(i), patch))).status, 'invalid-action');
  assert.equal(h.writes.length, 0);
});

for (const phase of ['before-read', 'during-read', 'before-write']) test(`routed native controls fence conversation identity ${phase}`, async () => {
  const h = fixture({
    readSession: async () => { if (phase === 'during-read') h.session.conversationId = 'replacement'; return h.observation; },
    onBeforeWrite: () => { if (phase === 'before-write') h.session.conversationId = 'replacement'; },
  });
  Object.assign(h.session, { cwd: 'C:/repo', conversationId: phase === 'before-read' ? 'replacement' : 'original' });
  if (phase === 'before-write') h.session.turnState = 'idle';
  const routingBinding = { target: { id: 'p', generation: 'g' }, nativeIdentity: { provider: 'codex', home: 'global', workspace: 'C:/repo', id: 'original' } };
  const result = await h.input.handle(h.action('routed', { routingBinding, promptSubmission: phase === 'before-write' }));
  assert.equal(result.status, 'conversation-changed'); assert.equal(result.delivery, 'not-dispatched'); assert.equal(h.writes.length, 0);
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
  Object.assign(shell.observation, { text: 'PS C:\\project>', cursor: { x: 14, y: 0 },
    cursorLine: { startRow: 0, text: 'PS C:\\project>', beforeCursor: 'PS C:\\project>' },
    cursorContext: { startRow: 0, rows: ['PS C:\\project>'] } });
  shell.rebase();
  assert.equal((await shell.input.handle(shell.action('shell'))).ok, true); assert.equal(shell.writes[0].expectedAgentPid, 43);
});
test('completed dedup history stays bounded without a lifetime action limit; disposal blocks writes', async () => {
  const h = fixture();
  for (let index = 0; index < 1002; index++) assert.equal((await h.input.handle(h.action(String(index)))).ok, true);
  assert.equal(h.writes.length, 1002); await h.input.handle(h.action('1001')); assert.equal(h.writes.length, 1002);
  h.input.dispose(); assert.equal((await h.input.handle(h.action('closed'))).status, 'cancelled'); assert.equal(h.writes.length, 1002);
});
const { surfaceEvidence } = require('../../backend/orchestratorInputSurface.cjs');
const hostSurface = (composerEmpty, sequence = 0) => surfaceEvidence({ composer: { empty: composerEmpty } }, sequence);
function host() {
  const events = [], terminals = []; let dead = false, clock = 0, nextTimer = 0;
  const timers = new Map();
  const advance = ms => {
    const end = clock + ms;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); clock = due[1].at; due[1].fn();
    }
    clock = end; return events.at(-1);
  };
  const context = vm.createContext({ require: name => name === 'node-pty' ? { spawn() { const terminal = { pid: 42, writes: [], onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; }, resize() {}, kill() {}, write(data) { this.writes.push(data); if (this.fail) throw Error('transport uncertain'); } }; terminals.push(terminal); return terminal; } } : name === 'readline' ? { createInterface: () => ({ on() {} }) } : name === './observedStop.cjs' ? require('../../backend/observedStop.cjs') : name === '../shared/terminalControls.cjs' ? require('../../shared/terminalControls.cjs') : require('node:module').createRequire(path.resolve(__dirname, '../../backend/ptyHost.cjs'))(name), process: { platform: 'win32', env: {}, stdin: {}, cwd: () => process.cwd(), stdout: { write: line => events.push(JSON.parse(line)) }, kill() { if (dead) throw Error('gone'); } }, Date: class extends Date { static now() { return Date.now() + clock; } }, setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: clock + ms }); return id; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../backend/ptyHost.cjs'), 'utf8'), context);
  context.handleMessage({ type: 'create', payload: { id: 'p', generation: 'g', launchToken: 1 } });
  // Every interaction the host accepts now carries the main process's captured
  // input surface and the input revision it was captured at. A test that wants
  // either of them wrong supplies its own; the defaults are the current truth,
  // read out of the host's own session rather than guessed.
  const live = () => vm.runInContext("(() => { const s = sessions.get('p'); return s && { inputRevision: s.inputRevision, cols: s.cols, rows: s.rows }; })()", context) || {};
  const send = (actionId, fields = {}) => {
    const geometry = events.filter(e => e.cols && e.rows).at(-1);
    const current = live();
    const payload = { kind: 'interaction', id: 'p', generation: 'g', actionId, expectedAgentPid: 42, interactionEvidence: { id: 'p', generation: 'g', pid: 42, sequence: events.filter(e => e.type === 'data').at(-1)?.sequence || 0, observedAt: Date.now() + clock }, keys: ['down'], ...fields };
    if (payload.interactionEvidence) payload.interactionEvidence = { cols: geometry.cols, rows: geometry.rows,
      inputRevision: current.inputRevision, surface: hostSurface(true, 0), ...payload.interactionEvidence };
    context.handleMessage({ type: 'action', payload }); return events.at(-1);
  };
  return { send, context, advance, now: () => Date.now() + clock, terminal: terminals[0], events, dead: () => { dead = true; }, manual: data => context.handleMessage({ type: 'input', payload: { id: 'p', generation: 'g', data } }) };
}
test('PTY encodes named keys, bracketed literal text and requested submission only', () => {
  const h = host(); assert.equal(h.send('one').status, 'written'); assert.equal(h.terminal.writes.at(-1), '\x1b[B');
  h.terminal.data('\x1b[?1h\x1b[?2004h'); h.send('two', { text: 'answer', keys: ['up', 'enter'] }); assert.equal(h.terminal.writes.at(-1), '\x1b[200~answer\x1b[201~\x1bOA'); assert.equal(h.advance(199).type, 'input-state'); assert.equal(h.advance(1).status, 'written'); assert.equal(h.terminal.writes.at(-1), '\r');
  assert.equal(h.send('three', { text: 'draft', keys: [] }).status, 'written'); assert.equal(h.terminal.writes.at(-1), '\x1b[200~draft\x1b[201~');
  assert.equal(h.send('four', { keys: [], submit: true }).status, 'written'); assert.equal(h.terminal.writes.at(-1), '\r');
});
test('PTY rejects stale/dead roots, unsafe input and user drafts without editing them', () => {
  const h = host(); const evidence = { id: 'p', generation: 'g', pid: 42, sequence: 0, observedAt: Date.now() };
  assert.equal(h.send('expired', { interactionEvidence: { ...evidence, observedAt: Date.now() - 6000 } }).status, 'stale-observation');
  assert.equal(h.send('missing', { interactionEvidence: undefined }).status, 'invalid-action');
  assert.equal(h.send('generation', { generation: 'replacement' }).status, 'stale-generation');
  assert.equal(h.send('shell-pid', { expectedAgentPid: 99, interactionEvidence: { ...evidence, pid: 99, shell: true } }).status, 'stale-observation');
  h.terminal.data('Question?');
  assert.equal(h.send('repainted', { interactionEvidence: { ...evidence, inputRevision: 0 } }).status, 'written', 'output between the read and the write is not staleness');
  assert.equal(h.send('control', { text: 'bad\x03' }).status, 'invalid-action'); assert.equal(h.send('key', { keys: ['constructor'] }).status, 'invalid-action');
  assert.equal(h.send('oversized', { text: '😀'.repeat(25001) }).status, 'invalid-action');
  h.manual('user draft'); const count = h.terminal.writes.length;
  // Main reports what its decoder sees; a composer holding the user's draft is
  // not empty, so the latch holds.
  assert.equal(h.send('draft', { interactionEvidence: { ...evidence, surface: hostSurface(false) } }).status, 'input-buffer-occupied'); assert.equal(h.terminal.writes.length, count);
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
test('operator helper requires a captured surface and an owner while readiness is unknown', async () => {
  const h = fixture(); h.session.turnState = 'unknown'; h.observation.inputRevision = 2; h.rebase();
  assert.equal((await h.input.handle({ target: { id: 'p', generation: 'g' }, actionId: 'missing', keys: ['down'], operator: true, requestId: 'r' })).status, 'invalid-action');
  assert.equal((await h.input.handle(h.action('unowned', { operator: true }))).status, 'invalid-action');
  const stale = { ...h.baseline, inputRevision: 1 };
  assert.equal((await h.input.handle(h.action('stale', { operator: true, requestId: 'r', inputSurface: stale }))).status, 'stale-observation');
  assert.equal((await h.input.handle(h.action('fresh', { operator: true, requestId: 'r' }))).ok, true);
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
  assert.equal(send('preserve', 2, { interactionEvidence: { ...evidence(2), surface: hostSurface(false) } }).status, 'input-buffer-occupied');
  assert.equal(send('edit', 2, { requestId: 'r2', editInput: true, keys: ['ctrl-a', 'backspace'] }).ok, true);
  assert.equal(send('submit-other', 3, { keys: ['enter'] }).status, 'input-buffer-occupied');
  assert.equal(send('submit-owner', 3, { requestId: 'r2', keys: ['enter'] }).ok, true);
  const state = h.events.filter(e => e.type === 'input-state').at(-1);
  assert.equal(state.inputRevision, 4); assert.equal(state.ownerRequestId, null);
});
test('PTY multiline needs paste mode; uncertain actions consume revision and never replay', () => {
  const h = host(); assert.equal(h.send('unsafe', { text: 'one\ntwo', keys: [] }).status, 'invalid-action');
  h.terminal.data('\x1b[?2004h');
  h.send('safe', { text: 'one\r\ntwo\t\u{1f600}', keys: [], submit: true });
  assert.equal(h.terminal.writes.at(-1), '\x1b[200~one\ntwo\t\u{1f600}\x1b[201~');
  assert.equal(h.advance(200).status, 'written'); assert.equal(h.terminal.writes.at(-1), '\r');
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
  assert.equal((await h.input.handle(h.action('stale', { ...fields, inputSurface: { ...h.baseline, inputRevision: 1 } }))).status, 'stale-observation');
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


test('native text submission holds dedup and pane ownership until one delayed Enter', () => {
  for (const bracketed of [false, true]) {
    const h = host(); if (bracketed) h.terminal.data('\x1b[?2004h');
    const fields = { text: 'new task', keys: [], submit: true, requestId: 'owner' };
    h.send('split', fields); h.send('split', fields);
    assert.equal(h.terminal.writes.length, 1);
    assert.equal(h.events.filter(e => e.type === 'action-result' && e.actionId === 'split').length, 0);
    assert.equal(h.events.at(-1).ownerRequestId, 'owner');
    assert.equal(h.events.at(-1).interactionInputPending, true);
    assert.equal(h.send('other', { keys: ['enter'], requestId: 'owner' }).status, 'interaction-busy');
    h.advance(199); assert.equal(h.terminal.writes.length, 1);
    assert.equal(h.advance(1).status, 'written');
    assert.deepEqual(h.terminal.writes, [bracketed ? '\x1b[200~new task\x1b[201~' : 'new task', '\r']);
    h.send('split', fields); h.advance(1000); assert.equal(h.terminal.writes.length, 2);
    assert.equal(h.events.filter(e => e.type === 'input-state').at(-1).interactionInputPending, false);
  }
});

for (const race of ['typing', 'manual-submit', 'cancel', 'deadline', 'exit', 'dead-recipient', 'replacement', 'resize', 'submit-write-fails']) {
  test(`native staged text never auto-submits or retries after ${race}`, () => {
    const h = host();
    const fields = { text: 'task', keys: [], submit: true, requestId: 'owner', ...(race === 'deadline' ? { deadlineAt: h.now() + 100 } : {}) };
    h.send('split', fields);
    switch (race) {
      case 'typing': h.manual('human'); break;
      case 'manual-submit': h.manual('\r'); break;
      case 'cancel': h.context.handleMessage({ type: 'action-cancel', payload: { id: 'p', generation: 'g', actionId: 'split' } }); break;
      case 'exit': h.terminal.exit({ exitCode: 0 }); break;
      case 'dead-recipient': h.dead(); break;
      case 'replacement': h.context.handleMessage({ type: 'create', payload: { id: 'p', generation: 'new', launchToken: 2 } }); break;
      case 'resize': h.context.handleMessage({ type: 'resize', payload: { id: 'p', generation: 'g', cols: 120, rows: 40 } }); break;
      case 'submit-write-fails': h.terminal.fail = true; break;
    }
    h.advance(200);
    const result = h.events.filter(e => e.type === 'action-result' && e.actionId === 'split').at(-1);
    assert.equal(result.status, 'unknown'); assert.equal(result.submission, 'unconfirmed'); assert.equal(result.partialWrite, true);
    assert.notEqual(result.delivery, 'not-dispatched');
    assert.deepEqual(h.terminal.writes, ['task', ...(['manual-submit', 'submit-write-fails'].includes(race) ? ['\r'] : race === 'typing' ? ['human'] : [])]);
    const count = h.terminal.writes.length; h.send('split', fields); h.advance(1000); assert.equal(h.terminal.writes.length, count);
    if (['cancel', 'deadline', 'dead-recipient', 'resize', 'submit-write-fails'].includes(race)) {
      const state = h.events.filter(e => e.type === 'input-state').at(-1);
      assert.equal(state.ownerRequestId, 'owner'); assert.equal(state.interactionInputPending, true);
    }
  });
}

test('native first-write failure retains draft ownership and never schedules final Enter', () => {
  const h = host(); h.terminal.fail = true;
  const result = h.send('split', { text: 'task', keys: [], submit: true, requestId: 'owner' });
  assert.equal(result.status, 'unknown'); assert.equal(result.partialWrite, true);
  h.advance(1000); assert.deepEqual(h.terminal.writes, ['task']);
  assert.equal(h.events.filter(e => e.type === 'input-state').at(-1).ownerRequestId, 'owner');
});

test('explicit stop cancels staged native Enter and terminal replies do not cancel submission', () => {
  for (const kind of ['interrupt', 'kill']) {
    const h = host(); h.send('split', { text: 'task', keys: [], submit: true });
    h.context.handleMessage({ type: 'action', payload: { id: 'p', generation: 'g', actionId: 'stop', kind } });
    assert.equal(h.events.at(-1).ok, true); h.advance(1000);
    assert.deepEqual(h.terminal.writes, ['task', ...(kind === 'interrupt' ? ['\x03'] : [])]);
    assert.equal(h.events.find(e => e.type === 'action-result' && e.actionId === 'split').status, 'unknown');
  }
  const h = host(); h.send('split', { text: 'task', keys: [], submit: true }); h.manual('\x1b[I');
  assert.equal(h.advance(200).status, 'written'); assert.deepEqual(h.terminal.writes, ['task', '\x1b[I', '\r']);
});

test('plain shell text and key-only submissions keep their immediate native behavior', () => {
  const h = host();
  assert.equal(h.send('shell', { text: 'echo hello', keys: [], submit: true, interactionEvidence: { id: 'p', generation: 'g', pid: 42, sequence: 0, observedAt: h.now(), shell: true } }).status, 'written');
  assert.equal(h.send('key', { keys: ['enter'] }).status, 'written');
  assert.deepEqual(h.terminal.writes, ['echo hello\r', '\r']); h.advance(1000); assert.equal(h.terminal.writes.length, 2);
});

// ---------------------------------------------------------------------------
// Input-surface freshness. The old fence compared an OUTPUT counter, so any pane
// that repaints itself — Codex 0.154 animates a sparkle around its empty
// composer several times a second, forever — was permanently "stale" and could
// never be typed into. The screens below are the recorded Codex 0.154 composer,
// decoded by the app's own decoder.
// ---------------------------------------------------------------------------
const { projectInputSurface } = require('../../backend/orchestratorInputSurface.cjs');
const { createTerminalObservation } = require('../../backend/terminalObservation.cjs');
const FIXTURES = path.join(__dirname, 'fixtures/provider-startup-screens');
async function composerFixture(t, overrides = {}) {
  const recorded = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'codex-ready.json'), 'utf8'));
  const decoder = createTerminalObservation(); t.after(() => decoder.dispose());
  await decoder.ingest({ type: 'created', id: 'p', generation: 'g', cols: recorded.cols, rows: recorded.rows, inputRevision: 3 });
  await decoder.ingest({ type: 'data', id: 'p', generation: 'g', sequence: 1,
    data: fs.readFileSync(path.join(FIXTURES, 'codex-ready.bin'), 'utf8') });
  const screen = await decoder.read({ id: 'p', generation: 'g' });
  const h = fixture(overrides);
  h.session.turnState = 'unknown';
  Object.assign(h.observation, screen, { ok: true, id: 'p', generation: 'g', sequence: 7 });
  h.prompt = (actionId, rest = {}) => h.action(actionId, { operator: true, requestId: 'r', inputRevision: 3,
    promptSubmission: true, submit: true, text: 'say hi', keys: [], ...rest });
  h.keys = (actionId, rest = {}) => h.action(actionId, { operator: true, requestId: 'r', inputRevision: 3, keys: ['down'], ...rest });
  h.surface = () => projectInputSurface(h.session, h.observation);
  return h;
}

test('an idle repaint advances the output sequence and the prompt is still typed', async t => {
  const h = await composerFixture(t);
  const inputSurface = h.surface();
  assert.equal(inputSurface.composer.empty, true);
  // Thirty-five sparkle frames later: the counter moved, the input did not.
  h.observation.sequence = 42;
  const result = await h.input.handle(h.prompt('sparkle', { inputSurface }));
  assert.equal(result.status, 'written', JSON.stringify(result));
  assert.equal(h.writes.length, 1);
  const evidence = h.writes[0].interactionEvidence;
  assert.equal(evidence.sequence, 42, 'the write is fenced on the sequence just read, not the one the model echoed');
  assert.equal(evidence.surface.verified, true);
  assert.equal(evidence.surface.composerEmpty, true);
  assert.match(evidence.surface.fingerprint, /^[0-9a-f]{64}$/);
  // A caller that supplies no surface keeps the exact-counter fence it had.
  const legacy = await composerFixture(t);
  legacy.observation.sequence = 42;
  assert.equal((await legacy.input.handle(legacy.prompt('legacy'))).status, 'stale-observation');
  assert.equal(legacy.writes.length, 0);
});

for (const [name, change] of [
  ['the composer is no longer empty', o => { o.cursorContext = { ...o.cursorContext, rows: o.cursorContext.rows.map(row => row.replace('›', ' ')) }; }],
  ['the pane switched to its alternate screen', o => { o.alternateScreen = true; }],
  ['another request staged input', o => { o.interactionInputPending = true; }],
]) test(`a prompt is refused once ${name}`, async t => {
  const h = await composerFixture(t);
  const inputSurface = h.surface();
  change(h.observation); h.observation.sequence = 9;
  const result = await h.input.handle(h.prompt('changed', { inputSurface }));
  assert.equal(result.status, 'stale-observation');
  assert.equal(result.reason, 'surface-changed');
  assert.equal(result.delivery, 'not-dispatched');
  assert.ok(result.changed.length > 0, JSON.stringify(result.changed));
  // A diagnostic names fields, never a fragment of what is on the screen.
  for (const field of result.changed) assert.match(field, /^[a-zA-Z]+$/);
  assert.equal(JSON.stringify(result).includes('Ask Codex'), false);
  assert.equal(h.writes.length, 0);
});

for (const [name, change] of [
  ['the caret moved', o => { o.cursor = { x: 9, y: o.cursor.y }; }],
  ['what stands left of the caret changed', o => { o.cursorLine = { ...o.cursorLine, beforeCursor: '› dr' }; }],
  ['the caret was hidden', o => { o.cursorVisible = false; }],
]) test(`native menu keys stay strict when ${name}`, async t => {
  const h = await composerFixture(t);
  const inputSurface = h.surface();
  change(h.observation); h.observation.sequence = 9;
  const result = await h.input.handle(h.keys('menu', { inputSurface }));
  assert.equal(result.status, 'stale-observation');
  assert.equal(result.reason, 'surface-changed');
  assert.equal(h.writes.length, 0);
});

test('a baseline caught mid-frame still submits a prompt, and still refuses menu keys', async t => {
  // A read can land between the chunks of one synchronized frame, with the
  // cursor briefly hidden. For a prompt into a composer that is empty now, at
  // the same geometry and input revision, that is the same act; for a key,
  // whose meaning is whatever the screen under it says, it is not.
  const h = await composerFixture(t);
  const inputSurface = projectInputSurface(h.session, { ...h.observation, cursorVisible: false });
  assert.equal(inputSurface.cursorVisible, false);
  h.observation.sequence = 11;
  assert.equal((await h.input.handle(h.prompt('mid-frame', { inputSurface }))).status, 'written');
  const keys = await composerFixture(t);
  keys.observation.sequence = 11;
  const refused = await keys.input.handle(keys.keys('mid-frame-keys', { inputSurface: projectInputSurface(keys.session, { ...keys.observation, cursorVisible: false }) }));
  assert.equal(refused.status, 'stale-observation');
  assert.equal(refused.reason, 'surface-changed');
  assert.equal(keys.writes.length, 0);
});

test('a moved input revision is still its own reason and is never superseded', async t => {
  const h = await composerFixture(t);
  const inputSurface = h.surface();
  h.observation.inputRevision = 4; h.observation.sequence = 12;
  const result = await h.input.handle(h.prompt('typed-since', { inputSurface }));
  assert.equal(result.status, 'stale-observation');
  assert.equal(result.reason, 'input-revision-changed');
  assert.equal(h.writes.length, 0);
});

// The host cannot recompute a surface — it holds no decoder — so it validates
// the shape and acts on the one fact main signed: whether the composer was
// recognizably empty.

test('the host admits a surface-fenced write after the pane repainted and says how far output ran', () => {
  const h = host();
  h.terminal.data('repaint one'); h.terminal.data('repaint two');
  const evidence = { id: 'p', generation: 'g', pid: 42, sequence: 0, inputRevision: 0, observedAt: Date.now(), surface: hostSurface(true, 0) };
  const result = h.send('fenced', { operator: true, requestId: 'r', interactionEvidence: evidence });
  assert.equal(result.status, 'written');
  assert.equal(result.sequenceAtWrite, 2, 'two chunks of output arrived between the read and the write');
  assert.equal(result.surfaceFingerprint, evidence.surface.fingerprint);
  const plain = host();
  plain.terminal.data('repaint one');
  assert.equal(plain.send('unsigned', { operator: true, requestId: 'r',
    interactionEvidence: { id: 'p', generation: 'g', pid: 42, sequence: 0, inputRevision: 0, observedAt: Date.now(), surface: undefined } }).status, 'invalid-action',
    'there is no unfenced form left: a write without a captured surface is refused');
  assert.equal(plain.terminal.writes.length, 0);
});

test('the host refuses malformed surface evidence, or evidence with no input revision', () => {
  const h = host();
  const base = { id: 'p', generation: 'g', pid: 42, sequence: 0, inputRevision: 0, observedAt: Date.now() };
  for (const [name, surface] of [['not an object', 'yes'], ['unsigned', { ...hostSurface(true, 0), verified: false }],
    ['short fingerprint', { ...hostSurface(true, 0), fingerprint: 'abc' }], ['unknown composer', { ...hostSurface(true, 0), composerEmpty: 'maybe' }]]) {
    const result = h.send(`malformed-${name}`, { operator: true, requestId: 'r', interactionEvidence: { ...base, surface } });
    assert.equal(result.status, 'invalid-action', name);
  }
  assert.equal(h.send('no-revision', { interactionEvidence: { id: 'p', generation: 'g', pid: 42, sequence: 0, observedAt: Date.now(), inputRevision: undefined, surface: hostSurface(true, 0) } }).status, 'stale-observation');
  assert.equal(h.terminal.writes.length, 0);
});

test('a keystroke latch yields to a composer proved empty and blocks over anything else', () => {
  const h = host();
  h.manual('\x1b[A'); // one arrow key: no draft, but the latch is set
  assert.equal(h.events.filter(e => e.type === 'input-state').at(-1).manualInputPending, true);
  const evidence = empty => ({ id: 'p', generation: 'g', pid: 42, sequence: h.events.filter(e => e.type === 'data').at(-1)?.sequence || 0,
    inputRevision: h.events.filter(e => e.type === 'input-state').at(-1).inputRevision, observedAt: h.now(), surface: hostSurface(empty, 0) });
  assert.equal(h.send('occupied', { operator: true, requestId: 'r', interactionEvidence: evidence(false) }).status, 'input-buffer-occupied');
  assert.equal(h.terminal.writes.length, 1, 'only the arrow key the user pressed');
  const result = h.send('empty', { operator: true, requestId: 'r', text: 'say hi', keys: [], submit: true, interactionEvidence: evidence(true) });
  assert.equal(result, h.events.at(-1));
  const cleared = h.events.filter(e => e.type === 'input-state').at(-1);
  assert.equal(cleared.manualInputPending, false, 'the published input state reflects the clear');
  assert.equal(h.advance(200).status, 'written');
  assert.deepEqual(h.terminal.writes, ['\x1b[A', 'say hi', '\r']);
  // A real draft typed after the clear latches the pane again.
  h.manual('draft');
  assert.equal(h.send('after-draft', { operator: true, requestId: 'r',
    interactionEvidence: { ...evidence(false), inputRevision: h.events.filter(e => e.type === 'input-state').at(-1).inputRevision } }).status, 'input-buffer-occupied');
});

test('terminal helper propagates action abort and disposal through in-flight writes', async () => {
  for (const mode of ['abort', 'dispose']) {
    const controller = new AbortController(); let signal;
    const h = fixture({ write: payload => { signal = payload.signal; return new Promise(resolve => signal.addEventListener('abort', () => resolve({ ok: false, status: 'unknown', partialWrite: true, submission: 'unconfirmed' }), { once: true })); } });
    const pending = h.input.handle(h.action('split', { text: 'task', keys: [], submit: true, signal: controller.signal }));
    await new Promise(setImmediate); assert.equal(signal.aborted, false);
    if (mode === 'abort') controller.abort(); else h.input.dispose();
    assert.equal(signal.aborted, true); const result = await pending; assert.equal(result.status, 'unknown'); assert.equal(result.partialWrite, true);
  }
});
