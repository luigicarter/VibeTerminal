'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createOrchestrator}=require('../../backend/orchestrator.cjs');
const {normalizeIntent}=require('../../backend/orchestratorIntent.cjs');
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-creation-purpose-'));
  const f={root,sessions:[],effects:[],plans:[],markers:[],checks:[],interpretations:[],phases:new Map()};let sequence=0;
  const response=body=>new Response(JSON.stringify(body));
  const tool=(name,args)=>response({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:`call-${++sequence}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
  f.draft=text=>({kind:'create_session',kindOfSession:'codex',cwd:root,text});
  f.work=text=>({kind:'delegate_task',kindOfSession:'codex',assignmentMode:'new',cwd:root,text});
  f.plan=actions=>({goal:'Preserve the original requested work.',access:'read-only',actions});
  f.relay=createOrchestrator({userDataPath:root,getSessions:()=>f.sessions,getRoots:()=>({projects:[root]}),getLaunchers:()=>[{kind:'codex',available:true,configured:true}],
    readSession:async target=>({ok:true,id:target.id,generation:target.generation,text:'Ready.',sequence:4,observationSequence:4,inputRevision:0}),
    dispatchAction:async action=>{
      f.effects.push(action);
      if(action.kind==='create_session'){
        const id=`worker-${f.sessions.length}`,generation=`generation-${id}`;
        f.sessions.push({id,generation,launchToken:1,cwd:root,kind:'codex',provider:'codex',status:'idle',started:true,processState:'running',agentProcessState:'running',agentPid:12,turnState:'idle',observation:'observed',conversationId:`conversation-${id}`});
        return {ok:true,status:'created',id,target:{id,generation},launchToken:1,processState:'running',draftStaged:Boolean(action.prompt||action.text)};
      }
      assert.equal(action.kind,'send_prompt');return {ok:true,status:'written'};
    },fetch:async(url,options)=>{try{
      if(url.endsWith('/key'))return response({data:{}});
      if(url.endsWith('/models'))return response({data:[{id:'scripted',context_length:128000,supported_parameters:['tools','tool_choice']}]});
      const body=JSON.parse(options.body);
      if(body.messages[0].content.startsWith('Check the purpose of proposed new-terminal drafts')){
        assert(!body.tools?.length);f.checks.push(JSON.parse(body.messages[1].content));
        let marker=f.markers.shift();assert.notEqual(marker,undefined,'Every purpose check is scripted');if(typeof marker==='function')marker=await marker(options);if(marker instanceof Error)throw marker;
        return response({choices:[{finish_reason:'stop',message:{content:marker}}]});
      }
      if(body.tools?.some(tool=>tool.function.name==='interpret_workspace')){
        f.interpretations.push(body);const plan=f.plans.shift();assert(plan,'Every interpretation is scripted');return tool('interpret_workspace',typeof plan==='function'?plan(body):plan);
      }
      const context=JSON.parse(body.messages.find(message=>message.role==='user').content);
      const grant=context.authorizedCommands.grants.find(grant=>(f.phases.get(grant.id)||0)<(grant.kind==='create_session'?1:4));
      if(!grant)return response({choices:[{finish_reason:'stop',message:{content:'Requested effects observed.'}}]});
      const phase=f.phases.get(grant.id)||0;f.phases.set(grant.id,phase+1);
      if(grant.kind==='create_session')return tool('workspace',{kind:'create_session',grantId:grant.id});
      assert.equal(grant.kind,'operate_terminal');const targetId=grant.targets[0].id;
      if(phase%2===0)return tool('workspace',{kind:'read_session',targetId});
      const observed=JSON.parse(body.messages.filter(message=>message.role==='tool').at(-1).content);
      return tool('workspace',{kind:phase===1?'send_prompt':'finish_terminal',targetId,grantId:grant.id,stepId:`step-${phase}`,observationToken:observed.observationToken,
        ...(phase===1?{text:grant.text,observationSequence:observed.observation.sequence,inputRevision:observed.observation.inputRevision}:{outcome:'completed',text:'Submission inspected.'})});
    }catch(error){f.fetchError=error;throw error;}}});
  t.after(async()=>{await f.relay.cancel();await f.relay.dispose();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  await f.relay.configure({apiKey:'test',model:'scripted',sessionOnly:true});assert.equal((await f.relay.setEnabled(true)).ok,true);
  f.run=text=>f.relay.send({text,origin:'text'});return f;
}
test('explicit unsent draft passes the purpose veto and is staged without task submission',async t=>{
  const f=await fixture(t);f.plans.push(f.plan([f.draft('Review later.')]));f.markers.push('DRAFT');
  const result=await f.run('Open Codex with an unsent draft: Review later.');assert.equal(result.ok,true,f.fetchError?.stack||JSON.stringify(result));
  assert.equal(f.checks.length,1);assert.equal(f.effects.length,1);assert.equal(f.effects[0].prompt,'Review later.');
});
test('requested execution misclassified as draft repairs into exactly one worker and one full prompt',async t=>{
  const f=await fixture(t),text='Investigate the regression without editing.';
  f.plans.push(f.plan([f.draft(text)]),body=>{assert.match(body.messages[0].content,/only save an unsent draft/);assert.equal(f.effects.length,0);return f.plan([f.work(text)]);});f.markers.push('EXECUTE');
  const result=await f.run(`Open a new Codex and ${text}`);assert.equal(result.ok,true,f.fetchError?.stack||JSON.stringify(result));
  assert.equal(f.effects.filter(action=>action.kind==='create_session').length,1);assert.equal(f.effects.filter(action=>action.kind==='send_prompt').length,1);assert.equal(f.effects.at(-1).text,text);
});
for(const marker of ['TYPE','unrecognized marker'])test(`${marker} purpose result asks a question with no effects`,async t=>{
  const f=await fixture(t);f.plans.push(f.plan([f.draft('Review.')]));f.markers.push(marker);const result=await f.run('Open a new worker for review.');
  assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(f.effects,[]);assert(f.relay.getState().tasks.some(task=>task.status==='needs-answer'));
});
test('execution repair cannot replace a task with an empty pane',async t=>{
  const f=await fixture(t);f.plans.push(f.plan([f.draft('Investigate.')]),f.plan([{kind:'create_session',kindOfSession:'codex',cwd:f.root}]));f.markers.push('EXECUTE');
  const result=await f.run('Open Codex and investigate.');assert.equal(result.ok,false);assert.deepEqual(f.effects,[]);assert.equal(f.checks.length,1);
});
test('changed mixed draft set is checked again while preserving draft and executed work',async t=>{
  const f=await fixture(t);f.plans.push(f.plan([f.draft('Save for later.'),f.draft('Investigate now.')]),f.plan([f.draft('Save for later.'),f.work('Investigate now.')]));f.markers.push('EXECUTE','DRAFT');
  const result=await f.run('Prepare one unsent draft Save for later. and ask a second new Codex to Investigate now.');assert.equal(result.ok,true,f.fetchError?.stack||JSON.stringify(result));
  assert.deepEqual(f.checks.map(check=>check.proposedDrafts.length),[2,1]);assert.equal(f.effects.filter(action=>action.kind==='create_session').length,2);assert.equal(f.effects.filter(action=>action.kind==='send_prompt').length,1);
});
test('purpose-check network failure propagates without repair or effects',async t=>{
  const f=await fixture(t);f.plans.push(f.plan([f.draft('Review.')]));f.markers.push(new TypeError('Synthetic network unavailable'));
  const result=await f.run('Open Codex to review.');assert.equal(result.ok,false);assert(result.upstreamError);assert.deepEqual(f.effects,[]);assert.equal(f.interpretations.length,1);
});
test('cancellation during purpose check cannot reach any creation or task effect',async t=>{
  const f=await fixture(t);let entered=false;f.plans.push(f.plan([f.draft('Review.')]));
  f.markers.push(options=>new Promise((resolve,reject)=>{entered=true;options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('Cancelled'),{name:'AbortError'})),{once:true});}));
  const work=f.run('Open Codex to review.');
  const deadline=Date.now()+1000;while(!entered){assert(Date.now()<deadline);await new Promise(resolve=>setImmediate(resolve));}
  await f.relay.cancel();assert.equal((await work).ok,false);assert.deepEqual(f.effects,[]);
});
test('unsupported delegated launcher uses the same safe unknown-type clarification contract',()=>{
  assert.throws(()=>normalizeIntent({goal:'Do requested work',actions:[{kind:'delegate_task',kindOfSession:'web',cwd:'C:/project',text:'Review.'}]},{requestId:'r',instruction:'Review.',roots:{projects:['C:/project']},sessions:[]}),error=>error.code==='ORCHESTRATOR_UNKNOWN_LAUNCHER'&&error.clarification==='What did you mean by the “web” terminal?'&&/supported task launcher/.test(error.message));
});
