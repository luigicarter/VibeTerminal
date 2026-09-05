'use strict';
// Real Electron UI + native Codex history, isolated from user profiles. The main
// wrapper counts actual IPC reads and blocks provider fetches; it does not fake history.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp', 'history-live-smoke', `${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true });
const result = { output, checks: [], sourceMutations: [] };
const userData = path.join(output, 'userData'), codexHome = path.join(output, 'codex');
const trace = path.join(output, 'events.jsonl');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 10000) { let last; for (const end = Date.now() + ms; Date.now() < end;) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await wait(150); } throw Error(`Timeout: ${label}; ${last || ''}`); }
class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.pending = new Map(); this.n = 0; }
  async open() { await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); }); this.ws.addEventListener('message', event => { const packet = JSON.parse(String(event.data)), pending = this.pending.get(packet.id); if (pending) { this.pending.delete(packet.id); packet.error ? pending.reject(Error(packet.error.message)) : pending.resolve(packet.result); } }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.n; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails)); return response.result.value; }
  close() { this.ws.close(); }
}
const events = () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const reads = () => events().filter(event => event.kind === 'read_conversation').length;
const record = (name, value) => { result.checks.push({ name, value }); console.log(name, JSON.stringify(value)); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const entry = path.join(output, 'main.cjs');
fs.writeFileSync(entry, `
const fs=require('node:fs'),electron=require('electron');
const log=value=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(value)+'\\n');
const handle=electron.ipcMain.handle.bind(electron.ipcMain);
electron.ipcMain.handle=(channel,listener)=>handle(channel,async(event,...args)=>{if(channel==='orchestrator:dispatch')log({kind:args[0]?.kind,time:Date.now()});return listener(event,...args);});
globalThis.fetch=async(url)=>{log({blockedNetwork:String(url)});throw Error('History QA forbids network requests');};
require(${JSON.stringify(path.join(root, 'backend/main.cjs'))});
`);
let child, cdp, fixture, expected;
const selector = '[aria-label="Saved conversation messages"]';
async function snapshot() { return cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&{text:e.textContent,messages:Array.from(e.children).map(n=>n.lastElementChild?.textContent),top:e.scrollTop,height:e.scrollHeight,viewport:e.clientHeight};})()`); }
async function clickButton(text) { await cdp.eval(`(()=>{const e=Array.from(document.querySelectorAll('.workspace-tools-panel button,.conversation-history button,[role=tab]')).find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing button '+${JSON.stringify(text)});e.click();})()`); }
async function screenshot(name) { const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, name), Buffer.from(shot.data, 'base64')); }
function verifySource() { assert.equal(digest(fs.readFileSync(fixture)), digest(Buffer.from(expected)), 'History must not mutate the native rollout'); }
function mutate(label, records, append = false) {
  if (expected !== undefined) verifySource();
  const bytes = records.map(record => JSON.stringify(record)).join('\n') + '\n';
  if (append) { fs.appendFileSync(fixture, bytes); expected += bytes; } else { fs.writeFileSync(fixture, bytes); expected = bytes; }
  result.sourceMutations.push({ label, sha256: digest(Buffer.from(expected)), bytes: Buffer.byteLength(expected) });
}
const message = (id, role, text) => ({ timestamp: new Date().toISOString(), type: 'response_item', payload: { id, type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
(async () => { try {
  assert.equal(process.platform, 'win32');
  assert(!process.argv.includes('--packaged'), 'This instrumented QA runs the development Electron build.');
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  const env = { ...process.env, VIBE_SCREENSHOT_MODE: '1', VIBE_INTERNAL_SCREENSHOT: '0', VIBE_SCREENSHOT_USER_DATA: userData, VIBE_AGENT_SHIM_BASE_DIR: path.join(output, 'shims'), CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: path.join(output, 'claude'), XDG_CONFIG_HOME: path.join(output, 'config'), XDG_DATA_HOME: path.join(output, 'data') };
  for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN/.test(key) || ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL'].includes(key)) delete env[key];
  child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [entry, `--remote-debugging-port=${port}`], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(output, 'electron.log')); child.stdout.pipe(log); child.stderr.pipe(log);
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page => page.type === 'page' && page.url.startsWith('file:') && !page.url.includes('surface=voice')), 'main renderer', 30000);
  cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.open(); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await until(() => cdp.eval('Boolean(window.vibe?.orchestrator && document.querySelector(\'[aria-label="Open workspace tools"]\'))'), 'workspace UI', 30000);
  const state = await cdp.eval('window.vibe.orchestrator.getState()'); assert.equal(state.enabled, false); assert.equal(state.settings.hasKey, false);
  const project = await cdp.eval(`window.vibe.orchestrator.dispatch({kind:'create_project',parent:${JSON.stringify(path.join(userData, 'Documents'))},name:'History QA'})`);
  assert.equal(project.ok, true, JSON.stringify(project));
  const id = '12345678-1234-4234-8234-123456789abc', date = new Date().toISOString();
  const folder = path.join(codexHome, 'sessions', ...date.slice(0, 10).split('-')); fs.mkdirSync(folder, { recursive: true });
  fixture = path.join(folder, `rollout-${date.replace(/:/g, '-')}-${id}.jsonl`);
  const earlier = 'EARLIER START 🧠\n' + '内容😀\r\n'.repeat(9000) + ' EARLIER END';
  const initial = [ { type: 'session_meta', payload: { id, session_id: id, cwd: project.path, name: 'History live QA', timestamp: date, originator: 'Codex CLI' } }, message('earlier', 'user', earlier), message('latest', 'assistant', 'INITIAL LATEST reply') ];
  mutate('initial', initial);
  await cdp.eval('document.querySelector(\'[aria-label="Open workspace tools"]\').click()');
  await until(() => cdp.eval('Boolean(document.querySelector(".workspace-tools-heading"))'), 'workspace tools');
  await cdp.eval(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='History').click()`);
  await until(() => cdp.eval(`Array.from(document.querySelectorAll('.conversation-history-item')).some(e=>e.textContent.includes('History live QA'))`), 'fixture listed');
  await cdp.eval(`Array.from(document.querySelectorAll('.conversation-history-item')).find(e=>e.textContent.includes('History live QA')).click()`);
  await until(async () => (await snapshot())?.text.includes('INITIAL LATEST reply'), 'recent transcript');
  const recent = await snapshot(); assert(!recent.text.includes('EARLIER START')); assert(recent.height - recent.top - recent.viewport < 3); record('recent-at-bottom', { chars: recent.text.length });
  const appended = message('append-one', 'assistant', 'LIVE APPEND ONE'); const start = Date.now(); mutate('append live', [appended], true);
  await until(async () => (await snapshot())?.text.includes('LIVE APPEND ONE'), 'automatic appended message');
  const live = await snapshot(); assert(live.height - live.top - live.viewport < 3); record('live-append-bottom-follow', { elapsedMs: Date.now() - start }); await screenshot('live-bottom.png');
  for (let i = 0; i < 8 && !(await snapshot()).text.includes('EARLIER START'); i++) {
    const before = (await snapshot()).text.length; await clickButton('Load earlier'); await until(async () => (await snapshot())?.text.length > before, 'earlier page');
  }
  const full = await snapshot(); assert(full.messages.includes(earlier), 'Unicode earlier message must reconstruct exactly');
  await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollTop=120;e.dispatchEvent(new Event('scroll'));})()`);
  const browsing = await snapshot(); const second = message('append-two', 'assistant', 'LIVE APPEND TWO'); mutate('append while browsing', [second], true);
  await until(() => cdp.eval(`Array.from(document.querySelectorAll('.conversation-history button')).some(e=>e.textContent==='Conversation updated')`), 'update indicator');
  const preserved = await snapshot(); assert.equal(preserved.text, browsing.text); assert.equal(preserved.top, browsing.top); record('earlier-unicode-and-scroll-preserved', { chars: earlier.length, scrollTop: preserved.top }); await screenshot('browsing-update.png');
  await clickButton('Conversation updated'); await until(async () => (await snapshot())?.text.includes('LIVE APPEND TWO'), 'update button resumes latest');
  const third = message('append-three', 'assistant', 'LIVE APPEND THREE'); mutate('append after resuming', [third], true); await until(async () => (await snapshot())?.text.includes('LIVE APPEND THREE'), 'live following resumed');
  await clickButton('Latest'); await until(async () => { const s = await snapshot(); return s && s.height - s.top - s.viewport < 3; }, 'Latest bottom');
  const edited = { ...third, payload: { ...third.payload, content: [{ type: 'output_text', text: 'EDITED SAME ID THREE' }] } };
  mutate('replace same native message ID', [...initial, appended, second, edited]);
  await until(async () => (await snapshot())?.text.includes('EDITED SAME ID THREE'), 'edited transcript live replacement');
  const replacement = await snapshot(); assert(!replacement.text.includes('LIVE APPEND THREE')); assert.equal(replacement.messages.filter(text => text === 'EDITED SAME ID THREE').length, 1); record('same-id-edit-replaces-without-duplicate', true); await screenshot('edited-live.png');
  verifySource(); await cdp.eval('document.querySelector(\'[aria-label="Close workspace tools"]\').click()');
  await until(() => cdp.eval(`!document.querySelector(${JSON.stringify(selector)})`), 'History closed'); await wait(1200);
  const closedReads = reads(); mutate('append while closed', [message('closed', 'assistant', 'CLOSED APPEND')], true); await wait(2500);
  assert.equal(reads(), closedReads, 'Closing History must stop read polling'); assert(closedReads > 3); verifySource();
  assert.equal(events().filter(event => event.blockedNetwork).length, 0, 'No provider network request should be attempted');
  assert.equal((await cdp.eval('window.vibe.voice.getState()')).listening, false);
  record('closed-stops-polling-no-network-no-voice', { readCalls: closedReads }); result.pass = true;
} catch (error) { result.pass = false; result.error = error.stack; console.error(error.stack); process.exitCode = 1; if (cdp) try { await screenshot('failure.png'); } catch {} }
finally { if (fixture && expected !== undefined) { result.expectedSourceSha256 = digest(Buffer.from(expected)); result.actualSourceSha256 = digest(fs.readFileSync(fixture)); } fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2)); cdp?.close(); if (child?.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); console.log(`Artifacts: ${output}`); } })();
