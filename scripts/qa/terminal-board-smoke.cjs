const assert = require("assert");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const root = path.resolve(__dirname, "../..");
const runId = `${Date.now()}-${process.pid}`;
const output = path.join(root, ".tmp", "terminal-board-smoke", runId);
fs.mkdirSync(output, { recursive: true });
const ptyLog = path.join(output, "pty.jsonl");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = { runId, output, build: fs.readdirSync(path.join(root,"dist/assets")).filter(x=>x.endsWith(".js")), checks: [] };
const check = (name, value) => { result.checks.push({name,value}); console.log(name, JSON.stringify(value)); };
class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.n=0; this.pending=new Map(); }
  async open() { await new Promise((resolve,reject)=>{this.ws.addEventListener("open",resolve,{once:true});this.ws.addEventListener("error",reject,{once:true});}); this.ws.addEventListener("message",event=>{const p=JSON.parse(String(event.data));if(p.id){const q=this.pending.get(p.id);if(q){this.pending.delete(p.id);p.error?q.reject(Error(p.error.message)):q.resolve(p.result);}}}); }
  send(method,params={}) { return new Promise((resolve,reject)=>{const id=++this.n;this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));}); }
  async eval(expression) { const r=await this.send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value; }
}
async function port() {return new Promise(resolve=>{const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function until(fn,label,timeout=15000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const r=await fn();if(r)return r;}catch(e){last=e;}await sleep(100);}throw Error(`Timeout: ${label} ${last||""}`);}
let child,cdp;
const selector=id=>`[data-session-id="${id}"]`;
async function geometry(id) {return cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector(id))});if(!e)return null;const r=e.getBoundingClientRect(),b=document.querySelector('.tiled-board').getBoundingClientRect();return {left:r.left-b.left-10,top:r.top-b.top,width:r.width,height:r.height,clientX:r.left,clientY:r.top};})()`);}
async function point(sel){return cdp.eval(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);}
async function click(sel){const p=await point(sel);await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",...p,button:"left",clickCount:1});await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",...p,button:"left",clickCount:1});}
async function drag(id,dx,dy,shift=false,edge){const p=await point(selector(id)+(edge?` .pane-resize-edge-${edge}`:" .pane-title"));const modifiers=shift?8:0;await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",...p,button:"left",clickCount:1,modifiers});for(let i=1;i<=8;i++){await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:p.x+dx*i/8,y:p.y+dy*i/8,buttons:1,modifiers});await sleep(35);}await sleep(120);const preview=await geometry(id);await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:p.x+dx,y:p.y+dy,button:"left",clickCount:1,modifiers});await sleep(350);return {preview,committed:await geometry(id)};}
let stage=0;
async function seed(rects,live=false){stage++; const w=await cdp.eval(`document.querySelector('.tiled-board')?.clientWidth-20 || 1000`);const sessions=rects.map(r=>({id:r.id,name:r.id,kind:r.kind||"terminal",command:r.command||"",cwd:output,createdAt:Date.now(),started:live,nextLaunchMode:"new",launchToken:stage,status:"idle",layout:{x:r.left/w*100,y:r.top,w:r.width/w*100,h:r.height,unit:"fluid"}}));await cdp.eval(`(async()=>{for(const s of await window.vibe.terminal.getRuntimeSnapshots())await window.vibe.terminal.kill(s.sessionId||s.id);localStorage.setItem('vibe-terminal:workspaces:v2',${JSON.stringify(JSON.stringify([{id:"qa",name:"QA Board",path:output,sessions},{id:"hidden",name:"QA Hidden",path:root,sessions:[]}]))});localStorage.setItem('vibe-terminal:active-workspace:v1','qa');localStorage.setItem('vibe-terminal:active-view:v1','project');location.reload();})()`);await until(()=>cdp.eval(`document.querySelectorAll('.pane-frame').length===${rects.length}`),"seed panes");await until(async()=>{if(stage===1)return cdp.eval(`(()=>{const b=document.querySelector(".tiled-board");return b.clientWidth>500;})()`);const currentWidth=await cdp.eval(`document.querySelector(".tiled-board").clientWidth-20`);for(const r of rects){const g=await geometry(r.id);if(!g||Math.abs(g.width-Math.max(280,r.width/w*currentWidth))>2||Math.abs(g.height-r.height)>2)return false;}return true;},"seed geometry settled");await sleep(stage===1?800:200);return await cdp.eval(`document.querySelector('.tiled-board').clientWidth-20`);}
function closeEnough(a,b,label){for(const k of ["left","top","width","height"])assert(Math.abs(a[k]-b[k])<1,`${label} ${k}: ${a[k]} != ${b[k]}`);}
(async()=>{
 try {
  const debugPort=await port();const env={...process.env,VIBE_SCREENSHOT_MODE:"1",VIBE_INTERNAL_SCREENSHOT:"0",VIBE_SCREENSHOT_USER_DATA:path.join(output,"userData"),VIBE_SCREENSHOT_PTY_DEBUG:ptyLog,CODEX_HOME:path.join(output,"codex"),CLAUDE_CONFIG_DIR:path.join(output,"claude"),GEMINI_CLI_HOME:path.join(output,"gemini"),QWEN_HOME:path.join(output,"qwen"),KIMI_CODE_HOME:path.join(output,"kimi"),XDG_CONFIG_HOME:path.join(output,"xdg-config"),XDG_DATA_HOME:path.join(output,"xdg-data"),VIBE_AGENT_SHIM_BASE_DIR:path.join(output,"shims")};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
  child=spawn(path.join(root,"node_modules/electron/dist/electron.exe"),[".",`--remote-debugging-port=${debugPort}`],{cwd:root,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  const log=fs.createWriteStream(path.join(output,"electron.log"));child.stdout.pipe(log);child.stderr.pipe(log);
  const target=await until(async()=>{const t=await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();return t.find(x=>x.type==="page"&&x.url.startsWith("file:"));},"CDP renderer",30000);
  cdp=new Cdp(target.webSocketDebuggerUrl);await cdp.open();await cdp.send("Page.enable");await cdp.send("Emulation.setDeviceMetricsOverride",{width:1500,height:1050,deviceScaleFactor:1,mobile:false});await sleep(600);
  await seed([{id:"initial",left:0,top:10,width:500,height:260}]);let iw=await cdp.eval(`document.querySelector('.tiled-board').clientWidth-20`);
  await seed([{id:"top",left:0,top:10,width:iw,height:196},{id:"bottom",left:0,top:480,width:iw,height:324}]);
  await click(selector("top")+' button[title="Pane actions"]');
  await click('.pane-action-menu button[title="Add matching pane"]');
  const newId=await until(()=>cdp.eval(`Array.from(document.querySelectorAll('.pane-frame')).map(e=>e.dataset.sessionId).find(id=>id!=='top'&&id!=='bottom')`),"new pane");await sleep(400);const created=await geometry(newId);assert(Math.abs(created.top-210)<1,"new pane must occupy y210 hole");check("new-pane-hole",created);
  const fixedWidth=iw-350;await seed([{id:"fixed",left:0,top:10,width:fixedWidth,height:400},{id:"move",left:0,top:450,width:500,height:220}]);const fixedBefore=await geometry("fixed");const moved=await drag("move",fixedWidth-50,-440);closeEnough(moved.preview,moved.committed,"drag preview/release");closeEnough(await geometry("fixed"),fixedBefore,"ordinary drag neighbor");assert(moved.committed.left>=fixedWidth+3);check("ordinary-drag",moved);
  const beforeMove=await geometry("move"),beforeFixed=await geometry("fixed");const swapped=await drag("move",-beforeMove.left+100,0,true);closeEnough(swapped.preview,swapped.committed,"swap preview/release");closeEnough(swapped.committed,beforeFixed,"explicit swap destination");closeEnough(await geometry("fixed"),beforeMove,"explicit swap peer");check("shift-swap",swapped);
  await seed([{id:"live",left:0,top:10,width:500,height:260}],true);await until(()=>cdp.eval(`document.querySelector('${selector("live")} .xterm-rows')?.textContent.length>0`),"live shell",20000);const resized=await drag("live",100,100,false,"se");closeEnough(resized.preview,resized.committed,"resize preview/release");await sleep(500);const term=await cdp.eval(`(()=>{const e=document.querySelector('${selector("live")}');const s=e.querySelector('.xterm-screen').getBoundingClientRect(),c=e.querySelector('.xterm-char-measure-element').getBoundingClientRect();return {cols:Math.round(s.width/(c.width/32)),rows:e.querySelector(".xterm-rows").children.length,screen:{width:s.width,height:s.height},char:{width:c.width/32,height:c.height}};})()`);const records=fs.readFileSync(ptyLog,"utf8").trim().split("\n").map(x=>JSON.parse(x));const pty=records.filter(x=>x.id==="live"&&x.cols&&x.rows).at(-1);check("resize-diagnostics",{term,pty});assert(pty,"PTY size recorded");assert.equal(pty.cols,term.cols,"PTY columns agree with xterm screen");assert.equal(pty.rows,term.rows,"PTY rows agree with xterm screen");check("resize-pty-fit",{resized,term,pty});
  const runtime=await cdp.eval(`window.vibe.terminal.getRuntimeSnapshots()`);check("runtime-snapshots",runtime);
  await cdp.eval(`Array.from(document.querySelectorAll('.workspace-button')).find(e=>e.textContent.includes('QA Hidden')).click()`);
  await until(()=>cdp.eval(`!document.querySelector('${selector("live")}')`),"hidden pane unmounted");
  await cdp.eval(`(async()=>{const s=(await window.vibe.terminal.getRuntimeSnapshots()).find(s=>s.id==='live');window.vibe.terminal.input('live',"[Console]::Write([char]27 + ']0;QA Hidden OSC' + [char]7)\\r".replace('\\\\r','\\r'),{generation:s.generation,launchToken:s.launchToken});})()`);
  const hiddenTitle=await until(()=>cdp.eval(`window.vibe.terminal.getRuntimeSnapshots().then(s=>s.find(s=>s.id==='live'&&s.terminalTitle==='QA Hidden OSC'))`),"OSC runtime while hidden",10000);
  await cdp.eval(`Array.from(document.querySelectorAll('.workspace-button')).find(e=>e.textContent.includes('QA Board')).click()`);
  await until(()=>cdp.eval(`document.querySelector('${selector("live")} .pane-title')?.textContent.includes('QA Hidden OSC')`),"OSC title on remount");check("hidden-runtime-OSC",hiddenTitle);
  await seed([{id:"live",left:0,top:310,width:500,height:260},{id:"scroll-marker",left:0,top:1200,width:500,height:170}],true);
  await cdp.eval(`document.querySelector('.tiled-board').parentElement.scrollTop=150`);await sleep(200);
  const scrollBefore=await geometry("live");assert(scrollBefore.clientY>0,"drag header visible in scrolled viewport");const scrolled=await drag("live",20,40);closeEnough(scrolled.preview,scrolled.committed,"scrolled preview/release");assert(Math.abs(scrolled.committed.top-(scrollBefore.top+40))<1,"scrolled drag changes board y by pointer delta");check("scrolled-drag",{scrollBefore,...scrolled});
  const boardOverflow=await cdp.eval(`(()=>{const b=document.querySelector('.tiled-board'),h=b.parentElement;return {boardWidth:b.getBoundingClientRect().width,parentBoundsWidth:h.getBoundingClientRect().width,clientWidth:h.clientWidth,scrollWidth:h.scrollWidth,clientHeight:h.clientHeight,scrollHeight:h.scrollHeight};})()`);check("board-overflow",boardOverflow);assert(boardOverflow.scrollWidth<=boardOverflow.clientWidth+1,"ordinary board must not overflow horizontally when tile minima fit");
  // Compact-pane activity details are portaled into the viewport and Escape
  // must dismiss this UI without sending an interrupt to the live shell.
  await seed([{id:"popover",left:0,top:10,width:360,height:170}],true);
  await until(()=>cdp.eval(`window.vibe.terminal.getRuntimeSnapshots().then(s=>s.some(s=>s.id==='popover'&&s.processState==='running'))`),"popover shell alive");
  await click(selector("popover")+' button[aria-label="Terminal activity"]');
  const popover=await until(()=>cdp.eval(`(()=>{const e=document.querySelector('[aria-label="Terminal activity details"]');if(!e||getComputedStyle(e).visibility==='hidden')return null;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,parent:e.parentElement.tagName};})()`),"activity portal");
  assert.equal(popover.parent,"BODY");assert(popover.left>=0&&popover.top>=0&&popover.right<=popover.width&&popover.bottom<=popover.height,"activity portal stays inside viewport");
  await cdp.send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await cdp.send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  await until(()=>cdp.eval(`!document.querySelector('[aria-label="Terminal activity details"]')`),"Escape dismisses details");
  assert(await cdp.eval(`window.vibe.terminal.getRuntimeSnapshots().then(s=>s.some(s=>s.id==='popover'&&s.processState==='running'))`));check("activity-portal",popover);

  // The fixture owns no model/API client. Its only network destination is the
  // app's authenticated loopback callback inherited by this isolated pane.
  const fixture=path.join(output,"fake-codex.cjs"),queue=path.join(output,"events.jsonl"),acks=path.join(output,"acks.jsonl");
  const rootId=crypto.randomUUID(),turnId=crypto.randomUUID();fs.writeFileSync(queue,"");
  fs.writeFileSync(fixture,`const fs=require('fs'),path=require('path');
