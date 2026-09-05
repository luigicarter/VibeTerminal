"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),net=require("node:net");
const {spawn,spawnSync}=require("node:child_process");
const root=path.resolve(__dirname,"../..");const output=path.join(root,".tmp","orchestrator-smoke",`${Date.now()}-${process.pid}`);fs.mkdirSync(output,{recursive:true});
const packaged=process.argv.includes("--packaged");
const userData=path.join(output,"userData"),docs=path.join(userData,"Documents");
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=20000){const end=Date.now()+ms;let error;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(e){error=e;}await wait(100);}throw Error(`Timeout: ${label} ${error||""}`);}
class Cdp{constructor(url){this.ws=new WebSocket(url);this.pending=new Map();this.n=0;}async open(){await new Promise((res,rej)=>{this.ws.addEventListener("open",res,{once:true});this.ws.addEventListener("error",rej,{once:true});});this.ws.addEventListener("message",e=>{const p=JSON.parse(String(e.data));if(p.id){const q=this.pending.get(p.id);if(q){this.pending.delete(p.id);p.error?q.reject(Error(p.error.message)):q.resolve(p.result);}}});}send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.n;this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}async eval(expression){const r=await this.send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}close(){this.ws.close();}}
async function freePort(){return new Promise(resolve=>{const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
const result={checks:[],output};let child,main,overlay;
const check=(label,value)=>{result.checks.push({label,value});console.log(label,JSON.stringify(value));};
(async()=>{try{
  const port=await freePort();const env={...process.env,VIBE_SCREENSHOT_MODE:"1",VIBE_INTERNAL_SCREENSHOT:"0",VIBE_SCREENSHOT_USER_DATA:userData,VIBE_AGENT_SHIM_BASE_DIR:path.join(output,"shims"),CODEX_HOME:path.join(output,"codex"),CLAUDE_CONFIG_DIR:path.join(output,"claude"),XDG_CONFIG_HOME:path.join(output,"config"),XDG_DATA_HOME:path.join(output,"data")};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL;
  const executable=packaged?path.join(root,"release/win-unpacked/vibeTerminal.exe"):path.join(root,"node_modules/electron/dist/electron.exe");
  child=spawn(executable,[...(packaged?[]:["."]),`--remote-debugging-port=${port}`],{cwd:root,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});const log=fs.createWriteStream(path.join(output,"electron.log"));child.stdout.pipe(log);child.stderr.pipe(log);
  const pages=async()=>await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page=await until(async()=> (await pages()).find(p=>p.type==="page"&&p.url.startsWith("file:")&&!p.url.includes("surface=voice")),"main renderer");main=new Cdp(page.webSocketDebuggerUrl);await main.open();await main.send("Page.enable");await main.send("Emulation.setDeviceMetricsOverride",{width:1500,height:1000,deviceScaleFactor:1,mobile:false});
  await until(()=>main.eval("Boolean(window.vibe?.orchestrator && document.querySelector('.orchestrator-mic'))"),"orchestrator UI");
  const initial=await main.eval("window.vibe.orchestrator.getState()");assert.equal(initial.enabled,false);assert.equal(initial.ready,false);assert.equal(initial.settings.hasKey,false);check("fresh-user",{enabled:initial.enabled,ready:initial.ready,hasKey:initial.settings.hasKey});
  assert(await main.eval("document.querySelector('.orchestrator-mic').disabled"));
  await main.eval("document.querySelector('.workspace-settings-button').click()");
  await until(()=>main.eval("Boolean(document.querySelector('#settings-dialog-title'))"),"settings dialog");
  await main.eval("Array.from(document.querySelectorAll('.orchestrator-settings button')).find(b=>b.textContent==='Load models').click()");
  await until(()=>main.eval("document.querySelector('.settings-note[role=status]')?.textContent.includes('OpenRouter')"),"missing-key model error");
  const settingsShot=await main.send("Page.captureScreenshot",{format:"png"});fs.writeFileSync(path.join(output,"settings.png"),Buffer.from(settingsShot.data,"base64"));
  await main.eval("Array.from(document.querySelectorAll('.settings-navigation button')).find(b=>b.textContent==='Appearance').click()");
  await until(()=>main.eval("Boolean(document.querySelector('[role=radiogroup]'))"),"appearance settings");
  await main.eval("document.querySelector('[aria-label=\"Close settings\"]').click()");
  check("settings-navigation",{missingKeyHandled:true,appearanceAvailable:true});
  const project=await main.eval(`window.vibe.orchestrator.dispatch({kind:'create_project',parent:${JSON.stringify(docs)},name:'Budget Tracker'})`);assert.equal(project.ok,true,JSON.stringify(project));
  assert.equal(project.path,path.join(docs,"Budget Tracker"));await until(()=>main.eval("document.querySelector('.workspace-title').textContent.includes('Budget Tracker')"),"project selected");check("create-project",project.path);
  const created=await main.eval(`window.vibe.orchestrator.dispatch({kind:'create_session',kindOfSession:'terminal',cwd:${JSON.stringify(project.path)}})`);assert.equal(created.ok,true,JSON.stringify(created));
  const paneId=created.id||created.sessionId;assert(paneId,JSON.stringify(created));
  await until(()=>main.eval(`window.vibe.terminal.getRuntimeSnapshots().then(s=>s.find(s=>s.id===${JSON.stringify(paneId)}&&s.processState==='running'))`),"plain terminal started");
  let session=await main.eval(`window.vibe.orchestrator.getState().then(s=>s.sessions.find(s=>s.id===${JSON.stringify(paneId)}))`);
  if(!session?.generation||session.generation.startsWith("paused:"))session=await until(()=>main.eval(`window.vibe.orchestrator.getState().then(s=>s.sessions.find(s=>s.id===${JSON.stringify(paneId)}&&!s.generation.startsWith('paused:')))`),"live relay identity");
  const target={id:paneId,generation:session.generation};
  const draft=await main.eval(`window.vibe.orchestrator.dispatch({kind:'stage_draft',target:${JSON.stringify(target)},text:'Write-Output relay-smoke'})`);assert.equal(draft.ok,true,JSON.stringify(draft));
  const before=await main.eval(`window.vibe.orchestrator.dispatch({kind:'read_session',target:${JSON.stringify(target)}})`);assert.equal(before.ok,true);assert(!before.observation.text.includes("relay-smoke"),"draft must not send PTY bytes");
  const send=await main.eval(`window.vibe.orchestrator.dispatch({kind:'send_prompt',target:${JSON.stringify(target)},text:'Write-Output relay-smoke'})`);assert.equal(send.ok,true,JSON.stringify(send));assert.equal(send.status,"written");
  await until(()=>main.eval(`window.vibe.orchestrator.dispatch({kind:'read_session',target:${JSON.stringify(target)}}).then(r=>r.observation?.text.includes('relay-smoke'))`),"acknowledged command output");check("draft-and-send",{draft:draft.status,send:send.status});
  const saved=await main.eval("window.vibe.orchestrator.dispatch({kind:'save_setup',name:'Test setup'})");assert.equal(saved.ok,true,JSON.stringify(saved));
  const listed=await main.eval(`window.vibe.setups.list({projectPath:${JSON.stringify(project.path)}})`);assert(listed.some(s=>s.name==="Test setup"));
  const loaded=await main.eval("window.vibe.orchestrator.dispatch({kind:'launch_setup',name:'Test setup'})");assert.equal(loaded.ok,true,JSON.stringify(loaded));check("setup-save-launch",{saved:saved.ok,loaded:loaded.ok});
  const preference=await main.eval("window.vibe.orchestrator.preferences({operation:'remember',text:'Use concise updates'})");assert.equal(preference.ok,true);assert(fs.readFileSync(path.join(userData,"orchestrator-settings.json"),"utf8").includes("Use concise updates"));
  assert(!fs.readFileSync(path.join(userData,"orchestrator-settings.json"),"utf8").includes("relay-smoke"));
  const shot=await main.send("Page.captureScreenshot",{format:"png"});fs.writeFileSync(path.join(output,"workspace.png"),Buffer.from(shot.data,"base64"));
  await main.eval("window.vibe.orchestrator.showOverlay()");const voice=await until(async()=> (await pages()).find(p=>p.url.includes("surface=voice")),"voice overlay");overlay=new Cdp(voice.webSocketDebuggerUrl);await overlay.open();
  await until(()=>overlay.eval("Boolean(document.querySelector('.voice-overlay'))"),"overlay loaded");assert.equal(await overlay.eval("typeof window.vibe.terminal"),"undefined");assert.equal(await overlay.eval("typeof window.vibe.orchestrator.configure"),"undefined");
  const voiceState=await overlay.eval("window.vibe.voice.getState()");assert.equal(voiceState.listening,false);
  const voiceShot=await overlay.send("Page.captureScreenshot",{format:"png"});fs.writeFileSync(path.join(output,"overlay.png"),Buffer.from(voiceShot.data,"base64"));check("overlay",{phase:voiceState.phase,narrowPreload:true});
  result.pass=true;
}catch(error){result.pass=false;result.error=error.stack;console.error(error.stack);process.exitCode=1;if(main){try{const shot=await main.send("Page.captureScreenshot",{format:"png"});fs.writeFileSync(path.join(output,"failure.png"),Buffer.from(shot.data,"base64"));}catch{}}}
finally{fs.writeFileSync(path.join(output,"results.json"),JSON.stringify(result,null,2));main?.close();overlay?.close();if(child?.pid)spawnSync("taskkill",["/pid",String(child.pid),"/t","/f"],{windowsHide:true,stdio:"ignore"});console.log(`Artifacts: ${output}`);}})();
