'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {normalizeIntent}=require('../../backend/orchestratorIntent.cjs');
const {createOrchestrator}=require('../../backend/orchestrator.cjs');
const objective='Investigate the failing tests in Recovery QA; do not edit files.';
test('missing existing targets explains task routing without changing authority',()=>{
  const raw={goal:objective,actions:[{kind:'operate_terminal',cwd:'C:/Recovery QA',text:objective}]};
  const before=structuredClone(raw);
  assert.throws(()=>normalizeIntent(raw,{requestId:'source',instruction:objective,sessions:[],roots:{projects:['C:/Recovery QA']}}),error=>error.code==='ORCHESTRATOR_EXISTING_TARGET_REQUIRED'&&/delegate_task/.test(error.message)&&/full original objective/.test(error.message)&&/do not replace.*navigate/.test(error.message));
  assert.deepEqual(raw,before);
  assert.throws(()=>normalizeIntent({goal:objective,actions:[{kind:'delegate_task',cwd:'C:/Recovery QA',targetIds:['invented'],text:objective}]},{requestId:'source',instruction:objective,sessions:[]}),error=>error.code==='ORCHESTRATOR_ROUTING_TARGET_CONFLICT');
});
test('real interpretation repair preserves a zero-terminal investigation and creates exactly one routed worker', {timeout:4000}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-intent-routing-repair-'));
  const sessions=[],effects=[],requests=[];let sequence=0,phase=0,fetchError;
  const response=body=>new Response(JSON.stringify(body));
  const tool=(name,args)=>response({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:`call-${++sequence}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
  const relay=createOrchestrator({userDataPath:root,getSessions:()=>sessions,getRoots:()=>({projects:[{name:'Recovery QA',path:root}]}),
    getLaunchers:()=>[{kind:'codex',available:true,configured:true}],
    routeTask:async()=>({kind:'choose',decision:'create',kindOfSession:'codex',reason:'Known project has no existing terminal.'}),
    readSession:async()=>({ok:true,id:'worker',generation:'generation',text:'Ready for investigation.',sequence:4,observationSequence:4,inputRevision:0}),
    dispatchAction:async action=>{
      effects.push(action);
      if(action.kind==='create_session'){
        assert.equal(action.prompt,undefined);assert.equal(action.text,undefined);
        const session={id:'worker',generation:'generation',launchToken:1,cwd:root,kind:'codex',provider:'codex',status:'idle',started:true,processState:'running',agentProcessState:'running',agentPid:12,turnState:'idle',observation:'observed',conversationId:'conversation'};
        sessions.push(session);return {ok:true,status:'created',id:session.id,target:{id:session.id,generation:session.generation},launchToken:1,processState:'running'};
      }
      assert.equal(action.kind,'send_prompt');return {ok:true,status:'written'};
    },
    fetch:async(url,options)=>{ try {
      if(url.endsWith('/key'))return response({data:{}});
      if(url.endsWith('/models'))return response({data:[{id:'scripted',context_length:128000,supported_parameters:['tools','tool_choice']}]});
      const body=JSON.parse(options.body);
      if(body.tools?.some(tool=>tool.function.name==='interpret_workspace')){
        requests.push(body);
        if(requests.length===1)return tool('interpret_workspace',{goal:objective,access:'read-only',actions:[{kind:'operate_terminal',cwd:root,text:objective}]});
        assert.equal(requests.length,2);assert.match(body.messages[0].content,/Validation failure: Invalid operate_terminal target selection/);
        assert.match(body.messages[0].content,/use delegate_task.*full original objective/);assert.equal(effects.length,0);
        return tool('interpret_workspace',{goal:objective,access:'read-only',actions:[{kind:'delegate_task',cwd:root,text:objective}]});
      }
      const context=JSON.parse(body.messages.find(message=>message.role==='user').content),grant=context.authorizedCommands.grants.find(grant=>grant.kind==='operate_terminal');
      if(phase++%2===0)return tool('workspace',{kind:'read_session',targetId:'worker'});
      const observed=JSON.parse(body.messages.filter(message=>message.role==='tool').at(-1).content);
      return tool('workspace',{kind:phase===2?'send_prompt':'finish_terminal',targetId:'worker',grantId:grant.id,stepId:`step-${phase}`,observationToken:observed.observationToken,
        ...(phase===2?{text:objective,observationSequence:observed.observation.sequence,inputRevision:observed.observation.inputRevision}:{outcome:'completed',text:'Submission inspected.'})});
    } catch(error) { fetchError=error; throw error; } }});
  t.after(async()=>{await relay.cancel();await relay.dispose();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  await relay.configure({apiKey:'test-key',model:'scripted',sessionOnly:true});assert.equal((await relay.setEnabled(true)).ok,true);
  const result=await relay.send({text:objective,origin:'text'});assert.equal(result.ok,true,fetchError?.stack || JSON.stringify(result));
  assert.equal(requests.length,2);assert.equal(effects.filter(action=>action.kind==='create_session').length,1);
  assert.equal(effects.filter(action=>action.kind==='send_prompt').length,1);assert.equal(effects.at(-1).text,objective);
});
