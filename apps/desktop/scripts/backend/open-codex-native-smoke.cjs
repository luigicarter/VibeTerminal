"use strict";
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createAdapter } = require('../../backend/openCodexAdapter.cjs');
const { modelCatalog } = require('../../backend/openCodexRuntime.cjs');
const root = path.resolve(__dirname,'../..');
const run = path.join(root,'.tmp','open-codex',`native-${Date.now()}`);
const workspace = path.join(run,'workspace'); fs.mkdirSync(workspace,{recursive:true});
const key = 'oc_fixture/coding-model';
const catalog = path.join(run,'models.json');
fs.writeFileSync(catalog, JSON.stringify(modelCatalog([{key,id:'coding-model',label:'Fixture coding model',providerName:'Fixture',contextWindow:32768,reasoning:false,imageInput:false}])));
const requests=[];
async function main() {
  const adapter = await createAdapter({ listModels:()=>[{key,providerName:'Fixture'}],
    resolveModel: id=>{assert.equal(id,key);return {id:'coding-model',baseUrl:'http://fixture.invalid/v1',apiMode:'auto',apiKey:'fixture-only'};},
    fetchImpl:async(url,options)=>{
      if(url.endsWith('/responses')) return new Response('',{status:404});
      const body=JSON.parse(options.body);requests.push(body);
      fs.writeFileSync(path.join(run,`request-${requests.length}.json`),JSON.stringify(body,null,2));
      let choice;
      if(requests.length===1){
        const tool=body.tools.find(row=>row.function.name==='shell_command' || row.function.name==='exec_command');
        assert.ok(tool,`Portable shell tool missing: ${body.tools.map(row=>row.function.name).join(', ')}`);
        const command = process.platform==='win32' ? "Set-Content -LiteralPath 'open-codex-proof.txt' -Value 'native adapter verified'" : "printf '%s\\n' 'native adapter verified' > open-codex-proof.txt";
        const parameters=tool.function.parameters.properties;
        const args={ [parameters.command?'command':'cmd']:command, ...(parameters.workdir?{workdir:workspace}:{}) };
        choice={index:0,delta:{tool_calls:[{index:0,id:'call_native_proof',type:'function',function:{name:tool.function.name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'};
      }else{
        assert.ok(body.messages.some(row=>row.role==='tool' && row.tool_call_id==='call_native_proof'));
        choice={index:0,delta:{content:'Created open-codex-proof.txt and completed the fixture.'},finish_reason:'stop'};
      }
      return new Response(`data: ${JSON.stringify({choices:[choice]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
    }});
  const binary=path.join(root,'vendor','open-codex',`${process.platform}-${process.arch}`,process.platform==='win32'?'codex.exe':'codex');
  assert.ok(fs.existsSync(binary),'Run npm run prepare:open-codex first.');
  const env={...process.env,LINA_OPEN_CODEX_BIN:binary,LINA_OPEN_CODEX_HOME:path.join(run,'home'),LINA_OPEN_CODEX_CATALOG:catalog,
    LINA_OPEN_CODEX_MODEL:key,LINA_OPEN_CODEX_BASE_URL:adapter.baseUrl,LINA_OPEN_CODEX_TOKEN:adapter.token};
  delete env.VIBE_TERMINAL_CALLBACK_URL; delete env.VIBE_TERMINAL_CODEX_HOOK_OVERRIDES; delete env.VIBE_TERMINAL_CODEX_HOOK_TRUST_OVERRIDE; delete env.VIBE_TERMINAL_NOTIFY_PROGRAM;
  const launcher=process.argv.includes('--electron-node')?require('electron'):process.execPath;
  if(process.argv.includes('--electron-node'))env.ELECTRON_RUN_AS_NODE='1';
  const child=spawn(launcher,[path.join(root,'backend/openCodexCli.cjs'),'-a','never','exec','--json','--skip-git-repo-check','--sandbox','danger-full-access','-C',workspace,'Create open-codex-proof.txt with the text native adapter verified.'],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderr=''; child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  const timer=setTimeout(()=>{child.kill();},45000);
  try {
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    fs.writeFileSync(path.join(run,'stdout.jsonl'),stdout);fs.writeFileSync(path.join(run,'stderr.txt'),stderr);
    assert.equal(code,0,stderr.slice(-2000));
    assert.equal(fs.readFileSync(path.join(workspace,'open-codex-proof.txt'),'utf8').trim(),'native adapter verified');
    assert.equal(requests.length,2);
    assert.ok(stdout.includes('turn.completed'),stdout.slice(-1500));
    const threadId=stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(row=>row.type==='thread.started').thread_id;
    const resumed=spawn(launcher,[path.join(root,'backend/openCodexCli.cjs'),'-a','never','exec','--json','--skip-git-repo-check','--sandbox','danger-full-access','-C',workspace,'resume',threadId,'Continue this exact saved conversation.'],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let resumeOut='',resumeError='';resumed.stdout.on('data',data=>resumeOut+=data);resumed.stderr.on('data',data=>resumeError+=data);
    const resumeTimer=setTimeout(()=>resumed.kill(),30000);
    try {
      const resumeCode=await new Promise((resolve,reject)=>{resumed.once('error',reject);resumed.once('exit',resolve);});
      fs.writeFileSync(path.join(run,'resume.jsonl'),resumeOut);fs.writeFileSync(path.join(run,'resume-stderr.txt'),resumeError);
      assert.equal(resumeCode,0,resumeError.slice(-2000));assert.ok(resumeOut.includes(threadId));assert.ok(resumeOut.includes('turn.completed'));
      assert.equal(requests.length,3);
    }finally{clearTimeout(resumeTimer);try{resumed.kill();}catch{}}
    console.log(`Open Codex native CLI → Chat Completions → tool execution → completion → exact resume passed. Evidence: ${path.relative(root,run)}`);
  } finally {clearTimeout(timer);await adapter.close();try{child.kill();}catch{}}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
