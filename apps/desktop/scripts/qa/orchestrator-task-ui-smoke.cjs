'use strict';
// Actual built renderer and preload in an isolated hidden Electron process; synthetic state, no provider.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const screenshots = process.argv.includes('--screenshots');
const output = path.join(root, '.tmp', 'orchestrator-task-ui-smoke', `${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true });
const result = { output, checks: [], liveProviderVerified: false, hidden: true, screenshots };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { let last; for (const end = Date.now() + 25000; Date.now() < end;) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await wait(100); } throw Error(`Timeout: ${label}; ${last || ''}`); }
class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.pending = new Map(); this.n = 0; }
  async open() { await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); }); this.ws.addEventListener('message', event => { const p = JSON.parse(String(event.data)), q = this.pending.get(p.id); if (q) { this.pending.delete(p.id); p.error ? q.reject(Error(p.error.message)) : q.resolve(p.result); } }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.n; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
}
const callsFile = path.join(output, 'calls.jsonl');
const tasks = ['running', 'waiting-results', 'needs-answer', 'failed', 'paused'].map((status, index) => ({
  id: `request-${index}`, requestId: `request-${index}`, sequence: index + 1, text: ['Review API changes', 'Run UI checks', 'Fix the findings', 'Summarize the documentation', 'Continue the build'][index], origin: 'text', status,
  targets: [{ id: `fixture-${index}`, generation: `generation-${index}`, name: ['API', 'UI', 'Tests', 'Documentation with a deliberately long project description', 'Build'][index], cwd: index === 3 ? 'C:\\Projects\\a-deliberately-long-workspace-path\\nested-folder\\documentation' : `C:\\Projects\\${['api', 'ui', 'tests', 'docs', 'build'][index]}` }],
  targetIds: [`fixture-${index}`], dependsOn: [], createdAt: Date.now(), updatedAt: Date.now(),
  ...(status === 'needs-answer' ? { question: { id: 'question-2', requestId: 'request-2', text: 'Should I fix the API findings or the UI findings?' } } : {}),
  ...(status === 'failed' ? { error: 'Brain request timed out. Unfinished work has been preserved.' } : {}),
}));
const messages = tasks.map(task => ({ id: `message-${task.id}`, requestId: task.requestId, role: 'user', text: task.text, at: Date.now() }));
messages.push({ id: 'question', requestId: 'request-2', role: 'assistant', text: tasks[2].question.text, at: Date.now() });
const entry = path.join(output, 'main.cjs');
fs.writeFileSync(entry, `
const fs=require('node:fs');
const electron=require('electron'),NativeWindow=electron.BrowserWindow,Module=require('node:module'),load=Module._load;
const hiddenElectron=Object.create(electron);
Object.defineProperty(hiddenElectron,'BrowserWindow',{value:class extends NativeWindow{
 constructor(options){super({...options,show:false});const send=this.webContents.send.bind(this.webContents);this.webContents.send=(channel,...args)=>send(channel,...(channel==='orchestrator:state'?[{...args[0],ready:true}]:args));} show(){} showInactive(){} maximize(){} restore(){} focus(){}
}});
Module._load=function(name,...args){return name==='electron'?hiddenElectron:load.call(this,name,...args);};
const handle=electron.ipcMain.handle.bind(electron.ipcMain);electron.ipcMain.handle=(channel,fn)=>handle(channel,channel==='orchestrator:get-state'?async (...args)=>({...await fn(...args),ready:true}):fn);
globalThis.fetch=async url=>{throw Error('Fixture blocked network: '+url)};
const mod=require(${JSON.stringify(path.join(root, 'backend/orchestrator.cjs'))}),factory=mod.createOrchestrator;
const tasks=${JSON.stringify(tasks)},messages=${JSON.stringify(messages)};
const fixture=s=>({...s,enabled:true,ready:true,busy:true,phase:'working',error:'',tasks,messages,sessions:tasks.flatMap(t=>t.targets.map(s=>({...s,kind:'codex',status:'working',started:true})))});
mod.createOrchestrator=options=>{const instance=factory({...options,onChange:s=>options.onChange(fixture(s))});return {...instance,getState:()=>fixture(instance.getState()),enqueue:async input=>{fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(input)+'\\n');return {ok:true,requestId:'accepted-fixture',status:'queued'};}};};
require(${JSON.stringify(path.join(root, 'backend/main.cjs'))});
`);
let child, cdp;
async function shot(name) {
  // Hidden Chromium surfaces can stop producing frames after viewport changes.
  // CI gates DOM geometry and real IPC; opt-in captures are separate visual QA.
  if (!screenshots) return;
  let timer;
  try {
    const captured = await Promise.race([cdp.send('Page.captureScreenshot', { format: 'png' }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Hidden screenshot timed out; run without --screenshots for the functional gate.')), 10000); })]);
    fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(captured.data, 'base64'));
  } finally { clearTimeout(timer); }
}
async function geometry(label) {
  const g = await cdp.eval(`(()=>{const panel=document.querySelector('.orchestrator-dock'),p=panel.getBoundingClientRect();const controls=[...panel.querySelectorAll('.relay-composer,.relay-composer textarea,.relay-composer button,.relay-task-meta button,.relay-thread-actions button')].map(e=>{const r=e.getBoundingClientRect();return {text:e.textContent||e.title||e.getAttribute('aria-label'),left:r.left,right:r.right,width:r.width,height:r.height};});return {panel:{left:p.left,right:p.right,width:p.width},scrollWidth:panel.scrollWidth,clientWidth:panel.clientWidth,controls}})()`);
  assert(g.scrollWidth <= g.clientWidth + 1, `${label}: panel horizontal overflow`);
  assert(await cdp.eval(`(()=>{const e=document.querySelector('.relay-thread');return e.scrollWidth<=e.clientWidth+1})()`),`${label}: thread horizontal overflow`);
  for (const c of g.controls) assert(c.width > 0 && c.height > 0 && c.left >= g.panel.left - 1 && c.right <= g.panel.right + 1, `${label}: clipped control ${JSON.stringify(c)}`);
  result.checks.push({ name: label, value: g });
}
(async () => { try {
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));}); });
  const env={...process.env,VIBE_SCREENSHOT_MODE:'1',VIBE_INTERNAL_SCREENSHOT:'0',VIBE_SCREENSHOT_USER_DATA:path.join(output,'userData'),VIBE_AGENT_SHIM_BASE_DIR:path.join(output,'shims'),CODEX_HOME:path.join(output,'codex'),CLAUDE_CONFIG_DIR:path.join(output,'claude'),GEMINI_CLI_HOME:path.join(output,'gemini'),QWEN_HOME:path.join(output,'qwen'),KIMI_CODE_HOME:path.join(output,'kimi'),XDG_CONFIG_HOME:path.join(output,'config'),XDG_DATA_HOME:path.join(output,'data')};
  for(const key of Object.keys(env))if(/API_KEY|AUTH_TOKEN/.test(key)||['ELECTRON_RUN_AS_NODE','VITE_DEV_SERVER_URL'].includes(key))delete env[key];
  child=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),[entry,`--remote-debugging-port=${port}`,'--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const log=fs.createWriteStream(path.join(output,'electron.log'));child.stdout.pipe(log);child.stderr.pipe(log);
  const page=await until(async()=>{const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();return pages.find(p=>p.type==='page'&&p.url.startsWith('file:')&&!p.url.includes('surface='));},'renderer');
  cdp=new Cdp(page.webSocketDebuggerUrl);await cdp.open();await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1500,height:1100,deviceScaleFactor:1,mobile:false});
  await until(()=>cdp.eval(`Boolean(document.querySelector('[aria-label="Open workspace tools"]'))`),'workspace tools');
  await cdp.eval(`document.querySelector('[aria-label="Open workspace tools"]').click()`);
  await until(()=>cdp.eval(`document.querySelectorAll('.relay-task-meta').length===5`),'five task cards');
  await geometry('wide');await shot('wide');
  await cdp.eval(`document.querySelector('.relay-thread').scrollTop=0;[...document.querySelectorAll('.relay-task-meta button')].find(e=>e.textContent==='Reply').click()`);
  await until(()=>cdp.eval(`Boolean(document.querySelector('.relay-reply-context'))`),'reply context');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:720,height:1000,deviceScaleFactor:1,mobile:false});await wait(200);
  await geometry('narrow');await shot('narrow-reply');
  await cdp.eval(`document.querySelector('.relay-thread').scrollTop=document.querySelector('.relay-thread').scrollHeight`);await shot('narrow-bottom');
  await cdp.eval(`document.querySelector('[aria-label="Orchestrator instruction"]').focus()`);
  await cdp.send('Input.insertText',{text:'Fix the API findings'});
  await until(()=>cdp.eval(`document.querySelector('[title="Send instruction"]').disabled===false`),'send enabled while busy');
  await shot('narrow-busy-send');
  await cdp.eval(`document.querySelector('[title="Send instruction"]').click()`);
  await until(()=>fs.existsSync(callsFile),'enqueue through preload IPC');
  const sent=JSON.parse(fs.readFileSync(callsFile,'utf8').trim());
  assert.equal(sent.text,'Fix the API findings');assert.equal(sent.replyToRequestId,'request-2');assert.equal(sent.questionId,'question-2');
  await until(()=>cdp.eval(`document.querySelector('[aria-label="Orchestrator instruction"]').value===''`),'accepted composer clearing');
  result.checks.push({name:'busy-send-with-reply-through-real-IPC',value:sent});
  result.pass=true;
} catch(error) { result.pass=false;result.error=error.stack;console.error(error.stack);process.exitCode=1; }
finally { fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));cdp?.ws.close();if(child?.pid)spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});console.log('Artifacts: '+output); } })();
