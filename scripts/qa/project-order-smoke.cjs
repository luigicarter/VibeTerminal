"use strict";
// Isolated Electron integration test. Never connects a provider or writes to a user's terminal.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.tmp','project-order-smoke',`${Date.now()}-${process.pid}`);
fs.mkdirSync(output,{recursive:true});
const userData=path.join(output,'userData');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=20000){const end=Date.now()+ms;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e;}await sleep(100);}throw Error(`Timeout: ${label}: ${last||''}`);}
class Cdp{
 constructor(url){this.ws=new WebSocket(url);this.n=0;this.pending=new Map();}
 async open(){await new Promise((resolve,reject)=>{this.ws.addEventListener('open',resolve,{once:true});this.ws.addEventListener('error',reject,{once:true});});this.ws.addEventListener('message',e=>{const p=JSON.parse(String(e.data)),q=this.pending.get(p.id);if(q){this.pending.delete(p.id);p.error?q.reject(Error(p.error.message)):q.resolve(p.result);}});}
 send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.n;this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}
 async eval(expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
}
async function freePort(){return new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
let child,cdp;const result={output,checks:[]};const check=(name,value)=>{result.checks.push({name,value});console.log(name,JSON.stringify(value));};
async function shot(name){const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));}

async function order(){return cdp.eval(`Array.from(document.querySelectorAll('.workspace-row')).map(e=>e.dataset.workspaceId)`);}
async function key(id,key){await cdp.eval(`document.querySelector('[data-workspace-id="${id}"] .workspace-reorder-grip').focus()`);await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:key==='ArrowUp'?38:40});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key});await sleep(150);}
async function drag(id,target,position,scrollTest=false){
 const points=await cdp.eval(`(()=>{const a=document.querySelector('[data-workspace-id="${id}"] .workspace-reorder-grip').getBoundingClientRect(),b=document.querySelector('[data-workspace-id="${target}"]').getBoundingClientRect();return {from:{x:a.left+a.width/2,y:a.top+a.height/2},to:{x:b.left+b.width/2,y:b.top+${position==='before'?'8':'b.height-8'}}};})()`);
 await cdp.send('Input.setInterceptDrags',{enabled:true});
 const intercepted=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Native drag did not start')),5000);const handler=e=>{const p=JSON.parse(String(e.data));if(p.method==='Input.dragIntercepted'){clearTimeout(timeout);cdp.ws.removeEventListener('message',handler);resolve(p.params.data);}};cdp.ws.addEventListener('message',handler);});
 await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...points.from});await sleep(100);
 await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...points.from,button:'left',clickCount:1});
 for(let n=1;n<=8;n++){await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:points.from.x+8*n,y:points.from.y+5*n,button:'left',buttons:1});await sleep(50);}
 const data=await intercepted;
 if(scrollTest){
   const edge=await cdp.eval(`(()=>{const r=document.querySelector('.workspace-list').getBoundingClientRect();return {x:r.left+r.width/2,y:r.bottom-8};})()`);
   await cdp.send('Input.dispatchDragEvent',{type:'dragEnter',...edge,data});
   for(let n=0;n<12;n++){await cdp.send('Input.dispatchDragEvent',{type:'dragOver',...edge,data});await sleep(60);}
   const scrolled=await cdp.eval(`document.querySelector('.workspace-list').scrollTop`);assert(scrolled>100,'edge scroll exposes later projects');check('long-list-edge-scroll',scrolled);await shot('long-list-edge-scroll');
   await cdp.send('Input.dispatchDragEvent',{type:'dragCancel',...edge,data});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...edge,button:'left',clickCount:1});await cdp.send('Input.setInterceptDrags',{enabled:false});await sleep(100);return;
 }
 await cdp.send('Input.dispatchDragEvent',{type:'dragEnter',...points.to,data});await cdp.send('Input.dispatchDragEvent',{type:'dragOver',...points.to,data});await sleep(150);
 assert(await cdp.eval(`document.querySelector('[data-workspace-id="${target}"]').classList.contains('drop-${position}')`),'visible insertion marker');await shot(`drag-${id}-${position}-${target}`);
 await cdp.send('Input.dispatchDragEvent',{type:'drop',...points.to,data});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...points.to,button:'left',clickCount:1});await sleep(350);
 await cdp.send('Input.setInterceptDrags',{enabled:false});
}
(async()=>{try{
 const port=await freePort(),env={...process.env,VIBE_SCREENSHOT_MODE:'1',VIBE_INTERNAL_SCREENSHOT:'0',VIBE_SCREENSHOT_USER_DATA:userData,VIBE_AGENT_SHIM_BASE_DIR:path.join(output,'shims'),CODEX_HOME:path.join(output,'codex'),CLAUDE_CONFIG_DIR:path.join(output,'claude'),GEMINI_CLI_HOME:path.join(output,'gemini'),QWEN_HOME:path.join(output,'qwen'),KIMI_CODE_HOME:path.join(output,'kimi'),XDG_CONFIG_HOME:path.join(output,'config'),XDG_DATA_HOME:path.join(output,'data')};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
 child=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),['.',`--remote-debugging-port=${port}`],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});result.pid=child.pid;const log=fs.createWriteStream(path.join(output,'electron.log'));child.stdout.pipe(log);child.stderr.pipe(log);
 const page=await until(async()=>{const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();return pages.find(p=>p.type==='page'&&p.url.startsWith('file:')&&!p.url.includes('surface=voice'));},'renderer');cdp=new Cdp(page.webSocketDebuggerUrl);await cdp.open();await cdp.send('Page.enable');await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});

 await until(()=>cdp.eval(`Boolean(window.vibe&&document.querySelector('.workspace-list'))`),'UI');
 const workspaces=['alpha','beta','gamma'].map(id=>({id,name:id,path:output,sessions:[]}));
 await cdp.eval(`localStorage.setItem('vibe-terminal:workspaces:v2',${JSON.stringify(JSON.stringify(workspaces))});localStorage.setItem('vibe-terminal:active-workspace:v1','beta');localStorage.setItem('vibe-terminal:active-view:v1','project');location.reload()`);
 await until(async()=> (await order()).length===3,'projects');
 await cdp.eval(`document.querySelector('[data-launcher-kind="terminal"]').click()`);
 const runtime=await until(()=>cdp.eval(`window.vibe.terminal.getRuntimeSnapshots().then(s=>s.find(s=>s.processState==='running'))`),'live local terminal');
 await cdp.eval(`window.__pane=document.querySelector('[data-session-id="${runtime.id}"]');window.__xterm=window.__pane.querySelector('.xterm');window.__dragEvents=[];for(const name of ['dragstart','drop','dragend'])document.addEventListener(name,e=>window.__dragEvents.push({name,trusted:e.isTrusted}),true)`);
 await drag('alpha','gamma','after');assert.deepEqual(await order(),['beta','gamma','alpha']);
 await drag('alpha','beta','before');assert.deepEqual(await order(),['alpha','beta','gamma']);
 await key('gamma','ArrowUp');assert.deepEqual(await order(),['alpha','gamma','beta']);assert.match(await cdp.eval(`document.querySelector('.workspace-reorder-sr-only[role="status"]').textContent`),/gamma moved to position 2 of 3/);
 await key('alpha','ArrowUp');assert.deepEqual(await order(),['alpha','gamma','beta']);
 const preserved=await cdp.eval(`({active:localStorage.getItem('vibe-terminal:active-workspace:v1'),pane:document.querySelector('[data-session-id="${runtime.id}"]')===window.__pane,xterm:window.__pane.querySelector('.xterm')===window.__xterm,events:window.__dragEvents})`);
 assert.equal(preserved.active,'beta');assert(preserved.pane&&preserved.xterm);assert(preserved.events.some(e=>e.name==='dragstart'&&e.trusted),'real Chromium native drag');
 const after=await cdp.eval(`window.vibe.terminal.getRuntimeSnapshots().then(s=>s.find(s=>s.id==='${runtime.id}'))`);assert.equal(after.generation,runtime.generation);check('native-drag-keyboard-runtime-preserved',{preserved,generation:after.generation,order:await order()});
 assert.deepEqual(await cdp.eval(`JSON.parse(localStorage.getItem('vibe-terminal:workspaces:v2')).map(w=>w.id)`),['alpha','gamma','beta']);
 await cdp.send('Page.reload');await until(async()=>JSON.stringify(await order())===JSON.stringify(['alpha','gamma','beta']),'persisted order');assert.equal(await cdp.eval(`localStorage.getItem('vibe-terminal:active-workspace:v1')`),'beta');check('order-persisted-after-reload',await order());await shot('final');
 const longOrder=['alpha','gamma','beta',...Array.from({length:20},(_,i)=>'extra-'+i)];
 await cdp.eval(`(()=>{const w=JSON.parse(localStorage.getItem('vibe-terminal:workspaces:v2'));for(let i=0;i<20;i++)w.push({id:'extra-'+i,name:'Extra project '+i,path:${JSON.stringify(output)},sessions:[]});localStorage.setItem('vibe-terminal:workspaces:v2',JSON.stringify(w));location.reload();})()`);
 await until(async()=> (await order()).length===23,'long project list');await drag('alpha','gamma','after',true);assert.deepEqual(await order(),longOrder);assert(!await cdp.eval(`Boolean(document.querySelector('.workspace-row.dragging,.workspace-row.drop-before,.workspace-row.drop-after'))`),'cancel clears drag state');check('cancel-preserves-long-order',true);result.pass=true;
}catch(error){result.pass=false;result.error=error.stack;if(cdp)try{result.events=await cdp.eval('window.__dragEvents');console.log(result.events);}catch{}console.error(error.stack);process.exitCode=1;if(cdp)try{await shot('failure');}catch{}}
finally{fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));cdp?.ws.close();if(child?.pid)spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});console.log(`Artifacts: ${output}`);}})();
