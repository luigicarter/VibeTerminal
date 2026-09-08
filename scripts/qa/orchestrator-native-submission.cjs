#!/usr/bin/env node
'use strict';
// Opt-in native integration check. No credentials, remote provider, or model output.
// node scripts/qa/orchestrator-native-submission.cjs --codex C:/path/to/codex.exe
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const repo = path.resolve(__dirname, '../..');
const hostPath = path.join(repo, 'backend/ptyHost.cjs');
const hostRequire = createRequire(hostPath);
const flag = process.argv.indexOf('--codex');
if (flag < 0 || !process.argv[flag + 1]) throw Error('Opt-in requires --codex with an explicit native executable path.');
const executable = path.resolve(process.argv[flag + 1]);
if (!fs.statSync(executable).isFile()) throw Error('Native Codex executable not found.');
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim();
const root = path.join(repo, '.tmp', `orchestrator-native-submission-${Date.now()}-${process.pid}`);
const home = path.join(root, 'home'), cwd = path.join(root, 'workspace');
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
execFileSync('git', ['init', '--quiet', cwd], { timeout: 10000 });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { version, executable, root, cases: [], requests: [], cleanup: {} };
const events = [], writes = []; let child, context, exited = false;
const screen = new Terminal({ cols: 110, rows: 35, allowProposedApi: true });
const screenText = () => Array.from({ length: screen.buffer.active.length }, (_, i) => screen.buffer.active.getLine(i)?.translateToString(true) || '').join('\n');
const snapshot = label => fs.writeFileSync(path.join(root, `${label}.txt`), screenText());
async function until(predicate, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; if (exited) throw Error(`Native process exited while ${description}`); await wait(40); }
  snapshot('failure'); throw Error(`Timed out: ${description}`);
}
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const markers = [...new Set(body.toString('utf8').match(/native transport probe (?:interaction|input)-(?:raw|bracketed)/g) || [])];
    report.requests.push({ at: Date.now(), method: req.method, url: req.url, bytes: body.length, encoding: req.headers['content-encoding'], markers });
    fs.writeFileSync(path.join(root, `request-${report.requests.length}.bin`), body);
    // No successful response or tool calls can reach the CLI.
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'LOCAL PROBE: submission observed', type: 'invalid_request_error' } }));
  });
});
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "probe"\nmodel_provider = "probe"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[model_providers.probe]\nname = "Local probe"\nbase_url = "${endpoint}"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  // Construct a minimal environment: never inherit auth, provider, Codex, or profile overrides.
  const env = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'), TERM: 'xterm-256color', NO_COLOR: '1' });
  context = vm.createContext({
    require(name) {
      if (name === 'readline') return { createInterface: () => ({ on() {} }) };
      if (name !== 'node-pty') return hostRequire(name);
      return { spawn() {
        child = pty.spawn(executable, ['--no-alt-screen', '--ask-for-approval', 'never'], { cols: 110, rows: 35, cwd, env, name: 'xterm-256color' });
        report.pid = child.pid;
        const nativeWrite = child.write.bind(child);
        child.write = data => { writes.push({ at: Date.now(), data }); nativeWrite(data); };
        child.onExit(event => { exited = true; report.exit = event; });
        child.onData(data => {
          fs.appendFileSync(path.join(root, 'native.raw.txt'), data); screen.write(data);
          if (data.includes('\x1b[6n')) child.write('\x1b[1;1R');
        });
        return child;
      } };
    },
    process: { platform: process.platform, env: {}, stdin: {}, cwd: () => cwd, kill: process.kill.bind(process), stdout: { write(line) { const event = JSON.parse(line); events.push(event); fs.appendFileSync(path.join(root, 'host.jsonl'), line); } } },
    setTimeout, clearTimeout, setInterval, clearInterval, Buffer, console
  });
  vm.runInContext(fs.readFileSync(hostPath, 'utf8'), context, { filename: hostPath });
  context.handleMessage({ type: 'create', payload: { id: 'probe', generation: 'probe-generation', launchToken: 1, cwd, cols: 110, rows: 35 } });
  await wait(1800); // The first composer frame may precede fresh-home onboarding.
  // Composer placeholder copy rotates between starts. Match its prompt and
  // the configured local-only model, then prove submission via HTTP below.
  const composerReady = () => /(?:^|\n)\s*›(?:\s|$)/.test(screenText()) && /model:\s+probe\b/.test(screenText());
  await until(() => /Do you trust|Set up the Codex agent sandbox/.test(screenText()) || composerReady(), 'initial native screen');
  if (/Do you trust/.test(screenText())) { child.write('\r'); await wait(800); }
  await until(() => /Set up the Codex agent sandbox/.test(screenText()) || composerReady(), 'composer or sandbox onboarding');
  if (/Set up the Codex agent sandbox/.test(screenText())) { child.write('\x1b'); await wait(500); }
  await until(composerReady, 'ready composer');
  snapshot('startup');
  for (const kind of ['interaction', 'input']) for (const bracketedPaste of [false, true]) {
    const label = `${kind}-${bracketedPaste ? 'bracketed' : 'raw'}`, text = `native transport probe ${label}`;
    // Deliberately select host encoding mode; the real native recipient is unchanged.
    vm.runInContext(`sessions.get('probe').bracketedPaste = ${bracketedPaste}`, context);
    const state = vm.runInContext(`(() => { const s=sessions.get('probe'); return {sequence:s.sequence,inputRevision:s.inputRevision,cols:s.cols,rows:s.rows}; })()`, context);
    const common = { id: 'probe', generation: 'probe-generation', actionId: label, expectedAgentPid: child.pid };
    const payload = kind === 'interaction' ? { ...common, kind, text, submit: true, operator: true, requestId: label,
      interactionEvidence: { ...state, id: common.id, generation: common.generation, pid: child.pid, observedAt: Date.now() } }
      : { ...common, kind, data: text + '\r', promptText: text, recipientEvidence: { generation: common.generation, pid: child.pid, state: 'idle', observedAt: Date.now() } };
    const before = report.requests.length, writeBefore = writes.length, startedAt = Date.now();
    context.handleMessage({ type: 'action', payload });
    await until(() => events.some(e => e.type === 'action-result' && e.actionId === label), `${label} host acknowledgment`);
    const receipt = events.find(e => e.type === 'action-result' && e.actionId === label);
    assert.equal(receipt.status, 'written', JSON.stringify(receipt));
    const matchingRequests = () => report.requests.slice(before).filter(request => request.method === 'POST' && request.url === '/v1/responses' && request.markers.includes(text));
    await until(() => matchingRequests().length > 0, `${label} native submission without recovery Enter`, 7000);
    await wait(1200);
    const count = report.requests.length - before;
    const actionWrites = writes.slice(writeBefore);
    report.cases.push({ label, startedAt, receipt, requestCount: count, writes: actionWrites }); snapshot(label);
    assert.equal(actionWrites.length, 2, `${label}: only the text and final Enter may be written`);
    assert.equal(actionWrites[0].data, bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text);
    assert.equal(actionWrites.filter(write => write.data === '\r').length, 1, `${label}: expected exactly one standalone submission Enter`);
    assert.ok(actionWrites[1].at - actionWrites[0].at >= 200, `${label}: native submission must wait at least 200 ms`);
    assert.equal(events.filter(e => e.type === 'action-result' && e.actionId === label).length, 1);
    assert.match(screenText(), /LOCAL PROBE: submission observed|400/);
    console.log(`PASS ${label}: one submission Enter, ${count} local provider request(s)`);
  }
  report.ok = true;
}
run().catch(error => { report.ok = false; report.error = error.stack; process.exitCode = 1; console.error(error.message); }).finally(async () => {
  if (child && !exited) {
    try { child.write('\x03'); await wait(200); if (!exited) child.write('\x03'); await wait(400); } catch (error) { report.cleanup.gracefulError = error.message; }
    if (!exited) { try { child.kill(); } catch (error) { report.cleanup.killError = error.message; } await wait(400); }
    try { process.kill(child.pid, 0); report.cleanup.pidAlive = true; process.exitCode = 1; } catch { report.cleanup.pidAlive = false; }
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); screen.dispose();
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Artifacts: ${root}`);
});
