'use strict';
// Real isolated Electron renderer, real PTY and real orchestrator activity scopes.
// Synthetic session observations only; no provider, microphone, or user profile.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp', 'orchestrator-dashboard-smoke', `${Date.now()}-${process.pid}`);
fs.mkdirSync(output, { recursive: true });
const controlFile = path.join(output, 'control.json'), ptyLog = path.join(output, 'pty.jsonl');
let control = { hold: [], count: 5, revisions: {} };
const writeControl = patch => { control = { ...control, ...patch }; fs.writeFileSync(controlFile, JSON.stringify(control)); };
writeControl({});
const result = { output, checks: [], liveProviderVerified: false, physicalInputUsed: false };
const record = (name, value) => { result.checks.push({ name, value }); console.log(name, JSON.stringify(value)); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 20000) { let last; for (const end = Date.now() + ms; Date.now() < end;) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await wait(100); } throw Error(`Timeout: ${label}; ${last || ''}`); }
class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.pending = new Map(); this.n = 0; }
  async open() { await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); }); this.ws.addEventListener('message', event => { const p = JSON.parse(String(event.data)), q = this.pending.get(p.id); if (q) { this.pending.delete(p.id); p.error ? q.reject(Error(p.error.message)) : q.resolve(p.result); } }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.n; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
}
const entry = path.join(output, 'main.cjs');
fs.writeFileSync(entry, `
const fs=require('node:fs');
const control=()=>JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)},'utf8'));
globalThis.fetch=async url=>{throw Error('Fixture blocked network: '+url)};
const modulePath=${JSON.stringify(path.join(root, 'backend/orchestrator.cjs'))};
const mod=require(modulePath),factory=mod.createOrchestrator;
mod.createOrchestrator=options=>factory({...options,
 getSessions:async()=>{const c=control();const actual=await options.getSessions();return [...actual,...Array.from({length:c.count},(_,i)=>({id:'fixture-'+i,name:['API','UI','Tests','Docs','Build'][i]||('Long session '+i+' '+ 'description '.repeat(18)),kind:['codex','claude','gemini','opencode','qwen'][i%5],cwd:${JSON.stringify(output)},generation:'fixture-generation-'+i,started:true,status:['working','done','waiting','idle','error'][i%5],...(c.revisions['fixture-'+i]||{})}))];},
 readSession:async payload=>{while(control().hold.includes(payload.id))await new Promise(r=>setTimeout(r,20));return payload.id.startsWith('fixture-')?{ok:true,text:'Fixture observation',generation:payload.generation}:options.readSession(payload);}
});
require(${JSON.stringify(path.join(root, 'backend/main.cjs'))});
`);
let child, cdp;
const cell = id => `[data-dashboard-session-id="${id}"]`;
async function click(selector) { const p = await cdp.eval(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 }); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 }); }
const refresh = () => cdp.eval(`window.vibe.orchestrator.dispatch({kind:'list_sessions'})`);
const activeCount = () => cdp.eval(`document.querySelectorAll('.orchestrator-dashboard-cell[data-targeted="true"]').length`);
async function read(id) { await cdp.eval(`(window.__reads ||= []).push(window.vibe.orchestrator.dispatch({kind:'read_session',targetId:${JSON.stringify(id)}}));void 0`); }
async function release() { writeControl({ hold: [] }); await cdp.eval(`Promise.all(window.__reads||[])`); await until(async () => await activeCount() === 0, 'all scopes released'); }
async function shot(name) { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(r.data, 'base64')); }
async function geometry(label) {
  assert(await cdp.eval(`[...document.querySelectorAll('.orchestrator-dashboard-bubble')].every(e=>{const b=e.getBoundingClientRect(),t=e.querySelector('.orchestrator-dashboard-label'),r=t.getBoundingClientRect(),title=t.querySelector('strong'),style=getComputedStyle(title);return r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1&&style.textOverflow==='ellipsis'&&style.overflowX==='hidden'})`), `${label}: visible labels exceed bubble bounds or lack truncation`);
  const g = await cdp.eval(`(()=>{const v=document.querySelector('.orchestrator-dashboard-viewport'),vr=v.getBoundingClientRect();return {viewport:{width:v.clientWidth,scrollWidth:v.scrollWidth,left:vr.left,right:vr.right},cells:[...document.querySelectorAll('.orchestrator-dashboard-cell')].map(e=>{const r=e.getBoundingClientRect(),s=e.querySelector('.orchestrator-dashboard-sphere').getBoundingClientRect(),h=e.querySelector('.orchestrator-dashboard-halo').getBoundingClientRect();return {id:e.dataset.dashboardSessionId,x:r.x+r.width/2,y:r.y+r.height/2,slot:r.width,sphere:{x:s.x,y:s.y,width:s.width,height:s.height},halo:{x:h.x,y:h.y,width:h.width,height:h.height},inView:e.dataset.inView,animation:getComputedStyle(e.querySelector('.orchestrator-dashboard-drift')).animationPlayState}})}})()`);
  assert(g.viewport.scrollWidth <= g.viewport.width + 1, `${label}: horizontal overflow ${JSON.stringify(g.viewport)}`);
  for (const c of g.cells) {
    assert(c.halo.x-3 >= g.viewport.left && c.halo.x+c.halo.width+3 <= g.viewport.right, `${label}: halo/motion clipped horizontally for ${c.id}`);
    assert(c.halo.width+6 <= c.slot, `${label}: actual halo/motion exceeds reserved cell for ${c.id}`);
  }
  for (let i = 0; i < g.cells.length; i++) for (let j = i + 1; j < g.cells.length; j++) {
    const a = g.cells[i], b = g.cells[j];
    // Bound every sphere at maximum scale, including halo and +/-3px float.
    assert(Math.hypot(a.x-b.x,a.y-b.y) >= Math.max(a.slot,b.slot)-12, `${label}: maximum envelopes overlap`);
    const ah=a.halo,bh=b.halo;
    assert(Math.hypot(ah.x+ah.width/2-bh.x-bh.width/2,ah.y+ah.height/2-bh.y-bh.height/2) >= (ah.width+bh.width)/2+6, `${label}: actual halos overlap including motion margin`);
  }
  record(label, g); return g;
}
async function sample(id, ms = 430) { return cdp.eval(`new Promise(resolve=>{const e=document.querySelector(${JSON.stringify(cell(id) + ' .orchestrator-dashboard-sphere')}),out=[],start=performance.now();function frame(t){out.push({t:t-start,scale:new DOMMatrixReadOnly(getComputedStyle(e).transform).a});if(t-start<${ms})requestAnimationFrame(frame);else resolve(out)}requestAnimationFrame(frame)})`); }
function smooth(values, low, high, label) { assert(values.some(v=>v.scale>low+.01&&v.scale<high-.01), `${label}: no intermediate scale`); assert(values.length>3, `${label}: insufficient frames`); record(label, values); }
(async()=>{try {
  const port = await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
  const env={...process.env,VIBE_SCREENSHOT_MODE:'1',VIBE_INTERNAL_SCREENSHOT:'0',VIBE_SCREENSHOT_USER_DATA:path.join(output,'userData'),VIBE_SCREENSHOT_PTY_DEBUG:ptyLog,VIBE_AGENT_SHIM_BASE_DIR:path.join(output,'shims'),CODEX_HOME:path.join(output,'codex'),CLAUDE_CONFIG_DIR:path.join(output,'claude'),GEMINI_CLI_HOME:path.join(output,'gemini'),QWEN_HOME:path.join(output,'qwen'),KIMI_CODE_HOME:path.join(output,'kimi'),XDG_CONFIG_HOME:path.join(output,'config'),XDG_DATA_HOME:path.join(output,'data')};
  for(const key of Object.keys(env))if(/API_KEY|AUTH_TOKEN/.test(key)||['ELECTRON_RUN_AS_NODE','VITE_DEV_SERVER_URL'].includes(key))delete env[key];
  child=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),[entry,`--remote-debugging-port=${port}`,'--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const log=fs.createWriteStream(path.join(output,'electron.log'));child.stdout.pipe(log);child.stderr.pipe(log);
  const page=await until(async()=>{const p=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();return p.find(p=>p.type==='page'&&p.url.startsWith('file:')&&!p.url.includes('surface='));},'main renderer',30000);
  cdp=new Cdp(page.webSocketDebuggerUrl);await cdp.open();await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1500,height:1100,deviceScaleFactor:1,mobile:false});
  await until(()=>cdp.eval(`Boolean(window.vibe?.terminal && document.querySelector('.orchestrator-nav-button'))`),'dashboard build');
  const seededAt=Date.now()-60000;
  const sessions=[{id:'real-shell',name:'Real PowerShell',kind:'terminal',command:'',cwd:output,createdAt:Date.now(),started:true,nextLaunchMode:'new',launchToken:1,status:'idle',layout:{x:0,y:10,w:70,h:350,unit:'fluid'}}];
  await cdp.eval(`(()=>{localStorage.setItem('vibe-terminal:workspaces:v2',${JSON.stringify(JSON.stringify([{id:'qa',name:'Dashboard QA',path:output,sessions}]))});localStorage.setItem('vibe-terminal:active-workspace:v1','qa');localStorage.setItem('vibe-terminal:active-view:v1','project');localStorage.setItem('vibe-terminal.session-recency.v1',${JSON.stringify(JSON.stringify({'fixture-2':seededAt,'real-shell':seededAt-300000}))});location.reload()})()`);
  await until(()=>cdp.eval(`document.querySelector('[data-session-id="real-shell"] .xterm-rows')?.textContent.length>0`),'actual PowerShell PTY',30000);
  await wait(800);
  // Observe the saved 70% board layout after initial measurement/transition,
  // before comparing it with the covered workspace.
  await until(()=>cdp.eval(`(()=>{const p=document.querySelector('[data-session-id="real-shell"]').getBoundingClientRect(),b=document.querySelector('.terminal-board').getBoundingClientRect();return p.width/b.width<.8&&p.width/b.width>.6})()`),'initial fluid pane layout');
  const before=await cdp.eval(`(async()=>{window.__main=document.querySelector('main.workspace');window.__term=document.querySelector('[data-session-id="real-shell"] .xterm');window.__pane=document.querySelector('[data-session-id="real-shell"]');return {runtime:await window.vibe.terminal.getRuntimeSnapshots(),pane:window.__pane.getBoundingClientRect().toJSON(),main:window.__main.getBoundingClientRect().toJSON(),layout:localStorage.getItem('vibe-terminal:workspaces:v2')}})()`);
  const ptyBefore=fs.readFileSync(ptyLog,'utf8');
  assert(await cdp.eval(`Boolean(document.querySelector('.orchestrator-nav-button').compareDocumentPosition(document.querySelector('[aria-label="Multi mode"]'))&Node.DOCUMENT_POSITION_FOLLOWING)`));
  await refresh();await cdp.eval(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await click('.orchestrator-nav-button');await refresh();await until(()=>cdp.eval(`document.querySelectorAll('[data-dashboard-session-id]').length===6`),'six live dashboard cells');
  const after=await cdp.eval(`(async()=>({sameMain:window.__main===document.querySelector('main.workspace'),sameTerm:window.__term===document.querySelector('[data-session-id="real-shell"] .xterm'),samePane:window.__pane===document.querySelector('[data-session-id="real-shell"]'),inert:window.__main.inert,hidden:window.__main.getAttribute('aria-hidden'),visibility:getComputedStyle(window.__main).visibility,pane:window.__pane.getBoundingClientRect().toJSON(),main:window.__main.getBoundingClientRect().toJSON(),runtime:await window.vibe.terminal.getRuntimeSnapshots(),layout:localStorage.getItem('vibe-terminal:workspaces:v2')}))()`);
  assert(after.sameMain&&after.sameTerm&&after.samePane&&after.inert);assert.equal(after.hidden,'true');assert.equal(after.visibility,'hidden');assert.deepEqual(after.pane,before.pane);assert.deepEqual(after.main,before.main);assert.equal(after.layout,before.layout);assert.equal(after.runtime[0].generation,before.runtime[0].generation);assert.equal(fs.readFileSync(ptyLog,'utf8'),ptyBefore);record('cover-preserves-main-xterm-generation-layout-and-PTY-size',{before,after});
  await cdp.eval(`window.__cells=[...document.querySelectorAll('[data-dashboard-session-id]')];window.__bubbles=window.__cells.map(e=>e.querySelector('button'));void 0`);
  const initialRecency=await cdp.eval(`JSON.parse(localStorage.getItem('vibe-terminal.session-recency.v1'))`);const order=await cdp.eval(`window.__cells.map(e=>e.dataset.dashboardSessionId)`);assert(order.indexOf('fixture-2')<order.indexOf('fixture-0'));record('seeded-recency-orders-otherwise-unused-sessions',{initialRecency,order});await geometry('wide-zero-targets');await shot('normal');
  const colors=await cdp.eval(`[...document.querySelectorAll('.orchestrator-dashboard-cell')].filter(e=>e.dataset.dashboardSessionId.startsWith('fixture-')).map(e=>({status:e.dataset.status,color:getComputedStyle(e).getPropertyValue('--status-color').trim(),fill:getComputedStyle(e.querySelector('.orchestrator-dashboard-rim')).backgroundImage,border:getComputedStyle(e.querySelector('.orchestrator-dashboard-rim')).borderTopWidth}))`);
  assert.equal(new Set(colors.map(c=>c.color)).size,5);assert(colors.every(c=>c.fill.includes('gradient')&&c.border==='2px'));record('distinct-status-colors-with-visible-fill',colors);
  const native={provider:'codex',processState:'running',agentProcessState:'running',children:[],telemetryHealth:'available',observation:'observed',revision:12};
  for(const [patch,expected] of [[{turnState:'running'},'working'],[{turnState:'waiting'},'needs-you'],[{turnState:'completed'},'done'],[{turnState:'completed',observation:'provisional'},'response'],[{turnState:'running',observation:'unavailable'},'unknown'],[{turnState:'running',pendingInput:'submit'},'pending']]) {
    writeControl({revisions:{'fixture-0':{...native,...patch}}});await refresh();await until(()=>cdp.eval(`document.querySelector(${JSON.stringify(cell('fixture-0'))}).dataset.status===${JSON.stringify(expected)}`),`native status ${expected}`);
  }
  writeControl({revisions:{}});await refresh();record('native-observation-status-transitions',true);
  const readRecency=await cdp.eval(`localStorage.getItem('vibe-terminal.session-recency.v1')`);
  writeControl({hold:['fixture-0']});await read('fixture-0');smooth(await sample('fixture-0'),.82,1,'expand-frames');assert.equal(await activeCount(),1);await shot('one-active');assert.equal(await cdp.eval(`localStorage.getItem('vibe-terminal.session-recency.v1')`),readRecency);record('passive-read-does-not-update-user-recency',true);
  writeControl({hold:['fixture-0','fixture-1']});await read('fixture-1');smooth(await sample('fixture-1'),.65,1,'second-expand-frames');assert.equal(await activeCount(),2);await geometry('two-targets');await shot('two-active');
  const stable=await cdp.eval(`window.__cells.map(e=>({id:e.dataset.dashboardSessionId,x:e.offsetLeft,y:e.offsetTop}))`);
  writeControl({revisions:{'fixture-0':{status:'done',focused:true,lastUsedAt:Date.now()}}});await refresh();
  assert(await cdp.eval(`window.__cells.every((e,i)=>e===document.querySelectorAll('[data-dashboard-session-id]')[i]&&window.__bubbles[i]===e.querySelector('button'))`));assert.deepEqual(await cdp.eval(`window.__cells.map(e=>({id:e.dataset.dashboardSessionId,x:e.offsetLeft,y:e.offsetTop}))`),stable);record('status-focus-recency-do-not-remount-or-shuffle',stable);
  writeControl({hold:[]});smooth(await sample('fixture-0'),.82,1,'retract-frames');await release();
  writeControl({hold:['fixture-0']});await read('fixture-0');await wait(60);writeControl({hold:['fixture-1']});await read('fixture-1');smooth(await sample('fixture-0'),.65,1,'rapid-retarget-frames');await release();
  writeControl({hold:['fixture-0']});await read('fixture-0');await until(async()=>await activeCount()===1,'old generation active');writeControl({revisions:{'fixture-0':{generation:'replacement-generation'}}});await refresh();assert.equal(await activeCount(),0);record('generation-mismatch-clears-target',true);await release();
  writeControl({revisions:{},hold:['real-shell',...Array.from({length:5},(_,i)=>'fixture-'+i)]});for(const id of control.hold)await read(id);await until(async()=>await activeCount()===6,'all targets');await wait(400);await geometry('all-targets-max-size');await release();
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:720,height:1000,deviceScaleFactor:1,mobile:false});await wait(450);await geometry('narrow');
  writeControl({hold:['real-shell',...Array.from({length:5},(_,i)=>'fixture-'+i)]});for(const id of control.hold)await read(id);await until(async()=>await activeCount()===6,'narrow all targets');await wait(400);await geometry('narrow-all-targets');await shot('narrow');await release();
  writeControl({count:30});await refresh();await until(()=>cdp.eval(`document.querySelectorAll('[data-dashboard-session-id]').length===31`),'many sessions');await wait(200);const many=await geometry('many-long-labels');assert(many.cells.some(c=>c.inView==='false'&&c.animation==='paused'));record('offscreen-animation-paused',true);
  writeControl({hold:['real-shell',...Array.from({length:30},(_,i)=>'fixture-'+i)]});for(const id of control.hold)await read(id);await until(async()=>await activeCount()===31,'31 concurrent targets');await wait(400);await geometry('many-long-labels-all-active');await release();
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});assert.deepEqual(await cdp.eval(`(()=>{const c=document.querySelector('.orchestrator-dashboard-cell');return {animation:getComputedStyle(c.querySelector('.orchestrator-dashboard-drift')).animationName,transition:getComputedStyle(c.querySelector('.orchestrator-dashboard-sphere')).transitionDuration}})()`),{animation:'none',transition:'0s'});record('reduced-motion-disabled',true);
  await cdp.send('Emulation.setEmulatedMedia',{features:[]});
  await cdp.send('Performance.enable');const perfStart=await cdp.send('Performance.getMetrics');await wait(2000);const perfEnd=await cdp.send('Performance.getMetrics');const metric=(r,n)=>r.metrics.find(m=>m.name===n)?.value||0;record('idle-renderer-task-sample',{seconds:metric(perfEnd,'Timestamp')-metric(perfStart,'Timestamp'),taskSeconds:metric(perfEnd,'TaskDuration')-metric(perfStart,'TaskDuration'),scope:'Renderer main-thread sample; not whole-app CPU benchmark'});
  await cdp.eval(`document.querySelector('.orchestrator-dashboard-viewport').scrollTop=0`);await click(cell('real-shell')+' button');await until(()=>cdp.eval(`!document.querySelector('.orchestrator-view-host')`),'bubble opens real pane');
  assert(await cdp.eval(`window.__term===document.querySelector('[data-session-id="real-shell"] .xterm')&&!document.querySelector('main.workspace').inert`));
  const used=await cdp.eval(`JSON.parse(localStorage.getItem('vibe-terminal.session-recency.v1'))['real-shell']`);assert(used>seededAt);record('bubble-internal-focus-updates-user-recency',used);
  await cdp.eval(`(async()=>{const s=(await window.vibe.terminal.getRuntimeSnapshots()).find(s=>s.id==='real-shell');window.vibe.terminal.input(s.id,"Write-Output 'QA_AGENT_OUTPUT'\\r",{generation:s.generation,launchToken:s.launchToken})})()`);await wait(600);assert.equal(await cdp.eval(`JSON.parse(localStorage.getItem('vibe-terminal.session-recency.v1'))['real-shell']`),used);record('PTY-output-does-not-update-user-recency',true);
  await click('[data-session-id="real-shell"] .xterm-screen');const pointerUsed=await cdp.eval(`JSON.parse(localStorage.getItem('vibe-terminal.session-recency.v1'))['real-shell']`);assert(pointerUsed>used);record('explicit-pane-pointer-updates-recency',pointerUsed);
  // Allow the intentional 15-second keyboard-write throttle to expire.
  await wait(15200);await cdp.eval(`document.querySelector('[data-session-id="real-shell"] .xterm-helper-textarea').focus()`);
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
  const keyUsed=await cdp.eval(`JSON.parse(localStorage.getItem('vibe-terminal.session-recency.v1'))['real-shell']`);assert(keyUsed>pointerUsed);record('explicit-pane-keyboard-updates-recency',keyUsed);
  assert.equal(await cdp.eval(`document.getAnimations().filter(a=>a.animationName==='orchestrator-gentle-drift').length`),0);record('closed-dashboard-has-no-running-drift-animations',true);
  writeControl({count:0});await refresh();await click('.orchestrator-nav-button');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1500,height:1100,deviceScaleFactor:1,mobile:false});
  await until(()=>cdp.eval(`document.querySelectorAll('[data-dashboard-session-id]').length===1`),'single session');await wait(400);
  await until(()=>cdp.eval(`document.querySelector('.orchestrator-dashboard-cell')?.dataset.inView==='true'`),'reopened single session resumes visible motion');
  await geometry('single-session');
  assert(await cdp.eval(`(()=>{const v=document.querySelector('.orchestrator-dashboard-viewport').getBoundingClientRect(),c=document.querySelector('.orchestrator-dashboard-cell').getBoundingClientRect();return Math.abs(c.x+c.width/2-v.x-v.width/2)<10&&Math.abs(c.y+c.height/2-v.y-v.height/2)<10})()`),'single bubble centered in viewport');
  await shot('single');
  await click('.orchestrator-nav-button');await click('[aria-label="Multi mode"]');assert(!await cdp.eval(`Boolean(document.querySelector('.orchestrator-view-host'))`));record('navigation-opens-and-closes-dashboard',true);
  result.pass=true;
}catch(e){result.pass=false;result.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{writeControl({hold:[]});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));cdp?.ws.close();if(child?.pid)spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});console.log(`Artifacts: ${output}`);}})();
