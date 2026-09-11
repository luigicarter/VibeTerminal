'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {normalizeIntent}=require('../../backend/orchestratorIntent.cjs');
const {createOrchestrator}=require('../../backend/orchestrator.cjs');
test('unbound creation source cannot mint effects; recovered siblings remain narrowly bound and new unrelated work remains valid',()=>{
  const prior={requestId:'original',instruction:'Investigate without editing.',unboundCreation:true,grants:[]};
  const context={requestId:'retry',instruction:'Continue.',previousCommand:prior,roots:{projects:['C:/project']},sessions:[]};
  const task={kind:'delegate_task',cwd:'C:/project',kindOfSession:'codex',assignmentMode:'new',text:prior.instruction};
  assert.throws(()=>normalizeIntent({goal:prior.instruction,actions:[{...task,sourceUserId:'original'}]},context),error=>error.code==='ORCHESTRATOR_UNBOUND_CREATION_AUTHORITY');
  assert.equal(normalizeIntent({goal:'Keep original pending.',continuationOf:'original',actions:[],clarification:'Wait for the existing worker?'},context).grants.length,0);
  assert.equal(normalizeIntent({goal:'A new unrelated task.',actions:[task]},context).grants.length,1);
  const recovered={kind:'operate_terminal',targets:[{id:'a',generation:'g'}],args:{},text:prior.instruction,promptMode:'compose',answerMode:'delegated',permissionMode:'none',lifecycleMode:'preserve'};
  const mixed={...context,previousCommand:{...prior,grants:[recovered]},sessions:[{id:'a',generation:'g',kind:'codex'}]};
  assert.equal(normalizeIntent({goal:prior.instruction,actions:[{kind:'operate_terminal',sourceUserId:'original'}]},mixed).grants[0].targets[0].id,'a');
  assert.throws(()=>normalizeIntent({goal:prior.instruction,actions:[{...task,sourceUserId:'original'}]},mixed),/unfinished operation/);
});
test('timed-out worker creation survives malformed old-source retry without a second creation', {timeout:4000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-unbound-authority-')),sessions=[],effects=[];let interpret,firstId;
  const objective='Investigate startup without editing.';
  const relay=createOrchestrator({userDataPath:root,getSessions:()=>sessions,getRoots:()=>({projects:[root]}),getLaunchers:()=>[{kind:'codex',available:true,configured:true}],
    interpretIntent:context=>interpret(context),
    dispatchAction:async action=>{
      effects.push(action);assert.equal(action.kind,'create_session');
      sessions.push({id:'original-pane',generation:'original-generation',launchToken:1,cwd:root,kind:'codex',provider:'codex',processState:'running',agentProcessState:'starting',status:'starting',turnState:'starting',started:true});
      return {ok:false,status:'launch-timeout',id:'original-pane',launchToken:1,sessionCreated:true,delivery:'not-dispatched',error:'Still starting.'};
    },fetch:async url=>new Response(JSON.stringify(url.endsWith('/key')?{data:{}}:{data:[{id:'scripted',context_length:128000,supported_parameters:['tools']}]}))});
  t.after(async()=>{await relay.cancel();await relay.dispose();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  await relay.configure({apiKey:'test',model:'scripted',sessionOnly:true});await relay.setEnabled(true);
  const task={kind:'delegate_task',cwd:root,kindOfSession:'codex',assignmentMode:'new',text:objective};
  interpret=()=>({goal:objective,actions:[task]});const first=await relay.send({text:'Open a new Codex and investigate startup without editing.',origin:'text'});firstId=first.requestId;
  assert.equal(first.ok,false);assert.equal(effects.length,1);
  interpret=context=>{
    const pending=context.pendingCommands.find(command=>command.requestId===firstId);assert(pending?.unboundCreation);assert.equal(pending.grants.length,0);
    return {goal:objective,continuationOf:firstId,actions:[{...task,sourceUserId:firstId}]};
  };
  const retry=await relay.send({text:'Continue the original request.',origin:'text',replyToRequestId:firstId});assert.equal(retry.ok,false);assert.equal(effects.length,1);
  assert.equal(relay.getState().tasks.find(task=>task.requestId===firstId).status,'failed');
  Object.assign(sessions[0],{agentProcessState:'running',agentPid:123,status:'idle',turnState:'idle',observation:'observed',conversationId:'original-conversation'});await relay.refresh();
  interpret=context=>{
    const pending=context.pendingCommands.filter(command=>command.requestId===firstId);assert.equal(pending.length,1);assert.equal(pending[0].grants.length,1);
    assert.equal(pending[0].grants[0].targets[0].id,'original-pane');return {goal:'Inspect original recovery owner.',actions:[],clarification:'The original worker is ready.'};
  };
  const inspected=await relay.send({text:'Which original worker is pending?',origin:'text'});assert.equal(inspected.ok,true,JSON.stringify(inspected));assert.equal(effects.length,1);
});