const rootId=${JSON.stringify(rootId)},turnId=${JSON.stringify(turnId)},queue=${JSON.stringify(queue)},acks=${JSON.stringify(acks)};
const home=process.env.CODEX_HOME,dir=path.join(home,'sessions','2026','09','04');fs.mkdirSync(dir,{recursive:true});
const transcript=path.join(dir,'rollout-qa-'+rootId+'.jsonl');fs.writeFileSync(transcript,JSON.stringify({type:'session_meta',payload:{id:rootId,cwd:process.cwd(),timestamp:new Date().toISOString(),originator:'Codex CLI',source:'cli'}})+'\\n');
fs.writeFileSync(path.join(home,'session_index.jsonl'),JSON.stringify({id:rootId,thread_name:'QA Conversation Name',updated_at:new Date().toISOString()})+'\\n');
let offset=0;async function loop(){const lines=fs.readFileSync(queue,'utf8').trim().split('\\n').filter(Boolean);while(offset<lines.length){const e=JSON.parse(lines[offset++]);const body={...e,provider:'codex',sessionId:process.env.VIBE_TERMINAL_SESSION_ID,launchNonce:process.env.VIBE_TERMINAL_LAUNCH_NONCE,providerThreadId:rootId,providerTurnId:e.providerTurnId||turnId,transcriptPath:transcript,cwd:process.cwd(),pid:process.pid,processId:'qa-root-process',timestamp:Date.now()};try{const r=await fetch(process.env.VIBE_TERMINAL_CALLBACK_URL,{method:'POST',headers:{'content-type':'application/json','x-vibe-telemetry-token':process.env.VIBE_TERMINAL_TELEMETRY_TOKEN},body:JSON.stringify(body)});fs.appendFileSync(acks,JSON.stringify({n:offset,status:r.status})+'\\n');}catch(error){fs.appendFileSync(acks,JSON.stringify({n:offset,error:String(error)})+'\\n');}}setTimeout(loop,80);}loop();`);
  await seed([{id:"fake-codex",kind:"codex",command:`node '${fixture.replace(/'/g,"''")}'`,left:0,top:10,width:560,height:320}],true);
  let eventCount=0;
  const post=async event=>{fs.appendFileSync(queue,JSON.stringify(event)+"\n");eventCount++;await until(()=>{if(!fs.existsSync(acks))return false;const a=fs.readFileSync(acks,"utf8").trim().split("\n").map(x=>JSON.parse(x)).find(x=>x.n===eventCount);if(a)assert(a.status>=200&&a.status<300,JSON.stringify(a));return a;},"fixture callback acknowledgement");};
  const snap=()=>cdp.eval(`window.vibe.terminal.getRuntimeSnapshots().then(s=>s.find(s=>s.id==='fake-codex'))`);
  await post({type:"agent.process.started"});await post({type:"agent.running"});
  await until(async()=>{const s=await snap();return s?.turnState==="running"&&s.conversation?.title==="QA Conversation Name";},"validated root name/running",30000);
  assert(await cdp.eval(`document.querySelector('${selector("fake-codex")} .pane-title').textContent.includes('QA Conversation Name')`));
  assert(await cdp.eval(`Array.from(document.querySelectorAll('.workspace-button')).find(e=>e.textContent.includes('QA Board')).textContent.toLowerCase().includes('working')`),"sidebar reflects running");
  await post({type:"agent.waiting",detail:"approval"});await until(async()=> (await snap())?.attention?.state==="waiting","approval wait");
  await post({type:"agent.running",detail:"tool"});await until(async()=>{const s=await snap();return s?.turnState==="running"&&!s.attention;},"approval cleared by resume");
  await post({type:"agent.activity",phase:"start",toolId:"tool-1",toolName:"Read fixture"});
  await post({type:"agent.activity",phase:"start",taskId:"child-1",taskLabel:"First child"});
  await post({type:"agent.activity",phase:"start",taskId:"child-2",taskLabel:"Second child"});
  await until(async()=> (await snap())?.children.length===2,"exact two children");
  await post({type:"agent.completed"});await until(async()=> (await snap())?.turnState==="completed","root completion");
  assert(await cdp.eval(`document.querySelector('${selector("fake-codex")} button[aria-label="Terminal activity"]').textContent.toLowerCase().includes('working')`),"pending children keep activity working");
  await post({type:"agent.activity",phase:"stop",taskId:"child-1"});await until(async()=> (await snap())?.children.length===1,"one child remains");
  await post({type:"agent.activity",phase:"stop",taskId:"child-2"});await until(async()=>{const s=await snap();return s?.children.length===0&&s.turnState==="completed";},"final child completed");
  await until(()=>cdp.eval(`document.querySelector('${selector("fake-codex")} button[aria-label="Terminal activity"]').textContent.toLowerCase().includes('done')`),"done activity pill");
  assert(!await cdp.eval(`document.querySelector('${selector("fake-codex")} .terminal-pane').classList.contains('terminal-pane-attention')`),"visible selected completion does not leave stale attention glow");
  check("fake-codex-lifecycle",await snap());
  const scopedInput=async data=>cdp.eval(`(async()=>{const s=await window.vibe.terminal.getRuntimeSnapshots().then(s=>s.find(s=>s.id==='fake-codex'));window.vibe.terminal.input(s.id,${JSON.stringify(data)},{generation:s.generation,launchToken:s.launchToken});})()`);
  const pill=()=>cdp.eval(`document.querySelector('${selector("fake-codex")} button[aria-label="Terminal activity"]').textContent.toLowerCase()`);
  const summary=()=>cdp.eval(`Array.from(document.querySelectorAll('.workspace-button')).find(e=>e.textContent.includes('QA Board')).textContent.toLowerCase()`);
  await scopedInput("\r");
  await until(async()=> (await snap())?.pendingInput==="submit"&&(await pill()).includes("awaiting activity"),"submit intent displayed neutrally");
  const pendingSummary=await summary();assert(!pendingSummary.includes("working")&&!pendingSummary.includes("done"),"pending submit must not claim running or retain completed sidebar count");check("input-submit-intent",await snap());
  const notifyTurn=crypto.randomUUID();
  await post({type:"agent.completed",providerTurnId:notifyTurn});
  await until(async()=>{const s=await snap();return s?.turnId===notifyTurn&&s.turnState==="completed"&&!s.pendingInput&&(await pill()).includes("done");},"notify-only next completion accepted");
  assert.equal((await snap()).turnStartedAt,undefined,"notify-only completion has no invented start time");
  await click(selector("fake-codex")+' button[aria-label="Terminal activity"]');
  await until(()=>cdp.eval(`Boolean(document.querySelector('[aria-label="Terminal activity details"]'))`),"notify-only details open");
  assert(!await cdp.eval(`document.querySelector('[aria-label="Terminal activity details"]').textContent.includes('Turn elapsed')`),"notify-only completion has no fabricated elapsed duration");
  await cdp.send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await cdp.send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  check("notify-only-completion",await snap());
  const nativeTurn=crypto.randomUUID();await post({type:"agent.running",providerTurnId:nativeTurn});
  await until(async()=> (await snap())?.turnId===nativeTurn&&(await pill()).includes("working"),"native new turn observed");
  await scopedInput("\x1b");
  await until(async()=> (await snap())?.pendingInput==="interrupt"&&(await pill()).includes("interrupt requested"),"interrupt intent displayed neutrally");
  assert(!(await summary()).includes("working"),"interrupt request is not authoritative working");
  await post({type:"agent.activity",phase:"start",toolId:"post-interrupt-tool",toolName:"Still running fixture",providerTurnId:nativeTurn});
  await until(async()=>{const s=await snap();return !s?.pendingInput&&s?.turnState==="running"&&(await pill()).includes("working");},"native tool activity supersedes interrupt intent");
  assert.equal((await snap()).agentProcessState,"running","ESC must not kill fixture");check("interrupt-activity-recovery",await snap());
  await post({type:"agent.completed",providerTurnId:nativeTurn});await until(async()=> (await pill()).includes("done"),"final fixture completion");
  const screenshot=await cdp.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});fs.writeFileSync(path.join(output,"final.png"),Buffer.from(screenshot.data,"base64"));result.pass=true;
 } catch(e) {result.pass=false;result.error=e.stack;console.error(e.stack);if(cdp){try{result.failureRuntime=await cdp.eval(`window.vibe.terminal.getRuntimeSnapshots()`);console.error("Failure runtime",JSON.stringify(result.failureRuntime));const shot=await cdp.send("Page.captureScreenshot",{format:"png"});fs.writeFileSync(path.join(output,"failure.png"),Buffer.from(shot.data,"base64"));}catch{}}process.exitCode=1;
 } finally {fs.writeFileSync(path.join(output,"results.json"),JSON.stringify(result,null,2));if(cdp)cdp.ws.close();if(child?.pid)spawnSync("taskkill",["/pid",String(child.pid),"/t","/f"],{windowsHide:true,stdio:"ignore"});console.log(`Artifacts: ${output}`);}
})();
