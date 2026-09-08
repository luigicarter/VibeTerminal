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
const fs=require('node:fs'),path=require('node:path');
const control=()=>JSON.parse(fs.readFileSync(${JSON.stringify(controlFile)},'utf8'));
globalThis.fetch=async url=>{throw Error('Fixture blocked network: '+url)};
const modulePath=${JSON.stringify(path.join(root, 'backend/orchestrator.cjs'))};
const mod=require(modulePath),factory=mod.createOrchestrator;
mod.createOrchestrator=options=>factory({...options,
 getSessions:async()=>{const c=control();const actual=await options.getSessions();return [...actual,...Array.from({length:c.count},(_,i)=>({id:'fixture-'+i,name:['Vibe terminal','Claude code','Gemini','OpenCode','Qwen'][i%5],kind:['codex','claude','gemini','opencode','qwen'][i%5],projectName:i===1?'Website':undefined,cwd:path.join(${JSON.stringify(output)},['API','storefront','Tests','Docs','Build'][i]||('Long project '+i+' '+ 'description '.repeat(18))),generation:'fixture-generation-'+i,started:true,status:['working','done','waiting','idle','error'][i%5],...(c.revisions['fixture-'+i]||{})}))];},
 readSession:async payload=>{while(control().hold.includes(payload.id))await new Promise(r=>setTimeout(r,20));const s=control().revisions[payload.id];return payload.id.startsWith('fixture-')?{ok:true,text:'Fixture observation',generation:payload.generation,...(s?.turnId&&s?.turnState==='completed'?{completedResult:{turnId:s.turnId,status:'completed',at:s.turnEndedAt,text:'Updated API route validation and added focused tests. Agent reports all checks passed.',source:'terminal-screen'}}:{})}:options.readSession(payload);}
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
async function motionChecks() {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 80 });
  const motion = await cdp.eval(`new Promise(resolve=>{
    const cells=[...document.querySelectorAll('.orchestrator-dashboard-cell')];
    const tracks=cells.map(e=>({id:e.dataset.dashboardSessionId,x:[],y:[],width:0})),start=performance.now();
    function frame(t){cells.forEach((e,i)=>{const r=e.querySelector('.orchestrator-dashboard-sphere').getBoundingClientRect(),c=e.getBoundingClientRect(),field=e.closest('.orchestrator-dashboard-field').getBoundingClientRect(),fit=c.width/parseFloat(getComputedStyle(e).width);tracks[i].x.push((c.x+c.width/2-field.x)/fit);tracks[i].y.push((c.y+c.height/2-field.y)/fit);tracks[i].width=r.width;});
      if(t-start<4000)requestAnimationFrame(frame);else resolve(tracks.map(p=>({id:p.id,width:p.width,frames:p.x.length,travelX:Math.max(...p.x)-Math.min(...p.x),travelY:Math.max(...p.y)-Math.min(...p.y)})));}
    requestAnimationFrame(frame);
  })`);
  assert(motion.length >= 3 && motion.every(p=>p.frames>30), `Insufficient compositor frames: ${JSON.stringify(motion)}`);
  assert(motion.every(p=>Math.hypot(p.travelX,p.travelY)>=10), `Every visible bubble should noticeably move within four seconds: ${JSON.stringify(motion)}`);
  assert(motion.every(p=>p.width>0&&p.width<=200), 'Resting bubbles should scale down to fit');
  assert(Math.max(...motion.map(p=>p.width))-Math.min(...motion.map(p=>p.width))>=Math.max(...motion.map(p=>p.width))*.08, 'Resting sizes should visibly vary');
  record('compact-varied-bubbles-visibly-float',motion);await shot('floating-after-four-seconds');
  const hovered = await cdp.eval(`(()=>{const e=document.querySelector('.orchestrator-dashboard-cell'),r=e.getBoundingClientRect();window.__motionCell=e;return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const position = () => cdp.eval(`(()=>{const r=window.__motionCell.getBoundingClientRect();return {x:r.x,y:r.y}})()`);
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...hovered});await wait(100);
  const paused = await position();await wait(250);assert.deepEqual(await position(),paused);
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:400,y:80});
  await cdp.eval(`window.__motionCell.querySelector('button').focus({preventScroll:true})`);await wait(100);
  const focused=await position();await wait(250);assert.deepEqual(await position(),focused);
  await cdp.eval(`window.__motionCell.querySelector('button').blur()`);await wait(250);
  const resumed=await position();assert(Math.hypot(resumed.x-focused.x,resumed.y-focused.y)>1);
  record('hover-and-keyboard-focus-pause-free-motion',true);
  const contact=await until(()=>cdp.eval(`(()=>{for(const e of document.querySelectorAll('.orchestrator-dashboard-sphere-surface')){const scale=e.style.transform.match(/scale\\(([^,]+)/);if(scale&&1-Number(scale[1])>.015)return {id:e.closest('.orchestrator-dashboard-cell').dataset.dashboardSessionId,transform:e.style.transform};}return null})()`),'a naturally occurring visible collision',20000);
  record('natural-contact-squashes-visible-glass',contact);await shot('natural-collision');
  await cdp.eval(`window.__motionBeforeStatus=window.__motionCell.getBoundingClientRect().toJSON();void 0`);
}
async function geometry(label) {
  assert(await cdp.eval(`[...document.querySelectorAll('.orchestrator-dashboard-bubble')].every(e=>{const b=e.getBoundingClientRect(),t=e.querySelector('.orchestrator-dashboard-label'),r=t.getBoundingClientRect(),title=t.querySelector('strong'),style=getComputedStyle(title);return r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1&&style.textOverflow==='ellipsis'&&style.overflowX==='hidden'})`), `${label}: visible labels exceed bubble bounds or lack truncation`);
  const g = await cdp.eval(`(()=>{const v=document.querySelector('.orchestrator-dashboard-viewport'),vr=v.getBoundingClientRect();return {viewport:{width:v.clientWidth,scrollWidth:v.scrollWidth,height:v.clientHeight,scrollHeight:v.scrollHeight,left:vr.left,right:vr.right,top:vr.top,bottom:vr.bottom},cells:[...document.querySelectorAll('.orchestrator-dashboard-cell')].map(e=>{const r=e.getBoundingClientRect(),s=e.querySelector('.orchestrator-dashboard-sphere').getBoundingClientRect(),h=e.querySelector('.orchestrator-dashboard-halo').getBoundingClientRect();return {id:e.dataset.dashboardSessionId,x:r.x+r.width/2,y:r.y+r.height/2,slot:r.width,fit:r.width/parseFloat(getComputedStyle(e).width),sphere:{x:s.x,y:s.y,width:s.width,height:s.height},halo:{x:h.x,y:h.y,width:h.width,height:h.height},inView:e.dataset.inView,animation:getComputedStyle(e.querySelector('.orchestrator-dashboard-drift')).animationPlayState}})}})()`);
  assert(g.viewport.scrollWidth <= g.viewport.width + 1, `${label}: horizontal overflow ${JSON.stringify(g.viewport)}`);
  assert(g.viewport.scrollHeight <= g.viewport.height + 1, `${label}: vertical overflow ${JSON.stringify(g.viewport)}`);
  for (const c of g.cells) {
    const glow=9*c.fit;
    assert(c.halo.x-glow >= g.viewport.left && c.halo.x+c.halo.width+glow <= g.viewport.right && c.halo.y-glow>=g.viewport.top&&c.halo.y+c.halo.height+glow<=g.viewport.bottom, `${label}: halo/glow clipped for ${c.id}`);
    assert(c.halo.x-glow>=c.x-c.slot/2&&c.halo.x+c.halo.width+glow<=c.x+c.slot/2&&c.halo.y-glow>=c.y-c.slot/2&&c.halo.y+c.halo.height+glow<=c.y+c.slot/2, `${label}: moving halo/glow exceeds reserved cell for ${c.id}`);
  }
  for (let i = 0; i < g.cells.length; i++) for (let j = i + 1; j < g.cells.length; j++) {
    const a = g.cells[i], b = g.cells[j];
    // Glass disks meet at contact. Their soft glows can mingle naturally.
    const ah=a.sphere,bh=b.sphere;
    assert(Math.hypot(ah.x+ah.width/2-bh.x-bh.width/2,ah.y+ah.height/2-bh.y-bh.height/2)+.2 >= (ah.width+bh.width)/2, `${label}: actual bubble disks overlap`);
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
  // Exercise foreground visibility without opening an OS window. This does not
  // guarantee foreground compositor cadence: motion checks stay strict below.
  if (process.env.VIBE_SCREENSHOT_HIDDEN === '1') {
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  }
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
  await cdp.eval(`new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Pane layout did not settle within 20 seconds')),20000);
    let previous='',stableSince=performance.now();
    function frame(now){
      const pane=document.querySelector('[data-session-id="real-shell"]');
      const rect=pane.getBoundingClientRect(),width=parseFloat(getComputedStyle(pane).width);
      const geometry=JSON.stringify([rect.x,rect.y,rect.width,rect.height,width]);
      if(geometry!==previous){previous=geometry;stableSince=now;}
      if(now-stableSince>=350){clearTimeout(timeout);resolve();}else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  })`);
  const before=await cdp.eval(`(async()=>{window.__main=document.querySelector('main.workspace');window.__term=document.querySelector('[data-session-id="real-shell"] .xterm');window.__pane=document.querySelector('[data-session-id="real-shell"]');return {runtime:await window.vibe.terminal.getRuntimeSnapshots(),pane:window.__pane.getBoundingClientRect().toJSON(),main:window.__main.getBoundingClientRect().toJSON(),layout:localStorage.getItem('vibe-terminal:workspaces:v2')}})()`);
  const ptyBefore=fs.readFileSync(ptyLog,'utf8');
  assert(await cdp.eval(`Boolean(document.querySelector('.orchestrator-nav-button').compareDocumentPosition(document.querySelector('[aria-label="Multi mode"]'))&Node.DOCUMENT_POSITION_FOLLOWING)`));
  await refresh();await cdp.eval(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await click('.orchestrator-nav-button');await refresh();await until(()=>cdp.eval(`document.querySelectorAll('[data-dashboard-session-id]').length===6`),'six live dashboard cells');
  const after=await cdp.eval(`(async()=>({sameMain:window.__main===document.querySelector('main.workspace'),sameTerm:window.__term===document.querySelector('[data-session-id="real-shell"] .xterm'),samePane:window.__pane===document.querySelector('[data-session-id="real-shell"]'),inert:window.__main.inert,hidden:window.__main.getAttribute('aria-hidden'),visibility:getComputedStyle(window.__main).visibility,pane:window.__pane.getBoundingClientRect().toJSON(),main:window.__main.getBoundingClientRect().toJSON(),runtime:await window.vibe.terminal.getRuntimeSnapshots(),layout:localStorage.getItem('vibe-terminal:workspaces:v2')}))()`);
  assert(after.sameMain&&after.sameTerm&&after.samePane&&after.inert);assert.equal(after.hidden,'true');assert.equal(after.visibility,'hidden');assert.deepEqual(after.pane,before.pane);assert.deepEqual(after.main,before.main);assert.equal(after.layout,before.layout);assert.equal(after.runtime[0].generation,before.runtime[0].generation);assert.equal(fs.readFileSync(ptyLog,'utf8'),ptyBefore);record('cover-preserves-main-xterm-generation-layout-and-PTY-size',{before,after});
  await cdp.eval(`window.__cells=[...document.querySelectorAll('[data-dashboard-session-id]')];window.__bubbles=window.__cells.map(e=>e.querySelector('button'));void 0`);
  const projectLabels=await cdp.eval(`[...document.querySelectorAll('[data-dashboard-session-id]')].map(e=>({id:e.dataset.dashboardSessionId,project:e.querySelector('strong').textContent,provider:e.querySelector('.orchestrator-dashboard-provider').textContent,title:e.querySelector('button').title,accessible:e.querySelector('button').getAttribute('aria-label')}))`);
  for(const [id,project,folder,sessionName] of [['real-shell','Dashboard QA',output],['fixture-0','API',path.join(output,'API'),'Vibe terminal'],['fixture-1','Website',path.join(output,'storefront'),'Claude code'],['fixture-2','Tests',path.join(output,'Tests'),'Gemini'],['fixture-3','Docs',path.join(output,'Docs'),'OpenCode'],['fixture-4','Build',path.join(output,'Build'),'Qwen']]) {
    const bubble=projectLabels.find(item=>item.id===id);
    assert.equal(bubble.project,project,`${id}: project must be the visible primary label`);
    assert(bubble.provider,`${id}: provider remains visible`);
    for(const text of [project,folder,sessionName].filter(Boolean)) {
      assert(bubble.title.includes(text),`${id}: hover identity missing ${text}`);
      assert(bubble.accessible.includes(text),`${id}: accessible identity missing ${text}`);
    }
  }
  record('project-labels-with-session-and-full-path-details',projectLabels);
  const initialRecency=await cdp.eval(`JSON.parse(localStorage.getItem('vibe-terminal.session-recency.v1'))`);const order=await cdp.eval(`window.__cells.map(e=>e.dataset.dashboardSessionId)`);assert(order.indexOf('fixture-2')<order.indexOf('fixture-0'));record('seeded-recency-orders-otherwise-unused-sessions',{initialRecency,order});await geometry('wide-zero-targets');await shot('normal');
  await motionChecks();
  const colors=await cdp.eval(`[...document.querySelectorAll('.orchestrator-dashboard-cell')].filter(e=>e.dataset.dashboardSessionId.startsWith('fixture-')).map(e=>({status:e.dataset.status,color:getComputedStyle(e).getPropertyValue('--status-color').trim(),fill:getComputedStyle(e.querySelector('.orchestrator-dashboard-rim')).backgroundImage,border:getComputedStyle(e.querySelector('.orchestrator-dashboard-rim')).borderTopWidth}))`);
  assert.equal(new Set(colors.map(c=>c.color)).size,5);assert(colors.every(c=>c.fill.includes('gradient')&&c.border==='2px'));record('distinct-status-colors-with-visible-fill',colors);
  const native={provider:'codex',processState:'running',agentProcessState:'running',children:[],telemetryHealth:'available',observation:'observed',revision:12};
  for(const [patch,expected] of [[{turnState:'running'},'working'],[{turnState:'waiting'},'needs-you'],[{turnState:'completed'},'done'],[{turnState:'completed',observation:'provisional'},'response'],[{turnState:'running',observation:'unavailable'},'unknown'],[{turnState:'running',pendingInput:'submit'},'pending']]) {
    writeControl({revisions:{'fixture-0':{...native,...patch}}});await refresh();await until(()=>cdp.eval(`document.querySelector(${JSON.stringify(cell('fixture-0'))}).dataset.status===${JSON.stringify(expected)}`),`native status ${expected}`);
  }
  writeControl({revisions:{}});await refresh();record('native-observation-status-transitions',true);
  assert(await cdp.eval(`(()=>{const a=window.__motionBeforeStatus,b=window.__motionCell.getBoundingClientRect();return Math.hypot(a.x-b.x,a.y-b.y)<40})()`));record('status-updates-preserve-floating-position',true);
  const readRecency=await cdp.eval(`localStorage.getItem('vibe-terminal.session-recency.v1')`);
  const restingScale=await cdp.eval(`Number(getComputedStyle(document.querySelector(${JSON.stringify(cell('fixture-0')+' button')})).getPropertyValue('--bubble-scale'))`);
  writeControl({hold:['fixture-0']});await read('fixture-0');smooth(await sample('fixture-0'),restingScale,1,'expand-frames');assert.equal(await activeCount(),1);await shot('one-active');assert.equal(await cdp.eval(`localStorage.getItem('vibe-terminal.session-recency.v1')`),readRecency);record('passive-read-does-not-update-user-recency',true);
  writeControl({hold:['fixture-0','fixture-1']});await read('fixture-1');smooth(await sample('fixture-1'),.65,1,'second-expand-frames');assert.equal(await activeCount(),2);await geometry('two-targets');await shot('two-active');
  const stable=await cdp.eval(`window.__cells.map(e=>({id:e.dataset.dashboardSessionId,x:e.offsetLeft,y:e.offsetTop}))`);
  writeControl({revisions:{'fixture-0':{status:'done',focused:true,lastUsedAt:Date.now()}}});await refresh();
  assert(await cdp.eval(`window.__cells.every((e,i)=>e===document.querySelectorAll('[data-dashboard-session-id]')[i]&&window.__bubbles[i]===e.querySelector('button'))`));assert.deepEqual(await cdp.eval(`window.__cells.map(e=>({id:e.dataset.dashboardSessionId,x:e.offsetLeft,y:e.offsetTop}))`),stable);record('status-focus-recency-do-not-remount-or-shuffle',stable);
  writeControl({hold:[]});smooth(await sample('fixture-0'),restingScale,1,'retract-frames');await release();
  writeControl({hold:['fixture-0']});await read('fixture-0');await wait(60);writeControl({hold:['fixture-1']});await read('fixture-1');smooth(await sample('fixture-0'),.65,1,'rapid-retarget-frames');await release();
  writeControl({hold:['fixture-0']});await read('fixture-0');await until(async()=>await activeCount()===1,'old generation active');writeControl({revisions:{'fixture-0':{generation:'replacement-generation'}}});await refresh();assert.equal(await activeCount(),0);record('generation-mismatch-clears-target',true);await release();
  writeControl({revisions:{},hold:['real-shell',...Array.from({length:5},(_,i)=>'fixture-'+i)]});for(const id of control.hold)await read(id);await until(async()=>await activeCount()===6,'all targets');await wait(400);await geometry('all-targets-max-size');await release();
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:720,height:1000,deviceScaleFactor:1,mobile:false});await wait(450);await geometry('narrow');
  writeControl({hold:['real-shell',...Array.from({length:5},(_,i)=>'fixture-'+i)]});for(const id of control.hold)await read(id);await until(async()=>await activeCount()===6,'narrow all targets');await wait(400);await geometry('narrow-all-targets');await shot('narrow');await release();
  writeControl({count:30});await refresh();await until(()=>cdp.eval(`document.querySelectorAll('[data-dashboard-session-id]').length===31`),'many sessions');await wait(400);await geometry('many-long-labels');record('all-31-sessions-fit-on-page',true);await shot('many-fit');
  writeControl({hold:['real-shell',...Array.from({length:30},(_,i)=>'fixture-'+i)]});for(const id of control.hold)await read(id);await until(async()=>await activeCount()===31,'31 concurrent targets');await wait(400);await geometry('many-long-labels-all-active');await release();
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await wait(100);
  const reducedPositions=()=>cdp.eval(`[...document.querySelectorAll('.orchestrator-dashboard-cell')].map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,transition:getComputedStyle(e.querySelector('.orchestrator-dashboard-sphere')).transitionDuration}})`);
  const reduced=await reducedPositions();await wait(250);assert.deepEqual(await reducedPositions(),reduced);assert(reduced.every(e=>e.transition==='0s'));record('reduced-motion-disabled',true);
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
  assert.equal(await cdp.eval(`document.querySelectorAll('.orchestrator-dashboard-cell').length`),0);record('closed-dashboard-removes-floating-cells',true);
  writeControl({count:0});await refresh();await click('.orchestrator-nav-button');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1500,height:1100,deviceScaleFactor:1,mobile:false});
  await until(()=>cdp.eval(`document.querySelectorAll('[data-dashboard-session-id]').length===1`),'single session');await wait(400);
  await until(()=>cdp.eval(`document.querySelector('.orchestrator-dashboard-cell')?.style.transform.startsWith('translate3d')`),'reopened single session resumes visible motion');
  await geometry('single-session');
  assert(await cdp.eval(`(()=>{const v=document.querySelector('.orchestrator-dashboard-viewport').getBoundingClientRect(),c=document.querySelector('.orchestrator-dashboard-cell').getBoundingClientRect();return Math.abs(c.x+c.width/2-v.x-v.width/2)<30&&Math.abs(c.y+c.height/2-v.y-v.height/2)<30})()`),'single bubble starts near center and can roam');
  await shot('single');
  // Durable work records are observed turn endings, including work begun outside
  // Orchestrator. A provisional response must not appear as completed work.
  const workTime=Date.now();
  writeControl({count:3,revisions:{
    'fixture-0':{...native,name:'Fix API route validation',projectName:'API',cwd:output+'\\API',turnId:'api-work',turnState:'completed',turnStartedAt:workTime-60000,turnEndedAt:workTime-1000},
    'fixture-1':{...native,provider:'claude',name:'Build settings screen',projectName:'Website',cwd:output+'\\Website',turnId:'website-work',turnState:'failed',turnStartedAt:workTime-50000,turnEndedAt:workTime-500},
    'fixture-2':{...native,observation:'provisional',turnId:'unverified-work',turnState:'completed',turnStartedAt:workTime-50000,turnEndedAt:workTime-300}
  }});
  await refresh();await read('fixture-0');await release();
  await click('.orchestrator-dashboard-tabs button:nth-child(2)');
  await until(()=>cdp.eval(`document.querySelectorAll('.orchestrator-work tbody tr').length===2`),'two observed work records');
  assert.equal(await cdp.eval(`document.querySelector('.orchestrator-dashboard').dataset.motion`),'false');
  assert.deepEqual(await cdp.eval(`[...document.querySelectorAll('.orchestrator-work tbody tr')].map(row=>row.dataset.workStatus)`),['failed','completed']);
  assert.equal(await cdp.eval(`document.querySelectorAll('.orchestrator-work select option').length`),3);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await cdp.eval(`document.querySelector('.orchestrator-work details').open=true`);await shot('work-global');
  await cdp.eval(`(()=>{const select=document.querySelector('.orchestrator-work select');select.value=[...select.options].find(option=>option.text.startsWith('API —')).value;select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await until(()=>cdp.eval(`document.querySelectorAll('.orchestrator-work tbody tr').length===1`),'project filtered work');
  assert.match(await cdp.eval(`document.querySelector('.orchestrator-work tbody').textContent`),/Fix API route validation/);
  await shot('work-project');
  writeControl({count:0,revisions:{}});await refresh();
  await cdp.eval(`(()=>{const select=document.querySelector('.orchestrator-work select');select.value='';select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await until(()=>cdp.eval(`document.querySelectorAll('.orchestrator-work tbody tr').length===2`),'closed terminal work retained');
  assert.equal(await cdp.eval(`document.querySelectorAll('.orchestrator-work-open').length`),0);
  assert.equal(await cdp.eval(`(document.querySelector('.orchestrator-work tbody').textContent.match(/Closed/g)||[]).length`),2);
  const history=await cdp.eval(`window.vibe.orchestrator.dispatch({kind:'list_work'})`);assert.equal(history.records.length,2);
  await shot('work-closed');record('work-history-global-project-closure-and-truth',{records:history.records,provisionalExcluded:true});
  await click('.orchestrator-nav-button');await click('[aria-label="Multi mode"]');assert(!await cdp.eval(`Boolean(document.querySelector('.orchestrator-view-host'))`));record('navigation-opens-and-closes-dashboard',true);
  result.pass=true;
}catch(e){result.pass=false;result.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{writeControl({hold:[]});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));cdp?.ws.close();if(child?.pid)spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});console.log(`Artifacts: ${output}`);}})();
