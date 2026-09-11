'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, duration = 30000) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await wait(100); }
  throw new Error(`Timed out: ${label}`);
}
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const output = path.join(root, '.tmp', 'open-codex', `electron-${Date.now()}`);
  fs.mkdirSync(output, { recursive: true });
  const env = { ...process.env, VIBE_SCREENSHOT_MODE: '1', VIBE_SCREENSHOT_HIDDEN: '1', VIBE_INTERNAL_SCREENSHOT: '0',
    VIBE_SCREENSHOT_USER_DATA: path.join(output, 'app'), VIBE_AGENT_SHIM_BASE_DIR: path.join(output, 'shims'),
    LINA_OPEN_CODEX_PROVIDERS_FILE: path.join(output, 'providers.json'),
    VIBE_SCREENSHOT_PTY_DEBUG: path.join(output, 'pty-debug.jsonl'),
    CODEX_HOME: path.join(output, 'personal-codex'), CLAUDE_CONFIG_DIR: path.join(output, 'claude'),
    XDG_CONFIG_HOME: path.join(output,'xdg-config'), XDG_DATA_HOME:path.join(output,'xdg-data') };
  for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN/.test(key) || ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL'].includes(key)) delete env[key];
  const child = spawn(require('electron'), [__filename, output], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log='';child.stdout.on('data', data=>log+=data); child.stderr.on('data', data=>log+=data);
  const timer=setTimeout(()=>{child.kill();console.error(log.slice(-4000));process.exitCode=1;},100000);
  child.once('exit',code=>{clearTimeout(timer);fs.writeFileSync(path.join(output,'electron.log'),log);console.log(log.slice(-5000));process.exitCode=code||0;});
} else {
  const output=process.argv[2], workspace=path.join(output,'workspace');fs.mkdirSync(workspace,{recursive:true});
  const electron=require('electron'), {app,BrowserWindow}=electron;
  const Module=require('node:module'), original=Module._load;
  const facade=Object.create(electron);let seeded=false, inspecting=false, selected, calls=0, lastModel;
  const events=[], qaWindows=[];
  Object.defineProperty(facade,'BrowserWindow',{value:class extends BrowserWindow {
    static getAllWindows(){return qaWindows.filter(window=>!window.isDestroyed());}
    constructor(options){super({...options,show:false});qaWindows.push(this);
      this.webContents.on('console-message', (_event, ...args) => console.log('renderer:', ...args));
      const send=this.webContents.send.bind(this.webContents);
      this.webContents.send=(channel,...args)=>{if(channel==='terminal:event' || channel==='terminal:runtime') events.push({channel,payload:args[0]});return send(channel,...args);};
      this.webContents.on('did-finish-load',()=>void inspect(this));}
    show(){} showInactive(){} maximize(){} restore(){} focus(){}
  }});
  Module._load=function(name,...args){return name==='electron'?facade:original.call(this,name,...args);};
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    if(String(url).startsWith('http://open-codex-fixture.invalid/')){
      if(String(url).endsWith('/models')) return new Response(JSON.stringify({data:[{id:'fixture-one'},{id:'fixture-two'},{id:'not-configured'}]}),{headers:{'content-type':'application/json'}});
      if(String(url).endsWith('/responses')) return new Response('',{status:404});
      const body=JSON.parse(options.body);calls++;lastModel=body.model;assert.ok(['fixture-one','fixture-two'].includes(body.model));
      return new Response(`data: ${JSON.stringify({choices:[{index:0,delta:{content:'Open Codex terminal fixture complete.'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
    }
    if(/^http:\/\/127\.0\.0\.1:/.test(String(url))) return nativeFetch(url,options);
    throw new Error('External network disabled in Open Codex QA');
  };
  async function inspect(window){
    if(inspecting || window.webContents.getURL().includes('surface='))return;inspecting=true;
    const js=code=>window.webContents.executeJavaScript(code);
    async function capture(name) {
      await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      await wait(300);
      fs.writeFileSync(path.join(output,name),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    }
    try{
      await until(()=>js('!!window.vibe?.modelProviders && !!document.querySelector("#root")?.childElementCount'),'renderer');
      if(!seeded){
        seeded=true;
        const saved=await js(`window.vibe.modelProviders.upsert({name:'QA Provider',baseUrl:'http://open-codex-fixture.invalid/v1',apiMode:'auto',apiKey:'fixture-only',models:[{id:'fixture-one',label:'Fixture One',contextWindow:32768},{id:'fixture-two',label:'Fixture Two',contextWindow:32768}]})`);
        assert.equal(saved.ok,true);
        const list=await js('window.vibe.modelProviders.list()');selected=list.defaultModel;assert.equal(list.models.length,2);assert.ok(!JSON.stringify(list).includes('fixture-only'));
        const home=path.join(output,'app','open-codex');fs.mkdirSync(home,{recursive:true});
        fs.writeFileSync(path.join(home,'config.toml'),`sandbox_mode = "danger-full-access"\napproval_policy = "never"\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`);
        const sessions=[{id:'open-codex-fixture',name:'Open Codex',kind:'open-codex',command:'open-codex',openCodexModel:selected,cwd:workspace,createdAt:Date.now(),started:true,launchToken:1,status:'idle',nextLaunchMode:'new',layout:{x:0,y:0,w:100,h:650,unit:'fluid'}}];
        await js(`localStorage.setItem('vibe-terminal:workspaces:v2',${JSON.stringify(JSON.stringify([{id:'open-codex-project',name:'Open Codex QA',path:workspace,sessions}]))});localStorage.setItem('vibe-terminal:active-workspace:v1','open-codex-project');localStorage.setItem('vibe-terminal:active-view:v1','project');`);
        inspecting=false;window.reload();return;
      }
      await js(`window.__openCodexEvents=[];window.vibe.terminal.onEvent(event=>window.__openCodexEvents.push(event));true;`);
      await until(()=>js(`window.vibe.terminal.getRuntimeSnapshots().then(rows=>rows.some(row=>row.id==='open-codex-fixture' && row.agentProcessState==='running'))`),'native Open Codex process');
      const text=()=>js(`window.__openCodexEvents.filter(row=>row.type==='data').map(row=>row.data).join('')`);
      await until(async()=>/model:\s+qa-provider\//.test((await text()).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')),'native model readiness',45000);
      await capture('terminal.png');
      await js(`window.vibe.terminal.input('open-codex-fixture','/model')`);await wait(200);
      await js(`window.vibe.terminal.input('open-codex-fixture',${JSON.stringify('\r')})`);
      await until(async()=>{const value=await text();return value.includes('Fixture One') && value.includes('Fixture Two');},'configured native model picker');
      await wait(250);
      await capture('models.png');
      assert.ok(!(await text()).includes('not-configured'));
      await js(`window.vibe.terminal.input('open-codex-fixture',${JSON.stringify('\u001b[B')})`);await wait(150);
      await js(`window.vibe.terminal.input('open-codex-fixture',${JSON.stringify('\r')})`);await wait(300);
      await until(async()=>(await text()).includes('Model changed to'),'model switch acknowledgment');
      await js(`window.vibe.terminal.input('open-codex-fixture',${JSON.stringify('\u001b')})`);await wait(200);
      await js(`window.vibe.terminal.input('open-codex-fixture','Say hello to verify this session.')`);await wait(200);
      await js(`window.vibe.terminal.input('open-codex-fixture',${JSON.stringify('\r')})`);
      await until(()=>calls>0,'provider call');
      assert.equal(lastModel,'fixture-two','The CLI model picker routes the selected configured model.');
      await until(()=>js(`window.vibe.terminal.getRuntimeSnapshots().then(rows=>rows.some(row=>row.id==='open-codex-fixture' && row.turnState==='completed'))`),'native completion telemetry');
      const threads=await js(`window.vibe.agentThreads.list({provider:'open-codex',cwd:${JSON.stringify(workspace)}})`);
      assert.equal(threads.status,'found');assert.equal(threads.threads.length,1);assert.equal(threads.threads[0].provider,'open-codex');
      window.webContents.send('menu:event',{type:'action',action:'open-settings'});
      await until(()=>js('!!document.querySelector(".settings-navigation")'),'settings dialog');
      await js(`Array.from(document.querySelectorAll('.settings-navigation button')).find(button=>button.textContent==='Models & providers').click()`);
      await until(()=>js('document.querySelector(".model-provider-settings")?.textContent.includes("QA Provider")'),'Open Codex settings');
      const panels=await js(`Array.from(document.querySelectorAll('.settings-navigation button')).map(button=>button.textContent)`);
      assert.deepEqual(panels,['Orchestrator & voice','Models & providers','Appearance']);
      await wait(250);
      await capture('settings.png');
      await js(`document.querySelector('[aria-label="Edit QA Provider"]').click()`);
      await until(()=>js('!!document.querySelector(".model-provider-provider-form")'),'provider form');
      await wait(250);
      await capture('settings-edit.png');
      await js(`document.querySelector('[aria-label="Close settings"]').click();document.querySelector('.launcher-picker-toggle').click()`);
      await until(()=>js(`!!document.querySelector('.launcher-model-engine')`),'shared launcher model list');
      const labels=await js(`Array.from(document.querySelectorAll('.launcher-picker-item-label')).map(element=>element.textContent)`);
      assert.equal(labels.filter(label=>label==='Fixture One').length,1);assert.equal(labels.filter(label=>label==='Fixture Two').length,1);
      await js(`Array.from(document.querySelectorAll('.launcher-model-engine button')).find(button=>button.textContent==='Open Claude Code').click()`);
      await capture('shared-launcher.png');
      await js(`Array.from(document.querySelectorAll('.launcher-picker-item-label')).find(label=>label.textContent==='Fixture Two').closest('button').click()`);
      const claudePane=await until(()=>js(`JSON.parse(localStorage.getItem('vibe-terminal:workspaces:v2')).flatMap(workspace=>workspace.sessions).find(session=>session.kind==='claude')`),'Open Claude Code from shared list');
      assert.equal(claudePane.providerModelOverride,'fixture-two');
      const configured=await js('window.vibe.modelProviders.list()');assert.equal(configured.profiles.length,1);assert.equal(claudePane.providerProfileId,configured.profiles[0].id);
      await js(`window.vibe.terminal.kill(${JSON.stringify(claudePane.id)},{launchToken:${claudePane.launchToken},reason:'close'})`);
      const state=(await js('window.vibe.terminal.getRuntimeSnapshots()')).find(row=>row.id==='open-codex-fixture');
      await js(`window.vibe.terminal.kill('open-codex-fixture',{generation:${JSON.stringify(state.generation)},reason:'close'})`);
      fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,models:2,threadId:threads.threads[0].id,calls}));
      console.log(`Shared settings and one model list for both CLIs; native Codex /model, turn, telemetry and history passed: ${output}`);app.quit();
    }catch(error){
      fs.writeFileSync(path.join(output,'diagnostics.json'),JSON.stringify(await js(`(async()=>({snapshots:await window.vibe.terminal.getRuntimeSnapshots(),events:window.__openCodexEvents,storage:localStorage.getItem('vibe-terminal:workspaces:v2'),body:document.body.innerText}))()`)));
      fs.writeFileSync(path.join(output,'events.json'),JSON.stringify(events));fs.writeFileSync(path.join(output,'failure.png'),(await window.webContents.capturePage()).toPNG());console.error(error);app.exit(1);}
  }
  require('../../backend/main.cjs');
}
