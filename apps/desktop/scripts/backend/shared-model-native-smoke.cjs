'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),run=path.join(root,'.tmp','shared-models',`native-${Date.now()}`),cwd=path.join(run,'workspace');fs.mkdirSync(cwd,{recursive:true});
process.env.LINA_MODEL_PROVIDERS_FILE=path.join(run,'providers.json');
const providers=require('../../backend/modelProviders.cjs');
const {createGatewayManager}=require('../../backend/claudeProviderGateway.cjs');
const {createRuntimeManager}=require('../../backend/openCodexRuntime.cjs');
const requests=[];
const server=http.createServer(async(req,res)=>{
  let data='';for await(const chunk of req)data+=chunk;
  if(req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
  const body=JSON.parse(data);requests.push({model:body.model,tools:body.tools?.length||0});
  assert.equal(body.model,'fixture-standard');assert.equal(req.headers.authorization,'Bearer fixture-secret');
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{role:'assistant',content:'SHARED_PROVIDER_OK'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}})}\n\ndata: [DONE]\n\n`);
});
async function execute(name,command,args,extraEnv) {
  const env={...process.env};for(const key of Object.keys(env))if(/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_|ELECTRON_RUN_AS_NODE|OPENAI_API_KEY|CODEX_API_KEY)/i.test(key))delete env[key];
  const child=spawn(command,args,{cwd,env:{...env,...extraEnv},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);
  const timeout=setTimeout(()=>child.kill(),60000);
  try {
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    fs.writeFileSync(path.join(run,`${name}-stdout.txt`),out);fs.writeFileSync(path.join(run,`${name}-stderr.txt`),err);
    assert.equal(code,0,`${name}: ${err.slice(-1500)} ${out.slice(-1000)}`);assert.ok(out.includes('SHARED_PROVIDER_OK'),`${name}: ${out.slice(-1000)}`);
  } finally {clearTimeout(timeout);try{child.kill();}catch{}}
}
async function main(){
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const created=providers.upsertProfile({name:'Shared Fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiMode:'chat-completions',apiKey:'fixture-secret',models:[{id:'fixture-standard',label:'Shared fixture',contextWindow:32768}]});assert.equal(created.ok,true);
  const claude=createGatewayManager(),codex=createRuntimeManager({userData:path.join(run,'app'),binaryOptions:{root},cliPath:path.join(root,'backend/openCodexCli.cjs'),nodeCommand:process.execPath});
  try{
    const claudeEnv=await claude.environment(created.profile.id,'fixture-standard');
    const claudeHome=path.join(run,'claude-home');fs.mkdirSync(claudeHome,{recursive:true});fs.writeFileSync(path.join(claudeHome,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true}));
    await execute('claude',process.env.LINA_CLAUDE_BIN || (process.platform==='win32'?path.join(os.homedir(),'.local','bin','claude.exe'):'claude'),['-p','Reply with SHARED_PROVIDER_OK.','--output-format','json','--max-turns','1','--setting-sources',''],{...claudeEnv,CLAUDE_CONFIG_DIR:claudeHome,DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'});
    console.log('Native Open Claude Code used the shared OpenAI-compatible model.');
    const prepared=await codex.prepare({id:'shared-native',generation:'test'});
    await execute('codex',process.execPath,[path.join(root,'backend/openCodexCli.cjs'),'-a','never','exec','--json','--skip-git-repo-check','--sandbox','read-only','-C',cwd,'Reply with SHARED_PROVIDER_OK.'],prepared.env);
    assert.ok(requests.length>=2);assert.ok(requests.every(request=>request.model==='fixture-standard'));
    fs.writeFileSync(path.join(run,'result.json'),JSON.stringify({ok:true,requests,evidence:run}));
    console.log(`Both native CLIs used one shared provider/model entry: ${path.relative(root,run)}`);
  }finally{await claude.close();await codex.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);server.closeAllConnections();server.close();process.exitCode=1;});
