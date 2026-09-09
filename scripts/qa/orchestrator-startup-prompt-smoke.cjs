'use strict';
// Real PTY and decoder with a deliberately slow local CLI. No model, API key,
// user profile, or user terminal is used. Startup is advanced by explicit gates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pty = require('node-pty');
const { createTerminalObservation } = require('../../backend/terminalObservation.cjs');
const { createTerminalInput } = require('../../backend/orchestratorTerminalInput.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp', 'orchestrator-startup-prompt-smoke', `${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true });
const phaseFile = path.join(output, 'phase.json'), receivedFile = path.join(output, 'received.jsonl');
const stubFile = path.join(output, 'slow-cli.cjs');
fs.writeFileSync(phaseFile, JSON.stringify({ phase: 'shell' }));
fs.writeFileSync(stubFile, `
const fs = require('node:fs');
const phaseFile = ${JSON.stringify(phaseFile)}, receivedFile = ${JSON.stringify(receivedFile)};
let phase = '', input = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', data => {
  const text = data.toString();
  fs.appendFileSync(receivedFile, JSON.stringify({phase,text})+'\\n');
  input += text;
  if (text.includes('\\r')) process.stdout.write('\\r\\nSUBMITTED: '+input.trim()+'\\r\\n');
});
function render() {
  const next = JSON.parse(fs.readFileSync(phaseFile,'utf8')).phase;
  if (next === phase) return;
  phase = next;
  if (phase==='stop') process.exit(0);
  const header = '\\x1b[2J\\x1b[HOpenAI Codex (local startup fixture)\\r\\nmodel: '+(phase==='loading'?'loading':'fixture')+'\\r\\n\\r\\n';
  if (phase==='shell') process.stdout.write('\\x1b[2J\\x1b[HPS C:\\\\fixture> \\x1b[?25h');
  else process.stdout.write(header+'› '+(phase==='ready'?'':'Ask Codex to do anything')+'\\x1b[4;3H'+(phase==='hidden'?'\\x1b[?25l':'\\x1b[?25h'));
}
render(); setInterval(render,20);
`);
const report = { output, mode: 'local delayed CLI; real PTY and decoded screen', checks: [] };
const observation = createTerminalObservation();
const session = { id: 'slow-native', generation: 'slow-g1', launchToken: 1, provider: 'codex', kind: 'codex',
  started: true, processState: 'running', launchState: 'ready', agentProcessState: 'running',
  observation: 'observed', turnState: 'unknown', cols: 110, rows: 35 };
let child, input, sequence = 0, exited = false;
const writes = [], wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = () => observation.read({ id: session.id, generation: session.generation });
async function until(predicate, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; if (exited) throw Error(`CLI exited during ${label}`); await wait(20); }
  throw Error(`Timed out: ${label}`);
}
function check(name, value) { report.checks.push({ name, value }); console.log(name, JSON.stringify(value)); }
async function phase(name, visible) {
  fs.writeFileSync(phaseFile, JSON.stringify({ phase: name }));
  await until(async () => { const screen = await read(); return screen.text.includes(name === 'loading' ? 'model: loading' : 'model: fixture') && screen.cursorVisible === visible; }, name);
}
(async () => { try {
  const env = {};
  for (const key of ['SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','PATH','PATHEXT','TEMP','TMP']) if (process.env[key]) env[key] = process.env[key];
  await observation.ingest({ type: 'created', ...session, inputRevision: 0 });
  child = pty.spawn(process.execPath, [stubFile], { cwd: output, cols: session.cols, rows: session.rows, name: 'xterm-256color', env });
  session.agentPid = child.pid;
  report.pid = child.pid;
  child.onExit(() => { exited = true; });
  child.onData(data => { void observation.ingest({ type: 'data', id: session.id, generation: session.generation, sequence: ++sequence, data }); });
  await until(async () => (await read()).text.includes('PS C:'), 'shell frame before native CLI');
  input = createTerminalInput({ getSession: () => session, readSession: read,
    startupTimeoutMs: 5000, startupPollMs: 20,
    write: async payload => { writes.push(payload); child.write(payload.text + (payload.submit ? '\r' : '')); return { ok: true, status: 'written', delivery: 'pty-transport-only' }; } });
  input.trackStartup({ id: session.id, generation: session.generation, launchToken: session.launchToken });
  const first = await read();
  const action = { target: { id: session.id, generation: session.generation }, actionId: 'initial-prompt', requestId: 'startup-request',
    operator: true, promptSubmission: true, text: 'Verify startup prompt delivery once', submit: true,
    observationSequence: first.sequence, inputRevision: first.inputRevision };
  let settled = false;
  const sending = input.handle(action).then(result => { settled = true; return result; });
  await wait(100);
  assert.equal(settled, false, 'shell readiness must not release native agent input'); assert.equal(writes.length, 0);
  check('no-input-at-shell-before-cli', true);
  await phase('loading', true); await wait(100);
  assert.equal(settled, false, 'a visible prompt while the model loads is not ready'); assert.equal(writes.length, 0);
  check('no-input-while-model-loading', true);
  await phase('hidden', false); await wait(100);
  assert.equal(settled, false, 'a disabled hidden cursor must not release input'); assert.equal(writes.length, 0);
  assert.equal(fs.existsSync(receivedFile), false, 'the CLI must receive no early bytes');
  check('no-input-at-disabled-composer', true);
  await phase('ready', true);
  const result = await sending;
  assert.equal(result.status, 'written', JSON.stringify(result)); assert.equal(writes.length, 1);
  await until(() => fs.existsSync(receivedFile) && fs.readFileSync(receivedFile,'utf8').includes('Verify startup prompt delivery once'), 'native prompt receipt');
  assert.deepEqual(await input.handle(action), result); assert.equal(writes.length, 1, 'same action must not send twice');
  const chunks = fs.readFileSync(receivedFile,'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert(chunks.every(chunk => chunk.phase === 'ready'));
  assert.equal(chunks.map(chunk => chunk.text).join(''), action.text+'\r');
  check('exactly-one-complete-prompt-after-ready', { status: result.status, chunks });
  report.pass = true;
} catch (error) { report.pass = false; report.error = error.stack; process.exitCode = 1; console.error(error.stack); }
finally {
  input?.dispose();
  if (child && !exited) {
    fs.writeFileSync(phaseFile, JSON.stringify({ phase: 'stop' }));
    const cleanupEnd = Date.now() + 2000;
    while (!exited && Date.now() < cleanupEnd) await wait(20);
    if (!exited) child.kill();
  }
  if (child) {
    try { process.kill(child.pid, 0); report.cleanup = 'child-still-running'; report.pass = false; process.exitCode = 1; }
    catch (error) { report.cleanup = error.code === 'ESRCH' ? 'child-exited' : 'child-state-unverified'; if (report.cleanup !== 'child-exited') { report.pass = false; process.exitCode = 1; } }
  }
  observation.dispose();
  fs.writeFileSync(path.join(output,'results.json'), JSON.stringify(report,null,2));
  console.log(`Artifacts: ${output}`);
  // node-pty can retain its Windows console worker after the owned child exits.
  // The process check above is mandatory before terminating this test driver.
  if (!child || report.cleanup === 'child-exited') process.exit(process.exitCode || 0);
} })();
