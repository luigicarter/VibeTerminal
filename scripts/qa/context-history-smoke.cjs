'use strict';
// Isolated real Electron history pagination/search QA. Provider fetches are blocked;
// voice stays disabled. Audio playback is covered by voice-experience-smoke.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp', 'context-history-smoke', `${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true });
const result = { output, checks: [], limits: ['Provider requests are blocked; model context selection is covered by backend tests.', 'Voice remains disabled; this does not test microphone capture or playback.'] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 30000) { let last; const end = Date.now() + ms; while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await wait(150); } throw Error(`Timeout: ${label}; ${last || ''}`); }
class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.pending = new Map(); this.n = 0; }
  async open() { await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); }); this.ws.addEventListener('message', event => { const packet = JSON.parse(String(event.data)), pending = this.pending.get(packet.id); if (pending) { this.pending.delete(packet.id); packet.error ? pending.reject(Error(packet.error.message)) : pending.resolve(packet.result); } }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.n; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
  close() { this.ws.close(); }
}
function record(name, value) { result.checks.push({ name, value }); console.log(name, JSON.stringify(value)); }
const userData = path.join(output, 'userData'), trace = path.join(output, 'network.jsonl');
const id = '33333333-3333-4333-8333-333333333333', project = path.join(userData, 'Documents', 'Context History QA');
const historyRoot = path.join(output, 'codex', 'sessions', '2026', '09', '05');
fs.mkdirSync(historyRoot, { recursive: true });
const early = 'EARLY_CONTEXT_MARKER_5937';
const longMessage = early + '\n' + Array.from({ length: 1650 }, (_, i) => `${String(i).padStart(4, '0')}: Unicode café 漢字 🧪 intact.\n`).join('');
const latest = 'LATEST_CONTEXT_MARKER_9271';
const historyFile = path.join(historyRoot, `rollout-2026-09-05T00-00-00-${id}.jsonl`);
fs.writeFileSync(historyFile, [{ type: 'session_meta', payload: { id, cwd: project, name: 'Progressive history fixture', timestamp: new Date().toISOString(), originator: 'Codex CLI' } }, ...[longMessage, latest].map((text, i) => ({ type: 'response_item', payload: { type: 'message', role: i ? 'assistant' : 'user', content: [{ type: i ? 'output_text' : 'input_text', text }] } }))].map(r => JSON.stringify(r)).join('\n') + '\n');
const hash = () => createHash('sha256').update(fs.readFileSync(historyFile)).digest('hex'), beforeHash = hash();
const entry = path.join(output, 'main.cjs');
fs.writeFileSync(entry, `const fs=require('node:fs');
globalThis.fetch=async(url)=>{fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({blockedNetwork:String(url)})+'\\n');throw Error('Context/history QA forbids provider requests');};
require(${JSON.stringify(path.join(root, 'backend/main.cjs'))});
`);
let child, cdp;
const button = text => cdp.eval(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(text)});if(!e||e.disabled)return false;e.click();return true})()`);
const reader = () => cdp.eval(`Array.from(document.querySelector('[aria-label="Saved conversation messages"]')?.children||[]).filter(e=>e.tagName==='DIV').map(e=>e.lastElementChild.textContent)`);
async function screenshot(client, name) { const s = await client.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, name), Buffer.from(s.data, 'base64')); }
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
(async () => { try {
  assert.equal(process.platform, 'win32');
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  const env = { ...process.env, VIBE_SCREENSHOT_MODE: '1', VIBE_INTERNAL_SCREENSHOT: '0', VIBE_SCREENSHOT_USER_DATA: userData, VIBE_AGENT_SHIM_BASE_DIR: path.join(output, 'shims'), CODEX_HOME: path.join(output, 'codex'), CLAUDE_CONFIG_DIR: path.join(output, 'claude'), XDG_CONFIG_HOME: path.join(output, 'config'), XDG_DATA_HOME: path.join(output, 'data'), KIMI_CODE_HOME: path.join(output, 'kimi'), QWEN_HOME: path.join(output, 'qwen'), GEMINI_CLI_HOME: path.join(output, 'gemini'), CURSOR_CONFIG_DIR: path.join(output, 'cursor'), VIBE_CLAUDE_CUSTOM_HOME: path.join(output, 'claude-custom') };
  for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN/.test(key) || ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL'].includes(key) || key.toLowerCase() === 'path') delete env[key];
  env.PATH = [path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot, path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter);
  env.VIBE_NODE_PATH = process.execPath;
  const executable = path.join(root, 'node_modules/electron/dist/electron.exe');
  assert(fs.existsSync(executable), 'Electron test runtime missing. Run node node_modules/electron/install.js first.');
  child = spawn(executable, [entry, `--remote-debugging-port=${port}`], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(output, 'electron.log')); child.stdout.pipe(log); child.stderr.pipe(log);
  const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
  const page = await until(async () => (await pages()).find(p => p.type === 'page' && p.url.startsWith('file:') && !p.url.includes('surface=voice')), 'main page');
  cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.open();
  await until(() => cdp.eval(`Boolean(window.vibe?.orchestrator && document.querySelector('[aria-label="Open workspace tools"]'))`), 'UI ready');
  assert.equal((await cdp.eval('window.vibe.orchestrator.getState()')).enabled, false);
  const created = await cdp.eval(`window.vibe.orchestrator.dispatch(${JSON.stringify({ kind: 'create_project', parent: path.join(userData, 'Documents'), name: 'Context History QA' })})`);
  assert.equal(created.ok, true, JSON.stringify(created));
  await cdp.eval(`document.querySelector('[aria-label="Open workspace tools"]').click()`);
  await until(() => cdp.eval('Boolean(document.querySelector(".workspace-tools-heading"))'), 'workspace tools');
  await cdp.eval("Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='History').click()");
  await until(() => cdp.eval("Boolean(document.querySelector('.conversation-history-item'))"), 'fixture history');
  await cdp.eval("document.querySelector('.conversation-history-item').click()");
  const recent = await until(async () => { const messages = await reader(); return messages.some(s => s.includes(latest)) && messages; }, 'latest history');
  assert(!recent.join('').includes(early)); assert(recent.join('').length <= 16000);
  record('recent-page-bounded', { characters: recent.join('').length, fullMessageCharacters: longMessage.length });
  let loaded = 0;
  while (await button('Load earlier')) { loaded++; await until(() => cdp.eval("!document.querySelector('.conversation-history-preview')?.textContent.includes('Loading saved messages')"), 'earlier page'); if (loaded > 10) throw Error('Unexpected pagination loop'); }
  assert.deepEqual(await reader(), [longMessage, latest]);
  record('progressive-exact-unicode-reconstruction', { loadedEarlierPages: loaded, characters: longMessage.length, hash: hash() });
  await screenshot(cdp, 'history-loaded.png');
  await button('Latest'); await until(async () => !(await reader()).join('').includes(early), 'reset to recent');
  await cdp.eval(`(()=>{const e=document.querySelector('[aria-label="Search text in selected conversation"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(early)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(() => button('Search text'), 'search button');
  await until(() => button('Jump to match'), 'search match');
  await until(async () => (await reader()).join('').includes(early), 'jump location');
  await screenshot(cdp, 'history-search-jump.png');
  await button('Latest'); await until(async () => { const s = (await reader()).join(''); return s.includes(latest) && !s.includes(early); }, 'latest after jump');
  assert.equal(hash(), beforeHash); record('history-search-jump-latest-no-file-mutation', true);
  assert.equal(rows(trace).length, 0, 'History must not trigger provider requests');
  assert.equal((await cdp.eval('window.vibe.voice.getState()')).listening, false);
  assert(!(await pages()).some(page => page.url.includes('surface=voice')), 'History must not create an audio renderer');
  record('no-provider-network-no-voice', true);
  result.ok = true;
} catch (error) { result.ok = false; result.error = error.stack; console.error(error); process.exitCode = 1; }
finally { fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2)); cdp?.close(); if (child?.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); console.log(`Artifacts: ${output}`); } })();
