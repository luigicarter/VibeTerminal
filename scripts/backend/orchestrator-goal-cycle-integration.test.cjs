'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createOrchestrator}=require('../../backend/orchestrator.cjs');
const {INSPECTION_GOAL_REVIEW}=require('../../backend/orchestratorGoalReview.cjs');
const tool=(id,args)=>({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id,type:'function',function:{name:'workspace',arguments:JSON.stringify(args)}}]}}]});
for(const menu of [false,true])test(`application goal cycle observes, continues and finishes inspection without a model finish: menu=${menu}`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-goal-cycle-'));let phase='prompt',sequence=1,executions=0,reviews=0;const effects=[];
  const session={id:'agent',generation:'g1',kind:'claude',provider:'claude',cwd:root,status:'idle',turnState:'idle'};
  const relay=createOrchestrator({userDataPath:root,getRoots:()=>({projects:[root]}),getSessions:()=>[session],
    interpretIntent:()=>({goal:'Inspect usage',actions:[{kind:'inspect_terminal',targetIds:['agent'],text:'Inspect current usage limits and reset time.'}]}),
    readSession:async()=>({ok:true,id:'agent',generation:'g1',sequence,inputRevision:sequence,text:phase==='prompt'?'Empty prompt.':phase==='menu'?'Tabs: Status | Usage. Right opens Usage.':'Usage: 23% used; resets 19:00.'}),
    dispatchAction:async action=>{assert.equal(action.kind,'terminal_interact');effects.push(action);phase=menu&&phase==='prompt'?'menu':'facts';sequence++;return {ok:true,status:'written'};},
    fetch:async(url,options)=>{
      if(url.endsWith('/key'))return Response.json({data:{}});
      if(url.endsWith('/models'))return Response.json({data:[{id:'fixture',context_length:128000,supported_parameters:['tools']}]});
      const body=JSON.parse(options.body);
      if(body.messages[0].content===INSPECTION_GOAL_REVIEW){reviews++;const pages=JSON.parse(body.messages[1].content).evidence,found=pages.find(page=>page.text.includes('23%'));
        return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(found?{decision:'complete',evidenceIds:[found.id]}:{decision:'continue'})}}]});}
      executions++;
      if(executions===1)return Response.json(tool('read',{kind:'read_session',targetId:'agent'}));
      assert(executions<=(menu?3:2),'No ceremonial finish or extra final model call');
      return Response.json(tool(`navigate-${executions}`,{kind:'terminal_interact',targetId:'agent',inputPurpose:'interaction',...(phase==='prompt'?{text:'/usage',submit:true}:{keys:['right']})}));
    }});
  t.after(async()=>{await relay.dispose();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
  await relay.configure({apiKey:'fixture',model:'fixture',sessionOnly:true});await relay.setEnabled(true);
  const result=await relay.send({text:'Inspect current usage limits and reset time.',origin:'text'});
  assert.equal(result.ok,true,JSON.stringify(result));assert.match(result.text,/23%/);assert.match(result.text,/19:00/);
  assert.equal(effects.length,menu?2:1);assert.equal(executions,menu?3:2);assert.equal(reviews,menu?2:1);
});
