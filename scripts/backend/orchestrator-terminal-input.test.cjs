'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createTerminalInput } = require('../../backend/orchestratorTerminalInput.cjs');
function fixture(overrides = {}) {
  const session = { id: 'p', generation: 'g', revision: 1, provider: 'codex', kind: 'codex', processState: 'running', agentProcessState: 'running', agentPid: 42, turnState: 'waiting' };
  const observation = { ok: true, id: 'p', generation: 'g', sequence: 7 }; const writes = [];
  const input = createTerminalInput({ getSession: () => session, readSession: async () => observation, write: async payload => { writes.push(payload); return { ok: true, status: 'written', delivery: 'pty-transport-only' }; }, now: () => 1000, ...overrides });
  return { input, session, observation, writes, action: (actionId, rest = {}) => ({ target: { id: 'p', generation: 'g' }, actionId, observationSequence: 7, keys: ['down'], ...rest }) };
}
test('waiting native menus allow bounded navigation, preserve evidence and deduplicate', async () => {
  const h = fixture(); const a = h.action('one');
  const result = await h.input.handle(a); assert.equal(result.status, 'written'); assert.equal(result.delivery, 'pty-transport-only');
  assert.deepEqual(await h.input.handle(a), result); assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].kind, 'interaction'); assert.deepEqual(h.writes[0].interactionEvidence, { id: 'p', generation: 'g', pid: 42, sequence: 7, revision: 1, observedAt: 1000, shell: false });
  assert.equal((await h.input.handle(h.action('two', { text: 'literal answer', keys: [], submit: true }))).status, 'written');
});
test('stale screen, wrong generation, stopped/rootless/chat panes and runtime changes reject before writes', async () => {
  for (const patch of [{ generation: 'new' }, { processState: 'exited' }, { agentPid: undefined }, { agentProcessState: 'unknown' }, { kind: 'fusion' }, { binding: { status: 'ambiguous' } }, { childActivity: true }]) {
    const h = fixture(); Object.assign(h.session, patch); assert.equal((await h.input.handle(h.action('one'))).ok, false); assert.equal(h.writes.length, 0);
  }
  const h = fixture(); h.observation.sequence++; assert.equal((await h.input.handle(h.action('stale'))).status, 'stale-observation');
  const changed = fixture({ readSession: async () => { changed.session.revision++; return changed.observation; } });
  assert.equal((await changed.input.handle(changed.action('changed'))).ok, false); assert.equal(changed.writes.length, 0);
});
test('literal inputs reject controls, multiline, excess bytes and unknown or excessive keys', async () => {
  const h = fixture();
  for (const [i, patch] of [{ text: 'x\x1b[A' }, { text: 'one\ntwo' }, { text: '😀'.repeat(1025) }, { keys: ['ctrl-c'] }, { keys: Array(17).fill('up') }, { submit: 'yes' }, { observationSequence: -1 }].entries()) assert.equal((await h.input.handle(h.action(String(i), patch))).status, 'invalid-action');
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
  const context = vm.createContext({ require: name => name === 'node-pty' ? { spawn() { const terminal = { pid: 42, writes: [], onData(fn) { this.data = fn; }, onExit() {}, resize() {}, kill() {}, write(data) { this.writes.push(data); if (this.fail) throw Error('transport uncertain'); } }; terminals.push(terminal); return terminal; } } : name === 'readline' ? { createInterface: () => ({ on() {} }) } : require(name), process: { platform: 'win32', env: {}, stdin: {}, cwd: () => process.cwd(), stdout: { write: line => events.push(JSON.parse(line)) }, kill() { if (dead) throw Error('gone'); } }, setTimeout() {} });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../backend/ptyHost.cjs'), 'utf8'), context);
  context.handleMessage({ type: 'create', payload: { id: 'p', generation: 'g', launchToken: 1 } });
  const send = (actionId, fields = {}) => { context.handleMessage({ type: 'action', payload: { kind: 'interaction', id: 'p', generation: 'g', actionId, expectedAgentPid: 42, interactionEvidence: { id: 'p', generation: 'g', pid: 42, sequence: events.filter(e => e.type === 'data').at(-1)?.sequence || 0, observedAt: Date.now() }, keys: ['down'], ...fields } }); return events.at(-1); };
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
  assert.equal(h.send('oversized', { text: '😀'.repeat(1025) }).status, 'invalid-action');
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
