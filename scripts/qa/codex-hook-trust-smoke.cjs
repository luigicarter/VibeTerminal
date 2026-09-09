'use strict';
// Read-only native discovery: isolated home/workspace, no thread or model turn.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {codexLifecycleConfigOverrides,codexLifecycleTrustOverride}=require('../../backend/agentTelemetry.cjs');
const executableArg=process.argv.indexOf('--codex-bin');
const executable=(executableArg>=0?process.argv[executableArg+1]:undefined) || process.env.VIBE_TEST_CODEX_BIN;
if(!executable) throw new Error('Supply --codex-bin <native executable> or VIBE_TEST_CODEX_BIN');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lina-codex-native-trust-'));
const win=process.platform==='win32',source=win?'C:\\<session-flags>\\config.toml':'/<session-flags>/config.toml';
const key=source+':user_prompt_submit:0:0';
const tomlString=value=>JSON.stringify(value);
async function list(name,{config='',project='',user=[],hook='observer.cjs',trustHook=hook}={}) {
 const home=path.join(root,name,'home'),cwd=path.join(root,name,'workspace');fs.mkdirSync(home,{recursive:true});fs.mkdirSync(cwd,{recursive:true});
 fs.writeFileSync(path.join(home,'config.toml'),config+`\n[projects.${tomlString(cwd)}]\ntrust_level="trusted"\n`);
 if(project){fs.mkdirSync(path.join(cwd,'.codex'));fs.writeFileSync(path.join(cwd,'.codex','config.toml'),project);}
 const hookPath=path.join(root,hook),trustPath=path.join(root,trustHook);
 const trust=codexLifecycleTrustOverride(process.execPath,trustPath,win);
 const args=['-c',trust,...user,...codexLifecycleConfigOverrides(process.execPath,hookPath,win).flatMap(value=>['-c',value]),'app-server'];
 const env={...process.env,CODEX_HOME:home,XDG_CONFIG_HOME:path.join(home,'xdg-config'),XDG_DATA_HOME:path.join(home,'xdg-data'),XDG_CACHE_HOME:path.join(home,'xdg-cache')};
 for(const k of Object.keys(env))if(k.startsWith('VIBE_TERMINAL_'))delete env[k];
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});let buffer='',stderr='',settled=false;
  const timer=setTimeout(()=>finish(new Error('native hooks/list timeout')),20000);
  function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);child.stdin.end();
   const deliver=()=>error?reject(error):resolve(value);
   if(child.exitCode!==null||child.signalCode!==null)deliver();else{child.once('close',deliver);child.kill();}
  }
  function send(value){child.stdin.write(JSON.stringify(value)+'\n');}
  child.stdin.on('error',()=>{});child.stderr.on('data',x=>{stderr=(stderr+x).slice(-1500);});
  child.on('error',e=>finish(e));child.on('exit',code=>{if(!settled)finish(new Error(`native exited ${code}: ${stderr}`));});
  child.stdout.on('data',data=>{
   buffer+=data;let index;
   while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let response;try{response=JSON.parse(line);}catch{continue;}
    if(response.error){finish(new Error(JSON.stringify(response.error)));return;}
    if(response.id===1){send({method:'initialized',params:{}});send({id:2,method:'hooks/list',params:{cwds:[cwd]}});}
    if(response.id===2){const result=response.result.data[0];if(result.errors?.length)finish(new Error(JSON.stringify(result.errors)));else finish(null,result.hooks);}
   }
  });
  send({id:1,method:'initialize',params:{clientInfo:{name:'lina-hook-trust-smoke',version:'0.1'},capabilities:{experimentalApi:true}}});
 });
}
const app=hooks=>hooks.filter(h=>h.key.startsWith(source+':'));
const custom='[hooks]\nStop=[{hooks=[{type="command",command="echo custom",timeout=5}]}]\n';
(async()=>{
 try{
  let hooks=await list('default');assert.equal(app(hooks).length,6);assert.ok(app(hooks).every(h=>h.trustStatus==='trusted'&&h.enabled));
  console.log('native: six exact generated hooks trusted');
  hooks=await list('custom',{config:custom,project:custom});assert.equal(hooks.length,8);assert.ok(hooks.filter(h=>!app(hooks).includes(h)).every(h=>h.trustStatus!=='trusted'));
  console.log('native: user/project custom hooks remain untrusted');
  hooks=await list('persist-disabled',{config:`[hooks.state.${tomlString(key)}]\nenabled=false\n`});assert.equal(app(hooks).find(h=>h.key===key).enabled,false);assert.equal(app(hooks).find(h=>h.key===key).trustStatus,'trusted');
  hooks=await list('cli-disabled',{user:['-c',`hooks.state={ '${key}'={enabled=false} }`]});assert.equal(app(hooks).find(h=>h.key===key).enabled,false);
  hooks=await list('cli-trust',{user:['-c',`hooks.state={ '${key}'={trusted_hash='sha256:user'} }`]});assert.notEqual(app(hooks).find(h=>h.key===key).trustStatus,'trusted');
  console.log('native: persisted and CLI disablement and explicit CLI trust take precedence');
  hooks=await list('changed-match',{hook:'observer-v2.cjs'});assert.ok(app(hooks).every(h=>h.trustStatus==='trusted'));
  hooks=await list('changed-mismatch',{hook:'observer-v2.cjs',trustHook:'observer.cjs'});assert.ok(app(hooks).every(h=>h.trustStatus!=='trusted'));
  console.log('native: changed command requires matching new hash');
 }finally{
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('lina-codex-native-trust-'));
  // App-server termination can briefly retain file handles on Windows.
  fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
