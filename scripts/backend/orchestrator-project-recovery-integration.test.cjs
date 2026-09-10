'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createOrchestrator}=require('../../backend/orchestrator.cjs');
test('Retry retains the original partial project-removal scope instead of forgetting its vanished pane',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-project-recovery-')),effects=[];let projects=[{id:'project',path:root,name:'Project'}],sessions=[{id:'pane',projectId:'project',generation:'g1',launchToken:1,kind:'codex',cwd:root}];
  fs.writeFileSync(path.join(root,'keep.txt'),'kept');
  const app=createOrchestrator({userDataPath:root,getRoots:()=>({projects}),getSessions:()=>sessions,
    interpretIntent:()=>({goal:'Remove this project from Lina only.',executionMode:'direct',actions:[{kind:'remove_project',path:root}]}),
    dispatchAction:async action=>{assert.equal(action.kind,'remove_project');effects.push(action);assert.equal(action.projectSelection.targets[0].id,'pane');sessions=[];
      if(effects.length===1)return {ok:false,status:'project-retained',filesDeleted:false,error:'The original stop is unconfirmed.'};
      projects=[];return {ok:true,status:'project-removed',filesDeleted:false};},
    fetch:async url=>{if(url.endsWith('/key'))return Response.json({data:{}});if(url.endsWith('/models'))return Response.json({data:[{id:'fixture',context_length:128000,supported_parameters:['tools']}]});assert.fail('A fully bound project retry needs no model call');}});
  t.after(async()=>{await app.dispose();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  await app.configure({apiKey:'fixture',model:'fixture',sessionOnly:true});await app.setEnabled(true);
  const first=await app.send({text:'Remove Project from Lina only.',origin:'text'});assert.equal(first.ok,false);
  const retry=app.retry({requestId:first.requestId});assert.equal(retry.ok,true,JSON.stringify(retry));
  const deadline=Date.now()+2000;while(!app.getState().tasks.some(task=>task.requestId===retry.requestId&&['finished','failed'].includes(task.status))){assert(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(app.getState().tasks.find(task=>task.requestId===retry.requestId).status,'finished');
  assert.equal(effects.length,2);assert.deepEqual(effects[1].projectSelection,effects[0].projectSelection);
  assert.equal(fs.readFileSync(path.join(root,'keep.txt'),'utf8'),'kept');
});
